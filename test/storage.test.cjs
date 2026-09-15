const test = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const registry = require('minecraft-data')('1.21.1')
const Item = require('prismarine-item')(registry)
const Recipe = require('prismarine-recipe')(registry).Recipe
const { describe, plain, reserve } = require('../src/storage/policy.cjs')
const { identity, transfer, withChest } = require('../src/storage/service.cjs')
const { planRecipes, stocks } = require('../src/storage/crafting.cjs')
const { Colony } = require('../src/storage/colony.cjs')
const { parse } = require('../src/agents/agent.cjs')
const bot = { registry, recipesAll: (id) => Recipe.find(id, null) }
const item = (name, count = 1, slot = 0) =>
  Object.assign(new Item(registry.itemsByName[name].id, count), { slot })
test('chest halves normalize for all facings; unloaded halves are rejected', () => {
  const directions = {
    north: [1, 0],
    south: [-1, 0],
    east: [0, 1],
    west: [0, -1],
  }
  for (const [facing, [dx, dz]] of Object.entries(directions)) {
    const left = {
      name: 'chest',
      position: new Vec3(0, 64, 0),
      getProperties: () => ({ type: 'left', facing }),
    }
    const right = {
      name: 'chest',
      position: new Vec3(dx, 64, dz),
      getProperties: () => ({ type: 'right', facing }),
    }
    const b = {
      blockAt: (p) =>
        p.equals(left.position)
          ? left
          : p.equals(right.position)
            ? right
            : null,
    }
    assert.equal(identity(b, left).container, identity(b, right).container)
    assert.equal(identity(b, left).capacity, 54)
    assert.throws(() => identity({ blockAt: () => null }, left), /unloaded/)
  }
})
test('fingerprints preserve components and removed components; equipment has real stack limits', () => {
  const a = item('diamond_pickaxe'),
    b = item('diamond_pickaxe')
  assert.equal(describe(a).stackSize, 1)
  assert.equal(plain(a), true)
  b.components = [
    { type: 'enchantments', data: { levels: [{ id: 1, level: 4 }] } },
  ]
  assert.notEqual(describe(a).fingerprint, describe(b).fingerprint)
  assert.equal(plain(b), false)
  b.components = []
  b.removedComponents = [1]
  assert.notEqual(describe(a).fingerprint, describe(b).fingerprint)
  assert.equal(plain(b), false)
  const w = { bot: { registry }, job: { roots: Array(12) } }
  assert.equal(reserve(item('oak_sapling'), w), 12)
  assert.equal(reserve(a, w), Infinity)
})
test('planner uses shared logs for a bounded full tool chain and rounds recipe batches', () => {
  const p = planRecipes(bot, 'wooden_pickaxe', 2, {}, { oak_log: 4 }, true)
  assert.deepEqual(p.withdrawals, { oak_log: 3 })
  assert.equal(
    p.steps
      .filter((s) => s.name === 'wooden_pickaxe')
      .reduce((n, s) => n + s.times, 0),
    2,
  )
  assert.equal(p.steps[0].name, 'oak_planks')
  assert(p.steps.some((s) => s.name === 'crafting_table'))
  const torches = planRecipes(bot, 'torch', 5, { coal: 2, stick: 2 }, {})
  assert.equal(torches.steps[0].times, 2)
  assert.throws(
    () => planRecipes(bot, 'stone_pickaxe', 1, {}, {}),
    /Missing materials/,
  )
  assert.throws(() => planRecipes(bot, 'diamond_block', 1, {}, {}), /supported/)
})
test('stock planning ignores stale/unmanaged/modified stock and subtracts reservations once', () => {
  const i = item('oak_log', 10),
    fp = describe(i).fingerprint
  const w = {
    bot: {
      registry,
      inventory: {
        items: () => [item('cobblestone', 64), item('cobblestone', 64)],
      },
      entity: { position: new Vec3(0, 64, 0) },
    },
    origin: new Vec3(0, 64, 0),
  }
  const chest = {
    id: 'a',
    position: { x: 0, y: 64, z: 0 },
    managed: true,
    checked_at: new Date().toISOString(),
    slots: [describe(i)],
  }
  const s = stocks(w, {
    containers: [
      chest,
      { ...chest, id: 'old', checked_at: '2000-01-01' },
      { ...chest, id: 'unmanaged', managed: false },
    ],
    reservations: [{ container: 'a', fingerprint: fp, quantity: 4 }],
  })
  assert.equal(s.shared.oak_log, 6)
  assert.equal(s.carry.cobblestone, 0)
})
function transferFixture(kind = 'deposit') {
  const slots = Array(63).fill(null),
    source = item('oak_log', 8, kind === 'deposit' ? 27 : 0)
  slots[source.slot] = source
  const window = {
    slots,
    inventoryStart: 27,
    inventoryEnd: 63,
    containerItems: () => slots.slice(0, 27).filter(Boolean),
    selectedItem: null,
  }
  const calls = []
  const w = {
    counts: {},
    check() {},
    sync() {},
    agent: { refresh() {} },
    bot: {
      registry,
      inventory: { items: () => slots.slice(27).filter(Boolean) },
      async transfer(o) {
        assert.equal(o.sourceEnd, o.sourceStart + 1)
        assert.equal(o.destEnd, o.destStart + 1)
        const src = slots[o.sourceStart],
          dest = slots[o.destStart]
        if (dest) dest.count += o.count
        else slots[o.destStart] = item(src.name, o.count, o.destStart)
        src.count -= o.count
        if (!src.count) slots[o.sourceStart] = null
      },
    },
    timed: async (f) => f(),
  }
  const ctx = {
    window,
    reopen: async () => window,
    db: async (a, p) => calls.push([a, p]),
  }
  return { w, ctx, calls, fp: describe(source).fingerprint, slots }
}
test('transfers journal before mutation and save confirmed absolute stock afterward', async () => {
  const { w, ctx, calls, fp } = transferFixture()
  const count = await transfer(w, ctx, 'deposit', fp, 5)
  assert.equal(count, 5)
  assert.deepEqual(
    calls.map((c) => c[0]),
    ['renew', 'begin', 'finish'],
  )
  assert.equal(calls[2][1].slots[0].count, 5)
})
test('partial mutation leaves pending intent and never publishes an invented snapshot', async () => {
  const { w, ctx, calls, fp } = transferFixture()
  w.bot.transfer = async () => {}
  await assert.rejects(transfer(w, ctx, 'deposit', fp, 5), /uncertain/)
  assert.deepEqual(
    calls.map((c) => c[0]),
    ['renew', 'begin'],
  )
})
test('lease failure and cancellation after intent never send Minecraft input', async () => {
  for (const abortAfter of ['renew', 'begin']) {
    const { w, ctx, calls, fp } = transferFixture()
    let cancelled = false,
      inputs = 0
    w.check = () => {
      if (cancelled) throw new Error('Cancelled')
    }
    w.bot.transfer = async () => inputs++
    ctx.db = async (a) => {
      calls.push(a)
      if (a === abortAfter) cancelled = true
    }
    await assert.rejects(transfer(w, ctx, 'deposit', fp, 5), /Cancelled/)
    assert.equal(inputs, 0)
    assert(!calls.includes('finish'))
  }
})
test('transport scopes requests and keeps credentials out of errors; no automatic retries', async () => {
  const actor = {
    username: 'Marc',
    state: { world: 'one', dimension: 'overworld' },
  }
  let count = 0
  const c = new Colony({
    url: 'https://example.invalid',
    key: 'secret',
    worlds: { one: '11111111-1111-4111-8111-111111111111' },
    fetchImpl: async (url, opts) => {
      count++
      const request = JSON.parse(opts.body)
      assert.equal(request.p_label, 'one')
      return {
        ok: false,
        json: async () => ({ message: 'secret infrastructure detail' }),
      }
    },
  })
  await assert.rejects(c.call(actor, 'list'), /configuration and migrations/)
  assert.equal(count, 1)
  assert.equal(
    c.scope({ ...actor, state: { world: 'two', dimension: 'overworld' } })
      .label,
    'two',
  )
})
test('storage command bounds are enforced and old aliases stay intact', () => {
  assert.equal(parse('storage and crafting').action, 'maintain')
  assert.equal(parse('create storage wood').category, 'wood')
  assert.throws(() => parse('create storage lava'))
  assert.equal(parse('craft stone_pickaxe 2').quantity, 2)
  assert.equal(parse('manage storage 0 64 -2 tools').category, 'tools')
  assert.throws(() => parse('craft stone_pickaxe 1000'))
  assert.throws(() => parse('manage storage 0 64 0 lava'))
  assert.equal(parse('farm wheat forever').type, 'wheatFarm')
})
test('craft execution retrieves shared logs, reserves ingredients, confirms recipes and stores output', async () => {
  const { execute } = require('../src/storage/crafting.cjs')
  const inventory = [],
    chestSlots = Array(27).fill(null)
  chestSlots[0] = item('oak_log', 8, 0)
  const position = new Vec3(1, 64, 0),
    table = { name: 'crafting_table', position: new Vec3(3, 64, 0) }
  const chest = {
    name: 'chest',
    position,
    getProperties: () => ({ type: 'single', facing: 'north' }),
  }
  const record = {
    id: '1,64,0',
    position: { ...position },
    blocks: [{ ...position }],
    managed: true,
    category: 'overflow',
    capacity: 27,
    checked_at: new Date().toISOString(),
    slots: [describe(chestSlots[0])],
  }
  const calls = [],
    job = {
      id: require('node:crypto').randomUUID(),
      item: 'wooden_pickaxe',
      quantity: 2,
    }
  let window = null
  function add(name, amount) {
    let i = inventory.find((i) => i.name === name)
    if (!i && amount > 0) {
      i = item(name, 0, 27 + inventory.length)
      inventory.push(i)
    }
    if (i) i.count += amount
  }
  const b = {
    registry,
    entity: { position: new Vec3(0, 64, 0) },
    inventory: {
      items: () => inventory.filter((i) => i.count > 0),
      emptySlotCount: () => 20,
    },
    recipesAll: (id) => Recipe.find(id, null),
    findBlocks: () => [table.position],
    blockAt: (p) =>
      p.equals(position) ? chest : p.equals(table.position) ? table : null,
    async openContainer() {
      const slots = Array(63).fill(null)
      chestSlots.forEach((i, n) => (slots[n] = i))
      inventory
        .filter((i) => i.count > 0)
        .forEach((i, n) => {
          i.slot = 27 + n
          slots[i.slot] = i
        })
      window = {
        slots,
        inventoryStart: 27,
        inventoryEnd: 63,
        containerItems: () => slots.slice(0, 27).filter(Boolean),
        close() {
          for (let n = 0; n < 27; n++) chestSlots[n] = slots[n]
        },
        selectedItem: null,
      }
      return window
    },
    async transfer(o) {
      const src = window.slots[o.sourceStart],
        name = src.name
      if (o.sourceStart < 27) {
        src.count -= o.count
        if (!src.count) window.slots[o.sourceStart] = null
        add(name, o.count)
        const dest = inventory.find((i) => i.name === name && i.count > 0)
        dest.slot = o.destStart
        window.slots[o.destStart] = dest
      } else {
        src.count -= o.count
        if (!src.count) window.slots[o.sourceStart] = null
        if (window.slots[o.destStart])
          window.slots[o.destStart].count += o.count
        else window.slots[o.destStart] = item(name, o.count, o.destStart)
      }
    },
    async craft(recipe) {
      for (const d of recipe.delta) add(registry.items[d.id].name, d.count)
    },
  }
  const agent = {
    username: 'Marc',
    state: { world: 'one', dimension: 'overworld' },
    publish() {},
    refresh() {},
    colony: {
      scope: () => ({ session: 'test' }),
      async call(actor, action, data) {
        calls.push([action, data])
        if (action === 'list')
          return {
            containers: [record],
            reservations: [],
            jobs: [job],
            uncertain: [],
          }
        if (action === 'acquire') return record
        if (action === 'snapshot' || action === 'finish')
          record.slots = data.slots
        return {}
      },
    },
  }
  const w = {
    bot: b,
    agent,
    counts: {},
    origin: b.entity.position.clone(),
    check() {},
    cancelled: () => false,
    sync() {},
    approach: async () => {},
    timed: async (f) => f(),
  }
  await execute(w, job)
  assert.equal(
    record.slots
      .filter((i) => i.name === 'wooden_pickaxe')
      .reduce((n, i) => n + i.count, 0),
    2,
  )
  assert(calls.some(([a, p]) => a === 'reserve' && p.items[0].quantity === 2))
  assert.equal(calls.filter(([a]) => a === 'finish_craft').length, 5)
  assert(calls.some(([a, p]) => a === 'job_status' && p.state === 'complete'))
})
test('container cleanup stays scoped to the original world after session changes', async () => {
  const position = new Vec3(1, 64, 0),
    chest = {
      name: 'chest',
      position,
      getProperties: () => ({ type: 'single', facing: 'north' }),
    }
  const calls = [],
    agent = {
      username: 'Marc',
      state: { world: 'original', dimension: 'overworld' },
      colonySession: 'one',
      colony: {
        scope: (a) => ({ session: a.colonySession }),
        async call(actor, action) {
          calls.push([actor.state.world, actor.colonySession, action])
          return { managed: true }
        },
      },
    }
  const w = {
    agent,
    origin: new Vec3(0, 64, 0),
    bot: {
      entity: { position: new Vec3(0, 64, 0) },
      blockAt: () => chest,
      openContainer: async () => ({
        inventoryStart: 27,
        slots: [],
        close() {},
      }),
    },
    check() {},
    cancelled: () => false,
    approach: async () => {},
    timed: async (f) => f(),
  }
  await withChest(w, position, async () => {
    agent.state.world = 'new'
    agent.colonySession = 'two'
  })
  assert.deepEqual(calls.at(-1), ['original', 'one', 'release'])
})
test('storage API validates structured goals and scopes them to the selected bot', async (t) => {
  const { createApp } = require('../src/web/server.cjs')
  const { EventEmitter } = require('node:events')
  const calls = []
  const make = (name) => Object.assign(new EventEmitter(), {
    id: name.toLowerCase(),
    username: name,
    state: { world: 'one', dimension: 'overworld' },
    log() {},
    colony: {
      enabled: true,
      async call(actor, action, payload) {
        calls.push([actor.username, action, payload])
        return action === 'list'
          ? { containers: [], jobs: [], reservations: [], uncertain: [] }
          : {}
      },
    },
  })
  const marc = make('Marc'),
    tree = make('Jerry')
  const server = createApp(marc, { marc, tree }).listen(0, '127.0.0.1')
  await new Promise((r) => server.once('listening', r))
  t.after(() => {
    server.close()
    server.closeAllConnections()
  })
  const url = `http://127.0.0.1:${server.address().port}`
  const post = (body, origin) =>
    fetch(url + '/bots/tree/api/craft-jobs', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(origin ? { Origin: origin } : {}),
      },
      body: JSON.stringify(body),
    })
  assert.equal(
    (await post({ item: 'stone_pickaxe', quantity: 129 })).status,
    400,
  )
  assert.equal(
    (
      await post(
        { item: 'stone_pickaxe', quantity: 2 },
        'https://outside.invalid',
      )
    ).status,
    403,
  )
  const result = await post({ item: 'stone_pickaxe', quantity: 2 })
  assert.equal(result.status, 200)
  assert.equal((await result.json()).status, 'queued')
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], 'Jerry')
  const skills = await (await fetch(url + '/api/skills')).json()
  assert(skills.some((s) => s.type === 'storageCrafting'))
  assert(skills.every((s) => !s.factory))
})

