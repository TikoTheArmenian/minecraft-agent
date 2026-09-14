const { test } = require('node:test')
const assert = require('node:assert/strict')
const { fixture, Vec3 } = require('./helpers/survival-fixture.cjs')
const { OreFinder, parseOreFinder } = require('../src/ore-finder.cjs')
const { parse } = require('../src/agent.cjs')
const storage = require('../src/storage.cjs')

// Fixture terrain: grass at y=63, dirt below, air above. An ore at y=64 is exposed on five
// faces; an ore at y=60 is sealed in dirt (buried) unless a neighbour is replaced by air.
function setup() {
  const h = fixture()
  const work = new OreFinder(h.agent, 1)
  work.pause = async () => work.check()
  work.approach = async (p) => { work.check(); h.bot.entity.position = p.offset(2, 1, 0) }
  work.pickup = async () => {}
  return { ...h, work }
}

test('parser accepts ore commands, validates bounds, and leaves generic find alone', () => {
  assert.deepEqual(parse('find ores'), { type: 'oreFinder', ores: null, radius: 48 })
  assert.deepEqual(parse('find ores iron'), { type: 'oreFinder', ores: ['iron'], radius: 48 })
  assert.deepEqual(parse('find ores coal within 48'), { type: 'oreFinder', ores: ['coal'], radius: 48 })
  assert.deepEqual(parse('mine ores diamond'), { type: 'oreFinder', ores: ['diamond'], radius: 48 })
  assert.deepEqual(parseOreFinder('find ores coal, iron and lapis lazuli within 16'), { type: 'oreFinder', ores: ['coal', 'iron', 'lapis'], radius: 16 })
  assert.equal(parse('ore finder').type, 'oreFinder')
  assert.equal(parse('start ore finder').type, 'oreFinder')
  assert.throws(() => parse('find ores within 100'), /8–64/)
  assert.throws(() => parse('find ores within 4'), /8–64/)
  assert.throws(() => parse('find ores unobtainium'), /Unknown ore/)
  assert.deepEqual(parse('find oak logs'), { type: 'find', name: 'oak_logs', radius: 32 })
  assert.equal(parse('find stone 20').type, 'find')
  assert.equal(parseOreFinder('farm trees'), null)
  assert.equal(parseOreFinder('mine stone 16'), null)
})

test('scan classifies exposed versus buried ores per type and publishes plain state', () => {
  const h = setup()
  h.set('coal_ore', new Vec3(3, 64, 0))
  h.set('deepslate_coal_ore', new Vec3(6, 64, 0))
  h.set('iron_ore', new Vec3(0, 60, 0)) // sealed in dirt
  h.set('gold_ore', new Vec3(0, 58, 0)); h.set('cave_air', new Vec3(1, 58, 0)) // cave-exposed
  h.set('nether_gold_ore', new Vec3(2, 64, 2)) // out of scope
  const targets = h.work.scan()
  assert.deepEqual(h.work.plan.found, { coal: 2, iron: 1, gold: 1 })
  assert.equal(h.work.plan.exposed, 3)
  assert.equal(h.work.plan.buried, 1)
  assert.deepEqual(h.work.plan.nearest.coal, { x: 3, y: 64, z: 0, distance: 3 })
  assert.equal(h.work.plan.nearest.iron, undefined, 'buried ores have no exposed nearest position')
  assert.equal(h.agent.state.oreFinder, h.work.plan)
  assert.equal(JSON.stringify(h.agent.state.oreFinder).includes('Vec3'), false)
  // Every exposed target is safe here; the cave-exposed gold has no liquid or gravel neighbours.
  assert.deepEqual(targets.map((b) => b.name).sort(), ['coal_ore', 'deepslate_coal_ore', 'gold_ore'])
  assert.equal(h.work.plan.mineable, 3)
  assert.match(h.work.summary(), /coal 2, iron 1, gold 1 · 3 exposed \(3 mineable\), 1 buried/)
})

test('a selected ore list restricts the scan and the radius is respected', () => {
  const h = setup()
  h.work.ores = ['iron']; h.work.radius = 8
  h.set('iron_ore', new Vec3(3, 64, 0))
  h.set('iron_ore', new Vec3(20, 64, 0))
  h.set('coal_ore', new Vec3(2, 64, 0))
  h.work.scan()
  assert.deepEqual(h.work.plan.found, { iron: 1 })
})

test('buried ores are reported but never tunnelled to', async () => {
  const h = setup(); h.add('iron_pickaxe')
  h.set('iron_ore', new Vec3(0, 60, 0))
  assert.equal(await h.work.cycle(), 0)
  assert.equal(h.dug.length, 0)
  assert.equal(h.work.plan.buried, 1)
})

test('exposed ore beside lava or under gravel is exposed but not mineable', () => {
  const h = setup(); h.add('iron_pickaxe')
  h.set('iron_ore', new Vec3(3, 64, 0)); h.set('lava', new Vec3(4, 64, 0))
  h.set('coal_ore', new Vec3(6, 64, 0)); h.set('gravel', new Vec3(6, 65, 0))
  const targets = h.work.scan()
  assert.equal(h.work.plan.exposed, 2)
  assert.equal(targets.length, 0)
  assert.equal(h.work.plan.unsafe, 2)
})

