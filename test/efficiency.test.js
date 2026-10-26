import test from 'node:test'
import assert from 'node:assert/strict'
import { efficiencyProjection as projection, efficiencyNotice, efficiencySummary, toolKind, isSvgCreation } from '../lib/efficiency.js'

const config = { repeatThreshold: 3, longOutputTokens: 4000, checkpointSteps: 20 }
function fold() {
  let state = projection.init({}, 0), seq = 0
  return { get state() { return state }, event(type, data, time) { state = projection.apply(state, { type, data, time, seq: seq++ }); return state } }
}
function call(f, id, name = 'read_file', args = { path: 'app.js' }, content = 'unchanged', time = 200) {
  f.event('tool/call', { callId: id, name, arguments: JSON.stringify(args) }, time)
  f.event('tool/result', { message: { toolCallId: id, content: [{ type: 'text', text: content }], isError: false } }, time + 1)
}

test('identical outcomes trigger one durable reminder, changed evidence and writes reset repetition', () => {
  const f = fold(); f.event('turn/start', { turn: 1 }, 100)
  for (let i = 0; i < 3; i++) call(f, String(i), 'read_file', { description: `Read ${i}`, path: 'app.js' }, 'same', 200 + i * 10)
  const notice = efficiencyNotice(f.state, config)
  assert.match(notice.id, /^repeat:/)
  assert.match(notice.text, /3 times/)
  f.event('user/message', { source: { kind: 'dsh-efficiency', notice: notice.id } }, 240)
  call(f, '4', 'read_file', { path: 'app.js' }, 'same', 250)
  assert.equal(efficiencyNotice(f.state, config), null)
  call(f, '5', 'read_file', { path: 'app.js' }, 'changed', 260)
  assert.equal(f.state.samples[0].count, 1)
  call(f, '6', 'edit', { path: 'app.js' }, 'edited', 270)
  assert.deepEqual(f.state.samples, [])
  projection.stateSchema.parse(f.state)
})

test('intentional waits, question tools, background results and PTC wrappers do not trigger repeat warnings', () => {
  const f = fold(); f.event('turn/start', { turn: 1 }, 100)
  let i = 0
  for (const name of ['qq_wait_for_messages', 'ask_user_question', 'job_output', 'list_agents', 'run_code']) {
    for (let n = 0; n < 4; n++) call(f, String(i++), name, {}, 'waiting', 200 + i * 10)
  }
  assert.equal(efficiencyNotice(f.state, config), null)
  assert.deepEqual(f.state.samples, [])
})

test('long-running listeners and wait-only steps do not consume working-step checkpoints', () => {
  const f = fold(); f.event('turn/start', { turn: 1 }, 100)
  for (let i = 0; i < 25; i++) {
    const time = 200 + i * 100
    f.event('step/start', { step: i + 1 }, time)
    f.event('assistant/message', {}, time + 1)
    f.event('tool/call', { callId: `root-${i}`, name: 'run_code', arguments: '{}' }, time + 2)
    f.event('tool/ptc-dispatch-start', { subCallId: String(i), name: 'qq_wait_for_messages', arguments: {} }, time + 3)
    f.event('tool/ptc-dispatch', { subCallId: String(i), content: [], isError: false }, time + 90)
    f.event('tool/result', { message: { toolCallId: `root-${i}`, content: [], isError: false } }, time + 91)
    f.event('step/end', {}, time + 92)
  }
  assert.equal(f.state.steps, 25)
  assert.equal(f.state.workSteps, 0)
  assert.equal(efficiencyNotice(f.state, config), null)
  projection.stateSchema.parse(f.state)
})

