// Canonical Markdown store for the configured vault. Reads reconcile a derived catalog with a
// metadata scan of the project folder; there are no watchers, timers or queues.
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile, rename, realpath, stat, lstat, unlink, readdir } from 'node:fs/promises'
import { resolve, relative, dirname, join, sep, isAbsolute } from 'node:path'
import { terms } from '../core/text.js'
import { delay, withAbort, SerialQueue } from '../core/async.js'
import { redact } from '../core/secrets.js'
import { MemoryUnavailable } from '../core/errors.js'
import { MarkdownCatalog } from './catalog.js'
import { encodeNote, decodeNote, describeNote, isPrivate, revisionOf, scopeOf } from './note.js'
import { withFileLock, moveFile } from './file-lock.js'

const MAX_NOTE_BYTES = 100_000
const STABLE_MS = 100
const STABLE_LIMIT_MS = 1000
const READ_BATCH = 64
const SCAN_BATCH_BYTES = 512_000
const digest = value => createHash('sha256').update(value).digest('hex')
const within = (root, path) => { const p = relative(root, path); return p && p !== '..' && !p.startsWith(`..${sep}`) && !isAbsolute(p) }
const signatureOf = info => [info.size, info.mtimeNs, info.ctimeNs, info.ino, info.dev].map(String).join(':')

export class MarkdownStore {
  /**
   * root: vault directory (must already exist). stateDir: history, trash, locks and catalogs.
   * catalog: 'disk' (persistent derived index) or 'memory' (no derived files).
   */
  constructor({ root, stateDir, scanner, catalog = 'disk' }) {
    if (!isAbsolute(root) || !isAbsolute(stateDir)) throw new Error('Knowledge paths must be absolute')
    this.kind = 'markdown'; this.root = root; this.stateDir = stateDir; this.scanner = scanner; this.catalogMode = catalog
    this.projects = new Map(); this.writes = new SerialQueue(); this.closed = false
    // Reconciliation is shared between callers, so it runs under the store's lifetime rather
    // than any one caller's cancellation signal.
    this.lifetime = new AbortController()
    // Signatures of notes this process wrote completely; they need no write-stability wait.
    this.written = new Map()
  }

  async remember(path) {
    const signature = await lstat(path, { bigint: true }).then(signatureOf, () => null)
    if (signature) { this.written.set(path, signature); if (this.written.size > 256) this.written.delete(this.written.keys().next().value) }
  }

  folder(project) { return resolve(this.root, 'projects', scopeOf(project)) }

  async vaultRoot() {
    try {
      const real = await realpath(this.root)
      if (!(await stat(real)).isDirectory()) throw Object.assign(new Error('not a directory'), { code: 'ENOTDIR' })
      return real
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') throw new MemoryUnavailable('Knowledge root is missing; restore it or update knowledgeRoot', 'VAULT_MISSING')
      throw new MemoryUnavailable(`Knowledge root is unreadable (${error.code ?? 'unknown'})`, 'VAULT_UNREADABLE')
    }
  }

  /** Per-project state: catalog plus the single in-flight reconciliation. Opened once per project. */
  async project(project, signal) {
    let state = this.projects.get(project)
    if (!state) {
      state = { clock: 0, running: null, catalog: null, degraded: null, last: null, opening: null }
      this.projects.set(project, state)
    }
    state.opening ??= this.openCatalog(project, state)
    // A failed open (for example an unavailable scanner) is retried by the next caller.
    state.opening.catch(() => { if (!state.catalog) state.opening = null })
    await withAbort(state.opening, signal)
    return state
  }

  async openCatalog(project, state) {
    const identity = { root: this.root, project, policy: await this.scanner.policy(this.lifetime.signal) }
    if (this.closed) throw new Error('Knowledge store closed')
    let catalog = null
    if (this.catalogMode === 'disk') {
      const path = resolve(this.stateDir, 'recall-index', `${digest(`${this.root}\n${project}`).slice(0, 32)}.sqlite`)
      try { catalog = new MarkdownCatalog(path, identity); state.degraded = null }
      catch (error) { state.degraded = `catalog-unavailable:${error.code ?? error.name}` }
    }
    state.catalog = catalog ?? new MarkdownCatalog(':memory:', identity)
    state.catalogPath = state.catalog.path
  }

