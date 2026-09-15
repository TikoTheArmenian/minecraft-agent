const { test } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { Agent, parse } = require('../src/agents/agent.cjs')
const { createApp } = require('../src/web/server.cjs')
function setup(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'walkbot-test-'))
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}))
  const agent=new Agent({dataDir:dir})
  let resolve,reject
  agent.bot={entity:{position:{x:0,y:64,z:0}},pathfinder:{setGoal(){},goto(){return new Promise((a,b)=>{resolve=a;reject=b})}},clearControlStates(){},quit(){}}
  agent.state.connection='ready';agent.state.dimension='overworld'
  t.after(()=>agent.stop(false))
  return {agent,resolve:()=>resolve(),reject:()=>reject(new Error('NoPath'))}
}
test('commands accept familiar phrasing and enforce bounds',()=>{
  assert.deepEqual(parse('go to 10 64 -20'),{type:'goto',x:10,y:64,z:-20})
  assert.deepEqual(parse('search for oak logs within 32 blocks'),{type:'find',name:'oak_logs',radius:32})
  assert.equal(parse('save as base').name,'base')
  assert.throws(()=>parse('find stone 1000'))
  assert.throws(()=>parse('go to 999999999 64 0'))
  assert.throws(()=>parse('destroy everything'))
})
test('stop suppresses late navigation completion',async t=>{
  const h=setup(t);h.agent.command('go to 10 64 0');await new Promise(setImmediate);h.agent.command('stop');h.resolve();await new Promise(setImmediate)
  assert.equal(h.agent.state.task.status,'cancelled')
  assert.ok(!h.agent.state.messages.some(m=>m.text.startsWith('Arrived')))
})
test('unreachable path reports failure',async t=>{
  const h=setup(t);h.agent.command('go to 10 64 0');await new Promise(setImmediate);h.reject();await new Promise(setImmediate)
  assert.equal(h.agent.state.task.status,'failed')
})
test('waypoints persist and remain separate across worlds',t=>{
  const {agent}=setup(t);agent.command('save base')
  const reloaded=new Agent({dataDir:agent.dataDir});reloaded.state.dimension='overworld';reloaded.waypoints()
  assert.equal(reloaded.state.waypoints.base.y,64)
  reloaded.state.world='Other world';reloaded.waypoints();assert.equal(Object.keys(reloaded.state.waypoints).length,0)
})
test('API rejects cross-origin writes and handles invalid commands',async t=>{
  const {agent}=setup(t)
  const server=createApp(agent).listen(0,'127.0.0.1')
  await new Promise(resolve=>server.once('listening',resolve))
  t.after(()=>{server.closeAllConnections();server.close()})
  const url=`http://127.0.0.1:${server.address().port}`
  assert.equal((await fetch(url)).status,200)
  assert.equal((await fetch(url+'/api/command',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://example.com'},body:'{"text":"stop"}'})).status,403)
  const result=await fetch(url+'/api/command',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"text":"go to 999999999 64 0"}'})
  assert.equal(result.status,400)
  assert.equal((await fetch(url+'/api/state')).status,200)
})
test('disconnect during preflight prevents a delayed connection',async t=>{
  let resolvePing,created=false
  const agent=new Agent({dataDir:fs.mkdtempSync(path.join(os.tmpdir(),'walkbot-connect-')),statusPing:()=>new Promise(r=>resolvePing=r),createBot:()=>{created=true}})
  t.after(()=>fs.rmSync(agent.dataDir,{recursive:true,force:true}))
  const pending=agent.connect(25565);agent.disconnect();resolvePing({version:{protocol:767}});await pending
  assert.equal(created,false);assert.equal(agent.state.connection,'disconnected')
})
test('empty path cannot falsely announce arrival',async t=>{
  const h=setup(t);h.agent.command('go to 10 64 0');await new Promise(setImmediate);h.resolve();await new Promise(setImmediate)
  assert.equal(h.agent.state.task.status,'failed')
})
test('observed destination produces a successful task',async t=>{
  const h=setup(t);h.agent.command('go to 10 64 0');await new Promise(setImmediate);h.agent.bot.entity.position.x=10;h.resolve();await new Promise(setImmediate)
  assert.equal(h.agent.state.task.status,'succeeded')
})

function lifecycle(t, options={}) {
  const registry=require('minecraft-data')('1.21.1')
  const {Vec3}=require('vec3')
  const bot=Object.assign(new EventEmitter(),{registry,game:{dimension:'overworld',gameMode:'survival'},entity:{position:new Vec3(0,64,0)},inventory:{items:()=>[]},pathfinder:{setGoal(){},setMovements(){},goto:async()=>{}},loadPlugin(){},waitForChunksToLoad:async()=>{},clearControlStates(){},stopDigging(){},quit(){this.closed=true}})
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'walkbot-life-'))
  const agent=new Agent({dataDir,createBot:()=>bot,statusPing:async()=>({version:{protocol:767}}),...options})
  t.after(()=>{agent.disconnect();fs.rmSync(dataDir,{recursive:true,force:true})})
  return {bot,agent}
}
test('connection without spawn times out and closes the bot',async t=>{
  const {agent,bot}=lifecycle(t,{spawnTimeoutMs:15})
  await agent.connect(25565)
  await new Promise(r=>setTimeout(r,30))
  assert.equal(agent.state.connection,'disconnected');assert.equal(bot.closed,true)
})
test('disconnect clears stale results, waypoints, position and inventory',async t=>{
  const {agent}=lifecycle(t)
  Object.assign(agent.state,{inventory:[{name:'pickaxe'}],results:[{x:1}],waypoints:{base:{x:1,y:64,z:1}},dimension:'overworld'})
  agent.disconnect()
  assert.deepEqual(agent.state.inventory,[]);assert.deepEqual(agent.state.results,[]);assert.deepEqual(agent.state.waypoints,{})
  assert.equal(agent.state.dimension,null)
})
test('a late spawn loading result cannot resurrect a disconnected session',async t=>{
  const {bot,agent}=lifecycle(t)
  let finish
  bot.waitForChunksToLoad=()=>new Promise(r=>finish=r)
  await agent.connect(25565);bot.emit('spawn');agent.disconnect();finish();await new Promise(setImmediate)
  assert.equal(agent.state.connection,'disconnected')
})
test('dimension changes cancel work before new chunks load',async t=>{
  const {bot,agent}=lifecycle(t)
  await agent.connect(25565);bot.emit('spawn');await new Promise(setImmediate)
  agent.state.task={status:'running'};agent.state.results=[{name:'stone'}]
  bot.game.dimension='the_nether';bot.emit('game')
  assert.equal(agent.state.connection,'loading');assert.equal(agent.state.task.status,'cancelled');assert.deepEqual(agent.state.results,[])
})
test('invalid port types and corrupt waypoint data fail clearly',async t=>{
  const {agent}=lifecycle(t)
  for(const port of [true,{},'2.5','1e3'])await assert.rejects(agent.connect(port),/numeric LAN port/)
  fs.writeFileSync(path.join(agent.dataDir,'waypoints.json'),'null')
  assert.throws(()=>new Agent({dataDir:agent.dataDir}),/JSON object/)
})
test('plugin initialization failure cleans up the partially created bot',async t=>{
  const {agent,bot}=lifecycle(t)
  bot.loadPlugin=()=>{throw new Error('plugin failure')}
  await assert.rejects(agent.connect(25565),/plugin failure/)
  assert.equal(bot.closed,true);assert.equal(agent.bot,null)
})
test('API validates JSON and retains the conversation after fetching state again',async t=>{
  const {agent}=setup(t)
  const server=createApp(agent).listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r))
  t.after(()=>{server.closeAllConnections();server.close()})
  const base=`http://127.0.0.1:${server.address().port}`
  const post=body=>fetch(base+'/api/command',{method:'POST',headers:{'Content-Type':'application/json'},body})
  assert.equal((await post('[]')).status,400)
  assert.equal((await post('{')).status,400)
  assert.equal((await post(JSON.stringify({text:'x'.repeat(5000)}))).status,413)
  assert.equal((await post('{"text":"position"}')).status,200)
  const state=await(await fetch(base+'/api/state')).json()
  assert.ok(state.messages.some(m=>m.role==='user'&&m.text==='position'))
  assert.equal((await fetch(base+'/api/unknown')).status,404)
})
test('EventSource disconnect removes its typed event listeners',async t=>{
  const {agent}=setup(t)
  const {EVENT_TYPES}=require('../src/web/events.cjs')
  const before=Object.fromEntries(EVENT_TYPES.map(type=>[type,agent.listenerCount(type)]))
  const server=createApp(agent).listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r))
  t.after(()=>{server.closeAllConnections();server.close()})
  const controller=new AbortController()
  const response=await fetch(`http://127.0.0.1:${server.address().port}/api/events`,{signal:controller.signal})
  const reader=response.body.getReader();await reader.read()
  for(const type of EVENT_TYPES)assert.equal(agent.listenerCount(type),before[type]+1)
  assert.equal(agent.listenerCount('state'),0)
  controller.abort();await new Promise(r=>setTimeout(r,30))
  for(const type of EVENT_TYPES)assert.equal(agent.listenerCount(type),before[type])
})
test('a synchronous pathfinder error is reported without leaving a running task',async t=>{
  const {agent}=setup(t);agent.bot.pathfinder.goto=()=>{throw new Error('Path calculation failed')}
  agent.command('go to 10 64 0');await new Promise(setImmediate)
  assert.equal(agent.state.task.status,'failed')
})
test('Stop before deferred navigation starts sends no new goal',async t=>{
  const {agent}=setup(t);let calls=0;agent.bot.pathfinder.goto=async()=>{calls++}
  agent.command('go to 10 64 0');agent.stop();await new Promise(setImmediate)
  assert.equal(calls,0)
})
test('prototype-like names are rejected by block search',async t=>{
  const {agent}=setup(t);agent.bot.registry={blocksByName:{stone:{id:1}}}
  assert.throws(()=>agent.command('find constructor'),/Unknown block/)
})

