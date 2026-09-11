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
