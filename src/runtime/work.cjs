/**
 * SHARED ACTIONS: mining, planting, choosing tools, and picking up drops.
 * Higher-level skills reuse these actions rather than sending Minecraft packets themselves.
 * Every action can be cancelled and has a deadline; successful actions verify what the server actually changed.
 */

const { Vec3 } = require('vec3')
const { watchBlock } = require('../minecraft/block-updates.cjs')
const { placeBlockWithOptions } = require('../minecraft/actions.cjs')
const { closeBot } = require('../minecraft/connection.cjs')
const { setTimeout: sleep } = require('node:timers/promises')
const { TaskTool, chooseTool } = require('../minecraft/tools.cjs')
const { Travel, TravelMovements } = require('../navigation/travel.cjs')
const { PickupGoal } = require('../navigation/pickup-goal.cjs')
const { BlockApproachGoal, canView, workingCell } = require('../navigation/block-approach.cjs')

// Crop definitions: the item used for planting and the age value that means fully grown.
const CROPS = {
  wheat: { block: 'wheat', seed: 'wheat_seeds', age: 7 },
  carrots: { block: 'carrots', seed: 'carrot', age: 7 },
  potatoes: { block: 'potatoes', seed: 'potato', age: 7 },
  beetroot: { block: 'beetroots', seed: 'beetroot_seeds', age: 3 },
}
const air = (block) => block && ['air', 'cave_air', 'void_air'].includes(block.name)
const key = (p) => `${p.x},${p.y},${p.z}`
function parseWork(s) {
  let m = s.match(
    /^mine area\s+(-?\d+)[ ,]+(-?\d+)[ ,]+(-?\d+)\s+(?:to\s+)?(-?\d+)[ ,]+(-?\d+)[ ,]+(-?\d+)$/,
  )
  if (m) {
    const n = m.slice(1).map(Number)
    if (
      n.some(
        (v, i) =>
          !Number.isSafeInteger(v) || (i % 3 === 1 ? v < -64 || v > 319 : Math.abs(v) > 30000000),
      )
    )
      throw new Error('Use valid whole-block coordinates.')
    const min = new Vec3(...n.slice(0, 3)),
      max = new Vec3(...n.slice(3))
    for (const axis of ['x', 'y', 'z'])
      [min[axis], max[axis]] = [Math.min(min[axis], max[axis]), Math.max(min[axis], max[axis])]
    const volume = (max.x - min.x + 1) * (max.y - min.y + 1) * (max.z - min.z + 1)
    if (volume > 512) throw new Error('Select at most 512 block positions per mining area.')
    return { type: 'mineArea', min, max, volume }
  }
  m = s.match(/^mine\s+([a-z_ ]+?)(?:\s+(\d+))?(?:\s+within\s+(\d+))?$/)
  if (m) {
    const count = Number(m[2] || 16),
      radius = Number(m[3] || 32)
    if (count < 1 || count > 128 || radius < 1 || radius > 64)
      throw new Error('Mine 1–128 blocks within a radius of 1–64.')
    return { type: 'mineType', name: m[1].trim().replace(/ /g, '_'), count, radius }
  }
  m = s.match(/^farm\s+(wheat|carrots?|potatoes|potato|beetroots?|all)(?:\s+(?:within\s+)?(\d+))?$/)
  if (m) {
    const crop = { carrot: 'carrots', potato: 'potatoes', beetroots: 'beetroot' }[m[1]] || m[1],
      radius = Number(m[2] || 16)
    if (radius < 1 || radius > 32) throw new Error('Farm within a radius of 1–32 blocks.')
    return { type: 'farm', crop, radius }
  }
  return null
}
function blockName(bot, name) {
  const names = bot.registry.blocksByName
  if (Object.hasOwn(names, name)) return name
  if (name.endsWith('s') && Object.hasOwn(names, name.slice(0, -1))) return name.slice(0, -1)
  throw new Error(`Unknown block: ${name}. Use a name such as stone or oak_log.`)
}
function mature(block, crop) {
  return block?.name === crop.block && Number(block.getProperties().age) === crop.age
}

