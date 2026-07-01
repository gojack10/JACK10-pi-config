// Vendored from github.com/KShivendu/pi-import-claude-history (npm pi-import-claude-history@1.0.1).
// Kept as a single tracked extension file (not an npm package) so it syncs via pi-push and works
// on all machines without per-machine node_modules — same convention as the other extensions here.
// To update: re-copy src/claude-import.ts from a newer release, re-add this header, diff, pi-push.
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

type ImportMode = "compact" | "strict";

type ClaudeTurn = {
	role: "user" | "assistant";
	text: string;
	timestamp?: string;
};

type ClaudeParseResult = {
	turns: ClaudeTurn[];
	toolCalls: number;
	toolResults: number;
};

type PiMessageContent = { type: "text"; text: string };

type PiMessageRecord = {
	type: "message";
	id: string;
	parentId: string | null;
	timestamp: string;
	message: {
		role: "user" | "assistant";
		content: PiMessageContent[];
		timestamp: number;
		api?: string;
		provider?: string;
		model?: string;
		usage?: {
			input: number;
			output: number;
			cacheRead: number;
			cacheWrite: number;
			totalTokens: number;
			cost: {
				input: number;
				output: number;
				cacheRead: number;
				cacheWrite: number;
				total: number;
			};
		};
		stopReason?: string;
	};
};

type PiSessionRecord =
	| { type: "session"; version: 3; id: string; timestamp: string; cwd: string }
	| {
			type: "model_change";
			id: string;
			parentId: string | null;
			timestamp: string;
			provider: string;
			modelId: string;
	  }
	| {
			type: "thinking_level_change";
			id: string;
			parentId: string | null;
			timestamp: string;
			thinkingLevel: "off" | "medium" | "high";
	  }
	| PiMessageRecord;

function randomId(length = 8): string {
	return Math.random().toString(16).slice(2, 2 + length);
}

function randomSessionId(): string {
	const a = Date.now().toString(16).slice(-8);
	const b = randomId(4);
	const c = randomId(4);
	const d = randomId(4);
	const e = randomId(12);
	return `${a}-${b}-${c}-${d}-${e}`;
}

function isoForFilename(d = new Date()): string {
	return d.toISOString().replaceAll(":", "-").replace(/\.\d+Z$/, "Z");
}

function sanitizeCwd(cwd: string): string {
	const normalized = cwd.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
	return `--${normalized.replaceAll("/", "-")}--`;
}

function parseClaudeTextParts(content: unknown): string[] {
	if (typeof content === "string") {
		return [content];
	}
	if (!Array.isArray(content)) {
		return [];
	}
	const parts: string[] = [];
	for (const item of content) {
		if (!item || typeof item !== "object") continue;
		const typed = item as Record<string, unknown>;
		if (typed.type === "text" && typeof typed.text === "string") {
			parts.push(typed.text);
		}
	}
	return parts;
}

