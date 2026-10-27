// Recall quality on the labelled corpus: hit rate, precision and false positives per backend.
// Usage: node bench/quality.mjs --entry <plugin entry URL or path> --backend sqlite|markdown [--queries corpus|holdout]
import { parseArgs } from 'node:util'
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { mount } from './lib/harness.mjs'
import { records, queries as corpusQueries } from './fixtures/recall-corpus.mjs'
import { queries as holdoutQueries } from './fixtures/recall-holdout.mjs'

const { values } = parseArgs({ options: { entry: { type: 'string' }, backend: { type: 'string', default: 'sqlite' }, details: { type: 'boolean', default: false }, queries: { type: 'string', default: 'corpus' } } })
const queries = values.queries === 'holdout' ? holdoutQueries : corpusQueries
const entry = values.entry.startsWith('file:') ? values.entry : pathToFileURL(resolve(values.entry)).href
const dir = await realpath(await mkdtemp(join(tmpdir(), 'dsh-quality-')))
const project = join(dir, 'project')
await mkdir(join(project, '.git'), { recursive: true })
const config = values.backend === 'markdown'
  ? { database: join(dir, 'memory.sqlite'), knowledgeRoot: join(dir, 'vault'), knowledgeProject: '', basicMemoryCommand: join(dir, 'no-basic-memory'), basicMemoryConfig: join(dir, 'state'), betterleaksCommand: '', projectRoot: '' }
  : { database: join(dir, 'memory.sqlite'), knowledgeRoot: '', betterleaksCommand: '', projectRoot: '' }
await mkdir(join(dir, 'vault'))
const bench = await mount({ entry, config, cwd: project })
try {
  for (const record of records) await bench.invoke('project_memory_save', { ...record, files: [] })
  const rows = []
  for (const { id, query, expect } of queries) {
    const { records: found } = await bench.invoke('project_memory_search', { query })
    const keys = found.map(record => record.key)
    rows.push({ id, expect, keys, hit: expect.length ? keys.some(key => expect.includes(key)) : keys.length === 0,
      correct: keys.filter(key => expect.includes(key)).length, wrong: keys.filter(key => !expect.includes(key)).length })
  }
  const relevant = rows.filter(row => row.expect.length), negative = rows.filter(row => !row.expect.length)
  const returned = relevant.reduce((sum, row) => sum + row.keys.length, 0)
  const summary = {
    backend: values.backend, query_set: values.queries, records: records.length, relevant_queries: relevant.length, no_hit_queries: negative.length,
    hit_rate: +(relevant.filter(row => row.hit).length / relevant.length).toFixed(3),
    precision: returned ? +(relevant.reduce((sum, row) => sum + row.correct, 0) / returned).toFixed(3) : null,
    no_hit_false_positive_rate: +(negative.filter(row => row.keys.length).length / negative.length).toFixed(3),
    wrong_records_returned: rows.reduce((sum, row) => sum + row.wrong, 0),
    misses: relevant.filter(row => !row.hit).map(row => row.id),
    false_positive_queries: negative.filter(row => row.keys.length).map(row => row.id),
  }
  console.log(JSON.stringify(values.details ? { ...summary, rows } : summary))
} finally {
  await bench.dispose()
  await rm(dir, { recursive: true, force: true })
}
