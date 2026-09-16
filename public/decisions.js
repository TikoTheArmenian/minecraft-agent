/* Read-only projection of the selected bot's live state. A proposal is never a queue. */
;(() => {
  const get = (id) => document.getElementById(id)
  const human = (value) => String(value || '').replaceAll('_', ' ').replaceAll('-', ' ')
  let state = null, connected = false, updatedAt = 0

  function card(name, tag, title, detail, meta = '') {
    for (const [field, value] of Object.entries({ tag, title, detail, meta }))
      get(`decision-${name}-${field}`).textContent = value || ''
  }

  function render() {
    if (!state) return
    const stale = !connected || Date.now() - updatedAt > 5000
    const supervisor = state.supervisor || {}, task = state.task || {}
    const running = Boolean(state.busy || task.status === 'running')
    const stopping = running && task.status === 'cancelled'
    const ready = state.connection === 'ready'
    get('decision-live').textContent = stale ? 'Updates unavailable · last known state' : 'Live · selected agent'
    get('decision-live').dataset.stale = String(stale)
    get('decision-goal').textContent = supervisor.objective
      ? `Objective: ${supervisor.objective}` : 'No supervisor objective set · direct skill controls are available.'

    const last = supervisor.lastDecision, decision = last?.decision
    if (decision) {
      const title = [human(decision.kind), human(decision.command?.type), decision.to].filter(Boolean).join(' · ')
      const date = new Date(last.at)
      card('last', last.status === 'shadow' ? 'Shadow proposal' : human(last.status || 'Recorded'),
        title, decision.reason || 'No reason provided.',
        [Number.isFinite(date.getTime()) ? date.toLocaleTimeString() : '', last.error?.message].filter(Boolean).join(' · '))
    } else card('last', 'No decision', 'No supervisor decision yet', 'Directly assigned skills still appear under Working on.')

    const action = task.action?.status === 'running' ? task.action : null
    const progress = task.progress || {}
    card('current', !ready ? 'Disconnected' : stopping ? 'Stopping' : running ? (progress.blocker ? 'Blocked' : 'Active') : 'Idle',
      !ready ? 'Waiting for Minecraft' : running ? task.label || human(task.skillId) || 'Task in progress' : 'No active task',
      !ready ? 'Connect this agent to see its work.' : stopping ? 'Waiting for the current action to settle.' : running
        ? progress.blockerDetail || action?.label || progress.phase || 'Working toward the current objective.'
        : task.label ? `Last task: ${task.label} · ${human(task.status)}` : 'Choose a skill or resume the supervisor.',
      ready && running ? [task.travel?.status === 'running' ? task.travel.label : '',
        task.startedAt ? `${Math.max(0, Math.floor((Date.now() - task.startedAt) / 1000))}s elapsed` : ''].filter(Boolean).join(' · ') : '')

    // Only live runtime state can promise a queued switch. Old decisions may already be completed.
    const pending = state.runtime?.pendingSkillId
    const steps = task.skillId === 'survive' && running && !stopping ? state.survival?.steps || [] : []
    const currentIndex = steps.findIndex((step) => step.id === state.survival?.currentStep)
    const nextStep = currentIndex >= 0 ? steps.slice(currentIndex + 1).find((step) => step.status === 'pending') : null
    if (stale) card('next', 'Unknown', 'Waiting for live updates', 'The next move cannot be confirmed while the controller is offline.')
    else if (!ready) card('next', 'Waiting', 'Connect to continue', 'Next work will be shown when the agent is ready.')
    else if (pending) card('next', 'Queued switch', human(pending), 'Starts after the current task reaches a safe handoff and admission checks pass.')
    else if (stopping) card('next', 'Stopping', 'Finish stopping', 'No replacement skill is queued.')
    else if (nextStep) card('next', 'Planned step', nextStep.label, 'Next milestone in the current skill; conditions or a new assignment can change it.')
    else if (supervisor.busy) card('next', 'Thinking', 'Choosing the next decision', 'The supervisor is considering the objective and current observations.')
    else if (supervisor.mode === 'shadow' && last?.status === 'shadow' && decision)
      card('next', 'Proposal only', [human(decision.kind), human(decision.command?.type), decision.to].filter(Boolean).join(' · '), 'Shadow decisions do not execute or queue work.')
    else if (supervisor.mode && supervisor.mode !== 'off' && !supervisor.paused && supervisor.nextWakeAt)
      card('next', 'Scheduled review', 'Reassess the objective', 'The next skill has not been selected.', `Review in ${Math.max(0, Math.ceil((supervisor.nextWakeAt - Date.now()) / 1000))}s`)
    else card('next', 'Undecided', 'No next move selected', supervisor.paused && supervisor.mode !== 'off'
      ? `Supervisor paused${supervisor.reason ? `: ${human(supervisor.reason)}` : ''}.`
      : supervisor.mode === 'autonomous' ? 'Waiting for new observations or the current task to finish.' : 'No replacement skill is queued.')
  }

  document.addEventListener('walkbot-state', (event) => {
    state = event.detail.state
    connected = Boolean(event.detail.connected)
    if (connected) updatedAt = Date.now()
    render()
  })
  setInterval(render, 1000)
})()
