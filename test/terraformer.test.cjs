const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { fixture, Vec3 } = require('./helpers/survival-fixture.cjs')
const { parse } = require('../src/agent.cjs')
const { BUILDING_BLOCKS } = require('../src/travel.cjs')
const storage = require('../src/storage.cjs')
const { Terraformer, parseTerraformer, protectedBlock } = require('../src/terraformer.cjs')

// Fixture terrain: grass at y=63, dirt below, air above. The bot starts at (0,64,0).
function setup(t, { colony = false } = {}) {
  const h = fixture()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'terraform-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  Object.assign(h.agent, { dataDir: dir, username: 'Terra', colony: { enabled: colony, scope: () => ({ session: 's' }) } })
  Object.assign(h.agent.state, { world: 'Test', dimension: 'overworld' })
  // Placement honours the requested face and is acknowledged like the real server.
  h.bot._placeBlockWithOptions = async (ref, face) => {
    const p = ref.position.plus(face)
    const b = h.set(h.bot.heldItem.name, p)
    h.placed.push(b.name)
    h.bot.heldItem.count--
    h.bot._client.emit('block_change', { location: p, type: b.stateId })
  }
  h.add('iron_pickaxe'); h.add('iron_shovel')
  const make = () => {
    const work = new Terraformer(h.agent, 1)
    work.pause = async () => work.check()
    work.pickup = async () => {}
    work.approachCut = async (p) => { work.check(); h.bot.entity.position = p.offset(2.5, 1, 0.5) }
    work.standNear = async (ref, dest) => { work.check(); h.bot.entity.position = dest.offset(1.5, 0, 0.5) }
    return work
  }
  return { ...h, dir, make }
}
const hillock = (h, x, z) => {
  h.set('stone', new Vec3(x, 64, z)); h.set('stone', new Vec3(x, 65, z)); h.set('dirt', new Vec3(x + 1, 64, z))
}

test('parser normalises corners, bounds the area and rejects bad input', () => {
  assert.deepEqual(parseTerraformer('flatten 5 -3 to -2 7 at 64'), { type: 'terraformer', min: { x: -2, z: -3 }, max: { x: 5, z: 7 }, y: 64 })
  assert.deepEqual(parse('Flatten -600, 1150 to -594, 1156 at y 70'), { type: 'terraformer', min: { x: -600, z: 1150 }, max: { x: -594, z: 1156 }, y: 70 })
  assert.throws(() => parseTerraformer('flatten 0 0 to 32 5 at 64'), /at most 32×32/)
  assert.throws(() => parseTerraformer('flatten 0 0 to 5 5 at 301'), /between -60 and 300/)
  assert.throws(() => parseTerraformer('flatten 0 0 to 5 5 at -61'), /between -60 and 300/)
  assert.throws(() => parseTerraformer('flatten 30000001 0 to 5 5 at 64'), /30,000,000/)
  assert.throws(() => parseTerraformer('flatten here'), /flatten X1 Z1 to X2 Z2 at Y/)
  assert.equal(parseTerraformer('farm wheat'), null)
  assert.deepEqual(parse('terraform'), { type: 'terraformer' })
  assert.deepEqual(parse('flatten 0 0 to 31 31 at 64').max, { x: 31, z: 31 })
})

test('survey counts cuts above and fills below the target, including negative coordinates and water', (t) => {
  const h = setup(t)
  hillock(h, -10, -10) // 3 blocks to cut
  h.set('air', new Vec3(-12, 63, -12)); h.set('air', new Vec3(-12, 62, -12)) // two-deep hole
  h.set('water', new Vec3(-8, 63, -8)) // pond surface at target level
  for (let y = 58; y <= 63; y++) h.set('air', new Vec3(-8, y, -12)) // deep cavity: only four supports
  h.set('short_grass', new Vec3(-9, 64, -8)) // vegetation above the level is cut like anything else
  const work = h.make()
  work.job = { area: { min: { x: -12, z: -12 }, max: { x: -8, z: -8 }, y: 63 }, done: [], cut: 0, filled: 0 }
  const s = work.survey()
  assert.equal(s.columns, 25)
  assert.equal(s.cuts.length, 4)
  assert.deepEqual(s.cuts.map((c) => c.pos.y).sort(), [64, 64, 64, 65])
  assert.equal(s.needFill, 2 + 1 + 4)
  assert.deepEqual(s.fills.find((f) => f.x === -8 && f.z === -12).cells, [60, 61, 62, 63])
  assert.equal(s.expectedYield, 3)
  assert.equal(s.skipped.length, 0)
  assert.equal(s.done.length, 25 - 6)
})

