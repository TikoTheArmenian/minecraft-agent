/**
 * LIVE MOB KILLER HARNESS: the same bounded single-bot flow as live-skill.cjs, plus the extra
 * observations a combat test needs: world difficulty, server replies to commands, nearby
 * entities, the published mobKiller plan, and cleanup chat lines sent before disconnecting.
 * It never touches the control-room server.
 *
 *   node --env-file-if-exists=.env scripts/live-mob-killer.cjs --bot knight --spot -464 1200 \
 *        --pre "/give @s iron_sword" --pre "/summon zombie ~6 ~ ~" \
 *        --command "hunt mobs within 16" --seconds 150 --post "/kill @e[type=zombie,distance=..24]"
 *
 * Options: --bot <fleet id> (default knight)   --command <text>   --seconds <n, default 120>
 *          --port <LAN port>   --world <label, default Agent Playground>
 *          --spot <x> <z>  teleport onto the surface at x,z before the --pre lines (two-step:
 *                          high teleport, read the loaded column, teleport onto the top block)
 *          --pre <chat line, repeatable>   --post <chat line, repeatable; sent at the end>
 *          --survey  when the spot column is under water, scan the loaded area and land on the nearest dry column
 *          --quiet (skip debug logs)
 */
const path = require('node:path')
const { Vec3 } = require('vec3')
const { Agent } = require('../src/agent.cjs')
const { Colony } = require('../src/colony.cjs')
const { profiles, publicProfile } = require('../src/fleet.cjs')
const { HOSTILES } = require('../src/world.cjs')

