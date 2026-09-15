# In-place maintenance

Maintenance is a same-runtime transcript refresh. `TaskOutcomeManager.beginMaintenance()` journals a durable marker and fences new background launches, `AgentSessionRuntime` drains the current run, validates the unchanged session identity/header and sealed leaf, reloads the transcript into the existing `SessionManager`/`AgentSession`, and notifies the existing UI. It emits no `session_shutdown` or `session_start` and never disposes or recreates the runtime.

Live child monitors and background processes remain owned by their existing manager. Their later receipts/completions continue through the same callbacks while maintenance is active; resuming the lease only clears the maintenance fence. Pending work is still rejected by `report_outcome completed`; context recovery no longer rejects it because the in-place refresh keeps live child monitors and background processes owned by their existing manager, so child results are neither lost nor duplicated.

The former park/adopt/lease transfer machinery is deliberately absent: no extension handoff registries, manager claims, queue capture/restore, replacement anchor token, or maintenance lifecycle events are used. Ordinary resume/new/fork still use the normal teardown and replacement path.

## Retained guardrails

- durable maintenance marker, current-file and session-id checks;
- selected branch/leaf and session header validation before the in-place refresh;
- idle and no-queued-message checks for session-only maintenance;
- typed context stops, historical cancellation release, finality/absorption, and exactly-once task outcomes;
- completion-time pending-work rejection;
- background launch fencing during the short maintenance window.

Deterministic tests cover refresh identity/lifecycle behavior, repeated/concurrent refresh, live child/background work, delayed child results, and the unchanged ordinary lifecycle path.
