/**
 * WORKING POSITION: defines where the bot can stand to see and reach a target block.
 * A goal is a test for an acceptable destination, not necessarily the block itself.
 * Most work needs stable ground; selected resource gathering can also use open surface water.
 */

const { goals } = require('mineflayer-pathfinder')

// Grass and crops have no collision shape. GoalLookAtBlock's default raycast
// passes straight through them, so it can report "no path" on an open island.
// Aim at the target cell while still rejecting solid obstructions before it.
function visible(bot, pos, eye, reach = 4.5) {
  const target = pos.offset(0.5, 0.5, 0.5),
    delta = target.minus(eye),
    distance = delta.norm()
  if (distance > reach) return false
  if (!bot.world?.raycast) return !!bot.canSeeBlock?.(bot.blockAt(pos))
  const hit = bot.world.raycast(
    eye,
    delta.normalize(),
    distance + 0.01,
    (block, iter) => block.position.equals(pos) || !!iter.intersect(block.shapes, block.position),
  )
  return !!hit?.position.equals(pos)
}
function canView(bot, pos) {
  return visible(bot, pos, bot.entity.position.offset(0, bot.entity.eyeHeight || 1.62, 0))
}
// Match pathfinder's air-cell convention when feet rest on farmland or a slab.
function workingCell(bot) {
  const p = bot.entity.position, cell = p.floored()
  return bot.entity.onGround && p.y - cell.y > 0.001 &&
    bot.blockAt(cell)?.boundingBox === 'block' ? cell.offset(0, 1, 0) : cell
}
class BlockApproachGoal extends goals.Goal {
  constructor(bot, pos, { allowSurface = false, interaction = false } = {}) {
    super()
    this.bot = bot
    this.pos = pos
    this.allowSurface = allowSurface
    this.interaction = interaction
  }
  heuristic(node) {
    return Math.max(0, node.distanceTo(this.pos) - 3)
  }
  isEnd(node) {
    if (!this.interaction && node.x === this.pos.x && node.z === this.pos.z && node.y === this.pos.y + 1) return false
    // Work from stable ground. A swimming bob is not a dependable mining or
    // farming stance even when the target is momentarily within eye reach.
    const surface =
      this.allowSurface &&
      this.bot.blockAt(node)?.name === 'water' &&
      ['air', 'cave_air'].includes(this.bot.blockAt(node.offset(0, 1, 0))?.name)
    if (!surface && this.bot.blockAt(node.offset(0, -1, 0))?.boundingBox !== 'block') return false
    return visible(
      this.bot,
      this.pos,
      node.offset(0.5, this.bot.entity.eyeHeight || 1.62, 0.5),
      3.75,
    )
  }
}
module.exports = { BlockApproachGoal, canView, visible, workingCell }
