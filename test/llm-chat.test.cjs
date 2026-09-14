const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path')
const {LlmChat}=require('../src/llm-chat.cjs')
function setup(t,fetchImpl){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mc-chat-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const sent=[];const bot={username:'Marc',chat:s=>sent.push(s),whisper:(u,s)=>sent.push(`${u}: ${s}`)};const agent={username:'Marc',dataDir:dir,bot,epoch:1,state:{task:{status:'running',label:'Planting wheat'},inventory:[]},publish(){},log(){},say(){}};const chat=new LlmChat(agent,{fetchImpl});chat.configure({enabled:true,model:'test-model',apiKey:'test-secret'});return {chat,agent,bot,sent}}
test('addressed chat uses live task and never exposes key in state or prompt',async t=>{
 let body;const f=setup(t,async(url,o)=>{body=JSON.parse(o.body);return {ok:true,json:async()=>({output:[{type:'message',content:[{type:'output_text',text:'I am planting wheat.'}]}]})}})
 await f.chat.receive(f.bot,'Player','Marc, what are you doing?');assert.equal(f.sent.length,1);assert.match(body.input[0].content,/Planting wheat/);assert.equal(JSON.stringify(body).includes('test-secret'),false);assert.equal(JSON.stringify(f.agent.state).includes('test-secret'),false);assert.equal(body.store,false);assert.equal(f.agent.state.llm.busy,false)
})
test('unaddressed and self messages do not call OpenAI; whispers do',async t=>{
 let calls=0;const f=setup(t,async()=>{calls++;return {ok:true,json:async()=>({output:[{type:'message',content:[{type:'output_text',text:'/stop\nhello'}]}]})}})
 await f.chat.receive(f.bot,'Player','hello');await f.chat.receive(f.bot,'Marc','Marc hello');assert.equal(calls,0)
 await f.chat.receive(f.bot,'Player','hello',true);assert.equal(calls,1);assert.equal(f.sent[0],'Player: /stop hello')
})
test('disconnect discards a late reply',async t=>{
 let resolve;const f=setup(t,()=>new Promise(r=>{resolve=r}));const pending=f.chat.receive(f.bot,'Player','Marc hello');f.chat.cancel();f.agent.bot=null;resolve({ok:true,json:async()=>({output:[{type:'message',content:[{type:'output_text',text:'late'}]}]})});await pending;assert.equal(f.sent.length,0)
})
test('HTTP errors are visible without logging response secrets',async t=>{const f=setup(t,async()=>({ok:false,status:401}));await f.chat.receive(f.bot,'Player','Marc hello');assert.match(f.agent.state.llm.error,/401/);assert.equal(f.sent.length,0)})
test('periodic summaries compare prior progress and request terse unchanged updates',async t=>{
 const bodies=[];const f=setup(t,async(url,o)=>{bodies.push(JSON.parse(o.body));return {ok:true,json:async()=>({output:[{type:'message',content:[{type:'output_text',text:'Still working on planting wheat.'}]}]})}})
 t.after(()=>clearInterval(f.chat.summaryTimer));f.agent.state.connection='ready';f.agent.state.logs=[]
 await f.chat.summarize();await f.chat.summarize()
 assert.equal(JSON.parse(bodies[0].input[0].content).previous,null)
 assert.equal(JSON.parse(bodies[1].input[0].content).unchanged,true)
 assert.match(bodies[1].instructions,/Still working/);assert.ok(f.sent.every(s=>s.startsWith('[Update] ')));assert.equal(f.chat.history.length,0)
 f.agent.state.task.counts={planted:4};await f.chat.summarize();assert.equal(JSON.parse(bodies[2].input[0].content).unchanged,false)
})
