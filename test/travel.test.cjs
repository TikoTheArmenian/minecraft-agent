const { test }=require('node:test')
const assert=require('node:assert/strict')
const { goals }=require('mineflayer-pathfinder')
const Move=require('mineflayer-pathfinder/lib/move')
const { Travel }=require('../src/navigation/travel.cjs')
const { fixture,Vec3 }=require('./helpers/travel-fixture.cjs')
const { BlockApproachGoal,canView }=require('../src/navigation/block-approach.cjs')

test('movement allows surface water entries and exits, but bounds drops and can walk through dense farmland',()=>{
  const {bot,changes,make}=fixture({bank:62})
  const moves=bot.pathfinder.movements
  assert.equal(moves.canDig,false)
  assert.equal(moves.countScaffoldingItems(),0)
  assert.equal(moves.getLandingBlock(new Move(0,66,0,0,0),{x:1,z:0}).name,'water')
  assert.equal(moves.getLandingBlock(new Move(0,70,0,0,0),{x:1,z:0}),null)
  const neighbors=[]
  moves.getMoveJumpUp(new Move(4,62,0,0,0),{x:1,z:0},neighbors)
  assert.ok(neighbors.some(n=>n.x===5 && n.y===63))
  changes.set('5,62,0',make('farmland',new Vec3(5,62,0)))
  assert.equal(moves.exclusionStep(bot.blockAt(new Vec3(5,63,0))),0)
  assert.equal(moves.getLandingBlock(new Move(4,65,0,0,0),{x:1,z:0}),null)
})

for(const [bank,blocks] of [[62,0],[63,1],[64,3]]) {
  test(`real physics swims off a platform and climbs bank ${bank} using ${blocks} blocks`,async()=>{
    const {bot,work,placements,logs,simulate}=fixture({bank})
    const goal=new goals.GoalBlock(8,bank+1,0)
    await simulate(work.travel(goal,'Cross the water'))
    assert.ok(goal.isEnd(bot.entity.position.floored()))
    assert.equal(placements.length,blocks)
    assert.ok(logs.some(l=>l.event==='travel.swimming'))
    assert.equal(bot.inventory.items()[0]?.count || 0,8-blocks)
    assert.equal(bot.listenerCount('physicsTick'),1) // Only pathfinder's own listener remains.
  })
}

test('shore planner requires ordinary building stock and does not place useless steps',async()=>{
  const {bot,work,items,placements,changes,make}=fixture({stock:0})
  items.push({name:'diamond_block',count:64})
  const travel=new Travel(work)
  await assert.rejects(travel.shorePlan(new goals.GoalBlock(8,64,0)),/needs dirt, cobblestone/)
  items.push({name:'cobblestone',count:8})
  // The destination is inside an unbreakable block even with shoreline access.
  changes.set('8,64,0',make('bedrock',new Vec3(8,64,0)))
  assert.equal(await travel.shorePlan(new goals.GoalBlock(8,64,0)),null)
  assert.equal(placements.length,0)
  assert.equal(bot.blockAt(new Vec3(4,62,0)).name,'water')
})

test('Stop while equipping a shore block prevents a late placement',async()=>{
  const {bot,work,agent,placements}=fixture()
  bot.entity.position=new Vec3(3.5,62,.5)
  let finish
  bot.equip=()=>new Promise(r=>{finish=()=>{bot.heldItem=bot.inventory.items()[0];r()}})
  const pending=new Travel(work).place({pos:new Vec3(4,62,0),ref:new Vec3(5,62,0),face:new Vec3(-1,0,0)})
  await new Promise(setImmediate)
  work.cancel();agent.nav++;finish()
  await assert.rejects(pending,/Cancelled/)
  assert.equal(placements.length,0)
})

test('shore placements reject occupied cells and changed terrain',async()=>{
  const {bot,work,placements,changes,make}=fixture()
  bot.entity.position=new Vec3(3.5,62,.5)
  const step={pos:new Vec3(4,62,0),ref:new Vec3(5,62,0),face:new Vec3(-1,0,0)}
  bot.entities[2]={position:new Vec3(4.5,62,.5),width:.6,height:1.8}
  await assert.rejects(new Travel(work).place(step),/occupying/)
  delete bot.entities[2]
  changes.set('4,62,0',make('chest',step.pos))
  await assert.rejects(new Travel(work).place(step),/changed/)
  assert.equal(placements.length,0)
})

