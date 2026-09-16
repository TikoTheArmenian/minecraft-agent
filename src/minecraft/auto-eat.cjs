/** Run auto-eat's ESM controller through a task-scoped bot view. Automatic tick
 * eating stays disabled; every equip/use operation is fenced by Work, and the
 * upstream unbounded listeners/unawaited restoration are replaced locally.
 */
const { isDeepStrictEqual } = require('node:util')
let eatModule
const blocked = (message) => Object.assign(new Error(message), { code: 'BLOCKED' })
const sameItem = (a, b) =>
  a.type === b.type &&
  a.metadata === b.metadata &&
  (a.durabilityUsed || 0) === (b.durabilityUsed || 0) &&
  isDeepStrictEqual(a.nbt, b.nbt) &&
  isDeepStrictEqual(a.componentMap, b.componentMap)

// Subscribe before use_item. Require both consumption acknowledgement and hunger
// gain, in either packet order. Cancellation releases item use and the waiter.
function consumption(work, before) {
  const bot = work.bot,
    signal = work.controller.signal
  let resolve,
    reject,
    active = false,
    acknowledged = false,
    fed = false
  const promise = new Promise((yes, no) => {
    resolve = yes
    reject = no
  })
  promise.catch(() => {}) // Equipping can fail before the controller awaits this.
  const cleanup = () => {
    bot._client.off('entity_status', status)
    bot._client.off('update_health', health)
    signal.removeEventListener('abort', abort)
  }
  const complete = () => {
    if (acknowledged && fed) {
      cleanup()
      resolve()
    }
  }
  const status = (packet) => {
    if (active && packet.entityId === bot.entity.id && packet.entityStatus === 9) {
      acknowledged = true
      fed ||= bot.food > before
      complete()
    }
  }
  const health = (packet) => {
    if (active && packet.food > before) {
      fed = true
      complete()
    }
  }
  const abort = () => {
    cleanup()
    try {
      if (active && work.agent.bot === bot && work.agent.nav === work.id) bot.deactivateItem()
    } catch (_) {} // A closed old socket must not throw out of the AbortSignal handler.
    reject(signal.reason)
  }
  bot._client.on('entity_status', status)
  bot._client.on('update_health', health)
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) abort()
  return {
    promise,
    cleanup,
    activate() {
      work.check()
      active = true
    },
  }
}

async function eatAtCheckpoint(work, foods, reserveFor) {
  work.check()
  if (work.bot.currentWindow || work.bot.inventory.selectedItem) return 0
  if (!Number.isFinite(work.bot.food) || work.bot.food > 16) return 0
  eatModule ||= import('mineflayer-auto-eat/dist/new.js')
  const { EatUtil } = await eatModule
  work.check()
  const bot = work.bot
  const count = (name) =>
    bot.inventory
      .items()
      .filter((i) => i.name === name)
      .reduce((n, i) => n + i.count, 0)
  const available = () =>
    bot.inventory
      .items()
      .filter((i) => foods.includes(i.name) && count(i.name) > reserveFor(i.name))
  let eaten = 0
  for (; eaten < 4 && bot.food <= 16; eaten++) {
    work.check()
    const view = Object.create(bot)
    view.util = {
      inv: {
        getAllItems: available,
        getHand: () => 'hand',
        getHandWithItem: () => bot.heldItem,
        customEquip: async (item) => {
          await work.equip(item)
          work.check()
          return true
        },
      },
    }
    const eater = new EatUtil(view, { priority: 'foodPoints', returnToLastItem: false })
    const item = eater.findBestChoices(available(), 'foodPoints')[0]
    if (!item) break
    const previous = bot.heldItem,
      before = bot.food
    work.decide(`Hunger ${bot.food}/20: eating ${item.name.replaceAll('_', ' ')}.`)
    work.check()
    const receipt = consumption(work, before)
    view.deactivateItem = () => {
      work.check()
      bot.deactivateItem()
    }
    view.activateItem = () => {
      work.check()
      if (bot.heldItem?.type !== item.type || count(item.name) <= reserveFor(item.name))
        throw blocked('Food or planting reserves changed before eating.')
      receipt.activate()
      bot.activateItem(false)
    }
    // The pinned package otherwise leaves timeout listeners behind and restores
    // old equipment without awaiting it. Only this controller instance is adapted.
    eater.buildEatingListener = () => receipt.promise
    try {
      await work.timed(
        () => eater.eat({ food: item, offhand: false, equipOldItem: false }),
        7000,
        `Eat ${item.name}`,
      )
      work.check()
      if (bot.food <= before) throw blocked('Eating was not confirmed by the server.')
      work.agent.refresh()
    } finally {
      receipt.cleanup()
      if (!work.cancelled()) {
        if (!previous) await work.equip(null)
        else {
          const carried = bot.inventory.items().find((i) => i.count > 0 && sameItem(i, previous))
          if (carried) await work.equip(carried)
        }
      }
    }
  }
  return eaten
}

module.exports = { eatAtCheckpoint }
