/** Event-driven high-level decisions. Physical ownership remains exclusively in SkillRunner. */
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { loadJson, saveJson } = require('../infra/json-store.cjs')
const { allowedActions, decisionSchema, decodeDecision } = require('./decision-schema.cjs')
const { ResponsesDecisionProvider, INSTRUCTIONS, failure } = require('./responses-transport.cjs')
const { defaultScheduler } = require('./inference-scheduler.cjs')
const { availability } = require('../runtime/invocations.cjs')
const MODES = ['off', 'shadow', 'autonomous']
const EVENTS = new Set([
  'human.objective',
  'human.message',
  'peer.message',
  'skill.result',
  'skill.blocked',
  'skill.progress',
  'observation.changed',
  'timer',
])
const DEFAULT_BUDGET = { requestsPerDay: 40, tokensPerDay: 100000, maxOutputTokens: 2048 }
const plain = (value) => JSON.parse(JSON.stringify(value))
const pick = (value, fields) =>
  Object.fromEntries(
    fields.filter((key) => value?.[key] !== undefined).map((key) => [key, value[key]]),
  )
const compact = (value, depth = 0) => {
  if (typeof value === 'string') return value.slice(0, 500)
  if (value === null || ['number', 'boolean'].includes(typeof value)) return value
  if (!value || depth > 3) return null
  if (Array.isArray(value)) return value.slice(0, 12).map((item) => compact(item, depth + 1))
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, 24)
      .map(([key, item]) => [key.slice(0, 64), compact(item, depth + 1)]),
  )
}
const resultSummary = (value) => ({
  ...compact(
    pick(value, ['runId', 'skillId', 'outcome', 'reasonCode', 'counts', 'checkpointId', 'endedAt']),
  ),
  confirmedEffectCount: value?.confirmedEffects?.length || 0,
  outstandingOperationCount: value?.outstandingOperationIds?.length || 0,
})
const freeze = (value) => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze)
    Object.freeze(value)
  }
  return value
}
const validBudget = (budget) =>
  budget &&
  Object.keys(budget).length === 3 &&
  Number.isSafeInteger(budget.requestsPerDay) &&
  budget.requestsPerDay >= 1 &&
  budget.requestsPerDay <= 500 &&
  Number.isSafeInteger(budget.tokensPerDay) &&
  budget.tokensPerDay >= 1000 &&
  budget.tokensPerDay <= 1000000 &&
  Number.isSafeInteger(budget.maxOutputTokens) &&
  budget.maxOutputTokens >= 256 &&
  budget.maxOutputTokens <= 4096
const validObjective = (value) =>
  value === null ||
  (value &&
    typeof value.text === 'string' &&
    value.text.length >= 1 &&
    value.text.length <= 1000 &&
    typeof value.world === 'string' &&
    value.world.length >= 1 &&
    value.world.length <= 64 &&
    typeof value.dimension === 'string' &&
    value.dimension.length <= 128)
const validConfig = (config) =>
  config &&
  Object.keys(config).every((key) => ['mode', 'model', 'objective', 'budget'].includes(key)) &&
  MODES.includes(config.mode) &&
  typeof config.model === 'string' &&
  /^[a-zA-Z0-9._-]{1,80}$/.test(config.model) &&
  validObjective(config.objective) &&
  validBudget(config.budget)
const validSaved = (value) =>
  value &&
  validConfig(value.config) &&
  Number.isSafeInteger(value.revision) &&
  value.revision >= 0 &&
  typeof value.paused === 'boolean' &&
  value.usage &&
  Number.isSafeInteger(value.usage.requests) &&
  value.usage.requests >= 0 &&
  Number.isSafeInteger(value.usage.tokens) &&
  value.usage.tokens >= 0

