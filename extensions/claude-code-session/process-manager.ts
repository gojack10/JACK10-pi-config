/**
 * ProcessManager: owns a long-lived `claude -p` subprocess.
 *
 * Responsibilities:
 * - Spawn `claude -p --input-format stream-json --output-format stream-json --verbose`
 * - Write user messages in Claude Code SDK stream-json format on stdin
 * - Expose a line-buffered stdout as an AsyncIterable<ClaudeEvent> from `send()`
 *   that yields every event up to and including the turn-ending `result` event
 * - Gracefully close on stop()
 *
 * One instance per active CC session. Module-level singleton is held by index.ts.
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";

export type ClaudeEffort = "low" | "medium" | "high" | "xhigh" | "max";

export interface StartOptions {
	/** Model alias or full id: "opus", "sonnet", "haiku", or full name. */
	model?: string;
	/** Effort level. Default "max". */
	effort?: ClaudeEffort;
	/** Working directory for claude -p. Defaults to current cwd. */
	cwd?: string;
	/** Additional env vars to pass to the subprocess. */
	env?: Record<string, string>;
	/**
	 * If true, the provider will NOT prepend pi's prior conversation history
	 * to the first user turn. Use when starting fresh is preferred over
	 * handoff continuity.
	 */
	noSeed?: boolean;
}

/**
 * Raw events from `claude -p --output-format stream-json`.
 * Typed loosely — consumers inspect `.type` and handle known shapes.
 */
