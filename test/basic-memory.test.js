import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, symlink, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { BasicMemoryClient, KnowledgeStore, decodeNote, redact } from '../lib/basic-memory.js'

async function setup(t) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'dsh-knowledge-')))
  const project = join(dir, 'project'), other = join(dir, 'other'), root = join(dir, 'vault')
  await mkdir(project); await mkdir(other)
  const hits = []
  const store = new KnowledgeStore(root, { ttlDays: 30, basicMemoryConfig: join(dir, 'config') }, { search: async () => hits, close: async () => {} })
  t.after(async () => { await store.close(); await rm(dir, { recursive: true, force: true }) })
  return { dir, project, other, root, hits, store }
}
const fact = { key: 'export', title: '\u8bba\u6587\u5bfc\u51fa', kind: 'pitfall', summary: '\u5148\u786e\u8ba4\u5f53\u524d\u6d4f\u89c8\u5668\u548c\u9875\u9762\u3002', evidence: '\u9a8c\u6536\u5939\u5177\uff1a\u786e\u8ba4\u7a97\u53e3\u7126\u70b9\u3002', files: [] }

test('Markdown is canonical: human edits invalidate revisions; stale files and project isolation remain enforced', async t => {
  const f = await setup(t)
  await writeFile(join(f.project, 'source.js'), 'one')
  const saved = await f.store.save(f.project, { ...fact, files: ['source.js'] }, 'session-a')
  f.hits.push({ file_path: relative(f.root, saved.path) })
  f.hits.push({ file_path: relative(f.root, saved.path) })
  const found = await f.store.search(f.project, '\u8bba\u6587')
  assert.equal(found.length, 1)
  assert.deepEqual(await f.store.search(f.project, 'unrelated_marker'), [])
  assert.equal(found[0].status, 'verified')
  assert.match(found[0].summary, /\u786e\u8ba4\u5f53\u524d\u6d4f\u89c8\u5668/)
  assert.deepEqual(await f.store.search(f.other, '\u8bba\u6587'), [])
  const raw = await readFile(saved.path, 'utf8')
  await writeFile(saved.path, raw.replace('\u5148\u786e\u8ba4\u5f53\u524d\u6d4f\u89c8\u5668\u548c\u9875\u9762\u3002', '\u5728 Obsidian \u4e2d\u4fee\u8ba2\u4e86\u6b65\u9aa4\u3002'))
  assert.match((await f.store.search(f.project, '\u8bba\u6587'))[0].summary, /Obsidian/)
  await assert.rejects(f.store.save(f.project, { ...fact, expected_revision: saved.revision }, 'session-a'), /changed/)
  await writeFile(join(f.project, 'source.js'), 'two')
  assert.deepEqual(await f.store.search(f.project, '\u8bba\u6587'), [])
  assert.equal((await f.store.search(f.project, '\u8bba\u6587', { includeStale: true }))[0].stale, 'files-changed')
})

test('concurrent replacements conflict and deletion keeps a recoverable copy', async t => {
  const f = await setup(t)
  const saved = await f.store.save(f.project, fact, 'session-a')
  const outcomes = await Promise.allSettled(['first', 'second'].map(summary => f.store.save(f.project, { ...fact, summary, expected_revision: saved.revision }, 'session-a')))
  assert.equal(outcomes.filter(x => x.status === 'fulfilled').length, 1)
  const latest = outcomes.find(x => x.status === 'fulfilled').value
  const removed = await f.store.forget(f.project, fact.key, latest.revision)
  assert.match(await readFile(removed.recoverable_at, 'utf8'), /first|second/)
  await assert.rejects(readFile(saved.path), { code: 'ENOENT' })
})

