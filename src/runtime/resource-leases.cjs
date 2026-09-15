/** Host-local resource ownership. Durable skill journals, not this map, survive a process restart. */
const { randomUUID } = require('node:crypto')

class ResourceLeases {
  constructor() {
    this.records = new Map()
  }
  key(scope, resource) {
    return JSON.stringify([scope.world, scope.dimension, resource])
  }
  acquire(scope, resource, owner) {
    if (
      !scope ||
      typeof scope.world !== 'string' ||
      typeof scope.dimension !== 'string' ||
      !resource ||
      !owner?.agentId ||
      owner.runId === undefined
    )
      throw new Error(
        'A resource lease needs world, dimension, resource, agent and run identities.',
      )
    const key = this.key(scope, resource),
      previous = this.records.get(key)
    if (previous) {
      if (previous.owner.agentId === owner.agentId && previous.owner.runId === owner.runId)
        return previous
      if (previous.owner.agentId !== owner.agentId || !previous.retained)
        throw Object.assign(new Error(`${resource} is reserved by ${previous.owner.agentId}.`), {
          code: 'RESOURCE_BUSY',
        })
    }
    const lease = {
      key,
      token: randomUUID(),
      scope: { ...scope },
      resource,
      owner: { ...owner },
      retained: false,
    }
    this.records.set(key, lease)
    return lease
  }
  valid(lease) {
    return !!lease && this.records.get(lease.key)?.token === lease.token
  }
  retain(lease) {
    if (!this.valid(lease))
      throw Object.assign(new Error('Resource ownership was lost.'), {
        code: 'RESOURCE_LOST',
        fatal: true,
      })
    lease.retained = true
  }
  release(lease) {
    if (!this.valid(lease)) return false
    this.records.delete(lease.key)
    return true
  }
}

module.exports = { ResourceLeases }