test('a burst of state changes reaches the browser without closing its event stream',async t=>{
  const {agent}=setup(t)
  const server=createApp(agent).listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r))
  t.after(()=>{server.closeAllConnections();server.close()})
  const abort=new AbortController()
  t.after(()=>abort.abort())
  const response=await fetch(`http://127.0.0.1:${server.address().port}/api/events?events=none&snapshotMs=100`,{signal:abort.signal})
  const reader=response.body.getReader();await reader.read()
  for(let n=0;n<2000;n++){agent.state.burst=n;agent.publish()}
  const update=await reader.read()
  assert.equal(update.done,false)
  const text=new TextDecoder().decode(update.value)
  assert.equal(JSON.parse(text.split('data: ')[1]).burst,1999)
  agent.state.burst=2000;agent.publish()
  assert.equal((await reader.read()).done,false)
})

test('event subscription options are validated before opening the stream',async t=>{
  const {agent}=setup(t)
  const server=createApp(agent).listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r))
  t.after(()=>{server.closeAllConnections();server.close()})
  const url=`http://127.0.0.1:${server.address().port}/api/events`
  for(const query of ['events=unknown','events=skill.result%0Aevent%3Aevil','events=a&events=b','events=',
    'snapshotMs=0','snapshotMs=99','snapshotMs=60001','snapshotMs=1e3','snapshotMs=100&snapshotMs=200']) {
    const response=await fetch(`${url}?${query}`)
    assert.equal(response.status,400,query)
    assert.match(response.headers.get('content-type'),/application\/json/)
    assert.equal(typeof (await response.json()).error,'string')
  }
})

