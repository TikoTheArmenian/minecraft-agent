const test = require('node:test')
const assert = require('node:assert/strict')
const { fixture, Vec3 } = require('./helpers/survival-fixture.cjs')
const { SugarcaneFarm, groupColumns, plantable, farmNearby } = require('../src/sugarcane-farm.cjs')
const storage = require('../src/storage.cjs')
const { parse } = require('../src/agent.cjs')

// Default fixture ground is grass at y=63 with air above. Water and cane are set explicitly.
function setup() {
  const f = fixture()
  f.bot.username = 'Cane'
  f.agent.username = 'Cane'
  f.agent.state.survival = 'previous'
  const work = new SugarcaneFarm(f.agent, 1)
  work.approach = async (p) => {
    work.check()
    f.bot.entity.position = p.offset(2, 0, 0)
  }
  work.travel = async () => work.check()
  work.pause = async () => work.check()
  work.pickup = async () => {}
  // The fixture's placement does not emit a server packet; real placements do.
  const place = f.bot._placeBlockWithOptions
  f.bot._placeBlockWithOptions = async (...args) => {
    await place(...args)
    const p = args[0].position.offset(0, 1, 0)
    f.bot._client.emit('block_change', { location: p, type: f.bot.blockAt(p).stateId })
  }
  // A shoreline column: sand at y=63 beside water, cane from y=64 upward.
  f.column = (x, z, height, soil = 'sand') => {
    f.set(soil, new Vec3(x, 63, z))
    f.set('water', new Vec3(x + 1, 63, z))
    for (let y = 0; y < height; y++) f.set('sugar_cane', new Vec3(x, 64 + y, z))
    return new Vec3(x, 64, z)
  }
  return { ...f, work }
}

test('aliases start the continuous skill and keep Survival state untouched', () => {
  for (const text of ['farm sugarcane', 'sugarcane farmer', 'start sugarcane farmer', 'farm sugar cane'])
    assert.equal(parse(text).type, 'sugarcaneFarm')
  const f = setup()
  assert.equal(f.work.task.skill, 'SUGARCANE FARMER')
  assert.equal(f.work.deadline, Infinity)
  assert.equal(f.work.task.deadlineAt, null)
  assert.equal(f.work.task.continuous, true)
  assert.equal(f.agent.state.survival, 'previous')
  assert.equal(f.agent.state.sugarcaneFarm, f.work.plan)
  assert.deepEqual(f.work.reserves, { sugar_cane: 8 })
})

test('columns are grouped by base and ready only at two blocks or taller', () => {
  const f = setup()
  f.column(0, 0, 1)
  f.column(3, 0, 2)
  f.column(6, 0, 3)
  // A column whose lower block was removed: the remaining block is its own base.
  f.set('sugar_cane', new Vec3(9, 65, 0))
  const columns = groupColumns(f.bot, f.work.find(['sugar_cane']))
  assert.equal(columns.length, 4)
  const byX = Object.fromEntries(columns.map((c) => [c.base.position.x, c]))
  assert.equal(byX[0].height, 1)
  assert.equal(byX[3].height, 2)
  assert.equal(byX[6].height, 3)
  assert.equal(byX[9].base.position.y, 65)
  assert.deepEqual(
    columns.filter((c) => c.ready).map((c) => c.base.position.x).sort(),
    [3, 6],
  )
  f.work.survey()
  assert.equal(f.work.plan.columns, 4)
  assert.equal(f.work.plan.ready, 2)
})

test('harvest digs only the block above the base and keeps every base', async () => {
  const f = setup()
  const a = f.column(0, 0, 3)
  const b = f.column(4, 0, 2)
  f.column(8, 0, 1)
  const digs = []
  const dig = f.work.dig.bind(f.work)
  f.work.dig = async (p, ...rest) => {
    digs.push(p.clone())
    return dig(p, ...rest)
  }
  await f.work.harvestReady(f.work.survey())
  assert.deepEqual(
    digs.map((p) => p.toString()).sort(),
    [a.offset(0, 1, 0), b.offset(0, 1, 0)].map((p) => p.toString()).sort(),
  )
  assert.equal(f.dug.filter((n) => n === 'sugar_cane').length, 2)
  for (const base of [a, b, new Vec3(8, 64, 0)]) assert.equal(f.bot.blockAt(base).name, 'sugar_cane')
  assert.equal(f.bot.blockAt(a.offset(0, 1, 0)).name, 'air')
  assert.equal(f.work.plan.harvested, 2)
  assert.equal(f.work.counts.harvested, 2)
  assert.equal(f.work.count('sugar_cane'), 2)
})

test('a base that disappears during the approach is never dug and cools down', async () => {
  const f = setup()
  const base = f.column(0, 0, 2)
  f.work.approach = async () => {
    f.work.check()
    f.set('air', base)
  }
  await f.work.harvestReady(f.work.survey())
  assert.equal(f.dug.length, 0)
  assert.equal(f.work.plan.harvested, 0)
  assert.equal(f.work.coolingDown(base), true)
})

