/**
 * TREE SKILL: inspects a whole tree, gathers replanting supplies, removes its logs, and replants.
 * A saved tree job lets the routine remember unfinished work instead of abandoning a half-cut tree.
 * The natural-tree checks help avoid treating a wooden building as a tree.
 */

const fs = require('node:fs')
const path = require('node:path')
const { Vec3 } = require('vec3')
const { Survival } = require('./survival.cjs')
const Move = require('mineflayer-pathfinder/lib/move')
const { Movements, goals } = require('mineflayer-pathfinder')
const { BlockApproachGoal, canView } = require('./block-approach.cjs')
const { BUILDING_BLOCKS, Travel, TravelMovements } = require('./travel.cjs')
const { Work } = require('./work.cjs')
const { isAir } = require('./world.cjs')
const { watchBlock } = require('./block-updates.cjs')
const key = (p) => `${p.x},${p.y},${p.z}`
const SPECIES = ['oak', 'birch', 'spruce', 'jungle', 'acacia', 'dark_oak', 'cherry']
const SOIL = new Set([
  'dirt',
  'grass_block',
  'podzol',
  'coarse_dirt',
  'rooted_dirt',
  'moss_block',
  'mycelium',
])

// Capture the entire connected trunk and diagonal branches BEFORE removing logs.
// Refuse truncated/unloaded trees instead of silently calling them complete.
function inspectTree(bot, start) {
  const species = SPECIES.find((s) => start.name === `${s}_log`)
  if (!species) throw new Error('Unsupported tree species.')
  const queue = [start.position],
    seen = new Set(),
    logs = [],
    roots = []
  let leaves = false
  while (queue.length) {
    const p = queue.pop(),
      id = key(p)
    if (seen.has(id)) continue
    seen.add(id)
    const b = bot.blockAt(p)
    if (!b) throw new Error('Tree reaches unloaded terrain. Move closer and retry.')
    if (b.name !== `${species}_log`) continue
    if (
      logs.length >= 256 ||
      Math.abs(p.x - start.position.x) > 12 ||
      Math.abs(p.z - start.position.z) > 12 ||
      Math.abs(p.y - start.position.y) > 40
    )
      throw new Error('Connected tree exceeds the supported size; no logs removed.')
    logs.push(p.clone())
    if (SOIL.has(bot.blockAt(p.offset(0, -1, 0))?.name)) roots.push(p.clone())
    for (let x = -1; x <= 1; x++)
      for (let y = -1; y <= 1; y++)
        for (let z = -1; z <= 1; z++) {
          if (!x && !y && !z) continue
          const q = p.offset(x, y, z),
            near = bot.blockAt(q)
          if (!near) throw new Error('Tree canopy is not fully loaded.')
          if (near.name === `${species}_leaves` && near.getProperties?.().persistent !== true)
            leaves = true
          if (near.name === `${species}_log`) queue.push(q)
        }
  }
  if (!roots.length || !leaves) throw new Error('Need a rooted tree with a natural leaf canopy.')
  if (
    species === 'dark_oak' &&
    !roots.some((p) =>
      [p.offset(1, 0, 0), p.offset(0, 0, 1), p.offset(1, 0, 1)].every((q) =>
        roots.some((r) => r.equals(q)),
      ),
    )
  )
    throw new Error('Dark oak needs a complete 2 × 2 planting footprint.')
  return { species, logs, roots, planted: [], removed: 0 }
}

class CanopyGoal extends goals.Goal {
  constructor(bot, pos, species) {
    super()
    this.bot = bot
    this.pos = pos
    this.species = species
  }
  heuristic(node) {
    return Math.max(0, node.distanceTo(this.pos) - 2)
  }
  isEnd(node) {
    if (node.x === this.pos.x && node.z === this.pos.z && node.y === this.pos.y + 1) return false
    const support = node.offset(0, -1, 0)
    const planned = node.toPlace?.some(
      (p) => p.x + p.dx === support.x && p.y + p.dy === support.y && p.z + p.dz === support.z,
    )
    if (!planned && this.bot.blockAt(support)?.boundingBox !== 'block') return false
    const eye = node.offset(0.5, 1.62, 0.5),
      delta = this.pos.offset(0.5, 0.5, 0.5).minus(eye)
    const distance = delta.norm()
    if (distance > 3.5) return false
    if (!this.bot.world?.raycast) return canView(this.bot, this.pos)
    const hit = this.bot.world.raycast(
      eye,
      delta.normalize(),
      distance + 0.01,
      (b, iter) =>
        b.position.equals(this.pos) ||
        ((b.name !== `${this.species}_leaves` || b.getProperties?.().persistent === true) &&
          !!iter.intersect(b.shapes, b.position)),
    )
    return !!hit?.position.equals(this.pos)
  }
}

