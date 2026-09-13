const {test}=require('node:test')
const assert=require('node:assert/strict')
const fs=require('node:fs')
const os=require('node:os')
const path=require('node:path')
const {ActivityLog,survivalAvailability}=require('../src/activity-log.cjs')
const {Agent}=require('../src/agent.cjs')
const {createApp}=require('../src/server.cjs')
const {fixture}=require('./helpers/survival-fixture.cjs')
function temp(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'walkbot-log-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir}
test('readiness distinguishes idle Creative, active work, stopping and ready Survival',()=>{
  const s={connection:'ready',busy:false,task:null,vitals:{gameMode:'creative'}}
  assert.equal(survivalAvailability(s).code,'game-mode');assert.match(survivalAvailability(s).reason,/No task is running/)
  s.vitals.gameMode='survival';assert.equal(survivalAvailability(s).canStart,true)
  s.busy=true;s.task={status:'running',label:'Craft wooden pickaxe'};assert.equal(survivalAvailability(s).code,'busy')
  s.task.status='cancelled';assert.equal(survivalAvailability(s).code,'stopping')
  s.connection='disconnected';assert.equal(survivalAvailability(s).code,'disconnected')
})
test('activity log writes readable bounded files and rotates the previous file',t=>{
  const dir=temp(t),log=new ActivityLog(dir,{maxBytes:300})
  log.write('action.start','Crafting a pickaxe','info',{taskId:1})
  assert.match(fs.readFileSync(log.file,'utf8'),/INFO.*Crafting a pickaxe/)
  for(let n=0;n<210;n++)log.write('test',`Event ${n}`)
  assert.equal(log.entries.length,200);assert.ok(fs.existsSync(log.file+'.1'))
  assert.ok(fs.statSync(log.file).size<=300);assert.ok(fs.statSync(log.file+'.1').size<=300)
  const restarted=new ActivityLog(dir);restarted.write('server.ready','Restarted')
  assert.match(fs.readFileSync(log.file,'utf8'),/Restarted/)
})
test('logging errors stay visible without crashing bot work',t=>{
  const dir=temp(t),file=path.join(dir,'not-a-directory');fs.writeFileSync(file,'test')
  const log=new ActivityLog(file);assert.doesNotThrow(()=>log.write('test','Message'))
  assert.equal(log.entries.length,1);assert.match(log.error,/Could not save activity log/)
})
test('logs cannot inject extra terminal lines or escape sequences',t=>{
  const log=new ActivityLog(temp(t));log.write('test','hello\nFAKE\u001b[31m')
  const saved=fs.readFileSync(log.file,'utf8');assert.equal(saved.trim().split('\n').length,1);assert.ok(!saved.includes('\u001b'))
})
test('in-flight actions expose their name and deadline, and record completion',async()=>{
  const f=fixture(),events=[];f.agent.log=(...args)=>events.push(args);let finish
  const run=f.work.timed(()=>new Promise(r=>finish=r),10000,'Craft wooden pickaxe')
  await new Promise(setImmediate)
  const action=f.agent.state.task.action
  assert.equal(action.label,'Craft wooden pickaxe');assert.equal(action.status,'running');assert.equal(action.deadlineAt-action.startedAt,10000)
  finish();await run
  assert.equal(action.status,'succeeded');assert.ok(action.endedAt);assert.ok(events.some(e=>e[0]==='action.complete'))
})
test('failed actions retain a concrete error instead of an unexplained running label',async()=>{
  const f=fixture(),events=[];f.agent.log=(...args)=>events.push(args)
  await assert.rejects(f.work.timed(async()=>{throw new Error('No path to target')},10000,'Walk to oak log'),/No path/)
  assert.equal(f.agent.state.task.action.status,'failed');assert.match(f.agent.state.task.action.error,/No path/)
  assert.ok(events.some(e=>e[0]==='action.failed' && e[2]==='error'))
})
test('log endpoints expose saved events and rejected commands are recorded',async t=>{
  const agent=new Agent({dataDir:temp(t)}),server=createApp(agent).listen(0,'127.0.0.1')
  await new Promise(r=>server.once('listening',r));t.after(()=>{server.closeAllConnections();server.close()})
  const url=`http://127.0.0.1:${server.address().port}`
  const rejected=await fetch(url+'/api/command',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:'survive'})})
  assert.equal(rejected.status,400)
  const logs=await fetch(url+'/api/logs').then(r=>r.json());assert.ok(logs.entries.some(e=>e.event==='request.rejected'))
  const download=await fetch(url+'/api/logs/download');assert.equal(download.status,200);assert.match(await download.text(),/Connect and wait/)
  assert.match(download.headers.get('content-disposition'),/walkbot-activity.log/)
})
