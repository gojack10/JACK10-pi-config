import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

const NODE_LIMIT = 200;
const TREE_LIMIT = 50;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function decodeXml(text: string): string {
	return text
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.trim();
}

function extractAttr(attrs: string, name: string): string | undefined {
	const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const match = attrs.match(new RegExp(`\\b${escaped}="([^"]*)"`, "i"));
	return match ? decodeXml(match[1]) : undefined;
}

function normalizeId(id: string | undefined): string | undefined {
	if (!id) return undefined;
	const normalized = id.trim().toLowerCase();
	return UUID_RE.test(normalized) ? normalized : undefined;
}

function textBlocksToString(content: unknown): string {
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		if (!("type" in block) || block.type !== "text") continue;
		if (!("text" in block) || typeof block.text !== "string") continue;
		parts.push(block.text);
	}
	return parts.join("\n");
}

function upsertLimited(map: Map<string, string>, id: string, name: string, maxSize: number): void {
	const key = id.toLowerCase();
	if (map.has(key)) map.delete(key);
	map.set(key, name);
	while (map.size > maxSize) {
		const oldest = map.keys().next().value;
		if (!oldest) break;
		map.delete(oldest);
	}
}

function parseIdeationGetNode(text: string): { trees: Array<{ id: string; name: string }>; nodes: Array<{ id: string; name: string }> } {
	const trees: Array<{ id: string; name: string }> = [];
	const nodes: Array<{ id: string; name: string }> = [];

	const rootTag = text.match(/<node\b([^>]*)>/i);
	if (!rootTag) return { trees, nodes };

	const rootAttrs = rootTag[1];
	const treeId = normalizeId(extractAttr(rootAttrs, "tree_id"));
	const treeName = extractAttr(rootAttrs, "tree_name");
	if (treeId && treeName) trees.push({ id: treeId, name: treeName });

	const nodeId = normalizeId(extractAttr(rootAttrs, "id"));
	const nodeNameMatch = text.match(/<name>([\s\S]*?)<\/name>/i);
	const nodeName = nodeNameMatch ? decodeXml(nodeNameMatch[1]) : undefined;
	if (nodeId && nodeName) nodes.push({ id: nodeId, name: nodeName });

	const childTagRe = /<child\b([^>]*)\/?>/gi;
	let childMatch: RegExpExecArray | null;
	while ((childMatch = childTagRe.exec(text))) {
		const attrs = childMatch[1];
		const childId = normalizeId(extractAttr(attrs, "id"));
		const childName = extractAttr(attrs, "name");
		if (childId && childName) nodes.push({ id: childId, name: childName });
	}

	return { trees, nodes };
}

function buildRefsBlock(treeRefs: Map<string, string>, nodeRefs: Map<string, string>): string | undefined {
	if (treeRefs.size === 0 && nodeRefs.size === 0) return undefined;
	const lines: string[] = [
		"SYSTEM (sifttext-session-refs): stable SiftText identifiers captured from earlier ideation_get_node results in this session.",
	];
	if (treeRefs.size > 0) {
		lines.push("Trees:");
		for (const [id, name] of treeRefs) lines.push(`- ${id} — ${name}`);
	}
	if (nodeRefs.size > 0) {
		lines.push("Nodes:");
		for (const [id, name] of nodeRefs) lines.push(`- ${id} — ${name}`);
	}
	lines.push("Use these only as identifier/name memory. Re-read with ideation_get_node before acting on current SiftText state.");
	return lines.join("\n");
}

export default async function sifttextSessionRefs(pi: ExtensionAPI) {
	const { Type } = await import("@sinclair/typebox");

	let treeRefs = new Map<string, string>();
	let nodeRefs = new Map<string, string>();

	const absorbText = (text: string): void => {
		const parsed = parseIdeationGetNode(text);
		for (const tree of parsed.trees) upsertLimited(treeRefs, tree.id, tree.name, TREE_LIMIT);
		for (const node of parsed.nodes) upsertLimited(nodeRefs, node.id, node.name, NODE_LIMIT);
	};

	const rebuildFromBranch = (ctx: ExtensionContext): void => {
		treeRefs = new Map<string, string>();
		nodeRefs = new Map<string, string>();
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			const message = entry.message;
			if (message.role !== "toolResult") continue;
			if (message.toolName !== "ideation_get_node" || message.isError) continue;
			absorbText(textBlocksToString(message.content));
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		rebuildFromBranch(ctx);
	});

	pi.on("tool_result", async (event, _ctx) => {
		if (event.toolName !== "ideation_get_node" || event.isError) return;
		absorbText(textBlocksToString(event.content));
	});

	pi.registerTool({
		name: "sifttext_recall_refs",
		label: "sifttext recall refs",
		description:
			"Recall SiftText tree/node UUIDs and names captured from earlier ideation_get_node results in this session. " +
			"Pass an optional case-insensitive substring (matched against names) or UUID prefix to narrow the list. " +
			"Use this when you remember seeing a node by name and need its UUID without re-searching. " +
			"Re-read with ideation_get_node before acting on current SiftText state — these refs are name/id memory only.",
		parameters: Type.Object({
			filter: Type.Optional(
				Type.String({
					description:
						"Optional substring to match against names (case-insensitive) or a UUID prefix to match IDs. Omit to return everything.",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal) {
			const raw = (params as { filter?: unknown })?.filter;
			const filter = typeof raw === "string" && raw.trim() ? raw.trim().toLowerCase() : undefined;
			const matches = (id: string, name: string): boolean => {
				if (!filter) return true;
				return id.toLowerCase().startsWith(filter) || name.toLowerCase().includes(filter);
			};
			const filteredTrees = new Map([...treeRefs].filter(([id, name]) => matches(id, name)));
			const filteredNodes = new Map([...nodeRefs].filter(([id, name]) => matches(id, name)));
			const block = buildRefsBlock(filteredTrees, filteredNodes);
			return {
				content: [
					{
						type: "text",
						text: block ?? "(no SiftText refs captured in this session yet — call ideation_get_node first)",
					},
				],
				details: {
					trees: [...filteredTrees].map(([id, name]) => ({ id, name })),
					nodes: [...filteredNodes].map(([id, name]) => ({ id, name })),
				},
			};
		},
	});
}
