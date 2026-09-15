const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { Agent, parse } = require('../src/agents/agent.cjs')
const { Exchange, parseExchange, plan, eligible } = require('../src/skills/exchange.cjs')
const { receiveControl } = require('../src/messaging/skill-chat.cjs')
const { fixture, Vec3 } = require('./helpers/survival-fixture.cjs')
function setup(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-exchange-'))
  const a = fixture(),
    b = fixture()
  for (const [f, username, id] of [
    [a, 'Marc', 1],
    [b, 'Jerry', 2],
  ]) {
    f.agent = new Agent({ username, dataDir: path.join(dataDir, username) })
    f.agent.bot = f.bot
    f.agent.state.connection = 'ready'
    f.agent.state.dimension = 'overworld'
    f.bot.username = username
    f.bot.entity.id = id
    f.bot.entity.position = new Vec3(id * 2 + 0.5, 64, 0.5)
    f.bot.lookAt = async () => {}
    f.bot.chat = () => {}
  }
  a.bot.players.Jerry = { entity: b.bot.entity }
  b.bot.players.Marc = { entity: a.bot.entity }
  a.agent.fleet = b.agent.fleet = { marc: a.agent, jerry: b.agent }
  const moves = Exchange.prototype.move
  Exchange.prototype.move = async function (goal) {
    this.check()
    if (Number.isFinite(goal.x))
      this.bot.entity.position = new Vec3(goal.x + 0.5, goal.y, goal.z + 0.5)
  }
  t.after(() => {
    Exchange.prototype.move = moves
    a.agent.stop(false)
    b.agent.stop(false)
    fs.rmSync(dataDir, { recursive: true, force: true })
  })
  let entityId = 100
  const transfers = []
  for (const [from, to] of [
    [a, b],
    [b, a],
  ])
    from.bot.toss = async (type, metadata, count) => {
      const name = from.bot.registry.items[type].name
      transfers.push({ from: from.agent.username, name, count })
      from.add(name, -count)
      const drop = {
        id: ++entityId,
        name: 'item',
        position: from.bot.entity.position.clone(),
        getDroppedItem: () => ({ name, type, count }),
      }
      to.bot.entities[drop.id] = drop
      to.bot.emit('entitySpawn', drop)
      to.add(name, count)
      to.bot.emit('playerCollect', to.bot.entity, drop)
      delete to.bot.entities[drop.id]
    }
  return { a, b, transfers }
}
async function settled(...agents) {
  for (let i = 0; i < 1000 && agents.some((a) => a.workActive); i++)
    await new Promise((r) => setTimeout(r, 1))
  assert.ok(
    agents.every((a) => !a.workActive),
    'both task locks must settle',
  )
}