test('world IDs resolve automatically and failures do not poison the cache', async () => {
  let registrations = 0
  const c = new Colony({
    url: 'https://example.invalid',
    key: 'secret',
    worlds: {},
    fetchImpl: async (url, opts) => {
      const body = JSON.parse(opts.body)
      if (url.endsWith('/colony_resolve_world')) {
        registrations++
        assert.equal(body.p_label, 'Shared world')
        if (registrations === 1) throw new Error('offline')
        return {
          ok: true,
          json: async () => '22222222-2222-4222-8222-222222222222',
        }
      }
      assert.equal(body.payload.world, '22222222-2222-4222-8222-222222222222')
      assert.equal(body.payload.dimension, 'overworld')
      return { ok: true, json: async () => ({}) }
    },
  })
  const a = {
    username: 'Marc',
    state: { world: 'Shared world', dimension: 'overworld' },
  }
  await assert.rejects(c.call(a, 'list'), /unavailable/)
  await Promise.all([
    c.call(a, 'list'),
    c.call({ ...a, username: 'Jerry' }, 'list'),
  ])
  assert.equal(registrations, 2)
})
test('storage placement uses the public Mineflayer API and waits for server confirmation', async () => {
  const { place } = require('../src/storage/crafting.cjs')
  const { EventEmitter } = require('node:events')
  const p = new Vec3(0, 63, 0),
    target = p.offset(0, 1, 0),
    client = new EventEmitter()
  let placed = false,
    called = 0
  const b = {
    registry,
    _client: client,
    entity: { position: new Vec3(3, 64, 0) },
    inventory: { items: () => [item('chest')] },
    findBlocks: () => [p],
    blockAt: (q) =>
      q.equals(p)
        ? { name: 'dirt', position: p }
        : q.equals(target) && placed
          ? { name: 'chest', position: target }
          : { name: 'air', position: q },
    async placeBlock(support, face) {
      called++
      assert(support.position.equals(p))
      assert(face.equals(new Vec3(0, 1, 0)))
      placed = true
      client.emit('block_change', {
        location: target,
        type: registry.blocksByName.chest.minStateId,
      })
    },
  }
  const w = {
    bot: b,
    approach: async () => {},
    equip: async () => {},
    timed: async (f) => f(),
  }
  assert.equal((await place(w, 'chest')).name, 'chest')
  assert.equal(called, 1)
  assert.equal(client.listenerCount('block_change'), 0)
})

