/**
 * MOVEMENT: combines ordinary pathfinding, surface swimming, and small construction routes.
 * Read go() first: try walking, look for a useful construction plan if that fails, then execute it.
 * Planning imagines blocks in an overlay; execution must still place and confirm each real block.
 */

const { Vec3 } = require('vec3')
const { Movements, goals } = require('mineflayer-pathfinder')
const { setTimeout: yieldSearch } = require('node:timers/promises')
const { watchBlock } = require('../minecraft/block-updates.cjs')
const { placeBlockWithOptions } = require('../minecraft/actions.cjs')
const Move = require('mineflayer-pathfinder/lib/move')
const { passage, handOpenable, installPassages, normalizePassagePath } = require('./passages.cjs')

const key = (p) => `${p.x},${p.y},${p.z}`
const air = (b) => b && ['air', 'cave_air', 'void_air'].includes(b.name)
const water = (b) => b?.name === 'water'
const solid = (b) =>
  b?.boundingBox === 'block' &&
  b.shapes?.some((s) => s[4] === 1) &&
  !/farmland|chest|barrel|shulker|crafting_table|furnace|magma|cactus|leaves/.test(b.name)
const BUILDING_BLOCKS = [
  'dirt',
  'cobblestone',
  'cobbled_deepslate',
  'stone',
  'andesite',
  'diorite',
  'granite',
  'netherrack',
]
const DIRECTIONS = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)]
const MAX_STEPS = 16 // Bounded construction per route, with confirmed blocks and safe staging.

// Weighted A*: trade shortest-path optimality for fewer expanded nodes on long
// trips. All collision, drop, water and digging constraints remain in Movements.
class WalkingSearchGoal extends goals.Goal {
  constructor(goal, weight = 2) {
    super()
    this.goal = goal
    this.weight = weight
  }
  heuristic(node) {
    return this.weight * this.goal.heuristic(node)
  }
  isEnd(node) {
    return this.goal.isEnd(node)
  }
  hasChanged() {
    return this.goal.hasChanged()
  }
  isValid() {
    return this.goal.isValid()
  }
}

function installReliableGoto(bot) {
  installPassages(bot)
  // The package's goto helper resolves on ANY empty path, including an unfinished
  // A* slice. Waiting for the real terminal event prevents premature "arrival".
  bot.pathfinder.goto = (goal) =>
    new Promise((resolve, reject) => {
      let settled = false,
        segmentEndpoint = null
      const finish = (error) => {
        if (settled) return
        settled = true
        bot.off('path_update', update)
        bot.off('goal_reached', arrived)
        bot.off('goal_updated', changed)
        bot.off('path_stop', stopped)
        bot.off('physicsTick', advance)
        setTimeout(() => (error ? reject(error) : resolve()), 0)
      }
      const failure = (name, message) => Object.assign(new Error(message), { name })
      const update = (result) => {
        normalizePassagePath(bot, result)
        if (result.status !== 'timeout') segmentEndpoint = null
        if (result.status === 'noPath') finish(failure('NoPath', 'No path to the goal.'))
        else if (result.status === 'timeout') {
          // A bounded search may still have a useful, safe segment. Do not call
          // that arrival: walk to its endpoint and then replan the original goal.
          const start = bot.entity.position
          const endpoint = [...(result.path || [])]
            .reverse()
            .find(
              (p) =>
                p.distanceTo(start) >= 2 &&
                goal.heuristic(p) < goal.heuristic(start) - 1 &&
                solid(bot.blockAt(p.floored().offset(0, -1, 0))) &&
                air(bot.blockAt(p.floored())) &&
                air(bot.blockAt(p.floored().offset(0, 1, 0))),
            )
          if (endpoint) {
            // The library already installed this path. Follow it instead of
            // clearing it and performing a second search for the same endpoint.
            segmentEndpoint = endpoint.floored()
          } else finish(failure('Timeout', 'No useful route within the search budget.'))
        } else if (result.status === 'success' && !result.path.length && reached(bot, goal))
          finish()
      }
      const arrived = (current) => {
        if (!current || current === goal) finish()
      }
      const changed = (current) => {
        if (current !== goal) finish(failure('GoalChanged', 'Route was cleared or changed.'))
      }
      const stopped = () => finish(failure('PathStopped', 'Route stopped.'))
      const advance = () => {
        if (!segmentEndpoint || settled) return
        if (
          !reached(
            bot,
            new goals.GoalBlock(segmentEndpoint.x, segmentEndpoint.y, segmentEndpoint.z),
          )
        )
          return
        finish(
          Object.assign(
            failure(
              'PartialRoute',
              'Useful route segment reached; continue the destination search.',
            ),
            {
              endpoint: segmentEndpoint,
              followed: true,
            },
          ),
        )
        bot.pathfinder.setGoal(null)
      }
      bot.on('path_update', update)
      bot.on('goal_reached', arrived)
      bot.on('goal_updated', changed)
      bot.on('path_stop', stopped)
      bot.on('physicsTick', advance)
      try {
        bot.pathfinder.setGoal(goal)
      } catch (error) {
        finish(error)
      }
    })
}

