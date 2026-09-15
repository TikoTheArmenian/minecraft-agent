const { test } = require('node:test')
const assert = require('node:assert/strict')
const { profiles, publicProfile } = require('../src/agents/fleet.cjs')
const path = require('node:path')
const { skills, skillForAlias, publicSkills, parseSkill } = require('../src/skills/registry.cjs')
const load = (module) => require(path.join(__dirname, '..', 'src', 'skills', module))
test('fleet profiles are unique and their default skill is a registered alias', () => {
  assert.equal(new Set(profiles.map((p) => p.id)).size, profiles.length)
  assert.equal(new Set(profiles.map((p) => p.username)).size, profiles.length)
  assert.equal(new Set(profiles.map((p) => p.dataDir)).size, profiles.length)
  for (const p of profiles) assert.ok(skillForAlias(p.skill), `${p.username}: ${p.skill} is not a skill alias`)
  assert.ok(!('dataDir' in publicProfile(profiles[0])))
})
test('every registered skill resolves its module, class and parser without crashing', () => {
  for (const s of skills) {
    if (s.module) assert.equal(typeof load(s.module)[s.className], 'function', s.type)
    if (s.parser) assert.equal(typeof load(s.module)[s.parser], 'function', s.type)
    assert.equal(parseSkill(s.aliases[0]).type, s.type)
  }
  const aliases = skills.flatMap((s) => s.aliases)
  assert.equal(new Set(aliases).size, aliases.length, 'duplicate alias')
  for (const s of publicSkills()) assert.ok(!s.factory && !s.module)
})
test('parameterized parsers ignore unrelated text so generic commands still work', () => {
  assert.equal(parseSkill('find oak logs'), null)
  assert.equal(parseSkill('go to 10 64 10'), null)
})
