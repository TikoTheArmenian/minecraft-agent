/**
 * SMELTER (Forge): turn shared raw ores, sand, clay, cobblestone, logs and raw food
 * into ingots, glass, bricks, stone, charcoal and cooked food in ordinary furnaces
 * beside the storage hub.
 *
 * Planning (which batch, how much fuel, which furnace) is separate from doing it.
 * Every furnace window action, wait, walk and chest transfer is time-bounded.
 * Minecraft slot contents plus inventory deltas confirm each step — expected
 * output is never counted before it is collected.
 *
 * Read in this order:
 *   parseSmelter / chooseBatches / fuelPlan  — what to smelt and how to fuel it
 *   validJobs / restore / persist            — jobs survive Stop and reconnect
 *   run / cycle                              — the loop
 *   acquireFurnaces / load / collect         — furnace I/O
 *   mutate / reconcile                       — confirm or quarantine every transfer
 */
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const { Work } = require('../runtime/work.cjs')
const { TravelMovements } = require('../navigation/travel.cjs')
const { HOSTILES } = require('../world/observations.cjs')
const { watchBlock } = require('../minecraft/block-updates.cjs')
const storage = require('../storage/service.cjs')
const crafting = require('../storage/crafting.cjs')
const { describe, plain } = require('../storage/policy.cjs')
const { loadJson, saveJson } = require('../infra/json-store.cjs')
const { ResourceLeases } = require('../runtime/resource-leases.cjs')

// ---------------------------------------------------------------------------
// Recipes and fuel
// ---------------------------------------------------------------------------

// One unit of each input becomes this output. Logs are matched separately
// (any species, stripped or not). Names are checked against the live registry.
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
const isLog = (name) => LOG.test(name)
const isPlanks = (name) => /_planks$/.test(name)
const RAW_FOODS = ['beef', 'porkchop', 'chicken', 'mutton', 'cod', 'salmon', 'potato']
const LOW_PRIORITY_BLOCKS = ['netherrack', 'kelp', 'wet_sponge']

// How many items one piece of each named fuel smelts. Lava buckets are excluded
// on purpose (they leave an empty bucket and are easy to waste).
const FUEL = { coal: 8, charcoal: 8, coal_block: 80, stick: 0.5 }
const PLANKS_OR_LOG_SMELTS = 1.5
const fuelValue = (name) => FUEL[name] ?? (isPlanks(name) || isLog(name) ? PLANKS_OR_LOG_SMELTS : 0)

// When several inputs are available, pick in this order: metal, food, then bulk.
const PRIORITY = [
  (n) => /^raw_|_ore$/.test(n),
  (n) => RAW_FOODS.includes(n),
  (n) => /sand$/.test(n),
  (n) => n === 'clay_ball',
  (n) => n === 'cobblestone',
  (n) => LOW_PRIORITY_BLOCKS.includes(n),
  (n) => isLog(n),
]
const priorityIndex = (name) => PRIORITY.findIndex((matches) => matches(name))

const SMELT_MS = 10000 // Vanilla furnace time per item.
const MAX_BATCH = 64 // One furnace input slot.
const MAX_FURNACES = 3
const LOG_FLOOR = 32 // Shared logs kept for chests/tools/planks; only the rest becomes charcoal.
const IDLE_WAIT_MS = 20000
const ONE_OFF_BASE_MS = 300000 // 5 min of walking/supply trips, plus SMELT_MS per item.
const MONITOR_MS = 500
const SLOT_CONFIRM_MS = 3000
const SLOT_POLL_MS = 100
const OPEN_WINDOW_MS = 7000
const TRANSFER_MS = 10000
const OCCUPIED_SKIP_MS = 60000
const WAIT_POLL_MS = 1000
const OVERDUE_SLACK_MS = 30000
const STALL_AFTER_MS = 4000
const REOPEN_AFTER_MS = 3000
const COLLECT_BATCH = 8
const FINISH_REOPEN_MS = 2000
const HUB_NEAR_BLOCKS = 6
const HUB_SCAN = 16
const LOCAL_SCAN = 24
const HOSTILE_BLOCKS = 7
const LOW_HEALTH = 6
const LOW_AIR = 8
const MIN_FREE_SLOTS = 3
const PLACE_TIMEOUT_MS = 7000
const PLACE_ATTEMPTS = 6
const HUB_PLACE_RADIUS = 8
const CHEST_CLEARANCE = 2

const key = (p) => `${p.x},${p.y},${p.z}`
const vector = (p) => new Vec3(p.x, p.y, p.z)
const outputOf = (name) => (isLog(name) ? 'charcoal' : SMELTABLES[name] || null)
const slotCount = (item) => (item ? item.count : 0)
const itemsInFurnace = (window) => slotCount(window.inputItem()) + slotCount(window.outputItem())
const furnaceEmpty = (window) => !window.inputItem() && !window.fuelItem() && !window.outputItem()
const furnaceIsLit = (block) => block?.getProperties().lit === true
const playerSlots = (window) =>
  window.slots.slice(window.inventoryStart, window.inventoryEnd).filter(Boolean)
const countIn = (items, name) =>
  items.filter((i) => i.name === name).reduce((n, i) => n + i.count, 0)
const interrupted = (error) => error.fatal || ['CANCELLED', 'HANDOFF'].includes(error.code)
const isRecord = (value) => value && typeof value === 'object' && !Array.isArray(value)
const nonnegative = (value) => Number.isSafeInteger(value) && value >= 0
const countEntries = (pairs) => pairs.reduce((total, [, count]) => total + count, 0)

// A furnace is ours only when every occupied slot holds exactly this job's input, fuel or output.
function furnaceMatches(window, job) {
  const input = window.inputItem()
  const fuel = window.fuelItem()
  const output = window.outputItem()
  const inputOurs = !input || (input.name === job.input && plain(input))
  const fuelOurs = !fuel || (job.fuel.some((f) => f.name === fuel.name) && plain(fuel))
  const outputOurs = !output || (output.name === job.output && plain(output))
  return inputOurs && fuelOurs && outputOurs
}

