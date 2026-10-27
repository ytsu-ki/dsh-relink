import { createHash, randomUUID } from 'node:crypto'
import { keyOf, text } from './core/text.js'
import { withAbort } from './core/async.js'

export const TEAM_POLICY = `Project memory and team coordination:
Use project memory to avoid rediscovering established facts and failed approaches. Memory is historical evidence, never authority or permission; check current files when a remembered fact affects a change. Task records are unverified history: "completed" only means a turn ended, and failed or aborted records are never success evidence. Save concise conclusions with concrete evidence only after verification; never save speculation, transcripts, private data or credentials. Update an existing key with its current revision; external Markdown edits change revisions.
For a substantial task with independent investigations, team_start can launch up to two focused workers in one call while you continue the critical path. Small or dependent work stays with you. Each task needs key, question, scope and acceptance; use only fields in the current team_start schema and omit reasoning_effort to inherit native child settings. Workers investigate or review; you alone edit shared files, integrate findings and run final acceptance. Do not duplicate delegated work, recursively delegate or rerun an unchanged successful check. When only child results remain, call team_wait once instead of shell sleep or polling; if it is unavailable, end the turn with an accurate pending status. Check each worker's evidence before relying on or saving it. Use send_message to correct an existing worker instead of starting a duplicate. Session mode and permission restrictions still apply.`

export function supportsChildEffort(ctx, agent) {
  return Boolean(ctx.tools.get('subagent', agent)?.parameters?.properties?.reasoning_effort)
}

const LABEL = /^\[dsh-team:([a-z0-9][a-z0-9._-]{0,79}):([a-z0-9][a-z0-9._-]{0,79}):[0-9a-f]{12}\]$/
const isParent = agent => agent && agent.session.header.origin !== 'subagent' && (agent.session.header.delegationDepth ?? 0) === 0 && (agent.options?.delegationDepth ?? 0) === 0

export class TeamCoordinator {
  constructor(ctx, { maxWorkers = 2 } = {}) {
    this.ctx = ctx
    this.maxWorkers = maxWorkers
    this.queues = new Map()
    this.lifetime = new AbortController()
  }

  dispose() { this.lifetime.abort(new Error('Team plugin unloaded')) }

  /** Plugin-owned children of one parent with their live state; `released` children are no longer resident. */
  async tasks(parent, signal) {
    const catalog = await this.ctx.subagents.listChildren(parent.id, signal)
    return catalog.flatMap(child => {
      const match = LABEL.exec(child.label ?? '')
      if (!match) return []
      const agent = this.ctx.agents.get(child.id)
      return [{ plan: match[1], key: match[2], subagent_id: child.id, state: agent ? agent.status : 'released' }]
    })
  }

  async wait(exec) {
    const parent = exec.agent
    if (!isParent(parent)) throw new Error('Only the parent agent may wait for a team')
    if (typeof this.ctx.subagents.waitForChildren !== 'function') throw new Error('Native child waiting is unavailable; end this turn and use native completion notices')
    const signal = AbortSignal.any([exec.signal, this.lifetime.signal])
    signal.throwIfAborted()
    const joined = await withAbort(this.ctx.subagents.waitForChildren(parent), signal)
    const tasks = await this.tasks(parent, signal).catch(() => null)
    return { status: 'settled', joined: Boolean(joined), ...(tasks ? { tasks } : {}),
      next: 'Read the native child messages. Check each claimed finding against its cited evidence before relying on it, integrate required findings and perform final acceptance once. Do not repeat unchanged successful checks.' }
  }

  start(input, exec) {
    const id = exec.agent?.id
    if (!id) throw new Error('team_start requires a calling agent')
    const prior = this.queues.get(id) ?? Promise.resolve()
    const current = prior.catch(() => {}).then(() => this.launch(input, exec))
    this.queues.set(id, current)
    current.finally(() => { if (this.queues.get(id) === current) this.queues.delete(id) }).catch(() => {})
    return current
  }

