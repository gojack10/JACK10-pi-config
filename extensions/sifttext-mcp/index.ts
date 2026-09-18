/**
 * SiftText MCP Extension for pi
 *
 * Connects to app.sifttext.com/mcp and registers selected ideation tools.
 *
 * Strategy: tool schemas are cached to tool-cache.json. Cache is valid for 24h.
 * On cache hit: tools load instantly (<50ms). On cache miss/expiry: ~2s connect.
 * No background refresh — cache invalidation is time-based only.
 *
 * Auth: SIFTTEXT_API_KEY env var, or ~/.pi/agent/.sifttext-key (read, never written)
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as path from "node:path";
import * as fs from "node:fs";
import { callMcpTool, initializeMcp, listMcpTools, mcpTextContent } from "../_shared/mcp-http";
import { siftTextKey } from "../_shared/sifttext-key";

const MCP_URL = "https://app.sifttext.com/mcp";
const CONNECT_TIMEOUT_MS = 2_000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1_000; // 24h — re-fetch schemas once per day
const CACHE_FILE = path.join(__dirname, "tool-cache.json");
const AUTH_ERROR_RE = /MCP HTTP 401|Invalid or expired (?:API key|access token)/i;

let workingTokenCache: string | undefined;


async function tokenWorks(token: string): Promise<boolean> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), CONNECT_TIMEOUT_MS);
	try {
		await initializeMcp(MCP_URL, token, "pi-sifttext-token-check", { signal: controller.signal });
		return true;
	} catch {
		return false;
	} finally {
		clearTimeout(timer);
	}
}


async function getWorkingToken(seed?: string): Promise<string | undefined> {
	if (workingTokenCache && (await tokenWorks(workingTokenCache))) return workingTokenCache;

	const candidate = seed ?? siftTextKey();
	if (!candidate || !(await tokenWorks(candidate))) {
		workingTokenCache = undefined;
		return undefined;
	}
	workingTokenCache = candidate;
	return candidate;
}

function isAuthError(err: unknown): boolean {
	return err instanceof Error && AUTH_ERROR_RE.test(err.message);
}

type CachedTool = {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
};

// Exposed MCP surface: node/outline/sql reads plus ideation writes.
const IDEATION_READ_TOOLS = new Set(["sifttext_get_node", "sifttext_get_outline", "sifttext_sql"]);
const IDEATION_WRITE_TOOLS = new Set([
	"sifttext_create_tree", "sifttext_create_node", "sifttext_crystallize_append",
	"sifttext_crystallize_replace", "sifttext_edit_crystallization", "sifttext_edit_section",
	"sifttext_edit_scope", "sifttext_set_scope", "sifttext_mark_stuck", "sifttext_resolve",
	"sifttext_discard", "sifttext_defer", "sifttext_activate", "sifttext_set_priority",
	"sifttext_add_warning", "sifttext_add_ruled_out", "sifttext_set_vitals", "sifttext_rename_node",
	"sifttext_move_node", "sifttext_move_cross_tree", "sifttext_delete_node",
	"sifttext_duplicate_node", "sifttext_promote_to_root", "sifttext_link_by_name",
	"sifttext_reorder_children",
]);

// ── Lazy imports ────────────────────────────────────────────────────────────

async function importTypeBox() {
	const { Type } = await import("@sinclair/typebox");
	return Type;
}

// ── Connect + fetch tool schemas ────────────────────────────────────────────

async function fetchToolSchemas(token: string): Promise<CachedTool[] | null> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), CONNECT_TIMEOUT_MS);

	try {
		const tools = await listMcpTools(MCP_URL, token, "pi-sifttext", { signal: controller.signal });
		return tools.map((t) => ({
			name: t.name,
			description: t.description ?? t.name,
			inputSchema: (t.inputSchema ?? {}) as Record<string, unknown>,
		}));
	} catch (err) {
		if (!controller.signal.aborted) console.error("[sifttext-mcp] Failed to connect:", err);
		return null;
	} finally {
		clearTimeout(timer);
	}
}

// ── Register tools from schemas ─────────────────────────────────────────────

async function registerTools(pi: ExtensionAPI, tools: CachedTool[], token: string): Promise<number> {
	const Type = await importTypeBox();
	let registered = 0;

	for (const tool of tools) {
		// ponytail: only expose node/outline/sql reads plus ideation writes.
		if (!IDEATION_READ_TOOLS.has(tool.name) && !IDEATION_WRITE_TOOLS.has(tool.name)) continue;
		const rawSchema = tool.inputSchema;
		const properties = (rawSchema?.properties ?? {}) as Record<string, unknown>;
		const required = (rawSchema?.required ?? []) as string[];

		const tbProps: Record<string, ReturnType<typeof Type.String>> = {};
		for (const [key, schemaProp] of Object.entries(properties)) {
			const prop = schemaProp as Record<string, unknown>;
			const desc = typeof prop.description === "string" ? prop.description : undefined;
			const opts = desc ? { description: desc } : {};

			if (prop.type === "number" || prop.type === "integer") {
				tbProps[key] = Type.Number(opts) as unknown as ReturnType<typeof Type.String>;
			} else if (prop.type === "boolean") {
				tbProps[key] = Type.Boolean(opts) as unknown as ReturnType<typeof Type.String>;
			} else if (prop.type === "array") {
				tbProps[key] = Type.Array(Type.Unknown(), opts) as unknown as ReturnType<typeof Type.String>;
			} else {
				tbProps[key] = Type.String(opts);
			}
		}

		const optionalProps: Record<string, ReturnType<typeof Type.Optional>> = {};
		for (const [key, val] of Object.entries(tbProps)) {
			if (!required.includes(key)) {
				optionalProps[key] = Type.Optional(val);
			} else {
				optionalProps[key] = val as unknown as ReturnType<typeof Type.Optional>;
			}
		}

		const parameters =
			Object.keys(optionalProps).length > 0 ? Type.Object(optionalProps) : Type.Object({});

		registered++;
		pi.registerTool({
			name: tool.name,
			label: tool.name.replace(/_/g, " "),
			description: tool.description ?? tool.name,
			parameters,
			async execute(_toolCallId, params, signal) {
				// Lazy direct JSON-RPC call on first tool use; no MCP SDK dependency.
				let runtimeToken = (await getWorkingToken(token)) ?? token;
				let result;
				try {
					result = await callMcpTool(
						MCP_URL,
						runtimeToken,
						"pi-sifttext",
						tool.name,
						params as Record<string, unknown>,
						{ signal },
					);
				} catch (err) {
					if (!isAuthError(err)) throw err;
					workingTokenCache = undefined;
					runtimeToken = (await getWorkingToken()) ?? runtimeToken;
					result = await callMcpTool(
						MCP_URL,
						runtimeToken,
						"pi-sifttext",
						tool.name,
						params as Record<string, unknown>,
						{ signal },
					);
				}
				if (result.isError) {
					throw new Error(`Tool error: ${JSON.stringify(result.content)}`);
				}
				const text = mcpTextContent(result);
				return {
					content: [{ type: "text", text: text || JSON.stringify(result.content) }],
					details: {},
				};
			},
		});
	}

	return registered;
}

// ── Entry point ─────────────────────────────────────────────────────────────

export default async function (pi: ExtensionAPI) {
	const token = await getWorkingToken(process.env.SIFTTEXT_API_KEY);
	if (!token) {
		console.warn("[sifttext-mcp] no working SiftText key (bad key or unreachable endpoint) — skipping SiftText tools");
		return;
	}

	// 1. Try cache — instant path (<50ms), re-fetch if older than 24h
	let tools: CachedTool[] | null = null;
	try {
		if (fs.existsSync(CACHE_FILE)) {
			const stat = fs.statSync(CACHE_FILE);
			const stale = Date.now() - stat.mtimeMs > CACHE_TTL_MS;
			tools = JSON.parse(fs.readFileSync(CACHE_FILE, "utf-8"));
			if (stale) tools = null; // Force re-fetch
		}
	} catch {
		// Cache corrupted — will re-fetch
	}

	// 2. No valid cache? Block and fetch (first-time or daily refresh, ~2s)
	if (!tools) {
		tools = await fetchToolSchemas(token);
		if (!tools || tools.length === 0) {
			const retryToken = await getWorkingToken();
			if (retryToken && retryToken !== token) tools = await fetchToolSchemas(retryToken);
		}
		if (!tools || tools.length === 0) {
			console.warn("[sifttext-mcp] Could not fetch tool schemas — skipping");
			return;
		}
		// Save cache for next time
		try {
			fs.writeFileSync(CACHE_FILE, JSON.stringify(tools, null, "\t"), "utf-8");
		} catch {}
	}

	// 3. Register tools from cache (instant — TypeBox import only)
	const registered = await registerTools(pi, tools, token);
	console.log(`[sifttext-mcp] Registered ${registered} SiftText tools`);
}
