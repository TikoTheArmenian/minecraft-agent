/**
 * TREE FARMER skill.
 *
 * The farmer works one whole tree at a time:
 *   1. inspectTree() maps the connected trunk and branches before anything is cut.
 *   2. prepareTools()/prepareDirt() obtain supplies, using the first trunk for wood.
 *   3. harvestTree() removes logs bottom-up, building temporary dirt steps into the
 *      canopy when a log is out of reach.
 *   4. recoverScaffolds() takes those temporary steps back down.
 *   5. plantingStock()/replantRoots() collect drops and replant the original roots.
 *
 * Unfinished work is saved as a "tree job" (one active per world + dimension) so a reconnect
 * or a skill switch never leaves a half-cut tree or an unpaid replanting debt behind.
 * The natural-tree checks (rooted in soil, non-persistent leaves) stop the bot from
 * dismantling a wooden building that merely looks like a tree.
 */

const { loadJson, saveJson } = require('../infra/json-store.cjs')
const path = require('node:path')
const { Vec3 } = require('vec3')
const { ResourceWork } = require('../capabilities/resources.cjs')
const Move = require('mineflayer-pathfinder/lib/move')
const { Movements, goals } = require('mineflayer-pathfinder')
const { BlockApproachGoal, canView, workingCell } = require('../navigation/block-approach.cjs')
const { BUILDING_BLOCKS, Travel, TravelMovements } = require('../navigation/travel.cjs')
const { Work } = require('../runtime/work.cjs')
const { isAir } = require('../world/observations.cjs')
const { watchBlock } = require('../minecraft/block-updates.cjs')
const { placeBlockWithOptions } = require('../minecraft/actions.cjs')

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Tree species this skill knows how to harvest and replant. */
const SPECIES = ['oak', 'birch', 'spruce', 'jungle', 'acacia', 'dark_oak', 'cherry']

/** Blocks a log may stand on for the tree to count as "rooted" (and for a sapling to grow). */
const SOIL = new Set([
  'dirt',
  'grass_block',
  'podzol',
  'coarse_dirt',
  'rooted_dirt',
  'moss_block',
  'mycelium',
])

// Size limits for one connected tree. Anything larger is refused before a single
// log is removed, because it is far more likely to be a building than a tree.
const MAX_TREE_LOGS = 256
const MAX_TRUNK_SPREAD = 12 // horizontal blocks away from the starting log
const MAX_TREE_HEIGHT = 40 // vertical blocks away from the starting log
const MAX_SAVED_SCAFFOLDS = 1024

// Minecraft world bounds, used only to validate coordinates read from disk.
const WORLD_HORIZONTAL_LIMIT = 30000000
const WORLD_MIN_Y = -64
const WORLD_MAX_Y = 320

const EYE_HEIGHT = 1.62 // player eye offset above the feet
const BLOCK_REACH = 4.5 // how far from the eye a block face can be interacted with
const CANOPY_VIEW_REACH = 3.5 // stricter reach used when choosing a canopy stance
const CANOPY_WORK_RADIUS = 14 // how far from the tree temporary supports may be built

const MAX_CLIMB_STEPS = 40
const MAX_STAIR_STEPS = 16
const MAX_LEAF_CLEARANCE_ATTEMPTS = 24
const MAX_STALLED_PASSES = 3
const SUPPLY_RETRY_MS = 60000
const TOOL_TIERS = ['netherite', 'diamond', 'iron', 'stone', 'wooden', 'golden']

/** Saved "planted" entries are position keys in the form "x,y,z". */
const POSITION_KEY_PATTERN = /^-?\d+,-?\d+,-?\d+$/

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

/** Stable string key for a block position; used for sets and saved "planted" lists. */
const positionKey = (p) => `${p.x},${p.y},${p.z}`
const toVec3 = (p) => new Vec3(p.x, p.y, p.z)
const logName = (species) => `${species}_log`
const leavesName = (species) => `${species}_leaves`
const saplingName = (species) => `${species}_sapling`
const sameColumn = (a, b) => a.x === b.x && a.z === b.z
const blockCenter = (pos) => pos.offset(0.5, 0.5, 0.5)
const eyePosition = (bot) => bot.entity.position.offset(0, EYE_HEIGHT, 0)

/**
 * True for leaves that grew naturally. Player-placed leaves carry the `persistent`
 * flag and are never treated as part of a tree.
 */
function isNaturalLeaf(block, species) {
  return block?.name === leavesName(species) && block.getProperties?.().persistent !== true
}

/** The 26 positions touching `pos`, including diagonals, in a fixed order. */
function* surroundingPositions(pos) {
  for (let dx = -1; dx <= 1; dx++)
    for (let dy = -1; dy <= 1; dy++)
      for (let dz = -1; dz <= 1; dz++) {
        if (!dx && !dy && !dz) continue
        yield pos.offset(dx, dy, dz)
      }
}

/** True when an entity's collision box overlaps the block cell at `cell`. Dropped items are ignored. */
function entityOverlapsCell(entity, cell) {
  if (!entity.position || entity.name === 'item') return false
  const p = entity.position
  const halfWidth = (entity.width || 0.6) / 2
  const height = entity.height || 1.8
  return (
    p.x + halfWidth > cell.x &&
    p.x - halfWidth < cell.x + 1 &&
    p.z + halfWidth > cell.z &&
    p.z - halfWidth < cell.z + 1 &&
    p.y + height > cell.y &&
    p.y < cell.y + 1
  )
}

/** True when the bot itself or any other entity is standing inside the block cell. */
function anyEntityInCell(bot, cell) {
  const entities = [bot.entity, ...Object.values(bot.entities || {})]
  return entities.some((entity) => entityOverlapsCell(entity, cell))
}

/** The world cell a pathfinder placement step (`{x, y, z, dx, dy, dz}`) would fill. */
const placementTarget = (step) => new Vec3(step.x + step.dx, step.y + step.dy, step.z + step.dz)

/** Watch `pos` until the server confirms it holds any state of `blockType`. */
function watchForBlockType(bot, pos, blockType, signal) {
  const matches = (stateId) => stateId >= blockType.minStateId && stateId <= blockType.maxStateId
  return watchBlock(bot, pos, matches, signal)
}

/** Building material for canopy steps: dirt first, then any other building block. */
function pickCanopyMaterial(bot) {
  return bot.inventory
    .items()
    .filter((item) => BUILDING_BLOCKS.includes(item.name) && item.count > 0)
    .sort((a, b) => Number(b.name === 'dirt') - Number(a.name === 'dirt'))[0]
}

// ---------------------------------------------------------------------------
// Saved job validation (tree-jobs.json)
// ---------------------------------------------------------------------------

/** A saved coordinate must be an integer triple inside the world limits. */
function isSavedPoint(p) {
  return (
    !!p &&
    [p.x, p.y, p.z].every(Number.isSafeInteger) &&
    Math.abs(p.x) <= WORLD_HORIZONTAL_LIMIT &&
    Math.abs(p.z) <= WORLD_HORIZONTAL_LIMIT &&
    p.y >= WORLD_MIN_Y &&
    p.y <= WORLD_MAX_Y
  )
}

/** Shape check for one saved tree job. Checks are ordered so later ones can rely on earlier ones. */
function isSavedTreeJob(job) {
  if (!job || !SPECIES.includes(job.species)) return false

  const logsValid =
    Array.isArray(job.logs) &&
    job.logs.length > 0 &&
    job.logs.length <= MAX_TREE_LOGS &&
    job.logs.every(isSavedPoint)
  if (!logsValid) return false

  const rootsValid =
    Array.isArray(job.roots) &&
    job.roots.length > 0 &&
    job.roots.length <= job.logs.length &&
    job.roots.every(isSavedPoint)
  if (!rootsValid) return false

  const plantedValid =
    Array.isArray(job.planted) &&
    job.planted.length <= job.roots.length &&
    job.planted.every((entry) => typeof entry === 'string' && POSITION_KEY_PATTERN.test(entry))
  if (!plantedValid) return false

  const removedValid =
    Number.isSafeInteger(job.removed) && job.removed >= 0 && job.removed <= job.logs.length
  if (!removedValid) return false

  const scaffoldsValid =
    job.scaffolds === undefined ||
    (Array.isArray(job.scaffolds) &&
      job.scaffolds.length <= MAX_SAVED_SCAFFOLDS &&
      job.scaffolds.every((entry) => isSavedPoint(entry) && BUILDING_BLOCKS.includes(entry.name)))
  return scaffoldsValid
}

