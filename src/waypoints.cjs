/**
 * SAVED PLACES: reads and validates named locations stored on this computer.
 * The agent separates places by world label and dimension so unrelated worlds do not share destinations.
 */

const fs = require('node:fs')
const path = require('node:path')
const validPoint = (p) =>
  p &&
  typeof p === 'object' &&
  [p.x, p.y, p.z].every(Number.isFinite) &&
  Math.abs(p.x) <= 30000000 &&
  Math.abs(p.z) <= 30000000 &&
  p.y >= -64 &&
  p.y <= 320
const validName = (name) => /^[a-z][a-z0-9 _-]{0,31}$/.test(name)
function readWaypoints(directory) {
  const filename = path.join(directory, 'waypoints.json')
  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(filename, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return {}
    throw new Error(
      `Cannot read saved places in ${filename}: ${error.message}. Fix or move the file and restart; it has not been overwritten.`,
    )
  }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object')
    throw new Error(
      'Saved places must be a JSON object. The existing file has not been overwritten.',
    )
  const saved = {}
  for (const [scope, points] of Object.entries(parsed)) {
    if (!points || Array.isArray(points) || typeof points !== 'object')
      throw new Error('Saved places contain an invalid world entry.')
    const clean = {}
    for (const [name, point] of Object.entries(points)) {
      if (!validName(name) || !validPoint(point))
        throw new Error(
          `Saved place “${name}” has invalid coordinates or a name. Fix the saved-places file before restarting.`,
        )
      Object.defineProperty(clean, name, {
        value: { x: point.x, y: point.y, z: point.z },
        enumerable: true,
        writable: true,
        configurable: true,
      })
    }
    Object.defineProperty(saved, scope, {
      value: clean,
      enumerable: true,
      writable: true,
      configurable: true,
    })
  }
  return saved
}
module.exports = { readWaypoints, validPoint }
