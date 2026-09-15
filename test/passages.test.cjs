const {test}=require('node:test')
const assert=require('node:assert/strict')
const {fixture,Vec3,registry}=require('./helpers/travel-fixture.cjs')
const {Travel,TravelMovements}=require('../src/navigation/travel.cjs')
const {installPassages}=require('../src/navigation/passages.cjs')
const {goals}=require('mineflayer-pathfinder')
const Move=require('mineflayer-pathfinder/lib/move')
const Block=require('prismarine-block')(registry)
function setup(){
 const h=fixture({stock:0})
 h.bot.entity.position=new Vec3(.5,64,.5)
 h.bot.blockAt=p=>{p=p.floored();if(p.x< -3||p.x>8||Math.abs(p.z)>2||p.y<60||p.y>70)return null;return h.changes.get(`${p.x},${p.y},${p.z}`)||h.make(p.y<=63?'stone':'air',p)}
 h.set=(name,p,props={})=>{const b=Block.fromProperties(registry.blocksByName[name].id,{waterlogged:false,powered:false,open:false,facing:'east',half:'lower',hinge:'left',north:false,east:false,south:false,west:false,in_wall:false,...props},0);b.position=p.clone();h.changes.set(`${p.x},${p.y},${p.z}`,b);return b}
 return h
}
for(const name of ['oak_door','copper_door','oak_fence_gate'])test(`real physics opens and crosses ${name} without digging or building`,async()=>{
 const h=setup(),p=new Vec3(2,64,0)
 h.set(name,p)
 if(name.endsWith('_door'))h.set(name,p.offset(0,1,0),{half:'upper'})
 for(let x=-2;x<=6;x++)for(const z of [-1,1])for(let y=64;y<=66;y++)h.set('stone',new Vec3(x,y,z))
 let uses=0
 h.bot.activateBlock=async()=>assert.fail('must use confirmed passage interaction')
 h.bot._client.write=(packet,_data)=>{
   assert.equal(packet,'block_place');uses++
   const lower=h.set(name,p,{open:true});h.bot._client.emit('block_change',{location:p,type:lower.stateId})
   if(name.endsWith('_door')){const upper=h.set(name,p.offset(0,1,0),{open:true,half:'upper'});h.bot._client.emit('block_change',{location:upper.position,type:upper.stateId})}
 }
 installPassages(h.bot)
 const goal=new goals.GoalBlock(4,64,0)
 await h.simulate(new Travel(h.work).go(goal),1500)
 assert.equal(goal.isEnd(h.bot.entity.position.floored()),true)
 assert.equal(uses,1);assert.equal(h.placements.length,0)
})
test('closed iron doors cannot be hand-opened, but an already-open iron door is usable',()=>{
 const h=setup(),p=new Vec3(1,64,0),m=new TravelMovements(h.bot)
 h.set('iron_door',p);h.set('iron_door',p.offset(0,1,0),{half:'upper'})
 const before=[];m.getMoveForward(new Move(0,64,0,0,0),{x:1,z:0},before);assert.equal(before.length,0)
 h.set('iron_door',p,{open:true});h.set('iron_door',p.offset(0,1,0),{half:'upper',open:true})
 const after=[];m.getMoveForward(new Move(0,64,0,0,0),{x:1,z:0},after);assert.equal(after.length,1);assert.equal(after[0].toPlace.length,0)
})
test('fence height prevents a ground-level jump and preserves barriers even with digging enabled',()=>{
 const h=setup(),m=new TravelMovements(h.bot),p=new Vec3(1,64,0)
 h.set('oak_fence',p);m.canDig=true
 assert.equal(m.safeToBreak(h.bot.blockAt(p)),false)
 const next=[];m.getMoveJumpUp(new Move(0,64,0,0,0),{x:1,z:0},next)
 assert.equal(next.length,0)
})
test('real physics walks along fence tops reached from a raised block',async()=>{
 const h=setup();h.set('stone',new Vec3(0,64,0));h.bot.entity.position=new Vec3(.5,65,.5)
 for(let x=1;x<=3;x++)h.set('oak_fence',new Vec3(x,64,0),{east:x<3,west:true})
 const goal=new goals.GoalBlock(3,65,0)
 await h.simulate(new Travel(h.work).go(goal),1500)
 assert.ok(Math.abs(h.bot.entity.position.y-65.5)<.05)
 assert.equal(goal.isEnd(h.bot.entity.position.floored()),true)
})
test('low ceiling over fence tops is rejected at the actual 1.5-block fence height',()=>{
 const h=setup(),m=new TravelMovements(h.bot)
 h.set('stone',new Vec3(0,64,0));h.set('oak_fence',new Vec3(1,64,0));h.set('stone',new Vec3(1,67,0))
 assert.equal(m.getNeighbors(new Move(0,65,0,0,0)).some(n=>n.x===1&&n.z===0&&n.y===65),false)
})
test('Stop during the turn prevents a delayed door interaction',async()=>{
 const h=setup(),p=new Vec3(1,64,0);h.set('oak_fence_gate',p)
 let finishLook,packets=0
 h.bot.activateBlock=async()=>{};h.bot.lookAt=()=>new Promise(r=>finishLook=r);h.bot._client.write=()=>packets++
 installPassages(h.bot);h.bot.pathfinder.setGoal(new goals.GoalBlock(3,64,0))
 const opening=h.bot.activateBlock(h.bot.blockAt(p));h.bot.pathfinder.setGoal(null);finishLook()
 await assert.rejects(opening,/cancelled/);assert.equal(packets,0)
})

test('navigation never toggles an already-open gate closed',async()=>{
 const h=setup(),p=new Vec3(1,64,0);h.set('oak_fence_gate',p,{open:true})
 h.bot.activateBlock=async()=>assert.fail('unexpected fallback');h.bot._client.write=()=>assert.fail('must not toggle an open gate')
 installPassages(h.bot);h.bot.pathfinder.setGoal(new goals.GoalBlock(3,64,0))
 await h.bot.activateBlock(h.bot.blockAt(p));h.bot.pathfinder.setGoal(null)
})
test('door opening waits for server confirmation of both halves',async()=>{
 const h=setup(),p=new Vec3(1,64,0);h.set('oak_door',p);h.set('oak_door',p.offset(0,1,0),{half:'upper'})
 h.bot.activateBlock=async()=>{}
 h.bot._client.write=()=>{const b=h.set('oak_door',p,{open:true});h.bot._client.emit('block_change',{location:p,type:b.stateId})}
 installPassages(h.bot);h.bot.pathfinder.setGoal(new goals.GoalBlock(3,64,0))
 let finished=false
 const opening=h.bot.activateBlock(h.bot.blockAt(p)).then(()=>finished=true)
 await new Promise(resolve=>setImmediate(resolve));assert.equal(finished,false)
 const upper=h.set('oak_door',p.offset(0,1,0),{half:'upper',open:true})
 h.bot._client.emit('block_change',{location:upper.position,type:upper.stateId})
 await opening;assert.equal(finished,true);h.bot.pathfinder.setGoal(null)
})
