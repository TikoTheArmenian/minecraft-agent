const { object, integer, name, coordinate, position, destination } = require('./schema.cjs')
const item = object({ name, count: integer(1, 64) }, ['name', 'count'])
const column = object({ x: coordinate, z: coordinate }, ['x', 'z'])
const empty = object()
const contracts = {
  exchange: {
    parameters: object({
      peer: { type: ['string', 'null'], pattern: '^[a-zA-Z0-9_]{1,16}$' },
      give: item,
      receive: item,
    }),
    profession: 'general worker',
    execution: 'finite',
    handoff: 'cancel-only',
  },
  practiceMovement: { parameters: empty, profession: 'movement explorer', execution: 'continuous' },
  survive: { parameters: empty, profession: 'general worker', execution: 'finite' },
  wheatFarm: {
    parameters: empty,
    profession: 'farmer',
    execution: 'continuous',
    tools: ['iron_hoe', 'iron_shovel'],
    supplies: { wheat_seeds: 32, dirt: 128 },
  },
  treeFarm: {
    parameters: empty,
    profession: 'tree farmer',
    execution: 'continuous',
    resume: 'validated-checkpoint',
    tools: ['iron_axe', 'iron_shovel'],
    supplies: { dirt: 128 },
  },
  torches: { parameters: empty, profession: 'general worker', execution: 'finite' },
  storageCrafting: {
    parameters: object({
      action: {
        type: 'string',
        enum: [
          'maintain',
          'scan',
          'store',
          'organize',
          'consolidate',
          'expand',
          'label',
          'tools',
          'hub',
          'craft',
          'manage',
          'create',
          'reconcile',
        ],
        default: 'maintain',
      },
      item: name,
      quantity: integer(1, 128),
      position,
      category: {
        type: 'string',
        enum: ['tools', 'wood', 'building', 'food', 'materials', 'overflow'],
      },
    }),
    profession: 'storage and tool maker',
    execution: 'mixed',
    requiresStorage: true,
  },
  oreFinder: {
    parameters: object({
      ores: {
        anyOf: [
          { type: 'null' },
          {
            type: 'array',
            minItems: 1,
            maxItems: 8,
            uniqueItems: true,
            items: {
              enum: ['coal', 'iron', 'copper', 'gold', 'redstone', 'lapis', 'diamond', 'emerald'],
            },
          },
        ],
      },
      radius: { ...integer(8, 64), default: 48 },
    }),
    profession: 'ore finder',
    execution: 'continuous',
    tools: ['iron_pickaxe', 'iron_shovel'],
    supplies: { torch: 16 },
  },
  sugarcaneFarm: {
    parameters: empty,
    profession: 'sugarcane farmer',
    execution: 'continuous',
    tools: ['iron_shovel'],
    supplies: { sugar_cane: 8 },
  },
  mobKiller: {
    parameters: object({ radius: { ...integer(8, 48), default: 24 } }),
    profession: 'mob killer',
    execution: 'continuous',
    tools: ['iron_sword'],
  },
  terraformer: {
    parameters: object({ min: column, max: column, y: integer(-60, 300) }),
    profession: 'terraformer',
    execution: 'finite',
    resume: 'validated-checkpoint',
    tools: ['iron_pickaxe', 'iron_shovel'],
    supplies: { dirt: 128 },
  },
  smelter: {
    parameters: object({ item: name, quantity: integer(1, 256) }),
    profession: 'smelter',
    execution: 'mixed',
    resume: 'validated-checkpoint',
    tools: ['iron_pickaxe'],
  },
  goto: {
    parameters: destination,
    profession: 'general worker',
    execution: 'finite',
    handoff: 'cancel-only',
    mode: 'any',
  },
  mineType: {
    parameters: object(
      {
        name,
        count: { ...integer(1, 128), default: 16 },
        radius: { ...integer(1, 64), default: 32 },
      },
      ['name'],
    ),
    profession: 'miner',
    execution: 'finite',
    tools: ['iron_pickaxe'],
  },
  mineArea: {
    parameters: object({ min: position, max: position, volume: integer(1, 512) }, ['min', 'max']),
    profession: 'miner',
    execution: 'finite',
    tools: ['iron_pickaxe', 'iron_shovel'],
  },
  farm: {
    parameters: object(
      {
        crop: { enum: ['wheat', 'carrots', 'potatoes', 'beetroot', 'all'] },
        radius: { ...integer(1, 32), default: 16 },
      },
      ['crop'],
    ),
    profession: 'farmer',
    execution: 'finite',
    supplies: { wheat_seeds: 32 },
  },
}
const resultSchema = object(
  {
    runId: { type: 'string' },
    skillId: { type: 'string' },
    outcome: { enum: ['succeeded', 'partial', 'blocked', 'cancelled', 'failed'] },
    reasonCode: { type: ['string', 'null'] },
    counts: { type: 'object' },
    confirmedEffects: { type: 'array', maxItems: 256, items: { type: 'object' } },
    outstandingOperationIds: { type: 'array', items: { type: 'string' } },
    checkpointId: { type: ['string', 'null'] },
    endedAt: { type: 'number' },
  },
  [
    'runId',
    'skillId',
    'outcome',
    'reasonCode',
    'counts',
    'confirmedEffects',
    'outstandingOperationIds',
    'checkpointId',
    'endedAt',
  ],
)
function contractFor(id) {
  return {
    version: 1,
    handoff: 'checkpoint',
    resume: 'none',
    tools: [],
    supplies: {},
    capabilities: ['minecraft'],
    effects: ['world', 'inventory'],
    result: resultSchema,
    ...contracts[id],
  }
}
module.exports = { contracts, contractFor, resultSchema }
