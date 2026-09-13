import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { constants } from "node:fs";
import { open, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MaintenanceHandoff } from "./_shared/maintenance.ts";

type TaskOutcomeEvent = {
	sessionId: string;
	sessionFile?: string;
	outcome: string;
	jobId: string;
	attemptId: string;
	mode?: "task" | "dialogue";
	source?: "model" | "technical" | "protocol" | "transport";
	final?: boolean;
	summary?: string;
	reportPath?: string;
	reportText?: string;
	pauseId?: string;
	maintenanceId?: string;
	ownerEpoch?: string;
	phase?: string;
};

type ArtifactIdentity = { dev: string; ino: string };
const redactSensitiveText = (value: string): string =>
	value.replace(/\b(api[_-]?key|token|password|secret|authorization)\b(\s*[:=]\s*)(?:bearer\s+)?\S+/gi, "$1$2[redacted]");
const errorMessage = (error: unknown): string => {
	const message = error instanceof Error ? error.message : String(error);
	return redactSensitiveText(message.replace(/[\0\x01-\x08\x0b\x0c\x0e-\x1f\x7f]/g, " ").replace(/[\r\n\t]+/g, " ").trim().slice(0, 2048) || "unknown error");
};

const writeArtifact = async (prefix: string, text: string): Promise<{ path: string; identity: ArtifactIdentity }> => {
	const path = join(tmpdir(), `${prefix}-${process.pid}-${randomUUID()}`);
	const file = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
	try {
		await file.writeFile(text, "utf8");
		const info = await file.stat();
		return { path, identity: { dev: String(info.dev), ino: String(info.ino) } };
	} finally {
		await file.close();
	}
};
const taskOutcomeEventStatus = (value: unknown): value is TaskOutcomeEvent =>
	!!value && typeof value === "object" &&
	typeof (value as any).sessionId === "string" &&
	typeof (value as any).jobId === "string" &&
	typeof (value as any).attemptId === "string" &&
	typeof (value as any).outcome === "string";

const START_CHANNEL_OPTION = "@pi_start_channel";
const DONE_CHANNEL_OPTION = "@pi_done_channel";
const SESSION_FILE_OPTION = "@pi_session_file";
const SETTLED_CHANNEL_OPTION = "@pi_settled_channel";
const SETTLED_GENERATION_OPTION = "@pi_settled_generation";
const START_GENERATION_OPTION = "@pi_start_generation";
const OUTCOME_CHANNEL_OPTION = "@pi_outcome_channel";
const OUTCOME_OPTION = "@pi_outcome";
const OUTCOME_GENERATION_OPTION = "@pi_outcome_generation";

// ponytail: Pi exposes no post-command event; extension commands bypass `input`
// (docs/extensions.md, “Lifecycle Overview” and “Input Events”). Keep local
// command ACKs command-specific until a real completion hook exists.
interface SignalState {
	ownerSessionId?: string;
	pendingOutcomes: unknown[];
	outcomeQueue: Promise<void>;
	pendingOutcomePublication?: Promise<boolean>;
}

const handoffKey = Symbol.for("pi.tmux-turn-signal.maintenance-handoffs");
const globalState = globalThis as typeof globalThis & {
	[handoffKey]?: Map<string, { state: SignalState; lease: MaintenanceHandoff }>;
};
const handoffs = globalState[handoffKey] ??= new Map();

