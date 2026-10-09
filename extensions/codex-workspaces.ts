import { appendFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Model, OAuthCredential, Provider } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parseRegistry } from "./codex-quota-extension/store.ts";
import {
	isTerminalCodexUsageLimit,
	isZeroOutputFailure,
	resolveCodexPersonalSelection,
	routeEntry,
	type RoutePin,
} from "./codex-personal/resolution.ts";
import { evaluateCodexRouteFromFiles } from "./codex-personal/router.ts";
import { scheduleLoginProbe, withFreshLoginProbe } from "./codex-workspaces/probe.ts";

const AGENT_DIR = join(homedir(), ".pi", "agent");
const REGISTRY_PATH = join(AGENT_DIR, "codex-accounts.json");
const FEED_PATH = join(AGENT_DIR, "codex-usage-state.json");
const AUTH_OBSERVABILITY_PATH = join(AGENT_DIR, "codex-workspace-auth-observability.jsonl");

type SelectorProvider = Provider & {
	selectable?: boolean;
	modelSelectionError?: (model: Model) => string | undefined;
};

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
	phase: "login" | "refresh" | "probe",
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
	const registry = parseRegistry(JSON.parse(readFileSync(REGISTRY_PATH, "utf8")) as unknown);
	const supportedModels = new Set(registry.accounts.flatMap((account) => account.supportedModels));
	const source = builtinProviders().find((provider) => provider.id === "openai-codex");
	const oauth = source?.auth.oauth;
	if (!source || !oauth) throw new Error("Built-in Codex provider has no OAuth flow");
	let pin: RoutePin | undefined;
	let pendingPin: RoutePin | undefined;
	let sessionStarted = false;
	let startupFallbackWarning: string | undefined;
	const failedAccounts = new Set<string>();
	for (const account of registry.accounts) {
		if (account.credentialRef !== account.providerId)
			throw new Error(`Unsupported credentialRef for ${account.accountKey}`);
		const accountOauth = withFreshLoginProbe(
			(interaction: Parameters<typeof oauth.login>[0]) => oauth.login(interaction),
			(credentials: OAuthCredential, signal: AbortSignal) => oauth.refresh(credentials, signal),
			() => queueMicrotask(() => scheduleLoginProbe(
				account.providerId,
				(outcome, details) => appendAuthObservation(account.providerId, "probe", outcome, details),
			)),
		);
		pi.registerProvider({
			...source,
			id: account.providerId,
			name: `${account.label} (Codex account)`,
			selectable: process.env.PI_CODEX_ACCOUNT_MAINTENANCE === account.providerId,
			auth: {
				oauth: {
					...oauth,
					name: `${account.label} (Codex account)`,
					login: async (interaction) => {
						try {
							const credentials = await accountOauth.login(interaction);
							appendAuthObservation(account.providerId, "login", "success", summarizeCredentials(credentials));
							return credentials;
						} catch (error) {
							appendAuthObservation(account.providerId, "login", "error", {
								error: error instanceof Error ? error.message : String(error),
							});
							throw error;
						}
					},
					refresh: async (credentials, signal) => {
						try {
							const refreshed = await accountOauth.refresh(credentials, signal);
							appendAuthObservation(account.providerId, "refresh", "success", summarizeCredentials(refreshed));
							return refreshed;
						} catch (error) {
							appendAuthObservation(account.providerId, "refresh", "error", {
								accountId: redactId(credentials.accountId),
								error: error instanceof Error ? error.message : String(error),
							});
							throw error;
						}
					},
				},
			},
			getModels: () => source.getModels().map((model) => ({ ...model, provider: account.providerId })),
			getAllModels: () => (source.getAllModels?.() ?? source.getModels())
				.map((model) => ({ ...model, provider: account.providerId })),
			stream: (model, context, options) => {
				if (
					pin?.accountKey !== account.accountKey &&
					process.env.PI_CODEX_ACCOUNT_MAINTENANCE !== account.providerId
				)
					throw new Error("ROUTE DENIED: Codex account has no matching session pin");
				return source.stream(model, context, { ...options, transport: "sse" });
			},
			streamSimple: (model, context, options) => {
				if (
					pin?.accountKey !== account.accountKey &&
					process.env.PI_CODEX_ACCOUNT_MAINTENANCE !== account.providerId
				)
					throw new Error("ROUTE DENIED: Codex account has no matching session pin");
				return source.streamSimple(model, context, { ...options, transport: "sse" });
			},
		} as Provider);
	}

	const selectionError = (model: Model): string | undefined =>
		evaluateCodexRouteFromFiles({
			model: model.id,
			registryPath: REGISTRY_PATH,
			feedPath: FEED_PATH,
		}).error;
	const unresolved = (): never => {
		throw new Error("Codex Personal provider resolution invariant failed");
	};
	const umbrella: SelectorProvider = {
		...source,
		id: registry.umbrellaProviderId,
		name: "OpenAI Codex Personal",
		selectable: true,
		auth: {
			apiKey: {
				name: "Local Codex personal router",
				resolve: async () => ({ auth: { apiKey: "selector-only" }, source: "local selector" }),
			},
		},
		getModels: () =>
			source
				.getModels()
				.filter((model) => supportedModels.has(model.id))
				.map((model) => ({ ...model, provider: registry.umbrellaProviderId })),
		getAllModels: () => (source.getAllModels?.() ?? source.getModels())
			.filter((model) => supportedModels.has(model.id))
			.map((model) => ({ ...model, provider: registry.umbrellaProviderId })),
		modelSelectionError: selectionError,
		resolveModel: async (model, context) => {
			const resolved = await resolveCodexPersonalSelection({
				model,
				registry,
				evaluate: () =>
					evaluateCodexRouteFromFiles({ model: model.id, registryPath: REGISTRY_PATH, feedPath: FEED_PATH }),
				context,
				excludedAccountKeys: failedAccounts,
				fallbackProviderId: sessionStarted ? undefined : "openai",
			});
			startupFallbackWarning = resolved.warning;
			if (resolved.pin) {
				if (sessionStarted) {
					if (pin?.actualProviderId !== resolved.pin.actualProviderId || pin?.model !== resolved.pin.model)
						pi.appendEntry("codex-route/v1", resolved.pin);
					pin = resolved.pin;
				} else {
					pendingPin = resolved.pin;
				}
			}
			return resolved.model;
		},
		stream: unresolved,
		streamSimple: unresolved,
	};
	pi.registerProvider(umbrella as Provider);

	const reroute = async (ctx: ExtensionContext) => {
		const model = ctx.model;
		if (
			!model || process.env.PI_CODEX_ACCOUNT_MAINTENANCE ||
			(model.provider !== registry.umbrellaProviderId && !registry.accounts.some((account) => account.providerId === model.provider))
		) return;
		const selector = ctx.modelRegistry.find(registry.umbrellaProviderId, model.id);
		if (!selector || !(await pi.setModel(selector))) throw new Error("Codex Personal provider resolution failed");
	};

	pi.on("session_start", async (_event, ctx) => {
		sessionStarted = true;
		if (startupFallbackWarning && ctx.hasUI)
			ctx.ui.notify(`Codex accounts unavailable; using ${ctx.model?.provider}/${ctx.model?.id}`, "warning");
		startupFallbackWarning = undefined;
		const branch = ctx.sessionManager.getBranch();
		pin = routeEntry(branch);
		if (!pin && pendingPin) {
			pin = pendingPin;
			pi.appendEntry("codex-route/v1", pin);
		}
		pendingPin = undefined;
		failedAccounts.clear();
		await reroute(ctx);
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		failedAccounts.clear();
		await reroute(ctx);
	});

	pi.on("message_end", async (event, ctx) => {
		if (
			event.message.role !== "assistant" ||
			!ctx.model ||
			!pin ||
			event.message.provider !== pin.actualProviderId ||
			!isTerminalCodexUsageLimit(event.message) ||
			!isZeroOutputFailure(event.message)
		)
			return;

		failedAccounts.add(pin.accountKey);
		try {
			const resolved = await resolveCodexPersonalSelection({
				model: ctx.model,
				registry,
				evaluate: () =>
					evaluateCodexRouteFromFiles({ model: event.message.model, registryPath: REGISTRY_PATH, feedPath: FEED_PATH }),
				context: {
					getModel: (provider, model) => ctx.modelRegistry.find(provider, model),
					hasAuth: async (provider) => !!(await ctx.modelRegistry.getProviderAuth(provider)),
				},
				excludedAccountKeys: failedAccounts,
			});
			if (!resolved.pin || !(await pi.setModel(resolved.model)))
				throw new Error(`AUTH UNAVAILABLE: ${resolved.pin?.actualProviderId ?? "next Codex account"}`);
			pin = resolved.pin;
			pi.appendEntry("codex-route/v1", pin);
			if (ctx.hasUI) ctx.ui.notify(`Codex usage limit: rerouted to ${pin.actualProviderId}`, "warning");
			return { retry: true };
		} catch (error) {
			const recovery = error instanceof Error ? error.message : String(error);
			return { message: { ...event.message, errorMessage: `${event.message.errorMessage}\nFailover unavailable: ${recovery}` } };
		}
	});
}
