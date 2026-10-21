import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

// Match Pi's runtime package alias without requiring local node_modules.
const pkg = join(homedir(), ".local/share/pi-mono/packages/coding-agent");
const { createJiti } = createRequire(join(pkg, "package.json"))("jiti");
const jiti = createJiti(import.meta.url, { alias: {
	"@mariozechner/pi-coding-agent": join(pkg, "dist/index.js"),
} });
const { getBackgroundJobManager, releaseBackgroundJobManager } = await jiti.import("../background-jobs/manager.ts");
const { default: activate } = await jiti.import("./index.ts");

type Handler = (event: unknown, ctx: unknown) => unknown;

const wait = () => new Promise((resolve) => setTimeout(resolve, 10));

test("publishes pane and session cache options through tmux", async (t) => {
	const handlers = new Map<string, Handler>();
	const listeners = new Map<string, ((data: unknown) => void)[]>();
	const options = new Map<string, string>();
	const messages: string[] = [];
	const cacheUpdates: unknown[] = [];
	const calls: string[][] = [];
	const intervals: (() => void)[] = [];
	const paneId = "%cache-test";
	const originalPane = process.env.TMUX_PANE;
	process.env.TMUX_PANE = paneId;

	const optionKey = (scope: string, target: string, name: string) =>
		`${scope}|${target}|${name}`;
	const pi = {
		sendUserMessage() {},
		on(event: string, handler: Handler) {
			handlers.set(event, handler);
		},
		events: {
			on(event: string, listener: (data: unknown) => void) {
				listeners.set(event, [...(listeners.get(event) ?? []), listener]);
			},
			emit(event: string, data: unknown) {
				for (const listener of listeners.get(event) ?? []) listener(data);
			},
		},
		async exec(command: string, args: string[]) {
			calls.push(args);
			assert.equal(command, "tmux");
			if (args[0] === "set-option") {
				const scope = args.includes("-p") ? "pane" : args.includes("-w") ? "window" : "session";
				const target = args[args.indexOf("-t") + 1] ?? "";
				const nameIndex = args.findIndex((arg) => arg.startsWith("@pi_cache"));
				const name = args[nameIndex];
				if (args.includes("-u")) options.delete(optionKey(scope, target, name));
				else options.set(optionKey(scope, target, name), args[nameIndex + 1]);
				return { stdout: "", code: 0 };
			}
			if (args[0] === "display-message" && args.includes("-p"))
				return { stdout: "$1\n", code: 0 };
			if (args[0] === "list-windows") return { stdout: "@1\n", code: 0 };
			if (args[0] === "list-panes") {
				return {
					stdout: `${paneId}|${options.get(optionKey("pane", paneId, "@pi_cache_data")) ?? ""}\n`,
					code: 0,
				};
			}
			if (args[0] === "list-sessions")
				return { stdout: "$1|cache-test\n", code: 0 };
			if (args[0] === "display-message") {
				messages.push(args.at(-1) ?? "");
				return { stdout: "", code: 0 };
			}
			throw new Error(`unexpected tmux call: ${args.join(" ")}`);
		},
	};
	listeners.set("cache-status:update", [(data) => cacheUpdates.push(data)]);
	const ctx = {
		model: { provider: "anthropic", id: "claude-fable-5", contextWindow: 200_000 },
		modelRegistry: { find: () => undefined },
		getContextUsage: () => ({ tokens: 44_000, contextWindow: 200_000, percent: 22 }),
		sessionManager: {
			getBranch: () => [],
			getEntries: () => [],
			getHeader: () => ({ timestamp: "2026-01-01T00:00:00.000Z" }),
		},
	};
	const originalSetInterval = globalThis.setInterval;
	const originalClearInterval = globalThis.clearInterval;
	globalThis.setInterval = ((callback: () => void) => {
		intervals.push(callback);
		return intervals.length as unknown as ReturnType<typeof setInterval>;
	}) as typeof setInterval;
	globalThis.clearInterval = (() => {}) as typeof clearInterval;

	const dir = await mkdtemp(join(tmpdir(), "pi-cache-background-"));
	activate(pi as never);
	t.after(async () => {
		releaseBackgroundJobManager(ctx as never);
		await rm(dir, { recursive: true, force: true });
		await handlers.get("session_shutdown")?.({}, ctx);
		globalThis.setInterval = originalSetInterval;
		globalThis.clearInterval = originalClearInterval;
		process.env.TMUX_PANE = originalPane;
	});
	handlers.get("session_start")?.({}, ctx);
	await wait();
	assert.ok(Array.isArray(cacheUpdates.at(-1)));
	assert.ok(options.get(optionKey("pane", paneId, "@pi_cache_data")));
	assert.match(
		options.get(optionKey("session", "$1", "@pi_cache_session")) ?? "",
		/NO CACHE/,
	);
	assert.deepEqual(
		JSON.parse(options.get(optionKey("session", "$1", "@pi_cache_state")) ?? ""),
		{ version: 1, entries: [], agentDone: false, agents: ["pi"] },
	);
	assert.match(
		options.get(optionKey("window", "@1", "@pi_cache_window")) ?? "",
		/RUN \$0\.00 TOTAL \$0\.00/,
	);

	const initialCalls = calls.length;
	handlers.get("agent_start")?.({}, ctx);
	await wait();
	const afterAgentStartCalls = calls.length;
	assert.ok(afterAgentStartCalls > initialCalls);
	assert.match(
		options.get(optionKey("pane", paneId, "@pi_cache_pane")) ?? "",
		/BUSY/,
	);

	const background = getBackgroundJobManager(pi as never, ctx as never);
	const state = () => JSON.parse(options.get(optionKey("session", "$1", "@pi_cache_state")) ?? "{}");
	const busyStartedAt = state().busyStartedAt;
	for (const gate of ["first", "last"]) {
		background.start({ command: `while [ ! -f '${join(dir, gate)}' ]; do sleep .02; done`, cwd: dir });
	}
	const settleWhileWaiting = async () => {
		handlers.get("agent_settled")?.({}, ctx);
		await wait();
		assert.equal(state().agentDone, false, "waiting on background work is not AGENT DONE");
		assert.equal(state().busyStartedAt, busyStartedAt);
		assert.match(options.get(optionKey("pane", paneId, "@pi_cache_pane")) ?? "", /BUSY/);
		assert.doesNotMatch(messages.join("\n"), /AGENT DONE/);
	};
	await settleWhileWaiting();
	const finishJob = async (gate: string, remaining: number) => {
		await writeFile(join(dir, gate), "");
		for (let i = 0; i < 300 && background.stats().running !== remaining; i++) await wait();
		assert.equal(background.stats().running, remaining);
	};
	await finishJob("first", 1);
	await settleWhileWaiting();

	// Reload/branch refresh must not restore a checkmark while the job is live.
	for (const event of ["session_start", "session_tree", "session_compact"]) {
		handlers.get(event)?.({}, ctx);
		await wait();
		assert.equal(state().agentDone, false);
		assert.equal(typeof state().busyStartedAt, "number");
	}
	await finishJob("last", 0);
	// The completion notice resumes Pi; only its final settled turn is done.
	handlers.get("agent_start")?.({}, ctx);
	handlers.get("agent_settled")?.({}, ctx);
	await wait();
	assert.equal(state().agentDone, true);
	assert.equal(state().busyStartedAt, undefined);
	const afterAgentSettledCalls = calls.length;
	assert.ok(afterAgentSettledCalls > afterAgentStartCalls);
	assert.match(messages.at(-1) ?? "", /\[pi\] \(0\) cache-test: AGENT DONE/);

	handlers.get("before_provider_request")?.({ payload: {} }, ctx);
	await wait();
	const afterRequestCalls = calls.length;
	assert.ok(afterRequestCalls > afterAgentSettledCalls);

	for (const cacheRead of [1, 2]) {
		handlers.get("message_update")?.(
			{
				message: {
					role: "assistant",
					provider: "anthropic",
					model: "claude-fable-5",
					usage: { cacheRead },
				},
			},
			ctx,
		);
	}
	assert.equal(calls.length, afterRequestCalls);

	const periodicTick = intervals[0];
	assert.ok(periodicTick);
	const updatesBeforeTick = cacheUpdates.length;
	periodicTick();
	await wait();
	assert.equal(calls.length, afterRequestCalls);
	assert.ok(cacheUpdates.length > updatesBeforeTick);

	handlers.get("message_end")?.(
		{
			message: {
				role: "assistant",
				provider: "anthropic",
				model: "claude-fable-5",
				usage: { cacheRead: 2 },
			},
		},
		ctx,
	);
	await wait();
	assert.ok(calls.length > afterRequestCalls);
	const snapshot = JSON.parse(
		Buffer.from(options.get(optionKey("pane", paneId, "@pi_cache_data")) ?? "", "base64url").toString(),
	) as { entries: { result?: string }[] };
	assert.equal(snapshot.entries[0]?.result, "REUSED");
	assert.equal(
		JSON.parse(options.get(optionKey("session", "$1", "@pi_cache_state")) ?? "").entries[0]?.result,
		"REUSED",
	);

	let eventCalls = calls.length;
	for (const event of ["model_select", "session_switch", "session_tree", "session_compact"]) {
		handlers.get(event)?.({}, ctx);
		await wait();
		assert.ok(calls.length > eventCalls, `${event} did not publish`);
		eventCalls = calls.length;
	}

	await handlers.get("session_shutdown")?.({}, ctx);
	assert.equal(options.get(optionKey("pane", paneId, "@pi_cache_data")), undefined);
	assert.equal(options.get(optionKey("window", paneId, "@pi_cache_window")), undefined);
	assert.equal(options.get(optionKey("session", "$1", "@pi_cache_state")), undefined);
});
