const { test } = require('node:test')
const assert = require('node:assert/strict')
const { setImmediate: turn } = require('node:timers/promises')
const { fixture, Vec3 } = require('./helpers/survival-fixture.cjs')
const { eatAtCheckpoint } = require('../src/minecraft/auto-eat.cjs')
const { equipArmor } = require('../src/minecraft/armor.cjs')
const { TaskTool } = require('../src/minecraft/tools.cjs')
const { FOOD } = require('../src/capabilities/resources.cjs')
const reserve = name => ['carrot', 'potato', 'beetroot'].includes(name) ? 4 : 0
const eat = h => eatAtCheckpoint(h.work, FOOD, reserve)
function deferred() { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }

// Real EatUtil code runs against the fixture's consumption acknowledgements.
test('auto-eat selects higher food points, excludes unsafe foods, and restores a moved weapon', async () => {
  const h = fixture(); h.bot.food = 16
  h.add('rotten_flesh', 32); h.add('carrot', 4); h.add('apple', 2); h.add('cooked_beef', 1)
  const sword = h.add('iron_sword'); h.bot.heldItem = sword
  const activate = h.bot.activateItem, meals = []
  h.bot.activateItem = () => {
    meals.push(h.bot.heldItem.name)
    h.items[h.items.indexOf(sword)] = { ...sword }
    activate()
  }
  assert.equal(await eat(h), 1)
  assert.deepEqual(meals, ['cooked_beef'])
  assert.equal(h.bot.heldItem.name, 'iron_sword')
  assert.notEqual(h.bot.heldItem, sword)
  assert.equal(h.work.count('carrot'), 4)
  assert.equal(h.bot.listenerCount('physicsTick'), 0)
  assert.equal(h.bot._client.listenerCount('entity_status'), 0)
  assert.equal(h.bot._client.listenerCount('update_health'), 0)
})

test('no available meal leaves planting stock alone and open windows defer maintenance', async () => {
  const h = fixture(); h.bot.food = 10; h.add('carrot', 4)
  assert.equal(await eat(h), 0)
  h.add('bread', 2); h.bot.currentWindow = {}
  h.bot.equip = () => assert.fail('A window owns the inventory')
  assert.equal(await eat(h), 0)
  assert.equal(await equipArmor(h.work), 0)
})

test('Stop during food equipping prevents late item activation and restoration', async () => {
  const h = fixture(); h.bot.food = 16; h.add('bread')
  const pending = deferred(), equipped = deferred()
  let used = 0
  h.bot.equip = async item => { equipped.resolve(); await pending.promise; h.bot.heldItem = item }
  h.bot.activateItem = () => used++
  const eating = eat(h)
  await equipped.promise
  h.work.cancel(); pending.resolve()
  await assert.rejects(eating, { code: 'CANCELLED' })
  assert.equal(used, 0)
  assert.equal(h.agent.bot, h.bot)
  assert.equal(h.bot._client.listenerCount('entity_status'), 0)
})

test('Stop during consumption releases item use and all observers without disconnecting', async () => {
  const h = fixture(); h.bot.food = 16; h.add('bread')
  const activated = deferred(); let released = 0
  h.bot.activateItem = () => activated.resolve()
  h.bot.deactivateItem = () => released++
  const eating = eat(h)
  await activated.promise
  h.work.cancel()
  await assert.rejects(eating, { code: 'CANCELLED' })
  assert.equal(released, 2) // Initial reset and immediate abort.
  assert.equal(h.agent.bot, h.bot)
  assert.equal(h.bot._client.listenerCount('entity_status'), 0)
  assert.equal(h.bot._client.listenerCount('update_health'), 0)
})

test('consumption waits for server hunger gain after an early acknowledgement', async () => {
  const h = fixture(); h.bot.food = 16; h.add('bread')
  const activated = deferred(); let done = false
  h.bot.activateItem = () => { h.bot._client.emit('entity_status', { entityId: h.bot.entity.id, entityStatus: 9 }); activated.resolve() }
  const eating = eat(h).then(() => { done = true })
  await activated.promise; await turn()
  assert.equal(done, false)
  h.bot.food = 20; h.bot._client.emit('update_health', { food: 20 })
  await eating
  assert.equal(done, true)
})

test('missing consumption acknowledgement times out and removes its listeners', async () => {
  const h = fixture(); h.bot.food = 16; h.add('bread')
  h.bot.activateItem = () => { h.bot.food = 20; h.bot._client.emit('update_health', { food: 20 }) }
  const timed = h.work.timed.bind(h.work)
  h.work.timed = (action, _ms, label) => timed(action, 25, label)
  await assert.rejects(eat(h), /timed out/)
  assert.equal(h.bot._client.listenerCount('entity_status'), 0)
  assert.equal(h.bot._client.listenerCount('update_health'), 0)
  assert.equal(h.agent.bot, h.bot)
})

test('planting reserves depleted during equip prevent eating', async () => {
  const h = fixture(); h.bot.food = 16; h.add('carrot', 5)
  h.bot.equip = async item => { h.bot.heldItem = item; item.count = 4 }
  h.bot.activateItem = () => assert.fail('Would eat the planting reserve')
  await assert.rejects(eat(h), /reserves changed/)
})

