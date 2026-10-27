import { AsyncLocalStorage } from 'node:async_hooks'

// DSH freezes request envelopes; scope cancellation to provider fetches instead.
export function installFetchScope() {
  const storage = new AsyncLocalStorage()
  const previous = globalThis.fetch
  let enabled = true
  function scopedFetch(input, init) {
    const controller = enabled && storage.getStore()
    if (!controller) return previous.call(this, input, init)
    const upstream = init?.signal ?? (input instanceof Request ? input.signal : undefined)
    const signal = upstream
      ? AbortSignal.any([upstream, controller.signal])
      : controller.signal
    return previous.call(this, input, { ...init, signal })
  }
  globalThis.fetch = scopedFetch
  return {
    run(controller, callback) { return storage.run(controller, callback) },
    dispose() {
      enabled = false
      if (globalThis.fetch === scopedFetch) globalThis.fetch = previous
    },
  }
}
