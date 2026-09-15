const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const { Vec3 } = require('vec3')
const { Agent } = require('../src/agents/agent.cjs')
const { Work } = require('../src/runtime/work.cjs')
const { actionFor } = require('../src/skills/registry.cjs')
const { loadJson } = require('../src/infra/json-store.cjs')
const storage = require('../src/storage/service.cjs')
const crafting = require('../src/storage/crafting.cjs')
const { describe } = require('../src/storage/policy.cjs')
const registry = require('minecraft-data')('1.21.1')
const Item = require('prismarine-item')(registry)
const Recipe = require('prismarine-recipe')(registry).Recipe
const item = (name, count, slot) =>
  Object.assign(new Item(registry.itemsByName[name].id, count), { slot })

function fixture(t, execute) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inventory-runtime-'))
  const calls = [],
    slots = Array(63).fill(null)
  const agent = new Agent({
    dataDir,
    colony: {
      enabled: true,
      scope: () => ({ session: 'offline' }),
      async call(actor, name, data) {
        calls.push({ name, data })
        if (name === 'list') return { containers: [], reservations: [], jobs: [], uncertain: [] }
        return {}
      },
    },
  })
  const bot = (agent.bot = Object.assign(new EventEmitter(), {
    registry,
    game: { gameMode: 'survival' },
    entity: { id: 1, position: new Vec3(0, 64, 0) },
    inventory: {
      items: () => slots.slice(27).filter((i) => i?.count > 0),
      emptySlotCount: () => 20,
    },
    pathfinder: { setGoal() {}, setMovements() {} },
    clearControlStates() {},
    stopDigging() {},
    findBlocks: () => [],
    recipesAll: (id) => Recipe.find(id, null),
  }))
  Object.assign(agent.state, { connection: 'ready', dimension: 'overworld' })
  const definition = actionFor('storageCrafting'),
    original = definition.factory
  let work
  definition.factory = (agent, id) => {
    work = new Work(agent, id)
    work.run = async () => {
      await execute(work)
      work.task.status = 'succeeded'
    }
    return work
  }
  t.after(() => {
    definition.factory = original
    agent.stop(false)
    fs.rmSync(dataDir, { recursive: true, force: true })
  })
  const run = () => agent.runtime.start({ type: 'storageCrafting', action: 'store' }).completion
  return {
    agent,
    bot,
    slots,
    calls,
    run,
    work: () => work,
    saved: () => loadJson(path.join(dataDir, 'runs.json')).data.runs.at(-1),
  }
}
function transferContext(f) {
  const window = {
    slots: f.slots,
    inventoryStart: 27,
    inventoryEnd: 63,
    containerItems: () => f.slots.slice(0, 27).filter(Boolean),
    selectedItem: null,
  }
  return {
    window,
    id: { container: '1,64,0' },
    reopen: async () => window,
    db: async (name, data) => {
      f.calls.push({ name, data })
      if (name === 'begin') assert.equal(f.saved().operations.at(-1).status, 'intent')
    },
  }
}