test('exchange parser validates bounded gifts/trades and supports web and Minecraft phrasing', () => {
  assert.deepEqual(parse('exchange with Jerry'), { type: 'exchange', peer: 'jerry' })
  const gift = { type: 'exchange', peer: 'jerry', give: { name: 'dirt', count: 16 } }
  assert.deepEqual(parseExchange('give Jerry 16 dirt'), gift)
  assert.deepEqual(parseExchange('give 16 dirt to Jerry'), gift)
  assert.equal(parse('trade Jerry 16 wheat for 8 oak_log').receive.count, 8)
  assert.throws(() => parseExchange('give Jerry 0 dirt'), /1–64/)
  assert.throws(() => parseExchange('give Jerry 65 dirt'), /1–64/)
  assert.throws(() => parseExchange('trade Jerry 1 dirt for 1 dirt'), /different/)
})
test('automatic decision preserves reserves and chooses reciprocal surplus or a one-way gift', (t) => {
  const { a, b } = setup(t)
  a.add('bread', 32)
  b.add('oak_log', 40)
  const trade = plan(a.agent, b.agent, {})
  assert.deepEqual(
    trade.legs.map((l) => [l.name, l.count]),
    [
      ['bread', 16],
      ['oak_log', 16],
    ],
  )
  a.add('bread', -16)
  assert.equal(plan(a.agent, b.agent, {}).legs.length, 1)
  b.add('oak_log', -24)
  assert.throws(() => plan(a.agent, b.agent, {}), /Neither bot/)
})
test('busy, distant, disconnected and different-world partners are excluded', (t) => {
  const { a, b } = setup(t)
  assert.equal(eligible(a.agent, b.agent), true)
  b.agent.activeWork = { cancel() {} }
  assert.equal(eligible(a.agent, b.agent), false)
  b.agent.activeWork = null
  b.agent.state.world = 'Other'
  assert.equal(eligible(a.agent, b.agent), false)
  b.agent.state.world = a.agent.state.world
  b.agent.state.dimension = 'the_nether'
  assert.equal(eligible(a.agent, b.agent), false)
  b.agent.state.dimension = a.agent.state.dimension
  b.bot.entity.position.x = 100
  assert.equal(eligible(a.agent, b.agent), false)
  b.bot.entity.position.x = 4
  b.agent.state.connection = 'disconnected'
  assert.equal(eligible(a.agent, b.agent), false)
})
test('full inventory, insufficient stock and modified items reject the agreement before tossing', (t) => {
  const { a, b, transfers } = setup(t)
  a.add('dirt', 16)
  const command = parseExchange('give Jerry 16 dirt')
  b.bot.inventory.emptySlotCount = () => 0
  assert.throws(() => plan(a.agent, b.agent, command), /inventory space/)
  b.bot.inventory.emptySlotCount = () => 10
  assert.throws(() => plan(a.agent, b.agent, parseExchange('give Jerry 32 dirt')), /does not have/)
  a.items[0].nbt = { type: 'compound', value: { name: 'personal' } }
  assert.throws(() => plan(a.agent, b.agent, command), /custom data/)
  assert.equal(transfers.length, 0)
})
test('addressed gift acquires both bots and reports verified inventory gains', async (t) => {
  const { a, b, transfers } = setup(t)
  a.add('dirt', 16)
  assert.equal(receiveControl(a.agent, a.bot, 'Player', 'Marc, give Jerry 16 dirt'), true)
  assert.equal(a.agent.workActive, true)
  assert.equal(b.agent.workActive, true)
  await settled(a.agent, b.agent)
  assert.equal(transfers.length, 1)
  assert.equal(a.agent.state.task.status, 'succeeded')
  assert.equal(b.agent.state.task.status, 'succeeded')
  assert.equal(a.agent.state.task.counts.given, 16)
  assert.equal(b.agent.state.task.counts.received, 16)
  assert.equal(a.agent.state.task.exchange.transfers[0].status, 'confirmed')
  assert.notEqual(a.agent.state.task.exchange, b.agent.state.task.exchange)
  assert.equal(b.bot.listenerCount('playerCollect'), 0)
  assert.equal(b.bot.listenerCount('entitySpawn'), 0)
})
test('two-way exchange confirms each leg and then releases both task locks', async (t) => {
  const { a, b, transfers } = setup(t)
  a.add('wheat', 24)
  b.add('oak_log', 16)
  a.agent.command('trade Jerry 16 wheat for 8 oak_log')
  await settled(a.agent, b.agent)
  assert.deepEqual(
    transfers.map((l) => l.name),
    ['wheat', 'oak_log'],
  )
  assert.equal(a.agent.state.task.counts.received, 8)
  assert.equal(b.agent.state.task.counts.received, 16)
  assert.equal(b.agent.state.task.exchange.transfers.length, 2)
})
test('a peer with an active production skill is never stopped to accept a gift', async (t) => {
  const { a, b, transfers } = setup(t)
  let cancelled = false
  b.agent.activeWork = {
    cancel() {
      cancelled = true
    },
  }
  a.add('dirt', 16)
  a.agent.command('give Jerry 16 dirt')
  await settled(a.agent)
  assert.equal(cancelled, false)
  assert.equal(transfers.length, 0)
  assert.equal(a.agent.state.task.status, 'failed')
})
test('both sides are revalidated after travel before the first handoff', async (t) => {
  const { a, b, transfers } = setup(t)
  a.add('wheat', 16)
  b.add('oak_log', 8)
  const meet = Exchange.prototype.meet
  Exchange.prototype.meet = async function () {
    b.add('oak_log', -8)
  }
  t.after(() => {
    Exchange.prototype.meet = meet
  })
  a.agent.command('trade Jerry 16 wheat for 8 oak_log')
  await settled(a.agent, b.agent)
  assert.equal(transfers.length, 0)
  assert.equal(a.agent.state.task.status, 'failed')
})
test('Stop on the recipient cancels the giver before the first toss', async (t) => {
  const { a, b, transfers } = setup(t)
  a.add('dirt', 16)
  const meet = Exchange.prototype.meet
  Exchange.prototype.meet = async function () {
    b.agent.stop()
    this.check()
  }
  t.after(() => {
    Exchange.prototype.meet = meet
  })
  a.agent.command('give Jerry 16 dirt')
  await settled(a.agent, b.agent)
  assert.equal(transfers.length, 0)
  assert.equal(a.agent.state.task.status, 'cancelled')
  assert.equal(b.agent.state.task.status, 'cancelled')
})
test('unconfirmed first handoff prevents the return trade and is not retried', async (t) => {
  const { a, b, transfers } = setup(t)
  a.add('wheat', 16)
  b.add('oak_log', 8)
  a.bot.toss = async () => {
    a.add('wheat', -16) // Client loss without a recipient collection is not success.
    b.agent.stop()
  }
  a.agent.command('trade Jerry 16 wheat for 8 oak_log')
  await settled(a.agent, b.agent)
  assert.equal(transfers.length, 0)
  assert.equal(a.agent.state.task.status, 'partial')
  assert.equal(a.agent.state.task.counts.given, 0)
  assert.equal(a.agent.state.task.exchange.transfers[0].status, 'uncertain')
  assert.match(a.agent.state.task.label, /check inventories/)
})
test('malformed game chat responds with usage instead of throwing in the event handler', (t) => {
  const { a } = setup(t)
  let reply
  a.bot.chat = (text) => {
    reply = text
  }
  assert.equal(receiveControl(a.agent, a.bot, 'Player', 'Marc, give Jerry 999 dirt'), true)
  assert.match(reply, /1–64/)
  assert.equal(a.agent.workActive, false)
})

