/** Named, bounded colony conversations. Chat conveys observations and destinations, never code. */
const fs = require('node:fs')
const path = require('node:path')
const { Vec3 } = require('vec3')
const { directoryFor } = require('./peer-directory.cjs')
const { StorageUpdates, layoutDigest } = require('./storage-updates.cjs')
// Roles come from the fleet profile list so a new bot only needs one entry in src/agents/fleet.cjs.
const ROLES = Object.fromEntries(
  require('../agents/profiles.cjs').profiles.map((p) => [p.username, p.profession]),
)
const NEEDS = {
  farmer: ['iron_hoe', 'iron_shovel'],
  'tree farmer': ['iron_axe', 'iron_shovel'],
  'movement explorer': ['iron_pickaxe', 'iron_shovel'],
  'ore finder': ['iron_pickaxe', 'iron_shovel'],
  'sugarcane farmer': ['iron_shovel'],
  'mob killer': ['iron_sword'],
  terraformer: ['iron_shovel', 'iron_pickaxe'],
  smelter: ['iron_pickaxe'],
}
const SUPPLIES = {
  farmer: { wheat_seeds: 32, dirt: 128 },
  'tree farmer': { dirt: 128 },
  'movement explorer': { dirt: 128 },
  'ore finder': { torch: 16 },
  'sugarcane farmer': { sugar_cane: 8 },
  'mob killer': {},
  terraformer: { dirt: 128 },
  smelter: {},
}
function workingNeeds(agent) {
  if (typeof agent.currentSkillNeeds === 'function') return agent.currentSkillNeeds()
  const profile = agent.profile || require('../agents/profiles.cjs').profileFor(agent.username)
  const profession = profile?.preferredProfession || profile?.profession || 'general worker'
  return {
    profession,
    tools: [...(NEEDS[profession] || [])],
    supplies: { ...(SUPPLIES[profession] || {}) },
  }
}
function hasTool(items, name) {
  const tiers = ['wooden', 'golden', 'stone', 'iron', 'diamond', 'netherite']
  const split = name.indexOf('_'),
    tier = tiers.indexOf(name.slice(0, split)),
    kind = name.slice(split)
  return items.some(
    (i) =>
      i.count > 0 &&
      i.name.endsWith(kind) &&
      tiers.indexOf(i.name.slice(0, i.name.indexOf('_'))) >= tier,
  )
}
const coords = (p) => `${p.x} ${p.y} ${p.z}`
class ColonyChat {
  constructor(agent) {
    this.agent = agent
    this.file = path.join(agent.dataDir, 'colony-memory.json')
    try {
      this.memory = JSON.parse(fs.readFileSync(this.file, 'utf8'))
    } catch {
      this.memory = {}
    }
    this.queue = []
    this.nextSend = 0
    this.nextCheck = 0
    this.busy = false
    this.pending = new Map()
    this.storageUpdates = new StorageUpdates(this)
  }
  scope() {
    return JSON.stringify([this.agent.state.world, this.agent.state.dimension])
  }
  recall() {
    const profile =
      this.agent.profile || require('../agents/profiles.cjs').profileFor(this.agent.username)
    const role = profile?.preferredProfession || profile?.profession || 'general worker'
    const memory = (this.memory[this.scope()] ||= { role, peers: {} })
    memory.role = role
    return memory
  }
  directory() {
    return directoryFor(this.agent)
  }
  coordinator() {
    return (
      (
        this.agent.profile || require('../agents/profiles.cjs').profileFor(this.agent.username)
      )?.capabilities?.includes('storageCoordinator') || false
    )
  }
  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.memory, null, 2), { mode: 0o600 })
    fs.renameSync(this.file + '.tmp', this.file)
    this.agent.state.colonyMemory = this.recall()
  }
  enqueue(name, texts, channel = 'chat') {
    const peer = this.peer(name)
    if (!peer || !['chat', 'whisper'].includes(channel)) return false
    const limit =
      (this.agent.bot?.supportFeature?.('lessCharsInChat') ? 100 : 256) -
      (channel === 'whisper' ? `/tell ${name} `.length : 0)
    const entries = texts.map((text) => ({
      message: `${name}: ${text}`,
      name,
      channel,
      scope: this.scope(),
      epoch: this.agent.epoch,
      peerEpoch: peer.epoch,
      expiresAt: Date.now() + 120000,
    }))
    if (
      entries.some((q) => q.message.length > Math.min(250, limit)) ||
      this.queue.length + entries.length > 64
    ) {
      this.agent.log?.(
        'colony.chat.overflow',
        'Coordination batch deferred: message or queue limit reached.',
        'warn',
      )
      return false
    }
    this.queue.push(...entries)
    return true
  }
  say(name, text, channel = 'chat') {
    if (
      this.queue.some(
        (q) =>
          q.message === `${name}: ${text}` &&
          q.channel === channel &&
          q.scope === this.scope() &&
          q.epoch === this.agent.epoch,
      )
    )
      return true
    return this.enqueue(name, [text], channel)
  }
  peer(name) {
    return this.directory().get(name)
  }
  receive(bot, name, message, channel = 'chat') {
    this.storageUpdates.prune()
    const peer = this.peer(name),
      prefix = this.agent.username + ': '
    if (
      bot !== this.agent.bot ||
      !peer ||
      typeof message !== 'string' ||
      !['chat', 'whisper'].includes(channel) ||
      (channel === 'chat' && !message.startsWith(prefix))
    )
      return false
    const text = message.startsWith(prefix) ? message.slice(prefix.length) : message,
      m = this.recall()
    if (peer.capabilities.includes('storageCoordinator') && !this.coordinator()) {
      if (text === 'What do you do?') {
        this.say(name, `My role is ${m.role}.`, channel)
        return true
      }
      if (text === 'What do you have, and what do you need?') {
        const items = {}
        for (const i of bot.inventory.items()) items[i.name] = (items[i.name] || 0) + i.count
        const entries = Object.entries(items).map(([n, c]) => `${n}=${c}`)
        let part = []
        const replies = []
        for (const entry of entries) {
          if ([...part, entry].join(', ').length > 150) {
            replies.push(`Inventory: ${part.join(', ')}.`)
            part = []
          }
          part.push(entry)
        }
        replies.push(`Inventory: ${part.join(', ') || 'empty'}.`)
        const active = workingNeeds(this.agent)
        const needs = (active.tools || []).filter((n) => !hasTool(bot.inventory.items(), n))
        for (const [item, count] of Object.entries(active.supplies || {}))
          if ((items[item] || 0) < count) needs.push(item)
        replies.push(`Needs: ${[...new Set(needs)].join(', ') || 'none'}.`)
        this.enqueue(name, replies, channel)
        return true
      }
      if (this.storageUpdates.receive(name, text, channel)) return true
      if (/^(Get tools at |Requested supplies: )/.test(text)) {
        this.agent.log('colony.chat', `${name}: ${text}`)
        return true
      }
    }
    if (this.coordinator()) {
      const peer = (m.peers[name] ||= {})
      let match = text.match(/^My role is ([a-z ]{1,40})\.$/)
      if (match) {
        peer.role = match[1]
        peer.inventory = []
        this.save()
        this.say(name, 'What do you have, and what do you need?', channel)
        return true
      }
      match = text.match(/^Inventory: ([a-z0-9_=, ]+)\.$/)
      if (match) {
        peer.inventory ||= []
        peer.inventory.push(
          ...match[1]
            .split(', ')
            .filter((v) => /^[a-z_]+=\d+$/.test(v))
            .slice(0, 36 - peer.inventory.length),
        )
        peer.inventoryReport = peer.inventory.join(', ')
        peer.inventoryAt = Date.now()
        this.save()
        return true
      }
      match = text.match(/^Needs: ([a-z_, ]+)\.$/)
      if (match) {
        peer.needs =
          match[1] === 'none'
            ? []
            : match[1]
                .split(', ')
                .filter((n) => /^[a-z_]{1,48}$/.test(n))
                .slice(0, 24)
        peer.inventoryAt = Date.now()
        peer.reportReady = true
        peer.askedAt = 0
        this.save()
        this.nextCheck = 0
        return true
      }
      match = text.match(/^Remembered storage update ([a-f0-9]{12})\.$/)
      if (match && peer.sentRevision === match[1] && peer.sentEpoch === this.peer(name)?.epoch) {
        peer.ackRevision = match[1]
        peer.ackEpoch = peer.sentEpoch
        peer.ackAt = Date.now()
        this.save()
        return true
      }
    }
    return false
  }
  async tick() {
    this.storageUpdates.prune()
    const a = this.agent,
      now = Date.now()
    if (a.state.connection !== 'ready' || !a.bot) return
    if (this.queue.length && now >= this.nextSend) {
      const q = this.queue.shift()
      if (
        q.scope === this.scope() &&
        q.epoch === a.epoch &&
        q.peerEpoch === this.peer(q.name)?.epoch &&
        q.expiresAt > now
      ) {
        if (q.channel === 'whisper') a.bot.whisper(q.name, q.message)
        else a.bot.chat(q.message)
        a.log('colony.chat', q.message)
      }
      this.nextSend = now + 1600
    }
    if (!this.coordinator() || !a.colony?.enabled || now < this.nextCheck || this.busy) return
    this.nextCheck = now + 10000
    this.busy = true
    const scope = this.scope(),
      epoch = a.epoch
    try {
      const [data, { position: hub }] = await Promise.all([
        a.colony.call(a, 'list'),
        a.colony.call(a, 'hub_get'),
      ])
      if (scope !== this.scope() || epoch !== a.epoch || !hub) return
      const locations = data.containers
        .filter(
          (c) =>
            c.managed &&
            new Vec3(c.position.x, c.position.y, c.position.z).distanceTo(
              new Vec3(hub.x, hub.y, hub.z),
            ) <= 8,
        )
        .map((c) => ({
          category: c.category,
          position: { x: c.position.x, y: c.position.y, z: c.position.z },
        }))
        .sort((x, y) =>
          (x.category + coords(x.position)).localeCompare(y.category + coords(y.position)),
        )
      if (!locations.length) return
      if (locations.length > 32) {
        a.log(
          'colony.chat.overflow',
          'Storage layout exceeds the 32-location protocol bound.',
          'warn',
        )
        return
      }
      const checksum = layoutDigest(locations),
        revision = checksum.slice(0, 12)
      const memory = this.recall()
      for (const worker of this.directory().list()) {
        const name = worker.username
        if (!this.peer(name)) continue
        const peer = (memory.peers[name] ||= {})
        if (peer.connectionEpoch !== worker.epoch) {
          peer.connectionEpoch = worker.epoch
          peer.askedAt = 0
          peer.ackEpoch = null
        }
        if (now - (peer.askedAt || 0) < 90000) continue
        if (!peer.role) {
          if (this.say(name, 'What do you do?')) peer.askedAt = now
        } else if (!peer.reportReady || now - (peer.inventoryAt || 0) > 300000) {
          if (this.say(name, 'What do you have, and what do you need?')) {
            peer.inventory = []
            peer.reportReady = false
            peer.askedAt = now
          }
        } else if (
          peer.ackRevision !== revision ||
          peer.ackEpoch !== worker.epoch ||
          peer.needs?.join(',') !== peer.answeredNeeds
        ) {
          const lines = this.storageUpdates.lines(locations)
          const tool =
            locations.find((c) => c.category === 'tools') ||
            locations.find((c) => c.category === 'overflow')
          if (peer.needs?.length) {
            const available = peer.needs.filter((n) =>
              data.containers.some(
                (c) =>
                  locations.some((l) => coords(l.position) === coords(c.position)) &&
                  c.slots.some((i) => i.name === n && i.count > 0),
              ),
            )
            lines.splice(
              lines.length - 1,
              0,
              `Requested supplies: ${peer.needs.join(', ')}. Stocked now: ${available.join(', ') || 'none; waiting for materials'}.`,
            )
          }
          if (tool)
            lines.splice(
              lines.length - 1,
              0,
              `Get tools at ${coords(tool.position)}. I make replacement iron tools here.`,
            )
          if (this.enqueue(name, lines)) {
            peer.sentRevision = revision
            peer.sentEpoch = worker.epoch
            peer.askedAt = now
            peer.answeredNeeds = peer.needs?.join(',')
          }
        }
      }
      this.save()
    } catch (error) {
      a.log('colony.chat.error', error.message, 'warn')
    } finally {
      this.busy = false
    }
  }
  async returnSupplies(w) {
    const memory = this.recall(),
      policy = memory.storage
    if (Date.now() < (memory.nextSupplyAttemptAt || 0)) return
    try {
      await require('../capabilities/building-supplies.cjs').ensure(w)
      if (!policy || !this.agent.colony.enabled || this.coordinator()) return
      if (
        Date.now() - (memory.lastReturnAt || 0) < policy.returnEveryMs &&
        w.bot.inventory.emptySlotCount() >= 4
      )
        return
      // Run only at skill checkpoints; never interrupt a chest click or a tree climb.
      w.check()
      const storage = require('../storage/service.cjs')
      w.progress('Returning surplus to the shared storage coordinator’s locations.')
      await storage.store(w)
      for (const name of workingNeeds(this.agent).tools || [])
        if (!hasTool(w.bot.inventory.items(), name)) await storage.retrieve(w, [name], 1)
      memory.lastReturnAt = Date.now()
      memory.nextSupplyAttemptAt = 0
      this.save()
    } catch (error) {
      // Storage is a side trip, not evidence that the current tree is unreachable.
      // Stop, safety failures, and air recovery must still reach the skill runner.
      w.check()
      if (error.fatal || ['CANCELLED', 'AIR_RECOVERY', 'HANDOFF'].includes(error.code)) throw error
      memory.nextSupplyAttemptAt = Date.now() + 60000
      this.save()
      w.addIssue(`Supply trip deferred for one minute; continuing farm work. ${error.message}`)
    }
  }
}
module.exports = { ColonyChat, ROLES, NEEDS, SUPPLIES, hasTool, workingNeeds, layoutDigest }