/** Active jobs use "world:dimension"; deferred planting jobs append ":replant:x,y,z". */
function isSavedTreeJobs(jobs) {
  if (!jobs || typeof jobs !== 'object' || Array.isArray(jobs)) return false
  return Object.values(jobs).every(isSavedTreeJob)
}

// ---------------------------------------------------------------------------
// Tree inspection
// ---------------------------------------------------------------------------

/** Dark oak only grows from a 2 × 2 sapling square, so its roots must contain one. */
function hasDarkOakFootprint(roots) {
  const isRoot = (q) => roots.some((r) => r.equals(q))
  return roots.some((p) => [p.offset(1, 0, 0), p.offset(0, 0, 1), p.offset(1, 0, 1)].every(isRoot))
}

/**
 * Map a whole tree BEFORE touching it.
 *
 * Flood-fills from `startLog` through every touching log of the same species
 * (diagonals included, so branches are captured). Returns a fresh job:
 * `{ species, logs, roots, planted: [], removed: 0 }`.
 *
 * Throws instead of guessing when the tree is unloaded, oversized, unrooted, or has
 * no natural leaf canopy. Refusing is better than silently calling a tree complete.
 */
function inspectTree(bot, startLog) {
  const species = SPECIES.find((s) => startLog.name === logName(s))
  if (!species) throw new Error('Unsupported tree species.')

  const origin = startLog.position
  const queue = [origin]
  const seen = new Set()
  const logs = []
  const roots = []
  let sawNaturalLeaves = false

  while (queue.length) {
    const pos = queue.pop()
    const id = positionKey(pos)
    if (seen.has(id)) continue
    seen.add(id)

    const block = bot.blockAt(pos)
    if (!block) throw new Error('Tree reaches unloaded terrain. Move closer and retry.')
    if (block.name !== logName(species)) continue

    const tooManyLogs = logs.length >= MAX_TREE_LOGS
    const tooWide =
      Math.abs(pos.x - origin.x) > MAX_TRUNK_SPREAD || Math.abs(pos.z - origin.z) > MAX_TRUNK_SPREAD
    const tooTall = Math.abs(pos.y - origin.y) > MAX_TREE_HEIGHT
    if (tooManyLogs || tooWide || tooTall)
      throw new Error('Connected tree exceeds the supported size; no logs removed.')

    logs.push(pos.clone())
    if (SOIL.has(bot.blockAt(pos.offset(0, -1, 0))?.name)) roots.push(pos.clone())

    for (const neighborPos of surroundingPositions(pos)) {
      const neighbor = bot.blockAt(neighborPos)
      if (!neighbor) throw new Error('Tree canopy is not fully loaded.')
      if (isNaturalLeaf(neighbor, species)) sawNaturalLeaves = true
      if (neighbor.name === logName(species)) queue.push(neighborPos)
    }
  }

  if (!roots.length || !sawNaturalLeaves)
    throw new Error('Need a rooted tree with a natural leaf canopy.')
  if (species === 'dark_oak' && !hasDarkOakFootprint(roots))
    throw new Error('Dark oak needs a complete 2 × 2 planting footprint.')

  return { species, logs, roots, planted: [], removed: 0 }
}

// ---------------------------------------------------------------------------
// Pathfinder goal
// ---------------------------------------------------------------------------

/**
 * Pathfinder goal: stand on solid footing from which the target block is visible and
 * within reach. Natural leaves of the tree's species are see-through for this check;
 * anything else solid blocks the line of sight.
 */
class CanopyGoal extends goals.Goal {
  constructor(bot, pos, species) {
    super()
    this.bot = bot
    this.pos = pos
    this.species = species
  }

  heuristic(node) {
    return Math.max(0, node.distanceTo(this.pos) - 2)
  }

  isEnd(node) {
    // Standing directly on top of the target would mean digging out our own footing.
    const standingOnTarget = sameColumn(node, this.pos) && node.y === this.pos.y + 1
    if (standingOnTarget) return false

    // The node needs solid support: existing terrain or a block the planner intends to place.
    const support = node.offset(0, -1, 0)
    const supportPlanned = node.toPlace?.some((p) => placementTarget(p).equals(support))
    if (!supportPlanned && this.bot.blockAt(support)?.boundingBox !== 'block') return false

    const eye = node.offset(0.5, EYE_HEIGHT, 0.5)
    const toTarget = blockCenter(this.pos).minus(eye)
    const distance = toTarget.norm()
    if (distance > CANOPY_VIEW_REACH) return false

    if (!this.bot.world?.raycast) return canView(this.bot, this.pos)
    const blocksSight = (block, iter) =>
      block.position.equals(this.pos) ||
      (!isNaturalLeaf(block, this.species) && !!iter.intersect(block.shapes, block.position))
    const hit = this.bot.world.raycast(eye, toTarget.normalize(), distance + 0.01, blocksSight)
    return !!hit?.position.equals(this.pos)
  }
}

// ---------------------------------------------------------------------------
// The skill
// ---------------------------------------------------------------------------

class TreeFarm extends ResourceWork {
  constructor(agent, id) {
    super(agent, id)
    // Tree farming never times out on its own; it keeps finding trees until stopped.
    this.deadline = Infinity
    this.task.deadlineAt = null
    this.task.continuous = true
    this.task.skill = 'TREE FARMER'

    /** Live status shared with the dashboard through agent.state.treeFarm. */
    this.plan = {
      status: 'running',
      decision: 'Looking for trees.',
      trees: 0,
      logs: 0,
      planted: 0,
      remaining: 0,
      waitingUntil: null,
    }
    agent.state.treeFarm = this.plan

    // One saved job per world + dimension, shared by every TreeFarm on this agent.
    this.jobKey = `${agent.state.world}:${agent.state.dimension}`
    agent.treeJobs ||= new Map()
    this.jobFile = agent.dataDir && path.join(agent.dataDir, 'tree-jobs.json')
    if (this.jobFile && !agent.treeJobs.size) this.loadSavedJobs()

    this.job = agent.treeJobs.get(this.jobKey) || null
    if (this.job) {
      this.plan.logs = this.job.removed || 0
      this.plan.planted = this.job.planted.length
      this.plan.remaining = this.job.logs.length - this.plan.logs
    }
    this.replantRetries = new Map()
    this.supplyRetries = new Map()
    this.updateReplantCount()
  }

  /** Read tree-jobs.json into agent.treeJobs, turning plain coordinates back into Vec3s. */
  loadSavedJobs() {
    const saved =
      loadJson(this.jobFile, { validate: isSavedTreeJobs, allowLegacy: true }).data || {}
    for (const [scope, job] of Object.entries(saved))
      this.agent.treeJobs.set(scope, {
        ...job,
        logs: job.logs.map(toVec3),
        roots: job.roots.map(toVec3),
      })
  }

  /** Persist unfinished tree work so reconnecting does not lose the replanting obligation. */
  saveJob() {
    this.updateReplantCount()
    if (!this.jobFile) return
    saveJson(this.jobFile, Object.fromEntries(this.agent.treeJobs), { validate: isSavedTreeJobs })
  }

  pendingReplants() {
    return [...this.agent.treeJobs].filter(([key]) => key.startsWith(`${this.jobKey}:replant:`))
  }

  updateReplantCount() {
    this.plan.pendingReplants = this.pendingReplants().reduce(
      (n, [, job]) => n + job.roots.length - job.planted.length,
      0,
    )
    this.reserves = {}
    for (const [key, job] of this.agent.treeJobs) {
      if (key !== this.jobKey && !key.startsWith(`${this.jobKey}:replant:`)) continue
      const name = saplingName(job.species)
      this.reserves[name] = (this.reserves[name] || 0) + job.roots.length - job.planted.length
    }
  }

  // -------------------------------------------------------------------------
  // Safety and stance
  // -------------------------------------------------------------------------

  check() {
    super.check()
    this.requestAir()
    if (this.needsAir && !this.recoveringAir)
      throw Object.assign(new Error('Surfacing to restore air.'), { code: 'AIR_RECOVERY' })
    const danger = this.safety()
    if (danger) throw Object.assign(new Error(danger), { fatal: true })
  }

