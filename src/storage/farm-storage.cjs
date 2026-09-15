/**
 * CHEST SUPPLIES: remembers observed contents and retrieves seeds or building blocks.
 * Recorded contents may be stale, so every withdrawal reopens the chest and checks current stock.
 * Cooldowns prevent repeated trips to empty or inaccessible storage.
 * Helper argument `w` means the currently running work/skill object.
 */

// Chest contents are observations, not a live inventory. Always reopen before
// withdrawing: players may have changed the contents since our last visit.
function remember(w, chest, window) {
  w.plan.chestContents ||= {}
  w.plan.chestContents[chest.position.toString()] = {
    position: { ...chest.position },
    checkedAt: Date.now(),
    items: window
      .containerItems()
      .map((i) => ({ name: i.name || w.bot.registry.items[i.type]?.name, count: i.count })),
  }
  w.agent.publish()
}
// threshold: when to refill; target: how much to carry after refilling.
// names may contain several interchangeable materials, such as dirt and cobblestone.
async function restock(w, names, target, threshold, label) {
  const total = () => names.reduce((n, name) => n + w.count(name), 0)
  if (total() >= threshold) return
  if (w.agent.colony?.enabled) {
    await require('./service.cjs').retrieve(w, names, target)
    return
  }
  w.seedChestChecks ||= new Map()
  const chests = w.find(['chest'], 32)
  for (const p of w.storage || []) {
    const b = w.bot.blockAt(p)
    if (b?.name === 'chest' && !chests.some((c) => c.position.equals(p))) chests.unshift(b)
  }
  for (const chest of chests.slice(0, 8)) {
    w.check()
    if (total() >= target) break
    const key = chest.position.toString() + ':' + names.join(',')
    if ((w.seedChestChecks.get(key) || 0) > Date.now()) continue
    // Bound retries for empty or inaccessible chests without trusting old stock.
    w.seedChestChecks.set(key, Date.now() + 60000)
    await w.attempt(`Retrieve ${label}`, async () => {
      w.decide(`Checking farm storage for ${label} before gathering more.`)
      await w.approach(chest.position)
      const window = await w.timed(
        async () => {
          const opened = await w.bot.openContainer(chest)
          try {
            w.check()
          } catch (error) {
            opened.close()
            throw error
          }
          return opened
        },
        7000,
        'Open supply storage chest',
      )
      try {
        w.check()
        remember(w, chest, window)
        for (const name of names) {
          if (total() >= target) break
          const type = w.bot.registry.itemsByName[name]?.id
          if (!type) continue
          const available = () =>
            window
              .containerItems()
              .filter((i) => i.type === type)
              .reduce((n, i) => n + i.count, 0)
          const before = w.count(name),
            stored = available()
          const stacks = w.bot.inventory.items().filter((i) => i.type === type)
          // Include both empty slots and spare room in existing stacks.
          const capacity =
            w.bot.inventory.emptySlotCount() * 64 +
            stacks.reduce((n, i) => n + Math.max(0, 64 - i.count), 0)
          const count = Math.min(target - total(), stored, capacity)
          if (count <= 0) continue
          await w.timed(
            () => window.withdraw(type, null, count),
            10000,
            `Retrieve ${count} ${name}`,
          )
          if (w.count(name) - before !== count || stored - available() !== count)
            throw new Error('Supply withdrawal was not fully confirmed.')
          const counter = name === 'wheat_seeds' ? 'seedsRetrieved' : 'buildingBlocksRetrieved'
          w.counts[counter] = (w.counts[counter] || 0) + count
          w.sync()
          w.agent.refresh()
          // After a successful refill, this chest can supply the next work pass too.
          w.seedChestChecks.delete(key)
        }
      } finally {
        remember(w, chest, window)
        window.close()
      }
    })
  }
}
const restockSeeds = (w) => restock(w, ['wheat_seeds'], 32, 8, 'planting seeds')
const restockBuilding = (w) =>
  restock(w, require('../navigation/travel.cjs').BUILDING_BLOCKS, 128, 8, 'bridge building blocks')
module.exports = { restock, remember, restockSeeds, restockBuilding }
