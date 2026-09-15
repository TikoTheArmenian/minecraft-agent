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
