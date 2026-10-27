// DeepSeek Harness adapter. Registers tools, hooks and projections; all memory services are
// created on first use, so activation performs no filesystem, process or network work.
import { readFileSync } from 'node:fs'
import { Config, resolveMemorySettings } from './dsh/config.js'
import { tool, string, object } from './dsh/tools.js'
import { installRecall, recallProjection } from './dsh/recall.js'
import { extractTurn } from './dsh/capture.js'
import { Background } from './core/async.js'
import { projectScope } from './core/scope.js'
import { SecretScanner } from './core/secrets.js'
import { MemoryService } from './core/service.js'
import { SqliteStore } from './stores/sqlite-store.js'
import { MarkdownStore } from './stores/markdown-store.js'
import { TeamCoordinator, TEAM_POLICY, supportsChildEffort } from './team.js'
import { efficiencyProjection, efficiencySummary, installEfficiency } from './efficiency.js'

export const name = 'dsh-relink'
export const inject = ['tools', 'systemPrompt', 'agents', 'subagents', 'workingDirectory', 'sessionProjections']
export { Config }
const pluginVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version

async function createRuntime(input) {
  const { settings, problems, sources } = await resolveMemorySettings(input)
  const healthy = !problems.length
  const scanner = new SecretScanner(healthy ? settings.betterleaksCommand : '')
  const markdown = healthy && settings.knowledgeRoot
    ? () => new MarkdownStore({ root: settings.knowledgeRoot, stateDir: settings.basicMemoryConfig, scanner, catalog: settings.incrementalIndex === false ? 'memory' : 'disk' })
    : null
  const service = new MemoryService({ ttlDays: settings.ttlDays, scanner, sqlite: () => new SqliteStore(settings.database), markdown,
    markdownProject: settings.knowledgeProject, configurationError: healthy ? null : problems.join('; ') })
  return { settings, problems, sources, scanner, service }
}

