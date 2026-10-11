# Dark Factory

## Peer factory floors

`bin/factory` is the explicit CLI for the multi-floor peer runtime. It consumes
`floors/runtime.mjs` and `floors/supervisor.mjs`; the existing sequential and
parallel commands below remain separate compatibility paths, not peer controllers.
Node 24 is required. Creation/configuration do not request a model.

Each floor's SQLite is the single source of truth for settings, messages, workers
and the owner's ballot. Default discovery is
`~/.local/state/dark-factory/floors/<id>/floor.sqlite`. The multi-floor room reads
that same discovery/runtime interface and picks up CLI-created floors on its next
list refresh, without restart. No browser SQLite access or second registration
store is needed. Configure the room in multi-floor mode; legacy BF2 room hosting
is still a separate mode.

```sh
FACTORY=/absolute/path/to/agent-checkout/bin/factory
"$FACTORY" -h
"$FACTORY" create --floor project-a --settings /tmp/project-a-settings.json
"$FACTORY" list
"$FACTORY" status --floor project-a
"$FACTORY" config --floor project-a
"$FACTORY" config --floor project-a --settings /tmp/project-a-patch.json
# Only when separately authorized and launch instructions are approved:
"$FACTORY" start --floor project-a --key start-1
"$FACTORY" message --floor project-a 'Please give me an overall progress update' --key update-1
"$FACTORY" stop --floor project-a --key stop-1
"$FACTORY" oss                    # Actual global managed OSS selection/lease
"$FACTORY" oss --floor project-a  # Select a floor with a configured OSS slot
"$FACTORY" oss --none             # Drain/release the managed OSS occupant
```

`--floors-dir /absolute/path` or `FACTORY_ROOT` selects another discovery root,
primarily for isolated fixtures. Outside a launched worker, floor-scoped commands
require `--floor`; there is no last-used fallback. Operator mutations reject
inherited worker identities. Stable `--key` values make owner message/start/stop
retries idempotent; changing the input for an existing key is rejected. Generated
keys appear in output: preserve one before retrying an uncertain command. If
controller recovery fails after persistence, output includes `controllerError`
and the CLI exits nonzero while naming the saved key. Repair recovery and retry
that same key; do not assume workers started.

### Settings input

`--settings` imports a JSON object once; the file is not a live configuration.
Creation requires name, existing absolute Git checkout cwd, nonempty starting-node
UUIDs and 2–10 slots. Instruction-entry UUID and owner vote condition may be null
or omitted while preparing a stopped floor. Two slots may
use the same model. This generic example is input structure, not an approved
project/instruction/account route:

```json
{
  "name": "Project A",
  "cwd": "/absolute/existing/git-checkout",
  "roots": ["11111111-1111-4111-8111-111111111111"],
  "instructions": "22222222-2222-4222-8222-222222222222",
  "voteCondition": "The exact condition supplied by the owner",
  "slots": [
    {"id":"peer-a","provider":"openai-codex-personal","model":"gpt-6.1-sol","thinking":"high","role":"","contextWarning":80},
    {"id":"peer-b","provider":"openai-codex-personal","model":"gpt-6.1-sol","thinking":"high","role":"","contextWarning":80}
  ],
  "bootstrap": null,
  "warningText": null,
  "wrapupText": null
}
```

Slot IDs are unique/stable. Select an explicitly authorized, installed account
provider rather than inferring it from registry order. Supported models/thinking:
`openrouter` / `xiaomi/mimo-v2.6-pro` / `high`; `openai-codex-personal` /
`gpt-6.1-sol` or `gpt-6-luna` / `high` (explicit existing Codex account routes
remain compatible); `local` /
`qwen3.8-flash-next` / `xhigh`. Role is owner-supplied text, not a director.
`contextWarning` is a percentage greater than zero and at most 100. On registered
peer floors it records a retirement transition, not an advisory checkpoint.
At most one OSS slot may be configured on a floor. The global OSS selection holds
its single lease until the old occupant actually exits/cleans up; selecting a
stopped floor does not start it.

Creation is **stopped**. New production bootstrap/warning/wrapup/role instructions
must be shown exactly to Jack and approved before installation. Null launch text
and pending instruction/vote settings permit stopped creation/adoption/configuration
but block Start before saving any start command, changing state or spawning.
Chat on a pending stopped floor is saved without starting; it cannot bypass the gate.
The website lists missing launch fields; configure the vote there and other launch
inputs with `factory config`. Live, queued or draining floors cannot clear these
prerequisites, preserving graceful stop. The CLI does not load a packaged
skill or persist any tree instructions. Use fixture text only in isolated checks.

