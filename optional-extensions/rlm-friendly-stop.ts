import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existingTaskOutcomeManager } from "../extensions/task-outcomes/manager.ts";

const STATE_TYPE = "rlm-friendly-stop-state";
const REPORT_TOOLS = new Set(["report_outcome", "read", "write", "edit", "bash", "bash_tail", "bash_jobs", "bash_kill", "get_current_session"]);
type State = { version: 2; jobId: string; attemptId: string };

export function registerFriendlyStop(pi: ExtensionAPI): void {
	let state: State | undefined;
	const restore = (ctx: ExtensionContext) => {
		state = undefined;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === STATE_TYPE && (entry.data as State)?.version === 2) {
				state = entry.data as State;
			}
		}
	};
	const wrapping = (ctx: ExtensionContext) => {
		const active = existingTaskOutcomeManager(ctx)?.snapshot().active;
		if (!active || active.state !== "active" || active.declaration) return;
		if (state?.jobId !== active.jobId || state.attemptId !== active.attemptId) {
			const usage = ctx.getContextUsage();
			if (!usage || usage.tokens === null || !Number.isFinite(usage.tokens) ||
				!Number.isFinite(usage.contextWindow) || usage.contextWindow <= 0 ||
				usage.tokens < Math.floor(usage.contextWindow * 0.8)) return;
			const next: State = { version: 2, jobId: active.jobId, attemptId: active.attemptId };
			// Persist before changing live policy so reload/branch selection retains the same wrap-up.
			pi.appendEntry(STATE_TYPE, next);
			state = next;
		}
		return active;
	};
	const instruction = (active: NonNullable<ReturnType<typeof wrapping>>) =>
		`FRIENDLY STOP: 80% of context reached. Stop new work now. Report what you have: findings, evidence, changes, unfinished work, and the exact next step. ` +
		(active.mode === "task" ? `Write the current report in place to ${JSON.stringify(active.reportPath)}, following the assignment's report format. ` : "Put the current findings in report_outcome's summary. ") +
		`Then call report_outcome with an honest outcome and summary, and end the turn. Follow the existing outcome contract; do not claim unfinished assignment work is complete. ` +
		`There is no report length or wrap-up turn limit. Do not create a rollover packet, call a checkpoint tool, clean tool outputs, compact context, or launch more work. Drain already-running child/background work before declaring completed.`;

	pi.on("session_start", (_event, ctx) => restore(ctx));
	pi.on("session_tree", (_event, ctx) => restore(ctx));
	pi.on("turn_end", (_event, ctx) => { wrapping(ctx); });
	pi.on("context", (event, ctx) => {
		const active = wrapping(ctx);
		if (!active) return;
		return { messages: [...event.messages, {
			role: "custom" as const, customType: STATE_TYPE, content: instruction(active), display: true, timestamp: Date.now(),
		}] };
	});
	pi.on("agent_before_settle", (event, ctx) => {
		// Never countermand Escape, provider failure, maintenance, or an existing continuation.
		if (event.outcome !== "completed" || event.continue) return;
		const active = wrapping(ctx);
		if (!active || active.pendingWork.length) return;
		return { continue: true, entries: [{
			type: "custom_message" as const, customType: STATE_TYPE, content: instruction(active), display: true,
		}] };
	});
	pi.on("tool_call", (event, ctx) => {
		if (!wrapping(ctx) || REPORT_TOOLS.has(event.toolName)) return;
		return { block: true, reason: "Friendly stop is active: stop new work, write your current report, then call report_outcome." };
	});
}

export default function (pi: ExtensionAPI) {
	registerFriendlyStop(pi);
}
