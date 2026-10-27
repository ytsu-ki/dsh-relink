import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import * as SubagentTool from '@deepseek-ai/dsh-tool-subagent'
import SubagentModelSelectionConfig from '@deepseek-ai/dsh-tool-subagent/model-selection-settings'
import * as Persistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { SessionQueryEngine } from '@deepseek-ai/dsh-session-query'
import * as plugin from '../lib/memory-team.js'
import { isolateHome, crashCanary } from './helpers.js'

for (const selectionEnabled of [false, true]) test(`production subagents preserve native effort ${selectionEnabled ? 'selection' : 'inheritance'} and return concurrent results`, { timeout: 8000 }, async t => {
  await isolateHome(t); crashCanary(t)
  const dir = await mkdtemp(join(tmpdir(), 'dsh-native-team-'))
  const ctx = new Context()
  t.after(async () => { await ctx.fiber.dispose(); await rm(dir, { recursive: true, force: true }) })
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  await ctx.plugin(Persistence, { root: join(dir, 'sessions') })
  new SessionQueryEngine(ctx)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(Spawn, { providerName: 'spawn' })
  await ctx.plugin(SubagentTool, { provider: 'spawn', toolName: 'subagent', maxDepth: 1 })
  await ctx.plugin(plugin, { database: join(dir, 'memory.sqlite'), knowledgeRoot: '' })
  const harness = await mountAgentLoopTestHarness(ctx)
  const childRequests = []
  const bothStarted = Promise.withResolvers()
  class Adapter extends LlmAdapter {
    async resolveModel(provider, model, signal) {
      return { ...await super.resolveModel(provider, model, signal), reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] } }
    }
    async *stream(options) {
      if (options.sessionId !== 'parent') {
        childRequests.push(options)
        if (childRequests.length === 2) bothStarted.resolve()
        await bothStarted.promise
      }
      const text = options.sessionId === 'parent' ? 'Integrated findings' : 'Verified local fixture evidence'
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['test'], new Adapter())
  const parent = await harness.create('parent', { provider: 'test', model: 'test', reasoningEffort: 'high' }, { cwd: dir })
  if (selectionEnabled) {
    new SubagentModelSelectionConfig(ctx, { enabled: { get: () => true }, allowedModels: { get: () => [{ provider: 'test', model: 'test' }] } })
    await parent.ctx.inject([...SubagentTool.inject, 'subagentModelSelection'], runtime =>
      SubagentTool.apply(runtime, { provider: 'spawn', toolName: 'subagent', maxDepth: 1, modelSelectionSettings: true }, parent.session))
  }
  const schema = ctx.tools.schemas(parent).find(tool => tool.name === 'team_start')
  assert.equal(Boolean(schema.parameters.properties.tasks.items.properties.reasoning_effort), selectionEnabled)
  const result = await ctx.tools.execute({ name: 'team_start', callId: randomUUID(), agent: parent, signal: new AbortController().signal, arguments: {
    plan: 'native-check', tasks: [
      { key: 'code', question: 'Inspect implementation evidence.', scope: 'Fixture only.', acceptance: 'Return a verified finding.', ...(selectionEnabled ? { reasoning_effort: 'low' } : {}) },
      { key: 'test', question: 'Review acceptance evidence.', scope: 'Fixture only.', acceptance: 'Return a verified finding.', ...(selectionEnabled ? { reasoning_effort: 'low' } : {}) },
    ],
  } })
  assert.equal(result.isError, false, JSON.stringify(result))
  assert(result.value.tasks.every(task => task.status === 'started'), JSON.stringify(result.value))
  const waited = await ctx.tools.execute({ name: 'team_wait', callId: randomUUID(), agent: parent, signal: new AbortController().signal, arguments: {} })
  assert.equal(waited.isError, false, JSON.stringify(waited))
  assert.equal(waited.value.status, 'settled')
  await parent.whenIdle()
  assert.equal(childRequests.length, 2)
  assert(childRequests.every(request => request.reasoningEffort === (selectionEnabled ? 'low' : 'high')))
  assert(childRequests.every(request => request.messages.some(message => message.content?.some(block => block.text?.includes('Independent investigation')))))
  assert(childRequests.every(request => !request.messages.some(message => message.content?.some(block => block.text?.includes('Integrated findings')))))
  const catalog = await ctx.subagents.listChildren(parent.id)
  assert.equal(catalog.length, 2)
  const log = await ctx.sessionQuery.readSession(parent.id)
  assert(JSON.stringify(log).includes('Verified local fixture evidence'), 'native lifecycle must deliver completed child results to parent')
})

