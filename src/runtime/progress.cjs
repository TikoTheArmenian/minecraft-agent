/** Compatibility projection while individual skill cards retain their detailed fields. */
class ProgressObserver {
  constructor(
    agent,
    { now = Date.now, intervalMs = 60000, milestone = 32, inventoryIntervalMs = 15000 } = {},
  ) {
    Object.assign(this, { agent, now, intervalMs, milestone, inventoryIntervalMs })
    this.last = null
    this.inventorySnapshot = null
    this.nextInventoryEventAt = 0
  }
  tick() {
    this.observeIdleInventory()
    const task = this.agent.activeWork?.task
    if (!task?.runId) {
      this.last = null
      return
    }
    const at = this.now(),
      counts = { ...task.counts }
    const previous = this.last?.runId === task.runId ? this.last : null
    const plan = this.agent.activeWork.plan
    const blocker = task.reasonCode || (plan?.blocker ? 'BLOCKED' : null)
    task.progress = {
      runId: task.runId,
      skillId: task.skillId,
      phase: task.phase || task.label,
      counts,
      blocker,
      blockerDetail: typeof plan?.blocker === 'string' ? plan.blocker.slice(0, 300) : null,
      at,
      checkpointRequested: Boolean(this.agent.activeWork.handoffRequested),
    }
    if (!previous) {
      this.last = { ...task.progress, at }
      return
    }
    const gained = Object.entries(counts).reduce(
      (sum, [key, value]) =>
        sum +
        (Number.isFinite(value) ? Math.max(0, value - (Number(previous.counts[key]) || 0)) : 0),
      0,
    )
    if (
      blocker !== previous.blocker ||
      (at - previous.at >= this.intervalMs && gained >= this.milestone)
    ) {
      this.last = { ...task.progress }
      this.agent.emit(blocker ? 'skill.blocked' : 'skill.progress', {
        ...task.progress,
        reasonCode: blocker,
      })
    }
  }
  observeIdleInventory() {
    const { state, supervisor } = this.agent
    const scope = JSON.stringify([this.agent.epoch, state.world, state.dimension])
    const counts = new Map()
    for (const item of state.inventory || []) {
      if (typeof item.name !== 'string' || !Number.isFinite(item.count) || item.count <= 0) continue
      counts.set(item.name, (counts.get(item.name) || 0) + item.count)
    }
    const previous = this.inventorySnapshot
    if (
      !previous ||
      previous.scope !== scope ||
      state.connection !== 'ready' ||
      this.agent.activeWork ||
      !supervisor ||
      supervisor.paused ||
      supervisor.config.mode === 'off'
    ) {
      this.inventorySnapshot = { scope, counts }
      this.nextInventoryEventAt = 0
      return
    }
    const changes = []
    for (const name of new Set([...previous.counts.keys(), ...counts.keys()])) {
      const before = previous.counts.get(name) || 0,
        after = counts.get(name) || 0
      if (before !== after) changes.push({ name, before, after })
    }
    const at = this.now()
    if (!changes.length || at < this.nextInventoryEventAt) return
    this.inventorySnapshot = { scope, counts }
    this.nextInventoryEventAt = at + this.inventoryIntervalMs
    this.agent.emit('observation.changed', {
      kind: 'inventory',
      changes: changes.slice(0, 12),
      omitted: Math.max(0, changes.length - 12),
      at,
    })
  }
}
module.exports = { ProgressObserver }
