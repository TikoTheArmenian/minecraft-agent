/** mineflayer-tool adapter: retain harvest, reserve and 1.21 enchantment policy. */
const { Tool } = require('mineflayer-tool')
const { enchantments, comparisonBlock } = require('./item-tools.cjs')

// Filter for harvest capability before comparing speed, so e.g. a gold pickaxe is
// not chosen for ore requiring a higher tier. Include bare hands where appropriate.
function chooseTool(bot, block, accepts = () => true) {
  return new TaskTool(bot).choose(block, accepts)
}

class TaskTool extends Tool {
  getDigTime(block, item) {
    return comparisonBlock(this.bot, block).digTime(
      item?.type ?? null,
      false,
      false,
      false,
      enchantments(item, this.bot),
      this.bot.entity.effects,
    )
  }
  itemInHand() {
    return this.bot.heldItem
  }
  choose(block, accepts = () => true) {
    const bot = this.bot
    const creative = bot.game.gameMode === 'creative'
    const options = [null, ...bot.inventory.items()].filter((item) => {
      if (!accepts(item)) return false
      if (creative && item && /sword|trident/.test(item.name)) return false
      const max = item && bot.registry.items[item.type]?.maxDurability
      if (max && item.durabilityUsed >= max - 1) return false
      return creative || block.canHarvest(item?.type ?? null)
    })
    if (!options.length)
      throw new Error(
        `Need a suitable tool to harvest ${block.name}. Give ${bot.username || 'the bot'} a tool.`,
      )
    const time = (item) => this.getDigTime(block, item)
    const bareTime = time(null),
      tiers = { wooden: 1, golden: 2, stone: 3, iron: 4, diamond: 5, netherite: 6 }
    const hotbarStart = bot.QUICK_BAR_START ?? 36
    return options
      .map((item) => {
        const duration = time(item),
          useful = item && (block.harvestTools?.[item.type] || duration < bareTime)
        return {
          item,
          duration,
          tier: useful ? tiers[item.name.split('_')[0]] || 0 : 0,
          hotbar: item?.slot >= hotbarStart && item.slot < hotbarStart + 9,
        }
      })
      .sort(
        (a, b) =>
          a.duration - b.duration ||
          b.tier - a.tier ||
          Number(!!a.item) - Number(!!b.item) ||
          Number(b.hotbar) - Number(a.hotbar) ||
          (a.item?.durabilityUsed || 0) - (b.item?.durabilityUsed || 0),
      )[0].item
  }

  async equipForBlock(block, { work, accepts = () => true, getFromChest = false } = {}) {
    if (!work || work.bot !== this.bot) throw new Error('Tool equipping requires its Work owner.')
    work.check()
    if (getFromChest) throw new Error('Tool retrieval must use shared storage.')
    const item = this.choose(block, accepts)
    if ((!item && !this.itemInHand()) || !this.isBetterMiningTool(block, [item])) return item
    await work.equip(item)
    work.check()
    const held = this.itemInHand() ?? null
    if (
      (held?.type ?? null) !== (item?.type ?? null) ||
      !accepts(held) ||
      (this.bot.game.gameMode !== 'creative' && !block.canHarvest(held?.type ?? null))
    )
      throw new Error('The required mining tool was not confirmed in hand.')
    return item
  }
}
module.exports = { TaskTool, chooseTool }
