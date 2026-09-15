/** Guard boundaries that are implemented today, without pretending legacy code is fully layered. */
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const { createRequire } = require('node:module')
const root = path.resolve(__dirname, '..')
const files = fs.readdirSync(path.join(root, 'src'), { recursive: true }).filter(file => file.endsWith('.cjs'))
const source = new Map(files.map(file => [file, fs.readFileSync(path.join(root, 'src', file), 'utf8')]))
const imports = file => [...source.get(file).matchAll(/require\(['"](\.[^'"]+)['"]\)/g)]
  .map(match => path.normalize(path.join(path.dirname(file), match[1])))
const skillModule = file => path.join('skills', file)
const runnable = new Set(require('../src/skills/registry.cjs').skills.map(skill => skillModule(skill.module)))
for (const entry of fs.readdirSync(path.join(root, 'src'), { withFileTypes: true })) {
  if (entry.isFile()) assert.equal(entry.name, 'main.cjs', 'Keep implementations in responsibility folders; src/main.cjs is the only root entry point')
}
// Resolve references without executing live scripts or connecting Minecraft bots.
const scriptFiles = ['bot.cjs', 'start.cjs', ...['src', 'scripts', 'test'].flatMap(directory =>
  fs.readdirSync(path.join(root, directory), { recursive: true })
    .filter(file => file.endsWith('.cjs')).map(file => path.join(directory, file)))]
for (const file of scriptFiles) {
  const filename = path.join(root, file), resolve = createRequire(filename).resolve
  for (const match of fs.readFileSync(filename, 'utf8').matchAll(/require(?:\.resolve)?\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g))
    assert.doesNotThrow(() => resolve(match[1]), `${file} has an unresolved relative import: ${match[1]}`)
}
for (const file of files) {
  const dependencies = imports(file)
  if (file.startsWith('capabilities/')) for (const dependency of dependencies)
    assert.ok(!runnable.has(dependency) && !['agents/agent.cjs', 'web/server.cjs', 'agents/fleet.cjs', 'skills/registry.cjs', 'main.cjs'].includes(dependency), `${file} must not depend on runnable/application ${dependency}`)
  if (file.startsWith('supervisor/')) {
    assert.ok(!dependencies.some(dependency => runnable.has(dependency)), `${file} must use SkillRunner to select work`)
    assert.doesNotMatch(source.get(file), /(?:this\.)?(?:agent\.)?bot\.(?:dig|craft|toss|equip|placeBlock|setControlState|chat|whisper)\s*\(/, `${file} bypasses runtime or message transport`)
  }
  if (file.startsWith('runtime/')) assert.ok(!dependencies.some(dependency => /^(public|web)\//.test(dependency)), `${file} must not import web adapters`)
}
assert.ok(!imports('storage/service.cjs').includes('storage/warehouse-layout.cjs'), 'Storage must read warehouse state without depending on construction')
assert.ok(!source.get('agents/agent.cjs').includes('async navigate('), 'Navigation ownership belongs to SkillRunner')
const actions = require('../src/skills/registry.cjs').actions
assert.equal(new Set(actions.map(action => action.id)).size, actions.length, 'Skill IDs must be unique')
for (const action of actions) {
  assert.ok(action.parameters && action.result && action.version && action.execution, `Incomplete skill contract: ${action.id}`)
  if (action.handoff === 'checkpoint' && action.module) {
    const implementation = source.get(skillModule(action.module))
    assert.ok(/checkpoint(?:\?\.)?\s*\(|handoffCheckpoint\s*\(/.test(implementation), `${action.id} advertises a checkpoint it never reaches`)
  }
}
console.log(`Checked dependency boundaries across ${files.length} modules and ${actions.length} skill contracts.`)
