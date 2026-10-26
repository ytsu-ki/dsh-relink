import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, symlink, rm, stat, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore, projectRoot, projectScope, renderMemories } from '../lib/memory.js'

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-memory-test-'))
  const a = join(dir, 'a'), b = join(dir, 'b')
  await mkdir(a); await mkdir(b); await mkdir(join(a, '.git'))
  await writeFile(join(a, 'app.js'), 'version 1')
  const path = join(dir, 'db', 'memory.sqlite')
  const store = new MemoryStore(path), stores = [store]
  t.after(async () => { for (const instance of stores) instance.close(); await rm(dir, { recursive: true, force: true }) })
  const record = { key: 'viewport-check', title: '1440px \u9a8c\u6536\u906e\u6321', kind: 'pitfall', summary: '\u9a8c\u6536\u524d\u5173\u95ed\u5f39\u7a97\uff0c\u518d\u6d4b1440px\u89c6\u53e3\u3002', evidence: '\u672c\u5730\u9a8c\u6536\u6d4b\u8bd5\u786e\u8ba4\u5f39\u7a97\u8986\u76d6\u6309\u94ae\u3002', files: ['app.js'] }
  return { dir, a: await projectRoot(a), b: await projectRoot(b), store, stores, path, record }
}

test('memory persists, searches Chinese/English and isolates projects', async t => {
  const f = await fixture(t)
  await f.store.save(f.a, f.record, 'source-session')
  assert.equal((await f.store.search(f.a, '\u9a8c\u6536')).length, 1)
  assert.equal((await f.store.search(f.a, '1440px'))[0].source_session, 'source-session')
  assert.deepEqual(await f.store.search(f.b, '1440px'), [])
  assert.deepEqual(await f.store.search(f.a, 'unrelatedXYZ'), [])
  const another = new MemoryStore(f.path)
  assert.equal((await another.search(f.a, '\u5f39\u7a97'))[0].revision, 1)
  another.close()
  if (process.platform !== 'win32') assert.equal((await stat(f.path)).mode & 0o777, 0o600)
})

test('file changes and TTL invalidate automatic recall, but remain inspectable', async t => {
  const f = await fixture(t)
  await f.store.save(f.a, f.record, 'source')
  await writeFile(join(f.a, 'app.js'), 'version 2')
  assert.deepEqual(await f.store.search(f.a, '\u9a8c\u6536'), [])
  assert.equal((await f.store.search(f.a, '\u9a8c\u6536', { includeStale: true }))[0].stale, 'files-changed')
  await f.store.save(f.a, { ...f.record, expected_revision: 1 }, 'new-source')
  f.store.db.prepare('UPDATE memories SET updated_at=?').run(Date.now() - 31 * 86400000)
  assert.deepEqual(await f.store.search(f.a, '\u9a8c\u6536'), [])
  assert.equal((await f.store.search(f.a, '\u9a8c\u6536', { includeStale: true }))[0].stale, 'expired')
})

test('optimistic revisions reject concurrent replacement and protect deletion', async t => {
  const f = await fixture(t)
  await f.store.save(f.a, f.record, 'source')
  const second = new MemoryStore(f.path)
  f.stores.push(second)
  const results = await Promise.allSettled([
    f.store.save(f.a, { ...f.record, expected_revision: 1, summary: 'First updated conclusion' }, 'one'),
    second.save(f.a, { ...f.record, expected_revision: 1, summary: 'Second updated conclusion' }, 'two'),
  ])
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
  assert.equal((await f.store.search(f.a, ''))[0].revision, 2)
  assert.throws(() => f.store.forget(f.a, f.record.key, 1), /revision/)
  f.store.forget(f.a, f.record.key, 2)
  assert.deepEqual(await f.store.search(f.a, ''), [])
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM memory_fts').get().n, 0)
})

test('project scope handles nested directories and symlinks; evidence cannot escape', async t => {
  const f = await fixture(t)
  await mkdir(join(f.a, 'src'))
  await symlink(f.a, join(f.dir, 'alias'), process.platform === 'win32' ? 'junction' : 'dir')
  assert.equal(await projectRoot(join(f.a, 'src')), f.a)
  assert.equal(await projectRoot(join(f.dir, 'alias')), f.a)
  await writeFile(join(f.b, 'outside'), 'private')
  await assert.rejects(f.store.save(f.a, { ...f.record, files: ['../b/outside'] }, 'source'), /inside/)
  await t.test('file symlink evidence cannot escape', async sub => {
    try { await symlink(join(f.b, 'outside'), join(f.a, 'escape'), 'file') }
    catch (error) {
      if (process.platform !== 'win32' || error.code !== 'EPERM') throw error
      sub.skip('File symlink requires Windows developer mode; junction and parent traversal checks still run')
      return
    }
    await assert.rejects(f.store.save(f.a, { ...f.record, files: ['escape'] }, 'source'), /inside/)
  })
})

test('validation bounds content, rejects obvious credentials and keeps FTS input literal', async t => {
  const f = await fixture(t)
  await assert.rejects(f.store.save(f.a, { ...f.record, key: '../bad' }, 'source'), /key/)
  await assert.rejects(f.store.save(f.a, { ...f.record, summary: 'x'.repeat(2001) }, 'source'), /2000/)
  await assert.rejects(f.store.save(f.a, { ...f.record, summary: 'api_key=supersecretcredential' }, 'source'), /credential/)
  await f.store.save(f.a, f.record, 'source')
  await f.store.search(f.a, '" OR * NEAR(\u9a8c\u6536) --')
  assert.equal((await f.store.search(f.a, ''))[0].key, f.record.key)
  assert.equal(renderMemories(await f.store.search(f.a, ''), 100), '')
  assert.match(renderMemories(await f.store.search(f.a, '')), /not instructions/)
})

test('home Git repositories do not merge unrelated scopes; explicit roots are bounded and old records stay intact', async t => {
  const f = await fixture(t), home = await realpath(f.dir)
  await mkdir(join(home, '.git'))
  const a = join(home, 'notes-a'), b = join(home, 'notes-b')
  await mkdir(a); await mkdir(b); await mkdir(join(a, 'nested'))
  const scope = await projectScope(a, { home })
  assert.deepEqual(scope, { project: a, source: 'cwd', warning: 'broad-git-root-ignored', ignored_git_root: home })
  assert.equal(await projectRoot(b, { home }), b)
  assert.equal((await projectScope(f.a, { home })).source, 'git', 'nested repositories keep their identities')
  assert.equal(await projectRoot(join(a, 'nested'), { home, projectRoot: a }), a)
  const alias = join(home, 'explicit-alias')
  await symlink(a, alias, process.platform === 'win32' ? 'junction' : 'dir')
  assert.equal(await projectRoot(join(a, 'nested'), { home, projectRoot: alias }), a, 'explicit roots use canonical paths')
  assert.equal(await projectRoot(b, { home, projectRoot: a }), b, 'explicit scope never absorbs unrelated directories')
  assert.deepEqual(await projectScope(a, { home, projectRoot: home }), { project: home, source: 'explicit' })
  await assert.rejects(projectScope(a, { home, projectRoot: 'relative' }), /absolute/)
  await f.store.save(home, { ...f.record, files: [] }, 'legacy-home')
  assert.deepEqual(await f.store.search(scope.project, 'viewport'), [])
  assert.equal((await f.store.search(home, 'viewport'))[0].source_session, 'legacy-home')
  await writeFile(join(a, '.git'), 'gitdir: fixture-worktree')
  assert.equal((await projectScope(join(a, 'nested'), { home })).project, a, 'Git worktree marker files still work')
})