  /** Reconcile once for every caller that arrived before the reconciliation started. */
  async sync(project, signal) {
    const state = await this.project(project, signal)
    const requested = ++state.clock
    while (true) {
      if (state.running && state.running.started >= requested) return withAbort(state.running.promise, signal)
      if (state.running) { await withAbort(state.running.promise.catch(() => {}), signal); continue }
      const started = ++state.clock
      const promise = this.reconcile(project, state, this.lifetime.signal)
      state.running = { started, promise }
      promise.then(() => {}, () => {}).finally(() => { if (state.running?.promise === promise) state.running = null })
      return withAbort(promise, signal)
    }
  }

  async scan(folder, root) {
    const files = []
    const walk = async dir => {
      let entries
      try { entries = await readdir(dir, { withFileTypes: true }) }
      catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return; throw error }
      const infos = await Promise.all(entries.map(async entry => {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) return { path, directory: true }
        if (!entry.isFile() || !entry.name.endsWith('.md')) return null
        try { return { path, info: await lstat(path, { bigint: true }) } }
        catch (error) { if (error.code === 'ENOENT') return null; throw error }
      }))
      for (const item of infos) {
        if (!item) continue
        if (item.directory) await walk(item.path)
        else if (item.info.isFile()) files.push({ path: item.path, signature: signatureOf(item.info), size: Number(item.info.size), mtimeMs: Number(item.info.mtimeNs / 1_000_000n) })
      }
    }
    // Symbolic links are never followed: `withFileTypes` reports them as links, not directories.
    const info = await lstat(folder).catch(error => { if (error.code === 'ENOENT') return null; throw error })
    if (!info) return files
    if (!info.isDirectory()) throw new MemoryUnavailable('Project knowledge folder is not a directory', 'FOLDER_INVALID')
    if (!within(root, await realpath(folder))) throw new MemoryUnavailable('Project knowledge folder escaped the vault', 'FOLDER_ESCAPED')
    await walk(folder)
    return files
  }

  async stable(file) {
    if (this.written.get(file.path) === file.signature) return file
    const started = Date.now()
    let current = file
    while (Date.now() - current.mtimeMs < STABLE_MS) {
      if (Date.now() - started > STABLE_LIMIT_MS) return null
      await delay(STABLE_MS)
      try {
        const info = await lstat(file.path, { bigint: true })
        const next = { ...file, signature: signatureOf(info), size: Number(info.size), mtimeMs: Number(info.mtimeNs / 1_000_000n) }
        if (!info.isFile()) return null
        if (next.signature === current.signature && Date.now() - next.mtimeMs >= STABLE_MS) return next
        current = next
      } catch { return null }
    }
    return current
  }

  async reconcile(project, state, signal) {
    const root = await this.vaultRoot()
    const folder = this.folder(project)
    const listing = await this.scan(folder, root)
    const known = state.catalog.signatures()
    const current = new Set(listing.map(file => file.path))
    const removed = [...known.keys()].filter(path => !current.has(path))
    const changed = listing.filter(file => known.get(file.path) !== file.signature)
    const diagnostics = { notes: listing.length, read: 0, removed: removed.length, unstable: 0, invalid: 0, oversized: 0 }
    const rows = []
    for (let start = 0; start < changed.length; start += READ_BATCH) {
      signal?.throwIfAborted()
      const batch = []
      for (const candidate of changed.slice(start, start + READ_BATCH)) {
        if (candidate.size > MAX_NOTE_BYTES) { diagnostics.oversized++; rows.push({ path: candidate.path, signature: candidate.signature, state: 'invalid' }); continue }
        const file = await this.stable(candidate)
        if (!file) { diagnostics.unstable++; removed.push(candidate.path); continue }
        batch.push(file)
      }
      const notes = await this.readMany(batch.map(file => file.path), signal)
      diagnostics.read += batch.length
      for (let i = 0; i < batch.length; i++) {
        const file = batch[i], note = notes[i]
        // A note that changed while it was read is excluded until a later read sees it stable.
        const after = await lstat(file.path, { bigint: true }).then(signatureOf, () => null)
        if (!note || after !== file.signature || note.signature !== file.signature) { diagnostics.unstable++; removed.push(file.path); continue }
        rows.push(this.row(project, folder, file, note, diagnostics))
      }
    }
    state.catalog.apply(rows, removed)
    state.last = { ...diagnostics, at: new Date().toISOString() }
    return state
  }

  row(project, folder, file, note, diagnostics) {
    if (note.error) { diagnostics.invalid++; return { path: file.path, signature: file.signature, state: 'invalid' } }
    if (isPrivate(note.meta)) return { path: file.path, signature: file.signature, state: 'private' }
    const described = describeNote(note, { project, relativePath: relative(folder, file.path), mtimeMs: file.mtimeMs })
    if (!described) return { path: file.path, signature: file.signature, state: 'foreign' }
    return { path: file.path, signature: file.signature, state: 'indexed', note: described }
  }

  /**
   * Read notes with their signatures and screen them for credentials in batches.
   * Returns { raw, meta, body, signature, revision } | { error } | null (missing) per path.
   */
  async readMany(paths, signal) {
    const raws = await Promise.all(paths.map(async path => {
      try {
        const before = await lstat(path, { bigint: true })
        if (!before.isFile() || before.size > BigInt(MAX_NOTE_BYTES)) return null
        const raw = await readFile(path, 'utf8')
        return { raw, signature: signatureOf(before) }
      } catch (error) { if (error.code === 'ENOENT' || error.code === 'EISDIR') return null; throw error }
    }))
    const cleaned = new Array(raws.length).fill(null)
    for (let start = 0; start < raws.length;) {
      let end = start, size = 0
      while (end < raws.length && size < SCAN_BATCH_BYTES) size += Buffer.byteLength(raws[end++]?.raw ?? '') + 100
      const batch = raws.slice(start, end).map(item => item?.raw ?? '')
      const separator = `\nDSH_BOUNDARY_${digest(batch.join('\n'))}\n`
      const values = (await this.scanner.sanitize(batch.join(separator), signal)).split(separator)
      if (values.length !== batch.length) throw new Error('Secret scan changed note boundaries')
      values.forEach((value, i) => { cleaned[start + i] = value; if (raws[start + i]) this.scanner.remember(raws[start + i].raw, value) })
      start = end
    }
    return raws.map((item, i) => {
      if (!item) return null
      try { return { ...decodeNote(cleaned[i]), signature: item.signature, revision: revisionOf(item.raw) } }
      catch (error) { if (error.code === 'NOTE_INVALID') return { error: error.code, signature: item.signature }; throw error }
    })
  }

  async candidates(project, prepared, { signal } = {}) {
    const state = await this.sync(project, signal)
    return { ...state.catalog.candidates(prepared), diagnostics: this.diagnostics(state) }
  }

  async recent(project, limit, { signal } = {}) {
    const state = await this.sync(project, signal)
    return { docs: state.catalog.recent(limit), diagnostics: this.diagnostics(state) }
  }

  diagnostics(state) {
    const last = state.last ?? {}
    return { degraded: state.degraded ?? (last.unstable ? 'unstable-notes' : null), unstable: last.unstable ?? 0, invalid: last.invalid ?? 0 }
  }

  /** Reread one catalogued note; the returned record never comes from cached content. */
  async load(project, doc, { signal } = {}) {
    const folder = this.folder(project)
    if (!within(folder, doc.path)) return null
    try {
      const actual = await realpath(doc.path)
      if (!within(await realpath(this.root), actual)) return null
    } catch (error) { if (error.code === 'ENOENT') return null; throw error }
    const [note] = await this.readMany([doc.path], signal)
    if (!note || note.error || isPrivate(note.meta)) return null
    // Only the version the reconciliation saw as stable may be returned.
    const after = await lstat(doc.path, { bigint: true }).then(signatureOf, () => null)
    if (doc.signature && (note.signature !== doc.signature || after !== doc.signature)) return null
    const info = await lstat(doc.path).catch(() => null)
    const described = describeNote(note, { project, relativePath: relative(folder, doc.path), mtimeMs: info?.mtimeMs ?? 0 })
    if (!described) return null
    const { parts } = described
    const summary = described.kind === 'task-record' || !parts.conclusion ? (parts.rest || parts.searchable) : parts.conclusion
    return {
      doc: { ...doc, key: described.key, title: described.title, kind: described.kind, status: described.status, updatedAt: described.updatedAt,
        titleTerms: new Set(described.titleTerms), bodyTerms: new Set(described.bodyTerms) },
      record: { key: described.key, revision: note.revision, title: redact(described.title).slice(0, 160), kind: described.kind, status: described.status,
        summary: redact(summary).slice(0, 2200), evidence: redact(parts.evidence || `Markdown note: ${relative(this.root, doc.path)}`).slice(0, 1000),
        source_session: described.sourceSession, updated_at: described.updatedAt, files: described.files, path: doc.path },
    }
  }

  lockFile(path) { return resolve(this.stateDir, 'locks', `${digest(path).slice(0, 32)}.lock`) }

  async directory(path, create) {
    const root = await this.vaultRoot()
    const target = resolve(root, relative(this.root, path))
    if (!within(root, target)) throw new Error('Knowledge path escaped the vault')
    let cursor = root
    for (const part of relative(root, target).split(sep)) {
      cursor = resolve(cursor, part)
      if (create) { try { await mkdir(cursor, { mode: 0o700 }) } catch (e) { if (e.code !== 'EEXIST') throw e } }
      const info = await lstat(cursor)
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Knowledge directories cannot be symbolic links')
    }
    return target
  }

  async readExisting(path) {
    try {
      const info = await lstat(path)
      if (info.isSymbolicLink() || !info.isFile()) throw new Error('Knowledge files cannot be symbolic links')
      return await readFile(path, 'utf8')
    } catch (error) { if (error.code === 'ENOENT') return null; throw error }
  }

  /** Writers of one note are serialized in-process and across processes; Markdown stays canonical. */
  exclusive(path, operation, signal) {
    return this.writes.run(path, async () => {
      await mkdir(resolve(this.stateDir, 'locks'), { recursive: true, mode: 0o700 })
      return withFileLock(this.lockFile(path), operation, { signal })
    })
  }

  async save(project, input, files, sourceSession, signal) {
    const { key, title, kind, summary, evidence, expected } = input
    const dir = await this.directory(resolve(this.folder(project), 'facts'), true)
    const path = resolve(dir, `${key}.md`)
    return this.exclusive(path, async () => {
      signal?.throwIfAborted()
      const old = await this.readExisting(path)
      if ((old ? revisionOf(old) : 0) !== expected) throw Object.assign(new Error(`Memory changed; search again before replacing it (current ${old ? revisionOf(old) : 0})`), { code: 'REVISION_CONFLICT' })
      const updatedAt = Date.now()
      const raw = await this.scanner.sanitize(encodeNote({ title, type: 'note', tags: ['dsh', 'verified'], dsh_project: project,
        dsh_key: key, dsh_kind: kind, dsh_status: 'verified', dsh_updated_at: updatedAt, dsh_files: files, dsh_source_session: sourceSession,
      }, `# ${title}\n\n## Conclusion\n${summary}\n\n## Evidence\n${evidence}\n\n## Search terms\n${terms(`${title} ${summary} ${evidence}`).join(' ')}`), signal)
      if (!old) {
        try { await writeFile(path, raw, { flag: 'wx', mode: 0o600 }) }
        catch (error) { if (error.code === 'EEXIST') throw Object.assign(new Error('Memory changed; search again before replacing it'), { code: 'REVISION_CONFLICT' }); throw error }
      } else {
        const history = resolve(this.stateDir, 'history', `${Date.now()}-${randomUUID()}.md`)
        await mkdir(dirname(history), { recursive: true, mode: 0o700 })
        await writeFile(history, old, { flag: 'wx', mode: 0o600 })
        const temp = `${path}.${randomUUID()}.tmp`
        try {
          await writeFile(temp, raw, { flag: 'wx', mode: 0o600 })
          // An external editor may have saved since the revision check.
          if (await readFile(path, 'utf8') !== old) throw Object.assign(new Error('Note was edited while saving; search again and retry'), { code: 'REVISION_CONFLICT' })
          await rename(temp, path)
        } finally { await unlink(temp).catch(e => { if (e.code !== 'ENOENT') throw e }) }
      }
      await this.remember(path)
      return { key, revision: revisionOf(raw), files, path, updated_at: updatedAt }
    }, signal)
  }

  async forget(project, key, revision, signal) {
    const path = resolve(this.folder(project), 'facts', `${key}.md`)
    await this.directory(dirname(path), false).catch(error => { if (error.code === 'ENOENT') throw new Error('Memory missing; search again'); throw error })
    return this.exclusive(path, async () => {
      const raw = await this.readExisting(path)
      if (raw === null) throw new Error('Memory missing; search again')
      if (revisionOf(raw) !== revision) throw Object.assign(new Error('Memory changed; search again'), { code: 'REVISION_CONFLICT' })
      const backup = resolve(this.stateDir, 'trash', `${Date.now()}-${randomUUID()}-${key}.md`)
      await mkdir(dirname(backup), { recursive: true, mode: 0o700 })
      await moveFile(path, backup)
      return { forgotten: key, recoverable_at: backup }
    }, signal)
  }

  /** Write one unverified task journal; repeated end events for the same turn are ignored. */
  async writeJournal(project, turn, signal) {
    let { prompt, reply } = await this.scanner.sanitizeObject({ prompt: turn.prompt, reply: turn.reply }, signal)
    prompt = prompt.slice(0, 1000); reply = reply.slice(0, 6000)
    const title = redact(prompt.split('\n')[0]).slice(0, 100)
    const tools = turn.tools
    const body = redact(`# ${title}\n\nTask status: ${turn.status}. This task record has not been independently verified and must not be treated as verified evidence.\n\n## Request\n${prompt}\n\n## Final reply\n${reply || 'No final text reply.'}\n\n## Execution evidence\nTool calls: ${tools.length}; tools: ${[...new Set(tools)].join(', ') || 'none'}. Source session: ${turn.sessionId}; turn: ${turn.turn}; end event: ${turn.endSeq}.`)
    const raw = await this.scanner.sanitize(encodeNote({ title, type: 'note', tags: ['dsh', 'task-record', turn.status], dsh_project: project,
      dsh_status: turn.status, dsh_updated_at: turn.time, dsh_source_session: turn.sessionId,
    }, `${body}\n\n## Search terms\n${terms(body).slice(0, 600).join(' ')}`), signal)
    const dir = await this.directory(resolve(this.folder(project), 'journal'), true)
    const path = resolve(dir, `${digest(turn.sessionId).slice(0, 16)}-${turn.turn}.md`)
    try { await writeFile(path, raw, { flag: 'wx', mode: 0o600 }); await this.remember(path); return { path, created: true } }
    catch (error) { if (error.code === 'EEXIST') return { path, created: false }; throw error }
  }

  status(project) {
    const state = this.projects.get(project)
    return { backend: 'markdown', vault: this.root, folder: this.folder(project), catalog: state?.catalogPath ?? null,
      catalog_mode: state?.catalog?.path === ':memory:' ? 'memory' : 'disk', catalog_rebuilt: state?.catalog?.rebuilt ?? null,
      catalog_counts: state?.catalog?.counts() ?? null, last_reconcile: state?.last ?? null, degraded: state?.degraded ?? null }
  }

  async close() {
    this.closed = true
    this.lifetime.abort(new Error('Knowledge store closed'))
    await this.writes.drain()
    for (const state of this.projects.values()) {
      await state.opening?.catch(() => {})
      await state.running?.promise.catch(() => {})
      state.catalog?.close()
    }
    this.projects.clear()
  }
}
