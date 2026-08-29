import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { registerFriendlyStop, writeReceipt } from "./rlm-friendly-stop.ts";

type Handler = (event: any, ctx: any) => any;

class FakePi {
	handlers = new Map<string, Handler[]>();
	tools: any[] = [];
	entries: any[] = [];
	messages: any[] = [];
	registerTool(tool: any) { this.tools.push(tool); }
	on(name: string, handler: Handler) { this.handlers.set(name, [...(this.handlers.get(name) ?? []), handler]); }
	appendEntry(customType: string, data: any) {
		this.entries.push({ type: "custom", customType, data: structuredClone(data) });
	}
	sendMessage(message: any, options: any) { this.messages.push({ message, options }); }
	async emit(name: string, event: any, ctx: any) {
		let result;
		for (const handler of this.handlers.get(name) ?? []) result = await handler(event, ctx) ?? result;
		return result;
	}
}

function context(pi: FakePi, tokens: number | null, branch = pi.entries) {
	let current = tokens;
	return {
		hasUI: false,
		ui: { setStatus() {}, notify() {} },
		mode: "json",
		cwd: "/tmp",
		model: { provider: "openai-codex-personal", id: "gpt-5.6-sol" },
		thinkingLevel: "medium",
		getContextUsage: () => ({ tokens: current, contextWindow: 400_000, percent: current === null ? null : current / 4_000 }),
		setTokens: (value: number) => { current = value; },
		sessionManager: {
			getBranch: () => branch,
			getSessionId: () => "session/1",
			getSessionFile: () => "/tmp/session.jsonl",
			getLeafId: () => "leaf/1",
		},
		abortCalls: 0,
		shutdownCalls: 0,
		abort() { this.abortCalls++; },
		shutdown() { this.shutdownCalls++; },
	};
}

