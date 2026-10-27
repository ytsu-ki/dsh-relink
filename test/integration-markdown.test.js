// End-to-end Markdown memory through the official agent loop: cold recall over an existing vault,
// automatic journals, external edits, isolation and outages. Basic Memory is not started by the
// plugin; with BASIC_MEMORY_TEST_COMMAND set, an independent Basic Memory indexes the same vault.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, realpath, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as plugin from '../lib/memory-team.js'
import { scopeOf, decodeNote, encodeNote } from '../lib/stores/note.js'
import { isolateHome, crashCanary } from './helpers.js'

const basicMemory = process.env.BASIC_MEMORY_TEST_COMMAND
async function eventually(check, message, timeoutMs = 10000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) { const value = await check(); if (value) return value; await delay(25) }
  assert.fail(message)
}
const recallOf = request => request.messages.filter(m => m.source?.kind === 'dsh-memory-team').map(m => m.content[0].text).join('\n')

async function setup(t, extra = {}) {
  await isolateHome(t); crashCanary(t)
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'dsh-md-e2e-')))
  const project = join(dir, 'project'), root = join(dir, 'vault'), state = join(dir, 'state')
  await mkdir(join(project, '.git'), { recursive: true }); await mkdir(root)
  const ctx = new Context()
  t.after(async () => { await ctx.fiber.dispose(); await rm(dir, { recursive: true, force: true }) })
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  ctx.provide('subagents', { listChildren: async () => [] })
  const harness = await mountAgentLoopTestHarness(ctx), requests = []
  let hold = null
  class Adapter extends LlmAdapter {
    async *stream(options) {
      requests.push(options)
      if (hold) { hold.resolve(); await delay(60000, undefined, { signal: options.signal }) }
      // "Checked the export focus; acceptance fixture complete."
      const text = '\u5bfc\u51fa\u5df2\u6838\u5bf9\u7126\u70b9\u3002\u9a8c\u6536\u5939\u5177\u5b8c\u6210\u3002'
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['test'], new Adapter())
  const config = { database: join(dir, 'sqlite.sqlite'), knowledgeRoot: root, knowledgeProject: '', basicMemoryCommand: '', basicMemoryConfig: state, betterleaksCommand: '', projectRoot: '', ...extra }
  let fiber = ctx.plugin(plugin, config); await fiber
  const create = (label, cwd = project) => harness.create(label, { provider: 'test', model: 'test' }, { cwd })
  const agent = await create('first')
  const invoke = async (name, args, a = agent) => (await ctx.tools.execute({ callId: randomUUID(), name, arguments: args, agent: a, signal: new AbortController().signal }))
  const run = async (a, text) => { a.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })); await a.whenIdle(); return requests.at(-1) }
  const reload = async override => { await fiber.dispose(); fiber = ctx.plugin(plugin, { ...config, ...override }); await fiber }
  return { dir, project, root, state, ctx, agent, create, invoke, run, reload, requests, holdNext: () => (hold = Promise.withResolvers()).promise, release: () => { hold = null } }
}

