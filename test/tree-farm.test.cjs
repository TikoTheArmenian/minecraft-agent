const {test}=require('node:test')
const assert=require('node:assert/strict')
const {fixture,Vec3}=require('./helpers/survival-fixture.cjs')
const {TreeFarm,inspectTree}=require('../src/tree-farm.cjs')
const {parse}=require('../src/agent.cjs')
function setup() {
  const h=fixture()
  for(let y=64;y<=72;y++)h.set('oak_log',new Vec3(0,y,0))
  h.set('oak_log',new Vec3(1,72,1));h.set('oak_log',new Vec3(2,73,2))
  h.set('oak_leaves',new Vec3(2,74,2)).getProperties=()=>({persistent:false})
  const work=new TreeFarm(h.agent,1)
  work.pause=async()=>work.check()
  work.approach=async p=>{work.check();h.bot.entity.position=p.offset(2,1,0)}
  work.pickup=async()=>{}
  work.reachLog=work.approach
  work.job=inspectTree(h.bot,h.bot.blockAt(new Vec3(0,64,0)))
  h.agent.treeJobs.set(work.jobKey,work.job)
  const place=h.bot._placeBlockWithOptions
  h.bot._placeBlockWithOptions=async (...args)=>{await place(...args);const p=args[0].position.offset(0,1,0);h.bot._client.emit('block_change',{location:p,type:h.bot.blockAt(p).stateId})}
  return {...h,work}
}
test('tree farmer command aliases',()=>{for(const text of ['farm trees','tree farmer','start tree farmer'])assert.equal(parse(text).type,'treeFarm')})
test('discovery captures tall trunks and diagonal branches before any mining',()=>{
  const h=setup();assert.equal(h.work.job.logs.length,11);assert.equal(h.work.job.roots.length,1);assert.equal(h.dug.length,0)
})
test('full tree removed and matching sapling confirmed before counting completion',async()=>{
  const h=setup();h.add('oak_sapling');await h.work.harvestTree()
  assert.equal(h.dug.filter(n=>n==='oak_log').length,11)
  assert.equal(h.bot.blockAt(new Vec3(2,73,2)).name,'air')
  assert.equal(h.bot.blockAt(new Vec3(0,64,0)).name,'oak_sapling')
  assert.equal(h.work.plan.trees,1);assert.equal(h.work.plan.remaining,0);assert.equal(h.agent.treeJobs.size,0)
})
test('unreachable upper branch leaves job pending and never counts a complete tree',async()=>{
  const h=setup();h.add('oak_sapling');h.work.reachLog=async()=>{throw new Error('No stairs available')}
  await assert.rejects(h.work.harvestTree(),/stairs/)
  assert.equal(h.work.plan.trees,0);assert.equal(h.dug.length,0);assert.equal(h.agent.treeJobs.size,1)
})
test('partial harvest resumes the captured tree, including disconnected branches',async()=>{
  const h=setup();h.add('oak_sapling');let calls=0
  h.work.reachLog=async p=>{if(++calls===3)throw new Error('Blocked');await h.work.approach(p)}
  await assert.rejects(h.work.harvestTree(),/Blocked/)
  assert.equal(h.dug.length,2)
  h.work.reachLog=h.work.approach;await h.work.harvestTree()
  assert.equal(h.dug.length,11);assert.equal(h.work.plan.trees,1)
})
test('missing planting stock preserves trunk and cancellation prevents subsequent actions',async()=>{
  const h=setup();h.work.find=()=>[]
  await assert.rejects(h.work.harvestTree(),/reserved for replanting/)
  assert.equal(h.dug.length,0)
  h.add('oak_sapling');h.work.cancel();await assert.rejects(h.work.harvestTree(),/Cancelled/)
  assert.equal(h.dug.length,0)
})
test('logs without roots or a canopy and oversized trees are refused',()=>{
  const h=fixture(),p=new Vec3(0,64,0)
  h.set('oak_log',p);assert.throws(()=>inspectTree(h.bot,h.bot.blockAt(p)),/canopy/)
  for(let y=64;y<110;y++)h.set('oak_log',new Vec3(0,y,0))
  h.set('oak_leaves',new Vec3(1,108,0))
  assert.throws(()=>inspectTree(h.bot,h.bot.blockAt(p)),/size/)
})
test('canopy traversal forbids automatic towers and breaking unrelated blocks',async()=>{
  const h=setup();h.bot.entity.position=new Vec3(10,64,10)
  const before=h.bot.pathfinder.movements
  h.bot.pathfinder.goto=async goal=>{
    const m=h.bot.pathfinder.movements
    assert.equal(m.allow1by1towers,false);assert.deepEqual(m.scafoldingBlocks,[])
    assert.equal(m.exclusionAreasBreak[0](h.bot.blockAt(new Vec3(0,64,0))),100)
    h.bot.entity.position=goal.pos.offset(2,0,0)
    h.set('dirt',h.bot.entity.position.offset(0,-1,0))
  }
  await TreeFarm.prototype.reachLog.call(h.work,new Vec3(2,73,2))
  assert.equal(h.bot.pathfinder.movements,before)
})

