/**
 * DEBUGGING HISTORY: keeps recent structured events for the dashboard and writes a rotating log.
 * Also explains whether the current bot state allows starting the survival routine.
 */

const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')

// Keep a short live feed in memory and a bounded, readable log across restarts.
// Logging failures are surfaced in the UI without interrupting Minecraft work.
class ActivityLog {
  constructor(dir, { consoleOutput = false, maxBytes = 2 * 1024 * 1024 } = {}) {
    this.file = path.join(dir, 'logs', 'activity.log')
    this.entries = []
    this.session = randomUUID()
    this.sequence = 0
    this.maxBytes = maxBytes
    this.consoleOutput = consoleOutput
    this.error = null
  }
  write(event, message, level = 'info', details = {}) {
    const clean = String(message)
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .slice(0, 1000)
    const entry = {
      id: `${this.session}:${++this.sequence}`,
      at: Date.now(),
      level,
      event,
      message: clean,
      details,
    }
    this.entries.push(entry)
    this.entries = this.entries.slice(-200)
    const extra = Object.keys(details).length ? ` ${JSON.stringify(details)}` : ''
    const line = `${new Date(entry.at).toISOString()} ${level.toUpperCase().padEnd(5)} [${event}] ${clean}${extra}\n`
    if (this.consoleOutput) process.stdout.write(line)
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      const size = fs.existsSync(this.file) ? fs.statSync(this.file).size : 0
      if (size + Buffer.byteLength(line) > this.maxBytes && size)
        fs.renameSync(this.file, this.file + '.1')
      fs.appendFileSync(this.file, line, { mode: 0o600 })
      this.error = null
    } catch (error) {
      this.error = `Could not save activity log: ${error.message}`
    }
    return entry
  }
}
function survivalAvailability(state) {
  if (state.connection !== 'ready')
    return {
      canStart: false,
      code: 'disconnected',
      label: 'Connect first',
      reason: `Connect ${state.username || 'Marc'} and wait for the world to load.`,
    }
  if (state.busy || state.task?.status === 'running') {
    const stopping = state.task?.status === 'cancelled'
    return {
      canStart: false,
      code: stopping ? 'stopping' : 'busy',
      label: stopping ? 'Stopping…' : 'Task running',
      reason: stopping
        ? 'Waiting for the last action to settle. The log shows its timeout.'
        : `A task is running: ${state.task?.label || 'working'}. Use Stop all actions to cancel it.`,
    }
  }
  if (state.vitals?.gameMode !== 'survival')
    return {
      canStart: false,
      code: 'game-mode',
      label: 'Survival mode required',
      reason: `No task is running. ${state.username || 'Marc'} is in ${state.vitals?.gameMode || 'an unknown'} mode. In Minecraft chat, run /gamemode survival ${state.username || 'Marc'}. You can stay in Creative yourself.`,
    }
  return {
    canStart: true,
    code: 'ready',
    label: 'Ready to start',
    reason: 'No task is running. Start Survive to begin the six-step routine.',
  }
}
module.exports = { ActivityLog, survivalAvailability }
