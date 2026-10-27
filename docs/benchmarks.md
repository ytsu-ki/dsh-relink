# Benchmarks

Comparable workloads were run against the 0.5.3-beta.3 baseline and this release through the public plugin interface only (tools and automatic recall in the official agent-loop test harness), so the same code measures both. Each phase runs in a fresh Node process with a temporary `HOME`; each configuration was repeated five times. Values are **median (min-max) across the five runs**. No live model was used, so these numbers say nothing about model speed or token usage; they measure the plugin's own work.

- Machine: Apple M1, 8 cores, 8 GiB, macOS 27.0.1, Node.js 26.11.1. A developer laptop with ordinary background activity, not an isolated benchmark host.
- Code: baseline tag `baseline-0.5.3-beta.3`; new code at commit `b23116e` (the later commit `b37b8b6` changes only cancellation sharing and catalog opening).
- Variants: `baseline` (Markdown runs use a missing Basic Memory command, so only its Orama index serves recall), `baseline-basic-memory` (the real Basic Memory 0.23.2 process the baseline starts for a configured vault) and `new`.
- Stores: the 30-record labelled corpus plus routine filler notes to 200 or 2,000 notes. Markdown notes are pre-existing files, not yet indexed; SQLite records are saved through the tool.
- Reproduce: `pnpm bench` (new code only), or `node bench/run.mjs --label baseline --entry /abs/0.5.3/lib/memory-team.js --reps 5 --quality` and `node bench/report.mjs .local/bench/*.jsonl`.

Round 1 of these runs exposed a workload bias: the cold phase restored the project folder just before exiting, which the baseline's still-running watcher re-indexed while the new design waits for the next read, so "restart" measured a rebuild for one variant only. The workload now searches once after the restore for both variants; only round 2 is reported.

## Results

### Cold process: first use of an existing store

| Variant | Backend | Notes | load ms | first search ms | first turn ms | warm p50 ms | warm p95 ms |
| --- | --- | --- | --- | --- | --- | --- | --- |
| baseline | markdown | 200 | 9.1 (7.8-22.8) | 256 (242-271) | 21.1 (19-22.8) | 2.6 (2.3-3) | 4.1 (3.8-5.3) |
| baseline | markdown | 2000 | 8.3 (7.8-9.1) | 861 (848-915) | 38.3 (37.2-42.7) | 12.4 (12.1-13.7) | 26.2 (23.5-29.4) |
| baseline | sqlite | 200 | 4.3 (4.2-4.7) | 1 (0.9-1) | 8.1 (7.6-8.3) | 0.9 (0.9-0.9) | 1.4 (1.3-1.5) |
| baseline | sqlite | 2000 | 4.5 (4-4.8) | 0.9 (0.9-1.1) | 9.4 (8.7-9.7) | 0.8 (0.8-0.8) | 2.4 (2.4-2.6) |
| baseline-basic-memory | markdown | 200 | 8.7 (8.6-8.9) | 239 (238-241) | 19.6 (19.1-19.9) | 2.7 (2.6-2.8) | 4.3 (3.8-4.7) |
| baseline-basic-memory | markdown | 2000 | 8.2 (8-8.3) | 899 (862-960) | 41.1 (38.6-46.1) | 14 (12.3-14.5) | 28.3 (26.7-30) |
| new | markdown | 200 | 1.7 (1.6-1.8) | 57.7 (55.4-57.9) | 12.8 (11.9-12.9) | 3.6 (3.5-3.6) | 5.3 (5.2-5.7) |
| new | markdown | 2000 | 1.7 (1.6-1.8) | 312 (304-365) | 29.8 (24.2-82.7) | 13.6 (13.4-14.4) | 18.3 (17.8-36.3) |
| new | sqlite | 200 | 1.6 (1.6-1.7) | 2.3 (2.2-2.6) | 9.2 (9.1-10.2) | 1.6 (1.5-1.8) | 2.8 (2.8-3.4) |
| new | sqlite | 2000 | 1.6 (1.6-1.6) | 2.3 (2.3-2.5) | 9.4 (9.3-9.5) | 1.4 (1.4-1.4) | 2.5 (2.4-2.5) |

### Restart: new process on the same data

