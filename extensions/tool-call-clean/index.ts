import assert from "node:assert/strict";
import {
	closeSync,
	copyFileSync,
	fsyncSync,
	openSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	buildSessionContext,
	estimateTokens,
	type ExtensionAPI,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { existingTaskOutcomeManager, getTaskOutcomeManager, type MaintenanceLease } from "../task-outcomes/manager.ts";

const KEEP = new Set(["sifttext_get_node", "sifttext_get_outline"]);
const CLEARED_RESULT = "[tool result cleared by /tool-call-clean]";
type Row = Record<string, any>;

type CleanResult = {
	rows: Row[];
	clearedResults: number;
};

export function cleanRows(input: Row[], leafId?: string | null): CleanResult {
	const rows = structuredClone(input);
	const selected = new Set<string>();
	if (leafId !== undefined) {
		const entries = rows.filter((row) => row.type !== "session");
		const byId = new Map(entries.map((row) => [row.id, row]));
		if (byId.size !== entries.length) throw new Error("Duplicate session entry IDs; no cleanup performed");
		let id = leafId;
		while (id !== null) {
			const row = byId.get(id);
			if (!row || selected.has(id) || !(row.parentId === null || typeof row.parentId === "string")) {
				throw new Error("Selected cleanup branch is missing or malformed; no cleanup performed");
			}
			selected.add(id);
			id = row.parentId;
		}
	}
	let clearedResults = 0;

	for (const row of rows) {
		if (leafId !== undefined && !selected.has(row.id)) continue;
		if (row.message?.role !== "toolResult" || KEEP.has(row.message.toolName)) continue;
		const content = row.message.content ?? [];
		if (content.length === 1 && content[0]?.type === "text" && content[0].text === CLEARED_RESULT) continue;
		row.message.content = [{ type: "text", text: CLEARED_RESULT }];
		clearedResults++;
	}

	return { rows, clearedResults };
}

function contextMessages(rows: Row[], leafId: string | null): AgentMessage[] {
	const entries = rows.filter((row) => row.type !== "session") as SessionEntry[];
	return buildSessionContext(entries, leafId).messages;
}

function freshContextEstimate(rows: Row[], leafId: string | null): number {
	return contextMessages(rows, leafId).reduce((total, message) => total + estimateTokens(message), 0);
}

function refreshLastUsageEstimate(rows: Row[], leafId: string | null): boolean {
	const messages = contextMessages(rows, leafId);
	const index = messages.findLastIndex(
		(message) =>
			message.role === "assistant" &&
			message.stopReason !== "aborted" &&
			message.stopReason !== "error" &&
			message.usage,
	);
	if (index < 0) return false;

	const assistant = messages[index] as Extract<AgentMessage, { role: "assistant" }>;
	const estimate = messages.slice(0, index + 1).reduce((total, message) => total + estimateTokens(message), 0);
	if (assistant.usage.totalTokens === estimate) return false;
	assistant.usage.totalTokens = estimate;
	return true;
}

function formatTokens(tokens: number) {
	return tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens);
}

function backupName(sessionFile: string) {
	return `${sessionFile}.tool-call-clean.${new Date().toISOString().replace(/[:.]/g, "-")}.bak`;
}