class TreeFarm extends Survival {
  constructor(agent, id) {
    const previous = agent.state.survival
    super(agent, id)
    agent.state.survival = previous
    this.deadline = Infinity
    this.task.deadlineAt = null
    this.task.continuous = true
    this.task.skill = 'TREE FARMER'
    this.plan = {
      status: 'running',
      decision: 'Looking for trees.',
      trees: 0,
      logs: 0,
      planted: 0,
      remaining: 0,
      waitingUntil: null,
    }
    agent.state.treeFarm = this.plan
    this.jobKey = `${agent.state.world}:${agent.state.dimension}`
    agent.treeJobs ||= new Map()
    this.jobFile = agent.dataDir && path.join(agent.dataDir, 'tree-jobs.json')
    if (this.jobFile && fs.existsSync(this.jobFile) && !agent.treeJobs.size) {
      const saved = JSON.parse(fs.readFileSync(this.jobFile, 'utf8'))
      for (const [scope, job] of Object.entries(saved))
        agent.treeJobs.set(scope, {
          ...job,
          logs: job.logs.map((p) => new Vec3(p.x, p.y, p.z)),
          roots: job.roots.map((p) => new Vec3(p.x, p.y, p.z)),
        })
    }
    this.job = agent.treeJobs.get(this.jobKey) || null
    if (this.job) {
      this.plan.logs = this.job.removed || 0
      this.plan.planted = this.job.planted.length
      this.plan.remaining = this.job.logs.length - this.plan.logs
    }
  }
  // Persist unfinished tree work so reconnecting does not lose the replanting obligation.
  saveJob() {
    if (!this.jobFile) return
    fs.mkdirSync(path.dirname(this.jobFile), { recursive: true })
    fs.writeFileSync(
      this.jobFile + '.tmp',
      JSON.stringify(Object.fromEntries(this.agent.treeJobs)),
      { mode: 0o600 },
    )
    fs.renameSync(this.jobFile + '.tmp', this.jobFile)
  }
  check() {
    super.check()
    this.requestAir()
    if (this.needsAir && !this.recoveringAir)
      throw Object.assign(new Error('Surfacing to restore air.'), { code: 'AIR_RECOVERY' })
    const danger = this.safety()
    if (danger) throw Object.assign(new Error(danger), { fatal: true })
  }
  // Live reach must use the actual eye position, not the center of its cell.
  // On narrow canopy stairs those two sight lines can lie on opposite sides of leaves.
  canWork(pos) {
    const feet = this.bot.entity.position.floored(),
      block = this.bot.blockAt(pos)
    return (
      !this.bot.entity.isInWater &&
      this.bot.blockAt(feet.offset(0, -1, 0))?.boundingBox === 'block' &&
      !(feet.x === pos.x && feet.z === pos.z && feet.y === pos.y + 1) &&
      canView(this.bot, pos) &&
      !!block &&
      (block.name === 'farmland' || this.bot.canDigBlock(block))
    )
  }
  async approach(pos, options = {}) {
    const excluded = new Set()
    for (let attempt = 0; attempt < 3; attempt++) {
      this.check()
      if (this.canWork(pos) || options.allowSurface && canView(this.bot, pos) && this.bot.canDigBlock(this.bot.blockAt(pos))) return
      excluded.add(key(this.bot.entity.position.floored()))
      const goal = new BlockApproachGoal(this.bot, pos, options)
      const base = goal.isEnd.bind(goal)
      goal.isEnd = node => !excluded.has(key(node)) && base(node) &&
        (options.allowSurface || ![node, node.offset(0, 1, 0)].some(p => this.bot.blockAt(p)?.name === 'water'))
      const before = this.bot.pathfinder.movements
      const movements = new TravelMovements(this.bot)
      movements.canDig = true
      movements.exclusionAreasBreak.push(b =>
        b.name === `${this.job?.species}_leaves` && b.getProperties?.().persistent !== true ? 0 : 100)
      try {
        this.bot.pathfinder.setMovements(movements)
        await this.travel(goal, 'Move to a dry, clear view of the tree work area')
      } finally {
        if (this.agent.bot === this.bot) this.bot.pathfinder.setMovements(before)
      }
    }
    if (!this.canWork(pos)) throw new Error('No clear working stance after three distinct approaches.')
  }
  async placeItem(name, support) {
    const planted = support.position.offset(0, 1, 0)
    if (this.bot.entity.position.distanceTo(planted.offset(0.5, 0, 0.5)) < 1.8) {
      const goal = new BlockApproachGoal(this.bot, support.position)
      const base = goal.isEnd.bind(goal)
      goal.isEnd = (node) =>
        base(node) && node.offset(0.5, 0, 0.5).distanceTo(planted.offset(0.5, 0, 0.5)) >= 2
      await this.travel(goal, 'Step back onto stable ground to replant the tree')
    }
    return super.placeItem(name, support)
  }
  safety() {
    const danger = super.safety()
    return danger?.startsWith('Air is running low') ? null : danger?.replaceAll('Marc', this.agent.username || 'Jerry') || null
  }
  requestAir() {
    if (this.recoveringAir || this.needsAir || !this.bot.entity.isInWater || !Number.isFinite(this.bot.oxygenLevel) || this.bot.oxygenLevel >= 12) return
    this.needsAir = true
    this.bot.pathfinder.setGoal(null)
    this.bot.stopDigging()
    this.bot.clearControlStates()
    this.bot.setControlState('jump', true)
  }
  async pause(ms = 200) {
    for (let left = ms; left > 0; left -= 250)
      await Work.prototype.pause.call(this, Math.min(left, 250))
  }
  async recoverAir() {
    this.recoveringAir = true
    this.plan.waitingUntil = null
    try {
      this.decide('Jerry is surfacing to restore air before resuming the saved tree.')
      const travel = new Travel(this, 15000)
      await travel.surface()
      const until = Date.now() + 10000
      while (this.bot.oxygenLevel < 18 && Date.now() < until) await travel.tick()
      if (this.bot.oxygenLevel < 18) throw new Error('Could not restore air at the surface. Saved tree retained.')
      this.needsAir = false
      travel.activity.status = 'succeeded'
    } finally { this.recoveringAir = false }
  }
  async leaveWater() {
    if (!this.bot.entity.isInWater) return
    this.decide('Returning to dry land before recovering tree supports.')
    await new Travel(this, 15000).surface()
    const positions = this.bot.findBlocks({
      matching: b => b.boundingBox === 'block' && !/magma|cactus|fire/.test(b.name),
      maxDistance: 32, count: 64,
      useExtraInfo: b => isAir(this.bot.blockAt(b.position.offset(0, 1, 0))) && isAir(this.bot.blockAt(b.position.offset(0, 2, 0))),
    }).filter(p => isAir(this.bot.blockAt(p.offset(0, 1, 0))) && isAir(this.bot.blockAt(p.offset(0, 2, 0))))
    if (!positions.length) throw new Error('No loaded dry landing nearby; tree supports retained.')
    await this.travel(new goals.GoalCompositeAny(positions.map(p => new goals.GoalBlock(p.x, p.y + 1, p.z))), 'Reach dry land before recovering supports')
    if (this.bot.entity.isInWater) throw new Error('Dry landing was not reached; tree supports retained.')
  }
  async placeCanopy(step, prepared = false) {
    const refPos = new Vec3(step.x, step.y, step.z),
      face = new Vec3(step.dx, step.dy, step.dz),
      pos = refPos.plus(face)
    const item = this.bot.inventory
      .items()
      .filter((i) => BUILDING_BLOCKS.includes(i.name) && i.count > 0)
      .sort((a, b) => Number(b.name === 'dirt') - Number(a.name === 'dirt'))[0]
    if (!item) throw new Error('Need dirt or cobblestone to build the next canopy step.')
    const valid = () => {
      this.check()
      const ref = this.bot.blockAt(refPos),
        dest = this.bot.blockAt(pos),
        eye = this.bot.entity.position.offset(0, 1.62, 0)
      if (
        ref?.boundingBox !== 'block' ||
        !isAir(dest) ||
        eye.distanceTo(refPos.offset(0.5, 0.5, 0.5).plus(face.scaled(0.5))) > 4.5
      )
        throw new Error('Canopy placement needs a reachable solid support and a clear cell.')
      for (const entity of [this.bot.entity, ...Object.values(this.bot.entities || {})]) {
        if (!entity.position || entity.name === 'item') continue
        const p = entity.position,
          r = (entity.width || 0.6) / 2,
          h = entity.height || 1.8
        if (
          p.x + r > pos.x &&
          p.x - r < pos.x + 1 &&
          p.z + r > pos.z &&
          p.z - r < pos.z + 1 &&
          p.y + h > pos.y &&
          p.y < pos.y + 1
        )
          throw new Error('An entity is occupying the canopy step.')
      }
      if (this.bot.heldItem?.name !== item.name)
        throw new Error('Canopy building material changed.')
      return ref
    }
    if (!prepared) await this.equip(item)
    if (!prepared) await this.timed(
      () => this.bot.lookAt(refPos.offset(0.5, 0.5, 0.5).plus(face.scaled(0.5))),
      5000,
      'Face the canopy step',
    )
    const type = this.bot.registry.blocksByName[item.name],
      ack = watchBlock(this.bot, pos, (s) => s >= type.minStateId && s <= type.maxStateId, this.controller.signal)
    try {
      await this.timed(
        () =>
          this.bot._placeBlockWithOptions(valid(), face, {
            forceLook: 'ignore',
            swingArm: 'right',
          }),
        7000,
        'Place supported canopy step',
      )
      await this.timed(() => ack.promise, 4000, 'Confirm canopy step')
      if (this.bot.blockAt(pos)?.name !== item.name)
        throw new Error('Canopy support was not confirmed.')
      if (this.job) {
        this.job.scaffolds ||= []
        this.job.scaffolds.push({ x: pos.x, y: pos.y, z: pos.z, name: item.name })
        this.saveJob()
      }
      this.counts.travelBlocks = (this.counts.travelBlocks || 0) + 1
      this.sync()
    } finally {
      ack.cleanup()
    }
  }
  canopyCellOccupied(step) {
    const pos = new Vec3(step.x + step.dx, step.y + step.dy, step.z + step.dz)
    return [this.bot.entity, ...Object.values(this.bot.entities || {})].some(entity => {
      if (!entity.position || entity.name === 'item') return false
      const p = entity.position, r = (entity.width || .6) / 2, h = entity.height || 1.8
      return p.x + r > pos.x && p.x - r < pos.x + 1 && p.z + r > pos.z && p.z - r < pos.z + 1 && p.y + h > pos.y && p.y < pos.y + 1
    })
  }
  async settleStance() {
    if (this.bot.entity.isInWater) {
      this.bot.setControlState('jump', true)
      throw new Error('Need dry footing before settling the canopy stance.')
    }
    this.bot.pathfinder.setGoal(null)
    this.bot.clearControlStates()
    for (let n = 0; n < 20; n++) {
      this.check()
      const velocity = this.bot.entity.velocity
      if (this.bot.entity.onGround !== false && (!velocity || Math.hypot(velocity.x, velocity.z) < 0.025)) return
      await this.pause(50)
    }
    throw new Error('Waiting for a stable canopy stance before working.')
  }
  async motionUntil(predicate, label) {
    let listener
    try {
      await this.timed(() => new Promise((resolve, reject) => {
        listener = () => {
          try { this.check(); if (predicate()) resolve() } catch (error) { reject(error) }
        }
        this.bot.on('physicsTick', listener)
        listener()
      }), 4000, label)
    } finally {
      if (listener) this.bot.off('physicsTick', listener)
    }
  }
  async climbTrunk(pos) {
    const root = this.job.roots.find(p => p.x === pos.x && p.z === pos.z)
    // Branches and old, partly cut jobs can still use the supported stair route.
    const feet = this.bot.entity.position.floored()
    if (!root) return false
    if ((feet.x !== root.x || feet.z !== root.z) &&
      (!isAir(this.bot.blockAt(root)) || !isAir(this.bot.blockAt(root.offset(0, 1, 0))))) return false
    if (feet.x !== root.x || feet.z !== root.z) {
      const before = this.bot.pathfinder.movements, movements = new Movements(this.bot)
      movements.canDig = false
      movements.scafoldingBlocks = []
      movements.allowParkour = false
      movements.maxDropDown = 2
      try {
        this.bot.pathfinder.setMovements(movements)
        await this.travel(new goals.GoalBlock(root.x, root.y, root.z), 'Walk into the cleared tree base')
      } finally { this.bot.pathfinder.setMovements(before) }
    }
    for (let n = 0; n < 40; n++) {
      await this.settleStance()
      if (this.canWork(pos)) return true
      const p = this.bot.entity.position.floored()
      if (p.x !== root.x || p.z !== root.z || p.y >= pos.y) return false
      await this.clearCanopyLeaves([p.offset(0, 1, 0), p.offset(0, 2, 0)].filter(q => !isAir(this.bot.blockAt(q))))
      const item = this.bot.inventory.items().find(i => i.name === 'dirt' && i.count > 0)
      if (!item) throw new Error('Dirt column exhausted; descend and refill Jerry’s dirt reserve.')
      await this.equip(item)
      await this.timed(() => this.bot.lookAt(p.offset(.5, 0, .5)), 5000, 'Face the dirt column')
      this.decide(`Climbing the cleared trunk with dirt · ${this.plan.remaining} logs left.`)
      this.bot.setControlState('jump', true)
      try {
        await this.motionUntil(() => this.bot.entity.position.y >= p.y + 1.01, 'Jump one block up the trunk')
        await this.placeCanopy({x:p.x, y:p.y-1, z:p.z, dx:0, dy:1, dz:0}, true)
      } finally { this.bot.setControlState('jump', false) }
      await this.motionUntil(() => this.bot.entity.onGround && this.bot.entity.position.floored().equals(p.offset(0, 1, 0)), 'Land on confirmed dirt')
    }
    throw new Error('Trunk climb limit reached; unfinished tree saved.')
  }
  async recoverScaffolds() {
    const scaffold = this.job.scaffolds ||= []
    if (scaffold.length) await this.descendCanopy()
    if (scaffold.length) await this.leaveWater()
    while (scaffold.length) {
      this.check()
      const entry = scaffold[scaffold.length - 1], p = new Vec3(entry.x, entry.y, entry.z)
      const block = this.bot.blockAt(p)
      // A removed bridge support can immediately fill with flowing water.
      if (!isAir(block) && block?.name !== 'water') {
        const grassSpread = entry.name === 'dirt' && block?.name === 'grass_block'
        if (block?.name !== entry.name && !grassSpread) throw new Error(`Temporary tree support changed at ${key(p)} (${block?.name || 'unloaded'}); refusing to remove it.`)
        this.decide(`Recovering climbing blocks · ${scaffold.length} remaining.`)
        const safeDescent = () => {
          const feet = this.bot.entity.position.floored()
          return !this.bot.entity.isInWater && feet.equals(p.offset(0, 1, 0)) && this.bot.entity.onGround !== false &&
            this.bot.blockAt(p.offset(0, -1, 0))?.boundingBox === 'block' &&
            this.job.scaffolds.includes(entry)
        }
        if (!safeDescent()) await this.approach(p)
        await this.settleStance()
        const descending = safeDescent()
        await this.dig(p, block.name, () => this.job.scaffolds.includes(entry), item => this.withoutSilk(item), safeDescent)
        if (descending) await this.motionUntil(() => this.bot.entity.onGround && this.bot.entity.position.floored().equals(p), 'Descend one block on solid support')
        // Nearby drops collect automatically during a column descent. Chasing
        // them here could walk off the column before the next support is removed.
        if (!descending) await this.pickup(p)
      }
      scaffold.pop()
      this.saveJob()
    }
  }
  async descendCanopy() {
    const natural = b => b?.name === `${this.job.species}_leaves` && b.getProperties?.().persistent !== true
    for (let n = 0; n < 40 && !this.bot.entity.isInWater; n++) {
      const p = this.bot.entity.position.floored().offset(0, -1, 0)
      if (!natural(this.bot.blockAt(p)) || this.bot.blockAt(p.offset(0, -1, 0))?.boundingBox !== 'block') return
      if (!this.job.roots.some(root => Math.hypot(root.x - p.x, root.z - p.z) <= 14) || p.y < Math.min(...this.job.roots.map(root => root.y))) return
      await this.settleStance()
      const safe = () => !this.bot.entity.isInWater && this.bot.entity.onGround !== false &&
        this.bot.entity.position.floored().equals(p.offset(0, 1, 0)) && natural(this.bot.blockAt(p)) &&
        this.bot.blockAt(p.offset(0, -1, 0))?.boundingBox === 'block'
      this.decide('Descending the natural canopy one supported block at a time.')
      await this.dig(p, `${this.job.species}_leaves`, natural, item => !item || !/shears/.test(item.name), safe)
      await this.motionUntil(() => this.bot.entity.onGround && this.bot.entity.position.floored().equals(p), 'Land after clearing a canopy block')
    }
  }
  async clearCanopyLeaves(positions) {
    if (!positions.length) return
    const pending = positions.map(p => new Vec3(p.x, p.y, p.z))
    const natural = block => block?.name === `${this.job.species}_leaves` && block.getProperties?.().persistent !== true
    let retries = 0
    for (let attempt = 0; attempt < 24; attempt++) {
      this.check()
      if (attempt > 0) await this.settleStance()
      const remaining = pending.map(p => this.bot.blockAt(p)).filter(b => !isAir(b))
      if (!remaining.length) return
      if (remaining.some(b => !natural(b))) throw new Error('Canopy clearance changed; refusing to dig unrelated terrain.')
      let target = remaining.find(b => this.canWork(b.position))
      if (!target && this.bot.world?.raycast) {
        // Planner ordering is not visibility ordering. A nearer leaf can hide a
        // requested leaf even when both blocks are geometrically within reach.
        const eye = this.bot.entity.position.offset(0, 1.62, 0)
        for (const leaf of remaining) {
          const direction = leaf.position.offset(.5, .5, .5).minus(eye)
          const distance = direction.norm()
          if (distance > 4.5) continue
          const hit = this.bot.world.raycast(eye, direction.normalize(), distance + .01)
          if (natural(hit) && this.canWork(hit.position)) { target = hit; break }
        }
      }
      if (!target) throw new Error('Canopy clearance needs a closer, unobstructed stance; no hidden blocks were dug.')
      try {
        await this.dig(target.position, target.name, natural)
        retries = 0
      } catch (error) {
        this.check()
        if (error.fatal || !/out of reach or view|Target changed/.test(error.message) || ++retries > 2) throw error
        this.agent.log?.('tree.clearance-retry', 'Canopy view changed while turning; settling and checking the nearest visible leaf again.')
      }
    }
    throw new Error('Canopy clearance reached its bounded leaf limit; unfinished tree retained.')
  }
  // Stair construction permits a return route; never build isolated jump towers.
  // Pathfinder may clear natural leaves, but cannot mine logs or other terrain.
  async reachLog(pos) {
    this.check()
    const goal = new CanopyGoal(this.bot, pos, this.job.species)
    if (this.canWork(pos)) return
    if (await this.climbTrunk(pos)) return
    const movements = new Movements(this.bot)
    movements.allow1by1towers = false
    movements.allowParkour = false
    movements.allowSprinting = false
    movements.maxDropDown = 2
    movements.canDig = true
    movements.scafoldingBlocks = BUILDING_BLOCKS.map(
      (n) => this.bot.registry.itemsByName[n]?.id,
    ).filter(Number.isInteger)
    movements.exclusionAreasBreak.push((b) =>
      b.name === `${this.job.species}_leaves` && b.getProperties?.().persistent !== true ? 0 : 100,
    )
    movements.exclusionAreasPlace.push((b) => {
      const root = this.job.roots[0]
      return !isAir(b) ||
        Math.abs(b.position.x - root.x) > 14 ||
        Math.abs(b.position.z - root.z) > 14 ||
        this.job.roots.some((p) => p.x === b.position.x && p.z === b.position.z)
        ? 100
        : 0
    })
    const before = this.bot.pathfinder.movements
    try {
      this.bot.pathfinder.setMovements(movements)
      await this.timed(
        async () => {
          const materials = movements.scafoldingBlocks
          try {
            movements.scafoldingBlocks = []
            await this.bot.pathfinder.goto(goal)
            await this.settleStance()
            return
          } catch (error) {
            if (!['NoPath', 'Timeout', 'PartialRoute'].includes(error.name)) throw error
            this.check()
            this.bot.pathfinder.setGoal(null)
          } finally {
            movements.scafoldingBlocks = materials
          }
          // The movement graph does not remember supports placed by earlier hypothetical
          // steps. Build one valid neighbor step, verify it, then replan on actual terrain.
          const visited = new Set()
          for (let step = 0; step < 16; step++) {
            this.check()
            await this.settleStance()
            if (this.canWork(pos) || goal.isEnd(this.bot.entity.position.floored())) return
            const feet = this.bot.entity.position.floored()
            const current = new Move(feet.x, feet.y, feet.z, movements.countScaffoldingItems(), 0)
            visited.add(key(feet))
            const choices = movements
              .getNeighbors(current)
              .filter(
                (n) =>
                  !visited.has(key(n)) &&
                  n.toPlace.every(p => !this.canopyCellOccupied(p)) &&
                  n.y >= feet.y - 2 &&
                  n.y <= Math.max(pos.y, feet.y) &&
                  (goal.isEnd(n) || n.distanceTo(pos) < feet.distanceTo(pos) + 0.25),
              )
              .sort(
                (a, b) =>
                  Number(goal.isEnd(b)) - Number(goal.isEnd(a)) ||
                  a.distanceTo(pos) - b.distanceTo(pos),
              )
            if (!choices.length)
              throw new Error(
                'No supported next canopy step. Provide dirt or clear access beside this tree.',
              )
            const next = choices[0]
            this.agent.log?.(
              'tree.climb',
              `Climbing supported canopy step ${step + 1}; ${next.toPlace.length} placement(s).`,
            )
            await this.clearCanopyLeaves(next.toBreak)
            // Clearing a leaf can change the landing. Replan instead of trying
            // to place a block through the bot's actual collision box.
            if (next.toPlace.some(p => this.canopyCellOccupied(p))) continue
            for (const placement of next.toPlace) await this.placeCanopy(placement)
            try {
              this.check()
              movements.scafoldingBlocks = []
              await this.bot.pathfinder.goto(new goals.GoalBlock(next.x, next.y, next.z))
              await this.settleStance()
            } finally {
              movements.scafoldingBlocks = materials
            }
            const actual = this.bot.entity.position.floored()
            if (
              !actual.equals(next) ||
              this.bot.blockAt(actual.offset(0, -1, 0))?.boundingBox !== 'block'
            )
              throw new Error('Canopy step was not reached on confirmed support.')
          }
          throw new Error('Canopy access reached its 16-step limit; unfinished tree saved.')
        },
        60000,
        'Build stairs and climb to the remaining tree logs',
      )
      // The search can plan through removable leaves. Clear the actual sight line
      // from the reached stance, one confirmed leaf at a time.
      for (let n = 0; n < 8 && !this.canWork(pos); n++) {
        const eye = this.bot.entity.position.offset(0, 1.62, 0),
          delta = pos.offset(0.5, 0.5, 0.5).minus(eye)
        const distance = delta.norm()
        const hit = this.bot.world.raycast(eye, delta.normalize(), distance + 0.01)
        if (
          hit?.name !== `${this.job.species}_leaves` ||
          hit.getProperties?.().persistent === true ||
          !this.canWork(hit.position)
        )
          break
        await this.clearCanopyLeaves([hit.position])
      }
      if (!this.canWork(pos))
        throw new Error('Upper log is still out of reach; retaining unfinished tree.')
    } finally {
      this.bot.pathfinder.setGoal(null)
      if (this.agent.bot === this.bot) this.bot.pathfinder.setMovements(before)
    }
  }
  safeTarget(block) {
    if (!super.safeTarget(block)) return false
    if (['dirt', 'grass_block'].includes(block.name)) {
      if (!isAir(this.bot.blockAt(block.position.offset(0, 1, 0)))) return false
      if (
        this.job?.roots.some((p) => Math.hypot(p.x - block.position.x, p.z - block.position.z) < 6)
      )
        return false
      for (let x = -2; x <= 2; x++)
        for (let z = -2; z <= 2; z++)
          if (this.bot.blockAt(block.position.offset(x, 0, z))?.name === 'farmland') return false
    }
    return true
  }
  async findTree() {
    const names = SPECIES.map((s) => `${s}_log`)
    const matching = names.map((n) => this.bot.registry.blocksByName[n].id)
    const eligible = (b) =>
      b &&
      b.position.distanceTo(this.origin) <= 80 &&
      SOIL.has(this.bot.blockAt(b.position.offset(0, -1, 0))?.name)
    const candidates = this.bot
      .findBlocks({ matching, maxDistance: 48, count: 256, useExtraInfo: eligible })
      .map((p) => this.bot.blockAt(p))
      .filter(eligible)
    for (const b of candidates.slice(0, 24)) {
      try {
        return inspectTree(this.bot, b)
      } catch (error) {
        this.addIssue(error.message)
      }
    }
    return null
  }
  async plantingStock(job) {
    const seed = `${job.species}_sapling`,
      needed = job.roots.length - job.planted.length
    if (this.count(seed) >= needed) return
    this.decide(`Collecting ${seed.replaceAll('_', ' ')} before cutting the tree.`)
    for (const p of job.roots) await this.pickup(p)
    const leaves = this.find(
      [`${job.species}_leaves`],
      32,
      (b) =>
        b.getProperties?.().persistent !== true &&
        job.logs.some((p) => p.distanceTo(b.position) <= 4),
    )
    for (const leaf of leaves.slice(0, 48)) {
      if (this.count(seed) >= needed) break
      try {
        await this.approach(leaf.position)
        await this.dig(
          leaf.position,
          leaf.name,
          () => true,
          (item) => !item || (!/shears/.test(item.name) && this.withoutSilk(item)),
        )
        await this.pickup(leaf.position)
      } catch (error) {
        if (error.fatal || this.cancelled()) throw error
        this.addIssue(error.message)
      }
    }
    if (this.count(seed) < needed)
      throw new Error(
        `Need ${needed} ${seed.replaceAll('_', ' ')} reserved for replanting. Drop saplings beside ${this.agent.username}.`,
      )
  }
  // Work through the inspected tree job; leave enough information to resume and replant it.
  async harvestTree() {
    const job = this.job
    await this.plantingStock(job)
    let remaining = job.logs.filter((p) => this.bot.blockAt(p)?.name === `${job.species}_log`)
    this.plan.remaining = remaining.length
    // Clear the base and trunk upward, then recover our supports before replanting.
    remaining.sort(
      (a, b) =>
        a.y - b.y ||
        a.distanceTo(this.bot.entity.position) - b.distanceTo(this.bot.entity.position),
    )
    for (const p of remaining) {
      this.check()
      if (this.bot.inventory.emptySlotCount() < 4 && this.agent.colony?.enabled)
        await require('./storage.cjs').store(this)
      if (this.bot.inventory.emptySlotCount() < 2)
        throw new Error(this.agent.colony?.enabled
          ? 'Inventory is full. Enroll a reachable wood or overflow chest with free space before continuing.'
          : `Inventory is full. Empty ${this.agent.username} inventory before continuing.`)
      this.decide(`Harvesting the full ${job.species} tree · ${this.plan.remaining} logs left.`)
      await this.reachLog(p)
      await this.dig(p, `${job.species}_log`)
      job.removed++
      this.plan.logs++
      this.counts.mined++
      this.plan.remaining--
      this.sync()
      this.saveJob()
    }
    if (
      job.logs.some(
        (p) => !this.bot.blockAt(p) || this.bot.blockAt(p).name === `${job.species}_log`,
      )
    )
      throw new Error('Tree removal is incomplete; retaining this tree for the next attempt.')
    await this.recoverScaffolds()
    for (const p of job.roots) {
      if (job.planted.includes(key(p))) continue
      const seed = `${job.species}_sapling`
      if (this.bot.blockAt(p)?.name !== seed) {
        const soil = this.bot.blockAt(p.offset(0, -1, 0))
        if (!SOIL.has(soil?.name)) throw new Error('Tree planting soil changed.')
        const type = this.bot.registry.blocksByName[seed]
        const ack = watchBlock(this.bot, p, (s) => s >= type.minStateId && s <= type.maxStateId, this.controller.signal)
        try {
          await this.placeItem(seed, soil)
          await this.timed(() => ack.promise, 4000, 'Confirm replanted sapling')
        } finally {
          ack.cleanup()
        }
      }
      job.planted.push(key(p))
      this.plan.planted++
      this.counts.planted++
      this.sync()
      this.saveJob()
      await this.pickup(p)
    }
    this.plan.trees++
    this.agent.treeJobs.delete(this.jobKey)
    this.saveJob()
    this.job = null
  }
  async run() {
    const collect = (entity) => {
      if (entity.id === this.bot.entity.id && !this.cancelled()) {
        this.counts.collectedStacks++
        this.sync()
      }
    }
    this.bot.on('playerCollect', collect)
    const float = () => {
      if (!this.cancelled() && this.bot.entity.isInWater && !this.recoveringAir && this.task.travel?.status !== 'running')
        this.bot.setControlState('jump', true)
    }
    this.bot.on('physicsTick', float)
    const guard = setInterval(() => {
      if (this.cancelled()) return
      this.requestAir()
      const danger = this.safety()
      if (danger && !this.cancelled())
        this.controller.abort(Object.assign(new Error(danger), { fatal: true }))
    }, 500)
    try {
      while (true) {
        const progressBefore = (this.job?.removed || 0) + (this.job?.planted.length || 0)
        const supportsBefore = this.job?.scaffolds?.length || 0
        try {
          this.check()
          await this.eat()
          if (!this.job) {
            this.job = await this.findTree()
            if (this.job) {
              this.agent.treeJobs.set(this.jobKey, this.job)
              this.saveJob()
            }
          }
          if (!this.job)
            throw new Error('No supported mature trees nearby. Waiting for saplings to grow.')
          // After an interrupted climb, return safely before collecting supplies.
          if (this.job.scaffolds?.length) await this.recoverScaffolds()
          await this.agent.coordination?.returnSupplies(this)
          // Dirt columns need dirt specifically; recover scaffolds before the supply trip.
          await require('./building-supplies.cjs').ensure(this,{names:['dirt'],threshold:8})
          await this.harvestTree()
          this.stalledPasses = 0
          this.decide('Full tree harvested and replanted. Looking for the next tree.')
          await this.pause(1000)
        } catch (error) {
          if (error.fatal || this.cancelled()) throw error
          if (error.code === 'AIR_RECOVERY' || this.needsAir) {
            await this.recoverAir()
            continue
          }
          const progressAfter = (this.job?.removed || 0) + (this.job?.planted.length || 0)
          this.stalledPasses = !this.job || progressAfter > progressBefore || (this.job.scaffolds?.length || 0) < supportsBefore ? 0 : (this.stalledPasses || 0) + 1
          if (this.job && this.stalledPasses >= 3)
            throw new Error(
              `No progress after three attempts. Unfinished tree saved. ${error.message} Move Jerry to another side of the tree or provide access blocks, then restart tree farming.`,
            )
          this.addIssue(error.message)
          this.decide(`Tree farmer waiting: ${error.message}`)
          const delay = this.job ? 1500 : 10000
          this.plan.waitingUntil = Date.now() + delay
          this.agent.publish()
          try { await this.pause(delay) } catch (waitError) {
            if (waitError.code !== 'AIR_RECOVERY') throw waitError
            await this.recoverAir()
          }
          this.plan.waitingUntil = null
        }
      }
    } catch (error) {
      const reason = this.controller.signal.reason || error
      this.plan.status = reason.code === 'CANCELLED' ? 'cancelled' : 'paused'
      this.task.status = this.plan.status === 'cancelled' ? 'cancelled' : 'partial'
      this.decideStopped(reason)
    } finally {
      this.bot.off('playerCollect', collect)
      this.bot.off('physicsTick', float)
      clearInterval(guard)
      this.plan.waitingUntil = null
      if (this.agent.bot === this.bot) {
        this.bot.pathfinder.setGoal(null)
        this.bot.clearControlStates()
        if (this.agent.baseMovements) this.bot.pathfinder.setMovements(this.agent.baseMovements)
        if (this.task.status === 'partial' && this.agent.nav === this.id && this.bot.entity.isInWater)
          this.bot.setControlState('jump', true)
      }
      this.agent.publish()
    }
  }
  decideStopped(error) {
    this.plan.decision = `Tree farmer ${this.plan.status}: ${error.message}`
    this.task.label = this.plan.decision
    this.addIssue(error.message)
    this.agent.say(this.plan.decision)
  }
}
module.exports = { TreeFarm, inspectTree, SPECIES, CanopyGoal }
