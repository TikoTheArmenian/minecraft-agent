/** One durable, surplus-funded storage guardian per hub. Never excavates a build site. */
const { randomUUID } = require('node:crypto')
const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const storage = require('./service.cjs')
const crafting = require('./crafting.cjs')
const { plain } = require('./policy.cjs')
const { TOOL_STOCK, ARMOR_STOCK } = require('./steward.cjs')
const { directoryFor } = require('../messaging/peer-directory.cjs')
const { needsIron } = require('../minecraft/armor.cjs')
const { watchBlock } = require('../minecraft/block-updates.cjs')
const IRON_RESERVE = 64
const HEADS = ['carved_pumpkin', 'jack_o_lantern']
const v = (p) => new Vec3(p.x, p.y, p.z)
const air = (b) => ['air', 'cave_air', 'void_air'].includes(b?.name)
const pieces = (p) => [p, p.offset(0, 1, 0), p.offset(-1, 1, 0), p.offset(1, 1, 0)]
const count = (w, name) =>
  w.bot.inventory
    .items()
    .filter((i) => i.name === name && plain(i))
    .reduce((n, i) => n + i.count, 0)
function surplus(w, data) {
  if ((data.jobs || []).some((j) => ['queued', 'claimed', 'running'].includes(j.state))) return null
  const stock = crafting.stocks(w, data)
  // Equipment reserves count shared stock only; carried tools stay with their owner.
  if ([...TOOL_STOCK, ...ARMOR_STOCK].some((n) => (stock.shared[n] || 0) < 4)) return null
  if (ARMOR_STOCK.some((n) => needsIron(w.bot, n))) return null
  const have = (n) => (stock.carry[n] || 0) + (stock.shared[n] || 0)
  const blocks = Math.min(4, have('iron_block'))
  const head = HEADS.find((n) => have(n) >= 1)
  if (!head || have('iron_ingot') < IRON_RESERVE + (4 - blocks) * 9) return null
  return { head, blocks }
}
function clearSite(bot, p, resume = false) {
  const iron = pieces(p)
  for (let x = -2; x <= 2; x++)
    for (let z = -2; z <= 2; z++) {
      const floor = bot.blockAt(p.offset(x, -1, z))
      if (
        floor?.boundingBox !== 'block' ||
        /chest|farmland|furnace|leaves|magma|cactus/.test(floor.name)
      )
        return false
      for (let y = 0; y <= 3; y++) {
        const pos = p.offset(x, y, z),
          block = bot.blockAt(pos)
        if (resume && iron.some((i) => i.equals(pos)) && block?.name === 'iron_block') continue
        if (!air(block)) return false
      }
    }
  return !Object.values(bot.entities || {}).some(
    (e) =>
      e !== bot.entity &&
      e.position &&
      Math.abs(e.position.x - p.x) < 3 &&
      Math.abs(e.position.z - p.z) < 3 &&
      Math.abs(e.position.y - p.y) < 4,
  )
}
function findSite(bot, hub) {
  for (const [dx, dz] of [
    [0, 12],
    [12, 0],
    [0, -12],
    [-12, 0],
    [12, 12],
    [-12, 12],
    [12, -12],
    [-12, -12],
  ])
    for (const dy of [0, 1, -1, 2, -2]) {
      const p = v(hub).offset(dx, dy, dz)
      if (clearSite(bot, p)) return p
    }
  return null
}
async function placeIron(w, p, reference, face) {
  w.check()
  if (!air(w.bot.blockAt(p))) throw new Error('Golem placement space changed.')
  const item = w.bot.inventory.items().find((i) => i.name === 'iron_block' && plain(i))
  if (!item) throw new Error('Missing an iron block for the golem.')
  await w.equip(item)
  const range = w.bot.registry.blocksByName.iron_block
  const watch = watchBlock(
    w.bot,
    p,
    (id) => id >= range.minStateId && id <= range.maxStateId,
    w.controller.signal,
  )
  try {
    await w.timed(
      async () => {
        w.check()
        if (!air(w.bot.blockAt(p))) throw new Error('Golem placement space changed.')
        await w.bot.placeBlock(w.bot.blockAt(reference), face)
        await watch.promise
        w.check()
      },
      7000,
      'Place golem iron block',
    )
  } finally {
    watch.cleanup()
  }
}
async function build(w, hub) {
  if (!directoryFor(w.agent).capabilities().includes('storageCoordinator')) return false
  const chat = w.agent.coordination
  if (!chat) return false
  const memory = chat.recall()
  memory.golems ||= {}
  const key = `${hub.x},${hub.y},${hub.z}`
  let state = memory.golems[key]
  if (state?.status === 'complete' || Date.now() < (state?.retryAt || 0)) return false
  const nearby = Object.values(w.bot.entities || {}).find(
    (e) => e.name === 'iron_golem' && e.position?.distanceTo(v(hub)) <= 32,
  )
  if (nearby) {
    if (state?.status === 'awaitingSpawn') {
      state.status = 'complete'
      chat.save()
    }
    return false
  }
  // A crash or lost spawn acknowledgement must never spend another set of iron.
  if (state?.status === 'awaitingSpawn') return false
  try {
    w.check()
    const data = await storage.list(w)
    if ((data.jobs || []).some((j) => ['queued', 'claimed', 'running'].includes(j.state)))
      return false
    if (!state?.position) {
      const plan = surplus(w, data)
      if (!plan) return false
      const p = findSite(w.bot, hub)
      if (!p) return false
      state = memory.golems[key] = { status: 'preparing', position: { ...p }, head: plan.head }
      chat.save()
    }
    const p = v(state.position)
    if (!clearSite(w.bot, p, true))
      throw new Error('Golem site is obstructed; leaving the partial build in place.')
    const needed = pieces(p).filter((pos) => w.bot.blockAt(pos)?.name !== 'iron_block').length
    // Recheck surplus before spending, including on a resumed partial build.
    const stock = crafting.stocks(w, data)
    const have = (n) => (stock.carry[n] || 0) + (stock.shared[n] || 0)
    if (
      [...TOOL_STOCK, ...ARMOR_STOCK].some((n) => (stock.shared[n] || 0) < 4) ||
      ARMOR_STOCK.some((n) => needsIron(w.bot, n))
    )
      return false
    const toCraft = Math.max(0, needed - have('iron_block'))
    if (have(state.head) < 1 || have('iron_ingot') < IRON_RESERVE + toCraft * 9) return false
    w.progress('Storage is idle with surplus iron. Building a storage guardian.')
    await storage.retrieve(w, [state.head], 1)
    await storage.retrieve(w, ['iron_block'], needed)
    const missing = Math.max(0, needed - count(w, 'iron_block'))
    if (missing) {
      const job = randomUUID()
      await storage.call(w, 'enqueue', { job, item: 'iron_block', quantity: missing })
      const claimed = await storage.call(w, 'claim_job', { job })
      if (!claimed) return false
      await crafting.execute(w, claimed, { storeOutput: false })
    }
    if (count(w, 'iron_block') < needed || count(w, state.head) < 1)
      throw new Error('Golem materials changed during collection.')
    await w.travel(new goals.GoalBlock(p.x, p.y, p.z + 3), 'Stand beside the golem build site')
    if (!clearSite(w.bot, p, true)) throw new Error('Golem site changed during collection.')
    state.status = 'building'
    chat.save()
    const positions = pieces(p)
    const references = [p.offset(0, -1, 0), p, p.offset(0, 1, 0), p.offset(0, 1, 0)]
    const faces = [new Vec3(0, 1, 0), new Vec3(0, 1, 0), new Vec3(-1, 0, 0), new Vec3(1, 0, 0)]
    for (let i = 0; i < positions.length; i++) {
      w.check()
      if (w.bot.blockAt(positions[i])?.name !== 'iron_block')
        await placeIron(w, positions[i], references[i], faces[i])
      w.checkpoint({ phase: 'golem-iron', position: { ...p }, pieces: i + 1 })
    }
    w.check()
    if (
      !clearSite(w.bot, p, true) ||
      positions.some((pos) => w.bot.blockAt(pos)?.name !== 'iron_block')
    )
      throw new Error('Golem structure changed before placing its head.')
    const head = w.bot.inventory.items().find((i) => i.name === state.head && plain(i))
    if (!head) throw new Error('Missing golem head.')
    await w.equip(head)
    const before = new Set(Object.values(w.bot.entities || {}).map((e) => e.id))
    state.status = 'awaitingSpawn'
    chat.save()
    await w.timed(
      async () => {
        w.check()
        try {
          await w.bot.placeBlock(w.bot.blockAt(p.offset(0, 1, 0)), new Vec3(0, 1, 0))
        } catch (error) {
          // The head can turn into an entity before Mineflayer sees it as a block.
          // Still require a new server-observed golem; a placement error alone is not success.
          w.check()
          if (error.fatal) throw error
        }
        while (
          !Object.values(w.bot.entities || {}).some(
            (e) => e.name === 'iron_golem' && !before.has(e.id) && e.position?.distanceTo(p) < 5,
          )
        ) {
          w.check()
          await w.pause(100)
        }
        w.check()
      },
      10000,
      'Confirm new iron golem',
    )
    state.status = 'complete'
    state.completedAt = Date.now()
    chat.save()
    w.counts.golemsBuilt = (w.counts.golemsBuilt || 0) + 1
    w.sync()
    w.progress('Iron golem spawned to guard shared storage.')
    return true
  } catch (error) {
    w.check()
    if (error.fatal || ['CANCELLED', 'HANDOFF', 'AIR_RECOVERY'].includes(error.code)) throw error
    if (state) {
      state.retryAt = Date.now() + 60000
      state.issue = error.message
      chat.save()
    }
    w.addIssue(`Storage golem deferred: ${error.message}`)
    return false
  }
}
module.exports = { build, surplus, clearSite, findSite, IRON_RESERVE }
