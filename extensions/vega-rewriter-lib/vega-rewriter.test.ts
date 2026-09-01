import assert from "node:assert/strict";
import { execPath } from "node:process";
import test from "node:test";
import { replaceAssistantText, runStreamingPi } from "./vega-rewriter-process.ts";

const env = process.env;

test("replaces assistant text and preserves tool calls", () => {
	assert.deepEqual(
		replaceAssistantText([
			{ type: "text", text: "raw" },
			{ type: "toolCall", id: "1", name: "read", arguments: {} },
			{ type: "text", text: "more raw" },
		], "rewritten"),
		[
			{ type: "text", text: "rewritten" },
			{ type: "toolCall", id: "1", name: "read", arguments: {} },
		],
	);
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
	await assert.rejects(
		runStreamingPi(execPath, ["-e", "setTimeout(() => {}, 1000)"], {
			cwd: "/tmp", env, timeoutMs: 1_000, firstTokenTimeoutMs: 50,
		}),
		/first-token deadline exceeded/,
	);
});

test("keeps the global deadline after the first token", async () => {
	const update = JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "started" } });
	await assert.rejects(
		runStreamingPi(execPath, ["-e", `console.log(${JSON.stringify(update)}); setTimeout(() => {}, 1000)`], {
			cwd: "/tmp", env, timeoutMs: 75, firstTokenTimeoutMs: 50,
		}),
		/rewrite deadline exceeded/,
	);
});