function rewriteAtomically(sessionFile: string, content: string) {
	const temp = `${sessionFile}.${process.pid}.tool-call-clean.tmp`;
	const fd = openSync(temp, "w", statSync(sessionFile).mode);
	try {
		writeFileSync(fd, content);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	try {
		renameSync(temp, sessionFile);
	} catch (error) {
		unlinkSync(temp);
		throw error;
	}
}

// Shared by the human command and tracked subagent maintenance; no model request here.
export function cleanSessionFile(sessionFile: string, leafId: string | null, contextLimit = Infinity) {
	if (!(leafId === null || typeof leafId === "string")) throw new Error("Cleanup requires an explicit selected branch");
	const original = readFileSync(sessionFile, "utf8");
	const rows = original.split("\n").filter(Boolean).map((line) => JSON.parse(line));
	const result = cleanRows(rows, leafId);
	const beforeTokens = freshContextEstimate(rows, leafId);
	const afterTokens = freshContextEstimate(result.rows, leafId);
	if (afterTokens >= contextLimit) throw new Error("Tool cleanup cannot free enough context; assignment remains paused");
	const usageRefreshed = refreshLastUsageEstimate(result.rows, leafId);
	const cleaned = `${result.rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
	const changed = result.clearedResults > 0 || usageRefreshed;
	if (changed) {
		if (readFileSync(sessionFile, "utf8") !== original) {
			throw new Error("Session changed during cleanup; run the command again while idle");
		}
		copyFileSync(sessionFile, backupName(sessionFile));
		rewriteAtomically(sessionFile, cleaned);
	}
	const summary = result.clearedResults > 0
		? `Cleared ${result.clearedResults} tool outputs; preserved all thinking and assistant blocks; fresh message estimate ${formatTokens(beforeTokens)} → ${formatTokens(afterTokens)}`
		: usageRefreshed
			? `Refreshed footer context estimate to ${formatTokens(afterTokens)}`
			: `Already clean; fresh message estimate ${formatTokens(afterTokens)}`;
	return { changed, summary, beforeTokens, afterTokens };
}

function runSelfTest() {
	const rows: Row[] = [
		{ type: "session", id: "session" },
		{ type: "message", id: "user", parentId: null, message: { role: "user", content: [] } },
		{
			type: "message",
			id: "assistant",
			parentId: "user",
			message: {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "valuable", thinkingSignature: "signed" },
					{ type: "toolCall", id: "clear-call", name: "bash", arguments: {} },
					{ type: "toolCall", id: "keep-call", name: "sifttext_get_node", arguments: {} },
				],
				stopReason: "toolUse",
				usage: { totalTokens: 999 },
			},
		},
		{
			type: "message",
			id: "clear-result",
			parentId: "assistant",
			message: {
				role: "toolResult",
				toolCallId: "clear-call",
				toolName: "bash",
				content: [{ type: "text", text: "large output" }],
				details: { state: "preserved" },
			},
		},
		{
			type: "message",
			id: "keep-result",
			parentId: "clear-result",
			message: {
				role: "toolResult",
				toolCallId: "keep-call",
				toolName: "sifttext_get_node",
				content: [{ type: "text", text: "keep output" }],
			},
		},
	];
	const result = cleanRows(rows);
	assert.equal(result.clearedResults, 1);
	assert.deepEqual(result.rows[2].message, rows[2].message);
	assert.deepEqual(result.rows[3].message.content, [{ type: "text", text: CLEARED_RESULT }]);
	assert.deepEqual(result.rows[3].message.details, { state: "preserved" });
	assert.deepEqual(result.rows[4], rows[4]);
	assert.equal(cleanRows(result.rows).clearedResults, 0);
	assert.equal(refreshLastUsageEstimate(result.rows, "keep-result"), true);
	assert.notEqual(result.rows[2].message.usage.totalTokens, 999);
}

export default function (pi: ExtensionAPI) {
	pi.on("agent_end", (_event, ctx) => ctx.ui.setStatus("tool-call-clean", undefined));

	pi.registerCommand("tool-call-clean", {
		description: "Clear non-ideation tool outputs while preserving every assistant and thinking block",
		handler: async (_args, ctx) => {
			const sessionFile = ctx.sessionManager.getSessionFile();
			if (!sessionFile) {
				ctx.ui.notify("tool-call-clean requires a saved session", "error");
				return;
			}

			const manager = getTaskOutcomeManager(pi, ctx);
			let lease: MaintenanceLease | undefined;
			let replacementAttempted = false;
			try {
				// Persist intent before the core aborts a streaming turn. A failed
				// marker leaves the run untouched and therefore retryable.
				lease = manager.beginMaintenance(sessionFile);
				let result: ReturnType<typeof cleanSessionFile> | undefined;
				// A rejection can occur after disposal but before withSession. From
				// this point the outer frame must not access either outgoing handle.
				replacementAttempted = true;
				const switched = await ctx.switchSession(sessionFile, {
					maintenance: {
						token: lease,
						beforeReplace: () => {
							result = cleanSessionFile(sessionFile, ctx.sessionManager.getLeafId());
							if (!result.changed) {
								return { replace: false, afterNoReplace: () => manager.resumeMaintenance(lease!) };
							}
							return { replace: true };
						},
					},
					withSession: async (replacementCtx) => {
						try {
							const summary = result?.summary ?? "Session cleaned";
							replacementCtx.ui.setStatus("tool-call-clean", summary);
							replacementCtx.ui.notify(`${summary}. The estimate becomes exact after the next successful response.`, "info");
						} catch (error) {
							existingTaskOutcomeManager(replacementCtx)?.failMaintenance(lease!, error);
							throw error;
						}
					},
				});
				if (switched.cancelled) throw new Error("Maintenance was cancelled");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (replacementAttempted) {
					// Core owns durable replacement failures through a fresh file owner;
					// this old command frame is only allowed to log.
					console.error(`tool-call-clean: ${message}`);
					return;
				}
				if (lease) manager.failMaintenance(lease, error);
				ctx.ui.notify(message, "error");
			}
		},
	});

	if (process.env.TOOL_CALL_CLEAN_SELF_TEST === "1") runSelfTest();
}
