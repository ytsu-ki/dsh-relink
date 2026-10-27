import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm, mkdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { DatabaseSync } from 'node:sqlite'
import { SecretScanner } from '../lib/core/secrets.js'
import { MemoryService } from '../lib/core/service.js'
import { SqliteStore } from '../lib/stores/sqlite-store.js'
import { MarkdownStore } from '../lib/stores/markdown-store.js'
import { encodeNote, scopeOf } from '../lib/stores/note.js'
import { extractTurn } from '../lib/dsh/capture.js'

async function fakeScanner(t, mode = 'normal') {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'dsh-secret-test-'))), command = join(dir, 'scanner.mjs')
  await writeFile(command, `
if (process.argv[2] === 'version') { process.stdout.write('1.9.0\\n'); process.exit(0) }
const args = process.argv.slice(2)
if (!args.includes('--validation=false') || !args.includes('--ignore-gitleaks-allow') || Object.keys(process.env).some(k => /BETTERLEAKS|GITLEAKS|TOKEN|PROXY/.test(k))) process.exit(8)
let input = ''; for await (const chunk of process.stdin) input += chunk
if (${JSON.stringify(mode)} === 'failure') { process.stderr.write(input); process.exit(2) }
if (${JSON.stringify(mode)} === 'hang') { setInterval(() => {}, 1000) }
else process.stdout.write(JSON.stringify(input.includes('SYNTHETIC_CREDENTIAL') ? [{ Secret: 'SYNTHETIC_CREDENTIAL' }] : []))
`, { mode: 0o700 })
  // The fixture runs through Node on every OS; production still executes the native binary without a shell.
  const scanner = new SecretScanner(command, {
    executeFile: (file, args, options) => promisify(execFile)(process.execPath, [file, ...args], options),
    spawnFile: (file, args, options) => spawn(process.execPath, [file, ...args], options),
  })
  const services = []
  t.after(async () => { for (const service of services) await service.close(); scanner.close(); await rm(dir, { recursive: true, force: true }) })
  return { dir, scanner, services }
}

test('scanner strips inherited config/credentials and redacts without corrupting JSON fields', async t => {
  const f = await fakeScanner(t)
  assert.equal(await f.scanner.sanitize('\u4e2d\u6587 SYNTHETIC_CREDENTIAL \u666e\u901a\u8bdd'), '\u4e2d\u6587 [credential omitted] \u666e\u901a\u8bdd')
  assert.deepEqual(await f.scanner.sanitizeObject({ summary: 'password=unreal-value', title: '\u4e2d\u6587 SYNTHETIC_CREDENTIAL' }),
    { summary: 'password=[credential omitted]', title: '\u4e2d\u6587 [credential omitted]' })
  const builtin = new SecretScanner()
  assert.deepEqual(await builtin.sanitizeObject({ prompt: 'api_key=private-value', reply: '\u6b63\u5e38\u4e2d\u6587\u3002' }),
    { prompt: 'api_key=[credential omitted]', reply: '\u6b63\u5e38\u4e2d\u6587\u3002' })
  builtin.close()
})

test('scanner startup diagnostics distinguish missing executables and unsupported versions without exposing paths', async t => {
  for (const [code, executeFile] of [
    ['SCANNER_NOT_FOUND', async () => { throw Object.assign(new Error('private path'), { code: 'ENOENT' }) }],
    ['SCANNER_VERSION_UNSUPPORTED', async () => ({ stdout: '0.0.0' })],
    ['SCANNER_BINARY_UNREADABLE', async () => ({ stdout: '1.9.0' })],
  ]) {
    const scanner = new SecretScanner('nonexistent-private-path', { executeFile })
    t.after(() => scanner.close())
    await assert.rejects(scanner.policy(), /memory withheld/)
    assert.equal(scanner.status, 'unavailable'); assert.equal(scanner.error, code)
  }
})

