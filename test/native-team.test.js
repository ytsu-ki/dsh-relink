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

for (const selectionEnabled of [false, true]) test(`production subagents preserve native effort ${selectionEnabled ? 'selection' : 'inheritance'} and return concurrent results`, { timeout: 8000 }, async t => {
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
