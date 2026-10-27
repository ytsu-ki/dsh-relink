// The setup script prepares a vault, activates settings with a backup and seeds idempotently.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { workspace, isolateHome, memoryService } from './helpers.js'

const script = fileURLToPath(new URL('../scripts/setup-knowledge.mjs', import.meta.url))

test('setup-knowledge activates a vault, keeps a settings backup and seeds without overwriting', async t => {
  const home = await isolateHome(t), w = await workspace(t)
  const seed = join(w.dir, 'seed.json')
  await writeFile(seed, JSON.stringify([['seeded-rule', 'Seeded cassowary rule', 'fact', 'Seeded cassowary conclusion.', 'Approved seed evidence.']]))
  const settingsFile = join(home, '.local/share/dsh-memory-team/settings.json')
  await mkdir(join(home, '.local/share/dsh-memory-team'), { recursive: true })
  await writeFile(settingsFile, JSON.stringify({ betterleaksCommand: '/opt/betterleaks' }))
  const run = (...args) => promisify(execFile)(process.execPath, [script, '--vault', w.vault, '--project', w.project, '--config-dir', w.state, ...args], { env: { ...process.env, HOME: home } })
  const first = JSON.parse((await run('--seed-file', seed, '--basic-memory-config', join(w.dir, 'bm'))).stdout)
  assert.equal(first.seeded, 1); assert.equal(first.activated, true)
  const settings = JSON.parse(await readFile(settingsFile, 'utf8'))
  assert.deepEqual(settings, { betterleaksCommand: '/opt/betterleaks', knowledgeRoot: w.vault, basicMemoryConfig: w.state, knowledgeProject: w.project })
  assert.equal((await readdir(join(home, '.local/share/dsh-memory-team'))).filter(name => name.includes('.backup')).length, 1)
  const bm = JSON.parse(await readFile(join(w.dir, 'bm', 'config.json'), 'utf8'))
  assert.equal(bm.projects['dsh-knowledge'].path, w.vault); assert.equal(bm.disable_permalinks, true)
  assert.match(await readFile(join(w.vault, 'README.md'), 'utf8'), /plain Markdown/)
  const again = JSON.parse((await run('--seed-file', seed)).stdout)
  assert.equal(again.seeded, 0, 'existing keys are not overwritten')
  const service = memoryService(t, w, 'markdown')
  assert.deepEqual((await service.search(w.project, 'cassowary rule')).records.map(r => r.key), ['seeded-rule'])
  await assert.rejects(promisify(execFile)(process.execPath, [script, '--vault', join(w.dir, 'elsewhere'), '--project', w.project, '--basic-memory-config', join(w.dir, 'bm'), '--no-activate'], { env: { ...process.env, HOME: home } }), /points elsewhere/)
})