test('tool tiers gate mining through canHarvest, and the skipped ores are explained', async () => {
  const h = setup(); h.add('stone_pickaxe')
  h.set('gold_ore', new Vec3(3, 64, 0))
  h.set('coal_ore', new Vec3(-3, 64, 0))
  const gold = h.bot.blockAt(new Vec3(3, 64, 0)), coal = h.bot.blockAt(new Vec3(-3, 64, 0))
  assert.equal(h.work.canMine(coal), true)
  assert.equal(h.work.canMine(gold), false)
  assert.equal(h.work.neededPickaxe([gold]), 'iron_pickaxe')
  assert.equal(h.work.neededPickaxe([coal]), 'wooden_pickaxe')
  const mined = await h.work.cycle()
  assert.equal(mined, 1)
  assert.deepEqual(h.dug, ['coal_ore'])
  assert.deepEqual(h.work.plan.mined, { coal: 1 })
  assert.equal(h.work.plan.needsTool, 1)
  assert.ok(h.work.issues.some((i) => /gold ore\(s\) that need a iron pickaxe.*iron ingots/.test(i)), h.work.issues.join(' | '))
  assert.ok(h.work.nextToolAttemptAt > Date.now(), 'a failed tool trip is cooled down')
  // A better pickaxe makes the skipped ore eligible on the next pass.
  h.add('iron_pickaxe')
  assert.equal(await h.work.cycle(), 1)
  assert.deepEqual(h.dug, ['coal_ore', 'gold_ore'])
  assert.equal(h.work.plan.tool, 'iron_pickaxe')
})

test('an iron pickaxe is retrieved from shared storage before crafting when colony storage is enabled', async () => {
  const h = setup(); h.add('stone_pickaxe'); h.agent.colony = { enabled: true }
  h.set('diamond_ore', new Vec3(3, 64, 0))
  const original = storage.retrieve, calls = []
  storage.retrieve = async (w, names, target) => { calls.push([names, target]); h.add('iron_pickaxe'); return 1 }
  try { await h.work.cycle() } finally { storage.retrieve = original }
  assert.deepEqual(calls, [[['iron_pickaxe', 'diamond_pickaxe', 'netherite_pickaxe'], 1]])
  assert.deepEqual(h.dug, ['diamond_ore'])
})

test('a 32-item ore batch triggers one confirmed deposit at a safe checkpoint', async () => {
  const h = setup(); h.add('iron_pickaxe'); h.agent.colony = { enabled: true }
  h.set('iron_ore', new Vec3(3, 64, 0))
  const original = storage.store, calls = []
  storage.store = async (w) => {
    assert.equal(w, h.work)
    assert.deepEqual(w.reserves, { torch: 16 })
    const raw = h.items.find((i) => i.name === 'raw_iron'); calls.push(raw.count); const moved = raw.count; raw.count = 0
    return moved
  }
  try {
    h.add('raw_iron', 10)
    await h.work.cycle()
    assert.deepEqual(calls, [], 'a small load is carried, not deposited')
    h.set('iron_ore', new Vec3(-3, 64, 0))
    h.add('raw_iron', 21) // 10 + 1 mined + 21 = 32
    assert.equal(h.work.oreLoad(), 32)
    await h.work.cycle()
    assert.deepEqual(calls, [32])
    assert.equal(h.work.plan.stored, 32)
    assert.deepEqual(h.dug, ['iron_ore', 'iron_ore'])
  } finally { storage.store = original }
})

test('a carried batch is deposited at the end of a pass even when nothing is mineable', async () => {
  const h = setup(); h.add('iron_pickaxe'); h.add('raw_iron', 40); h.agent.colony = { enabled: true }
  h.set('iron_ore', new Vec3(0, 60, 0)) // buried only
  const original = storage.store; let calls = 0
  storage.store = async () => { calls++; const raw = h.items.find((i) => i.name === 'raw_iron'); const n = raw.count; raw.count = 0; return n }
  try { assert.equal(await h.work.cycle(), 0) } finally { storage.store = original }
  assert.equal(calls, 1); assert.equal(h.work.plan.stored, 40); assert.equal(h.dug.length, 0)
})

test('a deposit that moves nothing is reported and not repeated every dig', async () => {
  const h = setup(); h.add('iron_pickaxe'); h.add('raw_iron', 40); h.agent.colony = { enabled: true }
  h.set('iron_ore', new Vec3(3, 64, 0)); h.set('iron_ore', new Vec3(-3, 64, 0))
  const original = storage.store; let calls = 0
  storage.store = async () => { calls++; return 0 }
  try { await h.work.cycle() } finally { storage.store = original }
  assert.equal(calls, 1)
  assert.equal(h.work.plan.stored, 0)
  assert.ok(h.work.issues.some((i) => /accepted no items/.test(i)))
  assert.equal(h.dug.length, 2, 'mining continues while the batch is carried')
})

