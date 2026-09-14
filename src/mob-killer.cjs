/** PLACEHOLDER: MobKiller skill. Replace this file with the real implementation. */
const { Work } = require('./work.cjs')
class MobKiller extends Work {
  constructor(agent, id) {
    super(agent, id)
    this.task.skill = 'MOB KILLER'
  }
  async run() {
    this.task.status = 'partial'
    this.addIssue('MobKiller is not implemented yet.')
    this.agent.say('MobKiller is not implemented yet.')
  }
}
// Parameterized commands return a validated { type, ... } object, or null when the text is unrelated.
const parseMobKiller = () => null
module.exports = { MobKiller, parseMobKiller }
