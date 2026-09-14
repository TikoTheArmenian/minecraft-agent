/**
 * FLEET PROFILES: the list of players the control room runs, in display order.
 * Adding a bot means adding one entry here. The server, browser tabs, and Sam's role
 * table all read this list, so nothing else needs a hardcoded username.
 * `skill` is the command the "Start <bot>" button sends; it must be a registered alias.
 */
const path = require('node:path')
const root = path.join(__dirname, '..')
const profiles = [
  { id: 'marc', username: 'Marc', dataDir: 'data', skill: 'farmer', action: 'wheat farming', role: 'Wheat & other skills', profession: 'farmer' },
  { id: 'tree', username: 'Jerry', dataDir: 'data/treebot', skill: 'farm trees', action: 'tree farming', role: 'Trees', profession: 'tree farmer' },
  { id: 'barneett', username: 'Barneett', dataDir: 'data/barneett', skill: 'practice-movement', action: 'movement practice', role: 'Movement practice', profession: 'movement explorer' },
  { id: 'sam', username: 'Sam', dataDir: 'data/sam', skill: 'storage and crafting', action: 'storage and crafting', role: 'Storage & Crafting', profession: 'storage and tool maker' },
  { id: 'orin', username: 'Orin', dataDir: 'data/orin', skill: 'find ores', action: 'ore finding', role: 'Ore finder', profession: 'ore finder' },
  { id: 'cane', username: 'Cane', dataDir: 'data/cane', skill: 'farm sugarcane', action: 'sugarcane farming', role: 'Sugarcane', profession: 'sugarcane farmer' },
  { id: 'knight', username: 'Knight', dataDir: 'data/knight', skill: 'hunt mobs', action: 'mob hunting', role: 'Mob killer', profession: 'mob killer' },
  { id: 'terra', username: 'Terra', dataDir: 'data/terra', skill: 'terraform', action: 'terraforming', role: 'Terraformer', profession: 'terraformer' },
  { id: 'forge', username: 'Forge', dataDir: 'data/forge', skill: 'smelt', action: 'smelting', role: 'Smelter', profession: 'smelter' },
]
const profileFor = (username) => profiles.find((p) => p.username === username)
// Browser-safe copy: no filesystem paths.
const publicProfile = ({ id, username, skill, action, role, profession }) => ({ id, username, skill, action, role, profession })
function buildFleet(Agent, options = {}) {
  const fleet = {}
  for (const profile of profiles) {
    const agent = new Agent({ username: profile.username, dataDir: path.join(root, profile.dataDir), ...options })
    agent.profile = publicProfile(profile)
    fleet[profile.id] = agent
  }
  for (const worker of Object.values(fleet)) worker.fleet = fleet
  return fleet
}
module.exports = { profiles, profileFor, publicProfile, buildFleet }
