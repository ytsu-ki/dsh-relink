import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, readFile, mkdir, realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as plugin from '../lib/memory-team.js'
import { efficiencyProjection } from '../lib/efficiency.js'
import { TeamCoordinator } from '../lib/team.js'
import { isolateHome, crashCanary } from './helpers.js'

async function setup(t, response) {
  await isolateHome(t); crashCanary(t)
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'dsh-team-test-')))
  await mkdir(join(dir, '.git'))
  const ctx = new Context()
  t.after(async () => { await ctx.fiber.dispose(); await rm(dir, { recursive: true, force: true }) })
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  const catalog = new Map()
  const calls = []
  ctx.provide('subagents', { listChildren: async id => catalog.get(id) ?? [] })
  const harness = await mountAgentLoopTestHarness(ctx)
  const received = []
  class Adapter extends LlmAdapter {
    async *stream(options) {
      received.push(options)
      if (response) { yield* response(options, received.length); return }
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'Done' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Done' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['test'], new Adapter())
  const fiber = ctx.plugin(plugin, { database: join(dir, 'memory.sqlite'), knowledgeRoot: '', betterleaksCommand: '', projectRoot: '' })
  await fiber
  assert(ctx.tools.get('project_memory_search'))
  const agent = await harness.create('parent', { provider: 'test', model: 'test' }, { cwd: dir })
  const invoke = (name, args, a = agent) => ctx.tools.execute({ callId: randomUUID(), name, arguments: args, agent: a, signal: new AbortController().signal })
  ctx.tools.register({
    name: 'subagent', description: 'test native delegation', parameters: { type: 'object' },
    output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      calls.push({ args, exec })
      // A two-party rendezvous proves overlapping startup instead of relying on clock timings.
      if (calls.length === 1) await new Promise(resolve => { calls.release = resolve })
      else calls.release?.()
      const id = randomUUID()
      catalog.set(exec.agent.id, [...catalog.get(exec.agent.id) ?? [], { id, label: args.description }])
      return { kind: 'activation', subagentId: id }
    },
  })
  return { ctx, dir, fiber, agent, invoke, calls, catalog, received, harness }
}

const tasks = [
  { key: 'implementation', question: 'Locate why the viewport layout overflows.', scope: 'src/layout.js; read only.', acceptance: 'Return the responsible lines and evidence.' },
  { key: 'acceptance', question: 'Review whether the 1440px acceptance assertions are valid.', scope: 'test/layout.js; read only.', acceptance: 'Identify false positives and a targeted verification.' },
]

test('real tool runtime executes parallel nested calls, propagates native policy and deduplicates retries', { timeout: 5000 }, async t => {
  const f = await setup(t)
  const observed = []
  f.ctx.on('tools/pre-execute', (exec, next) => { observed.push(exec); return next() })
  const result = await f.invoke('team_start', { plan: 'viewport', tasks })
  assert.equal(result.isError, false, JSON.stringify(result))
  assert.equal(f.calls.length, 2)
  assert(result.value.tasks.every(task => task.status === 'started'))
  assert.equal(observed.filter(exec => exec.name === 'subagent' && exec.parent).length, 2)
  const retry = await f.invoke('team_start', { plan: 'viewport', tasks })
  assert(retry.value.tasks.every(task => task.status === 'existing'))
  assert.equal(f.calls.length, 2)
  const changed = await f.invoke('team_start', { plan: 'viewport', tasks: [{ ...tasks[0], question: 'Different question' }] })
  assert.equal(changed.isError, true)
  const deny = f.ctx.tools.guard(exec => exec.name === 'subagent' ? 'Native delegation denied' : undefined)
  const refused = await f.invoke('team_start', { plan: 'denied', tasks })
  assert(refused.value.tasks.every(task => task.status === 'failed'))
  assert.equal(f.calls.length, 2)
  deny()
})

