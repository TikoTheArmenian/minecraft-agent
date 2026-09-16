/** Shared production engine for the separately registered pumpkin and melon farmers. */
const { ResourceWork } = require('./resources.cjs')
const { Work } = require('../runtime/work.cjs')
const { nearbyFirst } = require('../navigation/work-order.cjs')
const { TravelMovements, Travel } = require('../navigation/travel.cjs')
const { isAir } = require('../world/observations.cjs')
const storage = require('../storage/service.cjs')
const SIDES = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 0, 1],
  [0, 0, -1],
]
const SOIL = ['dirt', 'grass_block', 'farmland']
const STEMS = ['pumpkin_stem', 'attached_pumpkin_stem', 'melon_stem', 'attached_melon_stem']
const COOLDOWN = 60000
const GROWTH_WAIT = 20000
const key = (p) => `${p.x},${p.y},${p.z}`

// Do not plant in any existing stem's fruit lane, including the other crop's lane.
function besideStem(bot, pos, names = STEMS) {
  return SIDES.some((d) => names.includes(bot.blockAt(pos.offset(...d))?.name))
}
function plantable(bot, soil) {
  if (!SOIL.includes(soil?.name)) return false
  const p = soil.position
  if (!isAir(bot.blockAt(p.offset(0, 1, 0))) || !isAir(bot.blockAt(p.offset(0, 2, 0)))) return false
  if (besideStem(bot, p.offset(0, 1, 0))) return false
  // Each new stem needs a clear horizontal fruit cell on supported ground.
  return SIDES.some((d) => {
    const side = p.offset(...d)
    return SOIL.includes(bot.blockAt(side)?.name) && isAir(bot.blockAt(side.offset(0, 1, 0)))
  })
}
class StemFarm extends ResourceWork {
  constructor(agent, id, crop) {
    super(agent, id)
    this.crop = crop
    this.origin ||= this.bot.entity.position.clone()
    this.deadline = Infinity
    this.task.deadlineAt = null
    this.task.continuous = true
    this.task.skill = crop.label.toUpperCase()
    this.reserves = { [crop.seed]: 8 }
    this.plan = {
      status: 'running',
      decision: `Inspecting ${crop.fruit} plants.`,
      stems: 0,
      ready: 0,
      harvested: 0,
      planted: 0,
      stored: 0,
      cycles: 0,
      waitingUntil: null,
      blocker: null,
    }
    agent.state[crop.state] = this.plan
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
  // Continuous stem farming handles air recovery while retaining Work cancellation checks.
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
  // Farms grow beside water, so falling in is routine: surface, recover, resume the same routine.
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
  survey() {
    this.check()
    this.plan.stems = this.find([this.crop.block, this.crop.attached]).length
    const fruits = this.find([this.crop.fruit], 48, (b) => this.harvestable(b))
    this.plan.ready = fruits.length
    this.agent.publish()
    return fruits
  }
  harvestable(block) {
    // Leave standalone/decorative fruit alone; only harvest fruit next to matching stems.
    return (
      block?.name === this.crop.fruit &&
      besideStem(this.bot, block.position, [this.crop.block, this.crop.attached])
    )
  }
  async harvestReady(fruits) {
    let inspected = 0
    for (const fruit of nearbyFirst(this, fruits)) {
      if (++inspected > 64) break
      this.check()
      if (this.coolingDown(fruit.position) || !this.harvestable(this.bot.blockAt(fruit.position)))
        continue
      if (this.bot.inventory.emptySlotCount() < 2) {
        await this.storeBatch(true)
        if (this.bot.inventory.emptySlotCount() < 2) {
          this.plan.blocker = 'Inventory is full; leaving fruit until space is available.'
          break
        }
      }
      const done = await this.attempt(`Harvest ${this.crop.fruit}`, async () => {
        this.decide(`Harvesting ${this.crop.fruit}; keeping its stem growing.`)
        await this.approach(fruit.position)
        await this.dig(fruit.position, this.crop.fruit, (b) => this.harvestable(b))
        this.counts.harvested++
        this.plan.harvested++
        this.sync()
        await this.pause(300)
        await this.pickup(fruit.position)
        this.checkpoint({ phase: 'fruit-collected' })
        return true
      })
      if (!done) this.cooldowns.set(key(fruit.position), Date.now() + COOLDOWN)
    }
  }
  async restock() {
    if (this.count(this.crop.seed) >= 8) return
    // Recipes use the 2x2 inventory grid: pumpkins -> four seeds, slices -> one seed.
    for (let i = 0; i < 8 && this.count(this.crop.seed) < 8 && this.count(this.crop.produce); i++) {
      const made = await this.attempt('Make planting seeds', async () => {
        await this.craft(this.crop.seed)
        return true
      })
      if (!made) break
    }
    if (
      this.count(this.crop.seed) ||
      !this.agent.colony?.enabled ||
      Date.now() < this.nextRestockAt
    )
      return
    this.nextRestockAt = Date.now() + COOLDOWN
    await this.attempt('Retrieve planting seeds', () =>
      storage.retrieve(this, [this.crop.seed], 16),
    )
  }
  async plantMore() {
    await this.restock()
    if (!this.count(this.crop.seed)) {
      this.plan.expansion = `Need ${this.crop.seed} or ${this.crop.produce} in inventory, or seeds in shared storage.`
      return
    }
    const spots = this.find(
      SOIL,
      48,
      (b) => plantable(this.bot, b) && this.hydrated(b.position) && !this.coolingDown(b.position),
    )
    this.plan.expansion = `${spots.length} irrigated planting candidates; keeping fruit lanes clear.`
    let planted = 0
    let inspected = 0
    for (const soil of nearbyFirst(this, spots)) {
      if (++inspected > 48) break
      this.check()
      if (planted >= 16 || !this.count(this.crop.seed)) break
      if (!plantable(this.bot, this.bot.blockAt(soil.position))) continue
      const done = await this.attempt(`Plant ${this.crop.fruit}`, async () => {
        await this.approach(soil.position)
        if (!plantable(this.bot, this.bot.blockAt(soil.position)) || !this.hydrated(soil.position))
          return false
        if (this.bot.blockAt(soil.position)?.name !== 'farmland') {
          let hoe = this.bot.inventory.items().find((i) => i.name.endsWith('_hoe'))
          if (!hoe && this.agent.colony?.enabled) {
            await storage.retrieve(this, ['iron_hoe', 'stone_hoe', 'wooden_hoe'], 1)
            hoe = this.bot.inventory.items().find((i) => i.name.endsWith('_hoe'))
          }
          if (!hoe)
            throw new Error(
              'Need a hoe to till new stem plots; existing farmland can be planted without one.',
            )
          await this.till(soil.position, hoe.name)
        }
        if (!plantable(this.bot, this.bot.blockAt(soil.position))) return false
        await this.plant(soil.position, this.crop)
        this.plan.planted++
        this.checkpoint({ phase: 'stem-planted' })
        return true
      })
      if (done) planted++
      else this.cooldowns.set(key(soil.position), Date.now() + COOLDOWN)
    }
  }
  async storeBatch(force = false) {
    if (!this.agent.colony?.enabled) {
      this.plan.storage = 'Shared storage is disabled; harvest stays in inventory.'
      return
    }
    if (!force && this.bot.inventory.emptySlotCount() >= 4 && this.count(this.crop.produce) < 48)
      return
    if (Date.now() < this.nextStoreAt) return
    this.nextStoreAt = Date.now() + COOLDOWN
    await this.attempt('Store harvest', async () => {
      const before = this.counts.stored || 0
      await storage.store(this)
      this.plan.stored = this.counts.stored || 0
      if (before === this.plan.stored) throw new Error('No shared chest accepted surplus harvest.')
    })
  }
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
          this.checkpoint({ phase: 'between-stem-passes' })
          await this.cycle()
          this.checkpoint({ phase: 'stem-pass-complete' })
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
          `${this.task.skill}: ${productive ? 'continuing' : 'waiting for growth'} · ${this.plan.stems} stems, ${this.plan.ready} ready · ${this.plan.harvested} harvested, ${this.plan.planted} planted, ${this.plan.stored} stored. ${this.plan.blocker || this.plan.expansion || this.plan.storage || ''}`.trim(),
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
          ? `${this.crop.label} stopped.`
          : `${this.crop.label} paused: ${reason.message}`
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
module.exports = { StemFarm, plantable, besideStem }
