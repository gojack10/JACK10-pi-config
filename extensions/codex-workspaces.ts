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

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getModels, type Api, type Model } from "@earendil-works/pi-ai";
import { openaiCodexOAuthProvider } from "@earendil-works/pi-ai/oauth";

const SOURCE_PROVIDER = "openai-codex";
const CODEX_BASE_URL = "https://chatgpt.com/backend-api";

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
				login: (callbacks) => openaiCodexOAuthProvider.login(callbacks),
				refreshToken: (credentials) => openaiCodexOAuthProvider.refreshToken(credentials),
				getApiKey: (credentials) => openaiCodexOAuthProvider.getApiKey(credentials),
			},
		});
	}
}
