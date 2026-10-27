import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFile, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { withFileLock, moveFile } from '../lib/stores/file-lock.js'
import { workspace, cleanup } from './helpers.js'

test('cross-volume moves fall back to an exclusive copy and unlink', async t => {
  const w = await workspace(t)
  const source = join(w.dir, 'note.md'), target = join(w.dir, 'trash.md')
  await writeFile(source, 'recoverable')
  await moveFile(source, target, { renameFile: async () => { throw Object.assign(new Error('cross-device'), { code: 'EXDEV' }) } })
  assert.equal(await readFile(target, 'utf8'), 'recoverable')
  await assert.rejects(stat(source), { code: 'ENOENT' })
  await writeFile(source, 'second')
  await assert.rejects(moveFile(source, target, { renameFile: async () => { throw Object.assign(new Error('x'), { code: 'EXDEV' }) } }), { code: 'EEXIST' }, 'an existing copy is never overwritten')
  await assert.rejects(moveFile(join(w.dir, 'missing'), join(w.dir, 'x')), { code: 'ENOENT' })
})

test('file locks serialize writers, take over locks of dead processes and time out visibly', async t => {
  const w = await workspace(t), lock = join(w.dir, 'note.lock')
  const order = []
  await Promise.all([1, 2, 3].map(i => withFileLock(lock, async () => { order.push(`start-${i}`); await delay(20); order.push(`end-${i}`) })))
  for (let i = 0; i < order.length; i += 2) assert.equal(order[i].replace('start', 'end'), order[i + 1], 'critical sections never overlap')
  await assert.rejects(stat(lock), { code: 'ENOENT' }, 'the lock is released')
  // Holders are real child processes, one exited and one running: no fixed PID is dead or alive on every OS.
  const exited = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
  await once(exited, 'exit')
  await writeFile(lock, JSON.stringify({ pid: exited.pid, at: Date.now() }))
  assert.equal(await withFileLock(lock, async () => 'taken over'), 'taken over')
  const running = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  cleanup(t, async () => { if (running.exitCode === null && running.signalCode === null) { running.kill(); await once(running, 'exit') } })
  await once(running, 'spawn')
  await writeFile(lock, JSON.stringify({ pid: running.pid, at: Date.now() }))
  await assert.rejects(withFileLock(lock, async () => 'never', { waitMs: 100 }), { code: 'NOTE_LOCKED' })
})
