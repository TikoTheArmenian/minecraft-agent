/**
 * TERRAFORMER: levels one bounded rectangle of columns to a target height.
 * Finite, resumable job: survey → budget fill material → cut top-down → fill outside-in → store.
 * Every cut and fill is server-confirmed; player structures and everything near them are skipped.
 * Progress is saved per world/dimension so a bare `terraform` continues an unfinished rectangle.
 */

const fs = require('node:fs')
const path = require('node:path')
const { Vec3 } = require('vec3')
const { Survival } = require('./survival.cjs')
const { Work } = require('./work.cjs')
const { BUILDING_BLOCKS, TravelMovements } = require('./travel.cjs')
const { BlockApproachGoal, canView, workingCell } = require('./block-approach.cjs')
const { isAir } = require('./world.cjs')
const { watchBlock } = require('./block-updates.cjs')
const { nearbyFirst } = require('./work-order.cjs')
const storage = require('./storage.cjs')

const key = (p) => `${p.x},${p.y},${p.z}`
const column = (x, z) => `${x},${z}`
const liquid = (b) => !!b && /^(water|lava)$/.test(b.name)
// A cell that a fill block may occupy: air, liquid, or shapeless vegetation that is cut first.
const open = (b) => !!b && (isAir(b) || liquid(b) || (b.boundingBox === 'empty' && !protectedBlock(null, b)))
const solid = (b) => b?.boundingBox === 'block'

const MAX_SIDE = 32 // Columns per axis; a bigger area should be several jobs.
const MAX_REACH = 64 // Both corners must be this close when the job starts.
const CUT_ABOVE = 8 // Blocks above the target surface that may be cut; anything higher refuses the job.
const FILL_BELOW = 3 // Supporting blocks placed under a missing surface block.
const PROTECT_BUFFER = 2 // Columns kept untouched around any protected block.
const DEADLINE_MS = 60 * 60 * 1000
// Working stock kept out of surplus deposits; outstanding fill demand is added on top while filling.
const BASE_RESERVES = { dirt: 128, cobblestone: 64, cobbled_deepslate: 64, stone: 64 }
// Cut blocks that drop usable fill material, and what they drop as.
const FILL_YIELD = {
  dirt: 'dirt', grass_block: 'dirt', podzol: 'dirt', mycelium: 'dirt', rooted_dirt: 'dirt', dirt_path: 'dirt',
  stone: 'cobblestone', cobblestone: 'cobblestone', deepslate: 'cobbled_deepslate', cobbled_deepslate: 'cobbled_deepslate',
  andesite: 'andesite', diorite: 'diorite', granite: 'granite', netherrack: 'netherrack',
}

/**
 * PROTECTED BLOCKS: never cut, bury, or dig beside these. Any column within PROTECT_BUFFER
 * columns of one is skipped with a reason. Containers, workstations, signs, lighting, crops and
 * their irrigation, unbreakable/valuable terrain, furniture, doors, fences, glass, rails, and
 * anything carrying a block entity (spawners, banners, beds, chests…) all count.
 */
const PROTECTED_NAMES = new Set([
  'chest', 'trapped_chest', 'barrel', 'furnace', 'blast_furnace', 'smoker', 'crafting_table',
  'torch', 'farmland', 'wheat', 'carrots', 'potatoes', 'beetroots', 'bedrock', 'obsidian',
  'crying_obsidian', 'glass', 'rail', 'powered_rail', 'detector_rail', 'activator_rail',
])
const PROTECTED_PATTERNS = [/_sign$/, /_torch$/, /_bed$/, /_door$/, /_fence$/, /_fence_gate$/, /glass/, /_rail$/]
function protectedBlock(bot, block) {
  if (!block) return false
  if (PROTECTED_NAMES.has(block.name) || PROTECTED_PATTERNS.some((re) => re.test(block.name))) return true
  if (block.entity) return true
  // Farm irrigation: water touching farmland (same level or one below the field).
  if (bot && block.name === 'water')
    for (let dx = -1; dx <= 1; dx++)
      for (let dz = -1; dz <= 1; dz++)
        for (const dy of [0, 1])
          if ((dx || dz || dy) && bot.blockAt(block.position.offset(dx, dy, dz))?.name === 'farmland') return true
  return false
}

