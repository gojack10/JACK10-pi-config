import assert from "node:assert/strict";
import test from "node:test";
import { enforceForegroundTimeout, FOREGROUND_TIMEOUT_SECONDS } from "./policy.ts";

test("foreground bash hides agent timeout control and always injects the shared limit", async () => {
	let received: unknown;
	const bash = enforceForegroundTimeout({
		description: "Run bash. Optionally provide a timeout in seconds.",
		parameters: {
			type: "object",
			properties: { command: { type: "string" }, timeout: { type: "number" } },
		},
		promptGuidelines: ["Existing guidance."],
		async execute(_id: string, input: unknown) {
			received = input;
			return "ok";
		},
	});

	assert.deepEqual(Object.keys(bash.parameters.properties), ["command"]);
	assert.ok(bash.description.includes(`automatically stopped after ${FOREGROUND_TIMEOUT_SECONDS} seconds`));
	assert.doesNotMatch(bash.description, /Optionally provide a timeout/);
	assert.ok(bash.promptGuidelines.some((line) => line.includes("bash_bg")));
	assert.equal(await bash.execute("call", { command: "make test", timeout: 1 }), "ok");
	assert.deepEqual(received, { command: "make test", timeout: FOREGROUND_TIMEOUT_SECONDS });
});

test("only foreground timeout errors append background retry guidance", async () => {
	const timeout = new Error(`partial output\n\nCommand timed out after ${FOREGROUND_TIMEOUT_SECONDS} seconds`);
	const aborted = new Error("Command aborted");
	const other = new Error("spawn failed");
	const outputMentionsTimeout = new Error("Command timed out after 1 seconds\nCommand terminated without an exit code");
	const bash = enforceForegroundTimeout({
		description: "Run bash.",
		parameters: { properties: { command: {} } },
		execute(_id: string, { command }: { command: string }) {
			throw { timeout, aborted, other, outputMentionsTimeout }[command];
		},
	});
	await assert.rejects(bash.execute("call", { command: "timeout" }), error => {
		assert.equal(error, timeout);
		assert.ok(error.message.startsWith(`partial output\n\nCommand timed out after ${FOREGROUND_TIMEOUT_SECONDS} seconds\n\n`));
		assert.ok(error.message.includes(`exceeded bash's ${FOREGROUND_TIMEOUT_SECONDS}-second limit`));
		assert.match(error.message, /Run this command once with bash_bg/);
		return true;
	});
	for (const [command, error] of Object.entries({ aborted, other, outputMentionsTimeout })) {
		const before = error.message;
		await assert.rejects(bash.execute("call", { command }), actual => actual === error);
		assert.equal(error.message, before);
	}
});