test('unfinished jobs survive a controller restart with their detached branches',async t=>{
  const fs=require('node:fs'),os=require('node:os'),path=require('node:path')
  const h=setup(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'tree-job-'))
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}))
  h.work.jobFile=path.join(dir,'tree-jobs.json');h.work.saveJob()
  h.add('oak_sapling');let calls=0
  h.work.reachLog=async p=>{if(++calls===2)throw new Error('Blocked');await h.work.approach(p)}
  await assert.rejects(h.work.harvestTree(),/Blocked/)
  delete h.agent.treeJobs;h.agent.dataDir=dir
  const resumed=new TreeFarm(h.agent,1)
  assert.equal(resumed.job.logs.length,11);assert.equal(resumed.job.removed,1)
  assert.ok(resumed.job.logs[0] instanceof Vec3)
})

test('dark oak requires planting reserves for the entire four-sapling footprint',async()=>{
  const h=fixture()
  for(let x=0;x<2;x++)for(let z=0;z<2;z++)for(let y=64;y<67;y++)h.set('dark_oak_log',new Vec3(x,y,z))
  h.set('dark_oak_leaves',new Vec3(0,67,0)).getProperties=()=>({persistent:false})
  const work=new TreeFarm(h.agent,1)
  work.job=inspectTree(h.bot,h.bot.blockAt(new Vec3(0,64,0)))
  assert.equal(work.job.roots.length,4)
  h.add('dark_oak_sapling',3);work.find=()=>[];work.pickup=async()=>{}
  await assert.rejects(work.plantingStock(work.job),/Need 4/)
  h.add('dark_oak_sapling');await work.plantingStock(work.job)
})

test('actual canopy stance reaches logs even when the block-center ray is occluded (live regression)',async()=>{
  const capture=require('./helpers/tree-canopy-terrain.json'),Block=require('prismarine-block')(require('minecraft-data')('1.21.1'))
  const h=fixture(),blocks=new Map(capture.blocks.map(([x,y,z,state])=>{const b=Block.fromStateId(state,0);b.position=new Vec3(x,y,z);return [b.position.toString(),b]}))
  h.bot.blockAt=p=>blocks.get(p.floored().toString()) || null
  h.bot.world={getBlock:p=>h.bot.blockAt(p),raycast:require('prismarine-world/src/worldsync').prototype.raycast}
  h.bot.entity.position=new Vec3(capture.position.x,capture.position.y,capture.position.z)
  const work=new TreeFarm(h.agent,1),p=new Vec3(-471,70,1042)
  work.job={species:'birch',roots:[p.offset(0,-4,0)]}
  const {BlockApproachGoal}=require('../src/block-approach.cjs')
  assert.equal(new BlockApproachGoal(h.bot,p).isEnd(h.bot.entity.position.floored()),false)
  h.bot.pathfinder.goto=()=>{assert.fail('Must use the existing reachable stance instead of repeating route search')}
  assert.equal(work.canWork(p),true)
  assert.equal(new (require('../src/tree-farm.cjs').CanopyGoal)(h.bot,p,'birch').isEnd(h.bot.entity.position.floored()),true,'canopy ray must retain its full reach after normalizing direction')
  await work.reachLog(p)
})

