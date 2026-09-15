const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { ApiCosts } = require('../src/infra/api-costs.cjs')
const { usageOf, estimate } = require('../src/infra/api-pricing.cjs')
const { LlmChat } = require('../src/messaging/llm-chat.cjs')
const { Colony } = require('../src/storage/colony.cjs')
const { createApp } = require('../src/web/server.cjs')
const { Agent } = require('../src/agents/agent.cjs')
const { queryFilter } = require('../src/web/cost-routes.cjs')
const usage = { input_tokens: 1000, input_tokens_details: { cached_tokens: 400, cache_write_tokens: 200 },
  output_tokens: 200, output_tokens_details: { reasoning_tokens: 100 }, total_tokens: 1200 }
function result(id = 'resp_test') {
  return { id, model: 'gpt-5.6-luna', service_tier: 'default', status: 'completed', usage,
    output: [{type:'message',content:[{type:'output_text',text:'Working on the farm.'}]}] }
}
function setup(t, now = () => Date.parse('2026-09-14T15:00:00Z')) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-cost-'))
  const ledger = new ApiCosts({ file: path.join(dir, 'costs.sqlite'), now })
  t.after(() => { ledger.close(); fs.rmSync(dir, { recursive: true, force: true }) })
  return { dir, ledger }
}
function record(ledger, agent, id, response = result(id)) {
  const token = ledger.begin({ agent, provider: 'openai', operation: 'chat', model: 'gpt-5.6-luna' })
  ledger.finish(token, { result: response, httpStatus: 200 })
  return token
}
function chat(t, fetchImpl) {
  const h = setup(t), sent = [], bot = { username: 'Marc', chat: t => sent.push(t) }
  const agent = { username:'Marc',dataDir:h.dir,apiCosts:h.ledger,bot,epoch:1,nav:1,state:{},publish(){},log(){},say(){} }
  const llm = new LlmChat(agent, { env: { OPENAI_API_KEY: 'sk-never-store-me' }, fetchImpl })
  return { ...h, sent, bot, agent, llm }
}
test('prices uncached input, cached input and writes separately; reasoning is already in output', () => {
  const priced = estimate('gpt-5.6-luna', 'default', usageOf(usage))
  assert.equal(priced.costNano, 378000) // 400*.2 + 400*.02 + 200*.25 + 200*1.2, in nano USD
  assert.equal(priced.pricingStatus, 'estimated')
  assert.equal(estimate('gpt-5.6-luna', 'fast', usageOf(usage)).costNano, 756000)
  assert.equal(estimate('gpt-5.6-luna', 'flex', usageOf(usage)).costNano, 189000)
})
test('long-context boundary and unknown models/tiers never silently use ordinary prices', () => {
  const u = { ...usageOf(usage), input: 272000 }
  assert.equal(estimate('gpt-5.6-luna','default',u).price.context, 'short')
  assert.equal(estimate('gpt-5.6-luna','default',{...u,input:272001}).price.input, .4)
  assert.equal(estimate('gpt-5.6-luna','default',{...u,input:272001}).price.output, 1.8)
  assert.equal(estimate('unknown','default',u).costNano, null)
  assert.equal(estimate('gpt-5.6-luna','auto',u).pricingStatus, 'unknown_tier')
  assert.equal(usageOf({...usage,input_tokens:2}), null)
  assert.equal(usageOf({...usage,output_tokens:-1}), null)
  const partial = usageOf({input_tokens:100,output_tokens:2})
  assert.equal(partial.input,100)
  assert.equal(estimate('gpt-5.6-luna','default',partial).pricingStatus,'unknown_usage')
})
test('ledger is persistent, exactly once per response, and attributable by agent', t => {
  const { ledger, dir } = setup(t)
  const id = record(ledger,'Marc','resp_one')
  ledger.finish(id, {result:result('resp_one')})
  record(ledger,'Marc','resp_one')
  record(ledger,'Jerry','resp_two')
  let data = ledger.summary({}, ['Marc','Jerry','Sam'])
  assert.equal(data.total.requests, 3)
  assert.equal(data.total.costNano, 756000)
  assert.equal(data.total.inputTokens, 2000)
  assert.equal(data.agents.find(a => a.name==='Sam').requests, 0)
  assert.equal(data.agents.find(a => a.name==='Jerry').costNano, 378000)
  assert.equal(data.recent.filter(r => r.pricing_status==='duplicate').length, 1)
  ledger.close()
  const reopened = new ApiCosts({file:path.join(dir,'costs.sqlite')})
  t.after(() => reopened.close())
  assert.equal(reopened.summary().total.costNano, 756000)
  assert.equal(fs.statSync(path.join(dir,'costs.sqlite')).mode & 0o777, 0o600)
})
test('missing usage and interrupted requests stay visible as unknown rather than free', t => {
  let now = Date.parse('2026-09-14T00:00:00Z')
  const { ledger } = setup(t, () => now)
  const pending = ledger.begin({agent:'Jerry',provider:'openai',operation:'chat',model:'gpt-5.6-luna'})
  record(ledger,'Marc','resp_missing',{model:'gpt-5.6-luna',id:'resp_missing'})
  assert.equal(ledger.summary().total.pending, 1)
  now += 61000
  let data = ledger.summary()
  assert.equal(data.total.pending,0)
  assert.equal(data.total.unknownCosts,2)
  assert.equal(data.recent.find(r => r.id===pending).outcome,'interrupted')
  ledger.finish(pending,{result:result('resp_late')})
  data = ledger.summary()
  assert.equal(data.total.unknownCosts,1)
  assert.equal(data.total.costNano,378000)
})
test('date filters and project/per-agent alerts are independent and use UTC', t => {
  let now = Date.parse('2026-08-31T23:59:59Z')
  const { ledger } = setup(t, () => now)
  record(ledger,'Marc','resp_aug')
  now = Date.parse('2026-09-01T00:00:01Z')
  record(ledger,'Jerry','resp_sep')
  ledger.setBudget({scope:'project',dailyUsd:.0004,monthlyUsd:.0003})
  ledger.setBudget({scope:'Marc',dailyUsd:.0001})
  const data = ledger.summary(queryFilter({from:'2026-08-01',to:'2026-08-31'}))
  assert.equal(data.total.requests,1)
  assert.equal(data.month.requests,1)
  assert.deepEqual(data.alerts.map(a => a.level),['approaching','exceeded'])
  assert.throws(() => ledger.setBudget({scope:'Marc',dailyUsd:-1}))
  assert.throws(() => queryFilter({from:'2026-02-30'}))
  assert.throws(() => ledger.summary({from:10,to:5}))
  assert.equal(ledger.error,null)
  assert.equal(ledger.summary(queryFilter({from:'2020-01-01',to:'2020-02-01'})).daily.length,0)
})
test('successful usage is recorded before empty replies and locally cancelled replies are discarded', async t => {
  let resolve
  const h = chat(t, () => new Promise(r => {resolve=r}))
  const pending = h.llm.receive(h.bot,'Player','Marc, hello')
  h.llm.cancel(); h.agent.bot = null
  resolve({ok:true,status:200,json:async()=>result('resp_late'),headers:new Headers({'x-request-id':'req_test'})})
  await pending
  assert.equal(h.sent.length,0)
  assert.equal(h.ledger.summary().total.costNano,378000)
  assert.equal(h.ledger.records()[0].request_id,'req_test')
  assert.equal(JSON.stringify(h.ledger.records()).includes('sk-never-store-me'),false)
  assert.equal(JSON.stringify(h.ledger.records()).includes('Working on the farm'),false)
})
test('empty output and failed delivery still retain billed tokens', async t => {
  const h = chat(t, async () => ({ok:true,status:200,json:async()=>({...result('resp_empty'),output:[]})}))
  await h.llm.receive(h.bot,'Player','Marc hello')
  assert.equal(h.ledger.summary().total.costNano,378000)
  assert.equal(h.sent.length,0)
})
test('disabled, unaddressed and explicit skill commands do not incur an API record', async t => {
  const h = chat(t, async () => assert.fail('no API call expected'))
  await h.llm.receive(h.bot,'Player','hello')
  h.llm.configure({enabled:false})
  await h.llm.receive(h.bot,'Player','Marc hello')
  assert.equal(h.ledger.summary().total.requests,0)
})
test('HTTP, network and abort failures record unknown costs without raw response secrets', async t => {
  const h = chat(t, async () => ({ok:false,status:429,json:async()=>({error:'sk-secret'})}))
  await h.llm.receive(h.bot,'Player','Marc hello')
  assert.equal(h.ledger.records()[0].outcome,'http_error')
  h.llm.fetch = async () => {throw new Error('secret-network-message')}
  await h.llm.receive(h.bot,'Player','Marc hello')
  assert.equal(h.ledger.summary().total.unknownCosts,2)
  assert.equal(JSON.stringify(h.ledger.records()).includes('secret'),false)
})
test('Supabase requests include world resolution once and per-agent RPC volume, without inventing dollar costs', async t => {
  const { ledger } = setup(t)
  const colony = new Colony({url:'https://example.test',key:'secret',apiCosts:ledger,fetchImpl:async()=>({ok:true,status:200,json:async()=>({id:'world-id'})})})
  const marc = {username:'Marc',apiCosts:ledger,state:{world:'test',dimension:'overworld'}}
  const jerry = {...marc,username:'Jerry'}
  await colony.call(marc,'list'); await colony.call(jerry,'list')
  const data = ledger.summary()
  assert.equal(data.total.supabaseRequests,3)
  assert.equal(data.total.unknownCosts,0)
  assert.equal(data.agents.find(a=>a.name==='Marc').requests,2)
  assert.ok(data.recent.every(r=>r.estimatedUsd===null && r.pricing_status==='provider_billed_separately'))
})
test('storage failures fail visibly without making a paid operation depend on the monitor', t => {
  const {dir} = setup(t)
  const bad = path.join(dir,'not-a-directory'); fs.writeFileSync(bad,'x')
  const ledger = new ApiCosts({file:path.join(bad,'db.sqlite')})
  assert.equal(ledger.begin({agent:'Marc',provider:'openai',operation:'chat'}),null)
  assert.equal(ledger.summary().total,null)
  assert.match(ledger.summary().health.error,/storage error/)
})
test('cost APIs isolate agent views, validate budgets, export accounting and retain local-origin checks', async t => {
  const { ledger, dir } = setup(t)
  const marc = new Agent({username:'Marc',dataDir:path.join(dir,'marc'),apiCosts:ledger})
  const jerry = new Agent({username:'Jerry',dataDir:path.join(dir,'jerry'),apiCosts:ledger})
  marc.fleet=jerry.fleet={marc,tree:jerry}
  record(ledger,'Marc','resp_m'); record(ledger,'Jerry','resp_j')
  const server=createApp(marc,marc.fleet).listen(0,'127.0.0.1')
  await new Promise(r=>server.once('listening',r))
  t.after(()=>{server.closeAllConnections();server.close()})
  const url=`http://127.0.0.1:${server.address().port}`
  const root=await (await fetch(url+'/api/costs')).json()
  assert.equal(root.total.requests,2)
  assert.equal((await (await fetch(url+'/bots/tree/api/costs')).json()).total.requests,1)
  assert.equal((await fetch(url+'/bots/tree/api/costs?agent=Marc')).status,400)
  const options={method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({scope:'Jerry',dailyUsd:.1})}
  assert.equal((await fetch(url+'/api/costs/budgets',options)).status,200)
  assert.equal((await fetch(url+'/api/costs/budgets',{...options,headers:{...options.headers,Origin:'https://evil.test'}})).status,403)
  const csv=await (await fetch(url+'/api/costs/export?agent=Jerry')).text()
  assert.match(csv,/"Jerry"/); assert.doesNotMatch(csv,/"Marc"/)
  assert.match(csv,/cached_tokens/); assert.match(csv,/0.000378/)
})