async function readEvents(t,url) {
  const abort=new AbortController();t.after(()=>abort.abort())
  const response=await fetch(url,{signal:abort.signal})
  assert.equal(response.status,200)
  const reader=response.body.getReader(),decoder=new TextDecoder()
  let buffer=''
  return async()=>{
    while(true) {
      const end=buffer.indexOf('\n\n')
      if(end>=0) {
        const frame=buffer.slice(0,end);buffer=buffer.slice(end+2)
        if(!frame.includes('data: '))continue
        return {type:frame.match(/^event: (.+)$/m)?.[1] || 'message',data:JSON.parse(frame.match(/^data: (.+)$/m)[1])}
      }
      const chunk=await reader.read()
      assert.equal(chunk.done,false,'event stream remains open')
      buffer+=decoder.decode(chunk.value,{stream:true})
    }
  }
}

test('named SSE delivers actual skill results and message statuses only for the selected bot', {timeout:5000}, async t=>{
  const {agent:marc}=setup(t),tree=setup(t)
  tree.agent.id='tree'
  const server=createApp(marc,{marc,tree:tree.agent}).listen(0,'127.0.0.1')
  await new Promise(r=>server.once('listening',r))
  t.after(()=>{server.closeAllConnections();server.close()})
  const url=`http://127.0.0.1:${server.address().port}`
  const options='/api/events?events=skill.result,message.delivery&snapshotMs=60000'
  const marcNext=await readEvents(t,url+'/bots/marc'+options),treeNext=await readEvents(t,url+'/bots/tree'+options)
  assert.equal((await marcNext()).type,'message')
  assert.equal((await treeNext()).type,'message')
  marc.messages.deliveries.set('marc-delivery',{id:'marc-delivery'})
  marc.messages.reset()
  tree.agent.messages.deliveries.set('tree-delivery',{id:'tree-delivery'})
  tree.agent.messages.reset()
  for(const [next,botId,id] of [[marcNext,marc.id,'marc-delivery'],[treeNext,'tree','tree-delivery']]) {
    const event=await next()
    assert.equal(event.type,'message.delivery')
    assert.equal(event.data.botId,botId)
    assert.deepEqual(event.data.payload,{id,status:'cancelled',reason:'SESSION_CHANGED'})
  }
  tree.agent.command('go to 10 64 0');await new Promise(setImmediate)
  tree.agent.bot.entity.position.x=10;tree.resolve()
  const result=await treeNext()
  assert.equal(result.type,'skill.result')
  assert.equal(result.data.botId,'tree')
  assert.equal(result.data.payload.outcome,'succeeded')
  assert.equal(result.data.payload.runId,tree.agent.state.task.runId)
})

