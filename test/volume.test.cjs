const { test } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { fixture, Vec3 } = require('./helpers/survival-fixture.cjs')
const { buildVolume, trackPath } = require('../src/world/volume.cjs')
test('volume defaults to exactly 7 cubed positions centered on the chosen player', () => {
  const { bot } = fixture()
  bot.players.Alex = { username: 'Alex', entity: { position: new Vec3(-12.2, 65, 4) } }
  let reads = 0
  bot.blockAt = (p) => {
    reads++
    return { name: p.y === 65 ? 'air' : 'stone', shapes: [[0, 0, 0, 1, 0.5, 1]] }
  }
  const volume = buildVolume(bot, { focus: 'Alex' })
  assert.equal(reads, 343)
  assert.deepEqual(volume.origin, { x: -16, y: 62, z: 1 })
  assert.equal(volume.blocks.length, 294)
  assert.equal(volume.focus, 'Alex')
  assert.deepEqual(volume.blocks[0].shapes, [[0, 0, 0, 1, 0.5, 1]])
  assert.ok(volume.blocks.every((b) => b.x >= 0 && b.x < 7 && b.y < 7 && b.z < 7))
})
test('unknown terrain is separate from air and forged volume requests are rejected', () => {
  const { bot } = fixture()
  bot.blockAt = () => null
  assert.equal(buildVolume(bot).unknown.length, 343)
  assert.equal(buildVolume(bot).blocks.length, 0)
  for (const size of [0, 8, 999, NaN]) assert.throws(() => buildVolume(bot, { size }), /view size/)
  assert.throws(() => buildVolume(bot, { focus: 'missing' }), /loaded range/)
  assert.throws(() => buildVolume(bot, { focus: [] }), /focus/)
})
test('route follows live path nodes and clears on reset, stop, completion and world changes', () => {
  const { bot } = fixture()
  const emitter = new EventEmitter()
  bot.on = emitter.on.bind(emitter)
  trackPath(bot)
  for (const event of ['path_reset', 'path_stop', 'goal_reached', 'end', 'respawn', 'forcedMove']) {
    const path = [
      { x: 1.5, y: 64, z: 0.5 },
      { x: 2.5, y: 64, z: 0.5 },
    ]
    emitter.emit('path_update', { status: 'success', path })
    assert.equal(buildVolume(bot).path.points.length, 3)
    path.shift()
    assert.equal(buildVolume(bot).path.points[1].x, 2.5)
    emitter.emit(event)
    assert.deepEqual(buildVolume(bot).path.points, [])
  }
})

test('volume HTTP endpoint validates requests and rejects disconnected bots', async (t) => {
  const { createApp } = require('../src/web/server.cjs')
  const { bot } = fixture()
  const agent = { bot, state: { connection: 'ready' }, log() {} }
  const server = createApp(agent).listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  t.after(() => {
    server.closeAllConnections()
    server.close()
  })
  const url = `http://127.0.0.1:${server.address().port}/api/map/volume`
  const response = await fetch(url)
  assert.equal(response.status, 200)
  assert.equal((await response.json()).size, 7)
  assert.equal((await fetch(`${url}?size=1000`)).status, 400)
  assert.equal((await fetch(`${url}?focus=missing`)).status, 400)
  agent.state.connection = 'disconnected'
  assert.equal((await fetch(url)).status, 400)
})

test('17 by 5 by 17 samples only five centered layers and bounds entities vertically', () => {
  const { bot } = fixture()
  let reads = 0
  bot.blockAt = () => {
    reads++
    return null
  }
  const result = buildVolume(bot, { size: 17, height: 5 })
  assert.equal(reads, 1445)
  assert.equal(result.unknown.length, 1445)
  assert.equal(result.height, 5)
  assert.equal(result.origin.y, Math.floor(bot.entity.position.y) - 2)
  assert.equal(result.origin.x, Math.floor(bot.entity.position.x) - 8)
  assert.throws(() => buildVolume(bot, { size: 17, height: 100 }), /height/)
  assert.throws(() => buildVolume(bot, { size: 7, height: 11 }), /height/)
})
