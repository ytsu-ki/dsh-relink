// Repeated, comparable benchmark runs. Each phase runs in its own process with a temporary HOME
// so neither version reads the user's local plugin settings.
// Usage: node bench/run.mjs --label new --entry lib/memory-team.js [--reps 5] [--notes 200,2000]
//        [--backends markdown,sqlite] [--basic-memory /abs/basic-memory] [--quality]
import { parseArgs } from 'node:util'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const run = promisify(execFile)
const { values } = parseArgs({ options: {
  label: { type: 'string' }, entry: { type: 'string' }, reps: { type: 'string', default: '5' }, notes: { type: 'string', default: '200,2000' },
  backends: { type: 'string', default: 'markdown,sqlite' }, 'basic-memory': { type: 'string', default: '' }, quality: { type: 'boolean', default: false },
  out: { type: 'string', default: '.local/bench' },
} })
const here = fileURLToPath(new URL('.', import.meta.url))
const root = fileURLToPath(new URL('..', import.meta.url))
await mkdir(join(root, values.out), { recursive: true })
const lines = []
const phase = async (args, home) => {
  const { stdout } = await run(process.execPath, [join(here, 'performance.mjs'), ...args], { cwd: root, timeout: 600000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, HOME: home, DSH_HOME: '', DSH_PROFILE_DIR: '' } })
  return JSON.parse(stdout.trim().split('\n').at(-1))
}
for (const backend of values.backends.split(',')) {
  for (const notes of values.notes.split(',')) {
    for (let rep = 0; rep < Number(values.reps); rep++) {
      const dir = await mkdtemp(join(tmpdir(), 'dsh-bench-')), home = join(dir, 'home')
      await mkdir(home)
      try {
        const common = ['--entry', values.entry, '--backend', backend, '--notes', notes, '--dir', dir, ...(values['basic-memory'] ? ['--basic-memory', values['basic-memory']] : [])]
        for (const name of ['cold', 'restart']) {
          const value = await phase([...common, '--phase', name], home)
          lines.push({ label: values.label, rep, ...value })
          process.stderr.write(`${values.label} ${backend} ${notes} rep ${rep} ${name}: first ${value.first_search_ms}ms\n`)
        }
      } finally { await rm(dir, { recursive: true, force: true }) }
    }
  }
}
if (values.quality) {
  for (const backend of values.backends.split(',')) {
    const home = await mkdtemp(join(tmpdir(), 'dsh-bench-home-'))
    try {
      for (const set of ['corpus', 'holdout']) {
        const { stdout } = await run(process.execPath, [join(here, 'quality.mjs'), '--entry', values.entry, '--backend', backend, '--queries', set], { cwd: root, timeout: 600000, env: { ...process.env, HOME: home } })
        lines.push({ label: values.label, phase: 'quality', ...JSON.parse(stdout.trim().split('\n').at(-1)) })
      }
    } finally { await rm(home, { recursive: true, force: true }) }
  }
}
const file = join(root, values.out, `${values.label}.jsonl`)
await writeFile(file, lines.map(line => JSON.stringify(line)).join('\n') + '\n')
console.log(file)
