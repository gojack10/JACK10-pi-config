import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { isolateLauncherEnvironment } from "../extensions/_test-helpers/launcher-env.ts";

const restoreEnvironment = isolateLauncherEnvironment();
test.after(restoreEnvironment);
const packageDir = join(homedir(), ".local/share/pi-mono/packages/coding-agent");
const require = createRequire(join(packageDir, "package.json"));
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { alias: {
	"@mariozechner/pi-coding-agent": join(packageDir, "dist/index.js"),
	"@earendil-works/pi-coding-agent": join(packageDir, "dist/index.js"),
} });
const { registerFriendlyStop } = await jiti.import("./rlm-friendly-stop.ts");

class FakePi {
	handlers = new Map<string, any[]>();
	entries: any[] = [];
	on(name: string, handler: any) { this.handlers.set(name, [...(this.handlers.get(name) ?? []), handler]); }
	appendEntry(customType: string, data: any) { this.entries.push({ type: "custom", customType, data: structuredClone(data) }); }
	async emit(name: string, event: any, ctx: any) {
		let result;
		for (const handler of this.handlers.get(name) ?? []) result = await handler(event, ctx) ?? result;
		return result;
	}
}
function harness(tokens: number | null = 319999, contextWindow = 400000) {
	const pi = new FakePi();
	const active: any = { jobId: "job", attemptId: "attempt", mode: "task", reportPath: "/tmp/report.md", state: "active", pendingWork: [] };
	const ctx: any = {
		model: { provider: "local", id: "qwen3.8-flash-next" },
		getContextUsage: () => ({ tokens, contextWindow, percent: null }),
		sessionManager: { getBranch: () => pi.entries },
		abort: () => assert.fail("friendly reporting must not abort"),
	};
	const registry = (globalThis as any)[Symbol.for("pi.task-outcomes.manager-registry")] ??= new WeakMap();
	registry.set(ctx.sessionManager, { snapshot: () => ({ active }) });
	registerFriendlyStop(pi);
	return { pi, ctx, active };
}
const boundary = { outcome: "completed", continue: false, context: { canContinue: true } };

test("automatic 80% threshold uses every model's effective window, not legacy settings", async () => {
	for (const window of [128000, 272000, 1048576]) {
		const h = harness(Math.floor(window * 0.8) - 1, window);
		assert.equal(await h.pi.emit("context", { messages: [] }, h.ctx), undefined);
		h.ctx.getContextUsage = () => ({ tokens: Math.floor(window * 0.8), contextWindow: window });
		const result = await h.pi.emit("context", { messages: [] }, h.ctx);
		assert.match(result.messages.at(-1).content, /80%.*report_outcome/);
		assert.equal(h.pi.entries.length, 1);
		await h.pi.emit("context", { messages: [] }, h.ctx);
		assert.equal(h.pi.entries.length, 1, "arm once per attempt");
	}
	for (const [tokens, window] of [[null, 100], [90, 0], [NaN, 100], [90, Infinity]]) {
		const h = harness(tokens, window!);
		assert.equal(await h.pi.emit("context", { messages: [] }, h.ctx), undefined);
	}
	const ordinary = harness(400000);
	(globalThis as any)[Symbol.for("pi.task-outcomes.manager-registry")].delete(ordinary.ctx.sessionManager);
	assert.equal(await ordinary.pi.emit("context", { messages: [] }, ordinary.ctx), undefined, "ordinary chat has no report contract");
});

test("wrap-up permits report IO and draining existing work, blocks new work and cleanup, and has no turn limit", async () => {
	const h = harness(320000);
	for (const toolName of ["read", "write", "edit", "bash", "bash_tail", "bash_jobs", "bash_kill", "report_outcome"]) {
		assert.equal(await h.pi.emit("tool_call", { toolName }, h.ctx), undefined);
	}
	for (const toolName of ["sifttext_create_node", "subagent_launch", "bash_bg", "subagent_clean_and_continue", "rlm_rollover_checkpoint"]) {
		assert.equal((await h.pi.emit("tool_call", { toolName }, h.ctx)).block, true);
	}
	for (let i = 0; i < 5; i++) {
		assert.equal((await h.pi.emit("agent_before_settle", boundary, h.ctx)).continue, true);
	}
	h.active.pendingWork = ["child:still-running"];
	assert.equal(await h.pi.emit("agent_before_settle", boundary, h.ctx), undefined);
	h.active.pendingWork = [];
	h.active.declaration = { outcome: "completed" };
	assert.equal(await h.pi.emit("agent_before_settle", boundary, h.ctx), undefined);
	assert.equal(await h.pi.emit("context", { messages: [] }, h.ctx), undefined);
});

