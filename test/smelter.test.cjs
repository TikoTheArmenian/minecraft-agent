const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { Vec3 } = require('vec3')
const registry = require('minecraft-data')('1.21.1')
const Item = require('prismarine-item')(registry)
const { describe } = require('../src/storage/policy.cjs')
const { stocks } = require('../src/storage/crafting.cjs')
const storage = require('../src/storage/service.cjs')
const { loadJson } = require('../src/infra/json-store.cjs')
const { ResourceLeases } = require('../src/runtime/resource-leases.cjs')
const { parse } = require('../src/agents/agent.cjs')
const {
  Smelter,
  parseSmelter,
  chooseBatches,
  fuelPlan,
  fuelValue,
  outputOf,
  placeFurnace,
  LOG_FLOOR,
} = require('../src/skills/smelter.cjs')
const item = (name, count = 1, slot = 0) =>
  Object.assign(new Item(registry.itemsByName[name].id, count), { slot })
function checkpointDirectory(t) {
  const fs = require('node:fs'),
    path = require('node:path')
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'smelter-checkpoint-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return { dir, file: path.join(dir, 'smelter-jobs.json') }
}
const ironJob = (extra = {}) => ({
  key: '1,64,0',
  position: { x: 1, y: 64, z: 0 },
  input: 'raw_iron',
  output: 'iron_ingot',
  count: 8,
  fuel: [{ name: 'coal', count: 1 }],
  collected: 0,
  startedAt: Date.now() - 100000,
  lastOpenAt: 0,
  state: 'active',
  ...extra,
})

