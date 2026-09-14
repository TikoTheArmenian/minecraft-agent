/** PLACEHOLDER: OreFinder skill. Replace this file with the real implementation. */
const { Work } = require('./work.cjs')
class OreFinder extends Work {
  constructor(agent, id) {
    super(agent, id)
    this.task.skill = 'ORE FINDER'
  }
  async run() {
    this.task.status = 'partial'
    this.addIssue('OreFinder is not implemented yet.')
    this.agent.say('OreFinder is not implemented yet.')
  }
}
// Parameterized commands return a validated { type, ... } object, or null when the text is unrelated.
const parseOreFinder = () => null
module.exports = { OreFinder, parseOreFinder }
