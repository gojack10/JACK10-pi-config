# BF2 board and opt-in three-peer swarm

Dependency-free Node 24 SQLite CLI, optional Pi USER-input receiver, and a separate
experimental three-peer lifecycle. The board still works alone. The swarm never
uses the existing factory/task-report contract. No dispatcher, routing, assigned
tasks, subscriptions, ACK rules, tree-status interpretation or dependencies.
Existing factory/outcome/friendly-stop/settings sources remain untouched.

## Swarm controls (later authorized live trial only)

Keep this launcher checkout, the BF2 checkout, session JSONL and run DB durable.
The launcher does **not** initialize or modify the BF2 checkout. Set the provider
variable to the exact human-authorized account route; do not infer it from registry
order. This experiment fixes the model/thinking to `gpt-6.1-sol` / `high`.
The parent supplies the real BF2 root and experiment-instruction UUIDs. A UUID
placeholder is acceptable for build checks, not a live instruction node.

```sh
SWARM_CODE=/absolute/path/to/durable/agent-checkout
BF2_REPO=/absolute/path/to/durable/BF2-checkout
# Set BF2_SWARM_PROVIDER, BF2_ROOT_NODE, BF2_EXPERIMENT_NODE explicitly first.
"$SWARM_CODE/bin/bf2-swarm" start --cwd "$BF2_REPO" \
  --root "$BF2_ROOT_NODE" --instructions "$BF2_EXPERIMENT_NODE" \
  --provider "$BF2_SWARM_PROVIDER"
# Start prints a fresh durable RUN path and the single tmux parent attachment.
"$SWARM_CODE/bin/bf2-swarm" status --run-dir "$RUN"
"$SWARM_CODE/bin/bf2-swarm" stop --run-dir "$RUN"
"$SWARM_CODE/bin/bf2-swarm" resume --run-dir "$RUN"
# Recover only the controller window, preserving stored running/waiting/stop:
"$SWARM_CODE/bin/bf2-swarm" run --run-dir "$RUN"
"$SWARM_CODE/bin/bf2-swarm" -h
```

`start --run-dir /absolute/new/run` selects another fresh namespace. Default is
`~/.local/state/bf2-swarm/<new UUID>`, never `factory-runs`. Existing run directories
are rejected by start. `status`, `stop`, `resume` and recovery require the saved
run.json and DB; they never create a missing DB. The DB stores authoritative config,
worker identities, votes, handoffs and running/waiting/stopped state. Session files,
boot USER @files and tmux pane logs stay in that run directory. No PATH installation.

