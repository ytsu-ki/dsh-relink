import z from '@deepseek-ai/schemastery'
import { DEFAULTS, createGuard, isGuardFailure, resolveConfig } from './guard.js'
import { installFetchScope } from './fetch-scope.js'

export const name = 'dsh-stream-guard'
export const inject = ['llm', 'agents']
const duration = value => z.number().step(1).min(1).max(2_147_483_647).default(value)
export const Config = z.object({
  providers: z.array(z.string().min(1)).min(1).default([...DEFAULTS.providers]),
  stalledMs: duration(DEFAULTS.stalledMs),
  terminalGraceMs: duration(DEFAULTS.terminalGraceMs),
  maxCallMs: duration(DEFAULTS.maxCallMs),
  maxStepMs: duration(DEFAULTS.maxStepMs),
  maxRetries: z.number().step(1).min(0).max(10).default(DEFAULTS.maxRetries),
})

export function apply(ctx, input = {}) {
  const config = resolveConfig(input)
  const lifetime = new AbortController()
  const scope = installFetchScope()
  const guard = createGuard(config, scope, lifetime.signal,
    entry => ctx.logger.warn('dsh-stream-guard: %s', JSON.stringify(entry)))
  ctx.effect(() => () => {
    lifetime.abort()
    guard.dispose()
    scope.dispose()
  }, 'dsh-stream-guard: cancel active requests and restore fetch')
  ctx.on('llm/stream', (options, next) => {
    if (!config.providers.includes(options.provider) || options.purpose) return next()
    return guard.stream(options, next)
  }, { prepend: true })
  ctx.on('agent/request-error', (payload, next) => {
    if (isGuardFailure(payload.failure?.code)) return Promise.resolve(undefined)
    return next()
  }, { prepend: true })
}
