const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { loadJson, saveJson } = require('../src/infra/json-store.cjs')
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'json-store-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return { dir, file: path.join(dir, 'jobs.json') }
}
const validate = value => value && Number.isInteger(value.count)
test('missing checkpoints differ from corrupt, invalid, and unsupported saved state', t => {
  const { file } = fixture(t)
  assert.deepEqual(loadJson(file, { validate }), { status: 'missing', data: null })
  for (const text of ['{', '{"version":1,"data":{"count":"two"}}', '{"version":8,"data":{"count":2}}']) {
    fs.writeFileSync(file, text)
    assert.throws(() => loadJson(file, { validate }), error => error.code === 'CHECKPOINT_CORRUPT' && error.fatal)
    assert.equal(fs.readFileSync(file, 'utf8'), text, 'invalid input must remain available for recovery')
  }
})
test('legacy state requires explicit consent and passes the same shape validation', t => {
  const { file } = fixture(t)
  fs.writeFileSync(file, '{"count":2}')
  assert.throws(() => loadJson(file, { validate }), { code: 'CHECKPOINT_CORRUPT' })
  assert.deepEqual(loadJson(file, { validate, allowLegacy: true }), { status: 'loaded', data: { count: 2 }, version: 0, legacy: true })
  saveJson(file, { count: 3 }, { validate })
  assert.deepEqual(loadJson(file, { validate }), { status: 'loaded', data: { count: 3 }, version: 1, legacy: false })
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
})
test('failed validation or replacement preserves the previous checkpoint and removes temporary files', t => {
  const { dir, file } = fixture(t)
  saveJson(file, { count: 2 }, { validate })
  assert.throws(() => saveJson(file, { count: 'bad' }, { validate }), { code: 'CHECKPOINT_WRITE_FAILED' })
  t.mock.method(fs, 'renameSync', () => { throw new Error('disk error') })
  assert.throws(() => saveJson(file, { count: 5 }, { validate }), error => error.code === 'CHECKPOINT_WRITE_FAILED' && error.fatal)
  assert.equal(loadJson(file, { validate }).data.count, 2)
  assert.deepEqual(fs.readdirSync(dir), ['jobs.json'])
})