test('transfer verification uses reopened server contents even when bot.inventory is stale', async () => {
  const { w, ctx, calls, fp } = transferFixture()
  w.bot.inventory.items = () => [item('oak_log', 8, 9)]
  let reopened = 0
  ctx.reopen = async () => {
    reopened++
    return ctx.window
  }
  assert.equal(await transfer(w, ctx, 'deposit', fp, 5), 5)
  assert.equal(reopened, 1)
  assert(calls.some(([a]) => a === 'finish'))
})
test('server rejection after predicted clicks keeps the transfer quarantined', async () => {
  const { w, ctx, calls, fp, slots } = transferFixture()
  ctx.reopen = async () => {
    slots[0] = null
    slots[27] = item('oak_log', 8, 27)
    return ctx.window
  }
  await assert.rejects(transfer(w, ctx, 'deposit', fp, 5), /uncertain/)
  assert(!calls.some(([a]) => a === 'finish'))
})
test('hub destinations exclude remote chests and preserve category preference',()=>{
  const {destinations}=require('../src/storage/steward.cjs')
  const hub={x:0,y:64,z:0}
  const containers=[{id:'remote',managed:true,category:'food',position:{x:25,y:64,z:0}}, {id:'fallback',managed:true,category:'overflow',position:hub}, {id:'food',managed:true,category:'food',position:hub}, {id:'private',managed:false,category:'food',position:hub}]
  assert.deepEqual(destinations(containers,hub,item('wheat'),registry).map(c=>c.id),['food','fallback'])
  assert.deepEqual(destinations(containers,hub,item('iron_axe'),registry).map(c=>c.id),['fallback'])
  assert.equal(parse('storage hub -469 65 1060').action,'hub')
  assert.equal(parse('consolidate storage').action,'consolidate')
  assert.throws(()=>parse('storage hub 0 999 0'))
})
test('sign labels read server block entity text and retain supplied signs',()=>{
  const {signText}=require('../src/storage/steward.cjs')
  assert.equal(signText({entity:{front_text:{messages:['{"text":"Colony storage"}','"Food"','"Shared by all"','"Sam"']}}}),'Colony storage\nFood\nShared by all\nSam')
  assert.equal(reserve(item('cherry_sign'),{bot:{registry}}),32)
})
test('consolidation leaves reserved stock and full destinations untouched',async t=>{
  const storage=require('../src/storage/service.cjs'), steward=require('../src/storage/steward.cjs')
  const wheat=describe(item('wheat',64)), hub={x:0,y:64,z:0}
  const source={id:'source',managed:false,category:'food',position:{x:20,y:64,z:0},slots:[wheat]}
  const destination={id:'dest',managed:true,category:'food',position:hub,capacity:1,slots:[wheat]}
  let reservations=[]
  t.mock.method(storage,'list',async()=>({containers:[source,destination],reservations}))
  t.mock.method(storage,'withChest',()=>assert.fail('Must not withdraw stock without capacity or reservation clearance'))
  const w={origin:new Vec3(0,64,0),bot:{registry}}
  await steward.consolidate(w,hub)
  destination.slots=[]
  reservations=[{container:'source',fingerprint:wheat.fingerprint,quantity:1}]
  await steward.consolidate(w,hub)
})
test('warehouse plans double capacity beyond demand and ignores remote spare space',()=>{
 const{expansionCategory}=require('../src/storage/steward.cjs'),hub={x:0,y:64,z:0}
 const chest=(category,used,capacity=54,x=0)=>({category,managed:true,position:{x,y:64,z:0},capacity,slots:Array(used).fill({})})
 const containers=[chest('food',26,27),chest('food',26,27),chest('overflow',27,27),chest('overflow',0,54,30)]
 assert.equal(expansionCategory(containers,hub),'overflow')
 containers.push(chest('overflow',0));assert.equal(expansionCategory(containers,hub),'food')
 containers.push(chest('food',0),chest('food',0),chest('overflow',0))
 assert.equal(expansionCategory(containers,hub),null)
})
