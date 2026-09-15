/** Profiles describe identity and defaults; active skills supply operational needs. */
const path = require('node:path')
const fs = require('node:fs')
const { actions, skillForAlias } = require('../skills/registry.cjs')
const defaults = [
  {
    id: 'marc',
    username: 'Marc',
    dataDir: 'data',
    skill: 'farmer',
    action: 'wheat farming',
    role: 'Wheat & other skills',
    profession: 'farmer',
  },
  {
    id: 'tree',
    username: 'Jerry',
    dataDir: 'data/treebot',
    skill: 'farm trees',
    action: 'tree farming',
    role: 'Trees',
    profession: 'tree farmer',
  },
  {
    id: 'barneett',
    username: 'Barneett',
    dataDir: 'data/barneett',
    skill: 'practice-movement',
    action: 'movement practice',
    role: 'Movement practice',
    profession: 'movement explorer',
  },
  {
    id: 'sam',
    username: 'Sam',
    dataDir: 'data/sam',
    skill: 'storage and crafting',
    action: 'storage and crafting',
    role: 'Storage & Crafting',
    profession: 'storage and tool maker',
  },
  {
    id: 'orin',
    username: 'Orin',
    dataDir: 'data/orin',
    skill: 'find ores',
    action: 'ore finding',
    role: 'Ore finder',
    profession: 'ore finder',
  },
  {
    id: 'cane',
    username: 'Cane',
    dataDir: 'data/cane',
    skill: 'farm sugarcane',
    action: 'sugarcane farming',
    role: 'Sugarcane',
    profession: 'sugarcane farmer',
  },
  {
    id: 'knight',
    username: 'Knight',
    dataDir: 'data/knight',
    skill: 'hunt mobs',
    action: 'mob hunting',
    role: 'Mob killer',
    profession: 'mob killer',
  },
  {
    id: 'terra',
    username: 'Terra',
    dataDir: 'data/terra',
    skill: 'terraform',
    action: 'terraforming',
    role: 'Terraformer',
    profession: 'terraformer',
  },
  {
    id: 'forge',
    username: 'Forge',
    dataDir: 'data/forge',
    skill: 'smelt',
    action: 'smelting',
    role: 'Smelter',
    profession: 'smelter',
  },
]
function resolveProfile(profile) {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile))
    throw new Error('Each bot profile must be an object.')
  const { id, username } = profile
  if (id === 'events') throw new Error('Bot profile ID events is reserved for the fleet event bus.')
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(id || '') || !/^[a-zA-Z0-9_]{1,16}$/.test(username || ''))
    throw new Error('Profiles need a unique ID and a valid Minecraft username.')
  const fallback = skillForAlias(profile.skill || 'farmer')
  const invocation = profile.defaultInvocation || { skillId: fallback?.type, args: {} }
  const definition = actions.find((s) => s.id === invocation.skillId)
  if (!definition) throw new Error(`Unknown default skill for ${username}.`)
  const allowedSkills = profile.allowedSkills || actions.map((s) => s.id)
  if (
    !Array.isArray(allowedSkills) ||
    allowedSkills.some((id) => !actions.some((s) => s.id === id)) ||
    !allowedSkills.includes(invocation.skillId)
  )
    throw new Error('Profile skills must be registered and include its default.')
  const capabilities = profile.capabilities || []
  if (
    !Array.isArray(capabilities) ||
    capabilities.some((v) => typeof v !== 'string' || !/^[a-zA-Z]{1,40}$/.test(v))
  )
    throw new Error('Invalid profile capabilities.')
  const { validate } = require('../runtime/schema.cjs')
  const args = JSON.parse(JSON.stringify(invocation.args || {}))
  validate(definition.parameters, args, 'Default skill')
  const normalized = require('../runtime/invocations.cjs').validateCommand({
    type: invocation.skillId,
    ...args,
  })
  delete normalized.type
  const supervisor = {
    model: process.env.SUPERVISOR_MODEL || 'gpt-6-astra',
    enabled: false,
    ...profile.supervisor,
  }
  if (
    typeof supervisor.model !== 'string' ||
    !/^[a-zA-Z0-9._:-]{1,100}$/.test(supervisor.model) ||
    typeof supervisor.enabled !== 'boolean' ||
    Object.keys(supervisor).some((k) => !['model', 'enabled'].includes(k))
  )
    throw new Error('Profile supervisor supports model and enabled only.')
  if (
    profile.dataDir !== undefined &&
    (typeof profile.dataDir !== 'string' || !profile.dataDir.trim())
  )
    throw new Error('Profile dataDir must be a directory path.')
  return {
    ...profile,
    id,
    username,
    skill: profile.skill || definition.aliases?.[0] || definition.id,
    action: profile.action || definition.label,
    role: profile.role || definition.label,
    preferredProfession: profile.preferredProfession || profile.profession || definition.profession,
    profession: profile.preferredProfession || profile.profession || definition.profession,
    defaultInvocation: { skillId: invocation.skillId, args: normalized },
    allowedSkills: [...new Set(allowedSkills)],
    capabilities: [...new Set(capabilities)],
    supervisor,
  }
}
const profiles = defaults.map((p) =>
  resolveProfile({ ...p, capabilities: p.id === 'sam' ? ['storageCoordinator'] : [] }),
)
const profileFor = (username) => profiles.find((p) => p.username === username)
function publicProfile({
  id,
  username,
  skill,
  action,
  role,
  profession,
  preferredProfession,
  defaultInvocation,
  allowedSkills,
  capabilities,
  supervisor,
}) {
  return JSON.parse(
    JSON.stringify({
      id,
      username,
      skill,
      action,
      role,
      profession,
      preferredProfession,
      defaultInvocation,
      allowedSkills,
      capabilities,
      supervisor,
    }),
  )
}
function validateProfiles(input) {
  if (!Array.isArray(input) || !input.length || input.length > 32)
    throw new Error('Configure 1–32 bot profiles.')
  const result = input.map(resolveProfile)
  for (const key of ['id', 'username', 'dataDir']) {
    const values = result.map((p) =>
      key === 'dataDir' ? path.resolve(p.dataDir || `data/${p.id}`) : p[key].toLowerCase(),
    )
    if (new Set(values).size !== values.length)
      throw new Error(`Bot profiles must have unique ${key} values.`)
  }
  return result
}
function loadProfiles(file = process.env.BOT_PROFILES_FILE) {
  if (!file) return profiles
  return validateProfiles(JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')))
}
module.exports = {
  profiles,
  profileFor,
  publicProfile,
  resolveProfile,
  validateProfiles,
  loadProfiles,
}
