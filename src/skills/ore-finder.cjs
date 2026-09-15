/**
 * ORE FINDER (Orin): scans loaded terrain for ore blocks, reports what it found (exposed versus
 * buried, per ore type), mines the exposed ores nearest-first with a suitable pickaxe, collects
 * the drops, and stores raw ore batches in shared storage. Buried ores are only REPORTED: this
 * version digs no blind tunnels, so a later pass picks up whatever mining has newly exposed.
 * Read run() for the loop, cycle() for one pass, and scan() for the classification.
 */

const { ResourceWork } = require('../capabilities/resources.cjs')
const { Work, chooseTool } = require('../runtime/work.cjs')
const { nearbyFirst } = require('../navigation/work-order.cjs')
const { isAir } = require('../world/observations.cjs')

const ORES = ['coal', 'iron', 'copper', 'gold', 'redstone', 'lapis', 'diamond', 'emerald']
const ALIASES = {
  lapis_lazuli: 'lapis',
  lapis_ore: 'lapis',
  copper_ore: 'copper',
  iron_ore: 'iron',
  coal_ore: 'coal',
  gold_ore: 'gold',
  redstone_ore: 'redstone',
  diamond_ore: 'diamond',
  emerald_ore: 'emerald',
}
// Both stone and deepslate variants share the ore name. Nether ores and ancient debris are out of scope.
const blocksFor = (ore) => [`${ore}_ore`, `deepslate_${ore}_ore`]
const oreOf = (name) =>
  ORES.find((ore) => name === `${ore}_ore` || name === `deepslate_${ore}_ore`) || null
// Items that ore blocks drop. Together with coal they form the "batch" that triggers a deposit.
const ORE_ITEMS = new Set([
  'raw_iron',
  'raw_copper',
  'raw_gold',
  'coal',
  'redstone',
  'lapis_lazuli',
  'diamond',
  'emerald',
])
// Pickaxe tiers that can be obtained through the shared resource progression or shared storage.
const PICKAXE_TIERS = ['wooden_pickaxe', 'stone_pickaxe', 'iron_pickaxe']
const FACES = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 0, 1],
  [0, 0, -1],
  [0, 1, 0],
  [0, -1, 0],
]
const BATCH = 32 // Raw ore + coal carried before a deposit trip; stack-sized, not per item.
const WAIT_MS = 20000 // Rescan interval while nothing exposed is mineable.
const TARGET_COOLDOWN_MS = 120000 // A failed ore may become reachable after nearby digging.
const TOOL_RETRY_MS = 60000 // Do not repeat a failed shared-storage/crafting tool trip every pass.
const DEPOSIT_RETRY_MS = 120000 // A full or missing hub chest is a blocker for a while, not forever.
const DEFAULT_RADIUS = 48
const key = (p) => `${p.x},${p.y},${p.z}`
const plainPos = (p) => ({ x: p.x, y: p.y, z: p.z })
const blocked = (message) => Object.assign(new Error(message), { code: 'BLOCKED' })

/** `find ores`, `find ores iron`, `find ores coal within 48`, `mine ores diamond` → command or null. */
function parseOreFinder(text) {
  const s = String(text || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.!?]+$/, '')
  const m = s.match(
    /^(?:find|mine|search for|locate) ores?(?: (?:for )?([a-z_, ]+?))?(?: within (\d+)(?: blocks)?)?$/,
  )
  if (!m) return null
  const radius = m[2] ? Number(m[2]) : DEFAULT_RADIUS
  if (!Number.isSafeInteger(radius) || radius < 8 || radius > 64)
    throw new Error('Search for ores within 8–64 blocks, for example "find ores iron within 48".')
  let ores = null
  if (m[1]) {
    ores = [
      ...new Set(
        m[1]
          .replace(/lapis lazuli/g, 'lapis')
          .split(/[, ]+|\band\b/)
          .map((w) => w.trim())
          .filter(Boolean)
          .map((w) => ALIASES[w] || w),
      ),
    ]
    const unknown = ores.filter((ore) => !ORES.includes(ore))
    if (unknown.length)
      throw new Error(
        `Unknown ore "${unknown[0]}". Choose from ${ORES.join(', ')} (for example "find ores coal iron").`,
      )
  }
  return { type: 'oreFinder', ores, radius }
}

