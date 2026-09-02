import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execPath } from "node:process";
import test from "node:test";
import vegaRewriter from "../vega-rewriter.ts";
import { runStreamingPi } from "./vega-rewriter-process.ts";

const env = process.env;

function harness() {
	const handlers = new Map<string, (...args: any[]) => any>();
	const entries: Array<{ type: string; data: any }> = [];
	const statuses = new Map<string, string | undefined>();
	let transformer: (markdown: string, context: any) => string = (markdown) => markdown;
	vegaRewriter({
		on: (event: string, handler: (...args: any[]) => any) => handlers.set(event, handler),
		appendEntry: (type: string, data: any) => entries.push({ type, data }),
		registerCommand: () => {},
		registerMarkdownTransformer: (value: typeof transformer) => { transformer = value; },
	} as any);
	const user = { type: "message", message: { role: "user", content: [{ type: "text", text: "question" }] } };
	const ctx = {
		mode: "tui", cwd: "/tmp", signal: new AbortController().signal,
		sessionManager: { getEntries: () => [], getBranch: () => [user] },
		ui: { setStatus: (key: string, text: string | undefined) => statuses.set(key, text) },
	};
	return { ctx, entries, handlers, statuses, transformer, user };
}

async function arm(value: ReturnType<typeof harness>) {
	await value.handlers.get("session_start")?.({}, value.ctx);
	await value.handlers.get("message_end")?.(value.user, value.ctx);
}

test("hides pending assistant text, then displays its rewrite without changing content", async () => {
	const dir = await mkdtemp(join(tmpdir(), "vega-rewriter-"));
	const executable = join(dir, "pi");
	const oldPath = env.PATH;
	try {
		await writeFile(executable, `#!${execPath}\nconsole.log(JSON.stringify({type:"message_update",assistantMessageEvent:{type:"text_delta",delta:"rewrite"}}));console.log(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:"rewritten"}]}}));\n`);
		await chmod(executable, 0o755);
		env.PATH = `${dir}:${oldPath}`;
		const value = harness();
		await arm(value);
		const content = [
			{ type: "text", text: "before" },
			{ type: "toolCall", id: "1", name: "read", arguments: {} },
			{ type: "text", text: "after" },
		];
		const original = structuredClone(content);
		assert.equal(value.transformer("before", { messageType: "assistant", isStreaming: true }), "before");
		const result = value.handlers.get("message_end")?.({ message: { role: "assistant", content } }, value.ctx);
		assert.deepEqual(content.map((block) => block.type === "text"
			? { ...block, text: value.transformer(block.text, { messageType: "assistant", isStreaming: true }) }
			: block), [
			{ type: "text", text: "" },
			original[1],
			{ type: "text", text: "" },
		]);
		assert.equal(value.statuses.get("vega"), "Translating...");
		assert.equal(await result, undefined);
		assert.deepEqual(content, original);
		assert.equal(value.statuses.get("vega"), undefined);
		assert.equal(value.transformer("before", { messageType: "assistant", isStreaming: true }), "before");
		assert.deepEqual(content.map((block) => block.type === "text"
			? { ...block, text: value.transformer(block.text, { messageType: "assistant", isStreaming: false }) }
			: block), [
			{ type: "text", text: "rewritten" },
			original[1],
			{ type: "text", text: "" },
		]);
		assert.equal(value.entries.at(-1)?.type, "vega-rewrite");
		assert.equal(value.entries.at(-1)?.data.rawResponse, "beforeafter");

		const aborted = new AbortController();
		aborted.abort();
		value.ctx.signal = aborted.signal;
		await value.handlers.get("message_end")?.({ message: { role: "assistant", content } }, value.ctx);
		assert.equal(value.transformer("before", { messageType: "assistant", isStreaming: false }), "before");
	} finally {
		env.PATH = oldPath;
		await rm(dir, { recursive: true, force: true });
	}
});

test("failed rewrites leave finalized display raw", async () => {
	const value = harness();
	await arm(value);
	const aborted = new AbortController();
	aborted.abort();
	value.ctx.signal = aborted.signal;
	const result = await value.handlers.get("message_end")?.({ message: { role: "assistant", content: [{ type: "text", text: "raw" }] } }, value.ctx);
	assert.equal(result, undefined);
	assert.equal(value.transformer("raw", { messageType: "assistant", isStreaming: false }), "raw");
	assert.equal(value.statuses.get("vega"), undefined);
	assert.equal(value.entries.at(-1)?.type, "vega-rewrite-failed");
});

test("reads the final assistant text from streaming JSON events", async () => {
	const script = [
		`console.log(JSON.stringify({type:"message_update",assistantMessageEvent:{type:"text_delta",delta:"hello"}}))`,
		`console.log(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:"hello world"}]}}))`,
	].join(";");
	assert.equal(await runStreamingPi(execPath, ["-e", script], {
		cwd: "/tmp", env, timeoutMs: 1_000, firstTokenTimeoutMs: 500,
	}), "hello world");
});

test("kills a rewrite that emits no first token", async () => {
	await assert.rejects(runStreamingPi(execPath, ["-e", "setTimeout(() => {}, 1000)"], {
		cwd: "/tmp", env, timeoutMs: 1_000, firstTokenTimeoutMs: 50,
	}), /first-token deadline exceeded/);
});

test("keeps the global deadline after the first token", async () => {
	const update = JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "started" } });
	await assert.rejects(runStreamingPi(execPath, ["-e", `console.log(${JSON.stringify(update)}); setTimeout(() => {}, 1000)`], {
		cwd: "/tmp", env, timeoutMs: 75, firstTokenTimeoutMs: 50,
	}), /rewrite deadline exceeded/);
});