test('team enforces capacity, distinct work and parent-only orchestration', { timeout: 5000 }, async t => {
  const f = await setup(t)
  assert.equal((await f.invoke('team_start', { plan: 'bad', tasks: [tasks[0], tasks[0]] })).isError, true)
  assert.equal((await f.invoke('team_start', { plan: 'bad', tasks: [...tasks, tasks[0]] })).isError, true)
  // Two plugin-owned children that are still running fill the team.
  f.catalog.set(f.agent.id, [{ id: 'busy-a', label: '[dsh-team:busy:a:0123456789ab]' }, { id: 'busy-b', label: '[dsh-team:busy:b:0123456789ab]' }])
  const states = new Map([['busy-a', 'running'], ['busy-b', 'running']]), get = f.ctx.agents.get.bind(f.ctx.agents)
  t.mock.method(f.ctx.agents, 'get', id => states.has(id) ? { status: states.get(id) } : get(id))
  const full = await f.invoke('team_start', { plan: 'full', tasks })
  assert.equal(full.isError, true); assert.match(JSON.stringify(full.content), /still active/)
  // Finished children can stay resident and idle; they no longer block new independent work.
  states.set('busy-a', 'idle'); states.set('busy-b', 'idle')
  const next = await f.invoke('team_start', { plan: 'after-completion', tasks })
  assert.equal(next.isError, false, JSON.stringify(next.content))
  assert(next.value.tasks.every(task => task.status === 'started'))
  const worker = { ...f.agent, id: 'worker', options: {}, session: { header: { origin: 'subagent', delegationDepth: 1 } } }
  assert.equal((await f.ctx.tools.get('team_start').execute({ plan: 'nested', tasks }, { agent: worker, signal: new AbortController().signal }).catch(() => 'denied')), 'denied')
  assert.equal(f.calls.length, 2)
})

test('real agent admission persists one bounded memory context and excludes stale evidence', { timeout: 5000 }, async t => {
  const f = await setup(t)
  await writeFile(join(f.dir, 'layout.js'), 'one')
  const saved = await f.invoke('project_memory_save', { key: 'viewport', title: '1440px viewport', kind: 'pitfall', summary: 'Close the overlay before measuring.', evidence: 'Local fixture verified occlusion.', files: ['layout.js'] })
  assert.equal(saved.isError, false, JSON.stringify(saved))
  f.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Check the 1440px viewport' }] }))
  await f.agent.whenIdle()
  assert.equal(f.received.length, 1)
  const records = Array.from({ length: f.agent.session.seq + 1 }, (_, i) => f.agent.session.eventAt(i)).filter(event => event?.type === 'user/message' && event.data.source.kind === 'dsh-memory-team')
  assert.equal(records.length, 1)
  assert.match(records[0].data.content[0].text, /Close the overlay/)
  assert(f.received[0].messages.some(message => message.source?.kind === 'dsh-memory-team'))
  await writeFile(join(f.dir, 'layout.js'), 'two')
  const search = await f.invoke('project_memory_search', { query: 'viewport' })
  assert.deepEqual(search.value.records, [])
  const stale = await f.invoke('project_memory_search', { query: 'viewport', include_stale: true })
  assert.equal(stale.value.records[0].stale, 'files-changed')
  await f.fiber.dispose()
  assert.equal(f.ctx.tools.get('team_start'), undefined)
  assert.equal(f.ctx.tools.get('team_wait'), undefined)
  assert.equal(f.ctx.tools.get('project_memory_search'), undefined)
  assert.equal(f.ctx.tools.get('workflow_status'), undefined)
  assert.equal(f.ctx.sessionProjections.stateOf(f.agent.session, efficiencyProjection.key), undefined)
})

