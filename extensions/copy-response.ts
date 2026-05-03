/**
 * /copy — save the model's non-thinking response to /tmp/000-pi/response.txt
 *
 * Finds the last assistant message in the session branch, extracts text parts
 * that are NOT thinking/reasoning blocks, and writes them to a file.
 */

import { mkdir, writeFile } from "node:fs/promises";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const RESPONSE_FILE = "/tmp/000-pi/response.txt";

function extractResponseText(message: { content: unknown }): string {
	if (!Array.isArray(message.content)) return "";

	const parts = message.content as Array<{ type: string; text?: string }>;
	// Anthropic thinking blocks have type "thinking", OpenAI reasoning is separate
	const textParts = parts.filter((p) => p.type === "text");

	return textParts.map((p) => p.text ?? "").join("\n");
}

export default function (pi: ExtensionAPI) {
	// Ensure the target directory exists on startup
	pi.on("session_start", async () => {
		try {
			await mkdir("/tmp/000-pi", { recursive: true });
		} catch {
			// ignore
		}
	});

	// Register /save-response command (avoid conflict with built-in /copy)
	pi.registerCommand("save-response", {
		description: "Save the model's non-thinking response to /tmp/000-pi/response.txt",
		handler: async (_args, ctx) => {
			const entries = ctx.sessionManager.getBranch();

			// Find the last assistant message
			let lastAssistantMessage: { content: unknown } | null = null;
			for (let i = entries.length - 1; i >= 0; i--) {
				const entry = entries[i];
				if (entry.type === "message" && entry.message.role === "assistant") {
					lastAssistantMessage = entry.message;
					break;
				}
			}

			if (!lastAssistantMessage) {
				ctx.ui.notify("No assistant response found to copy.", "warning");
				return;
			}

			const text = extractResponseText(lastAssistantMessage);

			if (!text.trim()) {
				ctx.ui.notify("No non-thinking text found in response.", "warning");
				return;
			}

			try {
				await writeFile(RESPONSE_FILE, text, "utf8");
			} catch (err) {
				ctx.ui.notify(`Failed to write file: ${err}`, "error");
				return;
			}

			ctx.ui.notify(`Copied response to ${RESPONSE_FILE}`, "success");
		},
	});
}
