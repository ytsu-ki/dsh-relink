// One benchmark phase in a fresh process. Prints one JSON line.
// cold: populate a store, load the plugin, measure first/warm recall, external edits,
//       directory replacement, idle CPU, handles and memory.
// restart: reload the same store in a new process and measure the first recall.
import { parseArgs } from 'node:util'
import { mkdir, writeFile, readFile, rename, rm, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { mount, scopeFolder, childProcesses, resources, percentile } from './lib/harness.mjs'
import { records, queries } from './fixtures/recall-corpus.mjs'

const { values } = parseArgs({ options: {
  entry: { type: 'string' }, backend: { type: 'string', default: 'markdown' }, notes: { type: 'string', default: '200' },
  phase: { type: 'string', default: 'cold' }, dir: { type: 'string' }, 'basic-memory': { type: 'string', default: '' },
} })
const entry = values.entry.startsWith('file:') ? values.entry : pathToFileURL(resolve(values.entry)).href
const dir = await realpath(values.dir), project = join(dir, 'project'), vault = join(dir, 'vault'), notes = Number(values.notes)
const markdown = values.backend === 'markdown'
const config = markdown
  ? { database: join(dir, 'memory.sqlite'), knowledgeRoot: vault, knowledgeProject: '', basicMemoryCommand: values['basic-memory'] || join(dir, 'no-basic-memory'), basicMemoryConfig: join(dir, 'state'), betterleaksCommand: '', projectRoot: '' }
  : { database: join(dir, 'memory.sqlite'), knowledgeRoot: '', betterleaksCommand: '', projectRoot: '' }
const folder = join(vault, 'projects', scopeFolder(project))
const note = (key, title, body) => `---\ntitle: ${JSON.stringify(title)}\ntype: note\ntags:\n  - dsh\n  - verified\ndsh_project: ${JSON.stringify(project)}\ndsh_key: ${key}\ndsh_kind: fact\ndsh_status: verified\ndsh_updated_at: ${Date.now()}\ndsh_files: []\ndsh_source_session: bench\n---\n\n# ${title}\n\n## Conclusion\n${body}\n\n## Evidence\nSynthetic benchmark note.\n`
const filler = i => `Routine note ${i} about module ${i % 97} and component ${i % 89}; nothing notable in batch ${Math.floor(i / 50)}.`
const time = async fn => { const start = performance.now(); const value = await fn(); return [performance.now() - start, value] }
const until = async (fn, limitMs = 15000) => {
  const start = performance.now()
  while (performance.now() - start < limitMs) { if (await fn()) return +(performance.now() - start).toFixed(1); await delay(10) }
  return null
}
const result = { phase: values.phase, backend: values.backend, notes }

if (values.phase === 'cold') {
  await mkdir(join(project, '.git'), { recursive: true }); await mkdir(vault, { recursive: true })
  if (markdown) {
    await mkdir(join(folder, 'facts'), { recursive: true })
    for (const r of records) await writeFile(join(folder, 'facts', `${r.key}.md`), note(r.key, r.title, `${r.summary}\n\n${r.evidence}`))
    for (let i = records.length; i < notes; i++) await writeFile(join(folder, 'facts', `filler-${i}.md`), note(`filler-${i}`, `Routine note ${i}`, filler(i)))
  }
}
const cpuStart = process.cpuUsage(), wallStart = performance.now()
const bench = await mount({ entry, config, cwd: project })
result.load_ms = +bench.loadMs.toFixed(2)
await delay(50)
result.children_after_load = childProcesses().map(row => ({ command: row.command.split('/').at(-1), rss_kib: row.rssKiB }))
try {
  if (values.phase === 'cold' && !markdown) {
    for (const r of records) await bench.invoke('project_memory_save', { ...r, files: [] })
    for (let i = records.length; i < notes; i++) await bench.invoke('project_memory_save', { key: `filler-${i}`, title: `Routine note ${i}`, kind: 'fact', summary: filler(i), evidence: 'Synthetic benchmark note.', files: [] })
  }
  const probe = queries.filter(q => q.expect.length).slice(0, 30)
  const [firstMs, first] = await time(() => bench.invoke('project_memory_search', { query: probe[0].query }))
  result.first_search_ms = +firstMs.toFixed(2)
  result.first_search_hit = first.records.some(r => probe[0].expect.includes(r.key))
  // Automatic recall through the real agent loop (pre-step admission) on a fresh agent.
  const [recallMs, requests] = await time(async () => bench.ask(probe[1].query, await bench.createAgent()))
  result.first_turn_ms = +recallMs.toFixed(2)
  result.first_turn_recall_hit = requests[0].messages.some(m => m.source?.kind === 'dsh-memory-team' && probe[1].expect.some(key => JSON.stringify(m.content).includes(key)))
  if (values.phase === 'cold') {
    const warm = []
    for (let round = 0; round < 3; round++) for (const q of probe) warm.push((await time(() => bench.invoke('project_memory_search', { query: q.query })))[0])
    result.warm_search_ms = { n: warm.length, p50: percentile(warm, 50), p95: percentile(warm, 95), max: percentile(warm, 100) }
    if (markdown) {
      const target = join(folder, 'facts', `${records[0].key}.md`)
      const raw = await readFile(target, 'utf8')
      await writeFile(target, raw.replace('## Evidence', 'Edited in place zebramarkerone.\n\n## Evidence'))
      result.in_place_edit_visible_ms = await until(async () => (await bench.invoke('project_memory_search', { query: 'zebramarkerone' })).records.length > 0)
      await writeFile(`${target}.tmp`, raw.replace('## Evidence', 'Atomic save zebramarkertwo.\n\n## Evidence')); await rename(`${target}.tmp`, target)
      result.atomic_save_visible_ms = await until(async () => (await bench.invoke('project_memory_search', { query: 'zebramarkertwo' })).records.length > 0)
      await writeFile(join(folder, 'facts', 'added-note.md'), note('added-note', 'Added note', 'Newly added zebramarkerthree.'))
      result.added_note_visible_ms = await until(async () => (await bench.invoke('project_memory_search', { query: 'zebramarkerthree' })).records.length > 0)
      const replacement = []
      for (let i = 0; i < 5; i++) {
        await rename(folder, `${folder}-old-${i}`)
        await mkdir(join(folder, 'facts'), { recursive: true })
        await writeFile(join(folder, 'facts', `replaced-${i}.md`), note(`replaced-${i}`, `Replacement ${i}`, `Replacement content quokkamarker${i}.`))
        const previous = i ? `quokkamarker${i - 1}` : 'zebramarkerone'
        replacement.push(await until(async () => (await bench.invoke('project_memory_search', { query: `quokkamarker${i}` })).records.length > 0
          && (await bench.invoke('project_memory_search', { query: previous })).records.length === 0))
      }
      result.directory_replacement_visible_ms = replacement
      await rename(vault, `${vault}-moved`)
      const moved = await bench.invoke('project_memory_search', { query: 'quokkamarker4' }).then(value => ({ records: value.records.length, status: value.status ?? 'not-reported' }), error => ({ error: error.message.slice(0, 120) }))
      result.vault_moved = moved
      await rename(`${vault}-moved`, vault)
      result.vault_restored_visible_ms = await until(async () => (await bench.invoke('project_memory_search', { query: 'quokkamarker4' })).records.length > 0)
      // Restore the original store so the restart phase measures the populated folder.
      await rm(folder, { recursive: true, force: true }); await rename(`${folder}-old-0`, folder)
      // Let both designs bring their derived index up to date before exiting, so the restart
      // phase measures a warm restart rather than recovery from the restore above.
      result.restore_visible_ms = await until(async () => (await bench.invoke('project_memory_search', { query: probe[0].query })).records.some(r => probe[0].expect.includes(r.key)))
    }
    const memory = process.memoryUsage()
    result.memory_mib = { rss: +(memory.rss / 1048576).toFixed(1), heap_used: +(memory.heapUsed / 1048576).toFixed(1) }
    result.children_busy = childProcesses().map(row => ({ command: row.command.split('/').at(-1), rss_kib: row.rssKiB }))
    await delay(1500)
    const idleCpu = process.cpuUsage(), idleChildren = childProcesses(), idleStart = performance.now()
    await delay(5000)
    const used = process.cpuUsage(idleCpu), idleMs = performance.now() - idleStart
    const childCpu = childProcesses().reduce((sum, row) => sum + row.cpuSeconds, 0) - idleChildren.reduce((sum, row) => sum + row.cpuSeconds, 0)
    result.idle = { window_ms: Math.round(idleMs), plugin_process_cpu_ms: +((used.user + used.system) / 1000).toFixed(1), child_cpu_s: childCpu, resources: resources() }
  }
} finally {
  await bench.dispose()
}
await delay(200)
result.after_dispose = { resources: resources(), children: childProcesses().length }
const total = process.cpuUsage(cpuStart)
result.process_cpu_ms = +((total.user + total.system) / 1000).toFixed(1)
result.process_wall_ms = +(performance.now() - wallStart).toFixed(1)
console.log(JSON.stringify(result))
