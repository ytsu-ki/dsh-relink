# Architecture decision: host-independent core, thin DSH adapter, on-demand Markdown reconciliation

Status: accepted for 0.6.0-beta.1, published as `dsh-relink` (formerly `dsh-memory-team`; storage paths and identifiers persisted in session logs keep the former name). Supersedes the 0.5.x layout (`memory-team.js` + `memory.js` + `basic-memory.js` + `knowledge-index.js`).

## Context

Evidence gathered from the 0.5.3-beta.3 baseline (tag `baseline-0.5.3-beta.3`) and the installed host:

- `apply()` did all work at host load: parsed local settings (invalid JSON aborted activation), opened SQLite, created the vault directory, probed Betterleaks and spawned the Python Basic Memory MCP server for every Markdown configuration. The MCP server was only used by a fallback path; normal recall read Markdown through the Orama index.
- SQLite and Markdown backends duplicated validation, freshness and revision checks but disagreed on relevance: SQLite matched any query term through FTS5 `OR` (common words admitted unrelated records), while Markdown used substring matching with a minimum-term rule.
- `knowledge-index.js` combined a JSON snapshot of every note body, Chokidar/native watchers, a Windows parent watcher, identity checks, retry backoff, a bounded event queue, stable-write delays and a 60-second timer. Most of the Windows fixes in 0.5.x addressed problems created by holding watcher handles.
- The desktop host (`DeepSeek Harness 0.2.1-rc.3`, Electron 44.7.0, Node 24.21.0) runs plugins in an Electron Node-mode child. Its `installFailLoud` handler exits the host on any unhandled rejection or uncaught exception, and its projection driver calls every plugin projection without a `try`/`catch`. A plugin whose `apply()` throws is only reported as inactive. Background work is therefore the dangerous surface, not activation.
- The plugin-facing JavaScript of `cordis`, `dsh-tools`, `dsh-agent`, `dsh-agent-loop`, `dsh-session`, `dsh-session-projection`, `dsh-subagent`, `dsh-tool-subagent`, `dsh-system-prompt` and `dsh-working-directory` is byte-identical between the pinned `0.2.1-rc.2` SDK and the installed `0.2.1-rc.3` host.

## Options compared

| Option | Summary | Why not / why |
| --- | --- | --- |
| A. Refactor in place | Split the existing files, keep Orama, watchers and the managed MCP server | Keeps every platform-specific watcher state machine, the always-started Python process and 100+ transitive packages from the MCP SDK. Does not resolve divergent relevance. |
| B. Host-independent core, thin adapter, on-demand reconciliation (chosen) | One memory service and relevance model over two canonical stores; Markdown is reconciled with a metadata scan when memory is read; derived index in SQLite FTS5 | Smallest design that removes the failure classes above. Uses only Node built-ins plus `yaml`, `zod` and `schemastery`. |
| C. Worker process or semantic retrieval | Run memory in a child/daemon, or add embeddings | Adds process lifecycle, IPC, model downloads and privacy questions to the exact area that causes host instability. No evidence that semantic recall is needed; rejected. |

## Decision

```
lib/memory-team.js        DSH adapter entry (Cordis plugin)
lib/dsh/                  adapter: configuration, tool schemas, recall admission
lib/core/                 host-independent: text, records, relevance, render, scope, secrets, service
lib/stores/               canonical stores and the derived Markdown catalog
lib/team.js               native subagent coordination (adapter-level; uses host services)
lib/efficiency.js         session projection and reminders
lib/legacy/               deprecated stream guard (unchanged behaviour, deprecation warning)
```

`lib/core` and `lib/stores` import no `@deepseek-ai/*` package; a test enforces this.

### Canonical data and synchronization

| Data | Canonical source | Derived data | Direction | Conflict handling |
| --- | --- | --- | --- | --- |
| Records for projects without a vault | SQLite `memories` table (schema unchanged, `user_version` 1) | `memory_fts` rows in the same database, written in the legacy token format | SQLite to FTS in one transaction | `BEGIN IMMEDIATE` plus integer revision; one writer wins across processes |
| Records for the vault project | Markdown files under `<vault>/projects/<scope>/` | `recall-index/<hash>.sqlite` catalog: signatures, metadata and term strings only | Markdown to catalog, one way, on every read | Content-hash revision; a cross-process lock file serializes plugin writers; external editors are detected by a content re-check before rename |
| History and trash | Files under the state directory (`basicMemoryConfig`, historical name) | none | write-once copies | never overwritten |
| Task journals | Markdown `journal/*.md` | catalog rows | Markdown to catalog | write-once (`wx`), duplicates ignored |

The catalog can be deleted at any time. It never contains private notes (`dsh_private: true` leaves only a signature tombstone) and stores scanner-sanitized term strings, not note bodies. Returned records are always reread from Markdown.

### Markdown reconciliation

Each search, recall or save runs one metadata scan of the project folder (`readdir` + `lstat`), compares signatures with the catalog and rereads only changed notes. There are no watchers, timers or queues, so there is nothing to recover after root deletion, directory replacement or a vault/ancestor move, and nothing consumes CPU or handles when idle. A note modified in the last 100 ms is re-checked until it is stable (bounded at one second); one that is still changing, or changes while it is read, is excluded from that read and reported as `unstable`. Measured cost on the development Mac: about 12 ms for 1,000 notes and about 110 ms for 10,000.