test('scanner failure withholds memory and never copies raw stderr into an error; cancellation kills the child', async t => {
  const failed = await fakeScanner(t, 'failure')
  await assert.rejects(failed.scanner.sanitize('SYNTHETIC_CREDENTIAL'), error => /memory withheld/.test(error.message) && !error.message.includes('SYNTHETIC_CREDENTIAL'))
  const hung = await fakeScanner(t, 'hang'), controller = new AbortController()
  await hung.scanner.policy()
  const waiting = hung.scanner.sanitize('SYNTHETIC_CREDENTIAL', controller.signal)
  setTimeout(() => controller.abort(new Error('cancel secret scan')), 50)
  await assert.rejects(waiting, /cancel secret scan/)
  assert.equal(hung.scanner.children.size, 0)
})

test('Markdown saves, external recall, the derived catalog and SQLite all screen credentials', async t => {
  const f = await fakeScanner(t), project = join(f.dir, 'project'), vault = join(f.dir, 'vault'), state = join(f.dir, 'state')
  await mkdir(project); await mkdir(vault)
  const markdown = new MemoryService({ scanner: f.scanner, sqlite: () => { throw new Error('unused') }, markdown: () => new MarkdownStore({ root: vault, stateDir: state, scanner: f.scanner }) })
  const sqlite = new MemoryService({ scanner: f.scanner, sqlite: () => new SqliteStore(join(f.dir, 'legacy.sqlite')) })
  f.services.push(markdown, sqlite)
  // "Chinese acceptance", "credential ..., keep the steps", "local fixture".
  const input = { key: 'sample', title: '\u4e2d\u6587\u9a8c\u6536', kind: 'fact', summary: '\u51ed\u636e SYNTHETIC_CREDENTIAL\uff0c\u4ecd\u4fdd\u7559\u6b65\u9aa4\u3002', evidence: '\u672c\u5730\u5939\u5177', files: [] }
  const saved = await markdown.save(project, input, 'session')
  assert(!(await readFile(saved.path, 'utf8')).includes('SYNTHETIC_CREDENTIAL'))
  await sqlite.save(project, input, 'session')
  assert(!JSON.stringify(await sqlite.search(project, '\u9a8c\u6536')).includes('SYNTHETIC_CREDENTIAL'))
  const external = join(vault, 'projects', scopeOf(project), 'facts', 'external.md')
  await writeFile(external, encodeNote({ title: '\u5916\u90e8\u51ed\u636e', dsh_key: 'external', dsh_project: project, dsh_status: 'verified',
    dsh_files: [], dsh_updated_at: Date.now() }, 'SYNTHETIC_CREDENTIAL \u8fd9\u90e8\u5206\u662f\u5916\u90e8\u7f16\u8f91\u3002'))
  const found = await markdown.search(project, 'external')
  assert.equal(found.records.length, 1); assert(!JSON.stringify(found).includes('SYNTHETIC_CREDENTIAL'))
  const db = new DatabaseSync(markdown.storeFor(project).status(project).catalog, { readOnly: true })
  t.after(() => db.close())
  assert(!JSON.stringify(db.prepare('SELECT * FROM note_terms').all()).toLowerCase().includes('synthetic_credential'))
})

test('a configured scanner that fails withholds recall and saves while reporting why', async t => {
  const f = await fakeScanner(t, 'failure'), project = join(f.dir, 'project'), vault = join(f.dir, 'vault')
  await mkdir(project); await mkdir(vault)
  const service = new MemoryService({ scanner: f.scanner, sqlite: () => new SqliteStore(join(f.dir, 'db.sqlite')), markdown: () => new MarkdownStore({ root: vault, stateDir: join(f.dir, 'state'), scanner: f.scanner }) })
  f.services.push(service)
  const folder = join(vault, 'projects', scopeOf(project), 'facts')
  await mkdir(folder, { recursive: true })
  await writeFile(join(folder, 'existing.md'), encodeNote({ title: 'Existing kestrel note', dsh_key: 'existing', dsh_project: project, dsh_status: 'verified', dsh_files: [], dsh_updated_at: Date.now() }, 'Existing kestrel evidence.'))
  const result = await service.search(project, 'existing kestrel note')
  assert.equal(result.status, 'withheld'); assert.equal(result.diagnostics.code, 'SCANNER_EXECUTION_FAILED')
  assert.deepEqual(result.records, [])
  await assert.rejects(service.save(project, { key: 'k', title: 'Title here', kind: 'fact', summary: 'A summary.', evidence: 'Evidence.', files: [] }, 's'), /withheld/)
  const missing = new SecretScanner(join(f.dir, 'missing-scanner'))
  t.after(() => missing.close())
  const unavailable = new MemoryService({ scanner: missing, sqlite: () => new SqliteStore(join(f.dir, 'other.sqlite')) })
  f.services.push(unavailable)
  const withheld = await unavailable.search(project, 'anything relevant here')
  assert.equal(withheld.status, 'withheld'); assert.equal(withheld.diagnostics.code, 'SCANNER_NOT_FOUND')
  assert.equal(missing.status, 'unavailable'); assert.equal(missing.error, 'SCANNER_NOT_FOUND')
})

