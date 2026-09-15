/** Public agent events shared by in-process consumers and streaming adapters. */
const EVENT_TYPES = Object.freeze([
  'skill.progress',
  'skill.result',
  'skill.blocked',
  'travel.route',
  'travel.placed',
  'travel.stall',
  'travel.retry',
  'supervisor.decision',
  'message.delivery',
])
const eventEnvelope = (type, botId, payload) => ({ type, botId, at: Date.now(), payload })

module.exports = { EVENT_TYPES, eventEnvelope }
