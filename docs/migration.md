# Migration and rollback: dsh-memory-team 0.5.x to dsh-relink 0.6.0-beta.2

The plugin is displayed as **dsh-relink** in English and **鱼的记忆** in Chinese. The package name and plugin id remain `dsh-relink`.

0.6.0-beta.2 reads 0.5.x data in place. Canonical data is not converted, renamed or rewritten, so upgrading is a reinstall and rolling back is a reinstall of the earlier package. Only derived index files change format, and both versions rebuild what they need.

## The rename

From 0.6.0-beta.1 the package and plugin are named **dsh-relink** (formerly **dsh-memory-team**), and the repository moves to `github.com/ytsu-ki/dsh-relink`; GitHub redirects the old URLs.

| Changed | Unchanged |
| --- | --- |
| npm package name and Harness bundle name: `dsh-relink` | Local settings file `~/.local/share/dsh-memory-team/settings.json` |
| Plugin id in profile patches: `id: dsh-relink` | Default database `data/dsh-memory-team.sqlite` and the state directory |
| Legacy guard import: `dsh-relink/legacy-stream-guard` | Vault layout, note format, history and trash |
| System prompt section names and log prefix | Recall message source tag and session projection keys stored in session logs |
| Release files: `dsh-relink-0.6.0-beta.2.tgz` and `-source.zip` | Tool names and arguments |

Harness treats the renamed package as a different plugin. **Remove `dsh-memory-team` from the profile before installing `dsh-relink`.** Both register the same session projection, so if both stay enabled, whichever loads second fails to activate (the host keeps running; the failure appears in its plugin diagnostics). This was verified by loading both into one Cordis context in either order, and in the real desktop runtime (0.2.1-rc.3, macOS arm64) with both packages installed: the host printed `1 entry did not activate`, kept the other plugin active and finished the task normally. A profile patch entry with `id: dsh-memory-team` no longer configures anything; rename it to `id: dsh-relink`.

## Data map

| Data | Location | 0.5.x | 0.6.0-beta.2 | Action |
| --- | --- | --- | --- | --- |
| SQLite records | `database` (default `$DSH_PROFILE_DIR/data/dsh-memory-team.sqlite`) | schema `user_version` 1 | same schema, same `memory_fts` token format | none |
| Markdown notes | `<knowledgeRoot>/projects/<name>-<hash>/facts/*.md`, `journal/*.md` | frontmatter `dsh_*` fields | same layout and fields; earlier section headings still read | none; never rewritten |
| History and trash | `<basicMemoryConfig>/history`, `/trash` | write-once copies | same | none |
| Derived index | `<basicMemoryConfig>/recall-index/` | `<hash>.json` Orama snapshot | `<hash>.sqlite` catalog (signatures, metadata, term strings) | optional cleanup, see below |
| Write locks | `<basicMemoryConfig>/locks/` | none | short-lived lock files | none |
| Basic Memory | separate Python process | started by the plugin when a vault was configured | never started by the plugin | run Basic Memory yourself only if you use its own tools |
| Local settings | `~/.local/share/dsh-memory-team/settings.json` | read at activation; invalid JSON blocked activation | read on first memory use; invalid JSON disables memory with `CONFIGURATION_ERROR` | none |
| Session state | native session log | efficiency projection version 2 | efficiency projection version 3, recall projection version 1 | none; the host refolds projections from the log when a version differs |

`basicMemoryConfig` keeps its historical name: it is the plugin state directory for history, trash, locks and derived catalogs, whether or not Basic Memory is used.

## Contract changes