test('fresh sessions recall saved evidence only in the matching project and expose scope/storage diagnostics', { timeout: 8000 }, async t => {
  const f = await setup(t), other = await realpath(await mkdtemp(join(tmpdir(), 'dsh-recall-other-')))
  t.after(() => rm(other, { recursive: true, force: true }))
  await mkdir(join(other, '.git'))
  await writeFile(join(f.dir, 'source.txt'), 'version one')
  const answer = `EVIDENCE-${randomUUID()}`
  const saved = await f.invoke('project_memory_save', { key: 'fresh-proof', title: 'fresh-proof', kind: 'fact', summary: answer, evidence: 'Synthetic acceptance evidence.', files: ['source.txt'] })
  assert.equal(saved.isError, false)
  const status = (await f.invoke('project_memory_status', {})).value
  assert.equal(status.plugin_version, JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version)
  assert.equal(status.runtime.node, process.versions.node)
  assert.equal(status.runtime.uv, process.versions.uv)
  assert.equal(status.runtime.pid, process.pid)
  assert(Number.isFinite(Date.parse(status.loaded_at)))
  assert.equal(status.scope.source, 'git')
  assert.equal(status.backend, 'sqlite'); assert.equal(status.health, 'ok')
  assert.deepEqual(status.configuration.problems, [])
  assert.equal(status.database, join(f.dir, 'memory.sqlite'))
  assert.equal(status.permission_model, process.platform === 'win32' ? 'windows-acl-inherited-unverified' : 'posix-mode')
  const ask = async (id, cwd, query) => {
    const agent = await f.harness.create(id, { provider: 'test', model: 'test' }, { cwd })
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: query }] }))
    await agent.whenIdle()
    const request = f.received.find(request => request.sessionId === id)
    assert(request, 'the real AgentLoop must enter a model request')
    const recalled = request.messages.filter(message => message.source?.kind === 'dsh-memory-team')
    assert.equal(recalled.length, 1)
    const events = Array.from({ length: agent.session.seq + 1 }, (_, i) => agent.session.eventAt(i))
    assert(events.some(event => event?.type === 'user/message' && event.data.source?.kind === 'dsh-memory-team'))
    return recalled[0].content[0].text
  }
  assert((await ask('fresh-hit', f.dir, 'What is fresh-proof?')).includes(answer))
  for (const [id, cwd, query] of [['unrelated', f.dir, 'zzzz-unrelated-needle'], ['other-project', other, 'What is fresh-proof?']]) {
    const recall = await ask(id, cwd, query)
    assert.match(recall, /no matching current records/); assert(!recall.includes(answer))
  }
  await writeFile(join(f.dir, 'source.txt'), 'version two')
  const stale = await ask('stale-session', f.dir, 'What is fresh-proof?')
  assert.match(stale, /no matching current records/); assert(!stale.includes(answer))
  await f.fiber.dispose()
  await f.ctx.plugin(plugin, { database: join(f.dir, 'memory.sqlite'), knowledgeRoot: '', betterleaksCommand: '', projectRoot: f.dir })
  assert.equal((await f.invoke('project_memory_status', {})).value.scope.source, 'explicit')
  assert.equal((await f.invoke('project_memory_status', {}, await f.harness.create('outside-explicit', { provider: 'test', model: 'test' }, { cwd: other }))).value.project, other)
})

test('production agent loop admits one repeat reminder and completes without truncation', { timeout: 5000 }, async t => {
  const f = await setup(t, async function* (_request, count) {
    if (count <= 4) {
      const block = { type: 'tool-call', id: `probe-${count}`, name: 'fixture_probe', arguments: '{"path":"fixture"}' }
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id: block.id, name: block.name, argumentsDelta: block.arguments }
      yield { type: 'block-end', index: 0, block }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Final verified answer' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  })
  f.ctx.tools.register({ name: 'fixture_probe', description: 'Fixture probe', parameters: { type: 'object' },
    output: { schema: { type: 'object' }, render: () => [{ type: 'text', text: 'same visible result' }] },
    execute: async () => ({ value: 'same' }),
  })
  f.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Diagnose fixture' }] }))
  await f.agent.whenIdle()
  assert.equal(f.received.length, 5)
  const events = Array.from({ length: f.agent.session.seq + 1 }, (_, i) => f.agent.session.eventAt(i)).filter(Boolean)
  const notices = events.filter(event => event.type === 'user/message' && event.data.source.kind === 'dsh-efficiency')
  assert.equal(notices.length, 1)
  assert.match(notices[0].data.content[0].text, /fixture_probe/)
  assert(f.received[3].messages.some(message => message.source?.kind === 'dsh-efficiency'))
  assert.equal(events.at(-1).type, 'turn/end')
  const status = await f.invoke('workflow_status', {})
  assert.equal(status.value.steps, 5)
  assert.equal(status.value.tool_calls, 4)
  assert.equal(status.value.running, false)
  let replayed = efficiencyProjection.init(f.agent.session.header, 0)
  for (const event of events) replayed = efficiencyProjection.apply(replayed, event)
  assert.deepEqual(replayed, f.ctx.sessionProjections.stateOf(f.agent.session, efficiencyProjection.key))
})

test('SVG workflow reaches the first model request and recurring reasoning gets a durable follow-up', { timeout: 5000 }, async t => {
  const f = await setup(t, async function* (_request, count) {
    if (count <= 2) {
      const reasoning = { type: 'reasoning', text: 'synthetic-reasoning'.repeat(1000) }
      yield { type: 'block-start', index: 0, blockType: 'reasoning' }
      yield { type: 'reasoning-delta', index: 0, text: reasoning.text }
      yield { type: 'block-end', index: 0, block: reasoning }
      const block = { type: 'tool-call', id: `work-${count}`, name: 'fixture_check', arguments: '{}' }
      yield { type: 'block-start', index: 1, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 1, id: block.id, name: block.name, argumentsDelta: block.arguments }
      yield { type: 'block-end', index: 1, block }
      yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 7000 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Complete artifact and checks' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  })
  f.ctx.tools.register({ name: 'fixture_check', description: 'Check fixture', parameters: { type: 'object' },
    output: { schema: { type: 'object' }, render: () => [{ type: 'text', text: 'checked' }] }, execute: async () => ({ checked: true }) })
  f.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '\u751f\u6210\u4e00\u6bb5\u9e48\u9e55\u9a91\u81ea\u884c\u8f66\u7684SVG' }] }))
  await f.agent.whenIdle()
  assert.equal(f.received.length, 3)
  assert(f.received[0].messages.some(message => message.source?.kind === 'dsh-workflow'))
  assert(f.received[1].messages.some(message => message.source?.notice === 'reasoning:1'))
  assert(f.received[2].messages.some(message => message.source?.notice === 'reasoning:2'))
  const events = Array.from({ length: f.agent.session.seq + 1 }, (_, i) => f.agent.session.eventAt(i)).filter(Boolean)
  assert.equal(events.filter(e => e.type === 'user/message' && e.data.source?.kind === 'dsh-workflow').length, 1)
  assert.equal(events.at(-1).type, 'turn/end')
  const status = await f.invoke('workflow_status', {})
  assert.equal(status.value.completed_output_tokens, 14000)
  assert.equal(status.value.running, false)
  let replayed = efficiencyProjection.init(f.agent.session.header, 0)
  for (const event of events) replayed = efficiencyProjection.apply(replayed, event)
  assert.deepEqual(replayed, f.ctx.sessionProjections.stateOf(f.agent.session, efficiencyProjection.key))
  const checkpoint = f.ctx.sessionProjections.checkpoint(f.agent.session)
  checkpoint[efficiencyProjection.key] = { ver: 1, seq: events.at(-1).seq, val: { legacy: true } }
  assert.equal(f.ctx.sessionProjections.restoreFloor(checkpoint), 0)
  const restored = f.ctx.sessionProjections.restore(checkpoint, events, 0, f.agent.session.header, 0)
  assert.equal(restored.checkpoint[efficiencyProjection.key].ver, 3)
  assert.deepEqual(restored.checkpoint[efficiencyProjection.key].val, replayed)
})