test('block approaches see shape-free grass and crops, while rejecting an obstructing wall',()=>{
  const {bot,changes,make}=fixture({bank:62})
  bot.entity.position=new Vec3(5.5,63,.5)
  for(const name of ['short_grass','wheat','iron_ore']) {
    const pos=new Vec3(7,63,0)
    changes.set('7,63,0',make(name,pos))
    const goal=new BlockApproachGoal(bot,pos)
    assert.ok(goal.isEnd(bot.entity.position.floored()),name)
    assert.ok(canView(bot,pos),name)
    changes.set('6,64,0',make('stone',new Vec3(6,64,0)))
    changes.set('6,63,0',make('stone',new Vec3(6,63,0)))
    assert.equal(goal.isEnd(bot.entity.position.floored()),false)
    assert.equal(canView(bot,pos),false)
    changes.delete('6,64,0');changes.delete('6,63,0')
  }
})

test('a locally changed step without a server packet is not counted as placed',async()=>{
  const {bot,work,changes,make}=fixture()
  bot.entity.position=new Vec3(3.5,62,.5)
  bot._placeBlockWithOptions=async(ref,face)=>{const pos=ref.position.plus(face);changes.set(`${pos.x},${pos.y},${pos.z}`,make('cobblestone',pos))}
  const timed=work.timed.bind(work)
  work.timed=(fn,ms,label)=>timed(fn,label.startsWith('Confirm shore')?20:ms,label)
  await assert.rejects(new Travel(work).place({pos:new Vec3(4,62,0),ref:new Vec3(5,62,0),face:new Vec3(-1,0,0)}),/timed out/)
  assert.equal(work.counts.travelBlocks || 0,0)
  assert.equal(bot._client.listenerCount('block_change'),0)
})

test('a swimmer surfaces before path search rather than building an unnecessary stair',async()=>{
  const {bot,work,placements,logs,simulate}=fixture({bank:62})
  bot.entity.position=new Vec3(2.5,61,.5);bot.entity.isInWater=true;bot.entity.onGround=false
  await simulate(work.travel(new goals.GoalBlock(8,63,0),'Leave the water'))
  assert.ok(logs.some(l=>l.event==='travel.surfacing'))
  assert.equal(placements.length,0)
  assert.equal(bot.pathfinder.goal,null)
})

test('a route starting just above the water can settle onto the surface and swim',async()=>{
  const {bot,work,placements,simulate}=fixture({bank:62})
  bot.entity.position=new Vec3(2.5,63.1,.5);bot.entity.onGround=false
  await simulate(work.travel(new goals.GoalBlock(8,63,0),'Continue after bobbing above water'))
  assert.equal(placements.length,0)
  assert.equal(bot.entity.position.floored().x,8)
})

test('a failed route is retired before another objective can run',async()=>{
  const {bot,work}=fixture()
  bot.pathfinder.goto=async goal=>{bot.pathfinder.setGoal(goal);throw Object.assign(new Error('No route'),{name:'NoPath'})}
  const travel=new Travel(work);travel.shorePlan=async()=>null
  await assert.rejects(travel.go(new goals.GoalBlock(8,64,0)),/No walking/)
  assert.equal(bot.pathfinder.goal,null)
  assert.ok(Object.values(bot.controlState).every(v=>v===false))
  assert.equal(bot.listenerCount('path_update'),0)
})

