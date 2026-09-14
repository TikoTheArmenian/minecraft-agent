/** Durable project ledger. No prompts, replies, headers, URLs, credentials, or inventory payloads. */
const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { DatabaseSync } = require('node:sqlite')
const { usageOf, estimate, rates, VERIFIED_AT, SOURCE } = require('./api-pricing.cjs')
const DAY = 86400000
const word = value => typeof value === 'string' && /^[a-zA-Z0-9_.:/-]{1,120}$/.test(value) ? value : null
const outcomes = new Set(['completed', 'incomplete', 'failed', 'http_error', 'network_error', 'cancelled', 'timeout', 'invalid_response'])
const aggregate = `COUNT(*) requests,
 SUM(CASE WHEN provider='openai' THEN 1 ELSE 0 END) openaiRequests,
 SUM(CASE WHEN provider='supabase' THEN 1 ELSE 0 END) supabaseRequests,
 COALESCE(SUM(CASE WHEN duplicate_of IS NULL THEN cost_nano ELSE 0 END),0) costNano,
 SUM(CASE WHEN pricing_status='estimated' AND duplicate_of IS NULL THEN 1 ELSE 0 END) pricedRequests,
 SUM(CASE WHEN provider='openai' AND cost_nano IS NULL AND (outcome!='pending' OR started_at < ?) THEN 1 ELSE 0 END) unknownCosts,
 SUM(CASE WHEN outcome='pending' AND started_at >= ? THEN 1 ELSE 0 END) pending,
 SUM(CASE WHEN outcome NOT IN ('completed','pending') OR (outcome='pending' AND started_at < ?) THEN 1 ELSE 0 END) errors,
 COALESCE(SUM(CASE WHEN duplicate_of IS NULL THEN input_tokens ELSE 0 END),0) inputTokens,
 COALESCE(SUM(CASE WHEN duplicate_of IS NULL THEN cached_tokens ELSE 0 END),0) cachedTokens,
 COALESCE(SUM(CASE WHEN duplicate_of IS NULL THEN cache_write_tokens ELSE 0 END),0) cacheWriteTokens,
 COALESCE(SUM(CASE WHEN duplicate_of IS NULL THEN output_tokens ELSE 0 END),0) outputTokens,
 COALESCE(SUM(CASE WHEN duplicate_of IS NULL THEN reasoning_tokens ELSE 0 END),0) reasoningTokens,
 ROUND(AVG(ended_at-started_at)) latencyMs`
