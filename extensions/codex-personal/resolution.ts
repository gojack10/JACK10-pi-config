import type { Model, ModelResolutionContext } from "@earendil-works/pi-ai";
import type {
	CodexAccountRegistry,
	RegistryAccount,
} from "../codex-quota-extension/store.ts";
import type { RouteEvaluation, WorkInput } from "./router.ts";

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
}): Promise<{ model: Model; pin?: RoutePin }> {
	const { model, previousModel, registry, context, pin } = options;
	const pinnedAccount = pin
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
	if (evaluation.allBlocked) throw new Error(evaluation.error);
	for (const candidate of evaluation.candidates) {
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
	throw new Error(
		`ERROR: ${registry.umbrellaProviderId}/${model.id} unavailable — telemetry eligible but credentials unavailable.`,
	);
}