  /**
   * Can the bot work on the block at `pos` from where it stands right now?
   * Live reach must use the actual eye position, not the center of its cell: on
   * narrow canopy stairs those two sight lines can lie on opposite sides of leaves.
   */
  canWork(pos) {
    const feet = workingCell(this.bot)
    const block = this.bot.blockAt(pos)
    if (this.bot.entity.isInWater) return false
    if (this.bot.blockAt(feet.offset(0, -1, 0))?.boundingBox !== 'block') return false
    const standingOnTarget = sameColumn(feet, pos) && feet.y === pos.y + 1
    if (standingOnTarget) return false
    if (!canView(this.bot, pos)) return false
    if (!block) return false
    return block.name === 'farmland' || this.bot.canDigBlock(block)
  }

  /**
   * Walk to a dry stance with a clear view of `pos`. Each failed stance is excluded
   * from the next attempt so the pathfinder cannot hand us the same cell again.
   */
  async approach(pos, options = {}) {
    // Interaction approaches (chests, tables) use the generic Work routine unchanged.
    if (options.interaction) return Work.prototype.approach.call(this, pos, options)

    const rejectedCells = new Set()
    for (let attempt = 0; attempt < 3; attempt++) {
      this.check()
      if (this.canWork(pos)) return
      const surfaceViewIsEnough =
        options.allowSurface &&
        canView(this.bot, pos) &&
        this.bot.canDigBlock(this.bot.blockAt(pos))
      if (surfaceViewIsEnough) return

      rejectedCells.add(positionKey(this.bot.entity.position.floored()))
      rejectedCells.add(positionKey(workingCell(this.bot)))

      const goal = new BlockApproachGoal(this.bot, pos, options)
      const baseIsEnd = goal.isEnd.bind(goal)
      goal.isEnd = (node) => {
        if (rejectedCells.has(positionKey(node)) || !baseIsEnd(node)) return false
        if (options.allowSurface) return true
        const wet = [node, node.offset(0, 1, 0)].some((p) => this.bot.blockAt(p)?.name === 'water')
        return !wet
      }

      // Natural leaves may be cleared on the way; nothing else may be broken.
      const previousMovements = this.bot.pathfinder.movements
      const movements = new TravelMovements(this.bot)
      movements.canDig = true
      movements.exclusionAreasBreak.push((block) =>
        isNaturalLeaf(block, this.job?.species) ? 0 : 100,
      )
      try {
        this.bot.pathfinder.setMovements(movements)
        await this.travel(goal, 'Move to a dry, clear view of the tree work area')
      } finally {
        if (this.agent.bot === this.bot) this.bot.pathfinder.setMovements(previousMovements)
      }
    }
    if (!this.canWork(pos))
      throw new Error('No clear working stance after three distinct approaches.')
  }

  /** Place an item on `support`, first stepping back if we are standing where it would go. */
  async placeItem(name, support) {
    if (
      name === 'crafting_table' &&
      [this.job, ...this.pendingReplants().map(([, job]) => job)]
        .filter(Boolean)
        .some((job) => job.roots.some((p) => p.equals(support.position.offset(0, 1, 0))))
    )
      throw new Error('Keep the tree planting spot clear of the crafting table.')
    const plantedCenter = support.position.offset(0, 1, 0).offset(0.5, 0, 0.5)
    const standingTooClose = this.bot.entity.position.distanceTo(plantedCenter) < 1.8
    if (standingTooClose) {
      const goal = new BlockApproachGoal(this.bot, support.position)
      const baseIsEnd = goal.isEnd.bind(goal)
      goal.isEnd = (node) =>
        baseIsEnd(node) && node.offset(0.5, 0, 0.5).distanceTo(plantedCenter) >= 2
      await this.travel(goal, 'Step back onto stable ground to replant the tree')
    }
    return super.placeItem(name, support)
  }

  /** Low air is handled by requestAir()/recoverAir() rather than treated as a fatal danger. */
  safety() {
    const danger = super.safety()
    return danger?.startsWith('Air is running low') ? null : danger || null
  }

  /** When submerged and short on air, drop everything and start swimming up. */
  requestAir() {
    const alreadyHandling = this.recoveringAir || this.needsAir
    const airIsFine = !Number.isFinite(this.bot.oxygenLevel) || this.bot.oxygenLevel >= 12
    if (alreadyHandling || !this.bot.entity.isInWater || airIsFine) return
    this.needsAir = true
    this.bot.pathfinder.setGoal(null)
    this.bot.stopDigging()
    this.bot.clearControlStates()
    this.bot.setControlState('jump', true)
  }

  /** Pause in short slices so air and danger checks keep running during long waits. */
  async pause(ms = 200) {
    for (let left = ms; left > 0; left -= 250)
      await Work.prototype.pause.call(this, Math.min(left, 250))
  }

  async recoverAir() {
    this.recoveringAir = true
    this.plan.waitingUntil = null
    try {
      const who = this.agent.username || this.bot.username || 'This bot'
      this.decide(`${who} is surfacing to restore air before resuming the saved tree.`)
      const travel = new Travel(this, 15000)
      await travel.surface()
      const giveUpAt = Date.now() + 10000
      while (this.bot.oxygenLevel < 18 && Date.now() < giveUpAt) await travel.tick()
      if (this.bot.oxygenLevel < 18)
        throw new Error('Could not restore air at the surface. Saved tree retained.')
      this.needsAir = false
      travel.activity.status = 'succeeded'
    } finally {
      this.recoveringAir = false
    }
  }

  /** Get out of the water onto the nearest solid block with two air blocks above it. */
  async leaveWater() {
    if (!this.bot.entity.isInWater) return
    this.decide('Returning to dry land before recovering tree supports.')
    await new Travel(this, 15000).surface()

    const hasHeadroom = (p) =>
      isAir(this.bot.blockAt(p.offset(0, 1, 0))) && isAir(this.bot.blockAt(p.offset(0, 2, 0)))
    const landings = this.bot
      .findBlocks({
        matching: (b) => b.boundingBox === 'block' && !/magma|cactus|fire/.test(b.name),
        maxDistance: 32,
        count: 64,
        useExtraInfo: (b) => hasHeadroom(b.position),
      })
      .filter(hasHeadroom)
    if (!landings.length) throw new Error('No loaded dry landing nearby; tree supports retained.')

    const anyLanding = new goals.GoalCompositeAny(
      landings.map((p) => new goals.GoalBlock(p.x, p.y + 1, p.z)),
    )
    await this.travel(anyLanding, 'Reach dry land before recovering supports')
    if (this.bot.entity.isInWater)
      throw new Error('Dry landing was not reached; tree supports retained.')
  }

  /** Wait until the bot is on the ground and no longer sliding. */
  async settleStance() {
    if (this.bot.entity.isInWater) {
      this.bot.setControlState('jump', true)
      throw new Error('Need dry footing before settling the canopy stance.')
    }
    this.bot.pathfinder.setGoal(null)
    this.bot.clearControlStates()
    for (let attempt = 0; attempt < 20; attempt++) {
      this.check()
      const velocity = this.bot.entity.velocity
      const stationary = !velocity || Math.hypot(velocity.x, velocity.z) < 0.025
      if (this.bot.entity.onGround !== false && stationary) return
      await this.pause(50)
    }
    throw new Error('Waiting for a stable canopy stance before working.')
  }

  /** Resolve once `predicate` holds on a physics tick; re-checks safety on every tick. */
  async motionUntil(predicate, label) {
    let onTick
    try {
      await this.timed(
        () =>
          new Promise((resolve, reject) => {
            onTick = () => {
              try {
                this.check()
                if (predicate()) resolve()
              } catch (error) {
                reject(error)
              }
            }
            this.bot.on('physicsTick', onTick)
            onTick()
          }),
        4000,
        label,
      )
    } finally {
      if (onTick) this.bot.off('physicsTick', onTick)
    }
  }

  // -------------------------------------------------------------------------
  // Temporary supports (scaffolds)
  // -------------------------------------------------------------------------