test('a stationary route is cleared and retried instead of hanging until the task timeout',async()=>{
  const {bot,work,logs,simulate}=fixture()
  const normalGoto=bot.pathfinder.goto;let calls=0
  const physics=bot.physics.simulatePlayer
  bot.physics.simulatePlayer=(state,world)=>calls===1?state:physics(state,world)
  bot.pathfinder.goto=goal=>{
    if(++calls>1)return normalGoto(goal)
    bot.pathfinder.setGoal(goal)
    return new Promise((resolve,reject)=>{
      const changed=next=>{if(next!==goal){bot.off('goal_updated',changed);reject(new Error('Old route cleared'))}}
      bot.on('goal_updated',changed)
    })
  }
  await simulate(work.travel(new goals.GoalBlock(-3,66,0),'Walk on the platform'),7000)
  assert.equal(calls,2)
  assert.ok(logs.some(l=>l.event==='travel.recovering'))
  const events=work.task.travel.events.filter(e=>e.reason==='no_progress')
  assert.deepEqual(events.map(e=>[e.type,e.attempt]),[['stall',1],['retry',2]])
  assert.ok(events[0].idleMs>4500)
  assert.equal(events[1].maxAttempts,3)
  assert.ok(events.every(e=>Number.isFinite(e.at) && Number.isFinite(e.position.x)))
  assert.equal(bot.pathfinder.goal,null)
})

test('mining approaches do not end standing on ore or floating in water',()=>{
  const {bot,changes,make}=fixture({bank:63})
  const ore=new Vec3(5,63,0);changes.set('5,63,0',make('iron_ore',ore))
  const goal=new BlockApproachGoal(bot,ore)
  assert.equal(goal.isEnd(new Vec3(5,64,0)),false)
  assert.equal(goal.isEnd(new Vec3(4,62,0)),false)
  assert.equal(goal.isEnd(new Vec3(6,64,0)),true)
})

test('a swimmer underneath a solid overhang escapes sideways before surfacing',async()=>{
  const {bot,work,changes,make,simulate,logs}=fixture({bank:62})
  for(let x=1;x<=3;x++)for(let z=-2;z<=2;z++){const p=new Vec3(x,63,z);changes.set(`${x},63,${z}`,make('stone',p))}
  bot.entity.position=new Vec3(2.5,60,.5);bot.entity.onGround=false;bot.entity.isInWater=true
  await simulate(work.travel(new goals.GoalBlock(8,63,0),'Escape the overhang'))
  assert.equal(bot.entity.position.floored().x,8)
  assert.ok(logs.some(l=>l.message.includes('sideways')))
})

