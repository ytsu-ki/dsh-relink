// One behavioural contract, asserted identically against both canonical stores.
import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { BACKENDS, workspace, memoryService, fact, hanFact } from './helpers.js'

const age = async (service, backend, project, key, days) => {
  const updated = Date.now() - days * 86_400_000
  if (backend === 'sqlite') service.storeFor(project).db.prepare('UPDATE memories SET updated_at=? WHERE key=?').run(updated, key)
  else {
    const path = join(service.storeFor(project).folder(project), 'facts', `${key}.md`)
    await writeFile(path, (await readFile(path, 'utf8')).replace(/dsh_updated_at: \d+/, `dsh_updated_at: ${updated}`))
  }
}

for (const backend of BACKENDS) {
  test(`${backend}: relevant hits, correct no-hit decisions and Unicode queries`, async t => {
    const w = await workspace(t), service = memoryService(t, w, backend)
    await service.save(w.project, fact, 'session-a')
    await service.save(w.project, hanFact, 'session-a')
    const hit = await service.search(w.project, 'Why is the checkout button unclickable at 1440px with the cookie overlay?')
    assert.equal(hit.status, 'ok'); assert.equal(hit.records[0].key, 'viewport-check')
    assert.equal(hit.records[0].status, 'verified'); assert.equal(hit.records[0].source_session, 'session-a')
    // "acceptance" + "popup": Han query terms.
    assert.equal((await service.search(w.project, '\u9a8c\u6536\u5f39\u7a97')).records[0].key, 'han-viewport')
    for (const query of ['Please fix the failing test and run it again.', 'Write a haiku about autumn.', '\u8bf7\u5e2e\u6211\u68c0\u67e5\u8fd9\u4e2a\u6587\u4ef6', 'unrelatedXYZ']) {
      const miss = await service.search(w.project, query)
      assert.equal(miss.status, 'no-match', query); assert.deepEqual(miss.records, [], query)
    }
    assert.equal((await service.search(w.project, '" OR * NEAR(\u9a8c\u6536) --')).status, 'no-match', 'FTS syntax stays literal')
  })

  test(`${backend}: projects are isolated and exact keys or titles return only their record`, async t => {
    const w = await workspace(t), service = memoryService(t, w, backend)
    await service.save(w.project, fact, 's')
    await delay(5)
    await service.save(w.project, { ...fact, key: 'viewport-notes', title: 'Viewport notes', summary: 'General viewport overlay notes for 1440px checks.' }, 's')
    assert.deepEqual((await service.search(w.other, '1440px viewport overlay')).records, [])
    assert.deepEqual((await service.search(w.project, 'viewport-check')).records.map(r => r.key), ['viewport-check'])
    assert.deepEqual((await service.search(w.project, 'Recall "1440px viewport overlay" before checking.')).records.map(r => r.key), ['viewport-check'])
    const listed = await service.search(w.project, '')
    assert.deepEqual(listed.records.map(r => r.key), ['viewport-notes', 'viewport-check'], 'empty queries list newest first')
  })

  test(`${backend}: changed or missing evidence and expiry stop automatic recall but stay inspectable`, async t => {
    const w = await workspace(t), service = memoryService(t, w, backend)
    await writeFile(join(w.project, 'layout.js'), 'one')
    const saved = await service.save(w.project, { ...fact, files: ['layout.js'] }, 's')
    assert.equal(saved.files[0].path, 'layout.js')
    assert.equal((await service.search(w.project, 'viewport-check')).records.length, 1)
    await writeFile(join(w.project, 'layout.js'), 'two')
    assert.deepEqual((await service.search(w.project, 'viewport-check')).records, [])
    assert.equal((await service.search(w.project, 'viewport-check', { includeStale: true })).records[0].stale, 'files-changed')
    await service.save(w.project, { ...fact, files: [], expected_revision: saved.revision }, 's')
    await age(service, backend, w.project, fact.key, 31)
    assert.deepEqual((await service.search(w.project, 'viewport-check')).records, [])
    assert.equal((await service.search(w.project, 'viewport-check', { includeStale: true })).records[0].stale, 'expired')
    await assert.rejects(service.save(w.project, { ...fact, key: 'escape', files: ['../other/x'] }, 's'), /ENOENT|inside/)
  })

  test(`${backend}: revisions reject stale and concurrent replacement; deletion needs the current revision`, async t => {
    const w = await workspace(t), service = memoryService(t, w, backend)
    const first = await service.save(w.project, fact, 's')
    await assert.rejects(service.save(w.project, fact, 's'), /changed/, 'creating an existing key needs its revision')
    const outcomes = await Promise.allSettled(['first update', 'second update'].map(summary =>
      service.save(w.project, { ...fact, summary: `${summary} for the 1440px viewport overlay.`, expected_revision: first.revision }, 's')))
    assert.equal(outcomes.filter(o => o.status === 'fulfilled').length, 1)
    const current = outcomes.find(o => o.status === 'fulfilled').value
    await assert.rejects(service.forget(w.project, fact.key, first.revision), /changed|revision/)
    const removed = await service.forget(w.project, fact.key, current.revision)
    assert.equal(removed.forgotten, fact.key)
    if (backend === 'markdown') assert.match(await readFile(removed.recoverable_at, 'utf8'), /update for the 1440px/)
    assert.deepEqual((await service.search(w.project, '')).records, [])
  })

  test(`${backend}: separate processes cannot both replace the same revision`, async t => {
    const w = await workspace(t), service = memoryService(t, w, backend)
    const saved = await service.save(w.project, fact, 's')
    await service.close()
    const lib = new URL('../lib/', import.meta.url).href
    const child = `
      const { MemoryService } = await import(${JSON.stringify(lib + 'core/service.js')})
      const { SecretScanner } = await import(${JSON.stringify(lib + 'core/secrets.js')})
      const { SqliteStore } = await import(${JSON.stringify(lib + 'stores/sqlite-store.js')})
      const { MarkdownStore } = await import(${JSON.stringify(lib + 'stores/markdown-store.js')})
      const [backend, database, vault, state, project, revision, label] = process.argv.slice(1)
      const scanner = new SecretScanner()
      const service = new MemoryService({ scanner, sqlite: () => new SqliteStore(database), markdown: backend === 'markdown' ? () => new MarkdownStore({ root: vault, stateDir: state, scanner }) : null })
      try { await service.save(project, { ...${JSON.stringify(fact)}, summary: label + ' process update', expected_revision: Number(revision) }, label); console.log('SAVED') }
      catch (error) { console.log('REJECTED ' + error.message) }
      finally { await service.close() }`
    const run = label => promisify(execFile)(process.execPath, ['--input-type=module', '--eval', child, backend, w.database, w.vault, w.state, w.project, String(saved.revision), label], { cwd: fileURLToPath(new URL('..', import.meta.url)) })
    const results = await Promise.all(['alpha', 'beta', 'gamma'].map(run))
    const outcomes = results.map(r => r.stdout.trim())
    assert.equal(outcomes.filter(o => o === 'SAVED').length, 1, outcomes.join(' | '))
    assert.equal(outcomes.filter(o => o.startsWith('REJECTED')).length, 2)
  })

  test(`${backend}: validation bounds input and obvious credentials are rejected or redacted`, async t => {
    const w = await workspace(t), service = memoryService(t, w, backend)
    await assert.rejects(service.save(w.project, { ...fact, key: '../bad' }, 's'), /key/)
    await assert.rejects(service.save(w.project, { ...fact, summary: 'x'.repeat(2001) }, 's'), /2000/)
    await assert.rejects(service.save(w.project, { ...fact, kind: 'opinion' }, 's'), /kind/)
    await assert.rejects(service.save(w.project, { ...fact, files: Array.from({ length: 7 }, (_, i) => `f${i}`) }, 's'), /at most 6/)
    await assert.rejects(service.save(w.project, { ...fact, summary: 'api_key=supersecretcredential' }, 's'), /credential/)
    await assert.rejects(service.save(w.project, { ...fact, evidence: 'Authorization: Bearer abc1234567890' }, 's'), /credential/)
    await assert.rejects(service.forget(w.project, fact.key, 0), /positive/)
    await assert.rejects(service.search(w.project, 'x'.repeat(4001)), /4000/)
  })
}
