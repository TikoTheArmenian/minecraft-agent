const { Vec3 } = require('vec3')
const { validate } = require('./schema.cjs')
const { contractFor } = require('./skill-contracts.cjs')
function validateCommand(command, agent, { internalSession = null, supervisor = false } = {}) {
  if (!command || typeof command !== 'object' || Array.isArray(command))
    throw new Error('Supply a skill invocation.')
  const { type, ...input } = command
  const definition = require('../skills/registry.cjs').actionFor(type)
  if (!definition) throw new Error('Unknown skill.')
  // Serialize before validating so getters, prototypes, or a caller's later edits cannot change admitted work.
  const args = JSON.parse(JSON.stringify(input))
  validate(definition.parameters, args, definition.label)
  if (agent?.profile?.allowedSkills && !agent.profile.allowedSkills.includes(type))
    throw new Error('This skill is not allowed for this bot.')
  if (
    supervisor &&
    type === 'storageCrafting' &&
    ['hub', 'manage', 'create', 'reconcile'].includes(args.action)
  )
    throw new Error('Storage topology and reconciliation require an explicit human command.')
  if (supervisor && type === 'exchange' && (args.give || args.receive))
    throw new Error(
      'Autonomous exchanges share surplus according to both bots’ reserves; explicit gifts or trades require a human command.',
    )
  if (type === 'smelter' && !!args.item !== !!args.quantity)
    throw new Error('A smelting batch requires both item and quantity.')
  if (type === 'smelter' && args.item && !require('../skills/smelter.cjs').outputOf(args.item))
    throw new Error('Unsupported smelting input.')
  if (type === 'terraformer') {
    if (
      [args.min, args.max, args.y].some((v) => v !== undefined) &&
      [args.min, args.max, args.y].some((v) => v === undefined)
    )
      throw new Error('Terraforming needs both corners and a height.')
    if (args.min) {
      for (const axis of ['x', 'z'])
        [args.min[axis], args.max[axis]] = [
          Math.min(args.min[axis], args.max[axis]),
          Math.max(args.min[axis], args.max[axis]),
        ]
      if (args.max.x - args.min.x >= 32 || args.max.z - args.min.z >= 32)
        throw new Error('Select at most 32×32 columns.')
    }
  }
  if (type === 'storageCrafting') {
    const required =
      {
        craft: ['item', 'quantity'],
        hub: ['position'],
        manage: ['position', 'category'],
        create: ['category'],
        reconcile: ['position'],
      }[args.action] || []
    if (required.some((k) => args[k] === undefined))
      throw new Error(`Storage ${args.action} needs ${required.join(', ')}.`)
    if (args.action === 'craft' && !require('../storage/crafting.cjs').allowed(args.item))
      throw new Error('Unsupported crafting item.')
    if (Object.keys(args).some((k) => k !== 'action' && !required.includes(k)))
      throw new Error(`Storage ${args.action} received unrelated parameters.`)
    if (args.position?.y > 319) throw new Error('Storage positions must be at or below y=319.')
  }
  if (type === 'exchange' && args.receive && !args.give)
    throw new Error('A trade requires an outgoing item.')
  if (type === 'exchange' && args.give?.name === args.receive?.name && args.give)
    throw new Error('Choose different items for a trade.')
  if (type === 'mineArea') {
    for (const axis of ['x', 'y', 'z'])
      [args.min[axis], args.max[axis]] = [
        Math.min(args.min[axis], args.max[axis]),
        Math.max(args.min[axis], args.max[axis]),
      ]
    args.volume =
      (args.max.x - args.min.x + 1) * (args.max.y - args.min.y + 1) * (args.max.z - args.min.z + 1)
    if (args.volume > 512) throw new Error('Select at most 512 block positions per mining area.')
    args.min = new Vec3(args.min.x, args.min.y, args.min.z)
    args.max = new Vec3(args.max.x, args.max.y, args.max.z)
  }
  const normalized = { type, ...args }
  if (internalSession) {
    if (type !== 'exchange') throw new Error('Only an exchange can join an internal session.')
    normalized.invitation = internalSession
  }
  return normalized
}
function availability(agent, command) {
  if (!agent.bot || agent.state.connection !== 'ready')
    return {
      available: false,
      reasonCode: 'DISCONNECTED',
      reason: 'Connect and wait for the bot to spawn first.',
    }
  const definition = contractFor(command.type)
  if (
    definition.mode !== 'any' &&
    !['mineArea', 'mineType', 'farm'].includes(command.type) &&
    agent.bot.game?.gameMode !== 'survival'
  )
    return {
      available: false,
      reasonCode: 'GAME_MODE',
      reason: `This skill needs Survival mode. Run /gamemode survival ${agent.username}, then try again.`,
    }
  if (
    ['mineArea', 'mineType', 'farm'].includes(command.type) &&
    !['survival', 'creative'].includes(agent.bot.game?.gameMode)
  )
    return {
      available: false,
      reasonCode: 'GAME_MODE',
      reason: 'Mining and farming need Survival or Creative mode.',
    }
  if (definition.requiresStorage && !agent.colony?.enabled)
    return {
      available: false,
      reasonCode: 'STORAGE_UNCONFIGURED',
      reason: 'Configure shared storage before starting this skill.',
    }
  return { available: true, reasonCode: null, reason: null }
}
module.exports = { validateCommand, availability }
