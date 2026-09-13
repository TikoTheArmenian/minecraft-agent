// Canvas pixels come from /api/map's real block names/heights. No generated or
// guessed terrain is added. Coordinates stay an implementation detail of clicks.
(() => {
  const get=id=>document.getElementById(id), canvas=get('world-map'), ctx=canvas.getContext('2d')
  const colors={green:'#648d47',earth:'#78543b',wood:'#b2804f',stone:'#777e81',water:'#396fa1',iron:'#c5a58b',ore:'#70979e',crop:'#d5bc52',danger:'#d45d35',pale:'#d4cdab'}
  const steps=['Gather wood','Craft a wooden pickaxe','Upgrade to a stone pickaxe','Find and collect iron','Gather food','Collect 128 wheat']
  let latest=null, online=false, map=null, offset=0, selection=null, drag=false, hover=null, cursor=544, loading=false, acting=false, scanning=false
  let scene='', playersKey='', survivalKey='', inventoryKey='', surveyKey='', lastScan=0
  function element(tag,text,cls) {const e=document.createElement(tag);e.textContent=text;if(cls)e.className=cls;return e}
  function ready() {return online && latest?.connection==='ready'}
  function available() {return ready() && !latest.busy && latest.task?.status!=='running' && !acting}
  function bounds() {
    if(!selection || !map)return null
    const x1=selection.from%map.size,z1=Math.floor(selection.from/map.size),x2=selection.to%map.size,z2=Math.floor(selection.to/map.size)
    return {x:Math.min(x1,x2),z:Math.min(z1,z2),w:Math.abs(x1-x2)+1,h:Math.abs(z1-z2)+1}
  }
  function selectionInfo() {
    const b=bounds();if(!b)return null
    let top=-Infinity,known=true
    for(let z=b.z;z<b.z+b.h;z++)for(let x=b.x;x<b.x+b.w;x++) {const c=map.cells[z*map.size+x];if(c.y===null)known=false;else top=Math.max(top,c.y)}
    const depth=Number(get('map-depth').value)
    return {...b,top,depth,known,volume:b.w*b.h*depth,fresh:Date.now()-map.at<30000}
  }
  function updateActions() {
    const info=selectionInfo()
    const gate=latest?.surviveAvailability
    const mayStart=gate?.canStart ?? (ready() && !latest?.busy && latest?.task?.status!=='running' && latest?.vitals?.gameMode==='survival')
    get('wheat-farm').disabled=!online || !mayStart || acting
    get('wheat-farm').textContent=latest?.wheatFarm?.status==='running'?'FARMER running…':'Start FARMER'
    get('survive').disabled=!online || !mayStart || acting
    get('survive').textContent=!online?'Controller offline':acting?'Sending request…':!mayStart?(gate?.label || 'Survival mode required'):(get('skill-choice').value==='farmer'?'▶ Start FARMER':get('skill-choice').value==='get torches'?'▶ Get torches':'▶ Start Survive')
    get('survive-gate').textContent=!online?'The web app is not receiving controller updates. Check the server Terminal.':acting?'Waiting for the controller to accept your request…':gate?.reason || 'Marc must be connected and in Survival mode to start.'
    get('survive-gate').className='survive-gate '+(mayStart && online?'ready':'blocked')
    get('survive').title=get('survive-gate').textContent
    get('survey').disabled=!ready() || scanning
    get('map-walk').disabled=!available() || !info?.fresh || !info.known || selection.from!==selection.to
    get('map-mine').disabled=!available() || !info?.fresh || !info.known || info.volume>512 || info.top-info.depth+1 < -64
    get('map-download').disabled=!map
    get('map-down').disabled=!ready() || offset<=-32
    get('map-up').disabled=!ready() || offset>=32
    get('map-refresh').disabled=!ready() || loading
    get('map-reset-height').textContent=offset ? `${offset>0?'+':''}${offset} blocks` : 'Player level'
    get('map-selection').textContent=!info?'No selection. One square is one block.':!info.fresh?'Selection expired. Refresh the map and select again.':!info.known?'Selection includes unknown / empty columns. Choose visible blocks.':`${info.w} × ${info.h} blocks · ${info.depth} ${info.depth===1?'layer':'layers'} · ${info.volume} positions${info.volume>512?' — maximum 512':` · clears height ${info.top-info.depth+1} through ${info.top}`}.`
  }
  function draw() {
    ctx.fillStyle='#0e1519';ctx.fillRect(0,0,canvas.width,canvas.height)
    if(!map){get('map-destination').textContent='No movement destination.';ctx.fillStyle='#9aafa3';ctx.font='22px system-ui';ctx.textAlign='center';ctx.fillText('Connect Marc to see your world',396,390);return}
    const tile=canvas.width/map.size
    map.cells.forEach((c,i)=>{
      const x=(i%map.size)*tile,z=Math.floor(i/map.size)*tile
      if(c.block<0) {
        ctx.fillStyle=c.unknown?'#283034':'#141f25';ctx.fillRect(x,z,tile,tile)
        if(c.unknown){ctx.strokeStyle='#394043';ctx.beginPath();ctx.moveTo(x,z+tile);ctx.lineTo(x+tile,z);ctx.stroke()}
        return
      }
      const entry=map.palette[c.block]
      ctx.fillStyle=colors[entry.category]||colors.stone;ctx.fillRect(x,z,tile,tile)
      const hash=((map.origin.x+i%map.size)*31+(map.origin.z+Math.floor(i/map.size))*17)>>>0
      ctx.fillStyle=`rgba(0,0,0,${Math.min(.4,Math.max(0,(map.top-c.y)*.026))})`;ctx.fillRect(x,z,tile,tile)
      // Small deterministic flecks help distinguish individual block cells.
      ctx.fillStyle='rgba(255,255,255,.14)';ctx.fillRect(x+3+hash%8,z+4+(hash>>3)%8,5,3)
      ctx.fillStyle='rgba(0,0,0,.12)';ctx.fillRect(x+11,z+14,7,4)
      ctx.strokeStyle='rgba(0,0,0,.11)';ctx.strokeRect(x,z,tile,tile)
      if(['iron','crop','danger'].includes(entry.category)){ctx.fillStyle=entry.category==='danger'?'#ffe6a3':'#f7edc5';ctx.font='bold 13px system-ui';ctx.textAlign='center';ctx.fillText(entry.category==='iron'?'Fe':entry.category==='crop'?'✦':'!',x+tile/2,z+16)}
    })
    const b=bounds()
    if(b){ctx.fillStyle='rgba(209,242,168,.28)';ctx.fillRect(b.x*tile,b.z*tile,b.w*tile,b.h*tile);ctx.strokeStyle='#e4ffb1';ctx.lineWidth=3;ctx.strokeRect(b.x*tile+1,b.z*tile+1,b.w*tile-2,b.h*tile-2);ctx.lineWidth=1}
    if(hover!==null){ctx.strokeStyle='#fff';ctx.lineWidth=2;ctx.strokeRect((hover%map.size)*tile+1,Math.floor(hover/map.size)*tile+1,tile-2,tile-2);ctx.lineWidth=1}
    const target=ready() && latest?.task?.status==='running' && latest.task.travel?.status==='running'?latest.task.travel.destination:null
    get('map-destination').textContent=target?`Destination: ${target.label} · height ${Math.floor(target.y)}`:'No movement destination.'
    if(target) {
      const rawX=(target.x-map.origin.x+.5)*tile,rawZ=(target.z-map.origin.z+.5)*tile
      const x=Math.max(16,Math.min(canvas.width-16,rawX)),z=Math.max(32,Math.min(canvas.height-16,rawZ))
      const outside=rawX<0 || rawX>canvas.width || rawZ<0 || rawZ>canvas.height
      const bot=latest.position
      ctx.save()
      if(bot){ctx.strokeStyle='#ff79dc';ctx.lineWidth=2;ctx.setLineDash([7,6]);ctx.beginPath();ctx.moveTo((bot.x-map.origin.x)*tile,(bot.z-map.origin.z)*tile);ctx.lineTo(x,z);ctx.stroke();ctx.setLineDash([])}
      ctx.strokeStyle='#ff79dc';ctx.fillStyle='#281525';ctx.lineWidth=3
      ctx.beginPath();ctx.arc(x,z,11,0,Math.PI*2);ctx.fill();ctx.stroke()
      ctx.beginPath();ctx.moveTo(x-6,z);ctx.lineTo(x+6,z);ctx.moveTo(x,z-6);ctx.lineTo(x,z+6);ctx.stroke()
      ctx.font='bold 13px system-ui';ctx.textAlign=x<100?'left':x>canvas.width-100?'right':'center';ctx.lineWidth=4;ctx.strokeStyle='#13231c'
      const label=outside?'DESTINATION ↗ OFF MAP':'DESTINATION'
      ctx.strokeText(label,x,z-17);ctx.fillStyle='#ffb5ec';ctx.fillText(label,x,z-17);ctx.restore()
      if(outside)get('map-destination').textContent+=' · outside this view (marker at map edge).'
    }
    for(const entity of map.entities){
      const x=(entity.x-map.origin.x)*tile,z=(entity.z-map.origin.z)*tile
      ctx.beginPath();ctx.arc(x,z,entity.bot||entity.player?8:5,0,Math.PI*2);ctx.fillStyle=entity.bot?'#c6f696':entity.player?'#7bd6ff':entity.hostile?'#ff796b':'#e4d9b2';ctx.fill();ctx.strokeStyle='#12231b';ctx.lineWidth=2;ctx.stroke();ctx.lineWidth=1
      if(entity.bot||entity.player){ctx.font='bold 13px system-ui';ctx.textAlign='center';ctx.lineWidth=4;ctx.strokeStyle='#13231c';ctx.strokeText(entity.bot?'BOT':entity.name,x,z-13);ctx.fillStyle='#f0f5e9';ctx.fillText(entity.bot?'BOT':entity.name,x,z-13);ctx.lineWidth=1}
    }
  }
  function inspect(i) {
    if(!map || i===null)return
    const c=map.cells[i],entry=map.palette[c.block]
    get('map-detail').textContent=entry?`${entry.name.replaceAll('_',' ')} · height ${c.y} · ${c.y<map.top-5?'lower terrain':'near view level'}`:c.unknown?'Unknown terrain — the bot has not loaded this column.':'No block within this view’s 13 vertical layers. Lower the view to inspect below.'
  }
  async function refresh(clear=false) {
    if(clear){selection=null;hover=null;updateActions()}
    if(!ready() || loading || selection || drag)return
    const expected=scene,focus=get('map-focus').value,requestedOffset=offset
    loading=true;updateActions()
    try {
      const res=await fetch(`/api/map?focus=${encodeURIComponent(focus)}&offset=${offset}`,{signal:AbortSignal.timeout(10000)})
      const next=await res.json();if(!res.ok)throw new Error(next.error)
      if(expected!==scene || focus!==get('map-focus').value || requestedOffset!==offset || selection || !ready())return
      map=next
      get('map-live').textContent=`${map.focus} · ${new Date(map.at).toLocaleTimeString()}`
      get('map-caption').textContent=`${focus==='player' && !map.players.length?'Your player is outside the bot’s tracked range, so this view follows Marc. With world commands enabled, /tp Marc @s brings it to you. ':''}33 × 33 blocks around ${map.focus}. Cutaway: highest block at or below height ${map.top}, looking down to ${map.bottom}. Lower the view to see under trees or roofs. Darker tiles are lower; striped tiles are unknown. This uses the bot’s loaded terrain.`
      draw()
    } catch(error){if(expected===scene)get('map-live').textContent=error.message || 'Map unavailable'}
    finally{loading=false;updateActions()}
  }
  async function survey() {
    if(!ready() || scanning)return
    scanning=true;lastScan=Date.now();updateActions()
    try{await fetch('/api/scan',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}',signal:AbortSignal.timeout(10000)})}catch(_){}
    finally{scanning=false;updateActions()}
  }
  function renderState(s,isOnline) {
    latest=s;online=isOnline
    const nextScene=`${s.connection}:${s.world}:${s.dimension}`
    if(nextScene!==scene){scene=nextScene;map=null;selection=null;hover=null;offset=0;lastScan=0;draw();get('map-live').textContent=ready()?'Loading world…':'Waiting for world';get('map-detail').textContent=ready()?'Hover or click a block to inspect it.':'Connect to load nearby blocks.';if(ready()){refresh();survey()}}
    const people=JSON.stringify(s.players?.map(p=>p.name)||[])
    if(people!==playersKey){playersKey=people;const select=get('map-focus'),current=select.value;select.replaceChildren(new Option('My player (nearest)','player'),new Option('Marc','bot'),...(s.players||[]).map(p=>new Option(p.name,p.name)));select.value=[...select.options].some(o=>o.value===current)?current:'player'}
    get('llm-status').textContent=s.llm?.error || (s.llm?.busy?'Thinking…':s.llm?.enabled?(s.llm.configured?'OpenAI summaries every 30 seconds; also listening for mentions and whispers.':'API key needed.'):'LLM chat is off.')
    if(!get('llm-settings').contains(document.activeElement)){get('llm-enabled').checked=!!s.llm?.enabled;if(s.llm?.model)get('llm-model').value=s.llm.model}
    const v=s.vitals
    get('vitals').textContent=v?`♥ ${v.health??'?'}/20 health   ·   Hunger ${v.food??'?'}/20${v.time!==null?`   ·   ${v.time<12500?'Day':'Night'}`:''}`:'Connect to see health and hunger.'
    const inv=JSON.stringify([s.inventory,s.connection])
    if(inv!==inventoryKey){inventoryKey=inv;get('inventory-chips').replaceChildren(...(s.inventory.length?s.inventory.map(i=>window.MarcIcons?window.MarcIcons.chip(i):element('span',`${i.name.replaceAll('_',' ')} × ${i.count}`,'inventory-chip')):[element('p',ready()?'Empty — Survive can start with bare hands.':'Waiting for world.','muted')]))}
    get('wheat-farm-status').textContent=s.wheatFarm?.decision || (s.task?.status==='running'?`Another skill is running: ${s.task.label}. Use Stop all actions, then start FARMER if you want wheat production only.`:'Ready to expand and harvest wheat continuously. Runs until Stop; requires Survival mode.')
    get('wheat-farm-stats').textContent=s.wheatFarm?`${s.wheatFarm.plots} nearby plants · ${s.wheatFarm.expanded || 0} new plots · ${s.wheatFarm.groundAdded || 0} ground blocks added · ${s.wheatFarm.stored} wheat stored · ${s.wheatFarm.chests.length} storage chests · ${s.wheatFarm.cycles} passes${s.wheatFarm.layout ? ` · level Y=${s.wheatFarm.layout.y} · protected walking lanes` : ''}`:''
    const run=JSON.stringify([s.survival,s.vitals?.gameMode])
    if(run!==survivalKey){survivalKey=run;get('survival-decision').textContent=s.survival?.decision || 'Ready when you are. Marc must be in Survival mode.';get('survival-steps').replaceChildren(...(s.survival?.steps||steps.map(label=>({label,status:'pending'}))).map((step,i)=>{const li=element('li','',`step ${step.status}`);li.append(element('span',step.status==='complete'?'✓':String(i+1),'step-number'));const body=element('div','');body.append(element('strong',step.label),element('span',step.status,'step-status'));if(step.detail)body.append(element('p',step.detail));li.append(body);return li}))}
    const scan=s.observation,sig=JSON.stringify(scan)
    if(sig!==surveyKey){surveyKey=sig;get('resource-cards').replaceChildren(...Object.entries(scan?.resources||{}).map(([name,r])=>{const e=element('div','','resource-card');e.append(element('strong',`${r.count}${r.capped?'+':''}`),element('span',name));return e}));get('survey-at').textContent=scan?`Within ${scan.radius} blocks of Marc · scanned ${new Date(scan.at).toLocaleTimeString()}. Loaded blocks may be hidden or unreachable.`:'Resources within 24 blocks of Marc.';const threats=scan?.entities.filter(e=>e.hostile)||[];get('nearby-threats').textContent=threats.length?`Nearby threats: ${threats.slice(0,4).map(e=>`${e.name} (${e.distance} blocks)`).join(', ')}`:scan?'No hostile mobs observed within the scan radius.':''}
    if(ready() && s.vitals?.gameMode!=='survival')get('survival-decision').textContent=`Marc is in ${s.vitals?.gameMode || 'another'} mode. Run /gamemode survival Marc in Minecraft chat, then press Start Survive.`
    const farmer=get('skill-choice').value==='farmer'
    get('skill-limits').textContent=farmer?'Continuous production within 80 blocks. Surfaces to restore low air, then resumes. Stop all actions cancels the skill.':'Starter routine · up to 20 minutes · resources within 80 blocks. Stop all actions cancels the skill.'
    if(get('skill-choice').value==='get torches'){get('skill-limits').textContent='Gets 16 torches from coal or charcoal. Requires Survival mode. Stop cancels the skill.';get('survival-decision').textContent=s.task?.skill==='GET TORCHES'?s.task.label:'Ready to gather materials and craft torches.'}
    if(farmer)get('survival-decision').textContent=s.wheatFarm?.decision || 'Choose Start FARMER to begin continuous wheat production.'
    draw();updateActions()
  }
  function index(e) {const r=canvas.getBoundingClientRect();return Math.min(map.size-1,Math.max(0,Math.floor((e.clientY-r.top)/r.height*map.size)))*map.size+Math.min(map.size-1,Math.max(0,Math.floor((e.clientX-r.left)/r.width*map.size)))}
  canvas.onpointerdown=e=>{if(!map || !ready())return;canvas.focus();canvas.setPointerCapture(e.pointerId);const i=index(e);selection={from:i,to:i};cursor=i;hover=i;drag=true;inspect(i);draw();updateActions()}
  canvas.onpointermove=e=>{if(!map)return;hover=index(e);if(drag)selection.to=hover;inspect(hover);draw();updateActions()}
  canvas.onpointerup=()=>{drag=false;updateActions()}
  canvas.onpointercancel=()=>{drag=false;selection=null;draw();updateActions()}
  canvas.onpointerleave=()=>{if(!drag){hover=null;draw()}}
  canvas.onkeydown=e=>{
    if(!map)return
    if(e.key==='Escape'){selection=null;hover=null;refresh(true);draw();return}
    if(e.key==='Enter'){e.preventDefault();selection={from:cursor,to:cursor};hover=cursor;inspect(cursor);draw();updateActions();return}
    const d={ArrowLeft:-1,ArrowRight:1,ArrowUp:-map.size,ArrowDown:map.size}[e.key]
    if(d===undefined)return
    e.preventDefault();const old=cursor;cursor=Math.max(0,Math.min(map.cells.length-1,cursor+d));hover=cursor
    if(e.shiftKey)selection={from:selection?.from??old,to:cursor}
    inspect(cursor);draw();updateActions()
  }
  async function act(action) {
    if(!selection || !available())return
    const body={snapshot:map.id,from:selection.from,to:selection.to,depth:Number(get('map-depth').value),action}
    acting=true;updateActions()
    try {if(await request('/api/map/action',body)){selection=null;refresh(true)}}finally{acting=false;updateActions()}
  }
  get('map-walk').onclick=()=>act('walk');get('map-mine').onclick=()=>act('mine')
  get('map-depth').onchange=updateActions
  get('map-refresh').onclick=()=>refresh(true)
  get('map-focus').onchange=()=>{offset=0;refresh(true)}
  get('map-down').onclick=()=>{offset=Math.max(-32,offset-4);refresh(true)}
  get('map-up').onclick=()=>{offset=Math.min(32,offset+4);refresh(true)}
  get('map-reset-height').onclick=()=>{offset=0;refresh(true)}
  get('map-download').onclick=()=>{if(!map)return;const a=document.createElement('a');a.href=canvas.toDataURL('image/png');a.download=`walkbot-map-${map.at}.png`;a.click()}
  get('wheat-farm').onclick=async()=>{if(!available())return;acting=true;updateActions();try{await command('farmer')}finally{acting=false;updateActions()}}
  get('llm-settings').onsubmit=async e=>{e.preventDefault();try{const response=await fetch('/api/llm',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled:get('llm-enabled').checked,model:get('llm-model').value.trim(),apiKey:get('llm-key').value})});const data=await response.json();if(!response.ok)throw new Error(data.error);get('llm-key').value='';get('llm-status').textContent='Settings saved.'}catch(error){get('llm-status').textContent=error.message}}
  get('skill-choice').onchange=()=>{const farmer=get('skill-choice').value==='farmer';get('skill-description').textContent=get('skill-choice').value==='get torches'?'Gather coal or make charcoal, then craft 16 torches.':farmer?'Continuously expands, harvests and replants wheat, and stores surplus in chests. Runs until Stop.':'Gathers supplies, crafts tools, then expands and harvests a wheat farm toward 128 wheat.';get('survival-steps').hidden=get('skill-choice').value!=='survive';if(latest)renderState(latest,online);else updateActions()}
  get('survive').onclick=async()=>{if(!available())return;acting=true;updateActions();try{await command(get('skill-choice').value)}finally{acting=false;updateActions()}}
  get('survey').onclick=survey
  document.addEventListener('walkbot-state',e=>renderState(e.detail.state,e.detail.connected))
  setInterval(()=>{if(document.hidden)return;updateActions();if(ready()){refresh();if(Date.now()-lastScan>10000)survey()}},4000)
  draw()
})()
