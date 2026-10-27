// Structural guarantees: a host-independent core, English/ASCII sources with escaped Unicode,
// published entry points and a dependency set without optional services.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
async function files(dir, pattern) {
  const found = []
  for (const entry of await readdir(join(root, dir), { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...await files(path, pattern))
    else if (pattern.test(entry.name)) found.push(path)
  }
  return found
}
const imports = source => [...source.matchAll(/^\s*(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/gm)].map(match => match[1] ?? match[2])

test('the memory core and stores are host-independent', async () => {
  for (const file of [...await files('lib/core', /\.js$/), ...await files('lib/stores', /\.js$/)]) {
    const specifiers = imports(await readFile(join(root, file), 'utf8'))
    assert(!specifiers.some(spec => spec.startsWith('@deepseek-ai/')), `${file} imports a host package`)
    if (file.startsWith('lib/core')) assert(!specifiers.some(spec => /stores\/|dsh\//.test(spec)), `${file} depends on an adapter or store`)
  }
})

test('sources are ASCII; Unicode fixtures and stop words are escaped', async () => {
  const sources = [...await files('lib', /\.(js|mjs)$/), ...await files('test', /\.(js|mjs|py)$/), ...await files('bench', /\.(js|mjs)$/), ...await files('scripts', /\.(js|mjs|py|ps1)$/)]
  assert(sources.length > 20)
  for (const file of sources) {
    const text = await readFile(join(root, file), 'utf8')
    const index = [...text].findIndex(char => char.codePointAt(0) > 0x7e && char !== '\n')
    assert.equal(index, -1, `${relative(root, join(root, file))} contains a raw non-ASCII character`)
  }
})

test('published entry points resolve and the legacy guard is deprecated but still loadable', async () => {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  assert.equal(pkg.exports['.'], './lib/memory-team.js')
  const main = await import('dsh-relink')
  assert.equal(main.name, 'dsh-relink'); assert.equal(typeof main.apply, 'function'); assert(main.Config)
  const legacy = await import('dsh-relink/legacy-stream-guard')
  assert.equal(legacy.name, 'dsh-stream-guard'); assert.match(legacy.deprecation, /deprecated.*0\.7\.0/)
  const warnings = [], disposers = [], fetch = globalThis.fetch
  legacy.apply({ logger: { warn: (...args) => warnings.push(args.join(' ')) }, effect: start => disposers.push(start()), on() {} }, {})
  for (const dispose of disposers) dispose()
  assert.equal(globalThis.fetch, fetch, 'unloading restores fetch')
  assert(warnings.some(line => /deprecated/.test(line)))
  assert.deepEqual(Object.keys(pkg.dependencies).sort(), ['@deepseek-ai/schemastery', 'yaml', 'zod'], 'no optional service is a runtime dependency')
  for (const file of pkg.files) if (!file.includes('*')) await readFile(join(root, file)).catch(async () => { await readdir(join(root, file)) })
})
