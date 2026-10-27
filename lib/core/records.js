// The canonical record contract shared by both stores: input validation, evidence
// fingerprints and freshness. Stores persist records; they do not re-implement these rules.
import { createHash } from 'node:crypto'
import { realpath, stat, readFile } from 'node:fs/promises'
import { resolve, relative } from 'node:path'
import { text, keyOf } from './text.js'
import { inside } from './scope.js'

export const KINDS = Object.freeze(['fact', 'workflow', 'pitfall'])
export const LIMITS = Object.freeze({ title: 160, summary: 2000, evidence: 1000, files: 6, path: 500, evidenceBytes: 1_048_576 })
const DAY = 86_400_000

const credentialPattern = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]{16,}|\b(?:api[_-]?key|authorization|password|access[_-]?token)\s*[:=]\s*(?:bearer\s+)?\S{8,}/i

export function assertNoObviousSecret(value) {
  if (credentialPattern.test(value)) throw new Error('Memory appears to contain a credential; remove it before saving')
}

/** Validate save arguments without touching storage. Evidence files are fingerprinted separately. */
export function validateSave(input) {
  const key = keyOf(input.key)
  const title = text(input.title, 'title', LIMITS.title)
  const summary = text(input.summary, 'summary', LIMITS.summary)
  const evidence = text(input.evidence, 'evidence', LIMITS.evidence)
  if (!KINDS.includes(input.kind)) throw new Error('kind must be fact, workflow or pitfall')
  assertNoObviousSecret(`${title}\n${summary}\n${evidence}`)
  if (!Array.isArray(input.files) || input.files.length > LIMITS.files) throw new Error(`files must be an array of at most ${LIMITS.files} project-relative paths`)
  const files = [...new Set(input.files.map(file => text(file, 'file', LIMITS.path)))]
  const expected = input.expected_revision ?? 0
  if (!Number.isSafeInteger(expected) || expected < 0) throw new Error('expected_revision must be a nonnegative integer')
  return { key, title, kind: input.kind, summary, evidence, files, expected }
}

export function validateForget(key, revision) {
  keyOf(key)
  if (!Number.isSafeInteger(revision) || revision < 1) throw new Error('expected_revision must be a positive integer')
  return { key, revision }
}

const sha256 = data => createHash('sha256').update(data).digest('hex')

/** Path and content hash of one evidence file inside the project; contents are never stored. */
export async function fingerprint(project, file) {
  const path = await realpath(resolve(project, file))
  if (!inside(project, path)) throw new Error('Evidence files must stay inside the current project')
  const info = await stat(path)
  if (!info.isFile() || info.size > LIMITS.evidenceBytes) throw new Error('Evidence must be a regular file no larger than 1 MiB')
  const data = await readFile(path)
  if (data.length > LIMITS.evidenceBytes) throw new Error('Evidence file grew beyond 1 MiB')
  return { path: relative(project, path), sha256: sha256(data) }
}

/**
 * Why a record must not be recalled automatically, or null when it is current.
 * Expired records and records whose evidence changed stay inspectable with include_stale.
 */
export async function staleness(record, project, { ttlDays, now = Date.now() }) {
  const updated = Number(record.updated_at)
  if (!Number.isFinite(updated) || now - updated > ttlDays * DAY) return 'expired'
  let stale = null
  for (const file of Array.isArray(record.files) ? record.files : []) {
    try { if (typeof file?.path !== 'string' || (await fingerprint(project, file.path)).sha256 !== file.sha256) stale = 'files-changed' }
    catch { return 'files-unavailable' }
  }
  return stale
}
