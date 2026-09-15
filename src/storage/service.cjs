/** Composable physical storage actions. Database calls never replace Minecraft confirmation. */
const { randomUUID } = require('node:crypto')
const { Vec3 } = require('vec3')
const { describe, plain, category, reserve } = require('./policy.cjs')
const { pendingPositions } = require('./warehouse-state.cjs')
const posKey = (p) => `${p.x},${p.y},${p.z}`
const vector = (p) => new Vec3(p.x, p.y, p.z)
function identity(bot, block) {
  if (block?.name !== 'chest') throw new Error('Only ordinary chests are managed in this version.')
  const blocks = [block.position]
  const props = block.getProperties()
  if (props.type && props.type !== 'single') {
    const directions = {
      north: [1, 0],
      south: [-1, 0],
      east: [0, 1],
      west: [0, -1],
    }
    const right = directions[props.facing]
    if (!right) throw new Error('Unknown chest facing.')
    const sign = props.type === 'left' ? 1 : -1
    const p = block.position.offset(right[0] * sign, 0, right[1] * sign)
    const other = bot.blockAt(p),
      op = other?.getProperties?.()
    if (
      other?.name !== 'chest' ||
      op.facing !== props.facing ||
      !['left', 'right'].includes(op.type) ||
      op.type === props.type
    )
      throw new Error('The other half of this chest is unloaded or changed.')
    blocks.push(p)
  }
  blocks.sort((a, b) => a.x - b.x || a.y - b.y || a.z - b.z)
  return {
    container: blocks.map(posKey).join('|'),
    position: { ...blocks[0] },
    blocks: blocks.map((p) => ({ ...p })),
    capacity: blocks.length * 27,
  }
}
const snapshot = (window) =>
  window.slots.slice(0, window.inventoryStart).filter(Boolean).map(describe)
const total = (items, fp) =>
  items.filter((i) => describe(i).fingerprint === fp).reduce((n, i) => n + i.count, 0)
