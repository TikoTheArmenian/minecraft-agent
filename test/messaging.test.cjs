const test = require('node:test')
const assert = require('node:assert/strict')
const { PeerDirectory, MessageRouter } = require('../src/messaging/index.cjs')

function setup(options = {}) {
  let now = 100000
  const sent = []
  const make = (username) => ({
    username,
    epoch: 1,
    profile: { id: username.toLowerCase(), capabilities: [] },
    state: { world: 'world', dimension: 'overworld', connection: 'ready' },
    log() {},
    bot: {
      chat(text) {
        sent.push({ from: username, channel: 'chat', text })
      },
      whisper(to, text) {
        sent.push({ from: username, to, channel: 'whisper', text })
      },
    },
  })
  const a = make('Alpha'),
    b = make('Beta'),
    c = make('Gamma'),
    agents = { a, b, c }
  const directory = new PeerDirectory({ agents: () => agents })
  for (const agent of Object.values(agents)) {
    agent.peerDirectory = directory.forAgent(agent)
    agent.messages = new MessageRouter(agent, {
      now: () => now,
      intervalMs: 0,
      ...options,
      directory,
    })
  }
  const flush = (agent) => {
    let count = 0
    while (agent.messages.queue.length) {
      assert.ok(++count < 1000)
      agent.messages.tick()
    }
  }
  const deliver = (target, frames = sent.splice(0)) => {
    for (const frame of frames)
      target.messages.receive(target.bot, frame.from, frame.text, frame.channel)
  }
  return {
    a,
    b,
    c,
    agents,
    directory,
    sent,
    flush,
    deliver,
    advance: (ms) => {
      now += ms
    },
  }
}

test('actual whisper fragments reassemble once, preserve correlation, and acknowledge receipt without an LLM', () => {
  const { a, b, sent, flush, deliver } = setup()
  const events = [],
    deliveries = []
  b.messages.on('message', (value) => events.push(value))
  a.messages.on('delivery', (value) => deliveries.push(value))
  const receipt = a.messages.send({
    to: 'Beta',
    channel: 'whisper',
    kind: 'request',
    payload: { text: 'Bring 16 dirt. 🪨'.repeat(30) },
  })
  assert.ok(receipt.fragments > 1)
  flush(a)
  assert.ok(sent.every((f) => f.channel === 'whisper' && f.to === 'Beta' && f.text.length <= 220))
  const frames = sent.splice(0)
  deliver(b, [...frames].reverse())
  deliver(b, frames)
  assert.equal(events.length, 1)
  assert.equal(events[0].id, receipt.id)
  assert.equal(events[0].channel, 'whisper')
  assert.match(events[0].payload.text, /🪨/)
  flush(b)
  deliver(a)
  assert.ok(deliveries.some((d) => d.id === receipt.id && d.status === 'received'))
  assert.equal(a.messages.inbox.length, 0, 'ACKs never become supervisor requests')
  assert.equal(a.messages.queue.length, 0, 'ACKs never create reply loops')
})

test('public addressed transport is delivered only to the named bot, while broadcasts remain public', () => {
  const { a, b, c, sent, flush, deliver } = setup()
  a.messages.send({ to: 'Beta', channel: 'chat', payload: { text: 'Are you available?' } })
  flush(a)
  const frames = sent.splice(0)
  assert.ok(frames.every((f) => f.channel === 'chat'))
  deliver(c, frames)
  deliver(b, frames)
  assert.equal(c.messages.inbox.length, 0)
  assert.equal(b.messages.drain().length, 1)
  a.messages.send({ to: 'broadcast', payload: { text: 'New storage hub.' } })
  flush(a)
  const broadcast = sent.splice(0)
  deliver(b, broadcast)
  deliver(c, broadcast)
  assert.equal(b.messages.inbox[0].to, 'broadcast')
  assert.equal(c.messages.inbox.length, 1)
  assert.throws(
    () => a.messages.send({ to: 'broadcast', channel: 'whisper', payload: {} }),
    /named whisper/,
  )
})

test('missing or corrupted fragments never publish or acknowledge a complete logical message', () => {
  const { a, b, sent, flush, deliver } = setup()
  a.messages.send({ to: 'Beta', payload: { text: 'Sand '.repeat(150) } })
  flush(a)
  const frames = sent.splice(0)
  deliver(b, frames.slice(1))
  assert.equal(b.messages.inbox.length, 0)
  assert.equal(b.messages.queue.length, 0)
  const corrupted = { ...frames[0], text: frames[0].text.replace(/.$/, 'X') }
  deliver(b, [corrupted])
  assert.equal(b.messages.inbox.length, 0)
  assert.equal(b.messages.queue.length, 0)
})

test('channel mismatch, spoofed sender, changed world and stale sender epoch cannot deliver', () => {
  const { a, b, c, sent, flush, deliver } = setup()
  a.messages.send({ to: 'Beta', channel: 'whisper', payload: { text: 'Hello' } })
  flush(a)
  const frames = sent.splice(0)
  deliver(
    b,
    frames.map((frame) => ({ ...frame, channel: 'chat' })),
  )
  deliver(
    b,
    frames.map((frame) => ({ ...frame, from: c.username })),
  )
  assert.equal(b.messages.inbox.length, 0)
  a.epoch++
  deliver(b, frames)
  assert.equal(b.messages.inbox.length, 0)
  a.epoch--
  b.state.dimension = 'nether'
  deliver(b, frames)
  assert.equal(b.messages.inbox.length, 0)
})

