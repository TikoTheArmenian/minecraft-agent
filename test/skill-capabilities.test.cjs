const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { fixture, Vec3 } = require('./helpers/survival-fixture.cjs')
const { Survival } = require('../src/skills/survival.cjs')
const { ResourceWork } = require('../src/capabilities/resources.cjs')
const { restockLocal } = require('../src/capabilities/local-supplies.cjs')
const { WheatFarm } = require('../src/skills/wheat-farm.cjs')
const { TreeFarm } = require('../src/skills/tree-farm.cjs')
const { OreFinder } = require('../src/skills/ore-finder.cjs')
const { SugarcaneFarm } = require('../src/skills/sugarcane-farm.cjs')
const { MobKiller } = require('../src/skills/mob-killer.cjs')
const { Terraformer } = require('../src/skills/terraformer.cjs')
const { TorchSkill } = require('../src/skills/torches.cjs')

test('resource skills never construct or mutate the runnable starter workflow', () => {
  for (const Skill of [WheatFarm, TreeFarm, OreFinder, SugarcaneFarm, MobKiller, Terraformer, TorchSkill]) {
    const h = fixture()
    const saved = { status: 'complete', observations: 'old starter run' }
    Object.defineProperty(h.agent.state, 'survival', {
      get: () => saved,
      set: () => { assert.fail(`${Skill.name} must not publish temporary starter state`) },
    })
    const work = new Skill(h.agent, 1)
    assert.ok(work instanceof ResourceWork)
    assert.equal(work instanceof Survival, false)
    assert.equal(h.agent.state.survival, saved)
    assert.notEqual(work.plan, saved)
    h.agent.username = 'CustomBot'
    h.bot.health = 3
    assert.match(work.safety(), /CustomBot/)
  }
})

test('crop expansion propagates a handoff without recording it as a resource blocker', async () => {
  const h = fixture()
  const work = new ResourceWork(h.agent, 1)
  const signal = Object.assign(new Error('yield'), { code: 'HANDOFF' })
  await assert.rejects(work.attempt('Expand', async () => { throw signal }), (error) => error === signal)
  assert.equal(work.plan.blocker, undefined)
  assert.deepEqual(work.issues, [])
})

test('local supply adapter uses the work owner and retains empty-chest cooldowns', async () => {
  const h = fixture()
  const chest = h.set('chest', new Vec3(1, 64, 0))
  let opened = 0, closed = 0
  h.bot.openContainer = async () => {
    opened++
    return { containerItems: () => [], close: () => { closed++ } }
  }
  // These are Work ports; there is no Survival plan, count, find, decide or attempt method.
  const work = {
    bot: h.bot, agent: h.agent, counts: {}, check() {}, sync() {}, progress() {},
    approach: async (position) => assert.ok(position.equals(chest.position)),
    timed: async (operation) => operation(),
  }
  await restockLocal(work, ['dirt'], 128, 8, 'building blocks')
  await restockLocal(work, ['dirt'], 128, 8, 'building blocks')
  assert.equal(opened, 1)
  assert.equal(closed, 1)
  assert.equal(work.localSupplyState.checks.size, 1)
  assert.deepEqual(work.localSupplyState.plan.chestContents[chest.position.toString()].items, [])
  assert.equal(work.plan, undefined)
})

function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-skill-checkpoint-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('corrupt or unsupported tree and terrain jobs are preserved and refuse restart', (t) => {
  for (const [Skill, filename] of [[TreeFarm, 'tree-jobs.json'], [Terraformer, 'terraform-jobs.json']]) {
    const dir = temporary(t)
    const file = path.join(dir, filename)
    for (const text of ['{broken', '{"version":99,"data":{}}', '{"world:overworld":{"area":null}}']) {
      fs.writeFileSync(file, text)
      const h = fixture()
      h.agent.dataDir = dir
      assert.throws(() => new Skill(h.agent, 1), (error) => error.code === 'CHECKPOINT_CORRUPT' && error.fatal)
      assert.equal(fs.readFileSync(file, 'utf8'), text)
    }
  }
})

