/**
 * claude-code-session: embeds `claude -p` as a stateful pi provider.
 *
 * Pi acts as TUI shell + session recorder.
 * Claude Code owns the conversation, tools, and compaction — pi just ferries
 * user turns in and rendered event text back out.
 *
 * Usage (inside pi):
 *   /cc start [model?] [effort?] [no-seed?]  # spawn a subprocess, switch to claude-code/<model>
 *   /cc stop                                  # tear down the subprocess
 *   /cc status                                # show pid, cost, turn count, session id
 *
 * Defaults: model=opus, effort=max.
 *
 * Handoff: by default, if pi already has a conversation when `/cc start` runs,
 * the provider wraps the pi history into a <prior-conversation> block and
 * prepends it to the FIRST user turn sent to claude -p. Subsequent turns pass
 * through verbatim. Use `no-seed` (or `fresh`) to disable this and start
 * claude -p with a clean context.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { type ClaudeEffort, ProcessManager } from "./process-manager.js";
import { createClaudeCodeProvider } from "./provider.js";

// Module-level singleton: one subprocess per pi process.
const pm = new ProcessManager();

const VALID_EFFORTS: ReadonlySet<string> = new Set(["low", "medium", "high", "xhigh", "max"]);
const DEFAULT_MODEL = "opus";
const DEFAULT_EFFORT: ClaudeEffort = "max";

/**
 * Model list registered under provider "claude-code".
 * Costs are zero — billing is covered by the user's Claude Pro subscription
 * via `claude -p`'s own auth flow, not by pi's per-token accounting.
 */
const MODELS = [
	{
		id: "opus",
		name: "Claude Opus 4.7 (Claude Code)",
		reasoning: true,
		input: ["text", "image"] as ("text" | "image")[],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 64_000,
	},
	{
		id: "sonnet",
		name: "Claude Sonnet 4.6 (Claude Code)",
		reasoning: true,
		input: ["text", "image"] as ("text" | "image")[],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 64_000,
	},
	{
		id: "haiku",
		name: "Claude Haiku 4.5 (Claude Code)",
		reasoning: false,
		input: ["text", "image"] as ("text" | "image")[],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 64_000,
	},
];

const NO_SEED_TOKENS: ReadonlySet<string> = new Set(["no-seed", "noseed", "--no-seed", "fresh"]);

function parseStartArgs(args: string): { model: string; effort: ClaudeEffort; noSeed: boolean } {
	const parts = args
		.trim()
		.split(/\s+/)
		.filter((s) => s.length > 0);
	let model = DEFAULT_MODEL;
	let effort: ClaudeEffort = DEFAULT_EFFORT;
	let noSeed = false;
	for (const tok of parts) {
		if (NO_SEED_TOKENS.has(tok)) {
			noSeed = true;
		} else if (VALID_EFFORTS.has(tok)) {
			effort = tok as ClaudeEffort;
		} else {
			model = tok;
		}
	}
	return { model, effort, noSeed };
}

