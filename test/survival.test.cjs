const {test}=require('node:test')
const assert=require('node:assert/strict')
const {fixture,Vec3,registry}=require('./helpers/survival-fixture.cjs')
const {parse}=require('../src/agents/agent.cjs')

test('survival and survey have simple commands',()=>{
  assert.equal(parse('Survive!').type,'survive');assert.equal(parse('look around').type,'scan')
})
function matureWheat(f,count) {
  for(let i=0;i<count;i++){const x=-16+(i%16),z=Math.floor(i/16);f.set('farmland',new Vec3(x,63,z));f.set('wheat',new Vec3(x,64,z),7)}
}
test('full empty-inventory starter run verifies recipes, iron, food and 128 wheat',async()=>{
  const f=fixture()
  for(let x=2;x<=6;x++)f.set('oak_log',new Vec3(x,64,0))
  for(let x=2;x<5;x++){f.set('stone',new Vec3(x,64,3));f.set('iron_ore',new Vec3(x,64,5))}
  f.set('melon',new Vec3(6,64,5));f.set('water',new Vec3(7,63,7))
  for(let x=3;x<7;x++){f.set('short_grass',new Vec3(x,64,9));f.set('dirt',new Vec3(x,63,7))}
  f.set('grass_block',new Vec3(0,63,2))
  matureWheat(f,128)
  await f.work.run()
  assert.equal(f.work.plan.status,'complete',JSON.stringify(f.work.plan.steps))
  assert.ok(f.crafted.includes('wooden_pickaxe'));assert.ok(f.crafted.includes('stone_pickaxe'));assert.ok(f.crafted.includes('wooden_hoe'))
  assert.equal(f.work.count('raw_iron'),3);assert.ok(f.work.count('melon_slice')>=4)
  assert.equal(f.tilled.length,4);assert.equal(f.work.plan.farm.length,4)
  for(const p of f.work.plan.farm){assert.equal(f.bot.blockAt(new Vec3(p.x,p.y,p.z)).name,'wheat');assert.ok(f.work.hydrated(new Vec3(p.x,p.y-1,p.z)))}
  assert.ok(f.work.count('wheat')>=128)
  assert.equal(f.bot.listenerCount('health'),0);assert.equal(f.bot._client.listenerCount('block_change'),0)
})
test('existing better tools skip unnecessary pickaxe crafting',async()=>{
  const f=fixture();f.add('iron_pickaxe');await f.work.wooden();await f.work.stone()
  assert.deepEqual(f.crafted,[]);assert.deepEqual(f.dug,[])
})
test('survival uses a non-Silk-Touch pickaxe for recipe ingredients',async()=>{
  const f=fixture();f.add('netherite_pickaxe').enchants=[{name:'silk_touch',lvl:1}];f.add('wooden_pickaxe');const p=new Vec3(2,64,0)
  assert.equal(f.work.pick('stone'),undefined)
  const original=f.bot.dig;let held
  f.bot.dig=async b=>{held=f.bot.heldItem.name;await original(b)}
  await f.work.harvest(f.set('stone',p));assert.equal(held,'wooden_pickaxe')
})
test('worn tools are replaced and gold does not qualify for iron',()=>{
  const f=fixture();const i=f.add('stone_pickaxe');i.durabilityUsed=registry.itemsByName.stone_pickaxe.maxDurability-2
  f.add('golden_pickaxe');assert.equal(f.work.pick('stone'),undefined)
})
test('crafting cannot announce success when inventory was not updated',async()=>{
  const f=fixture();f.add('oak_log');f.bot.craft=async()=>{}
  await assert.rejects(f.work.craft('oak_planks'),/not confirmed/)
})
test('missing iron marks only its step blocked and continues to food and farm',async()=>{
  const f=fixture();f.add('oak_planks',16);f.add('stone_pickaxe');f.add('bread',8)
  f.work.explore=async()=>false
  f.work.starterFarm=async()=>{f.work.plan.farm=[{x:1}];return 'Fixture farm completed'}
  await f.work.run()
  assert.equal(f.work.plan.steps[3].status,'blocked');assert.equal(f.work.plan.steps[4].status,'complete');assert.equal(f.work.plan.steps[5].status,'complete')
  assert.equal(f.agent.state.task.status,'partial')
})

test('completed iron is not gathered again and objective transitions stay in order',async()=>{
  const f=fixture(),events=[]
  f.add('oak_planks',16);f.add('stone_pickaxe');f.add('raw_iron',3);f.add('bread',8)
  f.agent.log=(event,message,level,details)=>events.push({event,message,...details})
  f.work.starterFarm=async()=>{assert.equal(f.work.plan.currentStep,'farm');return 'Existing farm verified'}
  await f.work.run()
  assert.deepEqual(events.filter(e=>e.event==='survival.objective').map(e=>e.objective),['wood','wooden','stone','iron','food','farm'])
  assert.equal(f.work.plan.steps[3].status,'complete')
  assert.equal(f.work.plan.currentStep,null)
  assert.deepEqual(f.dug,[])
})
test('gathering relies on inventory pickup rather than counting broken blocks',async()=>{
  const f=fixture();f.set('oak_log',new Vec3(2,64,0));f.work.explore=async()=>false
  const dig=f.bot.dig;f.bot.dig=async b=>{await dig(b);f.items.length=0}
  await assert.rejects(f.work.gather(['oak_log'],()=>f.work.count('oak_log')>=1,'logs'),/Need logs/)
  assert.equal(f.dug.length,1)
})

