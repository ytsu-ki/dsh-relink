import { parseArgs, promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { homedir, tmpdir } from 'node:os'
import { resolve, join, isAbsolute } from 'node:path'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile, copyFile, chmod, rm } from 'node:fs/promises'

const execute = promisify(execFile)
const { values } = parseArgs({ options: { 'archive': { type: 'string' }, 'no-activate': { type: 'boolean', default: false } } })
const sums = {
  darwin_arm64: '83dd7eaab13d44a1e8e347a17064cdef153a1478db473276d41b38d55613d3f2',
  darwin_x64: '68dfd83458d9e7f90663daa7a81c7f944083b170dae82e4f5f8d0581ed519ef1',
  linux_arm64: '1d39116e0a58dc94574715e2aa12a2dbd5062f193eee3fec011fef6ba06bd13b',
  linux_x64: 'f8b185a39ffcece2a1ca82bf3a4e7435cd81963ffd16b7a9128daf75f35f6de7',
}
const platform = `${process.platform}_${process.arch}`
if (!sums[platform]) throw new Error('Automatic scanner setup supports macOS/Linux arm64/x64')
if (values.archive && !isAbsolute(values.archive)) throw new Error('--archive must be absolute')
const name = `betterleaks_1.9.0_${platform}.tar.gz`
const dir = resolve(homedir(), '.local/share/dsh-memory-team'), target = join(dir, 'betterleaks', '1.9.0')
const temp = await mkdtemp(join(tmpdir(), 'dsh-secret-setup-'))
try {
  const archive = values.archive || join(temp, name)
  if (!values.archive) await execute('curl', ['--fail', '--location', '--silent', '--show-error', '--connect-timeout', '15',
    '--max-time', '120', '--output', archive, `https://github.com/betterleaks/betterleaks/releases/download/v1.9.0/${name}`], { timeout: 125000 })
  const bytes = await readFile(archive)
  if (createHash('sha256').update(bytes).digest('hex') !== sums[platform]) throw new Error('Scanner archive checksum mismatch')
  // Extract only these two regular release members, after checking the official digest.
  await execute('tar', ['-xzf', archive, '-C', temp, 'betterleaks', 'LICENSE'])
  const { stdout } = await execute(join(temp, 'betterleaks'), ['version'], { timeout: 5000 })
  if (stdout.trim() !== '1.9.0') throw new Error('Scanner release version mismatch')
  await mkdir(target, { recursive: true, mode: 0o700 })
  for (const name of ['betterleaks', 'LICENSE']) await copyFile(join(temp, name), join(target, name))
  await chmod(join(target, 'betterleaks'), 0o700); await chmod(join(target, 'LICENSE'), 0o600)
  const command = join(target, 'betterleaks')
  if (!values['no-activate']) {
    const file = join(dir, 'settings.json')
    let settings = {}
    try {
      const old = await readFile(file, 'utf8'); settings = JSON.parse(old)
      await writeFile(`${file}.${Date.now()}.backup`, old, { mode: 0o600, flag: 'wx' })
    } catch (e) { if (e.code !== 'ENOENT') throw e }
    await writeFile(file, JSON.stringify({ ...settings, betterleaksCommand: command }, null, 2) + '\n', { mode: 0o600 })
  }
  console.log(JSON.stringify({ version: '1.9.0', betterleaksCommand: command, activated: !values['no-activate'] }))
} finally { await rm(temp, { recursive: true, force: true }) }
