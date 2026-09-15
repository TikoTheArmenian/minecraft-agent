// @ts-check
// One validator for untrusted HTTP/model invocations. Never coerce or remove input fields.
const Ajv = require('ajv').default
const ajv = new Ajv({ allErrors: true, strict: false, useDefaults: true })
/** @type {WeakMap<object, import('ajv').ValidateFunction>} */
const validators = new WeakMap()
/** @param {Record<string, import('ajv').SchemaObject>} properties @param {string[]} required */
const object = (properties = {}, required = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
})
/** @param {number} minimum @param {number} maximum */
const integer = (minimum, maximum) => ({ type: 'integer', minimum, maximum })
const name = { type: 'string', pattern: '^[a-z][a-z0-9_]{0,63}$' }
const coordinate = integer(-30000000, 30000000)
const position = object({ x: coordinate, y: integer(-64, 319), z: coordinate }, ['x', 'y', 'z'])
const destination = object(
  {
    x: { type: 'number', minimum: -30000000, maximum: 30000000 },
    y: { type: 'number', minimum: -64, maximum: 320 },
    z: { type: 'number', minimum: -30000000, maximum: 30000000 },
  },
  ['x', 'y', 'z'],
)
/** @template T @param {import('ajv').SchemaObject} schema @param {T} value @param {string} label @returns {T} */
function validate(schema, value, label = 'Request') {
  let check = validators.get(schema)
  if (!check) {
    check = ajv.compile(schema)
    validators.set(schema, check)
  }
  if (!check(value)) {
    const error = Object.assign(
      new Error(`${label}: ${ajv.errorsText(check.errors, { separator: '; ' })}`),
      { code: 'INVALID_ARGUMENTS' },
    )
    throw error
  }
  return value
}
module.exports = { validate, object, integer, name, coordinate, position, destination }
