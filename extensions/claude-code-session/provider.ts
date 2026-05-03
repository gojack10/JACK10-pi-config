/**
 * pi streamSimple adapter around a long-lived `claude -p` subprocess.
 *
 * Translates pi's "give me the next assistant turn" call into a single-shot
 * message to the subprocess, then streams `claude -p`'s events back to pi as
 * one big text content block (tool calls, tool results, and thinking all get
 * rendered as inline markers by stream-parser).
 *
 * Contract with pi (from @mariozechner/pi-ai):
 *   - Must return an AssistantMessageEventStream, never throw.
 *   - Terminate with either `done` (stop|length|toolUse) or `error` (error|aborted).
 *
 * Claude Code owns conversation state, so we only look at the latest user
 * message in `context.messages` — we never replay pi's history or tools.
 */

import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	createAssistantMessageEventStream,
	type Message,
	type Model,
	type SimpleStreamOptions,
	type StopReason,
} from "@mariozechner/pi-ai";
import { NotRunningError, type ProcessManager, TurnInFlightError } from "./process-manager.js";
import { extractResultText, isResultError, renderEvent } from "./stream-parser.js";

type ResultEvent = Parameters<typeof isResultError>[0];

/** Pull the newest user message's plain text out of pi's context. */
function extractLastUserText(messages: Message[]): string {
	const idx = findLatestUserIndex(messages);
	if (idx < 0) return "";
	const m = messages[idx];
	if (typeof m.content === "string") return m.content;
	const parts: string[] = [];
	for (const block of m.content as Array<{ type: string; [k: string]: unknown }>) {
		if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
		else if (block.type === "image") parts.push("[image attached — not forwarded to claude -p]");
	}
	return parts.join("\n");
}

/** Index of the latest user-role message, or -1 if none. */
function findLatestUserIndex(messages: Message[]): number {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role === "user") return i;
	}
	return -1;
}

// Cap each tool-call's serialized args to keep first-turn payload bounded.
const TOOL_ARGS_MAX = 400;

function userContentToText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content as Array<{ type: string; [k: string]: unknown }>) {
		if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
		else if (block.type === "image") parts.push("[image omitted from handoff]");
	}
	return parts.join("\n");
}

function assistantContentToText(content: unknown): string {
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content as Array<{ type: string; [k: string]: unknown }>) {
		if (block.type === "text" && typeof block.text === "string") {
			parts.push(block.text);
		} else if (block.type === "thinking") {
			// Skip thinking blocks — too long and rarely useful as handoff context.
			continue;
		} else if (block.type === "toolCall") {
			const name = typeof block.name === "string" ? block.name : "?";
			const args = JSON.stringify(block.arguments ?? {});
			const truncated = args.length > TOOL_ARGS_MAX ? `${args.slice(0, TOOL_ARGS_MAX)}… (truncated)` : args;
			parts.push(`[called tool ${name}: ${truncated}]`);
		}
	}
	return parts.join("\n");
}

/** Serialize pi's prior messages as human-readable text for claude -p to read as context. */
function serializePriorHistory(messages: Message[]): string {
	if (messages.length === 0) return "";
	const parts: string[] = [];
	for (const m of messages) {
		if (m.role === "user") {
			const text = userContentToText(m.content);
			if (text) parts.push(`User: ${text}`);
		} else if (m.role === "assistant") {
			const text = assistantContentToText(m.content);
			if (text) parts.push(`Assistant: ${text}`);
		} else if ((m as { role: string }).role === "toolResult") {
			const tr = m as unknown as {
				toolName?: string;
				isError?: boolean;
				content?: unknown;
			};
			const text = userContentToText(tr.content);
			const tag = tr.isError ? `tool_error:${tr.toolName ?? "?"}` : `tool_result:${tr.toolName ?? "?"}`;
			parts.push(`[${tag}] ${text || "(empty)"}`);
		}
	}
	return parts.join("\n\n");
}

