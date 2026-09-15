const { test } = require('node:test')
const assert = require('node:assert/strict')
const { goals } = require('mineflayer-pathfinder')
const { Travel } = require('../src/navigation/travel.cjs')
const { fixture, Vec3 } = require('./helpers/travel-fixture.cjs')

function telemetryFixture() {
  const f = fixture()
  const snapshots = [],
    events = []
  f.agent.emit = (type, payload) => events.push({ type, payload })
  f.agent.publish = () => snapshots.push(JSON.parse(JSON.stringify(f.agent.state.task.travel)))
  f.agent.log = (event, message, level, details) => {
    f.logs.push({ event, message, level, details })
    f.agent.publish()
  }
  return { ...f, snapshots, events }
}

for (const status of ['succeeded', 'failed', 'cancelled']) {
  test(`route snapshots survive path mutation, resets and ${status} cleanup`, async () => {
    const { bot, work, snapshots, events } = telemetryFixture()
    const travel = new Travel(work)
    const result = {
      status: 'success',
      path: [new Vec3(-3, 66, 0), new Vec3(-4, 66, 0)],
      visitedNodes: 14,
      generatedNodes: 20,
      cost: 3,
      time: 2.5,
    }
    result.context = { result } // The real A* context contains cycles and live bot references.
    const expected = result.path.map((p) => ({ x: p.x, y: p.y, z: p.z }))
    bot.pathfinder.searchRadius = 37
    travel.walk = async () => {
      bot.emit('path_update', result)
      assert.deepEqual(snapshots.at(-1).route.path, expected)
      result.path[0].x = 100
      result.path.shift()
      result.visitedNodes = 100
      bot.emit('path_reset', 'goal_updated')
      if (status === 'cancelled') work.cancel()
      if (status !== 'succeeded') throw new Error('Route interrupted')
    }
    const run = travel.go(new goals.GoalBlock(-4, 66, 0))
    if (status === 'succeeded') await run
    else await assert.rejects(run, /Route interrupted|Cancelled/)
    const saved = JSON.parse(JSON.stringify(work.task.travel))
    assert.equal(saved.status, status)
    assert.deepEqual(saved.route.path, expected)
    assert.deepEqual(saved.route.search, {
      status: 'success',
      searchRadius: 37,
      visitedNodes: 14,
      generatedNodes: 20,
      cost: 3,
      time: 2.5,
      updatedAt: saved.route.search.updatedAt,
      source: 'walking',
    })
    assert.ok(Number.isFinite(saved.route.search.updatedAt))
    assert.equal(bot.listenerCount('path_update'), 0)
    assert.equal(bot.listenerCount('path_reset'), 0)
    bot.emit('path_update', { status: 'noPath', path: [] })
    assert.deepEqual(work.task.travel.route.path, expected)
    assert.deepEqual(snapshots.at(-1), saved)
    const routeEvents = events.filter((e) => e.type === 'travel.route')
    assert.equal(routeEvents.at(-1).payload.status, status)
    assert.equal(routeEvents.at(-1).payload.taskId, work.id)
    assert.deepEqual(routeEvents.at(-1).payload.route, saved.route)
    assert.equal(routeEvents.find((e) => e.payload.route.search).payload.status, 'running')
  })
}

test('partial search snapshots update state without flooding publications, including moving goals', async () => {
  const { bot, work, snapshots } = telemetryFixture()
  const travel = new Travel(work)
  const entity = { position: new Vec3(-4, 66, 0) }
  travel.walk = async () => {
    const before = snapshots.length
    for (let i = 0; i < 20; i++) {
      entity.position.x = -4 - i
      bot.emit('path_update', { status: 'partial', path: [], visitedNodes: i })
    }
    assert.equal(snapshots.length, before + 1)
    assert.equal(work.task.travel.route.search.visitedNodes, 19)
    assert.equal(work.task.travel.destination.x, -23)
    bot.emit('path_update', { status: 'noPath', path: [], visitedNodes: 20 })
    assert.equal(snapshots.length, before + 2)
    assert.equal(snapshots.at(-1).route.search.status, 'noPath')
    assert.equal(snapshots.at(-1).route.search.searchRadius, -1)
    assert.equal(snapshots.at(-1).route.search.cost, null)
  }
  await travel.go(new goals.GoalFollow(entity, 1))
})

for (const optional of [false, true]) {
  test(`preview searches publish the actual radius (${optional ? 12 : 64}) without replacing the walking route`, async () => {
    const { bot, work, snapshots, events } = telemetryFixture()
    const travel = new Travel(work, 60000, { optional })
    const goal = new goals.GoalBlock(-4, 66, 0)
    let radius
    bot.pathfinder.getPathFromTo = function* (_moves, _start, _goal, options) {
      radius = options.searchRadius
      yield { result: { status: 'partial', path: [], visitedNodes: 10 } }
      yield { result: { status: 'success', path: [new Vec3(8, 64, 0)], visitedNodes: 27 } }
    }
    travel.walk = async () => {
      bot.emit('path_update', { status: 'timeout', path: [new Vec3(-3, 66, 0)], visitedNodes: 7 })
      const before = events.length
      await travel.path(bot.pathfinder.movements, bot.entity.position, goal)
      assert.equal(events.length, before, 'speculative paths do not emit travel.route')
    }
    await travel.go(goal)
    assert.equal(radius, optional ? 12 : 64)
    const saved = snapshots.at(-1)
    assert.deepEqual(saved.route.path, [{ x: -3, y: 66, z: 0 }])
    assert.equal(saved.route.search.visitedNodes, 7)
    assert.equal(saved.search.source, 'preview')
    assert.equal(saved.search.searchRadius, radius)
    assert.equal(saved.search.visitedNodes, 27)
  })
}

