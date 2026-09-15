/** Central storage maintenance: verified moves, physical labels, bounded tool stock. */
const { randomUUID } = require('node:crypto')
const { Vec3 } = require('vec3')
const storage = require('./service.cjs')
const crafting = require('./crafting.cjs')
const { category, plain, describe } = require('./policy.cjs')
const { directoryFor } = require('../messaging/peer-directory.cjs')
const { pendingPositions } = require('./warehouse-state.cjs')
const vector = (p) => new Vec3(p.x, p.y, p.z)
const atHub = (chest, hub) => vector(chest.position).distanceTo(vector(hub)) <= 8
const TOOL_STOCK = ['iron_pickaxe', 'iron_axe', 'iron_shovel', 'iron_hoe', 'iron_sword']
function coordinatorName(w) {
  if (!directoryFor(w.agent).capabilities().includes('storageCoordinator'))
    throw new Error(
      'Warehouse construction and labels require the storageCoordinator profile capability.',
    )
  return w.agent.username || w.agent.profile.username
}
function destinations(containers, hub, item, registry, exclude) {
  const cat = category(item, registry)
  return containers
    .filter(
      (c) =>
        c.managed &&
        c.id !== exclude &&
        atHub(c, hub) &&
        (c.category === cat || c.category === 'overflow'),
    )
    .sort((a, b) => Number(a.category === 'overflow') - Number(b.category === 'overflow'))
}
async function consolidate(w, hub) {
  const data = await storage.list(w)
  for (const chest of data.containers) {
    if (vector(chest.position).distanceTo(w.origin) > 80) continue
    for (const item of chest.slots) {
      if (
        chest.capacity === 54 &&
        atHub(chest, hub) &&
        (chest.category === category(item, w.bot.registry) ||
          (chest.category === 'overflow' &&
            !data.containers.some(
              (c) => c.managed && atHub(c, hub) && c.category === category(item, w.bot.registry),
            )))
      )
        continue
      if (
        data.reservations.some(
          (r) => r.container === chest.id && r.fingerprint === item.fingerprint,
        )
      )
        continue
      const targets = destinations(data.containers, hub, item, w.bot.registry, chest.id).filter(
        (c) => c.capacity === 54,
      )
      if (!targets.length) continue
      // Never start a move into an area whose observed capacity is already exhausted.
      const space = targets.reduce(
        (n, c) =>
          n +
          Math.max(0, c.capacity - c.slots.length) * (item.stackSize || 64) +
          c.slots
            .filter((i) => i.fingerprint === item.fingerprint)
            .reduce((m, i) => m + Math.max(0, (i.stackSize || 64) - i.count), 0),
        0,
      )
      if (!space) continue
      w.progress(`Consolidating ${item.name} into central storage.`)
      const moved = await storage.withChest(w, chest.position, (ctx) =>
        storage.transfer(w, ctx, 'withdraw', item.fingerprint, Math.min(item.count, space)),
      )
      if (!moved) continue
      const deposited = await storage.store(w, {
        fingerprint: item.fingerprint,
        count: moved,
        exclude: chest.id,
      })
      if (deposited !== moved) {
        // Return leftovers to the source if another worker filled the destination.
        await storage.withChest(w, chest.position, (ctx) =>
          storage.transfer(w, ctx, 'deposit', item.fingerprint, moved - deposited),
        )
        throw new Error('Central storage filled during consolidation. Add capacity at the hub.')
      }
      const current = await storage.list(w)
      data.containers = current.containers
    }
  }
}
function signText(block) {
  const nbt = require('prismarine-nbt')
  let entity = block?.entity
  if (entity?.type) entity = nbt.simplify(entity)
  const messages = entity?.front_text?.messages
  if (messages)
    return messages
      .map((s) => {
        try {
          const t = JSON.parse(s)
          return typeof t === 'string' ? t : t.text || ''
        } catch {
          return s
        }
      })
      .join('\n')
      .trim()
  return Array.isArray(block?.signText)
    ? block.signText.join('\n').trim()
    : block?.signText?.trim?.() || ''
}
async function ensureSign(w) {
  const names = Object.keys(w.bot.registry.itemsByName).filter((n) =>
    /^(oak|birch|spruce|jungle|acacia|dark_oak|cherry|mangrove)_sign$/.test(n),
  )
  if (w.bot.inventory.items().some((i) => names.includes(i.name) && plain(i))) return
  await storage.retrieve(w, names, 1)
  if (w.bot.inventory.items().some((i) => names.includes(i.name) && plain(i))) return
  const stock = crafting.stocks(w, await storage.list(w))
  for (const name of names) {
    try {
      crafting.planRecipes(w.bot, name, 1, stock.carry, stock.shared)
    } catch {
      continue
    }
    const job = randomUUID()
    await storage.call(w, 'enqueue', { job, item: name, quantity: 1 })
    const claimed = await storage.call(w, 'claim_job', { job })
    if (claimed) await crafting.execute(w, claimed, { storeOutput: false })
    return
  }
}
async function label(w, hub) {
  const coordinator = coordinatorName(w)
  const { containers } = await storage.list(w)
  for (const chest of containers.filter((c) => c.managed && c.capacity === 54 && atHub(c, hub))) {
    const p = vector(chest.position)
    const title =
      chest.category === 'overflow'
        ? 'Tools & supplies'
        : chest.category[0].toUpperCase() + chest.category.slice(1)
    const text = `Colony storage\n${title}\nShared by all\n${coordinator}`
    await storage.approach(w, p)
    const faces = [new Vec3(0, 0, 1)]
    const existing = faces
      .map((f) => w.bot.blockAt(p.plus(f)))
      .find((b) => b?.name.endsWith('_wall_sign') && signText(b) === text)
    if (existing) continue
    faces.sort(
      (a, b) =>
        p.plus(a).distanceTo(w.bot.entity.position) - p.plus(b).distanceTo(w.bot.entity.position),
    )
    const face = faces.find(
      (f) =>
        ['air', 'cave_air'].includes(w.bot.blockAt(p.plus(f))?.name) ||
        w.bot.blockAt(p.plus(f))?.name.endsWith('_wall_sign'),
    )
    const placedSign = face && w.bot.blockAt(p.plus(face))?.name.endsWith('_wall_sign')
    if (!placedSign) await ensureSign(w)
    const item = w.bot.inventory
      .items()
      .find((i) => /_sign$/.test(i.name) && !i.name.includes('hanging') && plain(i))
    if (!face || (!item && !placedSign)) {
      w.progress(`Need a sign and a clear chest face to label ${chest.id}.`)
      continue
    }
    const target = p.plus(face)
    await w.travel(
      new (require('mineflayer-pathfinder').goals.GoalBlock)(p.x, p.y, p.z + 2),
      'Stand in front of warehouse label',
    )
    let wrote = false
    const editor = (block) => {
      if (block?.position.equals(target)) {
        w.bot.updateSign(block, text)
        wrote = true
      }
    }
    w.bot.on('signOpen', editor)
    try {
      if (placedSign) {
        w.bot.setControlState('sneak', false)
        await w.timed(
          () => w.bot.activateBlock(w.bot.blockAt(target)),
          7000,
          'Edit warehouse label',
        )
      } else {
        await w.equip(item)
        w.bot.setControlState('sneak', true)
        await w.timed(() => w.bot.placeBlock(w.bot.blockAt(p), face), 7000, `Label ${title} chest`)
      }
      await w.timed(
        async () => {
          while (!wrote || signText(w.bot.blockAt(target)) !== text) {
            w.check()
            await w.pause(100)
          }
        },
        5000,
        'Confirm chest sign text',
      )
      w.counts.signsPlaced = (w.counts.signsPlaced || 0) + 1
      w.sync()
    } finally {
      w.bot.removeListener('signOpen', editor)
      w.bot.setControlState('sneak', false)
    }
  }
}
function expansionCategory(containers, hub) {
  const central = containers.filter((c) => c.managed && atHub(c, hub)),
    groups = new Map()
  for (const c of central) {
    const g = groups.get(c.category) || { used: 0, capacity: 0 }
    g.used += c.slots.length
    if (c.capacity === 54) g.capacity += 54
    groups.set(c.category, g)
  }
  if (!groups.has('overflow')) groups.set('overflow', { used: 0, capacity: 0 })
  return (
    [...groups]
      .map(([cat, g]) => ({
        cat,
        deficit:
          g.used + (cat === 'overflow' ? 54 : Math.max(27, Math.ceil(g.used / 4))) - g.capacity,
      }))
      .filter((g) => g.deficit > 0)
      .sort((a, b) => b.deficit - a.deficit)[0]?.cat || null
  )
}
async function expand(w, hub, requestedCategory = null) {
  coordinatorName(w)
  const data = await storage.list(w),
    cat = requestedCategory || expansionCategory(data.containers, hub)
  if (!cat) return false
  w.progress(`Expanding central ${cat} storage.`)
  const pending = pendingPositions(w)
  const required = pending.length
    ? pending.filter(
        (p) =>
          w.bot.blockAt(
            vector(Object.fromEntries(['x', 'y', 'z'].map((n, i) => [n, Number(p.split(',')[i])]))),
          )?.name !== 'chest',
      ).length
    : 2
  const chestCount = () =>
    w.bot.inventory
      .items()
      .filter((i) => i.name === 'chest' && plain(i))
      .reduce((n, i) => n + i.count, 0)
  const hasChest = () => chestCount() >= required
  if (!hasChest()) await storage.retrieve(w, ['chest'], required)
  if (!hasChest()) {
    let stock = crafting.stocks(w, await storage.list(w))
    try {
      crafting.planRecipes(w.bot, 'chest', required - chestCount(), stock.carry, stock.shared)
    } catch {
      // A small material trip, not an unbounded tree-farming job.
      const logs = Object.keys(w.bot.registry.blocksByName).filter((n) =>
        /^(oak|birch|spruce|jungle|acacia|dark_oak|cherry|mangrove)_log$/.test(n),
      )
      await storage.retrieve(w, logs, 4)
      const enough = () =>
        w.bot.inventory
          .items()
          .filter((i) => logs.includes(i.name))
          .reduce((n, i) => n + i.count, 0) >= 4
      if (!enough()) {
        const candidates = w.bot.findBlocks({
          matching: logs.map((n) => w.bot.registry.blocksByName[n].id),
          maxDistance: 32,
          count: 32,
        })
        for (const p of candidates.slice(0, 8)) {
          if (enough()) break
          w.check()
          const natural = (b) =>
            !!b &&
            logs.includes(b.name) &&
            [
              [0, 1, 0],
              [0, 2, 0],
              [1, 1, 0],
              [-1, 1, 0],
              [0, 1, 1],
              [0, 1, -1],
            ].some((d) => /_leaves$/.test(w.bot.blockAt(b.position.offset(...d))?.name || ''))
          let block = w.bot.blockAt(p)
          if (!natural(block)) continue
          try {
            await w.approach(p)
            block = w.bot.blockAt(p)
            await w.dig(p, block.name, natural)
            await w.pause(750)
            await w.pickup(p)
            await w.pickup(w.bot.entity.position)
          } catch (error) {
            w.check()
            if (error.fatal) throw error
            w.addIssue(`Chest wood: ${error.message}`)
          }
        }
      }
    }
    stock = crafting.stocks(w, await storage.list(w))
    crafting.planRecipes(w.bot, 'chest', required - chestCount(), stock.carry, stock.shared)
    const job = randomUUID()
    await storage.call(w, 'enqueue', { job, item: 'chest', quantity: required - chestCount() })
    const claimed = await storage.call(w, 'claim_job', { job })
    if (!claimed) throw new Error('Storage expansion chest job is already claimed.')
    await crafting.execute(w, claimed, { storeOutput: false })
  }
  // Recheck after the material trip; do not grow capacity already added by another worker.
  const currentCategory =
    requestedCategory || expansionCategory((await storage.list(w)).containers, hub)
  if (!currentCategory) return false
  const bay = await require('./warehouse-layout.cjs').build(w, hub, currentCategory)
  w.counts.chestsAdded = (w.counts.chestsAdded || 0) + 2
  w.sync()
  if (w.agent.coordination) w.agent.coordination.nextCheck = 0
  return w.bot.blockAt(bay.left)
}
async function tools(w, hub) {
  for (const name of TOOL_STOCK) {
    const data = await storage.list(w)
    const chests = data.containers.filter((c) => c.managed && atHub(c, hub))
    if (!chests.some((c) => ['tools', 'overflow'].includes(c.category))) return
    const carried = w.bot.inventory.items().filter((i) => i.name === name && plain(i))
    for (const item of carried)
      await storage.store(w, { fingerprint: describe(item).fingerprint, count: item.count })
    const fresh = await storage.list(w)
    const carriedCount = w.bot.inventory
      .items()
      .filter((i) => i.name === name && plain(i))
      .reduce((n, i) => n + i.count, 0)
    const count =
      carriedCount +
      fresh.containers
        .filter((c) => c.managed && atHub(c, hub))
        .flatMap((c) => c.slots)
        .filter((i) => i.name === name && plain(i))
        .reduce((n, i) => n + i.count, 0)
    if (count >= 4) continue
    const quantity = 4 - count
    const stock = crafting.stocks(w, fresh)
    try {
      crafting.planRecipes(w.bot, name, quantity, stock.carry, stock.shared)
    } catch (error) {
      w.progress(`Tool restock waiting: ${error.message}`)
      continue
    }
    w.progress(`Crafting ${quantity} ${name} for the colony.`)
    const job = randomUUID()
    await storage.call(w, 'enqueue', { job, item: name, quantity })
    const claimed = await storage.call(w, 'claim_job', { job })
    if (claimed) await crafting.execute(w, claimed)
  }
}
const ARMOR_STOCK = ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots']
async function armor(w, hub) {
  const data = await storage.list(w)
  const available = [
    ...data.containers.filter((c) => c.managed && atHub(c, hub)).flatMap((c) => c.slots),
    ...w.bot.inventory.items(),
  ].filter(plain)
  const count = (name) => available.filter((i) => i.name === name).reduce((n, i) => n + i.count, 0)
  if (TOOL_STOCK.some((name) => count(name) < 4)) {
    w.progress('Armor waits until the shared tool buffer is stocked.')
    return
  }
  for (const name of ARMOR_STOCK) {
    const item = w.bot.inventory.items().find((i) => i.name === name && plain(i))
    if (item) await storage.store(w, { fingerprint: describe(item).fingerprint, count: item.count })
    if (count(name) >= 4) continue
    const stock = crafting.stocks(w, await storage.list(w))
    // Make one piece at a time; partial material supply can still produce useful armor.
    try {
      crafting.planRecipes(w.bot, name, 1, stock.carry, stock.shared)
    } catch {
      continue
    }
    if (
      !data.containers.some(
        (c) =>
          c.managed &&
          atHub(c, hub) &&
          ['tools', 'overflow'].includes(c.category) &&
          c.slots.length < c.capacity,
      )
    )
      return
    const job = randomUUID()
    await storage.call(w, 'enqueue', { job, item: name, quantity: 1 })
    const claimed = await storage.call(w, 'claim_job', { job })
    if (claimed) await crafting.execute(w, claimed)
  }
}
module.exports = {
  armor,
  ARMOR_STOCK,
  expand,
  expansionCategory,
  atHub,
  destinations,
  consolidate,
  label,
  tools,
  signText,
  TOOL_STOCK,
}