  /**
   * Place one temporary building block for a pathfinder step `{x, y, z, dx, dy, dz}`:
   * the block goes on face `d*` of the block at `(x, y, z)`. The placement is recorded
   * in the job so it can be recovered later.
   *
   * `prepared` skips equipping and looking, for callers that already did both.
   */
  async placeCanopy(step, prepared = false) {
    const referencePos = new Vec3(step.x, step.y, step.z)
    const face = new Vec3(step.dx, step.dy, step.dz)
    const targetPos = referencePos.plus(face)
    const faceCenter = blockCenter(referencePos).plus(face.scaled(0.5))

    const material = pickCanopyMaterial(this.bot)
    if (!material) throw new Error('Need dirt or cobblestone to build the next canopy step.')

    // Re-validated right before placing, because the world can change while we equip and turn.
    const assertStillPlaceable = () => {
      this.check()
      const reference = this.bot.blockAt(referencePos)
      const target = this.bot.blockAt(targetPos)
      const supportSolid = reference?.boundingBox === 'block'
      const outOfReach = eyePosition(this.bot).distanceTo(faceCenter) > BLOCK_REACH
      if (!supportSolid || !isAir(target) || outOfReach)
        throw new Error('Canopy placement needs a reachable solid support and a clear cell.')
      if (anyEntityInCell(this.bot, targetPos))
        throw new Error('An entity is occupying the canopy step.')
      if (this.bot.heldItem?.name !== material.name)
        throw new Error('Canopy building material changed.')
      return reference
    }

    if (!prepared) {
      await this.equip(material)
      await this.timed(() => this.bot.lookAt(faceCenter), 5000, 'Face the canopy step')
    }

    const blockType = this.bot.registry.blocksByName[material.name]
    const confirmation = watchForBlockType(this.bot, targetPos, blockType, this.controller.signal)
    try {
      await this.timed(
        () =>
          placeBlockWithOptions(this.bot, assertStillPlaceable(), face, {
            forceLook: 'ignore',
            swingArm: 'right',
          }),
        7000,
        'Place supported canopy step',
      )
      await this.timed(() => confirmation.promise, 4000, 'Confirm canopy step')
      if (this.bot.blockAt(targetPos)?.name !== material.name)
        throw new Error('Canopy support was not confirmed.')

      if (this.job) {
        this.job.scaffolds ||= []
        this.job.scaffolds.push({
          x: targetPos.x,
          y: targetPos.y,
          z: targetPos.z,
          name: material.name,
        })
        this.saveJob()
      }
      this.counts.travelBlocks = (this.counts.travelBlocks || 0) + 1
      this.sync()
    } finally {
      confirmation.cleanup()
    }
  }

  /** True when something (including the bot) is standing where a placement step would put a block. */
  canopyCellOccupied(step) {
    return anyEntityInCell(this.bot, placementTarget(step))
  }

  /**
   * Climb straight up a cleared trunk column by jumping and placing dirt under our
   * own feet. Only applies when the log at `pos` sits above a root whose column has
   * already been cleared. Returns false when this route does not apply, true once
   * `pos` is workable.
   */
  async climbTrunk(pos) {
    const root = this.job.roots.find((r) => sameColumn(r, pos))
    // Branches and old, partly cut jobs can still use the supported stair route.
    const feet = this.bot.entity.position.floored()
    if (!root) return false

    if (!sameColumn(feet, root)) {
      const columnCleared =
        isAir(this.bot.blockAt(root)) && isAir(this.bot.blockAt(root.offset(0, 1, 0)))
      if (!columnCleared) return false
      await this.walkIntoTreeBase(root)
    }

    for (let step = 0; step < MAX_CLIMB_STEPS; step++) {
      await this.settleStance()
      if (this.canWork(pos)) return true

      const here = this.bot.entity.position.floored()
      if (!sameColumn(here, root) || here.y >= pos.y) return false

      // Clear anything in the two cells above us so the jump is not blocked.
      const blockedAbove = [here.offset(0, 1, 0), here.offset(0, 2, 0)].filter(
        (q) => !isAir(this.bot.blockAt(q)),
      )
      await this.clearCanopyLeaves(blockedAbove)

      const dirt = this.bot.inventory.items().find((i) => i.name === 'dirt' && i.count > 0)
      if (!dirt) {
        const who = this.agent.username || this.bot.username || 'the bot'
        throw new Error(`Dirt column exhausted; descend and refill ${who}’s dirt reserve.`)
      }
      await this.equip(dirt)
      await this.timed(
        () => this.bot.lookAt(here.offset(0.5, 0, 0.5)),
        5000,
        'Face the dirt column',
      )
      this.decide(`Climbing the cleared trunk with dirt · ${this.plan.remaining} logs left.`)

      // Jump, then place dirt on top of the block we were just standing on.
      this.bot.setControlState('jump', true)
      try {
        await this.motionUntil(
          () => this.bot.entity.position.y >= here.y + 1.01,
          'Jump one block up the trunk',
        )
        await this.placeCanopy({ x: here.x, y: here.y - 1, z: here.z, dx: 0, dy: 1, dz: 0 }, true)
      } finally {
        this.bot.setControlState('jump', false)
      }
      await this.motionUntil(
        () =>
          this.bot.entity.onGround &&
          this.bot.entity.position.floored().equals(here.offset(0, 1, 0)),
        'Land on confirmed dirt',
      )
    }
    throw new Error('Trunk climb limit reached; unfinished tree saved.')
  }

  /** Walk to the cleared root cell without digging, parkour, or scaffolding. */
  async walkIntoTreeBase(root) {
    const previousMovements = this.bot.pathfinder.movements
    const movements = new Movements(this.bot)
    movements.canDig = false
    movements.scafoldingBlocks = []
    movements.allowParkour = false
    movements.maxDropDown = 2
    try {
      this.bot.pathfinder.setMovements(movements)
      await this.travel(
        new goals.GoalBlock(root.x, root.y, root.z),
        'Walk into the cleared tree base',
      )
    } finally {
      this.bot.pathfinder.setMovements(previousMovements)
    }
  }

  /**
   * Take back every temporary support recorded in the job, newest first. When we are
   * standing on the support being removed, we simply drop one block onto the next one.
   */
  async recoverScaffolds() {
    const scaffolds = (this.job.scaffolds ||= [])
    if (scaffolds.length) await this.descendCanopy()
    if (scaffolds.length) await this.leaveWater()

    while (scaffolds.length) {
      this.check()
      const entry = scaffolds[scaffolds.length - 1]
      const pos = toVec3(entry)
      const block = this.bot.blockAt(pos)

      // A removed bridge support can immediately fill with flowing water; nothing to dig then.
      const alreadyGone = isAir(block) || block?.name === 'water'
      if (!alreadyGone) {
        const grassSpread = entry.name === 'dirt' && block?.name === 'grass_block'
        if (block?.name !== entry.name && !grassSpread)
          throw new Error(
            `Temporary tree support changed at ${positionKey(pos)} (${block?.name || 'unloaded'}); refusing to remove it.`,
          )
        this.decide(`Recovering climbing blocks · ${scaffolds.length} remaining.`)

        // Standing on this support with solid ground beneath it: removing it drops us exactly one block.
        const canDescendOntoNext = () => {
          const feet = this.bot.entity.position.floored()
          return (
            !this.bot.entity.isInWater &&
            feet.equals(pos.offset(0, 1, 0)) &&
            this.bot.entity.onGround !== false &&
            this.bot.blockAt(pos.offset(0, -1, 0))?.boundingBox === 'block' &&
            this.job.scaffolds.includes(entry)
          )
        }
        if (!canDescendOntoNext()) await this.approach(pos)
        await this.settleStance()
        const descending = canDescendOntoNext()
        await this.dig(
          pos,
          block.name,
          () => this.job.scaffolds.includes(entry),
          (item) => this.withoutSilk(item),
          canDescendOntoNext,
        )
        if (descending)
          await this.motionUntil(
            () => this.bot.entity.onGround && this.bot.entity.position.floored().equals(pos),
            'Descend one block on solid support',
          )
        // Nearby drops collect automatically during a column descent. Chasing
        // them here could walk off the column before the next support is removed.
        if (!descending) await this.pickup(pos)
      }
      scaffolds.pop()
      this.saveJob()
    }
  }

  /** Step down through natural leaves we are standing on, one confirmed block at a time. */
  async descendCanopy() {
    const isLeaf = (block) => isNaturalLeaf(block, this.job.species)
    for (let step = 0; step < MAX_CLIMB_STEPS && !this.bot.entity.isInWater; step++) {
      const below = this.bot.entity.position.floored().offset(0, -1, 0)
      const standingOnLeafOverSolid =
        isLeaf(this.bot.blockAt(below)) &&
        this.bot.blockAt(below.offset(0, -1, 0))?.boundingBox === 'block'
      if (!standingOnLeafOverSolid) return

      const nearTree = this.job.roots.some(
        (r) => Math.hypot(r.x - below.x, r.z - below.z) <= CANOPY_WORK_RADIUS,
      )
      if (!nearTree || below.y < Math.min(...this.job.roots.map((r) => r.y))) return

      await this.settleStance()
      const stillSafe = () =>
        !this.bot.entity.isInWater &&
        this.bot.entity.onGround !== false &&
        this.bot.entity.position.floored().equals(below.offset(0, 1, 0)) &&
        isLeaf(this.bot.blockAt(below)) &&
        this.bot.blockAt(below.offset(0, -1, 0))?.boundingBox === 'block'
      this.decide('Descending the natural canopy one supported block at a time.')
      await this.dig(
        below,
        leavesName(this.job.species),
        isLeaf,
        (item) => !item || !/shears/.test(item.name),
        stillSafe,
      )
      await this.motionUntil(
        () => this.bot.entity.onGround && this.bot.entity.position.floored().equals(below),
        'Land after clearing a canopy block',
      )
    }
  }