function parseClaudeSession(claudePath: string, mode: ImportMode): ClaudeParseResult {
	const raw = fs.readFileSync(claudePath, "utf8");
	const lines = raw.split(/\r?\n/).filter(Boolean);

	const turns: ClaudeTurn[] = [];
	let toolCalls = 0;
	let toolResults = 0;

	for (const line of lines) {
		let entry: Record<string, unknown>;
		try {
			entry = JSON.parse(line) as Record<string, unknown>;
		} catch {
			continue;
		}

		const topLevelType = typeof entry.type === "string" ? entry.type : "";
		const message = (entry.message ?? {}) as Record<string, unknown>;

		if (topLevelType === "user") {
			const userText = parseClaudeTextParts(message.content).join("\n").trim();
			const mappedUserText = mode === "compact" ? mapUserTextForCompact(userText) : userText;
			if (mappedUserText) {
				turns.push({
					role: "user",
					text: mappedUserText,
					timestamp: typeof entry.timestamp === "string" ? entry.timestamp : undefined,
				});
			}

			if (Array.isArray(message.content)) {
				for (const item of message.content) {
					if (!item || typeof item !== "object") continue;
					const typed = item as Record<string, unknown>;
					if (typed.type === "tool_result") {
						toolResults += 1;
						if (mode === "strict") {
							const content = typeof typed.content === "string" ? typed.content : JSON.stringify(typed.content);
							turns.push({
								role: "assistant",
								text: `[Claude tool_result]\n${content.slice(0, 4000)}`,
								timestamp: typeof entry.timestamp === "string" ? entry.timestamp : undefined,
							});
						}
					}
				}
			}
		}

		if (topLevelType === "assistant") {
			const content = message.content;
			if (!Array.isArray(content)) continue;

			for (const item of content) {
				if (!item || typeof item !== "object") continue;
				const typed = item as Record<string, unknown>;
				const itemType = typed.type;

				if (itemType === "text" && typeof typed.text === "string") {
					const mappedAssistantText = mode === "compact" ? mapAssistantTextForCompact(typed.text) : typed.text;
					if (mappedAssistantText) {
						turns.push({
							role: "assistant",
							text: mappedAssistantText,
							timestamp: typeof entry.timestamp === "string" ? entry.timestamp : undefined,
						});
					}
				}

				if (itemType === "tool_use") {
					toolCalls += 1;
					if (mode === "strict") {
						const toolName = typeof typed.name === "string" ? typed.name : "unknown_tool";
						const input = JSON.stringify(typed.input ?? {});
						turns.push({
							role: "assistant",
							text: `[Claude tool_use:${toolName}] ${input}`,
							timestamp: typeof entry.timestamp === "string" ? entry.timestamp : undefined,
						});
					}
				}
			}
		}
	}

	return {
		turns: mode === "compact" ? compactTurns(turns) : turns,
		toolCalls,
		toolResults,
	};
}

function normalizeText(s: string): string {
	return s.replace(/\s+/g, " ").trim().toLowerCase();
}

function isDisplayCandidateUserText(text: string): boolean {
	const t = normalizeText(text);
	if (!t) return false;
	if (t.startsWith("<task-notification>")) return false;
	if (t.startsWith("<command-name>")) return false;
	if (t.startsWith("<local-command-stdout>")) return false;
	if (t.startsWith("<local-command-caveat>")) return false;
	if (t.startsWith("[pasted text")) return false;
	return true;
}