// `flatten X1 Z1 to X2 Z2 at Y` → validated rectangle; bare aliases are handled by skills.cjs.
function parseTerraformer(text) {
  const s = String(text || '').trim().toLowerCase().replace(/\s+/g, ' ').replace(/[.!?]+$/, '')
  const m = s.match(/^flatten\s+(-?\d+)[ ,]+(-?\d+)\s+to\s+(-?\d+)[ ,]+(-?\d+)\s+at\s+(?:y\s*=?\s*)?(-?\d+)$/)
  if (!m) {
    if (/^flatten\b/.test(s))
      throw new Error('Use "flatten X1 Z1 to X2 Z2 at Y", for example flatten -600 1150 to -594 1156 at 70.')
    return null
  }
  const [x1, z1, x2, z2, y] = m.slice(1).map(Number)
  if ([x1, z1, x2, z2, y].some((v) => !Number.isSafeInteger(v)) || [x1, z1, x2, z2].some((v) => Math.abs(v) > 30000000))
    throw new Error('Use whole-block coordinates within ±30,000,000.')
  if (y < -60 || y > 300) throw new Error('Choose a target height between -60 and 300.')
  const min = { x: Math.min(x1, x2), z: Math.min(z1, z2) }, max = { x: Math.max(x1, x2), z: Math.max(z1, z2) }
  if (max.x - min.x + 1 > MAX_SIDE || max.z - min.z + 1 > MAX_SIDE)
    throw new Error(`Select at most ${MAX_SIDE}×${MAX_SIDE} columns; split a larger area into several jobs.`)
  return { type: 'terraformer', min, max, y }
}
const sameArea = (a, b) =>
  !!a && !!b && a.y === b.y && a.min.x === b.min.x && a.min.z === b.min.z && a.max.x === b.max.x && a.max.z === b.max.z

class Terraformer extends Survival {
  constructor(agent, id) {
    const previous = agent.state.survival
    super(agent, id)
    agent.state.survival = previous
    this.deadline = Date.now() + DEADLINE_MS
    this.task.deadlineAt = this.deadline
    this.task.continuous = false
    this.task.skill = 'TERRAFORMER'
    this.origin = this.bot.entity.position.clone()
    this.reserves = { ...BASE_RESERVES }
    this.plan = {
      status: 'planning',
      decision: 'Reading the selected rectangle.',
      area: null,
      columns: 0,
      done: 0,
      cut: 0,
      filled: 0,
      needFill: 0,
      carriedFill: 0,
      skipped: [],
      skippedCount: 0,
      deficit: 0,
      storage: null,
      waitingUntil: null,
    }
    agent.state.terraformer = this.plan
    this.jobKey = `${agent.state.world}:${agent.state.dimension}`
    this.jobFile = agent.dataDir ? path.join(agent.dataDir, 'terraform-jobs.json') : null
    this.jobs = {}
    if (this.jobFile && fs.existsSync(this.jobFile)) {
      try { this.jobs = JSON.parse(fs.readFileSync(this.jobFile, 'utf8')) } catch { this.jobs = {} }
    }
    this.job = null
    this.stalledPasses = 0
    this.failures = []
    this.hub = undefined
    this.storageExhausted = false
  }
  get username() { return this.agent.username || this.bot.username || 'Terra' }
  // Persist the unfinished rectangle so a reconnect or Stop does not lose the job (atomic rename).
  saveJob() {
    if (this.job) this.job.updatedAt = Date.now()
    if (!this.jobFile) return
    fs.mkdirSync(path.dirname(this.jobFile), { recursive: true })
    fs.writeFileSync(this.jobFile + '.tmp', JSON.stringify(this.jobs), { mode: 0o600 })
    fs.renameSync(this.jobFile + '.tmp', this.jobFile)
  }
  check() {
    if (!this.cancelled() && this.bot.game.gameMode !== 'survival')
      throw Object.assign(new Error(`${this.username} left Survival mode. Switch it back, then run terraform again.`), { fatal: true })
    if (!this.cancelled() && Date.now() >= this.deadline)
      throw Object.assign(new Error('Terraforming reached its 60-minute limit. Progress is saved; run terraform again to continue.'), { fatal: true })
    Work.prototype.check.call(this)
    const danger = this.safety()
    if (danger) throw Object.assign(new Error(danger), { fatal: true })
  }
  safety() {
    return super.safety()?.replaceAll('Marc', this.username) || null
  }
  // Survival's gatherer (used by the shared building-supply policy) must never quarry the rectangle.
  safeTarget(block) {
    if (!super.safeTarget(block)) return false
    const a = this.job?.area
    if (a && block.position.x >= a.min.x - PROTECT_BUFFER && block.position.x <= a.max.x + PROTECT_BUFFER &&
      block.position.z >= a.min.z - PROTECT_BUFFER && block.position.z <= a.max.z + PROTECT_BUFFER) return false
    return true
  }
  decide(text) {
    this.plan.decision = text
    this.progress(text)
  }
  carriedFill() {
    return this.bot.inventory.items().filter((i) => BUILDING_BLOCKS.includes(i.name)).reduce((n, i) => n + i.count, 0)
  }
  // Keep outstanding fill demand out of surplus deposits until the surface is complete.
  updateReserves(outstanding = 0) {
    for (const name of Object.keys(BASE_RESERVES)) this.reserves[name] = BASE_RESERVES[name] + outstanding
  }

