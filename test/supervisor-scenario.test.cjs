const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const { Vec3 } = require('vec3')
const { Agent } = require('../src/agents/agent.cjs')
const { Work } = require('../src/runtime/work.cjs')
const { actionFor } = require('../src/skills/registry.cjs')
const { buildFleet } = require('../src/agents/fleet.cjs')
const { InferenceScheduler } = require('../src/supervisor/inference-scheduler.cjs')
const { createApp } = require('../src/web/server.cjs')
const turn = () => new Promise(setImmediate)
const start = (skillId, kind = 'start') => ({ decision: { kind, reason: 'Advance the human objective.', invocation: { skillId, args: {} } } })
const wait = () => ({ decision: { kind: 'wait', reason: 'Wait for a useful event.', waitMs: null } })
const message = (to, channel, messageKind, text) => ({ decision: { kind: 'message', reason: 'Coordinate our shared work.',
  to, channel, messageKind, text, conversationId: 'shared-harvest', replyTo: null } })

function scenario(t, choices) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-supervisor-scenario-'))
  let calls = 0
  const scheduler = new InferenceScheduler({ file: path.join(directory, 'usage.json'), requestsPerMinute: 100, tokensPerDay: 1000000 })
  const fleet = buildFleet(Agent, { profiles: ['Scout', 'Builder'].map(username => ({ id: username.toLowerCase(), username,
    dataDir: path.join(directory, username), defaultInvocation: { skillId: 'treeFarm', args: {} }, allowedSkills: ['treeFarm', 'wheatFarm'] })),
    supervisorOptions: { scheduler, provider: { available: () => true, async decide(snapshot) {
      calls++
      const choice = choices[snapshot.bot.username].shift()
      assert.ok(choice, `Unexpected inference for ${snapshot.bot.username}`)
      return { decision: choice, usage: { input_tokens: 100, output_tokens: 30 } }
    } } } })
  const wire = []
  for (const agent of Object.values(fleet)) {
    agent.bot = Object.assign(new EventEmitter(), { username: agent.username, game: { gameMode: 'survival' },
      entity: { id: agent.username === 'Scout' ? 1 : 2, position: new Vec3(0, 64, 0) }, inventory: { items: () => [] },
      pathfinder: { setGoal() {}, setMovements() {} }, clearControlStates() {},
      chat(text) {
        wire.push(['chat', agent.username, text])
        for (const peer of Object.values(fleet)) if (peer !== agent) peer.messages.receive(peer.bot, agent.username, text, 'chat')
      },
      whisper(name, text) {
        wire.push(['whisper', agent.username, name, text])
        const peer = Object.values(fleet).find(p => p.username === name)
        peer.messages.receive(peer.bot, agent.username, text, 'whisper')
      },
    })
    Object.assign(agent.state, { connection: 'ready', dimension: 'overworld' })
    agent.messages.intervalMs = 0
    agent.supervisor.configure({ mode: 'autonomous', objective: 'Collect wood and grow wheat together.' })
    agent.supervisor.resume()
  }
  t.after(async () => {
    for (const agent of Object.values(fleet)) agent.stop(false)
    await turn()
    fs.rmSync(directory, { recursive: true, force: true })
  })
  return { fleet, wire, calls: () => calls, flush() {
    for (let turn = 0; turn < 128; turn++) for (const agent of Object.values(fleet)) agent.messages.tick()
  } }
}

