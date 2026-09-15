/**
 * LIVE TERRAFORMER INSPECTOR: connects ONE fleet bot (Terra by default) to the open LAN world,
 * optionally sends chat/command lines first, then reads the live geometry of a rectangle and lists
 * protected blocks (chests, farmland, crafting tables, signs, torches…) within a radius. It never
 * digs or places anything and never touches the control-room server on port 4317.
 *
 *   node --env-file-if-exists=.env scripts/live-terraformer.cjs --pre "/spreadplayers -600 1150 1 8 false @s"
 *   node --env-file-if-exists=.env scripts/live-terraformer.cjs --area "-604 1146 to -598 1152 at 68"
 *
 * Options: --bot <fleet id, default terra>   --area "X1 Z1 to X2 Z2 at Y" (default: 9×9 around the bot)
 *          --radius <protected-block scan radius, default 48>   --pre <chat line, repeatable>
 *          --wait <seconds to let chunks load after --pre, default 6>   --port <LAN port>   --world <label>
 *          --landscan <half-size in blocks>: also print a coarse (8-block) land/water map around the bot
 */
const path = require('node:path')
const { Vec3 } = require('vec3')
const { Agent } = require('../src/agents/agent.cjs')
const { Colony } = require('../src/storage/colony.cjs')
const { profiles, publicProfile } = require('../src/agents/fleet.cjs')
const { parseTerraformer, protectedBlock, CUT_ABOVE, FILL_BELOW } = require('../src/skills/terraformer.cjs')

function args() {
  const out = { pre: [], bot: 'terra', radius: 48, wait: 6, world: 'Agent Playground' }
  const argv = process.argv.slice(2)
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, '')
    if (key === 'pre') out.pre.push(argv[++i])
    else out[key] = argv[++i]
  }
  out.radius = Number(out.radius)
  out.wait = Number(out.wait)
  return out
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function main() {
  const options = args()
  const profile = profiles.find((p) => p.id === options.bot)
  if (!profile) throw new Error(`Unknown --bot. Choose one of: ${profiles.map((p) => p.id).join(', ')}`)
  const agent = new Agent({ username: profile.username, dataDir: path.join(__dirname, '..', profile.dataDir), colony: new Colony(), logToConsole: false })
  agent.profile = publicProfile(profile)
  agent.fleet = { [profile.id]: agent }
  const finish = async (code) => {
    agent.disconnect()
    await sleep(500)
    process.exit(code)
  }
  process.on('SIGINT', () => void finish(130))
  await agent.connect(options.port, options.world)
  const deadline = Date.now() + 30000
  while (agent.state.connection !== 'ready' && Date.now() < deadline) await sleep(250)
  if (agent.state.connection !== 'ready') throw new Error(`World did not load: ${agent.state.connection}`)
  const bot = agent.bot
  const pos = () => bot.entity.position
  console.log(`Ready at ${pos().floored()} (${bot.game.gameMode}); health ${bot.health}, food ${bot.food}.`)
  for (const line of options.pre) {
    console.log(`CHAT> ${line}`)
    bot.chat(line)
    await sleep(1500)
  }
  await sleep(options.wait * 1000)
  console.log(`Position after --pre: ${pos()} · inventory: ${bot.inventory.items().map((i) => `${i.name}×${i.count}`).join(', ') || 'empty'}`)
  const here = pos().floored()
  const area = options.area
    ? parseTerraformer(`flatten ${options.area}`)
    : { min: { x: here.x - 4, z: here.z - 4 }, max: { x: here.x + 4, z: here.z + 4 }, y: here.y - 1 }
  console.log(`\nRectangle ${area.min.x},${area.min.z} to ${area.max.x},${area.max.z} at Y=${area.y}`)
  console.log('Top solid height per column (`.` = exactly at target, `?` = unloaded, `~` = liquid on top):')
  let level = 0, above = 0, below = 0, unloaded = 0, columns = 0
  for (let z = area.min.z; z <= area.max.z; z++) {
    let row = `z=${String(z).padStart(6)} `
    for (let x = area.min.x; x <= area.max.x; x++) {
      columns++
      let top = null, liquidTop = false, missing = false
      for (let y = area.y + CUT_ABOVE + 2; y >= area.y - FILL_BELOW - 1; y--) {
        const b = bot.blockAt(new Vec3(x, y, z))
        if (!b) { missing = true; break }
        if (b.boundingBox === 'block') { top = y; break }
        if (/^(water|lava)$/.test(b.name)) liquidTop = true
      }
      if (missing) { unloaded++; row += '   ?' }
      else if (top === area.y && !liquidTop) { level++; row += '   .' }
      else { if (top === null || top < area.y) below++; else above++; row += String(top ?? 'v').padStart(4) + (liquidTop ? '~' : '') }
    }
    console.log(row)
  }
  console.log(`\n${level}/${columns} columns exactly at Y=${area.y}; ${above} higher, ${below} lower or hollow, ${unloaded} unloaded.`)
  const found = new Map()
  const ids = Object.values(bot.registry.blocksByName).filter((b) => protectedBlock(null, { name: b.name })).map((b) => b.id)
  for (const p of bot.findBlocks({ matching: ids, maxDistance: options.radius, count: 512 })) {
    const b = bot.blockAt(p)
    if (!b) continue
    const list = found.get(b.name) || []
    if (list.length < 5) list.push(`${p.x},${p.y},${p.z}`)
    found.set(b.name, list)
  }
  console.log(`\nProtected blocks within ${options.radius} blocks of ${here}: ${found.size ? '' : 'none'}`)
  for (const [name, list] of found) console.log(`  ${name}: ${list.join(' ')}`)
  if (options.landscan) {
    const half = Number(options.landscan), step = 8
    console.log(`\nCoarse land map (${step}-block cells, ±${half}): digits = surface height/10 of dry land, ~ = water, ? = unloaded, T = trees above`)
    for (let z = here.z - half; z <= here.z + half; z += step) {
      let row = `z=${String(z).padStart(6)} `
      for (let x = here.x - half; x <= here.x + half; x += step) {
        let mark = '?'
        for (let y = 100; y >= 40; y--) {
          const b = bot.blockAt(new Vec3(x, y, z))
          if (!b) break
          if (/^(water|lava)$/.test(b.name)) { mark = '~'; break }
          if (b.boundingBox === 'block') { mark = /leaves|log/.test(b.name) ? 'T' : String(Math.floor(y / 10)); break }
        }
        row += mark
      }
      console.log(row)
    }
  }
  const players = Object.values(bot.players).filter((p) => p.username !== bot.username && p.entity)
  console.log(`Other players in view: ${players.map((p) => `${p.username}@${p.entity.position.floored()}`).join(', ') || 'none'}`)
  await finish(0)
}
main().catch((error) => {
  console.error(error.message)
  process.exit(1)
})
