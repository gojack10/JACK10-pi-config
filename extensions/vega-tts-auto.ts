/**
 * vega-tts-auto — Auto-send Pi's non-thinking responses to the Vega TTS server.
 *
 * On agent_end, extracts the assistant response text (no reasoning/thinking),
 * POSTs it to the Vega TTS server over LAN.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { debateEvents } from "./_debate-shared/debate-events";

const VEGA_URL = "http://192.168.51.143:8787/generate";

function extractResponseText(message: { content: unknown }): string {
	if (!Array.isArray(message.content)) return "";

	const parts = message.content as Array<{ type: string; text?: string }>;
	const textParts = parts.filter((p) => p.type === "text");

	return textParts.map((p) => p.text ?? "").join("\n");
}

export default function (pi: ExtensionAPI) {
	// ── Debate integration: listen for round-complete events ──────────
	const onRoundComplete = (data: { topic: string; round: number; combined: string }) => {
		const text = data.combined.trim();
		if (!text || text.length < 3) return;

		fetch(VEGA_URL, { method: "POST", body: text }).catch(() => {});
	};

	debateEvents.on("roundComplete", onRoundComplete);

	pi.on("session_shutdown", () => {
		debateEvents.off("roundComplete", onRoundComplete);
	});

	// ── Normal agent_end: last assistant response → TTS ──────────────
	// Skip during debates — the EventEmitter handles round-complete instead.
	pi.on("agent_end", async (event, ctx) => {
		if (debateEvents.active) return;
		// Find the last assistant message from this turn
		const assistantMessages = event.messages.filter(
			(m: any) => m.role === "assistant"
		);
		const lastAssistant = assistantMessages[assistantMessages.length - 1];
		if (!lastAssistant) return;

		const text = extractResponseText(lastAssistant).trim();
		if (!text || text.length < 3) return;

		ctx.ui.setStatus("vega-tts", "sending to Vega TTS...");

		try {
			const resp = await fetch(VEGA_URL, {
				method: "POST",
				body: text,
				signal: ctx.signal,
			});

			if (resp.status === 202) {
				ctx.ui.notify("Vega TTS: job started", "info");
				ctx.ui.setStatus("vega-tts", "Vega: job started");
			} else if (resp.status === 409) {
				ctx.ui.setStatus("vega-tts", "Vega: busy");
			} else {
				ctx.ui.setStatus("vega-tts", `Vega: error ${resp.status}`);
			}
		} catch (err: any) {
			// Network error — Vega server might be down
			ctx.ui.setStatus("vega-tts", "Vega: unreachable");
		}
	});
}
