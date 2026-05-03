/**
 * Pure rendering functions for ClaudeEvent → display text.
 *
 * Each `assistant` event in --verbose mode is a complete message, not a partial delta.
 * Between turns we see: assistant → user(tool_result) → assistant → ... → result.
 * We convert each into a chunk of text to append to the pi-visible transcript.
 *
 * `result` is intentionally ignored to avoid duplicating the final assistant text.
 * `system`, `stream_event`, `keep_alive`, `rate_limit_event`, `streamlined_*` are ignored.
 */

import type { ClaudeEvent } from "./process-manager.js";

// ANSI SGR helpers — pi's TUI preserves escape codes through wrapTextWithAnsi().
const RESET = "\x1b[0m";
const GREY = "\x1b[90m"; // bright black = dark grey
const GREY_ITALIC = "\x1b[90;3m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const CYAN = "\x1b[36m";
const DIM = "\x1b[2m";

function grey(s: string): string { return `${GREY}${s}${RESET}`; }
function greyItalic(s: string): string { return `${GREY_ITALIC}${s}${RESET}`; }
function green(s: string): string { return `${GREEN}${s}${RESET}`; }
function red(s: string): string { return `${RED}${s}${RESET}`; }
function cyan(s: string): string { return `${CYAN}${s}${RESET}`; }
function dim(s: string): string { return `${DIM}${s}${RESET}`; }

type AssistantEvent = Extract<ClaudeEvent, { type: "assistant" }>;
type UserEvent = Extract<ClaudeEvent, { type: "user" }>;
type ErrorEvent = Extract<ClaudeEvent, { type: "error" }>;
type ResultEvent = Extract<ClaudeEvent, { type: "result" }>;

function truncate(s: string, max: number): string {
	if (s.length <= max) return s;
	return `${s.slice(0, max - 1)}…`;
}

/**
 * One-line summary of a tool call's input for the in-line marker.
 * Picks the most distinctive field when we know the tool, else shows a compact key=value preview.
 */
function summarizeToolInput(name: string, input: Record<string, unknown>): string {
	if (!input || typeof input !== "object") return "";
	const lower = name.toLowerCase();
	const str = (v: unknown): string => (typeof v === "string" ? v : "");

	if (lower === "read" || lower === "write" || lower === "edit") {
		return str(input.file_path);
	}
	if (lower === "bash") {
		return truncate(str(input.command), 120);
	}
	if (lower === "glob") {
		return str(input.pattern);
	}
	if (lower === "grep") {
		const pattern = str(input.pattern);
		const path = str(input.path);
		return path ? `${pattern} in ${path}` : pattern;
	}
	if (lower === "webfetch" || lower === "websearch") {
		return str(input.url) || str(input.query);
	}
	if (lower === "task" || lower === "agent") {
		return truncate(str(input.description) || str(input.prompt), 120);
	}

	// Fallback: first short scalar field
	for (const [k, v] of Object.entries(input)) {
		if (typeof v === "string" && v.length <= 120) return `${k}=${JSON.stringify(v)}`;
		if (typeof v === "number" || typeof v === "boolean") return `${k}=${v}`;
	}
	return Object.keys(input).slice(0, 3).join(", ");
}

function renderAssistant(event: AssistantEvent): string {
	const parts: string[] = [];
	for (const block of event.message.content) {
		if (block.type === "text") {
			const t = block.text;
			if (t) parts.push(t);
		} else if (block.type === "thinking") {
			const t = block.thinking;
			if (t) parts.push(greyItalic(`[thinking]\n${t}`));
		} else if (block.type === "tool_use") {
			const summary = summarizeToolInput(block.name, block.input);
			const label = summary ? `[${block.name}: ${summary}]` : `[${block.name}]`;
			parts.push(cyan(label));
		}
	}
	return parts.join("\n");
}

function renderUser(event: UserEvent): string {
	const content = event.message.content;
	if (typeof content === "string") {
		const trimmed = content.trim();
		return trimmed ? dim(`[tool_result] ${truncate(trimmed, 200)}`) : "";
	}
	const parts: string[] = [];
	for (const block of content) {
		if (block.type !== "tool_result") continue;
		const text =
			typeof block.content === "string"
				? block.content
				: block.content.map((c) => c.text).join("\n");
		const preview = truncate(text.trim(), 200);
		if (block.is_error) {
			parts.push(red(preview ? `[tool_error] ${preview}` : "[tool_error] (empty)"));
		} else {
			parts.push(green(preview ? `[tool_result] ${preview}` : "[tool_result] (empty)"));
		}
	}
	return parts.join("\n");
}

function renderError(event: ErrorEvent): string {
	const msg = event.error ?? event.message ?? "unknown error";
	return red(`[error] ${msg}`);
}

/**
 * Map a ClaudeEvent to a chunk of display text to append to the pi stream.
 * Returns an empty string for events that should be skipped; the caller strips empties.
 */
export function renderEvent(event: ClaudeEvent): string {
	switch (event.type) {
		case "assistant":
			return renderAssistant(event as AssistantEvent);
		case "user":
			return renderUser(event as UserEvent);
		case "error":
			return renderError(event as ErrorEvent);
		default:
			return "";
	}
}

/**
 * Fallback: extract the `result` field from a `result` event.
 * Used only if no assistant text was streamed during the turn.
 */
export function extractResultText(event: ResultEvent): string {
	return typeof event.result === "string" ? event.result : "";
}

/**
 * Map a `result` event's subtype/is_error flag to a pi StopReason hint.
 * Note: pi accepts only "stop" | "length" | "toolUse" for the `done` event.
 * We return "stop" for normal completion and surface errors through the provider's
 * error handling path instead.
 */
export function isResultError(event: ResultEvent): boolean {
	if (event.is_error === true) return true;
	const sub = event.subtype;
	return sub === "error_max_turns" || sub === "error_during_execution";
}
