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

const KEEP = new Set(["ideation_get_node", "ideation_get_outline"]);
const CLEARED_RESULT = "[tool result cleared by /tool-call-clean]";
type Row = Record<string, any>;

type CleanResult = {
	rows: Row[];
	clearedResults: number;
};

export function cleanRows(input: Row[]): CleanResult {
	const rows = structuredClone(input);
	let clearedResults = 0;

	for (const row of rows) {
		if (row.message?.role !== "toolResult" || KEEP.has(row.message.toolName)) continue;
		const content = row.message.content ?? [];
		if (content.length === 1 && content[0]?.type === "text" && content[0].text === CLEARED_RESULT) continue;
		row.message.content = [{ type: "text", text: CLEARED_RESULT }];
		clearedResults++;
	}

	return { rows, clearedResults };
}

function contextMessages(rows: Row[]): AgentMessage[] {
	const entries = rows.filter((row) => row.type !== "session") as SessionEntry[];
	return buildSessionContext(entries, entries.at(-1)?.id ?? null).messages;
}

function freshContextEstimate(rows: Row[]): number {
	return contextMessages(rows).reduce((total, message) => total + estimateTokens(message), 0);
}

function refreshLastUsageEstimate(rows: Row[]): boolean {
	const messages = contextMessages(rows);
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
					{ type: "toolCall", id: "keep-call", name: "ideation_get_node", arguments: {} },
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
				toolName: "ideation_get_node",
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
	assert.equal(refreshLastUsageEstimate(result.rows), true);
	assert.notEqual(result.rows[2].message.usage.totalTokens, 999);
}

export default function (pi: ExtensionAPI) {
	pi.on("agent_end", (_event, ctx) => ctx.ui.setStatus("tool-call-clean", undefined));

	pi.registerCommand("tool-call-clean", {
		description: "Clear non-ideation tool outputs while preserving every assistant and thinking block",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();
			const sessionFile = ctx.sessionManager.getSessionFile();
			if (!sessionFile) {
				ctx.ui.notify("tool-call-clean requires a saved session", "error");
				return;
			}

			try {
				const original = readFileSync(sessionFile, "utf8");
				const rows = original.split("\n").filter(Boolean).map((line) => JSON.parse(line));
				const beforeTokens = freshContextEstimate(rows);
				const result = cleanRows(rows);
				const afterTokens = freshContextEstimate(result.rows);
				const usageRefreshed = refreshLastUsageEstimate(result.rows);
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

				const switched = await ctx.switchSession(sessionFile, {
					withSession: async (replacementCtx) => {
						replacementCtx.ui.setStatus("tool-call-clean", summary);
						replacementCtx.ui.notify(`${summary}. The estimate becomes exact after the next successful response.`, "info");
					},
				});
				if (switched.cancelled) ctx.ui.notify(`${summary}, but session reload was cancelled`, "warning");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	if (process.env.TOOL_CALL_CLEAN_SELF_TEST === "1") runSelfTest();
}
