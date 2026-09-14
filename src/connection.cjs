/**
 * LOCAL CONNECTION HELPERS: validates the LAN port and closes old bot sockets.
 * The default port is read from the local Minecraft installation's log when no port is supplied.
 */

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
function localPort(input) {
  if (input === undefined || input === null || input === '') {
    let log
    try {
      log = fs.readFileSync(
        path.join(os.homedir(), 'minecraft-agent-worlds/logs/latest.log'),
        'utf8',
      )
    } catch (error) {
      if (error.code === 'ENOENT')
        throw new Error(
          'Open the world to LAN and enter its port, or use the Agent Test installation for auto-detection.',
        )
      throw error
    }
    input = [...log.matchAll(/(?:Started serving on|Local game hosted on port)\s+(\d+)/g)].at(
      -1,
    )?.[1]
  }
  if (!['string', 'number'].includes(typeof input) || !/^\d+$/.test(String(input)))
    throw new Error('Enter a numeric LAN port between 1 and 65535.')
  const port = Number(input)
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('Enter a numeric LAN port between 1 and 65535.')
  return port
}
function closeBot(bot) {
  if (!bot) return
  // A socket destroy also prevents a late action promise writing into a new session.
  try {
    bot.quit()
  } catch (_) {}
  try {
    bot._client?.end()
  } catch (_) {}
  bot._client?.socket?.destroy()
}
module.exports = { localPort, closeBot }
