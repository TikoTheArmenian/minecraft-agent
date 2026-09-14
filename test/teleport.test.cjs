const { test } = require('node:test')
const assert = require('node:assert/strict')
const { fixture, Vec3 } = require('./helpers/survival-fixture.cjs')
const { installTeleportHandling } = require('../src/teleport.cjs')
const { watchBlock } = require('../src/block-updates.cjs')

function setup() {
  const f = fixture()
  f.agent.stop = () => { f.agent.nav++; f.work.cancel(); f.bot.stopDigging(); f.agent.state.task.status = 'cancelled' }
  f.agent.log = () => {}
  installTeleportHandling(f.agent, f.bot, () => f.agent.bot === f.bot)
  f.teleport = p => { f.bot._client.emit('position', {}); f.bot.entity.position = p; f.bot.emit('forcedMove') }
  return f
}
test('teleport cancels an old block-confirmation wait without disconnecting', async () => {
  const f = setup()
  const watch = watchBlock(f.bot, new Vec3(1,64,0), () => true, f.work.controller.signal)
  const pending = f.work.timed(() => watch.promise, 4000, 'Confirm old dig')
  await new Promise(setImmediate)
  f.teleport(new Vec3(100,64,100))
  await assert.rejects(pending, /Cancelled/)
  assert.equal(f.agent.bot, f.bot)
  assert.equal(f.agent.state.connection, 'ready')
  assert.match(f.agent.state.task.label, /Teleported/)
  assert.equal(f.bot._client.listenerCount('block_change'), 0)
})
test('small position corrections and initial spawn do not cancel work', () => {
  const f = setup()
  f.bot.emit('forcedMove')
  f.teleport(new Vec3(0.3,64,0))
  assert.equal(f.work.cancelled(), false)
})
test('teleport during mining prevents waiting for the obsolete block', async () => {
  const f = setup(), p = new Vec3(1,64,0)
  f.set('dirt', p)
  f.bot.dig = async () => { f.teleport(new Vec3(100,64,100)) }
  await assert.rejects(f.work.dig(p, 'dirt'), /Cancelled/)
  assert.equal(f.agent.bot, f.bot)
  assert.equal(f.bot._client.listenerCount('block_change'), 0)
})