| Surface | Change | Compatible? |
| --- | --- | --- |
| `project_memory_search` | Adds `status` (`ok`, `no-match`, `degraded`, `withheld`, `unavailable`) and `diagnostics`. Records gain `status`; Markdown records split `summary` and `evidence` from the note sections instead of returning the whole body. | Additive. |
| `project_memory_status` | `backend` is `markdown` (was `basic-memory`) or `sqlite` (was `legacy-sqlite`); the Basic Memory `service` field is replaced by a `basic_memory` note; adds `health`, `health_diagnostics`, `configuration`, catalog counts and the last reconciliation. | Values changed; diagnostic only. |
| `project_memory_save` / `forget` | Same arguments and revision semantics. A concurrent create now reports a revision conflict instead of a raw `EEXIST`. Plugin writers in different processes are serialized by a lock file. | Same contract. |
| `team_start` | Same arguments. Capacity counts only running plugin-owned children. Worker prompts ask for an Answer / Evidence / Checks / Uncertainty / Next report. | Same contract. |
| `team_wait` | Adds `joined` and `tasks` (plan, key, subagent id, state). | Additive. |
| `workflow_status` | Adds `time_ms`, an exclusive partition of wall time; `intervals_ms` is unchanged. | Additive. |
| Automatic recall | Labelled sections for verified findings and unverified task history; an unchanged recall in the same session is a one-line pointer; a repeated no-match adds nothing; degraded, withheld and unavailable memory get a short notice. | Text format only. |
| Relevance | One shared model for both backends with document-frequency weighting and stop words. Fewer unrelated records are recalled. | Behavioural; see `docs/benchmarks.md`. |
| `legacy-stream-guard` export | Same path and behaviour; logs a deprecation warning. Removal planned for 0.7.0. | Same contract. |

## Upgrade

1. Use a separate test profile first and back up the profile directory, the SQLite database, the vault and the state directory.
2. Inspect what exists. This reads only:

   ```sh
   node scripts/migrate.mjs
   ```

   Pass `--database`, `--vault` and `--state-dir` when they differ from the defaults. The report lists record counts, the SQLite schema version, note counts and derived files.
3. Remove `dsh-memory-team` from the profile through the plugin manager, then install 0.6.0-beta.2 through the plugin manager or `dsh plugin --profile <test-profile> add /absolute/path/dsh-relink-0.6.0-beta.2.tgz`, and restart Harness when prompted. Rename any `id: dsh-memory-team` entry in the profile patch to `id: dsh-relink`.
4. Call `project_memory_status`: check `plugin_version`, `backend`, `health` (`ok` or `no-match`) and that `configuration.problems` is empty.
5. Optional, once you no longer plan to roll back, remove the obsolete 0.5.x snapshots:

   ```sh
   node scripts/migrate.mjs --remove-legacy-snapshots
   ```

The first Markdown search after the upgrade reads each project note once to build the catalog; later searches read only changed notes.

## Rollback

1. Remove `dsh-relink` from the profile, reinstall `dsh-memory-team` 0.5.3-beta.3 (`https://github.com/ytsu-ki/dsh-relink.git#v0.5.3-beta.3` or its package) and restart. Rename a profile patch entry `id: dsh-relink` back to `id: dsh-memory-team`.
2. Nothing needs converting. 0.5.3-beta.3 reads the same database (the FTS rows written by 0.6 use the 0.5.x token format) and the same notes, and rebuilds or reconciles its own snapshot. It ignores 0.6 catalogs; remove them with `node scripts/migrate.mjs --remove-catalogs` if you want.
3. 0.5.3-beta.3 starts Basic Memory again when a vault and `basicMemoryCommand` are configured.

## Verification

`test/migration.test.js` checks:

- a database created with the exact 0.5.x schema and rows is searched and updated in place, keeps `user_version` 1, and its new rows are found by the 0.5.x query form;
- 0.5.x notes (including earlier headings), journals and an Orama snapshot are read and left byte-identical;
- recall messages persisted by 0.5.x sessions are superseded, and compaction resets recall tracking;
- the migration helper reports data and deletes only the derived files it is asked to; removed catalogs are rebuilt;
- with `DSH_RELINK_BASELINE_ENTRY` pointing at a 0.5.3-beta.3 checkout, a real round trip: 0.6 writes SQLite and Markdown records, 0.5.3-beta.3 reads and updates them and writes a new note, and 0.6 reads those writes.

```sh
git worktree add .local/baseline-src v0.5.3-beta.3   # or the baseline tag of this repository
(cd .local/baseline-src && pnpm install --frozen-lockfile --ignore-scripts)
DSH_RELINK_BASELINE_ENTRY="$PWD/.local/baseline-src/lib/memory-team.js" node --test test/migration.test.js
```
