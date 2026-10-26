import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile, rename, realpath, stat, lstat, unlink, readdir } from 'node:fs/promises'
import { mkdirSync, realpathSync } from 'node:fs'
import { resolve, relative, isAbsolute, basename, dirname, sep } from 'node:path'
import { parse, stringify } from 'yaml'
import { keyOf, text, terms, fingerprint, assertNoObviousSecret, withAbort } from './memory.js'
import { SecretScanner, redact } from './secrets.js'
import { KnowledgeIndex } from './knowledge-index.js'
export { redact } from './secrets.js'

const digest = value => createHash('sha256').update(value).digest('hex')
const revisionOf = raw => Number.parseInt(digest(raw).slice(0, 12), 16) + 1
const stopWords = new Set(['\u65b0\u4f1a', '\u4f1a\u8bdd', '\u68c0\u67e5', '\u77e5\u8bc6', '\u8bc6\u5e93', '\u672c\u8f6e', '\u81ea\u52a8', '\u53ec\u56de', '\u9a8c\u8bc1', '\u7ecf\u9a8c', '\u8bb0\u5f55', '\u4efb\u52a1',
  '\u8bf7\u4ec5', '\u4f9d\u636e', '\u62a5\u544a', '\u5176\u4e2d', '\u660e\u786e', '\u533a\u5206', '\u4e0d\u8981', '\u8c03\u7528', '\u5de5\u5177', '\u6587\u4ef6', '\u6e90\u7801',
  'the', 'and', 'for', 'with', 'this', 'that', 'please', 'verified'])
const queryTerms = query => terms(query).filter(word => !stopWords.has(word)).slice(0, 96)
const normalized = value => value.normalize('NFKC').toLowerCase()
const queryKeys = query => [...new Set(normalized(query).match(/[a-z0-9][a-z0-9._-]{0,79}/g) ?? [])]
export const scopeOf = project => `${basename(project).replace(/[^\p{L}\p{N}._-]/gu, '-').slice(0, 50)}-${digest(project).slice(0, 12)}`
const inDirectory = (root, path) => { const p = relative(root, path); return p && p !== '..' && !p.startsWith(`..${sep}`) && !isAbsolute(p) }

export function encodeNote(meta, body) { return `---\n${stringify(meta).trimEnd()}\n---\n\n${body.trim()}\n` }
export function decodeNote(raw) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(raw)
  if (!match) throw new Error('Knowledge note has no YAML frontmatter')
  let meta
  try { meta = parse(match[1], { maxAliasCount: 0, prettyErrors: false }) }
  catch { throw new Error('Invalid knowledge note metadata') }
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) throw new Error('Invalid note metadata')
  return { meta, body: match[2].trim() }
}

/** One official Basic Memory MCP process; failures remain visible and recall can fail open. */
export class BasicMemoryClient {
  constructor({ command, configDir }) {
    this.client = new Client({ name: 'dsh-memory-team', version: '0.5.0' })
    this.transport = new StdioClientTransport({ command, args: ['mcp'], stderr: 'pipe', maxBufferSize: 2 * 1024 * 1024,
      env: { ...getDefaultEnvironment(), BASIC_MEMORY_CONFIG_DIR: configDir, BASIC_MEMORY_SEMANTIC_SEARCH_ENABLED: 'false', BASIC_MEMORY_FORCE_LOCAL: 'true', BASIC_MEMORY_LOG_LEVEL: 'ERROR', OTEL_SDK_DISABLED: 'true', HF_HUB_OFFLINE: '1' },
    })
    this.transport.stderr?.on('data', () => {}) // Keep upstream logs out of prompts and drain the pipe.
    this.status = 'starting'
    this.client.onclose = () => { if (this.status !== 'closed') this.status = 'unavailable' }
    this.ready = this.client.connect(this.transport, { timeout: 30000 }).then(() => { this.status = 'ready' }, async () => {
      this.status = 'unavailable'; await this.client.close().catch(() => {}); throw new Error('Basic Memory MCP startup failed')
    })
    this.ready.catch(() => {})
  }