async function tempDir(t: test.TestContext) {
	const directory = await mkdtemp(join(tmpdir(), "rlm-friendly-stop-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	return directory;
}

function valid(directory: string, extra: Record<string, string> = {}) {
	return { PI_RLM_FRIENDLY_STOP_TOKENS: "200000", PI_RLM_ROLLOVER_DIR: directory, ...extra };
}

test("inert without both valid opt-in environment values", () => {
	for (const env of [
		{},
		{ PI_RLM_FRIENDLY_STOP_TOKENS: "x", PI_RLM_ROLLOVER_DIR: "/tmp" },
		{ PI_RLM_FRIENDLY_STOP_TOKENS: "1", PI_RLM_ROLLOVER_DIR: "relative" },
		{ PI_RLM_FRIENDLY_STOP_TOKENS: "1" },
	]) {
		const pi = new FakePi();
		assert.equal(registerFriendlyStop(pi as any, env), false);
		assert.deepEqual([pi.tools.length, pi.handlers.size, pi.entries.length, pi.messages.length], [0, 0, 0, 0]);
	}
});

test("registers only when both opt-in values are valid", () => {
	const pi = new FakePi();
	assert.equal(registerFriendlyStop(pi as any, valid("/tmp/checkpoints")), true);
	assert.deepEqual(pi.tools.map((tool) => tool.name), ["rlm_rollover_checkpoint"]);
	assert.ok(pi.handlers.has("turn_end"));
});

test("below threshold is unchanged; crossing arms once and next context gets one instruction", async () => {
	const pi = new FakePi();
	registerFriendlyStop(pi as any, valid("/tmp/checkpoints"));
	const ctx = context(pi, 199_999);
	await pi.emit("session_start", { reason: "startup" }, ctx);
	await pi.emit("turn_end", {}, ctx);
	assert.equal(pi.entries.length, 0);
	ctx.setTokens(200_000);
	await pi.emit("turn_end", {}, ctx);
	await pi.emit("turn_end", {}, ctx);
	assert.equal(pi.entries.filter((entry) => entry.data.phase === "armed").length, 1);
	const first = await pi.emit("context", { messages: [] }, ctx);
	const second = await pi.emit("context", { messages: [] }, ctx);
	assert.equal(first.messages.length, 1);
	assert.match(first.messages[0].content, /RLM ROLLOVER REQUIRED/);
	assert.equal(second, undefined);
});

test("pre-provider context crossing arms, injects once, and blocks mutations before ordinary work", async () => {
	const pi = new FakePi();
	registerFriendlyStop(pi as any, valid("/tmp/checkpoints"));
	const ctx = context(pi, 199_999);
	await pi.emit("session_start", { reason: "startup" }, ctx);
	ctx.setTokens(200_000);
	const first = await pi.emit("context", { messages: [{ role: "user", content: "large prompt" }] }, ctx);
	const second = await pi.emit("context", { messages: first.messages }, ctx);
	assert.equal(first.messages.length, 2);
	assert.match(first.messages.at(-1).content, /RLM ROLLOVER REQUIRED/);
	assert.equal(second, undefined);
	assert.equal(pi.entries.filter((entry) => entry.data.phase === "armed").length, 1);
	const blocked = await pi.emit("tool_call", { toolName: "sifttext_create_node" }, ctx);
	assert.equal(blocked.block, true);
});

test("below-threshold pre-provider context is unchanged", async () => {
	const pi = new FakePi();
	registerFriendlyStop(pi as any, valid("/tmp/checkpoints"));
	const ctx = context(pi, 199_999);
	await pi.emit("session_start", { reason: "startup" }, ctx);
	assert.equal(await pi.emit("context", { messages: [{ role: "user", content: "small" }] }, ctx), undefined);
	assert.equal(pi.entries.length, 0);
	assert.equal(pi.messages.length, 0);
});

test("wrap-up blocks ideation mutations but permits reads and local checkpoint work", async () => {
	const pi = new FakePi();
	registerFriendlyStop(pi as any, valid("/tmp/checkpoints"));
	const ctx = context(pi, 200_000);
	await pi.emit("turn_end", {}, ctx);
	for (const name of ["sifttext_get_node", "sifttext_get_outline", "sifttext_sql", "read", "rlm_rollover_checkpoint"])
		assert.equal(await pi.emit("tool_call", { toolName: name }, ctx), undefined);
	const blocked = await pi.emit("tool_call", { toolName: "sifttext_create_node" }, ctx);
	assert.equal(blocked.block, true);
	assert.match(blocked.reason, /checkpoint/);
});

test("checkpoint is atomic, non-overwriting, terminating, and includes trusted metadata", async (t) => {
	const directory = await tempDir(t);
	const pi = new FakePi();
	registerFriendlyStop(pi as any, valid(directory));
	const ctx = context(pi, 210_000);
	await pi.emit("turn_end", {}, ctx);
	const result = await pi.tools[0].execute("call", {
		completedOperationIds: ["op-1"], nextOperation: "op-2",
		symbolicUuidBindings: { root: "uuid-1" }, failures: [], receiptPaths: ["/tmp/op-1.json"], notes: "ready",
	}, undefined, undefined, ctx);
	assert.equal(result.terminate, true);
	assert.equal(ctx.shutdownCalls, 0);
	assert.equal(ctx.abortCalls, 0);
	assert.equal(pi.entries.at(-1).data.phase, "checkpoint");
	const checkpoint = JSON.parse(await readFile(result.details.receiptPath, "utf8"));
	assert.equal(checkpoint.reported.nextOperation, "op-2");
	assert.equal(checkpoint.trusted.thresholdTokens, 200_000);
	assert.equal(checkpoint.trusted.currentUsage.tokens, 210_000);
	assert.deepEqual(checkpoint.trusted.session, { id: "session/1", file: "/tmp/session.jsonl", leaf: "leaf/1" });
	assert.deepEqual(checkpoint.trusted.model, { provider: "openai-codex-personal", id: "gpt-5.6-sol", thinking: "medium" });
	assert.equal(checkpoint.trusted.stateVersion, 1);
	const one = await writeReceipt(directory, "same", { n: 1 });
	const two = await writeReceipt(directory, "same", { n: 2 });
	assert.notEqual(one, two);
	assert.deepEqual([basename(one), basename(two)], ["same.json", "same-1.json"]);
});

test("natural settlement requests at most one queued checkpoint turn", async () => {
	const pi = new FakePi();
	registerFriendlyStop(pi as any, valid("/tmp/checkpoints"));
	const ctx = context(pi, 200_000);
	await pi.emit("turn_end", {}, ctx);
	await pi.emit("agent_settled", {}, ctx);
	await pi.emit("agent_settled", {}, ctx);
	assert.equal(pi.messages.length, 1);
	assert.equal(pi.messages[0].options.triggerTurn, true);
	assert.equal(pi.entries.at(-1).data.phase, "turn-queued");
});

test("an uncheckpointed injected turn gets one bounded reminder then forces without recursion", async (t) => {
	const directory = await tempDir(t);
	const pi = new FakePi();
	registerFriendlyStop(pi as any, valid(directory));
	const ctx = context(pi, 200_000);
	await pi.emit("turn_end", {}, ctx);
	await pi.emit("context", { messages: [] }, ctx); // first friendly turn
	await pi.emit("agent_settled", {}, ctx); // queue reminder
	await pi.emit("agent_settled", {}, ctx); // duplicate settlement cannot queue again
	assert.equal(pi.messages.length, 1);
	assert.equal(pi.entries.at(-1).data.phase, "turn-queued");
	await pi.emit("context", { messages: [] }, ctx); // reminder turn
	await pi.emit("agent_settled", {}, ctx); // grace exhausted
	await pi.emit("agent_settled", {}, ctx); // forced state is terminal
	assert.equal(pi.messages.length, 1);
	assert.equal(ctx.abortCalls, 1);
	assert.equal(ctx.shutdownCalls, 0);
	assert.equal(pi.entries.at(-1).data.phase, "forced");
	assert.equal(JSON.parse(await readFile(pi.entries.at(-1).data.receiptPath, "utf8")).kind, "forced-stop");
});

test("a successful reminder checkpoint prevents further turns", async (t) => {
	const directory = await tempDir(t);
	const pi = new FakePi();
	registerFriendlyStop(pi as any, valid(directory));
	const ctx = context(pi, 200_000);
	await pi.emit("turn_end", {}, ctx);
	await pi.emit("context", { messages: [] }, ctx);
	await pi.emit("agent_settled", {}, ctx);
	await pi.emit("context", { messages: [] }, ctx);
	const result = await pi.tools[0].execute("call", {
		completedOperationIds: [], nextOperation: "next", symbolicUuidBindings: {}, failures: [], receiptPaths: [], notes: "done",
	}, undefined, undefined, ctx);
	await pi.emit("agent_settled", {}, ctx);
	assert.equal(result.terminate, true);
	assert.equal(pi.messages.length, 1);
	assert.equal(pi.entries.at(-1).data.phase, "checkpoint");
	assert.equal(ctx.abortCalls, 0);
	assert.equal(ctx.shutdownCalls, 0);
});

test("grace exhaustion writes forced receipt and aborts before another request", async (t) => {
	const directory = await tempDir(t);
	const pi = new FakePi();
	registerFriendlyStop(pi as any, valid(directory, { PI_RLM_FRIENDLY_STOP_GRACE_TURNS: "1" }));
	const ctx = context(pi, 200_000);
	await pi.emit("turn_end", {}, ctx);
	await pi.emit("context", { messages: [] }, ctx);
	await pi.emit("context", { messages: [] }, ctx);
	assert.equal(ctx.abortCalls, 1);
	assert.equal(ctx.shutdownCalls, 0);
	const forced = pi.entries.at(-1).data;
	assert.equal(forced.phase, "forced");
	assert.equal(JSON.parse(await readFile(forced.receiptPath, "utf8")).kind, "forced-stop");
});

test("reload reconstruction prevents duplicate injection and checkpoint", async (t) => {
	const directory = await tempDir(t);
	const firstPi = new FakePi();
	registerFriendlyStop(firstPi as any, valid(directory));
	const firstCtx = context(firstPi, 200_000);
	await firstPi.emit("turn_end", {}, firstCtx);
	await firstPi.emit("context", { messages: [] }, firstCtx);

	const reloadedPi = new FakePi();
	registerFriendlyStop(reloadedPi as any, valid(directory));
	const reloadCtx = context(reloadedPi, 200_000, firstPi.entries);
	await reloadedPi.emit("session_start", { reason: "reload" }, reloadCtx);
	assert.equal(reloadedPi.messages.length, 1);
	assert.equal(reloadedPi.entries.at(-1).data.phase, "turn-queued");
	assert.equal(await reloadedPi.emit("context", { messages: [] }, reloadCtx), undefined);

	const result = await reloadedPi.tools[0].execute("call", {
		completedOperationIds: [], nextOperation: "next", symbolicUuidBindings: {}, failures: [], receiptPaths: [], notes: "",
	}, undefined, undefined, reloadCtx);
	const completedBranch = [...firstPi.entries, ...reloadedPi.entries];
	const finalPi = new FakePi();
	registerFriendlyStop(finalPi as any, valid(directory));
	const finalCtx = context(finalPi, 200_000, completedBranch);
	await finalPi.emit("session_start", { reason: "reload" }, finalCtx);
	assert.equal(finalPi.messages.length, 0);
	await assert.rejects(() => finalPi.tools[0].execute("again", {
		completedOperationIds: [], nextOperation: "", symbolicUuidBindings: {}, failures: [], receiptPaths: [], notes: "",
	}, undefined, undefined, finalCtx), /already exists/);
	assert.ok(result.details.receiptPath);
});