  /**
   * Dig the natural leaves at `positions`, always choosing one we can actually see.
   * Refuses to touch anything that is not a natural leaf of the tree's species.
   */
  async clearCanopyLeaves(positions) {
    if (!positions.length) return
    const pending = positions.map(toVec3)
    const isLeaf = (block) => isNaturalLeaf(block, this.job.species)
    let retries = 0

    for (let attempt = 0; attempt < MAX_LEAF_CLEARANCE_ATTEMPTS; attempt++) {
      this.check()
      if (attempt > 0) await this.settleStance()

      const remaining = pending.map((p) => this.bot.blockAt(p)).filter((b) => !isAir(b))
      if (!remaining.length) return
      if (remaining.some((b) => !isLeaf(b)))
        throw new Error('Canopy clearance changed; refusing to dig unrelated terrain.')

      let target = remaining.find((b) => this.canWork(b.position))
      if (!target && this.bot.world?.raycast) {
        // Planner ordering is not visibility ordering. A nearer leaf can hide a
        // requested leaf even when both blocks are geometrically within reach.
        const eye = eyePosition(this.bot)
        for (const leaf of remaining) {
          const direction = blockCenter(leaf.position).minus(eye)
          const distance = direction.norm()
          if (distance > BLOCK_REACH) continue
          const hit = this.bot.world.raycast(eye, direction.normalize(), distance + 0.01)
          if (isLeaf(hit) && this.canWork(hit.position)) {
            target = hit
            break
          }
        }
      }
      if (!target)
        throw new Error(
          'Canopy clearance needs a closer, unobstructed stance; no hidden blocks were dug.',
        )

      try {
        await this.dig(target.position, target.name, isLeaf)
        retries = 0
      } catch (error) {
        this.check()
        const transientViewChange = /out of reach or view|Target changed/.test(error.message)
        if (error.fatal || error.code === 'HANDOFF' || !transientViewChange || ++retries > 2)
          throw error
        this.agent.log?.(
          'tree.clearance-retry',
          'Canopy view changed while turning; settling and checking the nearest visible leaf again.',
        )
      }
    }
    throw new Error('Canopy clearance reached its bounded leaf limit; unfinished tree retained.')
  }

  // -------------------------------------------------------------------------
  // Reaching a log
  // -------------------------------------------------------------------------

  /**
   * Movements for building stairs into a canopy. The pathfinder may clear natural
   * leaves and place building blocks near the tree, but never mines logs or other
   * terrain, never builds isolated jump towers, and never fills a root column.
   */
  canopyMovements() {
    const movements = new Movements(this.bot)
    movements.allow1by1towers = false
    movements.allowParkour = false
    movements.allowSprinting = false
    movements.maxDropDown = 2
    movements.canDig = true
    movements.scafoldingBlocks = BUILDING_BLOCKS.map(
      (n) => this.bot.registry.itemsByName[n]?.id,
    ).filter(Number.isInteger)
    movements.exclusionAreasBreak.push((block) =>
      isNaturalLeaf(block, this.job.species) ? 0 : 100,
    )
    movements.exclusionAreasPlace.push((block) => {
      const anchor = this.job.roots[0]
      const farFromTree =
        Math.abs(block.position.x - anchor.x) > CANOPY_WORK_RADIUS ||
        Math.abs(block.position.z - anchor.z) > CANOPY_WORK_RADIUS
      const onRootColumn = this.job.roots.some((r) => sameColumn(r, block.position))
      return !isAir(block) || farFromTree || onRootColumn ? 100 : 0
    })
    return movements
  }

  /**
   * Get into a working stance for the log at `pos`. Tries, in order: already there,
   * the dirt-column trunk climb, a plain pathfinder route, and finally hand-built
   * canopy stairs. Stair construction always leaves a return route.
   */
  async reachLog(pos) {
    this.check()
    const goal = new CanopyGoal(this.bot, pos, this.job.species)
    if (this.canWork(pos)) return
    if (await this.climbTrunk(pos)) return

    const movements = this.canopyMovements()
    const previousMovements = this.bot.pathfinder.movements
    try {
      this.bot.pathfinder.setMovements(movements)
      await this.timed(
        async () => {
          if (await this.tryDirectCanopyPath(goal, movements)) return
          await this.buildCanopyStairs(pos, goal, movements)
        },
        60000,
        'Build stairs and climb to the remaining tree logs',
      )
      await this.clearSightLine(pos)
      if (!this.canWork(pos))
        throw new Error('Upper log is still out of reach; retaining unfinished tree.')
    } finally {
      this.bot.pathfinder.setGoal(null)
      if (this.agent.bot === this.bot) this.bot.pathfinder.setMovements(previousMovements)
    }
  }

  /** Try to walk to the goal without placing anything. Returns false when no such path exists. */
  async tryDirectCanopyPath(goal, movements) {
    const materials = movements.scafoldingBlocks
    try {
      movements.scafoldingBlocks = []
      await this.bot.pathfinder.goto(goal)
      await this.settleStance()
      return true
    } catch (error) {
      if (!['NoPath', 'Timeout', 'PartialRoute'].includes(error.name)) throw error
      this.check()
      this.bot.pathfinder.setGoal(null)
      return false
    } finally {
      movements.scafoldingBlocks = materials
    }
  }

  /**
   * An on-ground collision box can overlap a block edge while its center is over
   * air. The stair graph assumes support directly below its starting cell, so
   * walk back onto the actual supporting block before asking it for placements.
   */
  async supportedCanopyStance() {
    await this.settleStance()
    const feet = workingCell(this.bot)
    if (this.bot.blockAt(feet.offset(0, -1, 0))?.boundingBox === 'block') return feet

    const p = this.bot.entity.position
    const halfWidth = (this.bot.entity.width || 0.6) / 2
    const supports = []
    for (let x = Math.floor(p.x - halfWidth); x <= Math.floor(p.x + halfWidth); x++) {
      for (let z = Math.floor(p.z - halfWidth); z <= Math.floor(p.z + halfWidth); z++) {
        const block = this.bot.blockAt(new Vec3(x, Math.floor(p.y - 0.001), z))
        if (block?.boundingBox !== 'block') continue
        const underFeet = block.shapes.some(
          ([x0, , z0, x1, y1, z1]) =>
            Math.abs(block.position.y + y1 - p.y) < 0.01 &&
            p.x + halfWidth > x + x0 &&
            p.x - halfWidth < x + x1 &&
            p.z + halfWidth > z + z0 &&
            p.z - halfWidth < z + z1,
        )
        if (underFeet) supports.push(block.position.offset(0, 1, 0))
      }
    }
    supports.sort((a, b) => blockCenter(a).distanceTo(p) - blockCenter(b).distanceTo(p))
    if (!supports.length) throw new Error('No confirmed footing below the canopy stance.')

    const target = supports[0],
      previous = this.bot.pathfinder.movements
    const movements = new Movements(this.bot)
    movements.canDig = false
    movements.scafoldingBlocks = []
    movements.allowParkour = false
    movements.allowSprinting = false
    movements.maxDropDown = 0
    try {
      this.bot.pathfinder.setMovements(movements)
      await this.timed(
        () => this.bot.pathfinder.goto(new goals.GoalBlock(target.x, target.y, target.z)),
        10000,
        'Return from the canopy edge to solid footing',
      )
      await this.settleStance()
    } finally {
      if (this.agent.bot === this.bot) this.bot.pathfinder.setMovements(previous)
    }
    const actual = workingCell(this.bot)
    if (
      !actual.equals(target) ||
      this.bot.blockAt(actual.offset(0, -1, 0))?.boundingBox !== 'block'
    )
      throw new Error('The canopy stance did not reach confirmed footing.')
    return actual
  }

