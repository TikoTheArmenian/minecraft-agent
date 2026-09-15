/**
 * ORE FINDER LIVE PROBE: connects Orin alone (never the control room's bots), teleports him high
 * above candidate remote spots, reads the loaded surface column, and prints the exact `--pre`
 * lines for scripts/live-skill.cjs: a safe landing teleport, a few exposed hillside ore blocks to
 * place with /setblock, and a pickaxe. It only reads terrain and moves Orin; the harness performs
 * the world changes so they stay visible in one run log.
 *
 *   node --env-file-if-exists=.env scripts/live-ore-finder.cjs --candidates "-560,1100;-540,960;-390,1024"
 *
 * Options: --candidates "x,z;x,z" (default list below)   --port <LAN port>   --world <label>
 *          --ores "coal_ore,iron_ore" (alternating, default)   --count <n, default 6>
 *          --survey "cx,cz" (print an ASCII land/water map of loaded columns around that point, stride 8)
 *          --detail "cx,cz" (print the surface block name and height of every column within 10 blocks)
 *          --around 1 (print the 11x11 block layers from feet-1 to feet+2 at Orin's spawn position)
 */
const path = require('node:path')
const { Vec3 } = require('vec3')
const { Agent } = require('../src/agents/agent.cjs')
const { Colony } = require('../src/storage/colony.cjs')
const { profiles, publicProfile } = require('../src/agents/fleet.cjs')

