/** Resource capabilities shared by skills; no starter workflow or published skill state.
 * Each instance remains the current Work owner. Helpers use its live checks and primitives.
 */
const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const { Work, CROPS, mature } = require('../runtime/work.cjs')
const { watchBlock } = require('../minecraft/block-updates.cjs')
const { placeBlockWithOptions, genericPlace } = require('../minecraft/actions.cjs')
const { surroundings, isAir, HOSTILES } = require('../world/observations.cjs')
const { enchantments } = require('../minecraft/item-tools.cjs')
const { eatAtCheckpoint } = require('../minecraft/auto-eat.cjs')
const { equipArmor } = require('../minecraft/armor.cjs')
const cropExpansion = require('./crop-expansion.cjs')

const LOG = /^(?!stripped_).*_log$/
const PICKAXES = [
  'netherite_pickaxe',
  'diamond_pickaxe',
  'iron_pickaxe',
  'stone_pickaxe',
  'wooden_pickaxe',
]
// Avoid poisonous/raw meat foods. Leave planting stock aside when eating produce.
const FOOD = [
  'cooked_beef',
  'cooked_porkchop',
  'cooked_mutton',
  'cooked_chicken',
  'cooked_salmon',
  'cooked_cod',
  'bread',
  'baked_potato',
  'apple',
  'carrot',
  'potato',
  'melon_slice',
  'sweet_berries',
  'beetroot',
]
const blocked = (message) => Object.assign(new Error(message), { code: 'BLOCKED' })

