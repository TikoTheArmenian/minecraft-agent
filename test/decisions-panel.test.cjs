const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')

function panel() {
  const elements = new Map()
  let receive, tick, now = 100000
  const get = (id) => {
    if (!elements.has(id)) elements.set(id, { textContent: '', dataset: {} })
    return elements.get(id)
  }
  class Clock extends Date { static now() { return now } }
  vm.runInNewContext(fs.readFileSync(require.resolve('../public/decisions.js'), 'utf8'), {
    Date: Clock,
    document: { getElementById: get, addEventListener: (_name, fn) => { receive = fn } },
    setInterval: (fn) => { tick = fn },
  })
  return {
    text: (id) => get(`decision-${id}`).textContent,
    update: (state, connected = true) => receive({ detail: { state: { connection: 'ready', ...state }, connected } }),
    age: () => { now += 6000; tick() },
  }
}

test('current action and queued handoff take priority over an older supervisor decision', () => {
  const p = panel()
  p.update({ busy: true, task: { label: 'Gather wood', status: 'running', action: { status: 'running', label: 'Chopping oak' } },
    runtime: { pendingSkillId: 'smelt' }, supervisor: { lastDecision: { status: 'admitted', decision: { kind: 'start', command: { type: 'tree_farm' }, reason: 'Need wood' } } } })
  assert.equal(p.text('current-detail'), 'Chopping oak')
  assert.equal(p.text('next-tag'), 'Queued switch')
  assert.equal(p.text('next-title'), 'smelt')
  p.update({ supervisor: { lastDecision: { status: 'admitted', decision: { kind: 'start', command: { type: 'tree_farm' } } } } })
  assert.equal(p.text('next-title'), 'No next move selected')
})

test('shadow proposals are explicitly non-executing and rejected decisions are not next work', () => {
  const p = panel()
  const decision = { kind: 'switch', command: { type: 'smelt' }, reason: '<script>text only</script>' }
  p.update({ supervisor: { mode: 'shadow', lastDecision: { status: 'shadow', decision } } })
  assert.equal(p.text('next-tag'), 'Proposal only')
  assert.equal(p.text('last-detail'), decision.reason)
  p.update({ supervisor: { mode: 'autonomous', paused: true, lastDecision: { status: 'rejected', decision } } })
  assert.equal(p.text('next-tag'), 'Undecided')
})

test('planned survival milestones apply only to the running survival skill', () => {
  const p = panel()
  const state = { busy: true, task: { skillId: 'survive', status: 'running' }, survival: { currentStep: 'wood', steps: [
    { id: 'wood', label: 'Collect wood', status: 'running' }, { id: 'stone', label: 'Collect stone', status: 'pending' },
  ] } }
  p.update(state)
  assert.equal(p.text('next-title'), 'Collect stone')
  p.update({ ...state, task: { skillId: 'smelt', status: 'running' } })
  assert.equal(p.text('next-tag'), 'Undecided')
  p.update({ ...state, task: { skillId: 'survive', status: 'cancelled' } })
  assert.equal(p.text('next-title'), 'Finish stopping')
})

test('stale updates and bot selection clear actionable predictions', () => {
  const p = panel()
  p.update({ runtime: { pendingSkillId: 'smelt' }, supervisor: { objective: 'Make glass' } })
  p.age()
  assert.equal(p.text('next-tag'), 'Unknown')
  assert.match(p.text('live'), /unavailable/)
  p.update({ connection: 'disconnected' }, false)
  assert.equal(p.text('last-title'), 'No supervisor decision yet')
  assert.equal(p.text('current-title'), 'Waiting for Minecraft')
  assert.doesNotMatch(p.text('goal'), /glass/)
})

test('scheduled reviews count down only while the supervisor is enabled and resumed', () => {
  const p = panel()
  p.update({ supervisor: { mode: 'autonomous', nextWakeAt: 110000 } })
  assert.equal(p.text('next-meta'), 'Review in 10s')
  p.update({ supervisor: { mode: 'autonomous', paused: true, nextWakeAt: 110000 } })
  assert.equal(p.text('next-tag'), 'Undecided')
})
