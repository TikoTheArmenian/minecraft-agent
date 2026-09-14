/** Bounded recipe planning and durable execution, independent of Survival's run loop. */
const { randomUUID } = require('node:crypto')
const { Vec3 } = require('vec3')
const { describe, plain, reserve } = require('./storage-policy.cjs')
const storage = require('./storage.cjs')
const { watchBlock } = require('./block-updates.cjs')
const allowed = (name) =>
  /^(?:(?:oak|birch|spruce|jungle|acacia|dark_oak|cherry|mangrove)_planks|stick|chest|crafting_table|bread|torch|(?:wooden|stone|iron)_(?:pickaxe|axe|shovel|hoe|sword))$/.test(
    name,
  )
function planRecipes(bot, item, quantity, carry, shared, needTable = false) {
  if (
    !allowed(item) ||
    !Number.isInteger(quantity) ||
    quantity < 1 ||
    quantity > 128
  )
    throw new Error(
      'Craft 1–128 supported plain wood products, basic tools, bread or torches.',
    )
  let state = {
    carry: { ...carry },
    shared: { ...shared },
    withdrawals: {},
    steps: [],
  }
  let attempts = 0
  function consume(name, count, depth, path) {
    for (const source of ['carry', 'shared']) {
      const take = Math.min(count, state[source][name] || 0)
      state[source][name] = (state[source][name] || 0) - take
      if (source === 'shared' && take)
        state.withdrawals[name] = (state.withdrawals[name] || 0) + take
      count -= take
    }
    if (count > 0) {
      produce(name, count, depth, path)
      state.carry[name] -= count
    }
  }
  function produce(name, count, depth = 0, path = []) {
    if (++attempts > 512 || depth > 8 || path.includes(name) || !allowed(name))
      throw new Error(`Missing materials: ${name}.`)
    const id = bot.registry.itemsByName[name]?.id
    const recipes =
      id === undefined ? [] : bot.recipesAll(id, null, true).slice(0, 64)
    for (const recipe of recipes) {
      const before = state
      state = {
        carry: { ...before.carry },
        shared: { ...before.shared },
        withdrawals: { ...before.withdrawals },
        steps: [...before.steps],
      }
      try {
        const times = Math.ceil(count / recipe.result.count)
        for (const delta of recipe.delta.filter((d) => d.count < 0))
          consume(
            bot.registry.items[delta.id].name,
            -delta.count * times,
            depth + 1,
            [...path, name],
          )
        for (const delta of recipe.delta.filter((d) => d.count > 0)) {
          const output = bot.registry.items[delta.id].name
          state.carry[output] = (state.carry[output] || 0) + delta.count * times
        }
        state.steps.push({ name, recipe, times })
        if (state.steps.reduce((n, s) => n + s.times, 0) > 128)
          throw new Error('Craft plan exceeds 128 recipe executions.')
        return
      } catch (_) {
        state = before
      }
    }
    throw new Error(
      `Missing materials for ${name}; inspect shared stock and working reserves.`,
    )
  }
  if (needTable) produce('crafting_table', 1)
  produce(item, quantity)
  return state
}
function stocks(w, data) {
  const carry = {},
    shared = {}
  for (const item of w.bot.inventory.items())
    if (plain(item)) carry[item.name] = (carry[item.name] || 0) + item.count
  for (const name of Object.keys(carry))
    carry[name] = Math.max(
      0,
      carry[name] -
        reserve(
          w.bot.inventory.items().find((i) => i.name === name && plain(i)),
          w,
        ),
    )
  const candidates = []
  for (const chest of storage.eligible(w, data.containers)) {
    if (!chest.checked_at || Date.now() - Date.parse(chest.checked_at) > 300000)
      continue
    const aggregated = new Map()
    for (const item of chest.slots)
      if (plain(item)) {
        const previous = aggregated.get(item.fingerprint)
        aggregated.set(item.fingerprint, {
          ...item,
          count: (previous?.count || 0) + item.count,
        })
      }
    for (const item of aggregated.values()) {
      const held = data.reservations
        .filter(
          (r) => r.container === chest.id && r.fingerprint === item.fingerprint,
        )
        .reduce((n, r) => n + r.quantity, 0)
      const quantity = Math.max(0, item.count - held)
      shared[item.name] = (shared[item.name] || 0) + quantity
      candidates.push({
        container: chest.id,
        fingerprint: item.fingerprint,
        name: item.name,
        quantity,
      })
    }
  }
  return { carry, shared, candidates }
}
async function place(w, name, hub = null) {
  const bot = w.bot
  const candidates = bot.findBlocks({
    matching: (b) =>
      ['grass_block', 'dirt', 'stone', 'cobblestone'].includes(b.name),
    maxDistance: 8,
    count: 32,
  })
  for (const p of candidates) {
    const target = p.offset(0, 1, 0)
    if (hub && target.distanceTo(new Vec3(hub.x,hub.y,hub.z)) > 8) continue
    const clear = () =>
      ['air', 'cave_air'].includes(bot.blockAt(target)?.name) &&
      ['air', 'cave_air'].includes(bot.blockAt(target.offset(0, 1, 0))?.name)
    if (
      !clear() ||
      [
        new Vec3(1, 0, 0),
        new Vec3(-1, 0, 0),
        new Vec3(0, 0, 1),
        new Vec3(0, 0, -1),
      ].some((v) => bot.blockAt(target.plus(v))?.name === 'chest')
    )
      continue
    await w.approach(p)
    if (
      !clear() ||
      bot.entity.position.distanceTo(target.offset(0.5, 0, 0.5)) < 1.5
    )
      continue
    const item = bot.inventory.items().find((i) => i.name === name && plain(i))
    if (!item) throw new Error(`Need a plain ${name} to place.`)
    await w.equip(item)
    const watcher = watchBlock(
      bot,
      target,
      (id) =>
        id >= bot.registry.blocksByName[name].minStateId &&
        id <= bot.registry.blocksByName[name].maxStateId,
      w.controller?.signal,
    )
    try {
      await w.timed(
        async () => {
          await bot.placeBlock(bot.blockAt(p), new Vec3(0, 1, 0))
          await watcher.promise
        },
        7000,
        `Place ${name}`,
      )
      return bot.blockAt(target)
    } finally {
      watcher.cleanup()
    }
  }
  throw new Error(`No clear reachable place for ${name}.`)
}
async function execute(w, job, { storeOutput = true } = {}) {
  const db = (action, data = {}) =>
    storage.call(w, action, { job: job.id, ...data })
  try {
    const data = await storage.list(w),
      stock = stocks(w, data)
    let table = w.bot
      .findBlocks({
        matching: w.bot.registry.blocksByName.crafting_table.id,
        maxDistance: 24,
        count: 4,
      })
      .map((p) => w.bot.blockAt(p))[0]
    let plan = planRecipes(
      w.bot,
      job.item,
      job.quantity,
      stock.carry,
      stock.shared,
    )
    if (
      !table &&
      !w.bot.inventory
        .items()
        .some((i) => i.name === 'crafting_table' && plain(i)) &&
      plan.steps.some((s) => s.recipe.requiresTable)
    )
      plan = planRecipes(
        w.bot,
        job.item,
        job.quantity,
        stock.carry,
        stock.shared,
        true,
      )
    const allocations = []
    for (const [name, amount] of Object.entries(plan.withdrawals)) {
      let remaining = amount
      for (const candidate of stock.candidates.filter((c) => c.name === name)) {
        const quantity = Math.min(remaining, candidate.quantity)
        if (quantity) allocations.push({ ...candidate, quantity })
        remaining -= quantity
      }
      if (remaining) throw new Error(`Shared stock changed: ${name}.`)
    }
    await db('reserve', { items: allocations })
    // Withdraw all ingredients before crafting. Capacity failure blocks without consuming recipes.
    for (const [name, amount] of Object.entries(plan.withdrawals)) {
      const before = w.bot.inventory
        .items()
        .filter((i) => i.name === name)
        .reduce((n, i) => n + i.count, 0)
      await storage.retrieve(w, [name], before + amount, job.id, allocations)
      const after = w.bot.inventory
        .items()
        .filter((i) => i.name === name)
        .reduce((n, i) => n + i.count, 0)
      if (after - before !== amount)
        throw new Error(
          `Could not retrieve all ${name}; check chest contents and inventory space.`,
        )
      await db('job_status', {
        state: 'running',
        detail: `Retrieved ${amount} ${name}.`,
      })
    }
    let produced = 0
    for (const step of plan.steps) {
      if (step.recipe.requiresTable) {
        table ||= await place(w, 'crafting_table')
        await w.approach(table.position)
        if (w.bot.blockAt(table.position)?.name !== 'crafting_table')
          throw new Error('Crafting table changed.')
      }
      for (let n = 0; n < step.times; n++) {
        w.check()
        // Mineflayer recipes match item type. Refuse ambiguous modified ingredients.
        for (const delta of step.recipe.delta.filter((d) => d.count < 0)) {
          if (
            w.bot.inventory
              .items()
              .some((i) => i.type === delta.id && !plain(i))
          )
            throw new Error(
              'Move modified recipe ingredients out of inventory before crafting.',
            )
          const have = w.bot.inventory
            .items()
            .filter((i) => i.type === delta.id)
            .reduce((sum, i) => sum + i.count, 0)
          if (have < -delta.count)
            throw new Error('Recipe ingredients changed before crafting.')
        }
        if (w.bot.inventory.emptySlotCount() < 2)
          throw new Error(
            'Keep two empty inventory slots for crafting results.',
          )
        const before = new Map(
          step.recipe.delta.map((d) => [
            d.id,
            w.bot.inventory
              .items()
              .filter((i) => i.type === d.id)
              .reduce((sum, i) => sum + i.count, 0),
          ]),
        )
        const operation = randomUUID()
        await db('job_status', {
          state: 'running',
          detail: `Crafting ${step.name}.`,
        })
        await db('begin', {
          operation,
          kind: 'craft',
          detail: {
            name: step.name,
            delta: step.recipe.delta,
            before: Object.fromEntries(before),
          },
        })
        w.check()
        await w.timed(
          () =>
            w.bot.craft(
              step.recipe,
              1,
              step.recipe.requiresTable ? table : null,
            ),
          20000,
          `Craft ${step.name}`,
        )
        for (const delta of step.recipe.delta) {
          const after = w.bot.inventory
            .items()
            .filter((i) => i.type === delta.id)
            .reduce((sum, i) => sum + i.count, 0)
          if (after - before.get(delta.id) !== delta.count)
            throw new Error(
              'Craft result is uncertain. Inspect inventory before issuing a new job.',
            )
        }
        await db('finish_craft', { operation })
        w.counts.crafted = (w.counts.crafted || 0) + step.recipe.result.count
        if (step.name === job.item) produced += step.recipe.result.count
        w.sync()
        w.agent.refresh()
      }
    }
    const output = w.bot.inventory
      .items()
      .find((i) => i.name === job.item && plain(i))
    const stored =
      output && storeOutput
        ? await storage.store(w, {
            fingerprint: describe(output).fingerprint,
            count: produced,
          })
        : 0
    await db('job_status', {
      state: 'complete',
      detail: `Crafted ${produced}; stored ${stored}; ${produced - stored} remain carried.`,
    })
  } catch (error) {
    await db('job_status', {
      state: w.cancelled() ? 'cancelled' : 'blocked',
      detail: error.message,
    }).catch(() => {})
    throw error
  } finally {
    if (!w.cancelled()) await storage.list(w)
  }
}
module.exports = { allowed, planRecipes, stocks, place, execute }