| Variant | Backend | Notes | load ms | first search ms | first turn ms |
| --- | --- | --- | --- | --- | --- |
| baseline | markdown | 200 | 8.1 (7.1-11.8) | 48.8 (45.3-68.2) | 21.6 (19.7-24.1) |
| baseline | markdown | 2000 | 7.4 (7-7.8) | 98.9 (93.9-123) | 38.5 (37.8-52.3) |
| baseline | sqlite | 200 | 4 (3.6-4.4) | 5.8 (5.5-6.5) | 8.9 (8.7-10.6) |
| baseline | sqlite | 2000 | 4.3 (3.1-4.4) | 5.9 (5.7-6.2) | 10.1 (9.7-10.1) |
| baseline-basic-memory | markdown | 200 | 7.9 (7.4-11.8) | 52.3 (47.8-66.4) | 21.4 (21-23) |
| baseline-basic-memory | markdown | 2000 | 7.3 (7.3-11.3) | 97.7 (96-105) | 39.6 (38.8-41.5) |
| new | markdown | 200 | 1.6 (1.6-1.6) | 15.9 (14.7-16.4) | 13.6 (13.4-13.7) |
| new | markdown | 2000 | 1.6 (1.6-1.9) | 32.1 (31.7-33.2) | 26 (25.4-26.4) |
| new | sqlite | 200 | 1.6 (1.6-2.3) | 8.6 (7.6-9.3) | 9.9 (9.7-10.6) |
| new | sqlite | 2000 | 1.6 (1.6-1.7) | 8.9 (7.1-9.1) | 9.7 (9.5-10.1) |

### External changes visible to the next search (ms)

| Variant | Backend | Notes | in-place edit | atomic save | added note | directory replacement (5x, median of medians) | vault restored |
| --- | --- | --- | --- | --- | --- | --- | --- |
| baseline | markdown | 200 | 310 (308-316) | 314 (309-315) | 330 (327-331) | 210 (205-219) | 202 (201-206) |
| baseline | markdown | 2000 | 230 (223-236) | 244 (242-244) | 224 (223-231) | 205 (204-221) | 201 (198-206) |
| baseline-basic-memory | markdown | 200 | 306 (304-329) | 305 (304-308) | 318 (316-320) | 206 (204-207) | 203 (201-206) |
| baseline-basic-memory | markdown | 2000 | 229 (226-233) | 243 (242-244) | 224 (223-225) | 207 (203-210) | 203 (194-206) |
| new | markdown | 200 | 107 (106-107) | 111 (107-113) | 113 (107-114) | 112 (112-113) | 2 (2-2.6) |
| new | markdown | 2000 | 117 (116-118) | 121 (120-122) | 126 (120-128) | 112 (111-112) | 2 (1.9-2.5) |

### Resources

| Variant | Backend | Notes | RSS MiB | heap MiB | child RSS MiB | idle CPU ms / 5 s | child idle CPU s | active handles while idle |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| baseline | markdown | 200 | 133 (132-134) | 53.9 (45.9-56.3) | 0 (0-0) | 4.4 (2.3-6.6) | 0 (0-0) | 3 (3-3) |
| baseline | markdown | 2000 | 256 (245-259) | 124 (90.4-130) | 0 (0-0) | 3.3 (2.1-4.7) | 0 (0-0) | 3 (3-3) |
| baseline | sqlite | 200 | 75.6 (74.7-76.4) | 31.7 (29.5-32.3) | 0 (0-0) | 3.8 (2.4-5) | 0 (0-0) | 3 (3-3) |
| baseline | sqlite | 2000 | 81.9 (81.6-83.1) | 37.2 (27.6-37.8) | 0 (0-0) | 3.5 (3.3-4.4) | 0 (0-0) | 3 (3-3) |
| baseline-basic-memory | markdown | 200 | 133 (127-134) | 59.6 (38-61.2) | 194 (190-194) | 5.1 (4.4-5.3) | 0 (0-0) | 7 (7-7) |
| baseline-basic-memory | markdown | 2000 | 252 (247-259) | 98.8 (91.3-124) | 189 (154-197) | 5.1 (4.3-5.5) | 0 (0-0) | 7 (7-7) |
| new | markdown | 200 | 75.1 (72.6-110) | 32.5 (25.2-35.3) | 0 (0-0) | 5.2 (3.4-21.5) | 0 (0-0) | 1 (1-1) |
| new | markdown | 2000 | 171 (170-173) | 27.2 (26.9-49.2) | 0 (0-0) | 4.6 (4.2-5.3) | 0 (0-0) | 1 (1-1) |
| new | sqlite | 200 | 48.1 (47.9-48.3) | 16.2 (16.2-16.4) | 0 (0-0) | 4.3 (3.3-4.9) | 0 (0-0) | 1 (1-1) |
| new | sqlite | 2000 | 56.2 (54.9-56.9) | 18.8 (18.3-21.7) | 0 (0-0) | 4.7 (3.7-4.9) | 0 (0-0) | 1 (1-1) |

### Vault moved away during a session

| Variant | Result of a search |
| --- | --- |
| baseline | {"records":0,"status":"not-reported"} |
| baseline-basic-memory | {"records":0,"status":"not-reported"} |
| new | {"records":0,"status":"unavailable"} |

### Recall quality (labelled corpus)