test('an unreachable tree is not retried once per log in its crown',async()=>{
  const f=fixture();let attempts=0
  for(let y=64;y<74;y++)f.set('oak_log',new Vec3(2,y,0))
  f.work.approach=async()=>{attempts++;throw Object.assign(new Error('No shore route'),{code:'NO_ROUTE'})}
  f.work.explore=async()=>false
  await assert.rejects(f.work.wood(),/Need/)
  assert.equal(attempts,1)
})
test('resource gathering does not dig a sealed ore or expose neighboring lava',()=>{
  const f=fixture(),p=new Vec3(3,60,3);const ore=f.set('iron_ore',p)
  assert.equal(f.work.safeTarget(ore),false)
  f.set('air',p.offset(1,0,0));f.set('lava',p.offset(-1,0,0));assert.equal(f.work.safeTarget(ore),false)
})
test('Stop during crafting settles without starting another recipe',async()=>{
  const f=fixture();f.add('oak_log',2);let finish
  f.bot.craft=()=>new Promise(r=>finish=r)
  const task=f.work.planks(8);await new Promise(setImmediate);f.work.cancel();finish()
  await assert.rejects(task,/Cancelled/);assert.deepEqual(f.crafted,[])
})
test('low hunger consumes food but protects four planting carrots',async()=>{
  const f=fixture();f.bot.food=10;f.add('carrot',4);await f.work.eat();assert.equal(f.work.count('carrot'),4)
  f.add('bread',3);await f.work.eat();assert.ok(f.bot.food>16);assert.equal(f.work.count('carrot'),4)
})
test('nearby threat pauses the routine before mining or crafting',async()=>{
  const f=fixture();f.bot.entities[2]={name:'creeper',position:new Vec3(1,64,0)}
  await f.work.run();assert.equal(f.work.plan.status,'blocked');assert.match(f.work.plan.decision,/creeper/);assert.deepEqual(f.dug,[]);assert.deepEqual(f.crafted,[])
})
test('changing to Creative prevents the next survival action',async()=>{
  const f=fixture();f.add('oak_log');f.bot.game.gameMode='creative'
  await assert.rejects(f.work.craft('oak_planks'),/left Survival mode/)
  assert.deepEqual(f.crafted,[])
})
test('cancellation during pre-till turn sends no later hoe activation',async()=>{
  const f=fixture();f.add('wooden_hoe');const p=new Vec3(3,63,2);f.set('water',p.offset(1,0,0));let finish
  f.bot.lookAt=()=>new Promise(r=>finish=r)
  const task=f.work.till(p,'wooden_hoe');await new Promise(setImmediate);f.work.cancel();finish()
  await assert.rejects(task,/Cancelled/);assert.equal(f.tilled.length,0)
})
test('starter farm rejects dry ground without tilling anything',async()=>{
  const f=fixture();f.add('wheat_seeds',4);f.add('wooden_hoe');f.work.explore=async()=>false
  for(let x=1;x<6;x++)f.set('dirt',new Vec3(x,63,3))
  await assert.rejects(f.work.starterFarm(),/water/);assert.equal(f.tilled.length,0)
})
test('a repeat run recognizes an existing four-crop irrigated farm',async()=>{
  const f=fixture();f.set('water',new Vec3(4,63,4));f.add('wheat',128)
  for(let x=1;x<=4;x++){f.set('farmland',new Vec3(x,63,3));f.set('wheat',new Vec3(x,64,3),0)}
  await f.work.starterFarm();assert.equal(f.work.plan.farm.length,4);assert.equal(f.tilled.length,0);assert.equal(f.placed.length,0)
})
test('an immature farm waits cancellably instead of exploring for ripe wheat',async()=>{
  const f=fixture();f.set('water',new Vec3(4,63,4));f.work.explore=async()=>false
  for(let x=1;x<=4;x++){f.set('farmland',new Vec3(x,63,3));f.set('wheat',new Vec3(x,64,3),0)}
  let waited=false,explored=false;f.work.explore=async()=>{explored=true;return false}
  f.work.pause=async ms=>{if(ms===20000){waited=true;f.work.cancel()}f.work.check()}
  await assert.rejects(f.work.starterFarm(),/Cancelled/);assert.equal(f.work.plan.farm.length,4);assert.equal(waited,true);assert.equal(explored,false);assert.equal(f.work.plan.waitingUntil,null)
})
test('the last step succeeds after harvesting 128 mature wheat',async()=>{
  const f=fixture();f.set('water',new Vec3(4,63,4));f.add('wheat_seeds',8)
  for(let x=1;x<=4;x++){f.set('farmland',new Vec3(x,63,3));f.set('wheat',new Vec3(x,64,3),0)}
  matureWheat(f,128)
  await f.work.starterFarm()
  assert.ok(f.work.count('wheat')>=128);assert.equal(f.work.plan.farm.length,4)
})
test('wheat objective expands available irrigated ground before waiting',async()=>{
  const f=fixture();f.add('wheat_seeds',8);f.add('wooden_hoe');f.set('water',new Vec3(0,63,0));f.set('dirt',new Vec3(1,63,1));f.set('short_grass',new Vec3(1,64,1))
  f.work.explore=async()=>{throw new Error('Should not wander')}
  f.work.pause=async ms=>{if(ms===20000)f.work.cancel();f.work.check()}
  await assert.rejects(f.work.collectWheat(128),/Cancelled/)
  assert.ok(f.tilled.some(p=>p.equals(new Vec3(1,63,1))));assert.equal(f.bot.blockAt(new Vec3(1,64,1)).name,'wheat');assert.match(f.work.plan.decision,/Waiting 20 seconds/)
})