One reconciliation per project runs at a time; callers that arrive before it starts share it. It runs under the store's own lifetime signal, so cancelling one turn never fails another search that joined it, and each caller still stops waiting on its own cancellation. A project's catalog is opened once even under concurrent first use.

If the catalog cannot be opened or written, the store falls back to an in-memory catalog (the same code with `:memory:`) and reports `degraded`; a corrupt catalog file is replaced. `incrementalIndex: false` selects the in-memory catalog deliberately. If the vault root is missing, memory reports `unavailable`; the plugin never recreates a missing vault, because that would silently split data.

### Relevance (both backends)

Candidates come from FTS5 over the legacy term format (Latin words, digits, CJK bigrams). One shared scorer decides relevance with per-project inverse document frequency: exact keys and complete titles are decisive; otherwise a record needs enough rare matched terms. Common instruction words are stop words. Verified findings outrank task history, and automatic recall admits at most one unverified task record. A compound key such as `cache-ttl` is decisive anywhere in a request; a plain-word key such as `export` only in a short query. Thresholds were set on a labelled corpus and then checked unchanged on a held-out query set; results and the regression gate are described in `docs/benchmarks.md`.

### Basic Memory and Obsidian

Basic Memory is no longer started by the plugin. Markdown files keep the same frontmatter and sections, so an independently run Basic Memory 0.23.2 or Obsidian can keep editing and indexing the vault. `basicMemoryCommand` is accepted and ignored with a status note. Upgrading Basic Memory to 0.24 is not part of this change: 0.24 retires `disable_permalinks` and backfills `permalink` frontmatter, which the plugin tolerates (the revision changes once), and makes semantic search always on.

### Failure states

Every memory result carries `status`: `ok`, `no-match`, `degraded`, `withheld` (configured secret scanner failed: fail closed), or `unavailable` (store or vault cannot be used). Recall injects a short content-free notice for the last three states so a degraded component is never presented as an empty but healthy memory. Main tasks continue.

### Recall and context growth

Recall is one durable `user/message` per new user input. A small session projection remembers the digest of the last recall since the last compaction: an unchanged recall becomes a one-line pointer, a repeated no-match adds nothing, and a no-match after earlier records says that those records are superseded. Verified findings and unverified task history are rendered in separate, labelled sections.

### Coordination and diagnostics

`team_start` still goes through the native `subagent` tool, so permissions, cancellation, depth limits and result delivery stay native. Capacity now counts only children whose agent is `running`; finished children that remain resident do not block new work. With the in-process spawn runtime used in tests, finished children are released anyway, so this is a defensive change for continuable children rather than a reproduced 0.5.x defect. `team_wait` lists plugin-owned tasks and their state after joining, and worker prompts ask for an Answer / Evidence / Checks / Uncertainty / Next report the parent can check. `workflow_status` adds `time_ms`, an exclusive partition of wall time, alongside the earlier overlapping intervals. Policy and reminder texts are shorter (plugin system prompt about 2.8k characters instead of about 4.8k), and the reasoning-step reminder no longer asks the model to stop comparing approaches.

### Host safety

- `apply()` performs no filesystem, process or network work. Configuration problems become a `CONFIGURATION_ERROR` memory status instead of an activation failure, except schema validation, which the host performs before `apply()`.
- Every fire-and-forget task (journal capture) runs through a tracker that handles its rejection and is drained on unload; scanner child-process streams all have `error` listeners.
- Both projections are total: unexpected event shapes leave state unchanged (and valid for the host's checkpoint schema) and increment a fault counter.
- Plugin-level tests install `unhandledRejection` / `uncaughtException` canaries equivalent to the host's handler.

### Legacy stream guard

`lib/legacy/` keeps the earlier guard behind the `legacy-stream-guard` export (now `dsh-relink/legacy-stream-guard`) with unchanged behaviour and a deprecation warning. It imposes model request deadlines, which conflicts with this project's rules, so it is scheduled for removal in 0.7.0 rather than maintained.

### Measured trade-offs

The design is faster for Markdown first use, restarts and external-change visibility, and uses less memory, but some searches got slower: SQLite searches cost about 1-2 ms more because the shared scorer counts document frequency per query term, and every Markdown read rescans folder metadata (about 12 ms per 1,000 notes). See `docs/benchmarks.md`.

## Compatibility targets

DeepSeek Harness 0.2.1-rc.2 and 0.2.1-rc.3, Node.js 22.17 or later (built-in `node:sqlite` with FTS5), optional Basic Memory 0.23.2 run independently and optional Betterleaks 1.9.0. What was actually verified, and on which platform, is listed in `docs/compatibility.md`.

## Migration risks

- Existing SQLite databases are opened in place without schema changes; rollback to 0.5.3-beta.3 reads them unchanged.
- Existing Markdown is not rewritten. The old Orama JSON snapshots are ignored, not deleted; the new catalog is built on first use by reading each note once.
- Users who relied on the plugin to keep a Basic Memory index warm must run Basic Memory themselves. Markdown remains the source of truth, so no data is lost.
- Relevance is stricter. Some loosely related records that 0.5.x recalled are no longer recalled automatically; exact keys, titles and `project_memory_search` with explicit terms still find them.
- Contract changes are additive (`status`, `diagnostics`, `time_ms`, team task summaries) except `project_memory_status`, whose `backend` values are now `markdown` and `sqlite` and whose Basic Memory `service` field is gone.
- Session projections changed version; the host refolds them from the session log.

See `docs/migration.md` for the tested upgrade and rollback procedure.