test('planned stair support can satisfy the search goal but cannot satisfy live reach before placement',()=>{
  const {CanopyGoal}=require('../src/tree-farm.cjs'),Move=require('mineflayer-pathfinder/lib/move')
  const h=fixture(),work=new TreeFarm(h.agent,1),p=new Vec3(2,70,0)
  h.set('birch_log',p)
  const node=new Move(0,69,0,10,1,[],[{x:0,y:67,z:0,dx:0,dy:1,dz:0}])
  h.bot.entity.position=node.clone()
  assert.equal(new CanopyGoal(h.bot,p,'birch').isEnd(node),true)
  assert.equal(work.canWork(p),false)
  h.set('dirt',new Vec3(0,68,0));assert.equal(work.canWork(p),true)
})

test('three unchanged failures pause tree farming and retain the pending tree',async()=>{
  const h=setup();h.add('dirt',64)
  h.work.harvestTree=async()=>{throw new Error('No useful route')}
  h.work.pause=async()=>h.work.check()
  await h.work.run()
  assert.equal(h.work.plan.status,'paused');assert.equal(h.work.task.status,'partial')
  assert.match(h.work.plan.decision,/three attempts/);assert.equal(h.agent.treeJobs.size,1)
})

test('replanting steps back when the closest visible stance overlaps the sapling',async()=>{
  const h=setup();h.add('birch_sapling');const soil=h.bot.blockAt(new Vec3(4,63,4))
  h.bot.entity.position=new Vec3(4.5,64,4.5)
  let moved=false
  h.work.travel=async goal=>{
    assert.equal(goal.isEnd(new Vec3(4,64,4)),false)
    h.bot.entity.position=new Vec3(6.5,64,4.5);moved=true
  }
  h.work.approach=async()=>{}
  await h.work.placeItem('birch_sapling',soil)
  assert.equal(moved,true);assert.equal(h.bot.blockAt(new Vec3(4,64,4)).name,'birch_sapling')
})

test('real movement physics builds confirmed canopy steps in the second captured birch tree',async()=>{
  const {fixture:terrainFixture,registry}=require('./helpers/travel-fixture.cjs')
  const capture=require('./helpers/tree-stair-terrain.json'),Block=require('prismarine-block')(registry)
  const h=terrainFixture({stock:64}),key=p=>p.floored().toString()
  const map=new Map(capture.blocks.map(([x,y,z,id])=>{const b=Block.fromStateId(id,0);b.position=new Vec3(x,y,z);return [key(b.position),b]}))
  h.bot.blockAt=p=>h.changes.get(`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`) || map.get(key(p)) || null
  h.bot.entity.position=new Vec3(capture.position.x,capture.position.y,capture.position.z)
  h.bot.canDigBlock=b=>b.position.offset(.5,.5,.5).distanceTo(h.bot.entity.position.offset(0,1.62,0))<4.5
  h.bot.inventory.emptySlotCount=()=>20;h.bot.unequip=async()=>{h.bot.heldItem=null}
  h.bot.dig=async b=>{
    assert.equal(b.name,'birch_leaves')
    const air=h.make('air',b.position);h.changes.set(`${b.position.x},${b.position.y},${b.position.z}`,air)
    h.bot._client.emit('block_change',{location:b.position,type:air.stateId});h.bot.emit('blockUpdate',b,air)
  }
  h.bot.pathfinder.thinkTimeout=1000;h.bot.pathfinder.tickTimeout=5
  const work=new TreeFarm(h.agent,1),target=new Vec3(-466,72,1038)
  work.job={species:'birch',roots:[new Vec3(-466,66,1038)]}
  await h.simulate(work.reachLog(target),6000)
  assert.ok(h.placements.length>=2,'must actually place supports, not teleport to the canopy')
  assert.equal(work.canWork(target),true)
  assert.ok(h.bot.entity.position.y>=70)
})

