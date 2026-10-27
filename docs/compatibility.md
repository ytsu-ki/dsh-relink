# Supported versions

Status for 0.6.0-beta.1. "Verified" means the listed check was run for this release on the named environment; "configured" means CI is set up but no result is claimed here; "not verified" means no evidence exists for this release.

## Host and runtime

| Component | Versions | Status | Evidence |
| --- | --- | --- | --- |
| DeepSeek Harness desktop runtime | 0.2.1-rc.3 (Electron 44.7.0, Node 24.21.0), macOS arm64 | Verified | Real host boots of an isolated profile with the packed plugin (`test/host/desktop-acceptance.mjs`, five cold processes per backend): install through `dsh plugin add`, seven tools and the system prompt section in the first model request, `project_memory_status` and `project_memory_save` executed by the host (status reports `electron: 44.7.0`), recall in a new host process, journals in Markdown mode, exit code 0 and no plugin errors on stderr. Timings are in `docs/benchmarks.md`. |
| DeepSeek Harness desktop app (GUI cold start) | 0.2.1-rc.3, macOS arm64 | Not verified | The acceptance script runs the same Electron Node-mode runtime and plugin loader headlessly; it does not click through the desktop window. |
| DeepSeek Harness on Windows | any | Not verified | No Windows machine was available. CI is configured for Windows; see `docs/windows-acceptance.md` for the required manual acceptance. |
| DeepSeek Harness on Linux | any | Not verified | CI is configured for Ubuntu. |
| SDK packages used by tests | 0.2.1-rc.2 (pinned dev dependencies), 0.2.1-rc.3 | Verified | Full suite on both. The plugin-facing JavaScript of `cordis`, `dsh-tools`, `dsh-agent`, `dsh-agent-loop`, `dsh-session`, `dsh-session-projection`, `dsh-subagent`, `dsh-tool-subagent`, `dsh-system-prompt` and `dsh-working-directory` is byte-identical between rc.2 and the rc.3 desktop bundle. |
| Cordis | 4.0.5 | Verified | Same version in the SDK and the desktop bundle. |
| Node.js | 22.17.0 minimum; 24.x; 26.x | See table below | `node:sqlite` with FTS5 is required and is built in from 22.13; the desktop runtime's Electron Node also provides it (checked). |

## Node.js test runs

All runs at commit `b55302f` with the real Basic Memory 0.23.2, Betterleaks 1.9.0 and 0.5.3-beta.3 rollback tests enabled. The two skips are the Windows-only ACL tests.

| Node.js | SDK packages | Platform | Tests | Pass | Fail | Skipped |
| --- | --- | --- | --- | --- | --- | --- |
| 26.11.1 | 0.2.1-rc.2 | macOS arm64 | 110 | 108 | 0 | 2 |
| 26.11.1 | 0.2.1-rc.3 | macOS arm64 | 110 | 108 | 0 | 2 |
| 22.17.0 (official build, checksum verified) | 0.2.1-rc.2 | macOS arm64 | 110 | 108 | 0 | 2 |
| 24.21.0 (the desktop runtime's signed standalone Node) | 0.2.1-rc.2 | macOS arm64 | 110 | 105 | 3 | 2 |

The three failures on the signed 24.21.0 binary are the three native-subagent tests: macOS refuses to load the npm native add-on used by the test subagent runtime into a process with a different code-signing Team ID (`dlopen ... different Team IDs`). The 0.5.3-beta.3 baseline fails the same way on that binary. The plugin itself loads no native add-on; the same tests pass on the other Node builds, and the desktop runtime acceptance above runs the plugin in the host's own Electron runtime.

The release source archive, extracted and installed with `--frozen-lockfile`, passes `pnpm check` and `pnpm test` (110 tests, 105 pass, 5 skipped without the optional real-service variables), and the install archive passes the fresh-process cold-start test from a separate consumer project.

## Optional integrations

| Integration | Versions | Status | Notes |
| --- | --- | --- | --- |
| Obsidian | any | Not required | Plain Markdown; no Obsidian plugin is used. |
| Basic Memory | 0.23.2, run independently | Verified (macOS arm64) | Indexes plugin notes with `disable_permalinks` and `ensure_frontmatter_on_sync: false` without modifying them (`test/integration-markdown.test.js`). The plugin never starts it. |
| Basic Memory | 0.24.x | Not verified with a real binary | 0.24 writes `permalink` frontmatter; the plugin tolerates added fields (simulated in `test/markdown.test.js`), and rewritten notes get new revisions. |
| Betterleaks | 1.9.0 | Verified (macOS arm64) | Real binary test in `test/secrets.test.js`; automatic installation supports macOS and Linux arm64/x64 only. |
