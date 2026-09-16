const test = require('node:test')
const assert = require('node:assert/strict')
const { fixture } = require('./helpers/survival-fixture.cjs')
const { StorageCrafting } = require('../src/skills/storage-crafting.cjs')
const storage = require('../src/storage/service.cjs')
const crafting = require('../src/storage/crafting.cjs')
function setup() {
  const h = fixture()
  h.agent.colony = { enabled: true, scope: () => ({ session: 'test' }) }
  return { ...h, work: new StorageCrafting(h.agent, 1) }
}
test('storage hands off after the chest transaction closes, before beginning another phase', async t => {
  const h = setup()
  let closed = false, dbCalls = 0
  t.mock.method(storage, 'call', async () => { dbCalls++; return { position: null } })
  t.mock.method(storage, 'scan', async work => {
    work.bot.currentWindow = {}
    work.requestHandoff()
    await Promise.resolve()
    work.bot.currentWindow = null
    closed = true
  })
  await assert.rejects(h.work.run({ action: 'scan' }), { code: 'HANDOFF' })
  assert.equal(closed, true)
  assert.equal(dbCalls, 0)
  assert.equal(h.work.task.reasonCode, 'HANDOFF')
  assert.equal(h.work.task.checkpoint.data.phase, 'scanned')
})
test('crafting finishes the claimed job before a cooperative handoff', async t => {
  const h = setup(), calls = []
  t.mock.method(storage, 'call', async (_, action) => { calls.push(action); return action === 'claim_job' ? { id: 'job' } : {} })
  let completed = false
  t.mock.method(crafting, 'execute', async work => {
    work.bot.currentWindow = {}
    work.requestHandoff()
    await Promise.resolve()
    work.bot.currentWindow = null
    work.counts.crafted = 3
    completed = true
  })
  await assert.rejects(h.work.run({ action: 'craft', item: 'bread', quantity: 3 }), { code: 'HANDOFF' })
  assert.equal(completed, true)
  assert.deepEqual(calls, ['enqueue', 'claim_job'])
  assert.equal(h.work.task.checkpoint.data.phase, 'crafted')
  assert.equal(h.work.task.checkpoint.data.counts.crafted, 3)
})

for (const queued of [true,false]) test(`idle golem runs only after an empty crafting queue (${queued})`, async t => {
  const h=setup(), steward=require('../src/storage/steward.cjs'), golem=require('../src/storage/iron-golem.cjs')
  t.mock.method(require('../src/capabilities/building-supplies.cjs'),'ensure',async()=>{})
  for(const method of ['scan','store']) t.mock.method(storage,method,async()=>{})
  for(const method of ['expand','label','tools','armor','consolidate']) t.mock.method(steward,method,async()=>false)
  t.mock.method(storage,'call',async(_,action)=>action==='hub_get'?{position:{x:0,y:64,z:0}}:queued?{id:'queued-job'}:null)
  let crafts=0,golems=0
  t.mock.method(crafting,'execute',async()=>{crafts++})
  t.mock.method(golem,'build',async()=>{golems++})
  h.work.pause=async()=>{throw Object.assign(new Error('test stop'),{code:'CANCELLED'})}
  await h.work.run({action:'maintain'})
  assert.equal(crafts,queued?1:0)
  assert.equal(golems,queued?0:1)
})
