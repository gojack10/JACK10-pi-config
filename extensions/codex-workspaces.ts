/**
 * Codex workspace aliases.
 *
 * Pi's built-in openai-codex provider stores one OAuth credential under the
 * provider id. This extension registers additional provider ids that reuse the
 * same ChatGPT/Codex OAuth flow and the same Codex model catalog, so /login can
 * store separate workspace/account tokens without overwriting each other.
 *
 * Usage:
 *   /login openai-codex-alt
 *   /login openai-codex-team
 *   pi --model openai-codex-team/gpt-5.5
 */

import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getModels, type Api, type Model } from "@earendil-works/pi-ai";
import { openaiCodexOAuthProvider } from "@earendil-works/pi-ai/oauth";

const SOURCE_PROVIDER = "openai-codex";
const CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const AUTH_OBSERVABILITY_PATH = join(homedir(), ".pi", "agent", "codex-workspace-auth-observability.jsonl");

const CODEX_ALIASES = [
	{
		provider: "openai-codex-alt",
		name: "ChatGPT Edu / Alt (Codex)",
		modelSuffix: "Alt",
	},
	{
		provider: "openai-codex-team",
		name: "ChatGPT Team (Codex)",
		modelSuffix: "Team",
	},
] as const;

function decodeJwtPayload(token: string | undefined): Record<string, unknown> | undefined {
	try {
		if (!token) return undefined;
		const parts = token.split(".");
		if (parts.length !== 3 || !parts[1]) return undefined;
		return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf-8")) as Record<string, unknown>;
	} catch {
		return undefined;
	}
}

function redactId(value: unknown): string | undefined {
	if (typeof value !== "string" || value.length < 8) return undefined;
	return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

function summarizeCredentials(credentials: { access?: string; expires?: number; accountId?: string }): Record<string, unknown> {
	const payload = decodeJwtPayload(credentials.access);
	const auth = payload?.["https://api.openai.com/auth"] as Record<string, unknown> | undefined;
	return {
		accountId: redactId(credentials.accountId ?? auth?.chatgpt_account_id),
		expiresAt: credentials.expires ? new Date(credentials.expires).toISOString() : undefined,
		planType: auth?.chatgpt_plan_type,
		hasSsoConnection: typeof auth?.sso_connection_id === "string" && auth.sso_connection_id.length > 0,
	};
}

function appendAuthObservation(
	provider: string,
	phase: "login" | "refresh",
	outcome: "success" | "error",
	details: Record<string, unknown>,
): void {
	try {
		appendFileSync(
			AUTH_OBSERVABILITY_PATH,
			`${JSON.stringify({ capturedAt: new Date().toISOString(), provider, phase, outcome, ...details })}\n`,
			"utf-8",
		);
	} catch {
		// Best-effort observability only.
	}
}

function cloneCodexModels(modelSuffix: string): Array<{
	id: string;
	name: string;
	api: Api;
	baseUrl: string;
	reasoning: boolean;
	thinkingLevelMap?: Model<Api>["thinkingLevelMap"];
	input: ("text" | "image")[];
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
	maxTokens: number;
	compat?: Model<Api>["compat"];
}> {
	return (getModels(SOURCE_PROVIDER as never) as Model<Api>[]).map((model) => ({
		id: model.id,
		name: `${model.name ?? model.id} (${modelSuffix})`,
		api: model.api,
		baseUrl: model.baseUrl ?? CODEX_BASE_URL,
		reasoning: model.reasoning ?? false,
		thinkingLevelMap: model.thinkingLevelMap,
		input: (model.input ?? ["text"]) as ("text" | "image")[],
		cost: model.cost,
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
		compat: model.compat,
	}));
}

export default function codexWorkspaces(pi: ExtensionAPI) {
	for (const alias of CODEX_ALIASES) {
		pi.registerProvider(alias.provider, {
			name: alias.name,
			baseUrl: CODEX_BASE_URL,
			api: "openai-codex-responses",
			models: cloneCodexModels(alias.modelSuffix),
			oauth: {
				name: alias.name,
				usesCallbackServer: openaiCodexOAuthProvider.usesCallbackServer,
				login: async (callbacks) => {
					try {
						const credentials = await openaiCodexOAuthProvider.login(callbacks);
						appendAuthObservation(alias.provider, "login", "success", summarizeCredentials(credentials));
						return credentials;
					} catch (error) {
						appendAuthObservation(alias.provider, "login", "error", {
							error: error instanceof Error ? error.message : String(error),
						});
						throw error;
					}
				},
				refreshToken: async (credentials) => {
					try {
						const refreshed = await openaiCodexOAuthProvider.refreshToken(credentials);
						appendAuthObservation(alias.provider, "refresh", "success", summarizeCredentials(refreshed));
						return refreshed;
					} catch (error) {
						appendAuthObservation(alias.provider, "refresh", "error", {
							accountId: redactId(credentials.accountId),
							error: error instanceof Error ? error.message : String(error),
						});
						throw error;
					}
				},
				getApiKey: (credentials) => openaiCodexOAuthProvider.getApiKey(credentials),
			},
		});
	}
}
