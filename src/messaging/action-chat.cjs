/**
 * LEGACY CHAT HELPER: filters activity messages and includes the old queued-announcement class.
 * The current Agent does not use that class to announce every action; the LLM helper still imports the filter.
 */

// Mirror useful INFO events to Minecraft without recursively logging our own
// chat packets or letting an event burst flood the server's chat rate limit.
function announcement(event, message, level) {
  if (level !== 'info' || /^(chat\.|path\.|connection\.|server\.|command$)/.test(event)) return null
  if (event.startsWith('travel.') && !['travel.building', 'travel.placed'].includes(event))
    return null
  if (/^\[Chat to /i.test(message)) return null // LLM replies were already sent.
  if (
    /^(walk|swim|reach |explore toward|climb onto|coming up to|face open water|travel |arrived near|position:)/i.test(
      message,
    )
  )
    return null
  return String(message)
    .replace(/[\x00-\x1f\x7f§]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 220)
}
class ActionChat {
  constructor(agent, interval = 1000) {
    this.agent = agent
    this.interval = interval
    this.queue = []
    this.timer = null
    this.last = ''
    this.lastAt = 0
    this.skipped = 0
  }
  add(event, message, level) {
    const text = announcement(event, message, level),
      bot = this.agent.bot
    if (!text || !bot?.chat || this.agent.state.connection !== 'ready') return
    if (text === this.last && Date.now() - this.lastAt < 3000) return
    this.last = text
    this.lastAt = Date.now()
    if (this.queue.length >= 40) {
      this.queue.shift()
      this.skipped++
    }
    this.queue.push({ bot, epoch: this.agent.epoch, text })
    if (!this.timer) {
      this.flush()
      this.timer = setInterval(() => this.flush(), this.interval)
      this.timer.unref?.()
    }
  }
  flush() {
    if (!this.queue.length) {
      clearInterval(this.timer)
      this.timer = null
      return
    }
    const item = this.queue.shift()
    if (
      this.agent.bot !== item.bot ||
      this.agent.epoch !== item.epoch ||
      this.agent.state.connection !== 'ready'
    )
      return
    const summary = this.skipped ? `[${this.skipped} older updates skipped] ` : ''
    this.skipped = 0
    try {
      item.bot.chat(`[Action] ${summary}${item.text}`.slice(0, 250))
    } catch {
      /* Chat failure must not interrupt work. */
    }
  }
  clear() {
    clearInterval(this.timer)
    this.timer = null
    this.queue = []
    this.last = ''
    this.lastAt = 0
    this.skipped = 0
  }
}
module.exports = { ActionChat, announcement }
