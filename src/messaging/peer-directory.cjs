/** The in-process adapter is the only messaging component that sees live fleet objects. */
const { randomUUID } = require('node:crypto')

const fallbacks = new WeakMap()
const sameWorld = (a, b) =>
  a.state.world === b.state.world && a.state.dimension === b.state.dimension

class PeerDirectory {
  constructor({ agents = () => [] } = {}) {
    this.agents = agents
    this.reservations = new WeakMap()
  }
  registerFleet(fleet) {
    this.agents = () => fleet
  }
  values() {
    return Object.values(typeof this.agents === 'function' ? this.agents() : this.agents)
  }
  forAgent(agent) {
    const directory = this
    return {
      list: () => directory.list(agent),
      get: (name) =>
        directory
          .list(agent)
          .find((peer) => peer.username.toLowerCase() === String(name).toLowerCase()),
      hasCapability: (name, capability) =>
        directory
          .list(agent)
          .some((peer) => peer.username === name && peer.capabilities.includes(capability)),
      requestExchange: (work, name, command, policy) =>
        directory.requestExchange(agent, work, name, command, policy),
      capabilities: () => [...(agent.profile?.capabilities || [])],
    }
  }
  list(agent) {
    return this.values()
      .filter(
        (peer) =>
          peer !== agent && peer.bot && peer.state.connection === 'ready' && sameWorld(agent, peer),
      )
      .map((peer) =>
        Object.freeze({
          id: peer.profile?.id || peer.username,
          username: peer.username,
          epoch: peer.epoch,
          world: peer.state.world,
          dimension: peer.state.dimension,
          capabilities: Object.freeze([...(peer.profile?.capabilities || [])]),
          profession:
            peer.profile?.preferredProfession || peer.profile?.profession || 'general worker',
          busy: Boolean(peer.workActive),
        }),
      )
  }
  requestExchange(agent, work, name, command, { eligible, plan }) {
    work.check()
    if (agent.activeWork && agent.activeWork !== work)
      throw new Error('Exchange no longer owns the initiating bot.')
    if (this.reservations.has(agent)) throw new Error('This bot already has an exchange agreement.')
    const candidates = this.values()
      .filter(
        (peer) =>
          (!name || peer.username.toLowerCase() === name.toLowerCase()) &&
          !this.reservations.has(peer) &&
          eligible(agent, peer),
      )
      .sort(
        (a, b) =>
          a.bot.entity.position.distanceTo(work.bot.entity.position) -
          b.bot.entity.position.distanceTo(work.bot.entity.position),
      )
    if (!candidates.length)
      throw new Error(
        'No available partner within 32 blocks in this world. Stop the partner’s current skill and keep both bots connected in Survival mode.',
      )
    let peer, agreement, reason
    for (const candidate of candidates) {
      try {
        agreement = plan(agent, candidate, command)
        peer = candidate
        break
      } catch (error) {
        reason = error
      }
    }
    if (!peer) throw reason
    // No await is allowed between checking both owners and admitting the participant.
    // A busy peer is never cancelled to make room for an exchange.
    const id = randomUUID()
    this.reservations.set(agent, id)
    this.reservations.set(peer, id)
    let finish
    const done = new Promise((resolve) => {
      finish = resolve
    })
    const session = {
      ...agreement,
      id,
      works: [work],
      records: [],
      world: agent.state.world,
      dimension: agent.state.dimension,
      done,
      resolve: () => {
        if (this.reservations.get(agent) === id) this.reservations.delete(agent)
        if (this.reservations.get(peer) === id) this.reservations.delete(peer)
        finish()
      },
    }
    work.session = session
    try {
      if (!eligible(agent, peer))
        throw new Error('The partner became unavailable before accepting the exchange.')
      if (typeof peer.acceptExchange === 'function')
        peer.acceptExchange({ type: 'exchange' }, session)
      else peer.startWork({ type: 'exchange', invitation: session }) // Older runtime adapter.
      if (session.works.length !== 2) throw new Error('The partner could not accept the exchange.')
      return session
    } catch (error) {
      session.resolve()
      throw error
    }
  }
}

function directoryFor(agent) {
  if (agent.peerDirectory)
    return typeof agent.peerDirectory.forAgent === 'function'
      ? agent.peerDirectory.forAgent(agent)
      : agent.peerDirectory
  // Compatibility composition for tests and the terminal entry point. Fleet objects
  // are consulted only in this adapter, never returned from public directory reads.
  const fleet = agent.fleet || agent
  let directory = fallbacks.get(fleet)
  if (!directory) {
    directory = new PeerDirectory({ agents: () => agent.fleet || { self: agent } })
    fallbacks.set(fleet, directory)
  }
  return directory.forAgent(agent)
}

module.exports = { PeerDirectory, directoryFor }