test('disconnect/reconnect discards local inbox, partial messages, and stale outbound work', () => {
  const { a, b, sent, flush, deliver } = setup()
  a.messages.send({ to: 'Beta', payload: { text: 'Do not replay me.' } })
  flush(a)
  const frames = sent.splice(0)
  deliver(b, frames.slice(0, 1))
  assert.equal(b.messages.assemblies.size, 1)
  b.epoch++
  b.messages.tick()
  assert.equal(b.messages.assemblies.size, 0)
  deliver(b, frames)
  assert.equal(
    b.messages.inbox.length,
    0,
    'a complete old message is also bound to the former receiving session',
  )
  a.messages.send({ to: 'Beta', payload: { text: 'Queued before receiver reconnect.' } })
  b.epoch++
  flush(a)
  assert.equal(sent.length, 0)
  a.messages.send({ to: 'Beta', payload: { text: 'Queued before sender reconnect.' } })
  a.epoch++
  a.messages.tick()
  assert.equal(a.messages.queue.length, 0)
})

test('outbound and inbox overflow reject complete messages honestly without partial admission', () => {
  const { a, b, sent, flush, deliver } = setup({ maxInbox: 1 })
  a.messages.send({ to: 'Beta', payload: { text: 'first' } })
  flush(a)
  deliver(b)
  assert.equal(b.messages.inbox.length, 1)
  flush(b)
  deliver(a)
  a.messages.send({ to: 'Beta', payload: { text: 'second' } })
  flush(a)
  deliver(b, sent.splice(0))
  assert.equal(b.messages.inbox.length, 1)
  assert.equal(b.messages.queue.length, 0, 'overflow does not claim receipt')
  const bounded = setup({ maxQueue: 1 })
  assert.throws(
    () => bounded.a.messages.send({ to: 'Beta', payload: { text: 'Too many fragments' } }),
    /queue is full/,
  )
  assert.equal(bounded.a.messages.queue.length, 0)
})

test('expiry prunes incomplete fragments and reports unconfirmed delivery without resending', () => {
  const { a, b, sent, flush, deliver, advance } = setup({ ttlMs: 1000 })
  const events = []
  a.messages.on('delivery', (event) => events.push(event))
  a.messages.send({ to: 'Beta', payload: { text: 'Time bounded' } })
  flush(a)
  const frames = sent.splice(0)
  deliver(b, frames.slice(0, 1))
  advance(1001)
  a.messages.tick()
  b.messages.tick()
  assert.equal(b.messages.assemblies.size, 0)
  assert.ok(events.some((event) => event.status === 'expired'))
  deliver(b, frames)
  assert.equal(b.messages.inbox.length, 0)
  assert.equal(a.messages.queue.length, 0)
})

test('ordinary addressed chat and private peer text enqueue context without executing commands', () => {
  const { a, b } = setup()
  let commands = 0
  b.command = () => {
    commands++
  }
  assert.equal(b.messages.receive(b.bot, 'Alpha', 'Everyone can hear this'), false)
  assert.equal(b.messages.receive(b.bot, 'Alpha', 'Beta: start smelt raw_iron 16'), true)
  assert.equal(b.messages.receive(b.bot, 'Alpha', 'start smelt raw_iron 16', 'whisper'), true)
  assert.equal(commands, 0)
  assert.equal(b.messages.inbox.length, 2)
  assert.equal(b.messages.inbox[1].channel, 'whisper')
  assert.equal(b.messages.receive(b.bot, 'Human', 'Beta: hello'), false)
  assert.equal(b.messages.receive({}, a.username, 'Beta: hello'), false)
})

test('peer directory exposes immutable descriptors and scopes capabilities to connected peers', () => {
  const { a, b } = setup()
  b.profile.capabilities = ['storageCoordinator']
  const descriptor = a.peerDirectory.get('Beta')
  assert.equal(descriptor.bot, undefined)
  assert.equal(descriptor.startWork, undefined)
  assert.ok(Object.isFrozen(descriptor))
  assert.equal(a.peerDirectory.hasCapability('Beta', 'storageCoordinator'), true)
  b.state.connection = 'disconnected'
  assert.equal(a.peerDirectory.get('Beta'), undefined)
})

test('fragment sizes account for the installed Mineflayer whisper header on legacy short chat', () => {
  const { a, b, sent, flush, deliver } = setup()
  a.bot.supportFeature = (feature) => feature === 'lessCharsInChat'
  a.messages.send({ to: 'Beta', channel: 'whisper', payload: { text: 'short packets' } })
  flush(a)
  assert.ok(sent.every((frame) => frame.text.length + '/tell Beta '.length <= 100))
  deliver(b)
  assert.equal(b.messages.inbox.length, 1)
})

test('exchange request/accept admits both owners synchronously and rejects a competing participant', () => {
  const { a, b, c, directory } = setup()
  const position = { distanceTo: () => 1 }
  for (const agent of [a, b, c]) agent.bot.entity = { position }
  const work = { agent: a, bot: a.bot, check() {} },
    other = { agent: c, bot: c.bot, check() {} }
  a.activeWork = work
  c.activeWork = other
  let admissions = 0
  b.acceptExchange = (command, session) => {
    assert.deepEqual(command, { type: 'exchange' })
    assert.ok(!b.activeWork)
    b.activeWork = { agent: b, bot: b.bot }
    session.works.push(b.activeWork)
    admissions++
  }
  const policy = {
    eligible: (from, to) => from !== to && !to.activeWork,
    plan: () => ({ legs: [], automatic: true }),
  }
  const session = directory.forAgent(a).requestExchange(work, 'Beta', {}, policy)
  assert.equal(session.works.length, 2)
  assert.throws(
    () => directory.forAgent(c).requestExchange(other, 'Beta', {}, policy),
    /No available partner/,
  )
  assert.equal(admissions, 1)
  session.resolve()
  b.activeWork = null
  const next = directory.forAgent(c).requestExchange(other, 'Beta', {}, policy)
  assert.equal(admissions, 2)
  next.resolve()
})
