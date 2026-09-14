/**
 * SMELTER: Forge turns shared raw ores, sand, clay, cobblestone, logs and raw food into ingots,
 * glass, bricks, stone, charcoal and cooked food in furnaces beside the storage hub.
 * Planning (which batch, how much fuel, which furnace) is separate from execution; every furnace
 * window action, wait, route and chest transfer is bounded, and Minecraft slot contents plus
 * inventory deltas confirm each step. Expected output is never counted before it is collected.
 * Read run() for the loop, cycle() for one pass, and load()/collect() for the furnace mechanics.
 */
const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const { Work } = require('./work.cjs')
const { TravelMovements } = require('./travel.cjs')
const { HOSTILES } = require('./world.cjs')
const { watchBlock } = require('./block-updates.cjs')
const storage = require('./storage.cjs')
const crafting = require('./crafting.cjs')
const { describe, plain } = require('./storage-policy.cjs')

// Furnace inputs and what one unit of each becomes. Logs are matched separately (any species,
// stripped or not). Names are verified against the connected registry before use.
const SMELTABLES = {
  raw_iron: 'iron_ingot',
  raw_copper: 'copper_ingot',
  raw_gold: 'gold_ingot',
  iron_ore: 'iron_ingot',
  deepslate_iron_ore: 'iron_ingot',
  copper_ore: 'copper_ingot',
  deepslate_copper_ore: 'copper_ingot',
  gold_ore: 'gold_ingot',
  deepslate_gold_ore: 'gold_ingot',
  coal_ore: 'coal',
  sand: 'glass',
  red_sand: 'glass',
  cobblestone: 'stone',
  clay_ball: 'brick',
  netherrack: 'nether_brick',
  beef: 'cooked_beef',
  porkchop: 'cooked_porkchop',
  chicken: 'cooked_chicken',
  mutton: 'cooked_mutton',
  cod: 'cooked_cod',
  salmon: 'cooked_salmon',
  potato: 'baked_potato',
  kelp: 'dried_kelp',
  wet_sponge: 'sponge',
}
const LOG = /^(?:stripped_)?[a-z_]+_log$/
// Items one piece of each fuel smelts. Lava buckets are deliberately excluded.
const FUEL = { coal: 8, charcoal: 8, coal_block: 80, stick: 0.5 }
const fuelValue = (name) =>
  FUEL[name] ?? (/_planks$/.test(name) || LOG.test(name) ? 1.5 : 0)
// Batch order when several inputs are available: metal first, then food, then bulk blocks.
const PRIORITY = [
  (n) => /^raw_|_ore$/.test(n),
  (n) => ['beef', 'porkchop', 'chicken', 'mutton', 'cod', 'salmon', 'potato'].includes(n),
  (n) => /sand$/.test(n),
  (n) => n === 'clay_ball',
  (n) => n === 'cobblestone',
  (n) => ['netherrack', 'kelp', 'wet_sponge'].includes(n),
  (n) => LOG.test(n),
]
const SMELT_MS = 10000 // Vanilla furnace time per item.
const MAX_BATCH = 64 // One furnace input slot.
const MAX_FURNACES = 3
const LOG_FLOOR = 32 // Shared logs kept for chests, tools and planks; only the rest becomes charcoal.
const IDLE_WAIT_MS = 20000
const key = (p) => `${p.x},${p.y},${p.z}`
const vector = (p) => new Vec3(p.x, p.y, p.z)
const outputOf = (name) => (LOG.test(name) ? 'charcoal' : SMELTABLES[name] || null)

