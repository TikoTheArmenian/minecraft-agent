const test = require('node:test')
const assert = require('node:assert/strict')
const registry = require('minecraft-data')('1.21.1')
const { ArmorCoordination } = require('../src/messaging/armor-coordination.cjs')
const armor = require('../src/minecraft/armor.cjs')
const storage = require('../src/storage/service.cjs')
const crafting = require('../src/storage/crafting.cjs')
const steward = require('../src/storage/steward.cjs')
function fixture() {
  const memory = {}, sent = [], inventory = [], slots = [], events = []
  const peers = ['Farmer', 'Guard'].map(username => ({ username, epoch: 1, armorNeeds: ['iron_helmet'] }))
  const chat = { recall: () => memory, save() {}, directory: () => ({ list: () => peers }), peer: n => peers.find(p => p.username === n), say: (n, text) => { sent.push([n, text]); return true } }
  const bot = { registry, inventory: { slots, items: () => inventory }, entity: { position: { x: 0, y: 64, z: 0 } }, equip: async (i, destination) => { slots[{ head:5, torso:6, legs:7, feet:8 }[destination]] = i; inventory.splice(inventory.indexOf(i),1); events.push(`equip:${i.name}`) } }
  const work = { bot, agent: {}, task: {}, check() {}, timed: fn => fn(), progress() {}, addIssue: s => events.push(s) }
  const add = name => inventory.push({ name, type: registry.itemsByName[name].id, count: 1 })
  return { memory, sent, inventory, slots, events, peers, chat, work, add, coordination: new ArmorCoordination(chat) }
}
const hub = { x:0, y:64, z:0 }
const data = (items) => ({ containers: [{ managed:true, position:hub, slots:items.map(([name,count]) => ({ name,count })), capacity:54, category:'tools' }] })
test('LLM orders notifications and limited stock is offered only once', async t => {
  const h = fixture()
  t.mock.method(storage, 'list', async () => data([['iron_helmet',1]]))
  h.coordination.decide = async () => ({ order:['Guard','Farmer'] })
  await h.coordination.notify(h.work, hub)
  assert.deepEqual(h.sent.map(s => s[0]), ['Guard'])
  h.memory.nextArmorNotifyAt = 0
  await h.coordination.notify(h.work, hub)
  assert.equal(h.sent.length,1)
})
test('invalid model ordering and failed inference produce no offers', async t => {
  const h = fixture()
  t.mock.method(storage, 'list', async () => data([['iron_helmet',2]]))
  h.coordination.decide = async () => ({ order:['Guard','Guard'] })
  await h.coordination.notify(h.work, hub)
  assert.equal(h.sent.length,0)
  h.memory.nextArmorNotifyAt = 0
  h.coordination.decide = async () => { throw new Error('budget exhausted') }
  await h.coordination.notify(h.work, hub)
  assert.equal(h.sent.length,0)
})
test('offers deduplicate; LLM defers then retrieves and equips at a checkpoint', async t => {
  const h = fixture(), text = 'Armor waiting at 0 64 0: iron_helmet.'
  assert(h.coordination.receive('Storage', text))
  h.coordination.receive('Storage', text)
  assert.equal(h.memory.priorityStack.length,1)
  let collects = 0
  t.mock.method(storage, 'retrieve', async (_, [name]) => { collects++; h.add(name) })
  h.coordination.decide = async () => ({ collectNow:false, waitMs:60000, reason:'Finish replanting first.' })
  await h.coordination.collect(h.work)
  assert.equal(collects,0)
  assert(h.memory.priorityStack[0].dueAt > Date.now())
  h.memory.priorityStack[0].dueAt = 0
  h.coordination.decide = async () => ({ collectNow:true, waitMs:60000, reason:'Safe to collect now.' })
  await h.coordination.collect(h.work)
  assert.equal(h.slots[5].name,'iron_helmet')
  assert.equal(h.memory.priorityStack.length,0)
})
test('missing stock stays queued and cancellation propagates', async t => {
  const h = fixture()
  h.coordination.receive('Storage','Armor waiting at 0 64 0: iron_helmet.')
  t.mock.method(storage,'retrieve',async () => 0)
  h.coordination.decide = async () => ({ collectNow:true, waitMs:60000, reason:'Collect.' })
  await h.coordination.collect(h.work)
  assert.equal(h.memory.priorityStack.length,1)
  h.memory.priorityStack[0].dueAt = 0
  h.coordination.decide = async () => { throw Object.assign(new Error('Stopped'), { code:'CANCELLED' }) }
  await assert.rejects(h.coordination.collect(h.work), { code:'CANCELLED' })
})
test('steward equips its full set before crafting shared stock or notifying', async t => {
  const h = fixture(), jobs = new Map()
  t.mock.method(storage,'list',async () => data(steward.TOOL_STOCK.map(n => [n,4])))
  t.mock.method(storage,'retrieve',async () => 0)
  t.mock.method(storage,'call',async (_,action,job) => {
    if (action === 'enqueue') jobs.set(job.job,job)
    return action === 'claim_job' ? jobs.get(job.job) : null
  })
  t.mock.method(crafting,'stocks',() => ({ carry:{},shared:{} }))
  t.mock.method(crafting,'planRecipes',() => ({}))
  t.mock.method(crafting,'execute',async (_,job,options) => {
    if (options?.storeOutput === false) h.add(job.item)
    else { assert(Object.values(armor.IRON_SLOTS).every(slot => h.slots[slot])); h.events.push('shared') }
  })
  h.work.agent.coordination = { armorReady: async () => h.events.push('notify') }
  await steward.armor(h.work,hub)
  assert.deepEqual(h.events.slice(0,4),steward.ARMOR_STOCK.map(n => `equip:${n}`))
  assert.equal(h.events.at(-1),'notify')
})
