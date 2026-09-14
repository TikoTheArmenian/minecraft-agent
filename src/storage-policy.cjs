/** Inventory identity and conservative, shared working-stock policy. */
const { createHash } = require('node:crypto')
const { BUILDING_BLOCKS } = require('./travel.cjs')
const CATEGORIES = [
  'tools',
  'wood',
  'building',
  'food',
  'materials',
  'overflow',
]
function stable(value) {
  if (typeof value === 'bigint') return value.toString()
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, stable(value[k])]),
    )
  return value
}
function describe(item) {
  const data = stable({
    name: item.name,
    metadata: item.metadata ?? 0,
    nbt: item.nbt ?? null,
    components: item.components ?? null,
    removedComponents: item.removedComponents ?? [],
    durabilityUsed: item.durabilityUsed ?? 0,
  })
  return {
    ...data,
    fingerprint: createHash('sha256')
      .update(JSON.stringify(data))
      .digest('hex'),
    count: item.count,
    slot: item.slot,
    stackSize: item.stackSize || 64,
  }
}
function plain(item) {
  const nbt = item.nbt
  const pristineDamageOnly =
    nbt?.type === 'compound' &&
    Object.keys(nbt.value || {}).every(
      (k) => k === 'Damage' && nbt.value[k]?.value === 0,
    )
  return (
    (!nbt || pristineDamageOnly) &&
    !(item.components?.length || Object.keys(item.components || {}).length) &&
    !item.removedComponents?.length &&
    !item.durabilityUsed
  )
}

function category(item, registry) {
  const name = item.name
  if (
    registry.itemsByName[name]?.maxDurability ||
    /_(sword|pickaxe|axe|hoe|shovel|helmet|chestplate|leggings|boots)$/.test(
      name,
    )
  )
    return 'tools'
  if (
    /_(log|wood|planks|sapling)$/.test(name) ||
    ['stick', 'bamboo'].includes(name)
  )
    return 'wood'
  if (
    /seeds|wheat|carrot|potato|bread|apple|melon|beetroot|cooked_|berries/.test(
      name,
    )
  )
    return 'food'
  if (
    /ingot|nugget|diamond|emerald|coal|charcoal|redstone|lapis|raw_|^(sugar_cane|sugar|paper|flint|gunpowder|string|bone|rotten_flesh|spider_eye|arrow|ender_pearl|slime_ball|phantom_membrane|quartz)$/.test(name)
  )
    return 'materials'
  if (registry.blocksByName[name]) return 'building'
  return 'overflow'
}
function reserve(item, work) {
  const name = item.name
  // A skill can declare its own working stock (for example a terraformer keeping 128 dirt,
  // or a smelter keeping fuel) without changing the shared defaults below.
  if (work?.reserves && Object.hasOwn(work.reserves, name)) return work.reserves[name]
  // All carried equipment and modified items stay with the worker. Sorting can move chest equipment explicitly.
  if (!plain(item) || category(item, work.bot.registry) === 'tools')
    return Infinity
  if (/_sapling$/.test(name)) return Math.max(8, work.job?.roots?.length || 0)
  if (name === 'wheat_seeds') return 32
  if (name === 'wheat') return 12
  if (['carrot', 'potato', 'beetroot_seeds'].includes(name)) return 8
  if (/_sign$/.test(name)) return 32
  if (name === 'crafting_table') return 1
  if (name === 'torch') return 16
  if (
    ['bread', 'cooked_beef', 'baked_potato', 'apple', 'melon_slice'].includes(
      name,
    )
  )
    return 16
  if (BUILDING_BLOCKS.includes(name)) return 128
  return 0
}
module.exports = { CATEGORIES, describe, plain, category, reserve }
