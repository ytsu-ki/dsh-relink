// Project identity rules and evidence containment.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, writeFile, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { projectRoot, projectScope } from '../lib/core/scope.js'
import { workspace, memoryService, fact } from './helpers.js'

test('project scope follows Git roots, symlinks and worktree marker files', async t => {
  const w = await workspace(t)
  await mkdir(join(w.project, 'src', 'deep'), { recursive: true })
  assert.equal(await projectRoot(join(w.project, 'src', 'deep')), w.project)
  await symlink(w.project, join(w.dir, 'alias'), process.platform === 'win32' ? 'junction' : 'dir')
  assert.equal(await projectRoot(join(w.dir, 'alias')), w.project, 'aliases resolve to the canonical path')
  const worktree = join(w.dir, 'worktree'); await mkdir(join(worktree, 'nested'), { recursive: true })
  await writeFile(join(worktree, '.git'), 'gitdir: fixture-worktree')
  assert.deepEqual(await projectScope(join(worktree, 'nested')), { project: worktree, source: 'git' })
})

test('home or root Git repositories never merge unrelated directories; explicit roots are bounded', async t => {
  const w = await workspace(t), home = w.dir
  await mkdir(join(home, '.git'))
  const a = join(home, 'notes-a'), b = join(home, 'notes-b')
  await mkdir(join(a, 'nested'), { recursive: true }); await mkdir(b)
  assert.deepEqual(await projectScope(a, { home }), { project: a, source: 'cwd', warning: 'broad-git-root-ignored', ignored_git_root: home })
  assert.equal(await projectRoot(b, { home }), b)
  assert.equal((await projectScope(w.project, { home })).source, 'git', 'nested repositories keep their identity')
  assert.equal(await projectRoot(join(a, 'nested'), { home, projectRoot: a }), a)
  const alias = join(home, 'explicit-alias')
  await symlink(a, alias, process.platform === 'win32' ? 'junction' : 'dir')
  assert.equal(await projectRoot(join(a, 'nested'), { home, projectRoot: alias }), a, 'explicit roots use canonical paths')
  assert.equal(await projectRoot(b, { home, projectRoot: a }), b, 'an explicit root never absorbs unrelated directories')
  assert.deepEqual(await projectScope(a, { home, projectRoot: home }), { project: home, source: 'explicit' })
  await assert.rejects(projectScope(a, { home, projectRoot: 'relative' }), /absolute/)
})

test('evidence files cannot escape the project through traversal or symlinks', async t => {
  const w = await workspace(t), service = memoryService(t, w, 'sqlite')
  await writeFile(join(w.other, 'outside'), 'private')
  await assert.rejects(service.save(w.project, { ...fact, files: ['../other/outside'] }, 's'), /inside/)
  await t.test('file symlink evidence cannot escape', async sub => {
    try { await symlink(join(w.other, 'outside'), join(w.project, 'escape'), 'file') }
    catch (error) {
      if (process.platform !== 'win32' || error.code !== 'EPERM') throw error
      sub.skip('File symlinks require Windows developer mode; junction and traversal checks still run')
      return
    }
    await assert.rejects(service.save(w.project, { ...fact, files: ['escape'] }, 's'), /inside/)
  })
})
