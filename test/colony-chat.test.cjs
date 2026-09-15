const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path')
const { ColonyChat } = require('../src/messaging/colony-chat.cjs')
function fixture(t, name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'colony-chat-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const a = {
    username: name,
    profile: require('../src/agents/fleet.cjs').profileFor(name),
    dataDir: dir,
    epoch: 1,
    state: { world: 'test', dimension: 'overworld', connection: 'ready' },
    log() {},
    bot: { inventory: { items: () => [{ name: 'wheat', count: 64 }] } },
  }
  a.coordination = new ColonyChat(a)
  return a
}
function pair(t) {
  const sam = fixture(t, 'Sam'),
    marc = fixture(t, 'Marc')
  sam.fleet = marc.fleet = { sam, marc }
  return { sam, marc }
}
test('named role and stock exchange works without an LLM and persists learned roles', (t) => {
  const { sam, marc } = pair(t)
  assert.equal(marc.coordination.receive(marc.bot, 'Sam', 'Marc: What do you do?'), true)
  const reply = marc.coordination.queue.shift().message
  sam.coordination.receive(sam.bot, 'Marc', reply)
  assert.equal(new ColonyChat(sam).recall().peers.Marc.role, 'farmer')
  marc.coordination.receive(marc.bot, 'Sam', 'Marc: What do you have, and what do you need?')
  assert.ok(marc.coordination.queue.some((q) => q.message.includes('wheat=64')))
  assert.ok(marc.coordination.queue.some((q) => q.message.includes('iron_hoe')))
  assert.equal(marc.coordination.receive(marc.bot, 'Jerry', 'Marc: What do you do?'), false)
})
test('locations commit only after a complete addressed update, survive restart and stay world scoped', (t) => {
  const { marc } = pair(t),
    c = marc.coordination,
    locations = [{ category: 'food', position: { x: -469, y: 65, z: 1061 } }]
  const lines = c.storageUpdates.lines(locations),
    receive = (text) => c.receive(marc.bot, 'Sam', `Marc: ${text}`)
  receive(lines[0])
  receive(lines[1])
  assert.equal(c.recall().storage, undefined)
  receive(lines[2])
  assert.deepEqual(new ColonyChat(marc).recall().storage.locations, locations)
  assert.ok(c.queue.some((q) => q.message.startsWith('Sam: Remembered storage update ')))
  marc.state.dimension = 'nether'
  assert.equal(c.recall().storage, undefined)
})
test('Sam updates changed chest locations and waits for acknowledgement', async (t) => {
  const { sam } = pair(t),
    c = sam.coordination
  sam.bot.chat = () => {}
  sam.colony = {
    enabled: true,
    call: async (a, action) =>
      action === 'hub_get'
        ? { position: { x: 0, y: 64, z: 0 } }
        : {
            containers: [
              { managed: true, category: 'food', position: { x: 1, y: 64, z: 0 }, slots: [] },
            ],
          },
  }
  c.recall().peers.Marc = { role: 'farmer', reportReady: true, inventoryAt: Date.now(), needs: [] }
  await c.tick()
  const peer = c.recall().peers.Marc
  assert.equal(peer.ackRevision, undefined)
  assert.ok(c.queue.some((q) => q.message.includes('Store food at 1 64 0')))
  c.receive(sam.bot, 'Marc', `Sam: Remembered storage update ${peer.sentRevision}.`)
  assert.equal(peer.ackRevision, peer.sentRevision)
  c.queue = []
  peer.askedAt = 0
  c.nextCheck = 0
  await c.tick()
  assert.equal(c.queue.length, 0)
})
test('better tools do not cause requests for inferior replacements', () => {
  const { hasTool } = require('../src/messaging/colony-chat.cjs')
  assert.equal(hasTool([{ name: 'netherite_hoe', count: 1 }], 'iron_hoe'), true)
  assert.equal(hasTool([{ name: 'stone_hoe', count: 1 }], 'iron_hoe'), false)
})
test('a new chest triggers an update even after the previous layout was acknowledged', async (t) => {
  const { sam } = pair(t),
    c = sam.coordination
  const containers = [
    { managed: true, category: 'food', position: { x: 1, y: 64, z: 0 }, slots: [] },
  ]
  sam.bot.chat = () => {}
  sam.colony = {
    enabled: true,
    call: async (a, action) =>
      action === 'hub_get' ? { position: { x: 0, y: 64, z: 0 } } : { containers },
  }
  c.recall().peers.Marc = { role: 'farmer', reportReady: true, inventoryAt: Date.now(), needs: [] }
  await c.tick()
  const peer = c.recall().peers.Marc,
    old = peer.sentRevision
  peer.ackRevision = old
  peer.askedAt = 0
  c.queue = []
  c.nextCheck = 0
  containers.push({ managed: true, category: 'tools', position: { x: 2, y: 64, z: 0 }, slots: [] })
  await c.tick()
  assert.notEqual(peer.sentRevision, old)
  assert.ok(c.queue.some((q) => q.message.includes('Store tools at 2 64 0')))
  assert.equal(peer.ackRevision, old)
})