  // ----- Survey: read live blocks for every column and decide cut / fill / skip / refuse -----
  survey() {
    const a = this.job.area
    const skipped = [], protectedColumns = new Map()
    const scan = (x, z) => {
      for (let y = a.y - FILL_BELOW; y <= a.y + CUT_ABOVE; y++) {
        const b = this.bot.blockAt(new Vec3(x, y, z))
        if (protectedBlock(this.bot, b)) return b
      }
      return null
    }
    for (let x = a.min.x - PROTECT_BUFFER; x <= a.max.x + PROTECT_BUFFER; x++)
      for (let z = a.min.z - PROTECT_BUFFER; z <= a.max.z + PROTECT_BUFFER; z++) {
        const b = scan(x, z)
        if (b) protectedColumns.set(column(x, z), b)
      }
    const cuts = [], fills = [], tooTall = [], unloaded = [], done = []
    let needFill = 0
    for (let x = a.min.x; x <= a.max.x; x++)
      for (let z = a.min.z; z <= a.max.z; z++) {
        const id = column(x, z)
        let guard = null
        for (let dx = -PROTECT_BUFFER; dx <= PROTECT_BUFFER && !guard; dx++)
          for (let dz = -PROTECT_BUFFER; dz <= PROTECT_BUFFER && !guard; dz++) guard = protectedColumns.get(column(x + dx, z + dz))
        if (guard) {
          skipped.push({ x, z, reason: `protected ${guard.name} at ${key(guard.position)}` })
          continue
        }
        const at = (y) => this.bot.blockAt(new Vec3(x, y, z))
        let missing = false
        for (let y = a.y - FILL_BELOW; y <= a.y + CUT_ABOVE + 1 && !missing; y++) if (!at(y)) missing = true
        if (missing) { unloaded.push(id); continue }
        if (solid(at(a.y + CUT_ABOVE + 1))) { tooTall.push(id); continue }
        const columnCuts = [], columnFills = []
        let blockedBy = null
        for (let y = a.y + CUT_ABOVE; y > a.y; y--) {
          const b = at(y)
          if (isAir(b)) continue
          if (liquid(b)) { blockedBy = `${b.name} above the target level cannot be removed`; break }
          if (!b.diggable || b.hardness < 0) { blockedBy = `${b.name} cannot be mined`; break }
          columnCuts.push({ pos: b.position.clone(), name: b.name })
        }
        if (blockedBy) { skipped.push({ x, z, reason: blockedBy }); continue }
        // Fill the surface cell and up to FILL_BELOW contiguous open cells beneath it.
        for (let y = a.y; y >= a.y - FILL_BELOW; y--) {
          const b = at(y)
          if (!open(b)) break
          if (!isAir(b) && !liquid(b)) columnCuts.push({ pos: b.position.clone(), name: b.name })
          columnFills.push(y)
        }
        if (!columnCuts.length && !columnFills.length) { done.push(id); continue }
        cuts.push(...columnCuts)
        if (columnFills.length) fills.push({ x, z, cells: columnFills.reverse() })
        needFill += columnFills.length
      }
    const expectedYield = cuts.filter((c) => FILL_YIELD[c.name]).length
    return { cuts, fills, needFill, expectedYield, skipped, tooTall, unloaded, done, columns: (a.max.x - a.min.x + 1) * (a.max.z - a.min.z + 1) }
  }
  publishSurvey(s) {
    this.job.done = s.done
    this.plan.columns = s.columns
    this.plan.done = s.done.length
    this.plan.skipped = s.skipped.slice(0, 20)
    this.plan.skippedCount = s.skipped.length
    this.plan.needFill = s.needFill
    this.plan.carriedFill = this.carriedFill()
    this.saveJob()
    this.agent.publish()
  }

