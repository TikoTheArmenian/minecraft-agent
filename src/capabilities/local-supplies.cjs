/** Adapt a Work owner to local chest restocking without cloning its task object.
 * Cooldowns and remembered stock belong to that owner across repeated attempts.
 */
const { restock } = require('../storage/farm-storage.cjs')

async function restockLocal(w, names, target, threshold, label) {
  const state = (w.localSupplyState ||= { plan: {}, checks: new Map() })
  const context = {
    agent: w.agent,
    bot: w.bot,
    plan: w.plan || state.plan,
    counts: w.counts,
    storage: w.storage || [],
    seedChestChecks: state.checks,
    count: (name) =>
      w.bot.inventory
        .items()
        .filter((item) => item.name === name)
        .reduce((sum, item) => sum + item.count, 0),
    find: (types, radius) => {
      const matching = types
        .map((name) => w.bot.registry.blocksByName[name]?.id)
        .filter(Number.isInteger)
      if (!matching.length) return []
      return w.bot
        .findBlocks({ matching, maxDistance: radius, count: 32 })
        .map((position) => w.bot.blockAt(position))
        .filter(Boolean)
    },
    attempt: async (_label, action) => action(),
    decide: (message) => (typeof w.decide === 'function' ? w.decide(message) : w.progress(message)),
    check: () => w.check(),
    approach: (position) => w.approach(position),
    timed: (...args) => w.timed(...args),
    sync: () => w.sync(),
  }
  return restock(context, names, target, threshold, label)
}

module.exports = { restockLocal }
