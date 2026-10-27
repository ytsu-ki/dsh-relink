# Windows acceptance

This document covers 0.6.0-beta.2. Earlier betas spent most of their Windows work on file watchers: recursive child handles blocked parent renames, a parent watcher was needed to notice root renames, and watcher failures needed retry and reconciliation logic. 0.6.0 removes watchers entirely. Markdown is reconciled by a metadata scan when memory is read, so the plugin holds no handle on the vault between reads. That removes the watcher failure classes but does **not** by itself prove Windows desktop behaviour, which has not been verified for this release.

## Before installation

Keep the primary profile unchanged. If the test profile already has `dsh-memory-team` installed, remove it before installing `dsh-relink`. Create a separate test profile with DSH's supported flow and back up its configuration, sessions and memory. Do not delete a home-directory `.git` or clear global npm/Git proxies; distinguish network or proxy failures from plugin loading errors.

```powershell
dsh plugin --profile windows-memory-test add 'C:\Downloads\dsh-relink-0.6.0-beta.2.tgz'
```

Developers run `pnpm install --frozen-lockfile --ignore-scripts`, `pnpm check` and `pnpm test` with Node.js 22.17+ or 24. CI is configured for Windows with Node 22, 24, 22.17.0 and 24.18.0; configuration alone is not evidence that a commit passed.

## What changed for Windows in 0.6.0

- No Chokidar, `fs.watch`, parent watcher, retry timer or 60-second reconciliation timer. Directory renames and replacements cannot be blocked by plugin watch handles.
- Activation opens no file. The SQLite database and the derived catalog are opened on first memory use and closed on unload. While open they block renaming any folder that contains them, because Windows does not rename a directory with an open file below it. Keep the database and the state directory (`basicMemoryConfig`) outside the vault and outside any folder that may be moved while Harness runs; the defaults, under the profile directory, already are.
- A missing or moved vault is reported as `unavailable` (`VAULT_MISSING`) and is never recreated at the old path.
- Trash moves fall back to copy-and-delete when the vault and state directory are on different volumes (`EXDEV`).
- Plugin writers in different processes (for example desktop and CLI on one profile) are serialized by lock files in the state directory.
- Basic Memory is not started, so no Python process or MCP pipe is involved in startup.

## Required acceptance on a real machine

| Scenario | Acceptance criteria |
| --- | --- |
| Cold start | Exit and reopen the desktop app with the test profile. `project_memory_status` shows the plugin version, `loaded_at`, host PID, Node and Electron versions; all seven tools exist. Repeat a complete exit and start and confirm saved memory is still found, with no new startup error. A port change alone does not prove a restart. |
| Project isolation | With `.git` in the home directory, two working directories without their own `.git` keep separate scopes. A marker saved in one is not recalled in the other. Nested repositories, worktrees and junctions keep correct identities. |
| Fresh-session recall | Save a random marker, open a new session without the history, ask for its key: the plugin context in the request contains it. Unrelated requests, the other project, changed evidence and expired records recall nothing. |
| Directory replacement | Another process repeatedly renames or replaces the project folder while the desktop app runs; no `EPERM` is caused by the plugin, and the next search shows the final contents. Repeat for the whole vault and an ancestor directory that does not contain the database or state directory; memory is `unavailable` while moved and recovers when restored. |
| Idle cost | After searches, Task Manager shows no CPU use attributable to the host from this plugin while idle, and handle counts return to their earlier level. |
| Subagents | Two independent tasks overlap and return results to the parent; repeating the dispatch creates no duplicate; native permissions and cancellation still apply. |
| Uninstall and reinstall | Tools disappear while the database and Markdown remain; reinstallation reads the records. |

Record DSH and plugin versions, Windows edition and architecture, the installed package SHA-256, `pnpm test` output and `project_memory_status`. Explain skips rather than counting them as passes. Keep real Basic Memory, Betterleaks, desktop and simulated-test results separate.

## Read-only ACL inspection

Use `project_memory_status` to find the `database`, `vault` or `catalog` path, then:

```powershell
node .\scripts\inspect-windows-acl.mjs 'C:\Users\your-name\.dsh\profiles\windows-memory-test\data\dsh-memory-team.sqlite'
```

The Node entry passes the path as environment data to a fixed .NET `GetAccessControl()` query in system Windows PowerShell, removes inherited PowerShell module paths, closes unused standard input and reports owner and rules as SIDs. It has a 30-second process budget that covers PowerShell cold start; a timeout is reported as a failure and never as healthy permissions. It reads ACL entries only and does not compute effective access or change anything. The older `.ps1` remains for manual use and may be rejected in Low-integrity directories.

Database files, Markdown, catalogs, history and trash are plaintext. Windows mode bits do not establish owner-only access; the plugin inherits directory ACLs and does not rewrite them.

## Startup crashes

Keep the `crash-...-host.log` named by Diagnostic report, especially Failed plugins and the first exception stack. The host exits on any unhandled rejection or uncaught exception after startup, so the first stack is the most useful evidence. Redact credentials and private paths before sharing, and do not upload knowledge bases or sessions.
