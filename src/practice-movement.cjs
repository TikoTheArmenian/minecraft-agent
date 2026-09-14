/** Follow the nearest loaded sponge marker until Stop is pressed. */
const { goals } = require('mineflayer-pathfinder')
const { Work } = require('./work.cjs')
const { TravelMovements } = require('./travel.cjs')
const markerKey = p => p ? `${p.x},${p.y},${p.z}` : null

class PracticeMovement extends Work {
  constructor(agent, id) {
    super(agent, id)
    this.deadline = Infinity
    this.task.deadlineAt = null
    this.task.continuous = true
    this.task.skill = 'PRACTICE MOVEMENT'
  }
  nearest() {
    const matching = ['sponge', 'wet_sponge'].map(n => this.bot.registry.blocksByName[n]?.id).filter(Number.isInteger)
    return this.bot.findBlocks({ matching, maxDistance: 64, count: 256 })
      .sort((a, b) => a.distanceTo(this.bot.entity.position) - b.distanceTo(this.bot.entity.position))[0] || null
  }
  check() {
    super.check()
    if (this.targetChanged) throw Object.assign(new Error('Sponge target changed.'), { code: 'TARGET_CHANGED' })
  }
  async run() {
    const before = this.bot.pathfinder.movements
    this.bot.pathfinder.setMovements(new TravelMovements(this.bot))
    let monitor
    try {
      while (true) {
        await this.agent.coordination?.returnSupplies(this)
        this.check()
        const target = this.nearest()
        if (!target) {
          this.progress('Practice movement: scanning for a sponge within 64 blocks.')
          await this.pause(1000)
          continue
        }
        // A sponge is solid: reach an adjacent cell or stand on top of it.
        const goal = new goals.GoalNear(target.x, target.y, target.z, 1)
        if (goal.isEnd(this.bot.entity.position.floored())) {
          this.progress(`Practice movement: reached sponge at ${markerKey(target)}. Watching for changes.`)
          await this.pause(1000)
          continue
        }
        this.progress(`Practice movement: moving to sponge at ${markerKey(target)}.`)
        monitor = setInterval(() => {
          if (this.cancelled()) return
          if (markerKey(this.nearest()) !== markerKey(target)) {
            this.targetChanged = true
            this.bot.pathfinder.setGoal(null)
            this.bot.clearControlStates()
          }
        }, 750)
        try {
          await this.travel(goal, `Reach sponge at ${markerKey(target)}`, 30000)
          await this.pause(100)
        } catch (error) {
          const changed = this.targetChanged
          this.targetChanged = false
          super.check()
          if (error.fatal) throw error
          if (!changed) {
            this.addIssue(error.message)
            this.progress(`Practice movement: route blocked; retrying in 3 seconds. ${error.message}`)
          }
          clearInterval(monitor)
          monitor = null
          await this.pause(changed ? 100 : 3000)
        } finally {
          clearInterval(monitor)
          monitor = null
          this.targetChanged = false
        }
      }
    } catch (error) {
      this.task.status = error.code === 'CANCELLED' ? 'cancelled' : 'partial'
      this.task.label = `Practice movement ${this.task.status === 'cancelled' ? 'stopped' : 'paused'}: ${error.message}`
      if (error.code !== 'CANCELLED') this.addIssue(error.message)
    } finally {
      clearInterval(monitor)
      if (this.agent.bot === this.bot && this.agent.nav === this.id) {
        this.bot.pathfinder.setGoal(null)
        this.bot.clearControlStates()
        this.bot.pathfinder.setMovements(before)
      }
      this.agent.publish()
    }
  }
}
module.exports = { PracticeMovement }
