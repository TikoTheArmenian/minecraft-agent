/**
 * WORLD OBSERVATIONS: reads loaded blocks for nearby-resource reports and the map.
 * The map is a top-down cutaway of known blocks, not a camera image or imagined terrain.
 * MapStore validates selections before turning a browser click into a physical action.
 */

const { Vec3 } = require('vec3')
const { randomUUID } = require('node:crypto')

const AIR = new Set(['air', 'cave_air', 'void_air'])
const HOSTILES = new Set([
  'zombie',
  'husk',
  'drowned',
  'skeleton',
  'stray',
  'bogged',
  'creeper',
  'spider',
  'cave_spider',
  'witch',
  'slime',
  'magma_cube',
  'phantom',
  'pillager',
  'vindicator',
  'ravager',
  'blaze',
  'ghast',
  'hoglin',
  'piglin_brute',
  'warden',
  'silverfish',
  'endermite',
  'wither_skeleton',
])
const isAir = (b) => !!b && AIR.has(b.name)
const point = (p) => ({ x: p.x, y: p.y, z: p.z })
function players(bot) {
  return Object.values(bot?.players || {})
    .filter((p) => p.entity?.position && p.username !== bot.username)
    .sort(
      (a, b) =>
        a.entity.position.distanceTo(bot.entity.position) -
        b.entity.position.distanceTo(bot.entity.position),
    )
    .map((p) => ({ name: p.username, ...point(p.entity.position) }))
}
function category(name) {
  if (/lava|fire|cactus|magma|powder_snow/.test(name)) return 'danger'
  if (name === 'water' || name === 'bubble_column') return 'water'
  if (/iron_ore/.test(name)) return 'iron'
  if (/ore$|raw_iron_block/.test(name)) return 'ore'
  if (/log$|wood$|stem$|hyphae$|planks$|crafting_table/.test(name)) return 'wood'
  if (/wheat|carrot|potato|beetroot|melon|sweet_berry/.test(name)) return 'crop'
  if (/leaves|grass|moss|fern|flower|sapling/.test(name)) return 'green'
  if (/dirt|farmland|mud|podzol/.test(name)) return 'earth'
  if (/sand|snow|ice/.test(name)) return 'pale'
  return 'stone'
}
function surroundings(bot, radius = 24) {
  if (!bot?.entity?.position) return null
  const names = bot.registry.blocksByName
  const groups = {
    wood: Object.keys(names).filter((n) => /_log$/.test(n) && !n.startsWith('stripped_')),
    stone: ['stone', 'cobblestone', 'deepslate', 'cobbled_deepslate'],
    iron: ['iron_ore', 'deepslate_iron_ore'],
    crops: ['wheat', 'carrots', 'potatoes', 'beetroots', 'melon', 'sweet_berry_bush'],
    water: ['water'],
    seeds: ['short_grass', 'tall_grass', 'fern'],
  }
  const resources = {}
  for (const [name, blocks] of Object.entries(groups)) {
    const positions = bot.findBlocks({
      matching: blocks.map((n) => names[n]?.id).filter(Number.isInteger),
      maxDistance: radius,
      count: 64,
    })
    resources[name] = {
      count: positions.length,
      capped: positions.length === 64,
      nearest: positions[0] ? point(positions[0]) : null,
    }
  }
  const entities = Object.values(bot.entities || {})
    .filter((e) => e.id !== bot.entity.id && e.position?.distanceTo(bot.entity.position) <= radius)
    .map((e) => ({
      id: e.id,
      name: e.username || e.name || 'entity',
      hostile: HOSTILES.has(e.name),
      distance: Math.round(e.position.distanceTo(bot.entity.position) * 10) / 10,
      ...point(e.position),
    }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 48)
  return { at: Date.now(), radius, origin: point(bot.entity.position), resources, entities }
}

// Maps are small, bounded cutaways of real loaded blocks. A player focus changes
// the origin, but cannot reveal chunks the bot has not received from the server.
function buildMap(bot, { focus = 'player', offset = 0 } = {}) {
  if (typeof focus !== 'string' || focus.length > 32) throw new Error('Invalid map focus.')
  if (!Number.isInteger(offset) || offset < -32 || offset > 32)
    throw new Error('Map height must be within 32 blocks of the focus.')
  const people = players(bot)
  const person = focus === 'player' ? people[0] : people.find((p) => p.name === focus)
  if (!['player', 'bot'].includes(focus) && !person)
    throw new Error('That player is no longer in loaded range.')
  const center = person ? new Vec3(person.x, person.y, person.z) : bot.entity.position
  const radius = 16,
    size = radius * 2 + 1,
    top = Math.min(319, Math.max(-64, Math.floor(center.y) + 2 + offset))
  const origin = { x: Math.floor(center.x) - radius, z: Math.floor(center.z) - radius }
  const cells = [],
    palette = [],
    indexes = new Map(),
    counts = {}
  for (let z = 0; z < size; z++)
    for (let x = 0; x < size; x++) {
      let chosen = null,
        known = true
      for (let y = top; y >= Math.max(-64, top - 12); y--) {
        const block = bot.blockAt(new Vec3(origin.x + x, y, origin.z + z))
        if (!block) {
          known = false
          break
        }
        if (!isAir(block)) {
          chosen = block
          break
        }
      }
      if (!chosen) {
        cells.push({ y: null, block: -1, unknown: !known })
        continue
      }
      if (!indexes.has(chosen.name)) {
        indexes.set(chosen.name, palette.length)
        palette.push({ name: chosen.name, category: category(chosen.name) })
      }
      counts[chosen.name] = (counts[chosen.name] || 0) + 1
      cells.push({ y: chosen.position.y, block: indexes.get(chosen.name) })
    }
  const entities = Object.values(bot.entities || {})
    .filter(
      (e) =>
        e.position &&
        Math.abs(e.position.x - center.x) <= radius + 1 &&
        Math.abs(e.position.z - center.z) <= radius + 1 &&
        Math.abs(e.position.y - center.y) <= 12,
    )
    .slice(0, 80)
    .map((e) => ({
      name: e.username || e.name || 'entity',
      bot: e.id === bot.entity.id,
      player: e.type === 'player' || !!e.username,
      hostile: HOSTILES.has(e.name),
      ...point(e.position),
    }))
  return {
    id: randomUUID(),
    at: Date.now(),
    size,
    origin,
    top,
    bottom: Math.max(-64, top - 12),
    focus: person?.name || bot.username || 'Marc',
    dimension: String(bot.game.dimension),
    cells,
    palette,
    counts,
    entities,
    players: people.map((p) => p.name),
    center: point(center),
  }
}

// Resolve clicks against a server-held snapshot, never against coordinates supplied
// by the browser. Reject old/session-switched images before any world mutation.
class MapStore {
  constructor(agent) {
    this.agent = agent
    this.snapshots = new Map()
  }
  clear() {
    this.snapshots.clear()
  }
  snapshot(options) {
    if (this.agent.state.connection !== 'ready')
      throw new Error('Connect the bot to load the block map.')
    const cached = [...this.snapshots.values()].find(
      (s) =>
        s.epoch === this.agent.epoch &&
        JSON.stringify(s.options) === JSON.stringify(options) &&
        Date.now() - s.map.at < 1500,
    )
    if (cached) return cached.map
    const map = buildMap(this.agent.bot, options)
    this.snapshots.set(map.id, { map, epoch: this.agent.epoch, options })
    while (this.snapshots.size > 12) this.snapshots.delete(this.snapshots.keys().next().value)
    return map
  }
  action({ snapshot, from, to = from, action, depth = 1 }) {
    const entry = this.snapshots.get(snapshot),
      a = this.agent
    if (
      !entry ||
      entry.epoch !== a.epoch ||
      a.state.connection !== 'ready' ||
      Date.now() - entry.map.at > 30000
    )
      throw new Error('This map is out of date. Refresh it and select again.')
    if (a.workActive || a.state.task?.status === 'running')
      throw new Error('Stop the current action before using the map.')
    const map = entry.map
    if (![from, to].every((i) => Number.isInteger(i) && i >= 0 && i < map.cells.length))
      throw new Error('Select blocks on the map first.')
    if (!Number.isInteger(depth) || depth < 1 || depth > 4)
      throw new Error('Choose a depth of 1–4 blocks.')
    const coord = (i) => ({
      x: map.origin.x + (i % map.size),
      z: map.origin.z + Math.floor(i / map.size),
      y: map.cells[i].y,
    })
    const first = coord(from),
      last = coord(to)
    if (action === 'walk') {
      if (first.y === null) throw new Error('Select a known block to walk near.')
      const observed = a.bot.blockAt(new Vec3(first.x, first.y, first.z))
      if (!observed || observed.name !== map.palette[map.cells[from].block].name)
        throw new Error('That block changed. Refresh the map.')
      return a.command(`go to ${first.x} ${Math.min(320, first.y + 1)} ${first.z}`)
    }
    if (action !== 'mine') throw new Error('Unknown map action.')
    const minX = Math.min(first.x, last.x),
      maxX = Math.max(first.x, last.x),
      minZ = Math.min(first.z, last.z),
      maxZ = Math.max(first.z, last.z)
    let top = -Infinity
    for (let z = minZ; z <= maxZ; z++)
      for (let x = minX; x <= maxX; x++) {
        const cell = map.cells[(z - map.origin.z) * map.size + x - map.origin.x]
        if (cell.y === null)
          throw new Error('The selection includes unknown or empty columns. Select visible blocks.')
        const block = a.bot.blockAt(new Vec3(x, cell.y, z))
        if (!block || block.name !== map.palette[cell.block].name)
          throw new Error('Selected terrain changed. Refresh the map and select again.')
        top = Math.max(top, cell.y)
      }
    if (top - depth + 1 < -64) throw new Error('Selection extends below the world.')
    return a.command(`mine area ${minX} ${top - depth + 1} ${minZ} to ${maxX} ${top} ${maxZ}`)
  }
}
module.exports = { buildMap, MapStore, surroundings, players, category, isAir, HOSTILES }
