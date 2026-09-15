/** Bounded, read-only voxel snapshots from the selected bot's loaded world. */
const { Vec3 } = require('vec3')
const { players, category, isAir, HOSTILES } = require('./observations.cjs')
const routes = new WeakMap()
function trackPath(bot) {
  // Keep the pathfinder's array: it removes reached nodes as the bot moves.
  bot.on('path_update', (result) =>
    routes.set(bot, { status: result.status, path: result.path || [] }),
  )
  for (const event of ['path_reset', 'path_stop', 'goal_reached', 'end', 'respawn', 'forcedMove'])
    bot.on(event, () => routes.delete(bot))
}
function buildVolume(bot, { focus = 'bot', size = 7, height = size } = {}) {
  if (!bot?.entity?.position) throw new Error('Connect a bot to view its world.')
  if (typeof focus !== 'string' || focus.length > 32) throw new Error('Invalid player focus.')
  if (![7, 11, 15, 17].includes(size))
    throw new Error('Choose a view size of 7, 11, 15 or 17 blocks.')
  if (![5, 7, 11, 15, 17].includes(height) || height > size) throw new Error('Invalid view height.')
  const people = players(bot)
  const person =
    focus === 'player' ? people[0] : focus === 'bot' ? null : people.find((p) => p.name === focus)
  if (!['bot', 'player'].includes(focus) && !person)
    throw new Error('That player is no longer in loaded range.')
  const center = person || bot.entity.position
  const radius = Math.floor(size / 2)
  const origin = {
    x: Math.floor(center.x) - radius,
    y: Math.floor(center.y) - Math.floor(height / 2),
    z: Math.floor(center.z) - radius,
  }
  const blocks = [],
    unknown = [],
    palette = [],
    indexes = new Map()
  for (let y = 0; y < height; y++)
    for (let z = 0; z < size; z++)
      for (let x = 0; x < size; x++) {
        const block = bot.blockAt(new Vec3(origin.x + x, origin.y + y, origin.z + z))
        if (!block) {
          unknown.push([x, y, z])
          continue
        }
        if (isAir(block)) continue
        if (!indexes.has(block.name)) {
          indexes.set(block.name, palette.length)
          palette.push({ name: block.name, category: category(block.name) })
        }
        blocks.push({
          x,
          y,
          z,
          block: indexes.get(block.name),
          shapes: block.shapes || [[0, 0, 0, 1, 1, 1]],
        })
      }
  const point = (p) => ({ x: p.x, y: p.y, z: p.z })
  const inside = (p) =>
    ['x', 'y', 'z'].every(
      (axis) => p[axis] >= origin[axis] && p[axis] < origin[axis] + (axis === 'y' ? height : size),
    )
  const entities = [
    ...new Map([bot.entity, ...Object.values(bot.entities || {})].map((e) => [e.id, e])).values(),
  ]
    .filter((e) => e.position && inside(e.position))
    .slice(0, 80)
    .map((e) => ({
      ...point(e.position),
      name: e.username || (e.id === bot.entity.id ? bot.username : e.name) || 'Entity',
      bot: e.id === bot.entity.id,
      player: !!e.username || e.type === 'player',
      hostile: HOSTILES.has(e.name),
    }))
  const route = routes.get(bot)
  return {
    at: Date.now(),
    size,
    height,
    origin,
    center: point(center),
    focus: person?.name || bot.username,
    dimension: String(bot.game?.dimension || ''),
    blocks,
    unknown,
    palette,
    entities,
    path: {
      status: route?.status || 'idle',
      points: route?.path.length
        ? [point(bot.entity.position), ...route.path.slice(0, 512).map(point)]
        : [],
    },
  }
}
module.exports = { buildVolume, trackPath }
