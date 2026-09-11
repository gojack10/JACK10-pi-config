import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { link, mkdir, open, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { Type } from "typebox";
import { existingTaskOutcomeManager } from "../extensions/task-outcomes/manager.ts";

const STATE_TYPE = "rlm-friendly-stop-state";
const STATE_VERSION = 1;
const READ_ONLY_SIFTTEXT = new Set(["sifttext_get_node", "sifttext_get_outline", "sifttext_sql"]);
const INSTRUCTION =
	"RLM ROLLOVER REQUIRED. Start no new work and make no SiftText/ideation mutations. Preserve exact execution state for the replacement model: completed operation IDs, the exact next operation, symbolic UUID bindings, failures, and receipt paths. Call rlm_rollover_checkpoint as your FINAL action; do not respond after it.";

type Usage = { tokens: number | null; contextWindow: number; percent: number | null };
type Phase = "armed" | "turn-queued" | "injected" | "checkpoint" | "forced" | "reset";
type State = {
	version: 1;
	phase: Phase;
	threshold: number;
	upperThreshold: number;
	usage: Usage | null;
	wrapupTurns: number;
	receiptPath?: string;
	reason?: string;
	pausedTask?: { jobId: string; attemptId: string };
};

type Env = Record<string, string | undefined>;

type Config = { threshold?: number; model?: string; percent?: number; directory: string; graceTurns: number };
const PRODUCTION_MODEL = "gpt-6-astra";
const LOWER_PERCENT = 50;
const UPPER_PERCENT = 80;

function positiveInteger(value: string | undefined): number | undefined {
	if (!value || !/^\d+$/.test(value)) return;
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < 1) return;
	return parsed;
}

function config(env: Env): Config | undefined {
	const legacyThreshold = positiveInteger(env.PI_RLM_FRIENDLY_STOP_TOKENS);
	const model = env.PI_RLM_FRIENDLY_STOP_MODEL;
	const parsedPercent = positiveInteger(env.PI_RLM_FRIENDLY_STOP_PERCENT);
	const percent = parsedPercent !== undefined && parsedPercent >= 50 && parsedPercent <= 80 ? parsedPercent : undefined;
	const directory = env.PI_RLM_ROLLOVER_DIR;
	const graceTurns = positiveInteger(env.PI_RLM_FRIENDLY_STOP_GRACE_TURNS) ?? 2;
	if (!directory || !isAbsolute(directory)) return;
	if (legacyThreshold) return { threshold: legacyThreshold, directory, graceTurns };
	if (env.PI_RLM_FRIENDLY_STOP_PERCENT !== undefined && percent === undefined) return;
	if (model && (percent !== undefined || model === PRODUCTION_MODEL)) return { model, percent, directory, graceTurns };
	return;
}

export function friendlyStopThreshold(contextWindow: number, percent: number): number {
	return Math.floor(contextWindow * percent / 100);
}

function safePart(value: string | null | undefined): string {
	return (value || "none").replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 80);
}

/** Publish a complete file with a hard-link commit: atomic and incapable of overwriting. */
export async function writeReceipt(directory: string, prefix: string, value: unknown): Promise<string> {
	await mkdir(directory, { recursive: true });
	const temporary = join(directory, `.${prefix}.${process.pid}.${crypto.randomUUID()}.tmp`);
	const handle = await open(temporary, "wx", 0o600);
	try {
		await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
		await handle.sync();
	} finally {
		await handle.close();
	}
	try {
		for (let suffix = 0; ; suffix++) {
			const target = join(directory, `${prefix}${suffix ? `-${suffix}` : ""}.json`);
			try {
				await link(temporary, target);
				return target;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			}
		}
	} finally {
		await unlink(temporary).catch(() => {});
	}
}

function isIdeationMutation(name: string): boolean {
	return (name.startsWith("sifttext_") && !READ_ONLY_SIFTTEXT.has(name)) ||
		name.startsWith("ideation_") || name.startsWith("sift_");
}