test('canopy planning preserves three-block sight range with a normalized ray direction',()=>{
  const h=fixture(),{CanopyGoal}=require('../src/tree-farm.cjs'),target=new Vec3(3,65,0)
  h.set('birch_log',target)
  h.bot.world={getBlock:p=>h.bot.blockAt(p),raycast:require('prismarine-world/src/worldsync').prototype.raycast}
  assert.equal(new CanopyGoal(h.bot,target,'birch').isEnd(new Vec3(0,64,0)),true)
})

test('canopy clearance removes a visible blocker before the hidden planned leaf',async()=>{
  const h=setup(),near=new Vec3(1,65,0),far=new Vec3(2,65,0)
  h.work.job.species='birch'
  h.set('birch_leaves',near).getProperties=()=>({persistent:false})
  h.set('birch_leaves',far).getProperties=()=>({persistent:false})
  h.bot.world={getBlock:p=>h.bot.blockAt(p),raycast:require('prismarine-world/src/worldsync').prototype.raycast}
  const removed=[],dig=h.bot.dig
  h.bot.dig=async block=>{removed.push(block.position.toString());await dig(block)}
  assert.equal(h.work.canWork(far),false)
  await h.work.clearCanopyLeaves([far])
  assert.deepEqual(removed,[near.toString(),far.toString()])
})

test('canopy clearance does not break a log or player-placed leaf to reach a target',async()=>{
  const h=setup(),near=new Vec3(1,65,0),far=new Vec3(2,65,0)
  h.work.job.species='birch'
  h.set('birch_leaves',far).getProperties=()=>({persistent:false})
  h.set('birch_log',near)
  h.bot.world={getBlock:p=>h.bot.blockAt(p),raycast:require('prismarine-world/src/worldsync').prototype.raycast}
  await assert.rejects(h.work.clearCanopyLeaves([far]),/unobstructed stance/)
  assert.equal(h.dug.length,0)
  h.set('birch_leaves',near).getProperties=()=>({persistent:true})
  await assert.rejects(h.work.clearCanopyLeaves([far]),/unobstructed stance/)
  assert.equal(h.dug.length,0)
})

test('a failed actual view excludes the current cell instead of accepting another empty path',async()=>{
  const h=setup(),start=h.bot.entity.position.floored(),soil=new Vec3(2,63,0)
  let moved=false
  h.work.canWork=()=>moved
  h.work.travel=async goal=>{
    assert.equal(goal.isEnd(start),false,'a stale centered view cannot count as arrival again')
    h.bot.entity.position=new Vec3(1,64,1);moved=true
  }
  await TreeFarm.prototype.approach.call(h.work,soil)
  assert.equal(moved,true)
})

test('real physics climbs a dirt column and recovers every support back to the ground', async () => {
  const {fixture: physicsFixture, registry} = require('./helpers/travel-fixture.cjs')
  const h = physicsFixture({stock: 0}), target = new Vec3(0, 72, 0)
  h.items.push({name:'dirt',type:registry.itemsByName.dirt.id,count:32})
  h.bot.blockAt = p => {
    p = p.floored()
    return h.changes.get(`${p.x},${p.y},${p.z}`) || h.make(p.y <= 63 ? 'dirt' : p.equals(target) ? 'birch_log' : 'air', p)
  }
  h.bot.entity.position = new Vec3(.5,64,.5)
  h.bot.canDigBlock = b => b.position.offset(.5,.5,.5).distanceTo(h.bot.entity.position.offset(0,1.62,0)) < 4.5
  h.bot.unequip = async () => { h.bot.heldItem = null }
  h.bot.dig = async b => {
    assert.equal(b.name, 'dirt')
    const air = h.make('air', b.position)
    h.changes.set(`${b.position.x},${b.position.y},${b.position.z}`, air)
    h.items[0].count++
    h.bot._client.emit('block_change', {location:b.position,type:air.stateId})
  }
  const work = new TreeFarm(h.agent,1)
  work.job = {species:'birch', roots:[new Vec3(0,64,0)], scaffolds:[]}
  work.pickup = async () => {}
  await h.simulate(work.climbTrunk(target),6000)
  assert.ok(h.placements.length >= 3)
  assert.equal(work.canWork(target),true)
  assert.equal(work.job.scaffolds.length,h.placements.length)
  await h.simulate(work.recoverScaffolds(),6000)
  assert.equal(h.bot.entity.position.floored().y,64)
  assert.equal(work.job.scaffolds.length,0)
  assert.equal(h.items[0].count,32)
  for (const p of h.placements) assert.equal(h.bot.blockAt(p).name,'air')
})

