const { test } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { streamEvents, EVENT_TYPES } = require('../src/web/events.cjs')

function fixture(query = {}, agent = null) {
  agent ||= Object.assign(new EventEmitter(), {
    id: 'scout',
    state: { username: 'Scout', inventory: [{ name: 'stone', count: 20 }] },
  })
  const frames = [],
    headers = {}
  const res = Object.assign(new EventEmitter(), {
    writableLength: 0,
    destroyed: false,
    set(value) {
      Object.assign(headers, value)
    },
    flushHeaders() {},
    write(frame) {
      frames.push(frame)
      return true
    },
    destroy() {
      this.destroyed = true
      this.emit('close')
    },
  })
  streamEvents(agent, { query }, res)
  return { agent, res, frames, headers }
}
const data = (frame) => JSON.parse(frame.match(/^data: (.+)$/m)[1])

test('default stream sends immediate and periodic snapshots, with named events between them', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const { agent, res, frames, headers } = fixture()
  t.after(() => res.destroy())
  assert.equal(headers['Content-Type'], 'text/event-stream')
  assert.equal(headers['X-Accel-Buffering'], 'no')
  assert.deepEqual(data(frames[0]), agent.state)
  assert.ok(frames[0].startsWith('data: '), 'legacy onmessage receives raw state')
  for (let n = 0; n < 2000; n++) {
    agent.state.count = n
    agent.emit('state', agent.state)
  }
  assert.equal(frames.length, 1, 'state publications do not trigger full-state frames')
  for (const type of EVENT_TYPES) agent.emit(type, { marker: type })
  for (const [i, type] of EVENT_TYPES.entries()) {
    assert.ok(frames[i + 1].startsWith(`event: ${type}\n`))
    const envelope = data(frames[i + 1])
    assert.deepEqual(Object.keys(envelope), ['type', 'botId', 'at', 'payload'])
    assert.equal(envelope.type, type)
    assert.equal(envelope.botId, 'scout')
    assert.ok(Number.isFinite(envelope.at))
    assert.deepEqual(envelope.payload, { marker: type })
  }
  t.mock.timers.tick(4999)
  assert.equal(frames.length, EVENT_TYPES.length + 1)
  t.mock.timers.tick(1)
  assert.equal(data(frames.at(-1)).count, 1999)
  t.mock.timers.tick(15000)
  assert.ok(frames.includes(': heartbeat\n\n'))
})

test('subscriptions filter types, deduplicate names and preserve every result in a burst', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const f = fixture({ events: 'skill.result,travel.placed,skill.result', snapshotMs: '60000' })
  const snapshots = fixture({ events: 'none', snapshotMs: '100' }, f.agent)
  t.after(() => {
    f.res.destroy()
    snapshots.res.destroy()
  })
  assert.equal(f.agent.listenerCount('skill.result'), 1)
  f.agent.emit('travel.route', { path: [] })
  f.agent.emit('supervisor.decision', { kind: 'wait' })
  for (let n = 0; n < 30; n++) f.agent.emit('skill.result', { runId: `run-${n}` })
  f.agent.emit('travel.placed', { block: 'dirt' })
  assert.equal(f.frames.length, 32)
  assert.equal(snapshots.frames.length, 1)
  assert.deepEqual(
    f.frames.slice(1, -1).map((frame) => data(frame).payload.runId),
    Array.from({ length: 30 }, (_, n) => `run-${n}`),
  )
  assert.equal(data(f.frames.at(-1)).type, 'travel.placed')
  t.mock.timers.tick(100)
  assert.equal(snapshots.frames.length, 2)
  assert.equal(f.frames.length, 32)
})

for (const failure of ['close', 'error', 'slow']) {
  test(`${failure} streams remove every listener and stop their timers`, (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] })
    const { agent, res, frames } = fixture()
    assert.equal(agent.listenerCount('travel.route'), 1)
    if (failure === 'slow') {
      res.writableLength = 256 * 1024 + 1
      agent.emit('travel.route', { route: {} })
      assert.equal(res.destroyed, true)
    } else res.emit(failure)
    for (const type of EVENT_TYPES) assert.equal(agent.listenerCount(type), 0)
    assert.equal(agent.listenerCount('state'), 0)
    const before = frames.length
    t.mock.timers.tick(60000)
    agent.emit('skill.result', {})
    assert.equal(frames.length, before)
  })
}

test('serialization failure disconnects only the affected stream without interrupting its publisher', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const f = fixture({ events: 'travel.route' })
  const resultOnly = fixture({ events: 'skill.result' }, f.agent)
  t.after(() => resultOnly.res.destroy())
  const payload = {}
  payload.self = payload
  assert.doesNotThrow(() => f.agent.emit('travel.route', payload))
  assert.equal(f.res.destroyed, true)
  f.agent.emit('skill.result', { outcome: 'succeeded' })
  assert.equal(data(resultOnly.frames.at(-1)).payload.outcome, 'succeeded')
})
