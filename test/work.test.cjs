const {test}=require('node:test')
const {EventEmitter}=require('node:events')
const {watchBlock}=require('../src/minecraft/block-updates.cjs')
const assert=require('node:assert/strict')
const {Vec3}=require('vec3')
const registry=require('minecraft-data')('1.21.1')
const Block=require('prismarine-block')(registry)
const {Work,parseWork,chooseTool,mature,CROPS}=require('../src/runtime/work.cjs')
const key=p=>`${p.x},${p.y},${p.z}`
function fixture() {
  const blocks=new Map(),dug=[],planted=[],items=[]
  function set(name,p,age=0){const b=Block.fromStateId(registry.blocksByName[name].minStateId,0);b.position=p.clone();if(Object.values(CROPS).some(c=>c.block===name))b.getProperties=()=>({age});blocks.set(key(p),b);return b}
  const bot=Object.assign(new EventEmitter(),{_client:new EventEmitter(),registry,game:{gameMode:'survival'},entity:{position:new Vec3(0,64,0),effects:{}},entities:{},
    inventory:{items:()=>items,emptySlotCount:()=>10},blockAt:p=>blocks.get(key(p))||set('air',p),
    pathfinder:{movements:{},setMovements(m){this.movements=m},setGoal(){},goto:async()=>{}},
    canSeeBlock:()=>true,canDigBlock:()=>true,stopDigging(){},clearControlStates(){},
    equip:async i=>{bot.heldItem=i},unequip:async()=>{bot.heldItem=null},lookAt:async()=>{},
    dig:async b=>{dug.push(b.name);set('air',b.position);bot._client.emit('block_change',{location:b.position,type:0})},
    _placeBlockWithOptions:async b=>{const crop=Object.values(CROPS).find(c=>c.seed===bot.heldItem.name);const plantedBlock=set(crop.block,b.position.offset(0,1,0));planted.push(crop.block);bot.heldItem.count--;bot._client.emit('block_change',{location:plantedBlock.position,type:plantedBlock.stateId})},
    findBlocks:({matching})=>[...blocks.values()].filter(b=>b.type===matching).map(b=>b.position)
  })
  const agent={bot,nav:1,state:{connection:'ready',task:{status:'running'}},publish(){},say(text){this.last=text},disconnect(){this.nav++;this.bot=null;this.state.connection='disconnected'}}
  const work=new Work(agent,1);work.approach=async p=>{work.check();bot.entity.position=p.offset(2,1,0)};work.pause=async()=>work.check()
  return {bot,agent,work,set,dug,planted,items}
}
test('area corners normalize and limits reject oversized jobs',()=>{
  const c=parseWork('mine area 2 66 2 to 1 64 1');assert.equal(c.volume,12);assert.equal(c.min.y,64)
  assert.throws(()=>parseWork('mine area 0 0 0 to 10 10 10'))
  assert.throws(()=>parseWork('mine stone 129 within 32'))
  assert.throws(()=>parseWork('farm wheat 33'))
  assert.equal(parseWork('farm carrot').crop,'carrots')
})
test('correct-tier tool beats faster but unsuitable gold pickaxe',()=>{
  const f=fixture(),ore=f.set('diamond_ore',new Vec3(2,64,0))
  const gold={name:'golden_pickaxe',type:registry.itemsByName.golden_pickaxe.id},iron={name:'iron_pickaxe',type:registry.itemsByName.iron_pickaxe.id}
  f.items.push(gold,iron);assert.equal(chooseTool(f.bot,ore),iron)
  f.items.pop();assert.throws(()=>chooseTool(f.bot,ore),/suitable tool/)
})
test('diamond beats iron for stone and ore regardless of hotbar order or Creative mode',()=>{
  for(const mode of ['survival','creative'])for(const name of ['stone','iron_ore','diamond_ore']){
    const f=fixture();f.bot.game.gameMode=mode
    const iron={name:'iron_pickaxe',type:registry.itemsByName.iron_pickaxe.id,slot:36},diamond={name:'diamond_pickaxe',type:registry.itemsByName.diamond_pickaxe.id,slot:44}
    const block=f.set(name,new Vec3(2,64,0));f.items.push(iron,diamond)
    assert.equal(chooseTool(f.bot,block),diamond,`${mode}: ${name}`)
    f.items.reverse();assert.equal(chooseTool(f.bot,block),diamond)
  }
})
test('efficiency enchantments can make iron faster than unenchanted diamond on ore',()=>{
  const f=fixture(),block=f.set('iron_ore',new Vec3(2,64,0))
  const iron={name:'iron_pickaxe',type:registry.itemsByName.iron_pickaxe.id,enchants:[{name:'efficiency',lvl:5}],slot:36},diamond={name:'diamond_pickaxe',type:registry.itemsByName.diamond_pickaxe.id,slot:37}
  f.items.push(diamond,iron);assert.equal(chooseTool(f.bot,block),iron)
})
test('selection uses axes for logs, shovels for dirt, and hands for instant crops',()=>{
  const f=fixture()
  for(const name of ['diamond_pickaxe','iron_axe','diamond_shovel'])f.items.push({name,type:registry.itemsByName[name].id,slot:36+f.items.length})
  assert.equal(chooseTool(f.bot,f.set('oak_log',new Vec3(2,64,0))).name,'iron_axe')
  assert.equal(chooseTool(f.bot,f.set('dirt',new Vec3(2,64,0))).name,'diamond_shovel')
  assert.equal(chooseTool(f.bot,f.set('wheat',new Vec3(2,64,0))),null)
})
test('a nearly broken diamond pickaxe is skipped for a usable iron pickaxe',()=>{
  const f=fixture(),iron={name:'iron_pickaxe',type:registry.itemsByName.iron_pickaxe.id}
  f.items.push({name:'diamond_pickaxe',type:registry.itemsByName.diamond_pickaxe.id,durabilityUsed:registry.itemsByName.diamond_pickaxe.maxDurability-1},iron)
  assert.equal(chooseTool(f.bot,f.set('iron_ore',new Vec3(2,64,0))),iron)
})
test('mining actually equips the best hotbar tool before sending a dig',async()=>{
  const f=fixture(),p=new Vec3(2,64,0)
  for(const name of ['iron_pickaxe','diamond_pickaxe'])f.items.push({name,type:registry.itemsByName[name].id,slot:36+f.items.length})
  f.bot.heldItem=f.items[0];const original=f.bot.dig;let used
  f.bot.dig=async block=>{used=f.bot.heldItem.name;await original(block)}
  f.set('iron_ore',p);await f.work.dig(p,'iron_ore')
  assert.equal(used,'diamond_pickaxe')
})
test('ripe ages are crop-specific',()=>{
  for(const c of Object.values(CROPS)){assert.equal(mature({name:c.block,getProperties:()=>({age:c.age})},c),true);assert.equal(mature({name:c.block,getProperties:()=>({age:c.age-1})},c),false)}
})
test('area mining changes selected positions only',async()=>{
  const f=fixture();f.set('dirt',new Vec3(2,64,0));f.set('dirt',new Vec3(3,64,0));const outside=new Vec3(4,64,0);f.set('dirt',outside)
  await f.work.run(parseWork('mine area 2 64 0 to 3 64 0'))
  assert.equal(f.dug.length,2);assert.equal(f.bot.blockAt(outside).name,'dirt');assert.equal(f.agent.state.task.status,'succeeded')
})
test('type mining stops exactly at requested count',async()=>{
  const f=fixture();for(let x=2;x<6;x++)f.set('dirt',new Vec3(x,64,0))
  await f.work.run(parseWork('mine dirt 2 within 16'))
  assert.equal(f.dug.length,2)
})
test('unharvestable targets report partial results without breaking',async()=>{
  const f=fixture();f.set('diamond_ore',new Vec3(2,64,0));await f.work.run(parseWork('mine diamond_ore 1'))
  assert.equal(f.dug.length,0);assert.equal(f.agent.state.task.status,'partial')
})
test('stop during pending look never starts a delayed dig',async()=>{
  const f=fixture(),p=new Vec3(2,64,0);f.set('dirt',p)
  let done;f.bot.lookAt=()=>new Promise(r=>done=r)
  const run=f.work.dig(p,'dirt');await new Promise(setImmediate);f.agent.nav++;done()
  await assert.rejects(run,/Cancelled/);assert.equal(f.dug.length,0)
})
test('farming harvests only ripe crops and replants the same type',async()=>{
  const f=fixture()
  for(const [x,c,age] of [[2,CROPS.wheat,7],[3,CROPS.wheat,4],[4,CROPS.carrots,7]]){f.set('farmland',new Vec3(x,63,0));f.set(c.block,new Vec3(x,64,0),age)}
  f.items.push({name:'wheat_seeds',type:registry.itemsByName.wheat_seeds.id,count:10},{name:'carrot',type:registry.itemsByName.carrot.id,count:10})
  await f.work.run(parseWork('farm all 16'))
  assert.deepEqual(f.dug,['wheat','carrots']);assert.deepEqual(f.planted,['wheat','carrots']);assert.equal(f.bot.blockAt(new Vec3(3,64,0)).getProperties().age,4)
})
test('no seed stock leaves mature crops intact',async()=>{
  const f=fixture();f.set('farmland',new Vec3(2,63,0));f.set('wheat',new Vec3(2,64,0),7)
  await f.work.run(parseWork('farm wheat'))
  assert.equal(f.dug.length,0);assert.equal(f.agent.state.task.status,'partial');assert.match(f.agent.last,/wheat_seeds/)
})
test('empty farmland is planted with supplied stock',async()=>{
  const f=fixture();f.set('farmland',new Vec3(2,63,0));f.items.push({name:'potato',type:registry.itemsByName.potato.id,count:10})
  await f.work.run(parseWork('farm potatoes'))
  assert.deepEqual(f.planted,['potatoes']);assert.equal(f.dug.length,0)
})
test('crop changed to immature during equip is not harvested',async()=>{
  const f=fixture(),p=new Vec3(2,64,0);f.set('wheat',p,7)
  // Start with an item in hand so the tool adapter needs a real equipment change.
  f.bot.heldItem={name:'stone',type:registry.itemsByName.stone.id,count:1}
  f.bot.unequip=async()=>{f.bot.heldItem=null;f.set('wheat',p,0)}
  await assert.rejects(f.work.dig(p,'wheat',b=>mature(b,CROPS.wheat)),/changed/)
  assert.equal(f.dug.length,0)
})

