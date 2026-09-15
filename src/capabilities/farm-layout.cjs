/**
 * FARM GEOMETRY: chooses one ground height and identifies expansion or repair locations.
 * The field may use all clear hydrated soil; water holes stay where irrigation is needed.
 * Soil collection is kept away from the farm level so supplying new plots does not excavate old ones.
 * Helper argument `w` means the currently running work/skill object.
 */

const { Vec3 } = require('vec3')
const { isAir } = require('../world/observations.cjs')
const vegetation = (b) => ['short_grass', 'tall_grass', 'fern', 'large_fern'].includes(b?.name)
// Choose once per routine, favouring the established farm's most common level.
// Do not flatten hills by excavation: extend a single planted platform.
function layout(w) {
  if (w.plan.layout) return w.plan.layout
  const fields = w.find(['farmland'], 48),
    levels = new Map()
  for (const b of fields) levels.set(b.position.y, (levels.get(b.position.y) || 0) + 1)
  const y = levels.size
    ? [...levels].sort((a, b) => b[1] - a[1])[0][0]
    : (w.find(['water'], 32, (b) => isAir(w.bot.blockAt(b.position.offset(0, 1, 0))))[0]?.position
        .y ?? w.origin.floored().y - 1)
  const anchor = fields.find((b) => b.position.y === y)?.position || w.origin.floored()
  return (w.plan.layout = {
    x: anchor.x,
    y,
    z: anchor.z,
    radius: 24,
    strategy: 'Level continuous field, preserved irrigation, repair before expansion',
  })
}
function inside(w, p, margin = 0) {
  const l = layout(w)
  return Math.max(Math.abs(p.x - l.x), Math.abs(p.z - l.z)) <= l.radius + margin
}
function soilAllowed(w, b) {
  // Protect farm-level ground in this district and avoid undermining crops elsewhere.
  if (inside(w, b.position, 4) && b.position.y <= layout(w).y + 1) return false
  for (let x = -4; x <= 4; x++)
    for (let z = -4; z <= 4; z++)
      for (let y = 0; y <= 3; y++)
        if (w.bot.blockAt(b.position.offset(x, y, z))?.name === 'farmland') return false
  return true
}
function groundTargets(w) {
  const l = layout(w),
    holes = [],
    edge = []
  for (let x = l.x - l.radius; x <= l.x + l.radius; x++)
    for (let z = l.z - l.radius; z <= l.z + l.radius; z++) {
      const p = new Vec3(x, l.y, z),
        b = w.bot.blockAt(p)
      if (
        !b ||
        !(isAir(b) || b.name === 'water') ||
        !isAir(w.bot.blockAt(p.offset(0, 1, 0))) ||
        p.distanceTo(w.bot.entity.position) > 32
      )
        continue
      const neighbors = [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ].map(([dx, dz]) => w.bot.blockAt(p.offset(dx, 0, dz)))
      const attached = neighbors.filter((n) =>
        ['dirt', 'grass_block', 'farmland', 'stone', 'cobblestone'].includes(n?.name),
      ).length
      if (!attached) continue
      if (b.name === 'water' && ((x % 9 === 0 && z % 9 === 0) || !w.irrigationRemains(p, true)))
        continue
      // Air gaps within the platform are repaired even without irrigation.
      if (isAir(b) && attached >= 2) holes.push(b)
      else if (w.hydrated(p)) edge.push(b)
    }
  const distance = (a, b) =>
    a.position.distanceTo(w.bot.entity.position) - b.position.distanceTo(w.bot.entity.position)
  return holes.sort(distance).concat(edge.sort(distance))
}
module.exports = { layout, inside, soilAllowed, groundTargets, vegetation }
