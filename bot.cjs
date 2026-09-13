// This is the running bot. start.cjs prepares config.json, then loads this file.
// The original movement demo came from your tutorial; the launcher helper is separate.
// Mineflayer connects as its own player and exposes movement/world APIs.
const mineflayer = require('mineflayer')
// Node's built-in readline turns Terminal input into one command per line.
const readline = require('node:readline')
const path = require('node:path')
// Connection settings are separate from behavior so changing a LAN port needs no code edit.
const config = require('./config.json')

// Reject invalid settings before attempting a network connection.
if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
  throw new Error('config.json needs a numeric port between 1 and 65535.')
}
if (!['offline', 'microsoft'].includes(config.auth)) {
  throw new Error('auth must be offline or microsoft.')
}

// Spread copies host, port, username, auth, and version into the connection options.
// Microsoft login tokens, when used, stay in the project's ignored .auth folder.
const bot = mineflayer.createBot({
  ...config,
  profilesFolder: path.join(__dirname, '.auth')
})
const terminal = readline.createInterface({
  input: process.stdin, output: process.stdout
})
// These variables describe the current session and its scheduled movement.
let ready = false
let walkingTimer
let wanderTimer
// Each stop increments this counter. An older async action must not resume afterward.
let generation = 0
let closing = false
let exitCode = 0

// Shared cancellation point: invalidate pending turns, cancel timers, release keys.
// Releasing controls stops input; Minecraft physics may still carry existing momentum.
function stop() {
  generation++
  clearTimeout(walkingTimer)
  clearInterval(wanderTimer)
  walkingTimer = undefined
  wanderTimer = undefined
  bot.clearControlStates()
}

// Manual movement replaces the previous action and holds one control briefly.
// Durations are milliseconds: 1000 means one second.
function move(control, duration = 1000) {
  stop()
  bot.setControlState(control, true)
  walkingTimer = setTimeout(() => bot.clearControlStates(), duration)
}

// Simple random wandering, not pathfinding or AI: turn, walk, pause, repeat.
function wander() {
  stop()
  // Capture this run's identity so stop() can invalidate it, including across await.
  const run = generation
  let stepping = false
  async function step() {
    if (!ready || run !== generation || stepping) return
    stepping = true
    try {
    bot.clearControlStates()
    // Yaw is horizontal rotation in radians; pitch 0 looks straight ahead.
    await bot.look(Math.random() * Math.PI * 2, 0)
    // The turn is asynchronous: the user might have stopped us while it completed.
    if (!ready || run !== generation) return
    bot.setControlState('forward', true)
    walkingTimer = setTimeout(() => bot.clearControlStates(), 1200)
    } finally { stepping = false }
  }
  // Handle promise failures from interval callbacks instead of leaving rejections unhandled.
  const tick = () => step().catch(err => {
    if (run === generation) stop()
    console.error('Wander error:', err.message)
  })
  // Start immediately, then try another step every 2.5 seconds.
  tick()
  wanderTimer = setInterval(tick, 2500)
}

function help() {
  console.log('Commands: w, s, a, d, j, left, right, wander, stop, pos, help, quit')
  console.log('Type a command, then press Return.')
}

// Closing can be triggered several ways; the guard makes cleanup happen only once.
function quit() {
  if (closing) return
  closing = true
  stop()
  ready = false
  terminal.close()
  bot.quit('Movement demo stopped')
  // Give the disconnect a short grace period. unref lets Node exit sooner if already idle.
  setTimeout(() => process.exit(exitCode), 1500).unref()
}

// Mineflayer emits events as the server changes our state. Movement starts only after spawn.
// Respawning never resumes an old movement command.
bot.on('spawn', () => {
  if (closing) return
  stop()
  ready = true
  console.log('Ready! Logged in as ' + bot.username)
  console.log('Position:', bot.entity.position.toString())
  help()
})
// Stop on death and wait for a fresh spawn event.
bot.on('death', () => {
  stop()
  ready = false
  console.log('Died. Waiting for respawn; movement will stay stopped.')
})
// Log server/network failures and clean up when the connection ends.
bot.on('kicked', reason => { exitCode = 1; console.error('Kicked:', reason) })
bot.on('error', err => {
  exitCode = 1
  stop()
  ready = false
  console.error('Connection error:', err.message)
  quit()
})
bot.on('end', reason => {
  closing = true
  ready = false
  stop()
  console.log('Disconnected:', reason)
  terminal.close()
  process.exit(exitCode)
})

// Command router: normalize a line, then dispatch to a small, bounded action.
terminal.on('line', async line => {
  const requestGeneration = generation
  const command = line.trim().toLowerCase()
  try {
    // Help, stop, and quit are allowed even before the bot is ready.
    if (command === 'quit') return quit()
    if (command === 'help') return help()
    if (command === 'stop') return stop()
    if (!ready) return console.log('Wait for Ready before moving.')

    // These are control names from Mineflayer, relative to the bot's facing direction.
    const controls = { w: 'forward', s: 'back', a: 'left', d: 'right', j: 'jump' }
    if (controls[command]) {
      move(controls[command], command === 'j' ? 300 : 1000)
    } else if (command === 'left' || command === 'right') {
      stop()
      // A quarter turn is pi/2 radians (90 degrees).
      const angle = command === 'left' ? Math.PI / 2 : -Math.PI / 2
      await bot.look(bot.entity.yaw + angle, 0)
    } else if (command === 'wander') {
      wander()
      console.log('Wandering. Type stop to stop.')
    } else if (command === 'pos') {
      console.log('Position:', bot.entity.position.toString())
    } else {
      help()
    }
  } catch (err) {
    // A delayed turn failure must not cancel a newer command.
    if (generation <= requestGeneration + 1) stop()
    console.error('Command error:', err.message)
  }
})
// Control-C and closing stdin use the same shutdown path as the quit command.
terminal.on('SIGINT', quit)
terminal.on('close', () => { if (!closing) quit() })
process.on('SIGINT', quit)
