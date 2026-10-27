// Real-host acceptance on macOS: boots the installed DeepSeek Harness runtime (Electron in Node
// mode, the same process model the desktop app uses for plugins) with an isolated HOME and
// DSH_HOME, installs a packed plugin through `dsh plugin add`, and answers headless tasks
// against a local fake model. Telemetry is disabled and no account or remote model is used.
//
//   node test/host/desktop-acceptance.mjs --package /abs/dsh-relink-x.tgz [--label new]
//     [--app "/Applications/DeepSeek Harness.app"] [--reps 5] [--backend sqlite|markdown]
//     [--basic-memory /abs/basic-memory] [--no-plugin] [--plugin-id dsh-relink] [--extra-package /abs/other.tgz]
import { parseArgs } from 'node:util'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, readdir, rm, realpath, readFile } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join, basename } from 'node:path'
import assert from 'node:assert/strict'

const { values } = parseArgs({ options: {
  app: { type: 'string', default: '/Applications/DeepSeek Harness.app' }, package: { type: 'string' }, label: { type: 'string', default: 'run' },
  reps: { type: 'string', default: '5' }, backend: { type: 'string', default: 'sqlite' }, 'basic-memory': { type: 'string', default: '' },
  'no-plugin': { type: 'boolean', default: false }, keep: { type: 'boolean', default: false }, 'plugin-id': { type: 'string', default: '' },
  // Also install another package first, e.g. dsh-memory-team 0.5.x, to check an upgrade without removal.
  'extra-package': { type: 'string', default: '' },
} })
// The bundle id equals the package name: dsh-relink, or dsh-memory-team for 0.5.x packages.
const pluginId = values['plugin-id'] || /^(.+?)-\d+\.\d+\.\d+/.exec(basename(values.package ?? ''))?.[1] || 'dsh-relink'
const electron = join(values.app, 'Contents/MacOS/DeepSeek Harness')
const cli = join(values.app, 'Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js')
const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-host-acceptance-')))
const home = join(root, 'home'), dshHome = join(root, 'dsh'), project = join(root, 'project'), vault = join(root, 'vault')
for (const dir of [home, join(project, '.git'), vault]) await mkdir(dir, { recursive: true })

// --- Local fake model: OpenAI chat-completions streaming with scripted tool calls. ---
const requests = []
let firstRequestAt = null
const chunk = (res, delta, finish = null) => res.write(`data: ${JSON.stringify({ id: 'fake', object: 'chat.completion.chunk', created: 0, model: 'fake-model', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`)
const textOf = content => typeof content === 'string' ? content : Array.isArray(content) ? content.map(part => part.text ?? '').join('\n') : ''
const server = createServer((req, res) => {
  let body = ''
  req.on('data', data => { body += data })
  req.on('end', () => {
    if (!req.url.endsWith('/chat/completions')) { res.writeHead(404).end(); return }
    firstRequestAt ??= performance.now()
    const request = JSON.parse(body)
    requests.push({ at: performance.now(), body: request })
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const last = request.messages.at(-1)
    // The plugin's recall context is admitted after the user's text, so scan every user message.
    const prompt = request.messages.filter(m => m.role === 'user').map(m => textOf(m.content)).join('\n')
    const call = (name, args) => {
      chunk(res, { role: 'assistant', tool_calls: [{ index: 0, id: `call_${requests.length}`, type: 'function', function: { name, arguments: '' } }] })
      chunk(res, { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] })
      chunk(res, {}, 'tool_calls')
    }
    if (last.role === 'tool') { chunk(res, { role: 'assistant', content: 'ACK' }); chunk(res, {}, 'stop') }
    else if (prompt.includes('STATUS_PROBE')) call('project_memory_status', {})
    else if (prompt.includes('SAVE_PROBE')) call('project_memory_save', { key: 'host-acceptance', title: 'Host acceptance kestrel', kind: 'fact', summary: 'The kestrel marker HOSTMARKER was saved through the real host.', evidence: 'Desktop acceptance run.', files: [] })
    else { chunk(res, { role: 'assistant', content: 'Done' }); chunk(res, {}, 'stop') }
    res.write('data: [DONE]\n\n'); res.end()
  })
})
server.listen(0, '127.0.0.1'); await once(server, 'listening')
const port = server.address().port

