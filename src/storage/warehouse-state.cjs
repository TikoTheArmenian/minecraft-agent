/** Persistent warehouse intent shared by storage scans and the construction workflow. */
const key = (p) => `${p.x},${p.y},${p.z}`

function memory(work, hub) {
  const state = work.agent.coordination?.recall()
  if (!state) throw new Error('Warehouse construction needs persistent coordinator memory.')
  state.warehouse ||= {}
  return (state.warehouse[key(hub)] ||= { pending: null, completed: {} })
}

function pendingPositions(work) {
  const warehouse = work.agent.coordination?.recall()?.warehouse || {}
  return Object.values(warehouse).flatMap((state) => {
    if (!state.pending) return []
    const [x, y, z] = state.pending.id.split(',').map(Number)
    return [state.pending.id, key({ x: x + 1, y, z })]
  })
}

module.exports = { memory, pendingPositions }