test('parallel and nested intervals use wall-time unions and expose overlapping waits', () => {
  const f = fold()
  f.event('turn/start', { turn: 2 }, 100)
  f.event('step/start', { turn: 2, step: 1 }, 110)
  f.event('assistant/message', { usage: { outputTokens: 300 } }, 210)
  f.event('tool/call', { callId: 'root', name: 'run_code', arguments: '{}' }, 220)
  f.event('tool/call', { callId: 'parallel', name: 'bash', arguments: '{}' }, 220)
  f.event('tool/ptc-dispatch-start', { subCallId: 'nested', name: 'qq_wait_for_messages', arguments: {} }, 230)
  f.event('approval/asked', { id: 'approval' }, 240)
  f.event('approval/decided', { id: 'approval' }, 280)
  f.event('tool/ptc-dispatch', { subCallId: 'nested', content: [], isError: false }, 330)
  f.event('tool/result', { message: { toolCallId: 'root', content: [], isError: false } }, 420)
  f.event('tool/result', { message: { toolCallId: 'parallel', content: [], isError: false } }, 520)
  f.event('turn/end', { turn: 2 }, 530)
  const summary = efficiencySummary(f.state, 9000)
  assert.equal(summary.observed_wall_ms, 430)
  assert.equal(summary.intervals_ms.modelPhaseMs, 100)
  assert.equal(summary.intervals_ms.toolWindowMs, 300)
  assert.equal(summary.intervals_ms.approvalWaitMs, 40)
  assert.equal(summary.intervals_ms.intentionalWaitMs, 100)
  assert.equal(summary.tool_calls, 2)
  assert.match(summary.measurement, /Never add them together/)
  assert.equal(efficiencyNotice(f.state, config), null)
})

test('PTC inner repetitions are detected without copying tool arguments or output into the projection', () => {
  const f = fold(); f.event('turn/start', { turn: 1 }, 100)
  for (let i = 0; i < 3; i++) {
    f.event('tool/ptc-dispatch-start', { subCallId: String(i), name: 'pwsh', arguments: { command: 'private-command' } }, 110 + i * 10)
    f.event('tool/ptc-dispatch', { subCallId: String(i), content: [{ type: 'text', text: 'private-output' }], isError: true }, 115 + i * 10)
  }
  assert.match(efficiencyNotice(f.state, config).text, /pwsh/)
  assert(!JSON.stringify(f.state).includes('private-'))
})

test('long-output, transport and step reminders are advisory and capped at three per turn', () => {
  const f = fold(); f.event('turn/start', { turn: 1 }, 100)
  f.event('assistant/message', { usage: { outputTokens: 18000 } }, 200)
  let notice = efficiencyNotice(f.state, config)
  assert.equal(notice.id, 'long-output')
  f.event('user/message', { source: { kind: 'dsh-efficiency', notice: notice.id } }, 201)
  for (let i = 0; i < 2; i++) {
    f.event('assistant/attempt', {}, 205 + i * 5)
    f.event('llm/retry', { failure: { code: 'TRANSPORT' } }, 206 + i * 5)
  }
  notice = efficiencyNotice(f.state, config); assert.equal(notice.id, 'transport')
  f.event('user/message', { source: { kind: 'dsh-efficiency', notice: notice.id } }, 220)
  for (let i = 0; i < 20; i++) {
    f.event('step/start', { step: i + 1 }, 230 + i)
    f.event('step/end', {}, 230 + i)
  }
  notice = efficiencyNotice(f.state, config); assert.equal(notice.id, 'checkpoint:1')
  assert.match(notice.text, /not a step limit/)
  f.event('user/message', { source: { kind: 'dsh-efficiency', notice: notice.id } }, 260)
  for (let i = 0; i < 3; i++) call(f, String(i), 'bash', {}, 'same', 270 + i * 10)
  assert.equal(efficiencyNotice(f.state, config), null)
  f.event('turn/start', { turn: 2 }, 400)
  assert.equal(f.state.notices.length, 0)
  assert.equal(f.state.outputTokens, 0)
})

test('forked history is ignored, unrelated events reuse state, active waits extend only the reported view', () => {
  const initial = projection.init({}, 10)
  assert.equal(projection.apply(initial, { type: 'turn/start', seq: 1, time: 100, data: { turn: 1 } }), initial)
  assert.equal(projection.apply(initial, { type: 'session/title', seq: 12, time: 100, data: {} }), initial)
  let state = projection.apply(initial, { type: 'turn/start', seq: 10, time: 100, data: { turn: 1 } })
  state = projection.apply(state, { type: 'tool/call', seq: 11, time: 200, data: { callId: 'wait', name: 'ask_user_question', arguments: '{}' } })
  assert.equal(efficiencySummary(state, 1200).intervals_ms.questionWaitMs, 1000)
  assert.equal(state.questionWaitMs, 0)
  projection.stateSchema.parse(state)
})