test('failed storage side trips continue farming and respect cooldown even when nearly full', async (t) => {
  const a = fixture(t, 'Jerry'),
    c = a.coordination,
    storage = require('../src/storage/service.cjs')
  a.colony = { enabled: true }
  c.recall().storage = { returnEveryMs: 300000 }
  t.mock.method(require('../src/capabilities/building-supplies.cjs'), 'ensure', async () => {})
  let attempts = 0
  t.mock.method(storage, 'store', async () => {
    attempts++
    throw new Error('No path to the goal.')
  })
  const issues = [],
    w = {
      bot: { inventory: { emptySlotCount: () => 0 } },
      check() {},
      progress() {},
      addIssue: (s) => issues.push(s),
    }
  await c.returnSupplies(w)
  await c.returnSupplies(w)
  assert.equal(attempts, 1)
  assert.match(issues[0], /continuing farm work/)
  assert.equal(c.recall().lastReturnAt, undefined)
  c.recall().nextSupplyAttemptAt = 0
  await c.returnSupplies(w)
  assert.equal(attempts, 2)
})
test('supply cooldown never swallows cancellation, danger, or air recovery', async (t) => {
  const a = fixture(t, 'Jerry'),
    c = a.coordination
  a.colony = { enabled: true }
  c.recall().storage = { returnEveryMs: 300000 }
  for (const error of [
    Object.assign(new Error('stop'), { code: 'CANCELLED' }),
    Object.assign(new Error('air'), { code: 'AIR_RECOVERY' }),
    Object.assign(new Error('danger'), { fatal: true }),
  ]) {
    const mock = t.mock.method(require('../src/capabilities/building-supplies.cjs'), 'ensure', async () => {
      throw error
    })
    await assert.rejects(c.returnSupplies({ check() {} }), (e) => e === error)
    assert.equal(c.recall().nextSupplyAttemptAt, undefined)
    mock.mock.restore()
  }
})

test('a missing storage location cannot acknowledge a complete layout revision', (t) => {
  const { marc } = pair(t),
    c = marc.coordination
  const locations = [
    { category: 'food', position: { x: 1, y: 64, z: 0 } },
    { category: 'tools', position: { x: 2, y: 64, z: 0 } },
  ]
  const lines = c.storageUpdates.lines(locations),
    receive = (line) => c.receive(marc.bot, 'Sam', `Marc: ${line}`)
  receive(lines[0])
  receive(lines[1])
  receive(lines[3])
  assert.equal(c.recall().storage, undefined)
  assert.equal(c.queue.length, 0)
  // The second part may arrive after the commit marker. Publication still waits
  // for all indexed parts and the expected digest.
  receive(lines[2])
  assert.deepEqual(c.recall().storage.locations, locations)
  assert.equal(c.queue.length, 1)
})

test('changed, duplicate and legacy uncounted storage fragments cannot fake completeness', (t) => {
  const { marc } = pair(t),
    c = marc.coordination
  const locations = [
    { category: 'food', position: { x: 1, y: 64, z: 0 } },
    { category: 'tools', position: { x: 2, y: 64, z: 0 } },
  ]
  const lines = c.storageUpdates.lines(locations),
    receive = (line) => c.receive(marc.bot, 'Sam', `Marc: ${line}`)
  receive(lines[0])
  receive(lines[1])
  receive(lines[1])
  receive(lines[3])
  assert.equal(c.recall().storage, undefined)
  receive(lines[2].replace('2 64 0', '3 64 0'))
  assert.equal(c.recall().storage, undefined)
  assert.equal(c.queue.length, 0)
  receive('Storage update abcdef123456 begins.')
  receive('Store food at 1 64 0.')
  receive(
    'Remember storage update abcdef123456; return surplus every 5 minutes or when nearly full.',
  )
  assert.equal(c.recall().storage, undefined)
})

