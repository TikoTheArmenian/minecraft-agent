/* The selected bot owns this form. Saving configuration never resumes decisions. */
;(() => {
  const get = (id) => document.getElementById(id)
  const fields = get('supervisor-fields')
  let owner = '',
    snapshot = null,
    linked = false,
    ready = false,
    dirty = false,
    pending = false,
    sequence = 0
  const number = (value) => (Number.isFinite(Number(value)) ? Number(value).toLocaleString() : '—')
  const text = (value) => (typeof value === 'string' ? value : value?.message || '')
  const reasonText = (value) =>
    String(value || '')
      .replaceAll('_', ' ')
      .toLowerCase()

  function fill() {
    get('supervisor-mode').value = snapshot?.mode || 'off'
    get('supervisor-model').value = snapshot?.model || ''
    get('supervisor-objective').value = snapshot?.objective || ''
  }
  function feedback(message, error = false) {
    const element = get('supervisor-feedback')
    element.textContent = message
    element.hidden = !message
    element.classList.toggle('problem', error)
  }
  function render() {
    const mode = snapshot?.mode || 'off'
    fields.disabled = !linked || !snapshot || pending
    get('supervisor-resume').disabled =
      pending || dirty || !ready || mode === 'off' || !snapshot?.paused
    get('supervisor-pause').disabled = pending || mode === 'off' || Boolean(snapshot?.paused)
    get('supervisor-badge').textContent = !snapshot
      ? 'Unavailable'
      : mode === 'off'
        ? 'Off'
        : snapshot.paused
          ? 'Paused'
          : snapshot.busy
            ? 'Thinking'
            : mode === 'shadow'
              ? 'Shadow'
              : 'Autonomous'
    get('supervisor-badge').dataset.mode = mode
    get('supervisor-status').textContent = !linked
      ? 'Waiting for this bot’s controller.'
      : !snapshot
        ? 'Supervisor state is unavailable from this controller.'
        : mode === 'off'
          ? 'The supervisor is off. Human controls and running skills remain available.'
          : snapshot.paused
            ? `Decisions paused${snapshot.reason ? `: ${reasonText(snapshot.reason)}` : ''}.`
            : !ready
              ? 'Waiting for this bot to connect to Minecraft.'
              : snapshot.busy
                ? 'Considering the objective, current work, and recent messages…'
                : 'Waiting for a meaningful change or a new request.'
    const last = snapshot?.lastDecision
    if (!last) get('supervisor-decision').textContent = 'No decisions yet.'
    else {
      const decision = last.decision || last.proposal || last
      const kind = decision.kind || decision.type || decision.action || 'Decision'
      const skill =
        decision.skillId || decision.skill || decision.invocation?.skillId || decision.command?.type
      const status =
        last.mode === 'shadow' && last.status === 'shadow' ? 'Shadow proposal' : last.status
      const summary = [status, typeof kind === 'string' ? kind : 'Decision', skill, decision.to]
        .filter(Boolean)
        .join(' · ')
      const rationale = text(decision.reason || decision.rationale || last.reason || last.rationale)
      get('supervisor-decision').textContent = [
        summary,
        rationale,
        text(last.result?.message || last.error),
      ]
        .filter(Boolean)
        .join(' — ')
    }
    const usage = snapshot?.usage || {},
      budget = snapshot?.budget || {}
    get('supervisor-usage').textContent = snapshot
      ? `${number(usage.requests ?? usage.requestsToday ?? 0)} / ${number(budget.requestsPerDay)} requests · ${number(usage.tokens ?? usage.tokensToday ?? 0)} / ${number(budget.tokensPerDay)} tokens${budget.maxOutputTokens ? ` · up to ${number(budget.maxOutputTokens)} output tokens per decision` : ''}`
      : 'Waiting for usage.'
    get('supervisor-error').textContent = text(snapshot?.error)
    get('supervisor-error').hidden = !get('supervisor-error').textContent
  }
  function receive(value) {
    snapshot = value?.supervisor || value
    if (!dirty) fill()
    render()
  }
  async function submit(suffix, data) {
    const target = owner,
      ticket = ++sequence
    if (!snapshot || target !== botUrl('/api/supervisor') || pending) return
    pending = true
    feedback('Saving…')
    render()
    try {
      const response = await fetch(target + suffix, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
        signal: AbortSignal.timeout(15000),
      })
      const body = await response.json()
      if (target !== botUrl('/api/supervisor') || target !== owner || ticket !== sequence) return
      if (!response.ok) throw new Error(body.error || 'The supervisor request failed.')
      dirty = false
      if (body.supervisor || body.mode) receive(body)
      else {
        const refresh = await fetch(target, { signal: AbortSignal.timeout(10000) })
        const result = await refresh.json()
        if (target !== owner || ticket !== sequence) return
        if (!refresh.ok) throw new Error(result.error || 'Could not refresh supervisor state.')
        receive(result)
      }
      feedback(
        suffix === '/resume'
          ? 'Supervisor resumed.'
          : suffix === '/pause'
            ? 'New decisions paused.'
            : snapshot.mode === 'off'
              ? 'Saved. The supervisor is off.'
              : 'Saved and paused. Press Resume when ready.',
      )
    } catch (error) {
      if (target === owner && ticket === sequence)
        feedback(
          error.name === 'TimeoutError'
            ? 'The request timed out. Check the current supervisor state before trying again.'
            : error.message,
          true,
        )
    } finally {
      if (target === owner && ticket === sequence) {
        pending = false
        render()
      }
    }
  }
  get('supervisor-settings').addEventListener('input', () => {
    dirty = true
    feedback('Unsaved settings. Save before resuming.')
    render()
  })
  get('supervisor-settings').addEventListener('submit', (event) => {
    event.preventDefault()
    submit('', {
      mode: get('supervisor-mode').value,
      model: get('supervisor-model').value.trim(),
      objective: get('supervisor-objective').value.trim(),
    })
  })
  get('supervisor-resume').addEventListener('click', () => {
    if (!dirty && ready) submit('/resume', {})
  })
  get('supervisor-pause').addEventListener('click', () => submit('/pause', {}))
  document.addEventListener('walkbot-state', (event) => {
    const target = botUrl('/api/supervisor'),
      state = event.detail.state
    if (owner !== target) {
      owner = target
      sequence++
      pending = false
      dirty = false
      snapshot = null
      feedback('')
      fill()
    }
    linked = Boolean(event.detail.connected)
    ready = linked && state.connection === 'ready'
    if (state.supervisor) receive(state.supervisor)
    else render()
  })
  render()
})()