function reconcileError(message) {
  return Object.assign(
    new Error(
      `${message} Saved furnace ownership is retained; inspect the furnace and inventory before retrying.`,
    ),
    { code: 'REQUIRES_RECONCILIATION', fatal: true },
  )
}

function inImmediateDanger(bot) {
  const tooClose = Object.values(bot.entities || {}).some(
    (entity) =>
      HOSTILES.has(entity.name) &&
      entity.position?.distanceTo(bot.entity.position) < HOSTILE_BLOCKS,
  )
  return bot.health <= LOW_HEALTH || bot.entity.isInLava || bot.oxygenLevel < LOW_AIR || tooClose
}

function charcoalLogsNeeded(inputCount) {
  return inputCount + Math.ceil(inputCount / PLANKS_OR_LOG_SMELTS)
}

// Largest input count that still leaves enough of the same logs to burn as fuel.
function fitCharcoalBatch(available) {
  let count = Math.min(MAX_BATCH, available)
  while (count > 0 && charcoalLogsNeeded(count) > available) count--
  return count
}

// Open the window only when a useful amount of output should be ready, the fire
// went out, or the vanilla-time budget plus slack has expired.
function shouldCollectNow(job, block, now = Date.now()) {
  const elapsed = now - job.startedAt
  const expected = Math.min(job.count, Math.floor(elapsed / SMELT_MS))
  const overdue = elapsed > job.count * SMELT_MS + OVERDUE_SLACK_MS
  const stalled =
    !furnaceIsLit(block) && elapsed > STALL_AFTER_MS && now - job.lastOpenAt > REOPEN_AFTER_MS
  const batchReady = expected - job.collected >= COLLECT_BATCH
  const jobFinished = expected >= job.count && now - job.lastOpenAt > FINISH_REOPEN_MS
  return overdue || stalled || batchReady || jobFinished
}

// ---------------------------------------------------------------------------
// Command parsing and batch / fuel plans
// ---------------------------------------------------------------------------

function parseSmelter(text) {
  const match = text.match(/^smelt\s+([a-z_]+)\s+(\d+)$/)
  if (!match) return null
  if (!outputOf(match[1]))
    throw new Error(
      'Smelt a supported input: raw ores, ore blocks, sand, cobblestone, clay_ball, logs or raw food.',
    )
  const quantity = Number(match[2])
  if (quantity < 1 || quantity > 256) throw new Error('Smelt 1–256 items per job.')
  return { type: 'smelter', item: match[1], quantity }
}

// Usable counts per item name: carried + shared, minus the log floor on shared logs.
function usableSmeltStock(stock, { only = null, registry = null } = {}) {
  const available = {}
  for (const source of ['carry', 'shared']) {
    for (const [name, count] of Object.entries(stock[source] || {})) {
      if (!outputOf(name) || (registry && !registry.itemsByName[name])) continue
      if (only && name !== only) continue
      let usable = count
      if (source === 'shared' && isLog(name)) usable = Math.max(0, count - LOG_FLOOR)
      available[name] = (available[name] || 0) + Math.max(0, usable)
    }
  }
  return available
}

