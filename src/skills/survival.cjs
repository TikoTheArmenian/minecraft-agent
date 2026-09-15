/** Starter workflow: wood, tools, iron, food, then a productive wheat farm. */
const { ResourceWork, FOOD, LOG } = require('../capabilities/resources.cjs')
const { CROPS, mature } = require('../runtime/work.cjs')
const { TravelMovements } = require('../navigation/travel.cjs')

const WHEAT_GOAL = 128
const STAGES = [
  ['wood', 'Gather wood'],
  ['wooden', 'Craft a wooden pickaxe'],
  ['stone', 'Upgrade to a stone pickaxe'],
  ['iron', 'Find and collect iron'],
  ['food', 'Gather food'],
  ['farm', `Collect ${WHEAT_GOAL} wheat`],
]
const blocked = (message) => Object.assign(new Error(message), { code: 'BLOCKED' })

class Survival extends ResourceWork {
  constructor(agent, id) {
    super(agent, id)
    this.deadline = Date.now() + 20 * 60 * 1000
    this.task.deadlineAt = this.deadline
    this.plan = {
      status: 'running',
      started: Date.now(),
      decision: 'Inspecting inventory and nearby terrain.',
      steps: STAGES.map(([id, label]) => ({ id, label, status: 'pending', detail: '' })),
      observations: null,
      farm: [],
    }
    agent.state.survival = this.plan
  }
  check() {
    if (Date.now() >= this.deadline && !this.cancelled())
      throw Object.assign(
        blocked(
          'Survival reached its 20-minute limit. Review progress and start again to continue.',
        ),
        { fatal: true },
      )
    super.check()
  }
  async starterFarm() {
    // Re-running Survive recognizes an existing planted patch instead of expanding
    // a new farm every time. It is not necessary to wait for crop growth here.
    const existing = this.find(
      Object.values(CROPS).map((c) => c.block),
      24,
      (b) =>
        this.bot.blockAt(b.position.offset(0, -1, 0))?.name === 'farmland' &&
        this.hydrated(b.position.offset(0, -1, 0)),
    )
    const cluster = existing.find(
      (b) => existing.filter((s) => s.position.distanceTo(b.position) <= 5).length >= 4,
    )
    if (cluster)
      this.plan.farm = existing
        .filter((b) => b.position.distanceTo(cluster.position) <= 5)
        .slice(0, 4)
        .map((b) => ({ ...b.position }))
    else {
      let crop = Object.values(CROPS).find((c) => this.count(c.seed) >= 4)
      if (!crop) {
        await this.gather(
          ['short_grass', 'tall_grass', 'fern'],
          () => this.count('wheat_seeds') >= 4,
          '4 wheat seeds from grass',
          64,
        )
        crop = CROPS.wheat
      }
      let spots = this.farmSpots()
      for (let i = 0; !spots.length && i < 3; i++) {
        if (!(await this.explore())) break
        spots = this.farmSpots()
      }
      if (!spots.length)
        throw blocked(
          `Need four clear dirt/grass plots near existing water. Choose a shoreline on the map, move ${this.agent.username || this.bot.username || 'this bot'} nearby, and start again.`,
        )
      let hoe = ['netherite_hoe', 'diamond_hoe', 'iron_hoe', 'stone_hoe', 'wooden_hoe'].find((n) =>
        this.usable(n),
      )
      if (!hoe) {
        await this.sticks(2)
        await this.planks(2)
        await this.craft('wooden_hoe', await this.craftingTable())
        hoe = 'wooden_hoe'
      }
      this.decide(`Building a four-plot ${crop.block} farm beside existing water.`)
      for (const block of spots) {
        this.check()
        if (this.plan.farm.length >= 4) break
        try {
          if (!this.seed(crop)) throw blocked(`Need more ${crop.seed} to finish the farm.`)
          if (this.bot.blockAt(block.position)?.name !== 'farmland')
            await this.till(block.position, hoe)
          await this.approach(block.position)
          if (!this.hydrated(block.position)) throw new Error('Water disappeared before planting.')
          await this.plant(block.position, crop)
          this.plan.farm.push({ ...block.position.offset(0, 1, 0) })
          this.agent.publish()
        } catch (error) {
          if (
            error.fatal ||
            error.code === 'HANDOFF' ||
            error.code === 'CANCELLED' ||
            error.code === 'BLOCKED'
          )
            throw error
          this.check()
          this.addIssue(`Farm plot: ${error.message}`)
        }
      }
      if (this.plan.farm.length < 4)
        throw blocked(
          `Planted ${this.plan.farm.length}/4 plots. The remaining shoreline plots were unreachable.`,
        )
    }
    if (this.count('wheat') >= WHEAT_GOAL)
      return this.plan.farm.length >= 4
        ? `Starter farm is ready and inventory already has ${WHEAT_GOAL} wheat.`
        : `At least ${WHEAT_GOAL} wheat already in inventory.`
    await this.collectWheat(WHEAT_GOAL)
    return `Collected ${this.count('wheat')} wheat.`
  }
  async collectWheat(needed) {
    const crop = CROPS.wheat
    while (this.count('wheat') < needed) {
      this.checkpoint({ phase: 'between-wheat-passes' })
      this.check()
      this.decide(`Collecting wheat (${this.count('wheat')}/${needed}).`)
      const targets = this.find(['wheat'], 32, (b) => mature(b, crop))
      for (const block of targets) {
        if (this.count('wheat') >= needed) break
        const soil = block.position.offset(0, -1, 0)
        try {
          await this.approach(soil)
          await this.dig(
            block.position,
            crop.block,
            (b) => mature(b, crop) && this.bot.blockAt(soil)?.name === 'farmland',
          )
          this.counts.harvested++
          this.sync()
          await this.pause(250)
          await this.pickup(block.position)
          await this.pause(250)
          if (this.seed(crop)) await this.plant(soil, crop)
          else
            this.addIssue(
              'Harvest produced no reachable replanting stock; one existing crop plot is empty.',
            )
          this.checkpoint({
            phase: 'crop-action-complete',
            replanted: this.bot.blockAt(block.position)?.name === crop.block,
          })
        } catch (error) {
          if (error.fatal || error.code === 'HANDOFF' || error.code === 'CANCELLED') throw error
          this.check()
          this.failedTargets.add(`${block.position}:${block.name}`)
        }
      }
      if (this.count('wheat') >= needed) return
      // More wheat needs more production, not random exploration for ripe crops.
      try {
        await this.expand()
      } catch (error) {
        if (error.fatal || error.code === 'HANDOFF' || error.code === 'CANCELLED') throw error
        this.addIssue(`Farm expansion: ${error.message}`)
      }
      const plots = this.find(['wheat'], 32).length
      this.decide(
        `Growing wheat: ${this.count('wheat')}/${needed} collected; ${plots} plants nearby. Waiting 20 seconds for growth; next pass will harvest and expand.`,
      )
      this.plan.waitingUntil = Date.now() + 20000
      this.agent.publish()
      try {
        await this.pause(20000)
      } finally {
        this.plan.waitingUntil = null
      }
    }
    if (this.count('wheat') < needed)
      throw blocked(
        `Need ${needed} wheat to finish. Nearby mature crops supplied ${this.count('wheat')}.`,
      )
  }
  // Run the starter milestones in order, recording which succeeded and which still need resources.
  async run() {
    const moves = new TravelMovements(this.bot)
    this.bot.pathfinder.setMovements(moves)
    const guard = () => {
      if (this.cancelled()) return
      const danger = this.safety()
      if (danger) this.controller.abort(Object.assign(blocked(danger), { fatal: true }))
    }
    const monitor = setInterval(guard, 500)
    this.bot.on('health', guard)
    const collect = (collector) => {
      if (!this.cancelled() && collector.id === this.bot.entity.id) {
        this.counts.collectedStacks++
        this.sync()
      }
    }
    this.bot.on('playerCollect', collect)
    try {
      const danger = this.safety()
      if (danger) throw blocked(danger)
      this.observe()
      await this.eat()
      for (const step of this.plan.steps) {
        this.checkpoint({ phase: 'between-milestones', next: step.id })
        this.check()
        await this.agent.coordination?.returnSupplies(this)
        this.plan.currentStep = step.id
        step.status = 'running'
        this.decide(step.label)
        this.agent.log?.('survival.objective', `Current objective: ${step.label}.`, 'info', {
          taskId: this.id,
          objective: step.id,
        })
        try {
          step.detail = await (step.id === 'farm' ? this.starterFarm() : this[step.id]())
          step.status = 'complete'
        } catch (error) {
          if (error.fatal || error.code === 'HANDOFF' || error.code === 'CANCELLED') throw error
          this.check()
          step.status = 'blocked'
          step.detail = error.message
          this.addIssue(error.message)
        }
        this.observe()
        this.agent.say(`${step.label}: ${step.detail}`)
        this.agent.log?.(
          'survival.objective_done',
          `${step.label}: ${step.status === 'complete' ? 'complete' : 'blocked; moving to the next objective'}. ${step.detail}`,
          step.status === 'complete' ? 'info' : 'warn',
          { taskId: this.id, objective: step.id },
        )
      }
      this.check()
      const complete = this.plan.steps.every((s) => s.status === 'complete')
      this.plan.status = complete ? 'complete' : 'blocked'
      this.task.status = complete ? 'succeeded' : 'partial'
      this.plan.decision = complete
        ? `Starter survival routine complete. Inventory has at least ${WHEAT_GOAL} wheat.`
        : 'Finished the available steps. Review the blocked steps, then start Survive again after conditions change.'
      this.task.label = this.plan.decision
      this.agent.say(this.plan.decision)
    } catch (error) {
      const reason = this.controller.signal.reason
      const message = reason?.code === 'BLOCKED' ? reason.message : error.message
      const cancelled = ['CANCELLED', 'HANDOFF'].includes(error.code) && reason?.code !== 'BLOCKED'
      if (error.code === 'HANDOFF') this.task.reasonCode = 'HANDOFF'
      this.plan.status = cancelled ? 'cancelled' : 'blocked'
      this.task.status = cancelled ? 'cancelled' : 'partial'
      this.plan.decision = cancelled
        ? 'Survival stopped. Completed actions remain in the world.'
        : message
      for (const step of this.plan.steps)
        if (step.status === 'running') {
          step.status = cancelled ? 'cancelled' : 'blocked'
          step.detail = this.plan.decision
        }
      if (!cancelled) this.agent.say(`Survival paused: ${message}`)
      if (error.fatal) this.failure = error
    } finally {
      this.plan.currentStep = null
      clearInterval(monitor)
      this.bot.off('health', guard)
      this.bot.off('playerCollect', collect)
      this.bot.deactivateItem?.()
      if (this.agent.bot === this.bot && this.agent.nav === this.id) {
        this.bot.pathfinder.setGoal(null)
        this.bot.clearControlStates()
        if (this.agent.baseMovements) this.bot.pathfinder.setMovements(this.agent.baseMovements)
      }
      this.sync()
      this.agent.publish()
    }
  }
}
module.exports = { Survival, FOOD, STAGES, LOG, WHEAT_GOAL }
