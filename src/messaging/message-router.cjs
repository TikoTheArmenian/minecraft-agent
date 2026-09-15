const { EventEmitter } = require('node:events')
const { createHash, randomUUID } = require('node:crypto')
const { directoryFor } = require('./peer-directory.cjs')

const KINDS = new Set(['observation', 'request', 'proposal', 'accept', 'result', 'ack'])
const digest = (text) => createHash('sha256').update(text).digest('hex').slice(0, 24)
const token = (value) => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(value)
const scope = (agent) => JSON.stringify([agent.state.world, agent.state.dimension])
const asciiJson = (value) =>
  JSON.stringify(value).replace(
    /[\u007f-\uffff]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  )

/** Bounded transport and inbox. Receiving a peer message never invokes a command. */
class MessageRouter extends EventEmitter {
  constructor(
    agent,
    {
      directory,
      now = Date.now,
      intervalMs = 1600,
      maxFrameLength = 220,
      maxQueue = 256,
      maxInbox = 64,
      maxAssemblies = 32,
      maxParts = 64,
      maxBytes = 8192,
      ttlMs = 120000,
    } = {},
  ) {
    super()
    this.agent = agent
    this.directory = directory?.forAgent ? directory.forAgent(agent) : directory
    this.now = now
    Object.assign(this, {
      intervalMs,
      maxFrameLength,
      maxQueue,
      maxInbox,
      maxAssemblies,
      maxParts,
      maxBytes,
      ttlMs,
    })
    this.queue = []
    this.inbox = []
    this.assemblies = new Map()
    this.seen = new Map()
    this.deliveries = new Map()
    this.nextSend = 0
    this.identity = null
  }
  peers() {
    return this.directory || directoryFor(this.agent)
  }
  issue(code, message) {
    this.emit('issue', { code, message })
  }
  reset() {
    for (const entry of this.deliveries.values())
      this.emit('delivery', { id: entry.id, status: 'cancelled', reason: 'SESSION_CHANGED' })
    this.queue.length = 0
    this.inbox.length = 0
    this.assemblies.clear()
    this.seen.clear()
    this.deliveries.clear()
    this.identity = { bot: this.agent.bot, epoch: this.agent.epoch, scope: scope(this.agent) }
    this.nextSend = 0
  }
  refresh() {
    const a = this.agent
    if (
      !this.identity ||
      this.identity.bot !== a.bot ||
      this.identity.epoch !== a.epoch ||
      this.identity.scope !== scope(a)
    )
      this.reset()
    const now = this.now()
    this.inbox = this.inbox.filter(
      (message) =>
        message.expiresAt > now && this.peers().get(message.from)?.epoch === message.epoch,
    )
    for (const [key, entry] of this.assemblies) {
      const peer = this.peers().get(entry.sender)
      if (entry.expiresAt <= now || !peer || peer.epoch !== entry.epoch) this.assemblies.delete(key)
    }
    for (const [key, until] of this.seen) if (until <= now) this.seen.delete(key)
    for (const [id, entry] of this.deliveries) {
      const stalePeer = Object.entries(entry.recipientEpochs).some(
        ([name, epoch]) => this.peers().get(name)?.epoch !== epoch,
      )
      if (entry.expiresAt <= now || stalePeer) {
        this.deliveries.delete(id)
        this.queue = this.queue.filter((frame) => frame.id !== id)
        this.emit('delivery', {
          id,
          status: stalePeer ? 'cancelled' : 'expired',
          reason: stalePeer ? 'PEER_SESSION_CHANGED' : 'RECEIPT_NOT_CONFIRMED',
        })
      }
    }
  }
  send({
    to,
    channel = 'chat',
    kind = 'observation',
    payload,
    conversationId = randomUUID(),
    replyTo,
    expiresAt = this.now() + this.ttlMs,
  } = {}) {
    this.refresh()
    const a = this.agent,
      now = this.now(),
      peer = this.peers().get(to)
    if (a.state.connection !== 'ready' || !a.bot)
      throw new Error('Messaging needs a ready connection.')
    if (!['chat', 'whisper'].includes(channel) || (to === 'broadcast' && channel !== 'chat'))
      throw new Error('Choose chat or a named whisper recipient.')
    if (to !== 'broadcast' && !peer)
      throw new Error('The recipient is not a connected peer in this world and dimension.')
    if (!KINDS.has(kind) || !token(conversationId) || (replyTo !== undefined && !token(replyTo)))
      throw new Error('Invalid message kind or correlation identifier.')
    if (!Number.isFinite(expiresAt) || expiresAt <= now || expiresAt > now + this.ttlMs)
      throw new Error('Message expiry is outside the allowed window.')
    const recipients = to === 'broadcast' ? this.peers().list() : [peer]
    if (!recipients.length || recipients.length > 32)
      throw new Error('Messaging needs 1–32 connected recipients.')
    const id = randomUUID(),
      recipient = peer?.username || 'broadcast'
    const recipientEpochs = Object.fromEntries(recipients.map((p) => [p.username, p.epoch]))
    const message = {
      version: 1,
      id,
      conversationId,
      ...(replyTo ? { replyTo } : {}),
      from: a.username,
      to: recipient,
      channel,
      worldId: a.state.world,
      dimension: a.state.dimension,
      epoch: a.epoch,
      recipientEpochs,
      sentAt: now,
      expiresAt,
      kind,
      payload,
    }
    const body = asciiJson(message)
    if (body.length > this.maxBytes) throw new Error('Message exceeds the bounded payload size.')
    // Mineflayer subtracts `/tell <name> ` from its 256-character packet limit.
    const protocolLimit = a.bot.supportFeature?.('lessCharsInChat') ? 100 : 256
    const frameLimit = Math.min(
      this.maxFrameLength,
      protocolLimit - (channel === 'whisper' ? `/tell ${recipient} `.length : 0),
    )
    const checksum = digest(body)
    const chunkSize =
      frameLimit - `[mc1 ${id} ${this.maxParts}/${this.maxParts} ${checksum}] `.length
    if (chunkSize < 8) throw new Error('Chat packet size is too small for this message protocol.')
    const count = Math.ceil(body.length / chunkSize)
    if (count > this.maxParts) throw new Error('Message needs too many transport fragments.')
    if (this.queue.length + count > this.maxQueue || this.deliveries.size >= this.maxInbox) {
      this.issue('QUEUE_FULL', 'Outgoing message rejected: the bounded queue is full.')
      throw new Error('Outgoing message queue is full.')
    }
    for (let index = 0; index < count; index++)
      this.queue.push({
        id,
        channel,
        to: recipient,
        recipients: recipients.map((p) => ({ name: p.username, epoch: p.epoch })),
        expiresAt,
        text: `[mc1 ${id} ${index + 1}/${count} ${checksum}] ${body.slice(index * chunkSize, (index + 1) * chunkSize)}`,
      })
    if (kind !== 'ack')
      this.deliveries.set(id, {
        id,
        conversationId,
        channel,
        expiresAt,
        recipientEpochs,
        recipients: new Set(recipients.map((p) => p.username)),
        received: new Set(),
      })
    this.emit('delivery', { id, status: 'queued' })
    return { id, conversationId, status: 'queued', fragments: count }
  }
  tick() {
    this.refresh()
    const a = this.agent
    if (a.state.connection !== 'ready' || !a.bot || this.now() < this.nextSend) return
    while (this.queue.length) {
      const frame = this.queue.shift()
      const valid =
        frame.expiresAt > this.now() &&
        frame.recipients.every((p) => this.peers().get(p.name)?.epoch === p.epoch)
      if (!valid) {
        this.queue = this.queue.filter((q) => q.id !== frame.id)
        this.deliveries.delete(frame.id)
        this.emit('delivery', { id: frame.id, status: 'cancelled', reason: 'PEER_SESSION_CHANGED' })
        continue
      }
      try {
        if (frame.channel === 'whisper') a.bot.whisper(frame.to, frame.text)
        else a.bot.chat(frame.text)
        this.nextSend = this.now() + this.intervalMs
        if (!this.queue.some((q) => q.id === frame.id))
          this.emit('delivery', { id: frame.id, status: 'sent' })
      } catch (error) {
        this.queue = this.queue.filter((q) => q.id !== frame.id)
        this.deliveries.delete(frame.id)
        this.issue('SEND_FAILED', error.message)
        this.emit('delivery', { id: frame.id, status: 'failed', reason: 'SEND_FAILED' })
      }
      return
    }
  }
  receive(bot, sender, text, channel = 'chat') {
    this.refresh()
    const a = this.agent,
      peer = this.peers().get(sender),
      now = this.now()
    if (
      bot !== a.bot ||
      a.state.connection !== 'ready' ||
      !peer ||
      typeof text !== 'string' ||
      !['chat', 'whisper'].includes(channel)
    )
      return false
    if (!text.startsWith('[mc1 ')) return this.receivePlain(peer, text, channel)
    const match = text.match(
      /^\[mc1 ([a-zA-Z0-9_-]{1,64}) (\d{1,3})\/(\d{1,3}) ([a-f0-9]{24})\] ([\s\S]*)$/,
    )
    if (!match || text.length > this.maxFrameLength) {
      this.issue('INVALID_FRAME', 'Rejected a malformed peer message fragment.')
      return true
    }
    const [, id, partText, countText, checksum, part] = match,
      index = Number(partText),
      count = Number(countText)
    const key = `${peer.username}:${peer.epoch}:${id}`
    if (this.seen.has(key)) return true
    if (index < 1 || index > count || count > this.maxParts) return true
    let entry = this.assemblies.get(key)
    if (!entry) {
      if (this.assemblies.size >= this.maxAssemblies) {
        this.issue('ASSEMBLY_FULL', 'Incoming fragments rejected: too many incomplete messages.')
        return true
      }
      entry = {
        sender: peer.username,
        epoch: peer.epoch,
        count,
        checksum,
        channel,
        parts: new Map(),
        bytes: 0,
        expiresAt: now + this.ttlMs,
      }
      this.assemblies.set(key, entry)
    }
    if (
      entry.count !== count ||
      entry.checksum !== checksum ||
      entry.channel !== channel ||
      (entry.parts.has(index) && entry.parts.get(index) !== part)
    ) {
      this.assemblies.delete(key)
      this.issue(
        'CONFLICTING_FRAGMENT',
        'Rejected inconsistent fragments for the same peer message.',
      )
      return true
    }
    if (!entry.parts.has(index)) {
      entry.parts.set(index, part)
      entry.bytes += part.length
    }
    if (entry.bytes > this.maxBytes) {
      this.assemblies.delete(key)
      return true
    }
    if (entry.parts.size !== count) return true
    this.assemblies.delete(key)
    const body = Array.from({ length: count }, (_, i) => entry.parts.get(i + 1)).join('')
    let message
    try {
      if (digest(body) !== checksum) throw new Error('digest')
      message = JSON.parse(body)
    } catch {
      this.issue('INVALID_MESSAGE', 'Peer message checksum or JSON validation failed.')
      return true
    }
    if (
      message.version !== 1 ||
      message.id !== id ||
      message.from !== peer.username ||
      message.epoch !== peer.epoch ||
      message.channel !== channel ||
      (message.to !== a.username && !(message.to === 'broadcast' && channel === 'chat')) ||
      message.recipientEpochs?.[a.username] !== a.epoch ||
      message.worldId !== a.state.world ||
      message.dimension !== a.state.dimension ||
      !KINDS.has(message.kind) ||
      !token(message.conversationId) ||
      (message.replyTo !== undefined && !token(message.replyTo)) ||
      !Number.isFinite(message.sentAt) ||
      !Number.isFinite(message.expiresAt) ||
      message.sentAt > now + 5000 ||
      message.expiresAt <= now ||
      message.expiresAt - message.sentAt > this.ttlMs ||
      message.expiresAt <= message.sentAt
    )
      return true
    if (this.seen.size >= this.maxInbox * 8) {
      this.issue('DEDUP_FULL', 'Incoming message rejected: deduplication capacity reached.')
      return true
    }
    if (message.kind === 'ack') {
      const sent = this.deliveries.get(message.replyTo)
      if (
        sent?.recipients.has(peer.username) &&
        sent.channel === channel &&
        sent.conversationId === message.conversationId &&
        message.payload?.received === message.replyTo
      ) {
        sent.received.add(peer.username)
        this.emit('delivery', { id: sent.id, status: 'received', by: peer.username })
        if (sent.received.size === sent.recipients.size) this.deliveries.delete(sent.id)
      }
      this.seen.set(key, message.expiresAt)
      return true
    }
    if (this.inbox.length >= this.maxInbox) {
      this.issue(
        'INBOX_FULL',
        'Incoming message rejected: the inbox is full; no receipt was acknowledged.',
      )
      return true
    }
    this.seen.set(key, message.expiresAt)
    this.inbox.push(message)
    this.emit('message', message)
    try {
      this.send({
        to: peer.username,
        channel,
        kind: 'ack',
        payload: { received: id },
        conversationId: message.conversationId,
        replyTo: id,
      })
    } catch (error) {
      this.issue('ACK_NOT_QUEUED', error.message)
    }
    return true
  }
  receivePlain(peer, text, channel) {
    let body = text
    if (channel === 'chat') {
      const prefix = `${this.agent.username}: `
      if (!text.startsWith(prefix)) return false
      body = text.slice(prefix.length)
    }
    if (!body.trim() || body.length > 500) return false
    const key = `plain:${peer.username}:${peer.epoch}:${channel}:${digest(body)}`
    if (this.seen.has(key)) return true
    if (this.inbox.length >= this.maxInbox || this.seen.size >= this.maxInbox * 8) {
      this.issue('INBOX_FULL', 'Incoming conversation rejected: the inbox is full.')
      return true
    }
    const now = this.now(),
      message = {
        version: 1,
        id: randomUUID(),
        conversationId: randomUUID(),
        from: peer.username,
        to: this.agent.username,
        channel,
        worldId: this.agent.state.world,
        dimension: this.agent.state.dimension,
        epoch: peer.epoch,
        sentAt: now,
        expiresAt: now + this.ttlMs,
        kind: 'observation',
        payload: { text: body },
        unframed: true,
      }
    this.seen.set(key, now + 5000)
    this.inbox.push(message)
    this.emit('message', message)
    return true
  }
  drain(limit = this.maxInbox) {
    this.refresh()
    return this.inbox.splice(0, Math.max(0, Math.min(limit, this.maxInbox)))
  }
}

module.exports = { MessageRouter, digest }