test('Markdown memory end to end: cold recall, journals, fresh sessions, external edits, isolation and outages', { timeout: 60000 }, async t => {
  const f = await setup(t)
  const facts = join(f.root, 'projects', scopeOf(f.project), 'facts')
  await mkdir(facts, { recursive: true })
  for (let i = 0; i < 106; i++) {
    const target = i === 105, key = `index-${String(i).padStart(3, '0')}`
    // Target: "cache generation reproduction" / "protect the in-flight cache generation with the entry identity".
    const title = target ? 'MVP_COMMON \u7f13\u5b58\u4ee3\u6b21\u590d\u73b0' : `Routine note ${i}`
    await writeFile(join(facts, `${key}.md`), encodeNote({ title, type: 'note', dsh_project: f.project, dsh_key: key, dsh_kind: 'fact', dsh_status: 'verified', dsh_updated_at: Date.now(), dsh_files: [] },
      `# ${title}\n\n${target ? '\u7528 entry \u8eab\u4efd\u4fdd\u62a4\u5728\u9014\u7f13\u5b58\u4ee3\u6b21\u3002' : `Routine content ${i}.`}`))
  }
  const cold = await f.run(f.agent, 'MVP_COMMON \u7f13\u5b58\u4ee3\u6b21\u590d\u73b0')
  assert.match(recallOf(cold), /\u7528 entry \u8eab\u4efd\u4fdd\u62a4/, 'the first task recalls from an unindexed vault without warmup')

  // "PDF export acceptance": "confirm browser focus before exporting".
  const saved = await f.invoke('project_memory_save', { key: 'export-focus', title: '\u8bba\u6587\u5bfc\u51fa\u9a8c\u6536', kind: 'pitfall',
    summary: '\u8bba\u6587\u5bfc\u51fa\u524d\u786e\u8ba4\u6d4f\u89c8\u5668\u7126\u70b9\u3002', evidence: '\u672c\u5730\u9a8c\u6536\u5939\u5177\u3002', files: [] })
  assert.equal(saved.isError, false, JSON.stringify(saved.content))
  assert.deepEqual((await f.invoke('project_memory_search', { query: '\u8bba\u6587\u5bfc\u51fa' })).value.records.map(r => r.key), ['export-focus'])

  await f.run(f.agent, '\u68c0\u67e5\u8bba\u6587\u5bfc\u51fa\u4e0e\u6d4f\u89c8\u5668\u7126\u70b9')
  const journalDir = join(f.root, 'projects', scopeOf(f.project), 'journal')
  const journals = await eventually(async () => { try { const files = await readdir(journalDir); return files.length >= 2 && files } catch { return null } }, 'task journals were not captured')
  for (const file of journals) {
    const journal = decodeNote(await readFile(join(journalDir, file), 'utf8'))
    assert.equal(journal.meta.dsh_status, 'completed'); assert.match(journal.body, /not been independently verified/)
  }
  const modelCalls = f.requests.length
  const fresh = await f.create('fresh')
  const recalled = recallOf(await f.run(fresh, '\u68c0\u67e5\u8bba\u6587\u5bfc\u51fa\u4e0e\u6d4f\u89c8\u5668\u7126\u70b9'))
  assert.match(recalled, /Verified findings:[\s\S]*\u786e\u8ba4\u6d4f\u89c8\u5668\u7126\u70b9/)
  assert(recalled.length <= 6000)
  assert.equal(f.requests.length, modelCalls + 1, 'capture and recall make no extra model call')

  const interrupted = await f.create('interrupted')
  const entered = f.holdNext()
  // "abort the acceptance fixture"
  interrupted.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '\u4e2d\u6b62\u9a8c\u6536\u5939\u5177' }] }))
  await entered; interrupted.cancel({ kind: 'user' }); await interrupted.whenIdle(); f.release()
  await eventually(async () => {
    for (const file of await readdir(journalDir)) {
      const note = decodeNote(await readFile(join(journalDir, file), 'utf8'))
      if (note.meta.dsh_source_session === interrupted.id) { assert.equal(note.meta.dsh_status, 'aborted'); return true }
    }
  }, 'the aborted turn was not recorded as aborted')

  const raw = await readFile(saved.value.path, 'utf8')
  // "export the paper after the zebra-strawberry acceptance" plus a marker.
  await writeFile(saved.value.path, raw.replace('\u8bba\u6587\u5bfc\u51fa\u524d\u786e\u8ba4\u6d4f\u89c8\u5668\u7126\u70b9\u3002', '\u8bba\u6587\u5bfc\u51fa\u5148\u6838\u5bf9\u6591\u9a6c\u8349\u8393\u9a8c\u6536 MVP_EDIT_MARKER\u3002'))
  const edited = (await f.invoke('project_memory_search', { query: 'MVP_EDIT_MARKER' })).value.records[0]
  assert.equal(edited.key, 'export-focus'); assert.notEqual(edited.revision, saved.value.revision)

  const other = join(f.dir, 'other'); await mkdir(join(other, '.git'), { recursive: true })
  const foreign = await f.create('foreign', other)
  assert.equal((await f.invoke('project_memory_save', { key: 'foreign-export', title: '\u8bba\u6587\u5bfc\u51fa OTHER_PROJECT_ONLY', kind: 'fact', summary: 'Another project record.', evidence: 'Isolation fixture.', files: [] }, foreign)).isError, false)
  assert.deepEqual((await f.invoke('project_memory_search', { query: '\u8bba\u6587\u5bfc\u51fa' }, foreign)).value.records.map(r => r.key), ['foreign-export'])
  assert.deepEqual((await f.invoke('project_memory_search', { query: 'OTHER_PROJECT_ONLY' })).value.records, [])

  // Vault outage: recall says so, and the task still completes.
  await rename(f.root, `${f.root}-offline`)
  const offline = await f.create('offline')
  assert.match(recallOf(await f.run(offline, '\u8bba\u6587\u5bfc\u51fa MVP_EDIT_MARKER')), /Project memory is unavailable \(VAULT_MISSING\)/)
  await rename(`${f.root}-offline`, f.root)

  // A configured scanner that is missing withholds memory but not the task.
  await f.reload({ betterleaksCommand: join(f.dir, 'missing-secret-scanner') })
  const scan = await f.create('scanner-outage')
  const withheld = recallOf(await f.run(scan, '\u8bba\u6587\u5bfc\u51fa MVP_EDIT_MARKER'))
  assert.match(withheld, /withheld \(SCANNER_NOT_FOUND\)/); assert(!withheld.includes('\u6591\u9a6c'))
  const events = Array.from({ length: scan.session.seq + 1 }, (_, i) => scan.session.eventAt(i)).filter(Boolean)
  assert.equal(events.at(-1).type, 'turn/end')

  // Restart: the catalog is reused and the first recall rereads nothing unchanged.
  await f.reload({})
  const restarted = await f.create('restarted')
  assert.match(recallOf(await f.run(restarted, '\u8bba\u6587\u5bfc\u51fa MVP_EDIT_MARKER')), /\u6591\u9a6c\u8349\u8393/)
  const status = (await f.invoke('project_memory_status', {}, restarted)).value
  assert.equal(status.backend, 'markdown'); assert.equal(status.catalog_mode, 'disk')
  assert.equal(status.catalog_rebuilt, null, 'the persisted catalog was reused, not rebuilt')
})

