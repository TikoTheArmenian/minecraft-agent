const { test } = require('node:test')
const assert = require('node:assert/strict')
const { goals } = require('mineflayer-pathfinder')
const Move = require('mineflayer-pathfinder/lib/move')
const { Travel, TravelMovements } = require('../src/navigation/travel.cjs')
const { fixture, Vec3 } = require('./helpers/travel-fixture.cjs')

function irrigationHole() {
  const f = fixture({ stock: 0 })
  f.bot.blockAt = pos => {
    const p = pos.floored()
    if (Math.abs(p.x) > 6 || Math.abs(p.z) > 6 || p.y < 59 || p.y > 68) return null
    const hole = p.x === 0 && p.z === 0
    const name = p.y < 60 ? 'stone' : p.y < 62 ? 'water' : p.y === 62 ? (hole ? 'water' : 'farmland') : p.y === 63 && !hole ? 'wheat' : 'air'
    return f.make(name, p)
  }
  f.bot.entity.position = new Vec3(.5, 62.64, .5)
  f.bot.entity.onGround = false
  f.bot.entity.isInWater = true
  f.bot.pathfinder.setMovements(new TravelMovements(f.bot))
  return f
}
test('surface water has an exit onto farmland, while land jumps remain restricted', () => {
  const f = irrigationHole(), moves = f.bot.pathfinder.movements
  const neighbors = []
  moves.getMoveJumpUp(new Move(0,62,0,0,0), {x:1,z:0}, neighbors)
  assert.ok(neighbors.some(n => n.x === 1 && n.y === 63))
  const old = f.bot.blockAt
  f.bot.blockAt = p => p.floored().equals(new Vec3(0,62,0)) ? f.make('air',p.floored()) : old(p)
  const groundMoves = new TravelMovements(f.bot), groundNeighbors=[]
  groundMoves.getMoveJumpUp(new Move(0,62,0,0,0), {x:1,z:0}, groundNeighbors)
  assert.equal(groundNeighbors.length, 0)
})
test('real physics escapes a one-cell irrigation hole without placing or mining blocks', async () => {
  const f = irrigationHole()
  await f.simulate(new Travel(f.work,15000).go(new goals.GoalBlock(3,63,0), 'Leave irrigation hole'))
  assert.ok(f.bot.entity.position.x > 2)
  assert.ok(f.bot.entity.position.y > 62.8)
  assert.equal(f.placements.length, 0)
})
