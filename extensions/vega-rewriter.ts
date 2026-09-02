import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { mkdir, readFile, rmdir, stat } from "node:fs/promises";
import { connect } from "node:net";
import { DisplayRewrites, runStreamingPi, textOf } from "./vega-rewriter-lib/vega-rewriter-process.ts";

const PROMPT_PATH = "/Users/jack/.pi/agent/vega-presenter.md";
const PROVIDER_EXTENSION = "/Users/jack/.pi/agent/extensions/tunnel-llm-proxy.ts";
const LOCAL_LOCK = "/tmp/vega-rewriter-local.lock";
const NORMAL_TIMEOUT_MS = 30_000;
const OPENROUTER_FIRST_TOKEN_MS = 15_000;
const EMERGENCY_TIMEOUT_MS = 30_000;

type Route = "local" | "openrouter" | "luna";

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function tcpAvailable(signal?: AbortSignal): Promise<boolean> {
	return new Promise((resolve) => {
		if (signal?.aborted) return resolve(false);
		const socket = connect({ host: "127.0.0.1", port: 8002 });
		const timer = setTimeout(() => finish(false), 500);
		const finish = (available: boolean) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			socket.destroy();
			resolve(available);
		};
		const onAbort = () => finish(false);
		signal?.addEventListener("abort", onAbort, { once: true });
		socket.once("connect", () => finish(true));
		socket.once("error", () => finish(false));
	});
}

async function acquireLocalLock(): Promise<boolean> {
	try {
		await mkdir(LOCAL_LOCK);
		return true;
	} catch {
		try {
			if (Date.now() - (await stat(LOCAL_LOCK)).mtimeMs <= 45_000) return false;
			await rmdir(LOCAL_LOCK);
			await mkdir(LOCAL_LOCK);
			return true;
		} catch {
			return false;
		}
	}
}

async function healthIsFree(signal?: AbortSignal): Promise<boolean> {
	const timeout = AbortSignal.timeout(2_000);
	const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
	try {
		const response = await fetch("http://127.0.0.1:8002/health", { signal: combined });
		if (!response.ok) return false;
		const body = await response.json() as { ds4_active_requests?: unknown };
		return body.ds4_active_requests === 0;
	} catch {
		return false;
	}
}

function routeArgs(route: Route, prompt: string, input: string): string[] {
	const local = route === "local";
	return [
		"--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-tools",
		"--thinking", "off", "--mode", "json",
		...(local ? ["-e", PROVIDER_EXTENSION] : []),
		"--provider", local ? "tunnel" : "openrouter",
		"--model", route === "luna" ? "openai/gpt-5.6-luna" : route === "local" ? "glm-5.3-flash" : "z-ai/glm-5.3-flash",
		"--system-prompt", prompt,
		input,
	];
}

async function invoke(route: Route, prompt: string, input: string, cwd: string, timeoutMs: number, signal: AbortSignal): Promise<string> {
	return runStreamingPi("pi", routeArgs(route, prompt, input), {
		cwd,
		env: { ...process.env, PI_REQUEST_ORIGIN: "vega-rewriter" },
		timeoutMs,
		firstTokenTimeoutMs: route === "openrouter" ? Math.min(OPENROUTER_FIRST_TOKEN_MS, timeoutMs) : undefined,
		signal,
	});
}

