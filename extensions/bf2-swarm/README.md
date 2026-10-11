# BF2 broadcast board — communication slice only

Dependency-free Node 24 `node:sqlite` CLI plus an optional Pi USER-input receiver.
One dedicated database is one broadcast run. No model calls in the CLI; no broker,
routing, ACK rules, subscriptions, threads, joining/retirement, votes, replacement
controller, or 80% stop policy. Existing factory/outcome/settings code is untouched.

## Later launch setup (instructions, not an executed live trial)

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

## Integration surface for the next lifecycle slice

Stable surface: the four `BF2_BOARD_*` variables, executable `bin/board` with
`post`, `read`, help/history options, and explicit optional extension path
`optional-extensions/bf2-board.ts`. Launch with `--session-id` matching the env,
keep session JSONL durable, and pass a normal USER mission containing the startup
read sequence above. The lifecycle owner assigns identities, starts/stops peers,
and separately implements completion/voting/warning policy. A board post is not
`report_outcome`, `messaged_outcome`, or a finish/vote signal. No live launch is
performed or authorized by these docs. DB helper exports/schema are implementation
details, not a controller protocol. No existing controller needs changing for this
CLI/optional-receiver slice.

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

The tests use temporary SQLite files, real separate CLI processes, and fake Pi
USER/admission/session-file inputs. Discovery uses the full normal worktree path
plus the optional receiver, not `--no-extensions`. No env means the receiver
registers nothing and opens no DB; partial env refuses before opening. Loading
never starts a timer; only `session_start` does, and shutdown closes it. These
checks do not establish a live swarm, restart-on-real-Pi qualification, model
comprehension, or cache savings.
