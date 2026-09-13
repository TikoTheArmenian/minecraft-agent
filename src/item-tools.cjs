const serverEnchantments=new WeakMap()

function enchantments(item,bot) {
  if(!item)return []
  const raw=item.enchants
  // prismarine-item returns the raw 1.21 component container, whereas older
  // versions return [{name,lvl}]. Keep the component intact for inventory packets.
  const entries=Array.isArray(raw)?raw:Array.isArray(raw?.enchantments)?raw.enchantments:[]
  const names=serverEnchantments.get(bot)
  return entries.map(e=>{
    const id=e.name ?? e.id
    const name=typeof id==='string'?id.replace(/^minecraft:/,''):names?names[id]:bot.registry.enchantments[id]?.name
    return {name,lvl:Number(e.lvl ?? e.level)}
  }).filter(e=>typeof e.name==='string' && Number.isFinite(e.lvl) && e.lvl>0)
}
function comparisonBlock(bot,block) {
  const harvesters=Object.keys(block.harvestTools || {})
  // Minimum-tier tags are not mining speed tables. Use actual pickaxe speeds for
  // these ore entries without modifying the world's block instance.
  if(block.material?.startsWith('incorrect_for_') && harvesters.length && harvesters.every(id=>bot.registry.items[id]?.name.endsWith('_pickaxe')))return Object.assign(Object.create(block),{material:'mineable/pickaxe'})
  return block
}
function installToolCompatibility(bot) {
  // Java 1.21 enchantment IDs are supplied by the server's dynamic registry.
  bot._client?.on('registry_data',packet=>{
    if(packet.id==='minecraft:enchantment')serverEnchantments.set(bot,packet.entries.map(e=>e.key.replace(/^minecraft:/,'')))
  })
  // Mineflayer's public digTime is also used by bot.dig. Normalizing only our tool
  // selector would leave the actual dig crashing on the very same component.
  const digTime=block=>{
    const headSlot=bot.getEquipmentDestSlot?.('head') ?? 5
    const enchants=[...enchantments(bot.heldItem,bot),...enchantments(bot.inventory.slots?.[headSlot],bot)]
    return comparisonBlock(bot,block).digTime(bot.heldItem?.type ?? null,bot.game.gameMode==='creative',
      ['water','flowing_water'].includes(bot._getBlockAtEyeLevel?.()?.name),!bot.entity.onGround,enchants,bot.entity.effects)
  }
  bot.digTime=digTime
  // Mineflayer injects its built-in plugins on the next turn after createBot.
  // Reapply after that injection so its default helper cannot overwrite the fix.
  bot.once('inject_allowed',()=>{bot.digTime=digTime})
}
module.exports={enchantments,comparisonBlock,installToolCompatibility}