Config accepts a partial object; supplied arrays replace those arrays atomically.
Invalid settings leave the prior settings intact. Model/role changes apply to the
next occupant, not the current worker. Removing slots safely retires their current
occupants. Editing the owner's condition invalidates old votes and notifies peers;
membership changes invalidate an unfinished ballot. Unanimous yes pauses/drains
for that condition, not controller-defined product completion.

### Context retirement and independent jobs

Floor workers persist a context-stop request at the configured threshold before
admitting another tool, and at `turn_end`. Lifecycle inputs render the occupant's
launch-snapshot `warningText`/`wrapupText`; install the approved event/node-locator
text from Factory Control Lifecycle, not a behavior copied into source. All five
existing placeholders are available. Existing occupants retain their launch text;
source changes and tree persistence alone do not install approved settings.
Unadopted legacy BF2 retains its old advisory warning.

Retirement prevents new machine-job launches, ballots and new orchestration tools.
Native read/shell/edit/write, tree operations, tool discovery, background-result
inspection/cancellation and final `messaged_outcome` remain available for capture
and real settlement. Runtime cannot distinguish an artifact-preserving shell/edit
from substantive project work: that purpose, required reads and final coordination
message remain instruction-node behavior, not software-certified compliance.
Ordinary peer pushes stop without clearing their backlog; a separate durable
owner-input channel permits runtime-attributed human input, including while idle.
Direct interactive/RPC human input also remains available until final done. Neither
clears the retirement state. Idle cache warming stops during retirement.

`bin/factory-job -h` describes the native launcher/control surface. It does not
start a model or controller. For separately authorized machine work:

```sh
# Retain a fresh UUID KEY before any launch; FILE contains the exact shell command.
/absolute/agent-checkout/bin/factory-job launch --floor project-a --key "$KEY" \
  --command-file /durable/command.sh --owner "$WORK_NODE_UUID"
/absolute/agent-checkout/bin/factory-job list --floor project-a
/absolute/agent-checkout/bin/factory-job status --floor project-a --key "$KEY"
# Outside operator only, and only with explicit cancellation authority for this job:
/absolute/agent-checkout/bin/factory-job cancel --floor project-a --key "$KEY"
```

Workers omit `--floor` and keep their launch binding. Launch defaults to the floor's
Git cwd and records its actual HEAD; dirty drafts are not reset or snapshotted.
The retained job directory contains the immutable command/cwd/revision/origin/owner
manifest, runner/process identity, local control capability, output/runner logs and
atomic receipts. It is separate from worker tmux sessions and chat-scoped `bash_bg`.
A native group leader pins command-group identity until normal descendants drain.
Commands must not detach descendants outside that group: such work requires its
own separately verified control/drain contract. This is trusted local-user runtime,
not a process sandbox or power-loss/exactly-once external-effects guarantee.

The independent runner writes one global `[system]` terminal post transactionally
with its job terminal record, without originating-worker credentials or a named
recipient. Nonzero/signal exits, cancellation and abnormal/missing receipts remain
distinct from acceptance. Runner death without a terminal receipt reports unknown
effects/drain when observed by the supervisor or `factory-job status/list`; missing
START produces a retained abnormal/uncertain event, not an inferred process exit,
and never relaunches automatically.
Publication retries and receipt reconciliation deduplicate the terminal event.
Results/events remain in SQLite/artifacts while stopped or without peers. Fresh
peers' startup history and bounded USER batches include retained terminal events,
even beyond latest-30 history; this is not an ACK, assignment or acceptance system.
Completion never starts workers. Worker retirement, cleanup and floor Stop never
signal independent jobs. Explicit cancellation addresses the runner's identity-bound
control endpoint, verifies process-group drain and preserves output; absent or
ambiguous control refuses rather than signalling a possibly reused PID.

An authorized outside human may use `factory-job override-context --floor ID
--session UUID --reason 'explicit scope'` for this context-stopped occupant only.
It retains the reason and suppresses repeated observations of this occupant's same
threshold, not future workers. Instruction nodes govern the human's stated scope.
It cannot undo final done, owner Stop or another retirement request.

This source implementation is **not live rollout**. Inspect and preserve/migrate
existing independent jobs and legacy callbacks under separate authority first;
there is no automatic adoption of private wrappers. Then install approved lifecycle
signals and validate new occupants under separately authorized live trials. Native
fixtures do not establish model compliance or provider/platform reliability.

