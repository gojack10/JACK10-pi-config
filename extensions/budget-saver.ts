/**
 * Budget Saver Extension
 *
 * Shows cache-bust warnings and session budget interrupts. In print mode there
 * is no UI, so it does nothing. Pi TUI already has native context and session
 * cost indicators, so this extension does not add a status entry.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type CostModel = {
	provider: string;
	id: string;
	cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
};

type Fingerprint = {
	provider: string;
	model: string;
	thinking: string;
	tools: string;
	systemHash: string;
};

const CFG = {
	budgetStart: 20,
	budgetStep: 10,
	rebillFloor: 0.15,
	freshSessionEstimate: 0.05,
	failOpen: true,
};

export default function (pi: ExtensionAPI) {
	let currentProvider = "";
	let currentModel = "";
	let currentThinking = "";
	let lastTools = "";
	let lastSystemHash = "";
	let acceptedFingerprint: Fingerprint | null = null;
	let sessionCost = 0;
	let lastTurnCost = 0;
	let nextBudgetThreshold = CFG.budgetStart;
	let lastCtxTokens: number | null = null;
	let syncedFromHistory = false;

	function syncActiveSettings(ctx: any): void {
		const active = ctx.model as CostModel | undefined;
		if (active?.provider) currentProvider = String(active.provider);
		if (active?.id) currentModel = String(active.id);
		const thinking = pi.getThinkingLevel?.();
		if (thinking) currentThinking = String(thinking);
	}

	function currentFingerprint(): Fingerprint {
		return {
			provider: currentProvider,
			model: currentModel,
			thinking: currentThinking,
			tools: lastTools,
			systemHash: lastSystemHash,
		};
	}

	function fingerprintKey(fp: Fingerprint | null): string {
		if (!fp) return "";
		return [fp.provider, fp.model, fp.thinking, fp.tools, fp.systemHash].join("|");
	}

	function syncCostFromBranch(ctx: any): void {
		try {
			syncActiveSettings(ctx);
			const entries = ctx.sessionManager?.getBranch?.() ?? [];
			let total = 0;
			let branchProvider = "";
			let branchModel = "";
			let branchThinking = "";
			for (const entry of entries) {
				if (entry?.type === "message" && entry.message?.role === "assistant") {
					const msg = entry.message;
					total += Number(msg.usage?.cost?.total ?? 0);
					branchProvider = String(msg.provider ?? branchProvider);
					branchModel = String(msg.model ?? branchModel);
				} else if (entry?.type === "model_change") {
					branchProvider = String(entry.provider ?? branchProvider);
					branchModel = String(entry.modelId ?? entry.model ?? branchModel);
				} else if (entry?.type === "thinking_level_change") {
					branchThinking = String(entry.thinkingLevel ?? branchThinking);
				}
			}
			if (total > sessionCost) sessionCost = total;
			if (!acceptedFingerprint) {
				const live = currentFingerprint();
				acceptedFingerprint = {
					provider: live.provider || branchProvider,
					model: live.model || branchModel,
					thinking: live.thinking || branchThinking,
					tools: lastTools,
					systemHash: lastSystemHash,
				};
			}
			syncedFromHistory = true;
		} catch {
			// History sync is best-effort; live turns still update message_end.
		}
	}

	function syncCostFromMessages(messages: any[]): void {
		let total = 0;
		for (const msg of messages || []) {
			if (msg?.role === "assistant") total += Number(msg.usage?.cost?.total ?? 0);
		}
		if (total > sessionCost) sessionCost = total;
	}

	function currentCostModel(ctx: any): CostModel | undefined {
		const active = ctx.model as CostModel | undefined;
		if (active && active.provider === currentProvider && active.id === currentModel) return active;
		return ctx.modelRegistry?.find?.(currentProvider, currentModel) ?? active;
	}

	function priceReBill(model: CostModel | undefined, tokens: number): number {
		const cost = model?.cost;
		if (!cost) return 0;
		return (tokens * (Number(cost.input ?? 0) + Number(cost.cacheWrite ?? 0))) / 1_000_000;
	}

	function estimatePerTurn(ctx: any, tokens: number | null): number {
		if (!tokens) return 0;
		const model = currentCostModel(ctx);
		const cost = model?.cost;
		if (!cost) return 0;
		return (tokens * (Number(cost.cacheRead ?? cost.input ?? 0))) / 1_000_000;
	}

	function fmt(d: number): string {
		return `$${Math.max(0, d).toFixed(2)}`;
	}

	function fmtK(t: number | null): string {
		if (t == null) return "unknown";
		return `${Math.round(t / 1000)}k`;
	}

	function hash(s: string): string {
		let h = 2166136261;
		for (let i = 0; i < s.length; i++) {
			h ^= s.charCodeAt(i);
			h = Math.imul(h, 16777619);
		}
		return (h >>> 0).toString(16);
	}

	function thinkingRank(level: string): number {
		return { off: 0, minimal: 1, low: 2, medium: 3, high: 4, xhigh: 5 }[level] ?? 0;
	}

	function diffChanges(prev: Fingerprint, next: Fingerprint): string[] {
		const changes: string[] = [];
		if (prev.provider !== next.provider || prev.model !== next.model) changes.push(`switching to ${next.model}`);
		if (prev.thinking !== next.thinking) {
			const verb = thinkingRank(next.thinking) > thinkingRank(prev.thinking) ? "raising" : "lowering";
			changes.push(`${verb} thinking to ${next.thinking}`);
		}
		if (prev.tools !== next.tools) changes.push("changing tools");
		if (prev.systemHash !== next.systemHash) changes.push("editing the system prompt");
		return changes;
	}

	function joinClauses(items: string[]): string {
		if (items.length === 0) return "Changing settings";
		const capped = items.map((s, i) => (i === 0 ? s.charAt(0).toUpperCase() + s.slice(1) : s));
		if (capped.length === 1) return capped[0];
		if (capped.length === 2) return `${capped[0]} and ${capped[1]}`;
		return `${capped.slice(0, -1).join(", ")}, and ${capped[capped.length - 1]}`;
	}

	function cacheBustTitle(changes: string[], tokens: number, modelId: string, rebill: number): string {
		return `${joinClauses(changes)} clears the cache. Next turn re-bills ${fmtK(tokens)} at ${modelId} rates (~${fmt(rebill)}). Continue?`;
	}

	function budgetTitle(total: number, tokens: number | null, perTurn: number): string {
		return `Session ${fmt(total)}. At ${fmtK(tokens)} context, turns run ~${fmt(perTurn)} each. A fresh session with a handoff runs the same questions at ~${fmt(CFG.freshSessionEstimate)}.`;
	}

	function syncContextUsage(ctx: any): void {
		syncActiveSettings(ctx);
		const usage = ctx.getContextUsage?.();
		if (usage?.tokens != null) lastCtxTokens = usage.tokens;
		// Clear any old budget status left by previous extension versions.
		if (ctx.hasUI) ctx.ui.setStatus("budget", undefined);
	}

	async function restoreAcceptedSettings(ctx: any): Promise<void> {
		if (!acceptedFingerprint) return;
		const target = acceptedFingerprint;
		if (target.provider && target.model && (currentProvider !== target.provider || currentModel !== target.model)) {
			const model = ctx.modelRegistry?.find?.(target.provider, target.model);
			if (model) {
				const ok = await pi.setModel(model);
				if (ok !== false) {
					currentProvider = target.provider;
					currentModel = target.model;
				}
			}
		}
		if (target.thinking && currentThinking !== target.thinking) {
			pi.setThinkingLevel(target.thinking as any);
			currentThinking = target.thinking;
		}
		syncContextUsage(ctx);
	}

	pi.on("session_start", (_event: any, ctx: any) => {
		syncContextUsage(ctx);
	});

	pi.on("model_select", (event: any, ctx: any) => {
		currentProvider = String(event.model?.provider ?? currentProvider ?? "");
		currentModel = String(event.model?.id ?? currentModel ?? "");
		syncContextUsage(ctx);
	});

	pi.on("thinking_level_select", (event: any, ctx: any) => {
		currentThinking = String(event.level ?? currentThinking ?? "");
		syncContextUsage(ctx);
	});

	pi.on("before_agent_start", (event: any, ctx: any) => {
		lastTools = [...(event.systemPromptOptions?.selectedTools ?? [])].map(String).sort().join(",");
		lastSystemHash = hash(String(event.systemPrompt ?? ctx.getSystemPrompt?.() ?? ""));
		if (!acceptedFingerprint) acceptedFingerprint = currentFingerprint();
		syncContextUsage(ctx);
	});

	pi.on("context", (event: any, ctx: any) => {
		syncCostFromMessages(event.messages ?? []);
		syncContextUsage(ctx);
		return undefined;
	});

	pi.on("session_compact", () => {
		lastCtxTokens = null;
		acceptedFingerprint = null;
	});

	pi.on("message_end", (event: any, ctx: any) => {
		const msg = event.message;
		if (msg?.role !== "assistant") return;
		currentProvider = String(msg.provider ?? currentProvider ?? "");
		currentModel = String(msg.model ?? currentModel ?? "");
		const cost = Number(msg.usage?.cost?.total ?? 0);
		lastTurnCost = cost;
		sessionCost += cost;
		acceptedFingerprint = currentFingerprint();
		syncContextUsage(ctx);
	});

	pi.on("input", async (event: any, ctx: any) => {
		if (!ctx.hasUI) return { action: "continue" };
		if (event.source === "extension") return { action: "continue" };
		syncActiveSettings(ctx);
		if (!syncedFromHistory) syncCostFromBranch(ctx);

		const usage = ctx.getContextUsage?.();
		if (usage?.tokens != null) lastCtxTokens = usage.tokens;
		const tokens: number | null = usage ? usage.tokens : lastCtxTokens;

		if (sessionCost >= nextBudgetThreshold) {
			const perTurn = lastTurnCost || estimatePerTurn(ctx, tokens);
			const choice = await ctx.ui.select(budgetTitle(sessionCost, tokens, perTurn), [
				"Handoff + new session",
				"New session",
				"Continue",
				"Cancel",
			]);
			nextBudgetThreshold += CFG.budgetStep;
			if (choice === "Continue" || (choice === undefined && CFG.failOpen)) return { action: "continue" };
			await restoreAcceptedSettings(ctx);
			ctx.ui.notify("Stopped. Start a fresh session with a short handoff.", "info");
			return { action: "handled" };
		}

		if (acceptedFingerprint && tokens != null) {
			const next = currentFingerprint();
			if (fingerprintKey(next) !== fingerprintKey(acceptedFingerprint)) {
				const changes = diffChanges(acceptedFingerprint, next);
				const model = currentCostModel(ctx);
				const rebill = priceReBill(model, tokens);
				if (rebill >= CFG.rebillFloor) {
					const choice = await ctx.ui.select(
						cacheBustTitle(changes, tokens, currentModel || model?.id || "current model", rebill),
						["Continue", "Cancel"],
					);
					if (choice === "Cancel") {
						await restoreAcceptedSettings(ctx);
						return { action: "handled" };
					}
				}
			}
		}

		return { action: "continue" };
	});
}
