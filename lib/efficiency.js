import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'

export const EFFICIENCY_POLICY = `Execution efficiency:
Keep required deliverables complete. For long formulas, repetitive edits or generated code, reuse one validated template or script and verify representative cases. Save large deliverables to their files and report the change and evidence concisely; give full text when the user asks for it.
For substantial work, define a checkable outcome, make the smallest useful check, then implement and validate; finish when the outcome and required checks pass. After repeated identical failures, inspect the failing boundary and change approach. Batch independent reads when safe; keep dependent edits and approvals sequential. Anchor revisions to a specific unmet requirement or observed defect; requested refinements, proofs and variants stay in scope.
Run long commands once through the native background-job mechanism, keep the job id and continue independent work. Do not poll unchanged output or start duplicate installs, tests or servers. Planned listener waits are intentional, not a reason to restart a service. Ask only for missing user-owned decisions; keep every permission check.
workflow_status reports observed counters and time for the current or latest turn; use it to diagnose slow progress, not as a polling step. Reminders are advice and never a reason to omit requested work.`

export const SVG_WORKFLOW = `SVG creation workflow for this request (within the user's requirements and this agent's assigned scope):
Write one complete, recognizable first SVG to its intended file before comparing optional compositions. Use the user's requirements as acceptance conditions: valid XML; the requested subject and action are recognizable; required parts are visible; no blocking clipping or overlap; the file and preview open. Render and inspect one full preview, then fix concrete failures. Check a crop only to verify a specific defect that the full preview cannot resolve. Once those conditions pass, present the files and finish instead of inventing optional polish. Explicit requests for refinement, variants, animation or additional checks still apply.
Reuse a renderer and Python runtime already confirmed available in this environment; do not assume default Python has image libraries. If one independent review would resolve a persistent acceptance uncertainty and native workers are available, delegate that bounded review once, with the exact requirement and evidence; keep edits in the parent and use team_wait when only that result remains. Do not create workers for a simple task without an independent question. These are workflow instructions, not evidence that any check has already passed.`

