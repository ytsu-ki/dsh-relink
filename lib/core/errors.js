/** A store or configuration cannot be used; memory is unavailable but the main task continues. */
export class MemoryUnavailable extends Error {
  constructor(message, code) { super(message); this.name = 'MemoryUnavailable'; this.code = code }
}
