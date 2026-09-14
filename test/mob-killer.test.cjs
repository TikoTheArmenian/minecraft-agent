const { test } = require('node:test')
const assert = require('node:assert/strict')
const { fixture, Vec3 } = require('./helpers/survival-fixture.cjs')
const { MobKiller, parseMobKiller, chooseWeapon } = require('../src/mob-killer.cjs')
const { parse } = require('../src/agent.cjs')
const storage = require('../src/storage.cjs')

let nextId = 100
function mob(h, name, x, z, extra = {}) {
  const entity = { id: nextId++, name, type: 'mob', kind: 'Hostile mobs', height: 1.95, isValid: true, position: new Vec3(x, 64, z), ...extra }
  h.bot.entities[entity.id] = entity
  return entity
}
function setup(radius) {
  const h = fixture()
  h.attacks = []
  h.bot.attack = (entity) => h.attacks.push(entity.id)
  h.agent.username = 'Knight'
  h.agent.state.survival = { marker: 'previous survival plan' }
  const work = new MobKiller(h.agent, 1)
  if (radius) work.radius = radius
  work.pause = async () => work.check()
  return { ...h, work }
}

test('parser accepts the aliases with an optional bounded radius', () => {
  for (const text of ['hunt mobs', 'kill mobs', 'guard here', 'mob killer', 'start mob killer'])
    assert.deepEqual(parseMobKiller(text), { type: 'mobKiller', radius: 24 })
  assert.deepEqual(parseMobKiller('hunt mobs within 16'), { type: 'mobKiller', radius: 16 })
  assert.deepEqual(parseMobKiller('Kill mobs within 48 blocks!'), { type: 'mobKiller', radius: 48 })
  assert.deepEqual(parse('hunt mobs within 8'), { type: 'mobKiller', radius: 8 })
  assert.throws(() => parseMobKiller('hunt mobs within 7'), /8–48/)
  assert.throws(() => parseMobKiller('hunt mobs within 49'), /8–48/)
  assert.equal(parseMobKiller('hunt sponges'), null)
  assert.equal(parseMobKiller('farm trees'), null)
})
test('constructor keeps the continuous shape, the post, and the previous survival state', () => {
  const h = setup()
  assert.equal(h.work.deadline, Infinity)
  assert.equal(h.work.task.deadlineAt, null)
  assert.equal(h.work.task.continuous, true)
  assert.equal(h.work.task.skill, 'MOB KILLER')
  assert.deepEqual(h.agent.state.survival, { marker: 'previous survival plan' })
  assert.equal(h.agent.state.mobKiller, h.work.plan)
  assert.deepEqual(h.work.plan.post, { x: 0, y: 64, z: 0 })
  assert.deepEqual(h.work.reserves, {})
  assert.equal(h.work.refillingBuilding, true) // opts out of the building-block refill: a guard does not build
  assert.equal(h.work.origin.distanceTo(h.bot.entity.position), 0)
})
test('target selection excludes players, passive mobs, creepers, cooled-down and out-of-radius mobs and picks the nearest', () => {
  const h = setup(16)
  mob(h, 'zombie', 6, 0, { type: 'player', username: 'Steve', name: 'player' })
  mob(h, 'villager', 2, 0)
  mob(h, 'iron_golem', 2, 1)
  mob(h, 'wolf', 1, 1)
  mob(h, 'cow', 1, 0)
  mob(h, 'creeper', 2, 2)
  mob(h, 'zombie', 20, 0) // outside the 16-block radius
  const far = mob(h, 'zombie', 8, 0)
  const near = mob(h, 'skeleton', 4, 0)
  const cooled = mob(h, 'spider', 5, 0)
  h.work.cooldowns.set(cooled.id, { until: Date.now() + 30000, hard: false })
  const dead = mob(h, 'husk', 2, 0)
  h.work.dead.add(dead.id)
  assert.equal(h.work.selectTarget(), near)
  assert.deepEqual(h.work.candidates().map((e) => e.id), [near.id, far.id])
  // A soft-cooled mob that reaches melee range is defended against; a hard-cooled one is left alone.
  cooled.position = new Vec3(2, 64, 0)
  assert.equal(h.work.selectTarget(), cooled)
  h.work.cooldowns.set(cooled.id, { until: Date.now() + 30000, hard: true })
  assert.equal(h.work.selectTarget(), near)
  h.bot.entities = {}
  assert.equal(h.work.selectTarget(), null)
  // A creeper is detected for avoidance but is never a target.
  const creeper = mob(h, 'creeper', 3, 0)
  assert.equal(h.work.selectTarget(), null)
  assert.equal(h.work.creeperNear(), creeper)
})
test('weapon choice prefers tier, then swords over axes, and skips worn-out weapons', () => {
  const h = setup()
  assert.equal(chooseWeapon(h.bot), null)
  h.add('wooden_sword')
  h.add('iron_axe')
  assert.equal(chooseWeapon(h.bot).name, 'iron_axe')
  h.add('iron_sword')
  assert.equal(chooseWeapon(h.bot).name, 'iron_sword')
  const diamond = h.add('diamond_sword')
  diamond.durabilityUsed = 1560
  assert.equal(chooseWeapon(h.bot).name, 'iron_sword')
  diamond.durabilityUsed = 10
  assert.equal(chooseWeapon(h.bot).name, 'diamond_sword')
  h.add('netherite_axe')
  assert.equal(chooseWeapon(h.bot).name, 'netherite_axe')
})
test('safety ignores nearby hostiles but still stops for critical health, lava and low air', () => {
  const h = setup()
  mob(h, 'zombie', 1, 0)
  assert.equal(h.work.safety(), null)
  h.bot.health = 4
  assert.match(h.work.safety(), /critically low/)
  assert.match(h.work.safety(), /Knight/)
  h.bot.health = 20
  h.bot.entity.isInLava = true
  assert.match(h.work.safety(), /lava/)
  h.bot.entity.isInLava = false
  h.bot.oxygenLevel = 3
  assert.match(h.work.safety(), /Air is running low/)
  h.bot.oxygenLevel = 20
  assert.throws(() => { h.bot.health = 2; h.work.check() }, /critically low/)
})
test('kills are counted only when the entity leaves bot.entities after our hits, then drops are collected', async () => {
  const h = setup()
  h.add('iron_sword')
  const zombie = mob(h, 'zombie', 2, 0)
  const pickups = []
  h.work.pickup = async (pos) => { pickups.push(pos.clone()); if (pickups.length === 1) h.add('rotten_flesh', 2) }
  h.bot.attack = (entity) => {
    h.attacks.push(entity.id)
    if (h.attacks.length === 3) {
      delete h.bot.entities[entity.id]
      h.bot.emit('entityGone', entity)
    }
  }
  assert.equal(await h.work.engage(zombie), true)
  assert.equal(h.attacks.length, 3)
  assert.equal(h.bot.heldItem.name, 'iron_sword')
  assert.deepEqual(h.work.plan.kills, { zombie: 1 })
  assert.equal(h.work.plan.killsTotal, 1)
  assert.equal(pickups.length >= 1, true)
  assert.deepEqual(pickups[0], new Vec3(2, 64, 0)) // first at the death position, then around the bot
  assert.equal(h.work.plan.drops, 2) // counted from the mob-drop inventory delta, not every pickup
  assert.equal(h.work.plan.target, null)
})
test('a target that vanishes without being hit is not a kill, and a stubborn target is cooled down after the hit budget', async () => {
  const h = setup()
  h.add('iron_sword')
  const ghost = mob(h, 'skeleton', 10, 0)
  h.work.chase = async () => { delete h.bot.entities[ghost.id]; return true }
  assert.equal(await h.work.engage(ghost), false)
  assert.equal(h.work.plan.killsTotal, 0)
  const tank = mob(h, 'zombie', 2, 0)
  assert.equal(await h.work.engage(tank), false)
  assert.equal(h.attacks.filter((id) => id === tank.id).length, 40)
  assert.equal(h.work.plan.killsTotal, 0)
  assert.equal(h.work.cooldowns.get(tank.id).hard, true)
  assert.equal(h.work.selectTarget(), null) // even though it is still in reach
  assert.deepEqual(h.work.threatsInReach(), [])
})
test('pursuit stays within radius + 8 of the post: targets beyond it are abandoned and cooled down', async () => {
  const h = setup(8)
  h.add('iron_sword')
  const zombie = mob(h, 'zombie', 6, 0)
  let chases = 0
  h.work.chase = async (entity) => {
    chases++
    entity.position = new Vec3(17, 64, 0) // it wandered 17 blocks from the post (> 8 + 8)
    return true
  }
  assert.equal(await h.work.engage(zombie), false)
  assert.equal(chases, 1)
  assert.equal(h.attacks.length, 0)
  assert.equal(h.work.cooldowns.has(zombie.id), true)
  assert.match(h.work.plan.decision, /beyond 16 blocks/)
})
test('unreachable targets are cooled down after two failed chases', async () => {
  const h = setup()
  h.add('stone_sword')
  const zombie = mob(h, 'zombie', 10, 0)
  let chases = 0
  h.work.travelChase = async () => { chases++; throw Object.assign(new Error('No path to the goal.'), { name: 'NoPath' }) }
  assert.equal(await h.work.engage(zombie), false)
  assert.equal(chases, 2)
  assert.equal(h.work.cooldowns.has(zombie.id), true)
  assert.equal(h.attacks.length, 0)
})
test('without a weapon only zombies and skeletons are fought bare-handed, and only at high health', async () => {
  const h = setup()
  const spider = mob(h, 'spider', 2, 0)
  assert.equal(await h.work.engage(spider), false)
  assert.equal(h.work.cooldowns.has(spider.id), true)
  h.bot.health = 12
  const zombie = mob(h, 'zombie', 2, 0)
  assert.equal(await h.work.engage(zombie), false)
  assert.equal(h.attacks.length, 0)
  h.bot.health = 20
  const skeleton = mob(h, 'skeleton', 2, 0)
  h.bot.attack = (entity) => { h.attacks.push(entity.id); delete h.bot.entities[entity.id] }
  assert.equal(await h.work.engage(skeleton), true)
  assert.match(h.work.plan.decision, /bare-handed|Killed skeleton/)
  assert.equal(h.work.plan.kills.skeleton, 1)
})
test('health at or below 8 triggers a retreat toward the post instead of an attack', async () => {
  const h = setup()
  h.add('iron_sword')
  h.add('bread', 3)
  h.bot.health = 7
  h.bot.food = 10
  mob(h, 'zombie', 16, 0) // in the radius, out of reach: retreat, do not chase
  const routes = []
  h.work.travel = async (goal, label) => { routes.push(label); h.bot.entity.position = new Vec3(0.5, 64, 0.5) }
  h.bot.entity.position = new Vec3(10, 64, 0)
  let waits = 0
  h.work.pause = async () => {
    if (++waits === 3) { h.bot.health = 12; h.work.cancel() }
    h.work.check()
  }
  await h.work.run({ type: 'mobKiller', radius: 16 })
  assert.equal(h.attacks.length, 0)
  assert.equal(h.work.plan.retreats, 1)
  assert.deepEqual(routes, ['Retreat toward the guard post'])
  assert.equal(h.bot.food > 10, true) // ate carried bread while recovering
  assert.equal(h.work.task.status, 'cancelled')
  assert.equal(h.work.plan.status, 'cancelled')
})
test('while recovering, a mob that reaches melee range is fought off instead of ignored', async () => {
  const h = setup()
  h.add('iron_sword')
  h.bot.health = 7
  const zombie = mob(h, 'zombie', 2, 0)
  h.work.travel = async () => {}
  h.bot.attack = (entity) => {
    h.attacks.push(entity.id)
    if (h.attacks.length === 2) { delete h.bot.entities[entity.id]; h.bot.health = 12 }
  }
  let waits = 0
  h.work.pause = async () => { if (++waits > 4) h.work.cancel(); h.work.check() }
  await h.work.run({ type: 'mobKiller' })
  assert.deepEqual(h.attacks, [zombie.id, zombie.id])
  assert.equal(h.bot.heldItem.name, 'iron_sword')
  assert.equal(h.work.plan.retreats, 1)
  assert.equal(h.work.plan.killsTotal, 0) // self-defence hits outside engage() are not counted as confirmed kills
})
test('a close but unreachable mob is held at bay before being cooled down', async () => {
  const h = setup()
  h.add('iron_sword')
  const zombie = mob(h, 'zombie', 6, 0)
  let chases = 0, looks = 0
  h.work.travelChase = async () => { chases++; throw Object.assign(new Error('No path to the goal.'), { name: 'NoPath' }) }
  h.bot.lookAt = async () => { looks++; if (looks === 3) { delete h.bot.entities[zombie.id] } }
  assert.equal(await h.work.engage(zombie), false)
  assert.equal(chases, 2)
  assert.equal(looks >= 3, true)
  assert.match(h.work.plan.decision, /holding ground|vanished/)
})
test('creepers are avoided, never attacked', async () => {
  const h = setup()
  h.add('iron_sword')
  mob(h, 'creeper', 3, 0)
  const flights = []
  h.work.travelChase = async (goal, label) => { flights.push(label) }
  let waits = 0
  h.work.pause = async () => { if (++waits === 1) h.work.cancel(); h.work.check() }
  await h.work.run({ type: 'mobKiller', radius: 16 })
  assert.equal(h.attacks.length, 0)
  assert.deepEqual(flights, ['Back away from a creeper'])
  assert.match(h.work.plan.decision, /Creeper .* backing off|cancelled/)
})
test('storing a batch happens when 16 drops are carried, through storage.store, only when the hub is within 80 blocks', async () => {
  const original = { store: storage.store, call: storage.call }
  const h = setup()
  h.agent.colony = { enabled: true }
  h.add('rotten_flesh', 20)
  let hub = { x: 30, y: 64, z: 0 }
  const stores = []
  storage.call = async (w, action) => { assert.equal(action, 'hub_get'); return { position: hub } }
  storage.store = async (w) => { stores.push(w); return 20 }
  try {
    assert.equal(h.work.needsDeposit(), true)
    assert.equal(await h.work.storeBatch(), 20)
    assert.equal(stores[0], h.work)
    assert.equal(h.work.plan.stored, 20)
    // Below the trigger nothing is stored.
    h.items.length = 0
    h.add('rotten_flesh', 5)
    h.work.nextStoreAt = 0
    assert.equal(await h.work.storeBatch(), 0)
    assert.equal(stores.length, 1)
    // A far hub skips the trip with a decision note.
    h.add('bone', 20)
    hub = { x: 200, y: 64, z: 0 }
    assert.equal(await h.work.storeBatch(), 0)
    assert.equal(stores.length, 1)
    assert.match(h.work.plan.decision, /hub is 200 blocks/)
    // Near-full inventory triggers a deposit too.
    hub = { x: 10, y: 64, z: 0 }
    h.work.nextStoreAt = 0
    h.items.length = 0
    h.bot.inventory.emptySlotCount = () => 2
    assert.equal(await h.work.storeBatch(), 20)
    assert.equal(h.work.plan.stored, 40)
  } finally {
    Object.assign(storage, original)
  }
})
test('with the colony disabled the skill keeps drops and says so once', async () => {
  const h = setup()
  h.add('rotten_flesh', 32)
  assert.equal(await h.work.storeBatch(), 0)
  assert.match(h.work.plan.decision, /not configured/)
})
test('the idle checkpoint returns to the post, waits five seconds, and runs the supply checkpoint', async () => {
  const h = setup()
  h.bot.entity.position = new Vec3(9, 64, 0)
  const routes = []
  let supplies = 0
  h.agent.coordination = { returnSupplies: async (w) => { assert.equal(w, h.work); supplies++ } }
  h.work.travel = async (goal, label) => { routes.push(label); h.bot.entity.position = new Vec3(0.5, 64, 0.5) }
  h.work.pause = async (ms) => { assert.equal(ms, 5000); h.work.cancel(); h.work.check() }
  await h.work.run({ type: 'mobKiller' })
  assert.deepEqual(routes, ['Return to the guard post'])
  assert.equal(supplies, 1)
  assert.equal(h.work.plan.waitingUntil, null)
  assert.equal(h.work.task.status, 'cancelled')
})
test('Stop during a fight ends the attacks immediately and cleans up', async () => {
  const h = setup()
  h.add('iron_sword')
  mob(h, 'zombie', 2, 0)
  let restored = null
  const before = h.bot.pathfinder.movements
  h.bot.pathfinder.setMovements = (m) => { restored = m }
  h.agent.baseMovements = before
  h.bot.attack = (entity) => { h.attacks.push(entity.id); if (h.attacks.length === 2) h.work.cancel() }
  await h.work.run({ type: 'mobKiller', radius: 12 })
  assert.equal(h.attacks.length, 2)
  assert.equal(h.work.task.status, 'cancelled')
  assert.equal(h.work.plan.status, 'cancelled')
  assert.equal(h.work.plan.target, null)
  assert.equal(restored, before)
  assert.equal(h.bot.listenerCount('entityGone'), 0)
  assert.equal(h.bot.listenerCount('playerCollect'), 0)
})
test('critical health pauses the skill with a clear message naming the bot', async () => {
  const h = setup()
  mob(h, 'zombie', 2, 0)
  h.work.pause = async () => { h.bot.health = 3; h.work.check() }
  h.bot.health = 7
  h.work.travel = async () => {}
  await h.work.run({ type: 'mobKiller' })
  assert.equal(h.work.plan.status, 'paused')
  assert.equal(h.work.task.status, 'partial')
  assert.match(h.work.plan.decision, /critically low/)
  assert.match(h.agent.state.messages.at(-1), /Knight/)
})
