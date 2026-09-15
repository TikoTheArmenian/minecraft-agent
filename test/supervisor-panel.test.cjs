const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')

function panel() {
  const elements = new Map(),
    listeners = new Map(),
    requests = []
  let bot = 'alpha',
    respond = async () => ({
      ok: true,
      json: async () => ({
        mode: 'shadow',
        model: 'test-model',
        objective: 'Make glass',
        paused: true,
      }),
    })
  function get(id) {
    if (!elements.has(id))
      elements.set(id, {
        value: '',
        textContent: '',
        hidden: false,
        disabled: false,
        dataset: {},
        handlers: new Map(),
        classList: { toggle() {} },
        addEventListener(name, fn) {
          this.handlers.set(name, fn)
        },
      })
    return elements.get(id)
  }
  const document = { getElementById: get, addEventListener: (name, fn) => listeners.set(name, fn) }
  const context = vm.createContext({
    document,
    AbortSignal,
    console,
    botUrl: (suffix) => `/bots/${bot}${suffix}`,
    fetch: async (url, options) => {
      requests.push({ url, options })
      return respond(url, options)
    },
  })
  vm.runInContext(fs.readFileSync(require.resolve('../public/supervisor.js'), 'utf8'), context)
  const update = (supervisor, connection = 'ready') =>
    listeners.get('walkbot-state')({
      detail: { connected: true, state: { connection, supervisor } },
    })
  const event = (id, type) => get(id).handlers.get(type)({ preventDefault() {} })
  return {
    get,
    requests,
    update,
    event,
    select: (name) => {
      bot = name
    },
    response: (fn) => {
      respond = fn
    },
  }
}
const settle = () => new Promise((resolve) => setImmediate(resolve))

test('supervisor decisions show the proposed skill and shadow status from the API snapshot', () => {
  const p = panel()
  p.update({
    mode: 'shadow',
    paused: true,
    lastDecision: {
      mode: 'shadow',
      status: 'shadow',
      decision: { kind: 'start', command: { type: 'smelt' }, reason: 'Glass is needed.' },
    },
  })
  assert.equal(
    p.get('supervisor-decision').textContent,
    'Shadow proposal · start · smelt — Glass is needed.',
  )
})

test('saving supervisor settings posts only configuration and requires explicit resume', async () => {
  const p = panel()
  p.update({ mode: 'off', model: 'test-model', objective: '', paused: true })
  p.get('supervisor-mode').value = 'shadow'
  p.get('supervisor-objective').value = 'Make glass'
  p.event('supervisor-settings', 'input')
  assert.equal(p.get('supervisor-resume').disabled, true)
  p.event('supervisor-settings', 'submit')
  await settle()
  assert.equal(p.requests.length, 1)
  assert.equal(p.requests[0].url, '/bots/alpha/api/supervisor')
  assert.deepEqual(JSON.parse(p.requests[0].options.body), {
    mode: 'shadow',
    model: 'test-model',
    objective: 'Make glass',
  })
  assert.match(p.get('supervisor-feedback').textContent, /Saved and paused/)
  assert.equal(p.get('supervisor-resume').disabled, false)
  p.event('supervisor-resume', 'click')
  await settle()
  assert.equal(p.requests[1].url, '/bots/alpha/api/supervisor/resume')
})

test('streamed state preserves unsaved edits and a previous bot response cannot replace the selected bot form', async () => {
  const p = panel()
  p.update({ mode: 'off', model: 'alpha-model', objective: 'Old goal', paused: true })
  p.get('supervisor-objective').value = 'New draft'
  p.event('supervisor-settings', 'input')
  p.update({ mode: 'off', model: 'alpha-model', objective: 'Old goal', paused: true })
  assert.equal(p.get('supervisor-objective').value, 'New draft')
  let complete
  p.response(
    () =>
      new Promise((resolve) => {
        complete = resolve
      }),
  )
  p.event('supervisor-settings', 'submit')
  p.select('beta')
  p.update({ mode: 'shadow', model: 'beta-model', objective: 'Beta goal', paused: true })
  complete({
    ok: true,
    json: async () => ({ mode: 'off', model: 'alpha-model', objective: 'New draft', paused: true }),
  })
  await settle()
  assert.equal(p.get('supervisor-model').value, 'beta-model')
  assert.equal(p.get('supervisor-objective').value, 'Beta goal')
  assert.equal(p.requests.length, 1)
  assert.equal(p.requests[0].url, '/bots/alpha/api/supervisor')
})