test('native team waits and pure shell sleeps are measured as waiting without hiding real shell work', () => {
  assert.equal(toolKind('team_wait'), 'background')
  assert.equal(toolKind('bash', '{"command":"sleep 20; echo waited"}'), 'intentional')
  assert.equal(toolKind('exec_command', '{"cmd":"/bin/sleep 0.5"}'), 'intentional')
  for (const command of ['node test.mjs; sleep 20', 'sleep 2; rm data', 'sleep 1; echo $(read_secret)', 'sleep 1 && node test.mjs']) {
    assert.equal(toolKind('bash', { command }), 'tool')
  }
  const f = fold(); f.event('turn/start', { turn: 1 }, 100)
  f.event('step/start', {}, 101)
  call(f, 'wait', 'team_wait', {}, 'settled', 110)
  f.event('step/end', {}, 112)
  f.event('step/start', {}, 113)
  f.event('tool/call', { callId: 'sleep', name: 'bash', arguments: '{"command":"sleep 20; echo waited"}' }, 120)
  f.event('tool/result', { message: { toolCallId: 'sleep', content: [], isError: false } }, 20120)
  f.event('step/end', {}, 20121)
  assert.equal(f.state.workSteps, 0)
  assert.equal(f.state.backgroundWaitMs, 1)
  assert.equal(f.state.intentionalWaitMs, 20000)
})

test('large required tool output is distinct from reasoning and visible explanations', () => {
  const f = fold(); f.event('turn/start', { turn: 1 }, 100)
  f.event('step/start', {}, 110)
  const content = '<svg>' + 'x'.repeat(20000) + '</svg>'
  f.event('assistant/message', { usage: { outputTokens: 12000 }, message: { content: [
    { type: 'reasoning', text: 'r'.repeat(15000) },
    { type: 'tool-call', name: 'write', arguments: JSON.stringify({ file_path: 'art.svg', content }) },
  ] } }, 200)
  assert.equal(efficiencyNotice(f.state, config), null)
  const status = efficiencySummary(f.state, 200)
  assert.equal(status.output_characters.reasoning, 15000)
  assert(status.output_characters.tool_arguments > 20000)
  assert(!JSON.stringify(f.state).includes('<svg>'))
  assert(!JSON.stringify(f.state).includes('rrrrr'))
  f.event('step/start', {}, 210)
  f.event('assistant/message', { usage: { outputTokens: 5000 }, message: { content: [
    { type: 'text', text: 'explanation'.repeat(2000) }, { type: 'tool-call', name: 'bash', arguments: '{}' },
  ] } }, 220)
  assert.equal(efficiencyNotice(f.state, config).id, 'long-output')
  projection.stateSchema.parse(f.state)
})

test('reasoning-heavy steps get one follow-up after recurrence, without repeated unchanged notices', () => {
  const f = fold(); f.event('turn/start', { turn: 1 }, 100)
  for (let i = 1; i <= 3; i++) {
    f.event('step/start', {}, 100 + i * 10)
    f.event('assistant/message', { usage: { outputTokens: 7000 }, message: { content: [
      { type: 'reasoning', text: 'private-reasoning'.repeat(1000) },
      { type: 'tool-call', name: 'bash', arguments: '{"command":"mkdir art"}' },
    ] } }, 101 + i * 10)
    const notice = efficiencyNotice(f.state, config)
    if (i <= 2) {
      assert.equal(notice.id, `reasoning:${i}`)
      assert.match(notice.text, i === 1 ? /smallest concrete/ : /earlier reminder/)
      f.event('user/message', { source: { kind: 'dsh-efficiency', notice: notice.id } }, 102 + i * 10)
      assert.equal(efficiencyNotice(f.state, config), null)
    } else assert.equal(notice, null)
  }
  assert(!JSON.stringify(f.state).includes('private-reasoning'))
  assert.equal(f.state.notices.length, 2)
})

