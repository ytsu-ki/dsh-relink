import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile, readdir, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { workspace, memoryService, fact, hanFact, cleanup } from './helpers.js'
import { encodeNote, decodeNote, scopeOf } from '../lib/stores/note.js'
import { redact } from '../lib/core/secrets.js'

const note = (w, key, body, meta = {}) => encodeNote({ title: key, dsh_key: key, dsh_project: w.project, dsh_updated_at: Date.now(),
  dsh_status: 'verified', dsh_kind: 'fact', dsh_files: [], ...meta }, body)
const put = async (w, folder, key, body, meta) => {
  const dir = join(w.vault, 'projects', scopeOf(w.project), folder)
  await mkdir(dir, { recursive: true })
  const path = join(dir, `${key}.md`)
  await writeFile(path, note(w, key, body, meta))
  return path
}

test('Markdown is canonical: the 0.5.x layout is kept and human edits change revisions', async t => {
  const w = await workspace(t), service = memoryService(t, w, 'markdown')
  const saved = await service.save(w.project, hanFact, 'session-a')
  assert.equal(saved.path, join(w.vault, 'projects', scopeOf(w.project), 'facts', 'han-viewport.md'))
  const raw = await readFile(saved.path, 'utf8'), parsed = decodeNote(raw)
  assert.deepEqual(Object.keys(parsed.meta), ['title', 'type', 'tags', 'dsh_project', 'dsh_key', 'dsh_kind', 'dsh_status', 'dsh_updated_at', 'dsh_files', 'dsh_source_session'])
  assert.match(raw, /## Conclusion\n[\s\S]*## Evidence\n[\s\S]*## Search terms\n/)
  const [record] = (await service.search(w.project, '\u9a8c\u6536\u5f39\u7a97')).records
  assert.equal(record.summary, hanFact.summary); assert.equal(record.evidence, hanFact.evidence); assert.equal(record.revision, saved.revision)
  // An Obsidian edit: "revised the steps in Obsidian" replaces the conclusion.
  await writeFile(saved.path, raw.replace(hanFact.summary, '\u5728 Obsidian \u4e2d\u4fee\u8ba2\u4e86\u9a8c\u6536\u5f39\u7a97\u6b65\u9aa4\u3002'))
  const edited = (await service.search(w.project, '\u9a8c\u6536\u5f39\u7a97')).records[0]
  assert.match(edited.summary, /Obsidian/); assert.notEqual(edited.revision, saved.revision)
  await assert.rejects(service.save(w.project, { ...hanFact, expected_revision: saved.revision }, 's'), /changed/)
  const replaced = await service.save(w.project, { ...hanFact, expected_revision: edited.revision }, 's')
  const history = await readdir(join(w.state, 'history'))
  assert.equal(history.length, 1, 'the replaced version is kept in history')
  assert.match(await readFile(join(w.state, 'history', history[0]), 'utf8'), /Obsidian/)
  assert.equal((await service.search(w.project, 'han-viewport')).records[0].revision, replaced.revision)
})

test('generated search terms are not evidence and earlier section headings stay readable', async t => {
  const w = await workspace(t), service = memoryService(t, w, 'markdown')
  // Headings written by earlier versions: "conclusion", "evidence", "search terms".
  await put(w, 'facts', 'legacy-headings', '# Legacy note\n\n## \u7ed3\u8bba\nVerified visible conclusion about rollback tokens.\n\n## \u8bc1\u636e\nOld evidence line.\n\n## \u68c0\u7d22\u8bcd\nindexonlymarker')
  await put(w, 'facts', 'english-headings', '# English\n\n## Conclusion\nAnother conclusion about rollback tokens.\n\n## Evidence\nNew evidence line.\n\n## Search terms\nindexonlymarker')
  assert.deepEqual((await service.search(w.project, 'indexonlymarker')).records, [])
  const found = await service.search(w.project, 'legacy-headings')
  assert.equal(found.records[0].summary, 'Verified visible conclusion about rollback tokens.')
  assert.equal(found.records[0].evidence, 'Old evidence line.')
})

test('private notes never enter results or the derived catalog, including notes that become private', async t => {
  const w = await workspace(t), service = memoryService(t, w, 'markdown')
  const secret = 'PRIVATE_MARKER_\u9690\u79c1\u4fe1\u606f'
  const path = await put(w, 'facts', 'public-note', 'Public quokka evidence for deployment.')
  await put(w, 'facts', 'private-note', `${secret} quokka`, { dsh_private: true })
  assert.deepEqual((await service.search(w.project, secret)).records, [])
  assert.equal((await service.search(w.project, 'public-note')).records[0].key, 'public-note')
  await writeFile(path, (await readFile(path, 'utf8')).replace('dsh_key: public-note', 'dsh_key: public-note\ndsh_private: true'))
  assert.deepEqual((await service.search(w.project, 'public-note')).records, [])
  assert.deepEqual((await service.search(w.project, 'public-note', { includeStale: true })).records, [])
  const status = service.storeFor(w.project).status(w.project)
  assert.deepEqual(status.catalog_counts, { private: 2 })
  const db = new DatabaseSync(status.catalog, { readOnly: true })
  cleanup(t, () => db.close())
  const dump = JSON.stringify([db.prepare('SELECT * FROM notes').all(), db.prepare('SELECT * FROM note_terms').all()])
  assert(!dump.includes('PRIVATE_MARKER') && !dump.includes('quokka') && !dump.includes('\u9690\u79c1'))
})

test('task journals are labelled unverified, capped in recall and outranked by verified findings', async t => {
  const w = await workspace(t), service = memoryService(t, w, 'markdown')
  const store = service.storeFor(w.project)
  const turn = (i, status, prompt) => ({ prompt, reply: 'Checked the export dialog focus.', status, tools: ['read_file', 'read_file', 'bash'], sessionId: 'session-a', turn: i, endSeq: 10 + i, time: Date.now() })
  for (const [i, status] of ['completed', 'failed', 'aborted'].entries()) {
    const first = await store.writeJournal(w.project, turn(i + 1, status, `Check the PDF export dialog focus api_key=private-secret-value ${status}`))
    const again = await store.writeJournal(w.project, turn(i + 1, status, `Check the PDF export dialog focus ${status}`))
    assert.equal(first.created, true); assert.equal(again.created, false, 'repeated end events do not duplicate journals')
  }
  const files = await readdir(join(store.folder(w.project), 'journal'))
  assert.equal(files.length, 3)
  for (const file of files) {
    const raw = await readFile(join(store.folder(w.project), 'journal', file), 'utf8')
    assert.match(raw, /not been independently verified/); assert(!raw.includes('private-secret-value'))
    assert.match(raw, /Tool calls: 3; tools: read_file, bash/)
  }
  const history = await service.search(w.project, 'PDF export dialog focus')
  assert(history.records.length >= 2 && history.records.every(r => r.kind === 'task-record' && r.status !== 'verified'))
  assert.equal((await service.search(w.project, 'PDF export dialog focus', { maxTaskRecords: 1 })).records.length, 1)
  await service.save(w.project, { ...fact, key: 'export-focus', title: 'PDF export dialog focus', summary: 'Focus the browser window before exporting the PDF so the dialog opens in front.', evidence: 'Export fixture passed after focusing.' }, 's')
  const mixed = await service.search(w.project, 'PDF export dialog focus')
  assert.equal(mixed.records[0].key, 'export-focus', 'verified findings outrank task history')
})

test('malformed notes, foreign projects and Basic Memory 0.24 permalink backfill do not break recall', async t => {
  const w = await workspace(t), service = memoryService(t, w, 'markdown')
  const folder = join(w.vault, 'projects', scopeOf(w.project))
  await mkdir(join(folder, 'facts'), { recursive: true })
  await writeFile(join(folder, 'README.md'), '# Notes without frontmatter\n\nwombat')
  await writeFile(join(folder, 'facts', 'broken.md'), '---\n: [unclosed\n---\nwombat')
  await put(w, 'facts', 'foreign', 'wombat migration evidence', { dsh_project: w.other })
  const path = await put(w, 'facts', 'wombat-migration', 'Wombat migration conclusion with evidence.')
  const result = await service.search(w.project, 'wombat migration')
  assert.equal(result.status, 'ok'); assert.deepEqual(result.records.map(r => r.key), ['wombat-migration'])
  assert.equal(result.diagnostics.invalid_notes, 2)
  const before = result.records[0].revision
  // Basic Memory 0.24 writes a permalink into frontmatter during scans.
  await writeFile(path, (await readFile(path, 'utf8')).replace('---\ntitle:', '---\npermalink: projects/wombat-migration\ntitle:'))
  const after = (await service.search(w.project, 'wombat migration')).records[0]
  assert.equal(after.key, 'wombat-migration'); assert.notEqual(after.revision, before)
})

test('vault symlinks cannot redirect notes, captures or facts outside the vault', async t => {
  const w = await workspace(t), service = memoryService(t, w, 'markdown')
  const outside = join(w.dir, 'outside')
  await mkdir(join(outside, 'facts'), { recursive: true })
  await writeFile(join(outside, 'facts', 'stolen.md'), note(w, 'stolen', 'FOREIGN_DATA escape'))
  await mkdir(join(w.vault, 'projects', scopeOf(w.project)), { recursive: true })
  await symlink(outside, join(w.vault, 'projects', scopeOf(w.project), 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
  assert.deepEqual((await service.search(w.project, 'FOREIGN_DATA')).records, [])
  const w2 = await workspace(t), service2 = memoryService(t, w2, 'markdown')
  await symlink(outside, join(w2.vault, 'projects'), process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(service2.save(w2.project, fact, 's'), /symbolic/)
  assert.deepEqual(await readdir(outside), ['facts'])
  assert.equal((await service2.search(w2.project, 'anything here')).status, 'no-match', 'nothing exists behind the link')
  await mkdir(join(outside, scopeOf(w2.project)))
  const escaped = await service2.search(w2.project, 'anything here')
  assert.equal(escaped.status, 'unavailable'); assert.equal(escaped.diagnostics.code, 'FOLDER_ESCAPED')
  assert.equal(redact('Authorization: Bearer abc1234567890'), 'Authorization=[credential omitted]')
  assert.equal(redact(redact('Authorization: Bearer abc1234567890')), 'Authorization=[credential omitted]')
})

test('turn extraction keeps request, final reply and tool names only; subagent turns are skipped', async () => {
  const { extractTurn } = await import('../lib/dsh/capture.js')
  const events = [
    { type: 'turn/start', data: { turn: 2 } },
    { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Check the export dialog' }] } },
    { type: 'user/message', data: { source: { kind: 'dsh-memory-team' }, content: [{ type: 'text', text: 'recalled context' }] } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'reasoning', text: 'hidden reasoning' }, { type: 'tool-call', name: 'read_file', arguments: 'private arguments' }] } } },
    { type: 'tool/call', data: { name: 'read_file', arguments: 'private arguments' } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Export dialog verified.' }] } } },
  ]
  const session = origin => ({ header: { id: 'session-x', origin }, eventAt: seq => events[seq] })
  const turn = extractTurn(session('user'), { seq: events.length, time: 5, data: { turn: 2, reason: { kind: 'completed' } } })
  assert.deepEqual(turn, { prompt: 'Check the export dialog', reply: 'Export dialog verified.', status: 'completed', tools: ['read_file'], sessionId: 'session-x', turn: 2, endSeq: events.length, time: 5 })
  assert(!JSON.stringify(turn).includes('hidden reasoning') && !JSON.stringify(turn).includes('private arguments') && !JSON.stringify(turn).includes('recalled context'))
  assert.equal(extractTurn(session('subagent'), { seq: events.length, time: 5, data: { turn: 2, reason: { kind: 'completed' } } }), null)
})
