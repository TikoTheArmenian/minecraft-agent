const { publicActions } = require('../skills/registry.cjs')
const { availability } = require('../runtime/invocations.cjs')
const receipt = (value) => ({
  requestId: value.requestId,
  runId: value.runId || null,
  status: value.status,
  ...(value.result ? { result: value.result } : {}),
})

function installAgentRoutes(app, agent) {
  app.get('/api/actions', (req, res) =>
    res.json(
      publicActions().map((definition) => ({
        ...definition,
        allowed: agent.profile.allowedSkills.includes(definition.id),
        availability: availability(agent, { type: definition.id }),
      })),
    ),
  )
  app.get('/api/runs', (req, res) =>
    res.json({ runs: agent.runtime.saved.runs, ...agent.state.runtime }),
  )
  app.get('/api/requests/:requestId', (req, res) => {
    const result = agent.runtime.receipt(req.params.requestId)
    res.status(result ? 200 : 404).json(result || { error: 'Unknown request.' })
  })
  app.post('/api/runs', (req, res, next) => {
    try {
      res
        .status(202)
        .json(receipt(agent.commands.submit(req.body, { source: 'human', actorId: 'local-web' })))
    } catch (error) {
      next(error)
    }
  })
  app.post('/api/runs/:runId/review', (req, res, next) => {
    try {
      if (Object.keys(req.body).some((key) => key !== 'note'))
        throw new Error('Supply a recovery review note only.')
      res.json(agent.runtime.review(req.params.runId, req.body.note))
    } catch (error) {
      next(error)
    }
  })
  app.get('/api/supervisor', (req, res) => res.json(agent.supervisor.snapshot()))
  app.post('/api/supervisor', (req, res, next) => {
    try {
      agent.supervisor.configure(req.body)
      res.json({ supervisor: agent.supervisor.snapshot() })
    } catch (error) {
      next(error)
    }
  })
  for (const operation of ['pause', 'resume'])
    app.post(`/api/supervisor/${operation}`, (req, res, next) => {
      try {
        if (Object.keys(req.body).length) throw new Error('This control does not take parameters.')
        agent.supervisor[operation]('HUMAN_PAUSE')
        res.json({ supervisor: agent.supervisor.snapshot() })
      } catch (error) {
        next(error)
      }
    })
  app.get('/api/messages', (req, res) =>
    res.json({
      inbox: agent.messages.inbox,
      queuedFrames: agent.messages.queue.length,
      peers: agent.peerDirectory.list(),
    }),
  )
}
module.exports = { installAgentRoutes }
