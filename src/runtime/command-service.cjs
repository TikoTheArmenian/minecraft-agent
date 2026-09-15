// @ts-check
const { object, validate } = require('./schema.cjs')
const invocationSchema = object(
  {
    requestId: { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,128}$' },
    kind: { enum: ['start', 'switch'] },
    skillId: { type: 'string', maxLength: 64 },
    args: { type: 'object' },
    expectedRunId: { type: ['string', 'null'], maxLength: 128 },
  },
  ['requestId', 'kind', 'skillId', 'args'],
)

/** Structured application boundary. Provenance is supplied by the adapter, never the request. */
class CommandService {
  /** @param {import('./types').CommandAgent} agent */
  constructor(agent) {
    this.agent = agent
  }
  /** @param {unknown} input @param {import('./types').Provenance} provenance */
  submit(input, provenance = {}) {
    /** @type {import('./types').Invocation} */
    const invocation = JSON.parse(JSON.stringify(input))
    validate(invocationSchema, invocation, 'Invocation')
    const command = { ...invocation.args, type: invocation.skillId }
    if (Object.hasOwn(invocation.args, 'type'))
      throw new Error('Arguments cannot change the skill identity.')
    /** @type {import('./types').Provenance} */
    const options = {
      ...provenance,
      requestId: invocation.requestId,
      source: provenance.source || 'human',
    }
    // A retry gets its original receipt, even after the active run changes.
    const previous = this.agent.runtime.previous(command, options)
    if (previous) return previous
    if (
      Object.hasOwn(invocation, 'expectedRunId') &&
      invocation.expectedRunId !== (this.agent.activeWork?.task?.runId || null)
    )
      throw Object.assign(
        new Error('The active run changed. Refresh before submitting this assignment.'),
        { code: 'STALE_SESSION' },
      )
    return this.agent.runtime[invocation.kind](command, options)
  }
}
module.exports = { CommandService, invocationSchema }