function parseSmelter(text) {
  const m = text.match(/^smelt\s+([a-z_]+)\s+(\d+)$/)
  if (!m) return null
  if (!outputOf(m[1]))
    throw new Error(
      'Smelt a supported input: raw ores, ore blocks, sand, cobblestone, clay_ball, logs or raw food.',
    )
  const quantity = Number(m[2])
  if (quantity < 1 || quantity > 256) throw new Error('Smelt 1–256 items per job.')
  return { type: 'smelter', item: m[1], quantity }
}
// Pick up to `slots` batches (each ≤ MAX_BATCH) from reserve-adjusted stock, best inputs first.
// `only` restricts to one input (one-off jobs); `limit` caps the total across batches.
function chooseBatches(stock, { only = null, limit = Infinity, slots = MAX_FURNACES, registry = null } = {}) {
  const available = {}
  for (const source of ['carry', 'shared'])
    for (const [name, count] of Object.entries(stock[source] || {})) {
      if (!outputOf(name) || (registry && !registry.itemsByName[name])) continue
      if (only && name !== only) continue
      let usable = count
      if (source === 'shared' && LOG.test(name)) usable = Math.max(0, count - LOG_FLOOR)
      available[name] = (available[name] || 0) + Math.max(0, usable)
    }
  const order = Object.keys(available)
    .filter((n) => available[n] > 0)
    .sort((a, b) => PRIORITY.findIndex((f) => f(a)) - PRIORITY.findIndex((f) => f(b)) || b.localeCompare(a))
  const batches = []
  let remaining = limit
  for (const name of order) {
    while (available[name] > 0 && remaining > 0 && batches.length < slots) {
      const count = Math.min(MAX_BATCH, available[name], remaining)
      batches.push({ input: name, output: outputOf(name), count })
      available[name] -= count
      remaining -= count
    }
  }
  return batches
}
// Greedy fuel choice for `count` smelts from carried counts: coal and charcoal first, a coal
// block only when those run out (it burns 80 smelts at once), then planks/logs, sticks last.
// Returns the fuel items to load and how many smelts they cover (may be fewer than asked).
const fuelRank = (name) => ({ coal: 0, charcoal: 1, coal_block: 2, stick: 9 })[name] ?? (/_planks$/.test(name) ? 3 : 4)
function fuelPlan(count, carried) {
  const items = []
  let units = 0
  for (const name of Object.keys(carried).sort((a, b) => fuelRank(a) - fuelRank(b))) {
    const value = fuelValue(name)
    if (!value || carried[name] <= 0) continue
    const take = Math.min(carried[name], Math.ceil((count - units) / value))
    if (take <= 0) continue
    items.push({ name, count: take })
    units += take * value
    if (units >= count) break
  }
  return { items, covers: Math.min(count, Math.floor(units)) }
}
const slotCount = (item) => (item ? item.count : 0)
const furnaceEmpty = (window) => !window.inputItem() && !window.fuelItem() && !window.outputItem()
// A furnace is ours only when every occupied slot holds exactly this job's input, fuel or output.
function furnaceMatches(window, job) {
  const allowed = new Set([job.input, job.output, ...job.fuel.map((f) => f.name)])
  return [window.inputItem(), window.fuelItem(), window.outputItem()].every((i) => !i || allowed.has(i.name))
}
const playerSlots = (window) => window.slots.slice(window.inventoryStart, window.inventoryEnd).filter(Boolean)
const countIn = (items, name) => items.filter((i) => i.name === name).reduce((n, i) => n + i.count, 0)