test('harvesting visits logs from the base upward', async () => {
  const h = setup(), heights = []
  h.add('oak_sapling')
  h.work.reachLog = async p => { heights.push(p.y); await h.work.approach(p) }
  await h.work.harvestTree()
  assert.deepEqual(heights,[...heights].sort((a,b)=>a-b))
})

test('support recovery refuses changed blocks and unsafe drops', async () => {
  const h=setup(), p=new Vec3(0,65,0)
  h.work.job.scaffolds=[{x:0,y:65,z:0,name:'dirt'}]
  h.set('stone',p)
  await assert.rejects(h.work.recoverScaffolds(),/support changed/)
  assert.equal(h.work.job.scaffolds.length,1)
  h.set('dirt',p);h.set('air',p.offset(0,-1,0));h.bot.entity.position=p.offset(.5,1,.5)
  h.work.approach=async()=>{}
  await assert.rejects(h.work.recoverScaffolds(),/Standing on this block/)
  assert.equal(h.bot.blockAt(p).name,'dirt')
})

test('dirt reserve counts dirt rather than other construction materials', async () => {
  const h=setup();h.add('cobblestone',64)
  let gathered=false
  h.work.gather=async(names,enough,label)=>{
    assert.deepEqual(names,['dirt','grass_block'])
    assert.equal(enough(),false)
    assert.match(label,/128/)
    h.add('dirt',128);assert.equal(enough(),true);gathered=true
  }
  h.work.harvestTree=async()=>{assert.equal(gathered,true);h.work.cancel();h.work.check()}
  await h.work.run()
  assert.equal(gathered,true)
})

test('support recovery reaches dry footing before settling or digging', async () => {
  const h=setup(), p=new Vec3(5,65,0), order=[]
  h.set('dirt',p);h.work.job.scaffolds=[{x:p.x,y:p.y,z:p.z,name:'dirt'}]
  h.bot.entity.isInWater=true
  h.work.leaveWater=async()=>{order.push('land');h.bot.entity.isInWater=false}
  h.work.approach=async()=>{order.push('approach');h.bot.entity.position=new Vec3(7,64,0)}
  h.work.settleStance=async()=>{assert.equal(h.bot.entity.isInWater,false);order.push('settle')}
  h.work.dig=async()=>{order.push('dig');h.set('air',p)}
  await h.work.recoverScaffolds()
  assert.deepEqual(order,['land','approach','settle','dig'])
  assert.equal(h.work.job.scaffolds.length,0)
})
test('failed land recovery retains every support without settling in water', async () => {
  const h=setup(), p=new Vec3(5,65,0)
  h.set('dirt',p);h.work.job.scaffolds=[{x:p.x,y:p.y,z:p.z,name:'dirt'}]
  h.bot.entity.isInWater=true
  h.work.leaveWater=async()=>{throw new Error('No dry landing')}
  h.work.settleStance=async()=>assert.fail('must not stop swimming to settle')
  await assert.rejects(h.work.recoverScaffolds(),/No dry landing/)
  assert.equal(h.work.job.scaffolds.length,1);assert.equal(h.bot.blockAt(p).name,'dirt')
})
test('low air interrupts tree work for recovery instead of fatal cancellation', () => {
  const h=setup();h.bot.entity.isInWater=true;h.bot.oxygenLevel=10
  h.bot.setControlState=()=>{}
  assert.throws(()=>h.work.check(),e=>e.code==='AIR_RECOVERY')
  assert.equal(h.work.controller.signal.aborted,false)
  assert.equal(h.work.safety(),null)
})
test('water stance never clears swimming controls', async () => {
  const h=setup();h.bot.entity.isInWater=true;let jumping=false
  h.bot.setControlState=(name,value)=>{if(name==='jump')jumping=value}
  h.bot.clearControlStates=()=>assert.fail('must retain swimming controls')
  await assert.rejects(h.work.settleStance(),/dry footing/)
  assert.equal(jumping,true)
})

