// Markdown note format shared with Obsidian and Basic Memory. The layout is unchanged from 0.5.x:
// YAML frontmatter with dsh_* fields, then a body with Conclusion / Evidence / Search terms sections.
import { createHash } from 'node:crypto'
import { basename, sep } from 'node:path'
import { parse, stringify } from 'yaml'
import { terms } from '../core/text.js'

const digest = value => createHash('sha256').update(value).digest('hex')

/** Optimistic-concurrency token derived from the exact file content (same formula as 0.5.x). */
export const revisionOf = raw => Number.parseInt(digest(raw).slice(0, 12), 16) + 1

/** Vault folder for one project: readable name plus a hash of the canonical path. */
export const scopeOf = project => `${basename(project).replace(/[^\p{L}\p{N}._-]/gu, '-').slice(0, 50)}-${digest(project).slice(0, 12)}`

export function encodeNote(meta, body) { return `---\n${stringify(meta).trimEnd()}\n---\n\n${body.trim()}\n` }

export function decodeNote(raw) {
  const match = /^\ufeff?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw)
  if (!match) throw Object.assign(new Error('Knowledge note has no YAML frontmatter'), { code: 'NOTE_INVALID' })
  let meta
  try { meta = parse(match[1], { maxAliasCount: 0, prettyErrors: false }) }
  catch { throw Object.assign(new Error('Invalid knowledge note metadata'), { code: 'NOTE_INVALID' }) }
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) throw Object.assign(new Error('Invalid note metadata'), { code: 'NOTE_INVALID' })
  return { meta, body: match[2].trim() }
}

export const isPrivate = meta => meta.dsh_private === true || meta.dsh_private === 'true'

// English headings are written today; the escaped headings are read from notes written by
// earlier versions ("search terms", "conclusion", "evidence").
const SEARCH_TERMS = /\r?\n## (?:Search terms|\u68c0\u7d22\u8bcd)\r?\n[\s\S]*$/
const CONCLUSION = /^## (?:Conclusion|\u7ed3\u8bba)\s*$/
const EVIDENCE = /^## (?:Evidence|\u8bc1\u636e)\s*$/

/** Split a body into searchable text and the Conclusion / Evidence sections when present. */
export function sections(body) {
  const searchable = body.replace(SEARCH_TERMS, '').trim()
  let current = null
  const found = { conclusion: [], evidence: [] }, rest = []
  for (const line of searchable.split(/\r?\n/)) {
    if (CONCLUSION.test(line)) { current = 'conclusion'; continue }
    if (EVIDENCE.test(line)) { current = 'evidence'; continue }
    if (/^## /.test(line)) current = null
    if (current) found[current].push(line)
    else if (!/^# /.test(line)) rest.push(line)
  }
  const join = lines => lines.join('\n').trim()
  return { searchable, conclusion: join(found.conclusion), evidence: join(found.evidence), rest: join(rest) }
}

/**
 * Catalog view of a parsed note. Returns null when the note belongs to another project.
 * `relativePath` is relative to the project folder; journals live under journal/.
 */
export function describeNote({ meta, body }, { project, relativePath, mtimeMs }) {
  if (meta.dsh_project !== project) return null
  const journal = relativePath.split(sep)[0] === 'journal' || relativePath.startsWith('journal/')
  const key = typeof meta.dsh_key === 'string' && meta.dsh_key ? meta.dsh_key : basename(relativePath, '.md')
  const title = String(meta.title ?? key)
  const parts = sections(body)
  const updated = Number(meta.dsh_updated_at)
  return {
    key, title,
    kind: typeof meta.dsh_kind === 'string' ? meta.dsh_kind : journal ? 'task-record' : 'note',
    status: typeof meta.dsh_status === 'string' ? meta.dsh_status : 'unverified',
    updatedAt: Number.isFinite(updated) ? updated : Math.round(mtimeMs),
    files: Array.isArray(meta.dsh_files) ? meta.dsh_files.filter(file => file && typeof file.path === 'string' && typeof file.sha256 === 'string') : [],
    sourceSession: typeof meta.dsh_source_session === 'string' ? meta.dsh_source_session : null,
    titleTerms: terms(`${key} ${title}`), bodyTerms: terms(parts.searchable),
    parts,
  }
}

