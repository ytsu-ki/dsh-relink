// Text normalization, term extraction and input validation shared by every store.

/** Legacy index term format: Latin/digit words of two or more characters and Han bigrams. */
export function terms(value) {
  const result = new Set()
  for (const word of value.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []) {
    for (const part of word.match(/\p{Script=Han}+|[^\p{Script=Han}]+/gu) ?? []) {
      if (/\p{Script=Han}/u.test(part)) {
        const chars = [...part]
        if (chars.length === 1) result.add(part)
        for (let i = 0; i < chars.length - 1; i++) result.add(chars[i] + chars[i + 1])
      } else if (part.length > 1) result.add(part)
    }
  }
  return [...result]
}

export const normalized = value => value.normalize('NFKC').toLowerCase()

export const isHan = term => /\p{Script=Han}/u.test(term)

// Instruction and function words carry no topic. Han entries are escaped bigrams such as
// "please help", "check", "this", "file", "knowledge base", "automatic", "recall" and "verify".
const ENGLISH_STOP_WORDS = `a about after again all also an and any are as at be been before being both but by can could
did do does doing done each else for from get gets got had has have having he her here hers him his how i if in into is it
its itself just let lets me more most my need needs no nor not now of off on once only or other our out over own please
same she should so some such than that the their them then there these they this those through to too under until up us
very was we were what when where which while who whom why will with would you your yours yourself
add check checks create explain finish fix help look make makes run runs show tell try update use using verify verified
want write file files code task result results thing things way work again whole`.split(/\s+/)
const HAN_STOP_WORDS = ['\u8bf7\u5e2e', '\u5e2e\u6211', '\u8bf7\u4f60', '\u8bf7\u4ec5', '\u4e00\u4e0b', '\u8fd9\u4e2a', '\u90a3\u4e2a',
  '\u8fd9\u6bb5', '\u5982\u4f55', '\u600e\u4e48', '\u4ec0\u4e48', '\u4e3a\u4ec0', '\u53ef\u4ee5', '\u9700\u8981', '\u6211\u4eec',
  '\u4f60\u4eec', '\u8fdb\u884c', '\u68c0\u67e5', '\u6587\u4ef6', '\u4ee3\u7801', '\u4efb\u52a1', '\u95ee\u9898', '\u5de5\u5177',
  '\u8c03\u7528', '\u6e90\u7801', '\u77e5\u8bc6', '\u8bc6\u5e93', '\u65b0\u4f1a', '\u4f1a\u8bdd', '\u672c\u8f6e', '\u81ea\u52a8',
  '\u53ec\u56de', '\u9a8c\u8bc1', '\u7ecf\u9a8c', '\u8bb0\u5f55', '\u4f9d\u636e', '\u62a5\u544a', '\u5176\u4e2d', '\u660e\u786e',
  '\u533a\u5206', '\u4e0d\u8981', '\u4e00\u4e2a', '\u5e2e\u52a9', '\u89e3\u91ca', '\u603b\u7ed3']
export const STOP_WORDS = new Set([...ENGLISH_STOP_WORDS, ...HAN_STOP_WORDS])

/** Candidate record keys mentioned in free text. */
export const keyMentions = value => [...new Set(normalized(value).match(/[a-z0-9][a-z0-9._-]{0,79}/g) ?? [])]

export function text(value, name, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${name} must contain 1\u2013${max} characters`)
  return value.trim()
}

export function keyOf(value) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,79}$/.test(value)) throw new Error('key must be 1\u201380 lowercase letters, digits, dots, underscores or hyphens')
  return value
}
