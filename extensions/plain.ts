import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

/**
 * Plain mode extension
 *
 * Enables a stripped-down runtime when launched with --plain.
 * Intended to be paired with CLI args such as:
 *   --no-extensions --no-skills --no-prompt-templates --no-tools --system-prompt ''
 */
export default function plainExtension(pi: ExtensionAPI) {
	pi.registerFlag("plain", {
		description: "Plain mode: no tools, empty system prompt, block user !/!! bash",
		type: "boolean",
		default: false,
	});

	const isPlain = () => pi.getFlag("plain") === true;

	const applyPlainTools = () => {
		if (!isPlain()) return;
		// Disable all active tools (built-in, SDK, and extension-registered)
		pi.setActiveTools([]);
	};

	pi.on("session_start", async (_event, ctx) => {
		if (!isPlain()) return;
		applyPlainTools();
		ctx.ui.notify("Plain mode enabled", "info");
	});

	pi.on("before_agent_start", async () => {
		if (!isPlain()) return undefined;

		// Re-apply in case another extension re-enabled tools between turns
		applyPlainTools();

		return {
			systemPrompt: "",
		};
	});

	pi.on("user_bash", async (event) => {
		if (!isPlain()) return undefined;
		return {
			result: {
				output: `plain mode: blocked user shell command: ${event.command}`,
				exitCode: 1,
				cancelled: false,
				truncated: false,
			},
		};
	});
}
