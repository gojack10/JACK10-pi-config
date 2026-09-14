import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getTaskOutcomeManager } from "./task-outcomes/manager.ts";

const PRICING_LIMIT = 272_000;
// Just above Pi's 255,616-token auto-compaction threshold. Mid-loop compaction
// runs first; this remains the fail-closed fallback if compaction fails or is cancelled.
const REQUEST_GUARD = 256_000;
const STATUS_KEY = "openai-272k-guard";

type GuardModel = Pick<Model<Api>, "provider" | "id" | "baseUrl" | "contextWindow" | "cost">;

export function isOpenAIModel(model: GuardModel): boolean {
	const provider = model.provider.toLowerCase();
	const id = model.id.toLowerCase();
	const baseUrl = model.baseUrl?.toLowerCase() ?? "";
	return (
		provider.includes("openai") ||
		id.startsWith("openai/") ||
		id.startsWith("openai.") ||
		baseUrl.includes("openai.com") ||
		model.cost.tiers?.some((tier) => tier.inputTokensAbove === PRICING_LIMIT) === true
	);
}

export function capModel(model: GuardModel): boolean {
	if (!isOpenAIModel(model) || model.contextWindow <= PRICING_LIMIT) return false;
	model.contextWindow = PRICING_LIMIT;
	return true;
}

function hasTools(payload: unknown): boolean {
	if (!payload || typeof payload !== "object") return false;
	const body = payload as Record<string, unknown>;
	return (
		(Array.isArray(body.tools) && body.tools.length > 0) ||
		(Array.isArray(body.functions) && body.functions.length > 0)
	);
}

export function shouldBlock(model: GuardModel | undefined, tokens: number | null | undefined, payload: unknown): boolean {
	return !!model && isOpenAIModel(model) && tokens != null && tokens >= REQUEST_GUARD && hasTools(payload);
}

function harmlessPayload(payload: unknown): unknown {
	if (!payload || typeof payload !== "object") return payload;
	const body = { ...(payload as Record<string, unknown>) };
	if ("input" in body) body.input = [];
	if ("messages" in body) body.messages = [];
	if ("prompt" in body) body.prompt = "";
	if ("instructions" in body) body.instructions = "Blocked locally by the OpenAI 272K guard.";
	if ("tools" in body) body.tools = [];
	if ("functions" in body) body.functions = [];
	if ("max_output_tokens" in body) body.max_output_tokens = 1;
	if ("max_tokens" in body) body.max_tokens = 1;
	return body;
}

function applyCap(model: Model<Api> | undefined, ctx: ExtensionContext): void {
	if (!model || !isOpenAIModel(model)) {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		return;
	}
	const changed = capModel(model);
	ctx.ui.setStatus(STATUS_KEY, "OpenAI ≤272K");
	if (changed) ctx.ui.notify(`${model.provider}/${model.id} capped at 272K`, "warning");
}

export default function openAI272KGuard(pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => applyCap(ctx.model, ctx));
	pi.on("model_select", (event, ctx) => applyCap(event.model, ctx));

	pi.on("before_provider_request", (event, ctx) => {
		applyCap(ctx.model, ctx);
		const usage = ctx.getContextUsage();
		if (!shouldBlock(ctx.model, usage?.tokens, event.payload)) return;

		const tokens = usage?.tokens ?? 0;
		ctx.ui.setStatus(STATUS_KEY, `BLOCKED ${Math.round(tokens / 1000)}K`);
		const reason = `Blocked OpenAI request at ~${tokens.toLocaleString()} context tokens. Run /compact or /tool-call-clean, then retry.`;
		ctx.ui.notify(reason, "error");
		try {
			getTaskOutcomeManager(pi, ctx).pauseForContext(reason, REQUEST_GUARD);
		} catch (error) {
			ctx.ui.notify(`Context pause could not be saved: ${error instanceof Error ? error.message : String(error)}`, "error");
		}
		ctx.abort({ kind: "context", reason });
		// Codex can reuse an already-open WebSocket after abort. Replace the payload too,
		// so even that race cannot transmit the expensive conversation.
		return harmlessPayload(event.payload);
	});
}

if (process.env.OPENAI_272K_GUARD_SELF_TEST === "1") {
	const openAI = {
		provider: "openai-codex-team",
		id: "gpt-5.6-sol",
		baseUrl: "https://chatgpt.com/backend-api",
		contextWindow: 372_000,
		cost: {
			input: 5,
			output: 30,
			cacheRead: 0.5,
			cacheWrite: 6.25,
			tiers: [{ inputTokensAbove: 272_000, input: 10, output: 45, cacheRead: 1, cacheWrite: 12.5 }],
		},
	} satisfies GuardModel;
	assert.equal(capModel(openAI), true);
	assert.equal(openAI.contextWindow, 272_000);
	assert.equal(shouldBlock(openAI, 255_999, { tools: [{}] }), false);
	assert.equal(shouldBlock(openAI, 256_000, { tools: [{}] }), true);
	assert.equal(shouldBlock(openAI, 300_000, {}), false, "compaction requests without tools must remain available");
	assert.deepEqual(harmlessPayload({ model: "gpt-5.6-sol", input: ["private"], tools: [{}], max_output_tokens: 10 }), {
		model: "gpt-5.6-sol",
		input: [],
		tools: [],
		max_output_tokens: 1,
	});
	assert.equal(
		isOpenAIModel({
			provider: "anthropic",
			id: "claude-fable-5",
			baseUrl: "https://api.anthropic.com",
			contextWindow: 1_000_000,
			cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
		}),
		false,
	);
}