test('an independent Basic Memory 0.23.2 indexes the plugin vault without changing any note', {
  skip: !basicMemory && 'Set BASIC_MEMORY_TEST_COMMAND to a Basic Memory executable', timeout: 180000,
}, async t => {
  const f = await setup(t)
  const config = join(f.dir, 'bm-config'), home = join(f.dir, 'bm-home')
  await mkdir(config); await mkdir(home)
  await writeFile(join(config, 'config.json'), JSON.stringify({ default_project: 'dsh-knowledge', projects: { 'dsh-knowledge': { path: f.root, mode: 'local' } },
    semantic_search_enabled: false, reranker_enabled: false, auto_update: false, disable_permalinks: true, ensure_frontmatter_on_sync: false }))
  const saved = await f.invoke('project_memory_save', { key: 'bm-interop', title: 'Basic Memory interop wombat', kind: 'fact', summary: 'The vault stays readable by Basic Memory wombatmarker.', evidence: 'Interop fixture.', files: [] })
  await f.run(f.agent, 'Record a wombatmarker task journal.')
  await eventually(async () => (await readdir(join(f.root, 'projects', scopeOf(f.project), 'journal')).catch(() => [])).length === 1, 'journal not written')
  const snapshot = async () => {
    const files = {}
    const walk = async dir => { for (const entry of await readdir(dir, { withFileTypes: true })) { const path = join(dir, entry.name); if (entry.isDirectory()) await walk(path); else files[path] = createHash('sha256').update(await readFile(path)).digest('hex') } }
    await walk(f.root); return files
  }
  const before = await snapshot()
  const env = { ...process.env, HOME: home, BASIC_MEMORY_CONFIG_DIR: config, BASIC_MEMORY_FORCE_LOCAL: 'true', BASIC_MEMORY_SEMANTIC_SEARCH_ENABLED: 'false', BASIC_MEMORY_LOG_LEVEL: 'ERROR', HF_HUB_OFFLINE: '1', OTEL_SDK_DISABLED: 'true' }
  await promisify(execFile)(basicMemory, ['reindex', '--full', '--search', '--project', 'dsh-knowledge'], { env, timeout: 120000 })
  const { stdout } = await promisify(execFile)(basicMemory, ['tool', 'search-notes', 'wombatmarker', '--json', '--project', 'dsh-knowledge'], { env, timeout: 60000 })
  assert.match(stdout, /bm-interop/, 'Basic Memory finds the note written by the plugin')
  assert.deepEqual(await snapshot(), before, 'Basic Memory 0.23.2 with the documented settings rewrites no note')
  const record = (await f.invoke('project_memory_search', { query: 'bm-interop' })).value.records[0]
  assert.equal(record.revision, saved.value.revision)
})
