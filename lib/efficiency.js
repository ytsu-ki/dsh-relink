import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'

export const EFFICIENCY_POLICY = `Execution efficiency:
Keep required deliverables complete. For long formulas, repetitive data edits or generated code, reuse one validated template or deterministic script, then verify representative cases and totals. Do not repeatedly print full formulas, unchanged files, command output or lengthy plans into chat. Save large deliverables to their intended files and report the change and evidence concisely; provide full text when the user asks for it.
For a substantial task, define a checkable outcome, identify the smallest useful next check, then implement and validate. Finish when that outcome and required checks pass. Investigate a new hypothesis only when evidence supports it. After repeated identical failures, inspect the failing boundary and change the approach instead of repeating the same action. Batch independent reads or checks with existing tools when safe; keep dependent edits and approvals sequential.
Deliver a complete first artifact before exploring optional variants. Anchor further changes to a specific unmet user requirement or observed defect, then check that defect after the change. Do not keep reopening aesthetic choices after the requested checks pass. Required proofs, research, accessibility, animation, refinements and variants remain part of the task when requested; an efficiency reminder never reduces that scope.
Run long commands once using the available native background-job mechanism when appropriate. Retain the job id, continue independent work, and use a supported completion wait when needed. When only team results remain, use team_wait once instead of shell sleep or repeated tests; native completion provides the results. Do not launch a second install/test/server or tightly poll unchanged job output. Planned message-listener waits are intentional service activity, not a reason to restart a bot.
Ask only for missing user-owned decisions or required approval; combine related questions. Keep all existing permission checks. When waiting for a user, approval, command or network recovery, identify that state accurately instead of describing it as model thinking. Do not change permission rules or interrupt expected waits to improve a timing metric.
Use team workers only for independent, bounded questions. A simple lookup or mechanical verification can explicitly request low effort if native child model selection supports it; complex diagnosis and implementation keep inherited effort unless the user chooses otherwise. Do not infer that high effort is wasteful from a long task alone.
workflow_status reports the current or most recent turn's observed counters and overlapping wait intervals. Use it when diagnosing slow progress, not as a routine polling step. A checkpoint reminder is advice to reassess scope and evidence; it does not stop the task or justify omitting requested work.`

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
const stateSchema = z.object({
  inherited: number, turn: number, start: number, through: number, ended: z.boolean(), modelOpen: z.boolean(),
  steps: number, workSteps: number, stepCalls: number, stepWork: z.boolean(), outputTokens: number, peakOutputTokens: number, failedAttempts: number, retries: number,
  transportRetries: number, toolCalls: number, notices: z.array(z.string()).max(3),
  calls: z.array(callSchema), approvals: z.array(z.string()), samples: z.array(sampleSchema).max(16),
  lastOutput: outputSchema, reasoningChars: number, textChars: number, argumentChars: number,
  svgWorkflow: z.boolean(), focusArtifact: z.string(), artifacts: z.array(artifactSchema).max(8),
  ...Object.fromEntries(timingKeys.map(key => [key, number])),
})

function initial(inherited = 0) {
  return { inherited, turn: 0, start: 0, through: 0, ended: true, modelOpen: false,
    steps: 0, workSteps: 0, stepCalls: 0, stepWork: false, outputTokens: 0, peakOutputTokens: 0, failedAttempts: 0, retries: 0, transportRetries: 0,
    toolCalls: 0, notices: [], calls: [], approvals: [], samples: [],
    lastOutput: { step: 0, tokens: 0, reasoningChars: 0, textChars: 0, argumentChars: 0 },
    reasoningChars: 0, textChars: 0, argumentChars: 0, svgWorkflow: false, focusArtifact: '', artifacts: [],
    ...Object.fromEntries(timingKeys.map(key => [key, 0])),
  }
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
  return { ...state, through: time,
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
  key: 'dshMemoryTeamEfficiency', stateVersion: 2, stateSchema,
  init: (_header, inherited) => initial(inherited),
  apply(state, event) {
    if (event.seq < state.inherited || !events.has(event.type)) return state
    const d = event.data
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
        for (const block of d.message?.content ?? []) {
          if (block.type === 'reasoning') output.reasoningChars += block.text?.length ?? 0
          else if (block.type === 'text') output.textChars += block.text?.length ?? 0
          else if (block.type === 'tool-call') output.argumentChars += typeof block.arguments === 'string' ? block.arguments.length : 0
        }
        return { ...next, modelOpen: false, outputTokens: next.outputTokens + tokens, peakOutputTokens: Math.max(next.peakOutputTokens, tokens),
          lastOutput: output, reasoningChars: next.reasoningChars + output.reasoningChars,
          textChars: next.textChars + output.textChars, argumentChars: next.argumentChars + output.argumentChars }
      }
      case 'assistant/attempt': return { ...next, failedAttempts: next.failedAttempts + 1 }
      case 'llm/retry': return { ...next, retries: next.retries + 1, transportRetries: next.transportRetries + (d.failure?.code === 'TRANSPORT' ? 1 : 0) }
      case 'tool/call': return startCall(next, d.callId, d.name, d.arguments, false)
      case 'tool/ptc-dispatch-start': return startCall(next, d.subCallId, d.name, d.arguments, true)
      case 'tool/result': return finishCall(next, d.message.toolCallId, d.message.content, d.message.isError)
      case 'tool/ptc-dispatch': return finishCall(next, d.subCallId, d.content, d.isError)
      case 'approval/asked': return { ...next, approvals: [...new Set([...next.approvals, d.id])] }
      case 'approval/decided': return { ...next, approvals: next.approvals.filter(id => id !== d.id) }
      case 'user/message':
        if (d.source?.kind === 'dsh-efficiency' && typeof d.source.notice === 'string') return { ...next, notices: [...new Set([...next.notices, d.source.notice])].slice(-3) }
        if (d.source?.kind === 'dsh-workflow' || isSvgCreation([d])) return { ...next, svgWorkflow: true }
        return next
      default: return next
    }
  },
}

