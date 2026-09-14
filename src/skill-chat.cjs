/** Explicit player controls; model replies and fleet chatter never execute commands. */
const { skills } = require('./skills.cjs')
function parseControl(text) {
  const s = String(text).trim().toLowerCase().replace(/[.!?]+$/, '').replace(/\s+/g, ' ')
    .replace(/^please /, '')
  if (/^(stop|cancel|turn off|stop skill)$/.test(s)) return { type: 'stop' }
  if (/^(start|turn on|start skill|resume)$/.test(s)) return { type: 'startSkill' }
  if (/^(skills|list skills|help)$/.test(s)) return { type: 'skillHelp' }
  const name = s.replace(/^(?:switch (?:my |your )?skill to|switch to|change (?:my |your )?skill to|start|run|enable|turn on) /, '')
  const skill = skills.find(skill => [skill.type.toLowerCase(), skill.label.toLowerCase(), ...skill.aliases].includes(name))
  if (skill) return { type: 'controlSkill', skill: skill.type }
  const exchange = require('./exchange.cjs').parseExchange(name)
  return exchange ? { type: 'controlSkill', skill: 'exchange', command: exchange } : null
}
function addressed(message, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = String(message).match(new RegExp(`^@?${escaped}(?:\\s*[:,]\\s*|\\s+)(.+)$`, 'i'))
  return match?.[1] ?? null
}
function receiveControl(agent, bot, username, message, whisper = false) {
  if (agent.bot !== bot || agent.state.connection !== 'ready' || typeof message !== 'string' || message.length > 200 ||
      !/^[a-zA-Z0-9_]{1,16}$/.test(username) || username === agent.username ||
      Object.values(agent.fleet || {}).some(a => a.username === username)) return false
  const text = addressed(message, agent.username) ?? (whisper ? message : null)
  if (text === null) return false
  let reply
  try {
    const control = parseControl(text)
    if (!control) return false
    agent.log('chat.command', `${username}: ${text}`)
    reply = agent.controlSkill(control)
  } catch (error) { reply = error.message }
  try {
    const clean = String(reply).replace(/[\x00-\x1f\x7f§]/g, ' ').slice(0, 230)
    if (whisper) bot.whisper(username, clean)
    else bot.chat(`${username}: ${clean}`.slice(0, 250))
  } catch { /* A failed reply must not interrupt a skill. */ }
  return true
}
module.exports = { parseControl, addressed, receiveControl }