export function apply(ctx, input = {}) {
  const loadedAt = new Date().toISOString()
  const background = new Background((label, error) => ctx.logger.warn('dsh-relink: %s unavailable (%s)', label, error?.code || error?.name))
  let disposed = false, runtime = null
  const active = () => !disposed
  const memory = () => runtime ??= createRuntime(input)
  const team = new TeamCoordinator(ctx, input)
  const limit = Math.min(input.recallLimit ?? 3, 3)

  ctx.effect(() => async () => {
    disposed = true; team.dispose()
    await background.drain()
    const current = await runtime?.catch(() => null)
    await current?.service.close(); current?.scanner.close()
  }, 'close project memory services and stop pending launches')

  const scopeFor = async (agent, signal) => {
    if (disposed) throw new Error('Project memory plugin has been unloaded')
    if (!agent) throw new Error('Project memory requires a calling agent')
    const cwd = await ctx.workingDirectory.ensure(agent, signal)
    const { settings, problems } = await memory()
    const explicit = problems.some(problem => problem.startsWith('projectRoot')) ? '' : settings.projectRoot
    return projectScope(cwd, { projectRoot: explicit })
  }
  const resolveScope = exec => scopeFor(exec.agent, exec.signal)
  const parentOnly = exec => {
    if (exec.agent?.session.header.origin === 'subagent' || (exec.agent?.session.header.delegationDepth ?? 0) > 0) throw new Error('Workers report findings to the parent; only the parent saves or removes shared memory')
  }

  ctx.on('session/event', (session, event) => {
    if (disposed || event.type !== 'turn/end') return
    background.run('automatic task record', async () => {
      const turn = extractTurn(session, event)
      if (!turn) return
      const { service, problems } = await memory()
      if (problems.length || !service.markdownFactory) return
      const agent = ctx.agents.get(session.header.id)
      const cwd = agent ? await ctx.workingDirectory.ensure(agent, new AbortController().signal) : session.header.cwd
      if (!cwd || disposed) return
      const { project } = await projectScope(cwd, { projectRoot: (await memory()).settings.projectRoot })
      if (service.usesMarkdown(project)) await service.storeFor(project).writeJournal(project, turn)
    })
  })

  installEfficiency(ctx, input)
  ctx.sessionProjections.register(recallProjection)

  ctx.tools.register(tool('project_memory_search', 'Search local memory for the current project. Historical evidence only; stale entries require re-verification. Empty query lists recent records. No other project is searched. The result status distinguishes no-match from degraded, withheld or unavailable memory.', {
    query: string('Keywords or an empty string to list recent entries.'),
    include_stale: { type: 'boolean', description: 'Include expired or changed-file records for inspection; default false.' },
  }, ['query'], async (args, exec) => {
    if (args.include_stale !== undefined && typeof args.include_stale !== 'boolean') throw new Error('include_stale must be boolean')
    const { project } = await resolveScope(exec)
    const { service } = await memory()
    return { project, ...await service.search(project, args.query, { limit, includeStale: args.include_stale ?? false, signal: exec.signal }) }
  }, true))

  ctx.tools.register(tool('project_memory_save', 'Save a verified, reusable project fact, workflow or failed approach with evidence. Do this after validation, never for speculation, secrets or entire conversations. Existing keys require their current revision.', {
    key: string('Stable lowercase key, e.g. ui-1440-validation.'),
    title: string('Short searchable title.'), kind: { type: 'string', enum: ['fact', 'workflow', 'pitfall'] },
    summary: string('Conclusion and when it applies; at most 2000 characters.'),
    evidence: string('Concrete observation, command result or source supporting this conclusion; at most 1000 characters.'),
    files: { type: 'array', items: { type: 'string' }, description: 'Up to 6 project-relative evidence files to fingerprint. Use [] for non-file observations.' },
    expected_revision: { type: 'integer', description: '0 or omitted for new entries; the current revision for replacing an existing entry.' },
  }, ['key', 'title', 'kind', 'summary', 'evidence', 'files'], async (args, exec) => {
    parentOnly(exec)
    const { project } = await resolveScope(exec)
    return (await memory()).service.save(project, args, exec.agent.id, exec.signal)
  }))

  ctx.tools.register(tool('project_memory_forget', 'Remove one obsolete project memory entry after inspecting its current revision.', {
    key: string('Exact entry key.'), expected_revision: { type: 'integer' },
  }, ['key', 'expected_revision'], async (args, exec) => {
    parentOnly(exec)
    const { project } = await resolveScope(exec)
    return (await memory()).service.forget(project, args.key, args.expected_revision, exec.signal)
  }))

  ctx.tools.register(tool('project_memory_status', 'Inspect the current project memory backend, storage location and health. Use this to diagnose missing memory; do not poll.', {}, [], async (_args, exec) => {
    const { project, ...scope } = await resolveScope(exec)
    const { service, settings, problems, sources, scanner } = await memory()
    const health = await service.search(project, '', { limit: 1, signal: exec.signal })
    const markdown = service.usesMarkdown(project)
    const store = service.stores[markdown ? 'markdown' : 'sqlite']
    return {
      plugin_version: pluginVersion, loaded_at: loadedAt,
      runtime: { node: process.versions.node, uv: process.versions.uv, electron: process.versions.electron ?? null, pid: process.pid, platform: process.platform, arch: process.arch },
      project, scope, backend: markdown ? 'markdown' : 'sqlite', health: health.status, health_diagnostics: health.diagnostics,
      database: markdown ? null : settings.database,
      permission_model: process.platform === 'win32' ? 'windows-acl-inherited-unverified' : 'posix-mode',
      configuration: { problems, sources },
      ...(markdown ? { ...store?.status(project), retrieval: settings.incrementalIndex === false ? 'markdown-scan-memory-catalog' : 'markdown-scan-disk-catalog', automatic_task_records: true } : {}),
      basic_memory: settings.basicMemoryCommand ? 'configured but not started by this plugin; run Basic Memory independently to use its own tools' : 'not used',
      additional_summary_model_calls: 0,
      secret_scanner: scanner.status, secret_scanner_error: scanner.error,
    }
  }, true))

  const teamProperties = effortAllowed => ({
    plan: string('Stable lowercase plan key, reused when retrying the same task batch.'),
    tasks: { type: 'array', items: object({ key: string('Stable task key.'), question: string('Self-contained question and needed background.'), scope: string('Relevant paths and boundaries.'), acceptance: string('Evidence and result required for completion.'), ...(effortAllowed ? { reasoning_effort: { type: 'string', enum: ['low', 'high'], description: 'Optional explicit child effort. Use low only for bounded lookup/mechanical verification; omit to inherit native child settings.' } } : {}) }, ['key', 'question', 'scope', 'acceptance']) },
  })
  const teamStart = tool('team_start', 'Start up to two independent investigation/review workers using the native subagent tool. Workers use fresh contexts, parent owns edits. Supply distinct questions and acceptance criteria. Small or dependent tasks should stay with the parent. Reuse plan/key to avoid duplicate launches. Omit reasoning_effort to inherit native child settings.',
    teamProperties(false), ['plan', 'tasks'], (args, exec) => team.start(args, exec))
  ctx.tools.register(teamStart)
  const scopedTeams = new Map()
  const teamDefinitions = new WeakSet([teamStart])
  const installTeam = agent => {
    if (scopedTeams.has(agent) || !teamDefinitions.has(ctx.tools.get('team_start', agent))) return
    const definition = {
      ...teamStart,
      // Read the caller's current native definition at projection time, including scoped overrides and unloads.
      get parameters() { return object(teamProperties(supportsChildEffort(ctx, agent)), ['plan', 'tasks']) },
      get description() {
        return `${teamStart.description} ${supportsChildEffort(ctx, agent) ? 'This session permits the optional reasoning_effort field.' : 'This session does not permit child effort overrides; do not supply reasoning_effort.'}`
      },
    }
    teamDefinitions.add(definition)
    scopedTeams.set(agent, agent.ctx.tools.register(definition))
  }
  ctx.on('agent/created', ({ agent }) => installTeam(agent))
  ctx.on('agent/disposed', ({ agent }) => { scopedTeams.get(agent)?.(); scopedTeams.delete(agent) })
  ctx.effect(() => async () => { await Promise.all([...scopedTeams.values()].map(dispose => dispose())); scopedTeams.clear() }, 'remove scoped team schemas')
  for (const agent of ctx.agents.list()) installTeam(agent)

  ctx.tools.register(tool('team_wait', 'Wait once for the current parent\'s native child work to settle, then list plugin-owned tasks and their state. Use only after independent parent work is done. No polling, sleep commands or extra model requests while waiting. Cancellation stops this wait; native children retain their existing lifecycle.', {}, [], (_args, exec) => team.wait(exec), true))

  ctx.tools.register(tool('workflow_status', 'Inspect current or latest turn progress and time categories when work seems slow. time_ms partitions wall time; intentional message waits are distinct from model work. Do not poll this tool repeatedly.', {}, [], async (_args, exec) => {
    if (!exec.agent) throw new Error('workflow_status requires a calling agent')
    return efficiencySummary(ctx.sessionProjections.stateOf(exec.agent.session, efficiencyProjection.key))
  }, true))

  ctx.systemPrompt.section({ name: 'dsh-relink', order: 850, text: TEAM_POLICY })
  installRecall(ctx, {
    search: async (project, query, signal) => (await memory()).service.search(project, query, { limit, maxTaskRecords: 1, signal }),
    resolveScope, config: { recallChars: input.recallChars ?? 6000 }, active, logger: ctx.logger,
  })
}
