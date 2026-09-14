/**
 * THE COORDINATOR: connects one player, receives commands, and starts skills.
 * this.bot is the live Mineflayer connection; this.state is the dashboard snapshot.
 * Only one physical task owns this agent at a time. LLM chat explains state; it does not drive movement.
 */

const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const path = require('node:path')
const mineflayer = require('mineflayer')
const { pathfinder, goals } = require('mineflayer-pathfinder')
const { ping } = require('minecraft-protocol')
const { Work, parseWork, blockName } = require('./work.cjs')
const { localPort, closeBot } = require('./connection.cjs')
const { readWaypoints, validPoint } = require('./waypoints.cjs')
const { installBreathing } = require('./breathing.cjs')
const { LlmChat } = require('./llm-chat.cjs')
const { skills, skillFor, parseSkill } = require('./skills.cjs')
const { parseControl, addressed, receiveControl } = require('./skill-chat.cjs')
const { Colony } = require('./colony.cjs')
const { MapStore, surroundings, players } = require('./world.cjs')
const { ActivityLog, survivalAvailability } = require('./activity-log.cjs')
const { enchantments, installToolCompatibility } = require('./item-tools.cjs')
const { TravelMovements, installReliableGoto } = require('./travel.cjs')

// A small explicit vocabulary keeps commands predictable without an external AI service.
function parse(text) {
  const s = String(text || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[!?]$/, '')
  if (s.length > 200) throw new Error('Keep commands under 200 characters.')
  if (/^(stop|cancel|stop moving)$/.test(s)) return { type: 'stop' }
  if (/^(pos|position|status|where are you)$/.test(s)) return { type: 'status' }
  if (/^(help|commands)$/.test(s)) return { type: 'help' }
  if (/^(look around|scan|survey)$/.test(s)) return { type: 'scan' }
  const skill = parseSkill(s)
  if (skill) return skill
  const work = parseWork(s)
  if (work) return work
  let m = s.match(
    /^(?:go to|goto|move to)\s+(-?\d+(?:\.\d+)?)[ ,]+(-?\d+(?:\.\d+)?)[ ,]+(-?\d+(?:\.\d+)?)$/,
  )
  if (m) {
    const [x, y, z] = m.slice(1).map(Number)
    if (Math.abs(x) > 30000000 || Math.abs(z) > 30000000 || y < -64 || y > 320)
      throw new Error('Coordinates are outside this world’s supported range.')
    return { type: 'goto', x, y, z }
  }
  m = s.match(/^(?:go to|goto|move to|save as|save|remember|forget)\s+([a-z][a-z0-9 _-]{0,31})$/)
  if (m)
    return {
      type: /^(save|remember)/.test(s) ? 'save' : s.startsWith('forget') ? 'forget' : 'waypoint',
      name: m[1],
    }
  m = s.match(/^(?:find|search for)\s+([a-z_ ]+?)(?:\s+(?:within\s+)?(\d+)(?:\s+blocks)?)?$/)
  if (m) {
    const radius = Number(m[2] || 32)
    if (radius < 1 || radius > 64) throw new Error('Search within 1–64 blocks.')
    return { type: 'find', name: m[1].trim().replace(/ /g, '_'), radius }
  }
  throw new Error('Try “go to 20 64 -10”, “find oak logs”, “save base”, “go to base”, or “stop”.')
}

