import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type TaskOutcomeEvent = {
	sessionId: string;
	outcome: string;
	jobId: string;
	attemptId: string;
	source?: "model" | "technical" | "protocol" | "transport";
	final?: boolean;
	summary?: string;
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
export default function (pi: ExtensionAPI) {
	let ownerSessionId: string | undefined;
	const pendingOutcomes: unknown[] = [];
	let outcomeQueue = Promise.resolve();
	const readOption = async (pane: string, optionName: string) =>
		(await pi.exec("tmux", ["show-options", "-qv", "-t", pane, optionName])).stdout.trim();

	const signal = async (pane: string, optionName: string, clear = true) => {
		const channel = await readOption(pane, optionName);
		if (!channel) return;

		if (clear) await pi.exec("tmux", ["set-option", "-qu", "-t", pane, optionName]);
		await pi.exec("tmux", ["wait-for", "-S", channel]);
	};

	const settledChannel = async (pane: string) => {
		const current = await readOption(pane, SETTLED_CHANNEL_OPTION);
		if (current) return current;

		const channel = `pi-settled-${pane.replace("%", "pane-")}-${process.pid}-${Date.now()}`;
		await pi.exec("tmux", ["set-option", "-q", "-t", pane, SETTLED_CHANNEL_OPTION, channel]);
		return channel;
	};

	const saveSessionFile = async (pane: string, sessionFile?: string) => {
		if (sessionFile) {
			await pi.exec("tmux", ["set-option", "-q", "-t", pane, SESSION_FILE_OPTION, sessionFile]);
		}
	};

	const publishOutcome = async (payload: TaskOutcomeEvent) => {
		const pane = process.env.TMUX_PANE;
		if (!pane) return;
		const existingChannel = await readOption(pane, OUTCOME_CHANNEL_OPTION);
		const channel = existingChannel ||
			`pi-outcome-${pane.replace("%", "pane-")}-${process.pid}-${Date.now()}`;
		if (!existingChannel) {
			await pi.exec("tmux", ["set-option", "-q", "-t", pane, OUTCOME_CHANNEL_OPTION, channel]);
		}
		const generation = Number.parseInt(await readOption(pane, OUTCOME_GENERATION_OPTION), 10);
		const outcome = JSON.stringify({
			session_id: payload.sessionId,
			job_id: payload.jobId,
			attempt_id: payload.attemptId,
			mode: (payload as any).mode,
			outcome: payload.outcome,
			source: payload.source,
			final: payload.final,
			report: (payload as any).reportPath,
			session_file: (payload as any).sessionFile,
		});
		await pi.exec("tmux", ["set-option", "-q", "-t", pane, OUTCOME_OPTION, outcome]);
		await pi.exec("tmux", [
			"set-option", "-q", "-t", pane, OUTCOME_GENERATION_OPTION,
			String(Number.isSafeInteger(generation) ? generation + 1 : 1),
		]);
		await pi.exec("tmux", ["wait-for", "-S", channel]);
	};

	const deliverOutcome = (payload: TaskOutcomeEvent) => {
		outcomeQueue = outcomeQueue.then(() => publishOutcome(payload)).catch(() => {});
		return outcomeQueue;
	};

	const signalOutcome = async (payload: unknown) => {
		if (!taskOutcomeEventStatus(payload)) return;
		if (!ownerSessionId) {
			pendingOutcomes.push(payload);
			return;
		}
		if (payload.sessionId === ownerSessionId) await deliverOutcome(payload);
	};

	const flushPendingOutcomes = async () => {
		const queued = pendingOutcomes.splice(0);
		for (const payload of queued) {
			if (taskOutcomeEventStatus(payload) && payload.sessionId === ownerSessionId) {
				await deliverOutcome(payload);
			}
		}
		await outcomeQueue;
	};

	pi.events.on("task-outcome", signalOutcome);
	pi.on("session_start", async (_event, ctx) => {
		ownerSessionId = ctx.sessionManager.getSessionId();
		await flushPendingOutcomes();
	});

	pi.on("agent_start", async (_event, ctx) => {
		ownerSessionId = ctx.sessionManager.getSessionId();
		const pane = process.env.TMUX_PANE;
		if (!pane || ctx.mode !== "tui") return;

		// Publish the live identity before START; Pi defers creating the JSONL until an assistant response.
		await pi.exec("tmux", ["set-option", "-q", "-t", pane, "@pi_session_id", ownerSessionId]);
		await saveSessionFile(pane, ctx.sessionManager.getSessionFile());
		const startGeneration = Number.parseInt(await readOption(pane, START_GENERATION_OPTION), 10);
		await pi.exec("tmux", [
			"set-option", "-q", "-t", pane, START_GENERATION_OPTION,
			String(Number.isSafeInteger(startGeneration) ? startGeneration + 1 : 1),
		]);
		await settledChannel(pane);
		await signal(pane, START_CHANNEL_OPTION);
	});

	pi.on("agent_settled", async (_event, ctx) => {
		const pane = process.env.TMUX_PANE;
		if (!pane || ctx.mode !== "tui") return;

		await saveSessionFile(pane, ctx.sessionManager.getSessionFile());
		const channel = await settledChannel(pane);
		const generation = Number.parseInt(await readOption(pane, SETTLED_GENERATION_OPTION), 10);
		await pi.exec("tmux", [
			"set-option",
			"-q",
			"-t",
			pane,
			SETTLED_GENERATION_OPTION,
			String(Number.isSafeInteger(generation) ? generation + 1 : 1),
		]);
		await Promise.all([
			signal(pane, DONE_CHANNEL_OPTION, false),
			pi.exec("tmux", ["wait-for", "-S", channel]),
		]);
	});
}