  // ----- Budget: fill material comes from cut blocks first, then shared storage -----
  async storageHub() {
    if (this.hub !== undefined) return this.hub
    this.hub = null
    if (!this.agent.colony?.enabled) { this.plan.storage = 'Colony storage is disabled; surplus stays in inventory.'; return null }
    try {
      const { position } = await storage.call(this, 'hub_get')
      if (!position) this.plan.storage = 'No storage hub is configured; skipping shared storage.'
      else if (new Vec3(position.x, position.y, position.z).distanceTo(this.origin) > 80)
        this.plan.storage = `Storage hub at ${position.x} ${position.y} ${position.z} is more than 80 blocks from this job; skipping shared storage.`
      else this.hub = position
    } catch (error) {
      this.check()
      this.plan.storage = `Shared storage unavailable: ${error.message}`
    }
    return this.hub
  }
  async budget(s) {
    this.plan.status = 'budgeting'
    this.updateReserves(s.needFill)
    const carried = this.carriedFill()
    this.plan.carriedFill = carried
    const hub = await this.storageHub()
    if (hub && !this.toolsChecked) {
      this.toolsChecked = true
      for (const tool of ['iron_pickaxe', 'iron_shovel'])
        if (!require('./colony-chat.cjs').hasTool(this.bot.inventory.items(), tool)) {
          this.decide(`Fetching a ${tool.replaceAll('_', ' ')} from shared storage.`)
          try { await storage.retrieve(this, [tool], 1) } catch (error) { this.check(); if (error.fatal) throw error; this.addIssue(`Tool pickup: ${error.message}`) }
        }
    }
    const shortfall = s.needFill - carried - s.expectedYield
    if (shortfall <= 0 || !hub || this.storageExhausted) {
      this.decide(`Budget: ${s.needFill} fill blocks needed, ${carried} carried, about ${s.expectedYield} expected from cuts; ${s.cuts.length} blocks to cut.`)
      return
    }
    const target = Math.min(s.needFill, carried + 128)
    this.decide(`Budget: ${s.needFill} fill blocks needed, ${carried} carried; retrieving building blocks from shared storage (target ${target}).`)
    try {
      const moved = await storage.retrieve(this, BUILDING_BLOCKS, target)
      if (!moved) this.storageExhausted = true
      this.counts.retrieved = (this.counts.retrieved || 0) + moved
    } catch (error) {
      this.check()
      if (error.fatal) throw error
      this.storageExhausted = true
      this.addIssue(`Storage retrieval failed: ${error.message}`)
    }
    this.plan.carriedFill = this.carriedFill()
  }
  async storeSurplus(reason) {
    const hub = await this.storageHub()
    if (!hub) return 0
    this.plan.status = 'storing'
    this.decide(`Storing surplus in shared storage (${reason}).`)
    try {
      return await storage.store(this)
    } catch (error) {
      this.check()
      if (error.fatal) throw error
      this.addIssue(`Storage deposit failed: ${error.message}`)
      return 0
    }
  }
  async inventoryRoom() {
    if (this.bot.inventory.emptySlotCount() < 4) await this.storeSurplus('inventory nearly full')
    if (this.bot.inventory.emptySlotCount() < 2)
      throw Object.assign(new Error(this.hub
        ? 'Inventory is full and shared storage could not take the surplus. Free chest space, then run terraform again.'
        : `Inventory is full. Empty ${this.username}'s inventory or enable shared storage near this job, then run terraform again.`), { code: 'BLOCKED' })
  }

