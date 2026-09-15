const { test } = require('node:test')
const assert = require('node:assert/strict')
const { setImmediate: turn } = require('node:timers/promises')
const { fixture, Vec3 } = require('./helpers/survival-fixture.cjs')
const { Work } = require('../src/runtime/work.cjs')
const { BlockCollection } = require('../src/capabilities/block-collection.cjs')

function setup() {
  const h = fixture(), work = new Work(h.agent, 1)
  const collection = new BlockCollection(work)
  const blocks = [2, 8, 10].map(x => h.set('iron_ore', new Vec3(x, 64, 0)))
  return { ...h, work, collection, blocks }
}

test('the plugin queue deduplicates positions and reselects after movement without changing terrain settings', async () => {
  const h = setup(), order = [], movements = h.bot.pathfinder.movements
  h.bot.pathfinder.setMovements = () => assert.fail('The executor owns movement settings')
  h.bot.openChest = () => assert.fail('The executor owns storage')
  h.bot.dig = () => assert.fail('The executor owns digging')
  await h.collection.collect([...h.blocks, { ...h.blocks[0] }], {
    visit: async b => {
      order.push(b.position.x)
      h.bot.entity.position = new Vec3(10, 64, 0)
    },
  })
  assert.deepEqual(order, [2, 10, 8])
  assert.equal(h.bot.pathfinder.movements, movements)
  assert.equal(h.collection.targets.empty, true)
})

test('changed targets are skipped before invoking the skill executor', async () => {
  const h = setup(), order = []
  await h.collection.collect(h.blocks, {
    visit: async b => {
      order.push(b.position.x)
      h.set('gold_ore', h.blocks[1].position)
    },
  })
  assert.deepEqual(order, [2, 10])
})

test('batch and satisfied limits stop the queue without clearing another movement goal', async () => {
  const h = setup(), order = []
  h.bot.pathfinder.setGoal = () => assert.fail('No global stop')
  await h.collection.collect(h.blocks, { maxBlocks: 1, visit: async b => order.push(b) })
  assert.equal(order.length, 1)
  await h.collection.collect(h.blocks, { satisfied: () => true, visit: async () => assert.fail() })
  assert.equal(h.collection.targets.empty, true)
})

test('Stop before collection starts cannot execute the first target', async () => {
  const h = setup()
  const pending = h.collection.collect(h.blocks, { visit: async () => assert.fail() })
  h.work.cancel()
  await assert.rejects(pending, { code: 'CANCELLED' })
  assert.equal(h.collection.targets.empty, true)
})

test('cancellation during an executor await drains before another batch can acquire the bot', async () => {
  const h = setup()
  let release
  const visited = []
  const pending = h.collection.collect(h.blocks, {
    visit: async b => {
      visited.push(b)
      await h.work.timed(() => new Promise(resolve => { release = resolve }), 1000)
    },
  })
  await turn()
  const other = new BlockCollection(new Work(h.agent, 1))
  assert.throws(() => other.collect(h.blocks, { visit: async () => {} }), /already owns/)
  const rejected = assert.rejects(pending, { code: 'CANCELLED' })
  const cancelled = h.collection.cancelTask()
  release()
  await Promise.all([rejected, cancelled])
  assert.equal(visited.length, 1)
  assert.equal(h.agent.bot, h.bot)
  let resumed = 0
  await other.collect(h.blocks, { maxBlocks: 1, visit: async () => { resumed++ } })
  assert.equal(resumed, 1)
})

test('handoff propagates, empties the queue and does not visit another block', async () => {
  const h = setup()
  h.work.requestHandoff()
  let visited = 0
  await assert.rejects(h.collection.collect(h.blocks, {
    visit: async () => { visited++; h.work.checkpoint({ phase: 'collected' }) },
  }), { code: 'HANDOFF' })
  assert.equal(visited, 1)
  assert.equal(h.collection.targets.empty, true)
})

test('upstream vein traversal sees stable coordinate identities even with fresh block objects', () => {
  const h = setup()
  const read = h.bot.blockAt
  let reads = 0
  h.bot.blockAt = p => { reads++; const b = read(p); return { ...b, position: b.position.clone() } }
  h.set('iron_ore', new Vec3(3, 64, 0))
  const vein = h.collection.findFromVein(h.blocks[0], 32, 4)
  const positions = vein.map(b => b.position.toString())
  assert.equal(vein.length, 2)
  assert.equal(new Set(positions).size, 2)
  assert.ok(reads <= 54)
  assert.equal(h.dug.length, 0, 'Discovery never mines or navigates')
  assert.throws(() => h.collection.findFromVein(h.blocks[0], 129), /1–128/)
  assert.throws(() => h.collection.findFromVein(h.blocks[0], 32, 17), /1–16/)
})

test('an obsolete connection cannot discover or start collection', () => {
  const h = setup()
  h.agent.bot = {}
  assert.throws(() => h.collection.findFromVein(h.blocks[0]), { code: 'CANCELLED' })
  assert.throws(() => h.collection.collect(h.blocks, { visit: async () => {} }), { code: 'CANCELLED' })
})
