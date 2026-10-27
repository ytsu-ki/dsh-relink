// Inspect memory data before an upgrade or rollback, and optionally remove derived index files.
// Canonical data (SQLite records, Markdown notes, history, trash) is never modified.
//
//   node scripts/migrate.mjs [--state-dir DIR] [--database FILE] [--vault DIR]
//   node scripts/migrate.mjs --remove-legacy-snapshots   # delete 0.5.x Orama JSON snapshots
//   node scripts/migrate.mjs --remove-catalogs           # delete 0.6.x SQLite catalogs (rebuilt on next use)
import { parseArgs } from 'node:util'
import { readFile, readdir, stat, rm } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { join, isAbsolute } from 'node:path'
import { homedir } from 'node:os'
import { localSettingsPath, dataRoot } from '../lib/dsh/config.js'

const { values } = parseArgs({ options: {
  'state-dir': { type: 'string' }, database: { type: 'string' }, vault: { type: 'string' },
  'remove-legacy-snapshots': { type: 'boolean', default: false }, 'remove-catalogs': { type: 'boolean', default: false },
} })
for (const key of ['state-dir', 'database', 'vault']) if (values[key] && !isAbsolute(values[key])) throw new Error(`--${key} must be absolute`)

let local = {}
try { local = JSON.parse(await readFile(localSettingsPath(), 'utf8')) } catch (error) { if (error.code !== 'ENOENT') local = { error: 'local settings file is not valid JSON' } }
const root = dataRoot(process.env, homedir())
const stateDir = values['state-dir'] ?? local.basicMemoryConfig ?? join(root, 'data', 'basic-memory')
const database = values.database ?? join(root, 'data', 'dsh-memory-team.sqlite')
const vault = values.vault ?? local.knowledgeRoot ?? ''
const report = { settings: { file: localSettingsPath(), ...local }, state_dir: stateDir, database: null, vault: null, derived: { legacy_snapshots: [], catalogs: [] }, removed: [] }

try {
  await stat(database)
  const db = new DatabaseSync(database, { readOnly: true })
  try {
    report.database = { path: database, user_version: db.prepare('PRAGMA user_version').get().user_version,
      records: db.prepare('SELECT count(*) AS n FROM memories').get().n, projects: db.prepare('SELECT count(DISTINCT project) AS n FROM memories').get().n,
      compatible_with: '0.5.x and 0.6.x (schema version 1)' }
  } finally { db.close() }
} catch (error) { report.database = error.code === 'ENOENT' ? { path: database, exists: false } : { path: database, error: error.message } }

if (vault) {
  try {
    const projects = await readdir(join(vault, 'projects')).catch(error => { if (error.code === 'ENOENT') return []; throw error })
    const counts = {}
    for (const project of projects) for (const folder of ['facts', 'journal']) {
      counts[folder] = (counts[folder] ?? 0) + (await readdir(join(vault, 'projects', project, folder)).catch(() => [])).filter(name => name.endsWith('.md')).length
    }
    report.vault = { path: vault, project_folders: projects.length, notes: counts }
  } catch (error) { report.vault = { path: vault, error: error.code ?? error.message } }
}

const indexDir = join(stateDir, 'recall-index')
for (const name of await readdir(indexDir).catch(() => [])) {
  if (/^[0-9a-f]{32}\.json$/.test(name)) report.derived.legacy_snapshots.push(join(indexDir, name))
  else if (/^[0-9a-f]{32}\.sqlite(-journal)?$/.test(name)) report.derived.catalogs.push(join(indexDir, name))
}
const remove = async paths => { for (const path of paths) { await rm(path, { force: true }); report.removed.push(path) } }
if (values['remove-legacy-snapshots']) await remove(report.derived.legacy_snapshots)
if (values['remove-catalogs']) await remove(report.derived.catalogs)
console.log(JSON.stringify(report, null, 2))