export default function vegaRewriter(pi: ExtensionAPI) {
	let enabled = true;
	let armed = false;
	let tuiMode = false;
	let lifetime = new AbortController();
	const rewrites = new DisplayRewrites();

	pi.registerMarkdownTransformer((markdown, { messageType, isStreaming }) =>
		tuiMode && enabled && messageType === "assistant" && (!isStreaming || rewrites.isPending(markdown)) ? rewrites.transform(markdown) : markdown);

	pi.registerCommand("rewrite", {
		description: "Toggle VEGA response rewriting for this session",
		handler: async (_args, ctx) => {
			enabled = !enabled;
			pi.appendEntry("vega-rewriter-state", { enabled });
			ctx.ui.notify(`VEGA rewriting ${enabled ? "on" : "off"}`, "info");
		},
	});

	pi.on("session_start", (_event, ctx) => {
		enabled = true;
		armed = false;
		tuiMode = ctx.mode === "tui";
		lifetime = new AbortController();
		rewrites.clear();
		for (const entry of ctx.sessionManager.getEntries() as Array<any>) {
			if (entry.type === "custom" && entry.customType === "vega-rewriter-state" && typeof entry.data?.enabled === "boolean") enabled = entry.data.enabled;
		}
	});

	pi.on("session_shutdown", () => lifetime.abort());

	pi.on("message_end", async (event, ctx) => {
		if (!tuiMode) return;
		if (event.message.role === "user") {
			armed = true;
			return;
		}
		if (event.message.role !== "assistant" || !armed || !enabled) return;
		const rawResponse = textOf(event.message.content);
		if (!rawResponse.trim()) return;

		const operatorMessage = [...ctx.sessionManager.getBranch() as Array<any>]
			.reverse()
			.find((entry) => entry.type === "message" && entry.message?.role === "user");
		const operatorText = operatorMessage ? textOf(operatorMessage.message.content) : "";
		const signal = ctx.signal ? AbortSignal.any([ctx.signal, lifetime.signal]) : lifetime.signal;
		rewrites.setPending(event.message.content);
		ctx.ui.setStatus("vega", "Translating...");
		try {
			await runJob(ctx, operatorText, rawResponse, event.message.content, signal);
		} finally {
			ctx.ui.setStatus("vega", undefined);
			rewrites.finish(event.message.content);
		}
	});

	async function runJob(ctx: ExtensionContext, operatorMessage: string, rawResponse: string, content: unknown, signal: AbortSignal): Promise<void> {
		const started = Date.now();
		let route: Route = "openrouter";
		let primaryError = "";
		let lockHeld = false;
		let promptSha256 = "";

		try {
			signal.throwIfAborted();
			const prompt = await readFile(PROMPT_PATH, "utf8");
			promptSha256 = createHash("sha256").update(prompt).digest("hex");
			const input = `SOURCE RULE: Rewrite only RAW AGENT RESPONSE. CURRENT OPERATOR MESSAGE controls selection but is never output material; do not quote, echo, or paraphrase it.\n\nCURRENT OPERATOR MESSAGE:\n${operatorMessage}\n\nRAW AGENT RESPONSE:\n${rawResponse}`;
			const normalDeadline = started + NORMAL_TIMEOUT_MS;

			lockHeld = await acquireLocalLock();
			if (lockHeld && await tcpAvailable(signal) && await healthIsFree(signal)) route = "local";
			if (lockHeld && route !== "local") {
				await rmdir(LOCAL_LOCK).catch(() => {});
				lockHeld = false;
			}

			let rewrite: string | undefined;
			for (const candidate of route === "local" ? ["local", "openrouter"] as const : ["openrouter"] as const) {
				route = candidate;
				try {
					const remaining = normalDeadline - Date.now();
					if (remaining <= 0) throw new Error("normal rewrite deadline exceeded");
					rewrite = await invoke(route, prompt, input, ctx.cwd, remaining, signal);
					break;
				} catch (error) {
					primaryError += `${primaryError ? "; " : ""}${route}: ${errorText(error)}`;
					if (lockHeld) {
						await rmdir(LOCAL_LOCK).catch(() => {});
						lockHeld = false;
					}
				}
			}
			if (!rewrite) {
				route = "luna";
				const remaining = normalDeadline - Date.now();
				if (remaining <= 0) throw new Error(`${primaryError}; normal rewrite deadline exceeded`);
				rewrite = await invoke("luna", prompt, input, ctx.cwd, Math.min(EMERGENCY_TIMEOUT_MS, remaining), signal);
			}

			if (operatorMessage.trim() && rewrite.includes(operatorMessage.trim())) {
				throw new Error("unsafe rewrite rejected: output echoed operator message");
			}
			rewrites.set(content, rewrite);
			pi.appendEntry("vega-rewrite", {
				operatorMessage,
				rawResponse,
				rewrite,
				route,
				model: route === "local" ? "glm-5.3-flash" : route === "openrouter" ? "z-ai/glm-5.3-flash" : "openai/gpt-5.6-luna",
				durationMs: Date.now() - started,
				promptSha256,
				primaryError,
				timestamp: new Date().toISOString(),
			});
		} catch (error) {
			rewrites.delete(content);
			pi.appendEntry("vega-rewrite-failed", {
				rawText: rawResponse,
				error: errorText(error),
				primaryError,
				route,
				durationMs: Date.now() - started,
				promptSha256,
				timestamp: new Date().toISOString(),
			});
		} finally {
			if (lockHeld) await rmdir(LOCAL_LOCK).catch(() => {});
		}
	}
}
