const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const root = path.join(__dirname, '..')
const files = [
  'bot.cjs',
  'start.cjs',
  ...['src', 'public', 'scripts'].flatMap((dir) =>
    fs
      .readdirSync(path.join(root, dir))
      .filter((name) => /\.(?:cjs|js)$/.test(name))
      .map((name) => `${dir}/${name}`),
  ),
]
for (const file of files)
  execFileSync(process.execPath, ['--check', path.join(root, file)], { stdio: 'inherit' })
console.log(`Syntax checked ${files.length} JavaScript files.`)
