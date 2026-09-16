/** Armor-manager slot classification with task-owned, verified equipment changes.
 * Never install its delayed playerCollect listener: an inventory event can occur
 * inside a chest transfer or after Stop. Workers call this at safe checkpoints.
 */
const { findArmorDestination } = require('mineflayer-armor-manager/dist/lib/invUtil.js')
const { enchantments } = require('./item-tools.cjs')

// Correct upstream's chainmail-above-iron ordering. Turtle helmets are a
// situational choice, so do not replace an equipped one automatically.
const rank = { leather: 0, golden: 1, chainmail: 2, iron: 3, turtle: 3, diamond: 4, netherite: 5 }
const slots = { head: 5, torso: 6, legs: 7, feet: 8, 'off-hand': 45 }
const tier = (item) => rank[item?.name.split('_')[0]] ?? -1
const remaining = (bot, item) =>
  (bot.registry.items[item.type]?.maxDurability ?? Infinity) - (item.durabilityUsed || 0)
const cursed = (bot, item) =>
  enchantments(item, bot).some((e) => /binding_curse|vanishing_curse/.test(e.name))
function preservesEnchantments(bot, old, next) {
  const levels = new Map(enchantments(next, bot).map((e) => [e.name, e.lvl]))
  return enchantments(old, bot).every((e) => (levels.get(e.name) || 0) >= e.lvl)
}
function better(bot, old, next) {
  if (remaining(bot, next) <= 1 || cursed(bot, next)) return false
  if (!old) return true
  if (
    cursed(bot, old) ||
    old.name === 'elytra' ||
    (old.name === 'turtle_helmet' && next.name !== old.name)
  )
    return false
  if (!preservesEnchantments(bot, old, next)) return false
  if (tier(next) > tier(old)) return true
  if (tier(next) !== tier(old)) return false
  const quality = (i) => enchantments(i, bot).reduce((n, e) => n + e.lvl, 0)
  return (
    quality(next) > quality(old) ||
    (quality(next) === quality(old) && remaining(bot, next) > remaining(bot, old))
  )
}

async function equipArmor(work) {
  work.check()
  const bot = work.bot
  if (bot.currentWindow || bot.inventory.selectedItem || !bot.inventory.slots) return 0
  let equipped = 0
  for (const [destination, fallback] of Object.entries(slots)) {
    work.check()
    if (destination === 'off-hand' && bot.supportFeature?.('doesntHaveOffHandSlot')) continue
    const slot = bot.getEquipmentDestSlot?.(destination) ?? fallback
    const old = bot.inventory.slots[slot]
    // Keep shields, totems and any manually equipped offhand item. Only fill an
    // empty offhand with a carried shield; totems need an explicit user choice.
    if (destination === 'off-hand' && old) continue
    if (old && findArmorDestination(old) !== destination) continue
    const candidates = bot.inventory
      .items()
      .filter(
        (i) =>
          findArmorDestination(i) === destination &&
          (destination !== 'off-hand' || i.name === 'shield') &&
          (destination === 'off-hand'
            ? remaining(bot, i) > 1 && !cursed(bot, i)
            : better(bot, old, i)),
      )
    let best = old
    for (const candidate of candidates)
      if (
        destination === 'off-hand'
          ? !best || remaining(bot, candidate) > remaining(bot, best)
          : better(bot, best, candidate)
      )
        best = candidate
    if (!best || best === old) continue
    await work.timed(
      () => {
        work.check()
        if (
          bot.currentWindow ||
          bot.inventory.selectedItem ||
          bot.inventory.slots[slot] !== old ||
          !bot.inventory.items().includes(best) ||
          cursed(bot, best) ||
          remaining(bot, best) <= 1
        )
          throw new Error('Equipment changed before the armor upgrade.')
        return bot.equip(best, destination)
      },
      5000,
      `Equip ${best.name.replaceAll('_', ' ')}`,
    )
    work.check()
    const actual = bot.inventory.slots[slot]
    if (
      !actual ||
      actual.type !== best.type ||
      (actual.durabilityUsed || 0) !== (best.durabilityUsed || 0) ||
      !preservesEnchantments(bot, best, actual) ||
      cursed(bot, actual)
    )
      throw new Error(`Equipping ${best.name} was not confirmed by the inventory.`)
    equipped++
  }
  return equipped
}

const IRON_SLOTS = { iron_helmet: 5, iron_chestplate: 6, iron_leggings: 7, iron_boots: 8 }
function needsIron(bot, name) {
  const type = bot.registry.itemsByName[name]?.id
  return (
    type !== undefined &&
    better(bot, bot.inventory.slots?.[IRON_SLOTS[name]], {
      name,
      type,
      count: 1,
      durabilityUsed: 0,
    })
  )
}
module.exports = { equipArmor, needsIron, IRON_SLOTS }
