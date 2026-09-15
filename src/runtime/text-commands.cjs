const { parseWork } = require('./work.cjs')
const { parseSkill } = require('../skills/registry.cjs')

// A small explicit vocabulary keeps commands predictable without an external AI service.
function parse(text) {
  const original = String(text || '').trim()
  const goal = original.match(/^(?:set goal\s+|goal:\s*|objective:\s*)(.+)$/i)
  if (goal) {
    if (goal[1].length > 1000) throw new Error('Keep objectives under 1000 characters.')
    return { type: 'supervisor', action: 'objective', objective: goal[1] }
  }
  const supervisor = original.match(/^supervisor (pause|resume|off|shadow|autonomous|status)$/i)
  if (supervisor) return { type: 'supervisor', action: supervisor[1].toLowerCase() }
  const s = String(text || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[!?]$/, '')
  if (s.length > 200) throw new Error('Keep commands under 200 characters.')
  if (/^(stop|cancel|stop moving)$/.test(s)) return { type: 'stop' }
  if (/^(pos|position|status|where are you)$/.test(s)) return { type: 'status' }
  if (/^(help|commands)$/.test(s)) return { type: 'help' }
  if (/^(look around|scan|survey)$/.test(s)) return { type: 'scan' }
  const skill = parseSkill(s)
  if (skill) return skill
  const work = parseWork(s)
  if (work) return work
  let m = s.match(
    /^(?:go to|goto|move to)\s+(-?\d+(?:\.\d+)?)[ ,]+(-?\d+(?:\.\d+)?)[ ,]+(-?\d+(?:\.\d+)?)$/,
  )
  if (m) {
    const [x, y, z] = m.slice(1).map(Number)
    if (Math.abs(x) > 30000000 || Math.abs(z) > 30000000 || y < -64 || y > 320)
      throw new Error('Coordinates are outside this world’s supported range.')
    return { type: 'goto', x, y, z }
  }
  m = s.match(/^(?:go to|goto|move to|save as|save|remember|forget)\s+([a-z][a-z0-9 _-]{0,31})$/)
  if (m)
    return {
      type: /^(save|remember)/.test(s) ? 'save' : s.startsWith('forget') ? 'forget' : 'waypoint',
      name: m[1],
    }
  m = s.match(/^(?:find|search for)\s+([a-z_ ]+?)(?:\s+(?:within\s+)?(\d+)(?:\s+blocks)?)?$/)
  if (m) {
    const radius = Number(m[2] || 32)
    if (radius < 1 || radius > 64) throw new Error('Search within 1–64 blocks.')
    return { type: 'find', name: m[1].trim().replace(/ /g, '_'), radius }
  }
  throw new Error('Try “go to 20 64 -10”, “find oak logs”, “save base”, “go to base”, or “stop”.')
}

module.exports = { parse }