export default function claudeCodeSessionExtension(pi: ExtensionAPI): void {
	// Register the provider with its streamSimple adapter and model list.
	// baseUrl/apiKey are dummies: the streamSimple handler never makes HTTP calls —
	// the `claude -p` subprocess owns transport and auth. Pi's model registry still
	// requires them when `models` is non-empty (see model-registry.ts:712).
	pi.registerProvider("claude-code", {
		api: "claude-code-session",
		baseUrl: "local://claude-code-session",
		apiKey: "CLAUDE_CODE_SESSION_UNUSED",
		streamSimple: createClaudeCodeProvider(pm),
		models: MODELS,
	});

	pi.registerCommand("cc", {
		description: "Control the embedded Claude Code subprocess: start | stop | status",
		handler: async (args, ctx) => {
			const trimmed = (args ?? "").trim();
			const [verb = "status", ...rest] = trimmed.split(/\s+/);
			const restJoined = rest.join(" ");

			switch (verb) {
				case "start": {
					if (pm.isRunning()) {
						const s = pm.getState();
						ctx.ui.notify(`Claude Code already running (model=${s.model}, pid=${s.pid})`, "warning");
						return;
					}
					const { model, effort, noSeed } = parseStartArgs(restJoined);
					try {
						await pm.start({ model, effort, cwd: ctx.cwd, noSeed });
					} catch (err) {
						const msg = err instanceof Error ? err.message : String(err);
						ctx.ui.notify(`Failed to start claude -p: ${msg}`, "error");
						return;
					}

					// Switch pi's active model to the corresponding claude-code entry.
					// The model id the user gave may be "opus"/"sonnet"/"haiku" or a full
					// claude model id — only the short aliases are registered with pi.
					const registered = ctx.modelRegistry.find("claude-code", model);
					if (registered) {
						const ok = await pi.setModel(registered);
						if (!ok) ctx.ui.notify(`Could not switch pi model to claude-code/${model}`, "warning");
					}

					const state = pm.getState();
					ctx.ui.setStatus(
						"claude-code",
						ctx.ui.theme.fg("accent", `CLAUDE CODE: ${state.model ?? model} ${state.effort ?? effort}`),
					);
					ctx.ui.notify(
						`Claude Code started (model=${state.model ?? model}, effort=${state.effort ?? effort}, pid=${state.pid ?? "?"}${noSeed ? ", no-seed" : ""})`,
						"info",
					);
					return;
				}

				case "stop": {
					if (!pm.isRunning()) {
						ctx.ui.notify("Claude Code is not running", "info");
						return;
					}
					await pm.stop();
					ctx.ui.setStatus("claude-code", undefined);
					ctx.ui.notify("Claude Code stopped", "info");
					return;
				}

				case "status": {
					const s = pm.getState();
					if (!s.running) {
						ctx.ui.notify("Claude Code is not running (use /cc start)", "info");
						return;
					}
					const seedStatus = s.noSeed ? "off" : s.turnCount === 0 ? "pending" : "done";
					const lines: string[] = [
						`running: ${s.running}`,
						`model:   ${s.model ?? "?"}  effort: ${s.effort ?? "?"}`,
						`pid:     ${s.pid ?? "?"}`,
						`cwd:     ${s.cwd ?? "?"}`,
						`session: ${s.sessionId ?? "(pending)"}`,
						`turns:   ${s.turnCount}`,
						`seed:    ${seedStatus}`,
						`cost:    $${s.totalCostUsd.toFixed(4)}`,
					];
					if (s.startedAt) {
						const mins = ((Date.now() - s.startedAt) / 60_000).toFixed(1);
						lines.push(`uptime:  ${mins}min`);
					}
					ctx.ui.notify(lines.join("\n"), "info");
					return;
				}

				case "stderr": {
					const lines = pm.getRecentStderr(20);
					ctx.ui.notify(lines.length > 0 ? lines.join("\n") : "(no recent stderr)", "info");
					return;
				}

				default: {
					ctx.ui.notify(
						`Usage:
  /cc start [model] [effort] [no-seed]   — spawn subprocess (default: opus max, seeds pi history on first turn)
  /cc stop                                — terminate the subprocess
  /cc status                              — show current state
  /cc stderr                              — dump last 20 lines of claude -p stderr`,
						"info",
					);
					return;
				}
			}
		},
	});

	// Clean shutdown when pi exits.
	pi.on("session_shutdown", async () => {
		if (pm.isRunning()) {
			try {
				await pm.stop();
			} catch {
				// swallow — process exit is imminent
			}
		}
	});

	// Tree navigation in pi does not rewind claude -p's internal conversation.
	// Warn so the user knows the subprocess state will diverge from the pi view.
	pi.on("session_before_tree", async (_event, ctx) => {
		if (pm.isRunning()) {
			ctx.ui.notify(
				"Note: Claude Code's internal conversation state is not rewound by pi tree navigation. The subprocess will continue from where it is.",
				"warning",
			);
		}
	});
}
