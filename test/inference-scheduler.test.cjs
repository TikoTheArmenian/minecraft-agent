const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { InferenceScheduler } = require('../src/supervisor/inference-scheduler.cjs')
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
const spin = () => new Promise(resolve => setImmediate(resolve))
const request = (agentId, extra = {}) => ({ agentId, reservedTokens: 100, ...extra })
const used = (tokens = 30) => ({ usage: { input_tokens: tokens - 10, output_tokens: 10 } })

test('shared concurrency, per-agent ownership, and release before the next request', async () => {
  const s = new InferenceScheduler({ file: null, maxConcurrent: 1 })
  const held = deferred(); let secondStarted = false
  const a = s.run(request('a'), () => held.promise)
  const b = s.run(request('b'), () => { secondStarted = true; return used() })
  await assert.rejects(s.run(request('a'), () => used()), { code: 'INFERENCE_BUSY' })
  await spin(); assert.equal(secondStarted, false); assert.equal(s.snapshot('a').active, 1)
  held.resolve(used()); await a; await b
  await s.run(request('b'), () => used())
  assert.equal(secondStarted, true); assert.equal(s.snapshot('b').active, 0)
  assert.deepEqual(s.snapshot('b').usage, { requests: 2, tokens: 60 })
})

test('queued cancellation and real readiness recheck prevent provider admission', async () => {
  const s = new InferenceScheduler({ file: null, maxConcurrent: 1 })
  const held = deferred(), controller = new AbortController(); let ran = false, ready = true
  const first = s.run(request('a'), () => held.promise)
  const cancelled = s.run(request('b', { signal: controller.signal }), () => { ran = true })
  const stale = s.run(request('c', { isReady: () => ready }), () => { ran = true })
  const cancelledCheck = assert.rejects(cancelled, { code: 'PROVIDER_CANCELLED' })
  const staleCheck = assert.rejects(stale, { code: 'STALE_SESSION' })
  controller.abort(); ready = false
  held.resolve(used()); await Promise.all([first, cancelledCheck, staleCheck])
  assert.equal(ran, false); assert.equal(s.snapshot('b').usage.requests, 0); assert.equal(s.snapshot('c').usage.requests, 0)
})

test('fleet and individual daily token reservations reject before sending a request', async () => {
  const s = new InferenceScheduler({ file: null, tokensPerDay: 150, requestsPerDay: 2 })
  await s.run(request('a'), () => ({})) // Missing usage retains 100-token reservation.
  let ran = false
  await assert.rejects(s.run(request('b'), () => { ran = true }), { code: 'INFERENCE_BUDGET' })
  await assert.rejects(s.run(request('a', { reservedTokens: 10, budget: { requestsPerDay: 1 } }), () => { ran = true }), { code: 'INFERENCE_BUDGET' })
  assert.equal(ran, false); assert.equal(s.snapshot('a').fleetUsage.tokens, 100)
})

test('rate admission queues until the minute window ends without additional calls', async () => {
  let now = 100000, count = 0
  const s = new InferenceScheduler({ file: null, now: () => now, requestsPerMinute: 1 })
  await s.run(request('a'), () => { count++; return used() })
  const next = s.run(request('b'), () => { count++; return used() })
  await spin(); assert.equal(count, 1); assert.equal(s.queue.length, 1)
  now += 60000; s.drain(); await next
  assert.equal(count, 2); assert.equal(s.timer, null)
})

test('durable reservations survive restart; known usage settles and unknown failures retain charge', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inference-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'usage.json')
  const s = new InferenceScheduler({ file })
  await s.run(request('a'), () => used(40))
  await assert.rejects(s.run(request('a'), () => { throw new Error('unknown response') }), /unknown/)
  await assert.rejects(s.run(request('a'), () => { throw Object.assign(new Error('refusal'), used(20)) }), /refusal/)
  const next = new InferenceScheduler({ file })
  assert.deepEqual(next.snapshot('a').usage, { requests: 3, tokens: 160 })
  const stored = JSON.parse(fs.readFileSync(file, 'utf8')); assert.equal(stored.version, 1)
  fs.writeFileSync(file, '{corrupt')
  const corrupt = new InferenceScheduler({ file }); let ran = false
  await assert.rejects(corrupt.run(request('a'), () => { ran = true }), { code: 'CHECKPOINT_CORRUPT' })
  assert.equal(ran, false); assert.equal(fs.readFileSync(file, 'utf8'), '{corrupt')
})

test('a persisted unresolved reservation remains charged after a simulated crash', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inference-crash-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'usage.json'), held = deferred()
  const s = new InferenceScheduler({ file })
  const pending = s.run(request('a'), () => held.promise); await spin()
  assert.equal(new InferenceScheduler({ file }).snapshot('a').usage.tokens, 100)
  held.resolve({}); await pending
})