test('an aborted request settles as unknown and a chat delivery error does not lose recorded usage', async t => {
  const h=chat(t, async (url,options) => new Promise((resolve,reject) => options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true})))
  const pending=h.llm.receive(h.bot,'Player','Marc hello')
  h.llm.cancel()
  await pending
  assert.equal(h.ledger.records()[0].outcome,'cancelled')
  assert.equal(h.ledger.summary().total.unknownCosts,1)
  h.llm.fetch=async()=>({ok:true,status:200,json:async()=>result('resp_delivery')})
  h.bot.chat=()=>{throw new Error('Minecraft disconnected')}
  await h.llm.receive(h.bot,'Player','Marc hello again')
  assert.equal(h.ledger.summary().total.costNano,378000)
  assert.equal(h.ledger.summary().total.requests,2)
})
test('missing cache details preserve known token counts while keeping the price unknown', t => {
  const {ledger}=setup(t)
  record(ledger,'Marc','resp_partial_usage',{...result('resp_partial_usage'),usage:{input_tokens:100,output_tokens:20}})
  const data=ledger.summary()
  assert.equal(data.total.inputTokens,100)
  assert.equal(data.total.outputTokens,20)
  assert.equal(data.total.unknownCosts,1)
  assert.equal(data.recent[0].estimatedUsd,null)
})