export type ClaudeEvent =
	| {
			type: "system";
			subtype?: string;
			session_id?: string;
			model?: string;
			tools?: string[];
			mcp_servers?: unknown[];
			[k: string]: unknown;
	  }
	| {
			type: "assistant";
			message: {
				id?: string;
				role: "assistant";
				model?: string;
				content: Array<
					| { type: "text"; text: string }
					| { type: "thinking"; thinking: string; signature?: string }
					| { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
				>;
				stop_reason?: string | null;
				usage?: Record<string, number>;
			};
			[k: string]: unknown;
	  }
	| {
			type: "user";
			message: {
				role: "user";
				content:
					| string
					| Array<{
							type: "tool_result";
							tool_use_id: string;
							content: string | Array<{ type: "text"; text: string }>;
							is_error?: boolean;
					  }>;
			};
			[k: string]: unknown;
	  }
	| {
			type: "result";
			subtype?: "success" | "error_max_turns" | "error_during_execution" | string;
			is_error?: boolean;
			duration_ms?: number;
			result?: string;
			session_id?: string;
			total_cost_usd?: number;
			usage?: Record<string, number>;
			[k: string]: unknown;
	  }
	| {
			type: "rate_limit_event";
			[k: string]: unknown;
	  }
	| {
			type: "stream_event";
			event: unknown;
			[k: string]: unknown;
	  }
	| {
			type: "error";
			error?: string;
			message?: string;
			[k: string]: unknown;
	  }
	| {
			// Catch-all for other event types claude -p may emit (keep_alive, streamlined_*, etc.)
			type: string;
			[k: string]: unknown;
	  };

export interface ProcessState {
	running: boolean;
	pid?: number;
	model?: string;
	effort?: ClaudeEffort;
	sessionId?: string;
	cwd?: string;
	startedAt?: number;
	totalCostUsd: number;
	turnCount: number;
	/** When true, provider skips the first-turn pi-history handoff. */
	noSeed: boolean;
}

/** Thrown when send() is called while another turn is still consuming. */
export class TurnInFlightError extends Error {
	constructor() {
		super("Another turn is already streaming. Wait for it to finish first.");
	}
}

/** Thrown when the subprocess is not running. */
export class NotRunningError extends Error {
	constructor() {
		super("claude -p subprocess is not running. Call /cc start first.");
	}
}

export class ProcessManager {
	private proc?: ChildProcessWithoutNullStreams;
	private rl?: ReadlineInterface;
	private stderrBuffer: string[] = [];
	private lineQueue: string[] = [];
	private lineWaiters: Array<(line: string | null) => void> = [];
	private streamEnded = false;
	private exitReason: { code: number | null; signal: NodeJS.Signals | null } | undefined;
	private turnInFlight = false;
	private state: ProcessState = {
		running: false,
		totalCostUsd: 0,
		turnCount: 0,
		noSeed: false,
	};

	isRunning(): boolean {
		return this.state.running && this.proc !== undefined && this.proc.exitCode === null;
	}

	getState(): Readonly<ProcessState> {
		return { ...this.state };
	}

	getRecentStderr(maxLines = 20): string[] {
		return this.stderrBuffer.slice(-maxLines);
	}

	/**
	 * Spawn `claude -p` with stream-json IO.
	 * Throws if already running.
	 */
	async start(options: StartOptions = {}): Promise<void> {
		if (this.isRunning()) {
			throw new Error("claude -p subprocess is already running");
		}

		const args: string[] = [
			"-p",
			"--dangerously-skip-permissions",
			"--input-format",
			"stream-json",
			"--output-format",
			"stream-json",
			"--verbose",
		];

		if (options.model) {
			args.push("--model", options.model);
		}
		const effort = options.effort ?? "max";
		args.push("--effort", effort);

		const env: NodeJS.ProcessEnv = { ...process.env, ...options.env };

		const proc = spawn("claude", args, {
			cwd: options.cwd ?? process.cwd(),
			env,
			stdio: ["pipe", "pipe", "pipe"],
		});

		// Reset per-run state
		this.stderrBuffer = [];
		this.lineQueue = [];
		this.lineWaiters = [];
		this.streamEnded = false;
		this.exitReason = undefined;
		this.turnInFlight = false;

		this.proc = proc;
		this.state = {
			running: true,
			pid: proc.pid,
			model: options.model,
			effort,
			cwd: options.cwd ?? process.cwd(),
			startedAt: Date.now(),
			totalCostUsd: 0,
			turnCount: 0,
			noSeed: options.noSeed ?? false,
		};

		this.rl = createInterface({ input: proc.stdout });
		this.rl.on("line", (line) => this.pushLine(line));
		this.rl.on("close", () => this.endStream());

		proc.stderr.setEncoding("utf8");
		proc.stderr.on("data", (chunk: string) => {
			// Keep the last ~200 lines around for diagnostics
			for (const line of chunk.split("\n")) {
				if (line) {
					this.stderrBuffer.push(line);
					if (this.stderrBuffer.length > 200) this.stderrBuffer.shift();
				}
			}
		});

		proc.on("exit", (code, signal) => {
			this.exitReason = { code, signal };
			this.state.running = false;
			this.endStream();
		});

		proc.on("error", (err) => {
			this.stderrBuffer.push(`spawn error: ${err.message}`);
			this.state.running = false;
			this.endStream();
		});

		// claude -p's `system/init` event is only emitted AFTER the first user
		// message arrives on stdin — there is no output-based "ready" signal.
		// So all we can do is give it a brief beat to fail fast (bad binary,
		// missing auth, immediate spawn error) and then return.
		await new Promise<void>((resolve, reject) => {
			const settleAfter = setTimeout(() => {
				cleanup();
				if (this.exitReason) {
					reject(
						new Error(
							`claude -p exited before startup (code=${this.exitReason.code}, signal=${this.exitReason.signal}). stderr: ${this.getRecentStderr(10).join("\n").slice(0, 500)}`,
						),
					);
				} else {
					resolve();
				}
			}, 300);

			const onExit = () => {
				cleanup();
				reject(
					new Error(
						`claude -p exited before startup (code=${this.exitReason?.code ?? "?"}, signal=${this.exitReason?.signal ?? "?"}). stderr: ${this.getRecentStderr(10).join("\n").slice(0, 500)}`,
					),
				);
			};
			const onError = (err: Error) => {
				cleanup();
				reject(new Error(`claude -p spawn error: ${err.message}`));
			};
			const cleanup = () => {
				clearTimeout(settleAfter);
				proc.off("exit", onExit);
				proc.off("error", onError);
			};
			proc.once("exit", onExit);
			proc.once("error", onError);
		});
	}

	/**
	 * Send a user message and return an async iterator of events up to (and including)
	 * the `result` event that ends the turn. Throws if another turn is in flight or
	 * if the subprocess is not running.
	 */
	async *send(message: string): AsyncGenerator<ClaudeEvent, void, void> {
		if (!this.isRunning()) throw new NotRunningError();
		if (this.turnInFlight) throw new TurnInFlightError();
		if (!this.proc || !this.proc.stdin.writable) throw new NotRunningError();

		this.turnInFlight = true;
		this.state.turnCount += 1;

		try {
			const payload = JSON.stringify({
				type: "user",
				session_id: this.state.sessionId ?? "",
				message: { role: "user", content: message },
				parent_tool_use_id: null,
			});
			this.proc.stdin.write(`${payload}\n`);

			while (true) {
				const line = await this.nextLine();
				if (line === null) {
					// stream ended without a result event
					throw new Error(
						`claude -p stream ended unexpectedly mid-turn. Exit: code=${this.exitReason?.code ?? "?"}, signal=${this.exitReason?.signal ?? "?"}. stderr: ${this.getRecentStderr(10).join("\n").slice(0, 500)}`,
					);
				}
				const trimmed = line.trim();
				if (!trimmed) continue;
				let event: ClaudeEvent;
				try {
					event = JSON.parse(trimmed) as ClaudeEvent;
				} catch {
					// Swallow malformed lines rather than crashing the turn
					continue;
				}

				// Capture session id from init event so follow-up sends include it
				if (event.type === "system" && !this.state.sessionId) {
					const sid = (event as { session_id?: string }).session_id;
					if (typeof sid === "string" && sid.length > 0) this.state.sessionId = sid;
				}
				if (event.type === "result") {
					const cost = (event as { total_cost_usd?: number }).total_cost_usd;
					if (typeof cost === "number") this.state.totalCostUsd += cost;
				}

				yield event;

				if (event.type === "result") {
					return;
				}
			}
		} finally {
			this.turnInFlight = false;
		}
	}

	/**
	 * Send an interrupt control_request to end the current turn.
	 * claude -p will emit a `result` event with subtype=error_during_execution,
	 * which naturally unblocks any send() loop waiting on the turn.
	 * No-op if no turn is in flight or the subprocess is gone.
	 */
	interrupt(): void {
		if (!this.turnInFlight) return;
		const proc = this.proc;
		if (!proc || !proc.stdin.writable) return;
		const payload = JSON.stringify({
			type: "control_request",
			request_id: randomUUID(),
			request: { subtype: "interrupt" },
		});
		try {
			proc.stdin.write(`${payload}\n`);
		} catch {
			// stdin gone — subprocess will terminate on its own
		}
	}

	/** Gracefully stop the subprocess. Resolves when it has exited. */
	async stop(timeoutMs = 5000): Promise<void> {
		const proc = this.proc;
		if (!proc || proc.exitCode !== null) {
			this.state.running = false;
			return;
		}
		try {
			proc.stdin.end();
		} catch {
			// ignore
		}

		const exited = await new Promise<boolean>((resolve) => {
			const timer = setTimeout(() => resolve(false), timeoutMs);
			proc.once("exit", () => {
				clearTimeout(timer);
				resolve(true);
			});
		});

		if (!exited) {
			proc.kill("SIGTERM");
			await new Promise<void>((resolve) => {
				const killTimer = setTimeout(() => {
					try {
						proc.kill("SIGKILL");
					} catch {}
					resolve();
				}, 2000);
				proc.once("exit", () => {
					clearTimeout(killTimer);
					resolve();
				});
			});
		}

		this.state.running = false;
		this.endStream();
	}

	// ---- line queue plumbing ---------------------------------------------------

	private pushLine(line: string): void {
		const waiter = this.lineWaiters.shift();
		if (waiter) {
			waiter(line);
			return;
		}
		this.lineQueue.push(line);
	}

	private endStream(): void {
		if (this.streamEnded) return;
		this.streamEnded = true;
		while (this.lineWaiters.length > 0) {
			const w = this.lineWaiters.shift();
			w?.(null);
		}
	}

	private nextLine(): Promise<string | null> {
		if (this.lineQueue.length > 0) {
			return Promise.resolve(this.lineQueue.shift() as string);
		}
		if (this.streamEnded) return Promise.resolve(null);
		return new Promise<string | null>((resolve) => this.lineWaiters.push(resolve));
	}
}
