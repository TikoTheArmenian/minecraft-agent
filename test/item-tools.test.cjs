const {test}=require('node:test')
const assert=require('node:assert/strict')
const {fixture,registry,Vec3}=require('./helpers/survival-fixture.cjs')
const Item=require('prismarine-item')(registry)
const {enchantments,installToolCompatibility}=require('../src/item-tools.cjs')
const {chooseTool}=require('../src/work.cjs')
function component(name,entries) {
  const item=new Item(registry.itemsByName[name].id,1)
  item.componentMap.set('enchantments',{type:'enchantments',data:{enchantments:entries,showTooltip:true}})
  return item
}
test('actual 1.21 item components normalize to the list expected by mining',()=>{
  const f=fixture(),item=component('diamond_pickaxe',[{id:registry.enchantmentsByName.efficiency.id,level:5}])
  assert.equal(Array.isArray(item.enchants),false)
  assert.deepEqual(enchantments(item,f.bot),[{name:'efficiency',lvl:5}])
  assert.equal(Array.isArray(item.enchants),false,'Raw inventory components must remain unchanged')
  assert.deepEqual(enchantments(component('iron_pickaxe',[]),f.bot),[])
})
test('survival recognizes tools with component enchantments without throwing',async()=>{
  const f=fixture();f.items.push(component('iron_pickaxe',[]))
  assert.equal(f.work.pick('stone'),'iron_pickaxe')
  await f.work.wooden();await f.work.stone();assert.deepEqual(f.crafted,[])
})
test('server enchantment registry controls numeric IDs, including Silk Touch',()=>{
  const f=fixture();installToolCompatibility(f.bot)
  f.bot._client.emit('registry_data',{id:'minecraft:enchantment',entries:[{key:'minecraft:silk_touch'},{key:'minecraft:efficiency'}]})
  const item=component('netherite_pickaxe',[{id:0,level:1}]);f.items.push(item)
  assert.equal(f.work.withoutSilk(item),false);assert.equal(f.work.pick('stone'),undefined)
})
test('actual dig timing and tool selection both handle component Efficiency and plugin injection',()=>{
  const f=fixture();f.bot.entity.onGround=true
  f.bot.once('inject_allowed',()=>{f.bot.digTime=()=>{throw new Error('Old incompatible helper')}})
  installToolCompatibility(f.bot);f.bot.emit('inject_allowed')
  const iron=component('iron_pickaxe',[{id:registry.enchantmentsByName.efficiency.id,level:5}]),diamond=component('diamond_pickaxe',[])
  f.items.push(diamond,iron);const block=f.set('iron_ore',new Vec3(2,64,0))
  assert.equal(chooseTool(f.bot,block),iron)
  f.bot.heldItem=iron;const fast=f.bot.digTime(block)
  f.bot.heldItem=diamond;assert.ok(f.bot.digTime(block)>fast)
  assert.equal(block.material,registry.blocksByName.iron_ore.material)
})