  /**
   * Build supported steps toward `pos` one at a time. The movement graph does not
   * remember supports placed by earlier hypothetical steps, so each iteration picks
   * one valid neighbor step, builds and verifies it, then replans on real terrain.
   */
  async buildCanopyStairs(pos, goal, movements) {
    const materials = movements.scafoldingBlocks
    const visited = new Set()
    for (let step = 0; step < MAX_STAIR_STEPS; step++) {
      this.check()
      const feet = await this.supportedCanopyStance()
      if (this.canWork(pos) || goal.isEnd(this.bot.entity.position.floored())) return

      const current = new Move(feet.x, feet.y, feet.z, movements.countScaffoldingItems(), 0)
      visited.add(positionKey(feet))

      const choices = movements
        .getNeighbors(current)
        .filter(
          (n) =>
            !visited.has(positionKey(n)) &&
            n.toPlace.every((p) => !this.canopyCellOccupied(p)) &&
            n.y >= feet.y - 2 && // no big drops
            n.y <= Math.max(pos.y, feet.y) && // never climb above the target
            (goal.isEnd(n) || n.distanceTo(pos) < feet.distanceTo(pos) + 0.25), // must make progress
        )
        .sort(
          (a, b) =>
            Number(goal.isEnd(b)) - Number(goal.isEnd(a)) || a.distanceTo(pos) - b.distanceTo(pos),
        )
      if (!choices.length)
        throw new Error(
          'No supported next canopy step. Provide dirt or clear access beside this tree.',
        )

      const next = choices[0]
      this.agent.log?.(
        'tree.climb',
        `Climbing supported canopy step ${step + 1}; ${next.toPlace.length} placement(s).`,
      )
      await this.clearCanopyLeaves(next.toBreak)
      // Clearing a leaf can change the landing. Replan instead of trying
      // to place a block through the bot's actual collision box.
      if (next.toPlace.some((p) => this.canopyCellOccupied(p))) continue
      for (const placement of next.toPlace) await this.placeCanopy(placement)

      try {
        this.check()
        movements.scafoldingBlocks = []
        await this.bot.pathfinder.goto(new goals.GoalBlock(next.x, next.y, next.z))
        await this.settleStance()
      } finally {
        movements.scafoldingBlocks = materials
      }

      const actual = this.bot.entity.position.floored()
      const onConfirmedSupport =
        actual.equals(next) && this.bot.blockAt(actual.offset(0, -1, 0))?.boundingBox === 'block'
      if (!onConfirmedSupport) throw new Error('Canopy step was not reached on confirmed support.')
    }
    throw new Error('Canopy access reached its 16-step limit; unfinished tree saved.')
  }

  /**
   * The stair search may plan through removable leaves. From the reached stance,
   * clear the actual sight line to `pos` one confirmed leaf at a time.
   */
  async clearSightLine(pos) {
    for (let attempt = 0; attempt < 8 && !this.canWork(pos); attempt++) {
      const eye = eyePosition(this.bot)
      const toTarget = blockCenter(pos).minus(eye)
      const distance = toTarget.norm()
      const hit = this.bot.world.raycast(eye, toTarget.normalize(), distance + 0.01)
      if (!isNaturalLeaf(hit, this.job.species) || !this.canWork(hit.position)) break
      await this.clearCanopyLeaves([hit.position])
    }
  }

  // -------------------------------------------------------------------------
  // Finding trees and supplies
  // -------------------------------------------------------------------------

  /** Filter during the scan so buried dirt cannot crowd safe surface supplies out. */
  find(names, radius = 32, predicate = () => true) {
    const matching = names
      .map((name) => this.bot.registry.blocksByName[name]?.id)
      .filter(Number.isInteger)
    if (!matching.length) return []
    const eligible = (block) =>
      block &&
      block.position.distanceTo(this.origin) <= 80 &&
      !this.failedTargets.has(`${block.position}:${block.name}`) &&
      predicate(block)
    return this.bot
      .findBlocks({ matching, maxDistance: radius, count: 256, useExtraInfo: eligible })
      .map((pos) => this.bot.blockAt(pos))
      .filter(eligible)
      .sort(
        (a, b) =>
          a.position.distanceTo(this.bot.entity.position) -
          b.position.distanceTo(this.bot.entity.position),
      )
  }

  /** Dirt and grass may be dug for supports, but never where it would scar the tree site or a farm. */
  safeTarget(block) {
    if (!super.safeTarget(block)) return false
    if (!['dirt', 'grass_block'].includes(block.name)) return true

    const exposed = isAir(this.bot.blockAt(block.position.offset(0, 1, 0)))
    if (!exposed) return false
    const protectedJobs = [this.job, ...this.pendingReplants().map(([, job]) => job)].filter(
      Boolean,
    )
    const nearTreeRoots = protectedJobs.some((job) =>
      job.roots.some((r) => Math.hypot(r.x - block.position.x, r.z - block.position.z) < 6),
    )
    if (nearTreeRoots) return false
    for (let dx = -2; dx <= 2; dx++)
      for (let dz = -2; dz <= 2; dz++)
        if (this.bot.blockAt(block.position.offset(dx, 0, dz))?.name === 'farmland') return false
    return true
  }

  /** Look for a rooted log near the work origin and inspect it into a job. Returns null if none qualifies. */
  async findTree() {
    const logIds = SPECIES.map((s) => this.bot.registry.blocksByName[logName(s)].id)
    const isRootedNearOrigin = (block) =>
      block &&
      block.position.distanceTo(this.origin) <= 80 &&
      SOIL.has(this.bot.blockAt(block.position.offset(0, -1, 0))?.name)

    const candidates = this.bot
      .findBlocks({
        matching: logIds,
        maxDistance: 48,
        count: 256,
        useExtraInfo: isRootedNearOrigin,
      })
      .map((p) => this.bot.blockAt(p))
      .filter(isRootedNearOrigin)

    for (const candidate of candidates.slice(0, 24)) {
      try {
        return inspectTree(this.bot, candidate)
      } catch (error) {
        this.addIssue(error.message)
      }
    }
    return null
  }

  /** Optional supply trips never prevent reachable logs from being harvested. */
  supplyFailure(label, error) {
    this.check()
    if (error.fatal || ['HANDOFF', 'CANCELLED', 'AIR_RECOVERY'].includes(error.code)) throw error
    this.addIssue(`${label}: ${error.message}`)
  }

  async restock(names, target, label) {
    const key = names.join(',')
    if (Date.now() < (this.supplyRetries.get(key) || 0)) return
    this.supplyRetries.set(key, Date.now() + SUPPLY_RETRY_MS)
    await require('../capabilities/local-supplies.cjs').restockLocal(
      this,
      names,
      target,
      target,
      label,
    )
  }

  tool(kind) {
    return TOOL_TIERS.map((tier) => `${tier}_${kind}`).find((name) =>
      this.bot.inventory.items().some((item) => {
        if (item.name !== name || item.count <= 0) return false
        const max = this.bot.registry.items[item.type]?.maxDurability
        return !max || (item.durabilityUsed || 0) < max - 8
      }),
    )
  }

  /** Crafting must never use the generic wood gatherer, which loses the rest of a tree. */
  async planks(amount) {
    if (this.total(/_log$/) * 4 + this.total(/_planks$/) < amount)
      throw new Error('Waiting for more wood from the saved tree to craft tools.')
    await super.planks(amount)
  }

  async prepareTools() {
    for (const kind of ['axe', 'shovel']) {
      if (this.tool(kind)) continue
      const names = TOOL_TIERS.map((tier) => `${tier}_${kind}`)
      try {
        this.decide(`Getting a tree farming ${kind} from storage.`)
        // Worn-out tools must not satisfy the restock count.
        await this.restock(names, names.reduce((n, name) => n + this.count(name), 0) + 1, kind)
      } catch (error) {
        this.supplyFailure(`Could not retrieve a ${kind}`, error)
      }
    }
    if (this.tool('axe') && this.tool('shovel')) return

    try {
      // Three logs cover a table, sticks, axe and shovel. Every starter log is
      // part of the saved job, including if Stop arrives during preparation.
      const starterLogs = this.job.logs
        .filter(
          (p) =>
            this.bot.blockAt(p)?.name === logName(this.job.species) &&
            this.job.roots.some((root) => sameColumn(root, p) && p.y < root.y + 3),
        )
        .sort((a, b) => a.y - b.y)
      for (const pos of starterLogs.slice(0, 3)) {
        if (this.total(/_log$/) * 4 + this.total(/_planks$/) >= 12) break
        this.decide('Harvesting starter wood from the saved tree to craft tools.')
        await this.harvestLog(pos)
      }
      for (const kind of ['axe', 'shovel']) {
        if (this.tool(kind)) continue
        const amount = kind === 'axe' ? 3 : 1
        const tier =
          this.count('iron_ingot') >= amount
            ? 'iron'
            : this.count('cobblestone') >= amount || this.count('cobbled_deepslate') >= amount
              ? 'stone'
              : 'wooden'
        const table = await this.craftingTable()
        await this.sticks(2)
        if (tier === 'wooden') await this.planks(amount)
        await this.craft(`${tier}_${kind}`, table)
      }
    } catch (error) {
      this.supplyFailure(
        'Tool preparation deferred; continuing with available tools or hands',
        error,
      )
    }
  }

