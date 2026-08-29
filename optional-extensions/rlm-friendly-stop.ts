import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { link, mkdir, open, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { Type } from "typebox";

const STATE_TYPE = "rlm-friendly-stop-state";
const STATE_VERSION = 1;
const READ_ONLY_SIFTTEXT = new Set(["sifttext_get_node", "sifttext_get_outline", "sifttext_sql"]);
const INSTRUCTION =
	"RLM ROLLOVER REQUIRED. Start no new work and make no SiftText/ideation mutations. Preserve exact execution state for the replacement model: completed operation IDs, the exact next operation, symbolic UUID bindings, failures, and receipt paths. Call rlm_rollover_checkpoint as your FINAL action; do not respond after it.";

type Usage = { tokens: number | null; contextWindow: number; percent: number | null };
type Phase = "armed" | "turn-queued" | "injected" | "checkpoint" | "forced";
type State = {
	version: 1;
	phase: Phase;
	threshold: number;
	usage: Usage | null;
	wrapupTurns: number;
	receiptPath?: string;
	reason?: string;
};

type Env = Record<string, string | undefined>;

function positiveInteger(value: string | undefined): number | undefined {
	if (!value || !/^\d+$/.test(value)) return;
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < 1) return;
	return parsed;
}

function config(env: Env) {
	const threshold = positiveInteger(env.PI_RLM_FRIENDLY_STOP_TOKENS);
	const directory = env.PI_RLM_ROLLOVER_DIR;
	const graceTurns = positiveInteger(env.PI_RLM_FRIENDLY_STOP_GRACE_TURNS) ?? 2;
	if (!threshold || !directory || !isAbsolute(directory)) return;
	return { threshold, directory, graceTurns };
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
		if (state || current?.tokens === null || current === null || current.tokens < enabled.threshold) return false;
		state = { version: STATE_VERSION, phase: "armed", threshold: enabled.threshold, usage: current, wrapupTurns: 0 };
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
		thresholdTokens: state?.threshold ?? enabled.threshold,
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
	const forceStop = async (ctx: ExtensionContext) => {
		if (!state || state.phase === "forced" || state.phase === "checkpoint") return;
		const trusted = metadata(ctx);
		const receiptPath = await writeReceipt(
			enabled.directory,
			`forced-stop-${safePart(trusted.session.id)}-${safePart(trusted.session.leaf)}`,
			{ kind: "forced-stop", reason: `checkpoint tool not called within ${enabled.graceTurns} wrap-up turns`, trusted },
		);
		state = { ...state, phase: "forced", usage: trusted.currentUsage, receiptPath, reason: "grace-exhausted" };
		persist();
		show(ctx, "RLM rollover grace exhausted; aborting", "warning");
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
			state = { ...state, phase: "checkpoint", usage: trusted.currentUsage, receiptPath };
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
		if (!state && arm(ctx)) queueCheckpointTurn(ctx);
		else if (state?.phase === "armed") queueCheckpointTurn(ctx);
		else if (state?.phase === "turn-queued") restoreQueuedTurn(ctx);
		else if (state?.phase === "injected") {
			if (state.wrapupTurns >= enabled.graceTurns) await forceStop(ctx);
			else queueCheckpointTurn(ctx, true);
		}
	});
	pi.on("session_shutdown", () => { shuttingDown = true; });
	pi.on("turn_end", (_event, ctx) => { if (!shuttingDown) arm(ctx); });
	pi.on("context", async (event, ctx) => {
		if (shuttingDown) return;
		if (!state) arm(ctx);
		if (!state || state.phase === "checkpoint" || state.phase === "forced") return;
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
		if (shuttingDown || !state || state.phase === "checkpoint" || state.phase === "forced" || state.phase === "turn-queued") return;
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
