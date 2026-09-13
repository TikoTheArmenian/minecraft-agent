// Mineflayer predicts local block removal. Only packets received from the server
// can confirm that a dig really changed the world. This decoder targets Java 1.21.1.
function watchBlock(bot, position, predicate) {
  let settle
  let done = false
  const promise = new Promise(resolve => { settle = resolve })
  const client = bot._client
  const matches = p => p.x === position.x && p.y === position.y && p.z === position.z
  const update = (p, stateId) => {
    if (!done && matches(p) && predicate(stateId)) { done = true; settle(); cleanup() }
  }
  const single = packet => update(packet.location, packet.type)
  const multiple = packet => {
    const c = packet.chunkCoordinates
    if (!c) return
    for (const raw of packet.records) {
      const record = Number(raw)
      update({ x: c.x * 16 + ((record >> 8) & 15), y: c.y * 16 + (record & 15), z: c.z * 16 + ((record >> 4) & 15) }, Math.floor(record / 4096))
    }
  }
  function cleanup() { client.off('block_change', single); client.off('multi_block_change', multiple) }
  client.on('block_change', single)
  client.on('multi_block_change', multiple)
  return { promise, cleanup }
}
module.exports = { watchBlock }