test('real storage boundary persists local intent before backend begin and records confirmed result', async (t) => {
  let f
  f = fixture(t, (w) =>
    storage.transfer(w, transferContext(f), 'deposit', describe(f.slots[27]).fingerprint, 5),
  )
  f.slots[27] = item('oak_log', 8, 27)
  f.bot.transfer = async (options) => {
    assert.equal(f.saved().operations[0].status, 'intent')
    f.slots[0] = item('oak_log', options.count, 0)
    f.slots[27].count -= options.count
  }
  const result = await f.run(),
    saved = f.saved()
  assert.deepEqual(
    f.calls.map((c) => c.name),
    ['renew', 'begin', 'finish'],
  )
  assert.equal(saved.operations[0].status, 'confirmed')
  assert.deepEqual(result.outstandingOperationIds, [])
  assert.equal(result.confirmedEffects[0].operationId, saved.operations[0].id)
  assert.equal(result.confirmedEffects[0].count, 5)
  assert.equal(result.counts.stored, 5)
})
test('unconfirmed storage mutation blocks unrelated skills through the run journal', async (t) => {
  let f
  f = fixture(t, (w) =>
    storage.transfer(w, transferContext(f), 'deposit', describe(f.slots[27]).fingerprint, 5),
  )
  f.slots[27] = item('oak_log', 8, 27)
  f.bot.transfer = async () => {}
  const result = await f.run(),
    saved = f.saved()
  assert.deepEqual(
    f.calls.map((c) => c.name),
    ['renew', 'begin'],
  )
  assert.equal(saved.operations[0].status, 'uncertain')
  assert.deepEqual(result.outstandingOperationIds, [saved.operations[0].id])
  assert.deepEqual(result.confirmedEffects, [])
  assert.throws(() => f.agent.runtime.validate({ type: 'treeFarm' }), {
    code: 'REQUIRES_RECONCILIATION',
  })
})
test('local intent persistence failure prevents backend begin and Minecraft transfer', async (t) => {
  let f,
    packets = 0
  f = fixture(t, (w) =>
    storage.transfer(w, transferContext(f), 'deposit', describe(f.slots[27]).fingerprint, 5),
  )
  f.slots[27] = item('oak_log', 8, 27)
  f.bot.transfer = async () => {
    packets++
  }
  t.mock.method(f.agent.runtime, 'saveOperation', () => {
    throw Object.assign(new Error('local disk failed'), {
      code: 'CHECKPOINT_WRITE_FAILED',
      fatal: true,
    })
  })
  const result = await f.run()
  assert.equal(result.reasonCode, 'CHECKPOINT_WRITE_FAILED')
  assert.deepEqual(
    f.calls.map((c) => c.name),
    ['renew'],
  )
  assert.equal(packets, 0)
})
test('confirmed backend transfer retains uncertainty if local settlement cannot be saved', async (t) => {
  let f
  f = fixture(t, (w) =>
    storage.transfer(w, transferContext(f), 'deposit', describe(f.slots[27]).fingerprint, 5),
  )
  f.slots[27] = item('oak_log', 8, 27)
  f.bot.transfer = async () => {
    f.slots[0] = item('oak_log', 5, 0)
    f.slots[27].count -= 5
  }
  const save = f.agent.runtime.saveOperation.bind(f.agent.runtime)
  t.mock.method(f.agent.runtime, 'saveOperation', (w, operation) => {
    if (operation.status === 'confirmed')
      throw Object.assign(new Error('settlement write failed'), {
        code: 'CHECKPOINT_WRITE_FAILED',
        fatal: true,
      })
    return save(w, operation)
  })
  const result = await f.run()
  assert.equal(result.reasonCode, 'CHECKPOINT_WRITE_FAILED')
  assert.equal(result.confirmedEffects[0].count, 5)
  assert.equal(f.saved().operations[0].status, 'uncertain')
  assert.equal(result.outstandingOperationIds.length, 1)
})
test('actual recipe execution records confirmed effects only after backend settlement', async (t) => {
  let f
  const job = { id: 'craft-review', item: 'oak_planks', quantity: 4 }
  f = fixture(t, (w) => crafting.execute(w, job, { storeOutput: false }))
  f.slots[27] = item('oak_log', 2, 27)
  f.bot.craft = async (recipe) => {
    assert.equal(f.saved().operations.at(-1).status, 'intent')
    for (const delta of recipe.delta) {
      const name = registry.items[delta.id].name,
        existing = f.bot.inventory.items().find((i) => i.name === name)
      if (existing) existing.count += delta.count
      else f.slots[28] = item(name, delta.count, 28)
    }
  }
  const result = await f.run(),
    saved = f.saved()
  assert.equal(result.outcome, 'succeeded')
  assert.equal(saved.operations[0].kind, 'craft')
  assert.equal(saved.operations[0].status, 'confirmed')
  assert.equal(result.confirmedEffects[0].kind, 'crafted')
  assert.equal(result.confirmedEffects[0].count, 4)
  assert.equal(result.counts.crafted, 4)
  assert.equal(f.calls.filter((c) => c.name === 'finish_craft').length, 1)
})
test('Stop after backend confirmation preserves confirmed stock and effects', async (t) => {
  let f
  f = fixture(t, (w) => {
    const ctx = transferContext(f),
      db = ctx.db
    ctx.db = async (name, data) => {
      await db(name, data)
      if (name === 'finish') f.agent.stop(false)
    }
    return storage.transfer(w, ctx, 'deposit', describe(f.slots[27]).fingerprint, 5)
  })
  f.slots[27] = item('oak_log', 8, 27)
  f.bot.transfer = async () => {
    f.slots[0] = item('oak_log', 5, 0)
    f.slots[27].count -= 5
  }
  const result = await f.run()
  assert.equal(result.outcome, 'cancelled')
  assert.equal(f.saved().operations[0].status, 'confirmed')
  assert.deepEqual(result.outstandingOperationIds, [])
  assert.equal(result.counts.stored, 5)
  assert.equal(result.confirmedEffects[0].count, 5)
})
test('a failed backend settlement retains local uncertainty without claiming a confirmed effect', async (t) => {
  let f
  f = fixture(t, (w) => {
    const ctx = transferContext(f),
      db = ctx.db
    ctx.db = async (name, data) => {
      await db(name, data)
      if (name === 'finish') throw new Error('backend settlement unavailable')
    }
    return storage.transfer(w, ctx, 'deposit', describe(f.slots[27]).fingerprint, 5)
  })
  f.slots[27] = item('oak_log', 8, 27)
  f.bot.transfer = async () => {
    f.slots[0] = item('oak_log', 5, 0)
    f.slots[27].count -= 5
  }
  const result = await f.run()
  assert.equal(result.outcome, 'failed')
  assert.equal(f.saved().operations[0].status, 'uncertain')
  assert.equal(result.outstandingOperationIds.length, 1)
  assert.deepEqual(result.confirmedEffects, [])
})
test('actual recipe with unconfirmed inventory leaves both local and backend intent unresolved', async (t) => {
  let f
  const job = { id: 'craft-review', item: 'oak_planks', quantity: 4 }
  f = fixture(t, (w) => crafting.execute(w, job, { storeOutput: false }))
  f.slots[27] = item('oak_log', 2, 27)
  f.bot.craft = async () => {}
  const result = await f.run()
  assert.equal(result.outcome, 'failed')
  assert.equal(f.saved().operations[0].status, 'uncertain')
  assert.equal(
    f.calls.some((c) => c.name === 'finish_craft'),
    false,
  )
  assert.deepEqual(result.confirmedEffects, [])
  assert.equal(result.outstandingOperationIds.length, 1)
})
test('craft status refresh cannot hide a critical local intent failure', async (t) => {
  let f,
    lists = 0,
    packets = 0
  f = fixture(t, (w) =>
    crafting.execute(
      w,
      { id: 'craft-review', item: 'oak_planks', quantity: 4 },
      { storeOutput: false },
    ),
  )
  f.slots[27] = item('oak_log', 2, 27)
  f.bot.craft = async () => {
    packets++
  }
  const call = f.agent.colony.call.bind(f.agent.colony)
  t.mock.method(f.agent.colony, 'call', (actor, action, data) => {
    if (action === 'list' && ++lists === 2) throw new Error('refresh failed')
    return call(actor, action, data)
  })
  t.mock.method(f.agent.runtime, 'saveOperation', () => {
    throw Object.assign(new Error('intent disk failed'), {
      code: 'CHECKPOINT_WRITE_FAILED',
      fatal: true,
    })
  })
  const result = await f.run()
  assert.equal(result.reasonCode, 'CHECKPOINT_WRITE_FAILED')
  assert.equal(packets, 0)
  assert.equal(
    f.calls.some((call) => call.name === 'begin'),
    false,
  )
})