test('automatic Exchange runs a reciprocal plan without explicit items', async (t) => {
  const { a, b, transfers } = setup(t)
  a.add('bread', 32)
  b.add('oak_log', 40)
  a.agent.command('exchange')
  await settled(a.agent, b.agent)
  assert.deepEqual(
    transfers.map((l) => [l.name, l.count]),
    [
      ['bread', 16],
      ['oak_log', 16],
    ],
  )
  assert.equal(a.items.find((i) => i.name === 'bread').count, 16)
  assert.equal(b.items.find((i) => i.name === 'oak_log').count, 24)
})
test('unrelated collection events and inventory gains cannot confirm a handoff', async (t) => {
  const { a, b } = setup(t)
  a.add('dirt', 16)
  // A pre-existing drop must never be attributed to this exchange.
  const old = {
    id: 77,
    name: 'item',
    position: a.bot.entity.position.clone(),
    getDroppedItem: () => ({ name: 'dirt', count: 16 }),
  }
  b.bot.entities[old.id] = old
  a.bot.toss = async () => {
    a.add('dirt', -16)
    b.add('dirt', 16)
    b.bot.emit('playerCollect', b.bot.entity, old)
  }
  const pause = Exchange.prototype.pause
  Exchange.prototype.pause = async function () {
    this.cancel()
    this.check()
  }
  t.after(() => {
    Exchange.prototype.pause = pause
  })
  a.agent.command('give Jerry 16 dirt')
  await settled(a.agent, b.agent)
  assert.equal(a.agent.state.task.counts.given, 0)
  assert.equal(a.agent.state.task.status, 'partial')
})
test('disconnecting the recipient mid-meeting releases both exchange locks', async (t) => {
  const { a, b, transfers } = setup(t)
  a.add('dirt', 16)
  const meet = Exchange.prototype.meet
  Exchange.prototype.meet = async function () {
    b.agent.disconnect()
    this.check()
  }
  t.after(() => {
    Exchange.prototype.meet = meet
  })
  a.agent.command('give Jerry 16 dirt')
  await settled(a.agent, b.agent)
  assert.equal(transfers.length, 0)
  assert.equal(a.agent.state.task.status, 'cancelled')
  assert.equal(b.agent.state.connection, 'disconnected')
})
test('partner on a different server or absent from loaded players cannot be selected', (t) => {
  const { a, b } = setup(t)
  a.bot._client.socket = { remotePort: 25565 }
  b.bot._client.socket = { remotePort: 25566 }
  assert.equal(eligible(a.agent, b.agent), false)
  b.bot._client.socket.remotePort = 25565
  assert.equal(eligible(a.agent, b.agent), true)
  delete a.bot.players.Jerry
  assert.equal(eligible(a.agent, b.agent), false)
})
test('Exchange metadata exposes its controls and progress to the dashboard', () => {
  const meta = require('../src/skills/registry.cjs')
    .publicSkills()
    .find((s) => s.type === 'exchange')
  assert.equal(meta.aliases[0], 'exchange')
  assert.equal(meta.taskSkill, 'EXCHANGE')
  assert.match(meta.description, /give Jerry/)
  assert.match(meta.limits, /Stop either bot/)
})

