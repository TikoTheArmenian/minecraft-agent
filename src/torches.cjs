/**
 * LIGHTING: getTorches() supplies coal or charcoal and sticks, then crafts torches.
 * lightArea() places available torches near work areas without replacing crops.
 * TorchSkill wraps those helpers as a command the user can run directly.
 * Helper argument `w` means the currently running work/skill object.
 */

const { Survival } = require('./survival.cjs')
const { TravelMovements } = require('./travel.cjs')
const { isAir } = require('./world.cjs')
const LOG = /^(?!stripped_).*_log$/
const fatal = (w, e) => e.fatal || e.code === 'AIR_RECOVERY' || w.cancelled()
async function charcoal(w, amount) {
  let furnace = w.find(['furnace'], 24)[0]
  if (!furnace) {
    if (!w.item('furnace')) {
      if (!w.pick()) await w.wooden()
      await w.gather(
        ['stone', 'cobblestone'],
        () => w.count('cobblestone') >= 8,
        '8 cobblestone for a furnace',
        12,
        false,
      )
      await w.craft('furnace', await w.craftingTable())
    }
    const support = w.find(
      ['dirt', 'grass_block', 'stone', 'cobblestone'],
      12,
      (b) =>
        isAir(w.bot.blockAt(b.position.offset(0, 1, 0))) &&
        isAir(w.bot.blockAt(b.position.offset(0, 2, 0))),
    )[0]
    if (!support) throw new Error('Need a clear dry spot for a charcoal furnace.')
    furnace = await w.placeItem('furnace', support)
  }
  await w.gather(
    Object.keys(w.bot.registry.blocksByName).filter((n) => LOG.test(n)),
    () => w.total(LOG) >= amount + 1,
    'logs for charcoal and furnace fuel',
    amount + 4,
    false,
  )
  await w.planks(Math.ceil(amount / 1.5))
  await w.approach(furnace.position)
  let window
  try {
    await w.timed(
      async () => {
        window = await w.bot.openFurnace(furnace)
        if (w.cancelled() || (w.needsAir && !w.recoveringAir)) {
          window.close()
          w.check()
        }
      },
      7000,
      'Open charcoal furnace',
    )
    if (window.inputItem() || window.fuelItem() || window.outputItem())
      throw new Error(
        'The nearby furnace is occupied. Empty it or provide coal/charcoal for torches.',
      )
    const log = w.bot.inventory.items().find((i) => LOG.test(i.name) && i.count >= amount)
    const fuel = w.bot.inventory
      .items()
      .find((i) => /_planks$/.test(i.name) && i.count >= Math.ceil(amount / 1.5))
    if (!log || !fuel) throw new Error('Need one stack of logs and planks for charcoal.')
    const before = w.count('charcoal')
    await w.timed(() => window.putInput(log.type, null, amount), 7000, 'Load logs for charcoal')
    await w.timed(
      () => window.putFuel(fuel.type, null, Math.ceil(amount / 1.5)),
      7000,
      'Fuel charcoal furnace',
    )
    w.decide('Making charcoal for torches; waiting for the furnace.')
    const end = Date.now() + amount * 10000 + 15000
    while (w.count('charcoal') - before < amount && Date.now() < end) {
      w.check()
      if (window.outputItem()?.name === 'charcoal')
        await w.timed(() => window.takeOutput(), 7000, 'Collect charcoal')
      else await w.pause(250)
    }
    if (w.count('charcoal') - before < amount)
      throw new Error('Charcoal production was not confirmed before the time limit.')
  } finally {
    window?.close()
  }
}
async function getTorches(w, target = 8) {
  w.check()
  if (w.count('torch') >= target) return
  w.decide(`Getting torches: stocking ${target} for lighting.`)
  const fuelNeeded = Math.ceil((target - w.count('torch')) / 4)
  if (w.count('coal') + w.count('charcoal') < fuelNeeded) {
    try {
      if (!w.pick()) await w.wooden()
      await w.gather(
        ['coal_ore', 'deepslate_coal_ore'],
        () => w.count('coal') + w.count('charcoal') >= fuelNeeded,
        'coal for torches',
        fuelNeeded + 2,
        false,
      )
    } catch (e) {
      if (fatal(w, e)) throw e
    }
    const missing = fuelNeeded - w.count('coal') - w.count('charcoal')
    if (missing > 0) await charcoal(w, missing)
  }
  await w.sticks(fuelNeeded)
  while (w.count('torch') < target) {
    w.check()
    await w.craft('torch')
  }
}
async function lightArea(w) {
  if (!w.count('torch')) return
  const crops = w.find(['wheat', 'farmland'], 24)
  const lights = w.find(['torch', 'wall_torch', 'lantern', 'glowstone', 'sea_lantern'], 32)
  const supports = w.find(['dirt', 'grass_block', 'stone', 'cobblestone'], 20, (b) => {
    const top = b.position.offset(0, 1, 0)
    return (
      isAir(w.bot.blockAt(top)) &&
      isAir(w.bot.blockAt(top.offset(0, 1, 0))) &&
      (crops.length
        ? crops.some((c) => c.position.distanceTo(top) <= 5)
        : top.distanceTo(w.bot.entity.position) <= 6) &&
      !lights.some((l) => l.position.distanceTo(top) < 6)
    )
  })
  let placed = 0
  for (const support of supports) {
    if (placed >= 4 || !w.count('torch')) break
    if (lights.some((l) => l.position.distanceTo(support.position.offset(0, 1, 0)) < 6)) continue
    try {
      w.decide('Lighting the farm and work area with torches.')
      const torch = await w.placeItem('torch', support)
      lights.push(torch)
      placed++
      w.counts.torchesPlaced = (w.counts.torchesPlaced || 0) + 1
      w.sync()
    } catch (e) {
      if (fatal(w, e)) throw e
      w.addIssue(`Place torch: ${e.message}`)
    }
  }
}
class TorchSkill extends Survival {
  constructor(agent, id) {
    const prior = agent.state.survival
    super(agent, id)
    agent.state.survival = prior
    this.task.skill = 'GET TORCHES'
  }
  async run() {
    this.bot.pathfinder.setMovements(new TravelMovements(this.bot))
    const guard = setInterval(() => {
      if (!this.cancelled()) {
        const danger = this.safety()
        if (danger) this.controller.abort(Object.assign(new Error(danger), { fatal: true }))
      }
    }, 500)
    try {
      await getTorches(this, 16)
      this.task.status = 'succeeded'
      this.agent.say(`Torches ready: ${this.count('torch')} in inventory.`)
    } catch (e) {
      this.task.status = this.cancelled() ? 'cancelled' : 'partial'
      this.agent.say(`Get torches stopped: ${this.controller.signal.reason?.message || e.message}`)
    } finally {
      clearInterval(guard)
      if (this.agent.bot === this.bot && this.agent.nav === this.id) {
        this.bot.pathfinder.setGoal(null)
        this.bot.clearControlStates()
        if (this.agent.baseMovements) this.bot.pathfinder.setMovements(this.agent.baseMovements)
      }
      this.agent.publish()
    }
  }
}
module.exports = { getTorches, lightArea, charcoal, TorchSkill }
