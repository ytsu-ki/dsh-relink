// Summarize benchmark JSONL files as Markdown tables: median and range across repetitions.
// Usage: node bench/report.mjs .local/bench/baseline.jsonl .local/bench/new.jsonl ...
import { readFile } from 'node:fs/promises'

const rows = []
for (const file of process.argv.slice(2)) for (const line of (await readFile(file, 'utf8')).split('\n')) if (line.trim()) rows.push(JSON.parse(line))
const median = values => { const v = values.filter(Number.isFinite).sort((a, b) => a - b); if (!v.length) return null; const m = v.length >> 1; return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2 }
const fmt = value => value === null || value === undefined ? 'n/a' : typeof value === 'number' ? (Math.abs(value) >= 100 ? Math.round(value) : +value.toFixed(1)) : String(value)
const range = values => { const v = values.filter(Number.isFinite); return v.length ? `${fmt(Math.min(...v))}-${fmt(Math.max(...v))}` : 'n/a' }
const cell = values => `${fmt(median(values))} (${range(values)})`
const groups = new Map()
for (const row of rows.filter(row => row.phase !== 'quality')) {
  const key = `${row.label}|${row.backend}|${row.notes}|${row.phase}`
  if (!groups.has(key)) groups.set(key, [])
  groups.get(key).push(row)
}
const lines = []
const table = (title, header, phase, columns) => {
  lines.push(`### ${title}`, '', `| Variant | Backend | Notes | ${header.join(' | ')} |`, `| --- | --- | --- | ${header.map(() => '---').join(' | ')} |`)
  for (const [key, list] of groups) {
    const [label, backend, notes, rowPhase] = key.split('|')
    if (rowPhase !== phase) continue
    const values = columns.map(fn => list.map(fn))
    if (values.every(column => column.every(value => value === undefined || value === null))) continue
    lines.push(`| ${label} | ${backend} | ${notes} | ${values.map(cell).join(' | ')} |`)
  }
  lines.push('')
}
table('Cold process: first use of an existing store', ['load ms', 'first search ms', 'first turn ms', 'warm p50 ms', 'warm p95 ms'], 'cold', [
  r => r.load_ms, r => r.first_search_ms, r => r.first_turn_ms, r => r.warm_search_ms?.p50, r => r.warm_search_ms?.p95])
table('Restart: new process on the same data', ['load ms', 'first search ms', 'first turn ms'], 'restart', [r => r.load_ms, r => r.first_search_ms, r => r.first_turn_ms])
table('External changes visible to the next search (ms)', ['in-place edit', 'atomic save', 'added note', 'directory replacement (5x, median of medians)', 'vault restored'], 'cold', [
  r => r.in_place_edit_visible_ms, r => r.atomic_save_visible_ms, r => r.added_note_visible_ms, r => median(r.directory_replacement_visible_ms ?? []), r => r.vault_restored_visible_ms])
table('Resources', ['RSS MiB', 'heap MiB', 'child RSS MiB', 'idle CPU ms / 5 s', 'child idle CPU s', 'active handles while idle'], 'cold', [
  r => r.memory_mib?.rss, r => r.memory_mib?.heap_used, r => (r.children_busy ?? []).reduce((s, c) => s + c.rss_kib, 0) / 1024, r => r.idle?.plugin_process_cpu_ms, r => r.idle?.child_cpu_s,
  r => r.idle ? Object.values(r.idle.resources).reduce((a, b) => a + b, 0) : null])
const moved = rows.filter(row => row.phase === 'cold' && row.vault_moved)
if (moved.length) {
  lines.push('### Vault moved away during a session', '', '| Variant | Result of a search |', '| --- | --- |')
  for (const label of [...new Set(moved.map(r => r.label))]) lines.push(`| ${label} | ${JSON.stringify(moved.find(r => r.label === label).vault_moved)} |`)
  lines.push('')
}
const quality = rows.filter(row => row.phase === 'quality')
if (quality.length) {
  lines.push('### Recall quality (labelled corpus)', '', '| Variant | Backend | Query set | Relevant queries | Hit rate | Precision | No-hit queries | False-positive rate |', '| --- | --- | --- | --- | --- | --- | --- | --- |')
  for (const q of quality) lines.push(`| ${q.label} | ${q.backend} | ${q.query_set} | ${q.relevant_queries} | ${q.hit_rate} | ${q.precision} | ${q.no_hit_queries} | ${q.no_hit_false_positive_rate} |`)
  lines.push('')
}
console.log(lines.join('\n'))