const DEFAULTS = '-560,1100;-540,960;-390,1024;-464,940;-600,1024;-464,1130'
const SOLID = /^(stone|dirt|grass_block|andesite|granite|diorite|deepslate|coarse_dirt|podzol|tuff|gravel|sand|snow_block|moss_block|calcite)$/
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function args() {
  const out = { candidates: DEFAULTS, world: 'Agent Playground', ores: 'coal_ore,iron_ore', count: 6 }
  const argv = process.argv.slice(2)
  for (let i = 0; i < argv.length; i++) out[argv[i].replace(/^--/, '')] = argv[++i]
  out.count = Number(out.count)
  return out
}
// Highest loaded non-air block in the column, plus whether the column is fully loaded.
function surface(bot, x, z, top = 130) {
  for (let y = top; y >= -60; y--) {
    const block = bot.blockAt(new Vec3(x, y, z))
    if (!block) return { loaded: false, y }
    if (!['air', 'cave_air', 'void_air'].includes(block.name)) return { loaded: true, y, block }
  }
  return { loaded: true, y: null }
}
async function main() {
  const options = args()
  const profile = profiles.find((p) => p.id === 'orin')
  const agent = new Agent({ username: profile.username, dataDir: path.join(__dirname, '..', profile.dataDir), colony: new Colony(), logToConsole: false })
  agent.profile = publicProfile(profile)
  agent.fleet = { orin: agent }
  const finish = async (code) => {
    agent.stop(false)
    await sleep(500)
    agent.disconnect()
    await sleep(500)
    process.exit(code)
  }
  process.on('SIGINT', () => void finish(130))
  await agent.connect(options.port, options.world)
  const deadline = Date.now() + 30000
  while (agent.state.connection !== 'ready' && Date.now() < deadline) await sleep(250)
  if (agent.state.connection !== 'ready') {
    console.error('World did not load; state:', agent.state.connection)
    return finish(1)
  }
  const bot = agent.bot
  console.log(`Orin ready at ${bot.entity.position.floored()} (${bot.game.gameMode}).`)
  if (options.around) {
    await sleep(2500)
    const feet = bot.entity.position.floored(), legend = new Map()
    const code = (name) => {
      if (!legend.has(name)) legend.set(name, String.fromCharCode(97 + legend.size))
      return legend.get(name)
    }
    for (let dy = -1; dy <= 2; dy++) {
      console.log(`Layer y=${feet.y + dy} (x ${feet.x - 5}..${feet.x + 5} across, z ${feet.z - 5}..${feet.z + 5} down); Orin's own cell marked with *`)
      for (let dz = -5; dz <= 5; dz++) {
        let row = ''
        for (let dx = -5; dx <= 5; dx++) {
          const b = bot.blockAt(feet.offset(dx, dy, dz))
          row += (b ? code(b.name) : '?') + (dx === 0 && dz === 0 ? '*' : ' ')
        }
        console.log(`${String(feet.z + dz).padStart(5)} ${row}`)
      }
    }
    console.log(`Legend: ${[...legend].map(([n, c]) => `${c}=${n}`).join(' ')}; feet ${feet}; onGround ${bot.entity.onGround}; movements ${bot.pathfinder.movements ? 'set' : 'MISSING'}`)
    return finish(0)
  }
  if (options.survey) {
    const [cx, cz] = options.survey.split(',').map(Number)
    bot.chat(`/tp @s ${cx} 200 ${cz}`)
    await sleep(3500)
    const stride = 8, span = 152, rows = []
    for (let z = cz - span; z <= cz + span; z += stride) {
      let row = ''
      for (let x = cx - span; x <= cx + span; x += stride) {
        const s = surface(bot, x, z, 130)
        row += !s.loaded ? '?' : s.y === null ? ' ' : s.block.name === 'water' ? '~' : s.y >= 63 ? 'L' : 'l'
      }
      rows.push(`${String(z).padStart(5)} ${row}`)
    }
    console.log(`Survey around (${cx}, ${cz}); columns x=${cx - span}..${cx + span} step ${stride}; L=land at/above sea level, l=low land, ~=water, ?=unloaded`)
    console.log(rows.join('\n'))
    bot.chat('/tp @s -464 70 1024') // known dry spawn area
    await sleep(1500)
    console.log(`Orin back at ${bot.entity.position.floored()}, health ${bot.health}.`)
    return finish(0)
  }
  if (options.detail) {
    const [cx, cz] = options.detail.split(',').map(Number)
    bot.chat(`/tp @s ${cx} 200 ${cz}`)
    await sleep(3500)
    const legend = new Map()
    const code = (name) => {
      if (!legend.has(name)) legend.set(name, String.fromCharCode(97 + legend.size))
      return legend.get(name)
    }
    const rows = []
    for (let z = cz - 10; z <= cz + 10; z++) {
      let row = ''
      for (let x = cx - 10; x <= cx + 10; x++) {
        const s = surface(bot, x, z, 130)
        row += !s.loaded || s.y === null ? ' ?  ' : `${code(s.block.name)}${String(s.y).padStart(3)}`
      }
      rows.push(`${String(z).padStart(5)} ${row}`)
    }
    console.log(`Surface detail around (${cx}, ${cz}); x=${cx - 10}..${cx + 10}. Legend: ${[...legend].map(([n, c]) => `${c}=${n}`).join(' ')}`)
    console.log(rows.join('\n'))
    bot.chat('/tp @s -464 70 1024')
    await sleep(1500)
    console.log(`Orin back at ${bot.entity.position.floored()}, health ${bot.health}.`)
    return finish(0)
  }
  const spots = options.candidates.split(';').map((s) => s.split(',').map(Number)).filter((c) => c.length === 2 && c.every(Number.isFinite))
  for (const [x, z] of spots) {
    // Teleport high so the chunk loads while falling, then read the column and land safely.
    bot.chat(`/tp @s ${x} 200 ${z}`)
    let top = null
    for (let n = 0; n < 25 && !top?.loaded; n++) {
      await sleep(200)
      top = surface(bot, x, z, 130)
    }
    if (!top?.loaded || top.y === null) {
      console.log(`(${x}, ${z}): terrain did not load in time; skipping.`)
      continue
    }
    const landing = top.y + 1
    bot.chat(`/tp @s ${x} ${landing} ${z}`)
    await sleep(1500)
    const here = bot.entity.position.floored()
    console.log(`(${x}, ${z}): surface ${top.block.name} at y=${top.y}; Orin now at ${here}; health ${bot.health}.`)
    if (top.block.name === 'water' || top.block.name === 'lava' || top.y < 58) {
      console.log('  Not dry land. Trying the next candidate.')
      continue
    }
    // Nearby surface cells whose top block is natural solid ground with air above become ore
    // positions: exposed on top, resting on solid ground, away from liquids.
    const chosen = []
    for (let r = 2; r <= 7 && chosen.length < options.count; r++)
      for (let dx = -r; dx <= r && chosen.length < options.count; dx++)
        for (let dz = -r; dz <= r && chosen.length < options.count; dz++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue
          const s = surface(bot, x + dx, z + dz, landing + 6)
          if (!s.loaded || s.y === null || !SOLID.test(s.block.name) || Math.abs(s.y - top.y) > 4) continue
          const around = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0]].map((d) => bot.blockAt(new Vec3(x + dx + d[0], s.y + d[1], z + dz + d[2])))
          if (around.some((b) => !b || /water|lava/.test(b.name))) continue
          if (chosen.some((c) => Math.abs(c.x - (x + dx)) <= 1 && Math.abs(c.z - (z + dz)) <= 1)) continue
          chosen.push(new Vec3(x + dx, s.y, z + dz))
        }
    const ores = options.ores.split(',')
    const pre = [`--pre "/tp @s ${x} ${landing} ${z}"`]
    chosen.forEach((p, i) => pre.push(`--pre "/setblock ${p.x} ${p.y} ${p.z} ${ores[i % ores.length]}"`))
    pre.push('--pre "/give @s stone_pickaxe"')
    console.log(`  ${chosen.length} exposed ore positions chosen. Harness arguments:`)
    console.log('  ' + pre.join(' \\\n    '))
    return finish(0)
  }
  console.log('No dry candidate found. Add more --candidates.')
  return finish(1)
}
main().catch((error) => {
  console.error(error)
  process.exit(1)
})
