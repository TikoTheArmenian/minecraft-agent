/** Thin skill loop; storage and crafting capabilities also serve existing skills. */
const { randomUUID } = require('node:crypto')
const { Work } = require('./work.cjs')
const { TravelMovements } = require('./travel.cjs')
const { HOSTILES } = require('./world.cjs')
const storage = require('./storage.cjs')
const crafting = require('./crafting.cjs')
const { CATEGORIES } = require('./storage-policy.cjs')
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
    const [x,y,z]=hub.slice(1).map(Number)
    if (Math.abs(x)>30000000 || Math.abs(z)>30000000 || y< -64 || y>319) throw new Error('Use valid hub coordinates.')
    return {type:'storageCrafting',action:'hub',position:{x,y,z}}
  }
  let m = text.match(/^craft ([a-z_]+) (\d+)$/)
  if (m) {
    const quantity = Number(m[2])
    if (!crafting.allowed(m[1]) || quantity < 1 || quantity > 128)
      throw new Error(
        'Craft 1–128 supported wood products, basic tools, bread or torches.',
      )
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
    if (!CATEGORIES.includes(m[1]))
      throw new Error('Choose a supported storage category.')
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
        (e) =>
          HOSTILES.has(e.name) &&
          e.position?.distanceTo(this.bot.entity.position) < 7,
      )
    if (danger)
      throw Object.assign(
        new Error(
          'Storage paused: health, air, lava or a nearby hostile needs attention.',
        ),
        { fatal: true },
      )
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
      const db = (action, data = {}) => storage.call(this, action, data)
      if (command.action === 'hub') await db('hub_set', {position:command.position})
      else if (command.action === 'manage')
        await storage.manage(this, command.position, command.category)
      else if (command.action === 'reconcile')
        await storage.reconcile(this, command.position)
      else if (command.action === 'create') {
        if (
          !this.bot.inventory
            .items()
            .some(
              (i) =>
                i.name === 'chest' && require('./storage-policy.cjs').plain(i),
            )
        ) {
          const job = randomUUID()
          await db('enqueue', { job, item: 'chest', quantity: 1 })
          const claimed = await db('claim_job', { job })
          if (!claimed)
            throw new Error('Chest crafting was claimed by another worker.')
          await crafting.execute(this, claimed, { storeOutput: false })
        }
        const {position:hub}=await db('hub_get')
        if(hub) await this.approach(new (require('vec3').Vec3)(hub.x,hub.y,hub.z))
        const chest = await crafting.place(this, 'chest', hub)
        await storage.manage(this, chest.position, command.category)
      } else if (command.action === 'craft') {
        const job = randomUUID()
        await db('enqueue', {
          job,
          item: command.item,
          quantity: command.quantity,
        })
        const claimed = await db('claim_job', { job })
        if (!claimed) throw new Error('Craft job is queued for another worker.')
        await crafting.execute(this, claimed)
      } else {
        const continuous = command.action === 'maintain'
        if (continuous) {
          this.deadline = Infinity
          this.task.deadlineAt = null
          this.task.continuous = true
        }
        do {
          this.check()
          if (continuous) await require('./building-supplies.cjs').ensure(this)
          this.progress('Inspecting shared storage.')
          if (!['label','tools'].includes(command.action)) await storage.scan(this)
          const {position:hub}=await db('hub_get')
          const steward=require('./storage-steward.cjs')
          if (['consolidate','label','tools','expand'].includes(command.action) && !hub) throw new Error('Set storage hub X Y Z first.')
          if (hub && (continuous || command.action==='expand')) await steward.expand(this,hub)
          if (hub && (continuous || ['label','expand'].includes(command.action))) await steward.label(this,hub)
          if (command.action !== 'scan') await storage.store(this)
          if (hub && (continuous || ['consolidate','organize'].includes(command.action))) await steward.consolidate(this,hub)
          if (hub && (continuous || command.action==='tools')) await steward.tools(this,hub)
          if (!hub && ['organize', 'maintain'].includes(command.action))
            await storage.organize(this)
          if (continuous) {
            const job = await db('claim_job')
            if (job) await crafting.execute(this, job)
            this.progress(
              'Storage checked. Waiting 20 seconds for supplies or crafting jobs.',
            )
            await this.pause(20000)
          }
        } while (continuous)
      }
      this.task.status = 'succeeded'
      this.progress('Storage and Crafting complete. Shared stock is updated.')
    } catch (error) {
      this.task.status = error.code === 'CANCELLED' ? 'cancelled' : 'partial'
      this.addIssue(error.message)
      this.agent.say(`Storage and Crafting stopped: ${error.message}`)
    } finally {
      clearInterval(monitor)
      if (this.agent.bot === this.bot && this.agent.nav === this.id) {
        this.bot.pathfinder.setGoal(null)
        this.bot.clearControlStates()
        if (this.agent.baseMovements)
          this.bot.pathfinder.setMovements(this.agent.baseMovements)
      }
      this.agent.publish()
    }
  }
}
module.exports = { StorageCrafting, parseStorage }
