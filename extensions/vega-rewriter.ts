import { getMarkdownTheme, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Markdown } from "@earendil-works/pi-tui";
import { createHash } from "node:crypto";
import { mkdir, readFile, rmdir, stat } from "node:fs/promises";
import { connect } from "node:net";

const PROMPT_PATH = "/Users/jack/.pi/agent/vega-presenter.md";
const PROVIDER_EXTENSION = "/Users/jack/.pi/agent/extensions/tunnel-llm-proxy.ts";
const LOCAL_LOCK = "/tmp/vega-rewriter-local.lock";

type Route = "local" | "openrouter";

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block): block is { type: "text"; text: string } =>
			typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text" && typeof (block as { text?: unknown }).text === "string")
		.map((block) => block.text)
		.join("");
}

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
	const timeout = AbortSignal.timeout(2000);
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

export default function vegaRewriter(pi: ExtensionAPI) {
	let enabled = true;
	let armed = false;
	let tuiMode = false;
	let queue = Promise.resolve();
	let lifetime = new AbortController();
	const live = new Set<string>();
	const rewrites = new Map<string, string>();
	const failed = new Set<string>();
	const deliveries: Array<{ content: string; details: Record<string, unknown> }> = [];

	pi.registerMarkdownTransformer((markdown, { messageType, isStreaming }) => {
		if (!tuiMode || !enabled || messageType !== "assistant" || (!live.has(markdown) && !(armed && isStreaming))) return markdown;
		if (failed.has(markdown)) return markdown;
		return rewrites.get(markdown) ?? "";
	});

	pi.registerMessageRenderer("vega-rewrite", (message, { outputPad }) =>
		new Markdown(String(message.content), outputPad, 0, getMarkdownTheme()));

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
		live.clear();
		rewrites.clear();
		failed.clear();
		deliveries.length = 0;

		for (const entry of ctx.sessionManager.getEntries() as Array<any>) {
			if (entry.type === "custom" && entry.customType === "vega-rewriter-state" && typeof entry.data?.enabled === "boolean") enabled = entry.data.enabled;
		}
	});

	pi.on("session_shutdown", () => lifetime.abort());

	pi.on("agent_settled", () => {
		if (!tuiMode) return;
		for (const message of deliveries.splice(0)) {
			pi.sendMessage({ customType: "vega-rewrite", display: false, ...message }, { deliverAs: "followUp", triggerTurn: false });
		}
	});

	pi.on("message_end", async (event, ctx) => {
		if (!tuiMode) return;
		if (event.message.role === "user") {
			armed = true;
			return;
		}
		if (event.message.role !== "assistant" || !armed) return;
		const rawResponse = textOf(event.message.content);
		if (!rawResponse.trim()) return;
		const hasToolCall = event.message.content.some((block) => block.type === "toolCall");
		// ponytail: sparse tool narrations stay raw; replace this threshold if substantive narrations are skipped.
		if (hasToolCall && rawResponse.trim().split(/\s+/).length < 12) return;

		live.add(rawResponse);
		const operatorMessage = [...ctx.sessionManager.getBranch() as Array<any>]
			.reverse()
			.find((entry) => entry.type === "message" && entry.message?.role === "user");
		const operatorText = operatorMessage ? textOf(operatorMessage.message.content) : "";
		const turnSignal = ctx.signal;
		queue = queue.then(() => runJob(ctx, operatorText, rawResponse, turnSignal)).catch(() => {});
		await queue;
	});

	async function runJob(ctx: ExtensionContext, operatorMessage: string, rawResponse: string, turnSignal?: AbortSignal) {
		const started = Date.now();
		const signal = turnSignal ? AbortSignal.any([turnSignal, lifetime.signal]) : lifetime.signal;
		let route: Route = "openrouter";
		let error = "";
		let lockHeld = false;

		try {
			signal.throwIfAborted();
			const prompt = await readFile(PROMPT_PATH, "utf8");
			const promptSha256 = createHash("sha256").update(prompt).digest("hex");
			const input = `SOURCE RULE: Rewrite only RAW AGENT RESPONSE. CURRENT OPERATOR MESSAGE controls selection but is never output material; do not quote, echo, or paraphrase it.\n\nCURRENT OPERATOR MESSAGE:\n${operatorMessage}\n\nRAW AGENT RESPONSE:\n${rawResponse}`;

			if (process.env.VEGA_REWRITER_FORCE_FAIL === "1") throw new Error("forced failure (VEGA_REWRITER_FORCE_FAIL=1)");

			lockHeld = await acquireLocalLock();

			if (lockHeld && await tcpAvailable(signal) && await healthIsFree(signal)) route = "local";
			if (lockHeld && route !== "local") {
				await rmdir(LOCAL_LOCK).catch(() => {});
				lockHeld = false;
			}

			let rewrite: string;
			if (route === "local") {
				try {
					rewrite = await invoke("local", prompt, input, signal);
				} catch (localError) {
					error = `local: ${errorText(localError)}`;
					await rmdir(LOCAL_LOCK).catch(() => {});
					lockHeld = false;
					route = "openrouter";
					rewrite = await invoke("openrouter", prompt, input, signal).catch((openrouterError) => {
						throw new Error(`${error}; openrouter: ${errorText(openrouterError)}`);
					});
				}
			} else {
				rewrite = await invoke("openrouter", prompt, input, signal);
			}

			if (operatorMessage.trim() && rewrite.includes(operatorMessage.trim())) {
				throw new Error("unsafe rewrite rejected: output echoed operator message");
			}
			rewrites.set(rawResponse, rewrite);
			deliveries.push({
				content: rewrite,
				details: {
					operatorMessage,
					rawResponse,
					rewrite,
					route,
					model: route === "local" ? "glm-5.3-flash" : "z-ai/glm-5.3-flash",
					durationMs: Date.now() - started,
					promptSha256,
					timestamp: new Date().toISOString(),
				},
			});
		} catch (jobError) {
			error = errorText(jobError);
			failed.add(rawResponse);
			pi.appendEntry("vega-rewrite-failed", {
				rawText: rawResponse,
				error,
				route,
				timestamp: new Date().toISOString(),
			});
		} finally {
			if (lockHeld) await rmdir(LOCAL_LOCK).catch(() => {});
		}
	}

	async function invoke(route: Route, prompt: string, input: string, signal: AbortSignal): Promise<string> {
		const local = route === "local";
		const args = [
			"--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-tools",
			"--thinking", "off", "-p",
			...(local ? ["-e", PROVIDER_EXTENSION] : []),
			"--provider", local ? "tunnel" : "openrouter",
			"--model", local ? "glm-5.3-flash" : "z-ai/glm-5.3-flash",
			"--system-prompt", prompt,
			input,
		];
		const result = await pi.exec("pi", args, { signal, timeout: local ? 15_000 : 30_000 });
		const output = result.stdout.trim();
		if (result.code !== 0 || !output) throw new Error(result.stderr.trim() || `child exited ${result.code}`);
		return output;
	}
}
