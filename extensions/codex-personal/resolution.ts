import type { AssistantMessage, Model, ModelResolutionContext } from "@earendil-works/pi-ai";
import type {
	CodexAccountRegistry,
	RegistryAccount,
} from "../codex-quota-extension/store.ts";
import type { RouteEvaluation, WorkInput } from "./router.ts";

export const isTerminalCodexUsageLimit = (message: AssistantMessage): boolean =>
	message.stopReason === "error" &&
	/ChatGPT usage limit|usage[_ ]limit(?:[_ ]has[_ ]been)?[_ ]reached|usage_not_included/i.test(message.errorMessage ?? "");

export const isZeroOutputFailure = (message: AssistantMessage): boolean =>
	message.content.every(
		(block) =>
			(block.type === "text" && block.text.length === 0) ||
			(block.type === "thinking" && block.thinking.length === 0),
	) && message.usage.output === 0;

export type RoutePin = {
	umbrella: string;
	accountKey: string;
	model: string;
	actualProviderId: string;
	feedGeneration: number;
	routedAt: number;
	workClass: "short" | "long" | "unpredictable";
	horizonMinutes?: number;
};

export function routeEntry(entries: readonly unknown[]): RoutePin | undefined {
	let pin: RoutePin | undefined;
	for (const entry of entries) {
		if (!entry || typeof entry !== "object") continue;
		const value = entry as {
			type?: string;
			customType?: string;
			data?: RoutePin;
			provider?: string;
			modelId?: string;
		};
		if (value.type === "custom" && value.customType === "codex-route/v1") pin = value.data;
		else if (
			value.type === "model_change" &&
			pin &&
			(value.provider !== pin.actualProviderId || value.modelId !== pin.model)
		)
			pin = undefined;
	}
	return pin;
}

function validatePin(
	pin: RoutePin,
	account: RegistryAccount,
	umbrella: string,
): void {
	if (
		pin.umbrella !== umbrella ||
		pin.actualProviderId !== account.providerId ||
		!account.supportedModels.includes(pin.model)
	)
		throw new Error(
			"ROUTE DENIED: Codex route pin does not match the private account registry",
		);
}

export async function resolveCodexPersonalSelection(options: {
	model: Model;
	previousModel?: Model;
	pin?: RoutePin;
	registry: CodexAccountRegistry;
	work: WorkInput;
	evaluate: () => RouteEvaluation;
	context: ModelResolutionContext;
	excludedAccountKeys?: ReadonlySet<string>;
	consideredAccountKeys?: Set<string>;
	reevaluatePin?: boolean;
	fallbackProviderId?: string;
}): Promise<{ model: Model; pin?: RoutePin; warning?: string }> {
	const { model, previousModel, registry, context, pin } = options;
	const pinnedAccount = options.reevaluatePin
		? undefined
		: pin
			? registry.accounts.find((account) => account.accountKey === pin.accountKey)
			: registry.accounts.find(
					(account) => account.providerId === previousModel?.provider,
				);
	if (pinnedAccount) {
		const pinned = pin ? { ...pin, model: model.id } : undefined;
		if (pinned) validatePin(pinned, pinnedAccount, registry.umbrellaProviderId);
		const target = context.getModel(pinnedAccount.providerId, model.id);
		if (!target) throw new Error(`Pinned account does not support ${model.id}`);
		if (!(await context.hasAuth(pinnedAccount.credentialRef)))
			throw new Error(`AUTH UNAVAILABLE: ${pinnedAccount.label}`);
		return { model: target, ...(pinned ? { pin: pinned } : {}) };
	}

	const evaluation = options.evaluate();
	if (evaluation.allBlocked) {
		const fallback = options.fallbackProviderId
			? context.getModel(options.fallbackProviderId, model.id)
			: undefined;
		if (fallback && (await context.hasAuth(fallback.provider)))
			return {
				model: fallback,
				...(evaluation.error ? { warning: evaluation.error } : {}),
			};
		throw new Error(evaluation.error);
	}
	for (const candidate of evaluation.candidates) {
		if (options.excludedAccountKeys?.has(candidate.accountKey) || options.consideredAccountKeys?.has(candidate.accountKey))
			continue;
		options.consideredAccountKeys?.add(candidate.accountKey);
		const account = registry.accounts.find(
			(entry) => entry.accountKey === candidate.accountKey,
		);
		if (!account)
			throw new Error(`ROUTE DENIED: unknown account ${candidate.accountKey}`);
		const target = context.getModel(candidate.actualProviderId, model.id);
		if (!target || !(await context.hasAuth(account.credentialRef))) continue;
		return {
			model: target,
			pin: {
				umbrella: registry.umbrellaProviderId,
				accountKey: candidate.accountKey,
				model: model.id,
				actualProviderId: candidate.actualProviderId,
				feedGeneration: candidate.feedGeneration,
				routedAt: Date.now(),
				workClass: options.work.workClass,
				...(options.work.horizonMinutes === undefined
					? {}
					: { horizonMinutes: options.work.horizonMinutes }),
			},
		};
	}
	const excluded = [...(options.excludedAccountKeys ?? [])];
	throw new Error(
		`ERROR: ${registry.umbrellaProviderId}/${model.id} unavailable — eligible accounts exhausted or credentials unavailable.${excluded.length ? ` Excluded after usage limit: ${excluded.join(", ")}.` : ""}`,
	);
}
