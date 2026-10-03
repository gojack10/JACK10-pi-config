# Sequential dark factory

Runs one fresh planner and one fresh worker at a time through the canonical tmux subagent transport. Each named task has its own lock, so independent factories may run concurrently while every task remains sequential internally.

```sh
cd ~/.pi/agent
node extensions/dark-factory/run.mjs smoke bf2 --wait
node extensions/dark-factory/run.mjs start bf2
node extensions/dark-factory/run.mjs start yc
node extensions/dark-factory/run.mjs status yc
node extensions/dark-factory/run.mjs stop yc
node extensions/dark-factory/run.mjs recover yc
node extensions/dark-factory/run.mjs resume yc
```

Omitting the task defaults to `bf2` for backward compatibility. BF2 retains the legacy `factory-runs/LOCK`; other tasks use `factory-runs/<task>/LOCK`. Runs and evidence live in `factory-runs/` and are ignored by Git.

Advancement requires a structured task outcome, readable JSON report, durable receipt, and closed worker session before the successor launches. `stop` is graceful: the active agent finishes and reports, then no successor launches. Escape and provider/network turn failures pause the same factory attempt with its report contract still active; use Continue in that same Pi pane after fixing the complication. A process/pane crash cannot preserve an interactive turn and falls back to retained-evidence recovery. A crash retains only that task's lock. `stop`/`recover` release it only after metadata proves no matching controller or worker session remains; an orphan report is never credited without a successful durable task receipt. `resume` continues a graceful stop from its last verified checkpoint, or archives a failed attempt and reruns the same planner step or a worker's verified preceding assignment; it refuses active factories. For a model change, update the retained run's `config.json` route and contract, gracefully stop the current controller, then resume. Never delete an ambiguous lock manually.

The loop stops at its task-specific human boundary, `blocked`, an invalid report/receipt, repeated assignment, explicit `STOP`, or technical failure. Real attempts have no factory wall-clock deadline. It never treats pane exit, prose, process survival, or completed decomposition as project success.
