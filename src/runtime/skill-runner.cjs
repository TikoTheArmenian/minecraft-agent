/** Sole admission/settlement boundary for one player's physical work. */
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { Work, blockName } = require('./work.cjs')
const { actionFor } = require('../skills/registry.cjs')
const { validateCommand, availability } = require('./invocations.cjs')
const { validate } = require('./schema.cjs')
const { resultSchema } = require('./skill-contracts.cjs')
const { loadJson, saveJson } = require('../infra/json-store.cjs')
const terminal = new Set(['succeeded', 'partial', 'blocked', 'cancelled', 'failed'])
const plain = (value) => JSON.parse(JSON.stringify(value))
const validId = (value) => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value)
const fingerprint = (value) =>
  JSON.stringify(value, function (key, item) {
    return item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((k) => [k, item[k]]),
        )
      : item
  })
const outstanding = (record) => [
  ...new Set([
    ...(record.result?.outstandingOperationIds || []),
    ...(record.operations || []).filter((op) => op.status !== 'confirmed').map((op) => op.id),
  ]),
]
const validStore = (value) =>
  value &&
  typeof value === 'object' &&
  Array.isArray(value.runs) &&
  value.runs.length <= 100 &&
  value.runs.every(
    (r) =>
      validId(r.runId) &&
      validId(r.requestId) &&
      r.command &&
      typeof r.command.type === 'string' &&
      typeof r.world === 'string' &&
      (r.dimension === null || typeof r.dimension === 'string') &&
      Number.isFinite(r.startedAt) &&
      (!r.review ||
        (typeof r.review.note === 'string' &&
          r.review.note.length >= 8 &&
          Number.isFinite(r.review.at))) &&
      (!r.operations ||
        (Array.isArray(r.operations) &&
          r.operations.length <= 256 &&
          r.operations.every(
            (op) => validId(op.id) && ['intent', 'confirmed', 'uncertain'].includes(op.status),
          ))) &&
      (!r.result ||
        (() => {
          validate(resultSchema, r.result)
          return r.result.runId === r.runId && r.result.skillId === r.command.type
        })()),
  ) &&
  (!value.requests ||
    (Array.isArray(value.requests) &&
      value.requests.length <= 100 &&
      value.requests.every(
        (r) =>
          validId(r.requestId) &&
          typeof r.fingerprint === 'string' &&
          ['pending', 'accepted', 'cancelled', 'rejected', 'interrupted'].includes(r.status),
      )))

