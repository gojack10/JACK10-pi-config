import assert from "node:assert/strict";
import test from "node:test";
import kevEntryGuard from "../kev-entry-guard.ts";

function makeToolBoundary() {
	let check: (event: any) => { block?: boolean; reason?: string } | undefined;
	kevEntryGuard({ on: (_event: string, handler: typeof check) => { check = handler; } } as any);
	const executed: string[] = [];
	return {
		executed,
		call(toolName: string, command: string) {
			const verdict = check({ type: "tool_call", toolCallId: "trial", toolName, input: { command } });
			if (!verdict?.block) executed.push(command); // fake executor: no process, HTTP request or GPU work
			return verdict;
		},
	};
}

test("Pi tool admission blocks plain Kev launch and direct :8009 calls before execution", () => {
	const boundary = makeToolBoundary();
	for (const [tool, command] of [
		["bash", "uv run --extra serve python -m kev.serve --run jaredpalmer/kev-4b --port 8009"],
		["bash_bg", "/Users/jack/kev/venv/bin/python /Users/jack/kev/upstream/kev/serve.py --port 8008"],
		["bash", "uvicorn kev.serve:app --port 8888"],
		["bash", "curl -X POST http://127.0.0.1:8009/v1/systemone"],
		["bash_bg", "curl http://localhost:8009/v1/models"],
		["powershell", "Invoke-RestMethod http://[::1]:8009/v1/systemone"],
	]) {
		assert.equal(boundary.call(tool, command)?.block, true, command);
	}
	assert.deepEqual(boundary.executed, []);
});

test("managed :8002 route and unrelated development pass through", () => {
	const boundary = makeToolBoundary();
	for (const [tool, command] of [
		["bash", "curl -X POST http://127.0.0.1:8002/v1/systemone"],
		["bash_bg", "uv run python tests/test_kev_source_pin.py"],
		["bash", "node --test extensions/kev-entry-guard/*.test.ts"],
	]) {
		assert.equal(boundary.call(tool, command)?.block, undefined, command);
	}
	assert.equal(boundary.executed.length, 3);
});