test('placement rules: accepted soil, water beside the soil, clear above, away from farms', () => {
  const f = setup()
  const soil = f.set('sand', new Vec3(0, 63, 0))
  assert.equal(plantable(f.bot, soil), false, 'no water yet')
  f.set('water', new Vec3(1, 63, 0))
  assert.equal(plantable(f.bot, soil), true)
  f.set('water', new Vec3(1, 63, 0))
  f.set('oak_log', new Vec3(0, 64, 0))
  assert.equal(plantable(f.bot, soil), false, 'blocked above')
  f.set('air', new Vec3(0, 64, 0))
  assert.equal(plantable(f.bot, soil), true)
  // Diagonal or vertical water does not count.
  const diagonal = f.set('dirt', new Vec3(5, 63, 5))
  f.set('water', new Vec3(6, 63, 6))
  f.set('water', new Vec3(5, 62, 5))
  assert.equal(plantable(f.bot, diagonal), false)
  // Farmland is never used and nothing is planted within three blocks of a crop field.
  const farm = f.set('farmland', new Vec3(10, 63, 0))
  f.set('water', new Vec3(11, 63, 0))
  assert.equal(plantable(f.bot, farm), false)
  const near = f.set('grass_block', new Vec3(13, 63, 0))
  f.set('water', new Vec3(14, 63, 0))
  assert.equal(farmNearby(f.bot, near.position), true)
  assert.equal(plantable(f.bot, near), false)
  const far = f.set('grass_block', new Vec3(14, 63, 0))
  f.set('water', new Vec3(15, 63, 0))
  assert.equal(plantable(f.bot, far), true)
  const stone = f.set('stone', new Vec3(20, 63, 0))
  f.set('water', new Vec3(21, 63, 0))
  assert.equal(plantable(f.bot, stone), false)
})

test('planting keeps the eight-cane reserve, confirms each placement, and prefers spots beside cane', async () => {
  const f = setup()
  f.add('sugar_cane', 11)
  f.column(0, 0, 1)
  for (const x of [-1, 5, 9, 13]) {
    f.set('sand', new Vec3(x, 63, 0))
    f.set('water', new Vec3(x, 63, 1))
  }
  f.bot.entity.position = new Vec3(9, 64, -3)
  const order = []
  const plant = f.work.plantCane.bind(f.work)
  f.work.plantCane = async (soil) => {
    order.push(soil.position.x)
    return plant(soil)
  }
  await f.work.plantMore()
  assert.equal(f.work.count('sugar_cane'), 8)
  assert.equal(f.work.plan.planted, 3)
  assert.equal(f.placed.filter((n) => n === 'sugar_cane').length, 3)
  assert.equal(order[0], -1, 'the spot touching the existing column comes first')
  assert.equal(f.bot.blockAt(new Vec3(-1, 64, 0)).name, 'sugar_cane')
  assert.equal(f.bot.blockAt(new Vec3(-1, 63, 0)).name, 'sand')
  assert.equal(f.bot.blockAt(new Vec3(1, 63, 0)).name, 'water')
  // At the reserve nothing more is planted even though spots remain.
  await f.work.plantMore()
  assert.equal(f.work.plan.planted, 3)
  assert.match(f.work.plan.expansion, /reserve/)
})

test('an unconfirmed placement is not counted', async () => {
  const f = setup()
  f.add('sugar_cane', 12)
  f.set('sand', new Vec3(3, 63, 0))
  f.set('water', new Vec3(4, 63, 0))
  f.bot._placeBlockWithOptions = async () => {}
  f.work.timed = async (fn) => fn()
  await f.work.plantMore()
  assert.equal(f.work.plan.planted, 0)
  assert.equal(f.work.counts.planted, 0)
  assert.ok(f.work.issues.some((i) => /not confirm|Plant sugar cane/.test(i)))
})

test('storage: batch or inventory pressure triggers a shared deposit; small stock does not', async (t) => {
  const f = setup()
  const original = storage.store
  let calls = 0
  storage.store = async (w) => {
    calls++
    w.counts.stored = (w.counts.stored || 0) + 32
    return 32
  }
  t.after(() => {
    storage.store = original
  })
  f.agent.colony = { enabled: true }
  f.add('sugar_cane', 20)
  await f.work.storeBatch()
  assert.equal(calls, 0)
  f.add('sugar_cane', 20)
  await f.work.storeBatch()
  assert.equal(calls, 1)
  assert.equal(f.work.plan.stored, 32)
  f.items.find((i) => i.name === 'sugar_cane').count = 5
  f.bot.inventory.emptySlotCount = () => 3
  await f.work.storeBatch()
  assert.equal(calls, 2)
})

