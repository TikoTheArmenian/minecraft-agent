/**
 * THE COORDINATOR: connects one player, receives commands, and starts skills.
 * this.bot is the live Mineflayer connection; this.state is the dashboard snapshot.
 * SkillRunner owns physical work. Supervisor chooses registered skills; LlmChat explains state.
 */

const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const path = require('node:path')
const mineflayer = require('mineflayer')
const { pathfinder } = require('mineflayer-pathfinder')
const { ping } = require('minecraft-protocol')
const { blockName } = require('../runtime/work.cjs')
const { localPort, closeBot } = require('../minecraft/connection.cjs')
const { readWaypoints } = require('../world/waypoints.cjs')
const { installBreathing } = require('../minecraft/breathing.cjs')
const { LlmChat } = require('../messaging/llm-chat.cjs')
const { skills, skillFor, parseSkill } = require('../skills/registry.cjs')
const { parseControl, addressed, receiveControl } = require('../messaging/skill-chat.cjs')
const { Colony } = require('../storage/colony.cjs')
const { MapStore, surroundings, players } = require('../world/observations.cjs')
const { ActivityLog, survivalAvailability } = require('../infra/activity-log.cjs')
const { enchantments, installToolCompatibility } = require('../minecraft/item-tools.cjs')
const { TravelMovements, installReliableGoto } = require('../navigation/travel.cjs')

const { parse } = require('../runtime/text-commands.cjs')

