/**
 * tunnel tunnel models.
 *
 * Registers the nested 2222 machine models behind the existing tunnel path,
 * so pi keeps one provider surface instead of a separate local duplicate.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { streamSimple as baseStreamSimple } from "@earendil-works/pi-ai";
import type { Api, Model } from "@earendil-works/pi-ai";

const PROVIDER = "tunnel";
const API = "tunnel-openai-completions" as Api;
const BASE_URL = (process.env.TUNNEL_PROXY_URL || "http://127.0.0.1:8002/v1").replace(/\/+$/, "");
const API_KEY = process.env.TUNNEL_PROXY_API_KEY || process.env.LOCAL_LLM_PROXY_API_KEY
	|| readFileSync(join(homedir(), ".pi", "agent", ".proxy-key"), "utf8").trim();

function displayName(id: string, name?: string): string {
	return name && name !== id ? name : id;
}

const num = (value: unknown, fallback: number) => (typeof value === "number" && value > 0 ? value : fallback);

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
				return {
					id,
					name: displayName(id, typeof m.name === "string" ? m.name : undefined),
					api: API,
					provider: PROVIDER,
					baseUrl: BASE_URL,
					reasoning: m.reasoning === true,
					input: Array.isArray(m.input) && m.input.length ? (m.input as ("text" | "image")[]) : ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: num(m.context_length ?? m.contextWindow, 128000),
					maxTokens: num(m.max_completion_tokens ?? m.maxTokens, 16384),
					compat: { maxTokensField: "max_tokens" },
				};
			})
			.sort((a, b) => a.id.localeCompare(b.id));
		if (models.length > 0) return models;
	} catch {
		// The tunnel may still be coming up; pi re-lists models later.
	}
	return [];
}

export function requestHeaders() {
	return {
		"X-Pi-Request-Id": randomUUID(),
		"X-Pi-Origin": process.env.PI_REQUEST_ORIGIN || "user",
	};
}

export default async function tunnelProxy(pi: ExtensionAPI) {
	pi.registerProvider("local", {
		api: "openai-completions",
		streamSimple: (model, context, options) => baseStreamSimple(
			{ ...model, api: "openai-completions" as const },
			context,
			{ ...options, headers: { ...options?.headers, ...requestHeaders() } },
		),
	});
	pi.registerProvider(PROVIDER, {
		name: "tunnel tunnel",
		baseUrl: BASE_URL,
		api: API,
		apiKey: API_KEY,
		models: await proxyModels(),
		streamSimple: (model, context, options) => {
			return baseStreamSimple({ ...model, api: "openai-completions" as Api }, context, {
				...options,
				headers: { ...options?.headers, ...requestHeaders() },
				maxTokens: Math.min(options?.maxTokens ?? model.maxTokens ?? 8192, model.maxTokens ?? 8192),
			});
		},
	});
}