### Worker board scope and BF2 adoption

The launcher supplies `FACTORY_FLOOR`, `FACTORY_DB`, `FACTORY_SESSION`,
`FACTORY_SENDER`, `FACTORY_ROOT` and compatible `BF2_BOARD_*` aliases. Workers use
plain `board post`, `read`, `status`, `vote NUMBER yes|no` and `done`; they cannot
change their floor/identity. First plain read preserves the existing startup cursor
and retained-owner-input boundary. Outside workers use `board --floor ID read`
or `board --floor ID post 'text'` (owner input), or `factory message --floor ID`.
Outside history does not consume a worker's input. `done`, `pause` and `vote`
require a registered launched worker. Floor ballots come from the owner; legacy
BF2 `pause KEY reason` behavior remains unchanged in legacy mode.

```sh
# One-time operation only when separately authorized; never a live trial fixture:
"$FACTORY" adopt --floor bf2 --run-dir /absolute/stopped-drained/BF2-run \
  --settings /tmp/bf2-floor-settings.json
```

Adoption is runtime-owned and requires a compatible stopped/drained BF2 run with
its old controller exited. It registers the original database through the standard
floor discovery path, preserving history, identities and session directory rather
than rebuilding an empty run. It does not launch or credit old workers as fresh
completions. Identical adoption retries must preserve that exact source/settings;
conflicting source/settings are rejected. Keep the legacy `bin/bf2-swarm` controls
for unadopted runs; do not use them to resume an adopted floor. This implementation
assignment does not authorize Jack's live BF2 migration or any service restart.

Checks after merging the runtime dependency:

```sh
node --test extensions/dark-factory/floors/cli*.test.ts extensions/bf2-swarm/board.test.ts
# Isolated consumer worktree only: point tests at the sibling's real runtime.
FACTORY_TEST_RUNTIME_DIR=/absolute/runtime-checkout \
  node --test extensions/dark-factory/floors/cli*.test.ts
```

Integration tests use real SQLite/runtime operations with generic copied fixtures;
only controller transport is injected, so they make no real worker/model/browser
qualification claim. No live database, source project or services are exercised.

## Sequential dark factory

Runs fresh agents through the canonical tmux subagent transport. The repository owns generic scheduling, locks, route guards, report delivery and continuation. SiftText owns project instructions and completion conditions; no project contract Markdown is shipped or read from this repository.

A local `~/.pi/agent/factory-projects.local.json` maps task names to a `root` instruction-node UUID, explicit `route` (`provider`, `model`, `thinking`) and `ready` disposition. This file is ignored. A prepared `--config` may supply the same `project` object. Non-smoke work refuses to start without an instruction entry; workers read its current authority in SiftText. The default `task` supports read-only smoke without any project identity.

```sh
node extensions/dark-factory/run.mjs smoke task --wait
node extensions/dark-factory/run.mjs start sample --config /private/path/run.json
node extensions/dark-factory/run.mjs status sample
node extensions/dark-factory/run.mjs stop sample
node extensions/dark-factory/run.mjs resume sample
```

Each named task has its own lock and ignored run directory. Planner/worker lanes can coexist with fixed-assignment readers under bounded admission. Reader packets remain separate from aggregate writes. Suite status reports prerequisite, aggregate and reader states with exact assigned/read/excluded/merged counts; exclusions require explicit authority and cannot count as reads.

Advancement requires a structured task outcome, valid JSON report, durable receipt and a closed worker session. Context handoffs retain the role, assignment, report and spent work. Graceful stop admits no successor; interrupted or ambiguous attempts retain their evidence and locks until quiescence is proven. The route guard bounds provider-error retries and never overrides human/policy stops or pending work. Resume never credits an orphan report merely because its file exists. Real attempts have no factory wall-clock deadline, and transport settlement is not project completion.

## Shared room UI

The accepted C-layout chat assets live in `room/` (plain HTML/CSS/JS and fonts),
headed **Dark Factory**. `../bf2-swarm/room/` retains per-file relative symlinks for
existing static-server paths and module imports; browser asset URLs are unchanged.
The BF2 board, controller, room HTTP server and hosting adapter still belong to
`../bf2-swarm/`. This relocation does **not** give the sequential/parallel factories
or legacy BF2 runs the BF2 room API. No runtime, storage keys or auth identities
were generalized. See [room compatibility and live integration](room/README.md).

