// Shared fixtures: temporary projects, both canonical stores behind one MemoryService, and a
// canary for the host's fail-loud handlers.
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import assert from 'node:assert/strict'
import { MemoryService } from '../lib/core/service.js'
import { SecretScanner } from '../lib/core/secrets.js'
import { SqliteStore } from '../lib/stores/sqlite-store.js'
import { MarkdownStore } from '../lib/stores/markdown-store.js'

export const BACKENDS = ['sqlite', 'markdown']

export async function workspace(t, prefix = 'dsh-test-') {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)))
  const project = join(dir, 'project'), other = join(dir, 'other'), vault = join(dir, 'vault'), state = join(dir, 'state')
  for (const path of [join(project, '.git'), join(other, '.git'), vault]) await mkdir(path, { recursive: true })
  t.after(() => rm(dir, { recursive: true, force: true }))
  return { dir, project, other, vault, state, database: join(dir, 'memory.sqlite') }
}

/** A MemoryService over one backend. Every project uses that backend. */
export function memoryService(t, w, backend, { scanner = new SecretScanner(), ttlDays = 30, catalog = 'disk' } = {}) {
  const service = new MemoryService({ ttlDays, scanner, sqlite: () => new SqliteStore(w.database),
    markdown: backend === 'markdown' ? () => new MarkdownStore({ root: w.vault, stateDir: w.state, scanner, catalog }) : null })
  t.after(async () => { await service.close(); scanner.close() })
  return service
}

export async function eventually(check, message = 'condition not reached', timeoutMs = 5000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) { if (await check()) return; await delay(20) }
  assert.fail(message)
}

/** Fail the test if anything reaches the handlers the desktop host uses to exit. */
export function crashCanary(t) {
  const seen = []
  const rejection = error => seen.push(['unhandledRejection', error])
  const exception = error => seen.push(['uncaughtException', error])
  process.on('unhandledRejection', rejection); process.on('uncaughtException', exception)
  t.after(async () => {
    await delay(50)
    process.off('unhandledRejection', rejection); process.off('uncaughtException', exception)
    assert.deepEqual(seen.map(([kind, error]) => `${kind}: ${error?.stack ?? error}`), [], 'the host would have exited')
  })
}

export const fact = { key: 'viewport-check', title: '1440px viewport overlay', kind: 'pitfall',
  summary: 'Close the cookie overlay before measuring button clickability at 1440px.', evidence: 'Playwright trace showed the overlay intercepting clicks.', files: [] }
// "Acceptance overlay" record with Han text: title "1440px acceptance occlusion", summary
// "close the popup before testing the 1440px viewport", evidence "local acceptance test confirmed".
export const hanFact = { key: 'han-viewport', title: '1440px \u9a8c\u6536\u906e\u6321', kind: 'pitfall',
  summary: '\u9a8c\u6536\u524d\u5173\u95ed\u5f39\u7a97\uff0c\u518d\u6d4b1440px\u89c6\u53e3\u3002', evidence: '\u672c\u5730\u9a8c\u6536\u6d4b\u8bd5\u786e\u8ba4\u5f39\u7a97\u8986\u76d6\u6309\u94ae\u3002', files: [] }

/** Point HOME at an empty directory so no test reads the developer's local plugin settings. */
export async function isolateHome(t) {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-home-')))
  const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, DSH_HOME: process.env.DSH_HOME, DSH_PROFILE_DIR: process.env.DSH_PROFILE_DIR }
  process.env.HOME = home; process.env.USERPROFILE = home
  delete process.env.DSH_HOME; delete process.env.DSH_PROFILE_DIR
  t.after(async () => {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    await rm(home, { recursive: true, force: true })
  })
  return home
}