function args() {
  const out = { bot: 'knight', pre: [], post: [], seconds: 120, world: 'Agent Playground', spot: null }
  const argv = process.argv.slice(2)
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, '')
    if (key === 'quiet' || key === 'survey') out[key] = true
    else if (key === 'pre' || key === 'post') out[key].push(argv[++i])
    else if (key === 'spot') out.spot = { x: Number(argv[++i]), z: Number(argv[++i]) }
    else out[key] = argv[++i]
  }
  out.seconds = Number(out.seconds)
  return out
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const stamp = () => new Date().toISOString().slice(11, 19)

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
  let printed = 0,
    lastLabel = ''
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
    const s = agent.state,
      bot = agent.bot
    const inventory = (s.inventory || []).map((i) => `${i.name}×${i.count}${i.equipped ? ' (held)' : ''}`).join(', ') || 'empty'
    const entities = bot
      ? Object.values(bot.entities)
          .filter((e) => e !== bot.entity && (HOSTILES.has(e.name) || e.type === 'player' || e.name === 'item'))
          .map((e) => `${e.username || e.name}#${e.id}@${e.position.floored()}(${e.position.distanceTo(bot.entity.position).toFixed(1)})`)
          .slice(0, 12)
      : []
    return {
      connection: s.connection,
      gameMode: s.vitals?.gameMode,
      difficulty: bot?.game?.difficulty,
      health: s.vitals?.health,
      food: s.vitals?.food,
      time: s.vitals?.time,
      position: s.position && { x: +s.position.x.toFixed(1), y: +s.position.y.toFixed(1), z: +s.position.z.toFixed(1) },
      task: s.task && { skill: s.task.skill, label: s.task.label, status: s.task.status, counts: s.task.counts, issues: s.task.issues?.slice(-5) },
      mobKiller: s.mobKiller,
      storage: s.storage,
      inventory,
      entities,
    }
  }
  const ticker = setInterval(() => {
    if (agent.state.connection === 'ready') {
      agent.refresh()
      void agent.coordination.tick().catch(() => {})
    }
  }, 500)
  let finished = false,
    heartbeat = null,
    spotCenter = null,
    displaced = false
  async function chat(line) {
    console.log(`${stamp()} CHAT> ${line}`)
    agent.bot.chat(line)
    await sleep(1200)
  }
  async function finish(code) {
    if (finished) return
    finished = true
    clearInterval(ticker)
    clearInterval(heartbeat)
    console.log('\nFINAL', JSON.stringify(summary(), null, 2))
    agent.stop(false)
    await sleep(1500)
    if (agent.bot && agent.state.connection === 'ready')
      for (const line of options.post) {
        // Mob/item removal only makes sense at the test spot; a displaced bot must not run it near the base.
        if (/^\/kill/.test(line) && (displaced || (spotCenter && agent.bot.entity.position.distanceTo(spotCenter) > 48))) {
          console.log(`${stamp()} SKIP (not at the test spot) ${line}`)
          continue
        }
        await chat(line)
      }
    if (options.post.length) {
      await sleep(1500)
      console.log('AFTER CLEANUP entities:', JSON.stringify(summary().entities))
    }
    agent.disconnect()
    await sleep(500)
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
  while (agent.state.connection !== 'ready' && Date.now() < deadline) await sleep(250)
  if (agent.state.connection !== 'ready') {
    console.error('The world did not load in time; state:', agent.state.connection)
    return finish(1)
  }
  // Server replies to commands arrive as system messages; print them so effects can be verified.
  agent.bot.on('message', (message, position) => {
    if (position === 'chat') return
    const text = message.toString().trim()
    if (text) console.log(`${stamp()} SERVER(${position}) ${text}`)
  })
  console.log(`${stamp()} Ready at ${JSON.stringify(summary().position)} in ${summary().gameMode} mode; difficulty ${summary().difficulty}.`)
  // Column check: top solid block and whether liquid lies above it (an ocean floor is not a test spot).
  const column = (x, z) => {
    let top = null,
      wet = false
    for (let y = 199; y > -60 && top === null; y--) {
      const b = agent.bot.blockAt(new Vec3(x, y, z))
      if (!b) return null
      if (/water|lava/.test(b.name)) wet = true
      if (b.boundingBox === 'block') top = y
    }
    if (top === null) return null
    const name = agent.bot.blockAt(new Vec3(x, top, z))?.name || ''
    return { x, z, top, wet: wet || /leaves|log|ice|snow_block|cactus/.test(name) }
  }
  // A test spot must be a flat dry patch, not a canopy or a ledge beside water.
  const flat = (c) => {
    if (!c || c.wet) return false
    for (const dx of [-3, 0, 3])
      for (const dz of [-3, 0, 3]) {
        const n = column(c.x + dx, c.z + dz)
        if (!n || n.wet || Math.abs(n.top - c.top) > 1) return false
      }
    return true
  }
  if (options.spot && Number.isFinite(options.spot.x) && Number.isFinite(options.spot.z)) {
    let { x, z } = options.spot
    // Slow falling keeps the airborne survey from becoming a fatal fall (run 2 died and respawned at the base).
    let slow = false
    const onEffect = (message) => { if (/Applied effect Slow Falling/i.test(message.toString())) slow = true }
    agent.bot.on('message', onEffect)
    await chat(`/effect give @s minecraft:slow_falling 120 0 true`)
    await chat(`/tp @s ${x} 200 ${z}`)
    await sleep(2500)
    agent.bot.off('message', onEffect)
    if (!slow) {
      console.error('Slow Falling was not confirmed by the server; aborting the airborne survey before it becomes a fatal fall.')
      await chat(`/tp @s ${x} 200 ${z}`) // re-teleport resets the fall distance before we leave
      return finish(1)
    }
    let here = column(x, z)
    if (!flat(here) && options.survey) {
      // Scan the loaded area for dry columns and land on the nearest one instead of the water.
      const dry = []
      for (let dx = -96; dx <= 96; dx += 8)
        for (let dz = -96; dz <= 96; dz += 8) {
          const c = column(x + dx, z + dz)
          if (c && c.top > 58 && flat(c)) dry.push({ ...c, distance: Math.hypot(dx, dz) })
        }
      dry.sort((a, b) => a.distance - b.distance)
      console.log(`${stamp()} SURVEY dry columns near ${x},${z}: ${dry.slice(0, 12).map((c) => `${c.x},${c.top},${c.z}(${c.distance.toFixed(0)})`).join(' ') || 'none'}`)
      if (dry.length) {
        here = dry[0]
        x = here.x
        z = here.z
      }
    }
    if (!flat(here)) {
      console.error(!here ? 'Could not read the terrain column at the test spot.' : `The column at ${x},${z} is not a flat dry patch (top y=${here.top}, wet=${here.wet}). Choose another spot or add --survey.`)
      return finish(1)
    }
    await chat(`/tp @s ${x} ${here.top + 1} ${z}`)
    await sleep(1500)
    await chat(`/effect clear @s minecraft:slow_falling`)
    const at = agent.bot.entity.position
    console.log(`${stamp()} Test spot ${x} ${here.top + 1} ${z}; now at ${JSON.stringify(summary().position)}.`)
    spotCenter = new Vec3(x + 0.5, here.top + 1, z + 0.5)
    if (Math.hypot(at.x - (x + 0.5), at.z - (z + 0.5)) > 3 || Math.abs(at.y - (here.top + 1)) > 3) {
      console.error('Knight is NOT at the test spot (teleport failed or he died); refusing to run --pre lines or the command here.')
      return finish(1)
    }
  }
  // Never summon or fight near people: refuse when any other player is within 100 blocks.
  const people = Object.values(agent.bot.entities).filter((e) => e.type === 'player' && e !== agent.bot.entity)
  const near = people.filter((e) => e.position.distanceTo(agent.bot.entity.position) < 100).map((e) => `${e.username}(${e.position.distanceTo(agent.bot.entity.position).toFixed(0)})`)
  if (near.length && options.pre.some((line) => /^\/(summon|difficulty)/.test(line))) {
    console.error(`Other players within 100 blocks: ${near.join(', ')}. Refusing to summon or change difficulty here.`)
    return finish(1)
  }
  for (const line of options.pre) await chat(line)
  if (options.pre.length) await sleep(1500)
  agent.refresh()
  console.log(`${stamp()} Before command: hp ${summary().health} · ${summary().inventory} · entities ${JSON.stringify(summary().entities)}`)
  if (options.command) {
    console.log(`${stamp()} COMMAND> ${options.command}`)
    try {
      agent.command(options.command)
    } catch (error) {
      console.error('Command rejected:', error.message)
      return finish(1)
    }
  }
  // If someone teleports Knight away mid-run (it happened), end the test immediately so the
  // difficulty change and cleanup never apply near the base.
  const displacement = setInterval(() => {
    if (finished || !spotCenter || !agent.bot?.entity) return
    if (agent.bot.entity.position.distanceTo(spotCenter) > 60) {
      displaced = true
      console.log(`${stamp()} DISPLACED from the test spot to ${JSON.stringify(summary().position)}; ending the run now.`)
      clearInterval(displacement)
      void finish(3)
    }
  }, 1000)
  heartbeat = setInterval(() => {
    const s = summary()
    console.log(`${stamp()} POS ${JSON.stringify(s.position)} hp ${s.health} food ${s.food} · ${s.task?.label || 'idle'} · ${s.inventory}`)
    if (s.mobKiller)
      console.log(`${stamp()} PLAN ${JSON.stringify({ decision: s.mobKiller.decision, target: s.mobKiller.target, weapon: s.mobKiller.weapon, kills: s.mobKiller.kills, drops: s.mobKiller.drops, stored: s.mobKiller.stored, retreats: s.mobKiller.retreats })}`)
    console.log(`${stamp()} ENTITIES ${JSON.stringify(s.entities)}`)
  }, 10000)
  setTimeout(() => void finish(0), options.seconds * 1000)
}
main().catch((error) => {
  console.error(error)
  process.exit(1)
})
