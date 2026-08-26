import { appendFileSync, chmodSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Model, OAuthCredential, Provider } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { parseRegistry, type RegistryAccount } from "./codex-quota-extension/store.ts";
import {
	isTerminalCodexUsageLimit,
	isZeroOutputFailure,
	resolveCodexPersonalSelection,
	type RoutePin,
} from "./codex-personal/resolution.ts";
import { evaluateCodexRouteFromFiles, parseWorkInput } from "./codex-personal/router.ts";
import { scheduleLoginProbe, withFreshLoginProbe } from "./codex-workspaces/probe.ts";

const AGENT_DIR = join(homedir(), ".pi", "agent");
const REGISTRY_PATH = join(AGENT_DIR, "codex-accounts.json");
const FEED_PATH = join(AGENT_DIR, "codex-usage-state.json");
const CHOICE_PATH = join(AGENT_DIR, "codex-personal-choice.json");
const AUTH_OBSERVABILITY_PATH = join(AGENT_DIR, "codex-workspace-auth-observability.jsonl");
const ROUTE_ENV = "PI_CODEX_PERSONAL_ROUTE";
const SOL_MODEL = /(^|-)sol($|-)/;

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

function parseRoute(value: string | undefined): RoutePin | undefined {
	if (!value) return undefined;
	const route = JSON.parse(value) as Partial<RoutePin>;
	if (
		typeof route.umbrella !== "string" ||
		typeof route.accountKey !== "string" ||
		typeof route.model !== "string" ||
		typeof route.actualProviderId !== "string" ||
		!Number.isInteger(route.feedGeneration) ||
		!Number.isFinite(route.routedAt) ||
		!(["short", "long", "unpredictable"] as unknown[]).includes(route.workClass)
	)
		throw new Error("Invalid Codex route environment");
	return route as RoutePin;
}

function routeEntry(entries: readonly unknown[]): RoutePin | undefined {
	const routes = entries
		.filter(
			(entry): entry is { type: "custom"; customType: "codex-route/v1"; data: RoutePin } =>
				!!entry &&
				typeof entry === "object" &&
				(entry as { type?: string }).type === "custom" &&
				(entry as { customType?: string }).customType === "codex-route/v1",
		)
		.map((entry) => entry.data);
	return routes.at(-1);
}

function validatePin(pin: RoutePin, account: RegistryAccount, umbrella: string): void {
	if (
		pin.umbrella !== umbrella ||
		pin.actualProviderId !== account.providerId ||
		!account.supportedModels.includes(pin.model)
	)
		throw new Error("ROUTE DENIED: Codex route pin does not match the private account registry");
}

function writeChoice(model: string): void {
	writeFileSync(CHOICE_PATH, `${JSON.stringify({ model }, null, 2)}\n`, { mode: 0o600 });
	chmodSync(CHOICE_PATH, 0o600);
}