Before start, **new sessions** need Pi's native `steeringMode` and `followUpMode`
both `all` in current settings (the parent's separate queue change). The launcher
checks current settings; the opt-in extension independently checks effective Pi
settings before releasing startup input. Do not reload old runs. Ordinary extensions
and skills autoload. Swarm adds `optional-extensions/bf2-swarm.ts` then `bf2-board.ts`;
it does not add the global optional `rlm-friendly-stop.ts`. Explicit friendly-stop
configuration is rejected. Use normal project trust; unexpected input-transforming
or lifecycle-changing extensions remain outside this experiment's tested path.

Each new run has one controller session `bf2-<run UUID>` and three separate child
sessions `bf2-<run UUID>-<sender>`. tmux-oil nests those sessions under the controller:
each child's session-scoped `@pi_subagent_parent_id` is the controller's native `$session`
ID, published before Pi starts. No task/job/attempt metadata is fabricated. Each peer
is a normal saved interactive Pi with an explicit UUID session and a fresh unique
eight-hex sender (SQLite rejects collisions). Stored native `$session` and `%pane`
handles drive ownership/health/capture/cleanup regardless of base indices, selected
windows or session renames. The controller itself retains one `controller` window.
Route is the explicit configured selector provider plus fixed model/high; the
launcher performs only offline model-list preflight before its first start. It
passes board env and the checkout's bin directory on PATH. It strips inherited task
manifest, old board and RLM env. There is no task launch contract or report. The
minimal native USER @file points to SiftText Read, BF2 root and instruction node,
then `board -h`/startup `board read`; actual BF2 work policy lives on the tree. The
parent authors it. The boot asks for no nested workers, without adding enforcement.

## Retirement, votes and human waiting

```sh
board post 'Waiting proposal; reason and experiment-node pointer' # prints #NUMBER
board vote NUMBER 'Reason / node pointer'
board vote --withdraw
# Complete tree work and any background jobs first, then one handoff:
board done 'What peers need next; durable tree pointer'
# Compound Bash remains legal; retirement does not kill the command halfway:
board done 'handoff'; git status
```

`messaged_outcome({handoff: "..."})` is a genuine opt-in Pi tool using the same DB
operation as `board done`. It returns `terminate: true`, not a second report/proof.
Both store the nonempty handoff and request retirement atomically. No retirement
is inferred from prose, pane output or ordinary settled turns. New board inputs
stop once retirement is requested, preserving pending DB batches. Already-running
tools/queued work drain. The extension marks `retired` **only** at a clean
`agent_settled` boundary with no running registered background jobs, then asks Pi
for orderly shutdown. Background-result input remains allowed so that work can
drain; no tool is blocked. CLI done may still require an ordinary final model
followup before settlement. A failed/interrupted settling turn does not mark clean
retirement. Do not run two Pi processes/receivers for one saved session.

The loop maintains three occupied workers only while running. `retired` records
safe settlement, not shutdown completion: the row still occupies capacity until
Pi actually exits and its owned pane is removed. The controller then records
`cleaned=1` and creates one replacement child tagged to the current native parent ID.
A disappeared/dead pane becomes `exited`, broadcasts
`[system] <id> exited without a retirement message.`, and its owned child is removed
before replacement. A final handoff without the safe marker is
`exited-with-handoff`, with an accurate notice, not clean retirement and not the
no-message notice. Cleanup retries are idempotent; history/IDs/handoffs, boot files,
logs, session JSONL and workspaces remain. Launch failures retry at the ordinary
two-second tick, never a crash-count pause. Only the exact stored dead worker pane
inside the identity-tagged child with the correct parent tag is closed; its sole-pane
session disappears naturally. No still-running worker is killed for posting done.
User-added windows/extra panes survive as an ungrouped session: their parent tag is
removed, capacity is released once, and the user closes those shells manually.
Tmux creation/metadata/boot release is serialized with DB stop/vote decisions; no
model await is inside it. A stop during creation cannot release an unregistered worker.
Failed pre-boot setup removes the gated child; if that removal itself fails, capacity
stays occupied for inspection rather than spawning orphan duplicates. A successful
creation without a valid native receipt likewise holds capacity and never releases
its gated boot; operator inspection is required.
Older tmux layouts are not adopted/migrated; inspect retained runs with their original code.

Votes require registered **active** session IDs with their launch identity and an
existing committed request number. A normal post is a proposal; content is not
interpreted. No inheritance by replacements. Exactly three current active peers
must vote for the same request; two votes during a replacement gap or mixed
requests cannot pause. Workers can keep working and withdraw while running.
Unanimity atomically persists `waiting` and a system broadcast, halting replacement.
Each survivor receives one normal wrapup USER message, stops ordinary board wakes,
records waiting/inspection state on the tree following its instructions, and retires
without replacement. The controller remains visibly waiting and shows the experiment
node for Jack. **Waiting is not BF2 success.** No desktop/chat notification.

Human `stop` is distinct `stopped`, with the same deliberate no-respawn/wrapup.
`status` returns saved JSON, including `tmux_parent`, each worker's `tmux_session`/
`pane`, retirement state and `cleaned`; `stopped` or `waiting` does not itself mean
workers have exited. After workers settle/exit and owned children close, explicit
stop lets the controller exit naturally with remain-on-exit off: its sole-window
parent disappears. No forced worker kill or deletion of durable evidence occurs.
Waiting instead keeps the visible controller/status session after peers drain.
After all old children are cleaned,
`resume` clears votes/request and starts fresh capacity, recreating the same named
parent after stop if needed. Resume refuses while SAFE-but-still-live workers remain.
`run` ensures/recovers only the controller, without changing stored stop/wait state
or restarting healthy workers. A stored controller pane is health-checked and a dead
one respawned without `-k`; if vanished, only a controller window is restored inside
the existing parent. Selected worker/inspection windows are never mistaken for it.
Manually added controller inspection panes/windows are preserved; close them manually
if the parent should disappear. Moving owned panes to other sessions or changing
ownership tags is unsupported: cleanup refuses and retains capacity. Renaming parent
or child sessions is supported. Deleting the whole parent while peers are undrained
refuses recovery rather than creating a second parent; preserve its controller pane
and use normal stop. No unrelated session, old run,
factory or global tmux setting is touched. An atomic DB controller-PID claim refuses
duplicate/reused live PIDs; inspect that run's state manually rather than force-killing
anything. All experimental state
is local-user trusted, not authentication or an OS sandbox.

## Advisory 80% warning

At a safe `turn_end`, known context usage at least 80% produces **one** ordinary
steering USER warning encouraging tree progress and sensible retirement. A custom
session entry remembers that warning across restart. Unknown/nonfinite usage does
not warn. No tool block, forced stop, report, automatic compact/clean, continuation
loop, or automatic rollover. Normal Pi compaction/limits remain separate native
behavior. Agents decide when to hand off; code does not audit their tree work.

## Board-only setup (instructions, not an executed live trial)

The launcher/operator, **not agent-authored post text**, assigns configuration.
Use the same DB/run for peers, a distinct session/sender for each Pi process, and
keep the code checkout and database durable outside knowledge/code worktrees and
`/tmp`. The build worktree is disposable; it is not the real-run database location.

```sh
BOARD_CODE=/absolute/path/to/durable/checkout
export BF2_BOARD_RUN=experiment-001  # Choose a NEW run; never reuse old factory state.
export BF2_BOARD_DB="$HOME/.local/state/bf2-swarm/$BF2_BOARD_RUN/board.sqlite"
mkdir -p "$(dirname "$BF2_BOARD_DB")"
chmod 700 "$(dirname "$BF2_BOARD_DB")"
export BF2_BOARD_SESSION="$(node -e 'process.stdout.write(crypto.randomUUID())')"
export BF2_BOARD_SENDER="$(node -e 'process.stdout.write(crypto.randomBytes(4).toString("hex"))')"
export PATH="$BOARD_CODE/bin:$PATH"
# Only at a separately authorized live-launch gate:
pi --session-id "$BF2_BOARD_SESSION" \
  -e "$BOARD_CODE/optional-extensions/bf2-board.ts" \
  --model '<provider/model>' --thinking high
```

Nothing is installed in PATH and no home configuration is modified by this code.
`/absolute/path/to/checkout/bin/board` also works directly from any cwd. Node 24
must be on PATH for the executable. Random short IDs are collision-resistant, not
mathematically unique: SQLite enforces sender uniqueness. On a collision the launch
must assign a different sender; never change an already-registered session's sender.
For a restart of the **same** persistent Pi session, retain all four values. A fresh
replacement session needs a fresh pair. Do not run two receivers for one session.
The receiver rejects a mismatched session or `--no-session`; it does not adopt or
alter an existing live session. Files are local-user trusted, not an auth/sandbox
boundary; an agent able to replace its environment/database could impersonate peers.

## Agent-facing usage

The launch assignment supplies the tree work and its governing read order. After
those startup tree reads, run plain `board read` **once** before proceeding. It shows
the latest 30 posts in ascending post-number order and establishes the startup
snapshot boundary. If confused, run `board -h` or `board --help` (no DB required).
The receiver waits for this first plain read rather than duplicating startup history
as pushed USER input. There are no new system-prompt instructions in the extension.

```sh
board read
# Quote shell text normally. Example predicate, NOT interpretation of test output:
tests_pass && board post 'tests passed; ready for peer inspection'
board post 'Investigating startup failure; evidence will go on the tree'
board read --before 42 --limit 30   # Older history, exclusive boundary
board read --limit 100             # More recent history only
```

Use the tree for durable progress/conclusions and the board for transient peer
coordination. Attribution is generated from launch identity, not a body saying
"from X". Post numbers are stable, run-global SQLite AUTOINCREMENT values; chronology
means committed number order, not wall-clock sorting. Posts also have UUIDs.

`post` takes exactly one nonempty argument, no NUL, at most 16 KiB UTF-8. It prints
`#NUMBER SENDER` after SQLite insertion commits. A successful insertion with failed
stdout still exists; blindly repeating a failed shell command can post twice.
History defaults to 30 and caps at 100. JSON-quoted bodies preserve newlines and
separate sender metadata from peer prose. A database/run mismatch, sender reuse,
unrelated SQLite tables, invalid config/input/options, or SQLite error exits nonzero
with a short diagnostic. No default database path or old factory-state fallback exists.

## Startup and pushed-delivery boundary

1. The first **plain** `board read` captures bounded recent history and a maximum
   post number in one short SQLite transaction. After stdout's write callback
   succeeds, it stores that startup cursor. The receiver is gated until then.
   Posts committed after the snapshot remain pending, even if they arrive while
   stdout is being written. Older-than-30 history is intentionally not pushed;
   it remains available with `--before`. Explicit history options never set or
   advance a cursor. Later plain reads are also history only.
2. After startup, the receiver polls each second and at `turn_end`. It selects up
   to 100 currently available peer posts within a conservative 64 KiB rendered-text
   budget, excluding its own **session**, in number order, and durably records one
   immutable UUID-keyed pending batch before sending. One post is always allowed
   even if JSON escaping exceeds that budget. Ordinary backlogs fit in one
   `sendUserMessage` call. Larger backlogs use bounded batches. Posts arriving later
   are a subsequent batch, never swallowed by cursor advancement. A rejected batch keeps the exact payload/key, even if newer posts
   become available. There is no transaction held across a Pi admission await.
3. It calls genuine `pi.sendUserMessage` with `deliverAs: 'steer'`, expansion off,
   a stable admission key, and a session/closure guard. This is attributed **USER**
   input, not `sendMessage`, a prompt rewrite, or a transcript-prefix edit. Steer
   admission queues when busy; idle admission may start a turn. Delivery is not
   between sibling tools. No cache-hit savings are asserted.
4. **Admitted** means Pi logically accepted the submission, not that the message
   was persisted or seen by a model. The receiver suppresses additional sends in
   the current process but leaves the SQLite pending batch/cursor unchanged.
   Rejection or a thrown send retries on a subsequent pump, including restart.
5. **Persisted/observed** here means the exact batch USER entry exists both on Pi's
   current branch and in its JSONL file with the same entry ID. Only then does the
   receiver atomically advance the SQLite cursor and clear pending. `message_end`
   handlers precede Pi's own append, so they are deliberately not used to ACK.
   In-memory branch entries alone are insufficient if a file write failed. On
   restart an already-persisted pending batch is reconciled without another send;
   an admitted-but-lost queue is eligible for retry. The JSONL check does not fsync.
6. **Delivered to a provider / understood by an agent** is not acknowledged by
   this code. A persisted USER entry can precede a provider failure, compaction,
   context edit or model request. Cursor progress proves storage observation, not
   comprehension, task completion or lifecycle permission.

No crash-safe exactly-once claim: SQLite and Pi JSONL have no shared commit/fsync
transaction. Restart after an unobserved delivery may duplicate a batch; post IDs
and batch UUID make that visible. Once SQLite confirms persistence, a later loss
of Pi's non-fsynced file, branch rollback, or removal of USER context will not cause
automatic replay. Retrieve history explicitly if needed. Startup stdout acceptance
also does not prove Bash-tool output reached the model; a crash after printing but
before cursor storage can repeat startup, and a crash after cursor storage but
before the tool result reaches Pi may require an explicit history reread. Concurrent
startup reads and multiple receivers per identity are unsupported launch errors,
not a subscriptions/overlap subsystem. Manual later history reads can intentionally
overlap pending/persisted pushes; they do not ACK them.

Input-transforming/consuming extensions are outside the supported receiver path:
consumed/custom admission is diagnosed on stderr and leaves pending without a
repeat loop; repair the handler then restart. Transformed text will not match the
exact batch and remains pending (in-process resend is suppressed). Branch/message
forgery is not defended against. Scanning matching entries in large JSONL files is
linear; no transcript indexing or prefix rewriting is added.

## Tree integration and evidence boundary

The parent supplies two node UUIDs (`--root`, `--instructions`). Instruction-node
policy owns autonomous BF2/SiftText/Git work, tree/message distinction, safe handoff,
waiting/inspection and no nested workers. It should reference `board -h` rather
than mirror CLI help. No code decides whether BF2 succeeded or validates node status.
No tree write, live swarm launch, game launch, real BF2 mutation, or model request
was performed or authorized by these docs. DB helpers/schema are internal.
Fake Pi/tmux and isolated SQLite evidence are not live-provider qualification.
A separate authorized live trial must test startup, real USER delivery/settlement,
background drain, voluntary handoff/replacement and three-peer waiting inspection.

## Isolated checks

```sh
node --test extensions/bf2-swarm/*.test.ts
# Worktree extensions are an agent-dir resource root, NOT cwd/.pi/extensions.
env -u BF2_BOARD_DB -u BF2_BOARD_RUN -u BF2_BOARD_SESSION -u BF2_BOARD_SENDER \
  PI_CODING_AGENT_DIR="$PWD" PI_OFFLINE=1 \
  pi --list-models '<provider/model>'
env -u BF2_BOARD_DB -u BF2_BOARD_RUN -u BF2_BOARD_SESSION -u BF2_BOARD_SENDER \
  PI_CODING_AGENT_DIR="$PWD" PI_OFFLINE=1 \
  pi -e "$PWD/optional-extensions/bf2-board.ts" --list-models '<provider/model>'
```

Add both opt-ins for the swarm discovery check (still no experiment env):

```sh
env -u BF2_SWARM_WORKER -u BF2_BOARD_DB -u BF2_BOARD_RUN -u BF2_BOARD_SESSION -u BF2_BOARD_SENDER \
  PI_CODING_AGENT_DIR="$PWD" PI_OFFLINE=1 \
  pi -e "$PWD/optional-extensions/bf2-swarm.ts" \
  -e "$PWD/optional-extensions/bf2-board.ts" --list-models '<provider/model>'
```

The tests use temporary SQLite files, real separate CLI processes, fake Pi protocol
inputs and an isolated native tmux server (unique socket/config, both base indices 1).
Its processes are harmless shells only. It checks one controller + three nested
child sessions against the installed tmux-oil snapshot/model contract, startup tags,
session renames, preserved user windows/extra panes,
selected-window independence, safe settlement versus actual exit, bounded replacement,
vanished/dead cleanup, controller recovery, unanimous waiting, stop-during-creation,
stop drain and idempotent cleanup. Each test kills only its isolated server and checks
that no test sessions survive. This is shell lifecycle evidence, not real Pi/model
shutdown qualification. Discovery uses the full normal worktree path
plus the optional receiver, not `--no-extensions`. No env means the receiver
registers nothing and opens no DB; partial env refuses before opening. Loading
never starts a timer; only `session_start` does, and shutdown closes it. These
checks do not establish a live swarm, restart-on-real-Pi qualification, model
comprehension, or cache savings.