class ResourceWork extends Work {
  constructor(agent, id) {
    super(agent, id)
    this.origin = this.bot.entity.position.clone()
    this.failedTargets = new Set()
    this.visited = new Set()
    this.explorations = 0
    this.table = null
    // Local helper state only. A runnable skill installs its own public plan.
    this.plan = { observations: null, farm: [] }
  }
  attempt(label, fn) {
    return cropExpansion.attempt(this, label, fn)
  }
  expand() {
    return cropExpansion.expand(this)
  }
  extendShore() {
    return cropExpansion.extendShore(this)
  }
  irrigationRemains(pos, protectCrops = false) {
    return cropExpansion.irrigationRemains(this, pos, protectCrops)
  }
  item(name) {
    return this.bot.inventory.items().find((i) => i.name === name && i.count > 0)
  }
  count(name) {
    return this.bot.inventory
      .items()
      .filter((i) => i.name === name)
      .reduce((n, i) => n + i.count, 0)
  }
  total(regex) {
    return this.bot.inventory
      .items()
      .filter((i) => regex.test(i.name))
      .reduce((n, i) => n + i.count, 0)
  }
  usable(name) {
    const item = this.item(name),
      max = item && this.bot.registry.items[item.type]?.maxDurability
    return !!item && (!max || (item.durabilityUsed || 0) < max - 8)
  }
  withoutSilk(item) {
    return !enchantments(item, this.bot).some((e) => e.name === 'silk_touch')
  }
  pick(tier = 'wooden') {
    return PICKAXES.slice(0, PICKAXES.indexOf(`${tier}_pickaxe`) + 1).find(
      (n) => this.usable(n) && this.withoutSilk(this.item(n)),
    )
  }
  observe() {
    this.check()
    this.plan.observations = surroundings(this.bot)
    this.agent.refresh()
  }
  decide(text) {
    this.plan.decision = text
    this.progress(text)
  }
  check() {
    if (!this.cancelled() && this.bot.game.gameMode !== 'survival')
      throw Object.assign(
        blocked(
          `${this.agent.username || this.bot.username || 'This bot'} left Survival mode. Switch it back before restarting the skill.`,
        ),
        { fatal: true },
      )
    super.check()
  }
  safety() {
    if (this.bot.health <= 6)
      return `Health is critically low. Move ${this.agent.username || this.bot.username || 'this bot'} to safety and provide food before continuing.`
    if (this.bot.entity.isInLava)
      return `${this.agent.username || this.bot.username || 'This bot'} is in lava and needs help reaching safety.`
    if (Number.isFinite(this.bot.oxygenLevel) && this.bot.oxygenLevel < 8)
      return `Air is running low. Bring ${this.agent.username || this.bot.username || 'this bot'} out of the water.`
    const threat = Object.values(this.bot.entities || {}).find(
      (e) =>
        HOSTILES.has(e.name) &&
        e.position?.distanceTo(this.bot.entity.position) < (e.name === 'creeper' ? 7 : 5),
    )
    return threat
      ? `${threat.name.replaceAll('_', ' ')} is too close. Clear the danger before continuing.`
      : null
  }
  async eat() {
    await equipArmor(this)
    return eatAtCheckpoint(this, FOOD, (name) =>
      ['carrot', 'potato', 'beetroot'].includes(name) ? 4 : 0,
    )
  }
  safeTarget(block) {
    if (!block || !block.diggable || block.hardness < 0) return false
    if (
      this.plan.layout &&
      ['dirt', 'grass_block'].includes(block.name) &&
      !require('./farm-layout.cjs').soilAllowed(this, block)
    )
      return false
    const neighbors = [
      [1, 0, 0],
      [-1, 0, 0],
      [0, 0, 1],
      [0, 0, -1],
      [0, 1, 0],
      [0, -1, 0],
    ].map((d) => this.bot.blockAt(block.position.offset(...d)))
    if (neighbors.some((b) => !b || /lava|water/.test(b.name))) return false
    if (['sand', 'gravel', 'red_sand'].includes(neighbors[4]?.name)) return false
    // Only exposed resources. No blind tunnels, digging straight down, or access
    // mining outside the chosen target. A later run can use newly exposed terrain.
    return neighbors.slice(0, 5).some(isAir)
  }
  find(names, radius = 32, predicate = () => true) {
    const matching = names
      .map((n) => this.bot.registry.blocksByName[n]?.id)
      .filter(Number.isInteger)
    if (!matching.length) return []
    return this.bot
      .findBlocks({ matching, maxDistance: radius, count: 256 })
      .filter((p) => p.distanceTo(this.origin) <= 80)
      .map((p) => this.bot.blockAt(p))
      .filter((b) => b && !this.failedTargets.has(`${b.position}:${b.name}`) && predicate(b))
      .sort(
        (a, b) =>
          a.position.distanceTo(this.bot.entity.position) -
          b.position.distanceTo(this.bot.entity.position),
      )
  }
  async harvest(block) {
    this.check()
    // Double-height vegetation must be approached at its base. A previous dig
    // may already have removed both cells in this cached resource list.
    block = this.bot.blockAt(block.position)
    if (!block || isAir(block)) return false
    if (['tall_grass', 'large_fern'].includes(block.name) && block.getProperties().half === 'upper')
      block = this.bot.blockAt(block.position.offset(0, -1, 0))
    if (!block || isAir(block)) return false
    if (this.bot.inventory.emptySlotCount() === 0)
      throw blocked('Inventory is full. Make room for gathered materials.')
    this.decide(
      `Collecting ${block.name.replaceAll('_', ' ')}; checking tools and a reachable approach.`,
    )
    try {
      await this.approach(block.position, {
        allowSurface: ['dirt', 'grass_block'].includes(block.name) || LOG.test(block.name),
      })
      if (!this.safeTarget(this.bot.blockAt(block.position)))
        throw new Error('Resource is no longer safely exposed.')
      // These recipes need cobble/raw iron drops; Silk Touch would give the wrong
      // ingredients even though it is technically capable of harvesting the block.
      const requiresDrops = [
        'stone',
        'deepslate',
        'iron_ore',
        'deepslate_iron_ore',
        'short_grass',
        'tall_grass',
        'fern',
        'melon',
      ].includes(block.name)
      await this.dig(
        block.position,
        block.name,
        (b) => this.safeTarget(b),
        requiresDrops ? (item) => item?.name !== 'shears' && this.withoutSilk(item) : () => true,
      )
      this.counts.mined++
      this.sync()
      await this.pause(250)
      await this.pickup(block.position)
      await this.pause(250)
      this.agent.refresh()
      await this.eat()
      return true
    } catch (error) {
      if (
        error.fatal ||
        error.code === 'HANDOFF' ||
        error.code === 'CANCELLED' ||
        error.code === 'BLOCKED'
      )
        throw error
      this.check()
      this.failedTargets.add(`${block.position}:${block.name}`)
      if (error.code === 'NO_ROUTE' && LOG.test(block.name)) {
        // One unreachable tree is one failed approach, not a separate swim for
        // every log in its trunk and crown.
        for (const other of this.find(
          Object.keys(this.bot.registry.blocksByName).filter((n) => LOG.test(n)),
        )) {
          if (
            Math.hypot(other.position.x - block.position.x, other.position.z - block.position.z) <=
            4
          )
            this.failedTargets.add(`${other.position}:${other.name}`)
        }
      }
      this.addIssue(`${block.name}: ${error.message}`)
      return false
    }
  }
  async explore() {
    this.check()
    if (this.explorations >= 8) return false
    const p = this.bot.entity.position.floored(),
      candidates = []
    // Choose ground to explore; the shared travel skill can cross surface water
    // and build short shore stairs to get there. Stay within 80 blocks of start.
    for (const [dx, dz] of [
      [1, 0],
      [0, 1],
      [-1, 0],
      [0, -1],
      [1, 1],
      [-1, 1],
      [-1, -1],
      [1, -1],
    ]) {
      for (let dy = 3; dy >= -4; dy--) {
        const dest = p.offset(dx * 10, dy, dz * 10),
          below = this.bot.blockAt(dest.offset(0, -1, 0))
        const key = `${Math.floor(dest.x / 8)},${Math.floor(dest.z / 8)}`
        if (
          dest.distanceTo(this.origin) > 64 ||
          this.visited.has(key) ||
          below?.boundingBox !== 'block' ||
          /leaves|farmland|magma|cactus/.test(below.name)
        )
          continue
        if (isAir(this.bot.blockAt(dest)) && isAir(this.bot.blockAt(dest.offset(0, 1, 0)))) {
          candidates.push({ dest, key })
          break
        }
      }
    }
    for (const { dest, key } of candidates.slice(0, 3)) {
      this.visited.add(key)
      this.explorations++
      this.decide(
        'Exploring nearby land for missing resources; swimming and shore steps are available.',
      )
      const goal = new goals.GoalNear(dest.x, dest.y, dest.z, 1)
      try {
        await this.travel(goal, `Explore toward ${dest.x},${dest.y},${dest.z}`)
        if (!goal.isEnd(this.bot.entity.position.floored())) continue
        this.observe()
        await this.eat()
        return true
      } catch (error) {
        if (error.fatal || error.code === 'HANDOFF' || error.code === 'CANCELLED') throw error
        this.check()
      }
    }
    return false
  }
  // Keep trying eligible resources until the inventory requirement is met or the bounded attempts run out.
  async gather(
    names,
    satisfied,
    label,
    maxBlocks = 32,
    explore = true,
    continueExploring = () => true,
  ) {
    let removed = 0,
      rounds = 0
    while (!satisfied() && removed < maxBlocks && rounds++ < 12) {
      this.check()
      const targets = this.find(names, 32, (b) => this.safeTarget(b))
      let changed = false
      for (const block of require('../navigation/work-order.cjs').nearbyFirst(this, targets)) {
        if (satisfied() || removed >= maxBlocks) break
        if (this.failedTargets.has(`${block.position}:${block.name}`)) continue
        if (await this.harvest(block)) {
          removed++
          changed = true
        }
      }
      if (satisfied()) return
      if (!changed && (!explore || !continueExploring() || !(await this.explore()))) break
    }
    if (!satisfied())
      throw blocked(
        `Need ${label}. Nearby gathering attempts did not supply enough; review Bot activity for the specific route or resource problem.`,
      )
  }
  // Ask Mineflayer for a real recipe and confirm the resulting inventory change.
  async craft(name, table = null) {
    this.check()
    if (this.agent.colony?.enabled && /_(pickaxe|axe|shovel|hoe|sword)$/.test(name)) {
      const target = this.count(name) + 1
      await require('../storage/service.cjs').retrieve(this, [name], target)
      if (this.count(name) >= target) return
    }
    if (table) {
      await this.approach(table.position)
      table = this.bot.blockAt(table.position)
      if (table?.name !== 'crafting_table') throw blocked('The crafting table changed before use.')
    }
    const item = this.bot.registry.itemsByName[name]
    const recipe = item && this.bot.recipesFor(item.id, null, 1, table)[0]
    if (!recipe) throw blocked(`Missing ingredients for ${name.replaceAll('_', ' ')}.`)
    const before = this.count(name)
    this.decide(`Crafting ${name.replaceAll('_', ' ')} from the materials in inventory.`)
    await this.timed(() => this.bot.craft(recipe, 1, table), 20000, `Craft ${name}`)
    if (this.count(name) < before + recipe.result.count)
      throw blocked(`${name} was not confirmed in inventory.`)
    this.counts.crafted = (this.counts.crafted || 0) + recipe.result.count
    this.sync()
    this.agent.refresh()
  }
  async planks(amount) {
    for (let tries = 0; this.total(/_planks$/) < amount && tries < 16; tries++) {
      let log = this.bot.inventory.items().find((i) => LOG.test(i.name) && i.count > 0)
      if (!log) {
        await this.gather(
          Object.keys(this.bot.registry.blocksByName).filter((n) => LOG.test(n)),
          () => this.total(LOG) >= 2,
          'wood logs',
          12,
        )
        log = this.bot.inventory.items().find((i) => LOG.test(i.name) && i.count > 0)
      }
      await this.craft(log.name.replace(/_log$/, '_planks'))
    }
    if (this.total(/_planks$/) < amount) throw blocked('Could not make enough planks.')
  }
  async sticks(amount) {
    while (this.count('stick') < amount) {
      await this.planks(2)
      await this.craft('stick')
    }
  }
  async placeItem(name, support) {
    const pos = support.position.offset(0, 1, 0)
    await this.approach(support.position)
    await this.equip(this.item(name))
    await this.timed(
      () => this.bot.lookAt(support.position.offset(0.5, 1, 0.5)),
      5000,
      `Turn toward the ${name} placement spot`,
    )
    this.check()
    if (
      !isAir(this.bot.blockAt(pos)) ||
      !isAir(this.bot.blockAt(pos.offset(0, 1, 0))) ||
      this.bot.heldItem?.name !== name
    )
      throw new Error('Placement spot or held item changed.')
    if (this.bot.entity.position.distanceTo(pos.offset(0.5, 0, 0.5)) < 1.5)
      throw new Error('Standing too close to the placement spot.')
    const current = this.bot.blockAt(support.position)
    if (current?.name !== support.name) throw new Error('Placement support changed.')
    await this.timed(
      () =>
        placeBlockWithOptions(this.bot, current, new Vec3(0, 1, 0), {
          forceLook: 'ignore',
          swingArm: 'right',
        }),
      7000,
      `Place ${name}`,
    )
    if (this.bot.blockAt(pos)?.name !== name)
      throw blocked(`Server did not confirm placing ${name}.`)
    return this.bot.blockAt(pos)
  }
  async craftingTable() {
    const nearby = this.find(['crafting_table'], 24)
    if (
      this.table &&
      this.bot.blockAt(this.table.position)?.name === 'crafting_table' &&
      this.table.position.distanceTo(this.bot.entity.position) < 48
    )
      nearby.unshift(this.table)
    for (const table of nearby.slice(0, 3)) {
      try {
        await this.approach(table.position)
        this.table = table
        return table
      } catch (error) {
        if (error.fatal || error.code === 'HANDOFF' || error.code === 'CANCELLED') throw error
        this.check()
      }
    }
    if (!this.item('crafting_table')) {
      await this.planks(4)
      await this.craft('crafting_table')
    }
    const supports = this.find(
      ['grass_block', 'dirt', 'stone', 'cobblestone'],
      8,
      (b) =>
        isAir(this.bot.blockAt(b.position.offset(0, 1, 0))) &&
        isAir(this.bot.blockAt(b.position.offset(0, 2, 0))),
    )
    for (const support of supports.slice(0, 8)) {
      try {
        this.table = await this.placeItem('crafting_table', support)
        this.plan.table = { ...this.table.position }
        return this.table
      } catch (error) {
        if (
          error.fatal ||
          error.code === 'HANDOFF' ||
          error.code === 'CANCELLED' ||
          error.code === 'BLOCKED'
        )
          throw error
        this.check()
      }
    }
    throw blocked('Need a clear, reachable spot on solid ground for a crafting table.')
  }
  async wood() {
    const needed = this.pick('stone') ? 8 : 16
    await this.gather(
      Object.keys(this.bot.registry.blocksByName).filter((n) => LOG.test(n)),
      () => this.total(LOG) * 4 + this.total(/_planks$/) >= needed,
      `${needed / 4} logs or equivalent planks`,
      20,
    )
    return 'Wood supply is in inventory.'
  }
  async wooden() {
    if (this.pick()) return `Already have a usable ${this.pick()}; keeping it.`
    await this.planks(7)
    await this.sticks(2)
    await this.planks(7)
    await this.craft('wooden_pickaxe', await this.craftingTable())
    return 'Wooden pickaxe verified in inventory.'
  }
  async stone() {
    if (this.pick('stone')) return `Already have a usable ${this.pick('stone')}; keeping it.`
    await this.wooden()
    await this.gather(
      ['stone', 'cobblestone', 'deepslate', 'cobbled_deepslate'],
      () => this.count('cobblestone') >= 3 || this.count('cobbled_deepslate') >= 3,
      '3 cobblestone or 3 cobbled deepslate',
      12,
    )
    await this.sticks(2)
    await this.craft('stone_pickaxe', await this.craftingTable())
    return 'Stone pickaxe verified in inventory.'
  }
  async iron() {
    if (this.count('raw_iron') + this.count('iron_ingot') >= 3)
      return 'At least 3 raw iron / iron ingots already in inventory.'
    if (!this.pick('stone'))
      throw blocked(
        'A stone-tier or better pickaxe is required for iron. Finish the tool steps first.',
      )
    await this.gather(
      ['iron_ore', 'deepslate_iron_ore'],
      () => this.count('raw_iron') + this.count('iron_ingot') >= 3,
      '3 raw iron from exposed iron ore',
      12,
    )
    return 'Collected at least 3 iron. Smelting is a separate future step.'
  }
  foodCount() {
    return FOOD.reduce(
      (n, name) =>
        n +
        Math.max(0, this.count(name) - (['carrot', 'potato', 'beetroot'].includes(name) ? 4 : 0)),
      0,
    )
  }
  async food() {
    await this.eat()
    if (this.foodCount() >= 4) return 'Food is stocked; planting reserves are kept aside.'
    // Bread needs a table, while naturally found melons are a useful early source.
    for (let round = 0; round < 4 && this.foodCount() < 4; round++) {
      while (this.count('wheat') >= 3 && this.foodCount() < 4)
        await this.craft('bread', await this.craftingTable())
      if (this.foodCount() >= 4) break
      const targets = this.find(
        ['melon', 'wheat', 'carrots', 'potatoes', 'beetroots'],
        32,
        (b) => b.name === 'melon' || Object.values(CROPS).some((c) => mature(b, c)),
      )
      let progress = false
      for (const block of targets.slice(0, 20)) {
        if (this.foodCount() >= 4) break
        // Crops need irrigation, so the resource-mining liquid check is not used
        // here. Preserve the exact ripe crop predicate through equipping/digging.
        if (block.name === 'melon') {
          progress = (await this.harvest(block)) || progress
          continue
        }
        const crop = Object.values(CROPS).find((c) => mature(block, c)),
          soil = block.position.offset(0, -1, 0)
        try {
          await this.approach(soil)
          await this.dig(
            block.position,
            crop.block,
            (b) => mature(b, crop) && this.bot.blockAt(soil)?.name === 'farmland',
          )
          this.counts.harvested++
          this.sync()
          await this.pause(250)
          await this.pickup(block.position)
          await this.pause(250)
          if (this.seed(crop)) await this.plant(soil, crop)
          else
            this.addIssue(
              'Harvest produced no reachable replanting stock; one existing crop plot is empty.',
            )
          progress = true
        } catch (error) {
          if (error.fatal || error.code === 'HANDOFF' || error.code === 'CANCELLED') throw error
          this.check()
          this.failedTargets.add(`${block.position}:${block.name}`)
        }
      }
      if (!progress && !(await this.explore())) break
    }
    while (this.count('wheat') >= 3 && this.foodCount() < 4)
      await this.craft('bread', await this.craftingTable())
    await this.eat()
    if (this.foodCount() < 1)
      throw blocked(
        `No reachable food found. The new farm can supply food after it grows; apples, bread, or other food can also be dropped beside ${this.agent.username || this.bot.username || 'this bot'}.`,
      )
    return `${this.foodCount()} food items available, with planting stock reserved.`
  }
  // A plot needs nearby water; the scan covers four blocks in each horizontal direction.
  hydrated(soil) {
    for (let dx = -4; dx <= 4; dx++)
      for (let dz = -4; dz <= 4; dz++)
        for (const dy of [0, 1]) {
          if (this.bot.blockAt(soil.offset(dx, dy, dz))?.name === 'water') return true
        }
    return false
  }
  farmSpots() {
    const spots = this.find(
      ['grass_block', 'dirt', 'farmland'],
      32,
      (b) =>
        isAir(this.bot.blockAt(b.position.offset(0, 1, 0))) &&
        isAir(this.bot.blockAt(b.position.offset(0, 2, 0))) &&
        this.hydrated(b.position),
    )
    // A small cluster, all within four blocks of the first plot. Existing flat
    // shoreline supplies irrigation; no bucket, earthmoving or water placement.
    const anchor = spots.find(
      (b) =>
        spots.filter((s) => s.position.y === b.position.y && s.position.distanceTo(b.position) <= 4)
          .length >= 4,
    )
    return anchor
      ? spots
          .filter(
            (b) =>
              b.position.y === anchor.position.y && b.position.distanceTo(anchor.position) <= 4,
          )
          .slice(0, 16)
      : []
  }
  async till(pos, hoe) {
    await this.approach(pos)
    await this.equip(this.item(hoe))
    await this.timed(
      () => this.bot.lookAt(pos.offset(0.5, 1, 0.5)),
      5000,
      'Turn toward the farm plot',
    )
    this.check()
    const soil = this.bot.blockAt(pos)
    if (
      !['dirt', 'grass_block'].includes(soil?.name) ||
      !isAir(this.bot.blockAt(pos.offset(0, 1, 0))) ||
      !this.hydrated(pos) ||
      this.bot.heldItem?.name !== hoe
    )
      throw new Error('The farm spot or hoe changed.')
    const farmland = this.bot.registry.blocksByName.farmland
    const confirmation = watchBlock(
      this.bot,
      pos,
      (state) => state >= farmland.minStateId && state <= farmland.maxStateId,
      this.controller.signal,
    )
    try {
      // The interaction adapter preserves forceLook:'ignore' without a delayed turn.
      // Unlike activateBlock's internal async turn, it cannot activate after Stop.
      await this.timed(
        () =>
          genericPlace(this.bot, soil, new Vec3(0, 1, 0), {
            forceLook: 'ignore',
            swingArm: 'right',
          }),
        5000,
        `Till farmland at ${pos.x},${pos.y},${pos.z}`,
      )
      await this.timed(() => confirmation.promise, 4000, 'Wait for server to confirm farmland')
      await this.pause(50)
      if (this.bot.blockAt(pos)?.name !== 'farmland') throw new Error('Tilling was not confirmed.')
      this.counts.tilled = (this.counts.tilled || 0) + 1
      this.sync()
    } finally {
      confirmation.cleanup()
    }
  }
}
module.exports = { ResourceWork, FOOD, LOG }