test('empty partial paths do not announce arrival while A* is still searching',async()=>{
  const {bot}=fixture();let finished=false
  const goal=new goals.GoalBlock(8,64,0)
  const run=bot.pathfinder.goto(goal);run.then(()=>{finished=true},()=>{finished=true})
  bot.emit('path_update',{status:'partial',path:[]})
  await new Promise(r=>setTimeout(r,5));assert.equal(finished,false)
  bot.emit('path_update',{status:'noPath',path:[]})
  await assert.rejects(run,/No path/)
  assert.equal(bot.listenerCount('goal_reached'),0)
  bot.pathfinder.setGoal(null)
})
test('destination telemetry supports block work, coordinate travel and moving drops',()=>{
 const {bot,work}=fixture({bank:62}),travel=new Travel(work)
 travel.destination(new BlockApproachGoal(bot,new Vec3(4,63,2)),'Plant wheat')
 assert.deepEqual(travel.activity.destination,{x:4,y:63,z:2,label:'Plant wheat'})
 const entity={position:new Vec3(1.5,62.8,3.5)},goal=new goals.GoalFollow(entity,1)
 entity.position=new Vec3(2.5,62.8,3.5);travel.destination(goal,'Collect wheat');assert.equal(travel.activity.destination.x,2.5)
 travel.destination(new goals.GoalBlock(5,64,3),'Reach shore');assert.equal(travel.activity.destination.y,64)
 travel.destination({},'Unknown target');assert.equal(travel.activity.destination,null)
})
for(const [bank,required] of [[65,6],[66,10]])test(`builds a supported stair up a vertical bank at ${bank}`,async()=>{
 const {bot,work,simulate,placements,changes,make}=fixture({bank,stock:16})
 for(let y=59;y<=65;y++)for(let z=-4;z<=4;z++){const p=new Vec3(0,y,z);changes.set(`0,${y},${z}`,make(y<=62?'water':'air',p))}
 bot.entity.position=new Vec3(2.5,62.5,.5);bot.entity.onGround=false;bot.entity.isInWater=true
 const goal=new goals.GoalBlock(8,bank+1,0)
 await simulate(work.travel(goal,'Climb tall island'),5000)
 assert.ok(goal.isEnd(bot.entity.position.floored()));assert.equal(placements.length,required)
})
test('builds and crosses a bridge across a four-block gap',async()=>{
 const {bot,work,simulate,placements}=fixture({bank:65,stock:16})
 const goal=new goals.GoalBlock(8,66,0)
 await simulate(work.travel(goal,'Bridge to the island'),5000)
 assert.ok(goal.isEnd(bot.entity.position.floored()));assert.equal(placements.length,4);assert.ok(placements.every(p=>p.y===65))
})
test('jumps across a one-block gap with no construction stock',async()=>{
 const {bot,work,changes,make,simulate,placements}=fixture({bank:65,stock:0})
 for(let x=2;x<=4;x++)for(let z=-4;z<=4;z++){const p=new Vec3(x,65,z);changes.set(p.toString().replace(/[() ]/g,''),make('stone',p))}
 const goal=new goals.GoalBlock(8,66,0)
 await simulate(work.travel(goal,'Jump the gap'));assert.ok(goal.isEnd(bot.entity.position.floored()));assert.equal(placements.length,0)
})
test('pickup walks carefully onto farmland and confirms delayed item collection',async()=>{
 const {bot,work,changes,make,simulate}=fixture({bank:62,stock:0})
 bot.entity.position=new Vec3(5.5,63,.5);bot.entity.onGround=true
 const p=new Vec3(7,62,0);changes.set('7,62,0',make('farmland',p))
 const item={id:77,name:'item',position:new Vec3(7.5,62.9375,.5)};bot.entities[77]=item
 let ticks=0,collected=false
 bot.on('physicsTick',()=>{if(++ticks>10 && bot.entities[77] && Math.hypot(bot.entity.position.x-7.5,bot.entity.position.z-.5)<.85){collected=true;bot.emit('playerCollect',bot.entity,item);delete bot.entities[77]}})
 const before=bot.pathfinder.movements
 await simulate(work.pickup(item.position))
 assert.equal(collected,true);assert.equal(work.issues.length,0);assert.equal(bot.pathfinder.movements,before)
})
test('search slices yield to timers even when the skill pause is a no-op',async()=>{
 const {bot,work}=fixture();work.pause=async()=>{}
 let slices=0,heartbeat=0
 bot.pathfinder.getPathFromTo=function*(){for(let i=0;i<20;i++){slices++;yield {result:{status:'partial',path:[]}}}yield {result:{status:'success',path:[]}}}
 const timer=setInterval(()=>heartbeat++,1)
 try{await new Travel(work).path(bot.pathfinder.movements,bot.entity.position,new goals.GoalBlock(8,64,0));assert.equal(slices,20);assert.ok(heartbeat>=10)}finally{clearInterval(timer)}
})
test('Stop interrupts sliced planning instead of waiting for every candidate',async()=>{
 const {bot,work}=fixture();work.pause=async()=>{};let slices=0
 bot.pathfinder.getPathFromTo=function*(){while(true){slices++;yield {result:{status:'partial',path:[]}}}}
 const timer=setTimeout(()=>work.cancel(),10)
 try{await assert.rejects(new Travel(work).path(bot.pathfinder.movements,bot.entity.position,new goals.GoalBlock(8,64,0)));assert.ok(slices<10)}finally{clearTimeout(timer)}
})
test('timeout exposes a useful dry-land segment without falsely announcing arrival',async()=>{
 const {bot}=fixture(),goal=new goals.GoalBlock(-5,66,0)
 bot.removeAllListeners('physicsTick') // Drive the installed route's progress explicitly in this event test.
 const pending=bot.pathfinder.goto(goal)
 bot.emit('path_update',{status:'timeout',path:[new Vec3(-4,66,0)]})
 assert.equal(bot.pathfinder.goal,goal,'keep the already computed route installed')
 bot.entity.position=new Vec3(-3.5,66,.5);bot.emit('physicsTick')
 await assert.rejects(pending,e=>e.name==='PartialRoute' && e.endpoint.x===-4 && e.followed)
 bot.pathfinder.setGoal(null)
})
test('segments walk an intermediate endpoint then retry the original goal',async()=>{
 const {bot,work}=fixture(),goal=new goals.GoalBlock(8,64,0),seen=[]
 bot.pathfinder.goto=async g=>{seen.push(g);if(seen.length===1)throw Object.assign(new Error('segment'),{name:'PartialRoute',endpoint:new Vec3(2,63,0)})}
 await new Travel(work).segments(goal)
 assert.equal(seen.length,3);assert.equal(seen[0],goal);assert.equal(seen[2],goal);assert.equal(seen[1].x,2)
})
test('builds and climbs a rising bridge to a floating island with no seabed support',async()=>{
 const {bot,work,changes,make,placements,simulate}=fixture({stock:16})
 for(let x=-5;x<=12;x++)for(let z=-4;z<=4;z++)for(let y=58;y<=72;y++){
  const p=new Vec3(x,y,z),name=x<=0 && y<=63 || x>=4 && y===66?'stone':'air'
  changes.set(`${x},${y},${z}`,make(name,p))
 }
 bot.entity.position=new Vec3(-.5,64,.5);bot.entity.onGround=true
 bot.pathfinder.thinkTimeout=1000;bot.pathfinder.tickTimeout=5
 const goal=new goals.GoalBlock(8,67,0)
 await simulate(work.travel(goal,'Reach a floating island'),5000)
 assert.ok(goal.isEnd(bot.entity.position.floored()))
 assert.ok(placements.length>=6);assert.ok(placements.every(p=>p.y>=63))
 assert.equal(bot.blockAt(new Vec3(2,59,0)).name,'air')
})
test('floating island plans contain only supported placements and reject unloaded gaps',()=>{
 const {bot,changes,make}=fixture({stock:16}),{islandRoutes}=require('../src/navigation/island-routes.cjs')
 for(let x=-5;x<=12;x++)for(let z=-4;z<=4;z++)for(let y=58;y<=72;y++){
  const p=new Vec3(x,y,z);changes.set(`${x},${y},${z}`,make(x<=0&&y<=63 || x>=4&&y===66?'stone':'air',p))
 }
 bot.entity.position=new Vec3(-.5,64,.5)
 const scan=islandRoutes(bot,new goals.GoalBlock(8,67,0));let step;do{step=scan.next()}while(!step.done)
 assert.ok(step.value.length)
 for(const plan of step.value){const built=new Set();for(const p of plan.placements){assert.ok(built.has(p.ref.toString()) || bot.blockAt(p.ref)?.boundingBox==='block');assert.ok(p.pos.distanceTo(p.ref)===1);built.add(p.pos.toString())}}
 const original=bot.blockAt.bind(bot);bot.blockAt=p=>p.x>0&&p.x<4?null:original(p)
 const unknown=islandRoutes(bot,new goals.GoalBlock(8,67,0));do{step=unknown.next()}while(!step.done);assert.equal(step.value.length,0)
})
test('captured island approach finds a bounded bridge from the higher stone platform',async()=>{
 const {bot,work}=fixture({stock:16}),data=require('./helpers/island-terrain.json'),Block=require('prismarine-block')(bot.registry),blocks=new Map()
 for(const[x,z,lo,hi,id]of data.runs)for(let y=lo;y<=hi;y++){const p=new Vec3(x,y+60,z),b=Block.fromStateId(id,0);b.position=p;blocks.set(p.toString(),b)}
 bot.blockAt=p=>blocks.get(p.floored().toString()) || null
 bot.entity.position=new Vec3(data.start[0],data.start[1]+60,data.start[2]);bot.entity.isInWater=true
 const goal=new goals.GoalBlock(data.target[0],data.target[1]+60,data.target[2]),plan=await new Travel(work).shorePlan(goal)
 assert.equal(plan?.kind,'island-ramp');assert.ok(plan.placements.length<=8);assert.ok(plan.staging.y>=64)
})
test('resource gathering can target an exposed island block from open surface water',()=>{
 const {bot,changes,make}=fixture(),p=new Vec3(3,65,0),node=new Vec3(3,62,0)
 changes.set('3,65,0',make('dirt',p))
 assert.equal(new BlockApproachGoal(bot,p).isEnd(node),false)
 assert.equal(new BlockApproachGoal(bot,p,{allowSurface:true}).isEnd(node),true)
 changes.set('3,63,0',make('water',new Vec3(3,63,0)))
 assert.equal(new BlockApproachGoal(bot,p,{allowSurface:true}).isEnd(node),false)
})
test('captured birch resource goal prioritizes an island landing over cheap irrelevant steps',async()=>{
 const {bot,work}=fixture({stock:16}),data=require('./helpers/island-resource-terrain.json'),Block=require('prismarine-block')(bot.registry),blocks=new Map()
 for(const[x,z,lo,hi,id]of data.runs)for(let y=lo;y<=hi;y++){const p=new Vec3(x,y+64,z),b=Block.fromStateId(id,0);b.position=p;blocks.set(p.toString(),b)}
 bot.blockAt=p=>blocks.get(p.floored().toString()) || null
 bot.entity.position=new Vec3(data.start[0],data.start[1]+64,data.start[2])
 const goal=new BlockApproachGoal(bot,new Vec3(data.target[0],data.target[1]+64,data.target[2]),{allowSurface:true})
 const plan=await new Travel(work).shorePlan(goal)
 assert.equal(plan?.kind,'island-ramp');assert.equal(plan.placements.length,6)
})