class Smelter extends Work {
  constructor(agent, id) {
    super(agent, id)
    this.origin = this.bot.entity.position.clone()
    this.task.skill = 'SMELTER'
    // Fuel stays with Forge; cobblestone is furnace material, not a building reserve for him.
    this.reserves = { coal: 16, charcoal: 16, cobblestone: 0 }
    // Forge never builds, and the shared 128-block refill would dig up the ground around the hub
    // when storage runs out of dirt (observed live). The ensure() guard flag opts him out; the
    // colony return trip still stores surplus and fetches his iron pickaxe.
    this.refillingBuilding = true
    this.furnaces = new Map() // key → { position, state, checkedAt }
    this.hub = null
    // Jobs survive Stop/reconnect: a furnace still holding Forge's own items is reclaimed, not abandoned.
    this.file = agent.dataDir ? path.join(agent.dataDir, 'smelter-jobs.json') : null
    this.scope = `${agent.state.world}:${agent.state.dimension}`
    this.active = this.restore()
    this.plan = {
      status: 'running',
      decision: 'Starting the smelter.',
      furnaces: [],
      active: [],
      smelted: {},
      stored: 0,
      fuelCarried: 0,
      waitingUntil: null,
    }
    agent.state.smelter = this.plan
  }
  check() {
    if (this.cancelled()) super.check()
    if (Date.now() >= this.deadline)
      throw Object.assign(new Error('Smelter time limit reached before the job finished.'), { fatal: true })
    super.check()
    if (this.bot.game.gameMode !== 'survival') throw new Error('Smelter requires Survival mode.')
    const danger =
      this.bot.health <= 6 ||
      this.bot.entity.isInLava ||
      this.bot.oxygenLevel < 8 ||
      Object.values(this.bot.entities || {}).some(
        (e) => HOSTILES.has(e.name) && e.position?.distanceTo(this.bot.entity.position) < 7,
      )
    if (danger)
      throw Object.assign(new Error('Smelter paused: health, air, lava or a nearby hostile needs attention.'), {
        fatal: true,
      })
  }
  count(name) {
    return this.bot.inventory.items().filter((i) => i.name === name).reduce((n, i) => n + i.count, 0)
  }
  carriedCounts() {
    const counts = {}
    for (const item of this.bot.inventory.items()) if (plain(item)) counts[item.name] = (counts[item.name] || 0) + item.count
    return counts
  }
  decide(text) {
    this.plan.decision = text
    this.progress(text)
  }
  publish() {
    this.plan.furnaces = [...this.furnaces.values()].map((f) => ({ ...f.position, state: f.state }))
    this.plan.active = this.active.map((j) => ({
      position: j.position,
      input: j.input,
      count: j.count,
      collected: j.collected,
      startedAt: j.startedAt,
    }))
    this.plan.fuelCarried = this.count('coal') + this.count('charcoal')
    this.sync()
    this.agent.publish()
  }
  colony() {
    return !!this.agent.colony?.enabled
  }
  restore() {
    if (!this.file) return []
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'))[this.scope] || []
      return saved.filter((j) => j.key && j.input && Array.isArray(j.fuel)).slice(0, MAX_FURNACES).map((j) => ({ ...j, lastOpenAt: 0 }))
    } catch (_) {
      return []
    }
  }
  persist() {
    if (!this.file) return
    try {
      let all = {}
      try { all = JSON.parse(fs.readFileSync(this.file, 'utf8')) } catch (_) { all = {} }
      all[this.scope] = this.active.map(({ key, position, input, output, count, fuel, collected, startedAt }) => ({ key, position, input, output, count, fuel, collected, startedAt }))
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      fs.writeFileSync(this.file + '.tmp', JSON.stringify(all, null, 2))
      fs.renameSync(this.file + '.tmp', this.file)
    } catch (error) {
      this.addIssue(`Could not save furnace jobs: ${error.message}`)
    }
  }
  // Wait (bounded) for the server to reflect a furnace slot change instead of trusting one read.
  async confirmSlot(window, read, predicate, label) {
    for (let waited = 0; waited < 3000; waited += 100) {
      if (predicate(read())) return read()
      await this.pause(100)
    }
    throw new Error(`${label} was not confirmed by the furnace window.`)
  }
  db(action, data = {}) {
    return storage.call(this, action, data)
  }
  async run(command) {
    this.bot.pathfinder.setMovements(new TravelMovements(this.bot))
    const monitor = setInterval(() => {
      try {
        this.check()
      } catch (error) {
        if (!this.controller.signal.aborted) this.controller.abort(error)
      }
    }, 500)
    const continuous = !command.item
    if (continuous) {
      this.deadline = Infinity
      this.task.deadlineAt = null
      this.task.continuous = true
    } else {
      // Enough for the batch itself plus supply trips; the per-action limits still apply.
      this.deadline = this.started + 300000 + command.quantity * SMELT_MS
      this.task.deadlineAt = this.deadline
    }
    let produced = 0
    try {
      if (this.colony()) this.agent.colony.scope(this.agent)
      else this.agent.say(`${this.agent.username}: shared storage is not configured, so I only smelt what I carry.`)
      do {
        this.check()
        const result = await this.cycle(command, command.quantity ? command.quantity - produced : Infinity)
        produced += result.produced
        if (!continuous) {
          if (produced >= command.quantity) break
          if (!result.worked) {
            this.task.status = 'partial'
            this.plan.status = 'partial'
            this.agent.say(
              `${this.agent.username}: smelted ${produced}/${command.quantity} ${command.item}; ${this.plan.decision}`,
            )
            return
          }
          continue
        }
        if (!result.worked) {
          this.plan.waitingUntil = Date.now() + IDLE_WAIT_MS
          this.progress(`${this.plan.decision} Checking again in ${IDLE_WAIT_MS / 1000} seconds.`)
          this.publish()
          await this.pause(IDLE_WAIT_MS)
          this.plan.waitingUntil = null
        }
      } while (continuous)
      this.task.status = 'succeeded'
      this.plan.status = 'succeeded'
      this.decide(`Smelted ${produced} ${command.item} → ${outputOf(command.item)}; stored ${this.plan.stored}.`)
      this.agent.say(`${this.agent.username}: ${this.plan.decision}`)
    } catch (error) {
      this.task.status = error.code === 'CANCELLED' ? 'cancelled' : 'partial'
      this.plan.status = this.task.status
      this.addIssue(error.message)
      this.agent.say(`${this.agent.username} smelter stopped: ${error.message}`)
    } finally {
      clearInterval(monitor)
      if (this.agent.bot === this.bot && this.agent.nav === this.id) {
        this.bot.pathfinder.setGoal(null)
        this.bot.clearControlStates()
        if (this.agent.baseMovements) this.bot.pathfinder.setMovements(this.agent.baseMovements)
      }
      this.publish()
    }
  }
  // One pass: choose batches → fuel → inputs → furnaces → load → wait/collect → store.
  async cycle(command, limit) {
    const result = { worked: false, produced: 0 }
    this.plan.waitingUntil = null
    if (this.colony() && !this.hub) this.hub = (await this.db('hub_get')).position || null
    if (this.active.length) {
      this.decide(`Reclaiming ${this.active.length} furnace job(s) left from the previous run.`)
      for (const job of this.active) this.furnaces.set(job.key, { key: job.key, position: job.position, state: 'mine', checkedAt: 0 })
      result.worked = true
      result.produced += await this.waitForFurnaces()
      await this.storeOutput()
      // A one-off job can be satisfied entirely by reclaimed output.
      if (result.produced >= limit) return result
    }
    this.decide('Checking carried items and shared storage for smeltable stock.')
    let stock
    if (this.colony()) stock = crafting.stocks(this, await storage.list(this))
    else stock = { carry: this.carriedCounts(), shared: {} }
    let batches = chooseBatches(stock, { only: command.item || null, limit, registry: this.bot.registry })
    if (!batches.length) {
      this.decide(command.item ? `No ${command.item} available to smelt.` : 'Nothing smeltable is available.')
      return result
    }
    // Secure furnaces before any chest trip so inputs are never withdrawn with nowhere to smelt them.
    const furnaces = await this.acquireFurnaces(batches.length)
    if (!furnaces.length) return result
    batches = await this.arrangeFuel(batches.slice(0, furnaces.length), stock)
    if (!batches.length) return result
    batches = await this.gatherInputs(batches)
    if (!batches.length) return result
    if (this.bot.inventory.emptySlotCount() < 3) {
      this.decide('Inventory is nearly full; storing surplus before smelting.')
      if (this.colony()) await storage.store(this)
      if (this.bot.inventory.emptySlotCount() < 3) throw new Error('Inventory is full. Free space for furnace output.')
    }
    for (const [index, furnace] of furnaces.entries()) {
      const job = batches[index]
      if (!job) break
      try {
        await this.load(furnace, job)
      } catch (error) {
        if (error.fatal || error.code === 'CANCELLED') throw error
        this.check()
        this.addIssue(`Load furnace at ${furnace.key}: ${error.message}`)
        furnace.state = 'occupied'
        furnace.checkedAt = Date.now()
      }
    }
    if (!this.active.length) return result
    result.worked = true
    result.produced += await this.waitForFurnaces()
    await this.storeOutput()
    return result
  }
  // Fuel: carried coal/charcoal first, then shared coal, then a charcoal bootstrap from logs.
  async arrangeFuel(batches, stock) {
    const total = batches.reduce((n, b) => n + b.count, 0)
    let carried = this.carriedCounts()
    let coal = (carried.coal || 0) + (carried.charcoal || 0)
    const needed = Math.ceil(total / 8)
    if (coal < needed && this.colony()) {
      this.decide(`Retrieving fuel: need ${needed} coal or charcoal for ${total} smelts.`)
      await storage.retrieve(this, ['coal', 'charcoal'], needed)
      carried = this.carriedCounts()
      coal = (carried.coal || 0) + (carried.charcoal || 0)
    }
    const fuelStock = Object.fromEntries(Object.entries(carried).filter(([n]) => fuelValue(n) && !LOG.test(n)))
    let covered = fuelPlan(total, fuelStock).covers
    if (covered <= 0) {
      const logs = Object.entries({ ...stock.carry }).filter(([n]) => LOG.test(n))
      const sharedLogs = Object.entries(stock.shared || {}).filter(([n]) => LOG.test(n))
      const available =
        logs.reduce((n, [, c]) => n + c, 0) + Math.max(0, sharedLogs.reduce((n, [, c]) => n + c, 0) - LOG_FLOOR)
      let count = Math.min(MAX_BATCH, available)
      while (count > 0 && count + Math.ceil(count / 1.5) > available) count--
      if (count < 2) {
        this.decide('Waiting for fuel: no coal, charcoal or spare logs in storage or inventory.')
        return []
      }
      const species = [...logs, ...sharedLogs].sort((a, b) => b[1] - a[1])[0][0]
      this.decide(`No coal: making charcoal from ${count} ${species} first, burning logs as fuel.`)
      const total = count + Math.ceil(count / 1.5)
      if (this.count(species) < total && this.colony()) await storage.retrieve(this, [species], total)
      const have = this.count(species)
      let input = Math.min(count, have)
      while (input > 0 && input + Math.ceil(input / 1.5) > have) input--
      if (input < 2) {
        this.decide('Could not retrieve enough logs for a charcoal bootstrap.')
        return []
      }
      return [{ input: species, output: 'charcoal', count: input, fuel: [{ name: species, count: Math.ceil(input / 1.5) }] }]
    }
    // Assign fuel per batch; shrink the last batches when fuel covers only part of the total.
    const pool = { ...fuelStock }
    const out = []
    for (const batch of batches) {
      const plan = fuelPlan(batch.count, pool)
      if (plan.covers <= 0) break
      for (const f of plan.items) pool[f.name] -= f.count
      out.push({ ...batch, count: plan.covers, fuel: plan.items })
    }
    if (out.reduce((n, b) => n + b.count, 0) < total)
      this.addIssue(`Fuel covers ${out.reduce((n, b) => n + b.count, 0)} of ${total} planned smelts; the rest waits.`)
    return out
  }
  // Inputs: withdraw from shared chests, then trust only the confirmed carried count.
  async gatherInputs(batches) {
    const out = []
    const wanted = {}
    for (const b of batches) wanted[b.input] = (wanted[b.input] || 0) + b.count
    for (const [name, count] of Object.entries(wanted)) {
      const before = this.count(name)
      if (before < count && this.colony()) {
        this.decide(`Retrieving ${count - before} ${name} from shared storage.`)
        await storage.retrieve(this, [name], count)
        const after = this.count(name)
        if (after < count) this.addIssue(`Retrieved ${after - before} ${name}; planned ${count - before}.`)
      }
    }
    const carried = this.carriedCounts()
    for (const batch of batches) {
      // A charcoal bootstrap burns the same logs it smelts; keep the fuel share back.
      const fuelLogs = batch.fuel.filter((f) => f.name === batch.input).reduce((n, f) => n + f.count, 0)
      const count = Math.min(batch.count, (carried[batch.input] || 0) - fuelLogs)
      if (count <= 0) continue
      carried[batch.input] -= count + fuelLogs
      out.push({ ...batch, count })
    }
    const usable = out.filter((b) => b.count > 0)
    if (!usable.length) this.decide('Planned inputs did not arrive in inventory; retrying later.')
    return usable
  }
  // Furnace discovery near the hub (else near Forge); a furnace is usable only if empty or ours.
  async acquireFurnaces(needed) {
    const center = this.hub ? vector(this.hub) : this.bot.entity.position
    const positions = this.bot.findBlocks({
      point: center,
      matching: this.bot.registry.blocksByName.furnace.id,
      maxDistance: this.hub ? 16 : 24,
      count: 16,
    })
    for (const p of positions) {
      const k = key(p)
      const known = this.furnaces.get(k)
      if (!known) this.furnaces.set(k, { key: k, position: { x: p.x, y: p.y, z: p.z }, state: 'unknown', checkedAt: 0 })
      else if (known.state === 'missing') known.state = 'unknown'
    }
    for (const f of this.furnaces.values()) if (this.bot.blockAt(vector(f.position))?.name !== 'furnace') f.state = 'missing'
    const usable = []
    const candidates = [...this.furnaces.values()]
      .filter((f) => f.state !== 'missing')
      .sort((a, b) => vector(a.position).distanceTo(center) - vector(b.position).distanceTo(center))
    for (const furnace of candidates) {
      if (usable.length >= Math.min(needed, MAX_FURNACES)) break
      this.check()
      if (this.active.some((j) => j.key === furnace.key)) continue
      const block = this.bot.blockAt(vector(furnace.position))
      // A lit furnace we did not load belongs to someone else; skip it without opening.
      if (block.getProperties().lit === true) {
        furnace.state = 'occupied'
        furnace.checkedAt = Date.now()
        continue
      }
      if (furnace.state === 'occupied' && Date.now() - furnace.checkedAt < 60000) continue
      try {
        const window = await this.open(furnace.position)
        try {
          furnace.state = furnaceEmpty(window) ? 'empty' : 'occupied'
        } finally {
          window.close()
        }
      } catch (error) {
        if (error.fatal || error.code === 'CANCELLED') throw error
        this.check()
        this.addIssue(`Inspect furnace at ${furnace.key}: ${error.message}`)
        furnace.state = 'occupied'
      }
      furnace.checkedAt = Date.now()
      if (furnace.state === 'empty') usable.push(furnace)
    }
    if (!usable.length) {
      try {
        const placed = await this.obtainFurnace()
        if (placed) usable.push(placed)
      } catch (error) {
        // An unreachable hub or no clear spot is a reason to wait and retry, not to end the skill.
        if (error.fatal || error.code === 'CANCELLED') throw error
        this.check()
        this.addIssue(`Obtain furnace: ${error.message}`)
        this.decide(`Waiting for a furnace: ${error.message}`)
      }
    }
    this.publish()
    return usable
  }
  async obtainFurnace() {
    this.decide('No free furnace near the hub; getting one from storage or crafting it.')
    // Work from the hub: the shared crafting table and chests are there, and the furnace goes there.
    if (this.hub && vector(this.hub).distanceTo(this.bot.entity.position) > 6)
      await this.travel(new goals.GoalNear(this.hub.x, this.hub.y, this.hub.z, 3), 'Walk to the storage hub')
    const has = () => this.bot.inventory.items().some((i) => i.name === 'furnace' && plain(i))
    if (!has() && this.colony()) await storage.retrieve(this, ['furnace'], 1)
    if (!has() && this.colony()) {
      const job = randomUUID()
      await this.db('enqueue', { job, item: 'furnace', quantity: 1 })
      const claimed = await this.db('claim_job', { job })
      if (!claimed) throw new Error('Furnace crafting job was claimed by another worker.')
      this.decide('Crafting a furnace from 8 cobblestone through the shared crafting queue.')
      try {
        await crafting.execute(this, claimed, { storeOutput: false })
      } catch (error) {
        // Missing cobblestone or a table is a reason to wait, not to end the smelter.
        if (error.fatal || error.code === 'CANCELLED') throw error
        this.check()
        this.addIssue(`Furnace craft: ${error.message}`)
      }
    }
    if (!has()) {
      this.decide('Waiting for a furnace: none in storage and not enough cobblestone to craft one.')
      return null
    }
    if (this.hub && vector(this.hub).distanceTo(this.bot.entity.position) > 6)
      await this.travel(new goals.GoalNear(this.hub.x, this.hub.y, this.hub.z, 3), 'Walk to the storage hub')
    const block = await placeFurnace(this, this.hub)
    const furnace = { key: key(block.position), position: { ...block.position }, state: 'empty', checkedAt: Date.now() }
    this.furnaces.set(furnace.key, furnace)
    this.counts.furnacesPlaced = (this.counts.furnacesPlaced || 0) + 1
    return furnace
  }
  // Open a furnace window with a time limit; a window that arrives after cancellation is closed.
  async open(position) {
    const p = vector(position)
    if (this.bot.blockAt(p)?.name !== 'furnace') throw new Error('Furnace is missing or changed.')
    await storage.approach(this, p)
    this.check()
    let window = null
    const opening = this.bot.openFurnace(this.bot.blockAt(p))
    try {
      return await this.timed(
        async () => {
          const opened = await opening
          // A window arriving after Stop or a timeout is closed here; timed() has already rejected.
          if (this.cancelled()) {
            safeClose(opened)
            this.check()
          }
          window = opened
          return opened
        },
        7000,
        `Open furnace at ${key(p)}`,
      )
    } catch (error) {
      // Arrived in time but the post-action check failed: release it before rethrowing.
      if (window) safeClose(window)
      throw error
    }
  }
  async load(furnace, job) {
    this.decide(`Loading ${job.count} ${job.input} into the furnace at ${furnace.key}.`)
    const inputItem = this.bot.inventory.items().find((i) => i.name === job.input && plain(i))
    if (!inputItem) throw new Error(`No plain ${job.input} carried.`)
    const inputBefore = this.count(job.input)
    const window = await this.open(furnace.position)
    let loaded = 0
    try {
      if (!furnaceEmpty(window)) throw new Error('Furnace is occupied.')
      await this.timed(() => window.putInput(inputItem.type, null, job.count), 10000, `Load ${job.count} ${job.input}`)
      loaded = slotCount(await this.confirmSlot(window, () => window.inputItem(), (i) => i?.name === job.input, `Loading ${job.input}`))
      try {
        for (const fuel of job.fuel) {
          const item = this.bot.inventory.items().find((i) => i.name === fuel.name && plain(i))
          if (!item) throw new Error(`No ${fuel.name} carried for fuel.`)
          await this.timed(() => window.putFuel(item.type, null, fuel.count), 10000, `Fuel with ${fuel.count} ${fuel.name}`)
        }
        const fuelSlot = await this.confirmSlot(window, () => window.fuelItem(), (i) => !!i, 'Fueling')
        job.fuelLoaded = { name: fuelSlot.name, count: slotCount(fuelSlot) }
      } catch (error) {
        // Never leave a half-loaded furnace behind: reclaim the input before giving up.
        if (window.inputItem()?.name === job.input && !this.cancelled())
          await this.timed(() => window.takeInput(), 10000, `Take back ${job.input}`).catch(() => {})
        throw error
      }
    } finally {
      safeClose(window)
    }
    await this.pause(100)
    const delta = inputBefore - this.count(job.input)
    if (delta !== loaded) this.addIssue(`Inventory shows ${delta} ${job.input} left the bag; furnace shows ${loaded}.`)
    this.active.push({
      ...job,
      key: furnace.key,
      position: furnace.position,
      count: loaded,
      collected: 0,
      startedAt: Date.now(),
      lastOpenAt: Date.now(),
    })
    furnace.state = 'mine'
    this.persist()
    this.publish()
  }
  // Poll block state once per second; open the window only to collect or finish.
  async waitForFurnaces() {
    let produced = 0
    while (this.active.length) {
      this.check()
      for (const job of [...this.active]) {
        const block = this.bot.blockAt(vector(job.position))
        if (block?.name !== 'furnace') {
          this.addIssue(`Furnace at ${job.key} disappeared with ${job.count - job.collected} ${job.input} inside.`)
          this.retire(job, 'missing')
          continue
        }
        const now = Date.now(),
          elapsed = now - job.startedAt
        const expected = Math.min(job.count, Math.floor(elapsed / SMELT_MS))
        const overdue = elapsed > job.count * SMELT_MS + 30000
        const lit = block.getProperties().lit === true
        const stalled = !lit && elapsed > 4000 && now - job.lastOpenAt > 3000
        if (!(overdue || stalled || expected - job.collected >= 8 || (expected >= job.count && now - job.lastOpenAt > 2000))) continue
        try {
          const { taken, done } = await this.collect(job, overdue)
          produced += taken
          if (done) this.retire(job, 'empty')
        } catch (error) {
          if (error.fatal || error.code === 'CANCELLED') throw error
          this.check()
          this.addIssue(`Collect from ${job.key}: ${error.message}`)
          job.lastOpenAt = Date.now()
          if (/another worker/.test(error.message)) this.retire(job, 'occupied')
        }
      }
      const total = this.active.reduce((n, j) => n + j.count - j.collected, 0)
      if (this.active.length) {
        this.decide(`Smelting: ${total} items remaining in ${this.active.length} furnace(s).`)
        this.publish()
        await this.pause(1000)
      }
    }
    return produced
  }
  retire(job, state) {
    this.active = this.active.filter((j) => j !== job)
    const furnace = this.furnaces.get(job.key)
    if (furnace) furnace.state = state
    this.persist()
    this.publish()
  }
  // Take confirmed output; when the input is gone (or the wait expired) reclaim leftovers too.
  async collect(job, final = false) {
    const window = await this.open(job.position)
    job.lastOpenAt = Date.now()
    let taken = 0
    try {
      if (!furnaceMatches(window, job)) throw new Error('Furnace contents changed; another worker is using it.')
      const output = window.outputItem()
      if (output && output.name === job.output) {
        const before = countIn(playerSlots(window), job.output)
        await this.timed(() => window.takeOutput(), 10000, `Collect ${output.count} ${job.output}`)
        await this.pause(150)
        taken = countIn(playerSlots(window), job.output) - before
        if (taken <= 0) throw new Error(`Taking ${job.output} was not confirmed in inventory.`)
        job.collected += taken
        this.plan.smelted[job.output] = (this.plan.smelted[job.output] || 0) + taken
        this.counts.smelted = (this.counts.smelted || 0) + taken
        this.persist()
      }
      const input = window.inputItem(),
        fuel = window.fuelItem()
      const lit = this.bot.blockAt(vector(job.position))?.getProperties().lit === true
      let done = !input || final
      if (!done && input && !fuel && !lit) {
        // Out of fuel with input remaining: top up from the bag or give the batch up.
        const spare = this.bot.inventory.items().find((i) => fuelValue(i.name) && !LOG.test(i.name) && plain(i))
        if (spare) {
          const need = Math.min(spare.count, Math.ceil(input.count / fuelValue(spare.name)))
          await this.timed(() => window.putFuel(spare.type, null, need), 10000, `Refuel with ${need} ${spare.name}`)
          job.fuel = [...job.fuel, { name: spare.name, count: need }]
        } else {
          this.addIssue(`Furnace at ${job.key} ran out of fuel with ${input.count} ${job.input} left.`)
          done = true
        }
      }
      if (done) {
        if (window.inputItem()) await this.timed(() => window.takeInput(), 10000, `Take back leftover ${job.input}`)
        if (window.fuelItem()) await this.timed(() => window.takeFuel(), 10000, 'Take back leftover fuel')
        if (window.outputItem()) await this.timed(() => window.takeOutput(), 10000, `Collect remaining ${job.output}`)
        if (final && job.collected < job.count)
          this.addIssue(`Furnace at ${job.key} finished only ${job.collected}/${job.count} ${job.input} within the limit.`)
      }
      return { taken, done }
    } finally {
      safeClose(window)
    }
  }
  // Deposit this cycle's output explicitly, then ordinary surplus, then the colony return trip.
  async storeOutput() {
    if (!this.colony()) {
      this.decide(`Smelted ${JSON.stringify(this.plan.smelted)}; shared storage is not configured, so I keep it.`)
      return
    }
    for (const name of Object.keys(this.plan.smelted)) {
      const item = this.bot.inventory.items().find((i) => i.name === name && plain(i))
      if (!item) continue
      const have = this.count(name)
      this.decide(`Storing ${have} ${name} in shared storage.`)
      const stored = await storage.store(this, { fingerprint: describe(item).fingerprint, count: have })
      this.plan.stored += stored
      if (stored < have) this.addIssue(`Stored ${stored}/${have} ${name}; the rest stays carried until a chest has space.`)
    }
    await storage.store(this)
    this.publish()
    await this.agent.coordination?.returnSupplies(this)
  }
}
function safeClose(window) {
  try {
    window?.close()
  } catch (_) {
    // The socket may already be gone after a disconnect; nothing else to release.
  }
}
// Place a carried furnace within 8 blocks of the hub, at least two blocks from any chest so
// chest faces stay free for access and Sam's wall signs. Mirrors crafting.place with stricter spacing.
async function placeFurnace(w, hub) {
  const bot = w.bot
  const center = hub ? vector(hub) : bot.entity.position.floored()
  const blocked = new Set(['chest', 'trapped_chest', 'crafting_table', 'furnace'])
  const obstacles = bot
    .findBlocks({
      point: center,
      matching: (b) => blocked.has(b.name) || /sign$/.test(b.name),
      maxDistance: 12,
      count: 64,
    })
  const candidates = bot
    .findBlocks({
      point: center,
      matching: (b) => ['grass_block', 'dirt', 'stone', 'cobblestone'].includes(b.name),
      maxDistance: 8,
      count: 64,
    })
    .filter((p) => p.offset(0, 1, 0).distanceTo(center) <= 8)
    .sort((a, b) => a.distanceTo(center) - b.distanceTo(center))
  const clear = (target) =>
    ['air', 'cave_air'].includes(bot.blockAt(target)?.name) &&
    ['air', 'cave_air'].includes(bot.blockAt(target.offset(0, 1, 0))?.name)
  let tried = 0
  for (const p of candidates) {
    const target = p.offset(0, 1, 0)
    if (!clear(target) || obstacles.some((o) => o.distanceTo(target) < 2)) continue
    if (tried++ >= 6) break
    w.check()
    try {
      await w.approach(p)
    } catch (error) {
      if (error.fatal || error.code === 'CANCELLED') throw error
      continue
    }
    if (!clear(target) || bot.entity.position.distanceTo(target.offset(0.5, 0, 0.5)) < 1.5) continue
    const item = bot.inventory.items().find((i) => i.name === 'furnace' && plain(i))
    if (!item) throw new Error('Need a plain furnace to place.')
    await w.equip(item)
    const range = bot.registry.blocksByName.furnace
    const watcher = watchBlock(bot, target, (id) => id >= range.minStateId && id <= range.maxStateId, w.controller?.signal)
    try {
      await w.timed(
        async () => {
          await bot.placeBlock(bot.blockAt(p), new Vec3(0, 1, 0))
          await watcher.promise
        },
        7000,
        `Place furnace at ${key(target)}`,
      )
      w.check()
      const placed = bot.blockAt(target)
      if (placed?.name !== 'furnace') throw new Error('Furnace placement was not confirmed.')
      return placed
    } finally {
      watcher.cleanup()
    }
  }
  throw new Error('No clear spot within 8 blocks of the hub that keeps two blocks from every chest.')
}
module.exports = {
  Smelter,
  parseSmelter,
  chooseBatches,
  fuelPlan,
  fuelValue,
  outputOf,
  furnaceEmpty,
  furnaceMatches,
  placeFurnace,
  SMELTABLES,
  FUEL,
  LOG_FLOOR,
}
