import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { createGuard, DEFAULTS, resolveConfig } from '../lib/guard.js'
import { installFetchScope } from '../lib/fetch-scope.js'

const finish = { type: 'finish', reason: { kind: 'stop' } }
const nativeError = { type: 'finish', reason: { kind: 'error', failure: { code: 'TRANSPORT', message: 'connection lost' } } }
const text = value => ({ type: 'text-delta', index: 0, text: value })
const collect = async iterable => Array.fromAsync(iterable)
const frozenRequest = signal => Object.freeze({ provider: 'deepseek-account', model: 'deepseek-flash',
  sessionId: 'test-session', messages: Object.freeze([]), signal })

function setup(t, overrides = {}) {
  const scope = installFetchScope()
  const lifetime = new AbortController()
  const guard = createGuard(resolveConfig(overrides), scope, lifetime.signal)
  t.after(() => { lifetime.abort(); guard.dispose(); scope.dispose() })
  return { guard, lifetime, scope, request: frozenRequest(new AbortController().signal) }
}
const hang = () => ({ [Symbol.asyncIterator]() { return this }, next() { return new Promise(() => {}) },
  return() { return new Promise(() => {}) } })

test('validates explicit bounds, unknown fields, and provider names', () => {
  assert.deepEqual(resolveConfig(), DEFAULTS)
  for (const input of [{ stalledMs: 0 }, { maxCallMs: Infinity }, { maxStepMs: 1.5 },
    { terminalGraceMs: -1 }, { maxRetries: 11 }, { providers: [] }, { providers: [''] },
    { providers: [' deepseek-account'] }, { constructor: 'unknown' }, { other: true }]) {
    assert.throws(() => resolveConfig(input), TypeError)
  }
})

test('preserves successful chunks and the frozen request', async t => {
  const { guard, request } = setup(t)
  const chunks = [{ type: 'block-start', index: 0, blockType: 'text' }, text('ok'),
    { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } }, finish]
  const result = await collect(guard.stream(request, () => (async function* () { yield* chunks })()))
  assert.deepEqual(result, chunks)
  result.forEach((chunk, index) => assert.equal(chunk, chunks[index]))
  assert(Object.isFrozen(request))
})

test('bounds a silent producer even if next and return ignore cancellation', async t => {
  const { guard, request } = setup(t, { stalledMs: 25 })
  const start = performance.now()
  const result = await collect(guard.stream(request, hang))
  assert.equal(result.at(-1).reason.failure.code, 'DSH_STREAM_GUARD_STALLED')
  assert(performance.now() - start < 1000)
})

test('absolute duration expires while model output keeps arriving', async t => {
  const { guard, request } = setup(t, { stalledMs: 500, maxCallMs: 45 })
  const result = await collect(guard.stream(request, () => (async function* () {
    while (true) { yield text('token'); await delay(5) }
  })()))
  assert(result.length > 1)
  assert.equal(result.at(-1).reason.failure.code, 'DSH_STREAM_GUARD_CALL_DEADLINE')
})

test('closed blocks require a terminal event within the grace period', async t => {
  const { guard, request } = setup(t, { terminalGraceMs: 20 })
  const result = await collect(guard.stream(request, () => (async function* () {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield text('done')
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }
    await new Promise(() => {})
  })()))
  assert.equal(result.at(-1).reason.failure.code, 'DSH_STREAM_GUARD_TERMINAL_TIMEOUT')
})

test('a new block clears the previous terminal grace deadline', async t => {
  const { guard, request } = setup(t, { terminalGraceMs: 25 })
  const result = await collect(guard.stream(request, () => (async function* () {
    yield { type: 'block-start', index: 0, blockType: 'reasoning' }
    yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'thought' } }
    yield { type: 'block-start', index: 1, blockType: 'text' }
    await delay(40)
    yield text('answer')
    yield finish
  })()))
  assert.equal(result.at(-1), finish)
})

test('allows two retries, then returns a non-retryable guard failure', async t => {
  const { guard, request } = setup(t, { maxRetries: 2 })
  let calls = 0
  const next = () => (async function* () { calls++; yield nativeError })()
  for (let i = 0; i < 2; i++) assert.equal((await collect(guard.stream(request, next)))[0], nativeError)
  assert.equal((await collect(guard.stream(request, next)))[0].reason.failure.code, 'DSH_STREAM_GUARD_RETRY_LIMIT')
  assert.equal(calls, 3)
  assert.equal((await collect(guard.stream(request, next)))[0].reason.failure.code, 'DSH_STREAM_GUARD_RETRY_LIMIT')
  assert.equal(calls, 3)
})

test('successful steps reset the retry counter; sessions remain independent', async t => {
  const { guard, request } = setup(t, { maxRetries: 1 })
  const error = () => (async function* () { yield nativeError })()
  const success = () => (async function* () { yield finish })()
  assert.equal((await collect(guard.stream(request, error)))[0], nativeError)
  await collect(guard.stream(request, success))
  assert.equal((await collect(guard.stream(request, error)))[0], nativeError)
  const other = Object.freeze({ ...request, sessionId: 'other-session' })
  assert.equal((await collect(guard.stream(other, error)))[0], nativeError)
})

test('enforces a combined request budget across retries', async t => {
  const { guard, request } = setup(t, { maxStepMs: 65 })
  const next = () => (async function* () { await delay(40); yield nativeError })()
  assert.equal((await collect(guard.stream(request, next)))[0], nativeError)
  assert.equal((await collect(guard.stream(request, next)))[0].reason.failure.code, 'DSH_STREAM_GUARD_STEP_DEADLINE')
})

test('user cancellation and plugin disposal interrupt silent streams', async t => {
  for (const action of ['user', 'dispose']) {
    const { guard, request } = setup(t)
    const controller = new AbortController()
    const pending = collect(guard.stream(action === 'user' ? frozenRequest(controller.signal) : request, hang))
    await delay(5)
    if (action === 'user') controller.abort()
    else guard.dispose()
    assert.equal((await pending).at(-1).reason.kind, 'aborted')
  }
})

test('a finish event ends consumption even if producer hangs afterwards', async t => {
  const { guard, request } = setup(t)
  const result = await collect(guard.stream(request, () => (async function* () {
    yield finish
    await new Promise(() => {})
  })()))
  assert.deepEqual(result, [finish])
})

test('missing finish is an error and middleware exceptions stay visible', async t => {
  const { guard, request } = setup(t)
  assert.equal((await collect(guard.stream(request, () => (async function* () {})())))[0].reason.failure.code,
    'DSH_STREAM_GUARD_INCOMPLETE')
  await assert.rejects(collect(guard.stream(request, () => { throw new Error('middleware bug') })), /middleware bug/)
})

test('fetch scope preserves a later wrapper when it is unloaded', () => {
  const original = globalThis.fetch
  const scope = installFetchScope()
  const later = (...args) => original(...args)
  globalThis.fetch = later
  scope.dispose()
  assert.equal(globalThis.fetch, later)
  globalThis.fetch = original
})
