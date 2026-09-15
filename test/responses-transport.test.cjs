const { test } = require('node:test')
const assert = require('node:assert/strict')
const { ResponsesTransport, ResponsesDecisionProvider } = require('../src/supervisor/responses-transport.cjs')
const decision = { decision: { kind: 'wait', reason: 'No useful work.', waitMs: null } }
const completed = (overrides = {}) => ({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(decision) }] }],
  usage: { input_tokens: 100, output_tokens: 20 }, ...overrides })
const env = { OPENAI_API_KEY: 'fake-test-key' }
const response = (body, status = 200) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'x-request-id': 'request-1' } })

test('generic Responses transport uses only environment credentials and bounded fixed endpoint', async () => {
  const requests = []
  const transport = new ResponsesTransport({ env, fetchImpl: async (...args) => { requests.push(args); return response(completed()) } })
  const body = { model: 'test-model', input: 'Hello', store: false }
  const result = await transport.request(body)
  assert.equal(requests[0][0], 'https://api.openai.com/v1/responses')
  assert.equal(requests[0][1].headers.Authorization, 'Bearer fake-test-key')
  assert.deepEqual(JSON.parse(requests[0][1].body), body)
  assert.equal(result.requestId, 'request-1'); assert.equal(result.httpStatus, 200)
  assert.equal(JSON.stringify(result).includes(env.OPENAI_API_KEY), false)
  let called = false
  const missing = new ResponsesTransport({ env: {}, fetchImpl: () => { called = true } })
  await assert.rejects(missing.request({ apiKey: 'ignored' }), { code: 'PROVIDER_UNCONFIGURED' }); assert.equal(called, false)
})

test('HTTP, network, malformed and oversized responses return sanitized typed failures', async () => {
  for (const [fetchImpl, code] of [
    [async () => response('private server error fake-test-key', 429), 'PROVIDER_HTTP'],
    [async () => { throw new Error('private network details fake-test-key') }, 'PROVIDER_NETWORK'],
    [async () => response('{invalid'), 'PROVIDER_INVALID'],
    [async () => response({ huge: 'a'.repeat(500) }), 'PROVIDER_INVALID'],
  ]) {
    const transport = new ResponsesTransport({ env, fetchImpl, maxResponseBytes: 300 })
    await assert.rejects(transport.request({}), error => { assert.equal(error.code, code); assert.equal(error.message.includes('fake-test-key'), false); return true })
  }
})

test('timeouts abort HTTP requests; fully received cancelled responses retain usage for ledger callers', async () => {
  const hangingFetch = async (_, options) => new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }))
  const transport = new ResponsesTransport({ env, fetchImpl: hangingFetch, timeoutMs: 5 })
  await assert.rejects(transport.request({}), { code: 'PROVIDER_TIMEOUT' })
  const controller = new AbortController()
  const cancelled = new ResponsesTransport({ env, fetchImpl: async () => { controller.abort(); return response(completed()) } })
  const received = await cancelled.request({}, { signal: controller.signal })
  assert.equal(controller.signal.aborted, true)
  assert.equal(received.result.usage.input_tokens, 100)
  const preCancelled = new AbortController(); preCancelled.abort()
  await assert.rejects(transport.request({}, { signal: preCancelled.signal }), { code: 'PROVIDER_CANCELLED' })
})

test('decision provider sends strict Responses text.format and uses the existing API cost ledger', async () => {
  const requests = [], records = []
  const provider = new ResponsesDecisionProvider({ transport: { available: () => true, request: async (...args) => {
    requests.push(args); return { result: completed(), requestId: 'r1', httpStatus: 200 }
  } } })
  const agent = { username: 'Worker', apiCosts: { begin: metadata => { records.push(metadata); return 1 }, finish: (id, record) => records.push({ id, ...record }) } }
  const schema = { type: 'object', properties: {}, required: [], additionalProperties: false }
  const result = await provider.decide({ objective: { text: 'Gather stone.' } }, { schema, model: 'test-model', maxOutputTokens: 512, agent })
  assert.deepEqual(result.decision, decision); assert.equal(result.usage.input_tokens, 100)
  assert.deepEqual(requests[0][0].text.format, { type: 'json_schema', name: 'minecraft_supervisor_decision', strict: true, schema })
  assert.equal(requests[0][0].store, false); assert.equal(requests[0][0].max_output_tokens, 512)
  assert.equal(records[0].operation, 'supervisor'); assert.equal(records[1].outcome, 'completed'); assert.equal(records[1].result.usage.input_tokens, 100)
  assert.match(requests[0][0].instructions, /untrusted data/)
})

test('refusals, incomplete responses and invalid output fail closed while retaining usage', async () => {
  for (const [result, code] of [
    [completed({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }), 'PROVIDER_INCOMPLETE'],
    [completed({ output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'No.' }] }] }), 'PROVIDER_REFUSAL'],
    [completed({ output: [{ type: 'message', content: [{ type: 'output_text', text: '{broken' }] }] }), 'PROVIDER_INVALID'],
    [completed({ output: [] }), 'PROVIDER_INVALID'],
  ]) {
    const finishes = []
    const provider = new ResponsesDecisionProvider({ transport: { request: async () => ({ result, httpStatus: 200, requestId: 'r1' }) } })
    const agent = { username: 'Worker', apiCosts: { begin: () => 1, finish: (_, record) => finishes.push(record) } }
    await assert.rejects(provider.decide({}, { schema: {}, model: 'test', maxOutputTokens: 512, agent }), error => {
      assert.equal(error.code, code); assert.equal(error.usage.output_tokens, 20); return true
    })
    assert.equal(finishes.length, 1)
  }
})