test("Escape/errors/maintenance stay interruptible; same-attempt wrap-up survives reload, not new attempts or branches", async () => {
	const h = harness(320000);
	await h.pi.emit("context", { messages: [] }, h.ctx);
	for (const event of [{ ...boundary, outcome: "aborted" }, { ...boundary, outcome: "error" }, { ...boundary, continue: true }]) {
		assert.equal(await h.pi.emit("agent_before_settle", event, h.ctx), undefined);
	}
	h.ctx.getContextUsage = () => ({ tokens: 1, contextWindow: 400000 });
	await h.pi.emit("session_start", {}, h.ctx);
	assert.equal((await h.pi.emit("agent_before_settle", boundary, h.ctx)).continue, true);
	h.active.state = "context_paused";
	assert.equal(await h.pi.emit("agent_before_settle", boundary, h.ctx), undefined);
	h.active.state = "active";
	h.active.attemptId = "new-attempt";
	assert.equal(await h.pi.emit("agent_before_settle", boundary, h.ctx), undefined);
	h.active.attemptId = "attempt";
	h.ctx.sessionManager.getBranch = () => [];
	await h.pi.emit("session_tree", {}, h.ctx);
	assert.equal(await h.pi.emit("agent_before_settle", boundary, h.ctx), undefined);
});

test("real Pi lifecycle forces current-report completion without checkpoint/cleanup or summary length cap", async t => {
	const dir = await mkdtemp(join(tmpdir(), "friendly-report-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const sdk = await import(pathToFileURL(join(packageDir, "dist/index.js")).href);
	const { createAssistantMessageEventStream } = await import(pathToFileURL(join(packageDir, "../ai/dist/index.js")).href);
	const provider = "test-friendly-report";
	const model = { provider, id: "qwen3.8-flash-next", name: "Synthetic", api: "test-friendly-report", baseUrl: "https://invalid.invalid",
		reasoning: false, input: ["text"], contextWindow: 100000, maxTokens: 4096,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
	const runtime = await sdk.ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: join(dir, "models.json") });
	await runtime.setRuntimeApiKey(provider, "synthetic-only");
	const reportPath = join(dir, "report.md");
	const longReport = "Verified partial findings and remaining work.\n".repeat(1000);
	let calls = 0;
	runtime.registerProvider(provider, { api: model.api, streamSimple: (_model: any, context: any) => {
		const stream = createAssistantMessageEventStream();
		void (async () => {
			calls++;
			if (calls > 4) throw new Error("reporting did not terminate");
			if (calls > 1) assert.ok(context.messages.some((m: any) => JSON.stringify(m).includes("FRIENDLY STOP")));
			// Two prose-only turns prove the final actionable boundary insists on a report.
			const content = calls < 3 ? [{ type: "text", text: "partial findings, still unfinished" }] : calls === 3
				? [{ type: "toolCall", id: "write-report", name: "write", arguments: { path: reportPath, content: longReport } }]
				: [{ type: "toolCall", id: "declare-report", name: "report_outcome", arguments: { outcome: "completed", summary: longReport } }];
			const message = { role: "assistant", api: model.api, provider, model: model.id, content,
				stopReason: calls < 3 ? "stop" : "toolUse", timestamp: Date.now(),
				usage: { input: 80000, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 80001, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
			stream.push({ type: "done", reason: message.stopReason, message });
			stream.end(message);
		})().catch(error => stream.end({ role: "assistant", content: [], stopReason: "error", errorMessage: String(error) }));
		return stream;
	} });
	const sm = sdk.SessionManager.create(dir, dir);
	const services = await sdk.createAgentSessionServices({ cwd: dir, agentDir: dir, modelRuntime: runtime,
		settingsManager: sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
		resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
			additionalExtensionPaths: [fileURLToPath(new URL("../extensions/task-outcomes.ts", import.meta.url)), fileURLToPath(new URL("./rlm-friendly-stop.ts", import.meta.url))] } });
	const { session, extensionsResult } = await sdk.createAgentSessionFromServices({ services, sessionManager: sm, model, thinkingLevel: "off" });
	t.after(() => session.dispose());
	assert.deepEqual(extensionsResult.errors, []);
	await session.bindExtensions({ mode: "print" });
	const manager = (globalThis as any)[Symbol.for("pi.task-outcomes.manager-registry")].get(sm);
	manager.activateContract({ jobId: "friendly", attemptId: "same-attempt", mode: "task", reportPath });
	await session.prompt("Gather findings. At the friendly stop, complete the partial-progress report, not the unfinished assignment.");
	assert.equal(calls, 4);
	assert.equal(await readFile(reportPath, "utf8"), longReport);
	const final = manager.snapshot().outcomes.at(-1);
	assert.equal(final.outcome, "completed");
	assert.equal(final.source, "model");
	assert.equal(final.attemptId, "same-attempt");
	assert.equal(final.summary, longReport);
	assert.equal(manager.snapshot().outcomes.length, 1);
	assert.equal(sm.getBranch().some((entry: any) => /context_pause|context_resume|maintenance_begin/.test(entry.data?.kind ?? "")), false);
	assert.equal(sm.getBranch().filter((entry: any) => entry.customType === "rlm-friendly-stop-state" && entry.type === "custom").length, 1);
});