export function efficiencySummary(state, now = Date.now()) {
  const current = advance(state, now)
  return {
    turn: current.turn, running: !current.ended, observed_wall_ms: Math.max(0, current.through - current.start),
    steps: current.steps, work_steps: current.workSteps, completed_output_tokens: current.outputTokens, largest_step_output_tokens: current.peakOutputTokens,
    tool_calls: current.toolCalls, failed_attempts: current.failedAttempts, retries: current.retries, transport_retries: current.transportRetries,
    intervals_ms: Object.fromEntries(timingKeys.map(key => [key, Math.round(current[key])])),
    waiting_for: [...new Set([...current.calls.map(call => call.kind), ...(current.approvals.length ? ['approval'] : []), ...(current.modelOpen ? ['model-phase'] : [])])],
    repeated_outcomes: current.samples.filter(sample => sample.count >= 3).map(sample => ({ tool: sample.name, count: sample.count })),
    output_characters: { reasoning: current.reasoningChars, visible_text: current.textChars, tool_arguments: current.argumentChars },
    svg_review_cycles: current.artifacts.map(entry => ({ artifact: entry.key, successful_writes: entry.edits, review_cycles: entry.cycles })),
    measurement: 'Intervals overlap: toolWindowMs includes approval, question, job and intentional waits. Never add them together. modelPhaseMs includes preparation, first response and retry waiting; it is not decode time or tokens/s. Tokens cover committed successful/interrupted messages when usage is available. PTC wrappers are excluded from tool count.',
  }
}

export function efficiencyNotice(state, config) {
  if (!state || state.ended || state.notices.length >= 3) return null
  const repeated = state.samples.find(sample => sample.count >= config.repeatThreshold && !state.notices.includes(`repeat:${sample.key}`))
  if (repeated) return { id: `repeat:${repeated.key}`, text: `The same ${repeated.name} request and visible result occurred ${repeated.count} times in this turn. Check whether inputs or external state changed. If not, reuse the result or test a different hypothesis; do not repeat the same failing action. This observation does not prove the environment is unchanged.` }
  const visual = state.artifacts.find(entry => entry.cycles >= 2 && !state.notices.includes(`visual-review:${entry.key}`))
  if (visual) return { id: `visual-review:${visual.key}`, text: `There have been ${visual.cycles} successful SVG write/edit and image-review cycles for one artifact. This pattern does not prove those changes were unnecessary or that the viewed image belongs to this SVG. Before another revision, identify one specific unmet user requirement or observed defect and the check that will resolve it. If required checks already pass, present the files and finish. Preserve explicitly requested refinement and variants; do not invent a defect to justify optional polish. If independent review would settle the remaining uncertainty, request one bounded native review rather than parallel redesigns.` }
  const output = state.lastOutput
  const long = output.tokens >= config.longOutputTokens
  const reasoning = long && output.reasoningChars > output.textChars + output.argumentChars
  const previousReasoning = state.notices.filter(id => id.startsWith('reasoning:')).length
  if (reasoning && previousReasoning < 2 && !state.notices.includes(`reasoning:${output.step}`)) return { id: `reasoning:${output.step}`, text: `${previousReasoning ? 'Another reasoning-heavy step followed the earlier reminder.' : 'A reasoning-heavy step has completed.'} It reported ${output.tokens} output tokens, with ${output.reasoningChars} reasoning characters and ${output.argumentChars} tool-argument characters (character counts are not token allocations). ${previousReasoning ? 'Reassess the concrete remaining acceptance condition before continuing the same approach.' : 'Move to the smallest concrete implementation or evidence check instead of comparing optional approaches.'} For an artifact task, produce the complete first version if still missing; otherwise change only an identified defect and verify it. Keep necessary proofs, investigation and user-requested refinements complete. This advice applies to the next request and cannot shorten the completed one.` }
  // A large file/tool argument alone is required output, not evidence of waste.
  if (long && !reasoning && output.textChars >= output.argumentChars && !state.notices.includes('long-output')) return { id: 'long-output', text: `A completed step reported ${output.tokens} output tokens. This total may include reasoning and required deliverables; it does not prove waste. Avoid reprinting unchanged explanations or files, save large deliverables to their intended files, and summarize evidence concisely. Preserve full text and all necessary work when requested.` }
  if (state.transportRetries >= 2 && !state.notices.includes('transport')) return { id: 'transport', text: `${state.transportRetries} transport retries have occurred. If the task is still affected, inspect the connection/provider boundary using available diagnostics. Additional workers and repeated identical requests may increase contention. Do not reset unrelated services or change proxy/security settings without evidence and authorization.` }
  const checkpoint = Math.floor(state.workSteps / config.checkpointSteps)
  if (checkpoint >= 1 && state.calls.length === 0 && !state.notices.includes(`checkpoint:${checkpoint}`)) return { id: `checkpoint:${checkpoint}`, text: `This turn has reached ${state.workSteps} working steps (${state.steps} total model steps; wait-only steps excluded from checkpoints). Reassess the acceptance condition, evidence already obtained and remaining dependency. Reuse verified checks, stop reopening settled questions, and finish when the requested outcome is met. If blocked, state the exact blocker. Continue necessary work; this is not a step limit.` }
  return null
}

export function installEfficiency(ctx, config) {
  ctx.sessionProjections.register(efficiencyProjection)
  ctx.systemPrompt.section({ name: 'dsh-memory-team:efficiency', order: 851, text: EFFICIENCY_POLICY })
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
