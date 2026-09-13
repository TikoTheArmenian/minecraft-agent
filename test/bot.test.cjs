const { test } = require('node:test')
const assert = require('node:assert/strict')
const vm = require('node:vm')
const fs = require('node:fs')
const path = require('node:path')
const { EventEmitter } = require('node:events')

function setup() {
  const bot = new EventEmitter()
  const terminal = new EventEmitter()
  const timers = new Set()
  const controls = new Set()
  let resolveLook
  let pendingLook = false
  bot.username = 'Marc'
  bot.entity = { yaw: 0, position: { toString: () => '(0, 0, 0)' } }
  bot.clearControlStates = () => controls.clear()
  bot.setControlState = (name, active) => active ? controls.add(name) : controls.delete(name)
  bot.lookCalls = 0
  bot.look = () => { bot.lookCalls++; return pendingLook ? new Promise(resolve => { resolveLook = resolve }) : Promise.resolve() }
  bot.quit = () => { bot.didQuit = true }
  terminal.close = () => terminal.emit('close')
  function timer(fn) {
    const entry = { fn, unref() { return this } }
    timers.add(entry)
    return entry
  }
  const processStub = new EventEmitter()
  processStub.exit = () => {}
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'bot.cjs'), 'utf8'), {
    require(name) {
      if (name === 'mineflayer') return { createBot: () => bot }
      if (name === 'node:readline') return { createInterface: () => terminal }
      if (name === './config.json') return { port: 25565, auth: 'offline' }
      return require(name)
    },
    __dirname: path.join(__dirname, '..'),
    console: { log() {}, error() {} }, process: processStub,
    setTimeout: timer, setInterval: timer,
    clearTimeout: entry => timers.delete(entry), clearInterval: entry => timers.delete(entry)
  })
  return { bot, controls, timers,
    command: async value => { terminal.emit('line', value); await new Promise(setImmediate) },
    deferLook() { pendingLook = true },
    finishLook: async () => { resolveLook(); await new Promise(setImmediate) }
  }
}

test('movement waits for spawn, times out, and stop releases controls', async () => {
  const h = setup()
  await h.command('w')
  assert.equal(h.controls.size, 0)
  h.bot.emit('spawn')
  await h.command('w')
  assert.ok(h.controls.has('forward'))
  for (const timer of [...h.timers]) timer.fn()
  assert.equal(h.controls.size, 0)
  await h.command('d')
  assert.ok(h.controls.has('right'))
  await h.command('stop')
  assert.equal(h.controls.size, 0)
})

test('stop cancels wandering even while its turn is pending', async () => {
  const h = setup()
  h.bot.emit('spawn')
  h.deferLook()
  await h.command('wander')
  await h.command('stop')
  await h.finishLook()
  assert.equal(h.controls.size, 0)
  assert.equal(h.timers.size, 0)
})

test('death and quit stop active wandering; respawn stays still', async () => {
  const h = setup()
  h.bot.emit('spawn')
  await h.command('wander')
  assert.ok(h.controls.has('forward'))
  h.bot.emit('death')
  assert.equal(h.controls.size, 0)
  assert.equal(h.timers.size, 0)
  h.bot.emit('spawn')
  assert.equal(h.controls.size, 0)
  await h.command('wander')
  await h.command('quit')
  assert.equal(h.controls.size, 0)
  assert.equal(h.bot.didQuit, true)
})

test('wandering cannot overlap multiple unfinished turns',async()=>{
  const h=setup();h.bot.emit('spawn');h.deferLook();await h.command('wander')
  for(const timer of h.timers) {timer.fn();timer.fn()}
  assert.equal(h.bot.lookCalls,1)
  await h.command('stop');await h.finishLook();assert.equal(h.controls.size,0)
})
test('a spawn received after quit does not reactivate movement',async()=>{
  const h=setup();await h.command('quit');h.bot.emit('spawn');await h.command('w');assert.equal(h.controls.size,0)
})