// Pick up to `slots` batches (each ≤ MAX_BATCH) from reserve-adjusted stock, best inputs first.
// `only` restricts to one input (one-off jobs); `limit` caps the total across batches.
function chooseBatches(
  stock,
  { only = null, limit = Infinity, slots = MAX_FURNACES, registry = null } = {},
) {
  const available = usableSmeltStock(stock, { only, registry })
  const order = Object.keys(available)
    .filter((name) => available[name] > 0)
    .sort((a, b) => priorityIndex(a) - priorityIndex(b) || b.localeCompare(a))
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

// Greedy fuel choice for `count` smelts from carried counts: coal and charcoal first,
// a coal block only when those run out (it burns 80 smelts at once), then planks/logs,
// sticks last. May cover fewer smelts than asked.
const fuelRank = (name) =>
  ({ coal: 0, charcoal: 1, coal_block: 2, stick: 9 })[name] ?? (isPlanks(name) ? 3 : 4)
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

const carriedFuelStock = (carried) =>
  Object.fromEntries(Object.entries(carried).filter(([name]) => fuelValue(name) && !isLog(name)))

// ---------------------------------------------------------------------------
// Saved-job validation (corrupt files are refused, never silently discarded)
// ---------------------------------------------------------------------------

const JOB_STATES = ['loading', 'active', 'reconcile']
const TRANSFER_KINDS = ['putInput', 'putFuel', 'takeOutput', 'takeInput', 'takeFuel']

function validPosition(position, expectedKey) {
  return (
    isRecord(position) &&
    ['x', 'y', 'z'].every((axis) => Number.isSafeInteger(position[axis])) &&
    expectedKey === key(position)
  )
}

function validFuelList(fuel) {
  return (
    Array.isArray(fuel) &&
    fuel.every(
      (entry) =>
        isRecord(entry) &&
        !!fuelValue(entry.name) &&
        Number.isSafeInteger(entry.count) &&
        entry.count > 0 &&
        entry.count <= MAX_BATCH,
    )
  )
}

function pendingNameMatches(job, pending) {
  if (['putInput', 'takeInput'].includes(pending.kind)) return pending.name === job.input
  if (pending.kind === 'takeOutput') return pending.name === job.output
  return job.fuel.some((entry) => entry.name === pending.name)
}

const validOperationId = (id) => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(id)

function validPending(job, pending, allowMissingId = false) {
  if (pending == null) return true
  return (
    isRecord(pending) &&
    (validOperationId(pending.id) || (allowMissingId && pending.id === undefined)) &&
    TRANSFER_KINDS.includes(pending.kind) &&
    pendingNameMatches(job, pending) &&
    nonnegative(pending.beforeInventory) &&
    Number.isSafeInteger(pending.count) &&
    pending.count > 0 &&
    pending.count <= MAX_BATCH
  )
}

function validJob(job, allowMissingId = false) {
  return (
    isRecord(job) &&
    validPosition(job.position, job.key) &&
    !!outputOf(job.input) &&
    job.output === outputOf(job.input) &&
    Number.isSafeInteger(job.count) &&
    job.count > 0 &&
    job.count <= MAX_BATCH &&
    nonnegative(job.collected) &&
    job.collected <= job.count &&
    Number.isFinite(job.startedAt) &&
    validFuelList(job.fuel) &&
    (job.state === undefined || JOB_STATES.includes(job.state)) &&
    validPending(job, job.pending, allowMissingId)
  )
}

function validJobs(data, allowMissingId = false) {
  return (
    isRecord(data) &&
    Object.values(data).every(
      (jobs) =>
        Array.isArray(jobs) &&
        jobs.length <= MAX_FURNACES &&
        jobs.every((job) => validJob(job, allowMissingId)),
    )
  )
}

function loadJobFile(file, fallback) {
  return file
    ? loadJson(file, { validate: (data) => validJobs(data, true), allowLegacy: true }).data
    : fallback
}

// ---------------------------------------------------------------------------
// Smelter
// ---------------------------------------------------------------------------

class Smelter extends Work {
  constructor(agent, id) {
    super(agent, id)
    this.origin = this.bot.entity.position.clone()
    this.task.skill = 'SMELTER'
    // Fuel stays with Forge. Cobblestone is furnace material, not a building reserve.
    this.reserves = { coal: 16, charcoal: 16, cobblestone: 0 }
    // Forge never builds. The shared 128-block refill would dig up the ground around
    // the hub when storage runs out of dirt (observed live). `true` opts him out;
    // the colony return trip still stores surplus and fetches his iron pickaxe.
    this.refillingBuilding = true
    this.furnaces = new Map() // key → { position, state, checkedAt }
    this.hub = null
    // Jobs survive Stop/reconnect: a furnace still holding Forge's items is reclaimed.
    this.file = agent.dataDir ? path.join(agent.dataDir, 'smelter-jobs.json') : null
    this.scope = `${agent.state.world}:${agent.state.dimension}`
    this.resourceScope = {
      world: String(agent.state.world),
      dimension: String(agent.state.dimension),
    }
    this.resources = agent.resourceLeases ||= new ResourceLeases()
    this.resourceOwner = { agentId: agent.id || agent.username || 'smelter', runId: id }
    this.leases = new Map()
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
      throw Object.assign(new Error('Smelter time limit reached before the job finished.'), {
        fatal: true,
      })
    super.check()
    if (this.bot.game.gameMode !== 'survival') throw new Error('Smelter requires Survival mode.')
    if (inImmediateDanger(this.bot))
      throw Object.assign(
        new Error('Smelter paused: health, air, lava or a nearby hostile needs attention.'),
        {
          fatal: true,
        },
      )
  }

  count(name) {
    return this.bot.inventory
      .items()
      .filter((item) => item.name === name)
      .reduce((n, item) => n + item.count, 0)
  }

  carriedCounts() {
    const counts = {}
    for (const item of this.bot.inventory.items()) {
      if (plain(item)) counts[item.name] = (counts[item.name] || 0) + item.count
    }
    return counts
  }

  decide(text) {
    this.plan.decision = text
    this.progress(text)
  }

  publish() {
    this.plan.furnaces = [...this.furnaces.values()].map((furnace) => ({
      ...furnace.position,
      state: furnace.state,
    }))
    this.plan.active = this.active.map((job) => ({
      position: job.position,
      input: job.input,
      count: job.count,
      collected: job.collected,
      startedAt: job.startedAt,
      state: job.state || 'active',
      pending: job.pending?.kind || null,
    }))
    this.plan.fuelCarried = this.count('coal') + this.count('charcoal')
    this.sync()
    this.agent.publish()
  }

  colony() {
    return !!this.agent.colony?.enabled
  }

  restore() {
    const data = loadJobFile(this.file, this.agent.smelterJobs)
    let migrated = false
    for (const jobs of Object.values(data || {}))
      for (const job of jobs) {
        if (job.pending && !job.pending.id) {
          job.pending.id = randomUUID()
          migrated = true
        }
      }
    // Legacy intents keep the same recovery identity on every subsequent restart.
    if (migrated) {
      if (this.file) saveJson(this.file, data, { validate: validJobs })
      this.agent.smelterJobs = structuredClone(data)
    }
    return (data?.[this.scope] || []).map((job) => ({
      ...job,
      fuel: job.fuel.map((entry) => ({ ...entry })),
      state: job.state || 'active',
      lastOpenAt: 0,
    }))
  }

  get outstandingOperationIds() {
    return this.active.filter((job) => job.pending).map((job) => job.pending.id)
  }

  persist() {
    const all = loadJobFile(this.file, this.agent.smelterJobs) || {}
    all[this.scope] = this.active.map(
      ({
        key,
        position,
        input,
        output,
        count,
        fuel,
        collected,
        startedAt,
        state = 'active',
        pending = null,
      }) => ({
        key,
        position,
        input,
        output,
        count,
        fuel,
        collected,
        startedAt,
        state,
        pending,
      }),
    )
    if (this.file) saveJson(this.file, all, { validate: validJobs })
    this.agent.smelterJobs = structuredClone(all)
  }

  own(position) {
    const furnaceKey = key(position)
    const existing = this.leases.get(furnaceKey)
    if (existing && this.resources.valid(existing)) return existing
    const lease = this.resources.acquire(
      this.resourceScope,
      `furnace:${furnaceKey}`,
      this.resourceOwner,
    )
    this.leases.set(furnaceKey, lease)
    return lease
  }

  releaseResources() {
    for (const [furnaceKey, lease] of this.leases) {
      if (!this.resources.valid(lease)) continue
      if (this.active.some((job) => job.key === furnaceKey)) this.resources.retain(lease)
      else this.resources.release(lease)
    }
    this.leases.clear()
  }

  releaseUnusedResources() {
    for (const [furnaceKey, lease] of this.leases) {
      if (this.active.some((job) => job.key === furnaceKey)) continue
      this.resources.release(lease)
      this.leases.delete(furnaceKey)
    }
  }

  async safeCheckpoint(phase) {
    this.persist()
    await this.checkpoint?.({
      skill: 'smelter',
      phase,
      scope: this.scope,
      furnaces: this.active.map((job) => ({ key: job.key, state: job.state || 'active' })),
    })
  }

  // Wait (bounded) for the server to reflect a furnace slot change instead of trusting one read.
  async confirmSlot(window, read, predicate, label) {
    for (let waited = 0; waited < SLOT_CONFIRM_MS; waited += SLOT_POLL_MS) {
      if (predicate(read())) return read()
      await this.pause(SLOT_POLL_MS)
    }
    throw new Error(`${label} was not confirmed by the furnace window.`)
  }

  // Colony RPC (hub position, craft-job queue). Credentials never leave storage.cjs.
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
    }, MONITOR_MS)
    const continuous = !command.item
    if (continuous) {
      this.deadline = Infinity
      this.task.deadlineAt = null
      this.task.continuous = true
    } else {
      this.deadline = this.started + ONE_OFF_BASE_MS + command.quantity * SMELT_MS
      this.task.deadlineAt = this.deadline
    }
    let produced = 0
    try {
      if (this.colony()) this.agent.colony.scope(this.agent)
      else
        this.agent.say(
          `${this.agent.username}: shared storage is not configured, so I only smelt what I carry.`,
        )
      while (true) {
        this.check()
        const result = await this.cycle(
          command,
          command.quantity ? command.quantity - produced : Infinity,
        )
        this.releaseUnusedResources()
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
          await this.safeCheckpoint('cycle-complete')
          continue
        }
        if (!result.worked) {
          this.plan.waitingUntil = Date.now() + IDLE_WAIT_MS
          this.progress(`${this.plan.decision} Checking again in ${IDLE_WAIT_MS / 1000} seconds.`)
          this.publish()
          await this.pause(IDLE_WAIT_MS)
          this.plan.waitingUntil = null
        }
        await this.safeCheckpoint('cycle-complete')
      }
      this.task.status = 'succeeded'
      this.plan.status = 'succeeded'
      this.decide(
        `Smelted ${produced} ${command.item} → ${outputOf(command.item)}; stored ${this.plan.stored}.`,
      )
      this.agent.say(`${this.agent.username}: ${this.plan.decision}`)
    } catch (error) {
      const reason = error.fatal ? error : this.controller.signal.reason || error
      this.task.status = ['CANCELLED', 'HANDOFF'].includes(reason.code) ? 'cancelled' : 'partial'
      this.task.reasonCode = reason.code || 'SMELTER_FAILED'
      this.plan.status = this.task.status
      this.plan.reasonCode = this.task.reasonCode
      this.addIssue(reason.message)
      this.agent.say(`${this.agent.username} smelter stopped: ${reason.message}`)
      if (reason.code === 'HANDOFF' || reason.fatal) throw reason
    } finally {
      clearInterval(monitor)
      this.releaseResources()
      if (this.agent.bot === this.bot && this.agent.nav === this.id) {
        this.bot.pathfinder.setGoal(null)
        this.bot.clearControlStates()
        if (this.agent.baseMovements) this.bot.pathfinder.setMovements(this.agent.baseMovements)
      }
      this.publish()
    }
  }

  // One pass: reclaim leftovers → choose batches → fuel → inputs → furnaces → load → wait/collect → store.
  async cycle(command, limit) {
    const result = { worked: false, produced: 0, outputs: {} }
    const addProduction = (collected) => {
      for (const [name, count] of Object.entries(collected.outputs)) {
        result.outputs[name] = (result.outputs[name] || 0) + count
      }
      result.produced += command.item ? collected.inputs[command.item] || 0 : collected.total
    }
    this.plan.waitingUntil = null
    if (this.colony() && !this.hub) this.hub = (await this.db('hub_get')).position || null
    if (this.active.length) {
      this.decide(`Reclaiming ${this.active.length} furnace job(s) left from the previous run.`)
      for (const job of this.active) {
        this.furnaces.set(job.key, {
          key: job.key,
          position: job.position,
          state: 'mine',
          checkedAt: 0,
        })
      }
      result.worked = true
      addProduction(await this.waitForFurnaces())
      await this.storeOutput()
      if (result.produced >= limit) return result
    }
    this.decide('Checking carried items and shared storage for smeltable stock.')
    const stock = this.colony()
      ? crafting.stocks(this, await storage.list(this))
      : { carry: this.carriedCounts(), shared: {} }
    let batches = chooseBatches(stock, {
      only: command.item || null,
      limit: limit - result.produced,
      registry: this.bot.registry,
    })
    if (!batches.length) {
      this.decide(
        command.item ? `No ${command.item} available to smelt.` : 'Nothing smeltable is available.',
      )
      return result
    }
    // Secure furnaces before any chest trip so inputs are never withdrawn with nowhere to put them.
    const furnaces = await this.acquireFurnaces(batches.length)
    if (!furnaces.length) return result
    batches = await this.arrangeFuel(batches.slice(0, furnaces.length), stock)
    if (!batches.length) return result
    batches = await this.gatherInputs(batches)
    if (!batches.length) return result
    if (this.bot.inventory.emptySlotCount() < MIN_FREE_SLOTS) {
      this.decide('Inventory is nearly full; storing surplus before smelting.')
      if (this.colony()) await storage.store(this)
      if (this.bot.inventory.emptySlotCount() < MIN_FREE_SLOTS)
        throw new Error('Inventory is full. Free space for furnace output.')
    }
    for (const [index, furnace] of furnaces.entries()) {
      const job = batches[index]
      if (!job) break
      try {
        await this.load(furnace, job)
      } catch (error) {
        if (interrupted(error)) throw error
        this.check()
        this.addIssue(`Load furnace at ${furnace.key}: ${error.message}`)
        furnace.state = 'occupied'
        furnace.checkedAt = Date.now()
      }
    }
    if (!this.active.length) return result
    result.worked = true
    addProduction(await this.waitForFurnaces())
    await this.storeOutput()
    return result
  }

  // Fuel: carried coal/charcoal first, then shared coal, then a charcoal bootstrap from logs.
  async arrangeFuel(batches, stock) {
    const total = batches.reduce((n, batch) => n + batch.count, 0)
    let carried = this.carriedCounts()
    const coal = (carried.coal || 0) + (carried.charcoal || 0)
    const needed = Math.ceil(total / FUEL.coal)
    if (coal < needed && this.colony()) {
      this.decide(`Retrieving fuel: need ${needed} coal or charcoal for ${total} smelts.`)
      await storage.retrieve(this, ['coal', 'charcoal'], needed)
      carried = this.carriedCounts()
    }
    const fuelStock = carriedFuelStock(carried)
    const covered = fuelPlan(total, fuelStock).covers
    if (covered <= 0) return this.bootstrapCharcoal(stock)

    // Assign fuel per batch; shrink the last batches when fuel covers only part of the total.
    const pool = { ...fuelStock }
    const assigned = []
    for (const batch of batches) {
      const plan = fuelPlan(batch.count, pool)
      if (plan.covers <= 0) break
      for (const fuel of plan.items) pool[fuel.name] -= fuel.count
      assigned.push({ ...batch, count: plan.covers, fuel: plan.items })
    }
    const assignedTotal = assigned.reduce((n, batch) => n + batch.count, 0)
    if (assignedTotal < total)
      this.addIssue(`Fuel covers ${assignedTotal} of ${total} planned smelts; the rest waits.`)
    return assigned
  }

  async bootstrapCharcoal(stock) {
    const carriedLogs = Object.entries({ ...stock.carry }).filter(([name]) => isLog(name))
    const sharedLogs = Object.entries(stock.shared || {}).filter(([name]) => isLog(name))
    const available = countEntries(carriedLogs) + Math.max(0, countEntries(sharedLogs) - LOG_FLOOR)
    const count = fitCharcoalBatch(available)
    if (count < 2) {
      this.decide('Waiting for fuel: no coal, charcoal or spare logs in storage or inventory.')
      return []
    }
    const species = [...carriedLogs, ...sharedLogs].sort((a, b) => b[1] - a[1])[0][0]
    this.decide(`No coal: making charcoal from ${count} ${species} first, burning logs as fuel.`)
    const total = charcoalLogsNeeded(count)
    if (this.count(species) < total && this.colony()) await storage.retrieve(this, [species], total)
    const have = this.count(species)
    const input = Math.min(count, fitCharcoalBatch(have))
    if (input < 2) {
      this.decide('Could not retrieve enough logs for a charcoal bootstrap.')
      return []
    }
    return [
      {
        input: species,
        output: 'charcoal',
        count: input,
        fuel: [{ name: species, count: Math.ceil(input / PLANKS_OR_LOG_SMELTS) }],
      },
    ]
  }

  // Withdraw from shared chests, then trust only the confirmed carried count.
  async gatherInputs(batches) {
    const wanted = {}
    for (const batch of batches) wanted[batch.input] = (wanted[batch.input] || 0) + batch.count
    for (const [name, count] of Object.entries(wanted)) {
      const before = this.count(name)
      if (before < count && this.colony()) {
        this.decide(`Retrieving ${count - before} ${name} from shared storage.`)
        await storage.retrieve(this, [name], count)
        const after = this.count(name)
        if (after < count)
          this.addIssue(`Retrieved ${after - before} ${name}; planned ${count - before}.`)
      }
    }
    const carried = this.carriedCounts()
    const usable = []
    for (const batch of batches) {
      // A charcoal bootstrap burns the same logs it smelts; keep that fuel share back.
      const fuelLogs = batch.fuel
        .filter((fuel) => fuel.name === batch.input)
        .reduce((n, fuel) => n + fuel.count, 0)
      const count = Math.min(batch.count, (carried[batch.input] || 0) - fuelLogs)
      if (count <= 0) continue
      carried[batch.input] -= count + fuelLogs
      usable.push({ ...batch, count })
    }
    if (!usable.length) this.decide('Planned inputs did not arrive in inventory; retrying later.')
    return usable
  }

  // Furnaces near the hub (else near Forge). Usable only if empty — or already ours.
  async acquireFurnaces(needed) {
    const center = this.hub ? vector(this.hub) : this.bot.entity.position
    const positions = this.bot.findBlocks({
      point: center,
      matching: this.bot.registry.blocksByName.furnace.id,
      maxDistance: this.hub ? HUB_SCAN : LOCAL_SCAN,
      count: 16,
    })
    for (const position of positions) {
      const furnaceKey = key(position)
      const known = this.furnaces.get(furnaceKey)
      if (!known) {
        this.furnaces.set(furnaceKey, {
          key: furnaceKey,
          position: { x: position.x, y: position.y, z: position.z },
          state: 'unknown',
          checkedAt: 0,
        })
      } else if (known.state === 'missing') {
        known.state = 'unknown'
      }
    }
    for (const furnace of this.furnaces.values()) {
      if (this.bot.blockAt(vector(furnace.position))?.name !== 'furnace') furnace.state = 'missing'
    }
    const usable = []
    const candidates = [...this.furnaces.values()]
      .filter((furnace) => furnace.state !== 'missing')
      .sort((a, b) => vector(a.position).distanceTo(center) - vector(b.position).distanceTo(center))
    for (const furnace of candidates) {
      if (usable.length >= Math.min(needed, MAX_FURNACES)) break
      this.check()
      if (this.active.some((job) => job.key === furnace.key)) continue
      const block = this.bot.blockAt(vector(furnace.position))
      // A lit furnace we did not load belongs to someone else; skip it without opening.
      if (block.getProperties().lit === true) {
        furnace.state = 'occupied'
        furnace.checkedAt = Date.now()
        continue
      }
      const recentlyOccupied =
        furnace.state === 'occupied' && Date.now() - furnace.checkedAt < OCCUPIED_SKIP_MS
      if (recentlyOccupied) continue
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
      else {
        this.resources.release(this.leases.get(furnace.key))
        this.leases.delete(furnace.key)
      }
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
    if (this.hub && vector(this.hub).distanceTo(this.bot.entity.position) > HUB_NEAR_BLOCKS) {
      await this.travel(
        new goals.GoalNear(this.hub.x, this.hub.y, this.hub.z, 3),
        'Walk to the storage hub',
      )
    }
    const hasFurnace = () =>
      this.bot.inventory.items().some((item) => item.name === 'furnace' && plain(item))
    if (!hasFurnace() && this.colony()) await storage.retrieve(this, ['furnace'], 1)
    if (!hasFurnace() && this.colony()) {
      const job = randomUUID()
      await this.db('enqueue', { job, item: 'furnace', quantity: 1 })
      const claimed = await this.db('claim_job', { job })
      if (!claimed) throw new Error('Furnace crafting job was claimed by another worker.')
      this.decide('Crafting a furnace from 8 cobblestone through the shared crafting queue.')
      try {
        await crafting.execute(this, claimed, { storeOutput: false })
      } catch (error) {
        if (error.fatal || error.code === 'CANCELLED') throw error
        this.check()
        this.addIssue(`Furnace craft: ${error.message}`)
      }
    }
    if (!hasFurnace()) {
      this.decide('Waiting for a furnace: none in storage and not enough cobblestone to craft one.')
      return null
    }
    if (this.hub && vector(this.hub).distanceTo(this.bot.entity.position) > HUB_NEAR_BLOCKS) {
      await this.travel(
        new goals.GoalNear(this.hub.x, this.hub.y, this.hub.z, 3),
        'Walk to the storage hub',
      )
    }
    const block = await placeFurnace(this, this.hub)
    const furnace = {
      key: key(block.position),
      position: { ...block.position },
      state: 'empty',
      checkedAt: Date.now(),
    }
    this.furnaces.set(furnace.key, furnace)
    this.counts.furnacesPlaced = (this.counts.furnacesPlaced || 0) + 1
    return furnace
  }

  // Open a furnace window with a time limit. A window that arrives after Stop is closed.
  async open(position) {
    this.own(position)
    const at = vector(position)
    if (this.bot.blockAt(at)?.name !== 'furnace') throw new Error('Furnace is missing or changed.')
    await storage.approach(this, at)
    this.check()
    let window = null
    const opening = this.bot.openFurnace(this.bot.blockAt(at))
    try {
      return await this.timed(
        async () => {
          const opened = await opening
          if (this.cancelled()) {
            safeClose(opened)
            this.check()
          }
          window = opened
          return opened
        },
        OPEN_WINDOW_MS,
        `Open furnace at ${key(at)}`,
      )
    } catch (error) {
      if (window) safeClose(window)
      throw error
    }
  }

  async load(furnace, job) {
    this.decide(`Loading ${job.count} ${job.input} into the furnace at ${furnace.key}.`)
    const inputItem = this.bot.inventory
      .items()
      .find((item) => item.name === job.input && plain(item))
    if (!inputItem) throw new Error(`No plain ${job.input} carried.`)
    const window = await this.open(furnace.position)
    let tracked
    try {
      if (!furnaceEmpty(window)) throw new Error('Furnace is occupied.')
      tracked = {
        ...job,
        fuel: job.fuel.map((entry) => ({ ...entry })),
        key: furnace.key,
        position: furnace.position,
        collected: 0,
        startedAt: Date.now(),
        lastOpenAt: Date.now(),
        state: 'loading',
        pending: null,
      }
      this.active.push(tracked)
      // Record ownership and transfer intent on disk before the first inventory packet.
      await this.mutate(window, tracked, 'putInput', job.input, job.count, () =>
        window.putInput(inputItem.type, null, job.count),
      )
      // One fuel slot. Extra fuel types stay carried until that slot empties.
      for (const fuel of job.fuel.slice(0, 1)) {
        const item = this.bot.inventory
          .items()
          .find((carried) => carried.name === fuel.name && plain(carried))
        if (!item) throw reconcileError(`No ${fuel.name} carried to finish the saved load.`)
        await this.mutate(window, tracked, 'putFuel', fuel.name, fuel.count, () =>
          window.putFuel(item.type, null, fuel.count),
        )
      }
      tracked.state = 'active'
      this.persist()
      furnace.state = 'mine'
    } finally {
      safeClose(window)
    }
    this.publish()
    await this.safeCheckpoint('loaded')
    await this.pause(100)
  }

  transferConfirmed(window, job, pending) {
    if (!furnaceMatches(window, job)) return false
    const intoFurnace = pending.kind.startsWith('put')
    const inventoryDelta = countIn(playerSlots(window), pending.name) - pending.beforeInventory
    const expectedDelta = intoFurnace ? -pending.count : pending.count
    if (inventoryDelta !== expectedDelta) return false
    if (pending.kind === 'putInput') return itemsInFurnace(window) === pending.count
    if (pending.kind === 'putFuel') {
      return (
        !!window.fuelItem() ||
        furnaceIsLit(this.bot.blockAt(vector(job.position))) ||
        !!window.outputItem()
      )
    }
    if (pending.kind === 'takeInput') return !window.inputItem()
    if (pending.kind === 'takeFuel') return !window.fuelItem()
    return itemsInFurnace(window) + job.collected + pending.count <= job.count
  }

  recordOutput(job, count) {
    this.plan.smelted[job.output] = (this.plan.smelted[job.output] || 0) + count
    this.counts.smelted = (this.counts.smelted || 0) + count
  }

  settleTransfer(job, nextState) {
    const pending = job.pending
    const collected = job.collected
    if (pending?.kind === 'takeOutput') job.collected += pending.count
    job.pending = null
    job.state = nextState
    try {
      this.persist()
    } catch (error) {
      job.pending = pending
      job.state = 'reconcile'
      job.collected = collected
      throw error
    }
    const taken = pending?.kind === 'takeOutput' ? pending.count : 0
    if (pending)
      this.recordEffect({
        kind: 'furnace_transfer',
        operationId: pending.id,
        action: pending.kind,
        item: pending.name,
        count: pending.count,
        furnace: { ...job.position },
      })
    if (taken) this.recordOutput(job, taken)
    return taken
  }

  async mutate(window, job, kind, name, count, action) {
    this.check()
    this.own(job.position)
    if (job.pending)
      throw reconcileError(`An earlier ${job.pending.kind} at ${job.key} is still uncertain.`)
    const mixedModified =
      kind.startsWith('put') &&
      playerSlots(window).some((item) => item.name === name && !plain(item))
    if (mixedModified)
      throw new Error(
        `Modified ${name} is mixed with the working stock; separate it before smelting.`,
      )
    const nextState = job.state === 'loading' ? 'loading' : 'active'
    job.pending = {
      id: randomUUID(),
      kind,
      name,
      count,
      beforeInventory: countIn(playerSlots(window), name),
    }
    job.state = 'reconcile'
    this.persist()
    await this.timed(action, TRANSFER_MS, `${kind} ${count} ${name}`)
    await this.confirmSlot(
      window,
      () => this.transferConfirmed(window, job, job.pending),
      (confirmed) => confirmed,
      `${kind} ${name}`,
    )
    return this.settleTransfer(job, nextState)
  }

  async reconcile(job) {
    const window = await this.open(job.position)
    try {
      const overfilled = itemsInFurnace(window) + job.collected > job.count
      if (!furnaceMatches(window, job) || overfilled) {
        throw reconcileError(
          `Furnace at ${job.key} has changed contents or another worker's items.`,
        )
      }
      if (job.pending) {
        if (this.transferConfirmed(window, job, job.pending)) {
          const taken = this.settleTransfer(job, 'active')
          return { taken, empty: furnaceEmpty(window) }
        }
        // A never-started input write is the only load intent safe to discard automatically.
        const neverStarted =
          job.pending.kind === 'putInput' &&
          furnaceEmpty(window) &&
          countIn(playerSlots(window), job.pending.name) === job.pending.beforeInventory
        if (neverStarted) return { taken: 0, empty: true }
        throw reconcileError(
          `Cannot confirm the saved ${job.pending.kind} at ${job.key}; it will not be replayed.`,
        )
      }
      job.state = 'active'
      this.persist()
      return { taken: 0, empty: furnaceEmpty(window) }
    } finally {
      safeClose(window)
    }
  }

  // Poll the block once a second; open the window only to collect or finish.
  async waitForFurnaces() {
    const produced = { total: 0, outputs: {}, inputs: {} }
    const add = (job, taken) => {
      if (!taken) return
      produced.total += taken
      produced.outputs[job.output] = (produced.outputs[job.output] || 0) + taken
      produced.inputs[job.input] = (produced.inputs[job.input] || 0) + taken
    }
    while (this.active.length) {
      this.check()
      await this.safeCheckpoint('waiting')
      for (const job of [...this.active]) {
        this.own(job.position)
        const block = this.bot.blockAt(vector(job.position))
        if (block?.name !== 'furnace') {
          job.state = 'reconcile'
          this.persist()
          throw reconcileError(
            `Furnace at ${job.key} disappeared with ${job.count - job.collected} ${job.input} unaccounted for.`,
          )
        }
        if (job.state === 'loading' || job.state === 'reconcile' || job.pending) {
          const recovery = await this.reconcile(job)
          add(job, recovery.taken)
          if (recovery.empty) {
            this.retire(job, 'empty')
            continue
          }
        }
        const now = Date.now()
        if (!shouldCollectNow(job, block, now)) continue
        try {
          const overdue = now - job.startedAt > job.count * SMELT_MS + OVERDUE_SLACK_MS
          const { taken, done } = await this.collect(job, overdue)
          add(job, taken)
          if (done) this.retire(job, 'empty')
          await this.safeCheckpoint('collected')
        } catch (error) {
          if (interrupted(error)) throw error
          this.check()
          this.addIssue(`Collect from ${job.key}: ${error.message}`)
          job.lastOpenAt = Date.now()
          if (job.pending || /another worker/.test(error.message)) {
            job.state = 'reconcile'
            this.persist()
            throw reconcileError(error.message)
          }
        }
      }
      const remaining = this.active.reduce((n, job) => n + job.count - job.collected, 0)
      if (this.active.length) {
        this.decide(`Smelting: ${remaining} items remaining in ${this.active.length} furnace(s).`)
        this.publish()
        await this.pause(WAIT_POLL_MS)
      }
    }
    return produced
  }

  retire(job, state) {
    const before = this.active
    this.active = this.active.filter((entry) => entry !== job)
    try {
      this.persist()
    } catch (error) {
      this.active = before
      throw error
    }
    const furnace = this.furnaces.get(job.key)
    if (furnace) furnace.state = state
    this.resources.release(this.leases.get(job.key))
    this.leases.delete(job.key)
    this.publish()
  }

  // Take confirmed output. When the input is gone (or the wait expired) reclaim leftovers too.
  async collect(job, final = false) {
    const window = await this.open(job.position)
    job.lastOpenAt = Date.now()
    let taken = 0
    try {
      if (job.pending)
        throw reconcileError(`Furnace at ${job.key} needs its saved transfer reconciled.`)
      const overfilled = itemsInFurnace(window) + job.collected > job.count
      if (!furnaceMatches(window, job) || overfilled) {
        throw reconcileError('Furnace contents changed; another worker is using it.')
      }
      const output = window.outputItem()
      if (output && output.name === job.output) {
        taken += await this.mutate(window, job, 'takeOutput', job.output, output.count, () =>
          window.takeOutput(),
        )
      }
      const input = window.inputItem()
      const fuel = window.fuelItem()
      const lit = furnaceIsLit(this.bot.blockAt(vector(job.position)))
      let done = !input || final
      if (!done && input && !fuel && !lit) {
        const spare = this.bot.inventory
          .items()
          .find((item) => fuelValue(item.name) && !isLog(item.name) && plain(item))
        if (spare) {
          const need = Math.min(spare.count, Math.ceil(input.count / fuelValue(spare.name)))
          job.fuel = [...job.fuel, { name: spare.name, count: need }]
          await this.mutate(window, job, 'putFuel', spare.name, need, () =>
            window.putFuel(spare.type, null, need),
          )
        } else {
          this.addIssue(
            `Furnace at ${job.key} ran out of fuel with ${input.count} ${job.input} left.`,
          )
          done = true
        }
      }
      if (done) {
        if (window.inputItem()) {
          await this.mutate(window, job, 'takeInput', job.input, window.inputItem().count, () =>
            window.takeInput(),
          )
        }
        if (window.fuelItem()) {
          await this.mutate(
            window,
            job,
            'takeFuel',
            window.fuelItem().name,
            window.fuelItem().count,
            () => window.takeFuel(),
          )
        }
        if (window.outputItem()) {
          taken += await this.mutate(
            window,
            job,
            'takeOutput',
            job.output,
            window.outputItem().count,
            () => window.takeOutput(),
          )
        }
        if (final && job.collected < job.count) {
          this.addIssue(
            `Furnace at ${job.key} finished only ${job.collected}/${job.count} ${job.input} within the limit.`,
          )
        }
      }
      return { taken, done }
    } finally {
      safeClose(window)
    }
  }

  // Deposit this cycle's output explicitly, then ordinary surplus, then the colony return trip.
  async storeOutput() {
    if (!this.colony()) {
      this.decide(
        `Smelted ${JSON.stringify(this.plan.smelted)}; shared storage is not configured, so I keep it.`,
      )
      return
    }
    for (const name of Object.keys(this.plan.smelted)) {
      const item = this.bot.inventory
        .items()
        .find((carried) => carried.name === name && plain(carried))
      if (!item) continue
      const have = this.count(name)
      this.decide(`Storing ${have} ${name} in shared storage.`)
      const stored = await storage.store(this, {
        fingerprint: describe(item).fingerprint,
        count: have,
      })
      this.plan.stored += stored
      if (stored < have)
        this.addIssue(
          `Stored ${stored}/${have} ${name}; the rest stays carried until a chest has space.`,
        )
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

// Place a carried furnace within 8 blocks of the hub, at least two blocks from any chest
// so chest faces stay free for access and Sam's wall signs. Stricter than crafting.place.
async function placeFurnace(work, hub) {
  const bot = work.bot
  const center = hub ? vector(hub) : bot.entity.position.floored()
  const blocked = new Set(['chest', 'trapped_chest', 'crafting_table', 'furnace'])
  const obstacles = bot.findBlocks({
    point: center,
    matching: (block) => blocked.has(block.name) || /sign$/.test(block.name),
    maxDistance: 12,
    count: 64,
  })
  const candidates = bot
    .findBlocks({
      point: center,
      matching: (block) => ['grass_block', 'dirt', 'stone', 'cobblestone'].includes(block.name),
      maxDistance: HUB_PLACE_RADIUS,
      count: 64,
    })
    .filter((support) => support.offset(0, 1, 0).distanceTo(center) <= HUB_PLACE_RADIUS)
    .sort((a, b) => a.distanceTo(center) - b.distanceTo(center))
  const canPlaceAt = (target) =>
    ['air', 'cave_air'].includes(bot.blockAt(target)?.name) &&
    ['air', 'cave_air'].includes(bot.blockAt(target.offset(0, 1, 0))?.name)
  let tried = 0
  for (const support of candidates) {
    const target = support.offset(0, 1, 0)
    if (
      !canPlaceAt(target) ||
      obstacles.some((obstacle) => obstacle.distanceTo(target) < CHEST_CLEARANCE)
    )
      continue
    if (tried++ >= PLACE_ATTEMPTS) break
    work.check()
    try {
      await work.approach(support)
    } catch (error) {
      if (error.fatal || error.code === 'CANCELLED') throw error
      continue
    }
    if (!canPlaceAt(target) || bot.entity.position.distanceTo(target.offset(0.5, 0, 0.5)) < 1.5)
      continue
    const item = bot.inventory
      .items()
      .find((carried) => carried.name === 'furnace' && plain(carried))
    if (!item) throw new Error('Need a plain furnace to place.')
    await work.equip(item)
    const range = bot.registry.blocksByName.furnace
    const watcher = watchBlock(
      bot,
      target,
      (id) => id >= range.minStateId && id <= range.maxStateId,
      work.controller?.signal,
    )
    try {
      await work.timed(
        async () => {
          await bot.placeBlock(bot.blockAt(support), new Vec3(0, 1, 0))
          await watcher.promise
        },
        PLACE_TIMEOUT_MS,
        `Place furnace at ${key(target)}`,
      )
      work.check()
      const placed = bot.blockAt(target)
      if (placed?.name !== 'furnace') throw new Error('Furnace placement was not confirmed.')
      return placed
    } finally {
      watcher.cleanup()
    }
  }
  throw new Error(
    'No clear spot within 8 blocks of the hub that keeps two blocks from every chest.',
  )
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
