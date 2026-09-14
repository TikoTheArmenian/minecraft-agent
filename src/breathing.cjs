/**
 * OXYGEN CORRECTION: keeps the bot's air reading tied to its own player metadata.
 * Safety and surfacing routines depend on this value being about the bot, not a nearby entity.
 */

// Mineflayer 4.39's entity metadata handler emits breath for other entities too.
// Always derive oxygen from our player metadata, never the most recent mob.
function installBreathing(bot) {
  const index = bot.registry?.entitiesByName?.player?.metadataKeys?.indexOf('air_supply')
  const key = Number.isInteger(index) && index >= 0 ? index : 1
  const update = () => {
    const air = bot.entity?.metadata?.[key]
    bot.oxygenLevel = Number.isFinite(air) ? Math.max(0, Math.min(20, Math.round(air / 15))) : 20
  }
  bot.on('breath', update)
  bot.on('spawn', update)
}
module.exports = { installBreathing }
