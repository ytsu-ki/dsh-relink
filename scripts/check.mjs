// Syntax-check every JavaScript module in the package and its tooling.
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const files = []
const walk = async dir => {
  for (const entry of await readdir(join(root, dir), { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) await walk(path)
    else if (/\.(js|mjs)$/.test(entry.name)) files.push(path)
  }
}
for (const dir of ['lib', 'scripts', 'bench', 'test']) await walk(dir)
for (const file of files) execFileSync(process.execPath, ['--check', join(root, file)], { stdio: 'inherit' })
console.log(`checked ${files.length} files`)
