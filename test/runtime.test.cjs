const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const { Vec3 } = require('vec3')
const { Agent } = require('../src/agents/agent.cjs')
const { Work } = require('../src/runtime/work.cjs')
const { actionFor, publicActions } = require('../src/skills/registry.cjs')
const { profiles, resolveProfile, validateProfiles } = require('../src/agents/profiles.cjs')
const { receiveControl } = require('../src/messaging/skill-chat.cjs')
const { validateCommand } = require('../src/runtime/invocations.cjs')
const { ProgressObserver } = require('../src/runtime/progress.cjs')
const { saveJson } = require('../src/infra/json-store.cjs')
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
const turn = () => new Promise(setImmediate)

function fixture(t, profile = profiles[0]) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-runtime-'))
  const agent = new Agent({ profile, dataDir, colony: { enabled: true, scope() {} } })
  const sent = []
  agent.bot = Object.assign(new EventEmitter(), {
    username: profile.username, game: { gameMode: 'survival' },
    entity: { id: 1, position: new Vec3(0, 64, 0) }, inventory: { items: () => [] },
    pathfinder: { setGoal() {}, setMovements() {} }, clearControlStates() {},
    chat: text => sent.push(text), whisper: (name, text) => sent.push([name, text]),
  })
  Object.assign(agent.state, { connection: 'ready', dimension: 'overworld' })
  t.after(async () => {
    agent.stop(false)
    await turn()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })
  return { agent, sent, dataDir }
}
function fakeSkill(t, type, implementation) {
  const definition = actionFor(type), factory = definition.factory
  definition.factory = (agent, id) => {
    const work = new Work(agent, id)
    work.run = command => implementation(work, command)
    return work
  }
  t.after(() => { definition.factory = factory })
}

test('all nine bots start their profile default, including parameter defaults', t => {
  for (const profile of profiles) {
    const { agent } = fixture(t, profile), accepted = []
    agent.startWork = command => accepted.push(command)
    agent.command('start')
    assert.deepEqual(accepted[0], { type: profile.defaultInvocation.skillId, ...profile.defaultInvocation.args })
  }
})

test('web, addressed chat and whispers accept identical parameterized skills', t => {
  const { agent, sent } = fixture(t, profiles.find(p => p.id === 'forge')), calls = []
  agent.startWork = command => calls.push(command)
  agent.command('start smelt raw_iron 16')
  assert.equal(receiveControl(agent, agent.bot, 'Player', 'Forge, start smelt raw_iron 16'), true)
  assert.equal(receiveControl(agent, agent.bot, 'Player', 'switch to smelt raw_iron 16', true), true)
  assert.deepEqual(calls, Array.from({ length: 3 }, () => ({ type: 'smelter', item: 'raw_iron', quantity: 16 })))
  assert.equal(sent.length, 2)
  assert.equal(receiveControl(agent, agent.bot, 'Player', 'Forge, start smelt raw_iron 9999'), true)
  assert.equal(calls.length, 3)
})

test('contracts reject unsafe structured parameters and preserve fractional navigation', () => {
  for (const command of [
    { type: 'smelter', item: 'raw_iron' }, { type: 'smelter', item: 'tnt', quantity: 16 },
    { type: 'terraformer', min: { x: 0, z: 0 } },
    { type: 'storageCrafting', action: 'scan', item: 'stone' },
    { type: 'mineArea', min: { x: 0, y: 64, z: 0 }, max: { x: 50, y: 80, z: 50 } },
    { type: 'treeFarm', code: 'process.exit()' },
  ]) assert.throws(() => validateCommand(command))
  assert.equal(validateCommand({ type: 'goto', x: 1.5, y: 64, z: -2.5 }).x, 1.5)
  assert.throws(() => validateCommand({ type: 'exchange', peer: 'Jerry', give: { name: 'dirt', count: 16 } }, null, { supervisor: true }), /surplus/)
  for (const definition of publicActions()) {
    assert.ok(definition.id && definition.parameters && definition.result)
    assert.equal(definition.factory, undefined)
    assert.equal(definition.module, undefined)
  }
})