function buildSeededUserText(priorHistory: string, currentUserText: string): string {
	return [
		"<prior-conversation>",
		"The following is conversation history from before this Claude Code session started. Use it as context; the final user message below is the one to respond to.",
		"",
		priorHistory,
		"</prior-conversation>",
		"",
		currentUserText,
	].join("\n");
}

type RawUsage = { [k: string]: unknown };

function num(v: unknown): number {
	return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function extractUsage(src: RawUsage | undefined):
	| { input: number; output: number; cacheRead: number; cacheWrite: number }
	| undefined {
	if (!src || typeof src !== "object") return undefined;
	return {
		input: num(src.input_tokens),
		output: num(src.output_tokens),
		cacheRead: num(src.cache_read_input_tokens),
		cacheWrite: num(src.cache_creation_input_tokens),
	};
}

/**
 * Fill output.usage from the turn's usage.
 *
 * All fields come from the LAST inner-model iteration. Earlier versions used
 * result.usage (cumulative across iterations) for input/cacheRead/cacheWrite,
 * but that falsely tripped pi's silent-overflow check
 * (packages/ai/src/utils/overflow.ts:123): `input + cacheRead > contextWindow`
 * fires whenever a multi-iteration turn's cumulative cacheRead crosses the
 * window, even when the real context is tiny. Using the last iteration keeps
 * input + cacheRead representative of the actual prompt size.
 *
 * Session totals in the footer will now reflect per-turn last-iteration usage
 * rather than a cumulative-across-iterations sum.
 */
function applyUsage(
	output: AssistantMessage,
	result: ResultEvent,
	lastAssistantUsage: RawUsage | undefined,
): void {
	const last = extractUsage(lastAssistantUsage);
	const cumulative = extractUsage((result as { usage?: RawUsage }).usage);
	const source = last ?? cumulative;
	if (source) {
		output.usage.input = source.input;
		output.usage.output = source.output;
		output.usage.cacheRead = source.cacheRead;
		output.usage.cacheWrite = source.cacheWrite;
		output.usage.totalTokens = source.input + source.output + source.cacheRead + source.cacheWrite;
	}
	// cost remains 0 — Claude Pro subscription bills elsewhere.
}

/** Build a fresh zero-valued AssistantMessage skeleton. */
function makeOutput(model: Model<Api>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

/**
 * Factory for the streamSimple handler. Binds to a ProcessManager singleton
 * so index.ts can wire in whichever instance is currently active.
 */
export function createClaudeCodeProvider(
	pm: ProcessManager,
): (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream {
	return function streamClaudeCode(
		model: Model<Api>,
		context: Context,
		options?: SimpleStreamOptions,
	): AssistantMessageEventStream {
		const stream = createAssistantMessageEventStream();
		const output = makeOutput(model);
		// Single text block that we progressively fill from renderEvent() chunks.
		const textBlock: { type: "text"; text: string } = { type: "text", text: "" };

		(async () => {
			// Wire abort → send interrupt to claude -p so it terminates the turn
			// promptly instead of running to completion with no UI feedback.
			const onAbort = () => pm.interrupt();
			const signal = options?.signal;
			if (signal) {
				if (signal.aborted) {
					pm.interrupt();
				} else {
					signal.addEventListener("abort", onAbort, { once: true });
				}
			}

			try {
				if (!pm.isRunning()) {
					throw new NotRunningError();
				}

				let userText = extractLastUserText(context.messages);
				if (!userText.trim()) {
					throw new Error("No user text found in context; claude -p needs a non-empty user message.");
				}

				// First-turn handoff: if pi has prior messages, package them as context so
				// claude -p doesn't start cold when the user switches providers mid-session.
				// turnCount increments inside pm.send(), so reading it now captures "before
				// this turn started" — retries after a mid-turn error will see turnCount>0
				// and skip re-seeding (accepted trade-off: if stdin write failed, the
				// subprocess is hosed anyway and the user needs /cc start again).
				const state = pm.getState();
				if (state.turnCount === 0 && !state.noSeed) {
					const latestUserIdx = findLatestUserIndex(context.messages);
					const priorMessages = latestUserIdx > 0 ? context.messages.slice(0, latestUserIdx) : [];
					const priorHistory = serializePriorHistory(priorMessages);
					if (priorHistory.trim()) {
						userText = buildSeededUserText(priorHistory, userText);
					}
				}

				// Open the stream and establish the single text content block up-front.
				stream.push({ type: "start", partial: output });
				output.content.push(textBlock);
				stream.push({ type: "text_start", contentIndex: 0, partial: output });

				let sawOutput = false;
				let resultEvent: ResultEvent | undefined;
				let consumedAbort = false;
				// Track the last assistant event's usage for accurate context-size
				// reporting; result.usage aggregates iterations and over-reports cache reads.
				let lastAssistantUsage: Record<string, unknown> | undefined;

				for await (const event of pm.send(userText)) {
					if (event.type === "assistant") {
						const rawUsage = (event as { message?: { usage?: Record<string, unknown> } }).message?.usage;
						if (rawUsage && typeof rawUsage === "object") {
							lastAssistantUsage = rawUsage;
						}
					}

					if (event.type === "result") {
						resultEvent = event as ResultEvent;
						applyUsage(output, resultEvent, lastAssistantUsage);
						continue;
					}

					// If the user aborted we still drain events so process-manager's
					// turnInFlight flag resets cleanly; we just stop pushing UI updates.
					if (options?.signal?.aborted) {
						consumedAbort = true;
						continue;
					}

					const chunk = renderEvent(event);
					if (!chunk) continue;

					const delta = sawOutput ? `\n\n${chunk}` : chunk;
					sawOutput = true;
					textBlock.text += delta;
					stream.push({ type: "text_delta", contentIndex: 0, delta, partial: output });
				}

				// Fallback: no streamed assistant content — pull from result.result.
				if (!sawOutput && resultEvent) {
					const fallback = extractResultText(resultEvent);
					if (fallback) {
						textBlock.text = fallback;
						stream.push({ type: "text_delta", contentIndex: 0, delta: fallback, partial: output });
						sawOutput = true;
					}
				}

				stream.push({
					type: "text_end",
					contentIndex: 0,
					content: textBlock.text,
					partial: output,
				});

				// Drop the empty text block if nothing landed — keeps the final message honest.
				if (!sawOutput) output.content.length = 0;

				// Final terminal event: error, aborted, length, or stop.
				const aborted = consumedAbort || options?.signal?.aborted === true;
				if (aborted) {
					output.stopReason = "aborted";
					output.errorMessage = "Request was aborted";
					stream.push({ type: "error", reason: "aborted", error: output });
				} else if (resultEvent && isResultError(resultEvent)) {
					const subtype = (resultEvent as { subtype?: string }).subtype ?? "error";
					if (subtype === "error_max_turns") {
						// Map max-turn exhaustion onto pi's "length" rather than a hard error.
						output.stopReason = "length";
						stream.push({ type: "done", reason: "length", message: output });
					} else {
						output.stopReason = "error";
						output.errorMessage = `claude -p returned error (subtype=${subtype})`;
						stream.push({ type: "error", reason: "error", error: output });
					}
				} else {
					output.stopReason = "stop";
					stream.push({ type: "done", reason: "stop", message: output });
				}

				stream.end();
			} catch (err) {
				const aborted = options?.signal?.aborted === true;
				output.stopReason = aborted ? "aborted" : "error";
				output.errorMessage = err instanceof Error ? err.message : String(err);
				// Friendly message for a very common failure mode.
				if (err instanceof NotRunningError) {
					output.errorMessage = "Claude Code session is not running. Run /cc start to spawn it.";
				} else if (err instanceof TurnInFlightError) {
					output.errorMessage = "A Claude Code turn is already in flight. Wait for it to finish.";
				}
				stream.push({
					type: "error",
					reason: aborted ? "aborted" : "error",
					error: output,
				});
				stream.end();
			} finally {
				signal?.removeEventListener("abort", onAbort);
			}
		})();

		return stream;
	};
}

// Re-export StopReason for callers that need the type alongside the provider.
export type { StopReason };