export function registerFriendlyStop(pi: ExtensionAPI, env: Env = process.env): boolean {
	const enabled = config(env);
	if (!enabled) return false;

	let state: State | undefined;
	let shuttingDown = false;

	const persist = () => pi.appendEntry(STATE_TYPE, state);
	const usage = (ctx: ExtensionContext): Usage | null => ctx.getContextUsage() ?? null;
	const show = (ctx: ExtensionContext, message: string, kind: "info" | "warning" = "info") => {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus("rlm-friendly-stop", message);
		ctx.ui.notify(message, kind);
	};
	const arm = (ctx: ExtensionContext): boolean => {
		const current = usage(ctx);
		const identity = ctx.model?.id ?? "";
		const threshold = enabled.threshold ?? (current && Number.isFinite(current.contextWindow) && current.contextWindow > 0
			? friendlyStopThreshold(current.contextWindow, enabled.percent ?? LOWER_PERCENT) : undefined);
		const upperThreshold = current && Number.isFinite(current.contextWindow) && current.contextWindow > 0
			? friendlyStopThreshold(current.contextWindow, UPPER_PERCENT) : undefined;
		if (state || threshold === undefined || upperThreshold === undefined || threshold < 1 || (enabled.model && enabled.model !== identity) ||
			current?.tokens === null || current === null || current.tokens < threshold) return false;
		state = { version: STATE_VERSION, phase: "armed", threshold, upperThreshold, usage: current, wrapupTurns: 0 };
		persist();
		show(ctx, `RLM rollover armed at ${current.tokens.toLocaleString()} tokens`, "warning");
		return true;
	};
	const queueCheckpointTurn = (ctx: ExtensionContext, reminder = false) => {
		if (!state || state.phase === "checkpoint" || state.phase === "forced" || state.phase === "turn-queued") return;
		state = { ...state, phase: "turn-queued" };
		persist();
		pi.sendMessage({
			customType: STATE_TYPE,
			content: reminder ? `REMINDER: ${INSTRUCTION}` : INSTRUCTION,
			display: true,
		}, { triggerTurn: true, deliverAs: "followUp" });
		show(ctx, reminder ? "RLM checkpoint reminder requested" : "RLM checkpoint turn requested", "warning");
	};
	const restoreQueuedTurn = (ctx: ExtensionContext) => {
		if (state?.phase !== "turn-queued") return;
		// Pi's in-memory message queue does not survive reload; replay the single persisted queue state.
		pi.sendMessage({ customType: STATE_TYPE, content: INSTRUCTION, display: true }, { triggerTurn: true, deliverAs: "followUp" });
		show(ctx, "RLM checkpoint turn restored", "warning");
	};
	const metadata = (ctx: ExtensionContext) => ({
		stateVersion: STATE_VERSION,
		thresholdTokens: state?.threshold ?? enabled.threshold ?? null,
		upperThresholdTokens: state?.upperThreshold ?? null,
		currentUsage: usage(ctx),
		session: {
			id: ctx.sessionManager.getSessionId(),
			file: ctx.sessionManager.getSessionFile() ?? null,
			leaf: ctx.sessionManager.getLeafId(),
		},
		model: {
			provider: ctx.model?.provider ?? null,
			id: ctx.model?.id ?? null,
			thinking: ctx.thinkingLevel ?? null,
		},
		timestamp: new Date().toISOString(),
	});
	const pauseTask = (ctx: ExtensionContext, reason: string): State["pausedTask"] => {
		const task = existingTaskOutcomeManager(ctx);
		const active = task?.snapshot().active;
		if (!active) return; // Standalone legacy use has no tracked assignment.
		if (!task!.pauseForContext(reason, state!.threshold)) throw new Error("friendly stop could not record its pause");
		return { jobId: active.jobId, attemptId: active.attemptId };
	};
	const forceStop = async (ctx: ExtensionContext, cause = `checkpoint tool not called within ${enabled.graceTurns} wrap-up turns`) => {
		if (!state || state.phase === "forced" || state.phase === "checkpoint" || state.phase === "reset") return;
		const trusted = metadata(ctx);
		const receiptPath = await writeReceipt(
			enabled.directory,
			`forced-stop-${safePart(trusted.session.id)}-${safePart(trusted.session.leaf)}`,
			{ kind: "forced-stop", reason: cause, trusted },
		);
		const pauseReason = cause.startsWith("checkpoint tool")
			? `Friendly checkpoint missing: ${cause} (grace exhausted)`
			: `Friendly stop took control: ${cause}`;
		const pausedTask = pauseTask(ctx, `${pauseReason}; forced-stop receipt: ${receiptPath}`);
		state = { ...state, phase: "forced", usage: trusted.currentUsage, receiptPath, reason: pauseReason, pausedTask };
		persist();
		show(ctx, `${pauseReason}; aborting`, "warning");
		ctx.abort();
	};

	pi.registerTool({
		name: "rlm_rollover_checkpoint",
		label: "RLM Rollover Checkpoint",
		description: "Write the exact replacement-model checkpoint and terminate. Call only when RLM rollover is requested, as the final action.",
		promptSnippet: "Write the terminating RLM rollover checkpoint",
		promptGuidelines: ["Call rlm_rollover_checkpoint as the final action when the RLM rollover instruction appears."],
		executionMode: "sequential",
		parameters: Type.Object({
			completedOperationIds: Type.Array(Type.String()),
			nextOperation: Type.String(),
			symbolicUuidBindings: Type.Record(Type.String(), Type.String()),
			failures: Type.Array(Type.Object({
				operationId: Type.Optional(Type.String()),
				error: Type.String(),
			})),
			receiptPaths: Type.Array(Type.String()),
			notes: Type.String({ maxLength: 4000 }),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			if (!state || (state.phase !== "armed" && state.phase !== "injected")) {
				throw new Error("RLM rollover has not been requested, or a checkpoint already exists.");
			}
			const trusted = metadata(ctx);
			const receiptPath = await writeReceipt(
				enabled.directory,
				`checkpoint-${safePart(trusted.session.id)}-${safePart(trusted.session.leaf)}`,
				{ kind: "rollover-checkpoint", trusted, reported: params },
			);
			const pausedTask = pauseTask(ctx, `Friendly checkpoint saved: ${receiptPath}`);
			state = { ...state, phase: "checkpoint", usage: trusted.currentUsage, receiptPath, pausedTask };
			persist();
			show(ctx, "RLM rollover checkpoint saved");
			return {
				content: [{ type: "text", text: `Checkpoint saved: ${receiptPath}` }],
				details: { receiptPath, trusted },
				terminate: true,
			};
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		state = undefined;
		shuttingDown = false;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === STATE_TYPE &&
				(entry.data as State | undefined)?.version === STATE_VERSION) state = entry.data as State;
		}
		// Older persisted states had only the lower threshold; derive the shared upper bound.
		if (state && state.upperThreshold === undefined && state.usage?.contextWindow) {
			state = { ...state, upperThreshold: friendlyStopThreshold(state.usage.contextWindow, UPPER_PERCENT) };
		}
		if (state?.phase === "reset") state = undefined;
		if (existingTaskOutcomeManager(ctx)?.snapshot().active?.state === "context_paused") {
			// Reload is maintenance, not permission to start a checkpoint model turn.
			// A lost queued instruction will instead be injected after parent resume.
			if (state?.phase === "turn-queued") { state = { ...state, phase: "armed" }; persist(); }
			return;
		}
		if (!state && arm(ctx)) queueCheckpointTurn(ctx);
		else if (state?.phase === "armed") queueCheckpointTurn(ctx);
		else if (state?.phase === "turn-queued") restoreQueuedTurn(ctx);
		else if (state?.phase === "injected") {
			if (state.wrapupTurns >= enabled.graceTurns) await forceStop(ctx);
			else queueCheckpointTurn(ctx, true);
		}
	});
	pi.on("agent_start", (_event, ctx) => {
		if (shuttingDown || !state?.pausedTask || !["checkpoint", "forced"].includes(state.phase)) return;
		const active = existingTaskOutcomeManager(ctx)?.snapshot().active;
		if (active?.state !== "active" || active.jobId !== state.pausedTask.jobId || active.attemptId !== state.pausedTask.attemptId) return;
		// withSession resumes AFTER session_start. Require that exact assignment's
		// durable resume after this checkpoint, not an old resume or unrelated job.
		const branch = ctx.sessionManager.getBranch();
		const checkpointIndex = branch.findLastIndex(entry => entry.type === "custom" && entry.customType === STATE_TYPE);
		if (!branch.slice(checkpointIndex + 1).some(entry => entry.type === "custom" && entry.customType === "task-outcome/v1" &&
			(entry.data as any)?.kind === "context_resume" && (entry.data as any).jobId === active.jobId && (entry.data as any).attemptId === active.attemptId)) return;
		state = { version: STATE_VERSION, phase: "reset", threshold: state.threshold, upperThreshold: state.upperThreshold, usage: usage(ctx), wrapupTurns: 0 };
		persist();
		state = undefined;
		arm(ctx);
	});
	pi.on("session_shutdown", () => { shuttingDown = true; });
	pi.on("turn_end", (_event, ctx) => { if (!shuttingDown) arm(ctx); });
	pi.on("context", async (event, ctx) => {
		if (shuttingDown) return;
		if (!state) arm(ctx);
		if (!state || state.phase === "checkpoint" || state.phase === "forced" || state.phase === "reset") return;
		const current = usage(ctx);
		if (current?.tokens !== null && current !== null && current.tokens >= state.upperThreshold) {
			await forceStop(ctx, `shared friendly-stop upper boundary reached at ${state.upperThreshold} estimated tokens`);
			return;
		}
		if (state.wrapupTurns >= enabled.graceTurns) {
			await forceStop(ctx);
			return;
		}
		const inject = state.phase === "armed";
		state = { ...state, phase: "injected", wrapupTurns: state.wrapupTurns + 1 };
		persist();
		if (!inject) return;
		return {
			messages: [...event.messages, {
				role: "custom" as const,
				customType: STATE_TYPE,
				content: INSTRUCTION,
				display: true,
				timestamp: Date.now(),
			}],
		};
	});
	pi.on("agent_settled", async (_event, ctx) => {
		if (shuttingDown || !state || state.phase === "checkpoint" || state.phase === "forced" || state.phase === "reset" || state.phase === "turn-queued") return;
		if (state.phase === "armed") queueCheckpointTurn(ctx);
		else if (state.wrapupTurns >= enabled.graceTurns) await forceStop(ctx);
		else queueCheckpointTurn(ctx, true);
	});
	pi.on("tool_call", (event) => {
		if (!state || state.phase === "checkpoint" || state.phase === "forced" || !isIdeationMutation(event.toolName)) return;
		return {
			block: true,
			reason: "RLM rollover is active: SiftText/ideation mutations are blocked. Read if needed, then call rlm_rollover_checkpoint as your final action.",
		};
	});
	return true;
}

export default function (pi: ExtensionAPI) {
	registerFriendlyStop(pi);
}
