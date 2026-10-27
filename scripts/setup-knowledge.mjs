// Prepare a Markdown vault for one project and activate it in the local plugin settings.
// Basic Memory is optional: --basic-memory-config registers the vault for an independently run
// Basic Memory 0.23.2; the plugin itself never starts it.
//
//   node scripts/setup-knowledge.mjs --vault /abs/vault --project /abs/project [--config-dir /abs/state]
//     [--basic-memory-config /abs/bm-config] [--seed-file /abs/notes.json] [--no-activate]
import { parseArgs } from 'node:util'
import { resolve, isAbsolute, join } from 'node:path'
import { mkdir, readFile, writeFile, realpath } from 'node:fs/promises'
import { localSettingsPath, dataRoot } from '../lib/dsh/config.js'
import { SecretScanner } from '../lib/core/secrets.js'
import { MemoryService } from '../lib/core/service.js'
import { MarkdownStore } from '../lib/stores/markdown-store.js'

const { values } = parseArgs({ options: {
  vault: { type: 'string' }, project: { type: 'string' }, 'config-dir': { type: 'string' }, 'basic-memory-config': { type: 'string' },
  // Accepted for 0.5.x command lines; recorded but unused by the plugin.
  command: { type: 'string' },
  'seed-file': { type: 'string' }, 'no-activate': { type: 'boolean', default: false },
} })
for (const key of ['vault', 'project']) if (!values[key] || !isAbsolute(values[key])) throw new Error(`--${key} requires an absolute path`)
for (const key of ['config-dir', 'basic-memory-config', 'command', 'seed-file']) if (values[key] && !isAbsolute(values[key])) throw new Error(`--${key} must be absolute`)
const root = values.vault, project = await realpath(values.project)
const stateDir = values['config-dir'] ?? resolve(dataRoot(), 'data', 'basic-memory')
await mkdir(root, { recursive: true, mode: 0o700 }); await mkdir(stateDir, { recursive: true, mode: 0o700 })

const bmConfig = values['basic-memory-config'] ?? (values.command ? stateDir : null)
if (bmConfig) {
  await mkdir(bmConfig, { recursive: true, mode: 0o700 })
  const file = join(bmConfig, 'config.json')
  let existing = {}
  try { existing = JSON.parse(await readFile(file, 'utf8')) } catch (e) { if (e.code !== 'ENOENT') throw e }
  if (existing.projects?.['dsh-knowledge']?.path && existing.projects['dsh-knowledge'].path !== root) throw new Error('Existing Basic Memory project points elsewhere; refusing to replace it')
  await writeFile(file, JSON.stringify({ ...existing, default_project: existing.default_project ?? 'dsh-knowledge',
    projects: { ...existing.projects, 'dsh-knowledge': { path: root, mode: 'local' } },
    semantic_search_enabled: false, reranker_enabled: false, auto_update: false, disable_permalinks: true, ensure_frontmatter_on_sync: false,
  }, null, 2) + '\n', { mode: 0o600 })
}

const settings = { knowledgeRoot: root, basicMemoryConfig: stateDir, knowledgeProject: project, ...(values.command ? { basicMemoryCommand: values.command } : {}) }
if (!values['no-activate']) {
  const settingsFile = localSettingsPath()
  await mkdir(resolve(settingsFile, '..'), { recursive: true, mode: 0o700 })
  let previous = {}
  try {
    const old = await readFile(settingsFile, 'utf8')
    previous = JSON.parse(old)
    if (JSON.stringify(previous) !== JSON.stringify({ ...previous, ...settings })) await writeFile(`${settingsFile}.${Date.now()}.backup`, old, { mode: 0o600, flag: 'wx' })
  } catch (e) { if (e.code !== 'ENOENT') throw e }
  await writeFile(settingsFile, JSON.stringify({ ...previous, ...settings }, null, 2) + '\n', { mode: 0o600 })
}

const readme = `# DSH Project Knowledge\n\nThis directory is plain Markdown. Edit it in Obsidian or any editor; an independently run Basic Memory can index it too.\n\nSelected project directory: ${project}\n\n- projects/*/journal: automatic task records for each turn; completion does not mean the conclusions have been verified.\n- projects/*/facts: verified findings with supporting evidence.\n- Edit conclusions and evidence in the body. Preserve the YAML fields prefixed with dsh_. Add dsh_private: true to keep a note out of recall.\n- Retrieval uses local keywords without an additional model. Semantic equivalence is not guaranteed.\n- Recalled note excerpts are sent to the active model with normal requests. Do not store credentials or complete private conversations.\n- Records deleted through model tools are kept in ${join(stateDir, 'trash')}; replaced versions are kept in ${join(stateDir, 'history')}.\n\nUninstalling the DSH plugin does not delete these Markdown files.\n`
try { await writeFile(join(root, 'README.md'), readme, { flag: 'wx', mode: 0o600 }) } catch (e) { if (e.code !== 'EEXIST') throw e }

let seeded = null
if (values['seed-file']) {
  const rows = JSON.parse(await readFile(values['seed-file'], 'utf8'))
  if (!Array.isArray(rows) || rows.some(row => !Array.isArray(row) || row.length !== 5 || row.some(value => typeof value !== 'string'))) throw new Error('Seed file requires rows of [key, title, kind, summary, evidence]')
  const scanner = new SecretScanner()
  const service = new MemoryService({ scanner, sqlite: () => { throw new Error('unused') }, markdown: () => new MarkdownStore({ root, stateDir, scanner }) })
  seeded = 0
  try {
    for (const [key, title, kind, summary, evidence] of rows) {
      try { await service.save(project, { key, title, kind, summary, evidence, files: [] }, 'approved-setup'); seeded++ }
      catch (e) { if (e.code !== 'REVISION_CONFLICT') throw e }
    }
  } finally { await service.close(); scanner.close() }
}
const folder = new MarkdownStore({ root, stateDir, scanner: new SecretScanner() }).folder(project)
console.log(JSON.stringify({ ...settings, projectFolder: folder, basicMemoryProjectConfig: bmConfig, seeded, activated: !values['no-activate'] }, null, 2))
