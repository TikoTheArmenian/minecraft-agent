const test = require('node:test')
const assert = require('node:assert/strict')
const { fixture, Vec3 } = require('./helpers/survival-fixture.cjs')
const { PumpkinFarm } = require('../src/skills/pumpkin-farm.cjs')
const { MelonFarm } = require('../src/skills/melon-farm.cjs')
const { plantable } = require('../src/capabilities/stem-farm.cjs')
const { parseSkill, skillFor } = require('../src/skills/registry.cjs')
const { reserve } = require('../src/storage/policy.cjs')
const storage = require('../src/storage/service.cjs')

function setup(Farm) {
  const f = fixture()
  const work = new Farm(f.agent, 1)
  work.approach = async p => { work.check(); f.bot.entity.position = p.offset(2, 0, 0) }
  work.pause = async () => work.check()
  work.pickup = async () => {}
  f.bot._placeBlockWithOptions = async soil => {
    const b = f.set(work.crop.block, soil.position.offset(0, 1, 0), 0)
    f.bot.heldItem.count--
    f.bot._client.emit('block_change', { location: b.position, type: b.stateId })
  }
  return { ...f, work }
}
for (const [fruit, Farm] of [['pumpkin', PumpkinFarm], ['melon', MelonFarm]]) {
  test(`${fruit}: independent registration, contract and state`, () => {
    const f = setup(Farm)
    assert.equal(parseSkill(`farm ${fruit}s`).type, `${fruit}Farm`)
    assert.equal(skillFor(`${fruit}Farm`).execution, 'continuous')
    assert.equal(f.agent.state[`${fruit}Farm`], f.work.plan)
    assert.equal(f.agent.state[fruit === 'melon' ? 'pumpkinFarm' : 'melonFarm'], undefined)
    assert.equal(f.work.task.skill, `${fruit.toUpperCase()} FARMER`)
    assert.equal(f.work.deadline, Infinity)
    assert.equal(reserve(f.add(`${fruit}_seeds`, 16), f.work), 8)
  })
  test(`${fruit}: harvest preserves attached and growing stems and leaves other crops and decorations`, async () => {
    const f = setup(Farm)
    f.set(`attached_${fruit}_stem`, new Vec3(0, 64, 0))
    f.set(fruit, new Vec3(1, 64, 0))
    f.set(`${fruit}_stem`, new Vec3(4, 64, 0), 7)
    f.set(fruit, new Vec3(5, 64, 0))
    f.set(fruit, new Vec3(10, 64, 0))
    const other = fruit === 'melon' ? 'pumpkin' : 'melon'
    f.set(`${other}_stem`, new Vec3(0, 64, 4), 7)
    f.set(other, new Vec3(1, 64, 4))
    await f.work.harvestReady(f.work.survey())
    assert.deepEqual(f.dug, [fruit, fruit])
    assert.equal(f.work.plan.stems, 2)
    assert.equal(f.work.plan.harvested, 2)
    assert.equal(f.bot.blockAt(new Vec3(0, 64, 0)).name, `attached_${fruit}_stem`)
    assert.equal(f.bot.blockAt(new Vec3(10, 64, 0)).name, fruit)
  })
  test(`${fruit}: removed stem during approach prevents digging`, async () => {
    const f = setup(Farm)
    const stem = new Vec3(0, 64, 0)
    f.set(`${fruit}_stem`, stem, 7)
    f.set(fruit, stem.offset(1, 0, 0))
    f.work.approach = async () => f.set('air', stem)
    await f.work.harvestReady(f.work.survey())
    assert.equal(f.dug.length, 0)
    assert.equal(f.work.plan.harvested, 0)
  })
  test(`${fruit}: plants irrigated soil, confirms stems and leaves fruit lanes`, async () => {
    const f = setup(Farm)
    f.add(`${fruit}_seeds`, 8)
    f.add('iron_hoe')
    f.set('water', new Vec3(0, 63, 1))
    for (const x of [0, 1, 2, 3]) f.set('dirt', new Vec3(x, 63, 0))
    await f.work.plantMore()
    assert.equal(f.work.plan.planted, 2)
    assert.equal(f.work.counts.planted, 2)
    assert.equal(f.bot.blockAt(new Vec3(0, 64, 0)).name, `${fruit}_stem`)
    assert.equal(f.bot.blockAt(new Vec3(1, 64, 0)).name, 'air')
    assert.equal(f.bot.blockAt(new Vec3(2, 64, 0)).name, `${fruit}_stem`)
    assert.equal(f.bot.blockAt(new Vec3(3, 64, 0)).name, 'air')
  })
  test(`${fruit}: converts produce into seeds without a crafting table`, async () => {
    const f = setup(Farm)
    f.add(f.work.crop.produce, 12)
    await f.work.restock()
    assert.ok(f.work.count(f.work.crop.seed) >= 8)
    assert.ok(f.crafted.every(name => name === `${fruit}_seeds`))
  })
  test(`${fruit}: stop during approach prevents harvest`, async () => {
    const f = setup(Farm)
    f.set(`${fruit}_stem`, new Vec3(0, 64, 0), 7)
    f.set(fruit, new Vec3(1, 64, 0))
    f.work.approach = async () => { f.work.cancel(); f.work.check() }
    await assert.rejects(f.work.harvestReady(f.work.survey()), /Cancelled/)
    assert.equal(f.dug.length, 0)
  })
  test(`${fruit}: growth wait is cancellable and cleans up`, async () => {
    const f = setup(Farm)
    const delays = []
    f.work.cycle = async () => {}
    f.work.pause = async ms => { delays.push(ms); f.work.cancel(); f.work.check() }
    await f.work.run()
    assert.deepEqual(delays, [20000])
    assert.equal(f.work.plan.status, 'cancelled')
    assert.equal(f.work.plan.waitingUntil, null)
    assert.equal(f.bot.listenerCount('playerCollect'), 0)
  })
}
test('planting rejects crowded fruit spaces and the other crop’s lane', () => {
  const f = setup(PumpkinFarm)
  const p = new Vec3(0, 63, 0)
  const soil = f.set('farmland', p)
  f.set('melon_stem', p.offset(1, 1, 0), 7)
  assert.equal(plantable(f.bot, soil), false)
  f.set('air', p.offset(1, 1, 0))
  for (const [x, z] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) f.set('stone', p.offset(x, 0, z))
  assert.equal(plantable(f.bot, soil), false)
})
test('seed retrieval and batch storage use shared storage, with deposit backoff', async t => {
  const f = setup(MelonFarm)
  f.agent.colony = { enabled: true }
  const originalRetrieve = storage.retrieve, originalStore = storage.store
  t.after(() => { storage.retrieve = originalRetrieve; storage.store = originalStore })
  const asks = []
  storage.retrieve = async (w, names, count) => { asks.push([names, count]); f.add('melon_seeds', count) }
  await f.work.restock()
  assert.deepEqual(asks, [[['melon_seeds'], 16]])
  let calls = 0
  storage.store = async w => { calls++; w.counts.stored = 32 }
  f.add('melon_slice', 20)
  await f.work.storeBatch()
  assert.equal(calls, 0)
  f.add('melon_slice', 30)
  await f.work.storeBatch()
  await f.work.storeBatch()
  assert.equal(calls, 1)
  assert.equal(f.work.plan.stored, 32)
})
test('full inventory leaves fruit untouched when storage is unavailable', async () => {
  const f = setup(PumpkinFarm)
  f.set('pumpkin_stem', new Vec3(0, 64, 0), 7)
  f.set('pumpkin', new Vec3(1, 64, 0))
  f.bot.inventory.emptySlotCount = () => 0
  await f.work.harvestReady(f.work.survey())
  assert.equal(f.dug.length, 0)
  assert.match(f.work.plan.blocker, /Inventory is full/)
})
test('unconfirmed planting never increments production', async () => {
  const f = setup(PumpkinFarm)
  f.set('farmland', new Vec3(0, 63, 0))
  f.set('water', new Vec3(0, 63, 1))
  f.add('pumpkin_seeds', 8)
  f.bot._placeBlockWithOptions = async () => { throw new Error('Server rejected placement') }
  await f.work.plantMore()
  assert.equal(f.work.plan.planted, 0)
  assert.equal(f.work.counts.planted, 0)
  assert.match(f.work.plan.blocker, /Server rejected placement/)
})
test('three error-only passes pause with an actionable blocker', async () => {
  const f = setup(MelonFarm)
  let passes = 0
  f.work.cycle = async () => { passes++; throw new Error('No route to farm') }
  await f.work.run()
  assert.equal(passes, 3)
  assert.equal(f.work.plan.status, 'paused')
  assert.match(f.work.plan.decision, /three passes.*No route to farm/)
})
test('pumpkin and melon produce use the food storage category', () => {
  const { category } = require('../src/storage/policy.cjs')
  const f = setup(PumpkinFarm)
  for (const name of ['pumpkin', 'pumpkin_seeds', 'melon_slice', 'melon_seeds'])
    assert.equal(category({ name }, f.bot.registry), 'food')
})
