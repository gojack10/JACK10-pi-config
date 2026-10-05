# Sequential dark factory

Runs fresh agents through the canonical tmux subagent transport. Each named task has its own lock. Sequential planner/worker lanes can run concurrently with fixed-assignment read-only lanes. Lanes share one bounded admission budget. Readers produce isolated per-tree packets and only one lane writes/reconciles them, so parallel reading never creates competing writers.

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

Advancement requires a structured task outcome, readable JSON report, durable receipt, and closed worker session before the successor launches. At the shared 80% friendly stop, an unfinished `continue` report hands the same role and assignment to a fresh agent with the saved progress. A settled, identity-verified `continue` report explicitly requests a fresh-agent handoff even before the automatic context threshold. It never credits unfinished work. Legacy `blocked` reports count as continuation only with the exact attempt's friendly-stop event on the monitor-selected branch; ordinary blockers remain terminal. `stop` is graceful: the active agent finishes and reports, then no successor launches. Escape pauses the same factory attempt with its report contract still active; use Continue in that same Pi pane only under operator authorization. BF2's worker guard automatically continues provider-error generations at most twice per attempt, preserving the session, report and spent work; its durable retry count survives reload. It never overrides typed interruptions (human cancel, context, maintenance or lifecycle), a STOP marker, pending work/messages, a declared outcome or an inactive contract. Exhausted retries pause for manual recovery. Newly launched workers load this guard; an already-idle older worker can be continued manually without resetting its attempt. A process/pane crash cannot preserve an interactive turn and falls back to retained-evidence recovery. A crash retains only that task's lock. `stop`/`recover` release it only after metadata proves no matching controller or worker session remains; an orphan report is not itself credited as a completed attempt. In lean YC mode it is trusted as the next worker's saved progress, without an intervening planner audit. `resume` continues a graceful stop or verified context checkpoint, or archives a failed attempt and reruns the same planner step or a worker's verified preceding assignment; it refuses active factories. Context handoffs retain the original reports, assignment and role while reserving a fresh report path. After an operator resolves a genuine blocker, `resume <task> --retry-blocked` explicitly retries from its durable report; blockers are never blindly retried by the controller. For a model change, update the retained run's `config.json` route and contract, gracefully stop the current controller, then resume. Never delete an ambiguous lock manually.

`suite-status` reports separate video/profile/reader states and exact inventoried, read, excluded and merged counts. Reader projects may explicitly enable `excludeUnreadable` with operator authorization: documented AI read denials return `excluded`, advance the lane and remain in `excluded-trees.json`, never in read/merge counts. Other failures remain blockers. Overall `ready_for_interview` requires `video_ready`, `profile_ready`, all reader lanes complete, the exact inventoried population accounted for by reads or exclusions without overlap, and every read tree reconciled. Agent settlement and `finished.ok` alone do not mean task completion; `finished.completed` and the content-complete terminal state distinguish them. The suite watcher emits completion or a specific attention-needed state, without pane polling or model requests. Native filesystem events are backed by a one-second local durable-state recheck because macOS can lose/coalesce watcher events.

The loop stops at its task-specific human boundary, `blocked`, an invalid report/receipt, repeated assignment, explicit `STOP`, or technical failure. Real attempts have no factory wall-clock deadline. It never treats pane exit, prose, process survival, or completed decomposition as project success.

## Parallel factory

`parallel-run.mjs` runs the Parallel Execution Contract (SiftText `d96507db`) beside the sequential lanes; it imports but never changes the sequential lane modules. A deterministic controller (no model turns) owns seats, the event queue, launches, report validation and friendly-stop handoffs. Dispatchers and workers get pointer-only prompts; their instructions live in the Dispatcher Role and Worker Role nodes.

```sh
cd ~/.pi/agent
node extensions/dark-factory/parallel-run.mjs start-parallel --run <RUN node> [--config overrides.json]
node extensions/dark-factory/parallel-run.mjs status [--run <RUN node>]
node extensions/dark-factory/parallel-run.mjs wake [--run <RUN node>] [--note text]
node extensions/dark-factory/parallel-run.mjs stop [--run <RUN node>] [--now]
node extensions/dark-factory/parallel-run.mjs resume [--run <RUN node>]
```