// Pathfinder already swims by holding Jump. Its graph, however, measures a jump
// from the block *below* the swimmer, as if water were an empty hole. Use the
// surface as the take-off height when considering a one-block exit from water.
class TravelMovements extends Movements {
  constructor(bot, overlay = new Map()) {
    const view = Object.create(bot)
    view.blockAt = (p, ...args) => overlay.get(key(p.floored())) || bot.blockAt(p, ...args)
    super(view)
    this.canDig = false
    this.canOpenDoors = true
    this.allowFarmland = true // Walk through dense fields; jumping onto crops stays forbidden.
    this.allow1by1towers = false
    this.scafoldingBlocks = [] // Shore construction is explicitly guarded below.
    this.allowParkour = true // Short, non-sprinting jumps across one-block gaps.
    this.allowSprinting = false
    this.maxDropDown = 3 // At most a two-block fall onto solid ground.
    this.infiniteLiquidDropdownDistance = true // Bounded separately to six below.
    this.liquidCost = 2
    this.exclusionAreasStep.push((b) => {
      if (!b.position) return 100 // Pathfinder uses a positionless sentinel for unloaded cells.
      const below = view.blockAt(b.position.offset(0, -1, 0))
      if (
        /magma|cactus/.test(below?.name || '') ||
        (below?.name === 'farmland' && !this.allowFarmland)
      )
        return 100
      // Surface crossings only: don't plan submerged tunnels or waterfalls.
      if (
        water(b) &&
        (!air(view.blockAt(b.position.offset(0, 1, 0))) || Number(b.getProperties().level) >= 8)
      )
        return 100
      return 0
    })
  }
  getBlock(pos, dx, dy, dz) {
    const b = super.getBlock(pos, dx, dy, dz)
    if (b.name && /_fence$|_wall$|_fence_gate$/.test(b.name))
      b.physical = b.boundingBox === 'block' && b.shapes.length > 0
    if (b.name?.endsWith('_door')) {
      b.physical = false
      b.safe = false
    }
    if (
      this.surfaceJump &&
      pos === this.surfaceJump &&
      dx === 0 &&
      dy === -1 &&
      dz === 0 &&
      water(b)
    )
      return { ...b, height: pos.y }
    return b
  }
  safeToBreak(block) {
    if (passage(block) || /_fence$|_wall$/.test(block.name || '')) return false
    return super.safeToBreak(block)
  }
  getMoveForward(node, dir, neighbors) {
    const b = this.bot.blockAt(node.offset(dir.x, 0, dir.z))
    if (!passage(b)) return super.getMoveForward(node, dir, neighbors)
    const props = b.getProperties()
    if (!props.open && !handOpenable(b)) return
    if (['east', 'west'].includes(props.facing) ? dir.z !== 0 : dir.x !== 0) return
    const head = this.bot.blockAt(b.position.offset(0, 1, 0))
    if (b.name.endsWith('_door')) {
      if (props.half !== 'lower' || head?.name !== b.name || head.getProperties().half !== 'upper')
        return
    } else if (!head || head.boundingBox !== 'empty') return
    if (!this.getBlock(node, dir.x, -1, dir.z).physical || this.exclusionStep(b) >= 100) return
    const interactions = props.open
      ? []
      : [{ x: b.position.x, y: b.position.y, z: b.position.z, dx: 0, dy: 0, dz: 0, useOne: true }]
    neighbors.push(
      new Move(
        b.position.x,
        b.position.y,
        b.position.z,
        node.remainingBlocks,
        1 + interactions.length,
        [],
        interactions,
      ),
    )
  }
  getNeighbors(node) {
    return super.getNeighbors(node).filter((next) => {
      const source = this.bot.blockAt(node)
      if (passage(source)) {
        const facing = source.getProperties().facing
        if (['east', 'west'].includes(facing) ? next.z !== node.z : next.x !== node.x) return false
      }
      const support = this.getBlock(next, 0, -1, 0)
      if (!/_fence$|_wall$|_fence_gate$/.test(support.name || '') || !support.physical) return true
      // Fence tops are 1.5 blocks high. Require full player headroom at that
      // actual height, including the extra half-block above the grid node.
      for (let y = Math.floor(support.height); y < support.height + 1.8; y++) {
        const b = this.bot.blockAt(new Vec3(next.x, y, next.z))
        if (
          !b ||
          b.shapes.some(
            (s) =>
              s[3] > 0.2 &&
              s[0] < 0.8 &&
              s[5] > 0.2 &&
              s[2] < 0.8 &&
              y + s[4] > support.height &&
              y + s[1] < support.height + 1.8,
          )
        )
          return false
      }
      return true
    })
  }
  // A surface swimmer must be able to climb out of an irrigation hole.
  // Keep crop-protecting jump restrictions for routes that start on land.
  getMoveJumpUp(node, dir, neighbors) {
    this.surfaceJump = water(this.bot.blockAt(node)) ? node : null
    const start = neighbors.length
    try {
      super.getMoveJumpUp(node, dir, neighbors)
      for (let i = neighbors.length - 1; i >= start; i--)
        if (
          !this.surfaceJump &&
          this.bot.blockAt(neighbors[i].offset(0, -1, 0))?.name === 'farmland'
        )
          neighbors.splice(i, 1)
    } finally {
      this.surfaceJump = null
    }
  }
  getMoveDiagonal(node, dir, neighbors) {
    this.surfaceJump = water(this.bot.blockAt(node)) ? node : null
    const start = neighbors.length
    try {
      super.getMoveDiagonal(node, dir, neighbors)
      for (let i = neighbors.length - 1; i >= start; i--)
        if (
          !this.surfaceJump &&
          neighbors[i].y > node.y &&
          this.bot.blockAt(neighbors[i].offset(0, -1, 0))?.name === 'farmland'
        )
          neighbors.splice(i, 1)
    } finally {
      this.surfaceJump = null
    }
  }
  getMoveParkourForward(node, dir, neighbors) {
    const start = neighbors.length
    super.getMoveParkourForward(node, dir, neighbors)
    for (let i = neighbors.length - 1; i >= start; i--)
      if (this.bot.blockAt(neighbors[i].offset(0, -1, 0))?.name === 'farmland')
        neighbors.splice(i, 1)
  }
  getLandingBlock(node, dir) {
    // A swimmer can bob into the air cell immediately above water. The stock
    // search starts TWO cells below and misses the surface in that situation.
    const below = this.getBlock(node, dir.x, -1, dir.z)
    const b = water(below) && below.safe ? below : super.getLandingBlock(node, dir)
    if (
      b &&
      this.bot.blockAt(b.position.offset(0, -1, 0))?.name === 'farmland' &&
      node.y > b.position.y
    )
      return null // Do not drop onto crops.
    return water(b) && node.y - b.position.y > 6 ? null : b
  }
}