test('protected blocks and every column within two of them are skipped with a reason', (t) => {
  const h = setup(t)
  h.set('chest', new Vec3(0, 64, 0))
  h.set('torch', new Vec3(6, 64, 0)) // just outside the rectangle: still protects the x=4 edge
  h.set('farmland', new Vec3(-6, 63, -6)); h.set('water', new Vec3(-5, 63, -6)) // irrigation water next to a field
  const work = h.make()
  work.job = { area: { min: { x: -4, z: -4 }, max: { x: 4, z: 4 }, y: 63 }, done: [], cut: 0, filled: 0 }
  const s = work.survey()
  const skipped = new Set(s.skipped.map((k) => `${k.x},${k.z}`))
  for (let x = -2; x <= 2; x++) for (let z = -2; z <= 2; z++) assert.ok(skipped.has(`${x},${z}`), `${x},${z} near the chest`)
  for (let z = -2; z <= 2; z++) assert.ok(skipped.has(`4,${z}`), `4,${z} near the torch`)
  assert.ok(skipped.has('-4,-4'), 'irrigation water protects the corner')
  assert.ok(!skipped.has('3,4'))
  assert.match(s.skipped.find((k) => k.x === 0 && k.z === 0).reason, /protected chest at 0,64,0/)
  for (const name of ['oak_sign', 'oak_wall_sign', 'wall_torch', 'white_bed', 'oak_door', 'oak_fence', 'oak_fence_gate', 'glass_pane', 'rail', 'bedrock', 'obsidian', 'wheat', 'barrel', 'blast_furnace'])
    assert.equal(protectedBlock(h.bot, h.set(name, new Vec3(20, 70, 20))), true, name)
  assert.equal(protectedBlock(h.bot, Object.assign(h.set('spawner', new Vec3(21, 70, 20)), { entity: {} })), true)
  assert.equal(protectedBlock(h.bot, h.set('stone', new Vec3(22, 70, 20))), false)
  assert.equal(protectedBlock(h.bot, h.set('water', new Vec3(30, 63, 30))), false)
})

test('a column with solid blocks more than eight above the target refuses the whole job', async (t) => {
  const h = setup(t)
  for (let y = 64; y <= 73; y++) h.set('stone', new Vec3(2, y, 2))
  const work = h.make()
  await work.run({ type: 'terraformer', min: { x: -4, z: -4 }, max: { x: 4, z: 4 }, y: 63 })
  assert.equal(work.task.status, 'failed')
  assert.equal(work.plan.status, 'refused')
  assert.match(work.plan.decision, /too tall; choose a higher target or smaller area/)
  assert.equal(h.dug.length, 0)
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(h.dir, 'terraform-jobs.json'), 'utf8')), {})
})

test('corners farther than 64 blocks are refused before any work', async (t) => {
  const h = setup(t)
  const work = h.make()
  await work.run({ type: 'terraformer', min: { x: 100, z: 0 }, max: { x: 104, z: 4 }, y: 63 })
  assert.equal(work.task.status, 'failed')
  assert.match(work.plan.decision, /within 64 blocks of Terra/)
  assert.equal(h.dug.length, 0)
})

