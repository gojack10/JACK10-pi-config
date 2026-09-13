# Context recovery

The OpenAI context guard can pause a monitored task or dialogue instead of finalizing it as `Operation aborted`. The original guard message reaches the parent immediately through the existing outcome monitor. The batch remains pending.

When the parent receives that pause, call `subagent_clean_and_continue` with its `job_id`, `session_id`, and `attempt_id`. This is a local maintenance command, not `subagent_followup` and not a model request to the blocked child.

The operation:

1. Validates the monitored paused attempt and waits for a command-specific acknowledgement (up to 30 seconds).
2. Requires an idle worker with no queued messages or outstanding child/background jobs. Refuses before cleaning if those prerequisites are missing, rather than discarding queued input.
3. Reuses `/tool-call-clean`'s backup, atomic rewrite and tool-output clearing. Thinking, assistant messages, custom state, report reservation, session and attempt identity are preserved.
4. Reloads the same session and checks the replacement runtime's context estimate. If there is insufficient space or reload is cancelled, the assignment stays paused.
5. Requests continuation under the same contract and monitor. The tool returns `resume_requested`; that is not task completion. The eventual report/outcome still goes through normal validation.

Ordinary follow-ups cannot replace a paused/recovering attempt. A timed-out or interrupted recovery command is not automatically replayed: it may already have executed. Inspect its retained acknowledgement before any manual intervention. No sibling is cancelled and no parent completion gate is released by a context pause.

A final monitored outcome closes that **attempt**, not the saved agent session. `subagent_followup` may start a fresh same-mode attempt in a still-live saved pane, with a fresh report path and the exact saved route/friendly settings. The child task contract accepts that new attempt too. A missing pane/session is still a transport failure; finality does not justify launching a replacement agent automatically.

## Scope and loading

Reload the parent before launching workers with this change. The launcher explicitly loads the guard and recovery command in new children. Already-finalized failures, lost parent launcher state after restart, arbitrary provider overflows, automatic cleanup, friendly-stop thresholds and checkpoint rollover are **not** implemented by this recovery path. It does not alter ordinary Pi shutdown or cancellation behavior.

Cleanup uses Pi's context estimator, not a promise about exact provider tokens; a subsequent oversized request can pause again. The parent chooses whether to clean, compact manually, or checkpoint into a fresh session. Cleaning cannot remove retained thinking or large user inputs.

## Regression check

```sh
env -u TMUX -u TMUX_PANE -u PI_SUBAGENT_MANIFEST PI_OFFLINE=1 \
  node --test extensions/subagent-launch/context-recovery.test.ts
```

The test owns a disposable tmux socket and uses a fake interactive child with real extension handlers, session storage, guard, monitor and parent tools. It supplies synthetic context usage rather than making a provider request. Coverage includes same-attempt completion, backup/content preservation, stale IDs, insufficient cleanup, busy workers, queued input, cancelled reload, pending children, pause restoration and unchanged ordinary abort behavior. This verifies extension integration, not the complete real-provider/TUI lifecycle.

## Live qualification

A user-approved Luna task passed the real provider/TUI happy path on 2026-09-11: the native guard paused at ~300,373 estimated tokens, the parent received that actual reason, and `subagent_clean_and_continue` resumed the same job/attempt/session/report. The worker verified a preserved thinking block, progress marker and backup, then completed through the original monitor. A run-scoped tool supplied removable padding; request audit confirmed the blocked payload was stripped to 356 characters and the separate safety interlock did not fire. No global settings or production code changed for the trial.

Evidence and runnable receipt check: `/Users/jack/.cache/pi-context-recovery-live.Ay1VVX/` (`report.md`, `verify-receipts.mjs`). This qualifies one live task path, not dialogue, every provider, cancellation or crash recovery.

## Opt-in friendly checkpoints

The launcher now explicitly loads the existing `optional-extensions/rlm-friendly-stop.ts`. Friendly stopping uses one shared **40–80%** band: checkpoint wrapping begins at 40% of the effective runtime context window, and the upper boundary at 80% takes control so ordinary work does not continue past it. These are estimator/tool-boundary bands, not exact provider-token promises. `gpt-6-astra` is the first automatic production opt-in; launching it needs no percentage argument. Its run/attempt-scoped checkpoint directory is created automatically when none is supplied. Other models remain unconfigured unless a run explicitly supplies the temporary `friendly_stop_percent` (integer **40–80**) opt-in and directory. Account-wrapper resolution does not change model identity.

Omitted opt-in means **no friendly limit**. Canonical launches scrub inherited friendly-stop variables, including legacy token limits, to prevent accidental propagation. Explicit legacy token mode still works when the optional extension is used standalone. The production opt-in list is separate from the shared band: Astra is enabled automatically, while Luna, GLM, and unlisted models are not permanent defaults. Explicit percentage inputs remain compatible as isolated temporary opt-ins and are bounded to 40–80; they do not create separate production policies.

Saved friendly settings are immutable for follow-ups, just like the saved model route: omit to inherit or repeat the saved values; changing or adding a limit requires a fresh launch. Reload the parent to expose the new launch-tool fields.

A saved checkpoint produces a nonfinal pause carrying its receipt path; it is not task completion. Parent cleanup resumes the same contract. Friendly monitoring resets only after that assignment's durable resume, and remains armed for a later crossing. A missing checkpoint at grace exhaustion produces an honest forced-stop pause/receipt instead of success or an unexplained abort. Pending messages/child work still prevent cleanup; fresh-worker transfer remains unimplemented.

Latest verification: **109 combined regression tests plus 3 argument-boundary tests passed**, including configured boot environment, no inherited opt-in, 40/50/65/80 on distinct windows and model IDs, nonfinal checkpoint transport, cleanup/re-arm, follow-up after a final task outcome, immutable follow-ups, forced-stop cause and existing recovery regressions. Normal discovery passed. Live Luna canaries at **50%, 65% and 80%, thinking off, all passed** with same-attempt checkpoint/cleanup/re-arm and final reports; independent `verify-cases.mjs` passed. GLM Flash was rejected before launch because Pi's current model definition does not support thinking `off`; no GLM provider request was made and cross-provider qualification remains blocked. Evidence and the partial table are in `/Users/jack/.cache/pi-friendly-stop-matrix.ZCTroH/`. These are synthetic-padding control-plane checks, not naturally full-context recall benchmarks.
