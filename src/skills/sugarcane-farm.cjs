/**
 * CONTINUOUS SUGAR CANE SKILL (bot Cane): harvests grown columns above their base, replants
 * along water, grows the patch, and stores surplus in shared storage. Runs until Stop.
 * Cycle: observe → eat/safety → harvest ready columns → plant/expand → store a batch →
 * returnSupplies checkpoint → wait only when nothing productive is left.
 * Sugar cane rules differ from wheat: no tilling, no seeds, no maturity age. A column is
 * ready when it is at least two blocks tall; breaking the second block drops everything
 * above it and the base keeps growing. The base is never dug and water is never removed.
 */

const { ResourceWork } = require('../capabilities/resources.cjs')
const { Work } = require('../runtime/work.cjs')
const { nearbyFirst } = require('../navigation/work-order.cjs')
const { TravelMovements, Travel } = require('../navigation/travel.cjs')
const { isAir } = require('../world/observations.cjs')
const { watchBlock } = require('../minecraft/block-updates.cjs')
const { BlockApproachGoal, canView, workingCell } = require('../navigation/block-approach.cjs')
const storage = require('../storage/service.cjs')

// Blocks sugar cane accepts as soil in Java 1.21.1 (verified against the game rule; moss and
// mangrove roots are omitted so the farmer stays on ordinary shoreline ground).
const SOIL = [
  'sand',
  'red_sand',
  'dirt',
  'grass_block',
  'podzol',
  'coarse_dirt',
  'mud',
  'rooted_dirt',
]
// Anything that marks another farmer's irrigated field. Cane keeps three blocks away from it.
const FARM = ['farmland', 'wheat', 'carrots', 'potatoes', 'beetroots']
const SIDES = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 0, 1],
  [0, 0, -1],
]
const RESERVE = 8 // Planting stock kept out of deposits so expansion never stalls.
const BATCH = 32 // Deposit once this many surplus canes are carried (plus the reserve).
const RESTOCK_TARGET = 16 // Withdraw up to this many when planting stock runs out.
const PLANT_LIMIT = 16 // New columns per pass; growth, not planting, is the bottleneck.
const HARVEST_LIMIT = 64
const GROWTH_WAIT = 20000 // One segment grows in roughly 18 game minutes; re-observe often.
const COOLDOWN = 60000 // Failed targets rest before attracting another approach.
const MAX_HEIGHT = 8
const key = (p) => `${p.x},${p.y},${p.z}`
const cane = (block) => block?.name === 'sugar_cane'

// Group loaded cane blocks into columns. The base is the cane block whose support is not
// cane; height counts the contiguous cane above it. Works for changed lower blocks too:
// if someone removes a base, the lowest remaining block becomes the new base.
function groupColumns(bot, blocks) {
  const columns = []
  for (const block of blocks) {
    if (!cane(block) || cane(bot.blockAt(block.position.offset(0, -1, 0)))) continue
    let height = 1
    while (height < MAX_HEIGHT && cane(bot.blockAt(block.position.offset(0, height, 0)))) height++
    columns.push({ base: block, height, ready: height >= 2 })
  }
  return columns
}
// Wheat farms and any other crop field are off limits, including their tilled edge.
function farmNearby(bot, pos, radius = 3) {
  for (let x = -radius; x <= radius; x++)
    for (let z = -radius; z <= radius; z++)
      for (let y = -1; y <= 2; y++)
        if (FARM.includes(bot.blockAt(pos.offset(x, y, z))?.name)) return true
  return false
}
// Sugar cane placement rule: accepted soil, a clear cell above (plus headroom so the
// placement helper can confirm it), and water touching one horizontal side of the SOIL.
function plantable(bot, soil) {
  if (!soil || !SOIL.includes(soil.name)) return false
  const p = soil.position
  if (!isAir(bot.blockAt(p.offset(0, 1, 0))) || !isAir(bot.blockAt(p.offset(0, 2, 0)))) return false
  if (!SIDES.some((d) => bot.blockAt(p.offset(...d))?.name === 'water')) return false
  return !farmNearby(bot, p)
}
const besideCane = (bot, soil) =>
  SIDES.some((d) => cane(bot.blockAt(soil.position.offset(d[0], 1, d[2]))))

