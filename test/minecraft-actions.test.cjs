const { test } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { Vec3 } = require('vec3')
const { placeBlockWithOptions, genericPlace, SUPPORTED_MINEFLAYER_VERSION } = require('../src/minecraft/actions.cjs')
const adapters = [[placeBlockWithOptions, '_placeBlockWithOptions'], [genericPlace, '_genericPlace']]
const nextTurn = () => new Promise(resolve => setImmediate(resolve))

test('placement compatibility tests target the installed and repository-pinned Mineflayer version', () => {
  assert.equal(require('../package.json').dependencies.mineflayer, SUPPORTED_MINEFLAYER_VERSION)
  assert.equal(require('mineflayer/package.json').version, SUPPORTED_MINEFLAYER_VERSION)
})

test('adapters preserve receiver, argument identities, argument count and exact return promise', async () => {
  for (const [adapter, name] of adapters) {
    const reference = { position: new Vec3(1, 64, 2) }, face = new Vec3(0, 1, 0)
    const options = { forceLook: 'ignore', swingArm: 'right', delta: new Vec3(0.5, 1, 0.5) }
    const result = Promise.resolve('server result'), calls = []
    const bot = { [name](...args) { assert.equal(this, bot); calls.push(args); return result } }
    assert.equal(adapter(bot, reference, face, options), result)
    assert.equal(calls[0][0], reference); assert.equal(calls[0][1], face); assert.equal(calls[0][2], options)
    assert.equal(adapter(bot, reference, face), result)
    assert.equal(calls[1].length, 2)
    assert.equal(await result, 'server result')
  }
})

test('adapters preserve synchronous throws and promise rejection without retrying', async () => {
  for (const [adapter, name] of adapters) {
    const failure = new Error('server refused placement'); let calls = 0
    const bot = { [name]() { calls++; throw failure } }
    assert.throws(() => adapter(bot, {}, {}, {}), error => error === failure)
    assert.equal(calls, 1)
    const rejected = Promise.reject(failure)
    bot[name] = () => { calls++; return rejected }
    assert.equal(adapter(bot, {}, {}, {}), rejected)
    await assert.rejects(rejected, error => error === failure)
    assert.equal(calls, 2)
  }
})

test('missing private APIs fail clearly without falling back to unconfirmed public placement', () => {
  for (const [adapter, name] of adapters) {
    let fallback = false
    for (const bot of [null, { [name]: true, placeBlock() { fallback = true }, activateBlock() { fallback = true } }]) {
      assert.throws(() => adapter(bot, {}, {}, {}), error => {
        assert.equal(error.code, 'MINECRAFT_ADAPTER_UNSUPPORTED')
        assert.equal(error.method, name)
        assert.match(error.message, /4\.39\.0/)
        return true
      })
    }
    assert.equal(fallback, false)
  }
})

function installedPlugins() {
  const packets = [], swings = [], registry = require('minecraft-data')('1.21.1')
  const bot = Object.assign(new EventEmitter(), { registry, heldItem: { name: 'dirt' }, inventory: { slots: [] },
    supportFeature: feature => feature === 'blockPlaceHasInsideBlock',
    _client: { write: (...args) => packets.push(args) },
    lookAt: () => { throw new Error('An uncancellable internal turn must not occur.') },
    swingArm: (...args) => swings.push(args), blockAt: () => ({ type: 0, name: 'air' }),
  })
  require('mineflayer/lib/plugins/generic_place')(bot)
  require('mineflayer/lib/plugins/place_block')(bot)
  return { bot, packets, swings, reference: { position: new Vec3(1, 64, 2) }, face: new Vec3(0, 1, 0) }
}

test('installed generic placement supports forceLook ignore and sends exactly one interaction', async () => {
  const { bot, reference, face, packets, swings } = installedPlugins()
  const position = await genericPlace(bot, reference, face, { forceLook: 'ignore', swingArm: 'right' })
  assert.equal(position, reference.position)
  assert.equal(packets.length, 1); assert.equal(packets[0][0], 'block_place')
  assert.equal(packets[0][1].location, reference.position); assert.equal(packets[0][1].direction, 1)
  assert.deepEqual(swings, [['right', undefined]])
})

test('installed block placement still awaits the server update and rejects refusal', async () => {
  for (const accepted of [true, false]) {
    const { bot, reference, face, packets } = installedPlugins()
    const pending = placeBlockWithOptions(bot, reference, face, { forceLook: 'ignore', swingArm: 'right' })
    let settled = false
    pending.then(() => { settled = true }, () => { settled = true })
    await nextTurn()
    assert.equal(settled, false); assert.equal(packets.length, 1)
    const oldBlock = { type: 0, name: 'air' }
    bot.emit(`blockUpdate:${reference.position}`, oldBlock, oldBlock)
    bot.emit(`blockUpdate:${reference.position.plus(face)}`, oldBlock, accepted ? { type: 1, name: 'dirt' } : oldBlock)
    if (accepted) await pending
    else await assert.rejects(pending, /Server refused to place/)
    assert.equal(settled, true)
  }
})
