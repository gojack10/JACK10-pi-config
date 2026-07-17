import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type RecordValue = Record<string, unknown>;

const isRecord = (value: unknown): value is RecordValue =>
	value !== null && typeof value === "object" && !Array.isArray(value);

const withOneHourTtl = (block: unknown): unknown => {
	if (!isRecord(block) || !isRecord(block.cache_control)) return block;
	const cacheControl = block.cache_control;
	if (cacheControl.type !== "ephemeral" || cacheControl.ttl === "1h") return block;
	return { ...block, cache_control: { ...cacheControl, ttl: "1h" } };
};

const mapBlocks = (blocks: unknown): unknown => {
	if (!Array.isArray(blocks)) return blocks;
	let changed = false;
	const next = blocks.map((block) => {
		const updated = withOneHourTtl(block);
		changed ||= updated !== block;
		return updated;
	});
	return changed ? next : blocks;
};

const withOneHourMessage = (message: unknown): unknown => {
	if (!isRecord(message)) return message;
	const content = mapBlocks(message.content);
	return content === message.content ? message : { ...message, content };
};

const mapMessages = (messages: unknown): unknown => {
	if (!Array.isArray(messages)) return messages;
	let changed = false;
	const next = messages.map((message) => {
		const updated = withOneHourMessage(message);
		changed ||= updated !== message;
		return updated;
	});
	return changed ? next : messages;
};

export function withAnthropicOneHourCache(payload: unknown): RecordValue | undefined {
	if (!isRecord(payload)) return undefined;

	const system = mapBlocks(payload.system);
	const tools = mapBlocks(payload.tools);
	const messages = mapMessages(payload.messages);
	if (system === payload.system && tools === payload.tools && messages === payload.messages) return undefined;
	return { ...payload, system, tools, messages };
}

function isDirectAnthropic(model: unknown): boolean {
	return isRecord(model) && model.provider === "anthropic" && model.api === "anthropic-messages";
}

export default function anthropicLongCache(pi: ExtensionAPI) {
	pi.on("before_provider_request", (event, ctx) => {
		if (!isDirectAnthropic(ctx.model)) return;
		return withAnthropicOneHourCache(event.payload);
	});
}

if (process.env.ANTHROPIC_LONG_CACHE_SELF_TEST === "1") {
	const payload = {
		system: [{ type: "text", text: "system", cache_control: { type: "ephemeral" } }],
		tools: [{ name: "read", cache_control: { type: "ephemeral" }, input_schema: {} }],
		messages: [
			{
				role: "user",
				content: [
					{ type: "text", text: "hello", cache_control: { type: "ephemeral" } },
					{ type: "text", text: "unchanged" },
				],
			},
		],
		metadata: { cache_control: { type: "ephemeral" } },
	};
	const updated = withAnthropicOneHourCache(payload);
	assert.deepEqual(updated, {
		...payload,
		system: [{ ...payload.system[0], cache_control: { type: "ephemeral", ttl: "1h" } }],
		tools: [{ ...payload.tools[0], cache_control: { type: "ephemeral", ttl: "1h" } }],
		messages: [
			{
				...payload.messages[0],
				content: [
					{ ...payload.messages[0].content[0], cache_control: { type: "ephemeral", ttl: "1h" } },
					payload.messages[0].content[1],
				],
			},
		],
	});
	assert.equal(withAnthropicOneHourCache(updated), undefined);
	assert.equal(withAnthropicOneHourCache({ messages: [] }), undefined);
}