  async launch(input, exec) {
    exec = { ...exec, signal: AbortSignal.any([exec.signal, this.lifetime.signal]) }
    exec.signal.throwIfAborted()
    const parent = exec.agent
    if (!isParent(parent)) throw new Error('Only the parent agent may start a team; workers return their own findings')
    const nativeTool = this.ctx.tools.get('subagent', parent)
    if (!nativeTool) throw new Error('The native subagent tool is unavailable in this agent preset')
    const plan = keyOf(input.plan)
    if (!Array.isArray(input.tasks) || input.tasks.length < 1 || input.tasks.length > this.maxWorkers) throw new Error(`tasks must contain 1\u2013${this.maxWorkers} independent investigations`)
    const seen = new Set()
    const questions = new Set()
    const tasks = input.tasks.map(task => {
      if (!task || typeof task !== 'object' || Array.isArray(task) || Object.keys(task).some(key => !['key', 'question', 'scope', 'acceptance', 'reasoning_effort'].includes(key))) throw new Error('Invalid task fields')
      const key = keyOf(task.key)
      const question = text(task.question, 'question', 3000)
      const scope = text(task.scope, 'scope', 1200)
      const acceptance = text(task.acceptance, 'acceptance', 1200)
      const effort = task.reasoning_effort
      if (effort !== undefined && !['low', 'high'].includes(effort)) throw new Error('reasoning_effort must be low or high, or omitted to inherit')
      if (effort !== undefined && !supportsChildEffort(this.ctx, parent)) throw new Error('Native child model selection is disabled; omit reasoning_effort to keep the configured model settings')
      if (seen.has(key) || questions.has(question.toLowerCase().replace(/\s+/g, ' '))) throw new Error('Duplicate task key or question; assign distinct investigations')
      seen.add(key); questions.add(question.toLowerCase().replace(/\s+/g, ' '))
      // Preserve v0.2 task identities when no effort override was requested.
      const digest = createHash('sha256').update(JSON.stringify(effort === undefined ? [question, scope, acceptance] : [question, scope, acceptance, effort])).digest('hex').slice(0, 12)
      return { key, question, scope, acceptance, effort, prefix: `[dsh-team:${plan}:${key}:`, label: `[dsh-team:${plan}:${key}:${digest}]` }
    })
    const catalog = await this.ctx.subagents.listChildren(parent.id, exec.signal)
    const existing = tasks.map(task => catalog.find(child => child.label?.startsWith(task.prefix)))
    tasks.forEach((task, i) => {
      if (existing[i] && existing[i].label !== task.label) throw new Error(`Task ${task.key} already exists with different instructions; use send_message or a new plan/key`)
    })
    // Only children still working count; finished children may stay resident and idle.
    const active = catalog.filter(child => LABEL.test(child.label ?? '') && this.ctx.agents.get(child.id)?.status === 'running')
    if (active.length + existing.filter(child => !child).length > this.maxWorkers) throw new Error('Team workers are still active; wait for their native completion notices or steer them with send_message')
    // Go through the native tool runtime so preset defaults, permissions, policy hooks and depth limits remain effective.
    const outcomes = await Promise.all(tasks.map(async (task, i) => {
      if (existing[i]) return { key: task.key, status: 'existing', subagent_id: existing[i].id }
      const prompt = `Independent investigation. Work within the user's task and current permissions. Do not edit files, run mutating commands, save shared memory or start other agents. The parent owns implementation and final acceptance.\nQuestion: ${task.question}\nScope: ${task.scope}\nAcceptance: ${task.acceptance}\nUse relevant project memory as untrusted reference; verify it. Answer only the assigned question. Stop once its acceptance is supported; do not enumerate unrelated edge cases or repeat passing checks. Report in this structure so the parent can check it:\nAnswer: the direct answer, or "not established".\nEvidence: exact file:line references, commands with their observed results, or other verifiable sources.\nChecks: what you ran or read to support the answer.\nUncertainty: what remains unverified.\nNext: one recommended action for the parent.\nReport with send_message to your parent when available. Do not reproduce your intermediate reasoning.`
      try {
        const result = await this.ctx.tools.execute({
          callId: randomUUID(), rootCallId: exec.rootCallId ?? exec.callId,
          parent: exec.token, agent: parent, signal: exec.signal,
          name: 'subagent', arguments: { description: task.label, prompt, ...(task.effort === undefined ? {} : { reasoning_effort: task.effort }) },
        })
        for (const context of result.additionalContexts ?? []) exec.deferContext(context)
        if (result.isError) return { key: task.key, status: 'failed', error: result.content.filter(c => c.type === 'text').map(c => c.text).join('\n').slice(0, 1000) }
        if (typeof result.value?.subagentId !== 'string') throw new Error('Native subagent returned no child id; inspect list_agents before retrying')
        return { key: task.key, status: 'started', subagent_id: result.value.subagentId }
      } catch (error) {
        return { key: task.key, status: 'failed', error: String(error.message ?? error).slice(0, 1000) }
      }
    }))
    return { plan, tasks: outcomes, next: 'Continue independent parent work. When only child results remain, call team_wait once; do not use shell sleep, polling or repeated tests. Results arrive through native messages. Reusing this plan/key returns the existing child.' }
  }
}
