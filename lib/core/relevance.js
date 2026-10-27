// One deterministic relevance model for every store. Stores supply candidate documents
// (term sets) and per-project document frequencies; this module decides and orders.
import { terms, normalized, keyMentions, STOP_WORDS, isHan } from './text.js'

export const MAX_QUERY_TERMS = 96
// Small stores are smoothed to this size so one shared word is not mistaken for a rare one.
const REFERENCE_DOCUMENTS = 50
// Evidence needed for a long query: roughly two rare terms or several uncommon ones.
const MIN_MASS = 5.6
// Each term of a one- or two-term query must be at least this rare (df at most ~5 of 50).
const SHORT_QUERY_IDF = 2.1
const TASK_RECORD_WEIGHT = 0.6

export function prepareQuery(query) {
  const all = terms(query)
  const informative = all.filter(term => !STOP_WORDS.has(term) && !/^\d{1,2}$/.test(term)).slice(0, MAX_QUERY_TERMS)
  return { text: query, normalized: normalized(query), terms: informative, keys: new Set(keyMentions(query)), empty: !query.trim() }
}

/** FTS5 expression over the legacy term columns; long Latin terms also match by prefix. */
export function matchExpression(prepared) {
  const parts = new Set()
  for (const term of prepared.terms) {
    const quoted = `"${term.replaceAll('"', '""')}"`
    parts.add(quoted)
    if (!isHan(term) && term.length >= 5) {
      parts.add(`${quoted}*`)
      // Accept a shorter indexed stem, e.g. "sessions" for an indexed "session".
      for (const cut of [1, 2]) if (term.length - cut >= 4) parts.add(`"${term.slice(0, -cut).replaceAll('"', '""')}"`)
    }
  }
  return [...parts].join(' OR ')
}

/** Whether a query term occurs in a document's term set, with the same prefix rules as matching. */
export function termMatches(term, documentTerms) {
  if (documentTerms.has(term)) return true
  if (isHan(term) || term.length < 5) return false
  for (const candidate of documentTerms) {
    if (candidate.startsWith(term)) return true
    if (candidate.length >= 4 && term.startsWith(candidate) && term.length - candidate.length <= 2) return true
  }
  return false
}

export const inverseFrequency = (df, total) => {
  const n = Math.max(total, REFERENCE_DOCUMENTS)
  return Math.log(1 + (n - Math.min(df, n) + 0.5) / (df + 0.5))
}

/**
 * Score one candidate. `doc` = { key, title, status, kind, titleTerms: Set, bodyTerms: Set }.
 * `stats` = { total, df: Map(term -> documents containing it) }.
 */
export function assess(doc, prepared, stats) {
  // A compound key (e.g. "cache-ttl") is decisive; a plain word such as "export" only when
  // the query is short, otherwise any long request mentioning the word would recall it alone.
  const exactKey = prepared.keys.has(doc.key) && (/[-._\d]/.test(doc.key) || prepared.terms.length <= 3)
  const title = normalized(String(doc.title ?? '')).trim()
  const exactTitle = title.length >= 4 && prepared.normalized.includes(title)
  let mass = 0, score = 0, matched = 0, titleMatched = 0, weakest = Infinity
  for (const term of prepared.terms) {
    const inTitle = termMatches(term, doc.titleTerms), inBody = !inTitle && termMatches(term, doc.bodyTerms)
    if (!inTitle && !inBody) continue
    const idf = inverseFrequency(Math.max(1, stats.df.get(term) ?? 1), stats.total)
    matched++; mass += idf; score += idf * (inTitle ? 2 : 1); weakest = Math.min(weakest, idf)
    if (inTitle) titleMatched++
  }
  const short = prepared.terms.length <= 2
  const relevant = exactKey || exactTitle
    || (short && matched === prepared.terms.length && matched > 0 && weakest >= SHORT_QUERY_IDF)
    || (matched >= 2 && mass >= MIN_MASS)
  const weight = doc.status === 'verified' ? 1 : TASK_RECORD_WEIGHT
  return { relevant, exactKey, exactTitle, score: score * weight, matched, titleMatched, mass }
}

const verified = doc => doc.status === 'verified'

/**
 * Relevant documents in recall order. Exact keys, then complete titles of verified records,
 * are returned alone so generic matches cannot fill spare slots.
 */
export function rank(docs, prepared, stats) {
  const scored = docs.map(doc => ({ doc, ...assess(doc, prepared, stats) })).filter(entry => entry.relevant)
  const order = (a, b) => Number(b.exactKey) - Number(a.exactKey) || Number(b.exactTitle && verified(b.doc)) - Number(a.exactTitle && verified(a.doc))
    || b.score - a.score || Number(verified(b.doc)) - Number(verified(a.doc)) || (Number(b.doc.updatedAt) || 0) - (Number(a.doc.updatedAt) || 0)
    || String(a.doc.key).localeCompare(String(b.doc.key))
  scored.sort(order)
  if (scored.some(entry => entry.exactKey)) return scored.filter(entry => entry.exactKey)
  if (scored.some(entry => entry.exactTitle && verified(entry.doc))) return scored.filter(entry => entry.exactTitle && verified(entry.doc))
  return scored
}
