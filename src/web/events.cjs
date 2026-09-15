/** Named SSE events, with periodic full-state snapshots for reconnects. */
const { EVENT_TYPES, eventEnvelope } = require('../infra/events.cjs')
const SNAPSHOT_MS = 5000
const MAX_BUFFER_BYTES = 256 * 1024

function eventOptions(query) {
  const events = query.events ?? EVENT_TYPES.join(',')
  if (typeof events !== 'string' || events.length > 512)
    throw new Error('events must be a comma-separated list of event types, or none.')
  const types = events === 'none' ? [] : [...new Set(events.split(','))]
  if (types.some((type) => !EVENT_TYPES.includes(type)))
    throw new Error(`Unknown event type. Choose ${EVENT_TYPES.join(', ')}, or none.`)
  const value = query.snapshotMs ?? String(SNAPSHOT_MS)
  const snapshotMs = Number(value)
  if (
    typeof value !== 'string' ||
    !/^\d+$/.test(value) ||
    !Number.isSafeInteger(snapshotMs) ||
    snapshotMs < 100 ||
    snapshotMs > 60000
  )
    throw new Error('snapshotMs must be a whole number from 100 to 60000 milliseconds.')
  return { types, snapshotMs }
}

function stream(source, getSnapshot, envelope, req, res) {
  // Validate before sending headers so invalid subscriptions receive a JSON error.
  const { types, snapshotMs } = eventOptions(req.query)
  let closed = false,
    snapshots,
    heartbeat
  const listeners = new Map()
  const cleanup = () => {
    if (closed) return
    closed = true
    clearInterval(snapshots)
    clearInterval(heartbeat)
    for (const [type, listener] of listeners) source.off(type, listener)
  }
  const send = (frame) => {
    // Write events in order without a second queue; disconnect lagging readers.
    if (closed || res.destroyed || res.writableLength > MAX_BUFFER_BYTES) {
      cleanup()
      if (!res.destroyed) res.destroy()
      return false
    }
    res.write(frame)
    return true
  }
  const sendData = (payload, type = null) => {
    try {
      return send(`${type ? `event: ${type}\n` : ''}data: ${JSON.stringify(payload)}\n\n`)
    } catch {
      // A broken stream must never interrupt the work that published an event.
      cleanup()
      res.destroy()
      return false
    }
  }
  res.once('close', cleanup)
  res.once('error', cleanup)
  res.set({
    'Content-Type': 'text/event-stream',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  res.flushHeaders()
  // Unnamed frames retain the original EventSource.onmessage state contract.
  const snapshot = () => sendData(getSnapshot())
  if (!snapshot()) return
  for (const type of types) {
    const listener = (payload) => {
      sendData(envelope(type, payload), type)
    }
    listeners.set(type, listener)
    source.on(type, listener)
  }
  snapshots = setInterval(snapshot, snapshotMs)
  heartbeat = setInterval(() => send(': heartbeat\n\n'), 15000)
}

function streamEvents(agent, req, res) {
  stream(
    agent,
    () => agent.state,
    (type, payload) => eventEnvelope(type, agent.id, payload),
    req,
    res,
  )
}

const fleetSnapshot = (fleet) =>
  Object.fromEntries(
    Object.entries(fleet).map(([id, bot]) => [
      id,
      { ...bot.state, profile: bot.profile || { id, username: bot.username } },
    ]),
  )

function streamFleetEvents(fleet, req, res) {
  // The bus already stamped the envelope; all clients see the same bot and time.
  stream(
    fleet.events,
    () => fleetSnapshot(fleet),
    (_type, event) => event,
    req,
    res,
  )
}

module.exports = { streamEvents, streamFleetEvents, fleetSnapshot, EVENT_TYPES }