class Supervisor {
  constructor(
    agent,
    {
      provider,
      scheduler,
      now = Date.now,
      requestTimeoutMs = 50000,
      maxEvents = 32,
      maxSnapshotBytes = 48000,
      maxConversationTurns = 6,
    } = {},
  ) {
    this.agent = agent
    this.provider = provider || new ResponsesDecisionProvider()
    this.scheduler = scheduler || defaultScheduler()
    Object.assign(this, {
      now,
      requestTimeoutMs,
      maxEvents,
      maxSnapshotBytes,
      maxConversationTurns,
    })
    this.agentId = agent.profile?.id || agent.id || agent.username
    this.file = path.join(agent.dataDir, 'supervisor.json')
    this.config = {
      mode: 'off',
      model: agent.profile?.supervisor?.model || process.env.SUPERVISOR_MODEL || 'gpt-6-astra',
      objective: null,
      budget: { ...DEFAULT_BUDGET },
    }
    this.revision = 0
    this.paused = true
    this.reason = 'OFF'
    this.error = null
    this.storageError = null
    this.pending = null
    this.events = []
    this.seen = new Map()
    this.conversations = new Map()
    this.droppedEvents = 0
    this.nextWakeAt = null
    this.lastDecision = null
    try {
      const saved = loadJson(this.file, { validate: validSaved }).data
      if (saved) {
        this.config = saved.config
        this.revision = saved.revision + 1
        this.lastDecision = saved.lastDecision || null
        this.reason = 'RESTART'
      }
    } catch (error) {
      this.storageError = error
      this.error = error.message
      this.reason = 'CHECKPOINT_CORRUPT'
    }
    this.publish()
  }
  scopeMatches() {
    const objective = this.config.objective,
      state = this.agent.state
    return !!objective && objective.world === state.world && objective.dimension === state.dimension
  }
  ready() {
    return !!this.agent.bot && this.agent.state.connection === 'ready' && this.scopeMatches()
  }
  context() {
    return {
      epoch: this.agent.epoch,
      nav: this.agent.nav,
      world: this.agent.state.world,
      dimension: this.agent.state.dimension,
      objectiveRevision: this.revision,
    }
  }
  fresh(context) {
    const current = this.context()
    return (
      !this.paused &&
      this.config.mode !== 'off' &&
      this.ready() &&
      Object.keys(current).every((key) => current[key] === context[key])
    )
  }
  snapshot() {
    const scheduling = this.scheduler.snapshot(this.agentId)
    return plain({
      mode: this.config.mode,
      model: this.config.model,
      objective: this.config.objective?.text || '',
      scope: this.config.objective
        ? { world: this.config.objective.world, dimension: this.config.objective.dimension }
        : null,
      paused: this.paused,
      reason: this.reason,
      revision: this.revision,
      busy: !!this.pending || scheduling.agentBusy,
      configured: typeof this.provider.available === 'function' ? this.provider.available() : true,
      queuedEvents: this.events.length,
      droppedEvents: this.droppedEvents,
      nextWakeAt: this.nextWakeAt,
      budget: this.config.budget,
      usage: scheduling.usage,
      fleetUsage: scheduling.fleetUsage,
      inference: scheduling.limits,
      lastDecision: this.lastDecision,
      error: this.error || scheduling.error,
    })
  }
  publish() {
    this.agent.state.supervisor = this.snapshot()
    this.agent.publish?.()
  }
  persist() {
    if (this.storageError) throw this.storageError
    try {
      saveJson(
        this.file,
        {
          config: this.config,
          revision: this.revision,
          paused: this.paused,
          reason: this.reason,
          usage: this.scheduler.snapshot(this.agentId).usage,
          lastDecision: this.lastDecision,
        },
        { validate: validSaved },
      )
    } catch (error) {
      this.storageError = error
      throw error
    }
  }
  invalidate(reason) {
    this.revision++
    this.paused = true
    this.reason = reason
    this.events = []
    this.seen.clear()
    this.conversations.clear()
    this.nextWakeAt = null
    if (this.agent.runtime?.pending?.options?.source === 'supervisor') {
      this.agent.runtime.clearPending('SUPERVISOR_PAUSED')
      this.agent.runtime.publish()
    }
    this.pending?.controller.abort(failure('PROVIDER_CANCELLED', 'The supervisor was paused.'))
  }
  pause(reason = 'HUMAN_PAUSE') {
    this.invalidate(reason)
    try {
      this.persist()
    } catch (error) {
      this.error = error.message
    }
    this.publish()
    return this.snapshot()
  }
  configure(settings) {
    if (
      !settings ||
      typeof settings !== 'object' ||
      Array.isArray(settings) ||
      Object.keys(settings).some((key) => !['mode', 'model', 'objective', 'budget'].includes(key))
    )
      throw new Error('Supervisor settings accept mode, model, objective and budget only.')
    if (this.storageError) throw this.storageError
    const config = plain(this.config)
    for (const key of ['mode', 'model'])
      if (Object.hasOwn(settings, key)) config[key] = settings[key]
    if (Object.hasOwn(settings, 'budget')) {
      if (
        !settings.budget ||
        typeof settings.budget !== 'object' ||
        Array.isArray(settings.budget) ||
        Object.keys(settings.budget).some((key) => !Object.hasOwn(DEFAULT_BUDGET, key))
      )
        throw new Error('Invalid supervisor budget settings.')
      config.budget = { ...config.budget, ...settings.budget }
    }
    if (Object.hasOwn(settings, 'objective')) {
      if (typeof settings.objective !== 'string' || settings.objective.length > 1000)
        throw new Error('Use an objective of at most 1000 characters.')
      const text = settings.objective.trim()
      if (
        text &&
        (!this.agent.bot || this.agent.state.connection !== 'ready' || !this.agent.state.dimension)
      )
        throw new Error(
          'Connect to the intended world and dimension before assigning an objective.',
        )
      config.objective = text
        ? { text, world: this.agent.state.world, dimension: this.agent.state.dimension }
        : null
    }
    if (!validConfig(config))
      throw new Error('Invalid supervisor mode, model, objective or bounded budget.')
    this.invalidate(config.mode === 'off' ? 'OFF' : 'CONFIGURED')
    this.config = config
    this.error = null
    try {
      this.persist()
    } catch (error) {
      this.error = error.message
      this.publish()
      throw error
    }
    this.publish()
    return this.snapshot()
  }
  resume() {
    if (this.storageError) throw this.storageError
    if (this.config.mode === 'off')
      throw new Error('Choose shadow or autonomous mode before resuming.')
    if (!this.ready())
      throw new Error(
        'Resume requires a ready bot and a human objective for this world and dimension.',
      )
    if (this.pending || this.scheduler.snapshot(this.agentId).agentBusy)
      throw new Error('Wait for the cancelled decision to finish before resuming.')
    if (typeof this.provider.available === 'function' && !this.provider.available())
      throw new Error('Configure OPENAI_API_KEY in the server environment before resuming.')
    this.revision++
    this.paused = false
    this.reason = null
    this.error = null
    try {
      this.persist()
    } catch (error) {
      this.paused = true
      this.error = error.message
      this.publish()
      throw error
    }
    this.enqueue('human.objective', { text: this.config.objective.text })
    this.publish()
    return this.snapshot()
  }
  enqueue(kind, payload = {}) {
    if (!EVENTS.has(kind) || this.paused || this.config.mode === 'off') return false
    if (!this.ready()) {
      this.pause('SESSION_CHANGED')
      return false
    }
    let content
    try {
      const json = JSON.stringify(
        kind === 'skill.result'
          ? resultSummary(payload)
          : kind === 'skill.progress'
            ? compact(payload)
            : payload,
      )
      if (typeof json !== 'string' || Buffer.byteLength(json) > 8192) return false
      content = JSON.parse(json)
    } catch {
      return false
    }
    if (kind === 'peer.message') {
      if (
        !content ||
        content.from === this.agent.username ||
        content.kind === 'ack' ||
        content.worldId !== this.agent.state.world ||
        content.dimension !== this.agent.state.dimension ||
        !Number.isFinite(content.expiresAt) ||
        content.expiresAt <= this.now()
      )
        return false
      if ((this.conversations.get(content.conversationId) || 0) >= this.maxConversationTurns)
        return false
    }
    const key = `${kind}:${kind === 'peer.message' ? content.id : JSON.stringify(content)}`
    if (this.seen.has(key)) return false
    this.seen.set(key, this.now())
    while (this.seen.size > 128) this.seen.delete(this.seen.keys().next().value)
    if (['skill.progress', 'observation.changed'].includes(kind))
      this.events = this.events.filter((event) => event.kind !== kind)
    if (this.events.length >= this.maxEvents) {
      this.events.shift()
      this.droppedEvents++
    }
    this.events.push(
      freeze({
        kind,
        payload: content,
        at: this.now(),
        context: this.context(),
        trust: kind.startsWith('human.') ? 'human' : 'observation',
      }),
    )
    this.publish()
    return true
  }
  inferenceSnapshot(events) {
    const state = this.agent.state
    const runtime = state.runtime || {},
      nearby = state.observation
    const snapshot = {
      bot: { id: this.agentId, username: this.agent.username },
      context: this.context(),
      capturedAt: this.now(),
      objective: this.config.objective,
      events,
      observations: {
        connection: state.connection,
        position: state.position,
        vitals: state.vitals,
        inventory: (state.inventory || [])
          .slice(0, 64)
          .map((item) => ({ name: item.name, count: item.count })),
        task: state.task
          ? {
              ...compact(
                pick(state.task, [
                  'runId',
                  'skillId',
                  'status',
                  'label',
                  'source',
                  'invocation',
                  'counts',
                  'progress',
                ]),
              ),
              issues: compact((state.task.issues || []).slice(-3)),
            }
          : null,
        runtime: {
          ...compact(pick(runtime, ['activeRunId', 'pendingSkillId', 'error'])),
          results: (runtime.results || []).slice(-3).map(resultSummary),
          recoveryCount: runtime.recovery?.length || 0,
          recovery: (runtime.recovery || []).slice(0, 5).map((record) => ({
            ...pick(record, ['runId', 'skillId', 'reasonCode']),
            outstandingOperationCount: record.outstandingOperationIds?.length || 0,
          })),
          interruptedCount: runtime.interrupted?.length || 0,
        },
        nearby: nearby
          ? {
              ...compact(pick(nearby, ['at', 'radius', 'origin'])),
              resources: compact(nearby.resources),
              entities: compact(nearby.entities),
            }
          : null,
      },
      peers: compact((this.agent.peerDirectory?.list?.() || []).slice(0, 16)),
      actions: allowedActions(this.agent).map((action) => ({
        id: action.id,
        description: action.description,
        parameters: action.parameters,
        execution: action.execution,
        handoff: action.handoff,
        resume: action.resume,
        tools: action.tools,
        supplies: action.supplies,
        availability: availability(this.agent, { type: action.id }),
        policy:
          action.id === 'exchange'
            ? 'Automatic surplus only; recipient must explicitly allow autonomous exchange. Never specify give/receive.'
            : null,
      })),
    }
    const copy = plain(snapshot)
    if (Buffer.byteLength(JSON.stringify(copy)) > this.maxSnapshotBytes)
      throw failure(
        'CONTEXT_LIMIT',
        'The observation snapshot exceeds the bounded inference context.',
      )
    return freeze(copy)
  }
  async tick() {
    if (this.pending) return this.pending.promise
    if (this.paused || this.config.mode === 'off') return null
    if (!this.ready()) {
      this.pause('SESSION_CHANGED')
      return null
    }
    if (this.nextWakeAt !== null && this.now() >= this.nextWakeAt) {
      this.nextWakeAt = null
      this.enqueue('timer', { dueAt: this.now() })
    }
    this.events = this.events.filter(
      (event) =>
        this.fresh(event.context) &&
        (event.kind !== 'peer.message' || event.payload.expiresAt > this.now()),
    )
    if (!this.events.length) return null
    const controller = new AbortController(),
      context = this.context(),
      mode = this.config.mode
    let snapshot, schema
    try {
      schema = decisionSchema(this.agent)
      snapshot = this.inferenceSnapshot(this.events.splice(0, 8))
    } catch (error) {
      this.error = error.message
      this.pause(error.code || 'CONTEXT_INVALID')
      return null
    }
    const reservedTokens =
      Buffer.byteLength(JSON.stringify(snapshot)) +
      Buffer.byteLength(JSON.stringify(schema)) +
      Buffer.byteLength(INSTRUCTIONS) +
      this.config.budget.maxOutputTokens +
      1024
    const pending = { controller, context, promise: null }
    this.pending = pending
    const run = async () => {
      let timer
      try {
        const aborted = new Promise((_, reject) => {
          controller.signal.addEventListener('abort', () => reject(controller.signal.reason), {
            once: true,
          })
        })
        // Pausing is prompt, but the shared slot remains owned until the provider
        // actually settles. A provider ignoring AbortSignal cannot overlap a retry.
        const scheduled = this.scheduler.run(
          {
            agentId: this.agentId,
            reservedTokens,
            budget: this.config.budget,
            signal: controller.signal,
            isReady: () => this.fresh(context),
          },
          async () => {
            timer = setTimeout(
              () =>
                controller.abort(failure('PROVIDER_TIMEOUT', 'The supervisor decision timed out.')),
              this.requestTimeoutMs,
            )
            return this.provider.decide(snapshot, {
              schema,
              model: this.config.model,
              maxOutputTokens: this.config.budget.maxOutputTokens,
              signal: controller.signal,
              agent: this.agent,
            })
          },
        )
        const settled = () => {
          if (this.pending !== pending) this.publish()
        }
        scheduled.then(settled, settled)
        const result = await Promise.race([scheduled, aborted])
        if (!this.fresh(context) || controller.signal.aborted) {
          this.lastDecision = { at: this.now(), mode, status: 'stale', context }
          return null
        }
        const decision = decodeDecision(result.decision, this.agent, schema)
        this.lastDecision = {
          at: this.now(),
          mode,
          status: mode === 'shadow' ? 'shadow' : 'proposed',
          context,
          decision: plain(decision),
        }
        this.persist() // A decision is reviewable before it can invoke a side effect.
        if (mode === 'autonomous') {
          this.apply(decision, context)
          if (this.lastDecision.status === 'proposed') this.lastDecision.status = 'admitted'
        }
        this.agent.log?.(
          'supervisor.decision',
          `${mode}: ${decision.kind} — ${decision.reason}`,
          'info',
        )
        return this.lastDecision
      } catch (error) {
        if (this.fresh(context) && !this.paused) {
          if (this.lastDecision?.context === context) {
            this.lastDecision.status = 'rejected'
            this.lastDecision.error = {
              code: error.code || 'DECISION_FAILED',
              message: error.message,
            }
          }
          this.error = error.message
          this.pause(error.code || 'DECISION_FAILED')
        }
        return null
      } finally {
        clearTimeout(timer)
        if (this.pending === pending) {
          this.pending = null
          try {
            this.persist()
          } catch (error) {
            this.error = error.message
            this.paused = true
            this.reason = error.code
          }
          this.publish()
        }
      }
    }
    pending.promise = run()
    this.publish()
    return pending.promise
  }
  apply(decision, context) {
    if (!this.fresh(context))
      throw failure('STALE_SESSION', 'The decision became stale before execution.')
    if (decision.kind === 'start' || decision.kind === 'switch') {
      const current = this.agent.state.task
      if (
        current?.status === 'running' &&
        JSON.stringify(current.invocation) === JSON.stringify(decision.command)
      ) {
        this.lastDecision.status = 'unchanged'
        return
      }
      const receipt = this.agent.runtime[decision.kind](decision.command, {
        source: 'supervisor',
        supervisor: true,
        context,
        requestId: randomUUID(),
      })
      this.lastDecision.receipt = receipt
        ? { requestId: receipt.requestId, runId: receipt.runId || null, status: receipt.status }
        : null
    } else if (decision.kind === 'cancel') {
      this.agent.runtime.stop(false, 'SUPERVISOR_CANCEL', false)
    } else if (decision.kind === 'wait') {
      this.nextWakeAt = decision.waitMs === null ? null : this.now() + decision.waitMs
    } else if (decision.kind === 'message') {
      const conversationId = decision.conversationId || randomUUID()
      const turns = this.conversations.get(conversationId) || 0
      if (turns >= this.maxConversationTurns)
        throw failure(
          'CONVERSATION_LIMIT',
          'The peer conversation has reached its bounded turn limit.',
        )
      this.lastDecision.receipt = this.agent.messages.send({
        to: decision.to,
        channel: decision.channel,
        kind: decision.messageKind,
        payload: { text: decision.text },
        conversationId,
        ...(decision.replyTo ? { replyTo: decision.replyTo } : {}),
      })
      this.conversations.set(conversationId, turns + 1)
      while (this.conversations.size > 64)
        this.conversations.delete(this.conversations.keys().next().value)
    }
  }
}

module.exports = { Supervisor, MODES, DEFAULT_BUDGET }