test('cuts top-down, fills from cut material, and finishes with the surface level', async (t) => {
  const h = setup(t)
  hillock(h, 1, 1)
  h.set('air', new Vec3(-3, 63, -3)); h.set('air', new Vec3(-3, 62, -3))
  const layers = []
  const dig = h.bot.dig
  h.bot.dig = async (b) => { layers.push(b.position.y); await dig(b) }
  const work = h.make()
  await work.run({ type: 'terraformer', min: { x: -4, z: -4 }, max: { x: 4, z: 4 }, y: 63 })
  assert.equal(work.task.status, 'succeeded', work.plan.decision)
  assert.deepEqual(layers, [65, 64, 64])
  assert.deepEqual(h.placed, ['cobblestone', 'dirt'], 'hidden support uses stone drops, surface uses dirt')
  for (let x = -4; x <= 4; x++) for (let z = -4; z <= 4; z++) {
    assert.equal(h.bot.blockAt(new Vec3(x, 63, z)).boundingBox, 'block', `${x},${z} surface`)
    assert.equal(h.bot.blockAt(new Vec3(x, 64, z)).name, 'air', `${x},${z} clear`)
  }
  assert.equal(work.plan.cut, 3); assert.equal(work.plan.filled, 2); assert.equal(work.plan.done, 81)
  assert.match(work.plan.decision, /Colony storage is disabled/)
  assert.equal(work.plan.storage.startsWith('Colony storage is disabled'), true)
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(h.dir, 'terraform-jobs.json'), 'utf8')), {}, 'complete jobs are cleared')
})

test('fill shortfall requests shared storage first, deposits surplus when nearly full, and reports the exact deficit', async (t) => {
  const h = setup(t, { colony: true })
  for (let x = -4; x <= 4; x++) h.set('air', new Vec3(x, 63, 0)) // nine surface blocks missing, nothing to cut
  const calls = []
  t.mock.method(storage, 'call', async (w, action) => { calls.push(action); return action === 'hub_get' ? { position: { x: 10, y: 64, z: 10 } } : {} })
  let stocked = 4 // The shared chest only has four dirt; later requests find it empty.
  t.mock.method(storage, 'retrieve', async (w, names, target) => { calls.push(['retrieve', names, target]); h.add('dirt', stocked); const moved = stocked; stocked = 0; return moved })
  t.mock.method(storage, 'store', async () => { calls.push('store'); return 0 })
  const work = h.make()
  h.bot.inventory.emptySlotCount = () => 3
  await work.run({ type: 'terraformer', min: { x: -4, z: -4 }, max: { x: 4, z: 4 }, y: 63 })
  assert.deepEqual(calls.filter((c) => Array.isArray(c))[0], ['retrieve', BUILDING_BLOCKS, 9], 'target = min(needFill, carried + 128)')
  assert.equal(work.plan.filled, 4)
  assert.equal(work.task.status, 'partial')
  assert.equal(work.plan.deficit, 5)
  assert.match(work.plan.decision, /short 5 fill block\(s\)/)
  assert.ok(calls.includes('store'), 'surplus deposit runs at the end of the job')
  assert.equal(work.reserves.dirt, 128, 'reserves return to the base policy once the job stops')
  const saved = JSON.parse(fs.readFileSync(path.join(h.dir, 'terraform-jobs.json'), 'utf8'))['Test:overworld']
  assert.equal(saved.status, 'partial'); assert.equal(saved.filled, 4)
})

test('the storage hub must be within 80 blocks of the job origin', async (t) => {
  const h = setup(t, { colony: true })
  t.mock.method(storage, 'call', async () => ({ position: { x: 200, y: 64, z: 0 } }))
  t.mock.method(storage, 'retrieve', async () => assert.fail('no retrieval from a distant hub'))
  const work = h.make()
  await work.run({ type: 'terraformer', min: { x: -1, z: -1 }, max: { x: 1, z: 1 }, y: 63 })
  assert.equal(work.task.status, 'succeeded')
  assert.match(work.plan.storage, /more than 80 blocks/)
})