test('real physics swims to dry land before scaffold recovery', async () => {
  const {fixture:physicsFixture}=require('./helpers/travel-fixture.cjs')
  const h=physicsFixture({stock:32})
  h.bot.entity.position=new Vec3(3.5,62.5,.5);h.bot.entity.isInWater=true
  h.bot.findBlocks=({matching,useExtraInfo})=>{
    const result=[]
    for(let x=-4;x<=10;x++)for(let z=-3;z<=3;z++)for(let y=62;y<=66;y++){
      const p=new Vec3(x,y,z),b=h.bot.blockAt(p)
      if(b && matching(b) && useExtraInfo(b))result.push(p)
    }
    return result
  }
  const work=new TreeFarm(h.agent,1)
  await h.simulate(work.leaveWater(),6000)
  assert.equal(!!h.bot.entity.isInWater,false)
  assert.equal(h.bot.blockAt(h.bot.entity.position.floored().offset(0,-1,0)).boundingBox,'block')
})

test('support already replaced by flowing water is retired without digging',async()=>{
  const h=setup(),p=new Vec3(5,65,0)
  h.set('water',p);h.work.job.scaffolds=[{x:p.x,y:p.y,z:p.z,name:'dirt'}]
  h.work.dig=async()=>assert.fail('water must not be mined')
  await h.work.recoverScaffolds()
  assert.equal(h.work.job.scaffolds.length,0)
  assert.equal(h.bot.blockAt(p).name,'water')
})

test('recorded dirt supports remain recoverable after grass spreads onto them',async()=>{
  const h=setup(),p=new Vec3(5,65,0)
  h.set('grass_block',p);h.work.job.scaffolds=[{x:p.x,y:p.y,z:p.z,name:'dirt'}]
  h.work.settleStance=async()=>{}
  let mined
  h.work.dig=async(q,name)=>{mined=name;h.set('air',q)}
  await h.work.recoverScaffolds()
  assert.equal(mined,'grass_block');assert.equal(h.work.job.scaffolds.length,0)
})

test('recovery approaches may clear natural canopy leaves but reject underwater working stances',async()=>{
  const h=setup();let arrived=false
  h.work.canWork=()=>arrived
  h.work.travel=async goal=>{
    const movements=h.bot.pathfinder.movements
    assert.equal(movements.canDig,true)
    assert.equal(movements.exclusionAreasBreak.at(-1)({name:'oak_leaves',getProperties:()=>({persistent:false})}),0)
    assert.equal(movements.exclusionAreasBreak.at(-1)({name:'oak_leaves',getProperties:()=>({persistent:true})}),100)
    assert.equal(movements.exclusionAreasBreak.at(-1)({name:'stone'}),100)
    h.set('water',new Vec3(2,64,0))
    assert.equal(goal.isEnd(new Vec3(2,64,0)),false)
    arrived=true
  }
  const before=h.bot.pathfinder.movements
  await TreeFarm.prototype.approach.call(h.work,new Vec3(0,64,0))
  assert.equal(h.bot.pathfinder.movements,before)
})

