import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, copyFile, writeFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { SecretScanner } from '../lib/core/secrets.js'
import { MemoryService } from '../lib/core/service.js'
import { SqliteStore } from '../lib/stores/sqlite-store.js'
import { MarkdownStore } from '../lib/stores/markdown-store.js'
import { inspectWindowsAcl } from '../lib/windows-acl.js'

test('the read-only ACL query closes unused child standard input', async () => {
  let closed = false
  const value = { path: 'fixture', owner: 'owner', inheritance_disabled: false, rules: [] }
  const executeFile = () => Object.assign(Promise.resolve({ stdout: JSON.stringify(value) }), {
    child: { stdin: { end() { closed = true } } },
  })
  assert.deepEqual(await inspectWindowsAcl('fixture', { executeFile }), value)
  assert.equal(closed, true, 'a fixed query must not wait for an open input pipe')
})

test('ACL paths are data, including quotes and PowerShell syntax; failures are reported without raw stderr', async t => {
  const moduleKeys = ['PSModulePath', 'WinPSModulePath', 'PSModuleAnalysisCachePath']
  const original = moduleKeys.map(key => process.env[key])
  t.after(() => moduleKeys.forEach((key, i) => { if (original[i] === undefined) delete process.env[key]; else process.env[key] = original[i] }))
  for (const key of moduleKeys) process.env[key] = 'PowerShell-7-only-fixture'
  const path = "C:\\\u4e2d\u6587 \u7a7a\u683c\\'quoted\" $();`target.sqlite"
  const result = { path, owner: 'LOCAL\\owner', inheritance_disabled: false, rules: [] }
  const executeFile = async (file, args, options) => {
    assert.equal(file, 'powershell.exe'); assert(args.includes('-Command')); assert(!args.includes('-File'))
    assert(!args.some(arg => arg.includes(path)))
    assert.equal(options.env.DSH_ACL_TARGET, path)
    assert(!Object.keys(options.env).some(key => /^(?:PSModulePath|WinPSModulePath|PSModuleAnalysisCachePath)$/i.test(key)))
    assert.match(args.at(-1), /\[System\.IO\.Path\]::Combine\(\$PSHOME, 'Modules'\)/)
    assert(!/Set-ExecutionPolicy|Bypass|Invoke-Expression|SetAccessControl/.test(args.join(' ')))
    return { stdout: '\uFEFF' + JSON.stringify(result) }
  }
  assert.deepEqual(await inspectWindowsAcl(path, { executeFile }), result)
  await assert.rejects(inspectWindowsAcl(path, { executeFile: async () => {
    throw Object.assign(new Error('PRIVATE_STDERR'), { code: 1, stderr: 'PRIVATE_STDERR' })
  } }), error => error.code === 'ACL_DIAGNOSTIC_UNAVAILABLE' && !error.message.includes('PRIVATE_STDERR'))
  await assert.rejects(inspectWindowsAcl(path, { executeFile: async () => ({ stdout: '{}' }) }), { code: 'ACL_INVALID_RESPONSE' })
})

test('Windows ACL diagnostics inspect actual SQLite and index files without claiming POSIX permissions', {
  skip: process.platform !== 'win32' && 'Windows ACL inspection requires PowerShell on Windows',
}, async t => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'dsh-acl-'))), project = join(dir, 'project'), database = join(dir, 'memory.sqlite')
  await mkdir(project); await mkdir(join(dir, 'vault'))
  const scanner = new SecretScanner()
  const sqlite = new SqliteStore(database)
  const knowledge = new MemoryService({ scanner, sqlite: () => sqlite, markdown: () => new MarkdownStore({ root: join(dir, 'vault'), stateDir: join(dir, 'state'), scanner }) })
  t.after(async () => { await knowledge.close(); sqlite.close(); await rm(dir, { recursive: true, force: true }) })
  await knowledge.save(project, { key: 'acl-probe', title: 'ACL probe', kind: 'fact', summary: 'Synthetic local evidence.', evidence: 'Acceptance fixture.', files: [] }, 'acl-test')
  await knowledge.search(project, 'acl-probe')
  const index = { snapshot: knowledge.storeFor(project).status(project).catalog }
  const executeFile = (...args) => {
    const started = performance.now()
    args[1] = [...args[1]]
    const trace = stage => `[Console]::Error.WriteLine('ACL probe: ${stage}')\n`
    args[1][args[1].length - 1] = trace('script started') + args[1].at(-1)
      .replace('$item = if', trace('before file metadata') + '$item = if')
      .replace('$acl = $item.GetAccessControl()', trace('before ACL read') + '$acl = $item.GetAccessControl()')
      .replace('[pscustomobject]@{', trace('before JSON') + '[pscustomobject]@{')
    const request = promisify(execFile)(...args)
    request.catch(error => t.diagnostic(`ACL child failure: ${JSON.stringify({ elapsed_ms: Math.round(performance.now() - started), code: error.code, killed: error.killed, stdout: error.stdout, stderr: error.stderr })}`))
    return request
  }
  // The public CLI inspects one path per process; avoid competing cold PowerShell starts.
  const entries = []
  for (const path of [database, index.snapshot, project]) entries.push(await inspectWindowsAcl(path, { executeFile }))
  assert.equal(entries.length, 3)
  assert(entries.every(entry => entry.owner && entry.rules.length && typeof entry.inheritance_disabled === 'boolean'))
  assert(entries.every(entry => /^S-\d-/.test(entry.owner) && entry.rules.every(rule => /^S-\d-/.test(rule.identity))))
  t.diagnostic(`Read-only ACL evidence (effective access is not inferred): ${JSON.stringify(entries)}`)
})

test('the Node ACL entry point works from a disposable low-integrity source directory', {
  skip: process.platform !== 'win32' && 'Low-integrity labels require Windows',
}, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-acl-low-')), low = join(dir, "\u4f4e\u5b8c\u6574\u6027 ' $dsh"), target = join(low, '\u666e\u901a \u6570\u636e.txt')
  t.after(() => rm(dir, { recursive: true, force: true }))
  await mkdir(join(low, 'lib'), { recursive: true }); await mkdir(join(low, 'scripts'))
  await copyFile(fileURLToPath(new URL('../lib/windows-acl.js', import.meta.url)), join(low, 'lib', 'windows-acl.js'))
  await copyFile(fileURLToPath(new URL('../scripts/inspect-windows-acl.mjs', import.meta.url)), join(low, 'scripts', 'inspect-windows-acl.mjs'))
  await writeFile(join(low, 'package.json'), '{"type":"module"}')
  await writeFile(target, 'Synthetic read-only ACL fixture')
  await promisify(execFile)('icacls.exe', [low, '/setintegritylevel', '(OI)(CI)L', '/T'], { windowsHide: true })
  const { stdout } = await promisify(execFile)(process.execPath, [join(low, 'scripts', 'inspect-windows-acl.mjs'), target], {
    timeout: 45000, windowsHide: true, encoding: 'utf8',
  })
  const acl = JSON.parse(stdout)
  assert.equal(await realpath(acl.path), await realpath(target)); assert(acl.owner && Array.isArray(acl.rules))
})