test('storage fragments and ACKs are fenced by peer epoch and transport channel', (t) => {
  const { sam, marc } = pair(t),
    c = marc.coordination
  const lines = c.storageUpdates.lines([{ category: 'food', position: { x: 1, y: 64, z: 0 } }])
  c.receive(marc.bot, 'Sam', lines[0], 'whisper')
  c.receive(marc.bot, 'Sam', `Marc: ${lines[1]}`, 'chat')
  c.receive(marc.bot, 'Sam', lines[2], 'whisper')
  assert.equal(c.recall().storage, undefined)
  sam.epoch++
  c.receive(marc.bot, 'Sam', lines[1], 'whisper')
  assert.equal(c.pending.size, 0)
  assert.equal(c.recall().storage, undefined)
  const learned = (sam.coordination.recall().peers.Marc = {
    sentRevision: 'abcdef123456',
    sentEpoch: marc.epoch,
  })
  marc.epoch++
  sam.coordination.receive(sam.bot, 'Marc', 'Sam: Remembered storage update abcdef123456.')
  assert.equal(learned.ackRevision, undefined)
})

test('a full outgoing queue defers the whole storage update without recording it as sent', async (t) => {
  const { sam } = pair(t),
    c = sam.coordination
  sam.bot.chat = () => {}
  sam.colony = {
    enabled: true,
    call: async (a, action) =>
      action === 'hub_get'
        ? { position: { x: 0, y: 64, z: 0 } }
        : {
            containers: [
              { managed: true, category: 'food', position: { x: 1, y: 64, z: 0 }, slots: [] },
            ],
          },
  }
  c.recall().peers.Marc = { role: 'farmer', reportReady: true, inventoryAt: Date.now(), needs: [] }
  c.nextSend = Date.now() + 100000
  for (let i = 0; i < 63; i++) assert.equal(c.say('Marc', `Pending notice ${i}.`), true)
  await c.tick()
  assert.equal(c.queue.length, 63)
  assert.equal(c.recall().peers.Marc.sentRevision, undefined)
  assert.equal(
    c.queue.some((q) => q.message.includes('Storage update')),
    false,
  )
})

test('coordinator capability works under a new name and whisper replies stay private', async (t) => {
  const coordinator = fixture(t, 'Warehouse'),
    worker = fixture(t, 'Worker')
  coordinator.profile = {
    username: 'Warehouse',
    preferredProfession: 'storage keeper',
    capabilities: ['storageCoordinator'],
  }
  worker.profile = { username: 'Worker', preferredProfession: 'tree farmer', capabilities: [] }
  coordinator.fleet = worker.fleet = { coordinator, worker }
  const sent = []
  worker.bot.chat = (text) => sent.push({ channel: 'chat', text })
  worker.bot.whisper = (name, text) => sent.push({ channel: 'whisper', name, text })
  assert.equal(
    worker.coordination.receive(worker.bot, 'Warehouse', 'What do you do?', 'whisper'),
    true,
  )
  await worker.coordination.tick()
  assert.deepEqual(sent, [
    { channel: 'whisper', name: 'Warehouse', text: 'Warehouse: My role is tree farmer.' },
  ])
})

test('working needs follow the active skill while remembered profession remains profile identity', (t) => {
  const { marc } = pair(t)
  marc.profile = { ...marc.profile, preferredProfession: 'tree farmer' }
  marc.currentSkillNeeds = () => ({
    profession: 'farmer',
    tools: ['iron_hoe'],
    supplies: { wheat_seeds: 32 },
  })
  marc.coordination.receive(marc.bot, 'Sam', 'Marc: What do you have, and what do you need?')
  assert.equal(marc.coordination.recall().role, 'tree farmer')
  const needs = marc.coordination.queue.find((q) => q.message.includes('Needs:')).message
  assert.match(needs, /iron_hoe/)
  assert.match(needs, /wheat_seeds/)
  assert.doesNotMatch(needs, /iron_axe/)
})
