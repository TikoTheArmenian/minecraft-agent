const express = require('express')
const path = require('node:path')
const { Agent } = require('./agent.cjs')

function createApp(agent) {
  const app = express()
  app.disable('x-powered-by')
  // Bind locally and reject other origins/Host headers, including DNS rebinding.
  app.use((req, res, next) => {
    const host = req.headers.host || ''
    if (!/^(127\.0\.0\.1|localhost):\d+$/.test(host) || (req.headers.origin && req.headers.origin !== `http://${host}`) || req.headers['sec-fetch-site'] === 'cross-site') {
      return res.status(403).json({error:'This control room only accepts requests from its own local page.'})
    }
    res.set('Content-Security-Policy', "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
    res.set('X-Content-Type-Options', 'nosniff')
    // Live state must never be cached; the extracted item textures can be.
    res.set('Cache-Control', req.path.startsWith('/textures/') ? 'private, max-age=86400' : 'no-store')
    next()
  })
  app.use('/api', (req,res,next) => {
    if (req.method === 'POST' && !req.is('application/json')) return res.status(415).json({error:'Send commands as application/json.'})
    next()
  })
  app.use(express.json({limit:'4kb'}))
  app.use('/api', (req,res,next) => {
    if (req.method === 'POST' && (!req.body || typeof req.body !== 'object' || Array.isArray(req.body))) return res.status(400).json({error:'Send a JSON object.'})
    next()
  })
  app.use(express.static(path.join(__dirname,'..','public'), {etag:false,cacheControl:false}))
  app.get('/api/state', (req,res) => res.json(agent.state))
  // Bounded, read-only terrain capture for reproducing navigation failures.
  app.get('/api/navigation-snapshot',(req,res,next)=>{
    try {
      if(!agent.bot || agent.state.connection!=='ready')throw new Error('Connect the bot first.')
      const {Vec3}=require('vec3'),p=agent.bot.entity.position.floored(),blocks=[]
      for(let x=-12;x<=12;x++)for(let z=-12;z<=12;z++)for(let y=-4;y<=10;y++){
        const q=p.offset(x,y,z),b=agent.bot.blockAt(q)
        if(b)blocks.push([q.x,q.y,q.z,b.stateId])
      }
      res.json({version:agent.bot.version,position:agent.state.position,destination:agent.state.task?.travel?.destination,blocks})
    }catch(error){next(error)}
  })
  app.get('/api/logs',(req,res)=>res.json({entries:agent.journal.entries,file:agent.journal.file,error:agent.journal.error}))
  app.get('/api/logs/download',(req,res,next)=>res.download(agent.journal.file,'walkbot-activity.log',error=>{if(error && !res.headersSent)next(error)}))
  app.get('/api/map',(req,res,next) => {
    try { res.json(agent.maps.snapshot({focus:req.query.focus ?? 'player',offset:req.query.offset === undefined ? 0 : Number(req.query.offset)})) } catch(error) {next(error)}
  })
  app.post('/api/map/action',(req,res,next) => {
    try {agent.maps.action(req.body);res.json({ok:true})} catch(error) {next(error)}
  })
  app.post('/api/scan',(req,res,next) => {
    try {agent.scan();res.json({ok:true})} catch(error) {next(error)}
  })
  app.get('/api/events', (req,res) => {
    res.set({'Content-Type':'text/event-stream',Connection:'keep-alive'})
    res.flushHeaders()
    const send = state => {
      // A slow/closed browser must not accumulate an unbounded stream buffer.
      if (res.destroyed || res.writableLength > 256*1024) { res.destroy(); return }
      res.write(`data: ${JSON.stringify(state)}\n\n`)
    }
    send(agent.state)
    // Coalesce bursts of action/log events into one current state. A browser
    // should not disconnect simply because several placements finish together.
    let pending
    const schedule=()=>{ if(!pending)pending=setTimeout(()=>{pending=null;send(agent.state)},100) }
    agent.on('state',schedule)
    const pulse = setInterval(() => { if (!res.destroyed) res.write(': heartbeat\n\n') },15000)
    res.once('close', () => { clearTimeout(pending);clearInterval(pulse);agent.off('state',schedule) })
  })
  app.post('/api/llm',(req,res,next)=>{try{agent.llm.configure(req.body);res.json({ok:true})}catch(error){next(error)}})
  app.post('/api/connect',async(req,res,next) => {
    try { await agent.connect(req.body.port,req.body.world);res.json({ok:true}) } catch(error) {next(error)}
  })
  app.post('/api/disconnect',(req,res) => {agent.disconnect();res.json({ok:true})})
  app.post('/api/command',(req,res,next) => {
    try {
      if (typeof req.body.text !== 'string' || !req.body.text.trim()) throw new Error('Enter a command.')
      // Keep the conversation on the server so refreshing/reopening a tab preserves it.
      const at=Date.now()
      agent.command(req.body.text)
      agent.say(req.body.text.trim(),'user',at)
      res.json({ok:true})
    } catch(error) {next(error)}
  })
  app.use('/api',(req,res) => res.status(404).json({error:'Unknown API endpoint.'}))
  app.use((error,req,res,next) => {
    const status = error.type === 'entity.too.large' ? 413 : 400
    const message = error.type === 'entity.parse.failed' ? 'Invalid JSON in request.' : error.type === 'entity.too.large' ? 'Request is too large (maximum 4 KB).' : error.message
    agent.log('request.rejected',`${req.method} ${req.path}: ${message}`,'warn')
    res.status(status).json({error:message})
  })
  return app
}
if (require.main === module) {
  const agent = new Agent({logToConsole:true})
  // Item icons come from the installed Minecraft client jar; the app runs without them.
  require('../scripts/extract-textures.cjs').ensureTextures({log:console.log})
  const server = createApp(agent).listen(4317,'127.0.0.1')
  server.on('listening',()=>console.log('Marc control room: http://127.0.0.1:4317'))
  const ticker = setInterval(()=>{if(agent.state.connection==='ready')agent.refresh()},500)
  server.on('error',error=>{clearInterval(ticker);console.error(error.code==='EADDRINUSE'?'The control room is already running at http://127.0.0.1:4317.':error.message);process.exitCode=1})
  function shutdown() {
    clearInterval(ticker)
    agent.disconnect()
    server.close()
    server.closeAllConnections()
  }
  process.on('SIGINT',shutdown)
  process.on('SIGTERM',shutdown)
}
module.exports={createApp}