  async search(project, query, signal) {
    await withAbort(this.ready, signal)
    if (this.status !== 'ready') throw new Error(`Basic Memory is ${this.status}; Markdown records remain available`)
    const tokens = queryTerms(query)
    if (query.trim() && !tokens.length) return []
    const hits = [], seen = new Set()
    // Metadata-filtered FTS scores can all be zero upstream; page before local ranking.
    for (let page = 1; ; page++) {
      signal?.throwIfAborted()
      const result = await this.client.callTool({ name: 'search_notes', arguments: {
        project: 'dsh-knowledge', query: tokens.join(' OR ') || undefined,
        search_type: 'text', output_format: 'json', page_size: 100, page, metadata_filters: { dsh_project: project },
      } }, undefined, { timeout: 2500, signal })
      if (result.isError) throw new Error('Basic Memory search failed')
      let payload = result.structuredContent
      if (!payload?.results) {
        try { payload = JSON.parse(result.content.filter(b => b.type === 'text').map(b => b.text).join('\n')) }
        catch { throw new Error('Basic Memory returned an invalid search response') }
      }
      if (!Array.isArray(payload.results)) throw new Error('Basic Memory returned no result list')
      const before = seen.size
      for (const hit of payload.results) {
        if (typeof hit.file_path !== 'string' || seen.has(hit.file_path)) continue
        seen.add(hit.file_path); hits.push(hit)
      }
      if (!payload.has_more) return hits
      if (seen.size === before) throw new Error('Basic Memory pagination made no progress')
    }
  }

  async close() { this.status = 'closed'; await this.client.close().catch(() => {}) }
}

export class KnowledgeStore {
  constructor(root, config, client, scanner = new SecretScanner()) {
    if (!isAbsolute(root)) throw new Error('knowledgeRoot must be absolute')
    mkdirSync(root, { recursive: true, mode: 0o700 })
    this.root = realpathSync(root); this.config = config; this.client = client; this.pending = new Map()
    this.scanner = scanner; this.indexes = new Map(); this.ownsScanner = arguments.length < 4
  }
  async close() {
    await Promise.allSettled([...this.indexes.values()].map(index => index.close()))
    this.indexes.clear()
    if (this.ownsScanner) this.scanner.close()
    await this.client.close()
  }
  indexFor(project) {
    if (!this.indexes.has(project)) this.indexes.set(project, new KnowledgeIndex(this, project))
    return this.indexes.get(project)
  }
  async notify(project, path) {
    const index = this.indexes.get(project)
    if (index) await index.refresh(path).catch(() => {})
  }
  async flush() { await Promise.allSettled([...this.pending.values()]) }
  folder(project) { return resolve(this.root, 'projects', scopeOf(project)) }

  serial(key, operation) {
    const task = (this.pending.get(key) ?? Promise.resolve()).catch(() => {}).then(operation)
    this.pending.set(key, task)
    task.finally(() => { if (this.pending.get(key) === task) this.pending.delete(key) }).catch(() => {})
    return task
  }

  async safePath(path) {
    await this.directory(dirname(path), false)
    if ((await lstat(path)).isSymbolicLink()) throw new Error('Knowledge files cannot be symbolic links')
    const root = await realpath(this.root), actual = await realpath(path)
    if (!inDirectory(root, actual) || !(await stat(actual)).isFile()) throw new Error('Knowledge file escaped the vault')
    return actual
  }

  async directory(path, create) {
    if (!inDirectory(this.root, path)) throw new Error('Knowledge path escaped the vault')
    let cursor = this.root
    for (const part of relative(this.root, path).split(sep)) {
      cursor = resolve(cursor, part)
      if (create) { try { await mkdir(cursor, { mode: 0o700 }) } catch (e) { if (e.code !== 'EEXIST') throw e } }
      const info = await lstat(cursor)
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Knowledge directories cannot be symbolic links')
    }
  }

  async writeNew(path, raw) {
    await this.directory(dirname(path), true)
    await writeFile(path, raw, { flag: 'wx', mode: 0o600 })
  }

