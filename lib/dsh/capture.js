// Automatic, unverified task records: after each parent turn ends, summarize the turn from the
// native session log without a model call. Reasoning, tool arguments and outputs are not stored.

/** Extract one finished turn, or null for subagents and turns without a text request. */
export function extractTurn(session, end) {
  if (session.header.origin === 'subagent' || (session.header.delegationDepth ?? 0) > 0) return null
  const events = []
  for (let seq = end.seq - 1; seq >= 0; seq--) {
    const event = session.eventAt(seq)
    if (!event) continue
    if (event.type === 'turn/start' && event.data?.turn === end.data?.turn) break
    events.push(event)
  }
  events.reverse()
  const prompt = events.filter(e => e.type === 'user/message' && e.data?.source?.kind === 'user')
    .flatMap(e => e.data.content ?? []).filter(b => b?.type === 'text').map(b => b.text).join('\n')
  if (!prompt.trim()) return null
  const reply = events.filter(e => e.type === 'assistant/message')
    .map(e => (e.data?.message?.content ?? []).filter(b => b?.type === 'text').map(b => b.text).join('\n')).filter(Boolean).at(-1) ?? ''
  return {
    prompt, reply, status: String(end.data?.reason?.kind ?? 'unknown').replace(/[^\w-]/g, '').slice(0, 40) || 'unknown',
    tools: events.filter(e => e.type === 'tool/call').map(e => String(e.data?.name ?? 'unknown')),
    sessionId: session.header.id, turn: end.data?.turn, endSeq: end.seq, time: end.time,
  }
}
