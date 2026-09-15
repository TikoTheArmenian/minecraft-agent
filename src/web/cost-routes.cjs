const { costsFor } = require('../infra/api-costs.cjs')
function queryFilter(query, fixedAgent = null) {
  const allowed = new Set(['from', 'to', 'agent'])
  if (Object.keys(query).some((k) => !allowed.has(k)))
    throw new Error('Use from, to and agent filters.')
  const date = (value, inclusiveEnd = false) => {
    if (value === undefined || value === '') return null
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value))
      throw new Error('Dates must use YYYY-MM-DD in UTC.')
    const parsed = Date.parse(value + 'T00:00:00Z')
    if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== value)
      throw new Error('Invalid calendar date.')
    return parsed + (inclusiveEnd ? 86400000 : 0)
  }
  if (
    query.agent !== undefined &&
    (typeof query.agent !== 'string' || !/^[a-zA-Z0-9_-]{1,32}$/.test(query.agent))
  )
    throw new Error('Invalid agent.')
  if (fixedAgent && query.agent && query.agent !== fixedAgent)
    throw new Error('Use the project cost endpoint to view other agents.')
  return {
    from: date(query.from),
    to: date(query.to, true),
    agent: fixedAgent || query.agent || null,
  }
}
function installCostRoutes(app, agent, fleet) {
  const names = () => Object.values(fleet || agent.fleet || { self: agent }).map((a) => a.username)
  const filter = (req) =>
    queryFilter(req.query, req.baseUrl.startsWith('/bots/') ? agent.username : null)
  app.get('/api/costs', (req, res, next) => {
    try {
      const selection = filter(req)
      res.json(costsFor(agent).summary(selection, selection.agent ? [selection.agent] : names()))
    } catch (error) {
      next(error)
    }
  })
  app.post('/api/costs/budgets', (req, res, next) => {
    try {
      if (Object.keys(req.body).some((k) => !['scope', 'dailyUsd', 'monthlyUsd'].includes(k)))
        throw new Error('Unknown budget setting.')
      if (req.body.scope !== 'project' && !names().includes(req.body.scope))
        throw new Error('Choose project or a known bot.')
      if (req.baseUrl.startsWith('/bots/') && req.body.scope !== agent.username)
        throw new Error('This budget control belongs to the selected agent.')
      costsFor(agent).setBudget(req.body)
      res.json({ ok: true })
    } catch (error) {
      next(error)
    }
  })
  app.get('/api/costs/export', async (req, res, next) => {
    try {
      const selection = filter(req),
        costs = costsFor(agent)
      costs.filter(selection)
      if (!costs.db || costs.error)
        throw new Error('Cost ledger is unavailable; export cannot be completed.')
      // Freeze the upper time boundary so new requests do not extend a running export.
      selection.to = Math.min(selection.to || Infinity, costs.now() + 1)
      const columns = [
        'id',
        'started_at',
        'ended_at',
        'agent',
        'provider',
        'operation',
        'model',
        'tier',
        'outcome',
        'http_status',
        'input_tokens',
        'cached_tokens',
        'cache_write_tokens',
        'output_tokens',
        'reasoning_tokens',
        'estimatedUsd',
        'pricing_status',
        'response_id',
        'request_id',
        'duplicate_of',
        'price',
      ]
      const cell = (value) => {
        let text =
          value === null || value === undefined
            ? ''
            : typeof value === 'object'
              ? JSON.stringify(value)
              : String(value)
        if (/^[=+\-@\t\r]/.test(text)) text = "'" + text
        return '"' + text.replaceAll('"', '""') + '"'
      }
      res.type('text/csv').attachment('api-costs.csv')
      res.write(columns.join(',') + '\r\n')
      let count = 0
      for (const row of costs.exportRows(selection)) {
        if (res.destroyed) break
        if (!res.write(columns.map((c) => cell(row[c])).join(',') + '\r\n'))
          await new Promise((resolve) => {
            const done = () => {
              res.off('drain', done)
              res.off('close', done)
              res.off('error', done)
              resolve()
            }
            res.once('drain', done)
            res.once('close', done)
            res.once('error', done)
          })
        if (++count % 250 === 0) await new Promise(setImmediate)
      }
      res.end()
    } catch (error) {
      if (res.headersSent) res.destroy()
      else next(error)
    }
  })
}
module.exports = { installCostRoutes, queryFilter }
