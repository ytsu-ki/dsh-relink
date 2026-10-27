// Filesystem acceptance for on-demand Markdown reconciliation: external edits, atomic and
// chunked writes, root and vault replacement, catalog recovery, handles and idle cost.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile, appendFile, rename, rm, unlink, readdir, stat } from 'node:fs/promises'
import { writeFileSync, utimesSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { workspace, memoryService, cleanup } from './helpers.js'
import { encodeNote, scopeOf } from '../lib/stores/note.js'
import { MarkdownStore } from '../lib/stores/markdown-store.js'
import { MarkdownCatalog } from '../lib/stores/catalog.js'

const note = (project, key, body) => encodeNote({ title: key, dsh_key: key, dsh_project: project, dsh_updated_at: Date.now(), dsh_status: 'verified', dsh_kind: 'fact', dsh_files: [] }, body)
async function fixture(t, { vault, ...options } = {}) {
  const base = await workspace(t, 'dsh-fs-')
  // `vault` moves the vault to a path relative to the workspace, away from the state directory.
  const w = vault ? { ...base, vault: join(base.dir, vault) } : base
  if (vault) await mkdir(w.vault, { recursive: true })
  const service = memoryService(t, w, 'markdown', options)
  const folder = join(w.vault, 'projects', scopeOf(w.project))
  const put = async (key, body, dir = folder) => { await mkdir(join(dir, 'facts'), { recursive: true }); const path = join(dir, 'facts', `${key}.md`); await writeFile(path, note(w.project, key, body)); return path }
  const keys = async query => (await service.search(w.project, query)).records.map(r => r.key)
  return { ...w, service, folder, put, keys, store: () => service.storeFor(w.project) }
}
const moveInOtherProcess = (from, to) => promisify(execFile)(process.execPath, ['--input-type=module', '--eval',
  "import { rename } from 'node:fs/promises'; await rename(process.argv[1], process.argv[2])", from, to], { timeout: 10000 })

test('external in-place edits, atomic saves, additions and deletions are visible on the next read', async t => {
  const f = await fixture(t)
  const path = await f.put('editable', 'Original zebra evidence.')
  assert.deepEqual(await f.keys('editable'), ['editable'])
  const raw = await readFile(path, 'utf8')
  await writeFile(path, raw.replace('Original zebra', 'Updated strawberry'))
  assert.deepEqual(await f.keys('updated strawberry evidence'), ['editable'], 'in-place edit without any watcher')
  await writeFile(`${path}.tmp`, raw.replace('Original zebra', 'Atomic kiwi')); await rename(`${path}.tmp`, path)
  assert.deepEqual(await f.keys('atomic kiwi evidence'), ['editable'])
  await f.put('added', 'Newly added panda evidence.')
  assert.deepEqual(await f.keys('newly added panda'), ['added'])
  await unlink(path)
  assert.deepEqual(await f.keys('editable'), [], 'deleted text is never recalled from the catalog')
  const last = f.store().status(f.project).last_reconcile
  assert.equal(last.removed, 1); assert.equal(last.read, 0)
})

test('chunked writes are never indexed or returned half-written', async t => {
  const f = await fixture(t)
  const path = await f.put('chunks', 'Stable original content.')
  await f.keys('chunks')
  const raw = await readFile(path, 'utf8')
  await writeFile(path, raw.replace('Stable original content.', 'writebegin'))
  let writing = true, partial = 0, searches = 0
  const writer = (async () => {
    for (let i = 0; i < 6; i++) { await delay(40); await appendFile(path, ` chunk${i}`) }
    await appendFile(path, ' writeend'); writing = false
  })()
  while (writing) {
    const [record] = (await f.service.search(f.project, 'chunks')).records
    searches++
    if (record && record.summary.includes('writebegin') && !record.summary.includes('writeend')) partial++
  }
  await writer
  assert.equal(partial, 0, 'no search may observe a partially written note')
  assert(searches >= 1)
  const [record] = (await f.service.search(f.project, 'chunks')).records
  assert.match(record.summary, /writebegin\s+chunk0 chunk1 chunk2 chunk3 chunk4 chunk5 writeend/)
})

test('a note changed while it is read is excluded instead of cached inconsistently', async t => {
  const f = await fixture(t)
  const path = await f.put('racing', 'Original racing content.')
  await f.keys('racing')
  await writeFile(path, (await readFile(path, 'utf8')).replace('Original racing', 'Intermediate racing'))
  const store = f.store(), read = store.readMany.bind(store)
  let mutate = true
  store.readMany = async (...args) => {
    const notes = await read(...args)
    if (mutate) { mutate = false; await writeFile(path, (await readFile(path, 'utf8')).replace('Intermediate racing', 'Final racing')) }
    return notes
  }
  const during = await f.service.search(f.project, 'racing content')
  assert(!JSON.stringify(during.records).includes('Intermediate'))
  assert.equal(store.status(f.project).last_reconcile.unstable, 1)
  assert.equal(during.status, 'degraded', 'an excluded note is reported, not hidden')
  assert.match((await f.service.search(f.project, 'racing content')).records[0].summary, /Final racing/)
})

test('root deletion, recreation and twenty cross-process directory replacements recover without watchers', async t => {
  const f = await fixture(t)
  await f.put('initial', 'Initial quokka evidence.')
  assert.deepEqual(await f.keys('initial quokka evidence'), ['initial'])
  await rm(f.folder, { recursive: true })
  assert.deepEqual(await f.keys('initial quokka evidence'), [])
  assert.equal((await f.service.search(f.project, 'initial')).status, 'no-match', 'a missing project folder is an empty project, not an error')
  await f.put('recreated', 'Recreated quokka evidence.')
  assert.deepEqual(await f.keys('recreated quokka evidence'), ['recreated'])
  let previous = 'recreated'
  for (let i = 0; i < 20; i++) {
    await moveInOtherProcess(f.folder, `${f.folder}-old-${i}`)
    await f.put(`passive-${i}`, `Replacement ${i} wallaby evidence.`)
    assert.deepEqual(await f.keys(`passive-${i}`), [`passive-${i}`])
    assert(!(await f.keys(previous)).includes(previous), `${previous} must disappear after replacement ${i}`)
    previous = `passive-${i}`
  }
})

test('moving the vault or an ancestor reports unavailable memory and never recreates the vault', async t => {
  // The catalog stays open in the state directory between reads, and Windows refuses to rename a
  // directory with an open file below it, so the moved ancestor holds only the vault.
  const f = await fixture(t, { vault: join('library', 'vault') })
  await f.put('vault-note', 'Vault move numbat evidence.')
  assert.deepEqual(await f.keys('vault-note'), ['vault-note'])
  await rename(f.vault, `${f.vault}-moved`)
  const moved = await f.service.search(f.project, 'vault-note')
  assert.equal(moved.status, 'unavailable'); assert.equal(moved.diagnostics.code, 'VAULT_MISSING')
  await assert.rejects(f.service.save(f.project, { key: 'new-note', title: 'New', kind: 'fact', summary: 'Summary text.', evidence: 'Evidence text.', files: [] }, 's'), /Knowledge root is missing/)
  await assert.rejects(stat(f.vault), { code: 'ENOENT' }, 'a missing vault is not silently recreated')
  await rename(`${f.vault}-moved`, f.vault)
  assert.deepEqual(await f.keys('vault-note'), ['vault-note'])
  // Move an ancestor of the vault.
  const ancestor = dirname(f.vault), parked = `${ancestor}-parked`
  await rename(ancestor, parked)
  cleanup(t, () => rename(parked, ancestor).catch(() => {}))
  assert.equal((await f.service.search(f.project, 'vault-note')).status, 'unavailable')
  await assert.rejects(stat(f.vault), { code: 'ENOENT' }, 'the vault is not recreated below a moved ancestor')
  await rename(parked, ancestor)
  assert.deepEqual(await f.keys('vault-note'), ['vault-note'])
})

test('warm restarts reuse the catalog, corrupt or unusable catalogs degrade safely, and memory mode writes no files', async t => {
  const f = await fixture(t)
  for (let i = 0; i < 30; i++) await f.put(`note-${i}`, `Routine note ${i} about module ${i}.`)
  await f.put('target', 'Distinctive echidna evidence.')
  assert.deepEqual(await f.keys('echidna'), ['target'])
  assert.equal(f.store().status(f.project).last_reconcile.read, 31)
  const catalog = f.store().status(f.project).catalog
  await f.service.close()
  const scanner = f.service.scanner
  const reopened = new MarkdownStore({ root: f.vault, stateDir: f.state, scanner })
  cleanup(t, () => reopened.close())
  await reopened.sync(f.project)
  assert.equal(reopened.status(f.project).last_reconcile.read, 0, 'a restart rereads no unchanged note')
  await reopened.close()
  writeFileSync(catalog, 'not a sqlite database')
  const repaired = new MarkdownStore({ root: f.vault, stateDir: f.state, scanner })
  cleanup(t, () => repaired.close())
  await repaired.sync(f.project)
  assert.equal(repaired.status(f.project).catalog_rebuilt, 'corrupt')
  assert.equal(repaired.status(f.project).last_reconcile.read, 31)
  await repaired.close()
  // A state directory that cannot hold the catalog falls back to an in-memory catalog.
  const blocked = join(f.dir, 'blocked-state')
  await writeFile(blocked, 'a file, not a directory')
  const { MemoryService } = await import('../lib/core/service.js')
  const degraded = new MemoryService({ scanner, sqlite: () => { throw new Error('unused') }, markdown: () => new MarkdownStore({ root: f.vault, stateDir: blocked, scanner }) })
  cleanup(t, () => degraded.close())
  const result = await degraded.search(f.project, 'echidna')
  assert.equal(result.status, 'degraded'); assert.match(result.diagnostics.degraded, /^catalog-unavailable/)
  assert.deepEqual(result.records.map(r => r.key), ['target'], 'degraded indexing still answers from Markdown')
  const memoryOnly = new MemoryService({ scanner, sqlite: () => { throw new Error('unused') }, markdown: () => new MarkdownStore({ root: f.vault, stateDir: join(f.dir, 'memory-state'), scanner, catalog: 'memory' }) })
  cleanup(t, () => memoryOnly.close())
  assert.equal((await memoryOnly.search(f.project, 'echidna')).status, 'ok')
  await assert.rejects(readdir(join(f.dir, 'memory-state', 'recall-index')), { code: 'ENOENT' })
})

test('concurrent reads share one reconciliation and leave no handles, timers or idle CPU behind', async t => {
  const f = await fixture(t)
  for (let i = 0; i < 50; i++) await f.put(`load-${i}`, `Load note ${i} for platypus checks.`)
  // Count resources by type; transient requests from earlier tests (e.g. CloseReq) may vanish.
  const census = () => process.getActiveResourcesInfo().reduce((counts, type) => ({ ...counts, [type]: (counts[type] ?? 0) + 1 }), {})
  const noneAdded = (now, then, message) => { for (const [type, count] of Object.entries(now)) assert(count <= (then[type] ?? 0), `${message}: ${type} ${then[type] ?? 0} -> ${count}`) }
  const before = census()
  const store = f.store(), reconcile = store.reconcile.bind(store)
  let runs = 0
  store.reconcile = (...args) => { runs++; return reconcile(...args) }
  await Promise.all(Array.from({ length: 12 }, () => f.service.search(f.project, 'platypus checks')))
  assert(runs <= 2, `12 concurrent reads used ${runs} reconciliations`)
  await delay(50)
  noneAdded(census(), before, 'searching leaves no watcher, timer or file handle active')
  const cpu = process.cpuUsage(), started = performance.now()
  await delay(1000)
  const used = process.cpuUsage(cpu)
  assert((used.user + used.system) / 1000 < 50, `idle CPU ${(used.user + used.system) / 1000}ms over ${Math.round(performance.now() - started)}ms`)
  await f.service.close()
  noneAdded(census(), before, 'closing leaves nothing behind')
})

test('a large project store reconciles incrementally', { timeout: 60000 }, async t => {
  const f = await fixture(t)
  await mkdir(join(f.folder, 'facts'), { recursive: true })
  for (let i = 0; i < 1500; i++) writeFileSync(join(f.folder, 'facts', `large-${i}.md`), note(f.project, `large-${i}`, `Routine large store note ${i} for module ${i % 97}.`))
  assert.deepEqual(await f.keys('large-1499'), ['large-1499'])
  assert.equal(f.store().status(f.project).last_reconcile.read, 1500)
  const started = performance.now()
  assert.deepEqual(await f.keys('large-42'), ['large-42'])
  const warm = performance.now() - started
  assert.equal(f.store().status(f.project).last_reconcile.read, 0)
  assert(warm < 1000, `warm search over 1,500 notes took ${warm.toFixed(1)}ms`)
  const path = join(f.folder, 'facts', 'large-7.md')
  await writeFile(path, (await readFile(path, 'utf8')).replace('Routine large store note 7', 'Edited large store note 7 with kookaburra'))
  assert.deepEqual(await f.keys('kookaburra'), ['large-7'])
  assert.equal(f.store().status(f.project).last_reconcile.read, 1)
})

test('a burst of freshly modified notes costs about one stability wait in total', { timeout: 30000 }, async t => {
  const f = await fixture(t)
  await mkdir(join(f.folder, 'facts'), { recursive: true })
  await f.keys('anything')
  // Like a checkout: many notes modified at once, all within the stability window.
  for (let i = 0; i < 120; i++) writeFileSync(join(f.folder, 'facts', `bulk-${i}.md`), note(f.project, `bulk-${i}`, `Bulk checkout note ${i} about the bandicoot module.`))
  const now = new Date()
  for (let i = 0; i < 120; i++) utimesSync(join(f.folder, 'facts', `bulk-${i}.md`), now, now)
  const started = performance.now()
  assert.deepEqual(await f.keys('bulk-77'), ['bulk-77'])
  const elapsed = performance.now() - started
  assert.equal(f.store().status(f.project).last_reconcile.read, 120)
  assert(elapsed < 2000, `120 freshly written notes took ${Math.round(elapsed)}ms`)
})

test('cancelling one caller does not fail other searches sharing the reconciliation', async t => {
  const f = await fixture(t)
  await f.put('shared-seed', 'Shared reconciliation seed about the quoll module.')
  await f.keys('shared-seed')
  const store = f.store(), reconcile = store.reconcile.bind(store), controller = new AbortController()
  const gate = Promise.withResolvers()
  let calls = 0
  store.reconcile = async (...args) => {
    const call = ++calls
    if (call === 1) await gate.promise
    if (call === 2) {
      // The second reconciliation is started by the cancellable caller and joined by the other one.
      await f.put('shared-new', 'Shared reconciliation newcomer about the quoll module.')
      controller.abort(new Error('user cancelled this turn'))
    }
    return reconcile(...args)
  }
  const first = f.service.search(f.project, 'shared-seed')
  await delay(10)
  const cancelled = f.service.search(f.project, 'quoll module', { signal: controller.signal }).then(() => 'resolved', error => error)
  const other = f.service.search(f.project, 'shared-new')
  await delay(10)
  gate.resolve()
  assert.equal((await first).status, 'ok')
  assert.match(String((await cancelled)?.message), /user cancelled/)
  const result = await other
  assert.equal(result.status, 'ok', JSON.stringify(result.diagnostics)); assert.deepEqual(result.records.map(r => r.key), ['shared-new'])
  assert.equal(calls, 2, 'the other caller joined the cancelled caller\'s reconciliation')
})

test('concurrent first use of a project opens one catalog', async t => {
  const f = await fixture(t)
  await f.put('race', 'Concurrent first use dunnart note.')
  const store = f.store()
  const opens = t.mock.method(MarkdownCatalog.prototype, 'open')
  await Promise.all(Array.from({ length: 8 }, () => store.sync(f.project)))
  assert.equal(opens.mock.callCount(), 1, 'one catalog connection per project')
  assert.equal(store.status(f.project).catalog_counts.indexed, 1)
})
