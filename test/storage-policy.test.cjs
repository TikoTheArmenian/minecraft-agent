const test = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const registry = require('minecraft-data')('1.21.1')
const { reserve } = require('../src/storage/policy.cjs')
const { stocks } = require('../src/storage/crafting.cjs')

test('working reserves combine baseline, active supplies and explicit work reserves conservatively', () => {
  let supplies = { wheat_seeds: 64, dirt: 24, sugar_cane: 16 }
  const work = {
    bot: { registry },
    agent: { currentSkillNeeds: () => ({ supplies }) },
    reserves: { wheat_seeds: 48, dirt: 0, sugar_cane: 32 },
  }
  assert.equal(reserve({ name: 'wheat_seeds' }, work), 64)
  assert.equal(reserve({ name: 'dirt' }, work), 128)
  assert.equal(reserve({ name: 'sugar_cane' }, work), 32)
  // A new invocation changes its supplies without mutating the persistent profession.
  supplies = { coal: 24 }
  assert.equal(reserve({ name: 'coal' }, work), 24)
  assert.equal(reserve({ name: 'wheat_seeds' }, work), 48)
  work.reserves.wheat_seeds = 0
  assert.equal(reserve({ name: 'wheat_seeds' }, work), 32)
})

test('explicit low reserves never release equipment or modified items into ordinary surplus', () => {
  const work = { bot: { registry }, reserves: { iron_pickaxe: 0, oak_log: 0 } }
  assert.equal(reserve({ name: 'iron_pickaxe' }, work), Infinity)
  assert.equal(reserve({ name: 'oak_log', components: [{ type: 'custom_name' }] }, work), Infinity)
})

test('craft planning subtracts current skill supplies once across inventory stacks', () => {
  let supplies = { coal: 24 }
  const work = {
    bot: {
      registry,
      entity: { position: new Vec3(0, 64, 0) },
      inventory: {
        items: () => [
          { name: 'coal', count: 16 },
          { name: 'coal', count: 16 },
        ],
      },
    },
    agent: { currentSkillNeeds: () => ({ supplies }) },
    reserves: { coal: 16 },
  }
  const empty = { containers: [], reservations: [] }
  assert.equal(stocks(work, empty).carry.coal, 8)
  supplies = { coal: 32 }
  assert.equal(stocks(work, empty).carry.coal, 0)
})
