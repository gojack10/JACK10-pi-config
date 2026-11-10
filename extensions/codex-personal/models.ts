import type { StreamOptions } from "@earendil-works/pi-ai";

const FAST_SUFFIX = "-fast";

export const codexRequiresPro = (modelId: string): boolean => modelId === "gpt-6.1-sol-fast";

export const codexBaseModelId = (modelId: string): string =>
	modelId.endsWith(FAST_SUFFIX) ? modelId.slice(0, -FAST_SUFFIX.length) : modelId;

export function withCodexFastModels<T extends { id: string; name: string }>(
	models: readonly T[],
	supportedModels: ReadonlySet<string>,
): T[] {
	return models.flatMap((model) => {
		if (!supportedModels.has(model.id)) return [model];
		const id = `${model.id}${FAST_SUFFIX}`;
		return [model, { ...model, id, name: id }];
	});
}

export function codexAccountStreamOptions(modelId: string, options?: StreamOptions): StreamOptions {
	const baseModelId = codexBaseModelId(modelId);
	if (baseModelId === modelId) return { ...options, transport: "sse" };
	return {
		...options,
		transport: "sse",
		// Keep the alias in session messages; only the wire request uses the base ID.
		// Use onPayload because Codex streamSimple drops provider-specific options.
		onPayload: async (payload, model) => {
			const body = { ...(payload as Record<string, unknown>), model: baseModelId, service_tier: "priority" };
			return (await options?.onPayload?.(body, model)) ?? body;
		},
	};
}
