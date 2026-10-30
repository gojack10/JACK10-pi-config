import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getBackgroundJobManager } from "../background-jobs/manager.ts";
import { CacheStatus, clearPaneSnapshot, publishPaneSnapshot } from "./store.ts";

// Tmux metadata only: no cache warnings, footer table, or polling timers.
export default function (pi: ExtensionAPI) {
	const status = new CacheStatus();
	let paneId: string | undefined;
	let publishing = Promise.resolve();
	const exec = (args: string[]) => pi.exec("tmux", args, { timeout: 1000 });
	const publish = () => {
		const pane = paneId;
		const snapshot = status.getSnapshot();
		if (!pane || !snapshot) return publishing;
		publishing = publishing.then(() => publishPaneSnapshot(exec, pane, snapshot)).catch((error) => {
			console.error("cache-status: tmux publication failed", error);
		});
		return publishing;
	};
	const restart = (_event: unknown, ctx: ExtensionContext) => {
		status.start(ctx);
		if (!ctx.isIdle() || getBackgroundJobManager(pi, ctx).stats().running > 0) status.agentStart();
		return publish();
	};
	pi.on("session_start", (event, ctx) => {
		paneId = ctx.mode === "tui" ? process.env.TMUX_PANE : undefined;
		return restart(event, ctx);
	});
	pi.on("agent_start", () => {
		status.agentStart();
		return publish();
	});
	pi.on("agent_settled", (_event, ctx) => {
		// Settled while waiting on background work is still busy, not done.
		if (getBackgroundJobManager(pi, ctx).stats().running > 0) return;
		status.agentSettled();
		return publish();
	});
	pi.on("before_provider_request", (event, ctx) => {
		status.request(event.payload, ctx);
		return publish();
	});
	pi.on("message_end", (event) => {
		status.updateMessage(event.message, true);
		return publish();
	});
	pi.on("model_select", () => publish());
	pi.on("session_switch", restart);
	pi.on("session_tree", restart);
	pi.on("session_compact", restart);
	pi.on("session_shutdown", async () => {
		const pane = paneId;
		paneId = undefined;
		await publishing;
		if (pane) await clearPaneSnapshot(exec, pane);
		status.stop();
	});
}
