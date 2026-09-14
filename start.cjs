// Startup helper added around the tutorial bot: discover the local world, then connect.
// fs reads/writes files; path builds paths; os finds your home folder.
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
// This status query checks a Minecraft server without joining as a player.
const { ping } = require('minecraft-protocol')

async function main() {
  // npm start -- 53124 passes the port as the third process argument (index 2).
  const argument = process.argv[2]
  if (argument === '--help') {
    console.log(
      'npm start             Find the LAN port in Agent Test’s log\nnpm start -- 53124     Use the port shown in Minecraft\nnode bot.cjs          Use config.json directly (including online servers)',
    )
    return
  }
  let port
  if (argument !== undefined) {
    if (!/^\d+$/.test(argument)) throw new Error('Use a numeric LAN port: npm start -- 53124')
    port = Number(argument)
  } else {
    // Only inspect the isolated Agent Test installation, not your normal world's logs.
    const logPath = path.join(os.homedir(), 'minecraft-agent-worlds', 'logs', 'latest.log')
    let log = ''
    try {
      log = fs.readFileSync(logPath, 'utf8')
    } catch (err) {
      if (err.code !== 'ENOENT') throw err
    }
    // LAN ports can change. Use the last matching server-start message in this log.
    // A log can be stale, so the live status check below must still succeed.
    const matches = [...log.matchAll(/(?:Started serving on|Local game hosted on port)\s+(\d+)/g)]
    if (!matches.length)
      throw new Error(
        'Open Agent Playground to LAN first, then run npm start again. Or specify its port: npm start -- 53124',
      )
    port = Number(matches.at(-1)[1])
  }
  // TCP ports have a fixed valid range. Reject bad input before touching the network.
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('Port must be between 1 and 65535.')
  console.log(`Checking Minecraft at 127.0.0.1:${port}…`)
  // 127.0.0.1 means this Mac. Short timeouts avoid hanging on a closed LAN session.
  const status = await ping({
    host: '127.0.0.1',
    port,
    version: '1.21.1',
    closeTimeout: 3000,
    noPongTimeout: 1000,
  })
  // Protocol 767 is shared by Minecraft 1.21 and 1.21.1; the profile selects 1.21.1.
  if (status.version?.protocol !== 767)
    throw new Error(
      `Server reports ${status.version?.name}. Launch Agent Test with Minecraft 1.21.1.`,
    )
  const configPath = path.join(__dirname, 'config.json')
  // Avoid replacing a saved online-server configuration with local demo settings.
  if (fs.existsSync(configPath)) {
    const existing = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    if (existing.auth !== 'offline' || existing.host !== '127.0.0.1') {
      throw new Error(
        'config.json contains a nonlocal setup. Run node bot.cjs to use it, or move that config aside before starting the local demo.',
      )
    }
  }
  // Generate the local config only after validation. Mode 0600 limits newly created
  // files to this user. Offline authentication is for this local LAN demo.
  fs.writeFileSync(
    configPath,
    JSON.stringify(
      { host: '127.0.0.1', port, username: 'Marc', auth: 'offline', version: '1.21.1' },
      null,
      2,
    ) + '\n',
    { mode: 0o600 },
  )
  // Requiring the bot executes its top-level code in this same Node process.
  require('./bot.cjs')
}

// Turn startup failures into a readable message and a nonzero shell exit status.
main().catch((err) => {
  console.error(`Cannot start: ${err.message}`)
  process.exitCode = 1
})
