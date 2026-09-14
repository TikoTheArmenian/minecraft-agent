/** PLACEHOLDER: SugarcaneFarm skill. Replace this file with the real implementation. */
const { Work } = require('./work.cjs')
class SugarcaneFarm extends Work {
  constructor(agent, id) {
    super(agent, id)
    this.task.skill = 'SUGARCANE FARMER'
  }
  async run() {
    this.task.status = 'partial'
    this.addIssue('SugarcaneFarm is not implemented yet.')
    this.agent.say('SugarcaneFarm is not implemented yet.')
  }
}

module.exports = { SugarcaneFarm }
