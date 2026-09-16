const { StemFarm } = require('../capabilities/stem-farm.cjs')
class MelonFarm extends StemFarm {
  constructor(agent, id) {
    super(agent, id, {
      fruit: 'melon',
      produce: 'melon_slice',
      seed: 'melon_seeds',
      block: 'melon_stem',
      attached: 'attached_melon_stem',
      state: 'melonFarm',
      label: 'Melon farmer',
    })
  }
  async cycle() {
    this.checkpoint({ phase: 'between-melon-passes' })
    await super.cycle()
  }
}
module.exports = { MelonFarm }
