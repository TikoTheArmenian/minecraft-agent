/** Hand-operated passages, with server-confirmed opening and Stop checks. */
const { watchBlock } = require('../minecraft/block-updates.cjs')
const passage = (b) => !!b && (/_fence_gate$/.test(b.name) || /_door$/.test(b.name))
const handOpenable = (b) => passage(b) && b.name !== 'iron_door'
function normalizePassagePath(bot, result) {
  for (const p of result.path || []) {
    if (p.toPlace?.length || p.toBreak?.length) continue
    const b = bot.blockAt(p.floored())
    if (!b?.name.endsWith('_door') || !b.getProperties().open) continue
    // The library's generic shape postprocessor aims at the top of an open
    // door panel. Walking through a door requires the center of its lower cell.
    const lower = b.getProperties().half === 'upper' ? b.position.offset(0, -1, 0) : b.position
    p.x = lower.x + 0.5
    p.y = lower.y
    p.z = lower.z + 0.5
  }
}
function installPassages(bot) {
  if (bot._confirmedPassages || !bot.activateBlock) return
  bot._confirmedPassages = true
  const original = bot.activateBlock.bind(bot)
  const Block = require('prismarine-block')(bot.registry)
  bot.activateBlock = async (block, ...args) => {
    const goal = bot.pathfinder.goal
    if (!goal || !passage(block)) return original(block, ...args)
    const pos = block.position.clone(),
      name = block.name
    const current = () => {
      if (bot.pathfinder.goal !== goal) throw new Error('Passage opening cancelled.')
      const b = bot.blockAt(pos)
      if (b?.name !== name || !handOpenable(b))
        throw new Error('Passage changed or requires redstone.')
      if (bot.entity.position.offset(0, 1.62, 0).distanceTo(pos.offset(0.5, 0.5, 0.5)) > 4.5)
        throw new Error('Passage is out of reach.')
      return b
    }
    if (current().getProperties().open) return
    await bot.lookAt(pos.offset(0.5, 0.5, 0.5))
    if (current().getProperties().open) return
    const cells = name.endsWith('_door') ? [pos, pos.offset(0, 1, 0)] : [pos]
    const acknowledgements = cells
      .filter((p) => !bot.blockAt(p)?.getProperties().open)
      .map((p) =>
        watchBlock(bot, p, (state) => {
          const b = Block.fromStateId(state, 0)
          return b.name === name && b.getProperties().open === true
        }),
      )
    let timer, changed
    try {
      const cancelled = new Promise((_, reject) => {
        changed = (next) => {
          if (next !== goal) reject(new Error('Passage opening cancelled.'))
        }
        bot.on('goal_updated', changed)
        timer = setTimeout(() => reject(new Error('Server did not confirm passage opening.')), 3000)
      })
      current()
      bot.setControlState('sneak', false)
      // Java 1.21.1 use-block packet, after the cancellable turn has finished.
      bot._client.write('block_place', {
        location: pos,
        direction: 1,
        hand: 0,
        cursorX: 0.5,
        cursorY: 0.5,
        cursorZ: 0.5,
        insideBlock: false,
        sequence: 0,
      })
      bot.swingArm?.('right')
      await Promise.race([Promise.all(acknowledgements.map((a) => a.promise)), cancelled])
      current()
      if (cells.some((p) => bot.blockAt(p)?.name !== name || !bot.blockAt(p).getProperties().open))
        throw new Error('Passage closed before crossing.')
    } catch (error) {
      if (bot.pathfinder.goal === goal) bot.pathfinder.setGoal(null)
      throw error
    } finally {
      clearTimeout(timer)
      if (changed) bot.off('goal_updated', changed)
      for (const ack of acknowledgements) ack.cleanup()
    }
  }
}
module.exports = { passage, handOpenable, installPassages, normalizePassagePath }
