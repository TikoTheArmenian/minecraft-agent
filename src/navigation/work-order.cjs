/** Choose the next block from the patch we are already working in.
 * Sorting once by the starting position makes a row alternate left/right as
 * distances increase. Re-select after every action instead, keeping adjacent
 * targets together even when collecting a drop shifts the bot a little.
 */
function* nearbyFirst(work, blocks) {
  const pending = [...blocks]
  let anchor = work.bot.entity.position
  while (pending.length) {
    work.check()
    let best = 0
    const score = (block) =>
      block.position.distanceTo(anchor) + block.position.distanceTo(work.bot.entity.position) * 0.15
    for (let i = 1; i < pending.length; i++) if (score(pending[i]) < score(pending[best])) best = i
    const [block] = pending.splice(best, 1)
    yield block
    // A failed target should not pull the rest of the route towards it.
    anchor =
      work.bot.blockAt(block.position)?.stateId !== block.stateId
        ? block.position
        : work.bot.entity.position
  }
}
module.exports = { nearbyFirst }
