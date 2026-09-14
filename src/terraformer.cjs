/** PLACEHOLDER: Terraformer skill. Replace this file with the real implementation. */
const { Work } = require('./work.cjs')
class Terraformer extends Work {
  constructor(agent, id) {
    super(agent, id)
    this.task.skill = 'TERRAFORMER'
  }
  async run() {
    this.task.status = 'partial'
    this.addIssue('Terraformer is not implemented yet.')
    this.agent.say('Terraformer is not implemented yet.')
  }
}
// Parameterized commands return a validated { type, ... } object, or null when the text is unrelated.
const parseTerraformer = () => null
module.exports = { Terraformer, parseTerraformer }