  async save(project, input, sourceSession, signal) {
    const key = keyOf(input.key)
    let title = text(input.title, 'title', 160)
    let summary = text(input.summary, 'summary', 2000), evidence = text(input.evidence, 'evidence', 1000)
    if (!['fact', 'workflow', 'pitfall'].includes(input.kind)) throw new Error('Invalid memory kind')
    assertNoObviousSecret(`${title}\n${summary}\n${evidence}`)
    ;({ title, summary, evidence } = await this.scanner.sanitizeObject({ title, summary, evidence }, signal))
    if (!Array.isArray(input.files) || input.files.length > 6) throw new Error('files must contain at most 6 paths')
    const files = await Promise.all([...new Set(input.files)].map(f => fingerprint(project, text(f, 'file', 500))))
    const expected = input.expected_revision ?? 0
    if (!Number.isSafeInteger(expected) || expected < 0) throw new Error('Invalid expected_revision')
    const path = resolve(this.folder(project), 'facts', `${key}.md`)
    return this.serial(path, async () => {
      signal?.throwIfAborted()
      let old
      try { old = await readFile(await this.safePath(path), 'utf8') } catch (e) { if (e.code !== 'ENOENT') throw e }
      if ((old ? revisionOf(old) : 0) !== expected) throw new Error('Memory changed; search again before replacing it')
      const raw = await this.scanner.sanitize(encodeNote({ title, type: 'note', tags: ['dsh', 'verified'], dsh_project: project,
        dsh_key: key, dsh_kind: input.kind, dsh_status: 'verified', dsh_updated_at: Date.now(), dsh_files: files,
        dsh_source_session: sourceSession,
      }, `# ${title}\n\n## Conclusion\n${summary}\n\n## Evidence\n${evidence}\n\n## Search terms\n${terms(`${title} ${summary} ${evidence}`).join(' ')}`), signal)
      if (!old) await this.writeNew(path, raw)
      else {
        const history = resolve(this.config.basicMemoryConfig, 'history', `${Date.now()}-${randomUUID()}.md`)
        await mkdir(dirname(history), { recursive: true, mode: 0o700 })
        await writeFile(history, old, { flag: 'wx', mode: 0o600 })
        const temp = `${path}.${randomUUID()}.tmp`
        try {
          await writeFile(temp, raw, { flag: 'wx', mode: 0o600 })
          if (await readFile(path, 'utf8') !== old) throw new Error('Note was edited while saving; retry after searching')
          await rename(temp, path)
        } finally { await unlink(temp).catch(e => { if (e.code !== 'ENOENT') throw e }) }
      }
      await this.notify(project, path)
      return { key, revision: revisionOf(raw), files, path, updated_at: Date.now() }
    })
  }

  async readNotes(project, paths, signal) {
    const notes = await Promise.all(paths.map(async path => {
      signal?.throwIfAborted()
      try {
        if (!inDirectory(this.folder(project), path)) return null
        const safe = await this.safePath(path)
        if ((await stat(safe)).size > 100000) return null
        const raw = await readFile(safe, 'utf8')
        if (Buffer.byteLength(raw) > 100000) return null
        const { meta } = decodeNote(raw)
        if (meta.dsh_project !== project || meta.dsh_private === true || meta.dsh_private === 'true') return null
        return { raw, revision: revisionOf(raw) }
      } catch (e) {
        if (e.code === 'ENOENT' || /symbolic|escaped/.test(e.message)) return null
        throw e
      }
    }))
    // Batch cold indexing to avoid starting one scanner process per note.
    const pieces = []
    for (let start = 0; start < notes.length;) {
      let end = start, size = 0
      while (end < notes.length && size < 512000) size += Buffer.byteLength(notes[end++]?.raw ?? '') + 100
      const batch = notes.slice(start, end), separator = `\nDSH_BOUNDARY_${digest(batch.map(note => note?.raw ?? '').join('\n'))}\n`
      const clean = await this.scanner.sanitize(batch.map(note => note?.raw ?? '').join(separator), signal)
      const values = clean.split(separator)
      if (values.length !== batch.length) throw new Error('Secret scan changed note boundaries')
      pieces.push(...values); start = end
    }
    return pieces.map((raw, i) => {
      if (!notes[i]) return null
      this.scanner.remember(notes[i].raw, raw)
      return { ...decodeNote(raw), revision: notes[i].revision }
    })
  }

