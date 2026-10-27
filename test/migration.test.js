// Upgrade and rollback: 0.5.x data is read in place, written data stays readable by 0.5.x, and
// derived index files can be inspected or removed without touching canonical data.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { workspace, memoryService, isolateHome, fact, cleanup } from './helpers.js'
import { terms } from '../lib/core/text.js'
import { encodeNote, scopeOf } from '../lib/stores/note.js'
import { recallProjection, recallMessage } from '../lib/dsh/recall.js'

const sha = async path => createHash('sha256').update(await readFile(path)).digest('hex')

/** The exact 0.5.x schema and row format, written without any current code. */
function legacyDatabase(path, project) {
  const db = new DatabaseSync(path)
  db.exec(`CREATE TABLE memories (id INTEGER PRIMARY KEY, project TEXT NOT NULL, key TEXT NOT NULL, revision INTEGER NOT NULL, title TEXT NOT NULL, kind TEXT NOT NULL,
    summary TEXT NOT NULL, evidence TEXT NOT NULL, files TEXT NOT NULL, source_session TEXT NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(project, key));
    CREATE VIRTUAL TABLE memory_fts USING fts5(title, body); PRAGMA user_version=1;`)
  const row = { key: 'legacy-cache', title: 'Legacy cache invalidation rule', summary: 'Invalidate the product cache after price imports.', evidence: 'Import job log from the 0.5.x era.' }
  const { lastInsertRowid } = db.prepare('INSERT INTO memories(project,key,revision,title,kind,summary,evidence,files,source_session,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(project, row.key, 3, row.title, 'fact', row.summary, row.evidence, '[]', 'old-session', Date.now())
  db.prepare('INSERT INTO memory_fts(rowid,title,body) VALUES(?,?,?)').run(lastInsertRowid, terms(`${row.key} ${row.title}`).join(' '), terms(`${row.summary} ${row.evidence}`).join(' '))
  db.close()
}

test('a 0.5.x SQLite database is used in place and new writes stay in the 0.5.x format', async t => {
  const w = await workspace(t)
  legacyDatabase(w.database, w.project)
  const service = memoryService(t, w, 'sqlite')
  const [legacy] = (await service.search(w.project, 'product cache invalidation after price imports')).records
  assert.equal(legacy.key, 'legacy-cache'); assert.equal(legacy.revision, 3)
  await service.save(w.project, { key: 'legacy-cache', title: 'Legacy cache invalidation rule', kind: 'fact', summary: 'Invalidate the product cache after price and stock imports.', evidence: 'Updated import job log.', files: [], expected_revision: 3 }, 'new-session')
  await service.save(w.project, fact, 'new-session')
  await service.close()
  const db = new DatabaseSync(w.database, { readOnly: true })
  cleanup(t, () => db.close())
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1)
  // The 0.5.x query: quoted legacy terms joined with OR over memory_fts.
  const legacyQuery = query => db.prepare('SELECT m.key FROM memory_fts f JOIN memories m ON m.id=f.rowid WHERE memory_fts MATCH ? AND m.project=?')
    .all(terms(query).map(term => `"${term}"`).join(' OR '), w.project).map(row => row.key)
  assert(legacyQuery('stock imports').includes('legacy-cache'))
  assert(legacyQuery('cookie overlay').includes('viewport-check'))
})

test('0.5.x Markdown notes and Orama snapshots are read and left untouched', async t => {
  const w = await workspace(t)
  const folder = join(w.vault, 'projects', scopeOf(w.project))
  await mkdir(join(folder, 'facts'), { recursive: true }); await mkdir(join(folder, 'journal'), { recursive: true })
  // A 0.5.x fact with the earlier escaped headings ("conclusion", "evidence", "search terms").
  const oldFact = join(folder, 'facts', 'old-fact.md')
  await writeFile(oldFact, encodeNote({ title: 'Old platypus deployment rule', type: 'note', tags: ['dsh', 'verified'], dsh_project: w.project, dsh_key: 'old-fact', dsh_kind: 'fact',
    dsh_status: 'verified', dsh_updated_at: Date.now(), dsh_files: [], dsh_source_session: 'old' }, '# Old platypus deployment rule\n\n## \u7ed3\u8bba\nDeploy platypus services after the schema check.\n\n## \u8bc1\u636e\nOld release log.\n\n## \u68c0\u7d22\u8bcd\nplatypus deploy'))
  const oldJournal = join(folder, 'journal', '0123456789abcdef-1.md')
  await writeFile(oldJournal, encodeNote({ title: 'Check platypus deployment', type: 'note', tags: ['dsh', 'task-record', 'completed'], dsh_project: w.project, dsh_status: 'completed', dsh_updated_at: Date.now(), dsh_source_session: 'old' },
    '# Check platypus deployment\n\nTask status: completed. This task record has not been independently verified and must not be treated as verified evidence.\n\n## Request\nCheck platypus deployment\n\n## Final reply\nDeployed platypus after the schema check.'))
  const snapshot = join(w.state, 'recall-index', `${'a'.repeat(32)}.json`)
  await mkdir(join(w.state, 'recall-index'), { recursive: true }); await writeFile(snapshot, '{"version":1,"entries":[]}')
  const hashes = await Promise.all([oldFact, oldJournal, snapshot].map(sha))
  const service = memoryService(t, w, 'markdown')
  const found = await service.search(w.project, 'platypus deployment schema check')
  assert.deepEqual(found.records.map(r => [r.key, r.status]), [['old-fact', 'verified'], ['0123456789abcdef-1', 'completed']])
  assert.equal(found.records[0].summary, 'Deploy platypus services after the schema check.')
  assert.deepEqual(await Promise.all([oldFact, oldJournal, snapshot].map(sha)), hashes, 'no 0.5.x file is rewritten')
})

