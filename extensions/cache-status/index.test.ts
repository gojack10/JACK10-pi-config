import assert from "node:assert/strict";
import test from "node:test";
import activate from "./index.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

const wait = () => new Promise((resolve) => setTimeout(resolve, 10));

test("publishes pane and session cache options through tmux", async (t) => {
	const handlers = new Map<string, Handler>();
	const listeners = new Map<string, ((data: unknown) => void)[]>();
	const options = new Map<string, string>();
	const messages: string[] = [];
	const paneId = "%cache-test";
	const originalPane = process.env.TMUX_PANE;
	process.env.TMUX_PANE = paneId;

	const optionKey = (scope: string, target: string, name: string) =>
		`${scope}|${target}|${name}`;
	const pi = {
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

	activate(pi as never);
	t.after(async () => {
		await handlers.get("session_shutdown")?.({}, ctx);
		process.env.TMUX_PANE = originalPane;
	});
	handlers.get("session_start")?.({}, ctx);
	await wait();
	assert.ok(options.get(optionKey("pane", paneId, "@pi_cache_data")));
	assert.match(
		options.get(optionKey("session", "$1", "@pi_cache_session")) ?? "",
		/NO CACHE/,
	);
	assert.match(
		options.get(optionKey("window", "@1", "@pi_cache_window")) ?? "",
		/RUN \$0\.00 TOTAL \$0\.00/,
	);

	handlers.get("agent_start")?.({}, ctx);
	handlers.get("agent_settled")?.({}, ctx);
	await wait();
	assert.match(messages.at(-1) ?? "", /\[pi\] \(0\) cache-test: AGENT DONE/);

	await handlers.get("session_shutdown")?.({}, ctx);
	assert.equal(options.get(optionKey("pane", paneId, "@pi_cache_data")), undefined);
});
