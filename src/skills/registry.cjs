/** Skill metadata is shared by parsing, validation, dispatch, the API and the browser selector.
 * `aliases[0]` is the browser selector value and the command the Start button sends.
 * `taskSkill` matches the `task.skill` string a running skill publishes so the dashboard can
 * show its live label. `parser` names an optional exported function on the module that turns
 * parameterized text (for example "smelt raw_iron 16") into a validated command object.
 */
const { contractFor } = require('../runtime/skill-contracts.cjs')
const skills = [
  {
    type: 'exchange',
    label: 'Exchange',
    aliases: ['exchange', 'exchange items', 'start exchange'],
    module: './exchange.cjs',
    className: 'Exchange',
    parser: 'parseExchange',
    taskSkill: 'EXCHANGE',
    description:
      'Agree on useful surplus supplies with an idle bot, meet, and verify each handoff. Chat also supports give Jerry 16 dirt or trade Jerry 16 wheat for 8 oak_log.',
    limits:
      'One meeting within 32 blocks, up to 64 items each way. Automatic sharing keeps working reserves. Stop either bot cancels both sides.',
    ready: 'Ready to choose a useful gift or trade with a nearby idle bot.',
  },
  {
    type: 'practiceMovement',
    label: 'Practice movement',
    aliases: ['practice-movement', 'practice movement', 'start practice movement'],
    module: './practice-movement.cjs',
    className: 'PracticeMovement',
    taskSkill: 'PRACTICE MOVEMENT',
    description:
      'Find the nearest sponge and move beside or onto it. Watches for new or moved sponge blocks until Stop.',
    limits:
      'Continuously scans loaded terrain within 64 blocks for dry or wet sponge. Stop cancels.',
    ready: 'Place a sponge, then start to move to it.',
  },
  {
    type: 'survive',
    label: 'Survive',
    aliases: ['survive', 'start survival'],
    module: './survival.cjs',
    className: 'Survival',
    taskSkill: 'SURVIVE',
    description:
      'Gathers supplies, crafts tools, then expands and harvests a wheat farm toward 128 wheat.',
    limits:
      'Starter routine · up to 20 minutes · resources within 80 blocks. Stop the selected bot cancels the skill.',
    ready: 'Ready when you are.',
  },
  {
    type: 'wheatFarm',
    label: 'FARMER',
    aliases: ['farmer', 'start farmer', 'farm wheat forever', 'wheat farm', 'start wheat farm'],
    module: './wheat-farm.cjs',
    className: 'WheatFarm',
    taskSkill: 'FARMER',
    description:
      'Continuously expands, harvests and replants wheat, and stores surplus in chests. Runs until Stop.',
    limits:
      'Continuous production within 80 blocks. Surfaces to restore low air, then resumes. Stop the selected bot cancels the skill.',
    ready: 'Choose Start FARMER to begin continuous wheat production.',
  },
  {
    type: 'treeFarm',
    label: 'Tree farmer',
    aliases: ['farm trees', 'tree farmer', 'start tree farmer'],
    module: './tree-farm.cjs',
    className: 'TreeFarm',
    taskSkill: 'TREE FARMER',
    description:
      'Starts from a nearby tree, retrieves or crafts tools, gathers dirt, harvests whole trees and replants matching saplings.',
    limits:
      'Continuous tree farming. Collects saplings after cutting and saves unfinished planting while working on other trees. Stop cancels.',
    ready: 'Start near a mature tree; tools, dirt and saplings are gathered as needed.',
  },
  {
    type: 'torches',
    label: 'Get torches',
    aliases: ['get torches', 'make torches', 'craft torches'],
    module: './torches.cjs',
    className: 'TorchSkill',
    taskSkill: 'GET TORCHES',
    description: 'Gather coal or make charcoal, then craft 16 torches.',
    limits:
      'Gets 16 torches from coal or charcoal. Requires Survival mode. Stop cancels the skill.',
    ready: 'Ready to gather materials and craft torches.',
  },
  {
    type: 'storageCrafting',
    label: 'Storage and Crafting',
    aliases: ['storage and crafting'],
    module: './storage-crafting.cjs',
    className: 'StorageCrafting',
    parser: 'parseStorage',
    taskSkill: 'STORAGE AND CRAFTING',
    description:
      'Inspect shared chests, store surplus, organize managed storage and fulfill crafting jobs.',
    limits:
      'Shared managed chests within 80 blocks. Requires Supabase configuration. Stop cancels.',
    ready: 'Ready to organize storage and process crafting jobs.',
  },
  {
    type: 'oreFinder',
    label: 'Ore finder',
    aliases: ['find ores', 'ore finder', 'start ore finder'],
    module: './ore-finder.cjs',
    className: 'OreFinder',
    parser: 'parseOreFinder',
    taskSkill: 'ORE FINDER',
    description:
      'Locates exposed ores in loaded terrain, mines the reachable ones safely, and stores the raw ore in shared storage.',
    limits:
      'Loaded terrain within 80 blocks of start. Never digs straight down or into liquids. Stop cancels.',
    ready: 'Ready to search for ores.',
  },
  {
    type: 'sugarcaneFarm',
    label: 'Sugarcane farmer',
    aliases: ['farm sugarcane', 'sugarcane farmer', 'start sugarcane farmer', 'farm sugar cane'],
    module: './sugarcane-farm.cjs',
    className: 'SugarcaneFarm',
    taskSkill: 'SUGARCANE FARMER',
    description:
      'Harvests grown sugar cane above the base, replants along water, expands the patch, and stores surplus.',
    limits:
      'Continuous production near water within 80 blocks of start. Keeps the growing base. Stop cancels.',
    ready: 'Ready to harvest and expand sugar cane.',
  },
  {
    type: 'pumpkinFarm',
    label: 'Pumpkin farmer',
    aliases: [
      'farm pumpkins',
      'pumpkin farmer',
      'start pumpkin farmer',
      'pumpkin farm',
      'start pumpkin farm',
    ],
    module: './pumpkin-farm.cjs',
    className: 'PumpkinFarm',
    taskSkill: 'PUMPKIN FARMER',
    description:
      'Harvests pumpkins while preserving stems, plants irrigated plots with room for fruit, and stores surplus.',
    limits:
      'Continuous farming within 80 blocks of start. Needs seeds or produce, nearby water and a hoe for untilled soil. Stop cancels.',
    ready: 'Ready to grow and harvest pumpkins.',
  },
  {
    type: 'melonFarm',
    label: 'Melon farmer',
    aliases: [
      'farm melons',
      'melon farmer',
      'start melon farmer',
      'melon farm',
      'start melon farm',
    ],
    module: './melon-farm.cjs',
    className: 'MelonFarm',
    taskSkill: 'MELON FARMER',
    description:
      'Harvests melons while preserving stems, plants irrigated plots with room for fruit, and stores surplus.',
    limits:
      'Continuous farming within 80 blocks of start. Needs seeds or produce, nearby water and a hoe for untilled soil. Stop cancels.',
    ready: 'Ready to grow and harvest melons.',
  },
  {
    type: 'mobKiller',
    label: 'Mob killer',
    aliases: ['hunt mobs', 'mob killer', 'start mob killer', 'kill mobs'],
    module: './mob-killer.cjs',
    className: 'MobKiller',
    parser: 'parseMobKiller',
    taskSkill: 'MOB KILLER',
    description:
      'Hunts hostile mobs near its post with the best weapon, retreats and eats when hurt, collects drops, and stores surplus.',
    limits:
      'Hostile mobs only, within a bounded patrol radius. Never attacks players or passive animals. Stop cancels.',
    ready: 'Ready to guard this area.',
  },
  {
    type: 'terraformer',
    label: 'Terraformer',
    aliases: ['terraform', 'terraformer', 'start terraformer'],
    module: './terraformer.cjs',
    className: 'Terraformer',
    parser: 'parseTerraformer',
    taskSkill: 'TERRAFORMER',
    description:
      'Levels a selected rectangle to a target height: cuts blocks above, fills below with building blocks from inventory or shared storage.',
    limits:
      'Bounded rectangle within 64 blocks. Budgets fill material before digging. Stop cancels; rerunning resumes.',
    ready: 'Select an area on the map or send "flatten x1 z1 to x2 z2 at y".',
  },
  {
    type: 'smelter',
    label: 'Smelter',
    aliases: ['smelt', 'smelter', 'start smelter'],
    module: './smelter.cjs',
    className: 'Smelter',
    parser: 'parseSmelter',
    taskSkill: 'SMELTER',
    description:
      'Retrieves raw ores, sand, logs and raw food plus fuel from shared storage, runs furnaces near the hub, and stores the output.',
    limits:
      'Furnaces within the storage area. Confirms every input, fuel and output transfer. Stop cancels while waiting.',
    ready: 'Ready to smelt shared materials.',
  },
].map((s) => ({
  ...s,
  id: s.type,
  ...contractFor(s.type),
  mode: 'survival',
  // An entry may supply its own factory; otherwise the module/className pair is used lazily.
  factory: s.factory || ((agent, id) => new (require(s.module)[s.className])(agent, id)),
}))
const actions = [
  ...skills,
  ...[
    ['goto', 'Walk to coordinates', 'Walk to a nearby coordinate, within 256 blocks.'],
    ['mineType', 'Mine blocks', 'Mine up to 128 named blocks in loaded terrain.'],
    ['mineArea', 'Mine an area', 'Mine a bounded box containing at most 512 block positions.'],
    ['farm', 'Tend crops once', 'Harvest ripe crops and replant within a bounded radius.'],
  ].map(([type, label, description]) => ({
    type,
    id: type,
    label,
    description,
    ...contractFor(type),
  })),
]
const skillFor = (type) => skills.find((s) => s.type === type)
const actionFor = (type) => actions.find((s) => s.type === type)
const skillForAlias = (text) => skills.find((s) => s.aliases.includes(text))
function parseSkill(text) {
  for (const skill of skills) {
    if (!skill.parser) continue
    const parse = require(skill.module)[skill.parser]
    const command = typeof parse === 'function' ? parse(text) : null
    if (command) return command
  }
  const skill = skillForAlias(text)
  return skill ? { type: skill.type } : null
}
// Browser-safe metadata: no factories or module paths.
const publicSkills = () => skills.map(({ factory, module, className, parser, ...s }) => s)
const publicActions = () => actions.map(({ factory, module, className, parser, ...s }) => s)
module.exports = {
  skills,
  actions,
  skillFor,
  actionFor,
  skillForAlias,
  parseSkill,
  publicSkills,
  publicActions,
}
