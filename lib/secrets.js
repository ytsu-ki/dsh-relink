import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { withAbort } from './memory.js'

const execute = promisify(execFile)
const rules = fileURLToPath(new URL('../rules/betterleaks.toml', import.meta.url))
const hash = value => createHash('sha256').update(value).digest('hex')
export const omitted = '[credential omitted]'
const redactFields = value => typeof value === 'string' ? redact(value)
  : Array.isArray(value) ? value.map(redactFields)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, v]) => [key, redactFields(v)])) : value

export function redact(value) {
  return value.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, omitted)
    .replace(/\b(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]{16,}/g, omitted)
    .replace(/(?:AKIA|ASIA)[A-Z0-9]{16}/g, omitted)
    .replace(/xox[baprs]-[A-Za-z0-9-]{20,}/g, omitted)
    .replace(/\bauthorization\s*[:=]\s*(?!\[credential omitted\])(?:bearer\s+)?[^\s\n]+/gi, `Authorization=${omitted}`)
    .replace(/\b(api[_-]?key|password|access[_-]?token)\s*[:=]\s*(?!\[credential omitted\])[^\s\n]+/gi, `$1=${omitted}`)
}

export class SecretScanner {
  constructor(command = '', { executeFile = execute, spawnFile = spawn } = {}) {
    this.command = command; this.cache = new Map(); this.cacheBytes = 0; this.children = new Set(); this.closed = false
    this.executeFile = executeFile; this.spawnFile = spawnFile
    this.status = command ? 'starting' : 'builtin-only'
    this.error = null
    // Do not inherit config, credentials, validation flags, proxies or diagnostic settings.
    this.env = { PATH: process.env.PATH ?? '', LANG: 'en_US.UTF-8', LC_ALL: 'C', GOMAXPROCS: '2' }
    this.ready = command ? this.initialize() : Promise.resolve(hash(redact.toString()))
    this.ready.catch(() => {})
  }

  async initialize() {
    let reason = 'SCANNER_EXECUTION_FAILED'
    try {
      let stdout
      try { ({ stdout } = await this.executeFile(this.command, ['version'], { env: this.env, timeout: 10000, maxBuffer: 4096 })) }
      catch (error) { if (error.code === 'ENOENT') reason = 'SCANNER_NOT_FOUND'; throw error }
      reason = 'SCANNER_VERSION_UNSUPPORTED'
      if (stdout.trim() !== '1.9.0') throw new Error('Unsupported scanner version')
      reason = 'SCANNER_BINARY_UNREADABLE'
      const binary = await readFile(this.command)
      reason = 'SCANNER_RULES_UNAVAILABLE'
      const policy = hash(Buffer.concat([binary, await readFile(rules), Buffer.from(redact.toString())]))
      this.status = 'ready'; return policy
    } catch { this.status = 'unavailable'; this.error = reason; throw new Error('Local secret scanner unavailable; memory withheld') }
  }

  async sanitizeObject(value, signal) { return JSON.parse(await this.sanitize(JSON.stringify(value), signal, true)) }

  remember(value, clean, json = false) {
    const key = hash(`${json}\n${value}`)
    if (this.cache.has(key)) this.cacheBytes -= Buffer.byteLength(this.cache.get(key))
    this.cache.delete(key); this.cache.set(key, clean); this.cacheBytes += Buffer.byteLength(clean)
    while (this.cache.size > 64 || this.cacheBytes > 8 * 1024 * 1024) {
      const oldest = this.cache.keys().next().value
      this.cacheBytes -= Buffer.byteLength(this.cache.get(oldest)); this.cache.delete(oldest)
    }
  }

  async sanitize(value, signal, json = false) {
    signal?.throwIfAborted()
    if (this.closed) throw new Error('Local secret scanner closed')
    await withAbort(this.ready, signal)
    const finish = clean => {
      try { return json ? JSON.stringify(redactFields(JSON.parse(clean))) : redact(clean) }
      catch { throw new Error('Invalid screened memory data; memory withheld') }
    }
    if (!this.command) return finish(value)
    const key = hash(`${json}\n${value}`)
    if (this.cache.has(key)) return this.cache.get(key)
    if (Buffer.byteLength(value) > 2 * 1024 * 1024) throw new Error('Secret scan input too large; memory withheld')
    const output = await new Promise((resolve, reject) => {
      const child = this.spawnFile(this.command, ['stdin', '--config', rules, '--validation=false', '--ignore-gitleaks-allow',
        '--gitleaks-ignore-path', dirname(rules), '--no-banner', '--no-color', '--log-level', 'fatal',
        '--exit-code', '0', '--report-format', 'json', '--report-path', '-', '--max-decode-depth', '0', '--max-archive-depth', '0'],
      { env: this.env, cwd: dirname(rules), stdio: ['pipe', 'pipe', 'pipe'] })
      this.children.add(child)
      let chunks = [], size = 0, failure = false
      const fail = () => { failure = true; child.kill('SIGKILL') }
      const timer = setTimeout(fail, 5000)
      const abort = () => fail()
      signal?.addEventListener('abort', abort, { once: true })
      child.stdout.on('data', chunk => { size += chunk.length; if (size > 8 * 1024 * 1024) fail(); else chunks.push(chunk) })
      child.stderr.on('data', () => {}) // Findings and upstream errors must never enter the host log.
      child.stdin.on('error', fail)
      child.on('error', () => { failure = true })
      child.on('close', code => {
        clearTimeout(timer); signal?.removeEventListener('abort', abort); this.children.delete(child)
        if (signal?.aborted) reject(signal.reason)
        else if (failure || code !== 0 || this.closed) reject(new Error('Local secret scan failed; memory withheld'))
        else resolve(Buffer.concat(chunks).toString('utf8'))
      })
      child.stdin.end(value)
    })
    let findings
    try { findings = JSON.parse(output) } catch { throw new Error('Invalid secret scan result; memory withheld') }
    if (!Array.isArray(findings)) throw new Error('Invalid secret scan result; memory withheld')
    let clean = value
    for (const finding of findings) {
      const secret = finding.Secret
      if (typeof secret !== 'string' || !secret || !value.includes(secret)) throw new Error('Unusable secret scan result; memory withheld')
      clean = clean.replaceAll(secret, omitted)
    }
    clean = finish(clean)
    this.remember(value, clean, json)
    return clean
  }

  close() { this.closed = true; for (const child of this.children) child.kill('SIGKILL'); this.cache.clear(); this.cacheBytes = 0 }
}
