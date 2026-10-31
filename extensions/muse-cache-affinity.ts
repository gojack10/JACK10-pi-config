import { createHash } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Stable per-session cache affinity for Muse Wonder on OpenRouter. */
export default function museCacheAffinity(pi: ExtensionAPI) {
	pi.on("before_provider_request", (event, ctx) => {
		if (ctx.model?.provider !== "openrouter" || ctx.model.id !== "meta/muse-wonder") return;
		if (!event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) return;

		const payload = event.payload as Record<string, unknown>;
		if (payload.prompt_cache_key !== undefined && payload.prompt_cache_key !== null) return;

		const sessionId = ctx.sessionManager.getSessionId();
		// Bound custom session IDs without merging sessions that share a long prefix.
		const cacheKey = sessionId.length <= 64 ? sessionId : createHash("sha256").update(sessionId).digest("hex");
		return { ...payload, prompt_cache_key: cacheKey };
	});
}