test('optional child effort is passed through native selection and never silently enabled', { timeout: 5000 }, async t => {
  const f = await setup(t)
  const mechanical = tasks.map(task => ({ ...task, reasoning_effort: 'low' }))
  const disabled = await f.invoke('team_start', { plan: 'effort', tasks: mechanical })
  assert.equal(disabled.isError, true)
  assert.equal(f.calls.length, 0)
  const native = f.ctx.tools.get('subagent')
  native.parameters.properties = { reasoning_effort: { type: 'string' } }
  const started = await f.invoke('team_start', { plan: 'effort', tasks: mechanical })
  assert.equal(started.isError, false, JSON.stringify(started))
  assert.equal(f.calls.length, 2)
  assert(f.calls.every(call => call.args.reasoning_effort === 'low'))
  const changed = await f.invoke('team_start', { plan: 'effort', tasks })
  assert.equal(changed.isError, true)
})

test('team effort schema follows each agent native tool in requests and SDK projections', { timeout: 5000 }, async t => {
  const f = await setup(t)
  const effortOf = (schemas) => schemas.find(tool => tool.name === 'team_start').parameters.properties.tasks.items.properties.reasoning_effort
  assert.equal(effortOf(f.ctx.tools.schemas(f.agent)), undefined, 'disabled native selection must not advertise an override')
  const peer = await f.harness.create('selection-enabled', { provider: 'test', model: 'test' }, { cwd: f.dir })
  const native = f.ctx.tools.get('subagent', peer)
  const removeNative = peer.ctx.tools.register({ ...native, parameters: { type: 'object', properties: { reasoning_effort: { type: 'string' } } } })
  const enabledSnapshot = f.ctx.tools.schemas(peer)
  assert.deepEqual(effortOf(enabledSnapshot).enum, ['low', 'high'])
  assert.equal(effortOf(f.ctx.tools.schemas(f.agent)), undefined, 'another agent must retain its own policy')
  assert.deepEqual(effortOf(f.ctx.tools.sdkSchemas(peer)).enum, ['low', 'high'])
  assert.equal(effortOf(f.ctx.tools.sdkSchemas(f.agent)), undefined)
  for (const agent of [f.agent, peer]) {
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Read-only schema acceptance.' }] }))
    await agent.whenIdle()
  }
  assert.equal(effortOf(f.received[0].tools), undefined)
  assert.deepEqual(effortOf(f.received[1].tools).enum, ['low', 'high'])
  const globalNative = f.ctx.tools.get('subagent')
  globalNative.parameters.properties = { reasoning_effort: { type: 'string' } }
  assert(effortOf(f.ctx.tools.schemas(f.agent)))
  const removeRestriction = f.agent.ctx.tools.restrict({ deny: ['subagent'] })
  assert.equal(effortOf(f.ctx.tools.schemas(f.agent)), undefined)
  assert.equal((await f.invoke('team_start', { plan: 'restricted', tasks })).isError, true)
  assert.equal(f.calls.length, 0, 'native restrictions must still block delegation')
  await removeRestriction()
  delete globalNative.parameters.properties
  await removeNative()
  assert.equal(effortOf(f.ctx.tools.schemas(peer)), undefined, 'removed native capability must disappear')
  assert.deepEqual(effortOf(enabledSnapshot).enum, ['low', 'high'], 'prior request snapshots remain detached')
  await f.fiber.dispose()
  assert.equal(f.ctx.tools.get('team_start', peer), undefined)
  assert.equal(f.ctx.tools.get('team_start', f.agent), undefined)
})

