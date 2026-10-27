// Regression gate for the shared relevance model on the labelled corpora in bench/fixtures.
import test from 'node:test'
import assert from 'node:assert/strict'
import { workspace, memoryService } from './helpers.js'
import { records, queries as corpus } from '../bench/fixtures/recall-corpus.mjs'
import { queries as holdout } from '../bench/fixtures/recall-holdout.mjs'
import { prepareQuery, assess, inverseFrequency } from '../lib/core/relevance.js'

for (const backend of ['sqlite', 'markdown']) {
  test(`${backend}: labelled recall keeps hit rate, precision and no-hit decisions`, async t => {
    const w = await workspace(t), service = memoryService(t, w, backend)
    for (const record of records) await service.save(w.project, { ...record, files: [] }, 'corpus')
    for (const [name, queries] of [['corpus', corpus], ['holdout', holdout]]) {
      let hits = 0, relevant = 0, returned = 0, correct = 0, falsePositives = 0, negatives = 0
      for (const { query, expect } of queries) {
        const keys = (await service.search(w.project, query)).records.map(r => r.key)
        if (expect.length) { relevant++; returned += keys.length; correct += keys.filter(k => expect.includes(k)).length; if (keys.some(k => expect.includes(k))) hits++ }
        else { negatives++; if (keys.length) falsePositives++ }
      }
      assert(hits / relevant >= 0.95, `${name} hit rate ${hits}/${relevant}`)
      assert(correct / returned >= 0.9, `${name} precision ${correct}/${returned}`)
      assert(falsePositives / negatives <= 0.1, `${name} false positives ${falsePositives}/${negatives}`)
    }
  })
}

test('relevance decisions: exact keys, short rare queries and generic overlap', () => {
  const doc = (key, title, body, status = 'verified') => ({ key, title, status, titleTerms: new Set(prepareQuery(`${key} ${title}`).terms), bodyTerms: new Set(prepareQuery(body).terms) })
  const stats = { total: 10, df: new Map() }
  const cache = doc('cache-ttl', 'Redis session TTL', 'Sessions expire after thirty minutes in redis')
  assert(assess(cache, prepareQuery('cache-ttl'), stats).exactKey)
  assert(assess(cache, prepareQuery('redis'), stats).relevant, 'a single rare term is enough for a one-word query')
  assert(assess(cache, prepareQuery('How long do sessions last in Redis?'), stats).relevant, 'plural forms match by prefix')
  const common = { total: 10, df: new Map([['session', 9], ['sessions', 9], ['minutes', 9]]) }
  assert(!assess(cache, prepareQuery('Please check the sessions and minutes again'), common).relevant, 'common shared words are not evidence')
  assert(inverseFrequency(1, 1) > inverseFrequency(30, 50), 'small stores are smoothed toward the reference size')
  const word = doc('export', 'Export dialog', 'Focus the window before export')
  assert(!assess(word, prepareQuery('Fix the export of the monthly CSV report with the new column layout and update all tests'), stats).exactKey, 'a plain-word key mentioned in a long request is not decisive')
})