function reached(bot, goal) {
  const p = bot.entity.position
  const cell = new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))
  if (goal.isEnd(cell)) return true
  // Farmland, slabs, etc. leave feet in their cell instead of the air cell above.
  return !!(
    bot.entity.onGround &&
    p.y - cell.y > 0.001 &&
    bot.blockAt?.(cell)?.boundingBox === 'block' &&
    goal.isEnd(cell.offset(0, 1, 0))
  )
}

class Travel {
  constructor(work, limit = 60000, options = {}) {
    this.optional = !!options.optional
    this.work = work
    this.bot = work.bot
    this.deadline = Math.min(work.deadline, Date.now() + limit)
    this.activity = {
      status: 'running',
      phase: 'planning',
      label: 'Finding a walking or swimming route',
      blocksPlaced: 0,
    }
    this.work.task.travel = this.activity
  }
  check() {
    this.work.check()
    if (Date.now() >= this.deadline)
      throw new Error('Travel time limit reached. Review the route in Bot activity.')
  }
  log(event, message, level = 'info') {
    this.work.agent.log?.(event, message, level, { taskId: this.work.id })
  }
  phase(phase, label) {
    this.activity.phase = phase
    this.activity.label = label
    this.log(`travel.${phase}`, label)
  }
  async timed(fn, label, limit = 60000) {
    this.check()
    return this.work.timed(fn, Math.max(1, Math.min(limit, this.deadline - Date.now())), label)
  }
  stock() {
    return this.bot.inventory
      .items()
      .filter((i) => BUILDING_BLOCKS.includes(i.name) && i.count > 0)
      .sort((a, b) => BUILDING_BLOCKS.indexOf(a.name) - BUILDING_BLOCKS.indexOf(b.name))
  }
  async tick() {
    this.check()
    await new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer)
        this.bot.off('physicsTick', done)
        this.work.controller.signal.removeEventListener('abort', done)
        resolve()
      }
      const timer = setTimeout(done, 100)
      this.bot.once('physicsTick', done)
      this.work.controller.signal.addEventListener('abort', done, { once: true })
    })
    this.check()
  }
  surfaceEscape() {
    const start = this.bot.entity.position.floored(),
      queue = [{ pos: start, path: [] }],
      seen = new Set([key(start)])
    const clear = (b) => b && b.boundingBox === 'empty' && !/lava|fire|cobweb/.test(b.name)
    for (let i = 0; i < queue.length && i < 256; i++) {
      const node = queue[i]
      // Find daylight above the water, not just the underside of a platform.
      for (let y = start.y; y <= start.y + 16; y++) {
        const p = new Vec3(node.pos.x, y, node.pos.z),
          b = this.bot.blockAt(p)
        if (!clear(b)) break
        if (air(b) && air(this.bot.blockAt(p.offset(0, 1, 0))))
          return { ...node, surfaceY: y - 0.65 }
      }
      for (const direction of DIRECTIONS) {
        const pos = node.pos.plus(direction)
        if (seen.has(key(pos)) || Math.abs(pos.x - start.x) + Math.abs(pos.z - start.z) > 8)
          continue
        seen.add(key(pos))
        if (clear(this.bot.blockAt(pos)) && clear(this.bot.blockAt(pos.offset(0, 1, 0))))
          queue.push({ pos, path: [...node.path, pos] })
      }
    }
    return null
  }
  async surface() {
    if (!this.bot.entity.isInWater) return false
    const escape = this.surfaceEscape()
    if (!escape)
      throw Object.assign(new Error('No open-water escape found within eight blocks.'), {
        code: 'NO_ROUTE',
      })
    if (!escape.path.length && this.bot.entity.position.y >= escape.surfaceY) {
      this.bot.setControlState('jump', true)
      return false
    }
    this.phase(
      'surfacing',
      escape.path.length
        ? 'Swimming sideways out from under the obstruction, then surfacing'
        : 'Swimming up to the surface before planning the next route',
    )
    const end = Math.min(this.deadline, Date.now() + 15000)
    this.surfacing = true
    this.bot.pathfinder.setGoal(null)
    try {
      for (const cell of escape.path) {
        const target = cell.offset(0.5, 0, 0.5)
        while (
          Math.hypot(target.x - this.bot.entity.position.x, target.z - this.bot.entity.position.z) >
          0.3
        ) {
          this.check()
          if (Date.now() > end)
            throw Object.assign(
              new Error('Water escape stalled; stopped retrying this approach.'),
              { code: 'NO_ROUTE' },
            )
          const p = this.bot.entity.position
          await this.timed(
            () => this.bot.look(Math.atan2(p.x - target.x, p.z - target.z), 0, true),
            'Face open water',
            2000,
          )
          this.bot.setControlState('forward', true)
          const headroom = this.bot.blockAt(p.floored().offset(0, 2, 0))
          this.bot.setControlState('jump', !!headroom && headroom.boundingBox === 'empty')
          this.bot.setControlState('sprint', false)
          await this.tick()
        }
      }
      this.bot.setControlState('forward', false)
      while (this.bot.entity.position.y < escape.surfaceY) {
        this.check()
        if (Date.now() > end)
          throw Object.assign(new Error('Could not surface; stopped retrying this approach.'), {
            code: 'NO_ROUTE',
          })
        this.bot.setControlState('jump', true)
        await this.tick()
      }
    } finally {
      this.surfacing = false
      if (this.work.agent.bot === this.bot && this.work.agent.nav === this.work.id)
        this.bot.setControlState('forward', false)
    }
    return true
  }
  destination(goal, label) {
    const p = goal.entity?.position || goal.pos || goal
    this.activity.destination = [p.x, p.y, p.z].every(Number.isFinite)
      ? { x: p.x, y: p.y, z: p.z, label }
      : null
    this.work.agent.publish()
  }
  // A timeout can still yield a useful path section. Reach that section, then retry the original goal.
  async segments(goal) {
    const visited = new Set()
    const searchGoal =
      goal.heuristic(this.bot.entity.position) >= 24 ? new WalkingSearchGoal(goal) : goal
    if (searchGoal !== goal)
      this.log(
        'travel.search',
        'Using weighted A* for a long walk; favoring progress over the shortest possible route.',
      )
    for (let n = 0; n < 32; n++) {
      this.check()
      try {
        await this.bot.pathfinder.goto(searchGoal)
        return
      } catch (error) {
        if (error.name !== 'PartialRoute') throw error
        const p = error.endpoint,
          k = key(p)
        if (visited.has(k))
          throw Object.assign(new Error('Route segments stopped making progress.'), {
            name: 'NoPath',
          })
        visited.add(k)
        this.bot.pathfinder.setGoal(null)
        this.phase('segment', `Continuing after route section ${n + 1}/32`)
        // Keep the map destination on the user's goal, not this intermediate cell.
        try {
          if (!error.followed) await this.bot.pathfinder.goto(new goals.GoalBlock(p.x, p.y, p.z))
        } catch (segmentError) {
          if (segmentError.name === 'PartialRoute')
            throw Object.assign(
              new Error('Intermediate route changed; checking an alternative approach.'),
              { name: 'NoPath' },
            )
          throw segmentError
        }
        this.check()
      }
    }
    throw Object.assign(new Error('Route segment budget reached; choose a closer destination.'), {
      name: 'NoPath',
    })
  }
  async walk(goal, label) {
    if (this.bot.entity.isInWater && !this.optional) await this.surface()
    this.destination(goal, label)
    for (let attempt = 0; attempt < (this.optional ? 1 : 3); attempt++) {
      this.check()
      let stalled = false,
        lastPosition = this.bot.entity.position.clone?.(),
        lastProgress = Date.now()
      this.walking = true
      // Optional loot collection must yield before Work's fatal action timeout.
      const pickupLimit = this.optional
        ? setTimeout(() => {
            if (!this.work.cancelled() && this.bot.pathfinder.goal === goal)
              this.bot.pathfinder.setGoal(null)
          }, 4000)
        : null
      const watchdog = setInterval(() => {
        if (this.work.cancelled() || !lastPosition) return
        const p = this.bot.entity.position
        // Vertical bobbing in water is not forward progress.
        const distance = Math.hypot(
          p.x - lastPosition.x,
          p.z - lastPosition.z,
          this.bot.entity.isInWater ? 0 : p.y - lastPosition.y,
        )
        if (distance > 0.2) {
          lastPosition = p.clone()
          lastProgress = Date.now()
        } else if (Date.now() - lastProgress > 4500 && this.bot.pathfinder.goal === goal) {
          stalled = true
          this.bot.pathfinder.setGoal(null)
        }
      }, 250)
      try {
        await this.timed(() => this.segments(goal), label)
        break
      } catch (error) {
        this.check()
        if (!stalled || this.optional) throw error
        if (attempt === 2)
          throw Object.assign(new Error('Movement stalled after two route retries.'), {
            name: 'NoPath',
          })
        this.phase(
          'recovering',
          `Movement stalled; clearing the old route and retrying (${attempt + 1}/2)`,
        )
        await this.surface()
      } finally {
        clearTimeout(pickupLimit)
        clearInterval(watchdog)
        this.walking = false
        // goto() leaves its goal and partial path installed on several failures.
        // Retire them before the caller can switch from iron to farming, etc.
        if (this.work.agent.bot === this.bot && this.work.agent.nav === this.work.id) {
          this.bot.pathfinder.setGoal(null)
          this.bot.clearControlStates()
        }
      }
    }
    this.check()
    // Pathfinder can signal arrival one cell early while a swimmer is still
    // bobbing up after a drop. Keep Jump held and observe the actual surface.
    if (
      !reached(this.bot, goal) &&
      this.bot.entity.isInWater &&
      goal.isEnd(this.bot.entity.position.floored().offset(0, 1, 0))
    ) {
      this.phase('surfacing', 'Coming up to the water surface before continuing')
      for (let n = 0; n < 60 && !reached(this.bot, goal); n++) {
        this.check()
        await this.work.pause(50)
      }
    }
    if (!reached(this.bot, goal))
      throw Object.assign(new Error('The route search did not reach the requested destination.'), {
        name: 'NoPath',
      })
  }
  // Preview a route in short, cancellable slices; this does not move the bot.
  async path(moves, start, goal, end = Infinity) {
    // Consume the real pathfinder in short slices, so Stop and physics keep running
    // even when several possible beaches need to be compared.
    this.check()
    if (Date.now() >= end) return null
    const generator = this.bot.pathfinder.getPathFromTo(moves, start, goal, {
      timeout: Math.min(350, end - Date.now()),
      tickTimeout: 5,
      optimizePath: false,
      searchRadius: this.optional ? 12 : 64,
    })
    for (const { result } of generator) {
      this.check()
      if (result.status !== 'partial') return result.status === 'success' ? result : null
      if (Date.now() >= end) return null
      // Never delegate scheduler yielding to a skill: FARMER's pause(0) is a no-op.
      await yieldSearch(5, undefined, { signal: this.work.controller.signal })
      this.check()
    }
    return null
  }
  *candidateScan(goal) {
    const candidates = [],
      seen = new Set(),
      center = this.bot.entity.position.floored()
    // Inspect loaded surface water. A one-block stair reaches a two-block bank;
    // a three-block stair (including its footing) reaches a three-block bank.
    for (let dx = -24; dx <= 24; dx++)
      for (let dz = -24; dz <= 24; dz++) {
        if (dx * dx + dz * dz > 24 * 24) continue
        yield null
        for (let dy = 3; dy >= -6; dy--) {
          const p = center.offset(dx, dy, dz)
          if (!water(this.bot.blockAt(p)) || !air(this.bot.blockAt(p.offset(0, 1, 0)))) continue
          for (const outward of DIRECTIONS) {
            const bank = p.minus(outward)
            if (!solid(this.bot.blockAt(bank))) continue
            let height = 0
            while (height < 5 && solid(this.bot.blockAt(bank.offset(0, height + 1, 0)))) height++
            if (
              height < 1 ||
              height > 4 ||
              !air(this.bot.blockAt(bank.offset(0, height + 1, 0))) ||
              !air(this.bot.blockAt(bank.offset(0, height + 2, 0)))
            )
              continue
            const placements = []
            // Build each column while floating beside it, then shift outward.
            // Taller banks need a supported staircase, not an impossible jump.
            for (let column = 0; column < height; column++)
              for (let level = 0; level < height - column; level++) {
                const pos = p.plus(outward.scaled(column)).offset(0, level, 0)
                placements.push({
                  pos,
                  ref: pos.minus(outward),
                  face: outward,
                  stand: p.plus(outward.scaled(column + 1)),
                })
              }
            const positions = placements.map((s) => s.pos)
            if (positions.some((q) => !air(this.bot.blockAt(q)) && !water(this.bot.blockAt(q))))
              continue
            const landing = bank.offset(0, height + 1, 0),
              staging = p.plus(outward.scaled(height))
            if (
              !water(this.bot.blockAt(staging)) ||
              !air(this.bot.blockAt(staging.offset(0, 1, 0)))
            )
              continue
            if (positions.some((q) => !air(this.bot.blockAt(q.offset(0, 2, 0))))) continue
            const signature = positions.map(key).join(';')
            if (seen.has(signature)) continue
            seen.add(signature)
            candidates.push({
              placements,
              staging,
              landing,
              score: goal.heuristic(landing) + center.distanceTo(staging) + positions.length * 4,
            })
          }
          break
        }
      }
    const islands = yield* require('./island-routes.cjs').islandRoutes(this.bot, goal)
    candidates.push(...islands, ...this.bridgeCandidates(goal))
    return candidates
      .sort(
        (a, b) =>
          Number(goal.isEnd(b.landing)) - Number(goal.isEnd(a.landing)) ||
          (goal.heuristic(a.landing) - goal.heuristic(b.landing)) * 4 + a.score - b.score,
      )
      .slice(0, 24)
  }
  candidates(goal) {
    const scan = this.candidateScan(goal)
    let step
    do {
      step = scan.next()
    } while (!step.done)
    return step.value
  }
  bridgeCandidates(goal) {
    const plans = [],
      center = this.bot.entity.position.floored()
    for (let dx = -6; dx <= 6; dx++)
      for (let dz = -6; dz <= 6; dz++)
        for (let dy = -2; dy <= 2; dy++) {
          const staging = center.offset(dx, dy, dz),
            base = staging.offset(0, -1, 0)
          if (
            !solid(this.bot.blockAt(base)) ||
            !air(this.bot.blockAt(staging)) ||
            !air(this.bot.blockAt(staging.offset(0, 1, 0)))
          )
            continue
          for (const direction of DIRECTIONS) {
            const placements = []
            for (let distance = 1; distance <= 9; distance++) {
              const pos = base.plus(direction.scaled(distance)),
                ground = this.bot.blockAt(pos)
              if (
                !air(this.bot.blockAt(pos.offset(0, 1, 0))) ||
                !air(this.bot.blockAt(pos.offset(0, 2, 0)))
              )
                break
              if (solid(ground)) {
                if (placements.length) {
                  const landing = pos.offset(0, 1, 0)
                  plans.push({
                    kind: 'bridge',
                    placements,
                    staging,
                    landing,
                    score:
                      goal.heuristic(landing) + center.distanceTo(staging) + placements.length * 4,
                  })
                }
                break
              }
              if ((!air(ground) && !water(ground)) || distance > 8) break
              placements.push({
                pos,
                ref: pos.minus(direction),
                face: direction,
                stand: pos.minus(direction).offset(0, 1, 0),
                advance: pos.offset(0, 1, 0),
              })
            }
          }
        }
    return plans
  }
  // Compare bounded construction candidates against the real route and available block stock.
  async shorePlan(goal) {
    this.phase('shore', 'Checking shore steps, bridges, and rising ramps to islands')
    const searchEnd = Math.min(this.deadline, Date.now() + 1500)
    const scan = this.candidateScan(goal)
    let step,
      scanned = 0
    do {
      this.check()
      step = scan.next()
      if (++scanned % 64 === 0)
        await yieldSearch(5, undefined, { signal: this.work.controller.signal })
      if (Date.now() >= searchEnd) {
        this.phase('planning', 'Shore search budget reached; skipping this approach')
        return null
      }
    } while (!step.done)
    const candidates = step.value
    if (!candidates.length) return null
    const available = Math.min(
      this.stock().reduce((n, i) => n + i.count, 0),
      MAX_STEPS - this.activity.blocksPlaced,
    )
    const Block = require('prismarine-block')(this.bot.registry)
    const moves = this.bot.pathfinder.movements
    let shortOfBlocks = false
    for (const plan of candidates) {
      this.check()
      if (Date.now() > searchEnd) break
      // A previous search may have stopped in the water mid-crossing. If this
      // staging route already connects to the goal, no new construction is useful.
      if (await this.path(moves, plan.staging, goal, searchEnd)) {
        if (
          await this.path(
            moves,
            this.bot.entity.position,
            new goals.GoalBlock(plan.staging.x, plan.staging.y, plan.staging.z),
            searchEnd,
          )
        )
          return { ...plan, placements: [] }
      }
      if (plan.placements.length > available) {
        shortOfBlocks = true
        continue
      }
      const overlay = new Map(
        plan.placements.map(({ pos }) => {
          const block = Block.fromStateId(this.bot.registry.blocksByName.cobblestone.minStateId, 0)
          block.position = pos.clone()
          return [key(pos), block]
        }),
      )
      // Verify the future exit all the way to the requested goal, and the current
      // swimming route to a staging cell that is outside the new blocks.
      const projectedMoves = new TravelMovements(this.bot, overlay)
      const projectedGoal = Object.create(goal)
      if (goal.bot === this.bot) projectedGoal.bot = projectedMoves.bot
      if (!(await this.path(projectedMoves, plan.staging, projectedGoal, searchEnd))) continue
      if (
        !(await this.path(
          moves,
          this.bot.entity.position,
          new goals.GoalBlock(plan.staging.x, plan.staging.y, plan.staging.z),
          searchEnd,
        ))
      )
        continue
      return plan
    }
    if (shortOfBlocks)
      throw Object.assign(
        new Error(
          'An island approach needs building blocks. Marc needs dirt, cobblestone, or another ordinary building block (up to 16 placed per route).',
        ),
        { code: 'NO_ROUTE' },
      )
    return null
  }
  placementValid(step, name, { farmSupport = false } = {}) {
    this.check()
    const dest = this.bot.blockAt(step.pos),
      ref = this.bot.blockAt(step.ref),
      eye = this.bot.entity.position.offset(0, 1.62, 0)
    if ((!air(dest) && !water(dest)) || !(solid(ref) || (farmSupport && ref?.name === 'farmland')))
      throw new Error('Shoreline changed before placement; the route needs to be planned again.')
    const face = step.ref.offset(0.5, 0.5, 0.5).plus(step.face.scaled(0.5))
    if (eye.distanceTo(face) > 4.5) throw new Error('The shore step is outside placement reach.')
    if (this.bot.heldItem?.name !== name || this.bot.heldItem.count < 1)
      throw new Error('The building block is no longer equipped.')
    for (const entity of [this.bot.entity, ...Object.values(this.bot.entities || {})]) {
      if (!entity.position || entity.name === 'item') continue
      const p = entity.position,
        r = (entity.width || 0.6) / 2,
        h = entity.height || 1.8
      if (
        p.x + r > step.pos.x &&
        p.x - r < step.pos.x + 1 &&
        p.z + r > step.pos.z &&
        p.z - r < step.pos.z + 1 &&
        p.y + h > step.pos.y &&
        p.y < step.pos.y + 1
      )
        throw new Error('A player or entity is occupying the planned step.')
    }
    return { ref, face }
  }
  // Place one planned block only after checking support, reach, inventory, and entity collisions.
  async place(step) {
    this.check()
    const item = this.stock()[0]
    if (!item || this.activity.blocksPlaced >= MAX_STEPS)
      throw new Error('No building blocks remain in this task’s shore-step budget.')
    const name = item.name
    this.phase('building', `Placing a ${name.replaceAll('_', ' ')} shore step at ${key(step.pos)}`)
    await this.timed(() => this.bot.equip(item, 'hand'), `Equip ${name} for a shore step`, 5000)
    let current = this.placementValid(step, name)
    await this.timed(
      () => this.bot.lookAt(current.face),
      `Face the shore step at ${key(step.pos)}`,
      5000,
    )
    current = this.placementValid(step, name)
    const expected = this.bot.registry.blocksByName[name]
    const ack = watchBlock(
      this.bot,
      step.pos,
      (state) => state >= expected.minStateId && state <= expected.maxStateId,
      this.work.controller.signal,
    )
    try {
      // Pre-turn plus forceLook:'ignore' means there is no delayed look promise
      // inside the placement helper that could send a packet after Stop.
      await this.timed(
        () => {
          this.placementValid(step, name)
          return placeBlockWithOptions(this.bot, current.ref, step.face, {
            forceLook: 'ignore',
            swingArm: 'right',
          })
        },
        `Place shore step at ${key(step.pos)}`,
        7000,
      )
      await this.timed(() => ack.promise, `Confirm shore step at ${key(step.pos)}`, 4000)
      if (this.bot.blockAt(step.pos)?.name !== name)
        throw new Error('The server did not confirm the shore step.')
      this.work.counts.travelBlocks = (this.work.counts.travelBlocks || 0) + 1
      this.activity.blocksPlaced++
      this.work.sync()
      this.work.agent.refresh()
      this.log('travel.placed', `Shore step confirmed: ${name} at ${key(step.pos)}.`)
    } finally {
      ack.cleanup()
    }
  }
  // Own the whole trip, including water recovery and construction. Always clean up movement listeners.
  async go(goal, label = 'Travel to destination') {
    this.destination(goal, label)
    let swimming = false,
      route = []
    const pathUpdate = (result) => {
      route = result.path || []
      if (goal.entity) this.destination(goal, label)
    }
    const pathReset = () => {
      route = []
    }
    const buoyancy = () => {
      if (this.work.cancelled()) return
      if (this.bot.entity.isInWater) {
        // Keep afloat while planning, turning or equipping at the shore as well.
        if (!this.surfacing) this.bot.setControlState?.('jump', true)
        if (!swimming) {
          swimming = true
          this.phase('swimming', 'Swimming at the surface toward the destination')
        }
      } else if (swimming && this.bot.entity.onGround) {
        swimming = false
        this.phase('walking', 'Back on land; continuing toward the destination')
      }
      if (
        this.walking &&
        this.bot.entity.onGround &&
        !this.bot.entity.isInWater &&
        this.bot.pathfinder.goal
      ) {
        const p = this.bot.entity.position
        // The library's dry-land jump predictor can hesitate at a water drop.
        // Follow the already planned adjacent water landing with a plain walk.
        const entry = route.find(
          (n) =>
            n.y < p.y - 0.5 &&
            p.y - n.y <= 6 &&
            Math.hypot(n.x - p.x, n.z - p.z) < 1.8 &&
            water(this.bot.blockAt(n.floored())),
        )
        if (entry) {
          const face = new Vec3(entry.x, p.y, entry.z)
          const direction = face.minus(p),
            length = direction.norm()
          let clear = length > 0.05
          for (let d = 0.25; clear && d < length; d += 0.25) {
            const cell = p.plus(direction.scaled(d / length)).floored()
            clear = [cell, cell.offset(0, 1, 0)].every((q) => {
              const b = this.bot.blockAt(q)
              return b && b.boundingBox === 'empty'
            })
          }
          if (clear) {
            if (this.activity.phase !== 'entering_water')
              this.phase('entering_water', 'Walking off the ledge toward the planned water landing')
            this.bot.look(Math.atan2(-direction.x, -direction.z), 0).catch(() => {})
            this.bot.setControlState('forward', true)
            this.bot.setControlState('jump', false)
            this.bot.setControlState('sprint', false)
          }
        }
      }
    }
    this.bot.on?.('physicsTick', buoyancy)
    this.bot.on?.('path_update', pathUpdate)
    this.bot.on?.('path_reset', pathReset)
    try {
      if (!this.optional) await this.surface()
      try {
        await this.walk(goal, label)
      } catch (error) {
        this.check()
        if (
          this.optional ||
          error.fatal ||
          !['NoPath', 'Timeout'].includes(error.name) ||
          !this.bot.pathfinder.getPathFromTo
        )
          throw error
        this.bot.pathfinder.setGoal(null)
        const plan = await this.shorePlan(goal)
        if (!plan)
          throw Object.assign(
            new Error(
              'No walking, swimming, bridge, or rising-ramp route was found in the loaded terrain. Check Bot activity and choose another approach on the map.',
            ),
            { code: 'NO_ROUTE' },
          )
        this.phase(
          'approaching',
          plan.placements.length
            ? `Reaching the start of a ${plan.kind || 'shore stair'} requiring ${plan.placements.length} blocks`
            : 'Swimming to an existing shore approach; no new blocks needed',
        )
        await this.walk(
          new goals.GoalBlock(plan.staging.x, plan.staging.y, plan.staging.z),
          'Reach the shore-step staging point',
        )
        for (const step of plan.placements) {
          if (step.stand)
            await this.walk(
              new goals.GoalBlock(step.stand.x, step.stand.y, step.stand.z),
              'Reach the next safe construction position',
            )
          await this.place(step)
          if (step.advance)
            await this.walk(
              new goals.GoalBlock(step.advance.x, step.advance.y, step.advance.z),
              'Walk onto the confirmed bridge block',
            )
        }
        this.phase(
          'climbing',
          plan.placements.length
            ? 'Climbing the new shore steps and continuing to the destination'
            : 'Following the existing route to the destination',
        )
        await this.walk(goal, 'Climb onto land and reach the destination')
      }
      this.activity.status = 'succeeded'
      this.log('travel.arrived', 'Reached the requested destination.')
    } catch (error) {
      this.activity.status = this.work.cancelled() ? 'cancelled' : 'failed'
      throw error
    } finally {
      this.bot.off?.('physicsTick', buoyancy)
      this.bot.off?.('path_update', pathUpdate)
      this.bot.off?.('path_reset', pathReset)
      if (this.work.agent.bot === this.bot && this.work.agent.nav === this.work.id) {
        this.bot.pathfinder.setGoal(null)
        this.bot.clearControlStates()
        if (!this.work.cancelled() && this.bot.entity.isInWater)
          this.bot.setControlState('jump', true)
      }
      this.work.agent.publish()
    }
  }
}

module.exports = {
  Travel,
  TravelMovements,
  BUILDING_BLOCKS,
  reached,
  installReliableGoto,
  WalkingSearchGoal,
}
