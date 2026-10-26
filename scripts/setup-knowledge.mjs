import { parseArgs } from 'node:util'
import { resolve, isAbsolute, join } from 'node:path'
import { homedir } from 'node:os'
import { mkdir, readFile, writeFile, realpath } from 'node:fs/promises'
import { KnowledgeStore } from '../lib/basic-memory.js'

const { values } = parseArgs({ options: {
  vault: { type: 'string' }, project: { type: 'string' }, command: { type: 'string' }, 'config-dir': { type: 'string' },
  'seed-file': { type: 'string' }, 'no-activate': { type: 'boolean', default: false },
} })
for (const key of ['vault', 'project', 'command', 'config-dir']) {
  if (!values[key] || !isAbsolute(values[key])) throw new Error(`--${key} requires an absolute path`)
}
const root = values.vault, project = await realpath(values.project), configDir = values['config-dir']
await mkdir(root, { recursive: true, mode: 0o700 }); await mkdir(configDir, { recursive: true, mode: 0o700 })
const file = join(configDir, 'config.json')
let existing = {}
try { existing = JSON.parse(await readFile(file, 'utf8')) } catch (e) { if (e.code !== 'ENOENT') throw e }
if (existing.projects?.['dsh-knowledge']?.path && existing.projects['dsh-knowledge'].path !== root) throw new Error('Existing knowledge project points elsewhere; refusing to replace it')
await writeFile(file, JSON.stringify({ ...existing, default_project: 'dsh-knowledge',
  projects: { ...existing.projects, 'dsh-knowledge': { path: root, mode: 'local' } },
  semantic_search_enabled: false, reranker_enabled: false, auto_update: false,
  disable_permalinks: true, ensure_frontmatter_on_sync: false,
}, null, 2) + '\n', { mode: 0o600 })

const settings = { knowledgeRoot: root, basicMemoryCommand: values.command, basicMemoryConfig: configDir, knowledgeProject: project }
if (!values['no-activate']) {
  const dir = resolve(homedir(), '.local/share/dsh-memory-team')
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const settingsFile = join(dir, 'settings.json')
  let previous = {}
  try {
    const old = await readFile(settingsFile, 'utf8')
    previous = JSON.parse(old)
    if (JSON.stringify(previous) !== JSON.stringify({ ...previous, ...settings })) await writeFile(`${settingsFile}.${Date.now()}.backup`, old, { mode: 0o600, flag: 'wx' })
  } catch (e) { if (e.code !== 'ENOENT') throw e }
  await writeFile(settingsFile, JSON.stringify({ ...previous, ...settings }, null, 2) + '\n', { mode: 0o600 })
}

const store = new KnowledgeStore(root, { ttlDays: 30, basicMemoryConfig: configDir }, { close: async () => {} })
const readme = `# DSH Project Knowledge\n\nBasic Memory indexes this directory. You can edit the same files in Obsidian.\n\nSelected project directory: ${project}\n\n- projects/*/journal: automatic task records for each turn; completion does not mean the conclusions have been verified.\n- projects/*/facts: verified findings with supporting evidence.\n- Edit conclusions and evidence in the body. Preserve the YAML source and project fields prefixed with dsh_.\n- Retrieval uses local keywords without an additional summarization model. Semantic equivalence has not been validated.\n- Recalled note excerpts are sent to the active model with normal requests. Do not store credentials or complete private conversations.\n- Records deleted through model tools remain in ${join(configDir, 'trash')}; earlier versions remain in history.\n\nUninstalling the DSH plugin does not delete these Markdown files.\n`
try { await writeFile(join(root, 'README.md'), readme, { flag: 'wx', mode: 0o600 }) } catch (e) { if (e.code !== 'EEXIST') throw e }

if (values['seed-file']) {
  const rows = JSON.parse(await readFile(values['seed-file'], 'utf8'))
  if (!Array.isArray(rows) || rows.some(row => !Array.isArray(row) || row.length !== 5 || row.some(value => typeof value !== 'string'))) throw new Error('Seed file requires rows of [key, title, kind, summary, evidence]')
  let created = 0
  for (const [key, title, kind, summary, evidence] of rows) {
    try { await store.save(project, { key, title, kind, summary, evidence, files: [] }, 'approved-mvp-setup'); created++ }
    catch (e) { if (!/Memory changed/.test(e.message)) throw e }
  }
  console.log(JSON.stringify({ seeded: created }))
}
console.log(JSON.stringify({ ...settings, projectFolder: store.folder(project), activated: !values['no-activate'] }, null, 2))