class Agent extends EventEmitter {
  constructor({
    username = 'Marc',
    createBot = mineflayer.createBot,
    statusPing = ping,
    dataDir = path.join(__dirname, '..', 'data'),
    spawnTimeoutMs = 20000,
    logToConsole = false,
    colony = new Colony(),
    apiCosts = null,
  } = {}) {
    super()
    this.username = username
    this.colony = colony
    this.apiCosts = apiCosts
    this.createBot = createBot
    this.statusPing = statusPing
    this.dataDir = dataDir
    this.spawnTimeoutMs = spawnTimeoutMs
    this.bot = null
    // These counters identify the connection, spawn, and task that currently own callbacks.
    this.epoch = 0
    this.spawnGeneration = 0
    this.nav = 0
    this.timer = null
    this.spawnTimer = null
    this.activeWork = null
    this.baseMovements = null
    this.state = {
      username,
      treeFarm: null,
      storage: { configured: colony.enabled },
      connection: 'disconnected',
      position: null,
      dimension: null,
      inventory: [],
      task: null,
      results: [],
      search: null,
      messages: [],
      waypoints: {},
      world: 'Agent Playground',
      busy: false,
      vitals: null,
      players: [],
      observation: null,
      survival: null,
      wheatFarm: null,
    }
    this.maps = new MapStore(this)
    this.saved = readWaypoints(dataDir)
    this.journal = new ActivityLog(dataDir, { consoleOutput: logToConsole })
    this.state.logs = []
    this.state.logFile = this.journal.file
    this.state.lastMovedAt = null
    this.coordination = new (require('./colony-chat.cjs').ColonyChat)(this)
    this.llm = new LlmChat(this)
    this.log('server.ready', 'Controller started. No task is running.')
  }
  get workActive() {
    return !!this.activeWork
  }
  publish() {
    this.state.busy = this.workActive
    this.state.surviveAvailability = survivalAvailability(this.state)
    this.state.updatedAt = Date.now()
    this.emit('state', this.state)
  }
  log(event, message, level = 'info', details = {}) {
    this.journal.write(event, message, level, details)
    this.state.logs = this.journal.entries.slice(-100)
    this.state.logError = this.journal.error
    this.publish()
  }
  say(text, role = 'bot', at = Date.now()) {
    this.state.messages.push({ text, role, at })
    this.state.messages.sort(
      (a, b) => a.at - b.at || Number(a.role !== 'user') - Number(b.role !== 'user'),
    )
    this.state.messages = this.state.messages.slice(-100)
    this.log(role === 'user' ? 'command' : 'bot.message', text)
  }
  position() {
    const p = this.bot?.entity?.position
    return p && [p.x, p.y, p.z].every(Number.isFinite) ? { x: p.x, y: p.y, z: p.z } : null
  }
  // Copy live Minecraft values into the plain objects the browser can display.
  refresh() {
    const previousMode = this.state.vitals?.gameMode
    const previous = this.state.position,
      next = this.position()
    if (
      next &&
      (!previous ||
        Math.hypot(next.x - previous.x, next.y - previous.y, next.z - previous.z) > 0.02)
    )
      this.state.lastMovedAt = Date.now()
    this.state.position = next
    const hotbarStart = this.bot?.QUICK_BAR_START ?? 36
    this.state.inventory = (this.bot?.inventory?.items() || []).map((i) => ({
      name: i.name,
      displayName: i.displayName || i.name.replaceAll('_', ' '),
      count: i.count,
      enchantments: enchantments(i, this.bot),
      slot: i.slot ?? null,
      hotbar: i.slot >= hotbarStart && i.slot < hotbarStart + 9 ? i.slot - hotbarStart + 1 : null,
      equipped:
        i === this.bot.heldItem || (Number.isInteger(i.slot) && i.slot === this.bot.heldItem?.slot),
    }))
    this.state.vitals = this.bot
      ? {
          health: this.bot.health ?? null,
          food: this.bot.food ?? null,
          oxygen: this.bot.oxygenLevel ?? null,
          time: this.bot.time?.timeOfDay ?? null,
          gameMode: this.bot.game?.gameMode,
        }
      : null
    this.state.players = players(this.bot)
    if (this.state.vitals?.gameMode && this.state.vitals.gameMode !== previousMode)
      this.log('game.mode', `${this.username} game mode: ${this.state.vitals.gameMode}.`)
    this.publish()
  }
  scan() {
    if (this.state.connection !== 'ready')
      throw new Error('Connect and wait for the world to load first.')
    this.state.observation = surroundings(this.bot)
    this.refresh()
    return this.state.observation
  }
  scope() {
    return `${this.state.world}:${this.state.dimension}`
  }
  waypoints() {
    this.state.waypoints = Object.hasOwn(this.saved, this.scope()) ? this.saved[this.scope()] : {}
  }
  clearScene() {
    Object.assign(this.state, {
      position: null,
      inventory: [],
      results: [],
      search: null,
      waypoints: {},
      dimension: null,
      vitals: null,
      players: [],
      observation: null,
      lastMovedAt: null,
    })
    this.maps.clear()
  }
  armSpawnTimeout(epoch) {
    clearTimeout(this.spawnTimer)
    this.spawnTimer = setTimeout(() => {
      if (this.epoch === epoch && this.state.connection !== 'ready') {
        this.say(
          'Connection timed out waiting for the world to load. Reopen the world to LAN and reconnect.',
        )
        this.disconnect()
      }
    }, this.spawnTimeoutMs)
  }
  // A connection has its own epoch number. Late events from a replaced connection are ignored.
  async connect(port, world = 'Agent Playground') {
    if (this.state.connection !== 'disconnected')
      throw new Error('Disconnect the current session first.')
    if (typeof world !== 'string' || !world.trim() || world.length > 64)
      throw new Error('Enter a world label (1–64 characters).')
    port = localPort(port)
    const epoch = ++this.epoch
    this.colonySession = require('node:crypto').randomUUID()
    this.state.storage = { configured: this.colony.enabled }
    this.clearScene()
    Object.assign(this.state, {
      connection: 'connecting',
      world: world.trim(),
      task: null,
      survival: null,
      wheatFarm: null,
      treeFarm: null,
    })
    this.log('connection.connect', `Connecting ${this.username} to local LAN port ${port}.`)
    try {
      const status = await this.statusPing({
        host: '127.0.0.1',
        port,
        version: '1.21.1',
        closeTimeout: 3000,
        noPongTimeout: 1000,
      })
      if (epoch !== this.epoch) return
      if (status.version?.protocol !== 767)
        throw new Error('Use the Agent Test installation (Minecraft 1.21.1).')
      if (status.players?.sample?.some((p) => p.name === this.username))
        throw new Error(`${this.username} is already connected. Quit its other session first.`)
      const bot = this.createBot({
        host: '127.0.0.1',
        port,
        username: this.username,
        auth: 'offline',
        version: '1.21.1',
      })
      this.bot = bot
      installToolCompatibility(bot)
      installBreathing(bot)
      bot.on('chat', (username, message) => {
        if (!this.coordination.receive(bot, username, message) &&
            !receiveControl(this, bot, username, message))
          void this.llm.receive(bot, username, message).catch(() => {})
      })
      bot.on('whisper', (username, message) => {
        if (!receiveControl(this, bot, username, message, true))
          void this.llm.receive(bot, username, message, true).catch(() => {})
      })
      const current = () => epoch === this.epoch && this.bot === bot
      require('./teleport.cjs').installTeleportHandling(this, bot, current)
      let lastPath = '',
        lastPathAt = 0
      bot.on('path_update', (result) => {
        if (!current() || this.state.task?.status !== 'running') return
        // A* emits partial results every physics slice. Keep progress readable
        // without flooding the log or sending dozens of full states per second.
        if (result.status === 'partial' && Date.now() - lastPathAt < 1000) return
        const message = `Path ${result.status || 'updated'}: ${result.path?.length || 0} steps${Number.isFinite(result.visitedNodes) ? `, ${result.visitedNodes} nodes checked` : ''}.`
        if (message === lastPath) return
        lastPath = message
        lastPathAt = Date.now()
        this.log(
          'path.update',
          message,
          result.status === 'noPath' || result.status === 'timeout' ? 'warn' : 'debug',
          { taskId: this.state.task.id },
        )
      })
      // Register lifecycle handlers before loading plugins, including initialization errors.
      bot.on('error', (err) => {
        if (current()) {
          this.say(`Connection error: ${err.message}`)
          this.disconnect()
        }
      })
      bot.on('end', () => {
        if (current()) {
          this.disconnect()
          this.say('Disconnected.')
        }
      })
      bot.on('kicked', (reason) => {
        if (current())
          this.say(
            `Server disconnected Marc: ${typeof reason === 'string' ? reason : JSON.stringify(reason)}`,
          )
      })
      bot.on('death', () => {
        if (!current()) return
        this.stop(false)
        ++this.spawnGeneration
        this.clearScene()
        this.state.connection = 'respawning'
        this.armSpawnTimeout(epoch)
        this.say('Died. Waiting for respawn; previous work stays cancelled.')
      })
      bot.on('game', () => {
        if (
          !current() ||
          !this.state.dimension ||
          this.state.dimension === String(bot.game.dimension)
        )
          return
        this.stop(false)
        ++this.spawnGeneration
        this.clearScene()
        this.state.connection = 'loading'
        this.armSpawnTimeout(epoch)
        this.publish()
      })
      bot.on('spawn', async () => {
        if (!current()) return
        const generation = ++this.spawnGeneration
        this.stop(false)
        this.clearScene()
        this.state.connection = 'loading'
        this.armSpawnTimeout(epoch)
        this.publish()
        try {
          await bot.waitForChunksToLoad()
          if (!current() || generation !== this.spawnGeneration) return
          const moves = new TravelMovements(bot)
          installReliableGoto(bot)
          this.baseMovements = moves
          bot.pathfinder.setMovements(moves)
          bot.pathfinder.thinkTimeout = 1000
          bot.pathfinder.tickTimeout = 5
          clearTimeout(this.spawnTimer)
          this.state.connection = 'ready'
          this.state.dimension = String(bot.game.dimension)
          this.waypoints()
          this.refresh()
          this.say('Connected. Ready to explore.')
        } catch (error) {
          if (current() && generation === this.spawnGeneration) {
            this.say(`World loading failed: ${error.message}`)
            this.disconnect()
          }
        }
      })
      this.armSpawnTimeout(epoch)
      bot.loadPlugin(pathfinder)
    } catch (error) {
      if (epoch === this.epoch) this.disconnect()
      throw error
    }
  }
  // Signal cancellation immediately; activeWork stays locked until its current promise settles.
  stop(announce = true) {
    this.pendingSkill = null
    ++this.nav
    clearTimeout(this.timer)
    this.activeWork?.cancel()
    this.bot?.pathfinder?.setGoal(null)
    this.bot?.stopDigging?.()
    this.bot?.deactivateItem?.()
    this.bot?.clearControlStates()
    if (this.baseMovements && this.bot) this.bot.pathfinder.setMovements(this.baseMovements)
    if (this.state.task?.status === 'running') this.state.task.status = 'cancelled'
    if (announce) this.say('Stopped.')
    else this.publish()
  }
  disconnect() {
    this.llm?.cancel()
    const wasConnected = this.state.connection !== 'disconnected'
    ++this.epoch
    ++this.spawnGeneration
    clearTimeout(this.spawnTimer)
    this.stop(false)
    const bot = this.bot
    this.bot = null
    this.baseMovements = null
    // Retiring the whole connection isolates any old asynchronous equipment request.
    this.activeWork = null
    this.clearScene()
    this.state.connection = 'disconnected'
    closeBot(bot)
    if (wasConnected) this.log('connection.end', 'Marc disconnected.')
    else this.publish()
  }
  navigate(target) {
    if (this.workActive)
      throw new Error(
        'A work action is still finishing. Use Stop, then wait a moment before starting another action.',
      )
    if (!validPoint(target)) throw new Error('Invalid destination coordinates.')
    const pos = this.position()
    if (Math.hypot(target.x - pos.x, target.y - pos.y, target.z - pos.z) > 256)
      throw new Error('Choose a destination within 256 blocks for this version.')
    this.stop(false)
    const id = this.nav
    const startedAt = Date.now()
    this.state.task = {
      id,
      status: 'running',
      label: `Walking to ${target.x}, ${target.y}, ${target.z}`,
      startedAt,
      deadlineAt: startedAt + 60000,
    }
    const work = new Work(this, id)
    work.deadline = startedAt + 60000
    work.task.deadlineAt = work.deadline
    this.activeWork = work
    const finish = (status, text) => {
      if (id !== this.nav) return
      clearTimeout(this.timer)
      this.bot.pathfinder.setGoal(null)
      this.bot.clearControlStates()
      this.state.task.status = status
      this.refresh()
      this.say(text)
    }
    this.timer = setTimeout(() => {
      if (id === this.nav) {
        this.stop(false)
        this.state.task.status = 'failed'
        this.say('Travel timed out after 60 seconds.')
      }
    }, 60000)
    // Some empty-path outcomes resolve without reaching the goal. Check the observed
    // block position ourselves before announcing arrival (goals use whole block cells).
    const goal = new goals.GoalNear(target.x, target.y, target.z, 1)
    Promise.resolve()
      .then(() => {
        if (id === this.nav) return work.travel(goal, 'Walk or swim to the selected destination')
      })
      .then(
        () => {
          if (id !== this.nav) return
          const p = this.position()
          const reached =
            p && goal.isEnd({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) })
          finish(
            reached ? 'succeeded' : 'failed',
            reached ? 'Arrived near the destination.' : 'No reachable route to that destination.',
          )
        },
        (e) => finish('failed', `Could not reach destination: ${e.message}`),
      )
      .finally(() => {
        if (this.activeWork === work) {
          this.activeWork = null
          this.publish()
          this.startPendingSkill()
        }
      })
    this.say(this.state.task.label)
  }
  // Choose a skill class, give it ownership of this task, and release ownership only when it finishes.
  startWork(command) {
    if (this.workActive)
      throw new Error(
        'A work action is still finishing. Use Stop, then wait a moment before starting another action.',
      )
    if (!['survival', 'creative'].includes(this.bot.game.gameMode))
      throw new Error('Mining and farming require Survival or Creative mode.')
    if (
      skillFor(command.type)?.mode === 'survival' &&
      this.bot.game.gameMode !== 'survival'
    )
      throw new Error(
        `This skill needs Survival mode. Run /gamemode survival ${this.username}, then try again.`,
      )
    if (command.type === 'storageCrafting') this.colony.scope(this)
    if (command.type === 'mineType') blockName(this.bot, command.name)
    this.stop(false)
    const id = this.nav
    this.state.task = {
      id,
      status: 'running',
      label:
        command.type === 'treeFarm'
          ? 'Starting tree farmer'
          : command.type === 'torches'
            ? 'Getting torches'
            : command.type === 'wheatFarm'
              ? 'FARMER: expanding wheat production'
              : command.type === 'survive'
                ? 'Starting survival'
                : command.type === 'farm'
                  ? `Farming ${command.crop}`
                  : skillFor(command.type)?.label || 'Mining',
      counts: {},
      issues: [],
    }
    const skill = skillFor(command.type)
    const work = skill ? skill.factory(this, id) : new Work(this, id)
    this.activeWork = work
    this.publish()
    // Identity checks prevent old cleanup from releasing the lock on a newer session.
    work
      .run(command)
      .catch((error) => {
        if (this.activeWork === work) {
          this.state.task.status = 'failed'
          this.log('task.error', error.message, 'error', { taskId: id })
          this.say(`Unexpected work error: ${error.message}`)
        }
      })
      .finally(() => {
        if (this.activeWork === work) {
          this.activeWork = null
          this.publish()
          this.startPendingSkill()
        }
      })
  }
  controlSkill(control) {
    if (control.type === 'skillHelp') {
      const reply = `Skills: ${skills.map(s => s.label).join(', ')}. Use start <skill>, switch to <skill>, start, or stop.`
      this.say(reply)
      return reply
    }
    if (control.type === 'stop') { this.stop(); return 'Stopped.' }
    if (this.state.connection !== 'ready') throw new Error('Connect and wait for the bot to spawn first.')
    const type = control.skill || this.lastSkill || ({ Jerry: 'treeFarm', Barneett: 'practiceMovement', Sam: 'storageCrafting' }[this.username] || 'wheatFarm')
    const skill = skillFor(type)
    if (!skill) throw new Error('Unknown skill. Send skills to see the available skills.')
    if (skill.mode === 'survival' && this.bot.game.gameMode !== 'survival')
      throw new Error(`This skill needs Survival mode. Run /gamemode survival ${this.username}, then try again.`)
    if (type === 'storageCrafting') this.colony.scope(this)
    const command = control.command || parseSkill(skill.aliases[0])
    this.lastSkill = type
    if (this.workActive) {
      this.stop(false)
      this.pendingSkill = { command, epoch: this.epoch, nav: this.nav }
      const reply = `Switching to ${skill.label} after the current action finishes.`
      this.say(reply)
      return reply
    }
    this.startWork(command)
    const reply = this.state.task?.status === 'failed'
      ? this.state.task.label
      : `Started ${skill.label}.`
    this.say(reply)
    return reply
  }
  startPendingSkill() {
    const pending = this.pendingSkill
    this.pendingSkill = null
    if (!pending || pending.epoch !== this.epoch || pending.nav !== this.nav || this.state.connection !== 'ready') return
    try { this.startWork(pending.command) }
    catch (error) { this.say(`Could not start skill: ${error.message}`) }
  }
  command(text) {
    // The web conversation can target any named bot, just like Minecraft chat.
    for (const agent of Object.values(this.fleet || { self: this })) {
      const body = addressed(text, agent.username)
      if (body !== null) return agent.command(body)
    }
    const control = parseControl(text)
    if (control && !/^(help|commands)$/i.test(String(text).trim())) return this.controlSkill(control)
    const c = parse(text)
    if (c.type === 'stop') return this.stop()
    if (c.type === 'help')
      return this.say(
        'Use the live map to select where to walk or mine. Commands: exchange with Jerry • give Jerry 16 dirt • trade Jerry 16 wheat for 8 oak_log • skills • start <skill> • switch to <skill> • turn on • storage and crafting • create storage wood • scan storage • store surplus • organize storage • craft stone_pickaxe 2 • manage storage x y z category • farm trees • get torches • farmer • survive • look around • find oak logs [radius] • save base • go to base • mine stone 16 within 32 • farm wheat 16 • position • stop. Survive gathers resources, crafts tools, collects exposed iron and food, and plants a starter farm.',
      )
    if (c.type === 'status')
      return this.say(
        this.position()
          ? `Position: ${Object.values(this.position())
              .map((n) => n.toFixed(1))
              .join(', ')}`
          : 'Not connected yet.',
      )
    if (this.state.connection !== 'ready')
      throw new Error('Connect and wait for the bot to spawn first.')
    if (c.type === 'scan') {
      this.scan()
      return this.say(
        'Survey updated: inventory, nearby resources, players, and threats are visible in the control room.',
      )
    }
    if (skillFor(c.type) || ['mineArea', 'mineType', 'farm'].includes(c.type))
      return this.startWork(c)
    if (c.type === 'goto') return this.navigate(c)
    if (c.type === 'waypoint') {
      const p = Object.hasOwn(this.state.waypoints, c.name) ? this.state.waypoints[c.name] : null
      if (!p)
        throw new Error('Unknown destination. Use “save base” at the bot’s current location first.')
      return this.navigate(p)
    }
    if (c.type === 'save' || c.type === 'forget') {
      const points = { ...this.state.waypoints }
      if (c.type === 'save') points[c.name] = this.position()
      else delete points[c.name]
      const next = { ...this.saved, [this.scope()]: points }
      fs.mkdirSync(this.dataDir, { recursive: true })
      const file = path.join(this.dataDir, 'waypoints.json')
      fs.writeFileSync(file + '.tmp', JSON.stringify(next, null, 2))
      fs.renameSync(file + '.tmp', file)
      this.saved = next
      this.waypoints()
      return this.say(c.type === 'save' ? `Saved ${c.name}.` : `Forgot ${c.name}.`)
    }
    if (c.type === 'find') {
      const names = this.bot.registry.blocksByName
      const name = blockName(this.bot, c.name)
      const positions = this.bot.findBlocks({
        matching: names[name].id,
        maxDistance: c.radius,
        count: 24,
      })
      this.state.search = {
        name,
        radius: c.radius,
        at: Date.now(),
        origin: this.position(),
        dimension: this.state.dimension,
      }
      this.state.results = positions
        .map((p) => ({
          name,
          x: p.x,
          y: p.y,
          z: p.z,
          distance: p.distanceTo(this.bot.entity.position),
          at: Date.now(),
          dimension: this.state.dimension,
        }))
        .sort((a, b) => a.distance - b.distance)
      this.say(
        `Found ${positions.length} ${name} blocks within ${c.radius} blocks in loaded terrain. Locations may include hidden blocks.`,
      )
    }
  }
}
module.exports = { Agent, parse }