test('storage: a deposit that moves nothing is an obstacle, not a stored count', async (t) => {
  const f = setup()
  const original = storage.store
  storage.store = async () => 0
  t.after(() => {
    storage.store = original
  })
  f.agent.colony = { enabled: true }
  f.add('sugar_cane', 64)
  await f.work.storeBatch()
  assert.equal(f.work.plan.stored, 0)
  assert.match(f.work.plan.blocker, /No managed chest/)
})

test('colony disabled: no storage calls and the decision says so', async (t) => {
  const f = setup()
  const original = storage.store
  storage.store = async () => assert.fail('must not touch storage without a colony')
  t.after(() => {
    storage.store = original
  })
  f.add('sugar_cane', 64)
  await f.work.storeBatch()
  assert.match(f.work.plan.storage, /disabled/)
})

test('low planting stock asks shared storage for sugar cane before waiting', async (t) => {
  const f = setup()
  const original = storage.retrieve
  const asked = []
  storage.retrieve = async (w, names, target) => {
    asked.push([names, target])
    f.add('sugar_cane', 10)
    w.counts.retrieved = 10
    return 10
  }
  t.after(() => {
    storage.retrieve = original
  })
  f.agent.colony = { enabled: true }
  f.add('sugar_cane', 2)
  f.set('sand', new Vec3(3, 63, 0))
  f.set('water', new Vec3(4, 63, 0))
  await f.work.plantMore()
  assert.deepEqual(asked, [[['sugar_cane'], 16]])
  assert.equal(f.work.plan.planted, 1)
  assert.equal(f.work.count('sugar_cane'), 11)
})

test('cycle order: harvest, plant, store, then the supply checkpoint', async () => {
  const f = setup()
  const events = []
  f.work.harvestReady = async () => events.push('harvest')
  f.work.plantMore = async () => events.push('plant')
  f.work.storeBatch = async () => events.push('store')
  f.agent.coordination = { returnSupplies: async () => events.push('checkpoint') }
  await f.work.cycle()
  assert.deepEqual(events, ['harvest', 'plant', 'store', 'checkpoint'])
  assert.equal(f.work.plan.cycles, 1)
})

test('idle passes wait 20 seconds for growth; productive passes continue promptly', async () => {
  const f = setup()
  const delays = []
  let pass = 0
  f.work.cycle = async () => {
    if (++pass === 2) f.work.counts.harvested++
  }
  f.work.pause = async (ms) => {
    delays.push(ms)
    if (delays.length === 2) f.work.cancel()
    f.work.check()
  }
  await f.work.run()
  assert.deepEqual(delays, [20000, 1000])
  assert.equal(f.work.plan.status, 'cancelled')
  assert.equal(f.work.task.status, 'cancelled')
  assert.equal(f.work.plan.waitingUntil, null)
})

test('Stop during a cycle cancels the loop without a failure status', async () => {
  const f = setup()
  let cycles = 0
  f.work.cycle = async () => {
    cycles++
    f.work.cancel()
    f.work.check()
  }
  await f.work.run()
  assert.equal(cycles, 1)
  assert.equal(f.work.plan.status, 'cancelled')
  assert.equal(f.work.task.status, 'cancelled')
})

test('Stop while approaching a column stops before any dig', async () => {
  const f = setup()
  f.column(0, 0, 2)
  f.work.approach = async () => {
    f.work.cancel()
    f.work.check()
  }
  await assert.rejects(f.work.harvestReady(f.work.survey()), /Cancelled/)
  assert.equal(f.dug.length, 0)
})

test('three consecutive error-only passes pause the task with the blocker', async () => {
  const f = setup()
  let passes = 0
  f.work.cycle = async () => {
    passes++
    throw new Error('No route to the shoreline')
  }
  f.work.pause = async () => f.work.check()
  await f.work.run()
  assert.equal(f.work.plan.status, 'paused')
  assert.equal(f.work.task.status, 'partial')
  assert.match(f.work.plan.decision, /three passes.*No route/)
  assert.equal(passes, 3)
})

test('error passes reset once a pass makes confirmed progress', async () => {
  const f = setup()
  let pass = 0
  f.work.cycle = async () => {
    pass++
    if (pass % 3 === 0) {
      f.work.counts.planted++
      return
    }
    throw new Error('Blocked spot')
  }
  f.work.pause = async () => {
    if (pass >= 7) f.work.cancel()
    f.work.check()
  }
  await f.work.run()
  assert.equal(f.work.plan.status, 'cancelled')
  assert.equal(pass, 7)
})

test('wording never names Marc and Survival mode is required', () => {
  const f = setup()
  f.work.addIssue('Give Marc a tool.')
  assert.ok(f.work.issues.at(-1).includes('Cane'))
  f.bot.health = 3
  assert.match(f.work.safety(), /Cane/)
  f.bot.health = 20
  f.bot.game.gameMode = 'creative'
  assert.throws(() => f.work.check(), /Cane left Survival mode/)
})
