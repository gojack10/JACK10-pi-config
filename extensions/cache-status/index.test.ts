import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

const pkg = join(homedir(), ".local/share/pi-mono/packages/coding-agent");
const { createJiti } = createRequire(join(pkg, "package.json"))("jiti");
const jiti = createJiti(import.meta.url, { alias: {
	"@mariozechner/pi-coding-agent": join(pkg, "dist/index.js"),
	"@earendil-works/pi-coding-agent": join(pkg, "dist/index.js"),
} });
const { default: activate } = await jiti.import("./index.ts");
const { getBackgroundJobManager, releaseBackgroundJobManager } = await jiti.import("../background-jobs/manager.ts");

test("publishes busy/done to tmux, keeps background waiters busy, and clears on shutdown", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pi-status-"));
	const gate = join(dir, "finished");
	const originalPane = process.env.TMUX_PANE;
	process.env.TMUX_PANE = "%status-test";
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const options = new Map<string, string>();
	const key = (scope: string, target: string, name: string) => `${scope}|${target}|${name}`;
	const pi = {
		sendUserMessage() {},
		on(event: string, handler: (event: unknown, ctx: unknown) => unknown) { handlers.set(event, handler); },
		async exec(command: string, args: string[]) {
			assert.equal(command, "tmux");
			if (args[0] === "set-option") {
				const scope = args.includes("-p") ? "pane" : args.includes("-w") ? "window" : "session";
				const target = args[args.indexOf("-t") + 1];
				const i = args.findIndex((arg) => arg.startsWith("@pi_cache"));
				if (args.includes("-u")) options.delete(key(scope, target, args[i]));
				else options.set(key(scope, target, args[i]), args[i + 1]);
				return { stdout: "", code: 0 };
			}
			if (args[0] === "display-message" && args.includes("-p")) return { stdout: "$1\n", code: 0 };
			if (args[0] === "list-windows") return { stdout: "@1\n", code: 0 };
			if (args[0] === "list-panes") return { stdout: `%status-test|${options.get(key("pane", "%status-test", "@pi_cache_data")) ?? ""}\n`, code: 0 };
			assert.fail(`unexpected tmux call (no popup warnings): ${args.join(" ")}`);
		},
	};
	let idle = true;
	const ctx = {
		mode: "tui", isIdle: () => idle,
		model: undefined, modelRegistry: { find: () => undefined },
		getContextUsage: () => undefined,
		sessionManager: { getBranch: () => [], getEntries: () => [], getHeader: () => undefined },
	};
	activate(pi);
	const emit = (name: string, event = {}) => handlers.get(name)?.(event, ctx);
	const state = () => JSON.parse(options.get(key("session", "$1", "@pi_cache_state")) ?? "{}");
	t.after(async () => {
		await writeFile(gate, "");
		releaseBackgroundJobManager(ctx);
		await emit("session_shutdown");
		if (originalPane === undefined) delete process.env.TMUX_PANE;
		else process.env.TMUX_PANE = originalPane;
		await rm(dir, { recursive: true, force: true });
	});
	await emit("session_start");
	assert.equal(state().agentDone, false);
	idle = false;
	await emit("agent_start");
	assert.equal(typeof state().busyStartedAt, "number");
	assert.match(options.get(key("pane", "%status-test", "@pi_cache_pane")) ?? "", /fg=yellow.*BUSY/);
	const background = getBackgroundJobManager(pi, ctx);
	background.start({ command: `while [ ! -f '${gate}' ]; do sleep .02; done`, cwd: dir });
	idle = true;
	await emit("agent_settled");
	assert.equal(state().agentDone, false);
	for (const event of ["session_start", "session_tree", "session_compact"]) {
		await emit(event);
		assert.equal(typeof state().busyStartedAt, "number");
		assert.equal(state().agentDone, false);
	}
	await writeFile(gate, "");
	for (let i = 0; i < 200 && background.stats().running; i++) await delay(10);
	assert.equal(background.stats().running, 0);
	// Only the parent's settled response to the completion means done.
	await emit("agent_start");
	await emit("agent_settled");
	assert.equal(state().agentDone, true);
	assert.equal(state().busyStartedAt, undefined);
	assert.match(options.get(key("session", "$1", "@pi_cache_session")) ?? "", /fg=green.*AGENT DONE/);
	await emit("session_shutdown");
	assert.equal(options.get(key("pane", "%status-test", "@pi_cache_data")), undefined);
	assert.equal(options.get(key("session", "$1", "@pi_cache_state")), undefined);
});
