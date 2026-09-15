/**
 * HTTP application: serves the local website and exposes its /api endpoints.
 * Startup and shutdown live in src/main.cjs.
 * Each Agent owns one Minecraft player; the fleet list lives in src/agents/fleet.cjs.
 * The browser sends commands here, and receives current state through an event stream.
 */

const express = require('express')
const path = require('node:path')

function createApp(agent, fleet = null) {
  const app = express()
  app.disable('x-powered-by')
  // Bind locally and reject other origins/Host headers, including DNS rebinding.
  app.use((req, res, next) => {
    const host = req.headers.host || ''
    if (
      !/^(127\.0\.0\.1|localhost):\d+$/.test(host) ||
      (req.headers.origin && req.headers.origin !== `http://${host}`) ||
      req.headers['sec-fetch-site'] === 'cross-site'
    ) {
      return res
        .status(403)
        .json({ error: 'This control room only accepts requests from its own local page.' })
    }
    res.set(
      'Content-Security-Policy',
      "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    )
    res.set('X-Content-Type-Options', 'nosniff')
    // Live state must never be cached; the extracted item textures can be.
    res.set(
      'Cache-Control',
      req.path.startsWith('/textures/') ? 'private, max-age=86400' : 'no-store',
    )
    next()
  })
  app.use('/api', (req, res, next) => {
    if (req.method === 'POST' && !req.is('application/json'))
      return res.status(415).json({ error: 'Send commands as application/json.' })
    next()
  })
  app.use(express.json({ limit: '4kb' }))
  app.use('/api', (req, res, next) => {
    if (
      req.method === 'POST' &&
      (!req.body || typeof req.body !== 'object' || Array.isArray(req.body))
    )
      return res.status(400).json({ error: 'Send a JSON object.' })
    next()
  })
  if (fleet) {
    require('../agents/fleet-events.cjs').installFleetEvents(fleet)
    // Each entry carries the bot's live state plus its static profile (name, default skill, role).
    app.get('/api/fleet', (req, res) => res.json(require('./events.cjs').fleetSnapshot(fleet)))
    app.get('/api/fleet/events', (req, res) =>
      require('./events.cjs').streamFleetEvents(fleet, req, res),
    )
    app.post('/api/stop-all', (req, res) => {
      for (const bot of Object.values(fleet)) bot.stop()
      res.json({ ok: true })
    })
    for (const [id, bot] of Object.entries(fleet)) app.use(`/bots/${id}`, createApp(bot))
  }
  app.use(
    express.static(path.join(__dirname, '..', '..', 'public'), {
      etag: false,
      cacheControl: false,
    }),
  )
  app.get('/api/state', (req, res) => res.json(agent.state))
  require('./agent-routes.cjs').installAgentRoutes(app, agent)
  require('./cost-routes.cjs').installCostRoutes(app, agent, fleet)
  app.get('/api/skills', (req, res) => res.json(require('../skills/registry.cjs').publicSkills()))
  app.get('/api/storage', async (req, res, next) => {
    try {
      if (!agent.colony.enabled)
        return res.json({
          configured: false,
          containers: [],
          jobs: [],
          reservations: [],
          uncertain: [],
        })
      res.json({ configured: true, ...(await agent.colony.call(agent, 'list')) })
    } catch (error) {
      next(error)
    }
  })
  // Structured crafting goals queue safely even while the bot is running a farm.
  app.post('/api/craft-jobs', async (req, res, next) => {
    try {
      const { item, quantity } = req.body
      if (
        typeof item !== 'string' ||
        !require('../storage/crafting.cjs').allowed(item) ||
        !Number.isInteger(quantity) ||
        quantity < 1 ||
        quantity > 128
      )
        throw new Error('Use a supported item and a quantity from 1 to 128.')
      const job = require('node:crypto').randomUUID()
      await agent.colony.call(agent, 'enqueue', { job, item, quantity })
      res.json({ id: job, status: 'queued' })
    } catch (error) {
      next(error)
    }
  })

  // Bounded, read-only terrain capture for reproducing navigation failures.
  app.get('/api/navigation-snapshot', (req, res, next) => {
    try {
      if (!agent.bot || agent.state.connection !== 'ready')
        throw new Error('Connect the bot first.')
      const p = agent.bot.entity.position.floored(),
        blocks = []
      for (let x = -12; x <= 12; x++)
        for (let z = -12; z <= 12; z++)
          for (let y = -4; y <= 10; y++) {
            const q = p.offset(x, y, z),
              b = agent.bot.blockAt(q)
            if (b) blocks.push([q.x, q.y, q.z, b.stateId])
          }
      res.json({
        version: agent.bot.version,
        position: agent.state.position,
        destination: agent.state.task?.travel?.destination,
        blocks,
      })
    } catch (error) {
      next(error)
    }
  })
  app.get('/api/logs', (req, res) =>
    res.json({
      entries: agent.journal.entries,
      file: agent.journal.file,
      error: agent.journal.error,
    }),
  )
  app.get('/api/logs/download', (req, res, next) =>
    res.download(agent.journal.file, 'walkbot-activity.log', (error) => {
      if (error && !res.headersSent) next(error)
    }),
  )
  app.get('/api/map/volume', (req, res, next) => {
    try {
      if (agent.state.connection !== 'ready') throw new Error('Connect the bot to view its world.')
      res.json(
        require('../world/volume.cjs').buildVolume(agent.bot, {
          focus: req.query.focus ?? 'bot',
          size: req.query.size === undefined ? 7 : Number(req.query.size),
          ...(req.query.height === undefined ? {} : { height: Number(req.query.height) }),
        }),
      )
    } catch (error) {
      next(error)
    }
  })
  app.get('/api/map', (req, res, next) => {
    try {
      res.json(
        agent.maps.snapshot({
          focus: req.query.focus ?? 'player',
          offset: req.query.offset === undefined ? 0 : Number(req.query.offset),
        }),
      )
    } catch (error) {
      next(error)
    }
  })
  app.post('/api/map/action', (req, res, next) => {
    try {
      agent.maps.action(req.body)
      res.json({ ok: true })
    } catch (error) {
      next(error)
    }
  })
  app.post('/api/scan', (req, res, next) => {
    try {
      agent.scan()
      res.json({ ok: true })
    } catch (error) {
      next(error)
    }
  })
  app.get('/api/events', (req, res) => require('./events.cjs').streamEvents(agent, req, res))
  app.post('/api/llm', (req, res, next) => {
    try {
      agent.llm.configure(req.body)
      res.json({ ok: true })
    } catch (error) {
      next(error)
    }
  })
  app.post('/api/connect', async (req, res, next) => {
    try {
      await agent.connect(req.body.port, req.body.world)
      res.json({ ok: true })
    } catch (error) {
      next(error)
    }
  })
  app.post('/api/disconnect', (req, res) => {
    agent.disconnect()
    res.json({ ok: true })
  })
  app.post('/api/command', (req, res, next) => {
    try {
      if (typeof req.body.text !== 'string' || !req.body.text.trim())
        throw new Error('Enter a command.')
      // Keep the conversation on the server so refreshing/reopening a tab preserves it.
      const at = Date.now()
      agent.command(req.body.text)
      agent.say(req.body.text.trim(), 'user', at)
      res.json({ ok: true })
    } catch (error) {
      next(error)
    }
  })
  app.use('/api', (req, res) => res.status(404).json({ error: 'Unknown API endpoint.' }))
  app.use((error, req, res, _next) => {
    const status =
      error.type === 'entity.too.large'
        ? 413
        : ['STALE_SESSION', 'REQUEST_CONFLICT'].includes(error.code)
          ? 409
          : 400
    const message =
      error.type === 'entity.parse.failed'
        ? 'Invalid JSON in request.'
        : error.type === 'entity.too.large'
          ? 'Request is too large (maximum 4 KB).'
          : error.message
    agent.log('request.rejected', `${req.method} ${req.path}: ${message}`, 'warn')
    res.status(status).json({ error: message, code: error.code || null })
  })
  return app
}
module.exports = { createApp }
