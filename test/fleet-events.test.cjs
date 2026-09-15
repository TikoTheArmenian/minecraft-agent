const { test } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { Agent } = require('../src/agents/agent.cjs')
const { buildFleet } = require('../src/agents/fleet.cjs')
const { installFleetEvents } = require('../src/agents/fleet-events.cjs')
const { validateProfiles } = require('../src/agents/profiles.cjs')
const { EVENT_TYPES } = require('../src/infra/events.cjs')

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-events-'))
  const fleet = buildFleet(Agent, {
    profiles: ['Scout', 'Builder'].map((username) => ({
      id: username.toLowerCase(),
      username,
      dataDir: path.join(dir, username),
    })),
    supervisorOptions: { schedulerFile: path.join(dir, 'usage.json') },
  })
  t.after(() => {
    for (const agent of Object.values(fleet)) agent.disconnect()
    fleet.events.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  return fleet
}

test('built fleets forward every public event once with a detached, identified envelope', (t) => {
  const fleet = fixture(t),
    recorded = [],
    named = [],
    local = []
  assert.ok(fleet.events instanceof EventEmitter)
  assert.deepEqual(Object.keys(fleet), ['scout', 'builder'])
  assert.deepEqual(Object.values(fleet), [fleet.scout, fleet.builder])
  assert.equal(fleet.scout.fleet.events, fleet.events)
  assert.equal(fleet.builder.fleet.events, fleet.events)
  assert.equal(
    installFleetEvents(fleet),
    fleet.events,
    'installing twice does not duplicate bridges',
  )
  fleet.events.on('event', (event) => recorded.push(event))
  for (const type of EVENT_TYPES) {
    fleet.events.on(type, (event) => named.push(event))
    fleet.scout.on(type, (payload) => local.push(payload))
  }
  for (const agent of Object.values(fleet))
    for (const type of EVENT_TYPES) {
      const payload = { details: { value: `${agent.id}:${type}` } }
      agent.emit(type, payload)
      const event = recorded.at(-1)
      assert.deepEqual(Object.keys(event), ['type', 'botId', 'at', 'payload'])
      assert.equal(event.type, type)
      assert.equal(event.botId, agent.id)
      assert.ok(Number.isFinite(event.at))
      payload.details.value = 'changed'
      assert.equal(event.payload.details.value, `${agent.id}:${type}`)
      assert.equal(named.at(-1), event, 'named and catch-all listeners receive the same envelope')
    }
  assert.equal(recorded.length, EVENT_TYPES.length * 2)
  assert.equal(local.length, EVENT_TYPES.length, 'forwarding does not emit into another agent')
  for (const agent of Object.values(fleet)) agent.publish()
  assert.equal(
    recorded.length,
    EVENT_TYPES.length * 2,
    'state firehose stays outside the typed bus',
  )
})

test('fleet buses are isolated and retain their bridge across bot disconnects', (t) => {
  const a = fixture(t),
    b = fixture(t),
    received = []
  a.events.on('event', (event) => received.push(event))
  b.scout.emit('travel.route', { status: 'running' })
  assert.equal(received.length, 0)
  a.scout.disconnect()
  a.scout.emit('travel.route', { status: 'running' })
  assert.equal(received.length, 1)
  assert.equal(received[0].botId, 'scout')
})

test('detaching and closing a bus remove only its forwarding listeners', (t) => {
  const fleet = fixture(t),
    received = []
  let local = 0
  const observer = () => local++
  fleet.scout.on('travel.route', observer)
  fleet.events.on('event', (event) => received.push(event))
  fleet.events.detach(fleet.scout)
  fleet.events.detach(fleet.scout)
  fleet.scout.emit('travel.route', {})
  fleet.builder.emit('travel.route', {})
  assert.equal(local, 1)
  assert.deepEqual(
    received.map((e) => e.botId),
    ['builder'],
  )
  fleet.events.attach(fleet.scout)
  fleet.scout.emit('travel.route', {})
  assert.equal(local, 2)
  assert.deepEqual(
    received.map((e) => e.botId),
    ['builder', 'scout'],
  )
  const counts = Object.fromEntries(
    Object.values(fleet).map((agent) => [
      agent.id,
      Object.fromEntries(EVENT_TYPES.map((type) => [type, agent.listenerCount(type)])),
    ]),
  )
  fleet.events.close()
  fleet.events.close()
  for (const agent of Object.values(fleet))
    for (const type of EVENT_TYPES)
      assert.equal(agent.listenerCount(type), counts[agent.id][type] - 1)
  fleet.scout.emit('travel.route', {})
  assert.equal(local, 3)
  assert.equal(received.length, 2)
  assert.equal(fleet.events.sources.size, 0)
  assert.equal(fleet.events.eventNames().length, 0)
})

test('profile validation prevents a bot from shadowing fleet.events', () => {
  assert.throws(() => validateProfiles([{ id: 'events', username: 'Events' }]), /reserved/)
})