test('fleet commands, maps, logs and state remain isolated; global stop reaches all four',async t=>{
  const {agent:marc}=setup(t),{agent:tree}=setup(t),{agent:barneett}=setup(t),{agent:sam}=setup(t)
  marc.state.username='Marc';tree.state.username='Jerry';barneett.state.username='Barneett';sam.state.username='Sam'
  const commands=[[],[],[],[]]
  marc.command=text=>commands[0].push(text);tree.command=text=>commands[1].push(text);barneett.command=text=>commands[2].push(text);sam.command=text=>commands[3].push(text)
  let stopped=0;marc.stop=()=>stopped++;tree.stop=()=>stopped++;barneett.stop=()=>stopped++;sam.stop=()=>stopped++
  marc.maps.snapshot=()=>({owner:'marc'});tree.maps.snapshot=()=>({owner:'tree'})
  const server=createApp(marc,{marc,tree,barneett,sam}).listen(0,'127.0.0.1')
  await new Promise(r=>server.once('listening',r));t.after(()=>{server.closeAllConnections();server.close()})
  const url=`http://127.0.0.1:${server.address().port}`
  const post=(route,data)=>fetch(url+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)})
  assert.equal((await post('/bots/tree/api/command',{text:'farm trees'})).status,200)
  assert.equal((await post('/bots/barneett/api/command',{text:'practice-movement'})).status,200)
  assert.equal((await post('/bots/sam/api/command',{text:'storage and crafting'})).status,200)
  assert.deepEqual(commands,[[],['farm trees'],['practice-movement'],['storage and crafting']])
  assert.equal((await (await fetch(url+'/bots/sam/api/state')).json()).username,'Sam')
  assert.equal((await (await fetch(url+'/bots/barneett/api/state')).json()).username,'Barneett')
  assert.equal((await (await fetch(url+'/bots/tree/api/state')).json()).username,'Jerry')
  assert.equal((await (await fetch(url+'/bots/marc/api/map')).json()).owner,'marc')
  assert.equal((await (await fetch(url+'/bots/tree/api/map')).json()).owner,'tree')
  assert.deepEqual(Object.keys(await (await fetch(url+'/api/fleet')).json()),['marc','tree','barneett','sam'])
  assert.equal((await post('/api/stop-all',{})).status,200);assert.equal(stopped,4)
  assert.equal((await post('/bots/unknown/api/command',{text:'stop'})).status,404)
})

