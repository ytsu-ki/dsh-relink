// Cancellation and background-work helpers. The desktop host exits on any unhandled
// rejection, so every promise the plugin starts without awaiting goes through `Background`.

export async function withAbort(promise, signal) {
  signal?.throwIfAborted()
  if (!signal) return promise
  let onAbort
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      onAbort = () => reject(signal.reason)
      signal.addEventListener('abort', onAbort, { once: true })
    })])
  } finally { signal.removeEventListener('abort', onAbort) }
}

export function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted()
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve() }, ms)
    const onAbort = () => { clearTimeout(timer); reject(signal.reason) }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Tracks fire-and-forget work so it can be awaited on unload and never rejects unobserved. */
export class Background {
  constructor(report = () => {}) { this.tasks = new Set(); this.report = report; this.failures = 0 }

  run(label, operation) {
    const task = Promise.resolve().then(operation).catch(error => {
      this.failures++
      try { this.report(label, error) } catch { /* Reporting must not create a second failure. */ }
    })
    this.tasks.add(task)
    task.finally(() => this.tasks.delete(task))
    return task
  }

  async drain() { while (this.tasks.size) await Promise.all([...this.tasks]) }
}

/** Runs operations for one key strictly in order; failures do not block later work. */
export class SerialQueue {
  constructor() { this.tails = new Map() }

  run(key, operation) {
    const task = (this.tails.get(key) ?? Promise.resolve()).catch(() => {}).then(operation)
    this.tails.set(key, task)
    task.then(() => {}, () => {}).finally(() => { if (this.tails.get(key) === task) this.tails.delete(key) })
    return task
  }

  async drain() { await Promise.allSettled([...this.tails.values()]) }
}
