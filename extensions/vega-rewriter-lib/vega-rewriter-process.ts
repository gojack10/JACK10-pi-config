import { spawn } from "node:child_process";

const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

type StreamOptions = {
	cwd: string;
	env: NodeJS.ProcessEnv;
	timeoutMs: number;
	firstTokenTimeoutMs?: number;
	signal?: AbortSignal;
};

export function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block): block is { type: "text"; text: string } =>
			typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text" && typeof (block as { text?: unknown }).text === "string")
		.map((block) => block.text)
		.join("");
}

export class DisplayRewrites {
	private rewrites = new Map<string, { blocks: string[]; rewrite: string }>();
	private displays = new Map<string, string | null>();

	clear(): void {
		this.rewrites.clear();
		this.displays.clear();
	}

	set(content: unknown, rewrite: string): void {
		const blocks = this.blocks(content);
		this.rewrites.set(JSON.stringify(blocks), { blocks, rewrite });
		this.rebuild();
	}

	delete(content: unknown): void {
		this.rewrites.delete(JSON.stringify(this.blocks(content)));
		this.rebuild();
	}

	transform(markdown: string): string {
		// ponytail: block-only transformer context cannot disambiguate duplicate narration; keep collisions raw until Pi exposes message IDs.
		return this.displays.has(markdown) ? this.displays.get(markdown) ?? markdown : markdown;
	}

	private blocks(content: unknown): string[] {
		return Array.isArray(content)
			? content.filter((block): block is { type: "text"; text: string } => block?.type === "text" && typeof block.text === "string").map((block) => block.text.trim())
			: [String(content).trim()];
	}

	private rebuild(): void {
		this.displays.clear();
		for (const value of this.rewrites.values()) value.blocks.forEach((block, index) => {
			const display = index === 0 ? value.rewrite : "";
			const current = this.displays.get(block);
			this.displays.set(block, current === undefined || current === display ? display : null);
		});
	}
}

export function runStreamingPi(command: string, args: string[], options: StreamOptions): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"] });
		let settled = false;
		let firstToken = false;
		let stdout = "";
		let stderr = "";
		let bytes = 0;
		let finalText = "";

		const cleanup = () => {
			clearTimeout(deadlineTimer);
			if (firstTokenTimer) clearTimeout(firstTokenTimer);
			options.signal?.removeEventListener("abort", onAbort);
		};
		const stop = () => {
			if (child.exitCode !== null) return;
			child.kill("SIGTERM");
			const killTimer = setTimeout(() => child.exitCode === null && child.kill("SIGKILL"), 1_000);
			killTimer.unref();
		};
		const fail = (error: Error) => {
			if (settled) return;
			settled = true;
			cleanup();
			stop();
			reject(error);
		};
		const processLine = (line: string) => {
			if (!line.trim()) return;
			let event: any;
			try {
				event = JSON.parse(line);
			} catch {
				return;
			}
			if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta" && event.assistantMessageEvent.delta) {
				firstToken = true;
				if (firstTokenTimer) clearTimeout(firstTokenTimer);
			}
			if (event.type === "message_end" && event.message?.role === "assistant") {
				finalText = textOf(event.message.content);
			}
		};
		const drainLines = () => {
			for (;;) {
				const newline = stdout.indexOf("\n");
				if (newline < 0) return;
				processLine(stdout.slice(0, newline));
				stdout = stdout.slice(newline + 1);
			}
		};
		const onAbort = () => fail(new Error("rewrite aborted"));
		const deadlineTimer = setTimeout(() => fail(new Error("rewrite deadline exceeded")), options.timeoutMs);
		const firstTokenTimer = options.firstTokenTimeoutMs
			? setTimeout(() => !firstToken && fail(new Error("rewrite first-token deadline exceeded")), options.firstTokenTimeoutMs)
			: undefined;

		options.signal?.addEventListener("abort", onAbort, { once: true });
		if (options.signal?.aborted) return onAbort();
		child.stdout.on("data", (chunk: Buffer) => {
			bytes += chunk.length;
			if (bytes > MAX_OUTPUT_BYTES) return fail(new Error("rewrite output exceeded 4 MiB"));
			stdout += chunk.toString();
			drainLines();
		});
		child.stderr.on("data", (chunk: Buffer) => {
			if (stderr.length < 16_384) stderr += chunk.toString();
		});
		child.on("error", fail);
		child.on("close", (code, signal) => {
			if (settled) return;
			processLine(stdout);
			if (code !== 0) return fail(new Error(`child exited ${code ?? signal}: ${stderr.trim()}`));
			if (!finalText.trim()) return fail(new Error("rewriter returned empty output"));
			settled = true;
			cleanup();
			resolve(finalText.trim());
		});
	});
}
