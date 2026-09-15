const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { Vec3 } = require('vec3')
const registry = require('minecraft-data')('1.21.1')
const storage = require('../src/storage/service.cjs')
const steward = require('../src/storage/steward.cjs')
const layout = require('../src/storage/warehouse-layout.cjs')
const { profileFor } = require('../src/agents/profiles.cjs')
const hub = { x: 0, y: 64, z: 0 }

test('warehouse construction follows coordinator capability even after renaming the profile', async (t) => {
  const profile = { ...profileFor('Sam'), username: 'Harper', id: 'harper' }
  const work = {
    agent: { username: 'Harper', profile },
    bot: {
      blockAt: () => ({ name: 'chest' }),
      inventory: { items: () => [{ name: 'chest', count: 2 }] },
    },
    counts: {},
    progress() {},
    sync() {},
  }
  let built = 0
  t.mock.method(storage, 'list', async () => ({ containers: [] }))
  t.mock.method(layout, 'build', async () => {
    built++
    return { left: new Vec3(0, 64, 0) }
  })
  assert.equal((await steward.expand(work, hub, 'food')).name, 'chest')
  assert.equal(built, 1)
  assert.equal(work.counts.chestsAdded, 2)
  work.agent = { username: 'Sam', profile: { ...profile, username: 'Sam', capabilities: [] } }
  await assert.rejects(steward.expand(work, hub, 'food'), /storageCoordinator/)
  assert.equal(built, 1)
})

test('warehouse labels use the authorized coordinator name and confirm the server text', async (t) => {
  const profile = { ...profileFor('Sam'), username: 'Harper', id: 'harper' }
  const position = new Vec3(0, 64, 0)
  const sign = { name: 'oak_wall_sign', position: position.offset(0, 0, 1), signText: 'Old label' }
  const bot = Object.assign(new EventEmitter(), {
    registry,
    entity: { position: position.offset(0, 0, 2) },
    inventory: { items: () => [] },
    blockAt: (p) => (p.equals(sign.position) ? sign : { name: 'chest', position }),
    setControlState() {},
    activateBlock: async (block) => bot.emit('signOpen', block),
    updateSign: (block, text) => {
      block.signText = text
    },
  })
  const work = {
    agent: { username: 'Harper', profile },
    bot,
    counts: {},
    travel: async () => {},
    timed: (fn) => fn(),
    sync() {},
    check() {},
    pause: () => assert.fail('The fake server confirms the update synchronously.'),
  }
  t.mock.method(storage, 'list', async () => ({
    containers: [{ id: 'a', managed: true, capacity: 54, category: 'food', position }],
  }))
  t.mock.method(storage, 'approach', async () => {})
  await steward.label(work, hub)
  assert.equal(steward.signText(sign), 'Colony storage\nFood\nShared by all\nHarper')
  assert.equal(work.counts.signsPlaced, 1)
  assert.equal(bot.listenerCount('signOpen'), 0)
  work.agent.profile = { ...profile, capabilities: [] }
  await assert.rejects(steward.label(work, hub), /storageCoordinator/)
})

test('storage scanning skips both pending warehouse cells without loading the construction workflow', async () => {
  const position = new Vec3(4, 64, 7),
    calls = []
  const work = {
    check() {},
    agent: {
      username: 'Harper',
      state: { world: 'test', dimension: 'overworld' },
      publish() {},
      coordination: { recall: () => ({ warehouse: { hub: { pending: { id: '4,64,7' } } } }) },
      colony: {
        scope: () => ({ session: 'test' }),
        call: async (_actor, action) => {
          calls.push(action)
          return { containers: [], jobs: [], uncertain: [] }
        },
      },
    },
    bot: {
      registry,
      findBlocks: () => [position, position.offset(1, 0, 0)],
      blockAt: (p) => ({ name: 'chest', position: p }),
    },
  }
  await storage.scan(work)
  assert.deepEqual(calls, ['list'])
  assert(
    !require.cache[require.resolve('../src/storage/service.cjs')].children.some(
      (child) => child.filename === require.resolve('../src/storage/warehouse-layout.cjs'),
    ),
  )
})
