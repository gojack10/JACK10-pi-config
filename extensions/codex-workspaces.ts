/**
 * Codex workspace aliases.
 *
 * Pi's built-in openai-codex provider stores one OAuth credential under the
 * provider id. This extension registers a second provider id that reuses the
 * same ChatGPT/Codex OAuth flow and the same Codex model catalog, so /login can
 * store a separate Alt/Edu token without overwriting the existing token.
 *
 * Usage:
 *   /login openai-codex-alt
 *   pi --model openai-codex-alt/gpt-5.5
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getModels, type Api, type Model } from "@earendil-works/pi-ai";
import { openaiCodexOAuthProvider } from "@earendil-works/pi-ai/oauth";

const SOURCE_PROVIDER = "openai-codex";
const Alt_PROVIDER = "openai-codex-alt";
const CODEX_BASE_URL = "https://chatgpt.com/backend-api";

function cloneCodexModels(): Array<{
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
		name: `${model.name ?? model.id} (Alt)`,
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
	pi.registerProvider(Alt_PROVIDER, {
		name: "ChatGPT Edu / Alt (Codex)",
		baseUrl: CODEX_BASE_URL,
		api: "openai-codex-responses",
		models: cloneCodexModels(),
		oauth: {
			name: "ChatGPT Edu / Alt (Codex)",
			usesCallbackServer: openaiCodexOAuthProvider.usesCallbackServer,
			login: (callbacks) => openaiCodexOAuthProvider.login(callbacks),
			refreshToken: (credentials) => openaiCodexOAuthProvider.refreshToken(credentials),
			getApiKey: (credentials) => openaiCodexOAuthProvider.getApiKey(credentials),
		},
	});
}
