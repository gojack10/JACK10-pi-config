/**
 * /zdr — toggle OpenRouter Zero Data Retention on/off (default off).
 *
 * When on, injects provider.zdr: true into every OpenRouter request payload,
 * restricting routing to zero-retention endpoints (e.g. Astra via Azure).
 * Other providers are untouched.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "zdr";
const STATUS_ON = "ZDR ✓";

let zdr = false;

function isOpenRouter(model: { provider?: string; baseUrl?: string } | undefined): boolean {
	if (!model) return false;
	return model.provider === "openrouter" || !!model.baseUrl?.includes("openrouter.ai");
}

export default function (pi: ExtensionAPI) {
	const showStatus = (ctx: { ui: { setStatus(key: string, text: string | undefined): void } }) =>
		ctx.ui.setStatus(STATUS_KEY, zdr ? STATUS_ON : undefined);

	pi.registerCommand("zdr", {
		description: "Toggle OpenRouter zero-data-retention routing (default off)",
		handler: async (_args, ctx) => {
			zdr = !zdr;
			showStatus(ctx);
			ctx.ui.notify(
				zdr
					? "OpenRouter ZDR ON — requests route to zero-retention endpoints only"
					: "OpenRouter ZDR OFF",
				zdr ? "warning" : "info",
			);
		},
	});

	pi.on("before_provider_request", (event, ctx) => {
		if (!zdr) return;
		if (!isOpenRouter(ctx.model as { provider?: string; baseUrl?: string } | undefined)) return;
		const payload = event.payload as Record<string, unknown> | null;
		if (!payload || typeof payload !== "object") return;
		const existing =
			typeof payload.provider === "object" && payload.provider !== null
				? (payload.provider as Record<string, unknown>)
				: {};
		return { ...payload, provider: { ...existing, zdr: true } };
	});
}