export default function codexWorkspaces(pi: ExtensionAPI) {
	const registry = parseRegistry(JSON.parse(readFileSync(REGISTRY_PATH, "utf8")) as unknown);
	const source = builtinProviders().find((provider) => provider.id === "openai-codex");
	const oauth = source?.auth.oauth;
	if (!source || !oauth) throw new Error("Built-in Codex provider has no OAuth flow");
	let pin: RoutePin | undefined;
	let pendingPin: RoutePin | undefined;
	let sessionStarted = false;
	const failedAccounts = new Set<string>();
	const failoverAttempts = new Set<string>();
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
			stream: (model, context, options) => {
				if (
					pin?.accountKey !== account.accountKey &&
					process.env.PI_CODEX_ACCOUNT_MAINTENANCE !== account.providerId
				)
					throw new Error("ROUTE DENIED: launch real Codex accounts through pi-codex-personal");
				return source.stream(model, context, options);
			},
			streamSimple: (model, context, options) => {
				if (
					pin?.accountKey !== account.accountKey &&
					process.env.PI_CODEX_ACCOUNT_MAINTENANCE !== account.providerId
				)
					throw new Error("ROUTE DENIED: launch real Codex accounts through pi-codex-personal");
				return source.streamSimple(model, context, options);
			},
		} as Provider);
	}

	const selectionError = (model: Model): string | undefined =>
		evaluateCodexRouteFromFiles({
			model: model.id,
			work: parseWorkInput(process.env.PI_CODEX_WORK),
			registryPath: REGISTRY_PATH,
			feedPath: FEED_PATH,
		}).error;
	const failBeforeNetwork = (model: Model): never => {
		const blocked = selectionError(model);
		throw new Error(blocked ?? "launch through the Codex personal router");
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
				.filter((model) => SOL_MODEL.test(model.id))
				.map((model) => ({ ...model, provider: registry.umbrellaProviderId })),
		modelSelectionError: selectionError,
		resolveModel: async (model, context) => {
			const work = parseWorkInput(process.env.PI_CODEX_WORK);
			const resolved = await resolveCodexPersonalSelection({
				model,
				previousModel: context.previousModel,
				pin,
				registry,
				work,
				evaluate: () =>
					evaluateCodexRouteFromFiles({ model: model.id, work, registryPath: REGISTRY_PATH, feedPath: FEED_PATH }),
				context,
				excludedAccountKeys: failedAccounts,
				consideredAccountKeys: failedAccounts.size ? failoverAttempts : undefined,
				reevaluatePin: !!pin && failedAccounts.has(pin.accountKey),
			});
			if (resolved.pin) {
				if (sessionStarted) {
					pin = resolved.pin;
					pi.appendEntry("codex-route/v1", pin);
				} else {
					pendingPin = resolved.pin;
				}
			}
			return resolved.model;
		},
		stream: (model) => failBeforeNetwork(model),
		streamSimple: (model) => failBeforeNetwork(model),
	};
	pi.registerProvider(umbrella as Provider);

	let translating = false;
	pi.on("session_start", (event, ctx) => {
		sessionStarted = true;
		const branch = ctx.sessionManager.getBranch();
		pin = routeEntry(branch);
		const envRoute = parseRoute(process.env[ROUTE_ENV]);
		if (!pin && pendingPin) {
			pin = pendingPin;
			pi.appendEntry("codex-route/v1", pin);
		} else if (!pin && envRoute) {
			pin = envRoute;
			pi.appendEntry("codex-route/v1", pin);
		} else if (
			!pin &&
			branch.some((entry) => entry.type === "message") &&
			ctx.model?.provider.startsWith("openai-codex") &&
			ctx.model.provider !== registry.umbrellaProviderId
		) {
			const matches = registry.accounts.filter((account) => account.providerId === ctx.model?.provider);
			if (matches.length !== 1) throw new Error("ROUTE DENIED: historical Codex session has no unique account mapping");
			pin = {
				umbrella: registry.umbrellaProviderId,
				accountKey: matches[0]!.accountKey,
				model: ctx.model.id,
				actualProviderId: matches[0]!.providerId,
				feedGeneration: 0,
				routedAt: Date.now(),
				workClass: "unpredictable",
			};
			pi.appendEntry("codex-route/v1", pin);
		}
		pendingPin = undefined;
		if (!pin) return;
		const account = registry.accounts.find((entry) => entry.accountKey === pin!.accountKey);
		if (!account) throw new Error("ROUTE DENIED: pinned Codex account is absent from the registry");
		validatePin(pin, account, registry.umbrellaProviderId);
		if (ctx.model && (ctx.model.provider !== pin.actualProviderId || ctx.model.id !== pin.model))
			throw new Error("PIN VIOLATION: active model differs from the durable Codex route");
		if (event.reason === "new" && ctx.hasUI)
			ctx.ui.notify("NOT REBALANCED; RELAUNCH FOR ROUTING", "warning");
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
		failoverAttempts.add(pin.accountKey);
		const work = parseWorkInput(process.env.PI_CODEX_WORK);
		try {
			const resolved = await resolveCodexPersonalSelection({
				model: ctx.model,
				pin,
				registry,
				work,
				evaluate: () =>
					evaluateCodexRouteFromFiles({ model: event.message.model, work, registryPath: REGISTRY_PATH, feedPath: FEED_PATH }),
				context: {
					previousModel: ctx.model,
					getModel: (provider, model) => ctx.modelRegistry.find(provider, model),
					hasAuth: async (provider) => !!(await ctx.modelRegistry.getProviderAuth(provider)),
				},
				excludedAccountKeys: failedAccounts,
				consideredAccountKeys: failoverAttempts,
				reevaluatePin: true,
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

	pi.on("model_select", async (event, ctx) => {
		if (translating) return;
		if (event.model.provider === registry.umbrellaProviderId) {
			const blocked = selectionError(event.model);
			if (blocked) {
				if (ctx.hasUI) ctx.ui.notify(blocked, "error");
				if (event.previousModel) {
					translating = true;
					try {
						await pi.setModel(event.previousModel);
					} finally {
						translating = false;
					}
				}
				return;
			}
			if (!pin) {
				writeChoice(event.model.id);
				if (ctx.hasUI) ctx.ui.notify("Codex model saved; launch through pi-codex-personal to route an account", "warning");
				return;
			}
			const account = registry.accounts.find((entry) => entry.accountKey === pin!.accountKey)!;
			const actual = ctx.modelRegistry.find(account.providerId, event.model.id);
			if (!actual) throw new Error(`Pinned account does not support ${event.model.id}`);
			translating = true;
			try {
				if (!(await pi.setModel(actual))) throw new Error(`AUTH UNAVAILABLE: ${account.label}`);
			} finally {
				translating = false;
			}
			pin = { ...pin, model: event.model.id };
			pi.appendEntry("codex-route/v1", pin);
		}
	});
}
