/** Adapt collectblock's queue to Work's confirmed harvest executor.
 * We deliberately override collect/cancel: upstream owns movement, tools and
 * chests and cannot abort every wait. A batch here never starts a second worker.
 */
const { CollectBlock } = require('mineflayer-collectblock')

const key = (p) => `${p.x},${p.y},${p.z}`
const finite = (p) => p && [p.x, p.y, p.z].every(Number.isFinite)
const busyBots = new WeakMap()

class BlockCollection extends CollectBlock {
  constructor(work) {
    super(work.bot)
    this.work = work
    this.movements = null
    this.chestLocations = []
    this.itemFilter = () => false
    this.pending = null
  }
  // Stock vein discovery deduplicates Block objects by identity. Canonicalize
  // each coordinate for this one bounded read, including the seed itself.
  findFromVein(block, maxBlocks = 32, maxDistance = 8, floodRadius = 1) {
    this.work.check()
    if (
      !finite(block?.position) ||
      !Number.isInteger(maxBlocks) ||
      maxBlocks < 1 ||
      maxBlocks > 128 ||
      !Number.isInteger(maxDistance) ||
      maxDistance < 1 ||
      maxDistance > 16 ||
      floodRadius !== 1
    )
      throw new Error('Vein discovery needs 1–128 blocks within 1–16 blocks and radius 1.')
    const seed = this.bot.blockAt(block.position)
    if (!seed || seed.type !== block.type) return []
    const cache = new Map([[key(seed.position), seed]])
    const bot = {
      blockAt: (pos) => {
        this.work.check()
        const id = key(pos)
        if (!cache.has(id)) cache.set(id, this.bot.blockAt(pos))
        return cache.get(id)
      },
    }
    return CollectBlock.prototype.findFromVein.call(
      { bot },
      seed,
      maxBlocks,
      maxDistance,
      floodRadius,
    )
  }
  collect(blocks, { visit, maxBlocks = 32, satisfied = () => false } = {}) {
    this.work.check()
    if (typeof visit !== 'function') throw new TypeError('Collection requires a Work executor.')
    if (!Number.isInteger(maxBlocks) || maxBlocks < 1 || maxBlocks > 512)
      throw new Error('Collection batches must contain 1–512 targets.')
    if (busyBots.has(this.bot)) throw new Error('A collection batch already owns this bot.')
    const candidates = Array.isArray(blocks) ? blocks : [blocks]
    if (candidates.length > 512) throw new Error('Collection accepts at most 512 candidates.')
    const seen = new Set()
    this.targets.clear()
    for (const block of candidates) {
      if (!finite(block?.position) || !Number.isInteger(block.type))
        throw new TypeError('Collection requires located blocks.')
      const id = key(block.position)
      if (!seen.has(id)) {
        seen.add(id)
        this.targets.appendTarget(block)
      }
    }
    busyBots.set(this.bot, this)
    // Publish ownership before the first async step, including reentrant calls.
    this.pending = Promise.resolve().then(async () => {
      let visited = 0
      try {
        while (!this.targets.empty && visited < maxBlocks) {
          this.work.check()
          if (satisfied()) break
          const target = this.targets.getClosest()
          this.targets.removeTarget(target)
          const live = this.bot.blockAt(target.position)
          if (!live || live.type !== target.type || live.stateId !== target.stateId) continue
          visited++
          // The skill owns approach/dig/pickup, health checks, progress and
          // handoffs. No raw dig, movement mutation or chest transfer lives here.
          await visit(live)
          this.work.check()
        }
        return { visited }
      } finally {
        this.targets.clear()
        if (busyBots.get(this.bot) === this) busyBots.delete(this.bot)
        this.pending = null
      }
    })
    return this.pending
  }
  async cancelTask() {
    if (!this.pending) return
    // Only this batch's Work is cancelled; the existing runtime drains its
    // actions and isolates the old connection if an operation cannot settle.
    this.work.cancel()
    await this.pending.catch(() => {})
  }
}

module.exports = { BlockCollection }
