// Derived, rebuildable catalog of one project's Markdown notes in SQLite FTS5.
// It holds signatures, metadata and term strings only; note bodies stay in Markdown and are
// reread before anything is returned. ':memory:' gives the same behaviour without files.
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, chmodSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { matchExpression } from '../core/relevance.js'

export const CATALOG_VERSION = 1
const CANDIDATE_LIMIT = 200

export class MarkdownCatalog {
  /** identity: values that make cached rows invalid when they change (vault, project, scanner policy). */
  constructor(path, identity) {
    this.path = path; this.identity = JSON.stringify({ version: CATALOG_VERSION, ...identity })
    try { this.db = this.open() }
    catch (error) {
      if (path === ':memory:' || error.code === 'EACCES' || error.code === 'EPERM') throw error
      // A corrupt derived file is discarded; Markdown remains the source of truth.
      this.removeFiles()
      this.db = this.open()
      this.rebuilt = 'corrupt'
    }
  }

  open() {
    if (this.path !== ':memory:') mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    const db = new DatabaseSync(this.path)
    try {
      if (this.path !== ':memory:') chmodSync(this.path, 0o600)
      db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=DELETE;')
      db.exec(`CREATE TABLE IF NOT EXISTS meta(name TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS notes(id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, signature TEXT NOT NULL,
          state TEXT NOT NULL, key TEXT, title TEXT, kind TEXT, status TEXT, updated_at INTEGER, files TEXT);
        CREATE VIRTUAL TABLE IF NOT EXISTS note_terms USING fts5(title, body);`)
      const stored = db.prepare("SELECT value FROM meta WHERE name='identity'").get()?.value
      if (stored !== this.identity) {
        db.exec('BEGIN IMMEDIATE')
        try {
          db.exec("DELETE FROM notes; DELETE FROM note_terms; DELETE FROM meta;")
          db.prepare("INSERT INTO meta(name, value) VALUES('identity', ?)").run(this.identity)
          db.exec('COMMIT')
        } catch (error) { db.exec('ROLLBACK'); throw error }
        this.rebuilt ??= stored === undefined ? 'new' : 'identity-changed'
      }
      // A quick integrity probe so a damaged file is replaced instead of failing every search.
      db.prepare('SELECT count(*) AS n FROM note_terms').get()
      return db
    } catch (error) { db.close(); throw error }
  }

  removeFiles() { for (const suffix of ['', '-journal', '-wal', '-shm']) rmSync(`${this.path}${suffix}`, { force: true }) }

  close() { this.db?.close(); this.db = null }

  signatures() { return new Map(this.db.prepare('SELECT path, signature FROM notes').all().map(row => [row.path, row.signature])) }

  /**
   * Apply one reconciliation result atomically.
   * rows: { path, signature, state: 'indexed' | 'private' | 'foreign' | 'invalid', note? }
   */
  apply(rows, removed) {
    const db = this.db
    db.exec('BEGIN IMMEDIATE')
    try {
      const find = db.prepare('SELECT id FROM notes WHERE path=?')
      const dropTerms = db.prepare('DELETE FROM note_terms WHERE rowid=?')
      const drop = db.prepare('DELETE FROM notes WHERE path=?')
      for (const path of removed) { const row = find.get(path); if (row) dropTerms.run(row.id); drop.run(path) }
      const upsert = db.prepare(`INSERT INTO notes(path, signature, state, key, title, kind, status, updated_at, files) VALUES(?,?,?,?,?,?,?,?,?)
        ON CONFLICT(path) DO UPDATE SET signature=excluded.signature, state=excluded.state, key=excluded.key, title=excluded.title,
        kind=excluded.kind, status=excluded.status, updated_at=excluded.updated_at, files=excluded.files RETURNING id`)
      const addTerms = db.prepare('INSERT INTO note_terms(rowid, title, body) VALUES(?,?,?)')
      for (const { path, signature, state, note } of rows) {
        const previous = find.get(path)
        if (previous) dropTerms.run(previous.id)
        const indexed = state === 'indexed'
        const { id } = upsert.get(path, signature, state, indexed ? note.key : null, indexed ? note.title : null, indexed ? note.kind : null,
          indexed ? note.status : null, indexed ? note.updatedAt : null, indexed ? JSON.stringify(note.files) : null)
        if (indexed) addTerms.run(id, note.titleTerms.join(' '), note.bodyTerms.join(' '))
      }
      db.exec('COMMIT')
    } catch (error) { db.exec('ROLLBACK'); throw error }
  }

  #doc(row) {
    return { id: row.path, path: row.path, signature: row.signature, key: row.key, title: row.title, kind: row.kind, status: row.status, updatedAt: row.updated_at,
      titleTerms: new Set(row.tt ? row.tt.split(' ') : []), bodyTerms: new Set(row.bt ? row.bt.split(' ') : []) }
  }

  candidates(prepared) {
    const select = `SELECT n.path, n.signature, n.key, n.title, n.kind, n.status, n.updated_at, t.title AS tt, t.body AS bt FROM notes n JOIN note_terms t ON t.rowid=n.id`
    const expression = matchExpression(prepared)
    const docs = new Map()
    if (expression) for (const row of this.db.prepare(`${select} WHERE note_terms MATCH ? ORDER BY bm25(note_terms, 4.0, 1.0) LIMIT ${CANDIDATE_LIMIT}`).all(expression)) docs.set(row.path, this.#doc(row))
    const keys = [...prepared.keys].slice(0, 64)
    if (keys.length) for (const row of this.db.prepare(`${select} WHERE n.key IN (${keys.map(() => '?').join(',')})`).all(...keys)) docs.set(row.path, this.#doc(row))
    const count = this.db.prepare('SELECT count(*) AS n FROM note_terms WHERE note_terms MATCH ?')
    const df = new Map(prepared.terms.map(term => [term, count.get(matchExpression({ terms: [term] })).n]))
    return { docs: [...docs.values()], stats: { total: this.total(), df } }
  }

  recent(limit) {
    return this.db.prepare(`SELECT n.path, n.signature, n.key, n.title, n.kind, n.status, n.updated_at, t.title AS tt, t.body AS bt FROM notes n JOIN note_terms t ON t.rowid=n.id
      ORDER BY n.updated_at DESC, n.key LIMIT ?`).all(limit).map(row => this.#doc(row))
  }

  total() { return this.db.prepare("SELECT count(*) AS n FROM notes WHERE state='indexed'").get().n }

  counts() {
    return Object.fromEntries(this.db.prepare('SELECT state, count(*) AS n FROM notes GROUP BY state').all().map(row => [row.state, row.n]))
  }
}