test('reliable goto publishes a selected endpoint before walking it and retains the completed segment', async () => {
  const { bot, work, snapshots } = telemetryFixture()
  const travel = new Travel(work)
  const goal = new goals.GoalBlock(-5, 66, 0)
  bot.removeAllListeners('physicsTick')
  travel.walk = (g) => travel.segments(g)
  const run = travel.go(goal)
  await new Promise(setImmediate)
  bot.emit('path_update', { status: 'timeout', path: [new Vec3(-4, 66, 0)], visitedNodes: 30 })
  const selected = snapshots.at(-1).route
  assert.deepEqual(selected.partialEndpoint, { x: -4, y: 66, z: 0 })
  assert.equal(selected.segments.length, 1)
  assert.equal(selected.segments[0].reachedAt, null)
  bot.emit('path_update', { status: 'timeout', path: [new Vec3(-4, 66, 0)], visitedNodes: 31 })
  assert.deepEqual(snapshots.at(-1).route.partialEndpoint, selected.partialEndpoint)
  assert.equal(snapshots.at(-1).route.segments.length, 1)
  bot.entity.position = new Vec3(-3.5, 66, 0.5)
  const replanned = new Promise((resolve) => {
    const changed = (current) => {
      if (current !== goal) return
      bot.off('goal_updated', changed)
      resolve()
    }
    bot.on('goal_updated', changed)
  })
  bot.emit('physicsTick')
  await replanned
  assert.equal(bot.pathfinder.goal, goal)
  bot.emit('path_update', { status: 'success', path: [new Vec3(-5, 66, 0)], visitedNodes: 2 })
  bot.emit('goal_reached', goal)
  await run
  const saved = snapshots.at(-1)
  assert.equal(saved.route.partialEndpoint, null)
  assert.equal(saved.route.segments.length, 1)
  assert.ok(saved.route.segments[0].reachedAt >= saved.route.segments[0].plannedAt)
  assert.equal(selected.segments[0].reachedAt, null, 'published snapshots remain independent')
  assert.equal(saved.events[0].reason, 'partial_route')
  assert.equal(saved.destination.x, -5)
  assert.equal(bot.listenerCount('goal_reached'), 0)
})

test('unfollowed segment endpoints are retained and marked reached after the intermediate walk', async () => {
  const { bot, work, logs } = telemetryFixture()
  const travel = new Travel(work),
    goal = new goals.GoalBlock(8, 64, 0)
  const endpoint = new Vec3(2, 63, 0)
  let calls = 0
  bot.pathfinder.goto = async () => {
    if (++calls === 1) throw Object.assign(new Error('segment'), { name: 'PartialRoute', endpoint })
    if (calls === 2) assert.equal(travel.activity.route.segments[0].reachedAt, null)
  }
  await travel.segments(goal)
  endpoint.x = 99
  assert.equal(calls, 3)
  assert.deepEqual(travel.activity.route.segments[0].endpoint, { x: 2, y: 63, z: 0 })
  assert.ok(travel.activity.route.segments[0].reachedAt)
  const retry = logs.find((l) => l.event === 'travel.retry')
  assert.equal(retry.details.taskId, work.id)
  assert.equal(retry.details.reason, 'partial_route')
})

test('automatic stuck resets publish bounded structured stall and retry history', async () => {
  const { bot, work, snapshots, logs, events } = telemetryFixture()
  const travel = new Travel(work)
  travel.walk = async (goal) => {
    bot.pathfinder.setGoal(goal)
    bot.emit('path_update', { status: 'success', path: [new Vec3(-4, 66, 0)] })
    for (let i = 0; i < 70; i++) bot.emit('path_reset', 'stuck')
    bot.emit('path_reset', 'block_updated')
  }
  await travel.go(new goals.GoalBlock(-4, 66, 0))
  const saved = snapshots.at(-1)
  assert.equal(saved.events.length, 128)
  assert.equal(logs.filter((l) => l.event === 'travel.stall').length, 70)
  assert.equal(logs.filter((l) => l.event === 'travel.retry').length, 71)
  assert.equal(events.filter((e) => e.type === 'travel.stall').length, 70)
  assert.equal(events.filter((e) => e.type === 'travel.retry').length, 71)
  assert.equal(saved.events.at(-1).reason, 'block_updated')
  assert.equal(saved.events.at(-1).source, 'pathfinder')
  assert.deepEqual(saved.route.path, [{ x: -4, y: 66, z: 0 }])
})

for (const confirmed of [true, false]) {
  test(`travel.placed is emitted only after server confirmation (${confirmed})`, async () => {
    const { bot, work, changes, make, events } = telemetryFixture()
    bot.entity.position = new Vec3(3.5, 62, 0.5)
    const step = { pos: new Vec3(4, 62, 0), ref: new Vec3(5, 62, 0), face: new Vec3(-1, 0, 0) }
    if (!confirmed) {
      bot._placeBlockWithOptions = async () => changes.set('4,62,0', make('cobblestone', step.pos))
      const timed = work.timed.bind(work)
      work.timed = (fn, ms, label) => timed(fn, label.startsWith('Confirm shore') ? 20 : ms, label)
    }
    const run = new Travel(work).place(step)
    if (confirmed) await run
    else await assert.rejects(run, /timed out/)
    const placements = events.filter((e) => e.type === 'travel.placed')
    assert.equal(placements.length, confirmed ? 1 : 0)
    if (confirmed)
      assert.deepEqual(placements[0].payload, {
        taskId: work.id,
        runId: null,
        position: { x: 4, y: 62, z: 0 },
        block: 'cobblestone',
        blocksPlaced: 1,
      })
  })
}