test('valid legacy jobs remain resumable and upgrade to versioned checkpoints on save', (t) => {
  const cases = [
    [TreeFarm, 'tree-jobs.json', {
      species: 'oak', logs: [{ x: 0, y: 64, z: 0 }], roots: [{ x: 0, y: 64, z: 0 }],
      planted: [], removed: 0, scaffolds: [],
    }],
    [Terraformer, 'terraform-jobs.json', {
      area: { min: { x: 0, z: 0 }, max: { x: 1, z: 1 }, y: 63 },
      done: [], cut: 1, filled: 0, status: 'partial',
    }],
  ]
  for (const [Skill, filename, job] of cases) {
    const dir = temporary(t), file = path.join(dir, filename), h = fixture()
    Object.assign(h.agent, { dataDir: dir })
    Object.assign(h.agent.state, { world: 'Test', dimension: 'overworld' })
    fs.writeFileSync(file, JSON.stringify({ 'Test:overworld': job }))
    const work = new Skill(h.agent, 1)
    if (Skill === TreeFarm) assert.ok(work.job.logs[0] instanceof Vec3)
    else assert.deepEqual(work.jobs['Test:overworld'], job)
    work.saveJob()
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.equal(saved.version, 1)
    assert.deepEqual(saved.data['Test:overworld'], job)
  }
})

test('skill runners report cooperative yield as HANDOFF, not blocked work', async () => {
  for (const Skill of [WheatFarm, TreeFarm, OreFinder, SugarcaneFarm, MobKiller, Terraformer, TorchSkill, Survival]) {
    const h = fixture(), work = new Skill(h.agent, 1)
    work.pause = async () => work.check()
    if (Skill === MobKiller) {
      work.storeBatch = async () => {}
      work.hostilesNearPost = () => false
      work.selectTarget = () => null
    }
    work.requestHandoff()
    await work.run()
    assert.equal(work.task.status, 'cancelled', Skill.name)
    assert.equal(work.task.reasonCode, 'HANDOFF', Skill.name)
    assert.equal(h.dug.length, 0, Skill.name)
    assert.equal(h.crafted.length, 0, Skill.name)
  }
})

test('tree handoff recovers supports and saves obligations before releasing ownership', async () => {
  const h = fixture(), work = new TreeFarm(h.agent, 1), events = []
  work.job = { roots: [new Vec3(0, 64, 0)], scaffolds: [{ x: 0, y: 64, z: 0, name: 'dirt' }] }
  work.descendCanopy = async () => events.push('descend')
  work.recoverScaffolds = async () => { events.push('recover'); work.job.scaffolds = [] }
  work.saveJob = () => events.push('save')
  work.settleStance = async () => events.push('stable')
  // No requested handoff: the production loop does not repeatedly descend.
  await work.handoffCheckpoint()
  assert.deepEqual(events, [])
  work.requestHandoff()
  await assert.rejects(work.handoffCheckpoint(), (error) => error.code === 'HANDOFF')
  assert.deepEqual(events, ['descend', 'recover', 'save', 'stable'])
  assert.equal(work.task.checkpoint.data.unfinishedTree, true)
})

test('tree refuses to hand off when support recovery fails; emergency Stop still cancels', async () => {
  const h = fixture(), work = new TreeFarm(h.agent, 1)
  work.job = { scaffolds: [{}] }
  work.descendCanopy = async () => {}
  work.recoverScaffolds = async () => { throw new Error('Support changed') }
  work.requestHandoff()
  await assert.rejects(work.handoffCheckpoint(), /Support changed/)
  assert.equal(work.task.reasonCode, undefined)
  assert.equal(work.cancelled(), false)
  work.cancel()
  assert.equal(work.cancelled(), true)
})

test('yielding between tree logs preserves the remaining harvest and replanting job', async () => {
  const h = fixture(), work = new TreeFarm(h.agent, 1)
  const root = new Vec3(0, 64, 0)
  h.set('oak_log', root)
  h.set('oak_log', root.offset(0, 1, 0))
  h.add('oak_sapling')
  work.job = { species: 'oak', roots: [root], logs: [root, root.offset(0, 1, 0)], removed: 0, planted: [] }
  h.agent.treeJobs.set(work.jobKey, work.job)
  work.reachLog = async () => {}
  const dig = work.dig.bind(work)
  work.dig = async (...args) => { await dig(...args); work.requestHandoff() }
  await assert.rejects(work.harvestTree(), (error) => error.code === 'HANDOFF')
  assert.deepEqual(h.dug, ['oak_log'])
  assert.equal(work.job.removed, 1)
  assert.deepEqual(work.job.planted, [])
  assert.equal(work.plan.trees, 0)
  assert.equal(h.agent.treeJobs.get(work.jobKey), work.job)
  assert.equal(h.bot.blockAt(root.offset(0, 1, 0)).name, 'oak_log')
})