class OreFinder extends ResourceWork {
  constructor(agent, id) {
    super(agent, id)
    this.deadline = Infinity
    this.task.deadlineAt = null
    this.task.continuous = true
    this.task.skill = 'ORE FINDER'
    this.origin ||= this.bot.entity.position.clone()
    this.ores = null
    this.radius = DEFAULT_RADIUS
    // Torches are the ore finder's working supply; surplus storage keeps them (Sam supplies 16).
    this.reserves = { torch: 16 }
    this.cooldowns = new Map() // failed target key → retry time
    this.nextToolAttemptAt = 0
    this.nextDepositAt = 0
    this.stalledPasses = 0
    this.plan = {
      status: 'running',
      decision: 'Scanning loaded terrain for ores.',
      ores: null,
      radius: this.radius,
      found: {},
      exposed: 0,
      buried: 0,
      mineable: 0,
      unsafe: 0,
      needsTool: 0,
      nearest: {},
      mined: {},
      stored: 0,
      failed: 0,
      tool: null,
      waitingUntil: null,
    }
    agent.state.oreFinder = this.plan
  }
  get name() {
    return this.agent.username || this.bot.username || 'this bot'
  }
  check() {
    super.check()
    const danger = this.safety()
    if (danger) throw Object.assign(new Error(danger), { fatal: true })
  }
  // Cancellation must interrupt a 20-second wait promptly, not only at its end.
  async pause(ms = 200) {
    for (let left = ms; left > 0; left -= 250)
      await Work.prototype.pause.call(this, Math.min(left, 250))
  }
  // Ore digging must never quarry farms or the hub: dirt/grass are only touched for the
  // shared building reserve, and never within a farm or beside a chest.
  safeTarget(block) {
    if (!super.safeTarget(block)) return false
    if (['dirt', 'grass_block'].includes(block.name)) {
      if (!isAir(this.bot.blockAt(block.position.offset(0, 1, 0)))) return false
      for (let x = -4; x <= 4; x++)
        for (let z = -4; z <= 4; z++)
          for (let y = -1; y <= 2; y++) {
            const near = this.bot.blockAt(block.position.offset(x, y, z))?.name
            if (
              near === 'farmland' ||
              near === 'chest' ||
              near === 'crafting_table' ||
              near === 'furnace'
            )
              return false
          }
    }
    return true
  }
  oreNames() {
    return (this.ores || ORES).flatMap(blocksFor)
  }
  exposed(block) {
    return FACES.some((d) => isAir(this.bot.blockAt(block.position.offset(...d))))
  }
  // A pickaxe in inventory that Minecraft accepts for this ore (tier, durability), or null.
  toolFor(block) {
    try {
      return chooseTool(this.bot, block, (item) => !!item && /_pickaxe$/.test(item.name))
    } catch (_) {
      return null
    }
  }
  canMine(block) {
    return !!this.toolFor(block)
  }
  // The lowest obtainable pickaxe tier that harvests every listed ore block.
  neededPickaxe(blocks) {
    return (
      PICKAXE_TIERS.find((name) => {
        const id = this.bot.registry.itemsByName[name]?.id
        return Number.isInteger(id) && blocks.every((b) => b.canHarvest(id))
      }) || 'iron_pickaxe'
    )
  }
  oreLoad() {
    return this.bot.inventory
      .items()
      .filter((i) => ORE_ITEMS.has(i.name))
      .reduce((n, i) => n + i.count, 0)
  }
  carriedPickaxe() {
    return (
      this.bot.inventory
        .items()
        .filter((i) => /_pickaxe$/.test(i.name))
        .map((i) => i.name)
        .sort((a, b) => PICKAXE_TIERS.indexOf(b) - PICKAXE_TIERS.indexOf(a))[0] || null
    )
  }
  releaseCooldowns() {
    const now = Date.now()
    for (const [id, until] of this.cooldowns)
      if (until <= now) {
        this.cooldowns.delete(id)
        this.failedTargets.delete(id)
      }
  }
  // Observe: every selected ore within the radius (and 80 blocks of the start), classified.
  scan() {
    this.check()
    this.releaseCooldowns()
    const matching = this.oreNames()
      .map((n) => this.bot.registry.blocksByName[n]?.id)
      .filter(Number.isInteger)
    const positions = matching.length
      ? this.bot
          .findBlocks({ matching, maxDistance: this.radius, count: 512 })
          .filter((p) => p.distanceTo(this.origin) <= 80)
      : []
    const found = {},
      nearest = {},
      exposedBlocks = []
    let exposed = 0,
      buried = 0
    const here = this.bot.entity.position
    for (const p of positions) {
      const block = this.bot.blockAt(p),
        ore = block && oreOf(block.name)
      if (!ore) continue
      found[ore] = (found[ore] || 0) + 1
      if (!this.exposed(block)) {
        buried++
        continue
      }
      exposed++
      exposedBlocks.push(block)
      if (!nearest[ore] || p.distanceTo(here) < nearest[ore].distance)
        nearest[ore] = { ...plainPos(p), distance: Math.round(p.distanceTo(here) * 10) / 10 }
    }
    const mineable = exposedBlocks.filter((b) => this.safeTarget(b))
    Object.assign(this.plan, {
      found,
      exposed,
      buried,
      nearest,
      mineable: mineable.length,
      unsafe: exposedBlocks.length - mineable.length,
      needsTool: mineable.filter((b) => !this.canMine(b)).length,
      tool: this.carriedPickaxe(),
      scannedAt: Date.now(),
    })
    this.agent.log?.(
      'ore.scan',
      `${exposed} exposed / ${buried} buried; nearest exposed: ${
        Object.entries(nearest)
          .map(([ore, p]) => `${ore} at ${p.x},${p.y},${p.z} (${p.distance} m)`)
          .join(', ') || 'none'
      }.`,
      'info',
      { taskId: this.id },
    )
    this.agent.publish()
    return mineable
  }
  summary() {
    const list =
      Object.entries(this.plan.found)
        .map(([ore, n]) => `${ore} ${n}`)
        .join(', ') || 'none'
    return `Ores within ${this.radius}: ${list} · ${this.plan.exposed} exposed (${this.plan.mineable} mineable), ${this.plan.buried} buried (reported only).`
  }
  // Obtain a pickaxe good enough for the exposed ores: shared storage first, then the
  // Shared resource crafting progression. Bounded to one attempt per minute.
  async ensureTool(targets) {
    const lacking = targets.filter((b) => !this.canMine(b))
    if (!lacking.length) return
    const needed = this.neededPickaxe(lacking)
    const names = [
      ...new Set(lacking.map((b) => b.name.replace(/^deepslate_/, '').replace(/_ore$/, ''))),
    ].join('/')
    if (Date.now() < this.nextToolAttemptAt) {
      this.addIssue(
        `Skipping ${lacking.length} ${names} ore(s): a ${needed.replace('_', ' ')} is needed and the last tool trip failed; retrying in a minute.`,
      )
      return
    }
    this.decide(
      `Need a ${needed.replace('_', ' ')} for ${lacking.length} exposed ${names} ore(s); checking shared storage and crafting.`,
    )
    try {
      if (needed === 'wooden_pickaxe') await this.wooden()
      else if (needed === 'stone_pickaxe') await this.stone()
      else {
        // Silk Touch is irrelevant here; any iron-or-better pickaxe from the shared stock is fine.
        if (this.agent.colony?.enabled)
          await require('../storage/service.cjs').retrieve(
            this,
            ['iron_pickaxe', 'diamond_pickaxe', 'netherite_pickaxe'],
            1,
          )
        if (!this.pick('iron')) {
          if (this.count('iron_ingot') < 3)
            throw blocked(
              `No iron pickaxe in shared storage and only ${this.count('iron_ingot')}/3 iron ingots to craft one.`,
            )
          await this.sticks(2)
          await this.craft('iron_pickaxe', await this.craftingTable())
        }
      }
      this.plan.tool = this.carriedPickaxe()
      if (lacking.some((b) => !this.canMine(b)))
        throw blocked(`Still no pickaxe that harvests ${names} ore.`)
    } catch (error) {
      if (error.fatal || error.code === 'HANDOFF' || error.code === 'CANCELLED') throw error
      this.check()
      this.nextToolAttemptAt = Date.now() + TOOL_RETRY_MS
      this.addIssue(
        `Skipping ${lacking.length} ${names} ore(s) that need a ${needed.replace('_', ' ')}: ${error.message}`,
      )
    }
  }
  shouldStore() {
    return (
      !!this.agent.colony?.enabled &&
      (this.oreLoad() >= BATCH || this.bot.inventory.emptySlotCount() < 4)
    )
  }
  // Deposit at a safe checkpoint (between digs). Only confirmed transfers count as stored.
  async deposit(reason) {
    if (Date.now() < this.nextDepositAt) return 0
    const load = this.oreLoad()
    this.decide(`Storing surplus (${load} raw ore/coal carried; ${reason}) in shared storage.`)
    try {
      const moved = await require('../storage/service.cjs').store(this)
      this.plan.stored += moved
      const left = this.oreLoad()
      if (left >= BATCH) {
        // A verified partial deposit is still progress, but the rest of the batch has nowhere to go.
        this.nextDepositAt = Date.now() + DEPOSIT_RETRY_MS
        this.addIssue(
          moved
            ? `Shared storage took ${moved} item(s) but ${left} raw ore/coal remain carried: the hub materials/overflow chests are full. Retrying in two minutes.`
            : 'Shared storage accepted no items: the hub needs a materials or overflow chest with free space within 80 blocks. Carrying the batch; retrying in two minutes.',
        )
      }
      this.agent.refresh()
      return moved
    } catch (error) {
      if (error.fatal || error.code === 'HANDOFF' || error.code === 'CANCELLED') throw error
      this.check()
      this.nextDepositAt = Date.now() + TOOL_RETRY_MS
      this.addIssue(`Deposit deferred for a minute: ${error.message}`)
      return 0
    }
  }
  // Mine the exposed, safe ores from the patch we are in outward. Newly exposed neighbours
  // are picked up by the next scan rather than followed blindly.
  async mineExposed(targets) {
    let mined = 0,
      skipped = 0,
      failed = 0
    for (const block of nearbyFirst(this, targets)) {
      this.check()
      const id = `${block.position}:${block.name}`
      if (this.failedTargets.has(id)) continue
      const live = this.bot.blockAt(block.position),
        ore = live && oreOf(live.name)
      if (!ore || !this.safeTarget(live)) continue
      if (!this.canMine(live)) {
        skipped++
        continue
      }
      if (this.shouldStore()) await this.deposit('batch ready or inventory nearly full')
      if (this.bot.inventory.emptySlotCount() < 2)
        throw blocked(
          this.agent.colony?.enabled
            ? 'Inventory is full and shared storage could not take the ore. Add hub capacity, then restart.'
            : `Inventory is full. Empty ${this.name}’s inventory before continuing (shared storage is not configured).`,
        )
      this.decide(
        `Mining ${live.name.replaceAll('_', ' ')} at ${key(live.position)} · ${this.counts.mined} ores mined, ${this.plan.stored} stored.`,
      )
      const issuesBefore = this.issues.length
      if (await this.harvest(live)) {
        mined++
        this.plan.mined[ore] = (this.plan.mined[ore] || 0) + 1
        this.agent.publish()
        this.checkpoint({ phase: 'ore-collected' })
      } else if (this.failedTargets.has(id)) {
        failed++
        this.cooldowns.set(id, Date.now() + TARGET_COOLDOWN_MS)
        // One unreachable cliff face is one failed route, not a fresh search for each ore in it.
        if (
          /route/i.test(this.issues.slice(issuesBefore - this.issues.length || undefined).join(' '))
        )
          for (const other of targets) {
            const otherId = `${other.position}:${other.name}`
            if (other.position.distanceTo(live.position) <= 3 && !this.failedTargets.has(otherId)) {
              this.failedTargets.add(otherId)
              this.cooldowns.set(otherId, Date.now() + TARGET_COOLDOWN_MS)
            }
          }
      }
    }
    this.plan.needsTool = skipped
    this.plan.failed = failed
    return mined
  }
  // One pass: observe → eat → tool → mine → store → shared supply checkpoint.
  async cycle() {
    this.check()
    await this.eat()
    const targets = this.scan()
    this.decide(this.summary())
    let mined = 0
    if (targets.length) {
      await this.ensureTool(targets)
      mined = await this.mineExposed(targets)
    }
    // Checkpoints run even when nothing was mineable: a carried batch still needs storing,
    // and a full pass with nothing to mine is the safest moment for the shared supply trip.
    if (this.shouldStore()) await this.deposit('end of pass')
    await this.agent.coordination?.returnSupplies(this)
    return mined
  }
  async run(command = {}) {
    this.ores =
      Array.isArray(command.ores) && command.ores.length
        ? command.ores.filter((o) => ORES.includes(o))
        : null
    this.radius = Math.min(64, Math.max(8, Number(command.radius) || DEFAULT_RADIUS))
    Object.assign(this.plan, { ores: this.ores, radius: this.radius })
    const collect = (collector) => {
      if (!this.cancelled() && collector.id === this.bot.entity.id) {
        this.counts.collectedStacks++
        this.sync()
      }
    }
    this.bot.on('playerCollect', collect)
    const guard = setInterval(() => {
      if (this.cancelled()) return
      const danger = this.safety()
      if (danger) this.controller.abort(Object.assign(new Error(danger), { fatal: true }))
    }, 500)
    try {
      while (true) {
        const before = this.counts.mined + this.plan.stored
        try {
          this.checkpoint({ phase: 'between-ore-passes' })
          const mined = await this.cycle()
          this.checkpoint({ phase: 'ore-pass-complete' })
          this.stalledPasses = 0
          if (!mined) {
            const reason = !this.plan.exposed
              ? this.plan.buried
                ? `${this.plan.buried} buried ore(s) reported; no exposed ore to mine yet.`
                : 'No ores in loaded terrain within range.'
              : !this.plan.mineable
                ? `${this.plan.exposed} exposed ore(s) are unsafe to mine (liquid, unloaded or falling blocks beside them).`
                : this.plan.needsTool
                  ? `${this.plan.needsTool} exposed ore(s) need a better pickaxe.`
                  : this.plan.failed
                    ? `${this.plan.failed} exposed ore(s) could not be reached or mined this pass (see issues); they are retried after a two-minute cooldown.`
                    : `${this.plan.mineable} exposed ore(s) are cooling down after earlier failures.`
            this.decide(`${this.summary()} ${reason} Rescanning in ${WAIT_MS / 1000} s.`)
            this.plan.waitingUntil = Date.now() + WAIT_MS
            this.agent.publish()
            try {
              await this.pause(WAIT_MS)
            } finally {
              this.plan.waitingUntil = null
            }
          } else await this.pause(500)
        } catch (error) {
          if (error.fatal || error.code === 'HANDOFF' || this.cancelled()) throw error
          const progressed = this.counts.mined + this.plan.stored > before
          this.stalledPasses = progressed ? 0 : this.stalledPasses + 1
          if (this.stalledPasses >= 3)
            throw new Error(
              `No progress after three passes. ${error.message} Fix the blocker, then restart the ore finder.`,
              { cause: error },
            )
          this.addIssue(error.message)
          this.decide(`Ore finder waiting: ${error.message}`)
          this.plan.waitingUntil = Date.now() + WAIT_MS
          this.agent.publish()
          try {
            await this.pause(WAIT_MS)
          } finally {
            this.plan.waitingUntil = null
          }
        }
      }
    } catch (error) {
      const reason = error.fatal ? error : this.controller.signal.reason || error
      if (reason.code === 'HANDOFF') this.task.reasonCode = 'HANDOFF'
      this.plan.status = ['CANCELLED', 'HANDOFF'].includes(reason.code) ? 'cancelled' : 'paused'
      this.task.status = this.plan.status === 'cancelled' ? 'cancelled' : 'partial'
      this.plan.decision = `Ore finder ${this.plan.status}: ${reason.message}`
      this.task.label = this.plan.decision
      this.addIssue(reason.message)
      this.agent.say(this.plan.decision)
      if (reason?.fatal && reason.code !== 'HANDOFF') this.failure = reason
    } finally {
      this.bot.off('playerCollect', collect)
      clearInterval(guard)
      this.plan.waitingUntil = null
      this.bot.deactivateItem?.()
      if (this.agent.bot === this.bot && this.agent.nav === this.id) {
        this.bot.pathfinder.setGoal(null)
        this.bot.stopDigging()
        this.bot.clearControlStates()
        if (this.agent.baseMovements) this.bot.pathfinder.setMovements(this.agent.baseMovements)
      }
      this.sync()
      this.agent.publish()
    }
  }
}
module.exports = { OreFinder, parseOreFinder, ORES, ORE_ITEMS, oreOf, BATCH }