test('completed partial segments are not searched and walked a second time',async()=>{
 const {bot,work}=fixture(),goal=new goals.GoalBlock(8,64,0),seen=[]
 bot.pathfinder.goto=async g=>{seen.push(g);if(seen.length===1)throw Object.assign(new Error('segment'),{name:'PartialRoute',endpoint:new Vec3(2,63,0),followed:true})}
 await new Travel(work).segments(goal)
 assert.deepEqual(seen,[goal,goal])
})
test('weighted long-walk search expands fewer nodes around a wall using the same legal moves',()=>{
 const {WalkingSearchGoal}=require('../src/navigation/travel.cjs'),AStar=require('mineflayer-pathfinder/lib/astar'),Move=require('mineflayer-pathfinder/lib/move')
 const goal=new goals.GoalBlock(60,64,0)
 const movements={getNeighbors(n){return [[1,0],[-1,0],[0,1],[0,-1]].map(([x,z])=>new Move(n.x+x,64,n.z+z,0,1)).filter(p=>p.x>=-10&&p.x<=80&&Math.abs(p.z)<=30&&!(p.x===20&&Math.abs(p.z)<=12))}}
 const search=g=>new AStar(new Move(0,64,0,0,0),movements,g,10000,10000).compute()
 const plain=search(goal),weighted=search(new WalkingSearchGoal(goal))
 assert.equal(plain.status,'success');assert.equal(weighted.status,'success')
 assert.ok(weighted.visitedNodes < plain.visitedNodes*.7,`${weighted.visitedNodes} weighted vs ${plain.visitedNodes} ordinary nodes`)
 assert.ok(weighted.path.every(p=>!(p.x===20&&Math.abs(p.z)<=12)))
 assert.equal(goal.isEnd(weighted.path.at(-1)),true)
})

test('real physics completes a sixty-block walk with weighted search',async()=>{
 const {bot,work,make,simulate,logs}=fixture({stock:0})
 bot.blockAt=p=>{p=p.floored();return Math.abs(p.z)>6||p.x< -5||p.x>70?null:make(p.y<=63?'stone':'air',p)}
 bot.entity.position=new Vec3(.5,64,.5)
 const goal=new goals.GoalBlock(60,64,0)
 await simulate(new Travel(work).go(goal),6000)
 assert.equal(goal.isEnd(bot.entity.position.floored()),true)
 assert.ok(logs.some(l=>l.event==='travel.search'))
})
