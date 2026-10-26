import z from '@deepseek-ai/schemastery'
import { homedir } from 'node:os'
import { resolve, isAbsolute } from 'node:path'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { MemoryStore, projectScope, renderMemories } from './memory.js'
import { TeamCoordinator, TEAM_POLICY, supportsChildEffort } from './team.js'
import { efficiencyProjection, efficiencySummary, installEfficiency } from './efficiency.js'
import { BasicMemoryClient, KnowledgeStore } from './basic-memory.js'
import { SecretScanner } from './secrets.js'

export const name = 'dsh-memory-team'
export const inject = ['tools', 'systemPrompt', 'agents', 'subagents', 'workingDirectory', 'sessionProjections']
const pluginVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
export const Config = z.object({
  database: z.string().default(''),
  projectRoot: z.string(),
  ttlDays: z.number().step(1).min(1).max(365).default(30),
  recallLimit: z.number().step(1).min(1).max(6).default(3),
  recallChars: z.number().step(1).min(1000).max(12000).default(6000),
  maxWorkers: z.number().step(1).min(1).max(2).default(2),
  repeatThreshold: z.number().step(1).min(2).max(10).default(3),
  checkpointSteps: z.number().step(1).min(10).max(100).default(20),
  longOutputTokens: z.number().step(1).min(1000).max(32000).default(4000),
  knowledgeRoot: z.string(),
  basicMemoryCommand: z.string(),
  basicMemoryConfig: z.string(),
  knowledgeProject: z.string(),
  betterleaksCommand: z.string(),
  incrementalIndex: z.boolean().default(true),
})

const string = description => ({ type: 'string', description })
const object = (properties, required) => ({ type: 'object', additionalProperties: false, properties, required })

function tool(name, description, properties, required, execute, concurrency = false) {
  return {
    name, description, parameters: object(properties, required),
    output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    isConcurrencySafe: () => concurrency,
    async execute(args, exec) {
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Arguments must be an object')
      if (Object.keys(args).some(key => !Object.hasOwn(properties, key)) || required.some(key => !Object.hasOwn(args, key))) throw new Error('Missing or unknown tool arguments')
      exec.signal.throwIfAborted()
      return execute(args, exec)
    },
  }
}