export function isSvgCreation(messages) {
  const text = messages.filter(message => message.source?.kind === 'user')
    .flatMap(message => message.content).filter(block => block.type === 'text').map(block => block.text).join('\n').slice(0, 4000).trim()
  if (/^(?:\u8bf7|\u8bf7\u4f60)?(?:\u89e3\u91ca|\u8bb2\u89e3|\u4ecb\u7ecd|\u5206\u6790|\u8bf4\u660e|\u5982\u4f55|\u600e\u4e48)|^(?:explain|how\b|what\b|why\b)/i.test(text)) return false
  if (/(?:\u4e0d\u8981|\u65e0\u9700|\u4e0d\u7528|\u522b)\s*(?:\u751f\u6210|\u5236\u4f5c|\u7ed8\u5236|\u521b\u5efa|\u8bbe\u8ba1)|\b(?:do not|don't)\s+(?:create|draw|generate|make|design|build)\b/i.test(text)) return false
  return /\bsvg\b/i.test(text) && /\u751f\u6210|\u5236\u4f5c|\u7ed8\u5236|\u753b\u4e00|\u753b\u4e2a|\u521b\u5efa|\u8bbe\u8ba1|\b(?:create|draw|generate|make|design|build)\b/i.test(text)
}

const number = z.number().finite().nonnegative()
const callSchema = z.object({ id: z.string(), name: z.string(), key: z.string(), kind: z.string(), nested: z.boolean(), artifact: z.string(), review: z.string() })
const sampleSchema = z.object({ name: z.string(), key: z.string(), result: z.string(), count: number })
const outputSchema = z.object({ step: number, tokens: number, reasoningChars: number, textChars: number, argumentChars: number })
const artifactSchema = z.object({ key: z.string(), edits: number, reviewed: number, cycles: number })
const timingKeys = ['modelPhaseMs', 'toolWindowMs', 'approvalWaitMs', 'questionWaitMs', 'backgroundWaitMs', 'intentionalWaitMs']
// Exclusive attribution: each instant belongs to the first active category in this order.
const exclusiveKeys = ['approval', 'question', 'background', 'intentional', 'tool', 'model', 'other']
const stateSchema = z.object({
  inherited: number, turn: number, start: number, through: number, ended: z.boolean(), modelOpen: z.boolean(),
  steps: number, workSteps: number, stepCalls: number, stepWork: z.boolean(), outputTokens: number, peakOutputTokens: number, failedAttempts: number, retries: number,
  transportRetries: number, toolCalls: number, notices: z.array(z.string()).max(3),
  calls: z.array(callSchema), approvals: z.array(z.string()), samples: z.array(sampleSchema).max(16),
  lastOutput: outputSchema, reasoningChars: number, textChars: number, argumentChars: number,
  svgWorkflow: z.boolean(), focusArtifact: z.string(), artifacts: z.array(artifactSchema).max(8),
  ...Object.fromEntries(timingKeys.map(key => [key, number])),
  exclusive: z.object(Object.fromEntries(exclusiveKeys.map(key => [key, number]))), faults: number,
})

function initial(inherited = 0) {
  return { inherited, turn: 0, start: 0, through: 0, ended: true, modelOpen: false,
    steps: 0, workSteps: 0, stepCalls: 0, stepWork: false, outputTokens: 0, peakOutputTokens: 0, failedAttempts: 0, retries: 0, transportRetries: 0,
    toolCalls: 0, notices: [], calls: [], approvals: [], samples: [],
    lastOutput: { step: 0, tokens: 0, reasoningChars: 0, textChars: 0, argumentChars: 0 },
    reasoningChars: 0, textChars: 0, argumentChars: 0, svgWorkflow: false, focusArtifact: '', artifacts: [],
    ...Object.fromEntries(timingKeys.map(key => [key, 0])),
    exclusive: Object.fromEntries(exclusiveKeys.map(key => [key, 0])), faults: 0,
  }
}

function activeCategory(state, kinds) {
  if (state.approvals.length) return 'approval'
  for (const kind of ['question', 'background', 'intentional']) if (kinds.has(kind)) return kind
  if (state.calls.length) return 'tool'
  return state.modelOpen ? 'model' : 'other'
}

export function toolKind(name, args) {
  if (/^(ask_user_question|ask_user|request_user_input)$/.test(name)) return 'question'
  if (/^(team_wait|job_output|wait_job|wait_for_job|wait_agent|wait_agents|wait_threads|list_agents)$/.test(name)) return 'background'
  if (/^(qq_wait_for_messages|sleep|wait_for_messages)$/.test(name)) return 'intentional'
  if (['bash', 'exec_command', 'shell'].includes(name)) {
    try {
      const input = typeof args === 'string' ? JSON.parse(args) : args
      const command = input?.command ?? input?.cmd
      // Only recognize a pure wait with an optional literal echo, never an arbitrary shell pipeline.
      if (typeof command === 'string' && /^\s*(?:\/bin\/)?sleep\s+\d+(?:\.\d+)?\s*(?:;\s*echo\s+[\w .-]+)?\s*$/.test(command)) return 'intentional'
    } catch { /* Unknown shell arguments remain ordinary tool work. */ }
  }
  return 'tool'
}

function hash(value) { return createHash('sha256').update(value).digest('hex').slice(0, 24) }
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
  return value
}
function callKey(name, args) {
  try {
    const value = typeof args === 'string' ? JSON.parse(args) : args
    // Display labels may change even though the requested operation is identical.
    const normalized = value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).filter(([key]) => !['description', 'display_description'].includes(key))) : value
    return hash(`${name}\0${JSON.stringify(canonical(normalized))}`)
  } catch { return hash(`${name}\0${String(args)}`) }
}

function advance(state, time) {
  if (state.ended || time <= state.through) return state
  const delta = time - state.through
  const kinds = new Set(state.calls.map(call => call.kind))
  const category = activeCategory(state, kinds)
  return { ...state, through: time, exclusive: { ...state.exclusive, [category]: state.exclusive[category] + delta },
    modelPhaseMs: state.modelPhaseMs + (state.modelOpen ? delta : 0),
    toolWindowMs: state.toolWindowMs + (state.calls.length ? delta : 0),
    approvalWaitMs: state.approvalWaitMs + (state.approvals.length ? delta : 0),
    questionWaitMs: state.questionWaitMs + (kinds.has('question') ? delta : 0),
    backgroundWaitMs: state.backgroundWaitMs + (kinds.has('background') ? delta : 0),
    intentionalWaitMs: state.intentionalWaitMs + (kinds.has('intentional') ? delta : 0),
  }
}

