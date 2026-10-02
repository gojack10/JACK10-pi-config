# BF2 dark factory

Runs one fresh local Qwen planner and one fresh local Qwen worker at a time through the canonical tmux subagent transport. Advancement requires a structured task outcome, a readable JSON report, a durable receipt, and closed tmux session before the successor launches.

```sh
cd ~/.pi/agent
node extensions/dark-factory/run.mjs smoke --wait  # two read-only agents
node extensions/dark-factory/run.mjs start         # detached overnight run
node extensions/dark-factory/run.mjs stop          # stop after active bounded attempt; also clears a proven-stale lock
node extensions/dark-factory/run.mjs recover       # clear an interrupted lock only when no factory process/session exists
```

Runs and evidence live in `factory-runs/` and are ignored by Git. `factory-runs/LOCK/run` identifies the only admitted run. A crash retains the lock deliberately. `stop`/`recover` release it only after metadata proves no factory controller or worker session remains; an orphan report is retained but never credited without a successful durable task receipt. Never delete an ambiguous lock manually.

The loop stops at `ready_for_user_test`, `blocked`, an invalid report/receipt, repeated assignment, explicit `STOP`, or a technical failure. Real attempts have no factory wall-clock deadline; foreground commands have the global 120-second limit and longer commands use tracked `bash_bg`, whose completion gates `report_outcome`. It never treats pane exit, prose, process survival, or completed decomposition as game success.