test('a hung action timeout settles instead of holding the work lock forever',async()=>{
  const f=fixture()
  await assert.rejects(f.work.timed(()=>new Promise(()=>{}),10),/timed out/)
  assert.equal(f.agent.bot,null)
})
test('Stop aborts an unresolved action and retires its stuck connection',async()=>{
  const f=fixture()
  const operation=f.work.timed(()=>new Promise(()=>{}),10000)
  await new Promise(setImmediate)
  f.work.cancel()
  await assert.rejects(operation,/Cancelled/)
  assert.equal(f.agent.bot,null)
})
test('predicted local air does not count as server-confirmed mining',async()=>{
  const f=fixture(),p=new Vec3(2,64,0)
  f.set('dirt',p)
  f.bot.dig=async b=>f.set('air',b.position) // client prediction only
  const timed=f.work.timed.bind(f.work)
  f.work.timed=(fn,ms)=>timed(fn,Math.min(ms||20000,15))
  await assert.rejects(f.work.run(parseWork('mine dirt 1')), /timed out/)
  assert.equal(f.work.counts.mined,0)
  assert.equal(f.agent.state.task.status,'failed')
  assert.equal(f.bot._client.listenerCount('block_change'),0)
})
test('server update watcher decodes batched updates at negative coordinates',async()=>{
  const client=new EventEmitter(),p=new Vec3(-17,-63,31)
  const watch=watchBlock({_client:client},p,state=>state===0)
  client.emit('multi_block_change',{chunkCoordinates:{x:-2,y:-4,z:1},records:[(15<<8)|(15<<4)|1]})
  await watch.promise
  assert.equal(client.listenerCount('multi_block_change'),0)
})
test('pickup errors do not count a successfully mined block as skipped',async()=>{
  const f=fixture(),p=new Vec3(2,64,0)
  f.set('dirt',p)
  f.bot.entities={12:{id:12,name:'item',position:p}}
  f.bot.pathfinder.goto=async()=>{throw new Error('NoPath')}
  await f.work.run(parseWork('mine dirt 1'))
  assert.equal(f.work.counts.mined,1)
  assert.equal(f.work.counts.skipped,0)
  assert.equal(f.work.counts.collectedStacks,0)
  assert.match(f.agent.last,/could not be reached/)
})
test('planting stock lost during travel prevents harvest',async()=>{
  const f=fixture(),p=new Vec3(2,64,0)
  f.set('farmland',p.offset(0,-1,0));f.set('wheat',p,7)
  f.items.push({name:'wheat_seeds',type:registry.itemsByName.wheat_seeds.id,count:1})
  f.work.approach=async()=>{f.items.length=0}
  await f.work.run(parseWork('farm wheat'))
  assert.equal(f.dug.length,0)
  assert.equal(f.bot.blockAt(p).getProperties().age,7)
})
test('cancellation preserves the last completed work count',()=>{
  const f=fixture();f.work.counts.mined=3;f.work.cancel()
  assert.equal(f.agent.state.task.counts.mined,3)
})
test('pickup approaches fractional-height drops within range and follows movement',async()=>{
  const {Travel}=require('../src/navigation/travel.cjs'),original=Travel.prototype.go
  const f=fixture(),p=new Vec3(2.5,63.9375,.5),item={id:90,name:'item',position:p}
  f.bot.entity.id=1;f.bot.entities[90]=item
  Travel.prototype.go=async function(goal){
    assert.equal(this.optional,true)
    assert.equal(goal.isEnd(new Vec3(2,64,0)),true,'air above farmland must be an acceptable destination')
    item.position=new Vec3(5.5,63.9375,.5);assert.equal(goal.hasChanged(),true)
    f.bot.emit('playerCollect',f.bot.entity,item);delete f.bot.entities[90]
  }
  try{await f.work.pickup(p);assert.equal(f.work.issues.length,0)}finally{Travel.prototype.go=original}
})
test('unreachable loot is skipped on repeated passes instead of replanning',async()=>{
  const f=fixture(),p=new Vec3(2,64,0);f.bot.entities[91]={id:91,name:'item',position:p}
  let searches=0;f.bot.pathfinder.getPathFromTo=function*(){searches++;yield {result:{status:'timeout',path:[]}}}
  await f.work.pickup(p);await f.work.pickup(p)
  assert.equal(searches,1);assert.match(f.work.issues[0],/continuing work/);assert.equal(f.work.task.travel.status,'skipped');assert.equal(f.bot.listenerCount('playerCollect'),0)
  f.work.pickupCooldowns.set(91,Date.now()-1);await f.work.pickup(p);assert.equal(searches,2)
})
test('ordinary checkpoints are inert, but requested handoffs refuse an open window or cursor', () => {
  const { work, bot, agent } = fixture()
  bot.currentWindow = {}; bot.inventory.selectedItem = {}
  assert.doesNotThrow(() => work.checkpoint({ phase: 'idle' }))
  assert.equal(work.task.checkpoint, undefined)
  work.requestHandoff()
  assert.throws(() => work.checkpoint(), { code: 'HANDOFF_BLOCKED' })
  bot.currentWindow = null
  assert.throws(() => work.checkpoint(), { code: 'HANDOFF_BLOCKED' })
  assert.equal(work.controller.signal.aborted, false)
  bot.inventory.selectedItem = null
  let saved = null
  agent.runtime = { saveCheckpoint: (_, checkpoint) => { saved = checkpoint } }
  assert.throws(() => work.checkpoint({ phase: 'stable' }), { code: 'HANDOFF' })
  assert.equal(saved.data.phase, 'stable')
  assert.throws(() => work.check(), { code: 'HANDOFF' })
})
test('handoff checkpoint persistence fails before aborting the active skill', () => {
  const { work, agent } = fixture()
  work.requestHandoff()
  agent.runtime = { saveCheckpoint() { throw Object.assign(new Error('Cannot save checkpoint'), { code: 'CHECKPOINT_WRITE_FAILED' }) } }
  assert.throws(() => work.checkpoint(), { code: 'CHECKPOINT_WRITE_FAILED' })
  assert.equal(work.controller.signal.aborted, false)
  assert.equal(work.task.checkpoint, undefined)
})
test('cleanup runs once in reverse order, bounds hung callbacks, and retires its socket before release', async () => {
  const { work, agent } = fixture(), order = []
  work.registerCleanup(() => { order.push('first') })
  work.registerCleanup(() => { order.push('hung'); return new Promise(() => {}) }, { label: 'Close window', timeoutMs: 10 })
  work.registerCleanup(() => { order.push('last') })
  const pending = work.cleanup({ timeoutMs: 50 })
  assert.equal(work.cleanup(), pending)
  await assert.rejects(pending, error => error.code === 'CLEANUP_FAILED' && error.fatal)
  assert.deepEqual(order, ['last', 'hung', 'first'])
  assert.equal(agent.bot, null)
  assert.equal(work.task.reasonCode, 'CLEANUP_FAILED')
})
test('cleanup of an obsolete run never disconnects a newer bot', async () => {
  const { work, agent, bot } = fixture()
  let retired = false
  bot._client.socket = { destroy() { retired = true } }
  const current = agent.bot = { newer: true }
  work.registerCleanup(() => { throw new Error('Old resource failed') })
  await assert.rejects(work.cleanup(), { code: 'CLEANUP_FAILED' })
  assert.equal(retired, true)
  assert.equal(agent.bot, current)
})
test('an unclosed window cannot pass the final ownership-release barrier', async () => {
  const { work, bot, agent } = fixture()
  bot.currentWindow = {}
  await assert.rejects(work.cleanup(), { code: 'CLEANUP_FAILED' })
  assert.equal(agent.bot, null)
})
test('a server-confirmed dig remains in the result when Stop races completion', async () => {
  const { work, bot, set } = fixture(), p = new Vec3(2, 64, 0)
  set('dirt', p)
  const dig = bot.dig
  bot.dig = async block => { await dig(block); work.cancel() }
  await assert.rejects(work.dig(p, 'dirt'), { code: 'CANCELLED' })
  assert.equal(work.effects.length, 1)
  assert.equal(work.effects[0].kind, 'block_removed')
  assert.deepEqual(work.effects[0].position, { x: 2, y: 64, z: 0 })
})
test('predicted planting without a server packet neither succeeds nor records a confirmed effect', async () => {
  const { work, bot, set, items } = fixture(), p = new Vec3(2, 63, 0)
  set('farmland', p)
  items.push({ name: 'wheat_seeds', type: registry.itemsByName.wheat_seeds.id, count: 2 })
  bot._placeBlockWithOptions = async soil => { set('wheat', soil.position.offset(0, 1, 0)); bot.heldItem.count-- }
  const timed = work.timed.bind(work)
  work.timed = (operation, limit, label) => timed(operation, Math.min(limit, 15), label)
  await assert.rejects(work.plant(p, CROPS.wheat), /timed out/)
  assert.equal(work.counts.planted, 0)
  assert.equal(work.effects.length, 0)
  assert.equal(bot._client.listenerCount('block_change'), 0)
})
test('a requested farming handoff completes harvest and replant before yielding', async () => {
  const f = fixture()
  for (const x of [2, 3]) { f.set('farmland', new Vec3(x, 63, 0)); f.set('wheat', new Vec3(x, 64, 0), 7) }
  f.items.push({ name: 'wheat_seeds', type: registry.itemsByName.wheat_seeds.id, count: 2 })
  const dig = f.bot.dig
  f.bot.dig = async block => { await dig(block); f.work.requestHandoff() }
  await assert.rejects(f.work.run(parseWork('farm wheat')), { code: 'HANDOFF' })
  assert.deepEqual(f.dug, ['wheat'])
  assert.deepEqual(f.planted, ['wheat'])
  assert.equal(f.work.task.reasonCode, 'HANDOFF')
  assert.equal(f.work.task.checkpoint.data.phase, 'replanted')
  assert.equal(f.work.counts.harvested, 1)
  assert.equal(f.work.counts.planted, 1)
  assert.deepEqual(f.work.effects.map(effect => effect.kind), ['block_removed', 'block_placed'])
})
test('mining switches only after recording the finished block and before the next target', async () => {
  const f = fixture()
  for (const x of [2, 3]) f.set('dirt', new Vec3(x, 64, 0))
  const dig = f.bot.dig
  f.bot.dig = async block => { await dig(block); f.work.requestHandoff() }
  await assert.rejects(f.work.run(parseWork('mine dirt 2')), { code: 'HANDOFF' })
  assert.equal(f.dug.length, 1)
  assert.equal(f.work.counts.mined, 1)
  assert.equal(f.work.task.checkpoint.data.phase, 'mined')
})
