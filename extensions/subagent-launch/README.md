# Context recovery

The OpenAI context guard can pause a monitored task or dialogue instead of finalizing it as `Operation aborted`. The original guard message reaches the parent immediately through the existing outcome monitor. The batch remains pending.

When the parent receives that pause, call `subagent_clean_and_continue` with its `job_id`, `session_id`, and `attempt_id`. This is a local maintenance command, not `subagent_followup` and not a model request to the blocked child.

The operation:

1. Validates the monitored paused attempt and waits for a command-specific acknowledgement (up to 30 seconds).
2. Requires an idle worker with no queued messages. Refuses before cleaning if that prerequisite is missing, rather than discarding queued input. Outstanding child/background work no longer refuses the clean: the refresh is in place, and completion still gates on drained work.
3. Reuses `/tool-call-clean`'s backup, atomic rewrite and tool-output clearing. Thinking, assistant messages, custom state, report reservation, session and attempt identity are preserved.
4. Reloads the same session and checks the replacement runtime's context estimate. If there is insufficient space or reload is cancelled, the assignment stays paused.
5. Requests continuation under the same contract and monitor. The tool returns `resume_requested`; that is not task completion. The eventual report/outcome still goes through normal validation.

Ordinary follow-ups cannot replace a paused/recovering attempt. A timed-out or interrupted recovery command is not automatically replayed: it may already have executed. Inspect its retained acknowledgement before any manual intervention. No sibling is cancelled and no parent completion gate is released by a context pause.

A final monitored outcome closes that **attempt**, not the saved agent session. `subagent_followup` may start a fresh same-mode attempt in a still-live saved pane, with a fresh report path and the exact saved route. The child task contract accepts that new attempt too. A missing pane/session is still a transport failure; finality does not justify launching a replacement agent automatically.

## Busy follow-ups

`subagent_followup` accepts busy saved workers with `status: queued`, a fresh attempt, and a reserved fresh task report. This is acceptance, not START or completion. The current manifest and monitor remain authoritative until the old assignment settles. Outstanding task children must drain; a queued follow-up does not bypass context recovery or completion checks.

The local `/subagent-followup` command waits through Pi's native `waitForIdle()` and uses keyed `sendUserMessage` admission in the same session. Plain `deliverAs: "followUp"` alone would run inside the old agent loop, before its settlement, so it cannot safely switch task contracts. Replayed commands do not redeliver. Capable workers use this same admission path when apparently idle, closing the gap between pane status publication and the last native settlement handler; these receipts also say `queued`. Existing monitors still check pane health and durable outcomes; there is no polling-based delivery loop or replacement session. Reload the parent and saved worker to install the command. A busy worker without the session-bound capability advertisement is rejected before anything is pasted; older idle workers retain the legacy path. Crash/reload recovery of queued commands is not qualified.

The offline `node --test extensions/subagent-launch/busy-followup.test.ts` check uses a synthetic provider with real Pi admission, settlement, saved sessions, task/dialogue contracts and monitors on an isolated tmux socket. It is not a live-provider or full TUI-editor qualification.

## Scope and loading

Reload the parent before launching workers with this change. The launcher explicitly loads the recovery command in new children. Already-finalized failures, lost parent launcher state after restart, arbitrary provider overflows, automatic cleanup and checkpoint rollover are **not** implemented by this recovery path. It does not alter ordinary Pi shutdown or cancellation behavior.

Cleanup uses Pi's context estimator, not a promise about exact provider tokens; a subsequent oversized request can pause again. The parent chooses whether to clean, compact manually, or checkpoint into a fresh session. Cleaning cannot remove retained thinking or large user inputs.

## Regression check

```sh
env -u TMUX -u TMUX_PANE -u PI_SUBAGENT_MANIFEST PI_OFFLINE=1 \
  node --test extensions/subagent-launch/context-recovery.test.ts
```

The test owns a disposable tmux socket and uses a fake interactive child with real extension handlers, session storage, guard, monitor and parent tools. It supplies synthetic context usage rather than making a provider request. Coverage includes same-attempt completion, backup/content preservation, stale IDs, insufficient cleanup, busy workers, queued input, cancelled reload, pending children resumed through recovery, pause restoration and unchanged ordinary abort behavior. This verifies extension integration, not the complete real-provider/TUI lifecycle.

## Live qualification

A user-approved Luna task passed the real provider/TUI happy path on 2026-09-11: the native guard paused at ~300,373 estimated tokens, the parent received that actual reason, and `subagent_clean_and_continue` resumed the same job/attempt/session/report. The worker verified a preserved thinking block, progress marker and backup, then completed through the original monitor. A run-scoped tool supplied removable padding; request audit confirmed the blocked payload was stripped to 356 characters and the separate safety interlock did not fire. No global settings or production code changed for the trial.

The private qualification report and receipt-check script remain in machine-local evidence, not this public repository. This qualifies one live task path, not dialogue, every provider, cancellation or crash recovery.

## Subagent limits

Launch batches have no job-count cap. Subagents have no extension-imposed context threshold or forced reporting stop. Actual model context windows, provider failures, human cancellation and task-outcome requirements still apply. Context pauses can use the explicit `subagent_clean_and_continue` maintenance path above.

Restart existing workers to unload a previously loaded stop extension. Reload the parent before launching fresh workers.
