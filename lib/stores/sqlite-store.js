// Canonical SQLite store for projects without a vault. The schema and FTS row format are the
// 0.5.x format (user_version 1), so earlier versions can still read every record written here.
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, chmodSync } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'
import { terms } from '../core/text.js'
import { matchExpression } from '../core/relevance.js'

const CANDIDATE_LIMIT = 200

export class SqliteStore {
  constructor(path) {
    if (!isAbsolute(path)) throw new Error('Memory database path must be absolute')
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.kind = 'sqlite'; this.path = path
    this.db = new DatabaseSync(path)
    try {
      chmodSync(path, 0o600)
      this.db.exec('PRAGMA busy_timeout=3000; PRAGMA journal_mode=DELETE;')
      const version = this.db.prepare('PRAGMA user_version').get().user_version
      if (version > 1) throw new Error(`Unsupported memory database version ${version}`)
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS memories (
          id INTEGER PRIMARY KEY, project TEXT NOT NULL, key TEXT NOT NULL,
          revision INTEGER NOT NULL, title TEXT NOT NULL, kind TEXT NOT NULL,
          summary TEXT NOT NULL, evidence TEXT NOT NULL, files TEXT NOT NULL,
          source_session TEXT NOT NULL, updated_at INTEGER NOT NULL,
          UNIQUE(project, key)
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(title, body);
        PRAGMA user_version=1;
      `)
    } catch (error) { this.db.close(); throw error }
  }

  close() { this.db?.close(); this.db = null }

  #doc(row) {
    return { id: row.id, key: row.key, title: row.title, kind: row.kind, status: 'verified', updatedAt: row.updated_at,
      titleTerms: new Set(row.tt ? row.tt.split(' ') : []), bodyTerms: new Set(row.bt ? row.bt.split(' ') : []) }
  }

  async candidates(project, prepared) {
    const select = 'SELECT m.id, m.key, m.title, m.kind, m.updated_at, f.title AS tt, f.body AS bt FROM memory_fts f JOIN memories m ON m.id=f.rowid'
    const docs = new Map()
    const expression = matchExpression(prepared)
    if (expression) for (const row of this.db.prepare(`${select} WHERE memory_fts MATCH ? AND m.project=? ORDER BY bm25(memory_fts, 4.0, 1.0) LIMIT ${CANDIDATE_LIMIT}`).all(expression, project)) docs.set(row.id, this.#doc(row))
    const keys = [...prepared.keys].slice(0, 64)
    if (keys.length) for (const row of this.db.prepare(`${select} WHERE m.project=? AND m.key IN (${keys.map(() => '?').join(',')})`).all(project, ...keys)) docs.set(row.id, this.#doc(row))
    const count = this.db.prepare('SELECT count(*) AS n FROM memory_fts f JOIN memories m ON m.id=f.rowid WHERE memory_fts MATCH ? AND m.project=?')
    const df = new Map(prepared.terms.map(term => [term, count.get(matchExpression({ terms: [term] }), project).n]))
    const total = this.db.prepare('SELECT count(*) AS n FROM memories WHERE project=?').get(project).n
    return { docs: [...docs.values()], stats: { total, df }, diagnostics: { degraded: null } }
  }

  async recent(project, limit) {
    const rows = this.db.prepare(`SELECT m.id, m.key, m.title, m.kind, m.updated_at, f.title AS tt, f.body AS bt FROM memories m LEFT JOIN memory_fts f ON f.rowid=m.id
      WHERE m.project=? ORDER BY m.updated_at DESC, m.key LIMIT ?`).all(project, limit)
    return { docs: rows.map(row => this.#doc(row)), diagnostics: { degraded: null } }
  }

  async load(project, doc) {
    const row = this.db.prepare('SELECT m.*, f.title AS tt, f.body AS bt FROM memories m LEFT JOIN memory_fts f ON f.rowid=m.id WHERE m.id=? AND m.project=?').get(doc.id, project)
    if (!row) return null
    let files
    try { files = JSON.parse(row.files) } catch { files = [] }
    return { doc: this.#doc(row), record: { key: row.key, revision: row.revision, title: row.title, kind: row.kind, status: 'verified',
      summary: row.summary, evidence: row.evidence, source_session: row.source_session, updated_at: row.updated_at, files } }
  }

  async save(project, input, files, sourceSession) {
    const { key, title, kind, summary, evidence, expected } = input
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const old = this.db.prepare('SELECT id, revision FROM memories WHERE project=? AND key=?').get(project, key)
      if ((old?.revision ?? 0) !== expected) throw Object.assign(new Error(`Memory revision changed; search it again before replacing it (current ${old?.revision ?? 0})`), { code: 'REVISION_CONFLICT' })
      const updatedAt = Date.now()
      this.db.prepare(`INSERT INTO memories(project,key,revision,title,kind,summary,evidence,files,source_session,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(project,key) DO UPDATE SET
        revision=excluded.revision,title=excluded.title,kind=excluded.kind,summary=excluded.summary,
        evidence=excluded.evidence,files=excluded.files,source_session=excluded.source_session,updated_at=excluded.updated_at`)
        .run(project, key, expected + 1, title, kind, summary, evidence, JSON.stringify(files), sourceSession, updatedAt)
      const row = this.db.prepare('SELECT id FROM memories WHERE project=? AND key=?').get(project, key)
      this.db.prepare('DELETE FROM memory_fts WHERE rowid=?').run(row.id)
      // Same token format as 0.5.x so a rollback still finds these rows.
      this.db.prepare('INSERT INTO memory_fts(rowid,title,body) VALUES(?,?,?)').run(row.id, terms(`${key} ${title}`).join(' '), terms(`${summary} ${evidence}`).join(' '))
      this.db.exec('COMMIT')
      return { key, revision: expected + 1, updated_at: updatedAt, files }
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  async forget(project, key, revision) {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const row = this.db.prepare('SELECT id,revision FROM memories WHERE project=? AND key=?').get(project, key)
      if (!row || row.revision !== revision) throw Object.assign(new Error('Memory missing or revision changed; search it again'), { code: 'REVISION_CONFLICT' })
      this.db.prepare('DELETE FROM memory_fts WHERE rowid=?').run(row.id)
      this.db.prepare('DELETE FROM memories WHERE id=?').run(row.id)
      this.db.exec('COMMIT')
      return { forgotten: key }
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  status() { return { backend: 'sqlite', database: this.path } }
}
