/**
 * MOB KILLER: guards a post, hunts hostile mobs nearby with the best carried melee weapon,
 * retreats and eats when hurt, collects the drops, and stores batches in shared storage.
 *
 * Continuous cycle (see run()): assess health → pick the nearest eligible hostile → pursue
 * within a bounded radius → fight → collect drops → store a batch → supply checkpoint → idle
 * at the post. Every physical action is still bounded through Work's timed()/travel limits.
 *
 * Targets: only entity names in world.cjs HOSTILES. Players, villagers, golems, wolves, other
 * bots and every passive animal are never attacked. Creepers are never meleed: the bot keeps
 * at least CREEPER_DISTANCE blocks away and backs off toward the post when one approaches.
 */
const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const { Survival } = require('./survival.cjs')
const { Travel, TravelMovements } = require('./travel.cjs')
const { HOSTILES } = require('./world.cjs')
const storage = require('./storage.cjs')

const DEFAULT_RADIUS = 24
const MIN_RADIUS = 8
const MAX_RADIUS = 48
const PURSUIT_MARGIN = 8 // Chase up to radius + 8 blocks from the post, then give the target up.
const PURSUIT_MS = 8000 // One bounded chase attempt; the monitor re-evaluates twice a second.
const ATTACK_RANGE = 3.0 // Eye to the nearest point of the mob's hitbox (vanilla melee reach).
const HOLD_RANGE = 8 // Unreachable mobs this close usually come to us: hold ground before giving up.
const HOLD_MS = 6000
const ATTACK_COOLDOWN_MS = 600 // Vanilla sword cooldown is 0.625 s; faster swings deal reduced damage.
const HIT_BUDGET = 40 // Swings per target before it is cooled down as unkillable.
const ENGAGE_MS = 90000 // Total time per target, including chases.
const CREEPER_DISTANCE = 5
const RETREAT_HEALTH = 8
const RESUME_HEALTH = 12
const FATAL_HEALTH = 4
const FIST_HEALTH = 16 // Bare-handed fights are only allowed for slow melee mobs at high health.
const FIST_TARGETS = new Set(['zombie', 'husk', 'drowned', 'skeleton', 'stray', 'bogged'])
const TARGET_COOLDOWN_MS = 30000
const DEPOSIT_ITEMS = 16
const HUB_RANGE = 80
const IDLE_MS = 5000
const RETRY_MS = 3000
const SWORD_RETRIEVE_MS = 300000 // Ask shared storage for an iron sword at most every five minutes.
const TIERS = { netherite: 6, diamond: 5, iron: 4, stone: 3, golden: 2, wooden: 1 }
const WEAPON = /^(netherite|diamond|iron|stone|golden|wooden)_(sword|axe)$/
// Typical drops from HOSTILES; used for the deposit trigger and reporting. All are
// 'materials' or 'overflow' under storage-policy, so store() deposits every one of them.
const MOB_DROPS = new Set([
  'rotten_flesh', 'bone', 'arrow', 'string', 'gunpowder', 'spider_eye', 'slime_ball',
  'magma_cream', 'phantom_membrane', 'glass_bottle', 'redstone', 'glowstone_dust', 'sugar',
  'stick', 'ender_pearl', 'bow', 'iron_ingot', 'blaze_rod', 'ghast_tear', 'emerald',
  'saddle', 'crossbow', 'gold_ingot', 'gold_nugget', 'leather', 'porkchop', 'nautilus_shell',
  'trident', 'fishing_rod', 'copper_ingot', 'coal', 'tipped_arrow', 'spectral_arrow',
])
const finite = (p) => !!p && [p.x, p.y, p.z].every(Number.isFinite)
const round = (n) => Math.round(n * 10) / 10

function parseMobKiller(text) {
  const s = String(text || '').trim().toLowerCase().replace(/\s+/g, ' ').replace(/[.!?]+$/, '')
  const m = s.match(/^(?:start )?(?:hunt mobs|kill mobs|guard here|mob killer)(?: within (\d+)(?: blocks)?)?$/)
  if (!m) return null
  const radius = m[1] ? Number(m[1]) : DEFAULT_RADIUS
  if (!Number.isSafeInteger(radius) || radius < MIN_RADIUS || radius > MAX_RADIUS)
    throw new Error(`Hunt mobs within ${MIN_RADIUS}–${MAX_RADIUS} blocks, for example "hunt mobs within 16".`)
  return { type: 'mobKiller', radius }
}