test('running native workers fill the team; finished resident workers do not block the next plan', { timeout: 10000 }, async t => {
  await isolateHome(t); crashCanary(t)
  const dir = await mkdtemp(join(tmpdir(), 'dsh-native-capacity-'))
  const ctx = new Context()
  t.after(async () => { await ctx.fiber.dispose(); await rm(dir, { recursive: true, force: true }) })
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  await ctx.plugin(Persistence, { root: join(dir, 'sessions') })
  new SessionQueryEngine(ctx)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(Spawn, { providerName: 'spawn' })
  await ctx.plugin(SubagentTool, { provider: 'spawn', toolName: 'subagent', maxDepth: 1 })
  await ctx.plugin(plugin, { database: join(dir, 'memory.sqlite'), knowledgeRoot: '', betterleaksCommand: '' })
  const harness = await mountAgentLoopTestHarness(ctx)
  let gate = Promise.withResolvers(), started = 0
  const running = Promise.withResolvers()
  class Adapter extends LlmAdapter {
    async *stream(options) {
      if (options.sessionId !== 'parent') { if (++started === 2) running.resolve(); await gate.promise }
      const text = options.sessionId === 'parent' ? 'Integrated' : 'Answer: fixture finding. Evidence: fixture.'
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['test'], new Adapter())
  const parent = await harness.create('parent', { provider: 'test', model: 'test' }, { cwd: dir })
  const call = (name, args) => ctx.tools.execute({ name, callId: randomUUID(), agent: parent, signal: new AbortController().signal, arguments: args })
  const pair = suffix => [
    { key: `code-${suffix}`, question: `Inspect implementation evidence ${suffix}.`, scope: 'Fixture only.', acceptance: 'Return a verified finding.' },
    { key: `test-${suffix}`, question: `Review acceptance evidence ${suffix}.`, scope: 'Fixture only.', acceptance: 'Return a verified finding.' },
  ]
  const first = await call('team_start', { plan: 'first', tasks: pair('a') })
  assert(first.value.tasks.every(task => task.status === 'started'), JSON.stringify(first.value))
  await running.promise
  const ids = first.value.tasks.map(task => task.subagent_id)
  assert.deepEqual(ids.map(id => ctx.agents.get(id)?.status), ['running', 'running'])
  const blocked = await call('team_start', { plan: 'second', tasks: pair('b') })
  assert.equal(blocked.isError, true); assert.match(JSON.stringify(blocked.content), /still active/)
  gate.resolve()
  const waited = await call('team_wait', {})
  assert.equal(waited.value.status, 'settled')
  assert.deepEqual(waited.value.tasks.map(task => `${task.plan}/${task.key}`).sort(), ['first/code-a', 'first/test-a'])
  assert(waited.value.tasks.every(task => task.state !== 'running'), JSON.stringify(waited.value.tasks))
  gate = Promise.withResolvers(); gate.resolve()
  const second = await call('team_start', { plan: 'second', tasks: pair('b') })
  assert.equal(second.isError, false, JSON.stringify(second.content))
  assert(second.value.tasks.every(task => task.status === 'started'))
  await call('team_wait', {})
  await parent.whenIdle()
  assert.equal((await ctx.subagents.listChildren(parent.id)).length, 4)
})
