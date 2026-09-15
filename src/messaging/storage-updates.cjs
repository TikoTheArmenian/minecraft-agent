const { createHash } = require('node:crypto')
const coords = (p) => `${p.x} ${p.y} ${p.z}`
const layoutDigest = (locations) =>
  createHash('sha256').update(JSON.stringify(locations)).digest('hex')

/** Human-readable storage updates retain their visible chat, with complete-batch validation. */
class StorageUpdates {
  constructor(coordinator) {
    this.coordinator = coordinator
  }
  lines(locations) {
    const checksum = layoutDigest(locations),
      revision = checksum.slice(0, 12)
    return [
      `Storage update ${revision} begins; ${locations.length} locations; digest ${checksum}.`,
      ...locations.map(
        (location, i) =>
          `Store ${location.category} at ${coords(location.position)} for ${revision} part ${i + 1}/${locations.length}.`,
      ),
      `Remember storage update ${revision}; return surplus every 5 minutes or when nearly full.`,
    ]
  }
  prune() {
    const c = this.coordinator
    for (const [name, pending] of c.pending)
      if (
        pending.scope !== c.scope() ||
        pending.epoch !== c.agent.epoch ||
        pending.peerEpoch !== c.peer(name)?.epoch ||
        pending.expiresAt <= Date.now()
      )
        c.pending.delete(name)
  }
  receive(name, text, channel) {
    const c = this.coordinator
    let match = text.match(
      /^Storage update ([a-f0-9]{12}) begins; (\d{1,2}) locations; digest ([a-f0-9]{64})\.$/,
    )
    if (match) {
      const count = Number(match[2])
      if (count > 0 && count <= 32 && c.pending.size < 16)
        c.pending.set(name, {
          revision: match[1],
          count,
          digest: match[3],
          parts: new Map(),
          scope: c.scope(),
          epoch: c.agent.epoch,
          peerEpoch: c.peer(name).epoch,
          channel,
          expiresAt: Date.now() + 120000,
        })
      return true
    }
    match = text.match(
      /^Store (tools|wood|building|food|materials|overflow) at (-?\d+) (-?\d+) (-?\d+) for ([a-f0-9]{12}) part (\d{1,2})\/(\d{1,2})\.$/,
    )
    if (match) {
      const pending = c.pending.get(name),
        [x, y, z] = match.slice(2, 5).map(Number),
        index = Number(match[6]),
        count = Number(match[7])
      if (
        pending &&
        pending.channel === channel &&
        pending.revision === match[5] &&
        count === pending.count &&
        index > 0 &&
        index <= count &&
        Math.abs(x) <= 30000000 &&
        y >= -64 &&
        y <= 319 &&
        Math.abs(z) <= 30000000
      ) {
        const location = { category: match[1], position: { x, y, z } },
          previous = pending.parts.get(index)
        if (previous && JSON.stringify(previous) !== JSON.stringify(location))
          c.pending.delete(name)
        else {
          pending.parts.set(index, location)
          this.commit(name)
        }
      }
      return true
    }
    match = text.match(
      /^Remember storage update ([a-f0-9]{12}); return surplus every 5 minutes or when nearly full\.$/,
    )
    if (match) {
      const pending = c.pending.get(name)
      if (pending?.revision === match[1] && pending.channel === channel) {
        pending.committed = true
        this.commit(name)
      }
      return true
    }
    // Uncounted old-format batches cannot establish completeness.
    return /^(Storage update |Store (tools|wood|building|food|materials|overflow) at )/.test(text)
  }
  commit(name) {
    const c = this.coordinator,
      pending = c.pending.get(name)
    if (!pending?.committed || pending.parts.size !== pending.count) return
    const locations = Array.from({ length: pending.count }, (_, i) => pending.parts.get(i + 1))
    if (
      locations.some((p) => !p) ||
      new Set(locations.map((p) => coords(p.position))).size !== locations.length ||
      layoutDigest(locations) !== pending.digest ||
      pending.digest.slice(0, 12) !== pending.revision
    ) {
      c.pending.delete(name)
      c.agent.log?.(
        'colony.chat.invalid',
        'Storage update failed completeness or digest validation.',
        'warn',
      )
      return
    }
    c.recall().storage = {
      revision: pending.revision,
      locations,
      scope: pending.scope,
      coordinator: name,
      returnEveryMs: 300000,
      learnedAt: Date.now(),
    }
    c.save()
    c.say(name, `Remembered storage update ${pending.revision}.`, pending.channel)
    c.pending.delete(name)
  }
}
module.exports = { StorageUpdates, layoutDigest }