test('cancellation mid-layer keeps the saved job and a bare terraform resumes only unfinished columns', async (t) => {
  const h = setup(t)
  for (let x = -2; x <= 2; x++) h.set('dirt', new Vec3(x, 64, 2)) // one layer of five blocks
  const dig = h.bot.dig
  let work = h.make()
  h.bot.dig = async (b) => { await dig(b); if (h.dug.length === 2) work.cancel() }
  await work.run({ type: 'terraformer', min: { x: -4, z: -4 }, max: { x: 4, z: 4 }, y: 63 })
  assert.equal(work.task.status, 'cancelled'); assert.equal(work.plan.status, 'cancelled')
  assert.equal(h.dug.length, 2)
  const file = path.join(h.dir, 'terraform-jobs.json')
  let saved = JSON.parse(fs.readFileSync(file, 'utf8'))['Test:overworld']
  // The second dig was interrupted before the server confirmation: it is not counted, only verified later.
  assert.equal(saved.cut, 1); assert.equal(saved.status, 'cancelled'); assert.equal(saved.done.length, 76)
  // Someone disturbed a "done" column; live verification must redo it.
  h.set('stone', new Vec3(-4, 64, -4))
  h.bot.dig = dig
  work = h.make()
  await work.run()
  assert.equal(work.task.status, 'succeeded', work.plan.decision)
  assert.match(work.plan.decision, /-4,-4 to 4,4 at Y=63/)
  assert.equal(h.dug.length, 6, 'finished columns are not dug again')
  assert.equal(work.plan.cut, 5, 'resumed counts continue from the saved job')
  saved = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.deepEqual(saved, {})
})

test('an explicit command for a different rectangle replaces the saved job instead of resuming it', async (t) => {
  const h = setup(t)
  const work = h.make()
  work.jobs['Test:overworld'] = { area: { min: { x: 20, z: 20 }, max: { x: 24, z: 24 }, y: 63 }, done: [], cut: 5, filled: 0, status: 'partial' }
  await work.run({ type: 'terraformer', min: { x: -1, z: -1 }, max: { x: 1, z: 1 }, y: 63 })
  assert.equal(work.plan.cut, 0)
  assert.deepEqual(work.plan.area, { min: { x: -1, z: -1 }, max: { x: 1, z: 1 }, y: 63 })
})

test('the block under the feet is never dug: the bot steps aside first or records the failure', async (t) => {
  const h = setup(t)
  h.set('dirt', new Vec3(0, 64, 0)); h.set('dirt', new Vec3(1, 64, 0))
  h.bot.entity.position = new Vec3(0.5, 65, 0.5) // standing on the first target
  const dig = h.bot.dig
  h.bot.dig = async (b) => {
    assert.ok(!b.position.equals(h.bot.entity.position.floored().offset(0, -1, 0)), 'never dig the standing block')
    await dig(b)
  }
  let work = h.make()
  work.approachCut = Terraformer.prototype.approachCut
  work.travel = async (goal) => {
    assert.equal(goal.isEnd(new Vec3(0, 65, 0)), false, 'the excluded stance cannot be accepted again')
    h.bot.entity.position = new Vec3(2.5, 64, 0.5)
  }
  await work.run({ type: 'terraformer', min: { x: -1, z: -1 }, max: { x: 1, z: 1 }, y: 63 })
  assert.equal(work.task.status, 'succeeded', work.plan.decision)
  assert.equal(h.dug.length, 2)
  // If no other stance exists the target stays in place and the job pauses with the saved blocker.
  h.set('dirt', new Vec3(0, 64, 0)); h.bot.entity.position = new Vec3(0.5, 65, 0.5)
  work = h.make()
  work.approachCut = Terraformer.prototype.approachCut
  work.travel = async () => {}
  await work.run({ type: 'terraformer', min: { x: 0, z: 0 }, max: { x: 0, z: 0 }, y: 63 })
  assert.equal(work.task.status, 'partial')
  assert.match(work.plan.decision, /three attempts/)
  assert.equal(h.bot.blockAt(new Vec3(0, 64, 0)).name, 'dirt')
})

