const { StemFarm } = require('../capabilities/stem-farm.cjs')
class PumpkinFarm extends StemFarm {
  constructor(agent, id) {
    super(agent, id, {
      fruit: 'pumpkin',
      produce: 'pumpkin',
      seed: 'pumpkin_seeds',
      block: 'pumpkin_stem',
      attached: 'attached_pumpkin_stem',
      state: 'pumpkinFarm',
      label: 'Pumpkin farmer',
    })
  }
  async cycle() {
    this.checkpoint({ phase: 'between-pumpkin-passes' })
    await super.cycle()
  }
}
module.exports = { PumpkinFarm }
