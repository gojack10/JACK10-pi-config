import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CodexUsageStore } from "./store.ts";

const isCodex = (provider: unknown): provider is string =>
	typeof provider === "string" && provider.startsWith("openai-codex");

type CaptureContext = {
	hasUI: boolean;
	ui: { notify(message: string, level: "error"): void };
};

export default function (pi: ExtensionAPI) {
	const store = new CodexUsageStore();
	let awaitingResponse = 0;
	let pending = Promise.resolve();

	const reportFailure = (ctx: CaptureContext, error: unknown) => {
		const message = error instanceof Error ? error.message : String(error);
		pi.events.emit("codex-usage:update", {
			state: store.snapshot(),
			degraded: message,
		});
		if (ctx.hasUI) ctx.ui.notify(`Codex quota capture degraded: ${message}`, "error");
	};
	const publish = () =>
		pi.events.emit("codex-usage:update", { state: store.snapshot() });
	const enqueue = (ctx: CaptureContext, work: () => Promise<void>) => {
		const result = pending.then(work);
		pending = result.catch((error) => reportFailure(ctx, error));
		return result.catch(() => undefined);
	};

	pi.on("session_start", (_event, ctx) =>
		enqueue(ctx, async () => {
			await store.load();
			if (isCodex(ctx.model?.provider)) store.setCurrent(ctx.model.provider);
			await store.write();
			publish();
		}),
	);

	pi.on("before_provider_request", (_event, ctx) => {
		if (isCodex(ctx.model?.provider)) awaitingResponse++;
	});

	pi.on("after_provider_response", (event, ctx) => {
		const provider = ctx.model?.provider;
		if (!isCodex(provider)) return;
		awaitingResponse = Math.max(0, awaitingResponse - 1);
		return enqueue(ctx, async () => {
			store.observe(provider, event.status, event.headers);
			await store.write();
			publish();
		});
	});

	pi.on("message_end", (event, ctx) => {
		const message = event.message as { role?: string; provider?: string } | undefined;
		if (message?.role !== "assistant" || !isCodex(message.provider) || awaitingResponse === 0)
			return;
		awaitingResponse = 0;
		reportFailure(
			ctx,
			new Error("Codex response headers were not captured; transport must remain sse"),
		);
	});

	pi.on("model_select", (event, ctx) => {
		const provider = event.model?.provider;
		if (!isCodex(provider)) return;
		return enqueue(ctx, async () => {
			store.setCurrent(provider);
			await store.write();
			publish();
		});
	});

	pi.on("session_shutdown", async () => {
		await pending;
	});
}