function armorFixture() {
  const h = fixture(), changes = []
  h.bot.inventory.slots = []
  h.bot.getEquipmentDestSlot = name => ({ hand: 36, head: 5, torso: 6, legs: 7, feet: 8, 'off-hand': 45 })[name]
  h.bot.equip = async (item, destination) => {
    changes.push([item.name, destination])
    if (destination === 'hand') h.bot.heldItem = item
    else h.bot.inventory.slots[h.bot.getEquipmentDestSlot(destination)] = item
  }
  return { ...h, changes }
}

test('armor-manager equips carried armor and an empty offhand at resource checkpoints', async () => {
  const h = armorFixture()
  h.add('chainmail_chestplate'); h.add('iron_chestplate'); h.add('leather_boots'); h.add('shield')
  await h.work.eat() // Full hunger still maintains armor.
  assert.deepEqual(h.changes, [['iron_chestplate', 'torso'], ['leather_boots', 'feet'], ['shield', 'off-hand']])
  await h.work.eat()
  assert.equal(h.changes.length, 3, 'Already-equipped pieces are not moved again')
  assert.equal(h.bot.listenerCount('playerCollect'), 0)
})

test('armor upgrades preserve enchantments, elytra, bound equipment and manually chosen offhand', async () => {
  const h = armorFixture()
  const enchanted = h.add('iron_helmet'); enchanted.enchants = [{ name: 'protection', lvl: 3 }]
  h.bot.inventory.slots[5] = enchanted
  const diamond = h.add('diamond_helmet')
  h.bot.inventory.slots[6] = h.add('elytra'); h.add('netherite_chestplate')
  const bound = h.add('leather_boots'); bound.enchants = [{ name: 'binding_curse', lvl: 1 }]
  h.bot.inventory.slots[8] = bound; h.add('diamond_boots')
  h.bot.inventory.slots[45] = h.add('totem_of_undying'); h.add('shield')
  assert.equal(await equipArmor(h.work), 0)
  diamond.enchants = [{ name: 'protection', lvl: 3 }]
  assert.equal(await equipArmor(h.work), 1)
  assert.deepEqual(h.changes, [['diamond_helmet', 'head']])
})

test('worn and cursed armor is excluded and rejected equips are not counted', async () => {
  const h = armorFixture()
  const worn = h.add('diamond_boots'); worn.durabilityUsed = h.bot.registry.items[worn.type].maxDurability - 1
  const cursed = h.add('diamond_helmet'); cursed.enchants = [{ name: 'binding_curse', lvl: 1 }]
  assert.equal(await equipArmor(h.work), 0)
  h.add('iron_leggings')
  h.bot.equip = async () => {}
  await assert.rejects(equipArmor(h.work), /not confirmed/)
})

test('Stop during armor equip prevents the next piece from being equipped', async () => {
  const h = armorFixture(); h.add('iron_helmet'); h.add('iron_boots')
  const pending = deferred(), started = deferred()
  let calls = 0
  h.bot.equip = async () => { calls++; started.resolve(); await pending.promise }
  const armor = equipArmor(h.work)
  await started.promise; h.work.cancel(); pending.resolve()
  await assert.rejects(armor, { code: 'CANCELLED' })
  assert.equal(calls, 1)
  assert.equal(h.agent.bot, h.bot)
})

test('armor removed before the deferred equip is not sent as a stale equipment request', async () => {
  const h = armorFixture(); h.add('iron_helmet')
  const equipping = equipArmor(h.work)
  h.items.length = 0
  await assert.rejects(equipping, /Equipment changed/)
  assert.deepEqual(h.changes, [])
})

test('mineflayer-tool avoids redundant equipping and never retrieves from a chest', async () => {
  const h = fixture(), tools = new TaskTool(h.bot)
  const item = h.add('iron_pickaxe'), block = h.set('iron_ore', new Vec3(2, 64, 0))
  let equips = 0
  h.bot.equip = async i => { equips++; h.bot.heldItem = i }
  assert.equal(await tools.equipForBlock(block, { work: h.work }), item)
  assert.equal(await tools.equipForBlock(block, { work: h.work }), item)
  assert.equal(equips, 1)
  await assert.rejects(tools.equipForBlock(block, { work: h.work, getFromChest: true }), /shared storage/)
})

test('tool adapter retains harvest restrictions and rejects an unconfirmed hand change', async () => {
  const h = fixture(), tools = new TaskTool(h.bot)
  h.add('golden_pickaxe'); h.add('iron_pickaxe')
  const block = h.set('diamond_ore', new Vec3(2, 64, 0))
  assert.equal(tools.choose(block).name, 'iron_pickaxe')
  assert.throws(() => tools.choose(block, i => i?.name === 'golden_pickaxe'), /suitable tool/)
  h.bot.equip = async () => {}
  await assert.rejects(tools.equipForBlock(block, { work: h.work }), /not confirmed/)
  h.work.cancel()
  await assert.rejects(tools.equipForBlock(block, { work: h.work }), { code: 'CANCELLED' })
})