export function apply(ctx, input = {}) {
  const loadedAt = new Date().toISOString()
  let local = {}
  try { local = JSON.parse(readFileSync(resolve(homedir(), '.local/share/dsh-memory-team/settings.json'), 'utf8')) }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('Invalid local dsh-memory-team settings') }
  const allowed = ['projectRoot', 'knowledgeRoot', 'basicMemoryCommand', 'basicMemoryConfig', 'knowledgeProject', 'betterleaksCommand']
  // Leave these fields optional in Config so loader defaults cannot erase the local setup.
  const config = Config({ ...Object.fromEntries(Object.entries(local).filter(([key]) => allowed.includes(key))),
    ...Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)),
  })
  config.knowledgeRoot ??= ''; config.basicMemoryCommand ??= 'basic-memory'
  config.basicMemoryConfig ??= ''; config.knowledgeProject ??= ''
  config.betterleaksCommand ??= ''
  config.projectRoot ??= ''
  if (config.projectRoot && !isAbsolute(config.projectRoot)) throw new Error('projectRoot must be absolute')
  if (config.betterleaksCommand && !isAbsolute(config.betterleaksCommand)) throw new Error('betterleaksCommand must be absolute')
  if ([config.knowledgeRoot, config.basicMemoryConfig, config.knowledgeProject].some(path => path && !isAbsolute(path))) throw new Error('Knowledge paths must be absolute')
  const dataRoot = process.env.DSH_PROFILE_DIR || process.env.DSH_HOME || resolve(homedir(), '.dsh')
  const scanner = new SecretScanner(config.betterleaksCommand)
  const legacy = new MemoryStore(config.database || resolve(dataRoot, 'data', 'dsh-memory-team.sqlite'), { ...config, scanner })
  config.basicMemoryConfig ||= resolve(dataRoot, 'data', 'basic-memory')
  const knowledge = config.knowledgeRoot ? new KnowledgeStore(config.knowledgeRoot, config,
    new BasicMemoryClient({ command: config.basicMemoryCommand, configDir: config.basicMemoryConfig }), scanner) : null
  const storeFor = project => knowledge && (!config.knowledgeProject || project === config.knowledgeProject) ? knowledge : legacy
  const scopeFor = cwd => projectScope(cwd, { projectRoot: config.projectRoot })
  const captures = new Set()
  let disposed = false
  const team = new TeamCoordinator(ctx, config)
  ctx.effect(() => async () => {
    disposed = true; team.dispose()
    await Promise.allSettled([...captures]); await knowledge?.flush(); await knowledge?.close(); legacy.close(); scanner.close()
  }, 'close project memory services and stop pending launches')
  ctx.on('session/event', (session, event) => {
    if (!knowledge || disposed || event.type !== 'turn/end') return
    const work = (async () => {
      const agent = ctx.agents.get(session.header.id)
      const cwd = agent ? await ctx.workingDirectory.ensure(agent, new AbortController().signal) : session.header.cwd
      if (!cwd) return
      const { project } = await scopeFor(cwd)
      if (storeFor(project) === knowledge) await knowledge.capture(project, session, event)
    })().catch(error => ctx.logger.warn('Automatic task record unavailable (%s)', error.code || error.name))
    captures.add(work); work.finally(() => captures.delete(work)).catch(() => {})
  })
  installEfficiency(ctx, config)
  const resolveScope = async exec => {
    if (disposed) throw new Error('Project memory plugin has been unloaded')
    if (!exec.agent) throw new Error('Project memory requires a calling agent')
    const cwd = await ctx.workingDirectory.ensure(exec.agent, exec.signal)
    return scopeFor(cwd)
  }
  const resolveProject = async exec => (await resolveScope(exec)).project
  const parentOnly = exec => {
    if (exec.agent?.session.header.origin === 'subagent' || (exec.agent?.session.header.delegationDepth ?? 0) > 0) throw new Error('Workers report findings to the parent; only the parent saves or removes shared memory')
  }

  ctx.tools.register(tool('project_memory_search', 'Search local memory for the current project. Historical evidence only; stale entries require re-verification. Empty query lists recent records. No other project is searched.', {
    query: string('Keywords or an empty string to list recent entries.'),
    include_stale: { type: 'boolean', description: 'Include expired or changed-file records for inspection; default false.' },
  }, ['query'], async (args, exec) => {
    if (args.include_stale !== undefined && typeof args.include_stale !== 'boolean') throw new Error('include_stale must be boolean')
    const project = await resolveProject(exec)
    return { project, records: await storeFor(project).search(project, args.query, { limit: Math.min(config.recallLimit, 3), includeStale: args.include_stale ?? false, signal: exec.signal }) }
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
    const project = await resolveProject(exec)
    return storeFor(project).save(project, args, exec.agent.id, exec.signal)
  }))

  ctx.tools.register(tool('project_memory_forget', 'Remove one obsolete project memory entry after inspecting its current revision.', {
    key: string('Exact entry key.'), expected_revision: { type: 'integer' },
  }, ['key', 'expected_revision'], async (args, exec) => {
    parentOnly(exec)
    const project = await resolveProject(exec)
    return storeFor(project).forget(project, args.key, args.expected_revision)
  }))

  ctx.tools.register(tool('project_memory_status', 'Inspect the current project memory backend and local Markdown location. Use this to diagnose missing memory; do not poll.', {}, [], async (_args, exec) => {
    const { project, ...scope } = await resolveScope(exec), backend = storeFor(project)
    return { plugin_version: pluginVersion, loaded_at: loadedAt, runtime: { node: process.versions.node, uv: process.versions.uv, pid: process.pid },
      project, scope, backend: backend === knowledge ? 'basic-memory' : 'legacy-sqlite',
      database: backend === legacy ? legacy.path : null,
      permission_model: process.platform === 'win32' ? 'windows-acl-inherited-unverified' : 'posix-mode',
      ...(backend === knowledge ? { vault: knowledge.root, folder: knowledge.folder(project), service: knowledge.client.status,
        retrieval: config.incrementalIndex ? 'orama-incremental' : 'basic-memory-scan',
        index: knowledge.indexes.has(project) ? { ...knowledge.indexes.get(project).metrics,
          records: knowledge.indexes.get(project).entries.size, degraded: Boolean(knowledge.indexes.get(project).error || knowledge.indexes.get(project).watcherError),
          watcher: knowledge.indexes.get(project).watcherMode, watcher_error: knowledge.indexes.get(project).watcherError ?? null } : null,
        automatic_task_records: true, additional_summary_model_calls: 0 } : {}),
      secret_scanner: scanner.status,
      secret_scanner_error: scanner.error,
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

  ctx.tools.register(tool('team_wait', 'Wait once for the current parent\'s native child work to settle. Use only after independent parent work is done. No polling, sleep commands or extra model requests while waiting. Cancellation stops this wait; native children retain their existing lifecycle.', {}, [], (_args, exec) => team.wait(exec), true))

  ctx.tools.register(tool('workflow_status', 'Inspect current or latest turn progress and time categories when work seems slow. Reports overlapping observed intervals; intentional message waits are distinct from model work. Do not poll this tool repeatedly.', {}, [], async (_args, exec) => {
    if (!exec.agent) throw new Error('workflow_status requires a calling agent')
    return efficiencySummary(ctx.sessionProjections.stateOf(exec.agent.session, efficiencyProjection.key))
  }, true))

  ctx.systemPrompt.section({ name: 'dsh-memory-team', order: 850, text: TEAM_POLICY })
  // Append through pre-step admission so recall becomes an ordinary durable user/message,
  // rather than mutating frozen LLM requests or writing unknown session event types.
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (disposed || decision.kind !== 'enter') return decision
    const prompts = payload.messages.filter(message => message.source?.kind === 'user')
    if (!prompts.length) return decision
    const query = prompts.flatMap(message => message.content).filter(block => block.type === 'text').map(block => block.text).join('\n').slice(0, 4000)
    if (!query.trim()) return decision
    try {
      const { project, warning } = await resolveScope(payload)
      const records = await storeFor(project).search(project, query, { limit: Math.min(config.recallLimit, 3), signal: payload.signal })
      const prefix = `Current project: ${project}. This turn's recall supersedes earlier recall; prior records may be stale.\n${warning ? 'Home or filesystem-root Git scope ignored; using the current working directory. Set projectRoot explicitly to share that scope.\n' : ''}`
      const rendered = renderMemories(records, Math.max(0, config.recallChars - prefix.length))
      payload.signal.throwIfAborted()
      if (disposed) return decision
      const current = `${prefix}${rendered || 'No matching current memory. Verify earlier conclusions against current evidence.'}`.slice(0, config.recallChars)
      const memory = Object.freeze({
        id: randomUUID(), role: 'user',
        source: Object.freeze({ kind: 'dsh-memory-team', form: 'context' }),
        content: Object.freeze([Object.freeze({ type: 'text', text: current })]),
      })
      return { ...decision, messages: [...decision.messages, memory] }
    } catch (error) {
      if (payload.signal.aborted) throw error
      ctx.logger.warn('Project memory recall unavailable (%s); continuing without recall', error.code || error.name)
      return decision
    }
  })
}