function extractTagValue(text: string, tagName: string): string {
	const match = text.match(new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`, "i"));
	return match?.[1]?.replace(/\s+/g, " ").trim() ?? "";
}

function mapUserTextForCompact(text: string): string | null {
	const raw = text.trim();
	if (!raw) return null;
	const normalized = normalizeText(raw);

	if (normalized === "continue" || normalized === "contiue") {
		return "[User requested continuation]";
	}

	if (normalized.startsWith("<task-notification>")) {
		const summary = extractTagValue(raw, "summary");
		return summary ? `[Task notification] ${summary}` : "[Task notification]";
	}

	if (normalized.startsWith("<command-name>")) {
		const commandName = extractTagValue(raw, "command-name");
		const commandMessage = extractTagValue(raw, "command-message");
		if (commandName && commandMessage) return `[Local command] ${commandName}: ${commandMessage}`;
		if (commandName) return `[Local command] ${commandName}`;
		return "[Local command]";
	}

	if (normalized.startsWith("<local-command-stdout>")) {
		const stdout = extractTagValue(raw, "local-command-stdout");
		return stdout ? `[Local command stdout] ${stdout}` : "[Local command stdout]";
	}

	if (normalized.startsWith("<local-command-caveat>")) {
		const caveat = extractTagValue(raw, "local-command-caveat");
		return caveat ? `[Local command caveat] ${caveat}` : "[Local command caveat]";
	}

	return raw;
}

function mapAssistantTextForCompact(text: string): string | null {
	const raw = text.trim();
	if (!raw) return null;
	const normalized = normalizeText(raw);
	if (normalized.includes("you've hit your org's monthly usage limit")) {
		return "[Assistant error] Usage limit reached";
	}
	if (normalized.includes("operation aborted")) {
		return "[Assistant error] Operation aborted";
	}
	return raw;
}

function compactTurns(turns: ClaudeTurn[]): ClaudeTurn[] {
	const deduped: ClaudeTurn[] = [];
	for (const turn of turns) {
		const currentNorm = normalizeText(turn.text);
		const previous = deduped[deduped.length - 1];
		if (previous && previous.role === turn.role && normalizeText(previous.text) === currentNorm) {
			continue;
		}
		deduped.push(turn);
	}

	const compacted: ClaudeTurn[] = [];
	for (let i = 0; i < deduped.length; ) {
		const a = deduped[i];
		const b = deduped[i + 1];
		if (a && b) {
			const aNorm = normalizeText(a.text);
			const bNorm = normalizeText(b.text);
			let reps = 1;
			let j = i + 2;
			while (j + 1 < deduped.length) {
				const nextA = deduped[j];
				const nextB = deduped[j + 1];
				if (
					nextA.role === a.role &&
					nextB.role === b.role &&
					normalizeText(nextA.text) === aNorm &&
					normalizeText(nextB.text) === bNorm
				) {
					reps += 1;
					j += 2;
				} else {
					break;
				}
			}
			if (reps >= 3) {
				compacted.push(a, b, {
					role: "assistant",
					text: `[Importer compacted repeated exchange x${reps - 1}]`,
					timestamp: b.timestamp,
				});
				i = i + reps * 2;
				continue;
			}
		}
		compacted.push(a);
		i += 1;
	}

	return compacted;
}

function buildBootstrap(
	sourcePath: string,
	mode: ImportMode,
	parsed: ClaudeParseResult,
	selectedTurns: ClaudeTurn[],
): string {
	const objective = selectedTurns.find((t) => t.role === "user")?.text ?? "Continue the imported Claude discussion.";
	const lastUser = [...selectedTurns].reverse().find((t) => t.role === "user")?.text ?? "";

	const lines: string[] = [
		`Imported from Claude session: ${sourcePath}`,
		`Import mode: ${mode}`,
		`Imported turns: ${selectedTurns.length} (total parsed: ${parsed.turns.length})`,
		`Observed tool activity in source: ${parsed.toolCalls} tool_use, ${parsed.toolResults} tool_result`,
		"",
		"Objective:",
		objective.slice(0, 700),
		"",
		"Most recent user ask:",
		lastUser.slice(0, 700) || "N/A",
		"",
		"Continue from this context and ask clarifying questions only if needed.",
	];
	return lines.join("\n");
}

function toPiMessage(
	parentId: string | null,
	role: "user" | "assistant",
	text: string,
	timestamp?: string,
	modelProvider?: string,
	modelId?: string,
): PiMessageRecord {
	const ts = timestamp ?? new Date().toISOString();
	const baseMessage: PiMessageRecord["message"] = {
		role,
		content: [{ type: "text", text }],
		timestamp: new Date(ts).getTime(),
	};
	if (role === "assistant") {
		baseMessage.api = "openai-completions";
		baseMessage.provider = modelProvider ?? "openrouter";
		baseMessage.model = modelId ?? "openai/gpt-5.2-codex";
		baseMessage.usage = {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				total: 0,
			},
		};
		baseMessage.stopReason = "done";
	}
	return {
		type: "message",
		id: randomId(8),
		parentId,
		timestamp: ts,
		message: baseMessage,
	};
}

function resolveClaudePath(inputArg: string): string {
	const trimmed = inputArg.trim();
	if (!trimmed) {
		throw new Error("Provide a Claude session id or absolute jsonl path.");
	}

	if (trimmed.endsWith(".jsonl")) {
		const resolved = trimmed.startsWith("/") ? trimmed : path.resolve(process.cwd(), trimmed);
		if (!fs.existsSync(resolved)) throw new Error(`File not found: ${resolved}`);
		return resolved;
	}

	const byId = path.join(os.homedir(), ".claude", "projects");
	const projectDirs = fs.existsSync(byId) ? fs.readdirSync(byId) : [];
	for (const projectDir of projectDirs) {
		const candidate = path.join(byId, projectDir, `${trimmed}.jsonl`);
		if (fs.existsSync(candidate)) return candidate;
	}
	throw new Error(`Could not resolve Claude session id: ${trimmed}`);
}

function listClaudeSessionSuggestions(prefix: string, cwd: string): Array<{ value: string; label: string }> {
	const base = path.join(os.homedir(), ".claude", "projects");
	if (!fs.existsSync(base)) return [];

	const safePrefix = prefix.trim();
	const out: Array<{ value: string; label: string; lastActiveMs: number }> = [];

	// Project folder names in ~/.claude/projects are path-encoded with leading '-'.
	const cwdKey = `-${cwd.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "").replaceAll("/", "-")}`;

	const projectDirs = fs.readdirSync(base).filter((d) => {
		try {
			return fs.statSync(path.join(base, d)).isDirectory();
		} catch {
			return false;
		}
	});

	for (const projectDir of projectDirs) {
		const projectPath = path.join(base, projectDir);
		let files: string[] = [];
		try {
			files = fs.readdirSync(projectPath).filter((f) => f.endsWith(".jsonl"));
		} catch {
			continue;
		}

		for (const file of files) {
			const absPath = path.join(projectPath, file);
			const id = file.replace(/\.jsonl$/i, "");
			const value = id;
			let firstUser = "";
			let lastUser = "";
			let lastActiveMs = 0;
			let gitBranch = "";
			try {
				const raw = fs.readFileSync(absPath, "utf8");
				const lines = raw.split(/\r?\n/);
				for (const line of lines) {
					if (!line) continue;
					let entry: Record<string, unknown>;
					try {
						entry = JSON.parse(line) as Record<string, unknown>;
					} catch {
						continue;
					}
					const timestampRaw = entry.timestamp;
					if (typeof timestampRaw === "string") {
						const ts = Date.parse(timestampRaw);
						if (!Number.isNaN(ts)) {
							lastActiveMs = Math.max(lastActiveMs, ts);
						}
					}
					if (!gitBranch && typeof entry.gitBranch === "string") {
						gitBranch = entry.gitBranch;
					}
					if (entry.type !== "user") continue;
					const message = (entry.message ?? {}) as Record<string, unknown>;
					const content = message.content;
					let text = "";
					if (typeof content === "string") {
						text = content;
					} else if (Array.isArray(content)) {
						for (const item of content) {
							if (!item || typeof item !== "object") continue;
							const typed = item as Record<string, unknown>;
							if (typed.type === "text" && typeof typed.text === "string") {
								text += `${typed.text}\n`;
							}
						}
					}
					const clean = text.replace(/\s+/g, " ").trim();
					if (!clean) continue;
					if (isDisplayCandidateUserText(clean)) {
						if (!firstUser) firstUser = clean;
						lastUser = clean;
					}
				}
			} catch {
				// If parsing fails, fall back to id-only label.
			}

			let fileSizeBytes = 0;
			let mtimeMs = 0;
			try {
				const st = fs.statSync(absPath);
				fileSizeBytes = st.size;
				mtimeMs = st.mtimeMs;
			} catch {
				// Ignore stat errors
			}

			const activeMs = lastActiveMs || mtimeMs;
			const ageText = activeMs ? formatAge(activeMs) : "unknown";
			const branchText = gitBranch || "?";
			const sizeText = formatBytes(fileSizeBytes);
			const firstPreview = firstUser ? firstUser.slice(0, 90) : "No first message";
			const lastPreview = lastUser ? lastUser.slice(0, 60) : "No last message";
			const label = `${firstPreview} (last: ${lastPreview}) [${ageText}] [branch:${branchText}] [${sizeText}]`;
			const matches =
				!safePrefix ||
				id.includes(safePrefix) ||
				absPath.includes(safePrefix) ||
				file.includes(safePrefix);
			if (!matches) continue;

			out.push({ value, label, lastActiveMs: activeMs || mtimeMs || 0 });
		}
	}

	out.sort((a, b) => b.lastActiveMs - a.lastActiveMs);
	return out.slice(0, 30).map(({ value, label }) => ({ value, label }));
}

function formatAge(whenMs: number): string {
	const diffMs = Math.max(0, Date.now() - whenMs);
	const minutes = Math.floor(diffMs / 60_000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	return `${days}d ago`;
}

function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
	const units = ["B", "KB", "MB", "GB"];
	let value = bytes;
	let unitIndex = 0;
	while (value >= 1024 && unitIndex < units.length - 1) {
		value /= 1024;
		unitIndex += 1;
	}
	const rounded = value >= 10 || unitIndex === 0 ? Math.round(value) : Math.round(value * 10) / 10;
	return `${rounded} ${units[unitIndex]}`;
}

export default function claudeImportExtension(pi: ExtensionAPI) {
	pi.registerCommand("import-claude", {
		description: "Import a Claude Code JSONL session into Pi session format",
		getArgumentCompletions: (prefix) => {
			const suggestions = listClaudeSessionSuggestions(prefix, process.cwd());
			return suggestions.length > 0 ? suggestions : null;
		},
		handler: async (args, ctx) => {
			try {
				const argv = args.trim().split(/\s+/).filter(Boolean);
				if (argv.length === 0) {
					ctx.ui.notify("Usage: /import-claude <session-id|path.jsonl> [--mode compact|strict] [--turns N]", "error");
					return;
				}

				let source = argv[0]!;
				let mode: ImportMode = "compact";
				let maxTurns = 60;

				for (let i = 1; i < argv.length; i += 1) {
					const part = argv[i]!;
					if (part === "--mode") {
						const next = argv[i + 1];
						if (next === "compact" || next === "strict") {
							mode = next;
							i += 1;
						}
						continue;
					}
					if (part === "--turns") {
						const next = Number(argv[i + 1] ?? "");
						if (!Number.isNaN(next) && next > 0) {
							maxTurns = Math.min(next, 400);
							i += 1;
						}
					}
				}

				const claudePath = resolveClaudePath(source);
				const parsed = parseClaudeSession(claudePath, mode);
				if (parsed.turns.length === 0) {
					ctx.ui.notify("No importable user/assistant turns found in Claude session.", "error");
					return;
				}

				const selectedTurns = parsed.turns.slice(-maxTurns);
				const now = new Date();
				const sessionId = randomSessionId();
				const cwd = process.cwd();
				const sessionDir = path.join(os.homedir(), ".pi", "agent", "sessions", sanitizeCwd(cwd));
				fs.mkdirSync(sessionDir, { recursive: true });

				const fileName = `${isoForFilename(now)}_${sessionId}.jsonl`;
				const outPath = path.join(sessionDir, fileName);

				const provider = ctx.model?.provider ?? "openrouter";
				const modelId = ctx.model?.id ?? "openai/gpt-5.2-codex";

				const records: PiSessionRecord[] = [];
				records.push({
					type: "session",
					version: 3,
					id: sessionId,
					timestamp: now.toISOString(),
					cwd,
				});

				const modelChangeId = randomId(8);
				records.push({
					type: "model_change",
					id: modelChangeId,
					parentId: null,
					timestamp: now.toISOString(),
					provider,
					modelId,
				});

				const thinkingId = randomId(8);
				records.push({
					type: "thinking_level_change",
					id: thinkingId,
					parentId: modelChangeId,
					timestamp: now.toISOString(),
					thinkingLevel: "medium",
				});

				let parentId: string | null = thinkingId;
				const bootstrap = buildBootstrap(claudePath, mode, parsed, selectedTurns);
				const bootstrapMessage = toPiMessage(parentId, "assistant", bootstrap, undefined, provider, modelId);
				parentId = bootstrapMessage.id;
				records.push(bootstrapMessage);

				for (const turn of selectedTurns) {
					const msg = toPiMessage(parentId, turn.role, turn.text, turn.timestamp, provider, modelId);
					parentId = msg.id;
					records.push(msg);
				}

				const serialized = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
				fs.writeFileSync(outPath, serialized, "utf8");

				ctx.ui.notify(`Imported Claude chat into Pi session file: ${outPath}`, "info");
				ctx.ui.notify("Open Pi session picker and load the new session to continue.", "info");
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				ctx.ui.notify(`import-claude failed: ${message}`, "error");
			}
		},
	});
}