function startCall(state, id, name, args, nested) {
  if (state.calls.some(call => call.id === id)) return state
  const kind = toolKind(name, args)
  const wrapper = name === 'run_code'
  let artifact = ''
  if (state.svgWorkflow && /^(write|write_file|edit|str_replace_editor)$/.test(name)) {
    try {
      const input = typeof args === 'string' ? JSON.parse(args) : args
      const file = input?.file_path ?? input?.path
      if (typeof file === 'string' && /\.svg$/i.test(file)) artifact = hash(file)
    } catch { /* Unknown arguments cannot identify an artifact. */ }
  }
  const review = state.svgWorkflow && /^(read_image|view_image)$/.test(name) ? state.focusArtifact : ''
  return { ...state, toolCalls: state.toolCalls + (name === 'run_code' ? 0 : 1),
    stepCalls: state.stepCalls + (wrapper ? 0 : 1),
    stepWork: state.stepWork || (!wrapper && kind === 'tool' && name !== 'workflow_status'),
    calls: [...state.calls, { id, name, key: callKey(name, args), kind, nested, artifact, review }],
  }
}

function finishCall(state, id, content, isError) {
  const call = state.calls.find(call => call.id === id)
  if (!call) return state
  const calls = state.calls.filter(entry => entry.id !== id)
  if (!isError && call.artifact) {
    const previous = state.artifacts.find(entry => entry.key === call.artifact) ?? { key: call.artifact, edits: 0, reviewed: 0, cycles: 0 }
    state = { ...state, focusArtifact: call.artifact, artifacts: [...state.artifacts.filter(entry => entry.key !== call.artifact),
      { ...previous, edits: previous.edits + 1 }].slice(-8) }
  }
  if (!isError && call.review) state = { ...state, artifacts: state.artifacts.map(entry => entry.key === call.review && entry.edits > entry.reviewed
    ? { ...entry, reviewed: entry.edits, cycles: entry.cycles + 1 } : entry) }
  // Expected waits and transport wrappers must never produce a no-progress warning.
  if (call.kind !== 'tool' || ['run_code', 'workflow_status', 'project_memory_search'].includes(call.name)) return { ...state, calls }
  const mutating = /^(write|write_file|edit|apply_patch|str_replace_editor|project_memory_save|project_memory_forget|team_start|subagent|subagent_fork|send_message)$/.test(call.name)
  if (mutating && !isError) return { ...state, calls, samples: [] }
  const result = hash(JSON.stringify([isError, content]))
  const previous = state.samples.find(sample => sample.key === call.key)
  const sample = { name: call.name, key: call.key, result, count: previous?.result === result ? previous.count + 1 : 1 }
  return { ...state, calls, samples: [...state.samples.filter(entry => entry.key !== call.key), sample].slice(-16) }
}

const events = new Set(['turn/start', 'turn/end', 'step/start', 'step/end', 'assistant/message', 'assistant/attempt',
  'tool/call', 'tool/result', 'tool/ptc-dispatch-start', 'tool/ptc-dispatch', 'approval/asked', 'approval/decided', 'llm/retry', 'user/message'])

export const efficiencyProjection = {
  // The key predates the dsh-relink name; it is kept because session checkpoints store it.
  key: 'dshMemoryTeamEfficiency', stateVersion: 3, stateSchema,
  init: (_header, inherited) => initial(inherited),
  // The host folds every committed event through every projection without a guard, so this
  // must never throw: an unexpected event shape leaves the state unchanged and is counted.
  apply(state, event) {
    try { return applyEvent(state, event) }
    catch { return { ...state, faults: (state.faults ?? 0) + 1 } }
  },
}

const str = value => typeof value === 'string'

