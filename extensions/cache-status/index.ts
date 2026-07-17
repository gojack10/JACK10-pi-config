import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { cacheStatus, formatHubTimer, tmuxNotice } from "./store.ts";

const TICK_MS = 1000;
const FLASH_TICK_MS = 50;

export default function (pi: ExtensionAPI) {
	let timer: ReturnType<typeof setInterval> | undefined;
	let flashTimer: ReturnType<typeof setInterval> | undefined;
	let publishing = false;
	let publishAgain = false;
	let announceAgain = false;
	let paneId: string | undefined;
	let exec:
		| ((args: string[]) => Promise<{ stdout: string; code: number }>)
		| undefined;

	const render = () => pi.events.emit("cache-status:update", cacheStatus.getRows());
	const stopFlashTimer = () => {
		if (flashTimer) clearInterval(flashTimer);
		flashTimer = undefined;
	};
	const animateFlash = () => {
		if (flashTimer) return;
		flashTimer = setInterval(() => {
			render();
			if (!cacheStatus.hasActiveFlash()) stopFlashTimer();
		}, FLASH_TICK_MS);
	};
	const publish = async (announceDone = false) => {
		if (!paneId || !exec) return;
		if (publishing) {
			publishAgain = true;
			announceAgain = announceAgain || announceDone;
			return;
		}
		publishing = true;
		try {
			await cacheStatus.publish(exec, paneId);
			for (const row of cacheStatus.cacheWarnings()) {
				const level = row.remainingMs <= (row.durationMs ?? 0) * 0.25 ? "red" : "yellow";
				await tmuxNotice(
					exec,
					paneId,
					`#[fg=${level}]cache expiring in ${formatHubTimer(row.remainingMs)} (${row.model})#[default]`,
				);
			}
			if (announceDone) await tmuxNotice(exec, paneId, "AGENT DONE");
		} finally {
			publishing = false;
			if (publishAgain) {
				const nextAnnounceDone = announceAgain;
				publishAgain = false;
				announceAgain = false;
				void publish(nextAnnounceDone);
			}
		}
	};

	pi.on("session_start", (_event, ctx) => {
		cacheStatus.start(ctx);
		paneId = process.env.TMUX_PANE;
		exec = (args) => pi.exec("tmux", args, { timeout: TICK_MS });
		if (timer) clearInterval(timer);
		timer = setInterval(() => void publish(), TICK_MS);
		void publish();
		render();
	});

	pi.on("before_provider_request", (event, ctx) => {
		cacheStatus.request(event.payload, ctx);
		void publish();
		render();
	});
	pi.on("message_update", (event) => {
		cacheStatus.updateMessage(event.message, false);
		animateFlash();
		void publish();
		render();
	});
	pi.on("message_end", (event) => {
		cacheStatus.updateMessage(event.message, true);
		animateFlash();
		void publish();
		render();
	});
	pi.on("agent_start", () => {
		cacheStatus.agentStart();
		void publish();
		render();
	});
	pi.on("agent_settled", () => {
		cacheStatus.agentSettled();
		void publish(true);
		render();
	});
	pi.on("model_select", () => {
		void publish();
		render();
	});
	pi.on("session_shutdown", async () => {
		if (timer) clearInterval(timer);
		stopFlashTimer();
		if (paneId && exec) await cacheStatus.clear(exec, paneId);
		cacheStatus.stop();
		paneId = undefined;
		exec = undefined;
	});
}
