/** Fleet composition: shared infrastructure, isolated runtime and inbox for every player. */
const path = require('node:path')
const {
  profiles,
  profileFor,
  publicProfile,
  validateProfiles,
  loadProfiles,
} = require('./profiles.cjs')
const { ResourceLeases } = require('../runtime/resource-leases.cjs')
function buildFleet(Agent, options = {}) {
  const { profiles: configured = loadProfiles(), ...dependencies } = options
  const fleet = {}
  const resolved = validateProfiles(configured)
  const resourceLeases = dependencies.resourceLeases || new ResourceLeases()
  const supervisorOptions = { ...dependencies.supervisorOptions }
  supervisorOptions.scheduler ||=
    new (require('../supervisor/inference-scheduler.cjs').InferenceScheduler)({
      file:
        supervisorOptions.schedulerFile ||
        path.resolve(__dirname, '..', '..', 'data', 'supervisor-usage.json'),
    })
  const { PeerDirectory } = require('../messaging/peer-directory.cjs')
  const directory = new PeerDirectory({ agents: () => fleet })
  for (const profile of resolved) {
    const agent = new Agent({
      ...dependencies,
      username: profile.username,
      profile: publicProfile(profile),
      dataDir: path.resolve(__dirname, '..', '..', profile.dataDir || `data/${profile.id}`),
      resourceLeases,
      peerDirectory: directory,
      supervisorOptions,
    })
    fleet[profile.id] = agent
  }
  // Compatibility for legacy views; coordination uses the directory's scoped interface.
  for (const worker of Object.values(fleet)) worker.fleet = fleet
  return fleet
}
module.exports = { profiles, profileFor, publicProfile, buildFleet }
