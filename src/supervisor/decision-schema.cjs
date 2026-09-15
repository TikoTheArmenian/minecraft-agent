/** The model gets the same parameter contracts as human commands, in OpenAI's strict subset. */
const { validate } = require('../runtime/schema.cjs')
const { validateCommand } = require('../runtime/invocations.cjs')
const { actions } = require('../skills/registry.cjs')
const clone = (value) => JSON.parse(JSON.stringify(value))
const object = (properties) => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
})
const text = (maxLength) => ({ type: 'string', minLength: 1, maxLength })
const nullable = (schema) => ({ anyOf: [schema, { type: 'null' }] })

function strictSchema(schema) {
  const result = clone(schema)
  delete result.default
  // This constraint is still enforced by the canonical validator after decoding.
  delete result.uniqueItems
  if (result.enum && !result.type) result.type = typeof result.enum.find((v) => v !== null)
  if (result.anyOf) result.anyOf = result.anyOf.map(strictSchema)
  if (result.items) result.items = strictSchema(result.items)
  if (result.type === 'object') {
    const required = new Set(result.required || [])
    result.properties = Object.fromEntries(
      Object.entries(result.properties || {}).map(([name, field]) => [
        name,
        required.has(name) ? strictSchema(field) : nullable(strictSchema(field)),
      ]),
    )
    result.required = Object.keys(result.properties)
    result.additionalProperties = false
  }
  return result
}

function allowedActions(agent) {
  return actions.filter(
    (action) => !agent.profile?.allowedSkills || agent.profile.allowedSkills.includes(action.id),
  )
}

function decisionSchema(agent) {
  const invocation = {
    anyOf: allowedActions(agent).map((action) =>
      object({
        skillId: { type: 'string', enum: [action.id] },
        args: strictSchema(action.parameters),
      }),
    ),
  }
  const reason = text(400)
  const branches = [
    object({ kind: { type: 'string', enum: ['cancel'] }, reason }),
    object({
      kind: { type: 'string', enum: ['wait'] },
      reason,
      waitMs: nullable({ type: 'integer', minimum: 1000, maximum: 300000 }),
    }),
    object({
      kind: { type: 'string', enum: ['message'] },
      reason,
      to: { type: 'string', pattern: '^(?:[a-zA-Z0-9_]{1,16}|broadcast)$' },
      channel: { type: 'string', enum: ['chat', 'whisper'] },
      messageKind: {
        type: 'string',
        enum: ['observation', 'request', 'proposal', 'accept', 'result'],
      },
      text: text(500),
      conversationId: nullable({ type: 'string', pattern: '^[a-zA-Z0-9_-]{1,64}$' }),
      replyTo: nullable({ type: 'string', pattern: '^[a-zA-Z0-9_-]{1,64}$' }),
    }),
  ]
  if (invocation.anyOf.length)
    branches.unshift(
      object({ kind: { type: 'string', enum: ['start', 'switch'] }, reason, invocation }),
    )
  return object({ decision: { anyOf: branches } })
}

function omitOptionalNulls(value, schema) {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map((item) => omitOptionalNulls(item, schema.items || {}))
  const required = new Set(schema.required || [])
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key, field]) => field !== null || required.has(key))
      .map(([key, field]) => [key, omitOptionalNulls(field, schema.properties?.[key] || {})]),
  )
}

function decodeDecision(output, agent, schema = decisionSchema(agent)) {
  const envelope = clone(output)
  validate(schema, envelope, 'Supervisor decision')
  const decision = envelope.decision
  if (decision.invocation) {
    const action = allowedActions(agent).find((item) => item.id === decision.invocation.skillId)
    if (!action) throw new Error('Supervisor skill is not allowed for this bot.')
    const args = omitOptionalNulls(decision.invocation.args, action.parameters)
    decision.command = validateCommand({ type: action.id, ...args }, agent, { supervisor: true })
  }
  if (decision.kind === 'message' && decision.to === 'broadcast' && decision.channel === 'whisper')
    throw new Error('A whisper requires one named recipient.')
  return decision
}

module.exports = { strictSchema, allowedActions, decisionSchema, decodeDecision, omitOptionalNulls }
