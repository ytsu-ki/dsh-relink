export const DEFAULTS = Object.freeze({
  providers: Object.freeze(['deepseek-account', 'deepseek-official']),
  stalledMs: 60_000,
  terminalGraceMs: 30_000,
  maxCallMs: 180_000,
  maxStepMs: 300_000,
  maxRetries: 2,
})

const MAX_TIMER = 2_147_483_647
const RETRYABLE = new Set(['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'])
export const isGuardFailure = code => typeof code === 'string' && code.startsWith('DSH_STREAM_GUARD_')

export function resolveConfig(input = {}) {
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(DEFAULTS, key)) throw new TypeError(`dsh-stream-guard: unknown setting ${key}`)
  }
  const config = { ...DEFAULTS, ...input }
  for (const key of ['stalledMs', 'terminalGraceMs', 'maxCallMs', 'maxStepMs']) {
    if (!Number.isSafeInteger(config[key]) || config[key] < 1 || config[key] > MAX_TIMER) {
      throw new TypeError(`dsh-stream-guard: ${key} must be an integer from 1 to ${MAX_TIMER}`)
    }
  }
  if (!Number.isSafeInteger(config.maxRetries) || config.maxRetries < 0 || config.maxRetries > 10) {
    throw new TypeError('dsh-stream-guard: maxRetries must be an integer from 0 to 10')
  }
  if (!Array.isArray(config.providers) || config.providers.length === 0 ||
      config.providers.some(value => typeof value !== 'string' || value.trim() !== value || !value)) {
    throw new TypeError('dsh-stream-guard: providers must contain nonempty provider names')
  }
  return Object.freeze({ ...config, providers: Object.freeze([...new Set(config.providers)]) })
}

function hasOutput(chunk) {
  if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') return Boolean(chunk.text)
  if (chunk.type === 'tool-call-delta') return Boolean(chunk.id || chunk.name || chunk.argumentsDelta)
  return chunk.type === 'block-end'
}

function failure(code, message) {
  return { type: 'finish', reason: { kind: 'error', failure: { code, message } } }
}

// Retry state belongs to a caller signal and is cleared after each successful step.
export function createGuard(config, scope, lifetime, report = () => {}) {
  const chains = new WeakMap()
  const active = new Set()

  async function* stream(options, next) {
    const upstream = options.signal
    const key = JSON.stringify([options.sessionId, options.provider, options.model, options.purpose])
    let entries
    if (upstream && options.sessionId && !options.purpose) {
      entries = chains.get(upstream)
      if (!entries) chains.set(upstream, entries = new Map())
    }
    const chain = entries?.get(key) ?? { attempts: 0, elapsedMs: 0 }
    entries?.set(key, chain)
    const start = performance.now()
    let lastOutput = start
    let closedAt
    let finished = false
    let iterator
    let timer
    const blocks = new Set()
    const controller = new AbortController()
    active.add(controller)
    const signal = AbortSignal.any([controller.signal, lifetime, ...upstream ? [upstream] : []])
    let onAbort
    const cancel = new Promise(resolve => {
      onAbort = () => resolve({ kind: 'abort' })
      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) onAbort()
    })
    const stop = (suffix, detail) => {
      const elapsedMs = Math.round(performance.now() - start)
      const chunk = failure(`DSH_STREAM_GUARD_${suffix}`,
        `dsh-stream-guard: ${detail}; attempt ${chain.attempts}, elapsed ${elapsedMs}ms. Request stopped; retry manually when the connection is stable.`)
      report({ provider: options.provider, model: options.model, sessionId: options.sessionId,
        code: chunk.reason.failure.code, attempt: chain.attempts, elapsedMs })
      controller.abort(new Error(chunk.reason.failure.code))
      return chunk
    }
    try {
      if (signal.aborted) {
        yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'Request cancelled' } } }
        return
      }
      if (chain.attempts > config.maxRetries) {
        yield stop('RETRY_LIMIT', `automatic retry limit ${config.maxRetries} reached`)
        return
      }
      if (chain.elapsedMs >= config.maxStepMs) {
        yield stop('STEP_DEADLINE', `failed-step request budget ${config.maxStepMs}ms exhausted`)
        return
      }
      chain.attempts += 1
      iterator = scope.run(controller, () => next()[Symbol.asyncIterator]())
      while (true) {
        const now = performance.now()
        const deadlines = [
          [lastOutput + config.stalledMs, 'STALLED', `no model output for ${config.stalledMs}ms`],
          [start + config.maxCallMs, 'CALL_DEADLINE', `request duration limit ${config.maxCallMs}ms reached`],
          [start + config.maxStepMs - chain.elapsedMs, 'STEP_DEADLINE', `failed-step request budget ${config.maxStepMs}ms exhausted`],
        ]
        if (closedAt !== undefined) deadlines.push([closedAt + config.terminalGraceMs, 'TERMINAL_TIMEOUT',
          `all content blocks closed but no finish event for ${config.terminalGraceMs}ms`])
        deadlines.sort((a, b) => a[0] - b[0])
        const [deadline, code, detail] = deadlines[0]
        if (deadline <= now) {
          yield stop(code, detail)
          return
        }
        const timeout = new Promise(resolve => { timer = setTimeout(() => resolve({ kind: 'timeout' }), deadline - now) })
        const pending = Promise.resolve().then(() => scope.run(controller, () => iterator.next()))
          .then(item => ({ kind: 'item', item }), error => ({ kind: 'throw', error }))
        const result = await Promise.race([pending, timeout, cancel])
        clearTimeout(timer)
        if (result.kind === 'abort') {
          yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'Request cancelled' } } }
          return
        }
        if (result.kind === 'timeout') {
          yield stop(code, detail)
          return
        }
        if (result.kind === 'throw') throw result.error
        if (result.item.done) {
          yield stop('INCOMPLETE', 'provider ended the stream without a finish event')
          return
        }
        const chunk = result.item.value
        if (chunk.type === 'finish') {
          finished = true
          if (chunk.reason.kind === 'error' && RETRYABLE.has(chunk.reason.failure?.code) && chain.attempts > config.maxRetries) {
            yield stop('RETRY_LIMIT', `automatic retry limit ${config.maxRetries} reached after ${chunk.reason.failure.code}`)
          } else {
            if (chunk.reason.kind !== 'error' && chunk.reason.kind !== 'aborted') entries?.delete(key)
            yield chunk
          }
          return
        }
        if (hasOutput(chunk)) lastOutput = performance.now()
        if (chunk.type === 'block-start') { blocks.add(chunk.index); closedAt = undefined }
        if (chunk.type === 'block-end') {
          blocks.delete(chunk.index)
          if (blocks.size === 0) closedAt = performance.now()
        }
        yield chunk
      }
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      chain.elapsedMs += performance.now() - start
      controller.abort(new Error('dsh-stream-guard: stream closed'))
      active.delete(controller)
      // An adapter ignoring cancellation must not hold the consumer in return().
      if (iterator?.return) {
        try {
          Promise.resolve(scope.run(controller, () => iterator.return())).catch(() => {
            report({ code: 'CLEANUP_FAILED', provider: options.provider, model: options.model })
          })
        } catch {
          report({ code: 'CLEANUP_FAILED', provider: options.provider, model: options.model })
        }
      }
      if (!finished && (upstream?.aborted || lifetime.aborted)) entries?.delete(key)
    }
  }

  return { stream, dispose() { for (const controller of active) controller.abort(); active.clear() } }
}
