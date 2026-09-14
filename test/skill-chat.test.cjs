const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { Agent } = require('../src/agent.cjs')
const { skills } = require('../src/skills.cjs')
const { parseControl, receiveControl } = require('../src/skill-chat.cjs')
function setup(t, username = 'Jerry') {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-skill-chat-'))
  const agent = new Agent({ dataDir, username })
  const sent = []
  agent.bot = { game: { gameMode: 'survival' }, pathfinder: { setGoal() {} }, clearControlStates() {},
    chat: text => sent.push(text), whisper: (name, text) => sent.push(`${name}: ${text}`) }
  agent.state.connection = 'ready'
  t.after(() => { agent.stop(false); fs.rmSync(dataDir, { recursive: true, force: true }) })
  return { agent, sent }
}
test('skill controls cover every registered skill and common start/switch phrasing', () => {
  for (const skill of skills) {
    for (const verb of ['start', 'switch to', 'turn on', 'change skill to'])
      assert.deepEqual(parseControl(`${verb} ${skill.label}!`), { type: 'controlSkill', skill: skill.type })
  }
  assert.equal(parseControl('what are you doing?'), null)
  assert.equal(parseControl('please start').type, 'startSkill')
})
test('Minecraft controls require an addressed player message or whisper, with no LLM key', t => {
  const { agent, sent } = setup(t)
  const commands = []
  agent.startWork = c => commands.push(c)
  assert.equal(receiveControl(agent, agent.bot, 'Player', 'start farmer'), false)
  assert.equal(receiveControl(agent, agent.bot, 'Player', 'Marc, start farmer'), false)
  assert.equal(receiveControl(agent, {}, 'Player', 'Jerry, start farmer'), false)
  agent.fleet = { marc: { username: 'Marc' }, jerry: agent }
  assert.equal(receiveControl(agent, agent.bot, 'Marc', 'Jerry, start farmer'), false)
  assert.equal(receiveControl(agent, agent.bot, 'Player', 'Jerry, start farmer'), true)
  assert.equal(commands[0].type, 'wheatFarm')
  receiveControl(agent, agent.bot, 'Player', 'turn on', true)
  assert.equal(commands[1].type, 'wheatFarm')
  assert.match(sent[0], /Started FARMER/)
  assert.equal(receiveControl(agent, agent.bot, 'Player', 'Jerry, what are you doing?'), false)
})
test('switch waits for old work to settle and starts only the latest requested skill', async t => {
  const { agent } = setup(t)
  const skill = skills.find(s => s.type === 'treeFarm'), factory = skill.factory
  let finish, cancelled = false
  skill.factory = () => ({ cancel() { cancelled = true }, run: () => new Promise(r => { finish = r }) })
  t.after(() => { skill.factory = factory })
  agent.command('start tree farmer')
  const started = []
  agent.startWork = c => started.push(c)
  agent.command('switch to farmer')
  assert.equal(cancelled, true)
  assert.equal(started.length, 0)
  agent.command('switch to practice movement')
  finish()
  await new Promise(setImmediate)
  assert.deepEqual(started, [{ type: 'practiceMovement' }])
})
test('stop and disconnect discard pending switches; rejected skills leave current work alone', t => {
  const { agent } = setup(t)
  let cancelled = 0
  agent.activeWork = { cancel() { cancelled++ } }
  agent.bot.game.gameMode = 'creative'
  assert.throws(() => agent.command('switch to farmer'), /Survival/)
  assert.equal(cancelled, 0)
  agent.bot.game.gameMode = 'survival'
  agent.command('switch to farmer')
  agent.command('stop')
  assert.equal(agent.pendingSkill, null)
  agent.command('switch to farmer')
  agent.disconnect()
  assert.equal(agent.pendingSkill, null)
})
test('web chat routes to the named agent and bare start uses its default skill', t => {
  const { agent: marc } = setup(t, 'Marc')
  const { agent: jerry } = setup(t, 'Jerry')
  marc.fleet = jerry.fleet = { marc, jerry }
  let command
  jerry.startWork = c => { command = c }
  marc.command('Jerry, turn on')
  assert.deepEqual(command, { type: 'treeFarm' })
  assert.equal(marc.lastSkill, undefined)
})
