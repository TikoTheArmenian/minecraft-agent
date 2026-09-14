const test=require('node:test')
const assert=require('node:assert/strict')
const {fixture,Vec3,registry}=require('./helpers/survival-fixture.cjs')
const {WheatFarm}=require('../src/wheat-farm.cjs')
const {parse}=require('../src/agent.cjs')
function setup(){const f=fixture();f.work=new WheatFarm(f.agent,1);f.work.approach=async()=>f.work.check();f.work.pause=async()=>f.work.check();return f}
test('continuous command is separate from one-pass farming',()=>{assert.equal(parse('farm wheat forever').type,'wheatFarm');assert.equal(parse('farm wheat 16').type,'farm')})
test('harvest only ripe wheat and replant before proceeding',async()=>{
 const f=setup();f.add('wheat_seeds',2);f.set('farmland',new Vec3(1,63,0));f.set('wheat',new Vec3(1,64,0),7);f.set('farmland',new Vec3(2,63,0));f.set('wheat',new Vec3(2,64,0),3)
 await f.work.harvestWheat();assert.deepEqual(f.dug,['wheat']);assert.deepEqual(f.placed,['wheat']);assert.equal(f.bot.blockAt(new Vec3(1,64,0)).getProperties().age,0)
})
test('missing seed preserves mature crop',async()=>{const f=setup();f.set('farmland',new Vec3(1,63,0));f.set('wheat',new Vec3(1,64,0),7);await f.work.harvestWheat();assert.equal(f.dug.length,0)})
test('expansion fills former walking lanes while leaving dry ground untouched',async()=>{
 const f=setup();f.add('wheat_seeds',8);f.add('wooden_hoe');f.set('water',new Vec3(0,63,0));f.set('dirt',new Vec3(1,63,1));f.set('dirt',new Vec3(3,63,1));f.set('dirt',new Vec3(12,63,12));f.work.extendShore=async()=>{}
 await f.work.expand();assert.deepEqual(f.tilled.map(p=>p.toString()),[new Vec3(1,63,1).toString(),new Vec3(3,63,1).toString()]);assert.equal(f.work.count('wheat_seeds'),6)
})
test('shore expansion requires a separate permanent irrigation block',()=>{const f=setup(),p=new Vec3(1,63,1);f.set('water',p);assert.equal(f.work.irrigationRemains(p),false);f.set('water',new Vec3(0,63,1));assert.equal(f.work.irrigationRemains(p),true)})
test('chest deposits confirmed surplus and retains food and planting reserves',async()=>{
 const f=setup();f.add('wheat',64);f.add('wheat_seeds',64);let closed=false;const slots=Array(27).fill(null)
 const win={slots,inventoryStart:27,containerItems:()=>slots.filter(Boolean),close(){closed=true},async deposit(type,meta,count){const item=f.items.find(i=>i.type===type);item.count-=count;slots[slots.findIndex(i=>!i)]={type,count}}}
 f.bot.openContainer=async()=>win;await f.work.deposit(f.set('chest',new Vec3(1,64,1)))
 assert.equal(f.work.count('wheat'),12);assert.equal(f.work.count('wheat_seeds'),32);assert.equal(f.work.plan.stored,52);assert.equal(closed,true);assert.equal(f.work.plan.chests.length,1)
})
test('failed chest transfer never reports stored wheat and closes window',async()=>{
 const f=setup();f.add('wheat',64);let closed=false;f.bot.openContainer=async()=>({slots:Array(27).fill(null),inventoryStart:27,containerItems:()=>[],deposit:async()=>{},close(){closed=true}})
 await assert.rejects(f.work.deposit(f.set('chest',new Vec3(1,64,1))),/not fully confirmed/);assert.equal(f.work.plan.stored,0);assert.equal(closed,true)
})
test('continuous loop repeats and Stop cancels growth wait',async()=>{
 const f=setup();let cycles=0;f.work.cycle=async()=>{cycles++};f.work.pause=async()=>{if(cycles===2)f.work.cancel();f.work.check()}
 await f.work.run();assert.equal(cycles,2);assert.equal(f.work.plan.status,'cancelled');assert.equal(f.work.task.status,'cancelled')
})
test('crafts a chest from planks and places it on clear ground',async()=>{
 const f=setup();f.add('oak_planks',8);f.set('crafting_table',new Vec3(1,64,0));f.set('dirt',new Vec3(2,63,1))
 const chest=await f.work.createStorage();assert.equal(chest.name,'chest');assert.ok(f.crafted.includes('chest'));assert.equal(f.work.count('oak_planks'),0);assert.equal(f.work.plan.chests.length,1)
})
test('late container open closes if Stop arrives while opening',async()=>{
 const f=setup();let closed=false;f.bot.openContainer=async()=>{f.work.cancel();return {close(){closed=true}}}
 await assert.rejects(f.work.deposit(f.set('chest',new Vec3(1,64,1))));assert.equal(closed,true)
})
test('FARMER has direct commands and no overall wheat quota or time limit',()=>{
 const f=setup();assert.equal(parse('FARMER').type,'wheatFarm');assert.equal(parse('start farmer').type,'wheatFarm');assert.equal(f.work.deadline,Infinity);assert.equal(f.work.task.deadlineAt,null);assert.equal(f.work.task.skill,'FARMER')
})
test('productive farmer passes continue promptly instead of waiting for growth',async()=>{
 const f=setup();let delay;f.work.cycle=async()=>{f.work.counts.planted++};f.work.pause=async ms=>{delay=ms;f.work.cancel();f.work.check()}
 await f.work.run();assert.equal(delay,1000)
})
test('shore expansion connects across walking lanes and attaches to farmland',async()=>{
 const f=setup();f.add('dirt',12);f.set('farmland',new Vec3(0,63,1));f.set('water',new Vec3(0,63,0))
 for(let x=1;x<=3;x++)f.set('water',new Vec3(x,63,1))
 f.bot._placeBlockWithOptions=async(ref,face)=>{const pos=ref.position.plus(face),b=f.set('dirt',pos);f.bot.heldItem.count--;f.bot._client.emit('block_change',{location:pos,type:b.stateId})}
 await f.work.extendShore();assert.equal(f.bot.blockAt(new Vec3(3,63,1)).name,'dirt');assert.equal(f.bot.blockAt(new Vec3(0,63,0)).name,'water');assert.ok(f.work.plan.groundAdded>=3)
})
test('expansion cannot remove the only irrigation for an existing distant plot',()=>{
 const f=setup(),p=new Vec3(0,63,0);f.set('water',p);f.set('water',new Vec3(-4,63,0));f.set('farmland',new Vec3(4,63,0))
 assert.equal(f.work.irrigationRemains(p),true);assert.equal(f.work.irrigationRemains(p,true),false)
})
test('low air surfaces and resumes without cancelling the FARMER controller',async()=>{
 const f=setup(),{Travel}=require('../src/travel.cjs'),original=Travel.prototype.surface
 f.bot.entity.isInWater=true;f.bot.oxygenLevel=5;let surfaced=0,cycles=0
 Travel.prototype.surface=async function(){surfaced++;f.bot.oxygenLevel=20;f.bot.entity.isInWater=false}
 f.work.cycle=async()=>{cycles++;f.work.cancel();f.work.check()}
 try{await f.work.run();assert.equal(surfaced,1);assert.equal(cycles,1);assert.equal(f.work.needsAir,false);assert.equal(f.work.plan.status,'cancelled')}finally{Travel.prototype.surface=original}
})
test('Stop still cancels an air recovery before farming can resume',async()=>{
 const f=setup(),{Travel}=require('../src/travel.cjs'),original=Travel.prototype.surface
 f.bot.entity.isInWater=true;f.bot.oxygenLevel=5;f.work.requestAir()
 Travel.prototype.surface=async()=>{f.work.cancel();f.work.check()}
 try{await assert.rejects(f.work.recoverAir(),/Cancelled/);assert.equal(f.work.recoveringAir,false)}finally{Travel.prototype.surface=original}
})
test('farm quarry protects lanes, underlying dirt, and other crop patches',()=>{
 const f=setup(),{layout}=require('../src/farm-layout.cjs');f.set('farmland',new Vec3(1,63,1));layout(f.work)
 assert.equal(f.work.safeTarget(f.set('dirt',new Vec3(3,63,1))),false)
 assert.equal(f.work.safeTarget(f.set('dirt',new Vec3(3,62,1))),false)
 assert.equal(f.work.safeTarget(f.set('dirt',new Vec3(31,63,1))),true)
 f.set('farmland',new Vec3(31,64,1));assert.equal(f.work.safeTarget(f.bot.blockAt(new Vec3(31,63,1))),false)
})
test('expansion uses the established level and repairs holes ahead of shoreline',()=>{
 const f=setup(),{layout,groundTargets}=require('../src/farm-layout.cjs');f.set('farmland',new Vec3(1,63,1));f.set('farmland',new Vec3(2,63,1));f.set('farmland',new Vec3(1,65,2))
 assert.equal(layout(f.work).y,63)
 f.set('air',new Vec3(3,63,1));f.set('water',new Vec3(0,63,0));f.set('water',new Vec3(2,63,0))
 const targets=groundTargets(f.work);assert.equal(targets[0].name,'air');assert.ok(targets.every(b=>b.position.y===63))
})
test('seed shortage still allows constructing the next level plots',async()=>{
 const f=setup();let built=false;f.work.extendShore=async()=>{built=true;f.work.counts.groundAdded=1};f.work.gather=async()=>{}
 await f.work.expand();assert.equal(built,true);assert.match(f.work.plan.expansion,/seeds/)
})
test('double-height grass targets its base and ignores already removed cells',async()=>{
 const f=setup(),base=f.set('tall_grass',new Vec3(2,64,1)),top=f.set('tall_grass',new Vec3(2,65,1));top.getProperties=()=>({half:'upper'});base.getProperties=()=>({half:'lower'})
 let target;f.work.dig=async p=>{target=p;f.set('air',base.position);f.set('air',top.position)}
 assert.equal(await f.work.harvest(top),true);assert.ok(target.equals(base.position))
 assert.equal(await f.work.harvest(top),false)
})
test('repairs an air gap with dirt without digging adjacent walking lanes',async()=>{
 const f=setup();f.add('dirt',12);f.set('farmland',new Vec3(1,63,1));const gap=new Vec3(2,63,1);f.set('air',gap)
 f.bot._placeBlockWithOptions=async(ref,face)=>{const p=ref.position.plus(face),b=f.set('dirt',p);f.bot.heldItem.count--;f.bot._client.emit('block_change',{location:p,type:b.stateId})}
 await f.work.extendShore();assert.equal(f.bot.blockAt(gap).name,'dirt');assert.equal(f.dug.length,0);assert.equal(f.work.counts.groundAdded,1)
})
test('refills seeds from storage before considering grass, remembering actual remaining contents',async()=>{
 const f=setup();f.set('chest',new Vec3(2,64,1));let closed=false,stock=50
 f.bot.openContainer=async()=>({containerItems:()=>[{type:registry.itemsByName.wheat_seeds.id,name:'wheat_seeds',count:stock}],withdraw:async(type,meta,count)=>{stock-=count;f.add('wheat_seeds',count)},close(){closed=true}})
 f.work.extendShore=async()=>{};f.add('wooden_hoe');f.work.gather=async()=>assert.fail('must use chest seeds before gathering')
 await f.work.expand();assert.equal(f.work.count('wheat_seeds'),32);assert.equal(stock,18);assert.equal(closed,true)
 assert.equal(f.work.plan.chestContents['(2, 64, 1)'].items[0].count,18)
})
test('empty chests are cooled down but do not prevent fallback seed gathering',async()=>{
 const f=setup();f.set('chest',new Vec3(2,64,1));let opened=0,gathered=0
 f.bot.openContainer=async()=>{opened++;return {containerItems:()=>[],close(){}}};f.work.extendShore=async()=>{};f.work.gather=async()=>{gathered++}
 await f.work.expand();await f.work.expand();assert.equal(opened,1);assert.equal(gathered,2)
})
test('unconfirmed seed withdrawals are not counted and always close storage',async()=>{
 const f=setup();f.set('chest',new Vec3(2,64,1));let closed=false
 f.bot.openContainer=async()=>({containerItems:()=>[{type:registry.itemsByName.wheat_seeds.id,count:20}],withdraw:async()=>{},close(){closed=true}})
 await require('../src/farm-storage.cjs').restockSeeds(f.work)
 assert.equal(f.work.counts.seedsRetrieved,undefined);assert.equal(closed,true);assert.match(f.work.plan.blocker,/not fully confirmed/)
})
test('retrieves construction stock from chests without withdrawing seeds',async()=>{
 const f=setup();f.set('chest',new Vec3(2,64,1));let dirt=24
 f.bot.openContainer=async()=>({containerItems:()=>[{type:registry.itemsByName.dirt.id,count:dirt}],withdraw:async(type,meta,count)=>{assert.equal(type,registry.itemsByName.dirt.id);dirt-=count;f.add('dirt',count)},close(){}})
 await require('../src/farm-storage.cjs').restockBuilding(f.work)
 assert.equal(f.work.count('dirt'),24);assert.equal(dirt,0)
})
test('expansion does not spend the last eight access blocks',async()=>{
 const f=setup();f.add('dirt',8);f.set('farmland',new Vec3(1,63,1));f.set('air',new Vec3(2,63,1));f.work.gather=async()=>{}
 await f.work.extendShore();assert.equal(f.work.count('dirt'),8);assert.equal(f.work.counts.groundAdded,undefined)
})
test('harvest stays with neighboring ripe wheat instead of alternating across the starting point',async()=>{
 const f=setup();f.add('wheat_seeds',4);const order=[]
 for(const x of [1,-2,3,-4]){f.set('farmland',new Vec3(x,63,0));f.set('wheat',new Vec3(x,64,0),7).stateId+=7}
 const dig=f.work.dig.bind(f.work);f.work.dig=async(p,...args)=>{order.push(p.x);await dig(p,...args)}
 await f.work.harvestWheat();assert.deepEqual(order,[1,3,-2,-4])
})
test('wood trips collect a batch rather than stopping at the first recipe ingredient',async()=>{
 const f=setup();f.work.approach=async p=>{f.work.check();f.bot.entity.position=p.offset(1,0,0)};for(let x=1;x<=16;x++)f.set('oak_log',new Vec3(x,64,0))
 await f.work.gather(['oak_log'],()=>f.work.count('oak_log')>=1,'wood',2,false)
 assert.equal(f.work.count('oak_log'),16)
})
test('a small wood patch still completes the original need without exploring just for surplus',async()=>{
 const f=setup();f.set('oak_log',new Vec3(1,64,0));f.work.explore=async()=>assert.fail('do not travel farther for bonus stock')
 await f.work.gather(['oak_log'],()=>f.work.count('oak_log')>=1,'wood',2,true)
 assert.equal(f.work.count('oak_log'),1)
})
test('a modest harvest does not trigger a chest trip and harvesting precedes supply work',async()=>{
 const f=setup(),events=[];f.add('wheat',20);f.add('wheat_seeds',20);f.add('dirt',16);f.work.nextTorchAttempt=Infinity
 f.work.harvestWheat=async()=>events.push('harvest');f.work.expand=async()=>events.push('expand');f.work.store=async()=>events.push('store')
 await f.work.cycle();assert.deepEqual(events,['harvest','expand'])
})