class SugarcaneFarm extends ResourceWork {
  constructor(agent, id) {
    super(agent, id)
    this.origin ||= this.bot.entity.position.clone()
    this.deadline = Infinity
    this.task.deadlineAt = null
    this.task.continuous = true
    this.task.skill = 'SUGARCANE FARMER'
    this.reserves = { sugar_cane: RESERVE }
    this.plan = {
      status: 'running',
      decision: 'Looking for sugar cane and shoreline soil.',
      columns: 0,
      ready: 0,
      harvested: 0,
      planted: 0,
      stored: 0,
      cycles: 0,
      waitingUntil: null,
      blocker: null,
    }
    agent.state.sugarcaneFarm = this.plan
    this.cooldowns = new Map()
    this.nextRestockAt = 0
    this.nextStoreAt = 0
    this.stalledPasses = 0
    this.passErrors = 0
  }
  // Filter before the result cap so buried dirt cannot crowd shoreline soil out of the scan.
  find(names, radius = 48, predicate = () => true) {
    const matching = names
      .map((n) => this.bot.registry.blocksByName[n]?.id)
      .filter(Number.isInteger)
    if (!matching.length) return []
    const eligible = (b) =>
      b &&
      b.position.distanceTo(this.origin) <= 80 &&
      !this.failedTargets.has(`${b.position}:${b.name}`) &&
      predicate(b)
    return this.bot
      .findBlocks({ matching, maxDistance: radius, count: 1024, useExtraInfo: eligible })
      .map((p) => this.bot.blockAt(p))
      .filter(eligible)
      .sort(
        (a, b) =>
          a.position.distanceTo(this.bot.entity.position) -
          b.position.distanceTo(this.bot.entity.position),
      )
  }
  // Continuous farming handles air recovery while retaining Work cancellation checks.
  check() {
    Work.prototype.check.call(this)
    if (this.needsAir && !this.recoveringAir)
      throw Object.assign(new Error('Surfacing to restore air.'), { code: 'AIR_RECOVERY' })
    if (this.bot.game.gameMode !== 'survival')
      throw Object.assign(
        new Error(`${this.agent.username} left Survival mode. Switch it back, then restart.`),
        {
          fatal: true,
        },
      )
  }
  safety() {
    const danger = super.safety()
    if (!danger || danger.startsWith('Air is running low')) return null
    return danger
  }
  requestAir() {
    if (
      this.recoveringAir ||
      this.needsAir ||
      !this.bot.entity.isInWater ||
      !Number.isFinite(this.bot.oxygenLevel) ||
      this.bot.oxygenLevel >= 12
    )
      return
    this.needsAir = true
    this.bot.pathfinder.setGoal(null)
    this.bot.stopDigging()
    this.bot.clearControlStates()
  }
  async pause(ms = 200) {
    for (let left = ms; left > 0; left -= 250) {
      await Work.prototype.pause.call(this, Math.min(250, left))
      this.requestAir()
      this.check()
    }
  }
  // Cane grows beside water, so falling in is routine: surface, recover, resume the same routine.
  async recoverAir() {
    this.recoveringAir = true
    this.plan.waitingUntil = null
    try {
      this.decide(`${this.agent.username} is surfacing to restore air before continuing.`)
      const travel = new Travel(this, 15000)
      await travel.surface()
      const until = Date.now() + 10000
      while (this.bot.oxygenLevel < 18 && Date.now() < until) {
        this.check()
        await travel.tick()
      }
      if (this.bot.oxygenLevel < 18) throw new Error('Could not restore air after surfacing.')
      travel.activity.status = 'succeeded'
      this.needsAir = false
    } finally {
      this.recoveringAir = false
    }
  }
  // Bounded, non-fatal attempt: records the obstacle and lets the pass continue elsewhere.
  async attempt(label, fn) {
    try {
      this.check()
      return await fn()
    } catch (error) {
      if (
        error.fatal ||
        error.code === 'HANDOFF' ||
        error.code === 'AIR_RECOVERY' ||
        this.cancelled()
      )
        throw error
      this.passErrors++
      this.plan.blocker = `${label}: ${error.message}`
      this.addIssue(`${label}: ${error.message}`)
      return null
    }
  }
  coolingDown(pos) {
    const until = this.cooldowns.get(key(pos))
    if (until && until > Date.now()) return true
    this.cooldowns.delete(key(pos))
    return false
  }
  progressCount() {
    return (
      this.counts.harvested +
      this.counts.planted +
      (this.counts.stored || 0) +
      (this.counts.retrieved || 0)
    )
  }
  // Observe: every loaded cane block within 48 blocks (and 80 of the start) grouped into columns.
  survey() {
    this.check()
    const columns = groupColumns(this.bot, this.find(['sugar_cane'], 48))
    this.plan.columns = columns.length
    this.plan.ready = columns.filter((c) => c.ready).length
    this.agent.publish()
    return columns
  }
  // Harvest: dig ONLY the block above the base. The server drops the upper segments with it.
  async harvestReady(columns) {
    const bases = columns
      .filter((c) => c.ready && !this.coolingDown(c.base.position))
      .map((c) => c.base)
    let attempted = 0
    for (const base of nearbyFirst(this, bases)) {
      this.check()
      if (++attempted > HARVEST_LIMIT) break
      const top = base.position.offset(0, 1, 0)
      if (!cane(this.bot.blockAt(base.position)) || !cane(this.bot.blockAt(top))) continue
      if (this.bot.inventory.emptySlotCount() < 2) {
        await this.storeBatch(true)
        if (this.bot.inventory.emptySlotCount() < 2) {
          this.plan.blocker =
            'Inventory is full; sugar cane is left growing until space is available.'
          break
        }
      }
      const done = await this.attempt('Harvest sugar cane', async () => {
        this.decide(`Harvesting sugar cane above its base · ${this.plan.harvested} harvested`)
        await this.approach(top)
        // The predicate re-reads the base on every revalidation inside dig(): a missing base
        // means this is no longer the second segment, and digging it would end the column.
        await this.dig(top, 'sugar_cane', () => cane(this.bot.blockAt(base.position)))
        this.counts.harvested++
        this.plan.harvested++
        this.sync()
        await this.pause(300)
        await this.pickup(top)
        return true
      })
      if (!done) this.cooldowns.set(key(base.position), Date.now() + COOLDOWN)
      else this.checkpoint({ phase: 'cane-collected' })
    }
  }
  // Placement stance: the shared helper refuses to place from inside 1.5 blocks, and a
  // shoreline approach often ends there. Step to a viewing cell at least two blocks away first.
  async placeItem(name, support) {
    const spot = support.position.offset(0.5, 1, 0.5)
    const goal = new BlockApproachGoal(this.bot, support.position)
    const base = goal.isEnd.bind(goal)
    goal.isEnd = (node) => base(node) && node.offset(0.5, 0, 0.5).distanceTo(spot) >= 2
    if (!goal.isEnd(workingCell(this.bot)) || !canView(this.bot, support.position))
      await this.travel(goal, 'Step back to a clear view of the planting spot')
    return super.placeItem(name, support)
  }
  // Plant one cane on a soil block and count it only after the server reports the new block.
  async plantCane(soil) {
    const pos = soil.position.offset(0, 1, 0)
    const type = this.bot.registry.blocksByName.sugar_cane
    const ack = watchBlock(
      this.bot,
      pos,
      (state) => state >= type.minStateId && state <= type.maxStateId,
      this.controller.signal,
    )
    try {
      const current = this.bot.blockAt(soil.position)
      if (!plantable(this.bot, current)) throw new Error('Planting spot changed or lost its water.')
      if (this.count('sugar_cane') <= RESERVE) throw new Error('Planting stock is at the reserve.')
      await this.placeItem('sugar_cane', current)
      await this.timed(() => ack.promise, 4000, `Confirm sugar cane planted at ${key(pos)}`)
      this.check()
      if (!cane(this.bot.blockAt(pos))) throw new Error('Planting was not confirmed.')
      this.counts.planted++
      this.plan.planted++
      this.sync()
    } finally {
      ack.cleanup()
    }
  }
  // Plant/expand: shoreline soil beside water, growing outward from existing columns first.
  async plantMore() {
    if (this.count('sugar_cane') <= RESERVE) {
      // Restock only when the reserve itself is short: a deposit leaves exactly the reserve
      // behind, and fetching part of it straight back would be a wasted chest trip.
      if (this.count('sugar_cane') < RESERVE) await this.restock()
      if (this.count('sugar_cane') <= RESERVE) {
        this.plan.expansion = `Carrying ${this.count('sugar_cane')} sugar cane; the ${RESERVE}-cane reserve is kept for later planting.`
        return
      }
    }
    const spots = this.find(
      SOIL,
      48,
      (b) => plantable(this.bot, b) && !this.coolingDown(b.position),
    )
    const adjacent = spots.filter((b) => besideCane(this.bot, b))
    const others = spots.filter((b) => !besideCane(this.bot, b))
    this.plan.expansion = `${spots.length} plantable shoreline spots (${adjacent.length} beside existing cane).`
    const before = this.counts.planted
    let inspected = 0
    for (const group of [adjacent, others]) {
      for (const soil of nearbyFirst(this, group)) {
        if (++inspected > 48) return
        if (this.counts.planted - before >= PLANT_LIMIT || this.count('sugar_cane') <= RESERVE)
          return
        const done = await this.attempt('Plant sugar cane', async () => {
          this.decide(`Planting sugar cane along the water · ${this.plan.planted} planted`)
          await this.plantCane(soil)
          return true
        })
        if (!done) this.cooldowns.set(key(soil.position), Date.now() + COOLDOWN)
      }
    }
  }
  // Supplies: the colony's chests may hold cane from earlier deposits. Ask at most once a minute.
  async restock() {
    if (!this.agent.colony?.enabled || Date.now() < this.nextRestockAt) return
    this.nextRestockAt = Date.now() + COOLDOWN
    await this.attempt('Restock sugar cane from shared storage', async () => {
      this.decide('Planting stock is low; checking shared storage for sugar cane.')
      const moved = await storage.retrieve(this, ['sugar_cane'], RESTOCK_TARGET)
      if (!moved)
        this.plan.expansion = 'Shared storage has no sugar cane to plant; waiting for growth.'
    })
  }
  // Storage: stack-sized deposits or inventory pressure, never a chest trip for a few canes.
  async storeBatch(force = false) {
    if (!this.agent.colony?.enabled) {
      this.plan.storage = 'Shared storage is disabled; surplus sugar cane stays in inventory.'
      return
    }
    const pressure = this.bot.inventory.emptySlotCount() < 4
    if (!force && !pressure && this.count('sugar_cane') < BATCH + RESERVE) return
    if (!force && !pressure && Date.now() < this.nextStoreAt) return
    await this.attempt('Store sugar cane', async () => {
      this.decide(
        `Storing surplus sugar cane in shared storage · ${this.plan.stored} stored so far`,
      )
      const before = this.counts.stored || 0
      await storage.store(this)
      this.plan.stored = this.counts.stored || 0
      if (this.plan.stored === before) {
        // Deposits are counted only from confirmed transfers; back off before another trip.
        this.nextStoreAt = Date.now() + COOLDOWN
        throw new Error('No managed chest within 80 blocks of the start accepted sugar cane.')
      }
    })
  }
  // One pass: safety and food first, then local production, then supplies and storage.
  async cycle() {
    this.plan.cycles++
    this.plan.waitingUntil = null
    this.plan.blocker = null
    this.passErrors = 0
    const danger = this.safety()
    if (danger) throw Object.assign(new Error(danger), { fatal: true })
    await this.eat()
    await this.harvestReady(this.survey())
    await this.plantMore()
    await this.storeBatch()
    // Safe checkpoint: shared reserve/tool policy runs between actions, never mid-dig.
    await this.agent.coordination?.returnSupplies(this)
    this.plan.stored = this.counts.stored || 0
    this.survey()
  }
  async run() {
    this.bot.pathfinder.setMovements(new TravelMovements(this.bot))
    const collect = (collector) => {
      if (!this.cancelled() && collector.id === this.bot.entity.id) {
        this.counts.collectedStacks++
        this.sync()
      }
    }
    this.bot.on('playerCollect', collect)
    const guard = setInterval(() => {
      if (this.cancelled()) return
      this.requestAir()
      const danger = this.safety()
      if (danger) this.controller.abort(Object.assign(new Error(danger), { fatal: true }))
    }, 500)
    try {
      while (true) {
        const before = this.progressCount()
        try {
          this.requestAir()
          this.check()
          this.checkpoint({ phase: 'between-cane-passes' })
          await this.cycle()
          this.checkpoint({ phase: 'cane-pass-complete' })
        } catch (error) {
          if (error.fatal || error.code === 'HANDOFF' || this.cancelled()) throw error
          if (error.code === 'AIR_RECOVERY' || this.needsAir) {
            await this.recoverAir()
            continue
          }
          this.passErrors++
          this.plan.blocker = error.message
          this.addIssue(error.message)
        }
        const productive = this.progressCount() > before
        // Three consecutive passes that only produced errors mean a real blocker, not slow growth.
        this.stalledPasses = productive || !this.passErrors ? 0 : this.stalledPasses + 1
        if (this.stalledPasses >= 3)
          throw new Error(
            `No progress after three passes with errors. ${this.plan.blocker || ''}`.trim(),
          )
        const delay = productive ? 1000 : GROWTH_WAIT
        this.plan.phase = productive ? 'working' : 'waiting'
        this.decide(
          `SUGARCANE FARMER: ${productive ? 'continuing' : 'waiting for growth'} · ${this.plan.columns} columns, ${this.plan.ready} ready · ${this.plan.harvested} harvested, ${this.plan.planted} planted, ${this.plan.stored} stored. ${this.plan.blocker || this.plan.expansion || this.plan.storage || ''}`.trim(),
        )
        this.plan.waitingUntil = Date.now() + delay
        this.agent.publish()
        try {
          await this.pause(delay)
        } catch (error) {
          if (error.code !== 'AIR_RECOVERY') throw error
          await this.recoverAir()
        }
      }
    } catch (error) {
      const reason = error.fatal ? error : this.controller.signal.reason || error
      if (reason.code === 'HANDOFF') this.task.reasonCode = 'HANDOFF'
      this.plan.status = ['CANCELLED', 'HANDOFF'].includes(reason.code) ? 'cancelled' : 'paused'
      this.task.status = this.plan.status === 'cancelled' ? 'cancelled' : 'partial'
      this.plan.decision =
        this.plan.status === 'cancelled'
          ? 'Sugarcane farmer stopped.'
          : `Sugarcane farming paused: ${reason.message}`
      this.task.label = this.plan.decision
      if (this.plan.status !== 'cancelled') this.addIssue(reason.message)
      this.agent.say(this.plan.decision)
      if (reason?.fatal && reason.code !== 'HANDOFF') this.failure = reason
    } finally {
      this.bot.off('playerCollect', collect)
      clearInterval(guard)
      this.plan.waitingUntil = null
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
module.exports = { SugarcaneFarm, groupColumns, plantable, farmNearby, SOIL, RESERVE, BATCH }
