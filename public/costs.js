/** Project-wide panel deliberately sits outside the selected bot's command workspace. */
;(() => {
  const get = id => document.getElementById(id)
  const node = (tag, text = '') => { const e = document.createElement(tag); e.textContent = text; return e }
  const money = value => value === null || value === undefined ? 'Unknown' : value > 0 && value < 0.000001 ? '<$0.000001' : '$' + Number(value).toFixed(6)
  const totalMoney = total => (total.unknownCosts || total.pending) && !total.pricedRequests ? (total.unknownCosts ? 'Unknown' : 'Pending') : money(total.estimatedUsd)
  const num = value => Number(value || 0).toLocaleString()
  const day = value => new Date(value).toISOString().slice(0, 10)
  let state = null, timer, loading = false, rerun = false, names = []
  function query() {
    const q = new URLSearchParams(), now = Date.now(), utc = new Date(now)
    const period = get('cost-period').value
    if (period === 'month') q.set('from', day(Date.UTC(utc.getUTCFullYear(), utc.getUTCMonth(), 1)))
    if (period === 'today') q.set('from', day(now))
    if (period === 'week') q.set('from', day(now - 6 * 86400000))
    if (period === 'custom') {
      if (get('cost-from').value) q.set('from', get('cost-from').value)
      if (get('cost-to').value) q.set('to', get('cost-to').value)
    }
    if (get('cost-agent').value) q.set('agent', get('cost-agent').value)
    return q.toString()
  }
  function choices(id, first, values) {
    const select = get(id), value = select.value
    select.replaceChildren(...[first, ...values.map(n => [n,n])].map(([v,label]) => { const option = node('option',label); option.value = v; return option }))
    if ([...select.options].some(o => o.value === value)) select.value = value
  }
  function rows(id, data, columns) {
    const target = get(id)
    if (!data.length) { const row = node('tr'), cell = node('td', 'No recorded requests in this period.'); cell.colSpan = columns.length; row.append(cell); target.replaceChildren(row); return }
    target.replaceChildren(...data.map(item => {
      const row = node('tr')
      for (const column of columns) { const cell = node('td'), value = column(item); if (value instanceof Node) cell.append(value); else cell.textContent = value; row.append(cell) }
      return row
    }))
  }
  function loadBudget() {
    const saved = state?.budgets?.find(b => b.scope === get('cost-budget-scope').value)
    get('cost-budget-day').value = saved?.daily_usd ?? ''
    get('cost-budget-month').value = saved?.monthly_usd ?? ''
  }
  function render(data) {
    state = data
    if (!data.total) throw new Error(data.health?.error || 'Cost history is unavailable.')
    if (!get('cost-agent').value) {
      const updated = data.agents.map(a => a.name).filter(n => n !== 'project').sort()
      if (JSON.stringify(updated) !== JSON.stringify(names)) {
        names = updated
        choices('cost-agent', ['', 'Whole project'], names)
        choices('cost-budget-scope', ['project', 'Whole project'], names)
        loadBudget()
      }
    }
    const coverage = t => `${num(t.requests)} ${t.requests === 1 ? 'call' : 'calls'} · ${num(t.unknownCosts)} unknown ${t.unknownCosts === 1 ? 'cost' : 'costs'} · ${num(t.pending)} pending`
    get('cost-total').textContent = totalMoney(data.total)
    get('cost-range-label').textContent = `${get('cost-agent').value || 'Whole project'} · selected period OpenAI estimate`
    get('cost-coverage').textContent = coverage(data.total)
    get('cost-today').textContent = totalMoney(data.today)
    get('cost-today-detail').textContent = coverage(data.today)
    get('cost-month').textContent = totalMoney(data.month)
    get('cost-month-detail').textContent = coverage(data.month)
    const warnings = [data.health.error, data.pricing.stale ? 'Saved prices are over 90 days old; verify the rate card.' : '',
      data.total.unknownCosts ? 'Some OpenAI costs are unknown. The displayed amount is only the priced portion, not a complete bill.' : ''].filter(Boolean)
    get('cost-error').textContent = warnings.join(' '); get('cost-error').hidden = !warnings.length
    get('cost-alerts').textContent = data.alerts.map(a => `${a.scope}: ${a.period} budget ${a.level} (${money(a.estimatedUsd)} / ${money(a.budgetUsd)}).`).join(' ')
    get('cost-alerts').hidden = !data.alerts.length
    rows('cost-agent-rows', data.agents, [a => a.name, a => totalMoney(a), a => num(a.openaiRequests), a => num(a.supabaseRequests), a => `${num(a.inputTokens)} / ${num(a.outputTokens)}`, a => num(a.unknownCosts), a => `${num(a.errors)} / ${num(a.pending)}`])
    rows('cost-model-rows', data.models, [m => m.name, m => num(m.requests), m => m.pricedRequests ? money(m.estimatedUsd) : 'Not priced'])
    const max = Math.max(0.000001, ...data.daily.map(d => d.estimatedUsd))
    rows('cost-day-rows', data.daily.slice().reverse(), [d => d.name, d => { if ((d.unknownCosts || d.pending) && !d.pricedRequests) return node('span', '—'); const meter = node('meter'); meter.min = 0; meter.max = max; meter.value = d.estimatedUsd; meter.setAttribute('aria-label', `${d.name}: ${totalMoney(d)}`); return meter }, d => totalMoney(d)])
    rows('cost-request-rows', data.recent, [r => new Date(r.started_at).toLocaleString(), r => r.agent, r => `${r.provider} / ${r.operation}`, r => `${r.model || '—'} / ${r.tier || '—'}`, r => `${r.outcome}${r.http_status ? ` (${r.http_status})` : ''}`, r => money(r.estimatedUsd), r => r.pricing_status.replaceAll('_', ' ')])
    get('cost-pricing').replaceChildren(node('span', `Tracking since ${new Date(data.trackingSince).toLocaleString()}. Prices verified ${data.pricing.verifiedAt}. `))
    const link = node('a', 'Official OpenAI pricing'); link.href = 'https://developers.openai.com/api/docs/pricing'; link.target = '_blank'; link.rel = 'noopener noreferrer'; get('cost-pricing').append(link)
    get('cost-updated').textContent = `Updated ${new Date().toLocaleTimeString()} · USD estimates`
  }
  async function refresh() {
    clearTimeout(timer)
    if (loading) { rerun = true; return }
    loading = true
    const selected = query()
    get('cost-export').href = '/api/costs/export' + (selected ? '?' + selected : '')
    try {
      const response = await fetch('/api/costs?' + selected, { signal: AbortSignal.timeout(8000) })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Could not load costs.')
      if (selected !== query()) { rerun = true; return }
      render(data)
    } catch (error) {
      get('cost-error').textContent = `Cost refresh failed: ${error.message} Any displayed totals are from the last successful refresh.`
      get('cost-error').hidden = false
    } finally {
      loading = false
      if (rerun) { rerun = false; void refresh() }
      else timer = setTimeout(() => { if (!document.hidden) void refresh(); else timer = setTimeout(refresh, 10000) }, 10000)
    }
  }
  for (const id of ['cost-period','cost-agent','cost-from','cost-to']) get(id).addEventListener('change', () => {
    for (const label of ['cost-from-label','cost-to-label']) get(label).hidden = get('cost-period').value !== 'custom'
    void refresh()
  })
  get('cost-refresh').onclick = refresh
  get('cost-budget-scope').onchange = loadBudget
  get('cost-budget-form').onsubmit = async event => {
    event.preventDefault()
    const button = event.target.querySelector('button'); button.disabled = true
    try {
      const amount = id => get(id).value === '' ? null : Number(get(id).value)
      const response = await fetch('/api/costs/budgets', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: get('cost-budget-scope').value, dailyUsd: amount('cost-budget-day'), monthlyUsd: amount('cost-budget-month') }) })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Could not save budget alerts.')
      get('cost-budget-status').textContent = 'Budget alerts saved.'
      await refresh()
    } catch (error) { get('cost-budget-status').textContent = error.message }
    finally { button.disabled = false }
  }
  void refresh()
})()
