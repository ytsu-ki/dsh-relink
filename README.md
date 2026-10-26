# dsh-memory-team [Beta / Experimental]

<img src="./icon.jpg" alt="Project Memory and Teams icon" width="160" />

An unofficial project developed and maintained independently by a community member.

## Current status and apology

This project is still in early development and testing. Its architecture, stability and compatibility have not been fully validated. Users have reported that installing or enabling the plugin can prevent the host from starting or cause an unexpected exit. The original cause and triggering conditions remain under investigation. We apologize for the disruption and thank everyone who has provided feedback.

The desktop application has been tested on **macOS arm64**. The beta.2 Windows Node 22.17.0 / 24.18.0 suites each reported 76 passes, no failures and three skips; ACL diagnostics and package loading in a fresh process passed. This version adds reconciliation after watcher registration and stable-write checks for metadata updates. See [Actions](https://github.com/ytsu-ki/dsh-memory-team/actions) for results for each commit. Two complete Windows desktop cold starts have not yet been verified. Use a separate test profile and back up its configuration, sessions and knowledge files before trying the plugin in an important workflow.

1. **Recovery:** if the host displays a startup failure dialog, try **Disable third-party plugins, back up profile patch, and restart**. This disables third-party plugins, backs up the profile patch and attempts to restart the host. Other third-party plugins are affected too. If startup still fails, keep the diagnostic log and backup for investigation. Do not delete the knowledge base or sessions as a default recovery step.
2. **Feedback:** use the [bug report template](https://github.com/ytsu-ki/dsh-memory-team/issues/new?template=bug_report.yml) and attach the `crash-...-host.log` identified by **Diagnostic report** in the dialog. Preserve **Failed plugins**, the first exception and its complete stack trace where possible. Include the DSH version, operating system, installation method and reproduction steps. Redact credentials, tokens and private information before submitting.

**This notice does not mean that the reported host startup failure has been fixed.** Release notes describe the specific fixes and verification performed.

A project memory and native subagent coordination plugin for DeepSeek Harness. It aims to reduce repeated exploration, repeated validation and serial investigation without imposing a time limit on model requests.

Built and tested against **Harness 0.2.1-rc.2**. The current published prerelease is **0.5.3-beta.3**; [Releases](https://github.com/ytsu-ki/dsh-memory-team/releases) provides the install package, source archive and checksums. See [Windows acceptance](docs/windows-acceptance.md) for fixes, installation and verification steps. The older stream guard remains in `lib/index.js` and [its documentation](docs/legacy-stream-guard.md); the default installation entry does not enable it.

## What memory and subagents address

| Capability | Problem in a DSH workflow | Behavior and limits |
| --- | --- | --- |
| Project memory | Forgetting verified conclusions between sessions, rereading files, repeating failed approaches and investigating the same project again | Retrieves a small set of relevant findings for the current project and includes their conclusions and evidence in a new task. Unrelated queries may return no hits. Expired records and records whose evidence files changed are excluded from automatic recall. Memory reduces repeated exploration; it does not increase model generation speed or replace current verification. |
| Subagent coordination | Independent investigations or reviews being performed serially, forcing the main agent to switch context repeatedly | Assigns bounded questions with explicit acceptance criteria to up to two native subagents. The main agent continues its own work, then checks their evidence. Simple tasks and dependent work normally stay with the main agent. Parallel work may increase total tokens and requests and does not guarantee lower elapsed time. |

Use memory to identify conclusions that still apply, delegate the remaining independent questions, then have the main agent validate and save reusable findings. **Obsidian is an optional Markdown editor.** Default SQLite memory and native coordination work without it.

Model service failures, proxy failures, a single long reasoning response and slow external tools require separate investigation. These capabilities do not shorten tasks by forcibly ending them.

## How it works

**Project memory:** when a knowledge directory is configured, Basic Memory indexes Markdown and Obsidian edits the same files. Before a new user task reaches the model, keyword retrieval supplies up to three records within a default total of 6,000 characters. Semantic search and additional summarization models are disabled. Ranking is deterministic and local; synonymous wording is not guaranteed to match. Records are isolated by canonical project path: the nearest ancestor `.git`, or the working directory when no repository exists. A Git repository at the home or filesystem root does not merge unrelated subdirectories by default. An absolute `projectRoot` applies only to that directory and its descendants; other locations retain automatic detection. Sharing the home directory requires explicit configuration. Worktrees have separate scopes by default. Old records stored under a home scope remain intact and are not migrated or mixed into new projects. Check ownership before migrating records after a scope change. Projects without a configured knowledge directory continue using SQLite.

**Incremental retrieval:** Markdown remains the source of truth. Orama 3.1.18 maintains a rebuildable local index. The first scan reads project notes; later starts load a snapshot bound to the vault, project and scanner rules, compare metadata and reread only changed notes. Normal searches reread the highest-ranked candidates and validate file fingerprints rather than reading every note on every turn. They do not wait for Basic Memory MCP readiness. Basic Memory remains available for its existing indexing and editing workflows. Index failures can fall back to the original MCP/Markdown path.

English and Unicode text retain substring matching and deterministic ranking. Common instruction terms are filtered; exact keys, verified status, complete titles and term relevance determine ordering. An exact key or the complete title of a verified record returns only the corresponding entries rather than filling spare slots with generic instructions. Orama uses character bigrams for CJK candidate retrieval, without embeddings or a summarization model. Source fixtures and compatibility tokens use Unicode escapes. Newly generated note sections and journal labels are English; existing notes remain readable without being rewritten.

Windows uses Node's native recursive watcher for every project size to avoid per-directory handles blocking parent renames. Other platforms use Chokidar 5.0.0 for up to 1,000 files and native recursion for larger projects. Events are batched into incremental updates. Metadata is reconciled every 60 seconds to recover missed events; unchanged bodies are not reread. Watch creation or runtime errors close the old watcher and enter `metadata-only` mode while periodic reconciliation and recovery attempts continue. A changed directory identity also causes rebinding. Index availability and watcher health are reported separately; successful reconciliation does not conceal an ongoing watcher error. New external content may become searchable only after the next reconciliation while degraded. Returned hits are reread, so deleted or newly private records cannot be recalled solely from cache. Continuous writes may temporarily make retrieval unavailable; the task continues with a diagnostic. Initial indexing consumes memory, disk space and time and is not guaranteed to make the first query faster.

Each memory has a stable key, conclusion, kind, evidence, source session, update time, revision and optional file fingerprints. Changed or missing evidence files, or records older than 30 days, stop automatic recall; manual searches can include stale records. Markdown revisions derive from file content, so manual edits invalidate old revisions. Only one concurrent replacement within a process can succeed. Updates retain a history copy; tool deletions move records to trash. Concurrent saves by an external editor still have filesystem races: search again before replacing a note.

**Automatic records:** after each parent task turn in the selected project, the plugin writes `journal/*.md` using the request excerpt, final text reply, completion status, tool-name counts and source identifiers. It makes no summarization request and stores no internal reasoning, tool arguments or complete tool outputs. Completed, failed and aborted turns are distinguished. Completion means only that the turn ended normally; every journal is marked as not independently verified. Repeated end events do not create duplicates, and subagents do not create duplicate journals. Final replies are limited to 6,000 characters and requests to 1,000 characters; recognizable credentials are redacted.

The main agent still saves verified findings to `facts/*.md` through tools. The plugin does not import all historical chats automatically; approved seed files can supply initial records. Expiration stops automatic recall without deleting files. Normal retrieval does not depend on MCP initialization or availability. The legacy fallback retains its original MCP connection failure deadline; waits are cancellable and add no model request or reasoning deadline. If both retrieval paths fail, a content-free diagnostic is recorded and the main task continues.

**Coordination:** `team_start` launches up to two independent investigations or reviews, each with a question, scope and acceptance criteria. It invokes the complete native `subagent` tool execution path, preserving permission checks, model defaults, recursion limits, cancellation and result delivery. The standard native preset uses an independent context instead of copying the entire history. User changes to that native preset are respected.

The main agent owns shared-file changes and final acceptance while subagents investigate and return concise evidence. This is a prompt-level division of work, **not a separate filesystem sandbox**; Harness still manages access. Repeating an identical `plan/key` within the same parent session returns the existing task. Changing its content while reusing the same key is an error. At most two plugin-owned tasks may remain unreleased, and subagents cannot call `team_start` recursively. Other native subagents remain under Harness management.

After finishing independent work, the parent can call `team_wait` once to await native descendants. Waiting generates no extra model requests and requires no shell sleep or polling. Cancellation releases only that wait; native task permissions and lifecycles remain unchanged. If waiting is unavailable, the agent should end the turn with an accurate pending-results status and rely on native completion notification. Instructions ask subagents to stop after their assigned acceptance criteria pass and ask the parent to avoid repeating successful checks whose inputs have not changed.

**Execution checkpoints:** after three identical visible results for the same tool arguments, or 20 work steps, the model receives a short reminder to reuse evidence, check assumptions and review outstanding acceptance criteria. Duplicate detection includes PTC calls nested in `run_code`. A changed result resets its counter; successful known write tools clear repeated samples. Identical results do not prove that the environment stayed unchanged, so reminders do not block tools.

When a step reports at least 4,000 output tokens, message-block character counts distinguish reasoning, visible text and tool arguments. If reasoning characters exceed the other two combined, a reminder asks for a concrete implementation or evidence check; one additional reminder can request convergence if this repeats. Large files or tool arguments alone do not trigger a repeated-output reminder. Character counts are not per-category tokens, internal reasoning is not copied into reminders, and necessary investigation is not classified as waste merely because it is long. Messages reporting tokens without content details receive a conservative generic reminder.

An explicit SVG creation request adds one visible, replayable workflow context before the first model request: produce a complete first version, validate its XML, inspect the whole image and tie revisions to specific failed criteria. Requested refinements, variants, animation and additional checks remain required. Ordinary explanations of SVG do not trigger this workflow. After a successful SVG write or edit, the first successful image read counts as an observation cycle. Two cycles for the same file trigger a reminder to check remaining requirements, even when file and image outputs keep changing. Repeated detail views do not add cycles. Files are tracked separately, up to eight at once. Association with the most recently edited SVG is heuristic: it cannot prove the image depicts that file, classify a revision as unnecessary or end a task. Independent native review is suggested only for a concrete acceptance question; simple work is not forcibly split.

Each turn permits at most three diagnostic reminders. The SVG workflow context has a separate limit of one per new creation request. Both use the native session log, and replay does not repeat the same diagnostic reminder. QQ listener waits, user questions and background waits do not participate in duplicate detection. Wait-only steps do not advance work checkpoints. Thresholds are reminder conditions: **they do not truncate output, terminate tasks or impose execution deadlines**. Reminders take effect on the next request after a completed step, so they cannot shorten reasoning already in progress. Prompts encourage validated templates or scripts for long formulas and repeated code, while preserving full text when explicitly requested. Any reduction in steps or output depends on the model following the guidance.

**Timing diagnostics:** `workflow_status` reports the current or latest turn's model phase, tool windows, approvals, questions, background work, intentional waiting, output quantity and transport retries. It also reports reasoning/text/tool-argument character counts and anonymous SVG edit/view cycle counts. These contain no original text and are not per-category tokens. Concurrent intervals within a category are merged, while different categories may overlap and must not be added together. Model phases include preparation, first-output waiting and retries, so **they cannot establish generation speed or TTFT**. The plugin does not change proxy settings, permissions, retry policy or the main model effort.

`team_wait` is background waiting. A clearly identifiable shell `sleep NUMBER`, optionally followed by a literal `echo`, is intentional waiting and does not advance work steps. Scripts containing other commands, substitutions or pipelines remain ordinary tools to avoid reporting actual work as waiting.

## Installation

This is an experimental prerelease. Check the version and SHA-256 on the [release page](https://github.com/ytsu-ki/dsh-memory-team/releases/tag/v0.5.3-beta.3) and install into a separate test profile. Use the Git tag below or an absolute path to a downloaded `.tgz`. See [Windows acceptance](docs/windows-acceptance.md).

1. Open **Plugins > Add plugin** in Harness.
2. Enter `https://github.com/ytsu-ki/dsh-memory-team.git#v0.5.3-beta.3`, or the absolute path to the package, and install.
3. Enable **Project Memory and Teams** and confirm its component is running.

CLI users can run:

```sh
dsh plugin --profile desktop add 'https://github.com/ytsu-ki/dsh-memory-team.git#v0.5.3-beta.3'
```

Replace `desktop` with the actual profile. Default local SQLite memory and subagent coordination require no Obsidian installation. Markdown knowledge, Basic Memory and credential scanning are optional integrations described below.

Existing `dsh-stream-guard` users should disable or uninstall the older package through the plugin manager first. Its original `dsh-stream-guard-0.1.0.tgz` can restore that earlier approach. Do not edit profile package manifests or lockfiles manually. Directory installations are links, so later repository edits affect the installation source; packaged installations retain a fixed version. Restart Harness when its update prompt asks you to do so.

### Basic Memory and Obsidian

Use Python 3.12+ and install official Basic Memory into its own environment, without modifying upstream code:

```sh
python3 -m venv ~/.local/share/dsh-memory-team/basic-memory
~/.local/share/dsh-memory-team/basic-memory/bin/python -m pip install 'basic-memory==0.23.2'
node scripts/setup-knowledge.mjs \
  --vault '/absolute/path/to/Obsidian Vault/DSH Knowledge' \
  --project '/absolute/path/to/project' \
  --command '/absolute/path/to/basic-memory/bin/basic-memory' \
  --config-dir '/absolute/path/to/basic-memory-config'
```

`scripts/basic-memory-macos-arm64.txt` records verified Python 3.12 / macOS arm64 dependency versions. On that platform, `pip install -r scripts/basic-memory-macos-arm64.txt` avoids environment drift from dependency updates. Validate other platforms separately after using the basic installation above.

The setup script creates dedicated Basic Memory configuration and local `~/.local/share/dsh-memory-team/settings.json`; reload the plugin to apply it. Pass the Git root as `--project`, or the task working directory when no repository exists. Open the containing vault in Obsidian; no Obsidian plugin is required. Preserve YAML source/project fields and edit the body directly. Basic Memory watches file changes and indexes added search terms. Generated token sections are not automatically rewritten after external edits; add short terms to the **Search terms** section when needed. Existing note headings remain readable, and existing knowledge files are not translated or overwritten.

An optional `--seed-file /absolute/path/to/notes.json` accepts `[ [key, title, kind, summary, evidence], ... ]`. Import only approved material; existing keys are not overwritten. Keep personal seed files in ignored `.local/` so they do not enter releases. `--no-activate` prepares directories and configuration without changing active plugin settings.

After importing initial notes, warm the complete index with the official command before starting Harness / Basic Memory MCP. It also repairs a derived index after interrupted initial indexing without deleting Markdown:

```sh
BASIC_MEMORY_CONFIG_DIR='/absolute/path/to/basic-memory-config' \
BASIC_MEMORY_FORCE_LOCAL=true \
  '/absolute/path/to/basic-memory/bin/basic-memory' reindex --search --full --project dsh-knowledge
```

Upstream [Basic Memory](https://github.com/basicmachines-co/basic-memory) is AGPL-3.0-or-later; this project's MIT license covers only this project's code. Users install and run Basic Memory independently; it is not copied into the npm package. Obsidian is an optional existing editor, not an open-source dependency of this project.

### Local credential scanning

```sh
node scripts/setup-retrieval.mjs
```

The script downloads pinned Betterleaks 1.9.0 from its official GitHub release, verifies the built-in SHA-256, installs it under `~/.local/share/dsh-memory-team/betterleaks/1.9.0/`, and backs up and merges local settings. macOS/Linux arm64/x64 are supported; real acceptance has been performed on macOS arm64. `--archive /absolute/release.tar.gz` installs the same verified version offline; `--no-activate` prepares the executable only. Reload the plugin to apply settings. No DSH account, model or proxy changes are needed.

Rebuildable snapshots live in `recall-index/` under the Basic Memory configuration directory. They use POSIX mode 0600 and inherited Windows ACLs. They do not rewrite source Markdown; corrupt snapshots are rebuilt. Changes to program or rule fingerprints invalidate older snapshots. Betterleaks is MIT, Orama is Apache-2.0 and Chokidar is MIT. Users independently install Basic Memory under its AGPL license.

## Usage

Normally, give Harness a task. The plugin supplies retrieval and coordination guidance; the model still decides whether to save evidence or delegate work. Simple tasks need not be split. You can also ask explicitly:

> Search this project's memory first. Assign implementation investigation and acceptance-method review to two independent subagents, and handle the fix yourself. After verification, save the conclusion and failed approaches.

| Tool | Purpose |
| --- | --- |
| `project_memory_search` | Search the current project; an empty query lists recent records; `include_stale: true` includes invalidated records |
| `project_memory_save` | Save a fact, workflow or pitfall; `evidence` and a `files` array are required |
| `project_memory_forget` | Remove an unnecessary record by key and current revision |
| `project_memory_status` | Inspect the actual backend, Markdown folder and service readiness |
| `team_start` | Launch independent investigations in a batch; stable plan/task keys prevent duplicate dispatch |
| `team_wait` | After independent work, wait for native descendants without sleep or polling; cancellable |
| `workflow_status` | Inspect steps, output, retries and waiting in the current or latest turn; call only when diagnostics are needed |

Example memory arguments, not an already verified project conclusion:

```json
{
  "key": "viewport-acceptance",
  "title": "Prerequisites for 1440px acceptance",
  "kind": "pitfall",
  "summary": "Close overlays before checking button clickability. Use hit testing to assess layout only when the interface is unobstructed.",
  "evidence": "Replace this with actual observations and test results.",
  "files": ["tests/layout.test.js"]
}
```

Omit `expected_revision` on creation. Before updating, search and supply the returned current revision. `files` accepts up to six ordinary files inside the current project, each no larger than 1 MiB. Only paths and hashes are stored, not file contents. Observations with no file association can use `[]`; their validity is bounded by expiry and the evidence description.

Example coordination arguments:

```json
{
  "plan": "viewport-check",
  "tasks": [
    {"key": "layout", "question": "Find the cause of layout overflow at 1440px.", "scope": "Read src/layout only.", "acceptance": "Provide relevant line numbers, the cause and a minimal fix."},
    {"key": "assertions", "question": "Review the 1440px acceptance script for false results.", "scope": "Read tests/layout only.", "acceptance": "Provide evidence and checks that distinguish the suspected causes."}
  ]
}
```

Harness delivers native completion notifications. Use `team_wait` when only results remain. Correct a task with the existing `send_message` tool or stop it with `interrupt_agent`; do not create it again. If some launches fail, `team_start` reports started / existing / failed per task and leaves already started work running.

Omitting `reasoning_effort` inherits native settings. Parameters are derived from the native `subagent` tool actually visible to the current agent. Optional `reasoning_effort: "low"` or `"high"` appears only when Harness already permits that session to select child model settings. Otherwise the field is hidden and inheritance is explained. Native function calls and the PTC SDK use the same schema, isolated per session. Unloading or restricting the native capability updates the next schema. Older sessions and manual calls still get an explicit error if they supply a now-disallowed field; the plugin never silently changes effort or enables permission to select it. `low` suits bounded investigation or mechanical checks; complex diagnosis normally inherits. Changing a dispatched task's effort also changes its content and cannot reuse the same `plan/key`.

## Storage and configuration

The database defaults to `$DSH_PROFILE_DIR/data/dsh-memory-team.sqlite`, then `$DSH_HOME/data/` without a profile, then `~/.dsh/data/`. It is local plaintext. POSIX mode is 0600; Windows access depends on inherited ACLs, so `stat().mode` cannot establish owner-only access. The plugin does not rewrite Windows ACLs and reports `windows-acl-inherited-unverified`. Use `node scripts/inspect-windows-acl.mjs '/absolute/database/path'` to inspect entries read-only; this is not a complete effective-permissions audit. Markdown, derived snapshots, history and trash need equivalent platform-specific checks. Uninstalling keeps the database for reinstallation, removes tools and prompt contributions, and stops pending dispatch without terminating subagents already handed to Harness.

`project_memory_status` exposes the loaded `plugin_version`, `loaded_at`, `runtime.node/uv/pid`, `database`, `scope.source` (`git` / `cwd` / `explicit`), scope warnings and permission model. Markdown indexes also expose `index.watcher`, `index.watcher_error`, `index.last_reconciled_at`, batch/overflow counts and `index.degraded` to distinguish no hits, wrong scopes and degraded observation. `knowledgeProject` selects only the Markdown backend; it does not redefine the project root. Use `projectRoot` for explicit project identity.

**Local storage does not mean content never leaves the machine.** Recalled excerpts are sent to the current model service with normal requests. Source Markdown, history and trash remain local plaintext and existing files are not automatically rewritten. YAML `dsh_private: true` excludes an entire note from plugin recall and derived snapshots, including `include_stale: true`. It does not restrict direct file reads, Basic Memory's own tools or other plugins.

Optional Betterleaks 1.9.0 scanning redacts recognizable credentials before saving findings, capturing turns or returning recall. Rules and version are pinned and online validation is disabled. Existing rejection of obvious credentials on manual saves remains. Capture scans before truncating, so cutting a credential cannot bypass detection. Scanner errors reveal neither original text nor reports, withhold the affected memory write/recall, and let the main task continue. Scans are cancellable, with a five-second local service limit and ten-second version probe; these do not limit model or subagent reasoning. Without a scanner, built-in legacy rules remain and status is `builtin-only`.

Credential detection has false positives and false negatives. It does not cover all personal information, encoded credentials or complete chat transmission. It does not scan original model requests or other tools' outputs and does not clean existing logs. The scanner receives only necessary environment variables, has validation explicitly disabled and is isolated from project scanner configuration. Account tokens and proxy settings are not passed to it.

Configure these fields through plugin settings:

| Setting | Default | Range / meaning |
| --- | --- | --- |
| `database` | Automatic | A custom path must be absolute |
| `projectRoot` | Automatic | Optional absolute root; combines only itself and descendants; does not migrate old records |
| `knowledgeRoot` | Unset | Absolute Markdown directory indexed by Basic Memory; an explicit empty string disables it |
| `basicMemoryCommand` | basic-memory | Local executable; an absolute path is recommended for a separate environment |
| `basicMemoryConfig` | Data directory/basic-memory | Absolute path to dedicated Basic Memory configuration |
| `knowledgeProject` | Unrestricted | Canonical root of the selected project; other projects retain SQLite |
| `incrementalIndex` | true | Orama incremental retrieval; false restores MCP/Markdown retrieval without migrating source data |
| `betterleaksCommand` | Unset | Absolute path to pinned Betterleaks; failure after configuration withholds the affected memory transfer |
| `ttlDays` | 30 | 1-365 days; expired records stop automatic recall |
| `recallLimit` | 3 | Effective maximum is three; legacy values 4-6 are accepted but still capped at three |
| `recallChars` | 6000 | Automatic context limit, 1,000-12,000 characters |
| `maxWorkers` | 2 | One or two plugin-owned tasks |
| `repeatThreshold` | 3 | Reminder after 2-10 identical requests/results; SVG review also triggers after two edit/view cycles |
| `checkpointSteps` | 20 | Reminder every 10-100 work steps; wait-only steps do not count |
| `longOutputTokens` | 4000 | Classification threshold for reported step output, 1,000-32,000 tokens; necessary tool arguments alone do not trigger it |

Each new user input records bounded current retrieval results, including no-hit notices, and states that they replace earlier retrieval. Context enters native `user/message` logs through `agent/pre-step` and is replayable. Frozen model requests are not rewritten and no custom session event type is introduced. Retrieval errors record a content-free diagnostic and continue the task; tool read/write errors remain visible rather than pretending to succeed.

## Verification and development

Windows observes both small and large projects with native recursion and an additional nonrecursive parent watcher for root renames and recreation. The parent observation survives a temporarily missing project directory and is closed on unload. Event queues are bounded and continue flushing during sustained notifications. File signatures are checked before and after reading, and obsolete handles close after root deletion or replacement. Each watcher registration schedules metadata reconciliation to cover its registration gap. External changes and metadata reconciliation share a 100ms stable-write check; completed plugin saves still refresh immediately. Failed watchers on the same directory have a retry backoff, and metadata reconciliation continues every 60 seconds. New external edits may be delayed in `metadata-only` mode. See the Windows acceptance document for the remaining boundaries.

Maintainers use `pnpm release:prepare` to build the TGZ/source ZIP pair and verify runtime resources and file consistency. This development command needs Python 3 standard libraries; it adds no Python requirement to plugin runtime. `secret_scanner_error` distinguishes missing executables, unsupported versions, unreadable programs and unavailable rules.

Node.js 22.17+ and pnpm 11.25.0:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm check
pnpm test
pnpm pack

# Optional real-service acceptance in temporary directories; no paid model API calls
BASIC_MEMORY_TEST_COMMAND='/absolute/path/to/basic-memory' \
BETTERLEAKS_TEST_COMMAND='/absolute/path/to/betterleaks' node --test test/*.test.js
```

Tests cover SQLite persistence, English/Unicode retrieval, project isolation, evidence invalidation, concurrent revision conflicts, input limits, persisted context, tool unload, nested parallel calls, native permission checks, deduplicated dispatch, merged wait intervals, checkpoint replay and real subagent lifecycles. Coordination tests use official Cordis / AgentLoop / Subagent / JSONL persistence components with a simulated model and demonstrate overlapping child tasks with results delivered to the parent. Agent-loop tests verify that duplicate reminders appear once and work continues. No paid API calls are made. Legacy guard regression tests remain.

On macOS, lifecycle tests require Node.js that can load npm native extensions. Some application-bundled signed runtimes reject test extensions with a different Team ID. Use a normal development Node.js build; no system security changes are required. The plugin itself uses Node's built-in SQLite and does not depend on that test extension.

GitHub Actions is configured for Windows / Ubuntu / macOS and Node.js 22 / 24, including Windows 22.17.0 and 24.18.0. One packaging job builds the candidate pair, each matrix job installs and tests the extracted source ZIP, and a separate consumer installs the TGZ for a fresh-process check. Configuration alone is not evidence that a particular commit passed. Windows tests read actual SQLite, snapshot and directory ACLs through Node and fixed PowerShell/.NET queries, including a disposable Low-integrity source path. Directory escape tests use Windows junctions; unavailable file-symlink creation is explicitly skipped without skipping parent traversal or directory-link checks. Real Basic Memory / Betterleaks tests require explicitly configured executables. Release assets contain only project code, installation/diagnostic scripts, English locale metadata, defaults, icon, README, documentation and license. Dependencies, local databases, seeds, reports, chat history and unrelated `outputs/` files are excluded.

These changes improve task organization and reuse of evidence; they do not remove model service or proxy transport failures. Parallel work can increase total tokens and simultaneous requests. Measure speed with comparable live tasks rather than inferring a percentage from local mock tests.
