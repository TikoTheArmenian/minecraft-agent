/** Thin skill loop; storage and crafting capabilities also serve existing skills. */
const { randomUUID } = require('node:crypto')
const { Work } = require('../runtime/work.cjs')
const { TravelMovements } = require('../navigation/travel.cjs')
const { HOSTILES } = require('../world/observations.cjs')
const storage = require('../storage/service.cjs')
const crafting = require('../storage/crafting.cjs')
const { CATEGORIES } = require('../storage/policy.cjs')
function parseStorage(text) {
  const commands = {
    'storage and crafting': 'maintain',
    'scan storage': 'scan',
    'store surplus': 'store',
    'organize storage': 'organize',
    'consolidate storage': 'consolidate',
    'expand storage': 'expand',
    'label storage': 'label',
    'supply tools': 'tools',
  }
  if (commands[text]) return { type: 'storageCrafting', action: commands[text] }
  let hub = text.match(/^storage hub (-?\d+) (-?\d+) (-?\d+)$/)
  if (hub) {
    const [x, y, z] = hub.slice(1).map(Number)
    if (Math.abs(x) > 30000000 || Math.abs(z) > 30000000 || y < -64 || y > 319)
      throw new Error('Use valid hub coordinates.')
    return { type: 'storageCrafting', action: 'hub', position: { x, y, z } }
  }
  let m = text.match(/^craft ([a-z_]+) (\d+)$/)
  if (m) {
    const quantity = Number(m[2])
    if (!crafting.allowed(m[1]) || quantity < 1 || quantity > 128)
      throw new Error('Craft 1–128 supported wood products, basic tools, bread or torches.')
    return { type: 'storageCrafting', action: 'craft', item: m[1], quantity }
  }
  m = text.match(/^manage storage (-?\d+) (-?\d+) (-?\d+) ([a-z]+)$/)
  if (m) {
    const [x, y, z] = m.slice(1, 4).map(Number)
    if (
      !CATEGORIES.includes(m[4]) ||
      Math.abs(x) > 30000000 ||
      Math.abs(z) > 30000000 ||
      y < -64 ||
      y > 319
    )
      throw new Error('Use valid chest coordinates and a storage category.')
    return {
      type: 'storageCrafting',
      action: 'manage',
      position: { x, y, z },
      category: m[4],
    }
  }
  m = text.match(/^create storage ([a-z]+)$/)
  if (m) {
    if (!CATEGORIES.includes(m[1])) throw new Error('Choose a supported storage category.')
    return { type: 'storageCrafting', action: 'create', category: m[1] }
  }
  m = text.match(/^reconcile storage (-?\d+) (-?\d+) (-?\d+)$/)
  if (m) {
    const [x, y, z] = m.slice(1).map(Number)
    if (Math.abs(x) > 30000000 || Math.abs(z) > 30000000 || y < -64 || y > 319)
      throw new Error('Use valid chest coordinates.')
    return {
      type: 'storageCrafting',
      action: 'reconcile',
      position: { x, y, z },
    }
  }
  return null
}
class StorageCrafting extends Work {
  constructor(agent, id) {
    super(agent, id)
    this.origin = this.bot.entity.position.clone()
    this.task.skill = 'STORAGE AND CRAFTING'
  }
  check() {
    super.check()
    if (this.bot.game.gameMode !== 'survival')
      throw new Error('Storage and Crafting requires Survival mode.')
    const danger =
      this.bot.health <= 6 ||
      this.bot.entity.isInLava ||
      this.bot.oxygenLevel < 8 ||
      Object.values(this.bot.entities || {}).some(
        (e) => HOSTILES.has(e.name) && e.position?.distanceTo(this.bot.entity.position) < 7,
      )
    if (danger)
      throw Object.assign(
        new Error('Storage paused: health, air, lava or a nearby hostile needs attention.'),
        { fatal: true },
      )
  }
  async boundary(phase, action) {
    const result = await action()
    this.checkpoint({ phase, counts: { ...this.counts } })
    return result
  }
  async run(command) {
    this.bot.pathfinder.setMovements(new TravelMovements(this.bot))
    let monitor = setInterval(() => {
      try {
        this.check()
      } catch (error) {
        if (!this.controller.signal.aborted) this.controller.abort(error)
      }
    }, 500)
    try {
      this.agent.colony.scope(this.agent)
      this.checkpoint({ phase: 'before-storage', action: command.action })
      const db = (action, data = {}) => storage.call(this, action, data)
      if (command.action === 'hub') await db('hub_set', { position: command.position })
      else if (command.action === 'manage')
        await storage.manage(this, command.position, command.category)
      else if (command.action === 'reconcile') await storage.reconcile(this, command.position)
      else if (command.action === 'create') {
        const { position: hub } = await db('hub_get')
        if (!hub) throw new Error('Set storage hub X Y Z before building organized storage.')
        await this.boundary('scanned', () => storage.scan(this))
        await this.boundary('expanded', () =>
          require('../storage/steward.cjs').expand(this, hub, command.category),
        )
        await this.boundary('labeled', () => require('../storage/steward.cjs').label(this, hub))
      } else if (command.action === 'craft') {
        const job = randomUUID()
        await db('enqueue', {
          job,
          item: command.item,
          quantity: command.quantity,
        })
        const claimed = await db('claim_job', { job })
        if (!claimed) throw new Error('Craft job is queued for another worker.')
        await this.boundary('crafted', () => crafting.execute(this, claimed))
      } else {
        const continuous = command.action === 'maintain'
        if (continuous) {
          this.deadline = Infinity
          this.task.deadlineAt = null
          this.task.continuous = true
        }
        do {
          this.check()
          this.checkpoint({ phase: 'before-storage-cycle', action: command.action })
          if (continuous)
            await this.boundary('restocked', () =>
              require('../capabilities/building-supplies.cjs').ensure(this),
            )
          this.progress('Inspecting shared storage.')
          if (!['label', 'tools'].includes(command.action))
            await this.boundary('scanned', () => storage.scan(this))
          const { position: hub } = await db('hub_get')
          const steward = require('../storage/steward.cjs')
          if (['consolidate', 'label', 'tools', 'expand'].includes(command.action) && !hub)
            throw new Error('Set storage hub X Y Z first.')
          if (
            hub &&
            (continuous || command.action === 'expand') &&
            Date.now() >= (this.nextExpansionAt || 0)
          ) {
            try {
              for (let built = 0; built < 3; built++) {
                if (!(await this.boundary('expanded', () => steward.expand(this, hub)))) break
              }
            } catch (error) {
              if (
                !continuous ||
                error.fatal ||
                this.cancelled() ||
                !/Missing materials|No clear warehouse bay|Warehouse floor/.test(error.message)
              )
                throw error
              this.addIssue(`Storage expansion waiting: ${error.message}`)
              this.nextExpansionAt = Date.now() + 60000
            }
          }
          if (hub && (continuous || ['label', 'expand'].includes(command.action)))
            await this.boundary('labeled', () => steward.label(this, hub))
          if (command.action !== 'scan') await this.boundary('stored', () => storage.store(this))
          if (hub && (continuous || ['consolidate', 'organize'].includes(command.action)))
            await this.boundary('consolidated', () => steward.consolidate(this, hub))
          if (hub && (continuous || command.action === 'tools')) {
            await this.boundary('tools', () => steward.tools(this, hub))
            await this.boundary('armor', () => steward.armor(this, hub))
          }
          if (!hub && ['organize', 'maintain'].includes(command.action))
            await this.boundary('organized', () => storage.organize(this))
          if (continuous) {
            const job = await db('claim_job')
            if (job) await this.boundary('crafted', () => crafting.execute(this, job))
            this.progress('Storage checked. Waiting 20 seconds for supplies or crafting jobs.')
            for (let waited = 0; waited < 20000; waited += 1000) {
              await this.pause(1000)
              this.checkpoint({ phase: 'idle' })
            }
          }
        } while (continuous)
      }
      this.checkpoint({ phase: 'storage-complete', action: command.action })
      this.task.status = 'succeeded'
      this.progress('Storage and Crafting complete. Shared stock is updated.')
    } catch (error) {
      const reason = this.controller.signal.reason || error
      this.task.status = ['CANCELLED', 'HANDOFF'].includes(reason.code) ? 'cancelled' : 'partial'
      this.task.reasonCode = reason.code || 'STORAGE_FAILED'
      this.addIssue(reason.message)
      this.agent.say(`Storage and Crafting stopped: ${reason.message}`)
      if (reason.code === 'HANDOFF' || reason.fatal) throw reason
    } finally {
      clearInterval(monitor)
      if (this.agent.bot === this.bot && this.agent.nav === this.id) {
        this.bot.pathfinder.setGoal(null)
        this.bot.clearControlStates()
        if (this.agent.baseMovements) this.bot.pathfinder.setMovements(this.agent.baseMovements)
      }
      this.agent.publish()
    }
  }
}
module.exports = { StorageCrafting, parseStorage }
