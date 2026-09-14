/* Shared catalog is fetched on demand, not on every physics/state tick. */
;(() => {
  const get = (id) => document.getElementById(id)
  let data = null,
    scene = '',
    sequence = 0,
    queuePending = false,
    canQueue = false
  function render() {
    const box = get('storage-stock'),
      jobs = get('storage-jobs')
    box.replaceChildren()
    jobs.replaceChildren()
    if (!data?.configured) return
    const filter = get('storage-filter').value.toLowerCase().trim()
    for (const chest of data.containers || []) {
      const rows = chest.slots.filter((i) => i.name.includes(filter))
      if (filter && !rows.length) continue
      const card = document.createElement('p')
      const age = chest.checked_at
        ? `${Math.max(0, Math.floor((Date.now() - Date.parse(chest.checked_at)) / 1000))}s ago`
        : 'never inspected'
      card.textContent =
        `${chest.category} · ${chest.managed ? 'managed' : 'observed only'} · ${chest.id} · ${age}: ` +
        (rows
          .map((i) => {
            const reserved = (data.reservations || [])
              .filter(
                (r) =>
                  r.container === chest.id && r.fingerprint === i.fingerprint,
              )
              .reduce((n, r) => n + r.quantity, 0)
            return `${i.name} ×${i.count}${reserved ? ` (${reserved} reserved across matching slots)` : ''}`
          })
          .join(', ') || 'empty')
      box.append(card)
    }
    if (!box.childNodes.length)
      box.textContent =
        'No matching chest stock. Inspect and enroll nearby chests first.'
    for (const job of data.jobs || []) {
      const p = document.createElement('p')
      p.textContent = `${job.item} ×${job.quantity}: ${job.state}${job.detail ? ' — ' + job.detail : ''}`
      jobs.append(p)
    }
    if (data.uncertain?.length) {
      const p = document.createElement('p')
      p.textContent = `${data.uncertain.length} uncertain operation(s). Stop the affected worker and follow the storage recovery guide before retrying.`
      jobs.prepend(p)
    }
  }
  async function refresh() {
    const owner = scene,
      ticket = ++sequence,
      url = botUrl('/api/storage')
    get('storage-status').textContent = 'Loading shared stock…'
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(10000) })
      const result = await response.json()
      if (owner !== scene || ticket !== sequence) return
      if (!response.ok)
        throw new Error(result.error || 'Storage request failed.')
      data = result
      get('storage-status').textContent = data.configured
        ? 'Shared stock loaded. Observations may be stale.'
        : 'Supabase is not configured. See docs/STORAGE-SETUP.md.'
      render()
    } catch (error) {
      if (owner === scene && ticket === sequence)
        get('storage-status').textContent = error.message
    }
  }
  get('storage-refresh').onclick = refresh
  get('storage-filter').oninput = render
  for (const [id, text] of [
    ['scan', 'scan storage'],
    ['store', 'store surplus'],
    ['organize', 'organize storage'],
  ])
    get(`storage-${id}`).onclick = () => command(text)
  get('storage-enroll').onsubmit = async (e) => {
    e.preventDefault()
    const f = new FormData(e.target)
    await command(
      `manage storage ${f.get('x')} ${f.get('y')} ${f.get('z')} ${f.get('category')}`,
    )
  }
  get('storage-craft').onsubmit = async (e) => {
    e.preventDefault()
    if (queuePending || !canQueue) return
    queuePending = true
    const f = new FormData(e.target),
      button = e.target.querySelector('button')
    button.disabled = true
    try {
      if (
        await request('/api/craft-jobs', {
          item: f.get('item').trim(),
          quantity: Number(f.get('quantity')),
        })
      )
        await refresh()
    } finally {
      queuePending = false
      button.disabled = !canQueue
    }
  }
  document.addEventListener('walkbot-state', (e) => {
    const s = e.detail.state,
      next = `${selectedBot}:${s.world}:${s.dimension}:${s.connection}`
    const ready =
      e.detail.connected && s.connection === 'ready' && s.storage?.configured
    for (const id of ['storage-scan', 'storage-store', 'storage-organize'])
      get(id).disabled = !ready || s.busy
    get('storage-enroll').querySelector('button').disabled = !ready || s.busy
    canQueue = !!ready
    get('storage-craft').querySelector('button').disabled =
      !ready || queuePending
    if (next !== scene) {
      scene = next
      sequence++
      data = null
      render()
      get('storage-status').textContent =
        'Refresh to load storage for this bot’s world.'
    }
  })
})()
