// Automatic recall: one durable user/message per new user input, admitted through agent/pre-step.
// A session projection remembers the last recall so unchanged memory is not resent every turn.
import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { renderRecords } from '../core/render.js'
import { STATUS } from '../core/service.js'

// The source tag and projection key predate the dsh-relink name. They are persisted in session
// logs and checkpoints, so they keep their original values to recognize earlier recalls.
export const RECALL_SOURCE = 'dsh-memory-team'
const lastSchema = z.object({ digest: z.string(), records: z.number().int().nonnegative(), status: z.string() }).nullable()

/** Tracks the most recent recall in the visible context; compaction forgets it. Never throws. */
export const recallProjection = {
  key: 'dshMemoryTeamRecall', stateVersion: 1, stateSchema: z.object({ last: lastSchema, faults: z.number().int().nonnegative() }),
  init: () => ({ last: null, faults: 0 }),
  apply(state, event) {
    try {
      if (typeof event.type === 'string' && event.type.startsWith('compaction/')) return state.last ? { ...state, last: null } : state
      if (event.type !== 'user/message' || event.data?.source?.kind !== RECALL_SOURCE) return state
      const recall = event.data.source.recall
      // Recall messages written by 0.5.x carry no digest; treat them as records to supersede.
      const last = recall && typeof recall.digest === 'string' ? { digest: recall.digest, records: Number(recall.records) || 0, status: String(recall.status ?? 'ok') }
        : { digest: 'legacy', records: 1, status: 'ok' }
      return { ...state, last }
    } catch { return { ...state, faults: state.faults + 1 } }
  },
}

const digestOf = value => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24)

/** Decide what, if anything, to add for this input. Returns { text, recall } or null. */
export function recallMessage({ project, warning, result, last, budget }) {
  const keys = result.records.map(record => [record.key, record.revision, record.stale ?? null])
  const digest = digestOf([project, result.status, keys, result.diagnostics?.code ?? null])
  const recall = { digest, records: result.records.length, status: result.status }
  const prefix = `Current project: ${project}.${warning ? ' A Git repository at the home or filesystem root was ignored; using the working directory. Set projectRoot explicitly to share that scope.' : ''}`
  if (last?.digest === digest) {
    if (!result.records.length) return null
    return { recall, text: `${prefix} Project memory for this request is unchanged since the previous recall in this session (${result.records.map(r => `${r.key} revision ${r.revision}`).join(', ')}); the same caveats apply.` }
  }
  if (result.status === STATUS.withheld || result.status === STATUS.unavailable || (result.status === STATUS.degraded && !result.records.length)) {
    const code = result.diagnostics?.code ?? result.diagnostics?.degraded ?? 'unknown'
    return { recall, text: `${prefix} Project memory is ${result.status} (${code}). Continue without recalled memory; this is not evidence that no memory exists. Earlier recalled records may be stale.` }
  }
  if (!result.records.length) {
    if (last && !last.records) return null
    return { recall, text: `${prefix} Project memory has no matching current records for this request. Earlier recalled records may be stale; verify earlier conclusions against current evidence.` }
  }
  const head = `${prefix} This recall supersedes earlier recall in this session.${result.status === STATUS.degraded ? ` Memory is degraded (${result.diagnostics?.degraded}); some notes may be missing.` : ''}`
  const body = renderRecords(result.records, Math.max(0, budget - head.length - 1))
  return body ? { recall, text: `${head}\n${body}`.slice(0, budget) } : null
}

export function installRecall(ctx, { search, resolveScope, config, active, logger }) {
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (!active() || decision.kind !== 'enter') return decision
    const prompts = payload.messages.filter(message => message.source?.kind === 'user')
    if (!prompts.length) return decision
    const query = prompts.flatMap(message => message.content ?? []).filter(block => block?.type === 'text').map(block => block.text).join('\n').slice(0, 4000)
    if (!query.trim()) return decision
    try {
      const { project, warning } = await resolveScope(payload)
      const result = await search(project, query, payload.signal)
      payload.signal.throwIfAborted()
      if (!active()) return decision
      const last = ctx.sessionProjections.stateOf(payload.agent.session, recallProjection.key)?.last ?? null
      const message = recallMessage({ project, warning, result, last, budget: config.recallChars })
      if (!message) return decision
      return { ...decision, messages: [...decision.messages, Object.freeze({
        id: randomUUID(), role: 'user',
        source: Object.freeze({ kind: RECALL_SOURCE, form: 'context', recall: Object.freeze(message.recall) }),
        content: Object.freeze([Object.freeze({ type: 'text', text: message.text })]),
      })] }
    } catch (error) {
      if (payload.signal.aborted) throw error
      logger.warn('Project memory recall unavailable (%s); continuing without recall', error.code || error.name)
      return decision
    }
  })
}