export default function (pi: ExtensionAPI) {
	let activePi = pi;
	let signalState: SignalState = {
		pendingOutcomes: [],
		outcomeQueue: Promise.resolve(),
	};
	const execChecked = async (command: string, args: string[]) => {
		if (typeof activePi.execChecked === "function") return activePi.execChecked(command, args);
		const value = await activePi.exec(command, args);
		return value.code === 0 && !value.killed
			? { ok: true as const, value }
			: {
				ok: false as const,
				error: {
					command: command.split(/[\\/]/).at(-1) || command,
					code: value.code,
					killed: value.killed,
					diagnostic: redactSensitiveText(value.stderr.trim().slice(0, 1024)) || undefined,
				},
			};
	};
	const recordError = (record: Parameters<ExtensionAPI["recordError"]>[0]) => {
		if (typeof activePi.recordError === "function") return activePi.recordError(record);
		activePi.appendEntry("pi-error/v1", record);
		return "";
	};
	const execTmux = async (args: string[]) => {
		const result = await execChecked("tmux", args);
		if (!result.ok) {
			const status = result.error.killed ? `exited ${result.error.code} (killed)` : `exited ${result.error.code}`;
			throw new Error(`tmux ${status}${result.error.diagnostic ? `: ${result.error.diagnostic}` : ""}`);
		}
		return result.value;
	};
	const readOption = async (pane: string, optionName: string) => {
		const result = await execChecked("tmux", ["show-options", "-qv", "-t", pane, optionName]);
		// tmux uses a nonzero empty result for an unset option.
		if (!result.ok) {
			if (result.error.code === 1 && !result.error.killed && !result.error.diagnostic) return "";
			const status = result.error.killed ? `exited ${result.error.code} (killed)` : `exited ${result.error.code}`;
			throw new Error(`tmux ${status}${result.error.diagnostic ? `: ${result.error.diagnostic}` : ""}`);
		}
		return result.value.stdout.trim();
	};

	const signal = async (pane: string, optionName: string, clear = true) => {
		const channel = await readOption(pane, optionName);
		if (!channel) return;

		if (clear) await execTmux(["set-option", "-qu", "-t", pane, optionName]);
		await execTmux(["wait-for", "-S", channel]);
	};

	const settledChannel = async (pane: string) => {
		const current = await readOption(pane, SETTLED_CHANNEL_OPTION);
		if (current) return current;

		const channel = `pi-settled-${pane.replace("%", "pane-")}-${process.pid}-${Date.now()}`;
		await execTmux(["set-option", "-q", "-t", pane, SETTLED_CHANNEL_OPTION, channel]);
		return channel;
	};

	const saveSessionFile = async (pane: string, sessionFile?: string) => {
		if (sessionFile) {
			await execTmux(["set-option", "-q", "-t", pane, SESSION_FILE_OPTION, sessionFile]);
		}
	};

	const cleanupArtifact = async (path: string) => {
		try {
			await unlink(path);
		} catch (error) {
			console.error(`[tmux-turn-signal] publication cleanup failed: ${errorMessage(error)}`);
		}
	};

	const publishOutcome = async (payload: TaskOutcomeEvent) => {
		const pane = process.env.TMUX_PANE;
		if (!pane) return;
		let reportArtifact: { path: string; identity: ArtifactIdentity } | undefined;
		let receiptArtifact: { path: string; identity: ArtifactIdentity } | undefined;
		let published = false;
		try {
			const existingChannel = await readOption(pane, OUTCOME_CHANNEL_OPTION);
			const channel = existingChannel ||
				`pi-outcome-${pane.replace("%", "pane-")}-${process.pid}-${Date.now()}`;
			if (!existingChannel) {
				await execTmux(["set-option", "-q", "-t", pane, OUTCOME_CHANNEL_OPTION, channel]);
			}
			const generation = Number.parseInt(await readOption(pane, OUTCOME_GENERATION_OPTION), 10);
			if (payload.reportText !== undefined) {
				reportArtifact = await writeArtifact("pi-subagent-dialogue-report", payload.reportText);
			}
			const receipt = {
				version: 1,
				session_id: payload.sessionId,
				job_id: payload.jobId,
				attempt_id: payload.attemptId,
				mode: payload.mode,
				outcome: payload.outcome,
				source: payload.source,
				final: payload.final,
				pause_id: payload.pauseId,
				summary: payload.summary,
				report: payload.reportPath,
				session_file: payload.sessionFile,
				transport_report_path: reportArtifact?.path,
				transport_report_identity: reportArtifact?.identity,
				transport_report_present: payload.reportText !== undefined,
			};
			receiptArtifact = await writeArtifact("pi-subagent-outcome", JSON.stringify(receipt));
			const outcome = JSON.stringify({
				session_id: payload.sessionId,
				job_id: payload.jobId,
				attempt_id: payload.attemptId,
				mode: payload.mode,
				outcome: payload.outcome,
				source: payload.source,
				final: payload.final,
				receipt_path: receiptArtifact.path,
				receipt_identity: receiptArtifact.identity,
			});
			await execTmux(["set-option", "-q", "-t", pane, OUTCOME_OPTION, outcome]);
			published = true;
			// Generation is the commit point. A signal failure must not make the
			// monitor mistake a partially delivered outcome for a successful one.
			await execTmux(["wait-for", "-S", channel]);
			await execTmux([
				"set-option", "-q", "-t", pane, OUTCOME_GENERATION_OPTION,
				String(Number.isSafeInteger(generation) ? generation + 1 : 1),
			]);
		} catch (error) {
			try {
				recordError({
					version: 1,
					source: "subagent",
					operation: "outcome_publication",
					message: errorMessage(error),
					correlation: {
						session_id: payload.sessionId,
						job_id: payload.jobId,
						attempt_id: payload.attemptId,
					},
				});
			} catch (recordError) {
				console.error(`[tmux-turn-signal] outcome failure record unavailable: ${errorMessage(recordError)}`);
			}
			if (!published) await Promise.all([
				reportArtifact && cleanupArtifact(reportArtifact.path),
				receiptArtifact && cleanupArtifact(receiptArtifact.path),
			]);
			throw error;
		}
	};

	const deliverOutcome = (payload: TaskOutcomeEvent): Promise<boolean> => {
		const publication = signalState.outcomeQueue.then(() => publishOutcome(payload));
		signalState.outcomeQueue = publication.catch(error => {
			console.error(`[tmux-turn-signal] outcome publication failed: ${errorMessage(error)}`);
		});
		return publication.then(() => true, () => false);
	};

	const signalOutcome = async (payload: unknown) => {
		if (!taskOutcomeEventStatus(payload)) return;
		if (!signalState.ownerSessionId) {
			signalState.pendingOutcomes.push(payload);
			return;
		}
		if (payload.sessionId === signalState.ownerSessionId) {
			const publication = deliverOutcome(payload);
			signalState.pendingOutcomePublication = publication;
			await publication;
		}
	};

	const flushPendingOutcomes = async () => {
		const queued = signalState.pendingOutcomes.splice(0);
		for (const payload of queued) {
			if (taskOutcomeEventStatus(payload) && payload.sessionId === signalState.ownerSessionId) {
				await deliverOutcome(payload);
			}
		}
		await signalState.outcomeQueue;
	};

	activePi.events.on("task-outcome", signalOutcome);
	activePi.on("session_start", async (event, ctx) => {
		if (event.reason === "maintenance" && event.maintenance) {
			const handoff = handoffs.get(event.maintenance.maintenanceId);
			if (!handoff || handoff.lease.ownerEpoch !== event.maintenance.ownerEpoch ||
				handoff.lease.sessionId !== event.maintenance.sessionId) {
				throw new Error("tmux outcome publication handoff is missing or stale");
			}
			signalState = handoff.state;
			handoffs.delete(event.maintenance.maintenanceId);
			activePi = pi;
		}
		signalState.ownerSessionId = ctx.sessionManager.getSessionId();
		await flushPendingOutcomes();
	});

	activePi.on("session_shutdown", (event, ctx) => {
		if (event.reason === "maintenance" && event.maintenance) {
			if (signalState.ownerSessionId !== ctx.sessionManager.getSessionId()) {
				throw new Error("tmux outcome publication owner mismatch");
			}
			handoffs.set(event.maintenance.maintenanceId, { state: signalState, lease: { ...event.maintenance } });
		}
	});

	activePi.on("agent_start", async (_event, ctx) => {
		signalState.ownerSessionId = ctx.sessionManager.getSessionId();
		const pane = process.env.TMUX_PANE;
		if (!pane || ctx.mode !== "tui") return;

		// Publish the live identity before START; Pi defers creating the JSONL until an assistant response.
		await execTmux(["set-option", "-q", "-t", pane, "@pi_session_id", signalState.ownerSessionId]);
		await saveSessionFile(pane, ctx.sessionManager.getSessionFile());
		const startGeneration = Number.parseInt(await readOption(pane, START_GENERATION_OPTION), 10);
		await execTmux([
			"set-option", "-q", "-t", pane, START_GENERATION_OPTION,
			String(Number.isSafeInteger(startGeneration) ? startGeneration + 1 : 1),
		]);
		await settledChannel(pane);
		await signal(pane, START_CHANNEL_OPTION);
	});

	pi.on("agent_settled", async (_event, ctx) => {
		const pane = process.env.TMUX_PANE;
		if (!pane || ctx.mode !== "tui") return;

		// task-outcomes emits task-outcome synchronously from its settled handler.
		// Its event-bus listener assigns this promise before yielding, so the
		// settled generation cannot advertise availability before publication commits.
		const publication = signalState.pendingOutcomePublication;
		signalState.pendingOutcomePublication = undefined;
		if (publication && !(await publication)) return;

		await saveSessionFile(pane, ctx.sessionManager.getSessionFile());
		const channel = await settledChannel(pane);
		const generation = Number.parseInt(await readOption(pane, SETTLED_GENERATION_OPTION), 10);
		await execTmux([
			"set-option",
			"-q",
			"-t",
			pane,
			SETTLED_GENERATION_OPTION,
			String(Number.isSafeInteger(generation) ? generation + 1 : 1),
		]);
		await Promise.all([
			signal(pane, DONE_CHANNEL_OPTION, false),
			execTmux(["wait-for", "-S", channel]),
		]);
	});
}