test('fresh airborne drops wait to land before the recipient walks to collect them', async (t) => {
  const { a, b } = setup(t)
  a.add('dirt', 16)
  let drop,
    pauses = 0,
    pickups = 0
  a.bot.toss = async () => {
    a.add('dirt', -16)
    drop = {
      id: 300,
      name: 'item',
      position: b.bot.entity.position.offset(0, 1.3, 0),
      getDroppedItem: () => ({ name: 'dirt', count: 16 }),
    }
    b.bot.entities[drop.id] = drop
    b.bot.emit('entitySpawn', drop)
  }
  const pause = Exchange.prototype.pause,
    move = Exchange.prototype.move
  Exchange.prototype.pause = async function () {
    this.check()
    assert.ok(++pauses < 5)
    drop.position.y = 64.1
  }
  Exchange.prototype.move = async function (goal, ...args) {
    if (goal.entity) {
      assert.ok(pauses > 0, 'must wait for the airborne item')
      pickups++
      b.add('dirt', 16)
      b.bot.emit('playerCollect', b.bot.entity, drop)
      delete b.bot.entities[drop.id]
    } else await move.call(this, goal, ...args)
  }
  t.after(() => {
    Exchange.prototype.pause = pause
    Exchange.prototype.move = move
  })
  a.agent.command('give Jerry 16 dirt')
  await settled(a.agent, b.agent)
  assert.equal(pickups, 1)
  assert.equal(a.agent.state.task.status, 'succeeded')
})

test('an immediately blocked chat exchange reports its reason instead of claiming it started', (t) => {
  const { a, b } = setup(t)
  b.agent.activeWork = { cancel() {} }
  a.add('dirt', 16)
  let reply
  a.bot.chat = (text) => {
    reply = text
  }
  receiveControl(a.agent, a.bot, 'Player', 'Marc, give Jerry 16 dirt')
  assert.match(reply, /No available partner/)
  assert.doesNotMatch(reply, /Started Exchange/)
})

test('both exchange intents are durable before toss and both results contain confirmed item effects', async (t) => {
  const { a, b } = setup(t)
  a.add('dirt', 16)
  const toss = a.bot.toss
  let operationId
  a.bot.toss = async (...args) => {
    const records = [a, b].map((f) =>
      JSON.parse(fs.readFileSync(f.agent.runtime.file, 'utf8')).data.runs.at(-1),
    )
    operationId = records[0].operations[0].id
    assert.equal(records[0].operations[0].status, 'intent')
    assert.equal(records[1].operations[0].status, 'intent')
    assert.equal(records[1].operations[0].id, operationId)
    assert.equal(records[0].operations[0].fromRunId, records[0].runId)
    assert.equal(records[0].operations[0].toRunId, records[1].runId)
    await toss(...args)
  }
  a.agent.command('give Jerry 16 dirt')
  await settled(a.agent, b.agent)
  for (const f of [a, b]) {
    const run = JSON.parse(fs.readFileSync(f.agent.runtime.file, 'utf8')).data.runs.at(-1)
    assert.equal(run.operations[0].status, 'confirmed')
    assert.deepEqual(run.result.outstandingOperationIds, [])
    assert.equal(run.result.confirmedEffects[0].operationId, operationId)
    assert.equal(run.result.confirmedEffects[0].item, 'dirt')
    assert.equal(run.result.confirmedEffects[0].count, 16)
  }
})