test('three passes without progress pause the job as partial and keep it saved', async (t) => {
  const h = setup(t)
  hillock(h, 0, 0)
  const work = h.make()
  work.approachCut = async () => { throw new Error('No useful route') }
  await work.run({ type: 'terraformer', min: { x: -2, z: -2 }, max: { x: 2, z: 2 }, y: 63 })
  assert.equal(work.task.status, 'partial'); assert.equal(work.plan.status, 'partial')
  assert.match(work.plan.decision, /No progress after three attempts: .*No useful route/)
  assert.equal(h.dug.length, 0)
  const saved = JSON.parse(fs.readFileSync(path.join(h.dir, 'terraform-jobs.json'), 'utf8'))['Test:overworld']
  assert.equal(saved.status, 'partial')
})

test('fills are placed against live support faces from the outside ring inward', async (t) => {
  const h = setup(t)
  for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) for (let y = 60; y <= 63; y++) h.set('air', new Vec3(x, y, z)) // 3×3 pit, four deep
  const work = h.make()
  const rings = []
  const place = h.bot._placeBlockWithOptions
  h.bot._placeBlockWithOptions = async (ref, face) => { rings.push(Math.max(Math.abs(ref.position.x + face.x), Math.abs(ref.position.z + face.z))); await place(ref, face) }
  h.add('cobblestone', 64)
  await work.run({ type: 'terraformer', min: { x: -2, z: -2 }, max: { x: 2, z: 2 }, y: 63 })
  assert.equal(work.task.status, 'succeeded', work.plan.decision)
  assert.equal(work.plan.filled, 9 * 4)
  assert.deepEqual(rings.slice(0, 32).every((r) => r === 1), true, 'outer ring first')
  assert.deepEqual(rings.slice(32), [0, 0, 0, 0])
  for (let y = 60; y <= 63; y++) assert.equal(h.bot.blockAt(new Vec3(0, y, 0)).name, 'cobblestone')
})

test('run publishes bounded plain progress state', async (t) => {
  const h = setup(t)
  const before = h.agent.state.survival
  const work = h.make()
  assert.equal(h.agent.state.terraformer, work.plan)
  assert.equal(h.agent.state.survival, before, 'the survival dashboard state is left alone')
  await work.run({ type: 'terraformer', min: { x: -1, z: -1 }, max: { x: 1, z: 1 }, y: 63 })
  assert.equal(JSON.stringify(work.plan).length < 2000, true)
  for (const k of ['status', 'decision', 'area', 'columns', 'done', 'cut', 'filled', 'needFill', 'carriedFill', 'skipped', 'waitingUntil']) assert.ok(k in work.plan, k)
  assert.equal(work.task.skill, 'TERRAFORMER'); assert.equal(work.task.continuous, false)
})

test('fill references prefer same-level pit walls over a support face beyond stance reach (live regression)', async (t) => {
  const h = setup(t)
  for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++) for (let y = 64; y <= 66; y++) h.set('dirt', new Vec3(x, y, z)) // plateau at 66
  for (let y = 65; y <= 66; y++) h.set('air', new Vec3(0, y, 0)) // one 2-deep pit
  h.bot.entity.position = new Vec3(1.5, 67, 0.5)
  const work = h.make()
  const supports = work.supportsFor(new Vec3(0, 65, 0))
  assert.deepEqual(supports.at(-1), { ref: new Vec3(0, 64, 0), face: new Vec3(0, 1, 0) }, 'the block below is the last resort')
  assert.equal(supports.length, 5)
  assert.ok(supports.slice(0, 4).every((s) => s.ref.y === 65), 'pit walls first')
  assert.deepEqual(supports[0].ref, new Vec3(1, 65, 0), 'nearest wall first')
  let stances = 0
  work.standNear = async (ref, dest) => { stances++; if (ref.y < dest.y) throw Object.assign(new Error('No route'), { code: 'NO_ROUTE' }) }
  h.add('dirt', 4)
  await work.run({ type: 'terraformer', min: { x: -3, z: -3 }, max: { x: 3, z: 3 }, y: 66 })
  assert.equal(work.task.status, 'succeeded', work.plan.decision)
  assert.equal(h.bot.blockAt(new Vec3(0, 65, 0)).name, 'dirt'); assert.equal(h.bot.blockAt(new Vec3(0, 66, 0)).name, 'dirt')
  assert.equal(stances, 2, 'a same-level wall stance succeeds without trying the deep support')
})