// Best carried melee weapon: higher tier first, swords before axes, then least worn.
function chooseWeapon(bot) {
  const options = bot.inventory
    .items()
    .filter((item) => {
      const m = item.name.match(WEAPON)
      if (!m || !bot.registry.itemsByName[item.name]) return false
      const max = bot.registry.items[item.type]?.maxDurability
      return !(max && (item.durabilityUsed || 0) >= max - 1)
    })
    .map((item) => {
      const [, tier, kind] = item.name.match(WEAPON)
      return { item, tier: TIERS[tier], sword: kind === 'sword' }
    })
    .sort(
      (a, b) =>
        b.tier - a.tier ||
        Number(b.sword) - Number(a.sword) ||
        (a.item.durabilityUsed || 0) - (b.item.durabilityUsed || 0),
    )
  return options[0]?.item || null
}

class MobKiller extends Survival {
  constructor(agent, id) {
    // Survival's constructor publishes its own starter plan; this skill has its own state.
    const previous = agent.state.survival
    super(agent, id)
    agent.state.survival = previous
    this.deadline = Infinity
    this.task.deadlineAt = null
    this.task.continuous = true
    this.task.skill = 'MOB KILLER'
    this.origin = this.bot.entity.position.clone() // The guard post.
    this.radius = DEFAULT_RADIUS
    this.reserves = {} // Drops use the shared storage-policy defaults (no working stock kept).
    // A guard does not build. building-supplies.ensure() (run inside returnSupplies) honours this
    // re-entrancy flag, so Knight never digs up the ground around his post to refill 128 blocks.
    this.refillingBuilding = true
    this.cooldowns = new Map() // entity id → { until, hard }; hard ones also apply to mobs in reach
    this.dead = new Set() // entity ids the server reported dead while we fought them
    this.target = null
    this.armedFor = null
    this.swordAskedAt = 0
    this.nextStoreAt = 0
    this.plan = {
      status: 'running',
      decision: 'Looking for hostile mobs near the post.',
      post: { x: round(this.origin.x), y: round(this.origin.y), z: round(this.origin.z) },
      radius: this.radius,
      target: null,
      weapon: null,
      kills: {},
      killsTotal: 0,
      drops: 0,
      stored: 0,
      retreats: 0,
      waitingUntil: null,
    }
    agent.state.mobKiller = this.plan
  }
  // Shared helpers still mention the first bot in some messages; report this bot's own name.
  rename(text) {
    return String(text).replaceAll('Marc’s', `${this.agent.username}’s`).replaceAll('Marc', this.agent.username)
  }
  addIssue(text) {
    super.addIssue(this.rename(text))
  }
  // A nearby hostile is the job, not a reason to stop. Only genuinely fatal states pause the skill.
  safety() {
    const me = this.agent.username
    if (Number.isFinite(this.bot.health) && this.bot.health <= FATAL_HEALTH)
      return `Health is critically low (${this.bot.health}/20). Move ${me} to safety and provide food before restarting the mob killer.`
    if (this.bot.entity.isInLava) return `${me} is in lava. The mob killer needs help reaching safety.`
    if (Number.isFinite(this.bot.oxygenLevel) && this.bot.oxygenLevel < 8)
      return `Air is running low. Bring ${me} out of the water.`
    return null
  }
  check() {
    super.check()
    const danger = this.safety()
    if (danger) throw Object.assign(new Error(danger), { fatal: true })
  }
  publishPlan() {
    this.plan.radius = this.radius
    this.plan.weapon = this.bot.heldItem && WEAPON.test(this.bot.heldItem.name) ? this.bot.heldItem.name : null
    this.agent.publish()
  }
  // --- target selection -------------------------------------------------------------------
  fromPost(p) {
    return this.origin.distanceTo(p)
  }
  fromBot(p) {
    return this.bot.entity.position.distanceTo(p)
  }
  hostile(e) {
    return (
      !!e &&
      e !== this.bot.entity &&
      e.type !== 'player' &&
      !e.username &&
      e.isValid !== false &&
      HOSTILES.has(e.name) &&
      finite(e.position)
    )
  }
  // Everything the skill may attack: living hostiles other than creepers, inside the patrol radius.
  // A cooled-down mob that is already in melee reach is still attacked: never ignore what is biting us.
  eligible(e) {
    for (const [id, entry] of this.cooldowns)
      if (entry.until <= Date.now() || !this.bot.entities[id]) this.cooldowns.delete(id)
    if (!this.hostile(e) || e.name === 'creeper' || this.dead.has(e.id)) return false
    const cooldown = this.cooldowns.get(e.id)
    if (cooldown?.hard) return false
    if (this.inReach(e)) return true
    return !cooldown && this.fromPost(e.position) <= this.radius
  }
  // Hostiles (not creepers) currently in melee reach, nearest first: used for self-defence.
  threatsInReach() {
    return Object.values(this.bot.entities || {})
      .filter((e) => this.hostile(e) && e.name !== 'creeper' && !this.dead.has(e.id) && !this.cooldowns.get(e.id)?.hard && this.inReach(e))
      .sort((a, b) => this.fromBot(a.position) - this.fromBot(b.position))
  }
  candidates() {
    return Object.values(this.bot.entities || {})
      .filter((e) => this.eligible(e))
      .sort((a, b) => this.fromBot(a.position) - this.fromBot(b.position))
  }
  selectTarget() {
    return this.candidates()[0] || null
  }
  hostilesNearPost() {
    return Object.values(this.bot.entities || {}).some((e) => this.hostile(e) && this.fromPost(e.position) <= this.radius)
  }
  creeperNear(range = CREEPER_DISTANCE + 1) {
    return (
      Object.values(this.bot.entities || {}).find(
        (e) => this.hostile(e) && e.name === 'creeper' && this.fromBot(e.position) < range,
      ) || null
    )
  }
  // Soft cooldowns (no route, wandered off) still allow self-defence when the mob reaches us;
  // hard ones (hit budget exhausted, broken position) do not, so an unkillable mob is left alone.
  coolDown(entity, reason, hard = false) {
    this.cooldowns.set(entity.id, { until: Date.now() + TARGET_COOLDOWN_MS, hard })
    if (reason) this.decide(reason)
  }
  // --- weapons -----------------------------------------------------------------------------
  weapon() {
    return chooseWeapon(this.bot)
  }
  fistsAllowed(name) {
    return FIST_TARGETS.has(name) && this.bot.health >= FIST_HEALTH
  }
  async arm(target) {
    let weapon = this.weapon()
    if (!weapon && this.agent.colony?.enabled && Date.now() - this.swordAskedAt >= SWORD_RETRIEVE_MS) {
      this.swordAskedAt = Date.now()
      this.decide('No weapon carried; checking shared storage for an iron sword.')
      try {
        await storage.retrieve(this, ['iron_sword'], 1)
      } catch (error) {
        if (error.fatal || error.code === 'CANCELLED') throw error
        this.check()
        this.addIssue(`Could not fetch a sword from shared storage: ${error.message}`)
      }
      weapon = this.weapon()
    }
    if (weapon && (this.armedFor !== target.id || this.bot.heldItem?.slot !== weapon.slot)) {
      await this.equip(weapon)
      this.armedFor = target.id
    }
    return weapon
  }
  // --- combat ------------------------------------------------------------------------------
  eye() {
    return this.bot.entity.position.offset(0, this.bot.entity.height ?? 1.62, 0)
  }
  aimPoint(entity) {
    return entity.position.offset(0, (entity.height || 1.8) * 0.8, 0)
  }
  visible(entity) {
    if (typeof this.bot.world?.raycast !== 'function') return true
    const from = this.eye(),
      delta = this.aimPoint(entity).minus(from),
      distance = delta.norm()
    if (distance < 0.01) return true
    const hit = this.bot.world.raycast(from, delta.normalize(), distance)
    return !hit
  }
  // Distance from the eye to the closest point of the mob's bounding box, like vanilla reach.
  reachDistance(entity) {
    const eye = this.eye(),
      p = entity.position,
      half = (entity.width || 0.6) / 2,
      height = entity.height || 1.8
    const dx = Math.max(0, Math.abs(eye.x - p.x) - half),
      dz = Math.max(0, Math.abs(eye.z - p.z) - half),
      dy = Math.max(0, p.y - eye.y, eye.y - (p.y + height))
    return Math.hypot(dx, dy, dz)
  }
  inReach(entity) {
    return finite(entity?.position) && this.reachDistance(entity) <= ATTACK_RANGE && this.visible(entity)
  }
  beyondBound(entity) {
    return this.fromPost(entity.position) > this.radius + PURSUIT_MARGIN
  }
  // Short waits for library promises that normally settle instantly (turning). Bounded so a
  // missing response cannot stall the fight; check() afterwards still notices Stop.
  async briefly(promise, ms = 1500) {
    let timer
    try {
      await Promise.race([promise.catch(() => {}), new Promise((resolve) => { timer = setTimeout(resolve, ms) })])
    } finally {
      clearTimeout(timer)
    }
    this.check()
  }
  async strike(entity) {
    await this.briefly(this.bot.lookAt(this.aimPoint(entity), true))
    if (!this.bot.entities[entity.id]) return false
    this.bot.attack(entity)
    await this.pause(ATTACK_COOLDOWN_MS)
    return true
  }
  // One bounded chase. GoalFollow is dynamic, so the route updates as the mob moves. The monitor
  // clears the goal as soon as the target is in reach, invalid, out of bounds, or the fight must
  // stop for a creeper or low health. Uses Travel's optional mode deliberately: a single attempt,
  // no shore bridging toward a mob standing across water, and no bridge-block spending.
  async chase(entity, label) {
    // Range 3 makes normal arrival coincide with melee reach, so most chases end as successes
    // instead of monitor interruptions logged as failed actions.
    const goal = new goals.GoalFollow(entity, 3)
    let interrupted = false
    const monitor = setInterval(() => {
      if (this.cancelled()) return
      if (
        !this.bot.entities[entity.id] ||
        this.dead.has(entity.id) ||
        !finite(entity.position) ||
        this.inReach(entity) ||
        this.beyondBound(entity) ||
        this.creeperNear() ||
        this.bot.health <= RETREAT_HEALTH
      ) {
        interrupted = true
        this.bot.pathfinder.setGoal(null)
      }
    }, 500)
    try {
      await this.travelChase(goal, label, PURSUIT_MS)
      return true
    } catch (error) {
      if (error.fatal) throw error
      this.check()
      return interrupted
    } finally {
      clearInterval(monitor)
    }
  }
  travelChase(goal, label, limit) {
    return new Travel(this, limit, { optional: true }).go(goal, label)
  }
  async engage(target) {
    const id = target.id,
      name = target.name,
      me = this.agent.username
    this.target = target
    this.plan.target = { name, distance: round(this.fromBot(target.position)) }
    const weapon = await this.arm(target)
    if (!weapon && !this.fistsAllowed(name)) {
      this.coolDown(target, `No melee weapon carried; skipping ${name.replaceAll('_', ' ')} until ${me} has a sword${FIST_TARGETS.has(name) ? ' or full health' : ''}.`)
      this.target = null
      this.plan.target = null
      return false
    }
    if (!weapon) this.decide(`Fighting ${name.replaceAll('_', ' ')} bare-handed at health ${this.bot.health}/20; a sword would be safer.`)
    else this.decide(`Engaging ${name.replaceAll('_', ' ')} with ${weapon.name.replaceAll('_', ' ')}.`)
    let hits = 0,
      routeFailures = 0,
      holdUntil = null,
      last = target.position.clone()
    const started = Date.now()
    try {
      while (true) {
        this.check()
        const live = this.bot.entities[id]
        if (!live || live.isValid === false || this.dead.has(id)) {
          if (hits > 0) {
            await this.recordKill(name, last)
            return true
          }
          this.decide(`${name.replaceAll('_', ' ')} vanished before ${me} could reach it.`)
          return false
        }
        if (!finite(live.position)) {
          this.coolDown(live, `${name.replaceAll('_', ' ')} has no usable position; skipping it for 30 seconds.`, true)
          return false
        }
        last = live.position.clone()
        this.plan.target = { name, distance: round(this.fromBot(live.position)) }
        if (this.bot.health <= RETREAT_HEALTH) {
          await this.retreat(`while fighting ${name.replaceAll('_', ' ')}`)
          return false
        }
        const creeper = this.creeperNear()
        if (creeper) {
          await this.avoidCreeper(creeper)
          return false
        }
        if (this.beyondBound(live)) {
          this.coolDown(live, `${name.replaceAll('_', ' ')} moved beyond ${this.radius + PURSUIT_MARGIN} blocks from the post; returning.`)
          return false
        }
        if (hits >= HIT_BUDGET) {
          this.coolDown(live, null, true)
          this.addIssue(`${name} survived ${HIT_BUDGET} swings; leaving it alone for 30 seconds.`)
          return false
        }
        if (Date.now() - started > ENGAGE_MS) {
          this.coolDown(live, `Spent ${Math.round(ENGAGE_MS / 1000)} seconds on ${name.replaceAll('_', ' ')} without a kill; cooling it down.`)
          return false
        }
        if (this.inReach(live)) {
          holdUntil = null
          if (await this.strike(live)) hits++
          continue
        }
        if (holdUntil) {
          // Close but no route (water, ledge, fence): face it and let it come to us for a while.
          if (Date.now() < holdUntil && this.fromBot(live.position) <= HOLD_RANGE) {
            await this.briefly(this.bot.lookAt(this.aimPoint(live), true), 500)
            await this.pause(300)
            continue
          }
          this.coolDown(live, `No route to ${name.replaceAll('_', ' ')} and it did not come closer; skipping it for 30 seconds.`)
          return false
        }
        const followed = await this.chase(live, `Chase ${name} (${round(this.fromBot(live.position))} blocks away)`)
        // Arrived (or interrupted) but still not in reach: let physics and the mob move before re-planning.
        if (followed && this.bot.entities[id] && !this.inReach(this.bot.entities[id])) await this.pause(250)
        if (!followed && ++routeFailures >= 2) {
          if (this.fromBot(live.position) <= HOLD_RANGE) {
            holdUntil = Date.now() + HOLD_MS
            this.decide(`No route to ${name.replaceAll('_', ' ')} ${round(this.fromBot(live.position))} blocks away; holding ground for ${HOLD_MS / 1000} seconds.`)
            continue
          }
          this.coolDown(live, `No route to ${name.replaceAll('_', ' ')}; skipping it for 30 seconds.`)
          return false
        }
      }
    } finally {
      this.target = null
      this.plan.target = null
      this.publishPlan()
    }
  }
  async recordKill(name, position) {
    this.plan.kills[name] = (this.plan.kills[name] || 0) + 1
    this.plan.killsTotal++
    this.sync()
    this.decide(`Killed ${name.replaceAll('_', ' ')} · ${this.plan.killsTotal} total. Collecting drops.`)
    this.agent.log?.('mob.kill', `${this.agent.username} killed ${name} at ${position.floored()}.`, 'info', { taskId: this.id })
    // Drops appear a moment after the death packet; Work.pickup is bounded and cools down misses.
    const before = this.dropCount()
    await this.pause(400)
    await this.pickup(position)
    if (this.fromBot(position) > 1.5) await this.pickup(this.bot.entity.position)
    this.plan.drops += Math.max(0, this.dropCount() - before) // Mob drops only, not dirt or wheat.
    this.sync()
  }
  // --- danger handling ---------------------------------------------------------------------
  async returnToPost(limit = 20000, label = 'Return to the guard post') {
    if (this.fromBot(this.origin) <= 2) return
    const goal = new goals.GoalNear(this.origin.x, this.origin.y, this.origin.z, 2)
    await this.travel(goal, label, limit)
  }
  async retreat(reason) {
    this.plan.retreats++
    this.decide(`Health ${this.bot.health}/20: retreating toward the post ${reason}.`)
    try {
      await this.returnToPost(15000, 'Retreat toward the guard post')
    } catch (error) {
      if (error.fatal) throw error
      this.check()
      this.addIssue(`Retreat route incomplete: ${error.message}`)
    }
    await this.eat()
    const until = Date.now() + 120000
    while (this.bot.health < RESUME_HEALTH && Date.now() < until) {
      this.check()
      const creeper = this.creeperNear()
      if (creeper) await this.avoidCreeper(creeper)
      // Turning our back on a mob that is already hitting us is worse than fighting it off.
      const threat = this.threatsInReach()[0]
      if (threat) {
        this.decide(`Defending at health ${this.bot.health}/20: ${threat.name.replaceAll('_', ' ')} is in reach.`)
        await this.arm(threat)
        await this.strike(threat)
        continue
      }
      this.decide(`Recovering at the post: health ${this.bot.health}/20, resuming at ${RESUME_HEALTH}.`)
      this.plan.waitingUntil = Date.now() + 1000
      this.agent.publish()
      await this.pause(1000)
    }
    this.plan.waitingUntil = null
  }
  // Never melee a creeper: step away from it, preferring the post when that leads away from it.
  async avoidCreeper(creeper) {
    const me = this.bot.entity.position,
      away = me.minus(creeper.position)
    away.y = 0
    const direction = away.norm() > 0.01 ? away.normalize() : new Vec3(1, 0, 0)
    const postLeadsAway = this.fromBot(this.origin) > 1 && this.origin.distanceTo(creeper.position) > this.fromBot(creeper.position) + 2
    const point = postLeadsAway ? this.origin : me.plus(direction.scaled(CREEPER_DISTANCE + 3))
    this.decide(`Creeper ${round(this.fromBot(creeper.position))} blocks away: backing off without attacking.`)
    try {
      const goal = postLeadsAway
        ? new goals.GoalNear(point.x, point.y, point.z, 2)
        : new goals.GoalXZ(Math.floor(point.x), Math.floor(point.z))
      await this.travelChase(goal, 'Back away from a creeper', 6000)
    } catch (error) {
      if (error.fatal) throw error
      this.check()
    }
    await this.pause(1000)
  }
  // --- drops and storage -------------------------------------------------------------------
  dropCount() {
    return this.bot.inventory
      .items()
      .filter((i) => MOB_DROPS.has(i.name))
      .reduce((n, i) => n + i.count, 0)
  }
  needsDeposit() {
    return this.dropCount() >= DEPOSIT_ITEMS || this.bot.inventory.emptySlotCount() < 4
  }
  async storeBatch() {
    if (!this.needsDeposit() || Date.now() < this.nextStoreAt) return 0
    if (!this.agent.colony?.enabled) {
      if (!this.storageNoted) {
        this.storageNoted = true
        this.decide('Shared storage is not configured; keeping mob drops in the inventory.')
      }
      this.nextStoreAt = Date.now() + 60000
      return 0
    }
    try {
      const { position: hub } = await storage.call(this, 'hub_get')
      if (hub && this.origin.distanceTo(new Vec3(hub.x, hub.y, hub.z)) > HUB_RANGE) {
        this.decide(`Storage hub is ${Math.round(this.origin.distanceTo(new Vec3(hub.x, hub.y, hub.z)))} blocks from the post (limit ${HUB_RANGE}); keeping drops for now.`)
        this.nextStoreAt = Date.now() + 120000
        return 0
      }
      this.decide(`Carrying ${this.dropCount()} mob drops; storing a batch at the shared hub.`)
      const moved = await storage.store(this)
      this.plan.stored += moved
      this.sync()
      this.decide(moved ? `Stored ${moved} items in the shared hub · ${this.plan.stored} total.` : 'Storage accepted nothing new; continuing the patrol.')
      if (!moved) this.nextStoreAt = Date.now() + 60000
      return moved
    } catch (error) {
      if (error.fatal || error.code === 'CANCELLED') throw error
      this.check()
      this.nextStoreAt = Date.now() + 60000
      this.addIssue(`Storage trip deferred for one minute: ${error.message}`)
      return 0
    }
  }
  async idle() {
    if (this.fromBot(this.origin) > 4) {
      try {
        await this.returnToPost(20000)
      } catch (error) {
        if (error.fatal) throw error
        this.check()
        this.addIssue(`Could not walk back to the post: ${error.message}`)
      }
    }
    this.decide(`No hostile mobs within ${this.radius} blocks of the post · ${this.plan.killsTotal} kills. Watching.`)
    this.plan.waitingUntil = Date.now() + IDLE_MS
    this.agent.publish()
    try {
      await this.pause(IDLE_MS)
    } finally {
      this.plan.waitingUntil = null
    }
  }
  // --- main loop ---------------------------------------------------------------------------
  async run(command = {}) {
    if (Number.isSafeInteger(command.radius)) this.radius = command.radius
    this.plan.radius = this.radius
    const collect = (collector) => {
      if (collector?.id === this.bot.entity.id && !this.cancelled()) {
        this.counts.collectedStacks++
        this.sync()
      }
    }
    const gone = (entity) => {
      if (entity && this.target && entity.id === this.target.id) this.dead.add(entity.id)
    }
    const died = (entity) => {
      if (entity && entity.id !== this.bot.entity.id && HOSTILES.has(entity.name)) this.dead.add(entity.id)
    }
    this.bot.on('playerCollect', collect)
    this.bot.on('entityGone', gone)
    this.bot.on('entityDead', died)
    const guard = setInterval(() => {
      if (this.cancelled()) return
      const danger = this.safety()
      if (danger && !this.controller.signal.aborted)
        this.controller.abort(Object.assign(new Error(danger), { fatal: true }))
    }, 500)
    const before = this.bot.pathfinder.movements
    if (this.bot.pathfinder.setMovements) this.bot.pathfinder.setMovements(new TravelMovements(this.bot))
    try {
      this.decide(`Guarding the post within ${this.radius} blocks.`)
      while (true) {
        try {
          this.check()
          if (this.bot.health <= RETREAT_HEALTH) {
            await this.retreat('to recover')
            continue
          }
          await this.eat()
          const creeper = this.creeperNear()
          if (creeper) {
            await this.avoidCreeper(creeper)
            continue
          }
          const target = this.selectTarget()
          if (target) {
            await this.engage(target)
            await this.storeBatch()
            continue
          }
          await this.storeBatch()
          // Idle checkpoint only: supply trips never interrupt a fight or start while mobs lurk nearby.
          if (!this.hostilesNearPost()) await this.agent.coordination?.returnSupplies(this)
          await this.idle()
        } catch (error) {
          if (error.fatal || this.cancelled()) throw error
          this.addIssue(error.message)
          this.decide(`Mob killer waiting: ${error.message}`)
          this.plan.waitingUntil = Date.now() + RETRY_MS
          this.agent.publish()
          await this.pause(RETRY_MS)
          this.plan.waitingUntil = null
        }
      }
    } catch (error) {
      const reason = this.controller.signal.reason || error
      this.plan.status = reason.code === 'CANCELLED' ? 'cancelled' : 'paused'
      this.task.status = this.plan.status === 'cancelled' ? 'cancelled' : 'partial'
      this.plan.decision = `Mob killer ${this.plan.status}: ${reason.message}`
      this.task.label = this.plan.decision
      if (reason.code !== 'CANCELLED') this.addIssue(reason.message)
      this.agent.say(this.plan.decision)
    } finally {
      this.bot.off('playerCollect', collect)
      this.bot.off('entityGone', gone)
      this.bot.off('entityDead', died)
      clearInterval(guard)
      this.plan.waitingUntil = null
      this.plan.target = null
      if (this.agent.bot === this.bot && this.agent.nav === this.id) {
        this.bot.pathfinder.setGoal(null)
        this.bot.clearControlStates()
        const restore = this.agent.baseMovements || before
        if (restore && this.bot.pathfinder.setMovements) this.bot.pathfinder.setMovements(restore)
      }
      this.agent.publish()
    }
  }
}
module.exports = { MobKiller, parseMobKiller, chooseWeapon, MOB_DROPS, HOSTILES }