function applyEvent(state, event) {
  {
    if (!Number.isFinite(event?.seq) || event.seq < state.inherited || !events.has(event.type) || !Number.isFinite(event.time)) return state
    const d = event.data && typeof event.data === 'object' ? event.data : {}
    if (event.type === 'turn/start') return { ...initial(state.inherited), turn: d.turn, start: event.time, through: event.time, ended: false }
    if (state.ended) return state
    let next = advance(state, event.time)
    switch (event.type) {
      case 'turn/end': return { ...next, ended: true, modelOpen: false, calls: [], approvals: [] }
      case 'step/start': return { ...next, steps: next.steps + 1, stepCalls: 0, stepWork: false, modelOpen: true }
      case 'step/end': return { ...next, modelOpen: false, workSteps: next.workSteps + (next.stepCalls === 0 || next.stepWork ? 1 : 0) }
      case 'assistant/message': {
        const tokens = Number.isFinite(d.usage?.outputTokens) ? Math.max(0, d.usage.outputTokens) : 0
        const output = { step: next.steps, tokens, reasoningChars: 0, textChars: 0, argumentChars: 0 }
        // Keep only lengths. Token usage does not reliably split reasoning from file/tool arguments.
        for (const block of Array.isArray(d.message?.content) ? d.message.content : []) {
          if (block?.type === 'reasoning') output.reasoningChars += str(block.text) ? block.text.length : 0
          else if (block?.type === 'text') output.textChars += str(block.text) ? block.text.length : 0
          else if (block?.type === 'tool-call') output.argumentChars += str(block.arguments) ? block.arguments.length : 0
        }
        return { ...next, modelOpen: false, outputTokens: next.outputTokens + tokens, peakOutputTokens: Math.max(next.peakOutputTokens, tokens),
          lastOutput: output, reasoningChars: next.reasoningChars + output.reasoningChars,
          textChars: next.textChars + output.textChars, argumentChars: next.argumentChars + output.argumentChars }
      }
      case 'assistant/attempt': return { ...next, failedAttempts: next.failedAttempts + 1 }
      case 'llm/retry': return { ...next, retries: next.retries + 1, transportRetries: next.transportRetries + (d.failure?.code === 'TRANSPORT' ? 1 : 0) }
      case 'tool/call': return str(d.callId) && str(d.name) ? startCall(next, d.callId, d.name, d.arguments, false) : next
      case 'tool/ptc-dispatch-start': return str(d.subCallId) && str(d.name) ? startCall(next, d.subCallId, d.name, d.arguments, true) : next
      case 'tool/result': return str(d.message?.toolCallId) ? finishCall(next, d.message.toolCallId, d.message.content, d.message.isError) : next
      case 'tool/ptc-dispatch': return str(d.subCallId) ? finishCall(next, d.subCallId, d.content, d.isError) : next
      case 'approval/asked': return str(d.id) ? { ...next, approvals: [...new Set([...next.approvals, d.id])] } : next
      case 'approval/decided': return { ...next, approvals: next.approvals.filter(id => id !== d.id) }
      case 'user/message':
        if (d.source?.kind === 'dsh-efficiency' && typeof d.source.notice === 'string') return { ...next, notices: [...new Set([...next.notices, d.source.notice])].slice(-3) }
        if (d.source?.kind === 'dsh-workflow' || isSvgCreation([d])) return { ...next, svgWorkflow: true }
        return next
      default: return next
    }
  }
}

export function efficiencySummary(state, now = Date.now()) {
  const current = advance(state, now)
  return {
    turn: current.turn, running: !current.ended, observed_wall_ms: Math.max(0, current.through - current.start),
    steps: current.steps, work_steps: current.workSteps, completed_output_tokens: current.outputTokens, largest_step_output_tokens: current.peakOutputTokens,
    tool_calls: current.toolCalls, failed_attempts: current.failedAttempts, retries: current.retries, transport_retries: current.transportRetries,
    time_ms: Object.fromEntries(exclusiveKeys.map(key => [key, Math.round(current.exclusive[key])])),
    intervals_ms: Object.fromEntries(timingKeys.map(key => [key, Math.round(current[key])])),
    waiting_for: [...new Set([...current.calls.map(call => call.kind), ...(current.approvals.length ? ['approval'] : []), ...(current.modelOpen ? ['model-phase'] : [])])],
    repeated_outcomes: current.samples.filter(sample => sample.count >= 3).map(sample => ({ tool: sample.name, count: sample.count })),
    output_characters: { reasoning: current.reasoningChars, visible_text: current.textChars, tool_arguments: current.argumentChars },
    svg_review_cycles: current.artifacts.map(entry => ({ artifact: entry.key, successful_writes: entry.edits, review_cycles: entry.cycles })),
    measurement: 'time_ms partitions observed wall time: each instant counts once, under approval, question, background, intentional wait, tool, model or other, in that priority. intervals_ms are overlapping per-category windows (toolWindowMs includes waits inside tools); do not add them. Model time includes preparation, first-output waiting and retries; it is not decode time or tokens/s. Tokens cover committed messages with reported usage. PTC wrappers are excluded from tool counts.',
    ...(current.faults ? { projection_faults: current.faults } : {}),
  }
}

