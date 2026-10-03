# Sequential dark factory

Runs fresh agents through the canonical tmux subagent transport. Each named task has its own lock. Sequential planner/worker lanes can run concurrently with fixed-assignment read-only lanes. YC's video lane, profile writer and three forest-reader lanes share a three-agent admission budget. Readers produce isolated per-tree packets; only the profile lane writes/reconciles traits, so parallel reading does not create competing profile writers.

```sh
cd ~/.pi/agent
node extensions/dark-factory/run.mjs smoke bf2 --wait
node extensions/dark-factory/run.mjs start bf2
node extensions/dark-factory/run.mjs start yc
node extensions/dark-factory/run.mjs status yc
node extensions/dark-factory/run.mjs suite-status
node extensions/dark-factory/run.mjs stop yc
node extensions/dark-factory/run.mjs recover yc
node extensions/dark-factory/run.mjs resume yc
```

Omitting the task defaults to `bf2` for backward compatibility. BF2 retains the legacy `factory-runs/LOCK`; other tasks use `factory-runs/<task>/LOCK`. Runs and evidence live in `factory-runs/` and are ignored by Git.

Advancement requires a structured task outcome, readable JSON report, durable receipt, and closed worker session before the successor launches. At the shared 80% friendly stop, an unfinished `continue` report hands the same role and assignment to a fresh agent with the saved progress. The controller verifies the exact attempt's friendly-stop event on the monitor-selected session branch; it does not infer continuation from prose, credit unfinished work, or treat an ordinary blocker as progress. Legacy friendly-stop `blocked` reports are supported. `stop` is graceful: the active agent finishes and reports, then no successor launches. Escape and provider/network turn failures pause the same factory attempt with its report contract still active; use Continue in that same Pi pane after fixing the complication. A process/pane crash cannot preserve an interactive turn and falls back to retained-evidence recovery. A crash retains only that task's lock. `stop`/`recover` release it only after metadata proves no matching controller or worker session remains; an orphan report is never credited without a successful durable task receipt. `resume` continues a graceful stop or verified context checkpoint, or archives a failed attempt and reruns the same planner step or a worker's verified preceding assignment; it refuses active factories. Context handoffs retain the original reports, assignment and role while reserving a fresh report path. After an operator resolves a genuine blocker, `resume <task> --retry-blocked` explicitly retries from its durable report; blockers are never blindly retried by the controller. For a model change, update the retained run's `config.json` route and contract, gracefully stop the current controller, then resume. Never delete an ambiguous lock manually.

`suite-status` reports separate video/profile/reader states and exact inventoried, read and merged tree counts. Overall `ready_for_interview` requires `video_ready`, `profile_ready`, all reader lanes complete, the exact inventoried population accounted for, and every tree reconciled. Agent settlement and `finished.ok` alone do not mean task completion; `finished.completed` and the validated terminal state distinguish them. The suite watcher emits completion or a specific attention-needed state, without pane polling or model requests. Native filesystem events are backed by a one-second local durable-state recheck because macOS can lose/coalesce watcher events.

The loop stops at its task-specific human boundary, `blocked`, an invalid report/receipt, repeated assignment, explicit `STOP`, or technical failure. Real attempts have no factory wall-clock deadline. It never treats pane exit, prose, process survival, or completed decomposition as project success.
