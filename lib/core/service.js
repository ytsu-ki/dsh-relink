// The host-independent memory service: routes a project to its canonical store and applies
// one search, save and forget contract to both stores.
import { prepareQuery, rank, assess } from './relevance.js'
import { validateSave, validateForget, fingerprint, staleness } from './records.js'
import { ScannerError } from './secrets.js'
import { MemoryUnavailable } from './errors.js'

export const STATUS = Object.freeze({ ok: 'ok', noMatch: 'no-match', degraded: 'degraded', withheld: 'withheld', unavailable: 'unavailable' })
const errorCode = error => /^[A-Z0-9_]+$/.test(String(error?.code ?? '')) ? error.code : error?.name === 'Error' ? 'UNEXPECTED' : String(error?.name ?? 'UNEXPECTED')

export class MemoryService {
  /**
   * sqlite / markdown: factories for the canonical stores, called on first use.
   * markdownProject: the only project routed to Markdown ('' routes every project).
   */
  constructor({ ttlDays = 30, scanner, sqlite, markdown = null, markdownProject = '', configurationError = null }) {
    Object.assign(this, { ttlDays, scanner, sqliteFactory: sqlite, markdownFactory: markdown, markdownProject, configurationError })
    this.stores = {}
  }

  usesMarkdown(project) { return Boolean(this.markdownFactory) && (!this.markdownProject || project === this.markdownProject) }

  storeFor(project) {
    if (this.configurationError) throw new MemoryUnavailable(`Project memory configuration is invalid: ${this.configurationError}`, 'CONFIGURATION_ERROR')
    const kind = this.usesMarkdown(project) ? 'markdown' : 'sqlite'
    if (!this.stores[kind]) {
      try { this.stores[kind] = (kind === 'markdown' ? this.markdownFactory : this.sqliteFactory)() }
      catch (error) {
        if (error instanceof MemoryUnavailable) throw error
        throw new MemoryUnavailable(`Project memory store cannot be opened (${errorCode(error)})`, kind === 'markdown' ? 'VAULT_UNAVAILABLE' : 'DATABASE_UNAVAILABLE')
      }
    }
    return this.stores[kind]
  }

  /**
   * Search one project. Never throws for store or scanner failures: the result says why memory is
   * missing, so an empty result is only ever reported as `no-match` when the stores are healthy.
   */
  async search(project, query, { limit = 3, includeStale = false, maxTaskRecords = Infinity, signal } = {}) {
    if (typeof query !== 'string' || query.length > 4000) throw new Error('query must be at most 4000 characters')
    if (!Number.isInteger(limit) || limit < 1 || limit > 10) throw new Error('limit must be 1\u201310')
    try {
      const store = this.storeFor(project)
      // A configured scanner that cannot start is reported even when no record would be scanned.
      await this.scanner.policy(signal)
      const prepared = prepareQuery(query)
      let ordered, stats, diagnostics
      if (prepared.empty) ({ docs: ordered, diagnostics } = await store.recent(project, 30, { signal }))
      else {
        const found = await store.candidates(project, prepared, { signal })
        ;({ stats, diagnostics } = found)
        ordered = rank(found.docs, prepared, stats).map(entry => entry.doc)
      }
      const records = []
      let history = 0
      for (const doc of ordered) {
        if (records.length >= limit) break
        signal?.throwIfAborted()
        const loaded = await store.load(project, doc, { signal })
        if (!loaded) continue
        // The catalog may predate an edit; the reread content must still be relevant.
        if (!prepared.empty && !assess(loaded.doc, prepared, stats).relevant) continue
        const stale = await staleness(loaded.record, project, { ttlDays: this.ttlDays })
        if (stale && !includeStale) continue
        if (loaded.record.status !== 'verified' && history++ >= maxTaskRecords) continue
        records.push({ ...loaded.record, stale })
      }
      const clean = records.length ? await this.scanner.sanitizeObject(records, signal) : []
      const degraded = diagnostics?.degraded ?? null
      return { status: degraded ? STATUS.degraded : clean.length ? STATUS.ok : STATUS.noMatch, records: clean,
        diagnostics: { backend: store.kind, ...(degraded ? { degraded } : {}), ...(diagnostics?.unstable ? { unstable_notes: diagnostics.unstable } : {}), ...(diagnostics?.invalid ? { invalid_notes: diagnostics.invalid } : {}) } }
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error
      if (error instanceof ScannerError) return { status: STATUS.withheld, records: [], diagnostics: { code: error.code, reason: 'configured secret scanner failed; memory withheld' } }
      if (error instanceof MemoryUnavailable) return { status: STATUS.unavailable, records: [], diagnostics: { code: error.code, reason: error.message } }
      return { status: STATUS.unavailable, records: [], diagnostics: { code: errorCode(error), reason: 'project memory store failed' } }
    }
  }

  async save(project, args, sourceSession, signal) {
    const input = validateSave(args)
    const store = this.storeFor(project)
    const clean = await this.scanner.sanitizeObject({ title: input.title, summary: input.summary, evidence: input.evidence }, signal)
    const files = await Promise.all(input.files.map(file => fingerprint(project, file)))
    signal?.throwIfAborted()
    return store.save(project, { ...input, ...clean }, files, sourceSession, signal)
  }

  async forget(project, key, revision, signal) {
    validateForget(key, revision)
    return this.storeFor(project).forget(project, key, revision, signal)
  }

  async close() {
    const stores = Object.values(this.stores)
    this.stores = {}
    await Promise.allSettled(stores.map(store => store.close()))
  }
}