class ApiCosts {
  constructor({ file = path.join(__dirname, '..', 'data', 'api-costs.sqlite'), now = Date.now } = {}) {
    this.file = file
    this.now = now
    this.error = null
    this.missed = 0
    try {
      if (file !== ':memory:') {
        fs.mkdirSync(path.dirname(file), { recursive: true })
        fs.closeSync(fs.openSync(file, 'a', 0o600))
        fs.chmodSync(file, 0o600)
      }
      this.db = new DatabaseSync(file)
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=2000;
        CREATE TABLE IF NOT EXISTS requests (
          id TEXT PRIMARY KEY, started_at INTEGER NOT NULL, ended_at INTEGER,
          agent TEXT NOT NULL, provider TEXT NOT NULL, operation TEXT NOT NULL,
          requested_model TEXT, model TEXT, tier TEXT, outcome TEXT NOT NULL DEFAULT 'pending',
          http_status INTEGER, response_id TEXT, request_id TEXT, duplicate_of TEXT,
          input_tokens INTEGER, cached_tokens INTEGER, cache_write_tokens INTEGER,
          output_tokens INTEGER, reasoning_tokens INTEGER,
          cost_nano INTEGER, pricing_status TEXT NOT NULL DEFAULT 'pending', price_json TEXT
        );
        CREATE INDEX IF NOT EXISTS request_time ON requests(started_at);
        CREATE INDEX IF NOT EXISTS request_agent_time ON requests(agent,started_at);
        CREATE UNIQUE INDEX IF NOT EXISTS response_identity ON requests(provider,response_id) WHERE response_id IS NOT NULL AND duplicate_of IS NULL;
        CREATE TABLE IF NOT EXISTS budgets (scope TEXT PRIMARY KEY, daily_usd REAL, monthly_usd REAL);
        CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY,value TEXT NOT NULL);`)
      this.db.prepare("INSERT OR IGNORE INTO metadata VALUES ('started_at',?)").run(String(now()))
    } catch (error) { this.fault(error) }
  }
  fault(error) {
    this.error = `Cost tracking has a storage error (${word(error.code) || 'unavailable'}). Totals may be incomplete; game actions continue.`
    this.missed++
  }
  begin({ agent = 'project', provider, operation, model = null }) {
    const id = randomUUID()
    try {
      this.db.prepare('INSERT INTO requests (id,started_at,agent,provider,operation,requested_model) VALUES (?,?,?,?,?,?)')
        .run(id, this.now(), word(agent) || 'project', word(provider) || 'unknown', word(operation) || 'request', word(model))
      return id
    } catch (error) { this.fault(error); return null }
  }
  finish(id, { outcome = 'completed', httpStatus = null, result = null, requestId = null } = {}) {
    if (!id) return
    try {
      const row = this.db.prepare('SELECT * FROM requests WHERE id=?').get(id)
      // Completion is idempotent. A late API result may finish an old pending request after a disconnect.
      if (!row || row.outcome !== 'pending') return
      const model = word(result?.model) || row.requested_model
      const tier = word(result?.service_tier) || null
      const usage = row.provider === 'openai' ? usageOf(result?.usage) : null
      const price = row.provider === 'openai' ? estimate(model, tier, usage) : { costNano: null, pricingStatus: 'provider_billed_separately', price: null }
      const responseId = word(result?.id)
      const duplicate = responseId && this.db.prepare('SELECT id FROM requests WHERE provider=? AND response_id=? AND duplicate_of IS NULL AND id!=?').get(row.provider, responseId, id)
      this.db.prepare(`UPDATE requests SET ended_at=?, outcome=?, http_status=?, model=?, tier=?, response_id=?, request_id=?, duplicate_of=?,
        input_tokens=?,cached_tokens=?,cache_write_tokens=?,output_tokens=?,reasoning_tokens=?,cost_nano=?,pricing_status=?,price_json=? WHERE id=?`)
        .run(this.now(), outcomes.has(outcome) ? outcome : 'failed', Number.isInteger(httpStatus) ? httpStatus : null,
          model, tier, responseId, word(requestId), duplicate?.id || null,
          usage?.input ?? null, usage?.cached ?? null, usage?.cacheWrite ?? null, usage?.output ?? null, usage?.reasoning ?? null,
          duplicate ? 0 : price.costNano, duplicate ? 'duplicate' : price.pricingStatus, price.price ? JSON.stringify(price.price) : null, id)
    } catch (error) { this.fault(error) }
  }
  filter({ from = null, to = null, agent = null } = {}) {
    const params = [], clauses = []
    for (const [name, value, op] of [['from', from, '>='], ['to', to, '<']]) {
      if (value === null || value === '') continue
      if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${name} timestamp.`)
      clauses.push(`started_at ${op} ?`); params.push(value)
    }
    if (from !== null && to !== null && to <= from) throw new Error('End date must be after start date.')
    if (agent) {
      if (!word(agent)) throw new Error('Invalid agent.')
      clauses.push('agent=?'); params.push(agent)
    }
    return { where: clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '', params }
  }
  totals(filter = {}, group = null) {
    const { where, params } = this.filter(filter), stale = this.now() - 60000
    const groups = { agent: 'agent', model: "COALESCE(model,requested_model,provider)", day: "strftime('%Y-%m-%d',started_at/1000,'unixepoch')" }
    const column = groups[group]
    const rows = this.db.prepare(`SELECT ${column ? `${column} name,` : ''} ${aggregate} FROM requests${where}${column ? ` GROUP BY ${column} ORDER BY name` : ''}`)
      .all(stale, stale, stale, ...params)
    return rows.map(r => ({ ...Object.fromEntries(Object.entries(r).map(([key, value]) => [key, value === null && key !== 'latencyMs' ? 0 : value])), estimatedUsd: r.costNano / 1e9 }))
  }
  records(filter = {}, limit = 50) {
    const { where, params } = this.filter(filter)
    return this.db.prepare(`SELECT * FROM requests${where} ORDER BY started_at DESC,id DESC LIMIT ?`).all(...params, limit).map(r => this.publicRecord(r))
  }
  publicRecord(row) {
    return { ...row, outcome: row.outcome === 'pending' && row.started_at < this.now() - 60000 ? 'interrupted' : row.outcome,
      estimatedUsd: row.cost_nano === null ? null : row.cost_nano / 1e9, price: row.price_json ? JSON.parse(row.price_json) : null, price_json: undefined }
  }
  summary(filter = {}, agents = []) {
    this.filter(filter) // Bad query parameters must not be reported as storage failures.
    try {
      if (!this.db) throw new Error('unavailable')
      const now = this.now(), day = Math.floor(now / DAY) * DAY, d = new Date(now), month = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)
      const byAgent = this.totals(filter, 'agent')
      const empty = this.totals({ from: now, to: now + 1, agent: '__none__' })[0]
      for (const agent of agents) if (!byAgent.some(r => r.name === agent)) byAgent.push({ ...empty, name: agent })
      const budgets = this.db.prepare('SELECT * FROM budgets ORDER BY scope').all()
      const alerts = []
      for (const budget of budgets) {
        for (const [period, from, usd] of [['daily', day, budget.daily_usd], ['monthly', month, budget.monthly_usd]]) {
          if (usd === null) continue
          const total = this.totals({ from, agent: budget.scope === 'project' ? null : budget.scope })[0]
          if (total.estimatedUsd >= usd * 0.8) alerts.push({ scope: budget.scope, period, budgetUsd: usd,
            estimatedUsd: total.estimatedUsd, level: total.estimatedUsd >= usd ? 'exceeded' : 'approaching', unknownCosts: total.unknownCosts })
        }
      }
      return { currency: 'USD', timezone: 'UTC', trackingSince: Number(this.db.prepare("SELECT value FROM metadata WHERE key='started_at'").get().value),
        health: { error: this.error, missedWrites: this.missed },
        pricing: { verifiedAt: VERIFIED_AT, source: SOURCE, rates, stale: now - Date.parse(VERIFIED_AT) > 90 * DAY },
        total: this.totals(filter)[0], today: this.totals({ from: day, agent: filter.agent })[0], month: this.totals({ from: month, agent: filter.agent })[0],
        agents: byAgent, models: this.totals(filter, 'model'), daily: filter.to && filter.to <= day - 89 * DAY ? [] : this.totals({ ...filter, from: Math.max(filter.from || 0, day - 89 * DAY) }, 'day'),
        recent: this.records(filter), budgets, alerts }
    } catch (error) { this.fault(error); return { health: { error: this.error, missedWrites: this.missed }, total: null } }
  }
  setBudget({ scope, dailyUsd = null, monthlyUsd = null }) {
    if (!word(scope)) throw new Error('Choose a valid project or agent budget scope.')
    for (const value of [dailyUsd, monthlyUsd])
      if (value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 1000000))
        throw new Error('Budget alerts must be positive USD amounts, or blank to disable.')
    if (!this.db || this.error) throw new Error('Cost ledger is unavailable; budget was not saved.')
    this.db.prepare('INSERT INTO budgets VALUES (?,?,?) ON CONFLICT(scope) DO UPDATE SET daily_usd=excluded.daily_usd,monthly_usd=excluded.monthly_usd')
      .run(scope, dailyUsd, monthlyUsd)
  }
  *exportRows(filter) {
    const { where, params } = this.filter(filter)
    for (const row of this.db.prepare(`SELECT * FROM requests${where} ORDER BY started_at,id`).iterate(...params)) yield this.publicRecord(row)
  }
  close() { this.db?.close(); this.db = null }
}
// Lazy construction avoids opening a database for agents that never make an API call.
function costsFor(agent) {
  if (!agent.apiCosts) agent.apiCosts = new ApiCosts({ file: path.join(agent.dataDir, 'api-costs.sqlite') })
  return agent.apiCosts
}
module.exports = { ApiCosts, costsFor }
