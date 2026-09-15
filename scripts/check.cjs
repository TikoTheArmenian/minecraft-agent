const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const root = path.join(__dirname, '..')
function walk(directory) {
  return fs.readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name)
    return entry.isDirectory() ? walk(file) : /\.(cjs|js|mjs)$/.test(file) ? [file] : []
  })
}
const files = ['bot.cjs', 'start.cjs', 'eslint.config.cjs', ...['src', 'public', 'scripts', 'test'].flatMap(walk)]
for (const file of files) execFileSync(process.execPath, ['--check', path.join(root, file)], { stdio: 'inherit' })
console.log(`Syntax checked ${files.length} JavaScript files, including nested modules and tests.`)
