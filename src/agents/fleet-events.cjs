const { EventEmitter } = require('node:events')
const { EVENT_TYPES, eventEnvelope } = require('../infra/events.cjs')

/** One subscription point for every bot's public events, independent of HTTP. */
class FleetEvents extends EventEmitter {
  constructor() {
    super()
    this.sources = new Map()
  }
  attach(agent) {
    if (this.sources.has(agent)) return
    const listeners = new Map()
    for (const type of EVENT_TYPES) {
      const forward = (payload) => {
        // A recorder may keep this event after the agent mutates its live state.
        const event = eventEnvelope(type, agent.id, structuredClone(payload))
        this.emit('event', event)
        this.emit(type, event)
      }
      listeners.set(type, forward)
      agent.on(type, forward)
    }
    this.sources.set(agent, listeners)
  }
  detach(agent) {
    for (const [type, listener] of this.sources.get(agent) || []) agent.off(type, listener)
    this.sources.delete(agent)
  }
  close() {
    for (const agent of this.sources.keys()) this.detach(agent)
    this.removeAllListeners()
  }
}

function installFleetEvents(fleet) {
  if (!Object.hasOwn(fleet, 'events'))
    Object.defineProperty(fleet, 'events', { value: new FleetEvents() })
  if (!(fleet.events instanceof FleetEvents))
    throw new Error('The fleet events property is reserved for its event bus.')
  for (const agent of Object.values(fleet)) fleet.events.attach(agent)
  return fleet.events
}

module.exports = { FleetEvents, installFleetEvents }
