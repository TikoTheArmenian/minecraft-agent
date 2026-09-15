/** Small synchronous checkpoint store. Missing state is normal; unreadable state is not empty state. */
const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')

function failure(code, file, message, cause) {
  return Object.assign(
    new Error(`${message}: ${path.basename(file)}${cause ? ` (${cause.message})` : ''}`, { cause }),
    { code, fatal: true },
  )
}
function valid(data, validate) {
  if (validate && validate(data) === false) throw new Error('Checkpoint data has an invalid shape')
}
function loadJson(file, { version = 1, validate, allowLegacy = false } = {}) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return { status: 'missing', data: null }
    throw failure(
      'CHECKPOINT_CORRUPT',
      file,
      'Could not read saved work; inspect it before restarting',
      error,
    )
  }
  try {
    const parsed = JSON.parse(text)
    const envelope =
      parsed &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      Object.hasOwn(parsed, 'version') &&
      Object.hasOwn(parsed, 'data')
    if (envelope && parsed.version !== version)
      throw new Error(`Unsupported checkpoint version ${parsed.version}`)
    if (!envelope && !allowLegacy) throw new Error('Checkpoint version is missing')
    const data = envelope ? parsed.data : parsed
    valid(data, validate)
    return { status: 'loaded', data, version: envelope ? parsed.version : 0, legacy: !envelope }
  } catch (error) {
    throw failure(
      'CHECKPOINT_CORRUPT',
      file,
      'Saved work is invalid; preserve it for recovery',
      error,
    )
  }
}
function saveJson(file, data, { version = 1, validate } = {}) {
  let temporary, fd
  try {
    valid(data, validate)
    const serialized = JSON.stringify({ version, data })
    fs.mkdirSync(path.dirname(file), { recursive: true })
    temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
    fd = fs.openSync(temporary, 'wx', 0o600)
    fs.writeFileSync(fd, serialized, 'utf8')
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    fd = undefined
    fs.renameSync(temporary, file)
    temporary = undefined
  } catch (error) {
    throw failure(
      'CHECKPOINT_WRITE_FAILED',
      file,
      'Could not save work; stopped before further actions',
      error,
    )
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd)
      } catch {}
    }
    if (temporary) {
      try {
        fs.unlinkSync(temporary)
      } catch {}
    }
  }
}

module.exports = { loadJson, saveJson }