test('profile validation prevents identity/data collisions and keeps metadata independent', () => {
  assert.throws(() => validateProfiles([profiles[0], { ...profiles[1], username: 'marc' }]), /unique username/)
  assert.throws(() => validateProfiles([profiles[0], { ...profiles[1], dataDir: 'data/../data' }]), /unique dataDir/)
  assert.throws(() => resolveProfile({ ...profiles[0], allowedSkills: ['smelter'] }), /default/)
  const custom = resolveProfile({ id: 'helper', username: 'Helper', defaultInvocation: { skillId: 'smelter', args: { item: 'sand', quantity: 8 } } })
  assert.equal(custom.skill, 'smelt')
  assert.equal(custom.supervisor.enabled, false)
})

test('request retries survive restart and conflicting reuse is rejected', async t => {
  const { agent, dataDir } = fixture(t)
  let starts = 0
  fakeSkill(t, 'treeFarm', async work => { starts++; work.task.status = 'succeeded' })
  const request = { requestId: 'client-42', kind: 'start', skillId: 'treeFarm', args: {} }
  const first = agent.commands.submit(request)
  assert.equal(agent.commands.submit(request), first)
  await first.completion
  assert.equal(starts, 1)
  assert.throws(() => agent.commands.submit({ ...request, skillId: 'wheatFarm' }), /different invocation/)
  const reloaded = new Agent({ dataDir })
  const retry = reloaded.commands.submit(request)
  assert.equal(retry.runId, first.runId)
  assert.equal(retry.result.outcome, 'succeeded')
  assert.equal(starts, 1)
})

test('switch reaches a checkpoint, drains cleanup, then admits only the latest replacement', async t => {
  const { agent } = fixture(t), checkpoint = deferred(), cleanup = deferred(), order = []
  fakeSkill(t, 'treeFarm', async work => {
    work.registerCleanup(async () => { order.push('cleanup'); await cleanup.promise })
    await checkpoint.promise
    work.checkpoint({ phase: 'back-on-ground' })
  })
  fakeSkill(t, 'wheatFarm', async work => { order.push('wheat'); work.task.status = 'succeeded' })
  fakeSkill(t, 'practiceMovement', async work => { order.push('practice'); work.task.status = 'succeeded' })
  const first = agent.runtime.start({ type: 'treeFarm' })
  const original = agent.activeWork
  const superseded = agent.runtime.switch({ type: 'wheatFarm' }, { requestId: 'pending-1' })
  assert.equal(original.handoffRequested, true)
  assert.equal(original.controller.signal.aborted, false)
  agent.runtime.switch({ type: 'practiceMovement' }, { requestId: 'pending-2' })
  assert.equal(agent.runtime.receipt(superseded.requestId).status, 'cancelled')
  checkpoint.resolve(); await turn()
  assert.equal(agent.activeWork, original)
  assert.deepEqual(order, ['cleanup'])
  cleanup.resolve()
  const result = await first.completion
  await turn()
  assert.equal(result.reasonCode, 'HANDOFF')
  assert.ok(result.checkpointId)
  assert.deepEqual(order, ['cleanup', 'practice'])
  assert.equal(agent.runtime.receipt('pending-2').status, 'accepted')
})

test('Stop discards pending work and keeps ownership until settlement', async t => {
  const { agent } = fixture(t), finish = deferred()
  fakeSkill(t, 'treeFarm', async work => { await finish.promise; work.check() })
  const first = agent.runtime.start({ type: 'treeFarm' })
  agent.runtime.switch({ type: 'wheatFarm' }, { requestId: 'never-start' })
  agent.stop()
  assert.equal(agent.supervisor.snapshot().paused, true)
  assert.ok(agent.workActive)
  assert.equal(agent.pendingSkill, null)
  assert.equal(agent.runtime.receipt('never-start').status, 'cancelled')
  assert.throws(() => agent.runtime.start({ type: 'wheatFarm' }), /finishing/)
  finish.resolve(); const result = await first.completion
  assert.equal(result.reasonCode, 'HUMAN_STOP')
  assert.equal(agent.workActive, false)
})