test('team wait joins native work once, rejects workers and cancels without interrupting children', async t => {
  const f = await setup(t), pending = Promise.withResolvers()
  let waits = 0
  f.ctx.subagents.waitForChildren = parent => { assert.equal(parent, f.agent); waits++; return pending.promise }
  const result = f.invoke('team_wait', {})
  await Promise.resolve(); await Promise.resolve()
  pending.resolve(true)
  const settled = await result
  assert.equal(settled.isError, false)
  assert.equal(settled.value.status, 'settled')
  assert.equal(waits, 1)
  const coordinator = new TeamCoordinator(f.ctx)
  const worker = { ...f.agent, session: { header: { origin: 'subagent' } } }
  await assert.rejects(coordinator.wait({ agent: worker, signal: new AbortController().signal }), /Only the parent/)
  f.ctx.subagents.waitForChildren = () => new Promise(() => {})
  const controller = new AbortController()
  const waiting = coordinator.wait({ agent: f.agent, signal: controller.signal })
  controller.abort(new Error('cancel only the wait'))
  await assert.rejects(waiting, /cancel only the wait/)
  const unloading = coordinator.wait({ agent: f.agent, signal: new AbortController().signal })
  coordinator.dispose()
  await assert.rejects(unloading, /unloaded/)
})

const recallsOf = (requests, start = 0) => requests.slice(start).map(request => request.messages.filter(message => message.source?.kind === 'dsh-memory-team').map(message => message.content[0].text))

test('recall in one session is resent only when it changes; unchanged and repeated no-match turns stay small', { timeout: 8000 }, async t => {
  const f = await setup(t)
  await f.invoke('project_memory_save', { key: 'viewport', title: '1440px viewport overlay', kind: 'pitfall', summary: 'Close the cookie overlay before measuring the checkout button at 1440px.', evidence: 'Playwright trace showed the overlay.', files: [] })
  const turn = async text => {
    const before = f.received.length
    f.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }))
    await f.agent.whenIdle()
    const added = f.received.slice(before)
    const latest = added[0].messages.filter(message => message.source?.kind === 'dsh-memory-team')
    return latest.at(-1)?.content[0].text ?? null
  }
  const first = await turn('The checkout button at 1440px is unclickable because of the cookie overlay.')
  assert.match(first, /Verified findings:/); assert.match(first, /Close the cookie overlay/)
  const again = await turn('Still about the 1440px cookie overlay on the checkout button.')
  assert.match(again, /unchanged since the previous recall/); assert(again.length < 400, 'an unchanged recall is a short pointer')
  const unrelated = await turn('Write a haiku about autumn leaves.')
  assert.match(unrelated, /no matching current records/, 'a no-match notice supersedes the earlier records')
  const quiet = f.received.length
  f.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Another haiku about winter snow.' }] }))
  await f.agent.whenIdle()
  const events = Array.from({ length: f.agent.session.seq + 1 }, (_, i) => f.agent.session.eventAt(i)).filter(event => event?.type === 'user/message' && event.data.source?.kind === 'dsh-memory-team')
  assert.equal(events.length, 3, 'a second consecutive no-match adds nothing')
  assert.equal(f.received.length, quiet + 1)
  assert.deepEqual(events.map(event => event.data.source.recall.records), [1, 1, 0])
})

