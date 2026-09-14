/** Backend-only shared Colony transport. No process-local locks or authoritative cache. */
const { randomUUID } = require('node:crypto')
class Colony {
  constructor({
    url = process.env.SUPABASE_URL,
    key = process.env.SUPABASE_SECRET_KEY,
    worlds = process.env.COLONY_WORLDS,
    fetchImpl = fetch,
  } = {}) {
    this.url = url?.replace(/\/$/, '')
    this.key = key
    this.worlds = typeof worlds === 'string' ? JSON.parse(worlds) : worlds || {}
    this.resolvedWorlds = new Map()
    this.fetch = fetchImpl
    this.enabled = !!(url || key || Object.keys(this.worlds).length)
  }
  scope(agent) {
    if (!this.url || !this.key)
      throw new Error(
        'Configure SUPABASE_URL and SUPABASE_SECRET_KEY before using storage.',
      )
    const label = agent.state.world
    if (typeof label !== 'string' || !label.trim() || label.length > 64)
      throw new Error('Choose a world label before using storage.')
    if (!agent.state.dimension)
      throw new Error('Connect to a dimension before using storage.')
    return {
      label: label.trim(),
      dimension: agent.state.dimension,
      bot: agent.username,
      session: (agent.colonySession ||= randomUUID()),
    }
  }
  async resolveWorld(label) {
    // This cache only saves round trips. Postgres's unique label resolves races across processes.
    if (!this.resolvedWorlds.has(label)) {
      const existing = this.worlds[label]
      const pending = this.request('colony_resolve_world', {
        p_label: label,
        p_existing_id: /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(
          existing || '',
        )
          ? existing
          : null,
      }).catch((error) => {
        this.resolvedWorlds.delete(label)
        throw error
      })
      this.resolvedWorlds.set(label, pending)
    }
    return this.resolvedWorlds.get(label)
  }
  async call(agent, action, data = {}) {
    const { label, ...scope } = this.scope(agent)
    const world = await this.resolveWorld(label)
    return this.request(
      action.startsWith('hub_') ? 'colony_hub_rpc' : action.startsWith('reconcile_') ? 'colony_reconcile_rpc' : 'colony_rpc',
      {
        action,
        payload: { ...data, ...scope, world },
      },
    )
  }
  async request(rpc, body) {
    let response
    try {
      response = await this.fetch(`${this.url}/rest/v1/rpc/${rpc}`, {
        method: 'POST',
        signal: AbortSignal.timeout(8000),
        headers: {
          apikey: this.key,
          'Content-Type': 'application/json',
          ...(this.key.startsWith('eyJ')
            ? { Authorization: `Bearer ${this.key}` }
            : {}),
        },
        body: JSON.stringify(body),
      })
    } catch (_) {
      throw new Error(
        'Shared storage is unavailable; no action will be replayed automatically.',
      )
    }
    if (!response.ok) {
      // Supabase error text may include infrastructure details. Expose only our known messages.
      const result = await response.json().catch(() => ({}))
      const message = /^Colony: /.test(result.message || '')
        ? result.message
        : 'Shared storage request failed. Check backend configuration and migrations.'
      throw new Error(message)
    }
    return response.json()
  }
}
module.exports = { Colony }