test('English note sections exclude generated index terms and legacy separators remain readable', async t => {
  const f = await setup(t)
  for (const [i, heading] of ['Search terms', '\u68c0\u7d22\u8bcd'].entries()) {
    const saved = await f.store.save(f.project, { key: `format-${i}`, title: 'Note format fixture', kind: 'fact',
      summary: 'Verified visible body.', evidence: 'Local synthetic evidence.', files: [] }, 'format-test')
    const raw = await readFile(saved.path, 'utf8')
    assert.match(raw, /## Conclusion\n/)
    assert.match(raw, /## Evidence\n/)
    assert.match(raw, /## Search terms\n/)
    assert(!/[^\x00-\x7f]/.test(raw))
    const marker = `indexonlymarker${i}`
    await writeFile(saved.path, raw.replace(/## Search terms\n[\s\S]*$/, `## ${heading}\n${marker}\n`))
    assert.deepEqual(await f.store.search(f.project, marker), [], 'generated terms alone must not become evidence')
    assert((await f.store.search(f.project, 'Verified visible body')).some(record => record.key === `format-${i}`))
  }
})

test('capture records completed/failed/aborted tasks once, omits reasoning and arguments, and redacts credentials', async t => {
  const f = await setup(t)
  for (const [i, status] of ['completed', 'failed', 'aborted'].entries()) {
    const events = [
      { type: 'turn/start', data: { turn: i + 1 } },
      { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '\u68c0\u67e5\u8bba\u6587\u5bfc\u51fa api_key=private-secret-value' }] } },
      { type: 'assistant/message', data: { message: { content: [{ type: 'reasoning', text: 'hidden reasoning' }, { type: 'text', text: '\u68c0\u67e5\u9875\u9762\u540e\u7ed9\u51fa\u5bfc\u51fa\u6b65\u9aa4\u3002' }] } } },
      { type: 'tool/call', data: { name: 'read_image', arguments: 'private arguments' } },
    ]
    const session = { header: { id: 'session-a' }, eventAt: seq => events[seq] }
    const end = { seq: 4, time: Date.now(), data: { turn: i + 1, reason: { kind: status } } }
    await f.store.capture(f.project, session, end); await f.store.capture(f.project, session, end)
  }
  const dir = join(f.store.folder(f.project), 'journal'), files = await readdir(dir)
  assert.equal(files.length, 3)
  for (const file of files) {
    const raw = await readFile(join(dir, file), 'utf8'), parsed = decodeNote(raw)
    assert(['completed', 'failed', 'aborted'].includes(parsed.meta.dsh_status))
    assert.match(raw, /not been independently verified/)
    assert(!raw.includes('private-secret-value') && !raw.includes('hidden reasoning') && !raw.includes('private arguments'))
  }
})

test('vault symlinks cannot redirect captures or facts into another directory', async t => {
  const f = await setup(t)
  await symlink(f.other, join(f.root, 'projects'), process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(f.store.save(f.project, fact, 'session-a'), /symbolic/)
  assert.deepEqual(await readdir(f.other), [])
  await assert.rejects(f.store.save(f.project, { ...fact, summary: 'password=not-a-real-secret' }, 'session-a'), /credential/)
  await assert.rejects(f.store.save(f.project, { ...fact, summary: 'Authorization: Bearer abc1234567890' }, 'session-a'), /credential/)
  assert.equal(redact('Authorization=abc1234567890'), 'Authorization=[credential omitted]')
  assert.equal(redact('Authorization: Bearer abc1234567890'), 'Authorization=[credential omitted]')
  assert.equal(redact(redact('Authorization: Bearer abc1234567890')), 'Authorization=[credential omitted]')
})

test('zero-score index candidates are ranked before limiting; exact keys and titles beat noisy history', async t => {
  const f = await setup(t)
  for (let i = 0; i < 18; i++) {
    const saved = await f.store.save(f.project, { ...fact, key: `old-${i}`, title: `\u77e5\u8bc6\u8bb0\u5f55 ${i}`, summary: '\u77e5\u8bc6\u5e93\u68c0\u67e5\u7ecf\u9a8c\u3002', evidence: '\u65e7\u8bb0\u5f55\u3002' }, 'old')
    f.hits.push({ file_path: relative(f.root, saved.path), score: 0 })
  }
  const target = await f.store.save(f.project, { ...fact, key: 'online-cache-generation-20261020', title: '\u5f02\u6b65\u7f13\u5b58\u5931\u6548\u4e0e\u5728\u9014\u4ee3\u6b21\u4fdd\u62a4',
    summary: '\u7528\u5728\u9014 entry \u8eab\u4efd\u4fdd\u62a4\u5931\u6548\u4ee3\u6b21\uff1b\u6210\u529f\u540e\u5f00\u59cb TTL\u3002', evidence: 'node --test\uff1a9 \u9879\u901a\u8fc7\u3002' }, 'verified')
  f.hits.push({ file_path: relative(f.root, target.path), score: 0 })
  const boilerplate = await f.store.save(f.project, { ...fact, key: 'generic-recall', title: '\u81ea\u52a8\u53ec\u56de\u6761\u6570',
    summary: '\u8bfb\u53d6\u5df2\u9a8c\u8bc1\u7ecf\u9a8c\u7684\u4fee\u590d\u89c4\u5219\u548c\u9a8c\u6536\u9879\u6570\uff0c\u4fdd\u7559\u672c\u8f6e\u7684\u547d\u4ee4\u53ca\u6458\u8981\u3002', evidence: '\u901a\u7528\u89c4\u5219\uff0c\u975e\u7f13\u5b58\u95ee\u9898\u7ed3\u8bba\u3002' }, 'old')
  f.hits.push({ file_path: relative(f.root, boilerplate.path), score: 0 })
  const query = '\u65b0\u4f1a\u8bdd\u68c0\u67e5\u77e5\u8bc6\u5e93\uff1aonline-cache-generation-20261020 \u5f02\u6b65\u7f13\u5b58\u5931\u6548\u4e0e\u5728\u9014\u4ee3\u6b21\u4fdd\u62a4\u3002\u8bf7\u4ec5\u4f9d\u636e\u672c\u8f6e\u81ea\u52a8\u53ec\u56de\u7684\u5df2\u9a8c\u8bc1\u7ecf\u9a8c\uff0c\u62a5\u544a\u4fee\u590d\u89c4\u5219\u548c\u9a8c\u6536\u9879\u6570\uff0c\u4e0d\u8981\u8bfb\u53d6\u6587\u4ef6\u3002'
  const records = await f.store.search(f.project, query)
  assert.equal(records[0].key, 'online-cache-generation-20261020')
  assert.equal(records.length, 1, 'instruction words must not admit unrelated old notes')
  assert.equal((await f.store.search(f.project, '\u5f02\u6b65\u7f13\u5b58\u5931\u6548\u4e0e\u5728\u9014\u4ee3\u6b21\u4fdd\u62a4'))[0].key, records[0].key)
  f.hits.length = 0
  assert.equal((await f.store.search(f.project, 'online-cache-generation-20261020'))[0].key, records[0].key, 'exact keys work before index refresh')
  assert.deepEqual(await f.store.search(f.other, 'online-cache-generation-20261020'), [])
})

test('stale exact keys are excluded; verified evidence wins a relevance tie and empty queries list newest', async t => {
  const f = await setup(t)
  await writeFile(join(f.project, 'source.js'), 'one')
  const saved = await f.store.save(f.project, { ...fact, files: ['source.js'] }, 'verified')
  const history = join(f.store.folder(f.project), 'journal', 'history.md')
  await mkdir(join(f.store.folder(f.project), 'journal'))
  const raw = await readFile(saved.path, 'utf8')
  await writeFile(history, raw.replace('dsh_key: export', 'dsh_key: journal-export').replace('dsh_status: verified', 'dsh_status: aborted').replace(/dsh_updated_at: \d+/, `dsh_updated_at: ${Date.now() + 1000}`))
  f.hits.push({ file_path: relative(f.root, history) }, { file_path: relative(f.root, saved.path) })
  assert.equal((await f.store.search(f.project, '\u8bba\u6587\u5bfc\u51fa'))[0].status, 'verified')
  for (let i = 0; i < 4; i++) {
    const path = join(f.store.folder(f.project), 'journal', `repeated-${i}.md`)
    await writeFile(path, raw.replace('title: \u8bba\u6587\u5bfc\u51fa', 'title: \u68c0\u67e5\u8bba\u6587\u5bfc\u51fa\u4e0e\u6d4f\u89c8\u5668\u7126\u70b9').replace('dsh_key: export', `dsh_key: repeated-${i}`).replace('dsh_status: verified', 'dsh_status: completed'))
    f.hits.push({ file_path: relative(f.root, path) })
  }
  assert.equal((await f.store.search(f.project, '\u68c0\u67e5\u8bba\u6587\u5bfc\u51fa\u4e0e\u6d4f\u89c8\u5668\u7126\u70b9'))[0].status, 'verified', 'repeated journals must not crowd verified evidence out of automatic recall')
  assert.equal((await f.store.search(f.project, ''))[0].key, 'journal-export')
  await writeFile(join(f.project, 'source.js'), 'two')
  assert.deepEqual(await f.store.search(f.project, 'export'), [])
  assert.equal((await f.store.search(f.project, 'export', { includeStale: true }))[0].stale, 'files-changed')
})

test('MCP cold start awaits readiness, supports cancellation and pages beyond the first zero-score page', async () => {
  const ready = Promise.withResolvers(), calls = []
  const client = { status: 'starting', ready: ready.promise, client: { async callTool(request) {
    calls.push(request.arguments)
    const page = request.arguments.page
    return { structuredContent: { results: page === 1 ? Array.from({ length: 100 }, (_, i) => ({ file_path: `old-${i}.md`, score: 0 })) : [{ file_path: 'target.md', score: 0 }], has_more: page === 1 } }
  } } }
  const search = BasicMemoryClient.prototype.search.call(client, '/project', '\u7f13\u5b58\u4ee3\u6b21', new AbortController().signal)
  await Promise.resolve()
  assert.equal(calls.length, 0)
  client.status = 'ready'; ready.resolve()
  const hits = await search
  assert.equal(hits.length, 101)
  assert.equal(hits.at(-1).file_path, 'target.md')
  assert.deepEqual(calls.map(c => c.page), [1, 2])
  assert(calls.every(c => c.metadata_filters.dsh_project === '/project'))

  const controller = new AbortController()
  const waiting = BasicMemoryClient.prototype.search.call({ ...client, status: 'starting', ready: new Promise(() => {}) }, '/project', '\u7f13\u5b58', controller.signal)
  controller.abort(new Error('cancel cold start'))
  await assert.rejects(waiting, /cancel cold start/)
  assert.equal(calls.length, 2)
  const stuck = { ...client, client: { callTool: async () => ({ structuredContent: { results: [{ file_path: 'same.md' }], has_more: true } }) } }
  await assert.rejects(BasicMemoryClient.prototype.search.call(stuck, '/project', '\u7f13\u5b58'), /no progress/)
})
