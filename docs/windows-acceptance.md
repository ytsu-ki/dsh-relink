# Windows fixes and acceptance

This document covers prerelease `0.5.3-beta.3`; old v0.5.2 assets remain available. The beta.1 investigation identified recursive child-directory handles blocking parent renames and PowerShell script loading failures in Low-integrity directories. The beta.2 Windows Node 22.17.0 / 24.18.0 suites each had 76 passes, no failures and three skips; the Low-integrity Node diagnostic and package loading in a fresh process passed. This version also fixes the watcher registration gap and stable-write checks bypassed by metadata reconciliation. See [Actions](https://github.com/ytsu-ki/dsh-memory-team/actions) for results for the relevant commit. Windows desktop cold starts and real Basic Memory / Betterleaks integrations still require separate acceptance. The first exception from the original host crash has not been confirmed.

## Before installation

Keep the primary profile unchanged. Create a separate test profile using DSH's supported flow and back up its configuration, sessions and memory. Do not delete the home directory's `.git` or automatically clear global npm/Git proxies. Distinguish network/proxy failures from plugin loading errors.

In the source directory, developers run `pnpm install --frozen-lockfile --ignore-scripts`, `pnpm check` and `pnpm test`. Use Node.js 22.17+ or 24. CI covers Windows / Ubuntu / macOS with Node.js 22 / 24 and exact Windows versions 22.17.0 / 24.18.0. It installs and tests the source ZIP, then installs the TGZ for a separate fresh-process check. Configuration alone does not establish a passing result. Windows ACL diagnostics use a fixed read-only query through system Windows PowerShell and do not change execution policy or existing permissions.

This example assumes a test profile named `windows-memory-test` already exists and that the release package was copied to the absolute path shown:

```powershell
dsh plugin --profile windows-memory-test add 'C:\Downloads\dsh-memory-team-0.5.3-beta.3.tgz'
```

## Fix scope

- Tests close stores, SQLite connections and watchers before deleting temporary directories. Mock scanners run explicitly through Node without relying on a shebang or enabling a shell.
- Home/root `.git` repositories no longer combine unrelated working directories by default. An optional absolute `projectRoot` applies only to itself and its descendants; other locations retain automatic detection. `knowledgeProject` selects a backend without changing project identity.
- Records in an old home scope remain intact and are not automatically migrated. Explicitly select a shared home project only after checking record ownership. A non-Git project that needs shared memory across subdirectories should set its own `projectRoot`.
- Windows uses native recursive observation for all note counts; other platforms retain their original selection. Native updates wait for write stability and check file signatures before/after reading. A note changed during reading is removed from the derived index and queued for rereading. Ranking, private-note filtering and credential checks retain their behavior.
- Each initial or replacement watcher registration schedules metadata reconciliation to cover writes between scanning and registration that produced no visible event. Metadata reconciliation and external notifications share a 100ms stable-write check. Completed plugin saves still refresh immediately. Recovery does not require a fixed sleep or manual `reconcile` from a test script.
- Windows does not report renaming the watched directory itself, so an additional nonrecursive parent watcher observes that directory. It remains active while the project root is missing and detects same-name recreation. Both watchers close on unload. Moving an entire vault or its ancestors requires separate testing and cannot be inferred from project-root replacement.
- Notifications flush in fixed 100ms windows. Pending paths are capped at 2,048; overflow becomes one metadata reconciliation. Sustained notifications do not postpone updates indefinitely. Missing filenames and directory events trigger throttled identity checks. Missing/replaced directories close obsolete handles without requiring a watcher error event.
- Metadata reconciliation continues every 60 seconds after watcher creation/runtime failures or identity changes. A failed watcher on the same identity waits at least five seconds before recreation; a new identity can bind immediately. `metadata-only` means degraded live observation, so newly edited external files may wait until the next reconciliation to become searchable.
- Diagnostics include `plugin_version`, `loaded_at`, `runtime.node/uv/pid`, `index.last_reconciled_at`, watcher batch/overflow/creation counts and `secret_scanner_error`. Automatic scanner installation does not yet support Windows; default `builtin-only` status does not establish real Betterleaks acceptance.

## Required acceptance on a real machine

| Scenario | Acceptance criteria |
| --- | --- |
| Cold start | Exit and reopen the desktop app with the same test profile. Check plugin version, load time, host PID and Node/libuv versions; all seven tools must exist. Repeat a complete exit/start and verify saved memory is still searchable with no new startup error. A port change alone does not prove the app restarted. |
| Project isolation | With `.git` in home, two independent working directories without their own `.git` must retain separate scopes. A unique marker saved in A must not appear in B. Nested repositories, worktrees and directory junctions must retain correct identities. |
| Explicit scope | Descendants of `projectRoot` share records; unrelated paths are not included. Unicode paths and spaces work. Invalid configuration returns an actionable error without writing to the wrong scope. |
| Fresh-session recall | Save a random marker and evidence in A, create a new session without the original history and ask only for its key. Plugin context in the request/log must contain the marker. Test unrelated queries, project B, changed evidence and expired records separately for no hits. |
| Watcher recovery | Test atomic saves and chunked writes in small and large stores. Another process repeatedly renames/replaces a project directory containing descendants; the plugin must not cause EPERM while observation is active. Permanently delete and recreate it, then check final contents, old-handle closure and recovery. Test vault/ancestor moves separately. |
| Watcher load | Batches still complete during sustained notifications. After many edits, the index matches final files and handles/queues do not grow indefinitely. CPU returns to idle after permanent directory deletion/replacement. High-frequency legitimate edits are not automatically a failure. |
| Subagents | Two independent tasks actually overlap and return results to the parent. Repeated dispatch creates no duplicate. Native permissions and cancellation remain with Harness. |
| Long tasks | Duplicate-result, checkpoint and SVG edit/view reminders remain bounded. Necessary work continues without truncated answers or new model deadlines. |
| Uninstall/reinstall | Tools disappear while the database and Markdown remain. Reinstallation can read records; no obsolete watcher or database handle remains open. |

Automated tests use official AgentLoop components with simulated model responses for fresh-session positive/negative cases, real native child-task lifecycles and fresh-process SQLite persistence. They do not replace the Windows desktop acceptance above.

## Read-only Windows ACL inspection

Use `project_memory_status` to find the actual `database` or `folder`, then substitute its path in PowerShell:

```powershell
node .\scripts\inspect-windows-acl.mjs 'C:\Users\your-name\.dsh\profiles\windows-memory-test\data\dsh-memory-team.sqlite'
```

The Node entry passes the target as environment data to a fixed .NET `FileInfo` / `DirectoryInfo.GetAccessControl()` query. It does not load a workspace `.ps1` through `-File`. The child removes inherited PowerShell module paths and analysis-cache variables, restricts module lookup to system Windows PowerShell modules and closes unused standard input. ACL reads avoid the Get-Item / Get-Acl modules. JSON serialization explicitly selects the system Utility module. Owner/rule identities are SIDs, avoiding account-name resolution. Parent environment and execution policy remain unchanged.

The manual diagnostic has a 30-second process budget including Windows PowerShell / .NET cold startup; expiration remains an explicit failure and does not limit model reasoning. CI probes previously recorded more than ten seconds before the first query line and more than 30 seconds at the Get-Acl stage. Direct .NET reading replaces that module path. Microsoft also documents possible first-start optimization work in its [startup troubleshooting guide](https://learn.microsoft.com/en-us/powershell/scripting/dev-cross-plat/performance/startup-performance).

The older `.ps1` remains for manual compatibility and may still be rejected by PowerShell 5.1 in a Low-integrity directory. Automated acceptance uses the Node entry. An unavailable query never reports permissions as healthy. Windows tests apply Low labels only to disposable temporary fixtures and delete them afterward; existing directory labels are untouched.

Database files, Markdown, index snapshots, history and trash are plaintext. Windows `0600` values do not establish POSIX owner-only access. The implementation inherits ACLs without rewriting them. Diagnostics list owner, inheritance and access rules; they do not calculate complete effective permissions or modify ACLs. For shared directories, inspect read grants to broad groups. Neither `0o666` nor successful script execution alone establishes privacy or public access.

## Building release assets

In a Git working directory with dependencies installed, run `pnpm release:prepare`. The development command needs only Python 3 standard libraries; installation, plugin runtime and the Node ACL diagnostic do not require Python. It produces a TGZ, source ZIP, `manifest.json` and `SHA256SUMS`, checks required resources and compares runtime files with source files. Existing versioned assets are not overwritten; choose another `--out` directory when needed.

The source ZIP includes Git-managed files and nonignored pending files. Review that list before publication. Keep `.local/`, databases, dependency directories and unrelated `outputs/` excluded. Extracted sources must support installation, checks and tests without manually supplying missing `rules/`. An incomplete archive does not pass acceptance.

## Recording results

Keep complete `pnpm test` output, DSH/plugin versions, Windows architecture, installed package SHA-256, desktop test-profile cold-start evidence and watcher status. Explain skips rather than counting them as passes. Record real Basic Memory, Betterleaks, desktop operations and mock tests separately.

For host startup crashes, retain the `crash-...-host.log` identified by Diagnostic report, especially Failed plugins and the first exception stack. If needed, try **Disable third-party plugins, back up profile patch, and restart**; other third-party plugins are affected. Redact credentials and private information before submitting logs, and do not upload complete knowledge bases or sessions.

## Review of beta.2 Windows evidence and new regressions

The first beta.2 directory stress run had 60 content mismatches. A later run added waits and explicit `reconcile` and passed 20 rounds. Without both scripts, not all differences can be attributed to fixture timing. A reproducible regression confirms the registration gap: notes written after scanning but before watcher registration can miss events. Another verifies that metadata reconciliation cannot bypass stable-write checks. A real filesystem case replaces directories across processes 20 times and recovers through notifications without manual `reconcile` or a fixed 5.2-second wait.

Rerun these regressions for release acceptance. Record large-store tests, whole-vault/ancestor moves and sustained CPU/handle sampling after deletion/replacement separately. Low CPU after ordinary file edits does not replace directory-deletion load testing. Real CLI memory acceptance currently covers SQLite only and cannot establish the complete Windows Markdown / Basic Memory path.

Include fixture sources, structured tool events and exit-code lists with follow-up tests. Before sharing logs, redact Windows user paths, ACL identities/SIDs, conversations and model-process text. Keep original logs locally rather than attaching them to public releases.