test('missed handoff deadline cancels the replacement without aborting the worker', async t => {
  const { agent } = fixture(t), finish = deferred()
  agent.runtime.handoffMs = 10
  fakeSkill(t, 'treeFarm', async work => { await finish.promise; work.task.status = 'succeeded' })
  const first = agent.runtime.start({ type: 'treeFarm' }), active = agent.activeWork
  agent.runtime.switch({ type: 'wheatFarm' }, { requestId: 'handoff-timeout' })
  await new Promise(r => setTimeout(r, 25))
  assert.equal(active.controller.signal.aborted, false)
  assert.equal(active.handoffRequested, false)
  assert.equal(agent.pendingSkill, null)
  assert.equal(agent.runtime.receipt('handoff-timeout').reasonCode, 'HANDOFF_BLOCKED')
  finish.resolve(); await first.completion
})

test('interrupted work is visible and blocks unrelated admission until reviewed', async t => {
  const { agent, dataDir } = fixture(t)
  saveJson(path.join(dataDir, 'runs.json'), { runs: [{ runId: 'old-run', requestId: 'old-request', command: { type: 'exchange' },
    world: agent.state.world, dimension: agent.state.dimension, startedAt: Date.now() }], requests: [] })
  const reloaded = new Agent({ dataDir })
  reloaded.bot = agent.bot; Object.assign(reloaded.state, { connection: 'ready', dimension: agent.state.dimension })
  assert.equal(reloaded.state.runtime.interrupted.length, 1)
  assert.equal(reloaded.workActive, false)
  assert.throws(() => reloaded.runtime.start({ type: 'wheatFarm' }), /recovery review/)
  assert.throws(() => reloaded.runtime.review('old-run', 'ok'), /Describe/)
  reloaded.runtime.review('old-run', 'Checked both inventories and retrieved the dropped stack.')
  assert.equal(reloaded.runtime.recovery().length, 0)
  assert.equal(reloaded.runtime.saved.runs[0].result, undefined, 'a review is not a fabricated completion')
  assert.throws(() => agent.commands.submit({ requestId: 'stale-1', kind: 'start', skillId: 'treeFarm', args: {}, expectedRunId: 'obsolete' }), /active run changed/)
})

test('progress wakeups require a useful milestone or a changed blocker', t => {
  const { agent } = fixture(t)
  let now = 1000, wakeups = 0
  agent.activeWork = { task: { runId: 'progress-1', skillId: 'treeFarm', counts: { mined: 0 }, label: 'Walking' }, cancel() {} }
  const observer = new ProgressObserver(agent, { now: () => now, intervalMs: 100, milestone: 4 })
  agent.on('skill.progress', () => wakeups++)
  observer.tick()
  now += 1000; observer.tick(); assert.equal(wakeups, 0)
  agent.activeWork.task.counts.mined = 4; observer.tick(); assert.equal(wakeups, 1)
  observer.tick(); assert.equal(wakeups, 1)
})

test('idle inventory observations coalesce deliveries and ignore slot moves, paused work and new sessions', t => {
  const { agent } = fixture(t), events = []
  let now = 1000
  const observer = new ProgressObserver(agent, { now: () => now, inventoryIntervalMs: 100 })
  agent.supervisor.provider.available = () => true
  agent.supervisor.configure({ mode: 'shadow', objective: 'Wait for sand to arrive.' })
  agent.supervisor.resume()
  agent.on('observation.changed', event => events.push(event))
  observer.tick()
  agent.state.inventory = [{ name: 'sand', count: 8 }]; observer.tick()
  assert.deepEqual(events[0].changes, [{ name: 'sand', before: 0, after: 8 }])
  agent.state.inventory = [{ name: 'sand', count: 4 }, { name: 'sand', count: 4 }]
  now += 100; observer.tick(); assert.equal(events.length, 1, 'moving stacks is unchanged inventory')
  agent.state.inventory = [{ name: 'sand', count: 16 }]; observer.tick()
  agent.state.inventory[0].count = 24; observer.tick()
  agent.state.inventory[0].count = 32; observer.tick()
  assert.equal(events.length, 2)
  now += 100; observer.tick()
  assert.deepEqual(events[2].changes, [{ name: 'sand', before: 16, after: 32 }])
  observer.tick(); assert.equal(events.length, 3, 'unchanged idle state stays quiet')
  agent.supervisor.paused = true
  agent.state.inventory[0].count = 40; observer.tick()
  agent.supervisor.paused = false; observer.tick()
  assert.equal(events.length, 3)
  agent.epoch++; agent.state.inventory = []; observer.tick()
  assert.equal(events.length, 3, 'a replacement session starts a fresh baseline')
  agent.activeWork = { task: {}, cancel() {} }
  agent.state.inventory = [{ name: 'sand', count: 16 }]; observer.tick()
  agent.activeWork = null; observer.tick()
  assert.equal(events.length, 3, 'active production has its own progress and result events')
})

