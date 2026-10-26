import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { Context, Service } from '@deepseek-ai/cordis'
import { LlmRuntime, LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import { DeepSeekAdapter, resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek'
import * as plugin from '../lib/index.js'

function event(res, type, data) { res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`) }
function startMessage(res) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  event(res, 'message_start', { message: { id: 'test', role: 'assistant', model: 'deepseek-flash',
    content: [], usage: { input_tokens: 1, output_tokens: 0 } } })
  event(res, 'content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
  event(res, 'content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'ok' } })
}
function endMessage(res) {
  event(res, 'content_block_stop', { index: 0 })
  event(res, 'message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } })
  event(res, 'message_stop', {})
  res.end()
}

async function setup(t, handler, config = {}) {
  const server = createServer(handler)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const url = `http://127.0.0.1:${server.address().port}`
  const ctx = new Context()
  const llm = new LlmRuntime(ctx)
  new Service(ctx, 'agents')
  const originalFetch = globalThis.fetch
  const adapter = new DeepSeekAdapter({
    options: () => resolveAdapterOptions({ baseURL: url, streamIdleTimeoutMs: 1000, maxTokens: 4096 }),
    resolveAuth: async () => ({ headers: { 'x-api-key': 'local-test-only' } }),
    resolveUserId: () => 'local-test-only',
    prepareExtensions: async () => ({ fields: {}, accept: async () => {} }),
  })
  llm.registerAdapter(['deepseek-account'], adapter)
  const fiber = ctx.plugin(plugin, { stalledMs: 80, maxCallMs: 1000, ...config })
  await fiber
  t.after(async () => {
    await ctx.fiber.dispose()
    assert.equal(globalThis.fetch, originalFetch)
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  })
  const controller = new AbortController()
  const prepared = await llm.prepareCall({ provider: 'deepseek-account', model: 'deepseek-flash' }, controller.signal)
  const options = Object.freeze({ ...prepared.config, signal: controller.signal, sessionId: 'integration',
    messages: Object.freeze([createUserMessage({ content: [{ type: 'text', text: 'test' }], source: { kind: 'test' } })]) })
  return { ctx, llm, fiber, prepared, options, url, controller }
}

test('real DSH Messages adapter: heartbeat-only stalls terminate and close the socket', { timeout: 3000 }, async t => {
  let closed = false
  let requestBody
  const harness = await setup(t, (req, res) => {
    if (req.url === '/unrelated') {
      const timer = setTimeout(() => res.end('unrelated-ok'), 180)
      res.on('close', () => clearTimeout(timer))
      return
    }
    assert.equal(req.url, '/v1/messages')
    let raw = ''
    req.on('data', chunk => { raw += chunk })
    req.on('end', () => { requestBody = JSON.parse(raw) })
    startMessage(res)
    const timer = setInterval(() => res.write(': heartbeat\n\n'), 10)
    res.on('close', () => { clearInterval(timer); closed = true })
  })
  const unrelated = fetch(`${harness.url}/unrelated`).then(res => res.text())
  const started = performance.now()
  const chunks = await Array.fromAsync(harness.prepared.stream(harness.options))
  const unrelatedResult = await unrelated
  assert.equal(chunks.at(-1).reason.failure.code, 'DSH_STREAM_GUARD_STALLED')
  assert(performance.now() - started < 700)
  assert.equal(chunks.filter(chunk => chunk.type === 'finish').length, 1)
  assert.equal(unrelatedResult, 'unrelated-ok')
  assert(closed, 'the upstream HTTP stream must be aborted, not left in the background')
  assert.equal(requestBody.model, 'deepseek-flash')
  assert.equal(requestBody.output_config.effort, 'high')
  assert.equal(requestBody.thinking.type, 'enabled')
})

test('real DSH Messages adapter: valid output and usage are unchanged', { timeout: 3000 }, async t => {
  const { prepared, options } = await setup(t, (_req, res) => { startMessage(res); endMessage(res) }, { stalledMs: 1000 })
  const chunks = await Array.fromAsync(prepared.stream(options))
  assert.equal(chunks.at(-1).reason.kind, 'stop')
  assert.equal(chunks.find(chunk => chunk.type === 'text-delta').text, 'ok')
  assert.equal(chunks.find(chunk => chunk.type === 'usage').usage.outputTokens, 1)
})

test('real DSH Messages adapter: missing finish after closed blocks uses a shorter grace', { timeout: 3000 }, async t => {
  let closed = false
  const { prepared, options } = await setup(t, (_req, res) => {
    startMessage(res)
    event(res, 'content_block_stop', { index: 0 })
    const timer = setInterval(() => res.write(': heartbeat\n\n'), 10)
    res.on('close', () => { clearInterval(timer); closed = true })
  }, { terminalGraceMs: 30, stalledMs: 200 })
  const chunks = await Array.fromAsync(prepared.stream(options))
  assert.equal(chunks.at(-1).reason.failure.code, 'DSH_STREAM_GUARD_TERMINAL_TIMEOUT')
  await delay(15)
  assert(closed)
})

test('real Cordis recovery hook stops guard failures even with an always-retry downstream', async t => {
  const { ctx } = await setup(t, (_req, res) => res.end())
  let retries = 0
  const next = async () => { retries++; return { kind: 'retry' } }
  const stopped = await ctx.waterfall('agent/request-error', { failure: { code: 'DSH_STREAM_GUARD_STALLED' } }, next)
  assert.equal(stopped, undefined)
  assert.equal(retries, 0)
  const ordinary = await ctx.waterfall('agent/request-error', { failure: { code: 'TRANSPORT' } }, next)
  assert.equal(ordinary.kind, 'retry')
  assert.equal(retries, 1)
})

test('real Cordis unload cancels active transport and unregisters both hooks', { timeout: 3000 }, async t => {
  let closed = false
  let accepted
  const connected = new Promise(resolve => { accepted = resolve })
  const { prepared, options, fiber, ctx } = await setup(t, (_req, res) => {
    startMessage(res)
    const timer = setInterval(() => res.write(': heartbeat\n\n'), 10)
    res.on('close', () => { clearInterval(timer); closed = true })
    accepted()
  })
  const pending = Array.fromAsync(prepared.stream(options))
  await connected
  await fiber.dispose()
  assert.equal((await pending).at(-1).reason.kind, 'aborted')
  await delay(15)
  assert(closed)
  assert.equal(ctx.events.dispatch('waterfall', ['llm/stream']).length, 0)
  assert.equal(ctx.events.dispatch('waterfall', ['agent/request-error']).length, 0)
})

test('unselected providers and auxiliary purposes bypass the guard', { timeout: 3000 }, async t => {
  const { llm, options } = await setup(t, (_req, res) => {
    const timer = setTimeout(() => { startMessage(res); endMessage(res) }, 100)
    res.on('close', () => clearTimeout(timer))
  }, { stalledMs: 20 })
  const title = await Array.fromAsync(llm.stream(Object.freeze({ ...options, purpose: 'session-title' })))
  assert.equal(title.at(-1).reason.kind, 'stop')
  class OtherAdapter extends LlmAdapter {
    async *stream() { await delay(70); yield { type: 'finish', reason: { kind: 'stop' } } }
  }
  llm.registerAdapter(['other'], new OtherAdapter())
  assert.equal((await Array.fromAsync(llm.stream({ provider: 'other', model: 'other', messages: [] }))).at(-1).reason.kind, 'stop')
})