const env = {
  HOME: home, DSH_HOME: dshHome, PATH: `${join(values.app, 'Contents/Resources/runtime/bin')}:/usr/bin:/bin`,
  ELECTRON_RUN_AS_NODE: '1', DSH_FAKE_MODEL_KEY: 'local-test-only', LANG: 'en_US.UTF-8',
  // Never export telemetry; the exporter is also disabled in the profile patch.
  DSH_TELEMETRY_OTLP_URL: 'http://127.0.0.1:9/v1/logs',
  // Reuse the local pnpm content store so installing the package needs no registry download.
  npm_config_store_dir: join(homedir(), 'Library/pnpm/store'),
}
const dsh = (args, cwd = project) => new Promise((resolve, reject) => {
  const started = performance.now()
  const child = spawn(electron, ['--expose-internals', cli, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  child.stdout.on('data', data => { stdout += data }); child.stderr.on('data', data => { stderr += data })
  child.on('error', reject)
  child.on('close', code => resolve({ code, stdout, stderr, ms: performance.now() - started }))
})

const result = { label: values.label, backend: values.backend, plugin: !values['no-plugin'], host: null, runs: [], checks: {} }
try {
  const help = await dsh(['--profile', 'headless', '--help'])
  assert.equal(help.code, 0, help.stderr)
  const profile = join(dshHome, 'profiles', 'headless')
  if (values['extra-package']) {
    const extra = await dsh(['plugin', '--profile', 'headless', 'add', values['extra-package']], profile)
    assert.equal(extra.code, 0, `extra plugin install failed: ${extra.stderr.slice(-2000)}`)
  }
  if (!values['no-plugin']) {
    const add = await dsh(['plugin', '--profile', 'headless', 'add', values.package], profile)
    assert.equal(add.code, 0, `plugin install failed: ${add.stderr.slice(-2000)}`)
    result.install_ms = Math.round(add.ms)
  }
  const plugin = values['no-plugin'] ? '' : `
- id: ${pluginId}
  config:
    database: ${JSON.stringify(join(root, 'data', 'memory.sqlite'))}
    knowledgeRoot: ${JSON.stringify(values.backend === 'markdown' ? vault : '')}
    knowledgeProject: ''
    basicMemoryCommand: ${JSON.stringify(values['basic-memory'])}
    basicMemoryConfig: ${JSON.stringify(join(root, 'state'))}
    betterleaksCommand: ''
    projectRoot: ''`
  await writeFile(join(profile, 'cordis.patch.yml'), `
- id: llm-pi-ai
  config:
    providers:
      local-fake:
        api: openai-completions
        baseURL: http://127.0.0.1:${port}/v1
        apiKeyEnv: DSH_FAKE_MODEL_KEY
        models:
          - id: fake-model
            contextWindow: 64000
            maxTokens: 2048
            input: [text]
            reasoningEfforts: false
- id: agent-default-model
  config:
    provider: local-fake
    model: fake-model
- id: otel
  disabled: true
- id: session-telemetry-otel
  disabled: true
- id: session-title-llm
  disabled: true${plugin}
`)
  const dump = await dsh(['--profile', 'headless', '--dump-config'])
  result.host = { composed_entries: (dump.stdout.match(/^- id: /gm) ?? []).length, plugin_entry: dump.stdout.includes(`- id: ${pluginId}`) }
  const task = async (text, reps = 1) => {
    const runs = []
    for (let i = 0; i < reps; i++) {
      const before = requests.length
      firstRequestAt = null
      const started = performance.now()
      const run = await dsh(['--profile', 'headless', text])
      runs.push({ code: run.code, wall_ms: Math.round(run.ms), first_request_ms: firstRequestAt ? Math.round(firstRequestAt - started) : null, requests: requests.slice(before).map(r => r.body), stderr: run.stderr })
    }
    return runs
  }
  // Startup cost: identical trivial tasks in fresh host processes.
  const startup = await task('Say hello.', Number(values.reps))
  result.runs = startup.map(({ code, wall_ms, first_request_ms }) => ({ code, wall_ms, first_request_ms }))
  result.checks.all_exit_zero = startup.every(run => run.code === 0)
  result.checks.stderr_mentions_plugin_error = startup.some(run => /(dsh-relink|dsh-memory-team)[^\n]*(fail|error)/i.test(run.stderr))
  if (values['extra-package']) result.activation_diagnostics = [...new Set(startup[0].stderr.split('\n').filter(line => /dsh-relink|dsh-memory-team|did not activate|Failed plugins|projection/i.test(line)).map(line => line.trim().slice(0, 240)))].slice(0, 12)
  if (!values['no-plugin']) {
    const tools = startup[0].requests[0].tools?.map(tool => tool.function?.name) ?? []
    result.checks.tools = ['project_memory_search', 'project_memory_save', 'project_memory_forget', 'project_memory_status', 'team_start', 'team_wait', 'workflow_status'].every(name => tools.includes(name))
    result.checks.system_prompt_section = JSON.stringify(startup[0].requests[0].messages[0]).includes('Project memory and team coordination')
      || JSON.stringify(startup[0].requests[0].messages[0]).includes('Use project memory to avoid rediscovering')
    const [status] = await task('STATUS_PROBE')
    const toolResult = status.requests.at(-1)?.messages.find(m => m.role === 'tool')
    const parsed = toolResult ? JSON.parse(textOf(toolResult.content)) : null
    result.status = parsed && { plugin_version: parsed.plugin_version, runtime: parsed.runtime, backend: parsed.backend, health: parsed.health, basic_memory: parsed.basic_memory, problems: parsed.configuration?.problems ?? null, service: parsed.service ?? null }
    const [saved] = await task('SAVE_PROBE')
    result.checks.save_tool_result = JSON.stringify(saved.requests.at(-1)?.messages.find(m => m.role === 'tool') ?? '').includes('host-acceptance')
    // A new host process recalls the saved record before the first model request.
    const [recall] = await task('What is the host acceptance kestrel marker?')
    result.checks.restart_recall = JSON.stringify(recall.requests[0].messages).includes('HOSTMARKER')
    if (values.backend === 'markdown') {
      const journals = await readdir(join(vault, 'projects')).then(async dirs => (await Promise.all(dirs.map(dir => readdir(join(vault, 'projects', dir, 'journal')).catch(() => [])))).flat(), () => [])
      result.checks.journals_written = journals.length
    }
  }
} finally {
  server.close()
  if (values.keep) await writeFile(join(root, 'requests.json'), JSON.stringify(requests.map(r => r.body), null, 1))
  if (!values.keep) await rm(root, { recursive: true, force: true })
}
console.log(JSON.stringify(result))