## Parallel factory

`parallel-run.mjs` runs the Parallel Execution Contract (SiftText `d96507db`) beside the sequential lanes; it imports but never changes the sequential lane modules. A deterministic controller (no model turns) owns seats, the event queue, launches, report validation and friendly-stop handoffs. Dispatchers and workers get tree pointers; their task instructions live in the Dispatcher Role and Worker Role nodes. The shared dispatcher bootstrap supplies the current human scheduling-only/trust-workers override directly, above conflicting tree role or stale maintained contract prose.

```sh
cd ~/.pi/agent
node extensions/dark-factory/parallel-run.mjs start-parallel --run <RUN node> [--config overrides.json]
node extensions/dark-factory/parallel-run.mjs status [--run <RUN node>]
node extensions/dark-factory/parallel-run.mjs wake [--run <RUN node>] [--reconcile] [--note text]
node extensions/dark-factory/parallel-run.mjs answer --run <RUN node> --task <TASK node> --text 'human answer'
node extensions/dark-factory/parallel-run.mjs stop [--run <RUN node>] [--now]
node extensions/dark-factory/parallel-run.mjs resume [--run <RUN node>]
```

`start-parallel` reads the RUN node's `OWNER:` line (first node UUID) and `Read-only repository:` paths, refuses to start if a read-only repository is dirty, and records its HEAD. Without `--run`, other commands act on the most recent run. State lives in `factory-runs/parallel/<timestamp>-<run8>/`: `config.json`, `state.json` (seats, tasks, pending events, dispatcher), `history.jsonl` (every launch, finish, rest, event and fence check), `attempts/<n>-<kind>-<seat>/` (mission, events/state snapshots, report) and `artifacts/<task>/` (the ARTIFACTS directory a worker receives). tmux sessions are `pf-<run8>-ctl-*` (controller), `pf-<run8>-dispatch-<n>` and `pf-<run8>-<seat>-<n>-*`.

Hosted tree operations use `~/.local/bin/sifttext-mcp`; `sifttext` remains the native local Core CLI.

