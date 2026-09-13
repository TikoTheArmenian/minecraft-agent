const $ = s => document.querySelector(s)
let state = null, connected = false
let messageSignature = '', resultSignature = '', waypointSignature = '', worldSignature = ''
let submitting = false, inventorySignature = '', followConversation = true
async function request(url, data) {
  $('#error').hidden = true
  try {
    const res = await fetch(url, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data),signal:AbortSignal.timeout(15000)})
    const json = res.headers.get('content-type')?.includes('application/json')
    const body = json ? await res.json() : {}
    if (!res.ok) throw new Error(body.error || `Request failed (${res.status}).`)
    return true
  } catch (error) {
    $('#error').textContent = error.name === 'TimeoutError' ? 'The request timed out. Check task status before sending it again.' : error.message
    $('#error').hidden = false
    return false
  }
}
async function command(text) {
  const stopping = /^(stop|cancel)$/i.test(text.trim())
  if (submitting && !stopping) return false
  if (!stopping) submitting = true
  try { return await request('/api/command', {text}) }
  finally { if (!stopping) submitting = false }
}
function node(tag, text, className) { const el=document.createElement(tag); if(text!==undefined) el.textContent=text; if(className) el.className=className; return el }
function action(label, fn) { const b=node('button',label); b.type='button'; b.onclick=fn; return b }
function render(s) {
  if (!s) return
  state=s
  document.dispatchEvent(new CustomEvent('walkbot-state', {detail:{state:s,connected}}))
  if (s.world !== worldSignature) { worldSignature=s.world; $('#connection input[name=world]').value=s.world }
  $('#status').textContent=connected ? s.connection : 'Control app reconnecting…'; $('#status').className='badge '+s.connection
  $('#connect').disabled=s.connection!=='disconnected' || !connected
  $('#disconnect').disabled=s.connection==='disconnected' || !connected
  $('#position').textContent=s.position ? `${s.position.x.toFixed(1)} / ${s.position.y.toFixed(1)} / ${s.position.z.toFixed(1)} · ${s.dimension}` : 'Connect to begin exploring.'
  $('#task').textContent=s.busy && s.task?.status==='cancelled' ? 'Stopping: waiting for the current action to settle…' : s.task ? `${s.task.label} · ${s.task.status}` : 'No active task.'
  const inventorySig=JSON.stringify([s.inventory,s.connection])
  if(inventorySig!==inventorySignature) {
    inventorySignature=inventorySig
    const inventory=s.inventory || [],held=inventory.find(i=>i.equipped)
    $('#inventory-summary').textContent=s.connection==='ready' ? `${inventory.reduce((sum,i)=>sum+i.count,0)} items · ${inventory.length} stacks` : 'Waiting for world'
    const icons=window.MarcIcons
    $('#held-tool').replaceChildren(...(s.connection==='ready' ? [...(held && icons ? [icons.icon(held.name)] : []),node('span',`In hand: ${held ? held.displayName || held.name.replaceAll('_',' ') : 'empty'}`)] : [node('span','Connect to see the equipped item.')]))
    $('#current-inventory').replaceChildren(...(inventory.length ? [...inventory].sort((a,b)=>(a.slot??100)-(b.slot??100)).map(item=>{
      const row=node('div',undefined,'inventory-row'+(item.equipped?' equipped':''))
      const description=node('div'),location=item.hotbar ? `Hotbar ${item.hotbar}` : 'Inventory'
      description.append(node('strong',item.displayName || item.name.replaceAll('_',' ')),node('span',`${location}${item.equipped?' · In hand':''}${item.enchantments?.length?' · Enchanted':''}`))
      // Real item textures come from icons.js; the text keeps the name for screen readers.
      if(icons) row.append(icons.icon(item.name))
      row.append(description,node('span',`× ${item.count}`,'item-count'))
      return row
    }) : [node('p',s.connection==='ready' ? 'Inventory is empty. Drop supplies beside Marc to give it items.' : 'Connect to load inventory.','muted')]))
    $('#inventory').replaceChildren(...(inventory.length ? inventory.map(item=>icons ? icons.chip(item) : node('span',`${item.name} × ${item.count}`,'inventory-chip')) : [node('p',s.connection==='ready' ? 'No items. Give Marc tools and planting stock.' : 'Connect to see tools and planting stock.','muted')]))
  }
  $('#work-counts').textContent = s.task?.counts ? Object.entries(s.task.counts).map(([k,v])=>`${v} ${k==='collectedStacks'?'item stacks picked up':k}`).join(' · ') || 'Starting…' : 'No mining or farming work yet.'
  $('#work-issues').replaceChildren(...(s.task?.issues||[]).map(text=>node('li',text)))
  document.querySelectorAll('#mine-type button, #mine-area button, #farm button, #save button, #search button').forEach(button => { button.disabled = !connected || s.connection !== 'ready' || s.busy })
  const msgSig = JSON.stringify(s.messages)
  if (msgSig !== messageSignature) {
    messageSignature = msgSig
    const messages = $('#messages')
    const follow = followConversation
    const previousTop = messages.scrollTop
    messages.replaceChildren()
    const items = [...s.messages].sort((a,b)=>a.at-b.at || Number(a.role!=='user')-Number(b.role!=='user'))
    if (!items.length) messages.append(node('p','Connect your bot, then select an area on the map or start Survive.','muted'))
    for (const m of items) {
      const el=node('div',undefined,'message'+(m.role==='user'?' user':''))
      el.append(node('time',`${m.role==='user'?'You':'Marc'} · ${new Date(m.at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}`),node('span',m.text))
      messages.append(el)
    }
    messages.scrollTop = follow ? messages.scrollHeight : previousTop
  }
  const placesSig = JSON.stringify([s.waypoints,s.connection,s.busy,connected])
  if (placesSig !== waypointSignature) {
    waypointSignature = placesSig
  $('#waypoints').replaceChildren()
  for(const [name,p] of Object.entries(s.waypoints)){const row=node('div',undefined,'place');row.append(action(`${name} →`,()=>command(`go to ${name}`)),action('×',()=>command(`forget ${name}`)));row.lastChild.setAttribute('aria-label',`Forget ${name}`);row.firstChild.disabled=!connected || s.connection!=='ready' || s.busy;row.lastChild.disabled=!connected || s.connection!=='ready';row.firstChild.title=`${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)}`;$('#waypoints').append(row)}
  }
  const searchSig = JSON.stringify([s.results,s.search,s.connection,s.busy,connected])
  if (searchSig === resultSignature) return
  resultSignature = searchSig
  $('#results').replaceChildren()
  if(!s.results.length){$('#results').append(node('p',s.search ? `No ${s.search.name} found within ${s.search.radius} blocks of the search origin.` : 'Search for a block to see locations here.','empty'));return}
  if(s.search) $('#results').append(node('p',`Observed ${new Date(s.search.at).toLocaleTimeString()}. Distances are from the bot’s position at search time. Search again to refresh.`,'muted'))
  const table=node('table'),head=node('tr');for(const text of ['Block','Coordinates','Distance','']) {const th=node('th',text);th.scope='col';head.append(th)};table.append(head)
  for(const r of s.results){const row=node('tr');row.append(node('td',r.name),node('td',`${r.x}, ${r.y}, ${r.z}`),node('td',`${r.distance.toFixed(1)} blocks`));const td=node('td');td.append(action('Walk near',()=>command(`go to ${r.x} ${r.y} ${r.z}`)));row.append(td);row.title=`Observed ${new Date(r.at).toLocaleTimeString()} · ${r.dimension}`;td.firstChild.disabled = !connected || s.connection!=='ready' || s.busy;table.append(row)}
  $('#results').append(table)
}
$('#connection').onsubmit=async e=>{e.preventDefault();if($('#connect').disabled)return;$('#connect').disabled=true;const data=new FormData(e.target);await request('/api/connect',{port:data.get('port'),world:data.get('world')});render(state)}
$('#disconnect').onclick=()=>request('/api/disconnect',{})
$('#stop').onclick=()=>command('stop')
$('#command').onsubmit=async e=>{e.preventDefault();const text=$('#text').value;if(await command(text) && $('#text').value===text)$('#text').value=''}
$('#save').onsubmit=e=>{e.preventDefault();command(`save ${$('#place').value}`)}
$('#search').onsubmit=e=>{e.preventDefault();command(`find ${$('#block').value} ${$('#radius').value}`)}
document.querySelectorAll('[data-command]').forEach(b=>b.onclick=()=>command(b.dataset.command))
// Keep the message composer visible. Follow new replies only while the reader is
// at the bottom; opening the collapsed section should also reveal the latest reply.
$('#messages').addEventListener('scroll',()=>{
  const messages=$('#messages')
  if(messages.clientHeight)followConversation=messages.scrollHeight-messages.scrollTop-messages.clientHeight<60
})
$('.advanced').addEventListener('toggle',()=>{
  if($('.advanced').open && followConversation)$('#messages').scrollTop=$('#messages').scrollHeight
})
const events=new EventSource('/api/events')
events.onopen=()=>{connected=true;render(state)}
events.onmessage=e=>{try{render(JSON.parse(e.data))}catch(error){$('#error').textContent='Could not update the control room. Refresh this page.';$('#error').hidden=false}}
events.onerror=()=>{connected=false;render(state)}

$('#mine-type').onsubmit=e=>{e.preventDefault();const d=new FormData(e.target);command(`mine ${d.get('block')} ${d.get('count')} within ${d.get('radius')}`)}
$('#mine-area').onsubmit=e=>{e.preventDefault();const d=new FormData(e.target);command(`mine area ${d.get('x1')} ${d.get('y1')} ${d.get('z1')} to ${d.get('x2')} ${d.get('y2')} ${d.get('z2')}`)}
$('#mine-area').oninput=e=>{const d=new FormData($('#mine-area'));const names=['x1','y1','z1','x2','y2','z2'];if(names.some(k=>d.get(k)==='')){$('#volume').textContent='Enter two corners to see the selection size.';return;}const n=names.map(k=>Number(d.get(k)));const volume=(Math.abs(n[0]-n[3])+1)*(Math.abs(n[1]-n[4])+1)*(Math.abs(n[2]-n[5])+1);$('#volume').textContent=`${volume} block positions selected${volume>512?' — reduce to 512 or fewer':''}.`}
$('#farm').onsubmit=e=>{e.preventDefault();const d=new FormData(e.target);command(`farm ${d.get('crop')} ${d.get('radius')}`)}
