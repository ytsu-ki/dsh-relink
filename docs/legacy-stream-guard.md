# dsh-stream-guard (legacy)

Historical documentation for the earlier stream-request guard. The default `dsh-memory-team` installation does not enable this module.

The guard targets connections that keep delivering heartbeat messages while actual content stalls, and steps that spend several minutes retrying failures. It does not alter the model, effort, prompts, permissions, system proxy or DSH installation. A triggered guard returns an explicit failure, cancels the corresponding network request and retains attempts already logged by Harness. Incomplete answers and tool arguments are never executed as successful results.

## Default behavior

| Setting | Default | Meaning |
| --- | --- | --- |
| `providers` | `deepseek-account`, `deepseek-official` | Protect only these providers |
| `stalledMs` | `60000` | Stop after 60 seconds without content; SSE heartbeats do not reset this timer |
| `terminalGraceMs` | `30000` | Wait up to 30 seconds for termination after all content blocks close |
| `maxCallMs` | `180000` | Limit one request to three minutes even while output continues |
| `maxStepMs` | `300000` | Limit cumulative request time for a step and its retries to five minutes |
| `maxRetries` | `2` | Permit up to two additional attempts for natively retryable failures |

Budgets begin when the model request starts, including the wait before first output. Tool work, user questions and time between steps are excluded; retry backoff is excluded from cumulative request time. A successfully completed step resets retries and cumulative budgets for the next step.

A guard timeout stops the step and is not automatically retried. Other native errors remain with DSH's retry plugin until the guard's attempt count or cumulative budget is exhausted. The guard adds no native retries and sends no retry requests itself. `maxRetries` applies to standard agent calls carrying `sessionId` and `signal`; independent SDK calls receive only per-request limits.

Auxiliary requests with an explicit `purpose`, including session titles and context compression, bypass protection. Only the providers above are supported by default; cancellation behavior of other adapters is not guaranteed.

## Installation and disabling

The legacy integration targeted DeepSeek Harness **0.2.0-rc.2**. The original integration notes recorded Node.js **22.17+**, with local tests on Node.js 24.21.0. Other Harness versions require separate verification.

1. Download or clone the repository to a local directory.
2. Open **Plugins > Add plugin** in Harness.
3. Enter the repository's **absolute directory path** and install.
4. For a legacy bundle, enable **Stream Request Guard** and restart if prompted.

Alternatively, the agent can use native `plugin_manager` with `action: install_bundle` and the repository's absolute path as `target`. Do not edit profile package manifests or lockfiles manually. The current repository defaults to the memory/team plugin; use an actual legacy bundle to enable the older guard.

Disable or uninstall through the plugin manager. Disabling cancels protected requests, removes listeners and restores the earlier fetch wrapper. If a later plugin has wrapped fetch, this guard deactivates itself without overwriting that wrapper.

## Configuration

Override entries through plugin settings or the active profile's `cordis.patch.yml`. The loader replaces the entire `config`, so the complete configuration is shown; omitted fields return to defaults.

```yaml
- id: dsh-stream-guard
  config:
    providers: [deepseek-account, deepseek-official]
    stalledMs: 60000
    terminalGraceMs: 30000
    maxCallMs: 180000
    maxStepMs: 300000
    maxRetries: 2
```

All limits are integer milliseconds from `1` to `2147483647`; `maxRetries` is an integer from `0` to `10`. Invalid configuration rejects loading rather than silently disabling protection. Legitimate complex reasoning may exceed three minutes. Increase `maxCallMs` and `maxStepMs`, or temporarily disable the legacy guard, when appropriate. Excessively short limits can interrupt valid generation while still consuming generated tokens.

## Implementation and boundaries

- Wrap the original stream with Cordis `llm/stream`, preserving routing, frozen request configuration, blocks, usage and replay data.
- DSH 0.2.0-rc.2 freezes request objects and its waterfall `next()` does not accept a replacement request. Node.js `AsyncLocalStorage` therefore attaches a separate cancellation signal through a thin global fetch wrapper only within that request's async scope. Requests outside the scope pass through. URLs, request bodies, authentication headers, prompts and output are not read or logged.
- Run stall timing only while waiting for the next upstream chunk; do not add a log write for each token. An absolute deadline prevents endless small output chunks extending a call indefinitely.
- A prepended `agent/request-error` listener explicitly terminates guard failures so that DSH's `always` retry policy cannot replay them.
- Isolate retry state by the standard agent's cancellation signal and session ID. Do not scan or rewrite history or add session event types unknown to DSH.
- Cancellation has been verified to close HTTP streams from the bundled DeepSeek Messages adapter. Third-party implementations that bypass global fetch or ignore cancellation may only have consumer waiting bounded; their underlying work may continue. They are outside default support.
- This reduces failed waiting. It does not repair service, network or proxy failures or change the host UI's token/s formula.

Failure codes include `DSH_STREAM_GUARD_STALLED`, `DSH_STREAM_GUARD_TERMINAL_TIMEOUT`, `DSH_STREAM_GUARD_CALL_DEADLINE`, `DSH_STREAM_GUARD_STEP_DEADLINE`, `DSH_STREAM_GUARD_RETRY_LIMIT` and `DSH_STREAM_GUARD_INCOMPLETE`. Logs contain only code, duration, attempt count, provider, model and session ID. No separate log file or upload is added.

## Development and verification

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm check
pnpm test
pnpm pack
```

Tests cover configuration, valid output passthrough, missing output, absolute deadlines during continued output, missing termination, retry limits, cumulative budgets, session isolation, user cancellation, unload cleanup and integration with real Cordis / DSH Messages components and a local HTTP SSE server. They use dummy credentials, access only `127.0.0.1`, require no DeepSeek account and incur no model fees.

The repository provides Node.js 22 / 24 CI and packaging. Uploaded commits must actually run before a remote CI result can be claimed. The package `files` allowlist includes plugin code, default configuration, locale metadata, README and license. Personal reports, sessions, credentials and dependencies must not be committed; local reports are ignored.

## Repository publication

The original package included source, tests, a lockfile, CI and an MIT license for GitHub publication. Repository metadata now lives in `package.json`; publishing or pushing is a separate maintainer action and does not happen as part of a local build.

Interface references: [DSH source](https://github.com/deepseek-ai/deepseek-harness), [official thinking-mode documentation](https://api-docs.deepseek.com/guides/thinking_mode/).
