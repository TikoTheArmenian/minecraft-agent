/**
 * LIVE SKILL HARNESS: connects ONE fleet bot to the open LAN world, runs one command, and
 * streams its activity to the terminal for a bounded time. It never touches the control-room
 * server, so several harnesses (different bots) can run at once while the control room keeps
 * running its own bots. Shared storage still goes through the configured Colony (.env).
 *
 *   node --env-file-if-exists=.env scripts/live-skill.cjs --bot orin --command "find ores" --seconds 180
 *   node --env-file-if-exists=.env scripts/live-skill.cjs --bot forge --pre "/gamemode survival" \
 *        --pre "/tp @s -480 66 1040" --command "smelt" --seconds 240
 *
 * Options: --bot <fleet id>   --command <text>   --seconds <n, default 120>   --port <LAN port>
 *          --world <label, default Agent Playground>   --pre <chat line, repeatable; sent before the command>
 *          --keep (ignore --seconds; run until Ctrl-C)   --quiet (only warnings/errors and progress)
 * Colony chat peers (Sam's role questions) only work inside the control room where all bots share a process.
 */
const path = require('node:path')
const { Agent } = require('../src/agent.cjs')
const { Colony } = require('../src/colony.cjs')
const { profiles, publicProfile } = require('../src/fleet.cjs')

function args() {
  const out = { pre: [], seconds: 120, world: 'Agent Playground' }
  const argv = process.argv.slice(2)
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, '')
    if (['keep', 'quiet'].includes(key)) out[key] = true
    else if (key === 'pre') out.pre.push(argv[++i])
    else out[key] = argv[++i]
  }
  out.seconds = Number(out.seconds)
  return out
}
async function main() {
  const options = args()
  const profile = profiles.find((p) => p.id === options.bot)
  if (!profile) {
    console.error(`Unknown --bot. Choose one of: ${profiles.map((p) => p.id).join(', ')}`)
    process.exit(2)
  }
  const colony = new Colony()
  const agent = new Agent({
    username: profile.username,
    dataDir: path.join(__dirname, '..', profile.dataDir),
    colony,
    logToConsole: false,
  })
  agent.profile = publicProfile(profile)
  agent.fleet = { [profile.id]: agent }
  let printed = 0
  let lastLabel = ''
  const stamp = () => new Date().toISOString().slice(11, 19)
  agent.on('state', (state) => {
    for (const entry of state.logs.slice(printed - state.logs.length || state.logs.length)) {
      if (options.quiet && entry.level === 'debug') continue
      console.log(`${stamp()} [${entry.level}] ${entry.event}: ${entry.message}`)
    }
    printed = state.logs.length
    const label = state.task ? `${state.task.skill || ''} ${state.task.label} · ${state.task.status}` : ''
    if (label && label !== lastLabel) {
      lastLabel = label
      console.log(`${stamp()} TASK ${label}`)
    }
  })
  const summary = () => {
    const s = agent.state
    const inventory = (s.inventory || []).map((i) => `${i.name}×${i.count}`).join(', ') || 'empty'
    return {
      connection: s.connection,
      gameMode: s.vitals?.gameMode,
      health: s.vitals?.health,
      food: s.vitals?.food,
      position: s.position && { x: +s.position.x.toFixed(1), y: +s.position.y.toFixed(1), z: +s.position.z.toFixed(1) },
      task: s.task && { skill: s.task.skill, label: s.task.label, status: s.task.status, counts: s.task.counts, issues: s.task.issues?.slice(-5) },
      storage: s.storage,
      inventory,
    }
  }
  const ticker = setInterval(() => {
    if (agent.state.connection === 'ready') {
      agent.refresh()
      void agent.coordination.tick().catch(() => {})
    }
  }, 500)
  let finished = false
  let heartbeat = null
  async function finish(code) {
    if (finished) return
    finished = true
    clearInterval(ticker)
    clearInterval(heartbeat)
    console.log('\nFINAL', JSON.stringify(summary(), null, 2))
    agent.stop(false)
    await new Promise((r) => setTimeout(r, 1500))
    agent.disconnect()
    await new Promise((r) => setTimeout(r, 500))
    process.exit(code)
  }
  process.on('SIGINT', () => void finish(130))
  process.on('SIGTERM', () => void finish(143))
  console.log(`${stamp()} Connecting ${profile.username} (${profile.id}); colony ${colony.enabled ? 'configured' : 'NOT configured'}.`)
  try {
    await agent.connect(options.port, options.world)
  } catch (error) {
    console.error('Connection failed:', error.message)
    return finish(1)
  }
  const deadline = Date.now() + 30000
  while (agent.state.connection !== 'ready' && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250))
  if (agent.state.connection !== 'ready') {
    console.error('The world did not load in time; state:', agent.state.connection)
    return finish(1)
  }
  console.log(`${stamp()} Ready at ${JSON.stringify(summary().position)} in ${summary().gameMode} mode.`)
  for (const line of options.pre) {
    console.log(`${stamp()} CHAT> ${line}`)
    agent.bot.chat(line)
    await new Promise((r) => setTimeout(r, 1200))
  }
  if (options.pre.length) await new Promise((r) => setTimeout(r, 1500))
  agent.refresh()
  if (options.command) {
    console.log(`${stamp()} COMMAND> ${options.command}`)
    try {
      agent.command(options.command)
    } catch (error) {
      console.error('Command rejected:', error.message)
      return finish(1)
    }
  }
  heartbeat = setInterval(() => {
    const s = summary()
    console.log(`${stamp()} POS ${JSON.stringify(s.position)} hp ${s.health} food ${s.food} · ${s.task?.label || 'idle'} · ${s.inventory}`)
  }, 10000)
  if (!options.keep) setTimeout(() => void finish(0), options.seconds * 1000)
}
main().catch((error) => {
  console.error(error)
  process.exit(1)
})
