// Mounts a plugin entry in the official agent-loop test harness. Only public plugin
// behaviour is used (tools, recall admission), so the same workloads run against any version.
import { randomUUID, createHash } from 'node:crypto'
import { basename } from 'node:path'
import { execFileSync } from 'node:child_process'
import { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'

/** The vault folder naming rule is part of the Markdown compatibility contract. */
export const scopeFolder = project => `${basename(project).replace(/[^\p{L}\p{N}._-]/gu, '-').slice(0, 50)}-${createHash('sha256').update(project).digest('hex').slice(0, 12)}`

export async function mount({ entry, config, cwd }) {
  const plugin = await import(entry)
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  ctx.provide('subagents', { listChildren: async () => [] })
  const harness = await mountAgentLoopTestHarness(ctx)
  const requests = []
  class Adapter extends LlmAdapter {
    async *stream(options) {
      requests.push(options)
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'Done' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Done' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['test'], new Adapter())
  const started = performance.now()
  await ctx.plugin(plugin, config)
  const loadMs = performance.now() - started
  let agents = 0
  const createAgent = async () => harness.create(`bench-${agents++}`, { provider: 'test', model: 'test' }, { cwd })
  const agent = await createAgent()
  const invoke = async (name, args, a = agent) => {
    const result = await ctx.tools.execute({ callId: randomUUID(), name, arguments: args, agent: a, signal: new AbortController().signal })
    if (result.isError) throw new Error(`${name} failed: ${JSON.stringify(result.content).slice(0, 500)}`)
    return result.value
  }
  const ask = async (text, a = agent) => {
    const before = requests.length
    a.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }))
    await a.whenIdle()
    return requests.slice(before)
  }
  return { ctx, agent, createAgent, invoke, ask, requests, loadMs, dispose: () => ctx.fiber.dispose() }
}

/** Child processes of this process with resident memory (KiB) and CPU time (s). POSIX only. */
export function childProcesses() {
  if (process.platform === 'win32') return []
  const rows = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,rss=,time=,comm='], { encoding: 'utf8' }).trim().split('\n')
  const all = rows.map(line => line.trim().split(/\s+/)).map(([pid, ppid, rss, time, ...comm]) => ({ pid: +pid, ppid: +ppid, rssKiB: +rss, cpuSeconds: cpuSeconds(time), command: comm.join(' ') }))
  const descendants = [], frontier = [process.pid]
  while (frontier.length) {
    const parent = frontier.pop()
    for (const row of all) if (row.ppid === parent) { descendants.push(row); frontier.push(row.pid) }
  }
  return descendants.filter(row => row.command !== 'ps')
}

function cpuSeconds(value) {
  const parts = value.split(/[-:]/).map(Number)
  return parts.reduce((total, part) => total * 60 + part, 0)
}

export function resources() {
  const counts = {}
  for (const type of process.getActiveResourcesInfo()) counts[type] = (counts[type] ?? 0) + 1
  return counts
}

export const percentile = (values, p) => {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  return +sorted[Math.min(sorted.length - 1, Math.ceil(p / 100 * sorted.length) - 1)].toFixed(2)
}