`start-parallel` reads the RUN node's `OWNER:` line (first node UUID) and `Read-only repository:` paths, refuses to start if a read-only repository is dirty, and records its HEAD. Without `--run`, other commands act on the most recent run. State lives in `factory-runs/parallel/<timestamp>-<run8>/`: `config.json`, `state.json` (seats, tasks, pending events, dispatcher), `history.jsonl` (every launch, finish, rest, event and fence check), `attempts/<n>-<kind>-<seat>/` (mission, events/state snapshots, report) and `artifacts/<task>/` (the ARTIFACTS directory a worker receives). tmux sessions are `pf-<run8>-ctl-*` (controller), `pf-<run8>-dispatch-<n>` and `pf-<run8>-<seat>-<n>-*`.

- **Seats.** One OSS seat (`local/qwen3.8-flash-next` xhigh) and up to three Codex seats (`openai-codex-personal/gpt-6.1-sol` high), filled in that order. Overrides: `routes.{oss,codex,fallback}`, `seat_routes.<seat>`, `codex_seats`, `claude.{model,effort}`.
- **Dispatcher.** New runs default to a fresh Pi dispatcher on `openai-codex-personal/gpt-6.1-sol` high, using the existing fallback transport on every wake; no Claude requests. Override its route with `routes.fallback`. Saved runs select it with `dispatcher.engine: "fallback"` in `config.json` (stop the controller before editing). Old configs without an engine retain their original Claude-first behavior. To opt back into Claude on a new run, set `dispatcher_engine: "claude"` in overrides. In Claude-first mode: interactive `claude` (`claude-opus-5-5[1m]`, `--effort xhigh`, `--dangerously-skip-permissions`) in its own tmux session, started from the pre-trusted, empty `factory-runs/parallel/claude-dispatcher` directory so no project memory loads. Its hooks come only from the run's `claude-settings.json` (`--settings`); `parallel-hook.mjs` is inert without `FACTORY_PARALLEL_ATTEMPT_DIR`. On Stop it accepts a valid report (or reminds once), and on StopFailure it records the error; the controller then closes the session. A Claude usage limit rests the Claude seat until the stated reset (else 30 minutes). Any Claude failure hands the same events to one Pi fallback dispatcher on the fallback route. Three consecutive dispatcher failures stop the run as `needs_attention`. A Claude session with no transcript activity for 30 minutes counts as failed.
- **Events.** Task finished/blocked/errored, third continue, OSS idle (once per idle period, only when no wake is already due) and `wake`. One dispatcher at a time; events arriving meanwhile are coalesced into the next fresh dispatcher. A failed dispatcher's events go back to the queue.
- **Tasks.** The controller accepts a listed task only if both its node and its write scope lie inside OWNER's subtree. It runs tasks together only when their dependencies are met and their scopes are disjoint (neither is the other or its ancestor).
- **Capacity.** A worker failing with a usage limit (`Try again in ~N min`, or 30 minutes) rests its seat. The task goes back to the queue unchanged, ahead of others. A launch that fails before any model runs, or a provider failure that outlasts Pi's own retries, is treated the same way. A task's third provider failure becomes a `task_errored` event instead, so a task that breaks providers reaches the dispatcher rather than cycling through seats.
- **Friendly stop.** `continue` requeues the same task with `PREVIOUS`, OSS first. A third continue is a dispatcher event. `stop_running` and `stop --now` type a stop request into the worker's pane.
- **Fence guard.** After every worker attempt, each read-only repository must have empty `git status --porcelain` and an unchanged HEAD. Otherwise the controller asks running workers to report and stops as `needs_attention`.
- **Terminal states.** `done`, `blocked` and `idle` (nothing can start) end the controller; `wake` restarts it. `stop` is graceful: running attempts finish and nothing new launches. `resume` restarts from `state.json` and re-adopts running workers through their durable task-outcome receipts.
- **Smoke-only faults.** `faults.seat_usage_limit: {seat, launches, minutes}` makes that seat's first launches fail with a usage-limit provider error. `faults.claude_failure: {wake}` launches that wake's Claude dispatcher on a nonexistent model.

Tests: `node --test extensions/dark-factory/parallel-*.test.ts` (offline; simulated seats and clock).