test('a partial deposit counts only the verified amount and reports the rest as a capacity blocker', async () => {
  const h = setup(); h.add('iron_pickaxe'); h.add('coal', 8); h.add('raw_iron', 40); h.agent.colony = { enabled: true }
  const original = storage.store
  storage.store = async () => { h.items.find((i) => i.name === 'coal').count = 0; return 8 }
  try { await h.work.cycle() } finally { storage.store = original }
  assert.equal(h.work.plan.stored, 8)
  assert.ok(h.work.issues.some((i) => /took 8 item\(s\) but 40 raw ore\/coal remain/.test(i)), h.work.issues.join(' | '))
  assert.ok(h.work.nextDepositAt > Date.now())
})

test('without colony storage the ore is carried and a full inventory is a blocker', async () => {
  const h = setup(); h.add('iron_pickaxe'); h.add('raw_iron', 64)
  h.set('iron_ore', new Vec3(3, 64, 0))
  const original = storage.store
  storage.store = async () => assert.fail('no shared storage configured')
  try {
    assert.equal(h.work.shouldStore(), false)
    await h.work.cycle()
    assert.deepEqual(h.dug, ['iron_ore'])
    h.set('iron_ore', new Vec3(-3, 64, 0)); h.bot.inventory.emptySlotCount = () => 1
    await assert.rejects(h.work.cycle(), /Inventory is full. Empty Marc’s inventory.*not configured/)
  } finally { storage.store = original }
})

test('cancellation during the mining loop stops further digs', async () => {
  const h = setup(); h.add('iron_pickaxe')
  h.set('coal_ore', new Vec3(3, 64, 0)); h.set('coal_ore', new Vec3(4, 64, 0)); h.set('coal_ore', new Vec3(5, 64, 0))
  const dig = h.bot.dig
  h.bot.dig = async (b) => { await dig(b); h.work.cancel() }
  await assert.rejects(h.work.cycle(), /Cancelled/)
  assert.equal(h.dug.length, 1)
  // The removal was never server-confirmed after Stop, so it is not counted as progress.
  assert.equal(h.work.counts.mined, 0)
})

test('failed targets cool down and become eligible again later', async () => {
  const h = setup(); h.add('iron_pickaxe')
  h.set('coal_ore', new Vec3(3, 64, 0))
  h.work.approach = async () => { throw new Error('No route') }
  assert.equal(await h.work.cycle(), 0)
  assert.equal(h.dug.length, 0)
  const id = `${new Vec3(3, 64, 0)}:coal_ore`
  assert.ok(h.work.failedTargets.has(id)); assert.ok(h.work.cooldowns.has(id))
  h.work.cooldowns.set(id, Date.now() - 1)
  h.work.approach = async (p) => { h.bot.entity.position = p.offset(2, 1, 0) }
  assert.equal(await h.work.cycle(), 1)
})

test('the run loop waits and rescans when nothing is exposed, and stops cleanly on Stop', async () => {
  const h = setup(); h.add('iron_pickaxe')
  h.set('iron_ore', new Vec3(0, 60, 0))
  let waits = 0
  h.work.pause = async (ms) => { if (ms >= 20000) { waits++; h.work.cancel() } h.work.check() }
  await h.work.run({ type: 'oreFinder', ores: null, radius: 48 })
  assert.equal(waits, 1)
  assert.equal(h.work.plan.status, 'cancelled'); assert.equal(h.work.task.status, 'cancelled')
  assert.match(h.work.plan.decision, /cancelled/)
  assert.equal(h.work.plan.waitingUntil, null)
  assert.equal(h.dug.length, 0)
})

test('three passes with an error and no progress pause the skill with the blocker', async () => {
  const h = setup()
  h.work.cycle = async () => { throw new Error('Inventory is full.') }
  await h.work.run({ type: 'oreFinder' })
  assert.equal(h.work.plan.status, 'paused'); assert.equal(h.work.task.status, 'partial')
  assert.match(h.work.plan.decision, /three passes.*Inventory is full/)
  assert.equal(h.work.stalledPasses, 3)
})

test('a fatal safety condition ends the run and messages name this bot', async () => {
  const h = setup(); h.agent.username = 'Orin'
  h.bot.health = 4
  await h.work.run({ type: 'oreFinder' })
  assert.equal(h.work.plan.status, 'paused')
  assert.match(h.work.plan.decision, /Move Orin to safety/)
  assert.equal(h.work.plan.decision.includes('Marc'), false)
})

test('constructor keeps the previous survival state and marks the task continuous', () => {
  const h = fixture(); h.agent.state.survival = { keep: true }
  const work = new OreFinder(h.agent, 1)
  assert.deepEqual(h.agent.state.survival, { keep: true })
  assert.equal(work.task.continuous, true); assert.equal(work.task.deadlineAt, null); assert.equal(work.deadline, Infinity)
  assert.equal(work.task.skill, 'ORE FINDER')
  assert.equal(h.agent.state.oreFinder.status, 'running')
})
