// Tool definition helper for the DSH tool registry: strict argument shape, cancellation check
// and a JSON text rendering of the structured result.

export const string = description => ({ type: 'string', description })
export const object = (properties, required) => ({ type: 'object', additionalProperties: false, properties, required })

export function tool(name, description, properties, required, execute, concurrency = false) {
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
