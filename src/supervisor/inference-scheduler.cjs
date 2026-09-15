/** Shared admission for fleet inference. Reservations are charged before sending requests;
 * unknown outcomes and process crashes retain that charge instead of refunding unseen usage.
 */
const path = require('node:path')
const { loadJson, saveJson } = require('../infra/json-store.cjs')
const { failure } = require('./responses-transport.cjs')
const dayAt = (time) => new Date(time).toISOString().slice(0, 10)
const count = (value) => Number.isSafeInteger(value) && value >= 0
const counters = (value) => value && count(value.requests) && count(value.tokens)
const validLedger = (value) =>
  value &&
  typeof value.days === 'object' &&
  !Array.isArray(value.days) &&
  Array.isArray(value.recent) &&
  value.recent.every(Number.isFinite) &&
  Object.entries(value.days).every(
    ([day, value]) =>
      /^\d{4}-\d{2}-\d{2}$/.test(day) &&
      counters(value) &&
      value.agents &&
      typeof value.agents === 'object' &&
      Object.values(value.agents).every(counters),
  )
const tokenUsage = (usage) => {
  if (!usage || !count(usage.input_tokens) || !count(usage.output_tokens)) return null
  return usage.input_tokens + usage.output_tokens
}

class InferenceScheduler {
  constructor({
    file = path.join(__dirname, '..', '..', 'data', 'supervisor-usage.json'),
    now = Date.now,
    maxConcurrent = 2,
    requestsPerMinute = 10,
    requestsPerDay = 200,
    tokensPerDay = 250000,
    maxQueue = 32,
  } = {}) {
    Object.assign(this, {
      file,
      now,
      maxConcurrent,
      requestsPerMinute,
      requestsPerDay,
      tokensPerDay,
      maxQueue,
    })
    for (const value of [maxConcurrent, requestsPerMinute, requestsPerDay, tokensPerDay, maxQueue])
      if (!Number.isSafeInteger(value) || value < 1)
        throw new Error('Inference limits must be positive integers.')
    this.queue = []
    this.active = new Set()
    this.agents = new Set()
    this.error = null
    try {
      this.ledger = file
        ? loadJson(file, { validate: validLedger }).data || { days: {}, recent: [] }
        : { days: {}, recent: [] }
    } catch (error) {
      this.error = error
      this.ledger = { days: {}, recent: [] }
    }
  }
  persist() {
    if (this.error) throw this.error
    if (this.file) {
      try {
        saveJson(this.file, this.ledger, { validate: validLedger })
      } catch (error) {
        this.error = error
        throw error
      }
    }
  }
  current() {
    const today = dayAt(this.now())
    const value = (this.ledger.days[today] ||= { requests: 0, tokens: 0, agents: {} })
    this.ledger.recent = this.ledger.recent.filter((time) => this.now() - time < 60000)
    for (const day of Object.keys(this.ledger.days))
      if (day < dayAt(this.now() - 7 * 86400000)) delete this.ledger.days[day]
    return { day: today, value }
  }
  snapshot(agentId) {
    const { value } = this.current()
    return {
      limits: {
        maxConcurrent: this.maxConcurrent,
        requestsPerMinute: this.requestsPerMinute,
        requestsPerDay: this.requestsPerDay,
        tokensPerDay: this.tokensPerDay,
      },
      usage: { ...(value.agents[agentId] || { requests: 0, tokens: 0 }) },
      fleetUsage: { requests: value.requests, tokens: value.tokens },
      active: this.active.size,
      queued: this.queue.length,
      agentBusy: this.agents.has(agentId),
      error: this.error?.message || null,
    }
  }
  run({ agentId, reservedTokens, budget, signal, isReady = () => true }, execute) {
    if (this.error) return Promise.reject(this.error)
    if (
      !/^[a-zA-Z0-9_-]{1,64}$/.test(agentId || '') ||
      !count(reservedTokens) ||
      reservedTokens < 1
    )
      return Promise.reject(failure('INFERENCE_LIMIT', 'Invalid inference reservation.'))
    if (this.agents.has(agentId))
      return Promise.reject(
        failure('INFERENCE_BUSY', 'This bot already has a queued or running decision.'),
      )
    if (this.queue.length >= this.maxQueue)
      return Promise.reject(failure('INFERENCE_QUEUE_FULL', 'The fleet inference queue is full.'))
    if (signal?.aborted)
      return Promise.reject(failure('PROVIDER_CANCELLED', 'The queued decision was cancelled.'))
    return new Promise((resolve, reject) => {
      const entry = { agentId, reservedTokens, budget, signal, isReady, execute, resolve, reject }
      entry.cancel = () => {
        const index = this.queue.indexOf(entry)
        if (index < 0) return
        this.queue.splice(index, 1)
        this.release(entry)
        reject(failure('PROVIDER_CANCELLED', 'The queued decision was cancelled.'))
        this.drain()
      }
      signal?.addEventListener('abort', entry.cancel, { once: true })
      this.agents.add(agentId)
      this.queue.push(entry)
      this.drain()
    })
  }
  release(entry) {
    entry.signal?.removeEventListener('abort', entry.cancel)
    this.agents.delete(entry.agentId)
    this.active.delete(entry)
  }
  reserve(entry) {
    if (entry.signal?.aborted || !entry.isReady())
      throw failure('STALE_SESSION', 'The bot is no longer ready for the queued decision.')
    const { day, value } = this.current()
    const own = (value.agents[entry.agentId] ||= { requests: 0, tokens: 0 })
    const budget = entry.budget || {}
    if (
      value.requests >= this.requestsPerDay ||
      own.requests >= (budget.requestsPerDay ?? this.requestsPerDay) ||
      value.tokens + entry.reservedTokens > this.tokensPerDay ||
      own.tokens + entry.reservedTokens > (budget.tokensPerDay ?? this.tokensPerDay)
    )
      throw failure(
        'INFERENCE_BUDGET',
        'The daily inference budget cannot cover this decision reservation.',
      )
    value.requests++
    own.requests++
    value.tokens += entry.reservedTokens
    own.tokens += entry.reservedTokens
    this.ledger.recent.push(this.now())
    this.persist()
    entry.day = day
  }
  settle(entry, usage) {
    const actual = tokenUsage(usage)
    if (actual === null || !entry.day) return
    const value = this.ledger.days[entry.day],
      own = value?.agents[entry.agentId]
    if (!own) return
    value.tokens += actual - entry.reservedTokens
    own.tokens += actual - entry.reservedTokens
    this.persist()
  }
  drain() {
    clearTimeout(this.timer)
    this.timer = null
    while (this.queue.length && this.active.size < this.maxConcurrent) {
      this.current()
      if (this.error) {
        const entry = this.queue.shift()
        this.release(entry)
        entry.reject(this.error)
        continue
      }
      if (this.ledger.recent.length >= this.requestsPerMinute) {
        const wait = Math.max(1, 60000 - (this.now() - Math.min(...this.ledger.recent)))
        this.timer = setTimeout(() => this.drain(), wait)
        this.timer.unref?.()
        return
      }
      const entry = this.queue.shift()
      try {
        this.reserve(entry)
      } catch (error) {
        this.release(entry)
        entry.reject(error)
        continue
      }
      this.active.add(entry)
      const finish = (error, result) => {
        try {
          this.settle(entry, error ? error.usage : result?.usage)
        } catch (saveError) {
          error = saveError
        }
        this.release(entry)
        this.drain()
        if (error) entry.reject(error)
        else entry.resolve(result)
      }
      Promise.resolve()
        .then(() => {
          if (entry.signal?.aborted || !entry.isReady())
            throw failure('STALE_SESSION', 'The bot changed before inference began.')
          return entry.execute()
        })
        .then(
          (result) => finish(null, result),
          (error) => finish(error),
        )
    }
  }
}

let shared
const defaultScheduler = () => (shared ||= new InferenceScheduler())
module.exports = { InferenceScheduler, defaultScheduler, tokenUsage }