  async prepareDirt() {
    const minY = Math.min(...this.job.roots.map((p) => p.y))
    const height = Math.max(...this.job.logs.map((p) => p.y)) - minY
    const target = Math.min(64, Math.max(8, height + MAX_STAIR_STEPS + this.job.roots.length))
    if (this.count('dirt') >= target) return
    try {
      this.decide(`Preparing dirt for tree access: ${this.count('dirt')}/${target}.`)
      await this.restock(['dirt'], 128, 'tree access dirt')
      if (this.count('dirt') >= target) return
      await this.gather(
        ['dirt', 'grass_block'],
        () => this.count('dirt') >= target,
        `${target} dirt for tree access`,
        target,
        false,
      )
    } catch (error) {
      this.supplyFailure('Dirt preparation deferred; harvesting reachable logs first', error)
    }
  }

  /**
   * Collect replanting stock after cutting, when the canopy and drops are accessible.
   * Missing stock is saved as planting debt instead of blocking the next mature tree.
   */
  async plantingStock(job) {
    const sapling = saplingName(job.species)
    const saplingLabel = sapling.replaceAll('_', ' ')
    const needed = job.roots.filter(
      (p) => !job.planted.includes(positionKey(p)) && this.bot.blockAt(p)?.name !== sapling,
    ).length
    if (this.count(sapling) >= needed) return

    this.decide(`Collecting ${saplingLabel} from the harvested tree for replanting.`)
    for (const root of job.roots) await this.pickup(root)
    if (this.count(sapling) >= needed) return
    try {
      await this.restock([sapling], needed, saplingLabel)
    } catch (error) {
      this.supplyFailure('Sapling storage unavailable; checking the canopy', error)
    }

    const nearbyLeaves = this.find(
      [leavesName(job.species)],
      32,
      (block) =>
        block.getProperties?.().persistent !== true &&
        job.logs.some((p) => p.distanceTo(block.position) <= 4),
    )
    for (const leaf of nearbyLeaves.slice(0, 48)) {
      if (this.count(sapling) >= needed) break
      try {
        await this.reachLog(leaf.position)
        // Shears and silk touch would drop the leaf block itself instead of a sapling.
        await this.dig(
          leaf.position,
          leaf.name,
          (block) => isNaturalLeaf(block, job.species),
          (item) => !item || (!/shears/.test(item.name) && this.withoutSilk(item)),
        )
        await this.pickup(leaf.position)
      } catch (error) {
        this.supplyFailure('Sapling collection', error)
      }
    }

    if (this.count(sapling) < needed)
      throw Object.assign(
        new Error(
          `Replanting saved: ${this.count(sapling)}/${needed} ${saplingLabel}. Checking drops and storage again later.`,
        ),
        { code: 'WAITING_FOR_SAPLINGS' },
      )
  }

  /**
   * A voluntary skill switch may interrupt a large tree between logs, but only after
   * descending and recovering our temporary supports. Emergency Stop stays immediate.
   */
  async handoffCheckpoint() {
    if (!this.handoffRequested) return
    if (this.job) {
      await this.descendCanopy()
      await this.recoverScaffolds()
      const root = this.job.roots[0]
      const treeBase = new goals.GoalNear(root.x, root.y, root.z, 2)
      if (!treeBase.isEnd(this.bot.entity.position.floored()))
        await this.travel(treeBase, 'Return to the tree base before switching skills')
      this.saveJob()
    }
    await this.settleStance()
    this.checkpoint({ phase: 'tree-secured', unfinishedTree: !!this.job })
  }

  // -------------------------------------------------------------------------
  // Harvesting
  // -------------------------------------------------------------------------

  /** Offload to colony storage when nearly full; refuse to continue with fewer than two free slots. */
  async ensureInventoryRoom() {
    if (this.bot.inventory.emptySlotCount() < 4 && this.agent.colony?.enabled)
      await require('../storage/service.cjs').store(this)
    if (this.bot.inventory.emptySlotCount() < 2)
      throw new Error(
        this.agent.colony?.enabled
          ? 'Inventory is full. Enroll a reachable wood or overflow chest with free space before continuing.'
          : `Inventory is full. Empty ${this.agent.username} inventory before continuing.`,
      )
  }

  /** Work through the inspected tree job; leave enough information to resume and replant it. */
  async harvestTree() {
    const job = this.job
    this.check()

    const remainingLogs = job.logs.filter((p) => this.bot.blockAt(p)?.name === logName(job.species))
    this.plan.remaining = remainingLogs.length
    // Bottom-up, nearest first: clear the base and trunk, then the canopy.
    remainingLogs.sort(
      (a, b) =>
        a.y - b.y ||
        a.distanceTo(this.bot.entity.position) - b.distanceTo(this.bot.entity.position),
    )

    for (const logPos of remainingLogs) {
      this.decide(`Harvesting the full ${job.species} tree · ${this.plan.remaining} logs left.`)
      await this.harvestLog(logPos)
    }

    const logsLeft = job.logs.some(
      (p) => !this.bot.blockAt(p) || this.bot.blockAt(p).name === logName(job.species),
    )
    if (logsLeft)
      throw new Error('Tree removal is incomplete; retaining this tree for the next attempt.')

    await this.recoverScaffolds()
    await this.finishPlanting(job)
  }

  async harvestLog(pos) {
    this.check()
    await this.ensureInventoryRoom()
    await this.reachLog(pos)
    await this.dig(pos, logName(this.job.species))
    this.job.removed++
    this.plan.logs++
    this.counts.mined++
    this.plan.remaining = this.job.logs.filter(
      (p) => this.bot.blockAt(p)?.name === logName(this.job.species),
    ).length
    this.sync()
    this.saveJob()
    await this.handoffCheckpoint()
    await this.pickup(pos)
  }

  async finishPlanting(job) {
    let waiting
    try {
      await this.plantingStock(job)
    } catch (error) {
      if (error.code !== 'WAITING_FOR_SAPLINGS') throw error
      waiting = error
    }
    // Sapling collection may also have needed canopy steps. Always secure them
    // before moving on, even when no saplings dropped.
    await this.recoverScaffolds()
    if (!waiting) {
      try {
        await this.replantRoots(job)
      } catch (error) {
        if (error.code !== 'PLANTING_BLOCKED') throw error
        waiting = error
      }
    }
    if (waiting) {
      const pendingKey = `${this.jobKey}:replant:${positionKey(job.roots[0])}`
      this.agent.treeJobs.set(pendingKey, job)
      this.replantRetries.set(pendingKey, Date.now() + SUPPLY_RETRY_MS)
      this.decide(`${waiting.message} Continuing with nearby mature trees.`)
    } else {
      this.plan.trees++
    }
    this.agent.treeJobs.delete(this.jobKey)
    this.saveJob()
    this.job = null
  }

  async retryReplants() {
    const ready = this.pendingReplants().filter(
      ([key]) => Date.now() >= (this.replantRetries.get(key) || 0),
    )
    for (const [key, job] of ready.slice(0, 4)) {
      this.check()
      // Promote before acting so a failed climb or Stop retains one active job.
      this.job = job
      this.agent.treeJobs.set(this.jobKey, job)
      this.agent.treeJobs.delete(key)
      this.saveJob()
      if (job.scaffolds?.length) await this.recoverScaffolds()
      await this.finishPlanting(job)
      if (!this.agent.treeJobs.has(key)) this.replantRetries.delete(key)
      await this.handoffCheckpoint()
    }
  }