test('failed participant intent persistence prevents any toss and preserves a shared recovery identifier', async (t) => {
  const { a, b, transfers } = setup(t)
  a.add('dirt', 16)
  t.mock.method(b.agent.runtime, 'saveOperation', () => {
    throw Object.assign(new Error('Disk unavailable'), {
      code: 'CHECKPOINT_WRITE_FAILED',
      fatal: true,
    })
  })
  a.agent.command('give Jerry 16 dirt')
  await settled(a.agent, b.agent)
  assert.equal(transfers.length, 0)
  const left = a.agent.runtime.saved.runs.at(-1),
    right = b.agent.runtime.saved.runs.at(-1)
  assert.equal(left.result.outstandingOperationIds.length, 1)
  assert.deepEqual(left.result.outstandingOperationIds, right.result.outstandingOperationIds)
  assert.equal(left.operations[0].status, 'uncertain')
  assert.equal(left.result.confirmedEffects.length, 0)
})

test('failed confirmation persistence aborts the return leg and records uncertain transfer recovery for both bots', async (t) => {
  const { a, b, transfers } = setup(t)
  a.add('wheat', 16)
  b.add('oak_log', 8)
  const save = b.agent.runtime.saveOperation.bind(b.agent.runtime)
  t.mock.method(b.agent.runtime, 'saveOperation', (work, operation) => {
    if (operation.status === 'confirmed')
      throw Object.assign(new Error('Confirmation write failed'), {
        code: 'CHECKPOINT_WRITE_FAILED',
        fatal: true,
      })
    return save(work, operation)
  })
  a.agent.command('trade Jerry 16 wheat for 8 oak_log')
  await settled(a.agent, b.agent)
  assert.equal(transfers.length, 1)
  assert.equal(transfers[0].name, 'wheat')
  for (const f of [a, b]) {
    const run = JSON.parse(fs.readFileSync(f.agent.runtime.file, 'utf8')).data.runs.at(-1)
    assert.equal(run.operations[0].status, 'uncertain')
    assert.equal(run.result.outstandingOperationIds.length, 1)
    assert.equal(run.result.outcome, 'partial')
  }
})

test('uncertainty persistence failure preserves the original transfer failure and recovery evidence', async (t) => {
  const { a, b } = setup(t)
  a.add('dirt', 16)
  a.bot.toss = async () => {
    throw new Error('Toss rejected by server')
  }
  const save = b.agent.runtime.saveOperation.bind(b.agent.runtime)
  t.mock.method(b.agent.runtime, 'saveOperation', (work, operation) => {
    if (operation.status === 'uncertain') throw new Error('Uncertainty write failed')
    return save(work, operation)
  })
  a.agent.command('give Jerry 16 dirt')
  await settled(a.agent, b.agent)
  for (const f of [a, b]) {
    assert.match(f.agent.state.task.label, /Toss rejected by server/)
    assert.match(f.agent.state.task.label, /Uncertainty write failed/)
    assert.equal(f.agent.state.task.reasonCode, 'REQUIRES_RECONCILIATION')
    assert.equal(f.agent.state.task.exchange.transfers[0].status, 'uncertain')
    assert.equal(f.agent.runtime.saved.runs.at(-1).result.outstandingOperationIds.length, 1)
  }
  assert.equal(a.agent.runtime.saved.runs.at(-1).operations[0].status, 'uncertain')
  assert.equal(b.agent.runtime.saved.runs.at(-1).operations[0].status, 'intent')
  assert.equal(b.bot.listenerCount('playerCollect'), 0)
})
