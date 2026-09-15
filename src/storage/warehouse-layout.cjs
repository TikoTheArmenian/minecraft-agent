/** Fixed warehouse bays: south-facing pairs, one front label, and two-block aisles. */
const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const { plain } = require('./policy.cjs')
const { watchBlock } = require('../minecraft/block-updates.cjs')
const storage = require('./service.cjs')
const { memory, pendingPositions } = require('./warehouse-state.cjs')
const v = (p) => new Vec3(p.x, p.y, p.z)
const key = (p) => `${p.x},${p.y},${p.z}`
function bays(hub) {
  const result = []
  for (const z of [-4, 0, 4])
    for (const x of [-5, -1, 3]) {
      const left = v(hub).offset(x, 0, z),
        right = left.offset(1, 0, 0)
      result.push({ id: key(left), left, right, facing: 'south', sign: left.offset(0, 0, 1) })
    }
  return result
}
function validPair(bot, bay) {
  try {
    const a = bot.blockAt(bay.left),
      b = bot.blockAt(bay.right)
    return (
      a?.getProperties().facing === 'south' &&
      b?.getProperties().facing === 'south' &&
      storage.identity(bot, a).capacity === 54 &&
      storage.identity(bot, a).container === storage.identity(bot, b).container
    )
  } catch {
    return false
  }
}
function free(bot, bay) {
  for (const p of [bay.left, bay.right]) {
    for (const dy of [0, 1])
      if (!['air', 'cave_air'].includes(bot.blockAt(p.offset(0, dy, 0))?.name)) return false
    for (const d of [
      [-1, 0, 0],
      [1, 0, 0],
      [0, 0, -1],
      [0, 0, 1],
    ])
      if (bot.blockAt(p.offset(...d))?.name === 'chest') return false
  }
  // The fixed front label and walking strip must remain clear; never excavate a farm or structure.
  for (const p of [bay.left, bay.right])
    for (const z of [1, 2])
      for (const y of [0, 1])
        if (!['air', 'cave_air'].includes(bot.blockAt(p.offset(0, y, z))?.name)) return false
  for (const p of [bay.left, bay.right])
    for (const dz of [0, 1, 2]) {
      const floor = bot.blockAt(p.offset(0, -1, dz))
      if (!floor || /chest|farmland|furnace|leaves|magma|cactus/.test(floor.name)) return false
      if (floor.boundingBox !== 'block' && !['air', 'cave_air'].includes(floor.name)) return false
    }
  return true
}
async function placeConfirmed(w, p, name, reference, face) {
  w.check()
  const item = w.bot.inventory.items().find((i) => i.name === name && plain(i))
  if (!item) throw new Error(`Warehouse needs ${name}.`)
  await w.equip(item)
  const range = w.bot.registry.blocksByName[name]
  const watcher = watchBlock(
    w.bot,
    p,
    (id) => id >= range.minStateId && id <= range.maxStateId,
    w.controller.signal,
  )
  try {
    await w.timed(
      async () => {
        await w.bot.placeBlock(reference, face)
        await watcher.promise
        w.check()
      },
      7000,
      `Place warehouse ${name}`,
    )
  } finally {
    watcher.cleanup()
  }
}
async function floor(w, bay, hub) {
  const safe = (b) =>
    b?.boundingBox === 'block' && !/chest|farmland|furnace|leaves|magma|cactus/.test(b.name)
  const required = []
  for (const p of [bay.left, bay.right])
    for (const dz of [0, 1, 2]) required.push(p.offset(0, -1, dz))
  const eligible = (p) => {
    const b = w.bot.blockAt(p)
    if (safe(b)) return true
    return (
      ['air', 'cave_air'].includes(b?.name) &&
      ['air', 'cave_air'].includes(w.bot.blockAt(p.offset(0, 1, 0))?.name) &&
      ['air', 'cave_air'].includes(w.bot.blockAt(p.offset(0, 2, 0))?.name) &&
      !/chest|farmland/.test(w.bot.blockAt(p.offset(0, -1, 0))?.name || '')
    )
  }
  for (const target of required) {
    if (safe(w.bot.blockAt(target))) continue
    // Find a bounded, level connection back to existing solid support. No floating placements.
    const queue = [{ p: target, path: [target] }],
      seen = new Set([key(target)])
    let route = null
    for (let i = 0; i < queue.length && i < 225; i++) {
      const node = queue[i]
      if (!eligible(node.p)) continue
      if (safe(w.bot.blockAt(node.p))) {
        route = node.path.reverse()
        break
      }
      for (const d of [
        [1, 0, 0],
        [-1, 0, 0],
        [0, 0, 1],
        [0, 0, -1],
      ]) {
        const p = node.p.offset(...d)
        if (Math.abs(p.x - hub.x) > 7 || Math.abs(p.z - hub.z) > 7 || seen.has(key(p))) continue
        seen.add(key(p))
        queue.push({ p, path: [...node.path, p] })
      }
    }
    if (!route)
      throw new Error(
        'Warehouse floor has no clear supported connection. Clear or relocate the hub.',
      )
    for (let i = 1; i < route.length; i++) {
      const p = route[i],
        ref = route[i - 1]
      w.check()
      if (!eligible(p)) throw new Error('Warehouse floor changed while building its access strip.')
      await storage.approach(w, ref)
      const name = ['cobblestone', 'stone', 'dirt'].find((n) =>
        w.bot.inventory.items().some((i) => i.name === n && plain(i)),
      )
      if (!name) throw new Error('Warehouse floor needs more solid building blocks.')
      await placeConfirmed(w, p, name, w.bot.blockAt(ref), p.minus(ref))
    }
  }
}
async function build(w, hub, category) {
  const state = memory(w, hub),
    all = bays(hub)
  if (state.pending) {
    const old = all.find((b) => b.id === state.pending.id)
    if (
      old &&
      [old.left, old.right].every((p) => ['air', 'cave_air'].includes(w.bot.blockAt(p)?.name)) &&
      !free(w.bot, old)
    ) {
      state.pending = null
      w.agent.coordination.save()
    }
  }
  let bay = state.pending
    ? all.find((b) => b.id === state.pending.id)
    : all.find((b) => !state.completed[b.id] && free(w.bot, b))
  if (!bay)
    throw new Error(
      'No clear warehouse bay remains in the hub. The planned rows need a larger clear site.',
    )
  const data = await storage.list(w)
  const overlaps = data.containers.filter((c) =>
    c.blocks.some((p) => key(p) === key(bay.left) || key(p) === key(bay.right)),
  )
  if (
    overlaps.length &&
    !overlaps.every((c) => c.capacity === 54 && c.id === `${key(bay.left)}|${key(bay.right)}`)
  )
    throw new Error(
      'A registered chest overlaps this warehouse bay; do not join it until its inventories are reconciled.',
    )
  if (!state.pending) {
    state.pending = { id: bay.id, category }
    w.agent.coordination.save()
  }
  category = state.pending.category
  await floor(w, bay, hub)
  for (const p of [bay.left, bay.right]) {
    const existing = w.bot.blockAt(p)
    if (existing?.name === 'chest') {
      if (existing.getProperties().facing !== 'south')
        throw new Error('Incomplete warehouse chest faces the wrong way; inspect it before repair.')
      continue
    }
    if (!['air', 'cave_air'].includes(existing?.name))
      throw new Error('Warehouse bay changed during construction.')
    // Looking north from this fixed southern stance makes both chest fronts face south.
    await w.travel(new goals.GoalBlock(p.x, p.y, p.z + 2), 'Stand in warehouse aisle')
    w.bot.setControlState('sneak', false)
    await placeConfirmed(w, p, 'chest', w.bot.blockAt(p.offset(0, -1, 0)), new Vec3(0, 1, 0))
    if (w.bot.blockAt(p)?.getProperties().facing !== 'south')
      throw new Error('Server did not confirm the planned chest facing.')
  }
  await w.timed(
    async () => {
      while (!validPair(w.bot, bay)) {
        w.check()
        await w.pause(50)
      }
    },
    3000,
    'Confirm both double-chest halves',
  )
  await storage.manage(w, bay.left, category)
  state.completed[bay.id] = { category }
  state.pending = null
  w.agent.coordination.save()
  return bay
}
module.exports = { bays, validPair, free, build, pendingPositions }