test('real Betterleaks 1.9.0 detects synthetic AWS credentials and preserves ordinary Chinese evidence', {
  skip: !process.env.BETTERLEAKS_TEST_COMMAND && 'Set BETTERLEAKS_TEST_COMMAND for the real binary',
}, async t => {
  const scanner = new SecretScanner(process.env.BETTERLEAKS_TEST_COMMAND)
  t.after(() => scanner.close())
  // Build offline samples at runtime so publishing fixtures does not expose token-shaped literals.
  const key = 'AKIA' + 'Z7M3Q8N2R9T4W6Y5', sample = `\u90e8\u7f72\u8bb0\u5f55\uff1aAWS access key: ${key}\u3002\u53ea\u7528\u4e8e\u79bb\u7ebf\u5939\u5177\uff1b\u6ca1\u6709\u771f\u5b9e\u8d26\u53f7\u3002`
  const clean = await scanner.sanitize(sample)
  assert(!clean.includes(key)); assert.match(clean, /\u90e8\u7f72\u8bb0\u5f55/)
  const normal = '\u4e2d\u6587\u8ba2\u5355 20261020001234567890\uff1b\u9a8c\u6536 9 \u9879\u901a\u8fc7\uff1b\u7f13\u5b58 TTL 3000ms\u3002'
  assert.equal(await scanner.sanitize(normal), normal)
  const slack = ['xoxb', '123456789012', '1234567890123', 'abcdefghijklmnopqrstuvwxyz123456'].join('-')
  assert(!(await scanner.sanitize(`\u79bb\u7ebf\u683c\u5f0f\u6837\u4f8b\uff1a${slack}`)).includes(slack))

  const dir = await realpath(await mkdtemp(join(tmpdir(), 'dsh-secret-real-'))), project = join(dir, 'project')
  await mkdir(project)
  await mkdir(join(dir, 'vault'))
  const store = new MarkdownStore({ root: join(dir, 'vault'), stateDir: join(dir, 'state'), scanner })
  const service = new MemoryService({ scanner, sqlite: () => { throw new Error('unused') }, markdown: () => store })
  t.after(async () => { await service.close(); await rm(dir, { recursive: true, force: true }) })
  const events = [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: `\u79bb\u7ebf\u683c\u5f0f\u9a8c\u6536 ${key}` }] } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: `\u4ec5\u4f7f\u7528\u6837\u4f8b ${slack}\u3002\u6b63\u5e38\u4e2d\u6587\u9a8c\u6536\u6b65\u9aa4\u3002` }] } } },
  ]
  const turn = extractTurn({ header: { id: 'real-synthetic' }, eventAt: seq => events[seq] }, { seq: 3, time: Date.now(), data: { turn: 1, reason: { kind: 'completed' } } })
  await store.writeJournal(project, turn)
  const { records: found } = await service.search(project, '\u79bb\u7ebf\u683c\u5f0f\u9a8c\u6536')
  assert.equal(found.length, 1)
  const raw = await readFile(found[0].path, 'utf8')
  assert(!raw.includes(key) && !raw.includes(slack))
  assert(!JSON.stringify(found).includes(key) && !JSON.stringify(found).includes(slack))
  assert.match(raw, /\u6b63\u5e38\u4e2d\u6587\u9a8c\u6536\u6b65\u9aa4/)
})