test('parser accepts supported inputs and bounded quantities; bare aliases mean continuous mode', () => {
  assert.deepEqual(parseSmelter('smelt raw_iron 16'), {
    type: 'smelter',
    item: 'raw_iron',
    quantity: 16,
  })
  assert.equal(parseSmelter('smelt oak_log 8').item, 'oak_log')
  assert.equal(parseSmelter('farm wheat'), null)
  assert.throws(() => parseSmelter('smelt diamond 4'), /supported input/)
  assert.throws(() => parseSmelter('smelt raw_iron 0'), /1–256/)
  assert.throws(() => parseSmelter('smelt raw_iron 257'), /1–256/)
  assert.deepEqual(parse('smelt'), { type: 'smelter' })
  assert.deepEqual(parse('start smelter'), { type: 'smelter' })
  assert.equal(parse('smelt sand 12').quantity, 12)
  for (const [input, output] of Object.entries(require('../src/skills/smelter.cjs').SMELTABLES)) {
    assert(registry.itemsByName[input], input)
    assert(registry.itemsByName[output], output)
  }
  assert.equal(outputOf('stripped_birch_log'), 'charcoal')
  assert.equal(outputOf('iron_ingot'), null)
})
test('batch selection uses reserve-adjusted stock from fresh managed chests and prefers ores', () => {
  const chest = (id, slots, extra = {}) => ({
    id,
    position: { x: 0, y: 64, z: 0 },
    managed: true,
    checked_at: new Date().toISOString(),
    slots: slots.map((i) => describe(i)),
    ...extra,
  })
  const rawIron = item('raw_iron', 40)
  const w = {
    bot: {
      registry,
      inventory: { items: () => [item('cobblestone', 20), item('oak_log', 10)] },
      entity: { position: new Vec3(0, 64, 0) },
    },
    origin: new Vec3(0, 64, 0),
    reserves: { coal: 16, charcoal: 16, cobblestone: 0 },
  }
  const data = {
    containers: [
      chest('a', [rawIron, item('sand', 30), item('oak_log', 40)]),
      chest('stale', [item('raw_gold', 64)], { checked_at: '2000-01-01' }),
      chest('private', [item('raw_copper', 64)], { managed: false }),
    ],
    reservations: [{ container: 'a', fingerprint: describe(rawIron).fingerprint, quantity: 10 }],
  }
  const stock = stocks(w, data)
  assert.equal(stock.shared.raw_iron, 30)
  assert.equal(stock.shared.raw_gold, undefined)
  assert.equal(
    stock.carry.cobblestone,
    0,
    'the shared building reserve protects carried cobblestone',
  )
  const batches = chooseBatches(stock, { registry })
  assert.deepEqual(
    batches.map((b) => [b.input, b.output, b.count]),
    [
      ['raw_iron', 'iron_ingot', 30],
      ['sand', 'glass', 30],
      ['oak_log', 'charcoal', 10 + 40 - LOG_FLOOR],
    ],
  )
  // Logs come last and shared logs keep a floor for chests and tools; carried logs are fully usable.
  const logs = chooseBatches({ carry: { oak_log: 10 }, shared: { oak_log: 40 } })
  assert.deepEqual(logs, [{ input: 'oak_log', output: 'charcoal', count: 10 + 40 - LOG_FLOOR }])
  const oneOff = chooseBatches(
    { carry: {}, shared: { raw_iron: 200, sand: 64 } },
    { only: 'raw_iron', limit: 150 },
  )
  assert.deepEqual(
    oneOff.map((b) => b.count),
    [64, 64, 22],
  )
  assert.deepEqual(chooseBatches({ carry: { iron_ingot: 9, diamond: 3 }, shared: {} }), [])
})
test('fuel arithmetic: coal first, one coal per eight smelts, partial coverage shrinks the batch', () => {
  assert.equal(fuelValue('coal'), 8)
  assert.equal(fuelValue('spruce_planks'), 1.5)
  assert.equal(fuelValue('lava_bucket'), 0)
  assert.deepEqual(fuelPlan(16, { coal: 5 }), { items: [{ name: 'coal', count: 2 }], covers: 16 })
  assert.deepEqual(fuelPlan(17, { coal: 5 }), { items: [{ name: 'coal', count: 3 }], covers: 17 })
  assert.deepEqual(fuelPlan(64, { coal: 3, charcoal: 10 }), {
    items: [
      { name: 'coal', count: 3 },
      { name: 'charcoal', count: 5 },
    ],
    covers: 64,
  })
  assert.deepEqual(fuelPlan(20, { coal: 1, oak_planks: 4 }), {
    items: [
      { name: 'coal', count: 1 },
      { name: 'oak_planks', count: 4 },
    ],
    covers: 14,
  })
  assert.deepEqual(fuelPlan(3, { coal_block: 2, coal: 1 }).items, [{ name: 'coal', count: 1 }])
  assert.deepEqual(fuelPlan(8, {}), { items: [], covers: 0 })
})
// A fake world with furnaces whose windows mirror the bot's inventory in the player slot range.
function fixture(t, dataDir = null) {
  const inventory = []
  const add = (name, count) => {
    let i = inventory.find((i) => i.name === name && i.count > 0)
    if (!i) {
      i = item(name, 0, 9 + inventory.length)
      inventory.push(i)
    }
    i.count += count
    return i
  }
  const remove = (type, count) => {
    for (const i of inventory) {
      if (i.type !== type || count <= 0) continue
      const take = Math.min(i.count, count)
      i.count -= take
      count -= take
    }
    if (count) throw new Error('not enough items')
  }
  const items = () => inventory.filter((i) => i.count > 0)
  const furnaces = new Map()
  const blocks = new Map()
  const key = (p) => `${p.x},${p.y},${p.z}`
  const chestBlock = (p) => ({
    name: 'chest',
    position: p,
    getProperties: () => ({ type: 'single', facing: 'north' }),
  })
  function furnace(p, contents = {}, lit = false) {
    const f = {
      position: p,
      lit,
      opened: 0,
      closed: 0,
      hang: false,
      in: contents.input || null,
      fuel: contents.fuel || null,
      out: contents.output || null,
    }
    const window = {
      inventoryStart: 3,
      inventoryEnd: 39,
      get slots() {
        const s = Array(39).fill(null)
        s[0] = f.in
        s[1] = f.fuel
        s[2] = f.out
        items().forEach((i, n) => (s[3 + n] = i))
        return s
      },
      inputItem() {
        return f.in
      },
      fuelItem() {
        return f.fuel
      },
      outputItem() {
        return f.out
      },
      close() {
        f.closed++
      },
      async putInput(type, meta, count) {
        remove(type, count)
        f.in = f.in ? Object.assign(f.in, { count: f.in.count + count }) : new Item(type, count)
      },
      async putFuel(type, meta, count) {
        remove(type, count)
        f.fuel = f.fuel
          ? Object.assign(f.fuel, { count: f.fuel.count + count })
          : new Item(type, count)
      },
      async takeOutput() {
        if (f.hang) return new Promise(() => {})
        add(f.out.name, f.out.count)
        f.out = null
      },
      async takeInput() {
        add(f.in.name, f.in.count)
        f.in = null
      },
      async takeFuel() {
        add(f.fuel.name, f.fuel.count)
        f.fuel = null
      },
    }
    f.window = window
    furnaces.set(key(p), f)
    blocks.set(key(p), {
      name: 'furnace',
      position: p,
      getProperties: () => ({ lit: f.lit, facing: 'north' }),
    })
    return f
  }
  const bot = Object.assign(new EventEmitter(), {
    registry,
    _client: new EventEmitter(),
    game: { gameMode: 'survival' },
    health: 20,
    oxygenLevel: 20,
    entities: {},
    entity: { position: new Vec3(0.5, 64, 0.5), isInLava: false },
    inventory: { items, emptySlotCount: () => 20 },
    blockAt: (p) =>
      blocks.get(key(p)) || {
        name: p.y < 64 ? 'dirt' : 'air',
        position: p,
        getProperties: () => ({}),
      },
    findBlocks: ({ matching, maxDistance = 32, count = 64, point = bot.entity.position }) =>
      [...blocks.values()]
        .filter((b) =>
          typeof matching === 'function' ? matching(b) : b.name === registry.blocks[matching]?.name,
        )
        .filter((b) => b.position.distanceTo(point) <= maxDistance)
        .sort((a, b) => a.position.distanceTo(point) - b.position.distanceTo(point))
        .slice(0, count)
        .map((b) => b.position),
    async openFurnace(block) {
      const f = furnaces.get(key(block.position))
      f.opened++
      return f.window
    },
    pathfinder: { setMovements() {}, setGoal() {} },
    clearControlStates() {},
    stopDigging() {},
    async equip() {},
    async placeBlock() {},
  })
  const agent = {
    username: 'Forge',
    dataDir,
    bot,
    nav: 1,
    baseMovements: null,
    state: { connection: 'ready', task: { status: 'running' }, messages: [] },
    colony: { enabled: false, scope: () => ({ session: 'test' }) },
    publish() {},
    refresh() {},
    log() {},
    say(text) {
      this.state.messages.push(text)
    },
    disconnect() {
      this.state.connection = 'disconnected'
    },
  }
  const work = new Smelter(agent, 1)
  work.deadline = Infinity
  t.mock.method(storage, 'approach', async () => {})
  return { bot, agent, work, add, items, furnace, blocks, chestBlock, key }
}
test('active furnace jobs are persisted per world and reclaimed by the next run', async (t) => {
  const dir = require('node:fs').mkdtempSync(
    require('node:path').join(require('node:os').tmpdir(), 'smelter-'),
  )
  const { work, furnace, add } = fixture(t, dir)
  add('raw_iron', 8)
  add('coal', 2)
  const f = furnace(new Vec3(1, 64, 0))
  const [slot] = await work.acquireFurnaces(1)
  await work.load(slot, {
    input: 'raw_iron',
    output: 'iron_ingot',
    count: 8,
    fuel: [{ name: 'coal', count: 1 }],
  })
  const saved = loadJson(require('node:path').join(dir, 'smelter-jobs.json')).data
  assert.equal(saved['undefined:undefined'][0].key, '1,64,0')
  assert.equal(saved['undefined:undefined'][0].count, 8)
  // A new controller after Stop/reconnect sees the job and collects it instead of treating the furnace as foreign.
  const next = fixture(t, dir)
  next.furnace(new Vec3(1, 64, 0), { output: item('iron_ingot', 8) })
  assert.equal(next.work.active.length, 1)
  f.in = null
  const produced = await next.work.waitForFurnaces()
  assert.deepEqual(produced, { total: 8, outputs: { iron_ingot: 8 }, inputs: { raw_iron: 8 } })
  assert.equal(next.work.active.length, 0)
  assert.deepEqual(
    loadJson(require('node:path').join(dir, 'smelter-jobs.json')).data['undefined:undefined'],
    [],
  )
})
test('furnace selection skips lit and occupied furnaces without loading them', async (t) => {
  const { work, furnace } = fixture(t)
  const lit = furnace(
    new Vec3(1, 64, 0),
    { input: item('raw_iron', 4), fuel: item('coal', 1) },
    true,
  )
  const occupied = furnace(new Vec3(2, 64, 0), { output: item('glass', 3) })
  const empty = furnace(new Vec3(3, 64, 0))
  const usable = await work.acquireFurnaces(3)
  assert.deepEqual(
    usable.map((f) => f.key),
    ['3,64,0'],
  )
  assert.equal(lit.opened, 0)
  assert.equal(occupied.opened, 1)
  assert.equal(occupied.closed, 1)
  assert.equal(empty.closed, 1)
  assert.equal(work.furnaces.get('1,64,0').state, 'occupied')
  assert.equal(work.furnaces.get('2,64,0').state, 'occupied')
  assert.equal(work.plan.furnaces.length, 3)
  // No furnace at all and no way to get one: the cycle waits instead of inventing one.
  const { work: bare } = fixture(t)
  assert.deepEqual(await bare.acquireFurnaces(1), [])
  assert.match(bare.plan.decision, /Waiting for a furnace/)
})
test('loading and collecting are confirmed against furnace slots and inventory deltas', async (t) => {
  const { work, furnace, add, items } = fixture(t)
  add('raw_iron', 20)
  add('coal', 16)
  const f = furnace(new Vec3(1, 64, 0))
  const [slot] = await work.acquireFurnaces(1)
  await work.load(slot, {
    input: 'raw_iron',
    output: 'iron_ingot',
    count: 12,
    fuel: [{ name: 'coal', count: 2 }],
  })
  assert.equal(f.in.count, 12)
  assert.equal(f.fuel.count, 2)
  assert.equal(items().find((i) => i.name === 'raw_iron').count, 8)
  assert.equal(work.active.length, 1)
  assert.equal(work.active[0].count, 12)
  assert.equal(work.plan.active[0].input, 'raw_iron')
  assert.equal(f.closed, 2)
  // The server has produced some output: collect it, keep the job running.
  f.in.count = 4
  f.out = item('iron_ingot', 8)
  f.lit = true
  let result = await work.collect(work.active[0])
  assert.deepEqual(result, { taken: 8, done: false })
  assert.equal(items().find((i) => i.name === 'iron_ingot').count, 8)
  assert.equal(work.plan.smelted.iron_ingot, 8)
  // Finished: remaining output and leftover fuel come back, the job is done.
  f.in = null
  f.out = item('iron_ingot', 4)
  result = await work.collect(work.active[0])
  assert.deepEqual(result, { taken: 4, done: true })
  assert.equal(items().find((i) => i.name === 'iron_ingot').count, 12)
  assert.equal(items().find((i) => i.name === 'coal').count, 16)
  assert.equal(f.fuel, null)
  assert.equal(work.counts.smelted, 12)
  // Someone else's items in the furnace are never taken.
  f.out = item('glass', 2)
  await assert.rejects(work.collect(work.active[0]), /another worker/)
  assert.equal(f.out.count, 2)
})
test('cancellation while waiting on a furnace closes the window and takes nothing', async (t) => {
  const { work, furnace, agent } = fixture(t)
  const f = furnace(new Vec3(1, 64, 0), {
    input: item('raw_iron', 2),
    output: item('iron_ingot', 6),
  })
  f.hang = true
  const job = {
    key: '1,64,0',
    position: { x: 1, y: 64, z: 0 },
    input: 'raw_iron',
    output: 'iron_ingot',
    count: 8,
    fuel: [{ name: 'coal', count: 1 }],
    collected: 0,
    startedAt: Date.now(),
    lastOpenAt: 0,
  }
  work.active.push(job)
  const pending = work.collect(job)
  await new Promise((r) => setTimeout(r, 50))
  work.cancel()
  await assert.rejects(pending, (e) => e.code === 'CANCELLED')
  assert.equal(f.closed, 1)
  assert.equal(work.plan.smelted.iron_ingot, undefined)
  assert.equal(agent.state.task.action.status, 'cancelled')
  // A window that opens only after Stop is closed as well.
  const { work: late, furnace: lateFurnace } = fixture(t)
  const g = lateFurnace(new Vec3(2, 64, 0))
  late.bot.openFurnace = () => new Promise((resolve) => setTimeout(() => resolve(g.window), 100))
  const opening = late.open(g.position)
  await new Promise((r) => setTimeout(r, 20))
  late.cancel()
  await assert.rejects(opening, (e) => e.code === 'CANCELLED')
  await new Promise((r) => setTimeout(r, 150))
  assert.equal(g.closed, 1)
})
test('output is deposited with the produced fingerprint and count before surplus storage', async (t) => {
  const { work, agent, add } = fixture(t)
  agent.colony.enabled = true
  const ingots = add('iron_ingot', 12)
  add('coal', 10)
  work.plan.smelted = { iron_ingot: 12 }
  const calls = []
  t.mock.method(storage, 'store', async (w, only) => {
    calls.push(only)
    if (only) ingots.count -= only.count
    return only ? only.count : 0
  })
  let returned = 0
  agent.coordination = {
    returnSupplies: async (w) => {
      assert.equal(w, work)
      returned++
    },
  }
  await work.storeOutput()
  assert.deepEqual(calls[0], { fingerprint: describe(item('iron_ingot')).fingerprint, count: 12 })
  assert.equal(calls[1], undefined)
  assert.equal(calls.length, 2)
  assert.equal(work.plan.stored, 12)
  assert.equal(returned, 1)
})
test('furnace placement stays within the hub and two blocks away from every chest', async (t) => {
  const { work, bot, blocks, chestBlock, add, key } = fixture(t)
  add('furnace', 1)
  const hub = { x: 0, y: 64, z: 0 }
  blocks.set(key(new Vec3(0, 64, 0)), chestBlock(new Vec3(0, 64, 0)))
  blocks.set(key(new Vec3(1, 64, 0)), chestBlock(new Vec3(1, 64, 0)))
  for (let x = -6; x <= 6; x++)
    for (let z = -6; z <= 6; z++)
      if (!blocks.has(key(new Vec3(x, 64, z))))
        blocks.set(key(new Vec3(x, 63, z)), {
          name: 'grass_block',
          position: new Vec3(x, 63, z),
          getProperties: () => ({}),
        })
  work.approach = async (p) => {
    bot.entity.position = p.offset(2.5, 1, 0.5)
  }
  let placedAt = null
  bot.placeBlock = async (support) => {
    placedAt = support.position.offset(0, 1, 0)
    blocks.set(key(placedAt), {
      name: 'furnace',
      position: placedAt,
      getProperties: () => ({ lit: false }),
    })
    bot._client.emit('block_change', {
      location: placedAt,
      type: registry.blocksByName.furnace.minStateId,
    })
  }
  const block = await placeFurnace(work, hub)
  assert.equal(block.name, 'furnace')
  assert(
    placedAt.distanceTo(new Vec3(0, 64, 0)) >= 2 && placedAt.distanceTo(new Vec3(1, 64, 0)) >= 2,
  )
  assert(placedAt.distanceTo(new Vec3(hub.x, hub.y, hub.z)) <= 8)
  assert.equal(bot._client.listenerCount('block_change'), 0)
})
test('Stop after loading preserves active ownership before the first cancellable wait', async (t) => {
  const { dir, file } = checkpointDirectory(t),
    { work, furnace, add } = fixture(t, dir)
  add('raw_iron', 8)
  add('coal', 1)
  const f = furnace(new Vec3(1, 64, 0))
  t.mock.method(work, 'pause', async () => {
    work.cancel()
    work.check()
  })
  await assert.rejects(work.load({ key: '1,64,0', position: f.position }, ironJob()), {
    code: 'CANCELLED',
  })
  const [saved] = loadJson(file).data['undefined:undefined']
  assert.equal(saved.state, 'active')
  assert.equal(saved.pending, null)
  assert.equal(saved.count, 8)
  assert.equal(f.in.count, 8)
  assert.equal(f.fuel.count, 1)
  assert.equal(f.closed, 1)
})
test('a stopped input transfer is reconciled from saved intent without replaying the write', async (t) => {
  const { dir, file } = checkpointDirectory(t),
    first = fixture(t, dir)
  first.add('raw_iron', 8)
  first.add('coal', 1)
  const f = first.furnace(new Vec3(1, 64, 0)),
    putInput = f.window.putInput.bind(f.window)
  t.mock.method(f.window, 'putInput', async (...args) => {
    await putInput(...args)
    first.work.cancel()
  })
  await assert.rejects(first.work.load({ key: '1,64,0', position: f.position }, ironJob()), {
    code: 'CANCELLED',
  })
  assert.equal(loadJson(file).data['undefined:undefined'][0].pending.kind, 'putInput')
  const operationId = loadJson(file).data['undefined:undefined'][0].pending.id
  assert.match(operationId, /^[a-zA-Z0-9_-]{1,128}$/)
  assert.deepEqual(first.work.outstandingOperationIds, [operationId])
  assert.equal(first.work.effects.length, 0, 'a cancelled unconfirmed transfer is not an effect')
  const next = fixture(t, dir)
  next.add('coal', 1)
  const resumed = next.furnace(f.position, { input: item('raw_iron', 8) })
  t.mock.method(resumed.window, 'putInput', async () => {
    assert.fail('reconciliation must not replay input writes')
  })
  const recovery = await next.work.reconcile(next.work.active[0])
  assert.deepEqual(recovery, { taken: 0, empty: false })
  assert.equal(loadJson(file).data['undefined:undefined'][0].pending, null)
  assert.equal(next.work.active[0].state, 'active')
  assert.equal(resumed.in.count, 8)
  assert.deepEqual(next.work.outstandingOperationIds, [])
  assert.equal(next.work.effects[0].operationId, operationId)
  assert.equal(next.work.effects[0].action, 'putInput')
  assert.equal(next.work.effects[0].count, 8)
})
test('an ambiguous partial transfer stays quarantined across restart', async (t) => {
  const { dir, file } = checkpointDirectory(t),
    first = fixture(t, dir)
  first.add('raw_iron', 8)
  first.add('coal', 1)
  const f = first.furnace(new Vec3(1, 64, 0)),
    putInput = f.window.putInput.bind(f.window)
  t.mock.method(f.window, 'putInput', async (type, meta) => {
    await putInput(type, meta, 4)
    first.work.cancel()
  })
  await assert.rejects(first.work.load({ key: '1,64,0', position: f.position }, ironJob()), {
    code: 'CANCELLED',
  })
  const next = fixture(t, dir)
  next.add('raw_iron', 4)
  next.add('coal', 1)
  const resumed = next.furnace(f.position, { input: item('raw_iron', 4) })
  await assert.rejects(next.work.reconcile(next.work.active[0]), {
    code: 'REQUIRES_RECONCILIATION',
  })
  assert.equal(resumed.in.count, 4)
  assert.equal(loadJson(file).data['undefined:undefined'][0].pending.count, 8)
  assert.equal(next.work.active.length, 1)
})
test('critical checkpoint failure prevents furnace writes and corrupt files are never discarded', async (t) => {
  const fs = require('node:fs'),
    { dir, file } = checkpointDirectory(t),
    { work, furnace, add } = fixture(t, dir)
  add('raw_iron', 8)
  add('coal', 1)
  const f = furnace(new Vec3(1, 64, 0))
  t.mock.method(fs, 'renameSync', () => {
    throw new Error('disk unavailable')
  })
  await assert.rejects(work.load({ key: '1,64,0', position: f.position }, ironJob()), {
    code: 'CHECKPOINT_WRITE_FAILED',
  })
  assert.equal(f.in, null)
  assert.equal(work.count('raw_iron'), 8)
  fs.writeFileSync(file, '{broken')
  assert.throws(() => fixture(t, dir), { code: 'CHECKPOINT_CORRUPT' })
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken')
})
test('reclaimed iron output cannot complete a new sand request', async (t) => {
  const { work, furnace, agent } = fixture(t)
  furnace(new Vec3(1, 64, 0), { output: item('iron_ingot', 8) })
  work.active.push(ironJob())
  await work.run({ type: 'smelter', item: 'sand', quantity: 8 })
  assert.equal(agent.state.task.status, 'partial')
  assert.deepEqual(work.plan.smelted, { iron_ingot: 8 })
  assert.match(agent.state.messages.at(-1), /smelted 0\/8 sand/)
  assert.equal(
    agent.state.messages.some((message) => /Smelted 8 sand/.test(message)),
    false,
  )
})
test('one-off smelting continues after a fuel bootstrap that produced none of the requested item', async (t) => {
  const { work, agent } = fixture(t)
  let cycles = 0
  t.mock.method(work, 'cycle', async () => ({ worked: true, produced: ++cycles === 1 ? 0 : 8 }))
  await work.run({ type: 'smelter', item: 'raw_iron', quantity: 8 })
  assert.equal(cycles, 2)
  assert.equal(agent.state.task.status, 'succeeded')
})
test('two local smelters cannot load one furnace, including while its owner is stopped', async (t) => {
  const first = fixture(t),
    second = fixture(t),
    resources = new ResourceLeases()
  first.work.resources = second.work.resources = resources
  second.work.resourceOwner = { agentId: 'OtherForge', runId: 1 }
  first.add('raw_iron', 8)
  first.add('coal', 1)
  const f = first.furnace(new Vec3(1, 64, 0)),
    other = second.furnace(f.position)
  await first.work.load({ key: '1,64,0', position: f.position }, ironJob())
  await assert.rejects(second.work.open(f.position), { code: 'RESOURCE_BUSY' })
  first.work.cancel()
  first.work.releaseResources()
  await assert.rejects(second.work.open(f.position), { code: 'RESOURCE_BUSY' })
  assert.equal(other.opened, 0)
})
test('mixed fuel stays carried until the single furnace fuel slot is free', async (t) => {
  const { work, furnace, add } = fixture(t)
  add('raw_iron', 16)
  add('coal', 1)
  add('charcoal', 1)
  const f = furnace(new Vec3(1, 64, 0))
  await work.load(
    { key: '1,64,0', position: f.position },
    {
      input: 'raw_iron',
      output: 'iron_ingot',
      count: 16,
      fuel: [
        { name: 'coal', count: 1 },
        { name: 'charcoal', count: 1 },
      ],
    },
  )
  assert.equal(f.fuel.name, 'coal')
  assert.equal(work.count('charcoal'), 1)
  f.in.count = 8
  f.out = item('iron_ingot', 8)
  f.fuel = null
  await work.collect(work.active[0])
  assert.equal(f.fuel.name, 'charcoal')
  assert.equal(work.count('charcoal'), 0)
})
test('unexpected extra matching output is refused before taking another worker’s items', async (t) => {
  const { work, furnace } = fixture(t)
  const f = furnace(new Vec3(1, 64, 0), { output: item('iron_ingot', 16) })
  work.active.push(ironJob())
  await assert.rejects(work.collect(work.active[0]), { code: 'REQUIRES_RECONCILIATION' })
  assert.equal(f.out.count, 16)
  assert.equal(work.count('iron_ingot'), 0)
})
test('HANDOFF yields after closing the furnace and persisting ownership, preserving its reason', async (t) => {
  const { dir, file } = checkpointDirectory(t),
    { work, furnace, add, agent } = fixture(t, dir)
  add('raw_iron', 8)
  add('coal', 1)
  const f = furnace(new Vec3(1, 64, 0))
  t.mock.method(work, 'cycle', async () =>
    work.load({ key: '1,64,0', position: f.position }, ironJob()),
  )
  work.checkpoint = (data) => {
    assert.equal(data.phase, 'loaded')
    assert.equal(f.closed, 1)
    assert.equal(loadJson(file).data['undefined:undefined'][0].state, 'active')
    throw Object.assign(new Error('Switching skills at a safe checkpoint.'), { code: 'HANDOFF' })
  }
  await assert.rejects(work.run({ type: 'smelter', item: 'raw_iron', quantity: 8 }), {
    code: 'HANDOFF',
  })
  assert.equal(agent.state.task.status, 'cancelled')
  assert.equal(agent.state.task.reasonCode, 'HANDOFF')
  assert.equal(work.active.length, 1)
  assert.equal(work.resources.records.values().next().value.retained, true)
  assert.deepEqual(
    work.effects.map((effect) => effect.action),
    ['putInput', 'putFuel'],
  )
})
test('legacy furnace intents receive a durable stable identity before recovery', (t) => {
  const fs = require('node:fs'),
    { dir, file } = checkpointDirectory(t)
  const saved = {
    'undefined:undefined': [
      ironJob({
        state: 'reconcile',
        pending: { kind: 'putInput', name: 'raw_iron', count: 8, beforeInventory: 8 },
      }),
    ],
  }
  fs.writeFileSync(file, JSON.stringify(saved))
  const first = fixture(t, dir).work
  const id = first.outstandingOperationIds[0]
  assert.match(id, /^[a-zA-Z0-9_-]{1,128}$/)
  assert.equal(loadJson(file).data['undefined:undefined'][0].pending.id, id)
  assert.deepEqual(fixture(t, dir).work.outstandingOperationIds, [id])
  const corrupt = loadJson(file).data
  corrupt['undefined:undefined'][0].pending.id = []
  fs.writeFileSync(file, JSON.stringify({ version: 1, data: corrupt }))
  assert.throws(() => fixture(t, dir), { code: 'CHECKPOINT_CORRUPT' })
})
test('critical furnace persistence failure takes precedence over an earlier Stop', async (t) => {
  const { work, agent } = fixture(t)
  const failure = Object.assign(new Error('disk unavailable'), {
    code: 'CHECKPOINT_WRITE_FAILED',
    fatal: true,
  })
  t.mock.method(work, 'cycle', async () => {
    work.cancel()
    throw failure
  })
  await assert.rejects(work.run({ type: 'smelter', item: 'raw_iron', quantity: 8 }), failure)
  assert.equal(agent.state.task.reasonCode, 'CHECKPOINT_WRITE_FAILED')
})