  rank(note, path, query, prepared) {
    const { meta, body, revision } = note
    const { keywords, keys, normalizedQuery } = prepared
    const title = normalized(String(meta.title ?? ''))
    // Keep legacy note separators readable without rewriting existing records.
    const searchable = normalized(body.split(/\r?\n## (?:Search terms|\u68c0\u7d22\u8bcd)\r?\n/)[0])
    const exactKey = keys.has(meta.dsh_key), exactTitle = title.length >= 4 && normalizedQuery.includes(title)
    const matched = keywords.filter(word => title.includes(word) || searchable.includes(word))
    if (query.trim() && !exactKey && !exactTitle && matched.length < Math.min(3, Math.ceil(keywords.length / 4))) return null
    if (query.trim() && !exactKey && !exactTitle && !matched.length) return null
    const score = matched.reduce((sum, word) => sum + (title.includes(word) ? 5 : 1), 0)
    return { key: meta.dsh_key ?? basename(path, '.md'), revision, title: redact(String(meta.title ?? basename(path))).slice(0, 160),
      kind: meta.dsh_kind ?? 'task-record', status: meta.dsh_status ?? 'unverified',
      summary: redact(body).slice(0, 2200), evidence: `Markdown: ${path}`, source_session: meta.dsh_source_session,
      updated_at: meta.dsh_updated_at, files: meta.dsh_files ?? [], path,
      rank: [Number(exactKey), Number(meta.dsh_status === 'verified'), Number(exactTitle), score, Number(meta.dsh_updated_at) || 0],
    }
  }

  async legacyCandidates(project, query, signal) {
    const hits = await this.client.search(project, query, signal), paths = new Set()
    const scope = this.folder(project)
    for (const hit of hits) {
      if (typeof hit.file_path !== 'string') continue
      const path = resolve(this.root, hit.file_path)
      if (inDirectory(scope, path)) paths.add(path)
    }
    for (const folder of ['facts', 'journal']) {
      const dir = resolve(scope, folder)
      try {
        await this.directory(dir, false)
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          if (entry.isFile() && entry.name.endsWith('.md')) paths.add(resolve(dir, entry.name))
        }
      } catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    const candidates = [], all = [...paths]
    for (let i = 0; i < all.length; i += 64) {
      const batch = all.slice(i, i + 64), notes = await this.readNotes(project, batch, signal)
      notes.forEach((note, j) => { if (note) candidates.push({ ...note, path: batch[j] }) })
    }
    return candidates
  }

  async search(project, query, { limit = 3, includeStale = false, signal } = {}) {
    if (typeof query !== 'string' || query.length > 4000) throw new Error('query must be at most 4000 characters')
    if (!Number.isInteger(limit) || limit < 1 || limit > 10) throw new Error('limit must be 1\u201310')
    let index = this.config.incrementalIndex === false ? null : this.indexFor(project)
    let precise = true
    const prepared = { keywords: queryTerms(query), keys: new Set(queryKeys(query)), normalizedQuery: normalized(query) }
    for (let attempt = 0; attempt < 3; attempt++) {
      signal?.throwIfAborted()
      let candidates, preciseOnly = false
      try {
        if (index) {
          const found = await index.candidates(query, signal, precise, [...prepared.keys])
          candidates = found.notes; preciseOnly = found.precise
        } else candidates = await this.legacyCandidates(project, query, signal)
      }
      catch (error) {
        signal?.throwIfAborted()
        if (!index) throw error
        index = null; candidates = await this.legacyCandidates(project, query, signal)
      }
      const ranked = candidates.map(note => this.rank(note, note.path, query, prepared)).filter(Boolean)
      ranked.sort((a, b) => {
        if (!query.trim()) return b.updated_at - a.updated_at || a.key.localeCompare(b.key)
        for (let i = 0; i < a.rank.length; i++) if (a.rank[i] !== b.rank[i]) return b.rank[i] - a.rank[i]
        return a.key.localeCompare(b.key)
      })
      const groups = query.trim() ? [ranked.filter(r => r.rank[0]), ranked.filter(r => r.rank[1] && r.rank[2]), ranked] : [ranked]
      let changed = false
      for (const group of groups) {
        const records = []
        for (const record of group) {
          signal?.throwIfAborted()
          // Re-read only ranked results: cached content never authorizes recall by itself.
          const [current] = await this.readNotes(project, [record.path], signal)
          if (index && (!current || current.revision !== record.revision)) {
            await withAbort(index.refresh(record.path), signal); changed = true; break
          }
          if (!current) continue
          const fresh = this.rank(current, record.path, query, prepared)
          if (!fresh) continue
          let stale = !Number.isFinite(Number(fresh.updated_at)) || Date.now() - Number(fresh.updated_at) > this.config.ttlDays * 86400000 ? 'expired' : null
          for (const file of fresh.files) {
            try { if ((await fingerprint(project, file.path)).sha256 !== file.sha256) stale = 'files-changed' }
            catch { stale = 'files-unavailable' }
          }
          if (stale && !includeStale) continue
          const { rank, ...value } = fresh
          records.push({ ...value, stale })
          if (records.length === limit) break
        }
        if (changed) break
        // One local scan covers all outgoing fields, including generated file paths.
        if (records.length) return this.scanner.sanitizeObject(records, signal)
      }
      if (!changed && preciseOnly) { precise = false; continue }
      if (!changed) return []
    }
    throw new Error('Knowledge notes changed repeatedly; retry recall')
  }

  async forget(project, key, revision) {
    keyOf(key)
    const path = resolve(this.folder(project), 'facts', `${key}.md`)
    return this.serial(path, async () => {
      const raw = await readFile(await this.safePath(path), 'utf8')
      if (revisionOf(raw) !== revision) throw new Error('Memory changed; search again')
      const backup = resolve(this.config.basicMemoryConfig, 'trash', `${Date.now()}-${randomUUID()}-${key}.md`)
      await mkdir(dirname(backup), { recursive: true, mode: 0o700 }); await rename(path, backup)
      await this.notify(project, path)
      return { forgotten: key, recoverable_at: backup }
    })
  }

  async capture(project, session, end) {
    if (session.header.origin === 'subagent' || (session.header.delegationDepth ?? 0) > 0) return
    const events = []
    for (let seq = end.seq - 1; seq >= 0; seq--) {
      const event = session.eventAt(seq)
      if (!event) continue
      if (event.type === 'turn/start' && event.data.turn === end.data.turn) break
      events.push(event)
    }
    events.reverse()
    let prompt = events.filter(e => e.type === 'user/message' && e.data.source?.kind === 'user')
      .flatMap(e => e.data.content).filter(b => b.type === 'text').map(b => b.text).join('\n')
    if (!prompt.trim()) return
    let reply = events.filter(e => e.type === 'assistant/message').map(e => e.data.message.content.filter(b => b.type === 'text').map(b => b.text).join('\n')).filter(Boolean).at(-1) ?? ''
    ;({ prompt, reply } = await this.scanner.sanitizeObject({ prompt, reply }))
    prompt = prompt.slice(0, 1000); reply = reply.slice(0, 6000)
    const status = end.data.reason?.kind ?? 'unknown'
    const tools = events.filter(e => e.type === 'tool/call').map(e => e.data.name)
    const title = redact(prompt.split('\n')[0]).slice(0, 100)
    const body = redact(`# ${title}\n\nTask status: ${status}. This task record has not been independently verified and must not be treated as verified evidence.\n\n## Request\n${prompt}\n\n## Final reply\n${reply.slice(0, 6000) || 'No final text reply.'}\n\n## Execution evidence\nTool calls: ${tools.length}; tools: ${[...new Set(tools)].join(', ') || 'none'}. Source session: ${session.header.id}; turn: ${end.data.turn}; end event: ${end.seq}.`)
    const path = resolve(this.folder(project), 'journal', `${digest(session.header.id).slice(0, 16)}-${end.data.turn}.md`)
    const raw = await this.scanner.sanitize(encodeNote({ title, type: 'note', tags: ['dsh', 'task-record', status], dsh_project: project,
      dsh_status: status, dsh_updated_at: end.time, dsh_source_session: session.header.id,
    }, `${body}\n\n## Search terms\n${terms(body).slice(0, 600).join(' ')}`))
    return this.serial(path, async () => {
      try { await this.writeNew(path, raw) } catch (e) { if (e.code !== 'EEXIST') throw e }
      await this.notify(project, path)
    })
  }
}