test('recall messages persisted by 0.5.x sessions are superseded after the upgrade', () => {
  let state = recallProjection.init()
  state = recallProjection.apply(state, { type: 'user/message', seq: 4, data: { source: { kind: 'dsh-memory-team', form: 'context' }, content: [] } })
  assert.deepEqual(state.last, { digest: 'legacy', records: 1, status: 'ok' })
  const message = recallMessage({ project: '/p', result: { status: 'no-match', records: [], diagnostics: {} }, last: state.last, budget: 6000 })
  assert.match(message.text, /no matching current records/)
  state = recallProjection.apply(state, { type: 'compaction/end', seq: 5, data: {} })
  assert.equal(state.last, null, 'compaction forgets what was recalled')
  assert.equal(recallProjection.apply(state, { type: 'user/message', seq: 6, data: null }), state)
})

test('the migration helper reports data and removes only the derived files it is asked to', async t => {
  const home = await isolateHome(t), w = await workspace(t)
  legacyDatabase(w.database, w.project)
  const service = memoryService(t, w, 'markdown')
  await service.save(w.project, fact, 's'); await service.search(w.project, 'viewport-check'); await service.close()
  const snapshot = join(w.state, 'recall-index', `${'b'.repeat(32)}.json`)
  await writeFile(snapshot, '{}')
  const script = fileURLToPath(new URL('../scripts/migrate.mjs', import.meta.url))
  const run = async (...args) => JSON.parse((await promisify(execFile)(process.execPath, [script, '--state-dir', w.state, '--database', w.database, '--vault', w.vault, ...args], { env: { ...process.env, HOME: home } })).stdout)
  const report = await run()
  assert.equal(report.database.records, 1); assert.equal(report.database.user_version, 1)
  assert.deepEqual(report.vault.notes, { facts: 1, journal: 0 })
  assert.deepEqual(report.derived.legacy_snapshots, [snapshot]); assert.equal(report.derived.catalogs.length, 1)
  assert.deepEqual(report.removed, [])
  const cleaned = await run('--remove-legacy-snapshots')
  assert.deepEqual(cleaned.removed, [snapshot])
  assert.deepEqual((await readdir(join(w.state, 'recall-index'))).filter(name => name.endsWith('.json')), [])
  assert.equal((await run()).derived.catalogs.length, 1, 'catalogs stay unless explicitly removed')
  await run('--remove-catalogs')
  const reopened = memoryService(t, w, 'markdown')
  assert.equal((await reopened.search(w.project, 'viewport-check')).records[0].key, 'viewport-check', 'removed catalogs are rebuilt from Markdown')
})

const baseline = process.env.DSH_RELINK_BASELINE_ENTRY
test('rollback round trip with the real 0.5.3-beta.3 plugin on the same data', {
  skip: !baseline && 'Set DSH_RELINK_BASELINE_ENTRY to the dsh-memory-team 0.5.3-beta.3 lib/memory-team.js', timeout: 60000,
}, async t => {
  await isolateHome(t)
  const w = await workspace(t)
  const { mount } = await import('../bench/lib/harness.mjs')
  const mdProject = w.other
  const config = { database: w.database, knowledgeRoot: w.vault, knowledgeProject: mdProject, basicMemoryCommand: join(w.dir, 'no-basic-memory'), basicMemoryConfig: w.state, betterleaksCommand: '', projectRoot: '' }
  const current = pathToFileURL(fileURLToPath(new URL('../lib/memory-team.js', import.meta.url))).href
  const old = baseline.startsWith('file:') ? baseline : pathToFileURL(baseline).href
  const session = async (entry, cwd, steps) => { const bench = await mount({ entry, config, cwd }); try { return await steps(bench) } finally { await bench.dispose() } }
  const sqliteRecord = { key: 'rollback-sqlite', title: 'Rollback sqlite kingfisher', kind: 'fact', summary: 'Kingfisher rollback evidence in SQLite.', evidence: 'Round trip.', files: [] }
  const mdRecord = { key: 'rollback-markdown', title: 'Rollback markdown heron', kind: 'fact', summary: 'Heron rollback evidence in Markdown.', evidence: 'Round trip.', files: [] }
  await session(current, w.project, bench => bench.invoke('project_memory_save', sqliteRecord))
  await session(current, mdProject, bench => bench.invoke('project_memory_save', mdRecord))
  // Roll back: 0.5.3-beta.3 reads and updates what 0.6 wrote.
  const oldSqlite = await session(old, w.project, async bench => {
    const [record] = (await bench.invoke('project_memory_search', { query: 'kingfisher rollback' })).records
    await bench.invoke('project_memory_save', { ...sqliteRecord, summary: 'Kingfisher rollback evidence updated by 0.5.', expected_revision: record.revision })
    return record
  })
  assert.equal(oldSqlite.key, 'rollback-sqlite')
  const oldMarkdown = await session(old, mdProject, async bench => {
    const [record] = (await bench.invoke('project_memory_search', { query: 'heron rollback' })).records
    await bench.invoke('project_memory_save', { key: 'from-old', title: 'Old version egret', kind: 'fact', summary: 'Egret note written by 0.5.', evidence: 'Round trip.', files: [] })
    return record
  })
  assert.equal(oldMarkdown.key, 'rollback-markdown')
  // Upgrade again: 0.6 reads the 0.5 writes.
  const back = await session(current, w.project, async bench => (await bench.invoke('project_memory_search', { query: 'kingfisher rollback' })).records[0])
  assert.match(back.summary, /updated by 0\.5/); assert.equal(back.revision, 2)
  const egret = await session(current, mdProject, async bench => (await bench.invoke('project_memory_search', { query: 'egret note' })).records[0])
  assert.equal(egret.key, 'from-old')
})