class SkillRunner {
  constructor(agent, { handoffMs = 60000 } = {}) {
    this.agent = agent
    this.active = null
    this.pending = null
    this.handoffMs = handoffMs
    this.receipts = new Map()
    this.file = path.join(agent.dataDir, 'runs.json')
    this.error = null
    try {
      this.saved = loadJson(this.file, { validate: validStore }).data || { runs: [] }
    } catch (error) {
      this.error = error
      this.saved = { runs: [] }
    }
    this.saved.requests ||= []
    for (const request of this.saved.requests)
      if (request.status === 'pending') request.status = 'interrupted'
    this.publish()
  }
  publish() {
    this.agent.state.runtime = {
      activeRunId: this.active?.task?.runId || null,
      pendingSkillId: this.pending?.command.type || null,
      error: this.error?.message || null,
      results: this.saved.runs
        .filter((r) => r.result)
        .slice(-10)
        .map((r) => r.result),
      interrupted: this.saved.runs
        .filter((r) => !r.result && r.runId !== this.active?.task?.runId && !r.review)
        .map((r) => ({
          runId: r.runId,
          skillId: r.command.type,
          world: r.world,
          dimension: r.dimension,
          checkpoint: r.checkpoint || null,
        })),
      recovery: this.recovery().map((r) => ({
        runId: r.runId,
        skillId: r.command.type,
        reasonCode: r.result?.reasonCode || 'INTERRUPTED',
        outstandingOperationIds: outstanding(r),
      })),
    }
  }
  persist() {
    try {
      saveJson(this.file, this.saved, { validate: validStore })
    } catch (error) {
      this.error = error
      this.publish()
      throw error
    }
  }
  recovery() {
    return this.saved.runs.filter(
      (r) =>
        !r.review &&
        r.runId !== this.active?.task?.runId &&
        (!r.result ||
          outstanding(r).length ||
          [
            'CLEANUP_FAILED',
            'REQUIRES_RECONCILIATION',
            'CHECKPOINT_CORRUPT',
            'CHECKPOINT_WRITE_FAILED',
          ].includes(r.result.reasonCode)),
    )
  }
  review(runId, note) {
    if (this.active)
      throw new Error('Wait for the current task to settle before reviewing recovery.')
    if (typeof note !== 'string' || note.trim().length < 8 || note.length > 1000)
      throw new Error('Describe what you checked in the world (8–1000 characters).')
    const record = this.saved.runs.find((r) => r.runId === runId)
    if (!record) throw new Error('Unknown run.')
    record.review = { note: note.trim(), at: Date.now() }
    this.persist()
    this.publish()
    this.agent.publish()
    return record
  }
  receipt(requestId) {
    const record = this.saved.requests.find((r) => r.requestId === requestId)
    if (!record) return null
    const run = this.saved.runs.find((r) => r.runId === record.runId)
    return {
      requestId,
      runId: record.runId || null,
      status: record.status,
      reasonCode: record.reasonCode || null,
      result: run?.result || null,
    }
  }
  previous(command, options) {
    if (!options.requestId) return null
    if (!validId(options.requestId))
      throw new Error('Use a request ID with 1–128 letters, numbers, underscores or hyphens.')
    const request = this.saved.requests.find((r) => r.requestId === options.requestId)
    if (!request) return null
    const normalized = validateCommand(command, this.agent, options)
    delete normalized.invitation
    if (request.fingerprint !== fingerprint(normalized))
      throw Object.assign(new Error('This request ID already belongs to a different invocation.'), {
        code: 'REQUEST_CONFLICT',
      })
    return this.receipts.get(options.requestId) || this.receipt(options.requestId)
  }
  remember(command, requestId, status, extra = {}) {
    const safe = { ...command }
    delete safe.invitation
    let request = this.saved.requests.find((r) => r.requestId === requestId)
    if (!request) {
      request = { requestId, fingerprint: fingerprint(safe) }
      this.saved.requests.push(request)
    }
    Object.assign(request, { status, ...extra })
    this.saved.requests = this.saved.requests.slice(-100)
    this.persist()
  }
  assertFresh(context) {
    if (!context) return
    const a = this.agent
    if (
      context.epoch !== a.epoch ||
      context.nav !== a.nav ||
      context.world !== a.state.world ||
      context.dimension !== a.state.dimension ||
      (context.objectiveRevision !== undefined &&
        context.objectiveRevision !== a.supervisor?.revision)
    )
      throw Object.assign(new Error('The decision belongs to an old assignment or connection.'), {
        code: 'STALE_SESSION',
      })
  }
  validate(command, options = {}) {
    if (this.error) throw this.error
    if (options.source === 'supervisor') {
      const state = this.agent.supervisor?.snapshot()
      if (!options.context || state?.mode !== 'autonomous' || state.paused)
        throw Object.assign(new Error('Autonomous admission is paused or no longer authorized.'), {
          code: 'STALE_SESSION',
        })
    }
    this.assertFresh(options.context)
    const normalized = validateCommand(command, this.agent, options)
    const gate = availability(this.agent, normalized)
    if (!gate.available) throw Object.assign(new Error(gate.reason), { code: gate.reasonCode })
    const a = this.agent
    const recovery = this.recovery().filter(
      (r) => r.world === a.state.world && r.dimension === a.state.dimension,
    )
    if (recovery.length)
      throw Object.assign(
        new Error(
          'Previous work needs recovery review before another skill can start. Inspect the run and the world first.',
        ),
        { code: 'REQUIRES_RECONCILIATION' },
      )
    if (normalized.type === 'storageCrafting') a.colony.scope(a)
    if (normalized.type === 'mineType') blockName(a.bot, normalized.name)
    if (normalized.type === 'goto') {
      const p = a.position()
      if (!p || Math.hypot(normalized.x - p.x, normalized.y - p.y, normalized.z - p.z) > 256)
        throw new Error('Choose a destination within 256 blocks for this version.')
    }
    return normalized
  }
  start(command, options = {}) {
    const previous = this.previous(command, options)
    if (previous) return previous
    if (this.active)
      throw new Error(
        'A work action is still finishing. Use Stop, then wait a moment before starting another action.',
      )
    command = this.validate(command, options)
    if (!options.source || options.source === 'human')
      this.agent.supervisor?.pause('HUMAN_ASSIGNMENT')
    const a = this.agent,
      definition = actionFor(command.type),
      runId = randomUUID(),
      requestId = options.requestId || randomUUID()
    const storedCommand = { ...command }
    delete storedCommand.invitation
    const record = {
      runId,
      requestId,
      command: plain(storedCommand),
      world: a.state.world,
      dimension: a.state.dimension,
      startedAt: Date.now(),
    }
    // Keep unresolved operations even when pruning ordinary history.
    if (this.saved.runs.length >= 100) {
      const removable = this.saved.runs.findIndex((r) => r.result && !this.recovery().includes(r))
      if (removable < 0)
        throw new Error('Recovery history is full; review previous runs before starting more work.')
      this.saved.runs.splice(removable, 1)
    }
    this.saved.runs.push(record)
    this.remember(storedCommand, requestId, 'accepted', { runId }) // Fail before a physical action if its durable identity cannot be saved.
    if (definition.module && !options.internalSession) {
      a.lastSkill = command.type
      a.lastInvocation = plain(storedCommand)
    }
    ++a.nav
    const task = (a.state.task = {
      id: a.nav,
      runId,
      requestId,
      skillId: command.type,
      skill: definition.taskSkill || definition.label,
      status: 'running',
      label: `Starting ${definition.label}`,
      counts: {},
      issues: [],
      source: options.source || 'human',
      invocation: plain(storedCommand),
    })
    this.active = { task, cancel() {} } // Acquire before constructing a workflow; constructors cannot reenter admission.
    let work, execution
    try {
      work = definition.factory ? definition.factory(a, a.nav) : new Work(a, a.nav)
      work.task ||= task
      this.active = work
      if (command.type === 'goto') execution = this.navigate(work, command)
      else execution = work.run(command) // Synchronous admission is required by joint Exchange sessions.
    } catch (error) {
      execution = Promise.reject(error)
      work ||= this.active
    }
    const handle = { requestId, runId, status: 'accepted', completion: null }
    handle.completion = Promise.resolve(execution)
      .then(
        () => this.finish(work, record),
        (error) => this.finish(work, record, error),
      )
      .catch((error) => {
        this.error = error
        this.publish()
        a.log('runtime.error', error.message, 'error')
        return null
      })
    this.receipts.set(requestId, handle)
    while (this.receipts.size > 100) this.receipts.delete(this.receipts.keys().next().value)
    this.publish()
    a.publish()
    return handle
  }
  async navigate(work, command) {
    const { goals } = require('mineflayer-pathfinder')
    const goal = new goals.GoalNear(command.x, command.y, command.z, 1)
    work.deadline = Date.now() + 60000
    work.task.deadlineAt = work.deadline
    work.task.label = `Walking to ${command.x}, ${command.y}, ${command.z}`
    // Defer the first side effect so a synchronous Stop cancels admission before movement.
    await Promise.resolve()
    work.check()
    await work.travel(goal, 'Walk or swim to the selected destination')
    work.check()
    const p = this.agent.position()
    const reached = p && goal.isEnd({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) })
    work.task.status = reached ? 'succeeded' : 'failed'
    work.task.reasonCode = reached ? null : 'NO_ROUTE'
    if (reached) work.recordEffect({ kind: 'arrival', position: p })
    this.agent.say(
      reached ? 'Arrived near the destination.' : 'No reachable route to that destination.',
    )
  }
  async finish(work, record, error = null) {
    const a = this.agent,
      task = work.task
    error ||= work.failure || null
    try {
      await work.cleanup?.()
    } catch (cleanupError) {
      error = cleanupError
      task.reasonCode = cleanupError.code || 'CLEANUP_FAILED'
    }
    const reason =
      error?.fatal || error?.code === 'CLEANUP_FAILED'
        ? error
        : work.controller?.signal.reason || error
    if (error && !['CANCELLED', 'HANDOFF'].includes(error.code)) {
      task.status = 'failed'
      task.reasonCode = error.code || 'EXECUTION_FAILED'
      if (this.active === work) a.log('task.error', error.message, 'error', { taskId: task.id })
    }
    if (reason?.code === 'HANDOFF') {
      if (task.status !== 'partial') task.status = 'cancelled'
      task.reasonCode = 'HANDOFF'
    } else if (reason?.code === 'CANCELLED') {
      if (task.status !== 'partial') task.status = 'cancelled'
      task.reasonCode ||= reason.reasonCode || 'CANCELLED'
    }
    const result = {
      runId: record.runId,
      skillId: record.command.type,
      outcome: terminal.has(task.status) ? task.status : 'failed',
      reasonCode:
        task.reasonCode ||
        reason?.code ||
        ({
          succeeded: null,
          partial: 'PARTIAL',
          blocked: 'BLOCKED',
          cancelled: 'CANCELLED',
          failed: 'EXECUTION_FAILED',
        }[task.status] ??
          (task.status === 'succeeded' ? null : 'MISSING_RESULT')),
      counts: plain(task.counts || {}),
      confirmedEffects: plain(work.effects || []),
      outstandingOperationIds: [
        ...new Set([
          ...(work.outstandingOperationIds || []),
          ...(record.operations || []).filter((op) => op.status !== 'confirmed').map((op) => op.id),
        ]),
      ].map(String),
      checkpointId: record.checkpoint?.id || null,
      endedAt: Date.now(),
    }
    validate(resultSchema, result, 'Skill result')
    record.result = result
    try {
      this.persist()
    } catch {
      /* Error stays visible and prevents further admission. */
    }
    if (this.active === work) {
      this.active = null
      if (a.bot === work.bot || !work.bot) {
        a.bot?.pathfinder?.setGoal(null)
        a.bot?.clearControlStates?.()
        if (a.baseMovements && a.bot) a.bot.pathfinder.setMovements(a.baseMovements)
      }
      if (
        result.outstandingOperationIds.length ||
        this.error ||
        (reason?.fatal && reason.code !== 'HANDOFF')
      ) {
        this.clearPending('REQUIRES_RECONCILIATION')
        a.supervisor?.pause(result.reasonCode || 'REQUIRES_RECONCILIATION')
      }
      this.publish()
      a.publish()
      a.emit('skill.result', result)
      a.startPendingSkill()
    } else {
      // A retired socket may finish later; refresh history without emitting work for its replacement.
      this.publish()
      a.publish()
    }
    return result
  }
  switch(command, options = {}) {
    const previous = this.previous(command, options)
    if (previous) return previous
    command = this.validate(command, options)
    if (!this.active) return this.start(command, options)
    if (!options.source || options.source === 'human')
      this.agent.supervisor?.pause('HUMAN_ASSIGNMENT')
    this.clearPending('SUPERSEDED')
    const requestId = options.requestId || randomUUID()
    this.remember(command, requestId, 'pending')
    options = { ...options, requestId }
    const a = this.agent,
      work = this.active
    if (work.requestHandoff && actionFor(work.task.skillId)?.handoff === 'checkpoint')
      work.requestHandoff()
    else this.stop(false, 'SWITCH', false)
    // Cancel-only work increments nav during settlement; retain every other decision fence.
    this.pending = {
      command,
      options: { ...options, context: options.context ? { ...options.context, nav: a.nav } : null },
      epoch: a.epoch,
      nav: a.nav,
    }
    this.handoffTimer = setTimeout(() => {
      if (this.active !== work || !this.pending) return
      work.cancelHandoff?.()
      this.clearPending('HANDOFF_BLOCKED')
      a.state.task.handoffError =
        'HANDOFF_BLOCKED: skill did not reach a safe checkpoint within one minute.'
      a.log('task.handoff_blocked', a.state.task.handoffError, 'warn')
      a.emit('skill.blocked', { reasonCode: 'HANDOFF_BLOCKED' })
    }, this.handoffMs)
    this.handoffTimer.unref?.()
    this.publish()
    a.publish()
    return { requestId, runId: null, status: 'pending', skillId: command.type }
  }
  clearPending(reason = null) {
    clearTimeout(this.handoffTimer)
    this.handoffTimer = null
    this.active?.cancelHandoff?.()
    if (reason && this.pending?.options?.requestId) {
      const request = this.saved.requests.find(
        (r) => r.requestId === this.pending.options.requestId,
      )
      if (request) {
        request.status = 'cancelled'
        request.reasonCode = reason
        try {
          this.persist()
        } catch {}
      }
    }
    this.pending = null
  }
  drainPending() {
    const pending = this.pending
    this.clearPending()
    if (!pending) return
    if (
      pending.epoch !== this.agent.epoch ||
      pending.nav !== this.agent.nav ||
      this.agent.state.connection !== 'ready'
    ) {
      this.remember(pending.command, pending.options.requestId, 'cancelled', {
        reasonCode: 'STALE_SESSION',
      })
      return
    }
    // A pending receipt is promoted once, after cleanup and fresh admission checks.
    this.saved.requests = this.saved.requests.filter(
      (r) => r.requestId !== pending.options.requestId,
    )
    try {
      this.agent.startWork(pending.command, pending.options)
    } catch (error) {
      this.remember(pending.command, pending.options.requestId, 'rejected', {
        reasonCode: error.code || 'ADMISSION_FAILED',
      })
      this.agent.say(`Could not start skill: ${error.message}`)
    }
  }
  stop(announce = true, reason = 'HUMAN_STOP', suspend = true) {
    const a = this.agent
    this.clearPending(reason)
    ++a.nav
    clearTimeout(a.timer)
    if (suspend) a.supervisor?.pause(reason)
    const error = Object.assign(new Error(reason === 'SWITCH' ? 'Switching skill.' : 'Cancelled'), {
      code: 'CANCELLED',
      reasonCode: reason,
    })
    if (this.active?.task) this.active.task.reasonCode = reason
    this.active?.cancel(error)
    a.bot?.pathfinder?.setGoal(null)
    a.bot?.stopDigging?.()
    a.bot?.deactivateItem?.()
    a.bot?.clearControlStates?.()
    if (a.baseMovements && a.bot) a.bot.pathfinder.setMovements(a.baseMovements)
    if (a.state.task?.status === 'running') a.state.task.status = 'cancelled'
    this.publish()
    if (announce) a.say('Stopped.')
    else a.publish()
  }
  saveCheckpoint(work, checkpoint) {
    if (this.active !== work) throw new Error('Cannot checkpoint an obsolete run.')
    const record = this.saved.runs.find((r) => r.runId === work.task.runId)
    if (!record) throw new Error('Run record is missing.')
    record.checkpoint = { id: randomUUID(), ...plain(checkpoint) }
    this.persist()
    work.task.checkpoint = record.checkpoint
  }
  saveOperation(work, operation) {
    if (this.active !== work)
      throw Object.assign(new Error('Cannot mutate an obsolete run’s operation journal.'), {
        code: 'STALE_SESSION',
        fatal: true,
      })
    if (!validId(operation.id) || !['intent', 'confirmed', 'uncertain'].includes(operation.status))
      throw new Error('Invalid operation record.')
    const record = this.saved.runs.find((r) => r.runId === work.task.runId)
    if (!record) throw new Error('Run record is missing.')
    record.operations ||= []
    const index = record.operations.findIndex((op) => op.id === operation.id)
    if (index < 0) {
      if (record.operations.length >= 256) {
        const completed = record.operations.findIndex((op) => op.status === 'confirmed')
        if (completed < 0)
          throw Object.assign(
            new Error(
              'Operation journal is full of unresolved effects; recover them before continuing.',
            ),
            { code: 'REQUIRES_RECONCILIATION', fatal: true },
          )
        record.operations.splice(completed, 1)
      }
      record.operations.push(plain(operation))
    } else record.operations[index] = plain(operation)
    this.persist()
  }
}
module.exports = { SkillRunner }