  // ----- Cut: layer by layer from the top, serpentine rows, nearest target within the row -----
  cuttable(b) {
    if (!b || isAir(b) || !b.diggable || b.hardness < 0 || protectedBlock(this.bot, b)) return false
    const sides = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]].map((d) => this.bot.blockAt(b.position.offset(...d)))
    if (sides.some((n) => !n || protectedBlock(this.bot, n))) return false
    // Removing a block above the target level beside liquid would flood the rectangle.
    return b.position.y <= this.job.area.y || !sides.some(liquid)
  }
  // Find a stance that sees the block without standing on it; exclude stances that failed.
  async approachCut(pos) {
    const excluded = new Set()
    for (let attempt = 0; attempt < 3; attempt++) {
      this.check()
      const feet = workingCell(this.bot), block = this.bot.blockAt(pos)
      const standingOnIt = feet.x === pos.x && feet.z === pos.z && feet.y === pos.y + 1
      if (!standingOnIt && block && canView(this.bot, pos) && this.bot.canDigBlock(block)) return
      excluded.add(key(feet))
      excluded.add(key(this.bot.entity.position.floored()))
      const goal = new BlockApproachGoal(this.bot, pos)
      const base = goal.isEnd.bind(goal)
      goal.isEnd = (node) => !excluded.has(key(node)) && base(node)
      await this.travel(goal, `Walk to a working stance beside ${key(pos)}`)
    }
    throw new Error('No clear working stance after three approaches.')
  }
  async cutOne(block) {
    const pos = block.position
    try {
      await this.inventoryRoom()
      this.decide(`Cutting ${block.name.replaceAll('_', ' ')} at ${key(pos)} · ${this.job.cut} cut, ${this.job.filled} filled.`)
      await this.approachCut(pos)
      const live = this.bot.blockAt(pos)
      if (!live || isAir(live)) return true
      if (!this.cuttable(live)) throw new Error(`${live.name} is beside liquid or a protected block; left in place.`)
      await this.dig(pos, live.name, (b) => this.cuttable(b))
      this.job.cut++
      this.plan.cut = this.job.cut
      this.counts.mined++
      this.sync()
      this.saveJob()
      await this.pickup(pos)
      return true
    } catch (error) {
      if (error.fatal || error.code === 'CANCELLED' || error.code === 'BLOCKED') throw error
      this.check()
      const message = `${key(pos)}: ${error.message.replaceAll('Marc', this.username)}`
      this.failures.push(message)
      this.addIssue(message)
      return false
    }
  }
  async cutLayers(s) {
    if (!s.cuts.length) return
    this.plan.status = 'cutting'
    const layers = [...new Set(s.cuts.map((c) => c.pos.y))].sort((a, b) => b - a)
    for (const y of layers) {
      this.check()
      const rows = new Map()
      for (const c of s.cuts.filter((c) => c.pos.y === y)) (rows.get(c.pos.z) || rows.set(c.pos.z, []).get(c.pos.z)).push(c)
      const order = [...rows.keys()].sort((a, b) => a - b)
      order.forEach((z, index) => rows.get(z).sort((a, b) => (index % 2 ? b.pos.x - a.pos.x : a.pos.x - b.pos.x)))
      for (const z of order) {
        const targets = rows.get(z).map((c) => this.bot.blockAt(c.pos)).filter((b) => b && !isAir(b))
        for (const block of nearbyFirst(this, targets)) {
          this.check()
          if (isAir(this.bot.blockAt(block.position))) continue
          await this.cutOne(block)
        }
      }
      // Layer boundary: a safe checkpoint for the colony's supply/return policy.
      this.decide(`Layer Y=${y} cut · ${this.job.cut} cut so far.`)
      await this.agent.coordination?.returnSupplies(this)
    }
  }

  // ----- Fill: outside ring first so every placed block has a face to build against -----
  fillItem(surface) {
    const items = this.bot.inventory.items().filter((i) => BUILDING_BLOCKS.includes(i.name) && i.count > 0)
    // Dirt on the surface keeps the result natural; spend stone types on hidden supports first.
    items.sort((a, b) => (surface ? Number(b.name === 'dirt') - Number(a.name === 'dirt') : Number(a.name === 'dirt') - Number(b.name === 'dirt')) ||
      BUILDING_BLOCKS.indexOf(a.name) - BUILDING_BLOCKS.indexOf(b.name))
    return items[0] || null
  }
  // Candidate reference faces for a fill, best first. Side walls at the destination's own level
  // come before the block below: from the surrounding surface a face two or three blocks down is
  // beyond stance reach, while a same-level wall stays reachable through the open pit.
  supportsFor(dest) {
    const here = this.bot.entity.position
    const sides = []
    for (const d of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]) {
      const n = this.bot.blockAt(dest.offset(...d))
      if (solid(n) && !protectedBlock(this.bot, n)) sides.push({ ref: n.position, face: new Vec3(-d[0], -d[1], -d[2]) })
    }
    sides.sort((a, b) => a.ref.distanceTo(here) - b.ref.distanceTo(here))
    const below = this.bot.blockAt(dest.offset(0, -1, 0))
    if (solid(below)) sides.push({ ref: below.position, face: new Vec3(0, 1, 0) })
    return sides
  }
  // Stand where the support face is visible while the body stays out of the destination cell.
  async standNear(ref, dest) {
    const occupies = (node) => node.x === dest.x && node.z === dest.z && (node.y === dest.y || node.y === dest.y - 1)
    const tooLow = (node) => node.y < dest.y - 1 // Eye must stay above the support's top face.
    const acceptable = (node) => !occupies(node) && !tooLow(node)
    const feet = workingCell(this.bot)
    if (acceptable(feet) && canView(this.bot, ref)) return
    const goal = new BlockApproachGoal(this.bot, ref, { interaction: true })
    const base = goal.isEnd.bind(goal)
    goal.isEnd = (node) => acceptable(node) && !(node.x === dest.x && node.z === dest.z) && base(node)
    await this.travel(goal, `Walk beside the fill spot ${key(dest)}`)
  }
  placementValid(dest, ref, face, name) {
    this.check()
    const target = this.bot.blockAt(dest), support = this.bot.blockAt(ref)
    if (!isAir(target) && !liquid(target)) throw new Error('Fill spot is no longer empty.')
    if (!solid(support)) throw new Error('Fill support changed before placement.')
    const eye = this.bot.entity.position.offset(0, 1.62, 0)
    if (eye.distanceTo(ref.offset(0.5, 0.5, 0.5).plus(face.scaled(0.5))) > 4.5) throw new Error('Fill spot is outside placement reach.')
    if (this.bot.heldItem?.name !== name || this.bot.heldItem.count < 1) throw new Error('Fill material is no longer equipped.')
    for (const entity of [this.bot.entity, ...Object.values(this.bot.entities || {})]) {
      if (!entity.position || entity.name === 'item') continue
      const p = entity.position, r = (entity.width || 0.6) / 2, h = entity.height || 1.8
      if (p.x + r > dest.x && p.x - r < dest.x + 1 && p.z + r > dest.z && p.z - r < dest.z + 1 && p.y + h > dest.y && p.y < dest.y + 1)
        throw new Error('A player or entity is standing in the fill spot.')
    }
    return support
  }
  async placeFill(dest, item) {
    const supports = this.supportsFor(dest)
    if (!supports.length) throw new Error('No solid face to build against yet.')
    let stance = null
    for (const candidate of supports) {
      try {
        await this.standNear(candidate.ref, dest)
        stance = candidate
        break
      } catch (error) {
        if (error.fatal || error.code === 'CANCELLED') throw error
        this.check()
        if (candidate === supports.at(-1)) throw error
      }
    }
    const { ref, face } = stance
    await this.equip(item)
    await this.timed(() => this.bot.lookAt(ref.offset(0.5, 0.5, 0.5).plus(face.scaled(0.5))), 5000, `Face the fill spot ${key(dest)}`)
    let current = this.placementValid(dest, ref, face, item.name)
    const type = this.bot.registry.blocksByName[item.name]
    const ack = watchBlock(this.bot, dest, (s) => s >= type.minStateId && s <= type.maxStateId, this.controller.signal)
    try {
      await this.timed(() => {
        current = this.placementValid(dest, ref, face, item.name)
        return this.bot._placeBlockWithOptions(current, face, { forceLook: 'ignore', swingArm: 'right' })
      }, 7000, `Place ${item.name} at ${key(dest)}`)
      await this.timed(() => ack.promise, 4000, `Confirm fill at ${key(dest)}`)
      if (this.bot.blockAt(dest)?.name !== item.name) throw new Error('The server did not confirm the fill block.')
      this.job.filled++
      this.plan.filled = this.job.filled
      this.counts.placed = (this.counts.placed || 0) + 1
      this.sync()
      this.saveJob()
    } finally {
      ack.cleanup()
    }
  }
  async fillColumn(x, z, cells) {
    const a = this.job.area
    // Bottom-up so each support rests on the one before it.
    for (const y of cells) {
      this.check()
      const dest = new Vec3(x, y, z)
      const b = this.bot.blockAt(dest)
      if (!b) throw new Error(`${key(dest)}: terrain is not loaded.`)
      if (!open(b)) continue
      if (!isAir(b) && !liquid(b)) throw new Error(`${key(dest)}: ${b.name} must be cut before filling.`)
      const item = this.fillItem(y === a.y)
      if (!item) throw Object.assign(new Error('Out of fill material.'), { code: 'NO_MATERIAL' })
      this.decide(`Filling ${key(dest)} with ${item.name.replaceAll('_', ' ')} · ${this.job.filled} placed so far.`)
      await this.placeFill(dest, item)
    }
  }
  async fillColumns(s) {
    if (!s.fills.length) return
    this.plan.status = 'filling'
    const a = this.job.area
    const ring = (c) => Math.min(c.x - a.min.x, a.max.x - c.x, c.z - a.min.z, a.max.z - c.z)
    const rings = new Map()
    for (const c of s.fills) (rings.get(ring(c)) || rings.set(ring(c), []).get(ring(c))).push(c)
    for (const r of [...rings.keys()].sort((x, y) => x - y)) {
      const byId = new Map(rings.get(r).map((c) => [column(c.x, c.z), c]))
      const anchors = rings.get(r).map((c) => this.bot.blockAt(new Vec3(c.x, a.y, c.z))).filter(Boolean)
      for (const anchor of nearbyFirst(this, anchors)) {
        this.check()
        const c = byId.get(column(anchor.position.x, anchor.position.z))
        try {
          await this.fillColumn(c.x, c.z, c.cells)
        } catch (error) {
          if (error.fatal || error.code === 'CANCELLED' || error.code === 'BLOCKED') throw error
          if (error.code === 'NO_MATERIAL') { this.addIssue('Ran out of fill material; cutting more or checking storage before continuing.'); return }
          this.check()
          const message = `${column(c.x, c.z)}: ${error.message.replaceAll('Marc', this.username)}`
          this.failures.push(message)
          this.addIssue(message)
        }
      }
    }
  }

  // ----- Job lifecycle -----
  chooseArea(command) {
    const saved = this.jobs[this.jobKey]
    if (command?.min && command?.max) {
      const area = { min: { x: command.min.x, z: command.min.z }, max: { x: command.max.x, z: command.max.z }, y: command.y }
      return { area, resume: !!saved && saved.status !== 'complete' && sameArea(saved.area, area) }
    }
    if (saved && saved.status !== 'complete') return { area: saved.area, resume: true }
    const p = this.bot.entity.position.floored()
    return { area: { min: { x: p.x - 4, z: p.z - 4 }, max: { x: p.x + 4, z: p.z + 4 }, y: p.y - 1 }, resume: false }
  }
  finish(s, deficit) {
    const a = this.job.area
    const skippedNote = (s.skipped.length ? ` ${s.skipped.length} column(s) skipped: ${s.skipped.slice(0, 3).map((k) => `${k.x},${k.z} (${k.reason})`).join('; ')}${s.skipped.length > 3 ? '…' : ''}.` : '') +
      (this.plan.storage ? ` ${this.plan.storage}` : '')
    this.plan.deficit = deficit
    if (deficit) {
      this.job.status = 'partial'
      this.plan.status = 'partial'
      this.task.status = 'partial'
      this.plan.decision = `Partially flattened ${a.min.x},${a.min.z} to ${a.max.x},${a.max.z} at Y=${a.y}: ${this.job.cut} cut, ${this.job.filled} filled; short ${deficit} fill block(s). Give ${this.username} dirt or stock the shared building chest, then run terraform to continue.${skippedNote}`
    } else {
      this.job.status = 'complete'
      this.plan.status = 'complete'
      this.task.status = 'succeeded'
      this.plan.decision = `Flattened ${a.min.x},${a.min.z} to ${a.max.x},${a.max.z} at Y=${a.y}: ${s.columns} columns, ${this.job.cut} cut, ${this.job.filled} filled.${skippedNote}`
      delete this.jobs[this.jobKey]
    }
    this.plan.done = s.done.length
    this.saveJob()
    this.task.label = this.plan.decision
    this.agent.say(this.plan.decision)
  }
  async execute() {
    for (let pass = 0; pass < 64; pass++) {
      const before = this.job.cut + this.job.filled
      this.failures = []
      try {
        this.check()
        await this.eat()
        this.plan.status = 'planning'
        const s = this.survey()
        this.publishSurvey(s)
        if (s.tooTall.length)
          throw Object.assign(new Error(`Column ${s.tooTall[0].replace(',', ' ')} has solid blocks more than ${CUT_ABOVE} above Y=${this.job.area.y}: too tall; choose a higher target or smaller area.`), { code: 'REFUSED' })
        if (s.unloaded.length) throw new Error(`${s.unloaded.length} column(s) are not loaded; move closer to ${s.unloaded[0].replace(',', ' ')}.`)
        if (!s.cuts.length && !s.fills.length) {
          this.updateReserves(0)
          await this.storeSurplus('job finished')
          return this.finish(s, 0)
        }
        await this.budget(s)
        if (!s.cuts.length && s.needFill && !this.carriedFill() && (!this.hub || this.storageExhausted)) {
          this.updateReserves(0)
          await this.storeSurplus('job paused for material')
          return this.finish(s, s.needFill)
        }
        await this.cutLayers(s)
        await this.fillColumns(s)
        if (this.failures.length && this.job.cut + this.job.filled === before) throw new Error(this.failures.at(-1))
        this.stalledPasses = 0
      } catch (error) {
        if (error.fatal || this.cancelled() || ['CANCELLED', 'REFUSED'].includes(error.code)) throw error
        const after = this.job.cut + this.job.filled
        this.stalledPasses = after > before ? 0 : this.stalledPasses + 1
        if (this.stalledPasses >= 3)
          throw new Error(`No progress after three attempts: ${error.message} The unfinished job is saved; clear the blocker, then run terraform again.`)
        this.addIssue(error.message)
        this.decide(`Terraformer retrying after: ${error.message}`)
        this.plan.waitingUntil = Date.now() + 1500
        this.agent.publish()
        try { await this.pause(1500) } finally { this.plan.waitingUntil = null }
      }
    }
    throw new Error('Pass limit reached; the unfinished job is saved. Run terraform again to continue.')
  }
  async run(command = { type: 'terraformer' }) {
    const moves = new TravelMovements(this.bot)
    this.bot.pathfinder.setMovements(moves)
    const collect = (collector) => {
      if (!this.cancelled() && collector.id === this.bot.entity.id) { this.counts.collectedStacks++; this.sync() }
    }
    this.bot.on('playerCollect', collect)
    const guard = setInterval(() => {
      if (this.cancelled()) return
      const danger = this.safety()
      if (danger) this.controller.abort(Object.assign(new Error(danger), { fatal: true }))
    }, 500)
    try {
      const danger = this.safety()
      if (danger) throw Object.assign(new Error(danger), { fatal: true })
      const { area, resume } = this.chooseArea(command)
      const here = this.bot.entity.position
      for (const corner of [[area.min.x, area.min.z], [area.max.x, area.max.z]])
        if (Math.hypot(corner[0] + 0.5 - here.x, area.y + 1 - here.y, corner[1] + 0.5 - here.z) > MAX_REACH)
          throw Object.assign(new Error(`Both corners must be within ${MAX_REACH} blocks of ${this.username}. Move closer to ${area.min.x} ${area.y} ${area.min.z} – ${area.max.x} ${area.y} ${area.max.z}, then start again.`), { code: 'REFUSED' })
      const saved = this.jobs[this.jobKey]
      this.job = resume ? saved : { area, done: [], cut: 0, filled: 0, status: 'running', createdAt: Date.now() }
      this.job.status = 'running'
      this.jobs[this.jobKey] = this.job
      this.plan.area = area
      this.plan.cut = this.job.cut
      this.plan.filled = this.job.filled
      this.saveJob()
      this.decide(resume
        ? `Resuming the saved job: ${area.min.x},${area.min.z} to ${area.max.x},${area.max.z} at Y=${area.y} (${this.job.cut} cut, ${this.job.filled} filled so far).`
        : `Flattening ${area.min.x},${area.min.z} to ${area.max.x},${area.max.z} at Y=${area.y}.`)
      await this.execute()
    } catch (error) {
      const reason = this.controller.signal.reason || error
      const cancelled = reason.code === 'CANCELLED'
      const refused = error.code === 'REFUSED'
      this.plan.status = cancelled ? 'cancelled' : refused ? 'refused' : 'partial'
      this.task.status = cancelled ? 'cancelled' : refused ? 'failed' : 'partial'
      if (refused && this.job) { delete this.jobs[this.jobKey]; this.saveJob() }
      else if (this.job) { this.job.status = cancelled ? 'cancelled' : 'partial'; this.saveJob() }
      const message = reason.message || error.message
      this.plan.decision = `Terraformer ${this.plan.status}: ${message}`
      this.task.label = this.plan.decision
      this.addIssue(message)
      if (!cancelled) this.agent.say(this.plan.decision)
    } finally {
      this.bot.off('playerCollect', collect)
      clearInterval(guard)
      this.plan.waitingUntil = null
      this.updateReserves(0)
      if (this.agent.bot === this.bot && this.agent.nav === this.id) {
        this.bot.pathfinder.setGoal(null)
        this.bot.stopDigging()
        this.bot.clearControlStates()
        if (this.agent.baseMovements) this.bot.pathfinder.setMovements(this.agent.baseMovements)
      }
      this.sync()
      this.agent.publish()
    }
  }
}
module.exports = { Terraformer, parseTerraformer, protectedBlock, PROTECTED_NAMES, PROTECTED_PATTERNS, FILL_YIELD, CUT_ABOVE, FILL_BELOW, PROTECT_BUFFER }