class Agent extends EventEmitter {
  constructor({
    username = 'Marc',
    createBot = mineflayer.createBot,
    statusPing = ping,
    dataDir = path.join(__dirname, '..', '..', 'data'),
    spawnTimeoutMs = 20000,
    logToConsole = false,
    colony = new Colony(),
    apiCosts = null,
    profile = null,
    resourceLeases = null,
    peerDirectory = null,
    supervisorOptions = {},
  } = {}) {
    super()
    username = profile?.username || username
    this.username = username
    const profiles = require('./profiles.cjs')
    this.profile = profiles.publicProfile(
      profiles.resolveProfile(
        profile ||
          profiles.profileFor(username) || {
            id: username.toLowerCase(),
            username,
            skill: 'farmer',
          },
      ),
    )
    this.id = this.profile.id
    this.resourceLeases =
      resourceLeases || new (require('../runtime/resource-leases.cjs').ResourceLeases)()
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
    this.coordination = new (require('../messaging/colony-chat.cjs').ColonyChat)(this)
    this.llm = new LlmChat(this)
    this.runtime = new (require('../runtime/skill-runner.cjs').SkillRunner)(this)
    this.installMessaging(peerDirectory)
    this.commands = new (require('../runtime/command-service.cjs').CommandService)(this)
    this.progressObserver = new (require('../runtime/progress.cjs').ProgressObserver)(this)
    const scheduler =
      supervisorOptions.scheduler ||
      new (require('../supervisor/inference-scheduler.cjs').InferenceScheduler)({
        file: path.join(dataDir, 'supervisor-usage.json'),
      })
    this.supervisor = new (require('../supervisor/supervisor.cjs').Supervisor)(this, {
      ...supervisorOptions,
      scheduler,
    })
    for (const event of ['skill.result', 'skill.blocked', 'skill.progress', 'observation.changed'])
      this.on(event, (value) => this.supervisor.enqueue(event, value))
    this.log('server.ready', 'Controller started. No task is running.')
  }
  get activeWork() {
    return this.runtime ? this.runtime.active : this._activeWork
  }
  set activeWork(value) {
    if (this.runtime) this.runtime.active = value
    else this._activeWork = value
  }
  get pendingSkill() {
    return this.runtime ? this.runtime.pending : this._pendingSkill
  }
  set pendingSkill(value) {
    if (this.runtime) this.runtime.pending = value
    else this._pendingSkill = value
  }
  currentSkillNeeds() {
    const type = this.activeWork?.task?.skillId || this.profile.defaultInvocation.skillId
    const definition = require('../skills/registry.cjs').actionFor(type)
    return {
      profession: definition?.profession || this.profile.preferredProfession,
      tools: definition?.tools || [],
      supplies: definition?.supplies || {},
    }
  }
  installMessaging(directory) {
    const { PeerDirectory } = require('../messaging/peer-directory.cjs')
    const { MessageRouter } = require('../messaging/message-router.cjs')
    this.peerDirectory = (
      directory || new PeerDirectory({ agents: () => this.fleet || { [this.id]: this } })
    ).forAgent(this)
    this.messages = new MessageRouter(this, { directory: this.peerDirectory })
    this.messages.on('delivery', (delivery) => this.emit('message.delivery', delivery))
    this.messages.on('message', (message) => this.supervisor?.enqueue('peer.message', message))
    this.messages.on('issue', (issue) =>
      this.log(
        'messaging.issue',
        typeof issue === 'string' ? issue : issue.message || issue.code,
        'warn',
      ),
    )
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
    this.progressObserver.tick()
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
    for (const key of [
      'survival',
      'wheatFarm',
      'treeFarm',
      'oreFinder',
      'sugarcaneFarm',
      'mobKiller',
      'terraformer',
      'smelter',
    ])
      this.state[key] = null
    this.messages?.reset()
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
        if (
          !this.coordination.receive(bot, username, message, 'chat') &&
          !this.messages.receive(bot, username, message, 'chat') &&
          !receiveControl(this, bot, username, message)
        )
          void this.llm.receive(bot, username, message).catch(() => {})
      })
      bot.on('whisper', (username, message) => {
        if (
          !this.coordination.receive(bot, username, message, 'whisper') &&
          !this.messages.receive(bot, username, message, 'whisper') &&
          !receiveControl(this, bot, username, message, true)
        )
          void this.llm.receive(bot, username, message, true).catch(() => {})
      })
      const current = () => epoch === this.epoch && this.bot === bot
      require('../minecraft/teleport.cjs').installTeleportHandling(this, bot, current)
      require('../world/volume.cjs').trackPath(bot)
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
            `Server disconnected ${this.username}: ${typeof reason === 'string' ? reason : JSON.stringify(reason)}`,
          )
      })
      bot.on('death', () => {
        if (!current()) return
        this.stop(false, 'DEATH')
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
        this.stop(false, 'DIMENSION_CHANGED')
        ++this.spawnGeneration
        this.clearScene()
        this.state.connection = 'loading'
        this.armSpawnTimeout(epoch)
        this.publish()
      })
      bot.on('spawn', async () => {
        if (!current()) return
        const generation = ++this.spawnGeneration
        this.stop(false, 'SPAWN')
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
  stop(announce = true, reason = 'HUMAN_STOP') {
    return this.runtime.stop(announce, reason)
  }
  disconnect() {
    this.messages?.reset()
    this.llm?.cancel()
    const wasConnected = this.state.connection !== 'disconnected'
    ++this.epoch
    ++this.spawnGeneration
    clearTimeout(this.spawnTimer)
    this.stop(false, 'DISCONNECTED')
    const bot = this.bot
    this.bot = null
    this.baseMovements = null
    // Retiring the whole connection isolates any old asynchronous equipment request.
    this.activeWork = null
    this.runtime.publish()
    this.clearScene()
    this.state.connection = 'disconnected'
    closeBot(bot)
    if (wasConnected) this.log('connection.end', `${this.username} disconnected.`)
    else this.publish()
  }
  navigate(target, options = {}) {
    return this.runtime.start({ type: 'goto', ...target }, options)
  }
  startWork(command, options = {}) {
    return this.runtime.start(command, options)
  }
  acceptExchange(command, session) {
    if (session.works[0]?.task?.source === 'supervisor') {
      const policy = this.supervisor?.snapshot()
      if (
        !session.automatic ||
        policy?.mode !== 'autonomous' ||
        policy.paused ||
        !this.profile.allowedSkills.includes('exchange')
      )
        throw new Error(
          'This peer has not delegated autonomous surplus exchanges; its human assignment takes priority.',
        )
    }
    return this.runtime.start(command, { source: 'peer', internalSession: session })
  }
  controlSkill(control, context = {}) {
    if (control.type === 'skillHelp') {
      const reply = `Skills: ${skills.map((s) => s.label).join(', ')}. Use start <skill>, switch to <skill>, start, or stop.`
      this.say(reply)
      return reply
    }
    if (control.type === 'stop') {
      this.stop()
      return 'Stopped.'
    }
    const defaultInvocation = this.profile.defaultInvocation
    const type =
      control.skill || this.lastInvocation?.type || this.lastSkill || defaultInvocation.skillId
    const skill = skillFor(type)
    if (!skill) throw new Error('Unknown skill. Send skills to see the available skills.')
    const command =
      control.command ||
      (!control.skill && this.lastInvocation) ||
      (type === defaultInvocation.skillId
        ? { type, ...defaultInvocation.args }
        : parseSkill(skill.aliases[0]))
    this.runtime.validate(command)
    this.lastSkill = type
    this.lastInvocation = JSON.parse(JSON.stringify(command))
    if (context.source !== 'supervisor') this.supervisor?.pause('HUMAN_ASSIGNMENT')
    if (this.workActive) {
      this.runtime.switch(command, context)
      const reply = `Switching to ${skill.label} after the current action finishes at a safe handoff.`
      this.say(reply)
      return reply
    }
    this.startWork(command, context)
    const reply =
      this.state.task?.status === 'failed' ? this.state.task.label : `Started ${skill.label}.`
    this.say(reply)
    return reply
  }
  startPendingSkill() {
    return this.runtime.drainPending()
  }
  command(text, context = {}) {
    // The web conversation can target any named bot, just like Minecraft chat.
    for (const agent of Object.values(this.fleet || { self: this })) {
      const body = addressed(text, agent.username)
      if (body !== null) return agent.command(body, context)
    }
    const control = parseControl(text)
    if (control && !/^(help|commands)$/i.test(String(text).trim()))
      return this.controlSkill(control, context)
    const c = parse(text)
    if (c.type === 'supervisor') {
      if (context.source && context.source !== 'human')
        throw new Error('Supervisor settings require a human command.')
      if (c.action === 'objective') this.supervisor.configure({ objective: c.objective })
      else if (['pause', 'resume'].includes(c.action)) this.supervisor[c.action]()
      else if (c.action !== 'status') this.supervisor.configure({ mode: c.action })
      const s = this.supervisor.snapshot()
      const reply = `Supervisor ${s.mode}${s.paused ? ' (paused)' : ''}. Objective: ${s.objective || 'none'}.${c.action === 'objective' ? ' Use supervisor shadow or supervisor autonomous, then supervisor resume.' : ''}`
      this.say(reply)
      return reply
    }
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
      return this.startWork(c, context)
    if (c.type === 'goto') return this.navigate(c, context)
    if (c.type === 'waypoint') {
      const p = Object.hasOwn(this.state.waypoints, c.name) ? this.state.waypoints[c.name] : null
      if (!p)
        throw new Error('Unknown destination. Use “save base” at the bot’s current location first.')
      return this.navigate(p, context)
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
