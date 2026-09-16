const test = require('node:test')
const assert = require('node:assert/strict')
const { fixture, Vec3, registry } = require('./helpers/survival-fixture.cjs')
const golem = require('../src/storage/iron-golem.cjs')
const storage = require('../src/storage/service.cjs')
const crafting = require('../src/storage/crafting.cjs')
const { TOOL_STOCK, ARMOR_STOCK } = require('../src/storage/steward.cjs')
const hub = new Vec3(0,64,0)
function setup(t, ingots=100, blocks=0) {
  const h = fixture(), memory = {}, shared = Object.fromEntries([...TOOL_STOCK,...ARMOR_STOCK].map(n=>[n,4]))
  Object.assign(shared,{ iron_ingot:ingots,iron_block:blocks,carved_pumpkin:1 })
  h.agent.profile = { capabilities:['storageCoordinator'] }
  h.agent.coordination = { recall:()=>memory, save(){} }
  h.bot.inventory.slots = []
  for (const [i,name] of ARMOR_STOCK.entries()) h.bot.inventory.slots[5+i] = {name,type:registry.itemsByName[name].id,count:1}
  const data = {jobs:[],containers:[],reservations:[]}
  t.mock.method(storage,'list',async()=>data)
  t.mock.method(crafting,'stocks',()=>({ shared:{...shared},carry:Object.fromEntries(h.bot.inventory.items().map(i=>[i.name,i.count])) }))
  t.mock.method(storage,'retrieve',async(_, [name],target)=>{const current=h.bot.inventory.items().find(i=>i.name===name)?.count||0;const n=Math.min(Math.max(0,target-current),shared[name]||0);h.add(name,n);shared[name]-=n;return n})
  const jobs = new Map()
  t.mock.method(storage,'call',async(_,action,job)=>{if(action==='enqueue') jobs.set(job.job,{...job,id:job.job});return action==='claim_job'?jobs.get(job.job):null})
  t.mock.method(crafting,'execute',async(_,job)=>{assert.equal(job.item,'iron_block');shared.iron_ingot-=job.quantity*9;h.add('iron_block',job.quantity)})
  const work = {bot:h.bot,agent:h.agent,counts:{},controller:new AbortController(),check(){},checkpoint(){},sync(){},progress(){},addIssue(message){h.issues.push(message)},equip:i=>h.bot.equip(i),timed:fn=>fn(),pause:async()=>{throw new Error('spawn timeout')},travel:async goal=>{h.bot.entity.position=new Vec3(goal.x,goal.y,goal.z)}}
  h.issues=[]
  h.bot.placeBlock=async(ref,face)=>{
    const pos=ref.position.plus(face), name=h.bot.heldItem.name
    h.placed.push(name);h.bot.heldItem.count--
    const b=h.set(name,pos)
    h.bot._client.emit('block_change',{location:pos,type:b.stateId})
    if(name==='carved_pumpkin') {
      h.bot.entities[7]={id:7,name:'iron_golem',position:pos.offset(0,-2,0)}
      for(const [key,block] of h.blocks) if(['iron_block','carved_pumpkin'].includes(block.name)) h.blocks.delete(key)
    }
  }
  return {...h,work,memory,shared,data}
}
test('surplus protects 64 ingots, tool/armor buffers, and queued work', t=>{
  const h=setup(t)
  assert(golem.surplus(h.work,h.data))
  h.shared.iron_ingot=99
  assert.equal(golem.surplus(h.work,h.data),null)
  h.shared.iron_ingot=100
  h.shared.iron_axe=3
  assert.equal(golem.surplus(h.work,h.data),null)
  h.shared.iron_axe=4
  h.data.jobs=[{state:'queued'}]
  assert.equal(golem.surplus(h.work,h.data),null)
})
test('idle build crafts 4 blocks, places the head last, confirms spawn, and never repeats', async t=>{
  const h=setup(t)
  assert.equal(await golem.build(h.work,hub),true)
  assert.deepEqual(h.placed,['iron_block','iron_block','iron_block','iron_block','carved_pumpkin'])
  assert.equal(h.shared.iron_ingot,64)
  assert.equal(h.work.counts.golemsBuilt,1)
  h.bot.entities={}
  assert.equal(await golem.build(h.work,hub),false)
  assert.equal(h.placed.length,5)
})
test('stored blocks are used without spending the iron reserve', async t=>{
  const h=setup(t,64,4)
  assert(await golem.build(h.work,hub))
  assert.equal(h.shared.iron_ingot,64)
})
test('existing guardian, missing head, and obstructed site consume nothing', async t=>{
  const h=setup(t)
  h.bot.entities[7]={name:'iron_golem',position:hub}
  assert.equal(await golem.build(h.work,hub),false)
  h.bot.entities={};h.shared.carved_pumpkin=0
  assert.equal(await golem.build(h.work,hub),false)
  h.shared.carved_pumpkin=1
  t.mock.method(h.bot,'blockAt',p=>({name:'stone',boundingBox:'block',position:p}))
  assert.equal(await golem.build(h.work,hub),false)
  assert.equal(h.shared.iron_ingot,100)
})
test('handoff preserves the partial build and resumes without replacing confirmed blocks', async t=>{
  const h=setup(t)
  h.work.checkpoint=()=>{throw Object.assign(new Error('handoff'),{code:'HANDOFF'})}
  await assert.rejects(golem.build(h.work,hub),{code:'HANDOFF'})
  assert.equal(h.placed.length,1)
  h.work.checkpoint=()=>{}
  assert(await golem.build(h.work,hub))
  assert.equal(h.placed.length,5)
})
test('uncertain spawn is retained durably and does not spend a second set', async t=>{
  const h=setup(t), place=h.bot.placeBlock
  h.bot.placeBlock=async(...args)=>{await place(...args);h.bot.entities={}}
  assert.equal(await golem.build(h.work,hub),false)
  const state=h.memory.golems['0,64,0']
  assert.equal(state.status,'awaitingSpawn')
  state.retryAt=0
  assert.equal(await golem.build(h.work,hub),false)
  assert.equal(h.placed.length,5)
})
test('iron block recipe costs nine ingots and accepts real registry recipes',()=>{
  const Recipe=require('prismarine-recipe')(registry).Recipe
  const bot={registry,recipesAll:id=>Recipe.find(id,null)}
  assert.throws(()=>crafting.planRecipes(bot,'iron_block',4,{iron_ingot:35},{}),/Missing materials/)
  const plan=crafting.planRecipes(bot,'iron_block',4,{iron_ingot:36},{})
  assert.equal(plan.carry.iron_ingot,0)
})
