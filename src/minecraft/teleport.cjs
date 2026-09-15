/** Server teleports invalidate routes and block interactions at the old location. */
function installTeleportHandling(agent, bot, current) {
  let before
  // Capture the old position before Mineflayer applies the server's position packet.
  bot._client?.prependListener('position', () => {
    before = bot.entity?.position?.clone()
  })
  bot.on('forcedMove', () => {
    const previous = before
    before = null
    if (!current() || agent.state.connection !== 'ready' || !previous) return
    // Small server corrections are normal during movement; don't cancel for those.
    if (previous.distanceTo(bot.entity.position) < 2) return
    agent.stop(false, 'TELEPORTED')
    const message =
      'Teleported: stopped the previous task. Choose a skill or destination for this location.'
    if (agent.state.task) agent.state.task.label = message
    agent.log('movement.teleported', message, 'warn')
    agent.refresh()
    agent.say(message)
  })
}
module.exports = { installTeleportHandling }