- **Seats.** One OSS seat (`local/qwen3.8-flash-next` xhigh) and up to six Codex seats (`openai-codex-personal/gpt-6.1-sol` high), filled in that order. If RUN states that the primary is mandatory, the controller will not admit Sol-only work while OSS has no active contribution; it wakes the dispatcher instead. Overrides: `routes.{oss,codex,fallback}`, `seat_routes.<seat>`, `codex_seats`, `claude.{model,effort}`.
- **Dispatcher.** New runs default to a fresh Pi dispatcher on `openai-codex-personal/gpt-6.1-sol` high, using the existing fallback transport on every wake; no Claude requests. Override its route with `routes.fallback`. Saved runs select it with `dispatcher.engine: "fallback"` in `config.json` (stop the controller before editing). Old configs without an engine retain their original Claude-first behavior. To opt back into Claude on a new run, set `dispatcher_engine: "claude"` in overrides. In Claude-first mode: interactive `claude` (`claude-opus-5-5[1m]`, `--effort xhigh`, `--dangerously-skip-permissions`) in its own tmux session, started from the pre-trusted, empty `factory-runs/parallel/claude-dispatcher` directory so no project memory loads. Its hooks come only from the run's `claude-settings.json` (`--settings`); `parallel-hook.mjs` is inert without `FACTORY_PARALLEL_ATTEMPT_DIR`. On Stop it accepts a valid report (or reminds once), and on StopFailure it records the error; the controller then closes the session. A Claude usage limit rests the Claude seat until the stated reset (else 30 minutes). Any Claude failure hands the same events to one Pi fallback dispatcher on the fallback route. Three consecutive dispatcher failures stop the run as `needs_attention`. A Claude session with no transcript activity for 30 minutes counts as failed.
- **Events.** Task finished/blocked/errored, third continue, OSS idle (once per idle period, only when no wake is already due) and `wake`. One dispatcher at a time; events arriving meanwhile are coalesced into the next fresh dispatcher. A failed dispatcher's events go back to the queue.
- **Tasks.** The controller accepts a listed task only if both its node and its write scope lie inside OWNER's subtree. It runs tasks together only when their dependencies are met and their scopes are disjoint (neither is the other or its ancestor).
- **Capacity.** A worker failing with a usage limit (`Try again in ~N min`, or 30 minutes) rests its seat. The task goes back to the queue unchanged, ahead of others. A launch that fails before any model runs, or a provider failure that outlasts Pi's own retries, is treated the same way. A task's third provider failure becomes a `task_errored` event instead, so a task that breaks providers reaches the dispatcher rather than cycling through seats.
- **Human input.** A real `needs_input` question preserves its worker/session and pauses new admissions; `status` shows the exact task and question. Answer only that task with `answer --run <RUN> --task <TASK> --text '...'`; the controller continues the same saved session on its unchanged route with a fresh report. If registered background work is still running, the worker must wait for its completion notification and must not declare `needs_input` as a yield.
- **Bounded completion / friendly stop.** A finished assigned tree contribution returns `worked`, and finished code returns `candidate` (legacy granted publication retains `worked`). An unfinished parent does not authorize another batch inside the same fence. `continue` is only unfinished work in the SAME explicit assignment; it requeues that unchanged task with `PREVIOUS`, OSS first. A third continue is a dispatcher event. A stale relaunch of an exhausted contribution preserves its result and names the missing dispatcher assignment, without new work. `stop_running` and `stop --now` request a preserved checkpoint after registered checks drain, not an unconditional continue.
- **Fence guard.** After every worker attempt, each read-only repository must have empty `git status --porcelain` and an unchanged HEAD. Otherwise the controller asks running workers to report and stops as `needs_attention`.
- **Recovery admission.** `wake --reconcile` holds new worker admissions while retained outcomes are consumed. Only a newer dispatcher’s valid `tasks` decision with no rejected orders releases the hold; context handoffs, failures and old dispatcher reports do not. Running workers and their reports are preserved. The hold is visible in status and dispatcher STATE and survives restart. Use it when task instructions/ownership must be reconciled before a continuation can safely run. The fresh dispatcher reconciles ordinary inputs/ownership and may release bounded work under current RUN authority without an outer operator rewriting stale policy contracts or supplying an installed amendment receipt.
- **Lifecycle interruptions.** Provisional declarations, context/maintenance pauses, human questions and transport loss are not MODEL task completion. Live and readopted Pi monitors use the same selected-branch identity-bound receipts. Paused/lost/unknown attempts retain session, seat, draft and publication reservation, block replacement on that ownership and publish one actionable event with report/session/monitor locators; unchanged observations/refusals do not create wake loops. No report-only credit, vanished-pane completion, automatic cleanup or concurrent replacement. Context maintenance uses the existing explicitly authorized same-attempt recovery tool; actual loss needs verified background/native drain before replacement. Automatic readopted-context/loss recovery and live-provider reliability are not qualified by offline fixtures. A legitimate unfinished dispatcher continue remains allowed; prose is never parsed to decide semantic exhaustion.
- **Terminal states.** `done`, `blocked` and `idle` (nothing can start) end the controller; `wake` restarts it. `stop` is graceful: running attempts finish and nothing new launches. `resume` restarts from `state.json` and re-adopts running workers through their durable task-outcome receipts.
- **Smoke-only faults.** `faults.seat_usage_limit: {seat, launches, minutes}` makes that seat's first launches fail with a usage-limit provider error. `faults.claude_failure: {wake}` launches that wake's Claude dispatcher on a nonexistent model.

Tests: `node --test extensions/dark-factory/parallel-*.test.ts` (offline; simulated seats/receipts/clock, with disposable native Git fixtures for code tasks).

### Tree-forward code tasks

`code.integration: "dispatcher"` is the retained configuration name for the tree-forward pipeline (no mode/pin migration is needed for this role correction). Dispatcher reads current RUN/owners, task statuses and bounded settled reports to choose, sequence and assign work. It is **scheduling-only**, not an auditor, reviewer, semantic judge, integrity checker, acceptance tester or integration worker. The generated `dispatcherPrompt` supplies this explicit human override above conflicting ROLE/RUN/owner/previous-report text; canonical tree prose itself is not rewritten by this source change.

Current tree-owned/explicit current human targets govern work. Maintained `run-contract.md`/`acceptance-contract.md` are optional technical references/test recipes, not duplicate permission sources. No outer contract-install receipt, historical exact-two-tree allowlist, importer parity, micro-summary second read or whole-dataset integrity barrier is required for dispatcher admission/progress. No checker agent, attestation or hidden successor review replaces those gates. Real missing task inputs, current human decisions, live STOP, platform denial and actual route/fence incompatibility still stop affected action; independent work remains eligible. Code-config pins, legal assignment/route/scope, frozen-source Git ownership and settled report identity are mechanical safety, not content proof. DB authentication/RLS/read-only transactions, production-write prohibition and source privacy remain binding. This does not broaden credential access or implement a personal-tree exporter.