test('real physics descends natural canopy leaves only with a solid one-block landing',async()=>{
  const {fixture:physicsFixture}=require('./helpers/travel-fixture.cjs')
  const h=physicsFixture({stock:0})
  h.bot.entity.position=new Vec3(.5,67,.5)
  const Block=require('prismarine-block')(h.bot.registry),make=h.make
  h.make=(name,p)=>{if(name!=='birch_leaves')return make(name,p);const b=Block.fromProperties(h.bot.registry.blocksByName.birch_leaves.id,{persistent:false,waterlogged:false,distance:1},0);b.position=p.clone();return b}
  h.bot.blockAt=p=>{p=p.floored();return h.changes.get(`${p.x},${p.y},${p.z}`)||h.make(p.y<=63?'dirt':p.x===0&&p.z===0&&p.y<=66?'birch_leaves':'air',p)}
  h.bot.unequip=async()=>{h.bot.heldItem=null};h.bot.canDigBlock=()=>true
  let removed=0
  h.bot.dig=async b=>{assert.equal(b.name,'birch_leaves');removed++;const air=h.make('air',b.position);h.changes.set(`${b.position.x},${b.position.y},${b.position.z}`,air);h.bot._client.emit('block_change',{location:b.position,type:air.stateId})}
  const work=new TreeFarm(h.agent,1);work.job={species:'birch',roots:[new Vec3(0,64,0)]}
  await h.simulate(new Promise(resolve=>setTimeout(resolve,10)))
  await h.simulate(work.descendCanopy(),6000)
  assert.equal(removed,3);assert.equal(h.bot.entity.position.floored().y,64)
})

test('Jerry can work from farmland over water without repeating an arrival',async()=>{
  const h=fixture(),work=new TreeFarm(h.agent,1),target=new Vec3(2,65,0)
  h.set('water',new Vec3(0,61,0));h.set('farmland',new Vec3(0,62,0))
  h.set('oak_log',target)
  h.bot.entity.position=new Vec3(.5,62.9375,.5)
  h.bot.entity.onGround=true
  work.travel=async()=>assert.fail('The current farmland stance already reaches the log')
  assert.equal(work.canWork(target),true)
  await work.approach(target)
})
test('storage interaction does not require mining permission or a tree stance',async()=>{
  const h=fixture(),work=new TreeFarm(h.agent,1),target=new Vec3(2,65,0)
  h.set('water',new Vec3(0,61,0));h.set('farmland',new Vec3(0,62,0));h.set('chest',target)
  h.bot.entity.position=new Vec3(.5,62.9375,.5);h.bot.entity.onGround=true
  h.bot.canDigBlock=()=>false
  work.travel=async()=>assert.fail('The chest is already visible and reachable')
  await work.approach(target,{interaction:true})
  assert.equal(work.canWork(target),false)
})
test('failed farmland stance excludes both actual and pathfinder cells',async()=>{
  const h=fixture(),work=new TreeFarm(h.agent,1),target=new Vec3(2,65,0)
  h.set('water',new Vec3(0,61,0));h.set('farmland',new Vec3(0,62,0));h.set('oak_log',target)
  h.bot.entity.position=new Vec3(.5,62.9375,.5);h.bot.entity.onGround=true
  work.canWork=()=>false
  let routes=0
  work.travel=async goal=>{
    routes++
    assert.equal(goal.isEnd(new Vec3(0,62,0)),false)
    assert.equal(goal.isEnd(new Vec3(0,63,0)),false)
  }
  await assert.rejects(work.approach(target),/three distinct approaches/)
  assert.equal(routes,3)
})

test('missing saplings keep Barneett running beyond three retries and resume when supplied',async()=>{
  const h=setup();h.agent.username='Barneett';h.add('dirt',64)
  h.work.find=()=>[]
  let waits=0,completed=false
  h.work.harvestTree=async()=>{
    await h.work.plantingStock(h.work.job)
    completed=true
    h.work.cancel()
    h.work.check()
  }
  h.work.pause=async ms=>{
    h.work.check()
    assert.equal(ms,10000)
    assert.equal(h.work.stalledPasses,0)
    assert.equal(h.work.plan.status,'running')
    assert.match(h.work.plan.decision,/Drop saplings beside Barneett/)
    if(++waits===4)h.add('oak_sapling')
  }
  await h.work.run()
  assert.equal(waits,4)
  assert.equal(completed,true)
  assert.equal(h.dug.length,0)
})
test('real movement stalls name the active tree farming bot',async()=>{
  const h=setup();h.agent.username='Barneett';h.add('dirt',64)
  h.work.harvestTree=async()=>{throw new Error('No useful route')}
  await h.work.run()
  assert.match(h.work.plan.decision,/Move Barneett to another side/)
  assert.doesNotMatch(h.work.plan.decision,/Jerry/)
})
