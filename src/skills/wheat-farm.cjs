/**
 * CONTINUOUS WHEAT SKILL: repeats cycle() until stopped or a serious problem occurs.
 * Each cycle checks safety and supplies, harvests ripe wheat, expands the field, and stores surplus.
 * this.plan describes current decisions for the dashboard; this.counts records work completed.
 */

const { nearbyFirst } = require('../navigation/work-order.cjs')
const { Vec3 } = require('vec3')
const { ResourceWork } = require('../capabilities/resources.cjs')
const { Work, CROPS, mature } = require('../runtime/work.cjs')
const { TravelMovements, Travel } = require('../navigation/travel.cjs')
const { isAir } = require('../world/observations.cjs')
const { layout } = require('../capabilities/farm-layout.cjs')

// A continuous production loop, independent of the starter survival milestones.
// Individual actions remain timed and cancellable; each pass renews its budget.
class WheatFarm extends ResourceWork {
  constructor(agent, id) {
    super(agent, id)
    this.plan = {
      status: 'running',
      decision: 'Inspecting the wheat farm.',
      cycles: 0,
      plots: 0,
      stored: 0,
      chests: [],
      waitingUntil: null,
    }
    agent.state.wheatFarm = this.plan
    this.task.continuous = true
    this.task.skill = 'FARMER'
    this.deadline = Infinity
    this.task.deadlineAt = null
    this.plan.expanded = 0
    this.plan.groundAdded = 0
    this.storage = []
  }
  // Filter candidate soil before the result cap: buried dirt must not crowd
  // usable surface plots out of the scan. Stay within the farm's loaded district.
  find(names, radius = 48, predicate = () => true) {
    const matching = names
      .map((n) => this.bot.registry.blocksByName[n]?.id)
      .filter(Number.isInteger)
    const eligible = (b) =>
      b &&
      b.position.distanceTo(this.origin) <= 80 &&
      !this.failedTargets.has(`${b.position}:${b.name}`) &&
      predicate(b)
    if (!matching.length) return []
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
  check() {
    Work.prototype.check.call(this)
    if (this.needsAir && !this.recoveringAir)
      throw Object.assign(new Error('Surfacing to restore air.'), { code: 'AIR_RECOVERY' })
    if (this.bot.game.gameMode !== 'survival')
      throw Object.assign(new Error('Wheat farming requires Survival mode.'), { fatal: true })
  }
  safety() {
    const danger = super.safety()
    return danger?.startsWith('Air is running low') ? null : danger
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
    // Retire navigation/digging; let the current promise settle before recovery.
    this.bot.pathfinder.setGoal(null)
    this.bot.stopDigging()
    this.bot.clearControlStates()
  }
  async pause(ms = 200) {
    for (let remaining = ms; remaining > 0; remaining -= 250) {
      await Work.prototype.pause.call(this, Math.min(250, remaining))
      this.requestAir()
      this.check()
    }
  }
  // Temporarily pause farm work to restore air, then continue the same routine.
  async recoverAir() {
    this.recoveringAir = true
    this.plan.phase = 'recovering-air'
    this.plan.waitingUntil = null
    this.decide('Air is low: pausing farming, escaping to open water, and surfacing.')
    try {
      const travel = new Travel(this, 15000)
      await travel.surface()
      const until = Date.now() + 10000
      while (this.bot.oxygenLevel < 18 && Date.now() < until) {
        this.check()
        await travel.tick()
      }
      if (this.bot.oxygenLevel < 18)
        throw new Error(
          `Could not restore air after surfacing. Move ${this.agent.username || this.bot.username || 'this bot'} to open water or land.`,
        )
      travel.activity.status = 'succeeded'
      this.needsAir = false
      this.decide('Air restored. Resuming FARMER.')
    } finally {
      this.recoveringAir = false
    }
  }
  // Once a resource trip is needed, bring back a useful stock rather than one recipe's worth.
  async gather(names, satisfied, label, maxBlocks = 32, explore = true) {
    if (satisfied()) return
    const logs = names.every((name) => /_log$/.test(name))
    const dirt = names.every((name) => ['dirt', 'grass_block'].includes(name))
    const coal = names.every((name) => ['coal_ore', 'deepslate_coal_ore'].includes(name))
    const seeds = names.every((name) => ['short_grass', 'tall_grass', 'fern'].includes(name))
    const target = logs ? 16 : dirt ? 128 : coal ? 8 : seeds ? 32 : null
    const count = () =>
      logs ? this.total(/_log$/) : this.count(dirt ? 'dirt' : coal ? 'coal' : 'wheat_seeds')
    if (!target) return super.gather(names, satisfied, label, maxBlocks, explore)
    this.decide(`Gathering a batch of ${label}: aiming for ${target} in inventory.`)
    try {
      await super.gather(
        names,
        () => satisfied() && (count() >= target || this.bot.inventory.emptySlotCount() < 2),
        label,
        Math.max(maxBlocks, target),
        explore,
        () => !satisfied(),
      )
    } catch (error) {
      // A scarce patch may still supply enough for the original job. Never swallow cancellation or safety failures.
      if (error.code !== 'BLOCKED' || !satisfied()) throw error
      this.check()
    }
  }
  async harvestWheat() {
    let attempted = 0
    for (const block of nearbyFirst(
      this,
      this.find(['wheat'], 32, (b) => mature(b, CROPS.wheat)),
    )) {
      this.check()
      if (++attempted > 64) break
      if (!mature(this.bot.blockAt(block.position), CROPS.wheat)) continue
      if (this.bot.inventory.emptySlotCount() < 2) break
      // Reserve a seed before harvesting. Never leave a productive plot bare
      // just because its random drops did not include a reachable seed.
      if (!this.seed(CROPS.wheat)) break
      await this.attempt('Harvest wheat', async () => {
        const soil = block.position.offset(0, -1, 0)
        if (this.bot.blockAt(soil)?.name !== 'farmland') return
        this.decide(`Harvesting and replanting wheat · ${this.counts.harvested} harvested`)
        await this.approach(soil)
        await this.dig(
          block.position,
          'wheat',
          (b) => mature(b, CROPS.wheat) && !!this.seed(CROPS.wheat),
        )
        this.counts.harvested++
        this.sync()
        await this.plant(soil, CROPS.wheat)
        await this.pause(300)
        await this.pickup(block.position)
        this.checkpoint({ phase: 'crop-replanted' })
      })
    }
  }
  // Local storage is only used when there is no configured central warehouse.
  async createStorage() {
    const hub = this.agent.colony?.enabled
      ? (await require('../storage/service.cjs').call(this, 'hub_get')).position
      : null
    if (hub)
      throw new Error(
        'Central storage needs more capacity. Sam builds organized double chests; keeping harvest carried until space is available.',
      )
    if (!this.item('chest')) {
      const table = await this.craftingTable()
      await this.planks(8)
      await this.craft('chest', table)
    }
    const supports = this.find(
      ['grass_block', 'dirt', 'stone', 'cobblestone'],
      16,
      (b) =>
        (!hub || b.position.offset(0, 1, 0).distanceTo(new Vec3(hub.x, hub.y, hub.z)) <= 8) &&
        isAir(this.bot.blockAt(b.position.offset(0, 1, 0))) &&
        isAir(this.bot.blockAt(b.position.offset(0, 2, 0))) &&
        ![new Vec3(1, 1, 0), new Vec3(-1, 1, 0), new Vec3(0, 1, 1), new Vec3(0, 1, -1)].some(
          (d) => this.bot.blockAt(b.position.plus(d))?.name === 'chest',
        ),
    )
    for (const support of supports.slice(0, 8)) {
      const chest = await this.attempt('Place wheat chest', () => this.placeItem('chest', support))
      if (chest) {
        if (this.agent.colony?.enabled)
          await require('../storage/service.cjs').manage(this, chest.position, 'food')
        this.storage.push(chest.position.clone())
        this.plan.chests = this.storage.map((p) => ({ ...p }))
        this.agent.publish()
        return chest
      }
    }
    throw new Error('No clear reachable chest location. Keeping wheat in inventory.')
  }
  // Store only surplus: carried wheat and seeds are reserved for food and the next planting pass.
  async deposit(chest) {
    if (this.agent.colony?.enabled) {
      const storage = require('../storage/service.cjs')
      const info = require('../storage/policy.cjs')
      const { position: hub } = await storage.call(this, 'hub_get')
      if (hub && chest.position.distanceTo(new Vec3(hub.x, hub.y, hub.z)) > 8) {
        await this.store()
        return
      }
      const moved = await storage.withChest(this, chest.position, async (ctx) => {
        if (!ctx.record.managed || !['food', 'overflow'].includes(ctx.record.category)) return 0
        let wheat = 0
        for (const name of ['wheat', 'wheat_seeds']) {
          const item = this.item(name)
          if (item) {
            const amount = Math.max(0, this.count(name) - info.reserve(item, this))
            const n = await storage.transfer(
              this,
              ctx,
              'deposit',
              info.describe(item).fingerprint,
              amount,
            )
            if (name === 'wheat') wheat += n
          }
        }
        return wheat
      })
      this.plan.stored += moved
      return
    }
    await this.approach(chest.position)
    const window = await this.timed(
      async () => {
        const opened = await this.bot.openContainer(chest)
        if (this.cancelled()) {
          opened.close()
          this.check()
        }
        return opened
      },
      7000,
      'Open wheat storage chest',
    )
    try {
      this.check()
      if (!this.storage.some((p) => p.equals(chest.position)))
        this.storage.push(chest.position.clone())
      this.plan.chests = this.storage.map((p) => ({ ...p }))
      for (const [name, reserve] of [
        ['wheat', 12],
        ['wheat_seeds', 32],
      ]) {
        const type = this.bot.registry.itemsByName[name].id
        const capacity = window.slots
          .slice(0, window.inventoryStart)
          .reduce((n, i) => n + (!i ? 64 : i.type === type ? Math.max(0, 64 - i.count) : 0), 0)
        const count = Math.min(capacity, Math.max(0, this.count(name) - reserve))
        if (!count) continue
        const before = this.count(name),
          storedBefore = window
            .containerItems()
            .filter((i) => i.type === type)
            .reduce((n, i) => n + i.count, 0)
        await this.timed(
          () => window.deposit(type, null, count),
          10000,
          `Store ${count} ${name.replaceAll('_', ' ')}`,
        )
        const delta = before - this.count(name),
          storedAfter = window
            .containerItems()
            .filter((i) => i.type === type)
            .reduce((n, i) => n + i.count, 0)
        if (delta !== count || storedAfter - storedBefore !== count)
          throw new Error('Storage transfer was not fully confirmed.')
        if (name === 'wheat') this.plan.stored += count
        this.seedChestChecks?.clear()
        this.agent.refresh()
      }
    } finally {
      require('../storage/farm-storage.cjs').remember(this, chest, window)
      window.close()
    }
  }
  async store() {
    if (this.agent.colony?.enabled) {
      const shared = require('../storage/service.cjs')
      const before = this.counts.wheatStored || 0
      let data = await shared.list(this)
      if (
        !shared
          .eligible(this, data.containers)
          .some((c) => ['food', 'overflow'].includes(c.category))
      ) {
        await this.createStorage()
      }
      await shared.store(this)
      if (this.count('wheat') > 12 || this.count('wheat_seeds') > 32) {
        await this.createStorage()
        await shared.store(this)
      }
      this.plan.stored += (this.counts.wheatStored || 0) - before
      data = await shared.list(this)
      this.plan.chests = data.containers.filter((c) => c.managed).map((c) => c.position)
      return
    }
    const nearby = this.find(['chest'], 32)
    for (const pos of this.storage)
      if (this.bot.blockAt(pos)?.name === 'chest' && !nearby.some((b) => b.position.equals(pos)))
        nearby.unshift(this.bot.blockAt(pos))
    for (const chest of nearby.slice(0, 8)) {
      await this.attempt('Store wheat', () => this.deposit(chest))
      if (this.count('wheat') <= 12 && this.count('wheat_seeds') <= 32) return
    }
    // Create storage when a batch is ready to deposit and existing chests cannot hold it.
    if (!nearby.length || this.count('wheat') > 12 || this.count('wheat_seeds') > 32) {
      const chest = await this.createStorage()
      await this.deposit(chest)
    }
  }
  // One pass: handle safety, finish ripe crops, then resupply, store surplus, and expand.
  async cycle() {
    await this.agent.coordination?.returnSupplies(this)
    this.deadline = Infinity
    this.task.deadlineAt = null
    this.failedTargets.clear()
    this.explorations = 0
    this.plan.cycles++
    this.plan.waitingUntil = null
    this.plan.blocker = null
    layout(this)
    this.counts.travelBlocks = 0
    const danger = this.safety()
    if (danger) throw Object.assign(new Error(danger), { fatal: true })
    await this.eat()
    if (this.bot.food <= 16 && this.count('wheat') >= 3)
      await this.attempt('Make food', async () => {
        await this.craft('bread', await this.craftingTable())
        await this.eat()
      })
    if (this.bot.inventory.emptySlotCount() < 4)
      await this.attempt('Make room for harvest', () => this.store())
    if (this.count('wheat_seeds') < 2)
      await require('../storage/farm-storage.cjs').restockSeeds(this)
    const harvestedBefore = this.counts.harvested
    await this.harvestWheat()
    // Finish a productive patch before taking a discretionary supply trip.
    if (
      this.counts.harvested - harvestedBefore >= 32 &&
      this.bot.inventory.emptySlotCount() >= 4 &&
      this.find(['wheat'], 8, (b) => mature(b, CROPS.wheat)).length
    ) {
      this.plan.plots = this.find(['wheat'], 48).length
      this.plan.expansion = 'Finishing the nearby ripe wheat before resupplying.'
      this.agent.refresh()
      return
    }
    await require('../capabilities/building-supplies.cjs').ensure(this)
    // Lighting is a priority, but unavailable materials must not stall every pass.
    if (this.count('torch') < 4 && Date.now() >= (this.nextTorchAttempt || 0)) {
      this.nextTorchAttempt = Date.now() + 300000
      await this.attempt('Get torches', () => require('./torches.cjs').getTorches(this, 8))
    }
    await this.attempt('Light the farm', () => require('./torches.cjs').lightArea(this))
    if (this.count('wheat') >= 64 || this.bot.inventory.emptySlotCount() < 4)
      await this.attempt('Prepare wheat storage', () => this.store())
    await this.attempt('Expand wheat production', () => this.expand())
    if (
      this.count('wheat') >= 64 ||
      this.count('wheat_seeds') > 96 ||
      this.bot.inventory.emptySlotCount() < 4
    )
      await this.attempt('Store harvest', () => this.store())
    this.plan.plots = this.find(['wheat'], 48).length
    this.agent.refresh()
  }
  // Productive passes repeat promptly. Otherwise wait briefly for growth or changed resources.
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
        try {
          this.requestAir()
          this.check()
          this.checkpoint({ phase: 'between-farm-passes' })
          const production =
            this.counts.planted + (this.counts.groundAdded || 0) + this.counts.harvested
          await this.cycle()
          this.checkpoint({ phase: 'farm-pass-complete' })
          const growing =
            this.counts.planted + (this.counts.groundAdded || 0) + this.counts.harvested >
            production
          const delay = growing ? 1000 : 20000
          this.plan.phase = growing ? 'expanding' : 'waiting'
          this.decide(
            `${growing ? 'FARMER: continuing expansion and harvesting' : 'FARMER: waiting for growth or missing resources'} · ${this.plan.plots} nearby wheat plants · ${this.plan.stored} wheat stored. ${this.plan.blocker || this.plan.expansion || ''}`,
          )
          this.plan.waitingUntil = Date.now() + delay
          this.agent.publish()
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
          ? 'FARMER stopped.'
          : `Wheat farming paused: ${reason.message}`
      this.agent.say(this.plan.decision)
      if (reason?.fatal && reason.code !== 'HANDOFF') this.failure = reason
    } finally {
      this.bot.off('playerCollect', collect)
      clearInterval(guard)
      this.plan.waitingUntil = null
      if (this.agent.bot === this.bot && this.agent.nav === this.id) {
        this.bot.pathfinder.setGoal(null)
        this.bot.clearControlStates()
        if (this.agent.baseMovements) this.bot.pathfinder.setMovements(this.agent.baseMovements)
      }
      this.agent.publish()
    }
  }
}
module.exports = { WheatFarm }
