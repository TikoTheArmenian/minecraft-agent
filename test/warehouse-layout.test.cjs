const test=require('node:test'), assert=require('node:assert/strict'),{EventEmitter}=require('node:events')
const {Vec3}=require('vec3'),registry=require('minecraft-data')('1.21.1')
const layout=require('../src/storage/warehouse-layout.cjs'),storage=require('../src/storage/service.cjs'),crafting=require('../src/storage/crafting.cjs')
const hub={x:0,y:64,z:0}
test('bays are aligned, inside the hub, with consistent label positions and clear aisles',()=>{
 const bays=layout.bays(hub);assert.equal(bays.length,9)
 for(const b of bays){assert.equal(b.facing,'south');assert.equal(b.right.x,b.left.x+1);assert.equal(b.sign.z,b.left.z+1);assert.equal(b.left.y,64);assert(b.left.distanceTo(new Vec3(0,64,0))<=8)}
 for(const a of bays)for(const b of bays)if(a!==b)assert(a.left.x!==b.left.x||Math.abs(a.left.z-b.left.z)>=4)
})
function fixture(t){const blocks=new Map(),memory={},client=new EventEmitter();let n=2,placements=0
 const bot={registry,_client:client,entity:{position:new Vec3(0,64,0)},inventory:{items:()=>[{name:'chest',count:n}]},setControlState(){},blockAt(p){return blocks.get(p.toString())||{name:p.y===63?'stone':'air',boundingBox:p.y===63?'block':'empty',position:p,getProperties:()=>({})}},async placeBlock(ref,face){const p=ref.position.plus(face);assert(bot.entity.position.z>p.z);assert(n>0);n--;placements++;blocks.set(p.toString(),{name:'chest',position:p,getProperties:()=>({facing:'south',type:'single'})});const neighbor=bot.blockAt(p.offset(-1,0,0));if(neighbor.name==='chest'){neighbor.getProperties=()=>({facing:'south',type:'right'});blocks.get(p.toString()).getProperties=()=>({facing:'south',type:'left'})}client.emit('block_change',{location:p,type:registry.blocksByName.chest.minStateId})}}
 const w={bot,agent:{coordination:{recall:()=>memory,save(){}}},controller:new AbortController(),check(){},equip:async()=>{},timed:fn=>fn(),travel:async goal=>{bot.entity.position=new Vec3(goal.x+.5,goal.y,goal.z+.5)}}
 t.mock.method(storage,'list',async()=>({containers:[]}));t.mock.method(storage,'manage',async(w,p)=>assert.equal(storage.identity(bot,bot.blockAt(p)).capacity,54))
 return {w,blocks,placements:()=>placements}
}
test('registers only a confirmed joined double chest and does not rebuild completed bays',async t=>{const f=fixture(t);const bay=await layout.build(f.w,hub,'food');assert(layout.validPair(f.w.bot,bay));assert.equal(f.placements(),2);assert.deepEqual(layout.pendingPositions(f.w),[]);assert.equal(f.w.agent.coordination.recall().warehouse['0,64,0'].completed[bay.id].category,'food')})
test('partial pair retains its pending cells and refuses to join a registered single',async t=>{const f=fixture(t),bay=layout.bays(hub)[0];f.w.agent.coordination.recall().warehouse={'0,64,0':{pending:{id:bay.id,category:'food'},completed:{}}};t.mock.method(storage,'list',async()=>({containers:[{capacity:27,blocks:[bay.left],id:bay.id}]}));await assert.rejects(layout.build(f.w,hub,'food'),/registered chest overlaps/);assert.equal(f.placements(),0);assert.equal(layout.pendingPositions(f.w).length,2)})
test('armor recipes are supported and use the actual iron requirement',()=>{const Recipe=require('prismarine-recipe')(registry).Recipe;const bot={registry,recipesAll:id=>Recipe.find(id,null)};assert(crafting.allowed('iron_chestplate'));assert.throws(()=>crafting.planRecipes(bot,'iron_chestplate',1,{iron_ingot:7},{}),/Missing materials/);assert.equal(crafting.planRecipes(bot,'iron_chestplate',1,{iron_ingot:8},{}).steps.at(-1).name,'iron_chestplate')})
test('armor does not spend material while any shared tool target is missing',async t=>{const steward=require('../src/storage/steward.cjs');t.mock.method(storage,'list',async()=>({containers:[]}));t.mock.method(crafting,'execute',()=>assert.fail('armor must wait'));await steward.armor({bot:{inventory:{items:()=>[]}},progress(){}},hub)})
test('a partial pair resumes its second half without placing the first chest again',async t=>{
 const f=fixture(t),place=f.w.bot.placeBlock
 let calls=0
 f.w.bot.placeBlock=async(...args)=>{if(++calls===2)throw new Error('interrupted before second placement');return place(...args)}
 await assert.rejects(layout.build(f.w,hub,'food'),/interrupted/)
 assert.equal(layout.pendingPositions(f.w).length,2)
 const bay=await layout.build(f.w,hub,'food')
 assert(layout.validPair(f.w.bot,bay));assert.equal(f.placements(),2)
})
test('verification waits for the partner chest block update',async t=>{
 const f=fixture(t),place=f.w.bot.placeBlock
 f.w.pause=()=>new Promise(r=>setTimeout(r,2))
 f.w.bot.placeBlock=async(...args)=>{await place(...args);if(f.placements()===2){const b=f.w.bot.blockAt(layout.bays(hub)[0].left),correct=b.getProperties;b.getProperties=()=>({facing:'south',type:'single'});setTimeout(()=>{b.getProperties=correct},5)}}
 const bay=await layout.build(f.w,hub,'food');assert(layout.validPair(f.w.bot,bay))
})
