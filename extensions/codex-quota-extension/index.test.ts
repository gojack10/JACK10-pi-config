import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const wait = () => new Promise((resolve) => setTimeout(resolve, 20));

test("captures Codex response headers and publishes state", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "codex-quota-home-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	const oldHome = process.env.HOME;
	process.env.HOME = home;
	t.after(() => {
		process.env.HOME = oldHome;
	});
	const { default: activate } = await import(`./index.ts?test=${Date.now()}`);
	const handlers = new Map<string, (event: any, ctx: any) => unknown>();
	const updates: any[] = [];
	const pi = {
		on(name: string, handler: (event: any, ctx: any) => unknown) {
			handlers.set(name, handler);
		},
		events: { emit: (name: string, data: unknown) => name === "codex-usage:update" && updates.push(data) },
	};
	const ctx = {
		hasUI: false,
		model: { provider: "openai-codex-alt" },
		ui: { notify() {} },
	};
	activate(pi as never);
	await handlers.get("session_start")?.({}, ctx);
	await handlers.get("after_provider_response")?.(
		{
			status: 200,
			headers: {
				"x-codex-plan-type": "edu",
				"x-codex-primary-window-minutes": "300",
				"x-codex-primary-used-percent": "46",
				"x-codex-primary-reset-at": "2000000000",
				"x-codex-secondary-window-minutes": "0",
			},
		},
		ctx,
	);
	await wait();
	const state = JSON.parse(
		await readFile(join(home, ".pi", "agent", "codex-usage-state.json"), "utf8"),
	);
	assert.equal(state.accounts[0].windows[0].minutes, 300);
	assert.equal(state.current, "openai-codex-alt");
	assert.equal(updates.at(-1).state.accounts[0].windows[0].pctUsed, 46);
	await handlers.get("session_shutdown")?.({}, ctx);
});