test('SVG edit/review cycles survive changed outputs and count each successful revision once', () => {
  const f = fold(); f.event('turn/start', { turn: 1 }, 100)
  f.event('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: '\u751f\u6210\u4e00\u6bb5\u9e48\u9e55\u9a91\u81ea\u884c\u8f66\u7684svg' }] }, 101)
  for (let i = 0; i < 3; i++) {
    call(f, `edit-${i}`, i ? 'edit' : 'write', { file_path: 'pelican.svg', content: `revision-${i}` }, `changed-${i}`, 200 + i * 20)
    call(f, `review-${i}`, 'read_image', { file_path: `preview-${i}.png` }, `image-${i}`, 202 + i * 20)
    call(f, `crop-${i}`, 'read_image', { file_path: `crop-${i}.png` }, `detail-${i}`, 204 + i * 20)
    if (i === 0) assert.equal(efficiencyNotice(f.state, config), null)
    if (i === 1) assert.match(efficiencyNotice(f.state, config).id, /^visual-review:/)
  }
  const notice = efficiencyNotice(f.state, config)
  assert.match(notice.id, /^visual-review:/)
  assert.match(notice.text, /3 successful SVG/)
  assert.match(notice.text, /does not prove/)
  assert.equal(f.state.artifacts[0].cycles, 3)
  assert(!JSON.stringify(f.state).includes('pelican.svg'))
  f.event('user/message', { source: { kind: 'dsh-efficiency', notice: notice.id } }, 270)
  assert.equal(efficiencyNotice(f.state, config), null)
  call(f, 'other', 'write', { file_path: 'second.svg', content: 'second' }, 'written', 280)
  call(f, 'other-review', 'read_image', { file_path: 'second.png' }, 'image', 282)
  assert.deepEqual(f.state.artifacts.map(entry => entry.cycles), [3, 1])
  projection.stateSchema.parse(f.state)
})

test('SVG failures, unrelated tasks and wait tools do not manufacture revision cycles', () => {
  const f = fold(); f.event('turn/start', { turn: 1 }, 100)
  call(f, 'write', 'write', { file_path: 'art.svg', content: 'one' })
  call(f, 'read', 'read_image', { file_path: 'art.png' })
  assert.deepEqual(f.state.artifacts, [])
  f.event('user/message', { source: { kind: 'dsh-workflow' } }, 210)
  f.event('tool/call', { callId: 'bad', name: 'write', arguments: '{"file_path":"art.svg"}' }, 211)
  f.event('tool/result', { message: { toolCallId: 'bad', content: [], isError: true } }, 212)
  assert.deepEqual(f.state.artifacts, [])
  call(f, 'ok', 'write', { file_path: 'art.svg', content: 'one' }, 'written', 220)
  f.event('tool/call', { callId: 'bad-review', name: 'read_image', arguments: '{"file_path":"art.png"}' }, 222)
  f.event('tool/result', { message: { toolCallId: 'bad-review', content: [], isError: true } }, 223)
  call(f, 'wait', 'team_wait', {}, 'settled', 224)
  assert.equal(f.state.artifacts[0].cycles, 0)
})

test('SVG workflow admission is scoped to explicit creation requests', () => {
  const user = text => [{ source: { kind: 'user' }, content: [{ type: 'text', text }] }]
  assert(isSvgCreation(user('\u751f\u6210\u4e00\u6bb5\u9e48\u9e55\u9a91\u81ea\u884c\u8f66\u7684svg')))
  assert(isSvgCreation(user('Create an SVG of a pelican riding a bicycle')))
  assert(!isSvgCreation(user('\u8bf7\u89e3\u91ca\u5982\u4f55\u751f\u6210SVG')))
  assert(!isSvgCreation(user('\u4e0d\u8981\u751f\u6210 SVG\uff0c\u53ea\u4ecb\u7ecd\u683c\u5f0f')))
  assert(!isSvgCreation(user('How do I generate SVG?')))
  assert(!isSvgCreation(user('Check the cache implementation')))
  assert(!isSvgCreation([{ source: { kind: 'dsh-memory-team' }, content: [{ type: 'text', text: '\u751f\u6210SVG' }] }]))
})