test('activation creates no files, processes or handles; a missing vault is reported, never recreated', { timeout: 8000 }, async t => {
  await isolateHome(t); crashCanary(t)
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'dsh-lazy-')))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const project = join(dir, 'project'); await mkdir(join(project, '.git'), { recursive: true })
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  ctx.provide('subagents', { listChildren: async () => [] })
  const harness = await mountAgentLoopTestHarness(ctx)
  const resources = process.getActiveResourcesInfo().length
  const config = { database: join(dir, 'data', 'memory.sqlite'), knowledgeRoot: join(dir, 'missing-vault'), knowledgeProject: '', basicMemoryCommand: '/nonexistent/basic-memory', basicMemoryConfig: join(dir, 'state'), betterleaksCommand: '', projectRoot: '' }
  const fiber = ctx.plugin(plugin, config); await fiber
  for (const path of [join(dir, 'data'), join(dir, 'missing-vault'), join(dir, 'state')]) await assert.rejects(stat(path), { code: 'ENOENT' }, `${path} must not exist after activation`)
  assert.equal(process.getActiveResourcesInfo().length, resources, 'activation starts no process, watcher or timer')
  const agent = await harness.create('lazy', { provider: 'test', model: 'test' }, { cwd: project })
  const invoke = (name, args) => ctx.tools.execute({ callId: randomUUID(), name, arguments: args, agent, signal: new AbortController().signal })
  const search = await invoke('project_memory_search', { query: 'anything at all here' })
  assert.equal(search.value.status, 'unavailable'); assert.equal(search.value.diagnostics.code, 'VAULT_MISSING')
  const status = (await invoke('project_memory_status', {})).value
  assert.equal(status.backend, 'markdown'); assert.equal(status.health, 'unavailable')
  assert.match(status.basic_memory, /not started by this plugin/)
  await assert.rejects(stat(join(dir, 'missing-vault')), { code: 'ENOENT' })
  await fiber.dispose()
  assert.equal(ctx.tools.get('project_memory_search'), undefined)
})

test('invalid local settings disable memory with a diagnostic while the plugin and team tools keep working', { timeout: 8000 }, async t => {
  const home = await isolateHome(t); crashCanary(t)
  await mkdir(join(home, '.local/share/dsh-memory-team'), { recursive: true })
  await writeFile(join(home, '.local/share/dsh-memory-team/settings.json'), '{ not json')
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'dsh-badconfig-')))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await mkdir(join(dir, '.git'))
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  ctx.provide('subagents', { listChildren: async () => [] })
  const harness = await mountAgentLoopTestHarness(ctx)
  const received = []
  class Adapter extends LlmAdapter {
    async *stream(options) { received.push(options); yield { type: 'block-start', index: 0, blockType: 'text' }; yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Done' } }; yield { type: 'finish', reason: { kind: 'stop' } } }
  }
  ctx.llm.registerAdapter(['test'], new Adapter())
  await ctx.plugin(plugin, { database: join(dir, 'memory.sqlite') })
  const agent = await harness.create('badconfig', { provider: 'test', model: 'test' }, { cwd: dir })
  const invoke = (name, args) => ctx.tools.execute({ callId: randomUUID(), name, arguments: args, agent, signal: new AbortController().signal })
  const status = (await invoke('project_memory_status', {})).value
  assert.deepEqual(status.configuration.problems, ['local settings file is not valid JSON'])
  assert.equal(status.health, 'unavailable'); assert.equal(status.health_diagnostics.code, 'CONFIGURATION_ERROR')
  assert.equal((await invoke('project_memory_save', { key: 'k', title: 'Title here', kind: 'fact', summary: 'A summary.', evidence: 'Evidence.', files: [] })).isError, true)
  agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Fix the login page layout.' }] }))
  await agent.whenIdle()
  const notice = received[0].messages.find(message => message.source?.kind === 'dsh-memory-team')
  assert.match(notice.content[0].text, /Project memory is unavailable \(CONFIGURATION_ERROR\)/)
  const last = Array.from({ length: agent.session.seq + 1 }, (_, i) => agent.session.eventAt(i)).filter(Boolean).at(-1)
  assert.equal(last.type, 'turn/end', 'the main task completes')
  assert(ctx.tools.get('team_start') && ctx.tools.get('workflow_status'))
})
