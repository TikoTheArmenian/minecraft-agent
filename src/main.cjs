/** Application startup: compose the fleet, serve the control room, and shut down together. */
const { Agent } = require('./agents/agent.cjs')
const { createApp } = require('./web/server.cjs')

if (require.main === module) {
  const apiCosts = new (require('./infra/api-costs.cjs').ApiCosts)()
  const colony = new (require('./storage/colony.cjs').Colony)({ apiCosts })
  // Item icons come from the installed Minecraft client jar; the app runs without them.
  require('../scripts/extract-textures.cjs').ensureTextures({ log: console.log })
  // Every bot in src/agents/fleet.cjs gets its own Agent, data directory and API mount.
  const fleet = require('./agents/fleet.cjs').buildFleet(Agent, {
    colony,
    apiCosts,
    logToConsole: true,
  })
  const agent = fleet.marc || Object.values(fleet)[0]
  const server = createApp(agent, fleet).listen(4317, '127.0.0.1')
  server.on('listening', () =>
    console.log(
      `Control room for ${Object.values(fleet)
        .map((b) => b.username)
        .join(', ')}: http://127.0.0.1:4317`,
    ),
  )
  const ticker = setInterval(() => {
    for (const bot of Object.values(fleet))
      if (bot.state.connection === 'ready') {
        bot.refresh()
        bot.messages.tick()
        void bot.supervisor
          .tick()
          .catch((error) => bot.log('supervisor.error', error.message, 'warn'))
        void bot.coordination
          .tick()
          .catch((error) => bot.log('colony.chat.error', error.message, 'warn'))
      }
  }, 500)
  server.on('error', (error) => {
    clearInterval(ticker)
    console.error(
      error.code === 'EADDRINUSE'
        ? 'The control room is already running at http://127.0.0.1:4317.'
        : error.message,
    )
    process.exitCode = 1
  })
  function shutdown() {
    clearInterval(ticker)
    for (const bot of Object.values(fleet)) bot.disconnect()
    server.close()
    server.closeAllConnections()
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