const carried = (w) => w.bot.inventory.items()
// The backend owns chest/craft reconciliation; the local run journal prevents this
// player from starting unrelated work while one of those operations is unresolved.
async function journalOperation(w, operation, status) {
  await w.agent?.runtime?.saveOperation(w, {
    ...operation,
    status,
    world: w.colonyActor?.state?.world ?? w.agent?.state?.world ?? null,
    dimension: w.colonyActor?.state?.dimension ?? w.agent?.state?.dimension ?? null,
    updatedAt: Date.now(),
  })
}
async function inventoryOperation(w, operation, perform) {
  // Fail before the backend or Minecraft sees a write if the local intent cannot be saved.
  await journalOperation(w, operation, 'intent')
  try {
    const result = await perform()
    await journalOperation(w, operation, 'confirmed')
    return result
  } catch (error) {
    try {
      await journalOperation(w, operation, 'uncertain')
    } catch (journalError) {
      // Keep a durable intent when disconnected; surface critical persistence failures.
      if (journalError.fatal && !error.fatal) throw journalError
    }
    throw error
  }
}
function call(w, action, data = {}) {
  // Freeze world and session for cleanup after a reconnect or dimension change.
  const actor = (w.colonyActor ||= {
    username: w.agent.username,
    colonySession: w.agent.colony.scope(w.agent).session,
    state: { world: w.agent.state.world, dimension: w.agent.state.dimension },
  })
  return w.agent.colony.call(actor, action, data)
}
function nearby(w, radius = 32) {
  return w.bot
    .findBlocks({
      matching: w.bot.registry.blocksByName.chest.id,
      maxDistance: radius,
      count: 32,
    })
    .map((p) => w.bot.blockAt(p))
    .filter(Boolean)
}
async function list(w) {
  w.check()
  const result = await call(w, 'list')
  w.check()
  // Keep the physics/SSE state small; full stock is served only by /api/storage.
  w.agent.state.storage = {
    configured: true,
    updatedAt: Date.now(),
    containerCount: result.containers.length,
    queuedJobs: result.jobs.filter((job) => job.state === 'queued').length,
    uncertainCount: result.uncertain.length,
  }
  w.agent.publish()
  return result
}
async function approach(w, p) {
  try {
    await w.approach(p, { interaction: true })
  } catch (error) {
    if (error.message !== 'No reachable view of the block.') throw error
    // A cell center can see the chest while the bot at its edge cannot. Choose another stance.
    const { BlockApproachGoal } = require('../navigation/block-approach.cjs')
    const goal = new BlockApproachGoal(w.bot, p, { interaction: true }),
      start = w.bot.entity.position.floored()
    const valid = goal.isEnd.bind(goal)
    goal.isEnd = (node) => !(node.x === start.x && node.z === start.z) && valid(node)
    await w.travel(goal, 'Adjusting chest approach for a clear view')
    await w.approach(p, { interaction: true })
  }
}
async function withChest(w, position, fn, { reconcile = false } = {}) {
  w.check()
  const p = vector(position)
  const origin = w.origin || w.bot.entity.position
  if (p.distanceTo(origin) > 80 || p.distanceTo(w.bot.entity.position) > 80)
    throw new Error('Chest is outside the 80-block storage work area.')
  await approach(w, p)
  w.check()
  const id = identity(w.bot, w.bot.blockAt(p))
  const db = (action, data = {}) => call(w, action, { ...id, token, ...data })
  const token = randomUUID()
  await db('register')
  w.check()
  const record = await db(reconcile ? 'reconcile_acquire' : 'acquire')
  let window
  const open = async () => {
    w.check()
    const opened = await w.timed(
      async () => {
        const result = await w.bot.openContainer(w.bot.blockAt(p))
        if (w.cancelled()) {
          result.close()
          w.check()
        }
        return result
      },
      7000,
      'Open shared storage',
    )
    if (opened.inventoryStart !== id.capacity) {
      opened.close()
      throw new Error('Chest size changed. Scan its topology again.')
    }
    return opened
  }
  try {
    window = await open()
    await db('snapshot', { slots: snapshot(window) })
    w.check()
    const ctx = {
      window,
      db,
      record,
      id,
      token,
      reopen: async () => {
        window.close()
        window = null
        // A new window's initial contents come from the server, not predicted clicks.
        window = await open()
        ctx.window = window
        return window
      },
    }
    return await fn(ctx)
  } finally {
    window?.close()
    // If release fails, expiry recovers the lease. Pending operations remain quarantined.
    await db('release').catch(() => {})
  }
}
async function scan(w) {
  const seen = new Set()
  const pending = pendingPositions(w)
  for (const chest of nearby(w).slice(0, 32)) {
    if (pending.includes(posKey(chest.position))) continue
    w.check()
    const id = identity(w.bot, chest).container
    if (seen.has(id)) continue
    seen.add(id)
    await withChest(w, chest.position, async () => {})
  }
  return list(w)
}
// Exact one-slot source AND destination ranges avoid mixing modern item components.
async function transfer(w, ctx, kind, fingerprint, wanted, job = null) {
  const { db } = ctx
  let window = ctx.window
  let moved = 0
  for (let step = 0; step < 64 && moved < wanted; step++) {
    w.check()
    const from =
      kind === 'deposit' ? [window.inventoryStart, window.inventoryEnd] : [0, window.inventoryStart]
    const to =
      kind === 'deposit' ? [0, window.inventoryStart] : [window.inventoryStart, window.inventoryEnd]
    const source = window.slots
      .slice(...from)
      .find((i) => i && describe(i).fingerprint === fingerprint)
    if (!source) break
    const limit = source.stackSize || w.bot.registry.items[source.type]?.stackSize || 64
    let dest = -1
    for (let i = to[0]; i < to[1]; i++) {
      const item = window.slots[i]
      if (item && describe(item).fingerprint === fingerprint && item.count < limit) {
        dest = i
        break
      }
    }
    if (dest < 0)
      for (let i = to[0]; i < to[1]; i++)
        if (!window.slots[i]) {
          dest = i
          break
        }
    if (dest < 0) break
    const count = Math.min(wanted - moved, source.count, limit - (window.slots[dest]?.count || 0))
    const operation = randomUUID()
    const beforeChest = total(window.containerItems(), fingerprint),
      beforeBot = total(
        window.slots.slice(window.inventoryStart, window.inventoryEnd).filter(Boolean),
        fingerprint,
      )
    await db('renew')
    w.check()
    const intent = {
      id: operation,
      kind: 'storage',
      action: kind,
      container: ctx.id?.container || ctx.record?.id || null,
      item: source.name,
      count,
      fingerprint,
      beforeChest,
      beforeBot,
      job,
    }
    await inventoryOperation(w, intent, async () => {
      w.check()
      await db('begin', {
        operation,
        job,
        kind,
        detail: {
          fingerprint,
          name: source.name,
          count,
          beforeChest,
          beforeBot,
          source: source.slot,
          destination: dest,
        },
      })
      // Once intent exists, any failure is uncertain. Never update stock or replay on failure.
      w.check()
      await w.timed(
        () =>
          w.bot.transfer({
            window,
            itemType: source.type,
            metadata: source.metadata,
            count,
            sourceStart: source.slot,
            sourceEnd: source.slot + 1,
            destStart: dest,
            destEnd: dest + 1,
          }),
        15000,
        `${kind === 'deposit' ? 'Store' : 'Retrieve'} ${count} ${source.name}`,
      )
      window = await ctx.reopen()
      w.check()
      const direction = kind === 'deposit' ? 1 : -1
      if (
        total(window.containerItems(), fingerprint) - beforeChest !== direction * count ||
        total(
          window.slots.slice(window.inventoryStart, window.inventoryEnd).filter(Boolean),
          fingerprint,
        ) -
          beforeBot !==
          -direction * count ||
        window.selectedItem
      )
        throw new Error('Transfer is uncertain; chest writes are quarantined for reconciliation.')
      await db('finish', { operation, slots: snapshot(window) })
      w.recordEffect?.({
        kind: 'inventory_transfer',
        operationId: operation,
        direction: kind,
        item: source.name,
        count,
        container: intent.container,
      })
      moved += count
      w.counts[kind === 'deposit' ? 'stored' : 'retrieved'] =
        (w.counts[kind === 'deposit' ? 'stored' : 'retrieved'] || 0) + count
      if (kind === 'deposit' && source.name === 'wheat')
        w.counts.wheatStored = (w.counts.wheatStored || 0) + count
      w.sync()
      w.agent.refresh()
    })
    w.check()
  }
  return moved
}
async function reconcile(w, position) {
  await withChest(
    w,
    position,
    ({ window, db }) =>
      db('reconcile_finish', {
        slots: snapshot(window),
        playerInventory: window.slots
          .slice(window.inventoryStart, window.inventoryEnd)
          .filter(Boolean)
          .map(describe),
      }),
    { reconcile: true },
  )
  return list(w)
}
async function manage(w, position, cat) {
  await withChest(w, position, ({ db }) => db('manage', { category: cat }))
  return list(w)
}
function eligible(w, containers) {
  return containers
    .filter(
      (c) => c.managed && vector(c.position).distanceTo(w.origin || w.bot.entity.position) <= 80,
    )
    .sort(
      (a, b) =>
        vector(a.position).distanceTo(w.bot.entity.position) -
        vector(b.position).distanceTo(w.bot.entity.position),
    )
}
async function store(w, only = null) {
  const { containers } = await list(w)
  const { position: hub } = await call(w, 'hub_get')
  let moved = 0
  const seen = new Set()
  for (const item of carried(w)) {
    const info = describe(item),
      fp = info.fingerprint
    if (seen.has(fp)) continue
    seen.add(fp)
    let amount = only
      ? only.fingerprint === fp
        ? only.count
        : 0
      : Math.max(0, total(carried(w), fp) - reserve(item, w))
    if (!amount) continue
    const cat = category(item, w.bot.registry)
    const targets = eligible(w, containers)
      .filter(
        (c) =>
          (!hub || vector(c.position).distanceTo(vector(hub)) <= 8) &&
          c.id !== only?.exclude &&
          (only?.category
            ? c.category === only.category
            : c.category === cat || c.category === 'overflow'),
      )
      .sort(
        (a, b) =>
          Number(a.category === 'overflow') - Number(b.category === 'overflow') ||
          Number(b.capacity === 54) - Number(a.capacity === 54) ||
          b.slots.length - a.slots.length,
      )
    for (const chest of targets.slice(0, 8)) {
      if (amount <= 0) break
      const n = await withChest(w, chest.position, (ctx) => transfer(w, ctx, 'deposit', fp, amount))
      moved += n
      amount -= n
    }
  }
  await list(w)
  return moved
}
async function retrieve(w, names, target, job = null, allocations = null) {
  const { containers } = await list(w)
  let moved = 0
  const count = () =>
    carried(w)
      .filter((i) => names.includes(i.name))
      .reduce((n, i) => n + i.count, 0)
  for (const chest of eligible(w, containers).slice(0, 16)) {
    if (count() >= target) break
    if (!chest.slots.some((i) => names.includes(i.name))) continue
    await withChest(w, chest.position, async (ctx) => {
      const seen = new Set()
      for (const item of ctx.window.containerItems()) {
        const fp = describe(item).fingerprint
        if (seen.has(fp) || !names.includes(item.name) || !plain(item)) continue
        seen.add(fp)
        const allocation = allocations?.find(
          (a) => a.container === chest.id && a.fingerprint === fp,
        )
        if (allocations && !allocation) continue
        const amount = Math.min(Math.max(0, target - count()), allocation?.quantity ?? Infinity)
        moved += await transfer(w, ctx, 'withdraw', fp, amount, job)
      }
    })
  }
  await list(w)
  return moved
}
async function organize(w) {
  const { containers, reservations } = await list(w)
  for (const chest of eligible(w, containers).slice(0, 8)) {
    for (const item of chest.slots.slice(0, 16)) {
      if (reservations.some((r) => r.container === chest.id && r.fingerprint === item.fingerprint))
        continue
      const cat = category(item, w.bot.registry)
      if (
        cat === chest.category ||
        !containers.some((c) => c.managed && c.category === cat && c.id !== chest.id)
      )
        continue
      const n = await withChest(w, chest.position, (ctx) =>
        transfer(w, ctx, 'withdraw', item.fingerprint, item.count),
      )
      if (n) {
        const deposited = await store(w, {
          fingerprint: item.fingerprint,
          count: n,
          exclude: chest.id,
          category: cat,
        })
        if (deposited < n)
          throw new Error(
            'Destination filled during sorting. Remaining items are carried safely; free space before continuing.',
          )
      }
    }
  }
  return list(w)
}
module.exports = {
  journalOperation,
  inventoryOperation,
  call,
  approach,
  identity,
  snapshot,
  list,
  withChest,
  scan,
  transfer,
  manage,
  reconcile,
  store,
  retrieve,
  organize,
  eligible,
}
