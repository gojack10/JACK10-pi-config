/**
 * tunnel tunnel models.
 *
 * Registers the nested 2222 machine models behind the existing tunnel path,
 * so pi keeps one provider surface instead of a separate local duplicate.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { streamSimple as baseStreamSimple } from "@earendil-works/pi-ai";
import type { Api, Model } from "@earendil-works/pi-ai";

const PROVIDER = "tunnel";
const API = "tunnel-openai-completions" as Api;
const BASE_URL = (process.env.TUNNEL_PROXY_URL || "http://127.0.0.1:8002/v1").replace(/\/+$/, "");
const API_KEY = process.env.TUNNEL_PROXY_API_KEY || process.env.LOCAL_LLM_PROXY_API_KEY || "REDACTED-LOCAL-KEY";

const GEMMA_ID = "tunnel-model";
const QWEN_27_ID = "tunnel-model";
const QWEN_35_ID = "tunnel-model";
const DEEPSEEK_ID = "tunnel-model";

type ProxyModel = {
	id: string;
	name: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	contextWindow: number;
	maxTokens: number;
	compat: { maxTokensField: "max_tokens" };
};

const FALLBACK_MODELS: ProxyModel[] = [
	{ id: GEMMA_ID, name: "Gemma 4 12B (tunnel)", reasoning: false, input: ["text"], contextWindow: 131072, maxTokens: 16384, compat: { maxTokensField: "max_tokens" } },
	{ id: QWEN_27_ID, name: "Qwen3.6 27B UD Q4_K_XL MLX (tunnel)", reasoning: true, input: ["text", "image"], contextWindow: 130000, maxTokens: 16384, compat: { maxTokensField: "max_tokens" } },
	{ id: QWEN_35_ID, name: "Qwen3.6 35B-A3B UD Q4_K_XL MLX (tunnel)", reasoning: true, input: ["text", "image"], contextWindow: 85000, maxTokens: 16384, compat: { maxTokensField: "max_tokens" } },
	{ id: DEEPSEEK_ID, name: "DeepSeek V4 Flash (tunnel)", reasoning: true, input: ["text"], contextWindow: 524288, maxTokens: 393216, compat: { maxTokensField: "max_tokens" } },
];

function displayName(id: string, name?: string): string {
	if (id === GEMMA_ID) return "Gemma 4 12B (tunnel)";
	if (id === QWEN_27_ID) return name && name !== id ? name : "Qwen3.6 27B UD Q4_K_XL MLX (tunnel)";
	if (id === QWEN_35_ID) return name && name !== id ? name : "Qwen3.6 35B-A3B UD Q4_K_XL MLX (tunnel)";
	if (id === DEEPSEEK_ID) return name && name !== id ? name : "DeepSeek V4 Flash (tunnel)";
	return name && name !== id ? name : id;
}

function metaFor(id: string): Omit<ProxyModel, "id" | "name"> {
	if (id === GEMMA_ID) return { reasoning: false, input: ["text"], contextWindow: 131072, maxTokens: 16384, compat: { maxTokensField: "max_tokens" } };
	if (id === QWEN_27_ID) return { reasoning: true, input: ["text", "image"], contextWindow: 130000, maxTokens: 16384, compat: { maxTokensField: "max_tokens" } };
	if (id === QWEN_35_ID) return { reasoning: true, input: ["text", "image"], contextWindow: 85000, maxTokens: 16384, compat: { maxTokensField: "max_tokens" } };
	if (id === DEEPSEEK_ID) return { reasoning: true, input: ["text"], contextWindow: 524288, maxTokens: 393216, compat: { maxTokensField: "max_tokens" } };
	return { reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 16384, compat: { maxTokensField: "max_tokens" } };
}

function fallbackModels(): Model<Api>[] {
	return FALLBACK_MODELS.map((model) => ({
		id: model.id,
		name: model.name,
		api: API,
		provider: PROVIDER,
		baseUrl: BASE_URL,
		reasoning: model.reasoning,
		input: model.input,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
	}));
}

async function proxyModels(): Promise<Model<Api>[]> {
	try {
		const headers = API_KEY ? { Authorization: `Bearer ${API_KEY}` } : undefined;
		const signal = AbortSignal.timeout ? AbortSignal.timeout(2000) : undefined;
		const res = await fetch(`${BASE_URL}/models`, { headers, signal });
		if (!res.ok) throw new Error(`tunnel model list failed: ${res.status}`);
		const payload = (await res.json()) as { data?: Array<Record<string, unknown>> };
		const data = Array.isArray(payload.data) ? payload.data : [];
		const models = data
			.filter((m) => typeof m.id === "string" && m.id.length > 0)
			.map((m) => {
				const id = String(m.id);
				const meta = metaFor(id);
				return {
					id,
					name: displayName(id, typeof m.name === "string" ? m.name : undefined),
					api: API,
					provider: PROVIDER,
					baseUrl: BASE_URL,
					reasoning: meta.reasoning,
					input: meta.input,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: meta.contextWindow,
					maxTokens: meta.maxTokens,
					compat: meta.compat,
				};
			})
			.sort((a, b) => {
				const order = (id: string) => (id === GEMMA_ID ? 0 : id === QWEN_27_ID ? 1 : id === QWEN_35_ID ? 2 : id === DEEPSEEK_ID ? 3 : 4);
				return order(a.id) - order(b.id) || a.id.localeCompare(b.id);
			});
		if (models.length > 0) return models;
	} catch {
		// Fall through to static fallback; the SSH tunnel may still be coming up.
	}
	return fallbackModels();
}

export default async function tunnelProxy(pi: ExtensionAPI) {
	pi.registerProvider(PROVIDER, {
		name: "tunnel tunnel",
		baseUrl: BASE_URL,
		api: API,
		apiKey: API_KEY,
		models: await proxyModels(),
		streamSimple: (model, context, options) => {
			return baseStreamSimple({ ...model, api: "openai-completions" as Api }, context, {
				...options,
				maxTokens: Math.min(options?.maxTokens ?? model.maxTokens ?? 8192, model.maxTokens ?? 8192),
			});
		},
	});
}
