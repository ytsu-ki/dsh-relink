# 0.3.0: workflow changes based on slow-session reports

Designed from a user-provided report about recent slow sessions. This repository does not contain the original sessions, statistics scripts or personal report. Its sample measurements have not been independently recomputed here and are not a model performance benchmark.

| Observed cause | Plugin response | Practical limit |
| --- | --- | --- |
| Long formulas, code and repeated explanations increase output volume | Encourage validated templates or scripts, save deliverables to files and report concise evidence; check for repetition after long output | Requested content is not truncated and generation has no deadline; savings depend on the model following the guidance |
| Repeated exploration, rereads or unchanged failing commands | Reuse verified project memory; remind after three matching requests/results and review acceptance every 20 work steps | Identical results do not prove the environment is unchanged; reminders do not block operations |
| Serial independent investigations and duplicate child tasks | Up to two native subagents with scope and acceptance criteria; stable identifiers prevent duplicate dispatch | Parallelism may increase total tokens and service load; dependent work remains sequential |
| Excessive effort for a simple child task | Permit explicit child `reasoning_effort` through already enabled native model selection; omission inherits | The main model settings are unchanged and child model selection is not enabled automatically |
| Slow tools, installs, tests and background work | Start once, keep the job ID and await native completion; batch independent reads when safe | External programs do not run faster and processes are not killed to improve a metric |
| Approval or user-answer waiting | Measure approvals and questions separately; combine necessary questions and identify the pending decision | Existing permission flows remain; no automatic allow rules are added |
| TRANSPORT retries | Count retries and suggest inspecting the connection boundary on the next successful model step instead of increasing concurrency without evidence | Proxy/provider failures are not repaired; the model cannot act on a reminder while requests still fail |
| QQ listener waiting | Measure intentional waiting separately and exclude it from duplicate detection and wait-only work checkpoints | Listener duration and wake conditions are unchanged |
| Large historical context | Retrieve bounded project memory and use the native default of independent child contexts | History is not forcibly cleared or compressed; high cache-hit rates mean shorter context may not substantially reduce time |

Since 0.6.0, `workflow_status` also reports `time_ms`, an exclusive partition of wall time (approval, question, background wait, intentional wait, tool, model, other) whose values add up to the observed wall time; the overlapping `intervals_ms` below are unchanged. Reminder texts were shortened, and the reasoning-step reminder no longer asks the model to stop comparing approaches.

## Measurement definitions

- The report's 320 steps were the total across seven turns. An abbreviated account described them as a maximum for one turn; that cannot establish single-turn behavior.
- Tool duration already includes approvals, questions and waits inside tools. Parallel work overlaps. Categories cannot be summed directly into total time.
- `workflow_status` merges each activity category's event-time intervals for the current or latest turn. It does not infer progress from chat text. `work_steps` excludes steps consisting only of wait/status tools, unlike total `steps`.
- `modelPhaseMs` runs from step start to the model message or step end. It can include retries, preparation and first-output waiting and is not net generation duration. Output uses the usage reported by committed messages; unreported output from failures is not covered.
- Reminders and summaries use tool-result fingerprints and do not copy argument/output bodies into their projection. Native Harness logs retain their existing behavior.

## Evaluating the result

Compare the same task with the same acceptance criteria before and after the change. Record completion quality, work steps, successful output tokens, repeated calls, waiting categories and transport retries separately. Count an improvement only after the complete deliverable passes its checks. Cancellation, omitted work or an unanswered approval does not demonstrate faster model generation.

Local automated tests validate mechanisms and integration with real Harness components using simulated model responses. They cannot establish a live speedup percentage. Suitable samples include bounded bulk formula edits, a known bug fix and a pair of independent investigations. Observe persistent bot listeners separately.
