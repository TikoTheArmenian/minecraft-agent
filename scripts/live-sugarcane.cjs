/**
 * LIVE SUGAR CANE SCAN (read-only): connects Cane to the open LAN world, optionally sends a few
 * chat lines first (for example /tp @s X Y Z), waits for chunks, then reports what the sugarcane
 * farmer would see: water, plantable shoreline soil, cane columns, and the blocks at requested
 * positions. It never starts a skill, never digs or places, and disconnects when done.
 *
 *   node --env-file-if-exists=.env scripts/live-sugarcane.cjs --pre "/tp @s -464 70 950" --radius 40
 *   node --env-file-if-exists=.env scripts/live-sugarcane.cjs --at -470,64,952 --at -471,65,952
 *
 * Options: --pre <chat line, repeatable>   --radius <blocks, default 32>   --at <x,y,z, repeatable>
 *          --port <LAN port>   --world <label, default Agent Playground>   --wait <seconds after pre, default 6>
 */
const path = require('node:path')
const { Vec3 } = require('vec3')
const { Agent } = require('../src/agents/agent.cjs')
const { Colony } = require('../src/storage/colony.cjs')
const { profiles, publicProfile } = require('../src/agents/fleet.cjs')
const { groupColumns, plantable, SOIL } = require('../src/skills/sugarcane-farm.cjs')

function args() {
  const out = { pre: [], at: [], radius: 32, world: 'Agent Playground', wait: 6 }
  const argv = process.argv.slice(2)
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, '')
    if (key === 'pre') out.pre.push(argv[++i])
    else if (key === 'at') out.at.push(argv[++i])
    else out[key] = argv[++i]
  }
  out.radius = Math.min(48, Number(out.radius))
  out.wait = Number(out.wait)
  return out
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function main() {
  const options = args()
  const profile = profiles.find((p) => p.id === 'cane')
  const agent = new Agent({
    username: profile.username,
    dataDir: path.join(__dirname, '..', profile.dataDir),
    colony: new Colony(),
    logToConsole: false,
  })
  agent.profile = publicProfile(profile)
  agent.fleet = { cane: agent }
  const finish = async (code) => {
    agent.disconnect()
    await sleep(500)
    process.exit(code)
  }
  try {
    await agent.connect(options.port, options.world)
  } catch (error) {
    console.error('Connection failed:', error.message)
    return finish(1)
  }
  const deadline = Date.now() + 30000
  while (agent.state.connection !== 'ready' && Date.now() < deadline) await sleep(250)
  if (agent.state.connection !== 'ready') {
    console.error('World did not load; state:', agent.state.connection)
    return finish(1)
  }
  const bot = agent.bot
  console.log('Ready at', bot.entity.position.floored().toString(), 'mode', bot.game.gameMode)
  // Command feedback (for example "Changed the block" or "That position is not loaded") is a system message.
  bot.on('message', (message, position) => {
    if (position !== 'chat') console.log('MSG>', message.toString())
  })
  for (const line of options.pre) {
    console.log('CHAT>', line)
    bot.chat(line)
    await sleep(1200)
  }
  await sleep(options.wait * 1000)
  const origin = bot.entity.position.floored()
  console.log('Scanning from', origin.toString())
  const ids = (names) => names.map((n) => bot.registry.blocksByName[n]?.id).filter(Number.isInteger)
  const water = bot.findBlocks({ matching: ids(['water']), maxDistance: options.radius, count: 2000 })
  const surfaceWater = water.filter((p) => ['air', 'cave_air'].includes(bot.blockAt(p.offset(0, 1, 0))?.name))
  const soil = bot
    .findBlocks({ matching: ids(SOIL), maxDistance: options.radius, count: 4000 })
    .map((p) => bot.blockAt(p))
    .filter((b) => plantable(bot, b))
    .sort((a, b) => a.position.distanceTo(origin) - b.position.distanceTo(origin))
  const canes = bot.findBlocks({ matching: ids(['sugar_cane']), maxDistance: options.radius, count: 512 }).map((p) => bot.blockAt(p))
  const columns = groupColumns(bot, canes)
  const farm = bot.findBlocks({ matching: ids(['farmland', 'wheat']), maxDistance: options.radius, count: 10 })
  const chests = bot.findBlocks({ matching: ids(['chest']), maxDistance: options.radius, count: 10 })
  console.log(
    JSON.stringify(
      {
        water: water.length,
        surfaceWater: surfaceWater.length,
        nearestSurfaceWater: surfaceWater
          .sort((a, b) => a.distanceTo(origin) - b.distanceTo(origin))
          .slice(0, 5)
          .map(String),
        plantableSoil: soil.length,
        nearestPlantable: soil.slice(0, 12).map((b) => `${b.name}@${b.position}`),
        columns: columns.map((c) => `${c.base.position} h${c.height}${c.ready ? ' ready' : ''}`),
        farmBlocksNearby: farm.length,
        chestsNearby: chests.map(String),
        players: Object.values(bot.players)
          .filter((p) => p.entity && p.username !== bot.username)
          .map((p) => `${p.username}@${p.entity.position.floored()}`),
      },
      null,
      1,
    ),
  )
  for (const spec of options.at) {
    const [x, y, z] = spec.split(',').map(Number)
    const b = bot.blockAt(new Vec3(x, y, z))
    console.log(`AT ${x},${y},${z}: ${b ? b.name + ' ' + JSON.stringify(b.getProperties()) : 'unloaded'}`)
  }
  return finish(0)
}
main().catch((error) => {
  console.error(error)
  process.exit(1)
})