test('one fleet SSE subscription receives both bots through the shared bus and periodic fleet snapshots', {timeout:5000}, async t=>{
  const {agent:marc}=setup(t),{agent:tree}=setup(t)
  tree.id='tree'
  const fleet={marc,tree},recorded=[]
  const app=createApp(marc,fleet)
  const sourceListeners=marc.listenerCount('travel.route')
  createApp(marc,fleet)
  assert.equal(marc.listenerCount('travel.route'),sourceListeners,'mounting another app does not duplicate the bus')
  fleet.events.on('event',e=>recorded.push(e))
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r))
  t.after(()=>{server.closeAllConnections();server.close();fleet.events.close()})
  const url=`http://127.0.0.1:${server.address().port}`
  assert.equal((await fetch(url+'/api/fleet/events?events=unknown')).status,400)
  const next=await readEvents(t,url+'/api/fleet/events?events=travel.route,skill.result&snapshotMs=1000')
  const initial=await next()
  assert.equal(initial.type,'message')
  assert.deepEqual(Object.keys(initial.data),['marc','tree'])
  assert.equal(initial.data.marc.profile.id,marc.profile.id)
  assert.equal(fleet.events.listenerCount('travel.route'),1)
  assert.equal(marc.listenerCount('travel.route'),sourceListeners,'SSE subscribes only to the fleet bus')
  marc.emit('travel.route',{taskId:1,route:{path:[{x:1,y:64,z:0}]}})
  tree.emit('skill.progress',{counts:{mined:1}})
  tree.emit('skill.result',{runId:'tree-run',outcome:'succeeded'})
  for(const expected of [recorded[0],recorded[2]]) {
    const event=await next()
    assert.equal(event.type,expected.type)
    assert.deepEqual(event.data,expected,'the original envelope is sent without rewrapping or restamping')
  }
  tree.state.fleetTest=true
  const updated=await next()
  assert.equal(updated.type,'message')
  assert.equal(updated.data.tree.fleetTest,true)
  assert.deepEqual(Object.keys(updated.data),['marc','tree'])
  server.closeAllConnections()
  await new Promise(r=>setTimeout(r,30))
  assert.equal(fleet.events.listenerCount('travel.route'),0)
  assert.equal(fleet.events.listenerCount('skill.result'),0)
  assert.equal(marc.listenerCount('travel.route'),sourceListeners,'closing a viewer keeps in-process forwarding alive')
})

test('Jerry preflight permits Marc online and checks its own duplicate identity',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'treebot-connect-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}))
  let username
  const tree=new Agent({username:'Jerry',dataDir:dir,statusPing:async()=>({version:{protocol:767},players:{sample:[{name:'Marc'}]}}),createBot:options=>{username=options.username;throw new Error('fixture ends at socket creation')}})
  await assert.rejects(tree.connect(25565),/fixture ends/);assert.equal(username,'Jerry')
  tree.statusPing=async()=>({version:{protocol:767},players:{sample:[{name:'Jerry'}]}})
  await assert.rejects(tree.connect(25565),/Jerry is already connected/)
})