| Variant | Backend | Query set | Relevant queries | Hit rate | Precision | No-hit queries | False-positive rate |
| --- | --- | --- | --- | --- | --- | --- | --- |
| baseline | markdown | corpus | 50 | 1 | 0.593 | 25 | 0.48 |
| baseline | markdown | holdout | 30 | 1 | 0.705 | 15 | 0.4 |
| baseline | sqlite | corpus | 50 | 1 | 0.432 | 25 | 0.8 |
| baseline | sqlite | holdout | 30 | 1 | 0.431 | 15 | 0.8 |
| new | markdown | corpus | 50 | 1 | 0.943 | 25 | 0.04 |
| new | markdown | holdout | 30 | 1 | 0.969 | 15 | 0 |
| new | sqlite | corpus | 50 | 1 | 0.943 | 25 | 0.04 |
| new | sqlite | holdout | 30 | 1 | 0.969 | 15 | 0 |


### Real desktop runtime: headless cold starts

`test/host/desktop-acceptance.mjs` boots the installed DeepSeek Harness 0.2.1-rc.3 runtime (the Electron 44.7.0 Node-mode process the desktop app uses for plugins) with an isolated `HOME` and `DSH_HOME`, installs the packed plugin with `dsh plugin add`, disables telemetry and answers headless tasks against a local fake model. Five cold processes per variant; median (min-max).

| Variant | Backend | First model request ms | Process wall ms | Plugin install ms | Functional checks |
| --- | --- | --- | --- | --- | --- |
| no plugin | - | 525 (516-528) | 566 | - | - |
| new | sqlite | 575 (565-592) | 617 | 4,779 | tools, system prompt, status, save, recall after restart |
| new | markdown | 577 (567-602) | 623 | 5,946 | same, plus 8 journals written |
| baseline | sqlite | 625 (621-729) | 671 | 13,628 | same |
| baseline-basic-memory | markdown | 649 (643-687) | 2,698 | 12,488 | same, plus 8 journals written |

The new plugin adds about 50 ms before the first model request in a fresh host process (module loading and tool registration; services start lazily), against about 100-125 ms for the baseline. With Basic Memory configured, every baseline host process also took about two seconds longer to exit while the Python child shut down. Installation is faster because three runtime dependencies (the MCP SDK and its transitive packages, Orama and Chokidar) are gone; install time depends on the local package store and is indicative only.

## Reading the results

- **Markdown first use and restart are faster.** Building the catalog reads each note once; the baseline additionally built and serialized an Orama snapshot of every note body. After a restart, the new design reads no unchanged note and loads no snapshot.
- **External changes are visible on the next read.** About 110-125 ms is the deliberate 100 ms write-stability window for a just-modified note, not scanning cost; a note older than that is visible immediately (vault restored: about 2 ms). The baseline depended on watcher batching and stability delays (about 200-330 ms) and, while degraded, on a 60-second reconciliation timer.
- **Memory is lower.** The catalog lives on disk; the baseline kept every note body in memory and in its snapshot. A configured baseline also kept a Basic Memory process of about 190 MiB resident, which no longer exists.
- **Some searches are slower.** SQLite searches cost about 1-2 ms more because the shared relevance model counts each query term's document frequency. Small warm Markdown searches are about 1 ms slower at the median because every read rescans folder metadata (about 12 ms for 1,000 notes and 110 ms for 10,000 notes measured separately). These costs buy correct no-match decisions and freedom from watchers; they are small next to a model request but they are real.
- **Idle cost.** Over a 5-second idle window both versions used about 3-5 ms of CPU in the harness process, which is measurement noise; the difference that matters is structural. The new version keeps no watcher, timer or child process after a read (one active handle, the harness's own pipe), while the baseline kept watchers, a 60-second timer and, with Basic Memory, a child process. The `ps` sampling used for child CPU has coarse resolution and showed no measurable idle use by the Basic Memory child in these short windows.
- **Recall quality.** The corpus (`bench/fixtures/recall-corpus.mjs`, 50 relevant and 25 unrelated requests in English and Chinese) and a held-out set written before thresholds were frozen (`recall-holdout.mjs`, 30 and 15) are run against both backends. Both versions find every relevant record; the baseline also injected records into 40-80% of unrelated requests (for example "Write a short haiku about autumn leaves"). The new model returns the same results on both backends because they share one scorer. `test/relevance.test.js` fails the suite if hit rate drops below 0.95, precision below 0.9 or the false-positive rate rises above 0.1. These are synthetic corpora written for this project; precision on real project notes will differ.
- **Context size.** Plugin system-prompt text is about 2.8k characters per request (team policy about 1.5k, efficiency policy about 1.3k) instead of about 4.8k (team policy about 1.9k, efficiency policy about 2.9k) in 0.5.3-beta.3. Within a session, an unchanged recall is a one-line pointer instead of the full records again, and repeated no-match turns add nothing (`test/memory-team.test.js`). Effects on live token usage were not measured.
