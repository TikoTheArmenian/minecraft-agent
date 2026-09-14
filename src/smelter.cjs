/** PLACEHOLDER: Smelter skill. Replace this file with the real implementation. */
const { Work } = require('./work.cjs')
class Smelter extends Work {
  constructor(agent, id) {
    super(agent, id)
    this.task.skill = 'SMELTER'
  }
  async run() {
    this.task.status = 'partial'
    this.addIssue('Smelter is not implemented yet.')
    this.agent.say('Smelter is not implemented yet.')
  }
}
// Parameterized commands return a validated { type, ... } object, or null when the text is unrelated.
const parseSmelter = () => null
module.exports = { Smelter, parseSmelter }
