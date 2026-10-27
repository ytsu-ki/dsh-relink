// Cross-process coordination for plugin writers of one Markdown note, and moves that survive
// a vault and state directory on different volumes.
import { open, readFile, unlink, rename, copyFile, stat, constants } from 'node:fs/promises'
import { delay } from '../core/async.js'

const STALE_MS = 30_000

const alive = pid => {
  try { process.kill(pid, 0); return true }
  catch (error) { return error.code === 'EPERM' }
}

/**
 * Hold the `lock` file (exclusive create) while `operation` runs. A lock whose holder process is
 * gone, or that is older than 30 seconds, is taken over. External editors do not take this lock.
 */
export async function withFileLock(lock, operation, { signal, waitMs = 10_000 } = {}) {
  const started = Date.now()
  let handle
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted()
    try { handle = await open(lock, 'wx', 0o600); break }
    catch (error) {
      if (error.code !== 'EEXIST') throw error
      let holder = null
      try { holder = JSON.parse(await readFile(lock, 'utf8')) } catch { /* Partially written or removed lock. */ }
      const info = await stat(lock).catch(() => null)
      const abandoned = info && (Date.now() - info.mtimeMs > STALE_MS || (Number.isSafeInteger(holder?.pid) && holder.pid !== process.pid && !alive(holder.pid)))
      if (abandoned) { await unlink(lock).catch(() => {}); continue }
      if (Date.now() - started > waitMs) throw Object.assign(new Error('Another writer holds this memory note; search again and retry'), { code: 'NOTE_LOCKED' })
      await delay(Math.min(200, 10 * 2 ** Math.min(attempt, 4)), signal)
    }
  }
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, at: Date.now() }))
    await handle.close(); handle = null
    return await operation()
  } finally {
    await handle?.close().catch(() => {})
    await unlink(lock).catch(() => {})
  }
}

/** Rename, falling back to an exclusive copy and unlink across filesystems. */
export async function moveFile(source, target, { renameFile = rename } = {}) {
  try { await renameFile(source, target) }
  catch (error) {
    if (error.code !== 'EXDEV') throw error
    await copyFile(source, target, constants.COPYFILE_EXCL)
    await unlink(source)
  }
}
