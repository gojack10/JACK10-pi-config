import assert from "node:assert/strict";
import test from "node:test";
import { enforceForegroundTimeout, FOREGROUND_TIMEOUT_SECONDS } from "./policy.ts";

test("foreground bash hides agent timeout control and always injects 120 seconds", async () => {
	let received: unknown;
	const bash = enforceForegroundTimeout({
		description: "Run bash.",
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

	assert.equal(FOREGROUND_TIMEOUT_SECONDS, 120);
	assert.deepEqual(Object.keys(bash.parameters.properties), ["command"]);
	assert.match(bash.description, /automatically stopped after 120 seconds/);
	assert.ok(bash.promptGuidelines.some((line) => line.includes("bash_bg")));
	assert.equal(await bash.execute("call", { command: "make test", timeout: 1 }), "ok");
	assert.deepEqual(received, { command: "make test", timeout: 120 });
});
