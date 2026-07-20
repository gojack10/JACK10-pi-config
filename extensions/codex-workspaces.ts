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
import type { OAuthCredential } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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

function summarizeCredentials(credentials: OAuthCredential): Record<string, unknown> {
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

export default function codexWorkspaces(pi: ExtensionAPI) {
	const source = builtinProviders().find((provider) => provider.id === "openai-codex");
	const oauth = source?.auth.oauth;
	if (!source || !oauth) throw new Error("Built-in Codex provider has no OAuth flow");

	for (const alias of CODEX_ALIASES) {
		pi.registerProvider({
			...source,
			id: alias.provider,
			name: alias.name,
			auth: {
				oauth: {
					...oauth,
					name: alias.name,
					login: async (interaction) => {
						try {
							const credentials = await oauth.login(interaction);
							appendAuthObservation(alias.provider, "login", "success", summarizeCredentials(credentials));
							return credentials;
						} catch (error) {
							appendAuthObservation(alias.provider, "login", "error", {
								error: error instanceof Error ? error.message : String(error),
							});
							throw error;
						}
					},
					refresh: async (credentials, signal) => {
						try {
							const refreshed = await oauth.refresh(credentials, signal);
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
				},
			},
			getModels: () =>
				source.getModels().map((model) => ({
					...model,
					provider: alias.provider,
					name: `${model.name ?? model.id} (${alias.modelSuffix})`,
				})),
		});
	}
}
