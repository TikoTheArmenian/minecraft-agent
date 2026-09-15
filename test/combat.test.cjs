const { test } = require('node:test')
const assert = require('node:assert/strict')
const { setImmediate: turn } = require('node:timers/promises')
const { fixture, Vec3 } = require('./helpers/survival-fixture.cjs')
const { Work } = require('../src/runtime/work.cjs')
const { MeleeCombat, attackTicks, waitTicks } = require('../src/minecraft/combat.cjs')

function setup() {
  const h = fixture(), work = new Work(h.agent, 1), combat = new MeleeCombat(work)
  const target = { id: 100, position: new Vec3(2, 64, 0) }
  h.bot.entities[target.id] = target
  h.bot.heldItem = h.add('iron_sword')
  const attacks = [], actions = []
  h.bot.attack = (e) => attacks.push(e)
  const options = { canAttack: (e) => e.position.distanceTo(h.bot.entity.position) <= 3, aimPoint: (e) => e.position }
  return { ...h, work, combat, target, options, attacks, actions }
}

test('PVP weapon timing rounds up fractional cooldowns and supports pre-cooldown combat', () => {
  const h = setup()
  assert.equal(attackTicks(h.bot), 13)
  h.bot.heldItem = h.add('iron_axe')
  assert.equal(attackTicks(h.bot), 23)
  h.bot.heldItem = h.add('stone_axe')
  assert.equal(attackTicks(h.bot), 25)
  h.bot.supportFeature = () => false
  assert.equal(attackTicks(h.bot), 4)
})

test('cooldown waits for physics ticks and removes only its own listeners', async () => {
  const h = setup()
  const other = () => {}
  h.bot.on('physicsTick', other)
  let finished = false
  const waiting = waitTicks(h.work, 13).then(() => { finished = true })
  await turn()
  for (let i = 0; i < 12; i++) h.bot.emit('physicsTick')
  await turn()
  assert.equal(finished, false)
  h.bot.emit('physicsTick')
  await waiting
  assert.deepEqual(h.bot.listeners('physicsTick'), [other])
})

test('Stop aborts a tick wait immediately without retiring the connection', async () => {
  const h = setup()
  const waiting = waitTicks(h.work, 23)
  await turn()
  h.work.cancel()
  await assert.rejects(waiting, { code: 'CANCELLED' })
  assert.equal(h.bot.listenerCount('physicsTick'), 0)
  assert.equal(h.agent.bot, h.bot)
})

test('a missing physics stream times out and cleans up the waiter', async () => {
  const h = setup()
  const timed = h.work.timed.bind(h.work)
  h.work.timed = (action, _ms, label) => timed(action, 20, label)
  await assert.rejects(waitTicks(h.work, 13), /timed out/)
  assert.equal(h.bot.listenerCount('physicsTick'), 0)
})

test('Stop during a delayed look cannot produce a late attack or mutate a replacement bot', async () => {
  const h = setup()
  let resolveLook
  h.bot.lookAt = () => new Promise(resolve => { resolveLook = resolve })
  const strike = h.combat.strike(h.target, h.options)
  await turn()
  h.work.cancel()
  const replacement = { marker: 'new session' }
  h.agent.bot = replacement
  h.agent.nav++
  resolveLook()
  await assert.rejects(strike, { code: 'CANCELLED' })
  assert.equal(h.attacks.length, 0)
  assert.equal(h.agent.bot, replacement)
  assert.equal(h.combat.busy, false)
})

test('reach, policy and entity identity are revalidated after aiming', async () => {
  for (const change of ['range', 'policy', 'identity']) {
    const h = setup()
    h.bot.lookAt = async () => {
      if (change === 'range') h.target.position = new Vec3(20, 64, 0)
      if (change === 'policy') h.options.canAttack = () => false
      if (change === 'identity') h.bot.entities[h.target.id] = { ...h.target }
    }
    // A live policy closure can change while the aim is pending.
    let allowed = true
    if (change === 'policy') {
      h.options.canAttack = () => allowed
      h.bot.lookAt = async () => { allowed = false }
    }
    assert.equal(await h.combat.strike(h.target, h.options), false)
    assert.equal(h.attacks.length, 0)
  }
})

function shield(h) {
  h.bot.getEquipmentDestSlot = () => 45
  h.bot.inventory.slots = []
  h.bot.inventory.slots[45] = { name: 'shield' }
  h.bot.deactivateItem = () => h.actions.push('lower')
  h.bot.activateItem = offhand => { assert.equal(offhand, true); h.actions.push('raise') }
}

test('shield sequencing surrounds a single attack and releases before returning', async () => {
  const h = setup(); shield(h)
  h.bot.attack = () => h.actions.push('attack')
  h.combat.pauseTicks = async ticks => { h.actions.push(ticks); h.work.check() }
  assert.equal(await h.combat.strike(h.target, h.options), true)
  assert.deepEqual(h.actions, ['lower', 2, 'attack', 3, 'raise', 10, 'lower'])
})

test('Stop while shielding releases item use and prevents the next attack', async () => {
  const h = setup(); shield(h)
  h.combat.pauseTicks = async ticks => {
    if (ticks === 10) h.work.cancel()
    h.work.check()
  }
  await assert.rejects(h.combat.strike(h.target, h.options), { code: 'CANCELLED' })
  assert.equal(h.attacks.length, 1)
  assert.deepEqual(h.actions, ['lower', 'raise', 'lower'])
  await assert.rejects(h.combat.strike(h.target, h.options), { code: 'CANCELLED' })
  assert.equal(h.attacks.length, 1)
})

test('a second strike cannot overlap an outstanding look', async () => {
  const h = setup()
  let release
  h.bot.lookAt = () => new Promise(resolve => { release = resolve })
  const first = h.combat.strike(h.target, h.options)
  await turn()
  await assert.rejects(h.combat.strike(h.target, h.options), /already owns/)
  h.work.cancel(); release()
  await assert.rejects(first, { code: 'CANCELLED' })
})
