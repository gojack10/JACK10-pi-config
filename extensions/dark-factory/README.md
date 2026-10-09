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
node extensions/dark-factory/parallel-run.mjs answer --run <RUN node> --task <TASK node> --text 'human answer'
node extensions/dark-factory/parallel-run.mjs stop [--run <RUN node>] [--now]
node extensions/dark-factory/parallel-run.mjs resume [--run <RUN node>]
```

`start-parallel` reads the RUN node's `OWNER:` line (first node UUID) and `Read-only repository:` paths, refuses to start if a read-only repository is dirty, and records its HEAD. Without `--run`, other commands act on the most recent run. State lives in `factory-runs/parallel/<timestamp>-<run8>/`: `config.json`, `state.json` (seats, tasks, pending events, dispatcher), `history.jsonl` (every launch, finish, rest, event and fence check), `attempts/<n>-<kind>-<seat>/` (mission, events/state snapshots, report) and `artifacts/<task>/` (the ARTIFACTS directory a worker receives). tmux sessions are `pf-<run8>-ctl-*` (controller), `pf-<run8>-dispatch-<n>` and `pf-<run8>-<seat>-<n>-*`.

- **Seats.** One OSS seat (`local/qwen3.8-flash-next` xhigh) and up to three Codex seats (`openai-codex-personal/gpt-6.1-sol` high), filled in that order. If RUN states that the primary is mandatory, the controller will not admit Sol-only work while OSS has no active contribution; it wakes the dispatcher instead. Overrides: `routes.{oss,codex,fallback}`, `seat_routes.<seat>`, `codex_seats`, `claude.{model,effort}`.
- **Dispatcher.** New runs default to a fresh Pi dispatcher on `openai-codex-personal/gpt-6.1-sol` high, using the existing fallback transport on every wake; no Claude requests. Override its route with `routes.fallback`. Saved runs select it with `dispatcher.engine: "fallback"` in `config.json` (stop the controller before editing). Old configs without an engine retain their original Claude-first behavior. To opt back into Claude on a new run, set `dispatcher_engine: "claude"` in overrides. In Claude-first mode: interactive `claude` (`claude-opus-5-5[1m]`, `--effort xhigh`, `--dangerously-skip-permissions`) in its own tmux session, started from the pre-trusted, empty `factory-runs/parallel/claude-dispatcher` directory so no project memory loads. Its hooks come only from the run's `claude-settings.json` (`--settings`); `parallel-hook.mjs` is inert without `FACTORY_PARALLEL_ATTEMPT_DIR`. On Stop it accepts a valid report (or reminds once), and on StopFailure it records the error; the controller then closes the session. A Claude usage limit rests the Claude seat until the stated reset (else 30 minutes). Any Claude failure hands the same events to one Pi fallback dispatcher on the fallback route. Three consecutive dispatcher failures stop the run as `needs_attention`. A Claude session with no transcript activity for 30 minutes counts as failed.
- **Events.** Task finished/blocked/errored, third continue, OSS idle (once per idle period, only when no wake is already due) and `wake`. One dispatcher at a time; events arriving meanwhile are coalesced into the next fresh dispatcher. A failed dispatcher's events go back to the queue.
- **Tasks.** The controller accepts a listed task only if both its node and its write scope lie inside OWNER's subtree. It runs tasks together only when their dependencies are met and their scopes are disjoint (neither is the other or its ancestor).
- **Capacity.** A worker failing with a usage limit (`Try again in ~N min`, or 30 minutes) rests its seat. The task goes back to the queue unchanged, ahead of others. A launch that fails before any model runs, or a provider failure that outlasts Pi's own retries, is treated the same way. A task's third provider failure becomes a `task_errored` event instead, so a task that breaks providers reaches the dispatcher rather than cycling through seats.
- **Human input.** A real `needs_input` question preserves its worker/session and pauses new admissions; `status` shows the exact task and question. Answer only that task with `answer --run <RUN> --task <TASK> --text '...'`; the controller continues the same saved session on its unchanged route with a fresh report. If registered background work is still running, the worker must wait for its completion notification and must not declare `needs_input` as a yield.
- **Friendly stop.** `continue` requeues the same task with `PREVIOUS`, OSS first. A third continue is a dispatcher event. `stop_running` and `stop --now` type a stop request into the worker's pane.
- **Fence guard.** After every worker attempt, each read-only repository must have empty `git status --porcelain` and an unchanged HEAD. Otherwise the controller asks running workers to report and stops as `needs_attention`.
- **Terminal states.** `done`, `blocked` and `idle` (nothing can start) end the controller; `wake` restarts it. `stop` is graceful: running attempts finish and nothing new launches. `resume` restarts from `state.json` and re-adopts running workers through their durable task-outcome receipts.
- **Smoke-only faults.** `faults.seat_usage_limit: {seat, launches, minutes}` makes that seat's first launches fail with a usage-limit provider error. `faults.claude_failure: {wake}` launches that wake's Claude dispatcher on a nonexistent model.

Tests: `node --test extensions/dark-factory/parallel-*.test.ts` (offline; simulated seats/receipts/clock, with disposable native Git fixtures for code tasks).

### Tree-forward code tasks

Set `code.integration: "dispatcher"` for the agent-owned pipeline. The tree's dispatcher and worker roles own the engineering protocol; the controller only schedules, allocates private worktrees, consumes settled reports and tracks identities. It does not execute gates, register acceptance packets, enforce registry membership or launch reconciliation/publication workers in this mode. The original JIT mode below remains available only for unmigrated runs; changing modes requires an authorized, drained config/pin migration, not a casual resume edit.

Workers implement and test in their assigned worktree, checkpoint their task node and return `candidate`. Overlapping source fences are allowed. A candidate is a settled draft, not accepted main. The sole dispatcher trusts those checkpoints, runs the required integration tests, reconciles ordinary Git conflicts, merges and records the result in the tree. Existing frozen tests and file/tree fences still apply; an unlanded sibling observer is not a global prerequisite. The dispatcher maintains mandatory-primary participation and selects actual dependencies, rather than code inventing policy from check registration.

After integration the dispatcher includes `completed: [{node_id, candidate, main, checks: [absolute_test_log_paths]}]` in its ordinary report. Candidate and main are full SHAs; each integrated main must be in the current clean main history. The controller releases dependencies from that result without rerunning tests. It does not write to the tree. If integration fails, the dispatcher retains the draft and assigns repair, while independent work continues.

At 80% context a dispatcher returns `disposition: "continue", tasks: []` with any integrations already completed and a precise next step in its summary. The next dispatcher receives `PREVIOUS` and current STATE and continues without re-auditing completed work. Worker continuation uses the existing retained-worktree/report handoff. Tests use real disposable Git worktrees and executable checks with simulated agent transport; they do not claim universal live-agent compliance.

### Original code tasks (unmigrated JIT controller)

Tree-only configs/reports retain the existing behavior. Code runs must override `roles` with run-scoped **JIT** dispatcher/worker instructions; the generic Worker Role's historical code refusal and permanent-chat orchestration instructions are not this protocol. The detached controller makes no model turns. Set `codex_seats: 1`, `dispatcher_engine: "fallback"` for exactly one Qwen worker and one Sol worker plus fresh Sol dispatchers; existing `routes` and `roles` overrides still apply. There is no checker model.

Add this object to the overrides (replace placeholders with approved canonical paths, full SHA and exact independent gate argv):

```json
{
  "codex_seats": 1,
  "dispatcher_engine": "fallback",
  "roles": {"dispatcher": "<JIT dispatcher node UUID>", "worker": "<JIT worker node UUID>"},
  "code": {
    "repo": "/absolute/accepted-main-checkout",
    "main_branch": "main",
    "main_head": "<full authorized main commit SHA>",
    "worktree_root": "/absolute/existing-private-worktree-parent",
    "allowed_paths": ["src", "tests"],
    "frozen_paths": ["laws", "tests/frozen-expectations"],
    "candidate_checks": [["/absolute/check-executable", "candidate-arguments"]],
    "main_checks": [["/absolute/check-executable", "main-arguments"]]
  }
}
```

`repo` is an existing clean checkout on `main_branch`, pinned at `main_head` at first start; `worktree_root` must already exist, be canonical (no symlink aliases), and be disjoint from `repo`. The mutable repo cannot also be a read-only repo (including another worktree of the same Git repository). A repository-wide `.git/parallel-factory.lock/owner` identifies the owning run directory. Another run or an ambiguous owner is refused, never automatically stolen. Normal safe terminal states release it; ambiguous launches/publication/attention and retained merge reservations keep it. No worktree, branch, stash or dirty draft is removed/reset by the controller.

The parent owns the exact gate selection and frozen paths. `allowed_paths` and `frozen_paths` are nonempty literal repo-relative file/directory arrays, not globs. Each task's files must be inside `allowed_paths` and disjoint from frozen paths, including when a requested directory contains a frozen file. Independent acceptance definitions, assertion/expectation sources and any candidate-local gate scripts must be frozen or located outside mutable worker authority. Do not weaken them to make a candidate pass. Git gates enforce changed-path/identity boundaries, not the meaning of arbitrary checks.

Dispatcher task entries add optional `seats` (explicit IDs) and `code`:

```json
{"node_id":"<task UUID>","depends_on":[],"scope":"<task subtree UUID>","seats":["codex-1"],"code":{"files":["src/storage"]}}
```

Code tasks require explicit `seats`; use `oss` for prescribed fixtures/checks/source evidence and `codex-1` for persistence/proof/isolation/synthesis. Tree tasks can use `seats` too, or omit it to retain OSS-first legacy routing. Unavailable seat IDs are rejected. Suitability is an explicit dispatcher constraint, never inferred by the controller. Dependencies release only after `worked`, not after a private candidate. Task-node scopes must remain disjoint for concurrency; overlapping code file scopes are allowed in separate drafts and require worker reconciliation. Retained code file/seat/tree-scope ownership cannot change through re-listing.

On first launch the controller journals a unique task worktree/branch and base before native `git worktree add -b`, then launches at that private cwd. Pointer-only missions add `CODE: /absolute/attempt/code.json`. That file contains task/seat, repo, allowed/frozen paths, worktree, branch, original base, latest candidate, phase and merge reservation/grant. State/snapshots/status expose those identities and receipts; `history.jsonl` records reservations, exact candidate checks, publication, attention and gate log paths. Existing drained input commits can be imported **by the worker** as explicitly named task inputs; old active worktrees are never adopted implicitly.

The worker protocol has three phases, all on a constrained worker seat, with fresh sessions and the same task/worktree:

1. **develop**: worker inspects/stages/commits only its file fence, records tree evidence, returns `candidate`. It never writes main or marks publication complete.
2. **reconcile**: controller reserves one merge turn naming task and current accepted main SHA. Worker merges that exact main into its branch and resolves conflicts itself, preserving its earlier candidate ancestry; no rebase/reset that drops history. Return `candidate` with `code.main` equal to the reservation's main SHA. Controller requires a clean exact branch tip, main ancestry and allowed changed paths, runs exact candidate gates in the private cwd, then checks identity/cleanliness/main again.
3. **publish**: only after those gates pass, a fresh worker gets `phase: "publish"` and `merge: {task,main,candidate,checks}`. Before mutation it checks the exact branch/candidate, clean main on the named branch and exact old main SHA. Only this grant permits `git -C <repo> merge --ff-only <full candidate SHA>`. It never stages/edits main or publishes another SHA. Return `worked` with `code.main` and `code.candidate` both equal to the checked candidate. Controller checks exact landed main, runs main gates **in the main checkout** (rebuild there when required), then releases the reservation and credits the task. A private binary/check is not a main-check substitute.

All phases retain the ordinary worker JSON fields and add:

```json
{"code":{"worktree":"/absolute/owned/worktree","branch":"factory/<run UUID>/<task UUID>","base":"<full original base SHA>","candidate":"<full SHA or null for an uncommitted checkpoint>","main":"<reserved old main SHA for reconciliation; exact published SHA for worked>"}}
```

`candidate` is a new worker disposition, not completion of the code task. `continue`/`blocked` retain draft/candidate/phase/previous report; include the assigned worktree/branch/base even for interruptions, plus exact remaining work/next action and uncommitted/untracked/stashed evidence. Report `candidate`/`worked` only with clean worktree and actual full commit SHA. Do not resolve the task before its published main acceptance; publication workers record their tree checkpoint, and downstream tasks release only when the controller credits the main gates. Workers write the reserved report in place, call `report_outcome` under their real task contract, and end; completed report transport is not full-run success.

Gate argv are trusted parent configuration, run without shell interpolation or a deadline, with `FACTORY_CANDIDATE`, `FACTORY_MAIN`, `FACTORY_WORKTREE` in the environment. Candidate checks run from the private cwd; main checks run from main. Logs are `attempts/.../{candidate,main}-check-<n>.log`. A nonzero exit, execution failure, output exceeding the 16 MiB capture ceiling, changed candidate, dirty checkout, failed fence, stale main or edited code config stops advancement as attention. Code config is hash-pinned across restarts; stop/resume cannot waive acceptance by editing checks/fences. Gates must be nonmutating except ignored build output; checked tracked/untracked changes invalidate publication. While a gate is running, inbox stop/wake is processed after that gate returns; there is no gate deadline.

`task_candidate` wakes a fresh dispatcher like a finished worker turn; running/merge-queued/credited tasks are not re-assigned by dispatchers. A dispatcher `done` is refused while tasks are unfinished; human-owned unanswered meaning is `blocked`, never `done`. A single reservation spans reconciliation, checks and publication, including friendly/operator stops. New code admissions and sibling code-report processing pause during an active publication so main is not sampled mid-merge. CLI wake/stop/resume and durable known-receipt readoption remain the existing transport. A missing launch receipt, partial worktree allocation, unexpected main mutation or lost publication outcome is **ambiguous**: retain identities/lock/drafts and stop for operator recovery, never force-reset/relaunch/credit a plausible orphan report. Automatic recovery from arbitrary OS/process crashes is not claimed. Tests exercise fake receipt replay, not universal exactly-once START/delivery/publication.

These worktrees/file prompts and Git gates are development/publication discipline, **not OS sandbox enforcement**. Other same-user processes and arbitrary worker commands can bypass them; no service/toolchain/security-policy changes are made.
