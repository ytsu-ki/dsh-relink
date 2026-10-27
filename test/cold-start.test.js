import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

test('independent host-component processes load seven tools and persist memory across restart', { timeout: 20000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cold-start-'))
  await mkdir(join(dir, '.git'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const entry = process.env.DSH_RELINK_TEST_ENTRY || new URL('../lib/memory-team.js', import.meta.url).href
  const code = `
    import assert from 'node:assert/strict'
    import { join } from 'node:path'
    import { Context } from '@deepseek-ai/cordis'
    import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
    import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
    const plugin = await import(${JSON.stringify(entry)})
    const [dir, phase] = process.argv.slice(1), ctx = new Context(), requests = []
    try {
      await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
      ctx.provide('subagents', { listChildren: async () => [] })
      const harness = await mountAgentLoopTestHarness(ctx)
      class Adapter extends LlmAdapter {
        async *stream(options) {
          requests.push(options)
          yield { type: 'block-start', index: 0, blockType: 'text' }
          yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Done' } }
          yield { type: 'finish', reason: { kind: 'stop' } }
        }
      }
      ctx.llm.registerAdapter(['test'], new Adapter())
      await ctx.plugin(plugin, { database: join(dir, 'memory.sqlite'), projectRoot: '', knowledgeRoot: '', betterleaksCommand: '' })
      const names = ['project_memory_search', 'project_memory_save', 'project_memory_forget', 'project_memory_status', 'team_start', 'team_wait', 'workflow_status']
      assert(names.every(name => ctx.tools.get(name)))
      const agent = await harness.create('cold-' + phase, { provider: 'test', model: 'test' }, { cwd: dir })
      const invoke = (name, args) => ctx.tools.execute({ name, callId: name, arguments: args, agent, signal: new AbortController().signal })
      if (phase === 'save') {
        const result = await invoke('project_memory_save', { key: 'restart-proof', title: 'restart-proof', kind: 'fact', summary: 'PERSISTED_ONLY_IN_SQLITE', evidence: 'Synthetic restart fixture.', files: [] })
        assert.equal(result.isError, false)
      } else {
        assert.equal((await invoke('project_memory_search', { query: 'restart-proof' })).value.records.length, 1)
        agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'What is restart-proof?' }] }))
        await agent.whenIdle()
        assert.equal(requests.length, 1)
        assert(requests[0].messages.some(message => message.source?.kind === 'dsh-memory-team' && message.content.some(block => block.text?.includes('PERSISTED_ONLY_IN_SQLITE'))))
      }
      console.log('COLD_START_ACCEPTED:' + phase)
    } finally { await ctx.fiber.dispose() }
  `
  for (const phase of ['save', 'recall']) {
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '--eval', code, dir, phase], {
      cwd: fileURLToPath(new URL('..', import.meta.url)), timeout: 10000,
    })
    assert(stdout.includes(`COLD_START_ACCEPTED:${phase}`))
  }
})