test('chat can set a scoped human goal without enabling inference', t => {
  const { agent } = fixture(t)
  assert.equal(receiveControl(agent, agent.bot, 'Player', 'Marc, goal: Make glass for North Base'), true)
  assert.equal(agent.supervisor.snapshot().objective, 'Make glass for North Base')
  assert.equal(agent.supervisor.snapshot().mode, 'off')
  assert.equal(agent.supervisor.snapshot().paused, true)
})

test('pausing the supervisor invalidates an already queued autonomous switch', async t => {
  const { agent } = fixture(t), checkpoint = deferred()
  fakeSkill(t, 'treeFarm', async work => { await checkpoint.promise; work.checkpoint({ phase: 'safe' }); work.task.status = 'succeeded' })
  let replacements = 0
  fakeSkill(t, 'wheatFarm', async work => { replacements++; work.task.status = 'succeeded' })
  const first = agent.runtime.start({ type: 'treeFarm' })
  agent.supervisor.provider = { available: () => true }
  agent.supervisor.configure({ mode: 'autonomous', objective: 'Grow wheat' })
  agent.supervisor.resume()
  agent.runtime.switch({ type: 'wheatFarm' }, { source: 'supervisor', supervisor: true,
    requestId: 'stale-switch', context: agent.supervisor.context() })
  agent.supervisor.pause()
  assert.equal(agent.activeWork.handoffRequested, false)
  checkpoint.resolve(); await first.completion; await turn()
  assert.equal(replacements, 0)
  assert.equal(agent.runtime.receipt('stale-switch').status, 'cancelled')
  assert.equal(agent.runtime.receipt('stale-switch').reasonCode, 'SUPERVISOR_PAUSED')
})

test('same skill cannot overwrite an interrupted job or unresolved operation', t => {
  const { dataDir, agent } = fixture(t)
  saveJson(path.join(dataDir, 'runs.json'), { runs: [{ runId: 'old-terraform', requestId: 'area-one',
    command: { type: 'terraformer', min: { x: 0, z: 0 }, max: { x: 1, z: 1 }, y: 64 },
    world: agent.state.world, dimension: agent.state.dimension, startedAt: Date.now(),
    operations: [{ id: 'unresolved-fill', status: 'intent' }] }], requests: [] })
  const reloaded = new Agent({ dataDir }); reloaded.bot = agent.bot
  Object.assign(reloaded.state, { connection: 'ready', dimension: 'overworld' })
  assert.deepEqual(reloaded.state.runtime.recovery[0].outstandingOperationIds, ['unresolved-fill'])
  assert.throws(() => reloaded.runtime.start({ type: 'terraformer', min: { x: 10, z: 10 }, max: { x: 11, z: 11 }, y: 64 }), /recovery review/)
})

test('retired socket settlement refreshes runtime history without an active run', async t => {
  const { agent } = fixture(t), finish = deferred()
  fakeSkill(t, 'treeFarm', async work => { await finish.promise; work.check() })
  const handle = agent.runtime.start({ type: 'treeFarm' })
  agent.disconnect()
  assert.equal(agent.state.runtime.activeRunId, null)
  finish.resolve(); await handle.completion
  assert.equal(agent.state.runtime.activeRunId, null)
  assert.equal(agent.state.runtime.interrupted.length, 0)
  assert.equal(agent.state.runtime.results.at(-1).reasonCode, 'DISCONNECTED')
})

test('bare Start also remembers a parameterized structured invocation', async t => {
  const { agent } = fixture(t)
  fakeSkill(t, 'smelter', async work => { work.task.status = 'succeeded' })
  await agent.commands.submit({ requestId: 'glass-eight', kind: 'start', skillId: 'smelter', args: { item: 'sand', quantity: 8 } }).completion
  let repeated
  agent.startWork = command => { repeated = command }
  agent.command('start')
  assert.deepEqual(repeated, { type: 'smelter', item: 'sand', quantity: 8 })
})