Workers implement and run their own assigned tests in private worktrees; native checks and useful test recipes remain available. Dispatcher/controller do not rerun them as acceptance gates. Overlapping source fences are allowed. A candidate is a worker-reported finished draft, not yet published main. Dispatcher returns `completed: [{node_id, candidate, report}]` using the exact current candidate SHA and `last_report` path from STATE, without main/check logs. Controller binds that instruction to the current settled worker result, checks Git/worktree/file/frozen identities, then performs **ff-only** publication and releases dependencies. Credit records `verification: "worker_report"`: the result is trusted, not independently proven. Controller does not inspect product meaning, execute acceptance tests or write the tree. Already-issued historical `{node_id,candidate,main,checks}` integration reports remain supported without repeated checks.

A non-fast-forward candidate stays pending and emits `candidate_needs_reconciliation`; no model or automatic repair is launched. Dispatcher may return `recover` for the same owning task/draft. That worker receives `CODE.current_main`, preserves both histories, resolves in-fence conflicts and runs its own affected assigned tests before returning another candidate. There is no separate publication/review assignment. Dispatcher does not repair conflicts itself. Malformed, stale or unauthorized receipt instructions do not publish or release dependencies. Worker-reported failure is not reinterpreted as success.

At 80% context dispatcher returns `disposition: "continue", tasks: []` with any selected receipts and the precise scheduling checkpoint. Successor reads PREVIOUS/STATE without auditing completed work. Worker continuation remains bounded to its unchanged unfinished assignment. Done reflects current RUN work/statuses and no unfinished ownership, not a fresh integrity audit. Tests use disposable Git and simulated transport; they establish mechanical execution and generated instructions, not live model compliance or independently verified product content. The original JIT controller below is retained only for unmigrated runs; its test-managed pipeline is not invoked by the active tree-forward mode.

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

`candidate` is a new worker disposition, not completion of the code task. `continue` means unfinished work in that same assigned phase, not selection of another task/batch; `continue`/`blocked` retain draft/candidate/phase/previous report. Include the assigned worktree/branch/base even for interruptions, plus exact remaining work/next action and uncommitted/untracked/stashed evidence. Report `candidate`/`worked` only with clean worktree and actual full commit SHA. Do not resolve the task before its published main acceptance; publication workers record their tree checkpoint, and downstream tasks release only when the controller credits the main gates. Workers write the reserved report in place, call `report_outcome` under their real task contract, and end; completed report transport is not full-run success.

Gate argv are trusted parent configuration, run without shell interpolation or a deadline, with `FACTORY_CANDIDATE`, `FACTORY_MAIN`, `FACTORY_WORKTREE` in the environment. Candidate checks run from the private cwd; main checks run from main. Logs are `attempts/.../{candidate,main}-check-<n>.log`. A nonzero exit, execution failure, output exceeding the 16 MiB capture ceiling, changed candidate, dirty checkout, failed fence, stale main or edited code config stops advancement as attention. Code config is hash-pinned across restarts; stop/resume cannot waive acceptance by editing checks/fences. Gates must be nonmutating except ignored build output; checked tracked/untracked changes invalidate publication. While a gate is running, inbox stop/wake is processed after that gate returns; there is no gate deadline.

`task_candidate` wakes a fresh dispatcher like a finished worker turn; running/merge-queued/credited tasks are not re-assigned by dispatchers. A dispatcher `done` is refused while tasks are unfinished; human-owned unanswered meaning is `blocked`, never `done`. A single reservation spans reconciliation, checks and publication, including friendly/operator stops. New code admissions and sibling code-report processing pause during an active publication so main is not sampled mid-merge. CLI wake/stop/resume and durable known-receipt readoption remain the existing transport. A missing launch receipt, partial worktree allocation, unexpected main mutation or lost publication outcome is **ambiguous**: retain identities/lock/drafts and stop for operator recovery, never force-reset/relaunch/credit a plausible orphan report. Automatic recovery from arbitrary OS/process crashes is not claimed. Tests exercise fake receipt replay, not universal exactly-once START/delivery/publication.

These worktrees/file prompts and Git gates are development/publication discipline, **not OS sandbox enforcement**. Other same-user processes and arbitrary worker commands can bypass them; no service/toolchain/security-policy changes are made.
