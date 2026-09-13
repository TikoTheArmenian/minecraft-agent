(() => {
  const get=id=>document.getElementById(id)
  let state=null,online=false,lastUpdate=0,signature=''
  const seconds=at=>Math.max(0,Math.floor((Date.now()-at)/1000))
  function status() {
    if(!state)return
    const stale=!online || Date.now()-lastUpdate>5000
    const task=state.task,running=state.busy || task?.status==='running',stopping=state.busy && task?.status==='cancelled'
    get('activity-state').textContent=stale?'Controller offline':state.connection!=='ready'?state.connection:stopping?'Stopping':running?'Running':'Idle'
    get('activity-state').className=stale?'offline':running?'running':'idle'
    get('activity-mode').textContent=`${state.vitals?.gameMode || 'Unknown'} mode`
    get('activity-heartbeat').textContent=stale?`No update for ${seconds(lastUpdate)}s`:'Receiving live updates'
    const action=task?.action
    get('activity-summary').textContent=stale?'Live status is unavailable. Check the Terminal running npm run web; the state below may be stale.':state.connection!=='ready'?'Marc is not ready to work. Connect it and wait for the world to load.':stopping?`Stopping: ${action?.label || task.label}. Waiting for the action to settle.`:running?(action?.status==='running'?action.label:task.label):task?.status==='partial'?`Last run finished with blocked steps. ${task.issues?.at(-1) || state.survival?.decision || task.label}`:task?.status==='failed'?`Last task failed: ${task.issues?.at(-1) || task.label}`:state.surviveAvailability?.reason || 'No task is running.'
    const timings=[]
    if(running && !task?.continuous && state.survival?.waitingUntil)timings.push(`Next harvest/expansion check in ${Math.max(0,Math.ceil((state.survival.waitingUntil-Date.now())/1000))}s`)
    if(running && task?.continuous && state.wheatFarm?.waitingUntil)timings.push(`Next crop check in ${Math.max(0,Math.ceil((state.wheatFarm.waitingUntil-Date.now())/1000))}s`)
    const objective=!task?.continuous && state.survival?.steps?.find(s=>s.id===state.survival.currentStep)
    if(running && objective)timings.push(`Objective: ${objective.label}`)
    if(task?.counts?.travelBlocks)timings.push(`${task.counts.travelBlocks} shore blocks placed`)
    if(running && task?.travel?.status==='running')timings.push(task.travel.label)
    if(running && task?.startedAt)timings.push(`Task running for ${seconds(task.startedAt)}s`)
    if(running && action?.status==='running') {
      timings.push(`Current action: ${seconds(action.startedAt)}s elapsed`)
      timings.push(`Timeout in ${Math.max(0,Math.ceil((action.deadlineAt-Date.now())/1000))}s`)
    }
    if(state.lastMovedAt && running)timings.push(`Last position change ${seconds(state.lastMovedAt)}s ago`)
    if(!running && task)timings.push(`Last task: ${task.status} · ${task.label}`)
    get('activity-timing').textContent=timings.join(' · ')
  }
  function renderLog(force=false) {
    const entries=(state?.logs || []).filter(e=>get('log-filter').value!=='problems' || ['warn','error'].includes(e.level))
    const next=JSON.stringify(entries.map(e=>e.id))
    if(!force && next===signature)return
    signature=next
    const log=get('activity-log'),previousTop=log.scrollTop
    log.replaceChildren()
    if(!entries.length){const p=document.createElement('p');p.className='muted';p.textContent=get('log-filter').value==='problems'?'No warnings or errors in the current feed.':'Waiting for controller events…';log.append(p)}
    for(const entry of entries) {
      const row=document.createElement('div');row.className=`log-entry ${entry.level}`
      const time=document.createElement('time');time.textContent=new Date(entry.at).toLocaleTimeString();time.dateTime=new Date(entry.at).toISOString()
      const label=document.createElement('span');label.className='log-level';label.textContent=entry.level.toUpperCase()
      const body=document.createElement('span');body.textContent=entry.message
      const detail=entry.details || {},suffix=[]
      if(detail.taskId!==undefined)suffix.push(`Task ${detail.taskId}`)
      if(detail.durationMs!==undefined)suffix.push(`${detail.durationMs} ms`)
      if(detail.timeoutMs!==undefined)suffix.push(`${detail.timeoutMs/1000}s timeout`)
      row.title=[entry.event,...suffix].join(' · ')
      row.append(time,label,body);log.append(row)
    }
    log.scrollTop=get('log-follow').checked?log.scrollHeight:previousTop
  }
  document.addEventListener('walkbot-state',e=>{
    state=e.detail.state;online=e.detail.connected
    if(online)lastUpdate=Date.now()
    get('log-file').textContent=state.logFile || 'data/logs/activity.log'
    get('log-error').hidden=!state.logError
    get('log-error').textContent=state.logError || ''
    status();renderLog()
  })
  get('log-filter').onchange=()=>renderLog(true)
  get('log-follow').onchange=()=>{if(get('log-follow').checked)get('activity-log').scrollTop=get('activity-log').scrollHeight}
  get('activity-log').addEventListener('scroll',()=>{
    const log=get('activity-log')
    if(log.clientHeight)get('log-follow').checked=log.scrollHeight-log.scrollTop-log.clientHeight<30
  })
  document.querySelector('.activity-details').addEventListener('toggle',()=>{
    if(get('log-follow').checked)get('activity-log').scrollTop=get('activity-log').scrollHeight
  })
  setInterval(status,1000)
})()