  async plantingSoil(root) {
    const pos = root.offset(0, -1, 0)
    const soil = this.bot.blockAt(pos)
    if (SOIL.has(soil?.name)) return soil
    const blocked = (message) => Object.assign(new Error(message), { code: 'PLANTING_BLOCKED' })
    if (!isAir(soil))
      throw blocked(`Replanting saved: soil at ${positionKey(pos)} is ${soil?.name || 'unloaded'}.`)
    if (!this.count('dirt')) await this.prepareDirt()
    const support = this.bot.blockAt(pos.offset(0, -1, 0))
    if (!this.count('dirt') || support?.boundingBox !== 'block')
      throw blocked(`Replanting saved: need dirt and solid support at ${positionKey(pos)}.`)
    this.decide('Restoring missing dirt beneath the saved tree planting spot.')
    const confirmation = watchForBlockType(
      this.bot,
      pos,
      this.bot.registry.blocksByName.dirt,
      this.controller.signal,
    )
    try {
      await this.placeItem('dirt', support)
      await this.timed(() => confirmation.promise, 4000, 'Confirm restored tree soil')
    } finally {
      confirmation.cleanup()
    }
    return this.bot.blockAt(pos)
  }

  /** Put a sapling on every root that has not been replanted yet, confirming each placement. */
  async replantRoots(job) {
    const sapling = saplingName(job.species)
    const saplingType = this.bot.registry.blocksByName[sapling]
    for (const rootPos of job.roots) {
      if (job.planted.includes(positionKey(rootPos))) continue

      if (this.bot.blockAt(rootPos)?.name !== sapling) {
        if (!isAir(this.bot.blockAt(rootPos)))
          throw Object.assign(
            new Error(
              `Replanting saved: planting spot ${positionKey(rootPos)} is occupied or unloaded.`,
            ),
            { code: 'PLANTING_BLOCKED' },
          )
        const soil = await this.plantingSoil(rootPos)
        const confirmation = watchForBlockType(
          this.bot,
          rootPos,
          saplingType,
          this.controller.signal,
        )
        try {
          await this.placeItem(sapling, soil)
          await this.timed(() => confirmation.promise, 4000, 'Confirm replanted sapling')
        } finally {
          confirmation.cleanup()
        }
      }

      job.planted.push(positionKey(rootPos))
      this.plan.planted++
      this.counts.planted++
      this.sync()
      this.saveJob()
      await this.pickup(rootPos)
    }
  }

  // -------------------------------------------------------------------------
  // Main loop
  // -------------------------------------------------------------------------

  /** Logs removed plus roots replanted; used to detect passes that made no progress. */
  jobProgress() {
    return (this.job?.removed || 0) + (this.job?.planted.length || 0)
  }

  /** One full attempt: find or resume a tree, gather supplies, harvest, replant. */
  async farmOnePass() {
    this.check()
    await this.handoffCheckpoint()
    await this.eat()

    if (!this.job) {
      await this.retryReplants()
      this.job = await this.findTree()
      if (this.job) {
        this.plan.remaining = this.job.logs.length
        this.agent.treeJobs.set(this.jobKey, this.job)
        this.saveJob()
      }
    }
    if (!this.job)
      throw new Error('No supported mature trees nearby. Waiting for saplings to grow.')

    // After an interrupted climb, return safely before collecting supplies.
    if (this.job.scaffolds?.length) await this.recoverScaffolds()
    if (this.job.logs.some((p) => this.bot.blockAt(p)?.name === logName(this.job.species))) {
      await this.prepareTools()
      await this.prepareDirt()
    }

    await this.harvestTree()
    await this.handoffCheckpoint()
    this.stalledPasses = 0
    this.decide(
      this.plan.pendingReplants
        ? `Tree harvested; ${this.plan.pendingReplants} planting spots saved. Looking for the next tree.`
        : 'Full tree harvested and replanted. Looking for the next tree.',
    )
    // The farmer manages dirt itself; this checkpoint only returns surplus and
    // obtains shared tools, without starting a second, mandatory 128-block dig.
    this.refillingBuilding = true
    try {
      await this.agent.coordination?.returnSupplies(this)
    } finally {
      this.refillingBuilding = false
    }
    await this.pause(1000)
  }

  /**
   * Count consecutive passes that neither removed a log, replanted a root, nor
   * recovered a support. Deferred planting never counts as a movement stall. Gives up on
   * the saved tree after MAX_STALLED_PASSES so the operator can reposition the bot.
   */
  trackStall(error, progressBefore, scaffoldsBefore) {
    const progressed = this.jobProgress() > progressBefore
    const recoveredSupports = (this.job?.scaffolds?.length || 0) < scaffoldsBefore
    const madeProgress =
      error.code === 'WAITING_FOR_SAPLINGS' || !this.job || progressed || recoveredSupports
    this.stalledPasses = madeProgress ? 0 : (this.stalledPasses || 0) + 1
    if (this.job && this.stalledPasses >= MAX_STALLED_PASSES) {
      const who = this.agent.username || this.bot.username
      throw new Error(
        `No progress after three attempts. Unfinished tree saved. ${error.message} Move ${who} to another side of the tree or provide access blocks, then restart tree farming.`,
      )
    }
  }

  /** Report a recoverable failure and wait before the next pass, still surfacing for air if needed. */
  async waitOutFailure(error) {
    await this.handoffCheckpoint()
    this.addIssue(error.message)
    this.decide(`Tree farmer waiting: ${error.message}`)
    // Retry an in-progress tree quickly; back off longer when there is nothing to work on.
    const delay = error.code === 'WAITING_FOR_SAPLINGS' || !this.job ? 10000 : 1500
    this.plan.waitingUntil = Date.now() + delay
    this.agent.publish()
    try {
      await this.pause(delay)
    } catch (waitError) {
      if (waitError.code !== 'AIR_RECOVERY') throw waitError
      await this.recoverAir()
    }
    this.plan.waitingUntil = null
  }

  async run() {
    const onCollect = (entity) => {
      if (entity.id === this.bot.entity.id && !this.cancelled()) {
        this.counts.collectedStacks++
        this.sync()
      }
    }
    this.bot.on('playerCollect', onCollect)

    // Keep the head above water whenever nothing else is steering the bot.
    const keepAfloat = () => {
      const idleInWater =
        !this.cancelled() &&
        this.bot.entity.isInWater &&
        !this.recoveringAir &&
        this.task.travel?.status !== 'running'
      if (idleInWater) this.bot.setControlState('jump', true)
    }
    this.bot.on('physicsTick', keepAfloat)

    // Independent of the work loop, so danger aborts even mid-await.
    const dangerGuard = setInterval(() => {
      if (this.cancelled()) return
      this.requestAir()
      const danger = this.safety()
      if (danger && !this.cancelled())
        this.controller.abort(Object.assign(new Error(danger), { fatal: true }))
    }, 500)

    try {
      while (true) {
        const progressBefore = this.jobProgress()
        const scaffoldsBefore = this.job?.scaffolds?.length || 0
        try {
          await this.farmOnePass()
        } catch (error) {
          if (error.fatal || error.code === 'HANDOFF' || this.cancelled()) throw error
          if (error.code === 'AIR_RECOVERY' || this.needsAir) {
            await this.recoverAir()
            continue
          }
          this.trackStall(error, progressBefore, scaffoldsBefore)
          await this.waitOutFailure(error)
        }
      }
    } catch (error) {
      const reason = error.fatal ? error : this.controller.signal.reason || error
      if (reason.code === 'HANDOFF') this.task.reasonCode = 'HANDOFF'
      this.plan.status = ['CANCELLED', 'HANDOFF'].includes(reason.code) ? 'cancelled' : 'paused'
      this.task.status = this.plan.status === 'cancelled' ? 'cancelled' : 'partial'
      this.decideStopped(reason)
      if (reason.fatal && reason.code !== 'HANDOFF') this.failure = reason
    } finally {
      this.bot.off('playerCollect', onCollect)
      this.bot.off('physicsTick', keepAfloat)
      clearInterval(dangerGuard)
      this.plan.waitingUntil = null
      if (this.agent.bot === this.bot) {
        this.bot.pathfinder.setGoal(null)
        this.bot.clearControlStates()
        if (this.agent.baseMovements) this.bot.pathfinder.setMovements(this.agent.baseMovements)
        const pausedInWater =
          this.task.status === 'partial' && this.agent.nav === this.id && this.bot.entity.isInWater
        if (pausedInWater) this.bot.setControlState('jump', true)
      }
      this.agent.publish()
    }
  }

  decideStopped(error) {
    this.plan.decision = `Tree farmer ${this.plan.status}: ${error.message}`
    this.task.label = this.plan.decision
    this.addIssue(error.message)
    this.agent.say(this.plan.decision)
  }
}

module.exports = { TreeFarm, inspectTree, SPECIES, CanopyGoal }