test('two supervisors coordinate over Minecraft whisper/chat while skills retain one owner', async t => {
  const h = scenario(t, {
    Scout: [start('treeFarm'), message('Builder', 'whisper', 'request', 'Please grow wheat while I collect wood.'), start('wheatFarm', 'switch')],
    Builder: [wait(), start('wheatFarm'), message('Scout', 'chat', 'result', 'Four wheat are confirmed in inventory.')],
  })
  const { scout, builder } = h.fleet
  let release, concurrent = 0, peak = 0
  const tree = actionFor('treeFarm'), wheat = actionFor('wheatFarm'), oldTree = tree.factory, oldWheat = wheat.factory
  t.after(() => { tree.factory = oldTree; wheat.factory = oldWheat })
  tree.factory = (agent, id) => {
    const work = new Work(agent, id)
    work.run = async () => {
      concurrent++; peak = Math.max(peak, concurrent)
      try { await new Promise(resolve => { release = resolve }); work.checkpoint({ phase: 'descended' }) }
      finally { concurrent-- }
    }
    return work
  }
  wheat.factory = (agent, id) => {
    const work = new Work(agent, id)
    work.run = async () => {
      if (agent === scout) { concurrent++; peak = Math.max(peak, concurrent) }
      work.counts.harvested = 4; work.sync()
      work.recordEffect({ kind: 'inventory_observation', item: 'wheat', count: 4 })
      work.task.status = 'succeeded'
      if (agent === scout) concurrent--
    }
    return work
  }
  await scout.supervisor.tick(); await builder.supervisor.tick(); await turn()
  const original = scout.activeWork
  scout.supervisor.enqueue('observation.changed', { needed: 'wheat' })
  await scout.supervisor.tick(); h.flush()
  assert.equal(scout.activeWork, original)
  assert.equal(builder.workActive, false, 'receipt of a message does not itself invoke work')
  await builder.supervisor.tick(); await turn()
  assert.equal(builder.state.runtime.results.at(-1).outcome, 'succeeded')
  await builder.supervisor.tick(); h.flush()
  await scout.supervisor.tick()
  assert.equal(original.handoffRequested, true)
  assert.equal(scout.activeWork, original)
  release(); await turn(); await turn()
  assert.equal(peak, 1)
  assert.equal(scout.state.runtime.results.at(-1).skillId, 'wheatFarm')
  assert.equal(scout.state.runtime.results.at(-2).reasonCode, 'HANDOFF')
  assert.ok(h.wire.some(frame => frame[0] === 'whisper'))
  assert.ok(h.wire.some(frame => frame[0] === 'chat'))
  assert.equal(h.calls(), 6)
})

test('a supervisor waiting for materials wakes when its live inventory receives supplies', async t => {
  const h = scenario(t, { Scout: [wait(), start('wheatFarm'), wait()], Builder: [wait()] })
  const { scout } = h.fleet
  const wheat = actionFor('wheatFarm'), oldFactory = wheat.factory
  t.after(() => { wheat.factory = oldFactory })
  let started = 0
  wheat.factory = (agent, id) => {
    const work = new Work(agent, id)
    work.run = async () => { started++; work.task.status = 'succeeded' }
    return work
  }
  scout.refresh()
  await scout.supervisor.tick()
  for (let i = 0; i < 5; i++) { scout.refresh(); await scout.supervisor.tick() }
  assert.equal(h.calls(), 1)
  assert.equal(started, 0)
  scout.bot.inventory.items = () => [{ name: 'wheat_seeds', count: 8 }]
  scout.refresh()
  assert.ok(scout.supervisor.events.some(event => event.kind === 'observation.changed' && event.payload.kind === 'inventory'))
  await scout.supervisor.tick(); await turn()
  assert.equal(started, 1)
  assert.equal(scout.state.runtime.results.at(-1).outcome, 'succeeded')
  await scout.supervisor.tick()
  for (let i = 0; i < 5; i++) { scout.refresh(); await scout.supervisor.tick() }
  assert.equal(h.calls(), 3, 'one delivery and one completion wake the waiting controller')
})

test('HTTP supervisor settings are per bot, paused on save, and reject forged authority', async t => {
  const h = scenario(t, { Scout: [wait()], Builder: [wait()] })
  for (const agent of Object.values(h.fleet)) agent.supervisor.configure({ mode: 'off', objective: '' })
  const server = createApp(h.fleet.scout, h.fleet).listen(0, '127.0.0.1')
  await new Promise(resolve => server.once('listening', resolve))
  t.after(() => { server.closeAllConnections(); server.close() })
  const url = `http://127.0.0.1:${server.address().port}`
  const post = (route, body) => fetch(url + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  assert.equal((await post('/bots/scout/api/supervisor', { mode: 'shadow', objective: 'Collect wood.' })).status, 200)
  assert.equal(h.fleet.scout.supervisor.snapshot().paused, true)
  assert.equal(h.fleet.builder.supervisor.snapshot().mode, 'off')
  assert.equal((await post('/bots/scout/api/supervisor', { apiKey: 'never-store-this' })).status, 400)
  assert.equal((await post('/bots/scout/api/supervisor/resume', {})).status, 200)
  await h.fleet.scout.supervisor.tick()
  assert.equal(h.fleet.scout.supervisor.snapshot().lastDecision.status, 'shadow')
  assert.equal(h.fleet.scout.workActive, false)
  assert.equal((await post('/bots/scout/api/runs', { requestId: 'forged', kind: 'start', skillId: 'treeFarm', args: {}, source: 'supervisor' })).status, 400)
  const actions = await (await fetch(url + '/bots/scout/api/actions')).json()
  assert.equal(actions.find(action => action.id === 'smelter').allowed, false)
  assert.equal((await post('/api/stop-all', {})).status, 200)
  assert.equal(h.fleet.scout.supervisor.snapshot().paused, true)
})