class Work {
  constructor(agent, id) {
    this.agent = agent
    this.bot = agent.bot
    this.id = id
    this.task = agent.state.task
    this.started = Date.now()
    this.deadline = this.started + 300000
    Object.assign(this.task, {
      startedAt: this.started,
      deadlineAt: this.deadline,
      lastProgressAt: this.started,
    })
    this.controller = new AbortController()
    this.handoffController = new AbortController()
    this.effects = []
    this.cleanups = []
    this.counts = { mined: 0, harvested: 0, planted: 0, skipped: 0, collectedStacks: 0 }
    this.issues = []
    this.pickupCooldowns = new Map()
    this.sync()
  }
  sync() {
    Object.assign(this.task, { counts: { ...this.counts }, issues: this.issues.slice(-12) })
  }
  get handoffRequested() {
    return this.handoffController.signal.aborted
  }
  requestHandoff() {
    this.handoffController.abort()
  }
  cancelHandoff() {
    this.handoffController = new AbortController()
  }
  // Workflows call this only after a stable physical boundary and durable operation accounting.
  checkpoint(data = {}) {
    if (!this.handoffRequested) return
    this.check()
    if (this.bot.currentWindow || this.bot.inventory?.selectedItem)
      throw Object.assign(new Error('Cannot hand off an open inventory operation.'), {
        code: 'HANDOFF_BLOCKED',
      })
    const checkpoint = {
      skillId: this.task.skillId,
      data,
      at: Date.now(),
      world: this.agent.state.world,
      dimension: this.agent.state.dimension,
    }
    this.agent.runtime?.saveCheckpoint(this, checkpoint)
    this.task.checkpoint ||= checkpoint
    const reason = Object.assign(new Error('Skill yielded at a safe checkpoint.'), {
      code: 'HANDOFF',
    })
    this.task.reasonCode = reason.code
    this.controller.abort(reason)
    throw reason
  }
  registerCleanup(cleanup, { label = 'Release task resource', timeoutMs = 1000 } = {}) {
    if (typeof cleanup !== 'function' || !Number.isFinite(timeoutMs) || timeoutMs <= 0)
      throw new TypeError('Cleanup needs a function and a positive timeout.')
    if (this.cleanupPromise)
      throw new Error('Cannot register resources after task cleanup started.')
    const entry = { cleanup, label, timeoutMs }
    this.cleanups.push(entry)
    return () => {
      this.cleanups = this.cleanups.filter((item) => item !== entry)
    }
  }
  cleanup({ timeoutMs = 5000 } = {}) {
    if (this.cleanupPromise) return this.cleanupPromise
    this.cleanupPromise = (async () => {
      const errors = [],
        deadline = Date.now() + Math.max(1, timeoutMs)
      for (const { cleanup, label, timeoutMs: limit } of this.cleanups.splice(0).reverse()) {
        let timer
        const controller = new AbortController()
        const operation = Promise.resolve().then(() => cleanup(controller.signal))
        // Observe late rejection even if a timeout wins; the socket will be retired before release.
        operation.catch(() => {})
        try {
          await Promise.race([
            operation,
            new Promise((_, reject) => {
              timer = setTimeout(
                () => {
                  const error = new Error(`${label} did not settle before its cleanup deadline.`)
                  controller.abort(error)
                  reject(error)
                },
                Math.max(1, Math.min(limit, deadline - Date.now())),
              )
            }),
          ])
        } catch (error) {
          errors.push(error)
        } finally {
          clearTimeout(timer)
        }
      }
      if (this.bot.currentWindow || this.bot.inventory?.selectedItem)
        errors.push(new Error('Task left an open inventory window or cursor item after cleanup.'))
      if (errors.length) {
        const error = Object.assign(
          new AggregateError(
            errors,
            `Task cleanup failed: ${errors.map((e) => e.message).join('; ')}`,
          ),
          { code: 'CLEANUP_FAILED', fatal: true },
        )
        this.task.reasonCode = error.code
        // A newer run must never inherit a window, cursor, or delayed request on this socket.
        try {
          if (this.agent.bot === this.bot) this.agent.disconnect()
          else closeBot(this.bot)
        } catch (closeError) {
          errors.push(closeError)
        }
        throw error
      }
    })()
    return this.cleanupPromise
  }
  recordEffect(effect) {
    // Detailed effects are bounded; task counts retain aggregate progress.
    this.effects.push({ ...structuredClone(effect), confirmedAt: Date.now() })
    if (this.effects.length > 256) this.effects.shift()
  }
  addIssue(text) {
    // Keep the state bounded, and avoid repeating the same obstruction on every pass.
    const repeated = this.issues.includes(text)
    this.issues = [...this.issues.filter((issue) => issue !== text), text].slice(-100)
    this.sync()
    if (!repeated) this.agent.log?.('task.obstacle', text, 'warn', { taskId: this.id })
  }
  // A task is obsolete if Stop was pressed, a newer task took over, or the connection changed.
  cancelled() {
    return (
      this.controller.signal.aborted ||
      this.agent.nav !== this.id ||
      this.agent.bot !== this.bot ||
      this.agent.state.connection !== 'ready'
    )
  }
  cancel(reason = null) {
    this.sync()
    if (!this.controller.signal.aborted) {
      const error = reason || new Error('Cancelled')
      error.code ||= 'CANCELLED'
      this.controller.abort(error)
    }
  }
  check() {
    if (this.cancelled()) {
      if (this.controller.signal.reason?.code === 'HANDOFF') throw this.controller.signal.reason
      const error = new Error('Cancelled')
      error.code = 'CANCELLED'
      throw error
    }
    if (Date.now() >= this.deadline) {
      const error = new Error('Work limit reached (five minutes).')
      error.fatal = true
      throw error
    }
  }
  progress(label) {
    this.check()
    const changed = this.task.label !== label
    this.task.label = label
    this.task.lastProgressAt = Date.now()
    this.sync()
    if (changed) this.agent.log?.('task.progress', label, 'info', { taskId: this.id })
    this.agent.publish()
  }
  async pause(ms = 200) {
    try {
      await sleep(ms, undefined, { signal: this.controller.signal })
    } catch (_) {
      this.check()
    }
    this.check()
  }
  // Run an operation with cancellation and a timeout. Cleanup must settle before another task starts.
  async timed(action, ms = 20000, label = 'Waiting for a game action') {
    this.check()
    const startedAt = Date.now(),
      limit = Math.max(1, Math.min(ms, this.deadline - startedAt))
    const activity = { label, startedAt, deadlineAt: startedAt + limit, status: 'running' }
    this.task.action = activity
    this.agent.log?.('action.start', label, 'info', { taskId: this.id, timeoutMs: limit })
    this.agent.publish()
    let timer,
      onAbort,
      settled = false
    const operation = Promise.resolve().then(() => {
      this.check()
      return action()
    })
    // Attach both handlers even if an abort wins, so late errors never escape unhandled.
    operation.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      },
    )
    const abort = new Promise((_, reject) => {
      onAbort = () => reject(this.controller.signal.reason)
      this.controller.signal.addEventListener('abort', onAbort, { once: true })
    })
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(
        () => {
          const error = new Error(
            `${label} timed out after ${Math.round(limit / 1000)} seconds. Reconnect if the server stopped responding.`,
          )
          error.fatal = true
          reject(error)
        },
        Math.max(1, activity.deadlineAt - Date.now()),
      )
    })
    try {
      const result = await Promise.race([operation, abort, timeout])
      this.check()
      activity.status = 'succeeded'
      this.task.lastProgressAt = Date.now()
      this.agent.log?.('action.complete', label, 'debug', {
        taskId: this.id,
        durationMs: Date.now() - startedAt,
      })
      return result
    } catch (error) {
      activity.status = ['CANCELLED', 'HANDOFF'].includes(error.code) ? 'cancelled' : 'failed'
      activity.error = error.message
      this.agent.log?.(
        'action.' + activity.status,
        `${label}: ${error.message}`,
        activity.status === 'cancelled' ? 'info' : 'error',
        { taskId: this.id, durationMs: Date.now() - startedAt },
      )
      if (error.fatal || ['CANCELLED', 'HANDOFF'].includes(error.code)) {
        // Invalidate subsequent steps before a timed-out route or equip settles.
        if (!this.controller.signal.aborted) this.controller.abort(error)
        this.bot.pathfinder.setGoal(null)
        this.bot.stopDigging()
        this.bot.clearControlStates()
        // Never wait forever for a library promise. A short cleanup grace period
        // keeps normal Stop connected; a hung action retires only its own socket.
        if (!settled) {
          let grace
          await Promise.race([
            operation.catch(() => {}),
            new Promise((resolve) => {
              grace = setTimeout(resolve, 250)
            }),
          ])
          clearTimeout(grace)
        }
        if (!settled) {
          if (this.agent.bot === this.bot) this.agent.disconnect()
          else closeBot(this.bot)
        }
      }
      throw error
    } finally {
      activity.endedAt = Date.now()
      clearTimeout(timer)
      this.controller.signal.removeEventListener('abort', onAbort)
      this.agent.publish()
    }
  }
  async travel(goal, label, limit = 60000) {
    return new Travel(this, limit).go(goal, label)
  }
  async approach(pos, options = {}) {
    this.check()
    const goal = new BlockApproachGoal(this.bot, pos, options)
    if (!goal.isEnd(workingCell(this.bot)) || !canView(this.bot, pos))
      await this.travel(goal, `Walk or swim to block ${key(pos)}`)
    // goto() may resolve for an empty path, so require reach and line of sight.
    const block = this.bot.blockAt(pos)
    if (
      !block ||
      (!options.interaction && !this.bot.canDigBlock(block) && block.name !== 'farmland')
    )
      throw new Error('Target is not in reach.')
    if (!canView(this.bot, pos)) throw new Error('No reachable view of the block.')
  }
  async equip(item) {
    await this.timed(
      () => (item ? this.bot.equip(item, 'hand') : this.bot.unequip('hand')),
      5000,
      item ? `Equip ${item.displayName || item.name}` : 'Use empty hands',
    )
  }
  // Recheck the block and tool after turning, then require a server-confirmed removal.
  async dig(
    pos,
    expected,
    predicate = () => true,
    acceptsTool = () => true,
    safeDescent = () => false,
  ) {
    this.check()
    let block = this.bot.blockAt(pos)
    if (!block || block.name !== expected || !predicate(block))
      throw new Error('Target changed before mining.')
    if (!block.diggable || block.hardness < 0) throw new Error(`${block.name} cannot be mined.`)
    const feet = this.bot.entity.position.floored()
    if (pos.x === feet.x && pos.z === feet.z && pos.y === feet.y - 1 && !safeDescent())
      throw new Error('Standing on this block; move aside before mining it.')
    this.tools ||= new TaskTool(this.bot)
    await this.tools.equipForBlock(block, { work: this, accepts: acceptsTool })
    block = this.bot.blockAt(pos)
    if (!block || block.name !== expected || !predicate(block))
      throw new Error('Target changed while equipping.')
    // Do the turn outside dig(). Stop cannot leave a delayed turn that starts a new dig.
    await this.timed(
      () => this.bot.lookAt(pos.offset(0.5, 0.5, 0.5)),
      5000,
      `Turn toward ${expected} at ${key(pos)}`,
    )
    this.check()
    block = this.bot.blockAt(pos)
    if (!block || block.name !== expected || !predicate(block))
      throw new Error('Target changed before digging.')
    const now = this.bot.entity.position.floored()
    if (pos.x === now.x && pos.z === now.z && pos.y === now.y - 1 && !safeDescent())
      throw new Error('Standing on this block; move aside before mining it.')
    if (!this.bot.canDigBlock(block) || !canView(this.bot, pos))
      throw new Error('Target moved out of reach or view before digging.')
    if (this.bot.game.gameMode !== 'creative' && !block.canHarvest(this.bot.heldItem?.type ?? null))
      throw new Error('The required tool is no longer equipped.')
    const airStates = ['air', 'cave_air', 'void_air'].map(
      (name) => this.bot.registry.blocksByName[name]?.minStateId,
    )
    const confirmation = watchBlock(
      this.bot,
      pos,
      (state) => airStates.includes(state),
      this.controller.signal,
    )
    try {
      await this.timed(
        () => this.bot.dig(block, 'ignore'),
        30000,
        `Dig ${block.name} at ${key(pos)}`,
      )
      await this.timed(
        () => confirmation.promise,
        4000,
        `Wait for server to confirm removal at ${key(pos)}`,
      )
      await this.pause(50)
      if (!air(this.bot.blockAt(pos)))
        throw new Error('The block was replaced before removal could be verified.')
    } finally {
      if (confirmation.confirmed)
        this.recordEffect({ kind: 'block_removed', block: expected, position: { ...pos } })
      confirmation.cleanup()
    }
  }
  issue(pos, e) {
    if (e.fatal || e.code === 'HANDOFF') throw e
    this.check()
    this.addIssue(`${key(pos)}: ${e.message}`)
  }
  // Try nearby dropped items briefly. Missing one drop must not stall the entire skill.
  async pickup(pos) {
    if (this.bot.game.gameMode === 'creative') return
    for (const [id, until] of this.pickupCooldowns)
      if (until <= Date.now() || !this.bot.entities[id]) this.pickupCooldowns.delete(id)
    const drops = Object.values(this.bot.entities)
      .filter(
        (e) =>
          e.name === 'item' && !this.pickupCooldowns.has(e.id) && e.position.distanceTo(pos) < 3,
      )
      .sort(
        (a, b) =>
          a.position.distanceTo(this.bot.entity.position) -
          b.position.distanceTo(this.bot.entity.position),
      )
      .slice(0, 3)
    for (const entity of drops) {
      this.check()
      if (!this.bot.entities[entity.id]) continue
      let collected = false
      const onCollect = (collector, item) => {
        if (collector.id === this.bot.entity.id && item.id === entity.id) collected = true
      }
      this.bot.on('playerCollect', onCollect)
      const previousMoves = this.bot.pathfinder.movements
      const pickupMoves = new TravelMovements(this.bot)
      pickupMoves.allowFarmland = true
      pickupMoves.allowParkour = false
      this.bot.pathfinder.setMovements(pickupMoves)
      try {
        // Items bob on farmland/slabs and float in water. Their floored cell
        // may be inside solid ground: approach collection range, not that cell.
        const goal = new PickupGoal(this.bot, entity)
        const travel = new Travel(this, 10000, { optional: true })
        const itemCell = entity.position.floored()
        if (
          this.bot.blockAt(itemCell)?.name === 'water' &&
          this.bot.blockAt(itemCell.offset(0, 1, 0))?.name === 'water'
        ) {
          travel.activity.status = 'skipped'
          throw new Error('Waiting for submerged drops to float into reachable water')
        }
        if (this.bot.entity.isInWater) await travel.surface()
        if (this.bot.pathfinder.getPathFromTo) {
          const route = await travel.path(
            this.bot.pathfinder.movements,
            this.bot.entity.position,
            goal,
          )
          if (!route) {
            travel.activity.status = 'skipped'
            throw new Error('No short pickup route')
          }
        }
        if (!collected && this.bot.entities[entity.id])
          await travel.go(goal, `Collect nearby dropped item ${entity.id}`)
        // The server applies a pickup delay to fresh drops; remain close long
        // enough to observe collection instead of immediately walking away.
        for (let wait = 0; wait < 8 && !collected && this.bot.entities[entity.id]; wait++)
          await this.pause(100)
        if (!collected && this.bot.entities[entity.id]) {
          this.pickupCooldowns.set(entity.id, Date.now() + 60000)
          this.addIssue(
            `Some dropped items were not confirmed in ${this.agent.username}’s inventory; retrying after a one-minute cooldown.`,
          )
        }
      } catch (error) {
        if (error.fatal) throw error
        this.check()
        if (!collected && this.bot.entities[entity.id]) {
          this.pickupCooldowns.set(entity.id, Date.now() + 60000)
          this.addIssue(
            'Some dropped items could not be reached; continuing work and retrying after a one-minute cooldown.',
          )
        }
      } finally {
        this.bot.off('playerCollect', onCollect)
        if (this.agent.bot === this.bot && this.agent.nav === this.id)
          this.bot.pathfinder.setMovements(previousMoves)
      }
    }
  }
  async mine(c) {
    let positions, name
    const center = this.bot.entity.position.clone()
    if (c.type === 'mineArea') {
      if (center.distanceTo(c.min) > 64 || center.distanceTo(c.max) > 64)
        throw new Error('Move within 64 blocks of both area corners first.')
      positions = []
      for (let y = c.max.y; y >= c.min.y; y--)
        for (let x = c.min.x; x <= c.max.x; x++)
          for (let z = c.min.z; z <= c.max.z; z++) positions.push(new Vec3(x, y, z))
    } else {
      name = blockName(this.bot, c.name)
      positions = this.bot.findBlocks({
        point: center,
        matching: this.bot.registry.blocksByName[name].id,
        maxDistance: c.radius,
        count: 512,
      })
    }
    let pending = positions,
      pass = 0
    // Retry blocked targets after a successful pass exposes more of the same selection.
    while (pending.length && pass++ < 512) {
      this.check()
      let progress = 0
      const failed = []
      pending.sort(
        (a, b) =>
          b.y - a.y ||
          a.distanceTo(this.bot.entity.position) - b.distanceTo(this.bot.entity.position),
      )
      for (const pos of pending) {
        this.check()
        this.checkpoint({ phase: 'before-mine', target: { ...pos }, counts: { ...this.counts } })
        if (c.type === 'mineType' && this.counts.mined >= c.count) return
        if (c.type === 'mineArea' && this.counts.mined >= 512) {
          this.counts.skipped = positions.filter((p) => !air(this.bot.blockAt(p))).length
          if (this.counts.skipped)
            this.addIssue('Stopped after 512 removals; some positions refilled or remain blocked.')
          return
        }
        const block = this.bot.blockAt(pos)
        if (air(block)) continue
        if (name && block?.name !== name) continue
        if (!block) {
          this.addIssue(`${key(pos)}: terrain is not loaded.`)
          failed.push(pos)
          continue
        }
        this.progress(`Mining ${block.name} · ${this.counts.mined} removed`)
        try {
          if (this.bot.inventory.emptySlotCount() === 0 && this.bot.game.gameMode !== 'creative')
            throw new Error('Inventory is full. Make space before mining.')
          await this.approach(pos)
          await this.dig(pos, block.name)
          this.counts.mined++
          this.sync()
          progress++
        } catch (e) {
          this.issue(pos, e)
          failed.push(pos)
          continue
        }
        await this.pickup(pos)
        this.checkpoint({ phase: 'mined', target: { ...pos }, counts: { ...this.counts } })
      }
      if (!progress) {
        this.counts.skipped = failed.length
        break
      }
      pending = c.type === 'mineArea' ? positions : failed
    }
    if (c.type === 'mineType' && this.counts.mined < c.count)
      this.addIssue(
        `Requested ${c.count}; only ${this.counts.mined} matching blocks could be mined in loaded terrain.`,
      )
  }
  seed(crop) {
    return this.bot.inventory.items().find((i) => i.name === crop.seed && i.count > 0)
  }
  async plant(soilPos, crop) {
    this.check()
    const soil = this.bot.blockAt(soilPos),
      above = this.bot.blockAt(soilPos.offset(0, 1, 0)),
      seed = this.seed(crop)
    if (soil?.name !== 'farmland' || !air(above))
      throw new Error('Planting spot changed or is not empty farmland.')
    if (!seed) throw new Error(`Need ${crop.seed} to replant.`)
    await this.equip(seed)
    this.check()
    // Pre-turn and revalidate, then use the pinned Mineflayer placement helper with
    // forceLook ignored so a cancelled turn cannot send a later placement packet.
    await this.timed(
      () => this.bot.lookAt(soilPos.offset(0.5, 1, 0.5)),
      5000,
      `Turn toward planting spot ${key(soilPos)}`,
    )
    this.check()
    if (
      this.bot.blockAt(soilPos)?.name !== 'farmland' ||
      !air(this.bot.blockAt(soilPos.offset(0, 1, 0)))
    )
      throw new Error('Planting spot changed before placing.')
    if (this.bot.heldItem?.name !== crop.seed || !this.seed(crop))
      throw new Error('Planting stock changed before placing.')
    const planted = soilPos.offset(0, 1, 0),
      range = this.bot.registry.blocksByName[crop.block]
    const confirmation = watchBlock(
      this.bot,
      planted,
      (state) => state >= range.minStateId && state <= range.maxStateId,
      this.controller.signal,
    )
    try {
      await this.timed(
        () =>
          placeBlockWithOptions(this.bot, this.bot.blockAt(soilPos), new Vec3(0, 1, 0), {
            forceLook: 'ignore',
            swingArm: 'right',
          }),
        7000,
        `Plant ${crop.block} at ${key(soilPos)}`,
      )
      await this.timed(() => confirmation.promise, 4000, `Confirm planted ${crop.block}`)
      if (this.bot.blockAt(planted)?.name !== crop.block)
        throw new Error('Planting was not confirmed.')
      this.counts.planted++
      this.sync()
    } finally {
      if (confirmation.confirmed)
        this.recordEffect({ kind: 'block_placed', block: crop.block, position: { ...planted } })
      confirmation.cleanup()
    }
  }
  async farm(c) {
    const all = c.crop === 'all',
      selected = all ? Object.values(CROPS) : [CROPS[c.crop]]
    // A farm pass must not jump/drop onto crops or trample farmland while travelling.
    const previous = this.bot.pathfinder.movements,
      moves = new TravelMovements(this.bot)
    this.bot.pathfinder.setMovements(moves)
    try {
      const spots = this.bot.findBlocks({
        matching: this.bot.registry.blocksByName.farmland.id,
        maxDistance: c.radius,
        count: 256,
      })
      // Harvest first so newly gathered seeds can be used for empty plots afterward.
      spots.sort(
        (a, b) =>
          Number(air(this.bot.blockAt(a.offset(0, 1, 0)))) -
            Number(air(this.bot.blockAt(b.offset(0, 1, 0)))) ||
          a.distanceTo(this.bot.entity.position) - b.distanceTo(this.bot.entity.position),
      )
      for (const soil of spots) {
        this.check()
        this.checkpoint({ phase: 'before-crop', position: { ...soil }, counts: { ...this.counts } })
        let block = this.bot.blockAt(soil.offset(0, 1, 0))
        const crop =
          selected.find((x) => mature(block, x)) ||
          (air(block) ? selected.find((x) => this.seed(x)) : null)
        if (!crop && air(block)) {
          this.counts.skipped++
          this.addIssue(`No planting stock for empty farmland at ${key(soil)}.`)
        }
        if (!crop) continue // Never harvest immature crops or a different selected crop.
        this.progress(
          `Tending ${crop.block} · ${this.counts.harvested} harvested, ${this.counts.planted} planted`,
        )
        try {
          // Reserve planting material before harvesting, even if the harvest might drop seeds.
          if (!this.seed(crop))
            throw new Error(
              `Give ${this.agent.username} ${crop.seed}; mature crops are left intact without replanting stock.`,
            )
          if (this.bot.inventory.emptySlotCount() === 0 && this.bot.game.gameMode !== 'creative')
            throw new Error('Inventory is full; make room for the harvest.')
          await this.approach(soil)
          block = this.bot.blockAt(soil.offset(0, 1, 0))
          if (!this.seed(crop))
            throw new Error(
              `Planting stock disappeared before harvest; give ${this.agent.username} ${crop.seed}.`,
            )
          if (this.bot.blockAt(soil)?.name !== 'farmland')
            throw new Error('Farmland changed before harvest.')
          if (mature(block, crop)) {
            await this.dig(
              block.position,
              crop.block,
              (b) =>
                mature(b, crop) && !!this.seed(crop) && this.bot.blockAt(soil)?.name === 'farmland',
            )
            this.counts.harvested++
            this.sync()
          } else if (!air(block)) throw new Error('Crop changed or is not ripe.')
          await this.plant(soil, crop)
          await this.pickup(soil.offset(0, 1, 0))
          // Harvest/replant is one unit: a handoff must not leave a crop bare between its two steps.
          this.checkpoint({ phase: 'replanted', position: { ...soil }, counts: { ...this.counts } })
        } catch (e) {
          this.issue(soil, e)
          this.counts.skipped++
        }
      }
    } finally {
      // Do not replace movement settings belonging to a newer task after cancellation.
      if (this.agent.nav === this.id && previous) this.bot.pathfinder.setMovements(previous)
    }
  }
  async run(c) {
    const onCollect = (collector) => {
      if (!this.cancelled() && collector.id === this.bot.entity.id) {
        this.counts.collectedStacks++
        this.sync()
        this.agent.publish()
      }
    }
    this.bot.on('playerCollect', onCollect)
    try {
      if (c.type === 'farm') await this.farm(c)
      else await this.mine(c)
      this.check()
      const partial =
        this.counts.skipped > 0 || (c.type === 'mineType' && this.counts.mined < c.count)
      const empty = !this.counts.mined && !this.counts.harvested && !this.counts.planted
      this.task.status = partial ? 'partial' : 'succeeded'
      this.sync()
      this.agent.say(
        `${partial ? 'Partially complete' : empty ? 'Nothing ready to work on' : 'Complete'}: ${this.counts.mined} mined, ${this.counts.harvested} harvested, ${this.counts.planted} planted, ${this.counts.skipped} skipped.${this.issues.length ? ' ' + this.issues.at(-1) : ''}`,
      )
    } catch (error) {
      this.sync()
      if (error.code === 'HANDOFF') {
        this.task.status = 'cancelled'
        this.task.reasonCode = 'HANDOFF'
        throw error
      }
      if (error.code === 'CANCELLED') return
      if (this.agent.state.task !== this.task) return
      // A timeout may already have retired the session; preserve the actual failure.
      this.task.status = 'failed'
      this.addIssue(error.message)
      this.agent.say(`Work stopped: ${error.message}`)
      if (error.fatal) throw error
    } finally {
      this.bot.off('playerCollect', onCollect)
      if (this.agent.bot === this.bot && this.agent.nav === this.id) {
        this.bot.pathfinder.setGoal(null)
        this.bot.stopDigging()
        this.bot.clearControlStates()
      }
      this.sync()
    }
  }
}
module.exports = { Work, parseWork, chooseTool, mature, CROPS, blockName }
