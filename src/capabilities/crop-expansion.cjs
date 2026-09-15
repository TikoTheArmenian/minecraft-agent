/** Shared crop expansion; the supplied work owns every action and its cancellation. */
const { Vec3 } = require('vec3')
const { nearbyFirst } = require('../navigation/work-order.cjs')
const { CROPS } = require('../runtime/work.cjs')
const { Travel } = require('../navigation/travel.cjs')
const { isAir } = require('../world/observations.cjs')
const { watchBlock } = require('../minecraft/block-updates.cjs')
const { placeBlockWithOptions } = require('../minecraft/actions.cjs')
const { layout, inside, groundTargets, vegetation } = require('./farm-layout.cjs')

async function attempt(w, label, fn) {
  try {
    w.check()
    return await fn()
  } catch (error) {
    if (error.fatal || error.code === 'HANDOFF' || error.code === 'AIR_RECOVERY' || w.cancelled())
      throw error
    w.plan.blocker = `${label}: ${error.message}`
    w.addIssue(`${label}: ${error.message}`)
    return null
  }
}
async function expand(w) {
  await require('../storage/farm-storage.cjs').restockSeeds(w)
  const level = layout(w).y
  // Construction can progress while the existing crops multiply our seeds.
  await w.attempt('Repair and extend level farm ground', () => w.extendShore())
  if (w.count('wheat_seeds') < 2) {
    // A short attempt per cycle, with cooldown between cycles if grass is scarce.
    await w.attempt('Find planting seeds', () =>
      w.gather(
        ['short_grass', 'tall_grass', 'fern'],
        () => w.count('wheat_seeds') >= 8,
        'wheat seeds',
        12,
        false,
      ),
    )
  }
  if (w.count('wheat_seeds') < 2) {
    w.plan.expansion = 'Need more wheat seeds before expanding.'
    return
  }
  let hoe = ['netherite_hoe', 'diamond_hoe', 'iron_hoe', 'stone_hoe', 'wooden_hoe'].find((n) =>
    w.usable(n),
  )
  if (!hoe) {
    const table = await w.craftingTable()
    await w.sticks(2)
    await w.planks(2)
    await w.craft('wooden_hoe', table)
    hoe = 'wooden_hoe'
  }
  const spots = w.find(
    ['farmland', 'grass_block', 'dirt'],
    48,
    (b) =>
      b.position.y === level &&
      inside(w, b.position) &&
      (isAir(w.bot.blockAt(b.position.offset(0, 1, 0))) ||
        vegetation(w.bot.blockAt(b.position.offset(0, 1, 0)))) &&
      w.hydrated(b.position),
  )
  w.plan.expansion = `${spots.length} clear irrigated plots found; ${w.count('wheat_seeds')} seeds available.`
  const before = w.counts.planted
  let inspected = 0
  for (const soil of nearbyFirst(w, spots)) {
    if (++inspected > 64) break
    if (w.counts.planted - before >= 32) break
    if (w.count('wheat_seeds') <= 1) break
    await w.attempt('Expand farm', async () => {
      w.decide(`Expanding the wheat farm · ${w.counts.planted} plantings`)
      const above = w.bot.blockAt(soil.position.offset(0, 1, 0))
      if (vegetation(above)) {
        await w.approach(above.position)
        await w.dig(above.position, above.name)
      }
      if (soil.name !== 'farmland') await w.till(soil.position, hoe)
      await w.approach(soil.position)
      await w.plant(soil.position, CROPS.wheat)
    })
  }
  w.plan.expanded = (w.plan.expanded || 0) + w.counts.planted - before
  w.plan.expansion = `Planted ${w.counts.planted - before} new plots w pass; ${spots.length} candidates inspected.`
}
// Fill supported gaps without removing required irrigation or spending the access-block reserve.
async function extendShore(w) {
  const candidates = groundTargets(w)
  if (!candidates.length) {
    w.plan.expansion = 'No supported, irrigated expansion or repair sites at the farm level.'
    return
  }
  w.decide(
    `Repairing and extending the level farm at Y=${layout(w).y}; gathering dirt outside the protected farm.`,
  )
  if (w.count('dirt') < 12)
    await w.attempt('Gather expansion dirt', () =>
      w.gather(
        ['dirt', 'grass_block'],
        () => w.count('dirt') >= 12,
        'dirt for new farm ground',
        16,
        false,
      ),
    )
  if (!w.count('dirt')) {
    w.plan.blocker = 'Need reachable dirt or grass blocks to extend the farm.'
    return
  }
  // Keep spaced permanent water holes and never remove the last nearby water.
  // New level ground connects successive sections of the growing farm.
  const water = candidates
  let built = 0,
    inspected = 0,
    routeFailures = 0
  w.groundFailures ||= new Map()
  for (const target of nearbyFirst(w, water)) {
    if ((w.groundFailures.get(target.position.toString()) || 0) > Date.now()) continue
    if (inspected++ >= 24) break
    if (built >= 12 || w.count('dirt') <= 8) break
    const faces = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)]
    const face = faces.find((d) =>
      ['dirt', 'grass_block', 'farmland', 'stone', 'cobblestone'].includes(
        w.bot.blockAt(target.position.minus(d))?.name,
      ),
    )
    if (!face) continue
    const placed = await w.attempt('Place farm ground', async () => {
      const refPos = target.position.minus(face)
      await w.approach(refPos)
      await w.equip(w.item('dirt'))
      await w.timed(
        () => w.bot.lookAt(refPos.offset(0.5, 0.5, 0.5).plus(face.scaled(0.5))),
        5000,
        'Face the new farm ground',
      )
      w.check()
      const p = w.bot.entity.position
      if (
        Math.abs(p.x - target.position.x - 0.5) < 0.9 &&
        Math.abs(p.z - target.position.z - 0.5) < 0.9
      )
        throw new Error('Standing in the new plot; leaving it clear.')
      if (
        !(
          isAir(w.bot.blockAt(target.position)) ||
          (w.bot.blockAt(target.position)?.name === 'water' &&
            w.irrigationRemains(target.position, true))
        ) ||
        w.bot.heldItem?.name !== 'dirt'
      )
        throw new Error('Farm-ground placement changed.')
      new Travel(w, 15000).placementValid({ pos: target.position, ref: refPos, face }, 'dirt', {
        farmSupport: true,
      })
      const dirt = w.bot.registry.blocksByName.dirt,
        ack = watchBlock(
          w.bot,
          target.position,
          (s) => s >= dirt.minStateId && s <= dirt.maxStateId,
          w.controller.signal,
        )
      try {
        await w.timed(
          () =>
            placeBlockWithOptions(w.bot, w.bot.blockAt(refPos), face, {
              forceLook: 'ignore',
              swingArm: 'right',
            }),
          7000,
          'Extend farm ground with dirt',
        )
        await w.timed(() => ack.promise, 4000, 'Confirm new farm ground')
        built++
        w.plan.groundAdded = (w.plan.groundAdded || 0) + 1
        w.counts.groundAdded = (w.counts.groundAdded || 0) + 1
        w.sync()
      } finally {
        ack.cleanup()
      }
      return true
    })
    if (!placed) {
      w.groundFailures.set(target.position.toString(), Date.now() + 60000)
      if (/route|view|reach/i.test(w.plan.blocker || '') && ++routeFailures >= 3) {
        w.plan.blocker =
          'Three construction approaches were blocked. Continuing other farm work before retrying.'
        break
      }
    } else routeFailures = 0
  }
  if (built)
    w.plan.expansion = `Added or repaired ${built} level ground blocks; planting available plots next.`
  if (!built)
    w.plan.blocker =
      'Expansion needs reachable surface water, solid shore support, and dirt. No new ground could be placed w pass.'
}
function irrigationRemains(w, pos, protectCrops = false) {
  const otherWater = (soil) => {
    for (let x = -4; x <= 4; x++)
      for (let z = -4; z <= 4; z++)
        for (const y of [0, 1]) {
          const p = soil.offset(x, y, z)
          if (!p.equals(pos) && w.bot.blockAt(p)?.name === 'water') return true
        }
    return false
  }
  if (!otherWater(pos)) return false
  // Replacing water must not dry out any existing farmland it irrigated.
  if (protectCrops)
    for (let x = -4; x <= 4; x++)
      for (let z = -4; z <= 4; z++)
        for (const y of [-1, 0]) {
          const soil = pos.offset(x, y, z)
          if (w.bot.blockAt(soil)?.name === 'farmland' && !otherWater(soil)) return false
        }
  return true
}

module.exports = { attempt, expand, extendShore, irrigationRemains }