export function efficiencyNotice(state, config) {
  if (!state || state.ended || state.notices.length >= 3) return null
  const repeated = state.samples.find(sample => sample.count >= config.repeatThreshold && !state.notices.includes(`repeat:${sample.key}`))
  if (repeated) return { id: `repeat:${repeated.key}`, text: `The same ${repeated.name} request returned the same visible result ${repeated.count} times this turn. If inputs and external state are unchanged, reuse that result or test a different hypothesis instead of repeating it. Identical results do not prove the environment is unchanged.` }
  const visual = state.artifacts.find(entry => entry.cycles >= 2 && !state.notices.includes(`visual-review:${entry.key}`))
  if (visual) return { id: `visual-review:${visual.key}`, text: `${visual.cycles} successful SVG write/edit and image-review cycles have happened for one artifact (this does not prove the changes were unnecessary or that the image shows this SVG). Before another revision, name the unmet requirement or observed defect and the check that resolves it; if required checks pass, present the files and finish. Explicitly requested refinements and variants still apply.` }
  const output = state.lastOutput
  const long = output.tokens >= config.longOutputTokens
  const reasoning = long && output.reasoningChars > output.textChars + output.argumentChars
  const previousReasoning = state.notices.filter(id => id.startsWith('reasoning:')).length
  if (reasoning && previousReasoning < 2 && !state.notices.includes(`reasoning:${output.step}`)) return { id: `reasoning:${output.step}`, text: `${previousReasoning ? 'Another reasoning-heavy step followed the earlier reminder' : 'A reasoning-heavy step completed'}: ${output.tokens} output tokens, ${output.reasoningChars} reasoning and ${output.argumentChars} tool-argument characters (characters are not token allocations). ${previousReasoning ? 'Restate the concrete remaining acceptance condition before continuing the same approach.' : 'If the next action is already clear, take the smallest concrete implementation or evidence step.'} Necessary proofs, investigation and requested refinements remain in scope.` }
  // A large file/tool argument alone is required output, not evidence of waste.
  if (long && !reasoning && output.textChars >= output.argumentChars && !state.notices.includes('long-output')) return { id: 'long-output', text: `A completed step reported ${output.tokens} output tokens (this may include reasoning and required deliverables). Avoid reprinting unchanged explanations or files; save large deliverables to their files and summarize evidence. Give full text when requested.` }
  if (state.transportRetries >= 2 && !state.notices.includes('transport')) return { id: 'transport', text: `${state.transportRetries} transport retries have occurred. If the task is still affected, inspect the connection/provider boundary; extra workers and repeated identical requests add contention. Do not change proxy or security settings without evidence and authorization.` }
  const checkpoint = Math.floor(state.workSteps / config.checkpointSteps)
  if (checkpoint >= 1 && state.calls.length === 0 && !state.notices.includes(`checkpoint:${checkpoint}`)) return { id: `checkpoint:${checkpoint}`, text: `Checkpoint: ${state.workSteps} working steps this turn (${state.steps} model steps; wait-only steps excluded). Reassess the acceptance condition, the evidence already obtained and what remains; reuse verified checks and finish when the outcome is met, or state the exact blocker. This is not a step limit.` }
  return null
}

export function installEfficiency(ctx, config) {
  ctx.sessionProjections.register(efficiencyProjection)
  ctx.systemPrompt.section({ name: 'dsh-relink:efficiency', order: 851, text: EFFICIENCY_POLICY })
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision.kind !== 'enter') return decision
    const state = ctx.sessionProjections.stateOf(payload.agent.session, efficiencyProjection.key)
    const notice = efficiencyNotice(state, config)
    const workflow = isSvgCreation(payload.messages)
    if (!notice && !workflow) return decision
    payload.signal.throwIfAborted()
    const messages = [...decision.messages]
    if (workflow) messages.push({ id: randomUUID(), role: 'user', source: { kind: 'dsh-workflow', form: 'context' }, content: [{ type: 'text', text: SVG_WORKFLOW }] })
    if (notice) messages.push({ id: randomUUID(), role: 'user', source: { kind: 'dsh-efficiency', form: 'context', notice: notice.id }, content: [{ type: 'text', text: notice.text }] })
    return { ...decision, messages }
  })
}
