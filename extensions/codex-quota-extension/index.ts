import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ProbeScheduler } from "./probe-scheduler.ts";
import { CodexUsageStore } from "./store.ts";

const isCodex = (provider: unknown): provider is string =>
	typeof provider === "string" && provider.startsWith("openai-codex") && provider !== "openai-codex-personal";

type CaptureContext = {
	hasUI: boolean;
	ui: { notify(message: string, level: "error"): void };
};

export default function (pi: ExtensionAPI) {
	const store = new CodexUsageStore();
	const probes = new ProbeScheduler();
	let awaitingResponse = 0;
	let pending = Promise.resolve();

	const publish = async (ctx: CaptureContext, degraded?: string) => {
		const state = store.snapshot();
		pi.events.emit("codex-usage:update", {
			state,
			...(degraded ? { degraded } : {}),
		});
		try { await probes.reconcile(state); }
		catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (ctx.hasUI) ctx.ui.notify(`Codex probe scheduling degraded: ${message}`, "error");
		}
	};
	const reportFailure = async (ctx: CaptureContext, provider: string | undefined, error: unknown) => {
		const message = error instanceof Error ? error.message : String(error);
		if (provider) {
			try {
				store.recordFailure(provider, error);
				await store.write();
			} catch {
				// Registry/feed failures are already fail-closed to the router.
			}
		}
		await publish(ctx, message);
		if (ctx.hasUI) ctx.ui.notify(`Codex quota capture degraded: ${message}`, "error");
	};
	const enqueue = (ctx: CaptureContext, provider: string | undefined, work: () => Promise<void>) => {
		const result = pending.then(work);
		pending = result.catch((error) => reportFailure(ctx, provider, error));
		return pending;
	};

	pi.on("session_start", (_event, ctx) => {
		const provider = isCodex(ctx.model?.provider) ? ctx.model.provider : undefined;
		return enqueue(ctx, provider, async () => {
			await store.load();
			if (provider) store.setCurrent(provider);
			await store.write();
			await publish(ctx);
		});
	});

	pi.on("before_provider_request", (_event, ctx) => {
		if (isCodex(ctx.model?.provider)) awaitingResponse++;
	});

	pi.on("after_provider_response", (event, ctx) => {
		const provider = ctx.model?.provider;
		if (!isCodex(provider)) return;
		awaitingResponse = Math.max(0, awaitingResponse - 1);
		return enqueue(ctx, provider, async () => {
			store.observe(provider, event.status, event.headers);
			await store.write();
			await publish(ctx);
		});
	});

	pi.on("message_end", (event, ctx) => {
		const message = event.message as { role?: string; provider?: string } | undefined;
		if (message?.role !== "assistant" || !isCodex(message.provider) || awaitingResponse === 0) return;
		awaitingResponse = 0;
		return enqueue(ctx, message.provider, async () => {
			throw new Error("Codex response headers were not captured; transport must remain sse");
		});
	});

	pi.on("model_select", (event, ctx) => {
		const provider = event.model?.provider;
		if (!isCodex(provider)) return;
		return enqueue(ctx, provider, async () => {
			store.setCurrent(provider);
			await store.write();
			await publish(ctx);
		});
	});

	pi.on("session_shutdown", async () => {
		probes.close();
		await pending;
	});
}
