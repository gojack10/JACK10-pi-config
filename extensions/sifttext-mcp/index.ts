/**
 * SiftText MCP Extension for pi
 *
 * Connects to app.sifttext.com/mcp and registers all ideation tools.
 *
 * Strategy: tool schemas are cached to tool-cache.json. Cache is valid for 24h.
 * On cache hit: tools load instantly (<50ms). On cache miss/expiry: ~2s connect.
 * No background refresh — cache invalidation is time-based only.
 *
 * Auth: set SIFTTEXT_API_KEY env var (sk-... key from SiftText API key management)
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as path from "node:path";
import * as fs from "node:fs";

const MCP_URL = "https://app.sifttext.com/mcp";
const CONNECT_TIMEOUT_MS = 2_000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1_000; // 24h — re-fetch schemas once per day
const CACHE_FILE = path.join(__dirname, "tool-cache.json");

type CachedTool = {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
};

// ── Lazy SDK imports (bypass jiti — Node native ESM loader is faster) ──────

async function importTypeBox() {
	const { Type } = await import("@sinclair/typebox");
	return Type;
}

async function importMcpSdk() {
	const [{ Client }, { StreamableHTTPClientTransport }] = await Promise.all([
		import("@modelcontextprotocol/sdk/client/index.js"),
		import("@modelcontextprotocol/sdk/client/streamableHttp.js"),
	]);
	return { Client, StreamableHTTPClientTransport };
}

// ── Connect + fetch tool schemas ────────────────────────────────────────────

async function fetchToolSchemas(token: string): Promise<CachedTool[] | null> {
	const { Client, StreamableHTTPClientTransport } = await importMcpSdk();

	const client = new Client({ name: "pi-sifttext", version: "1.0.0" });

	const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
		requestInit: { headers: { Authorization: `Bearer ${token}` } },
	});

	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		transport.close();
	}, CONNECT_TIMEOUT_MS);

	try {
		await client.connect(transport);
		if (timedOut) return null;
	} catch (err) {
		if (!timedOut) console.error("[sifttext-mcp] Failed to connect:", err);
		return null;
	} finally {
		clearTimeout(timer);
	}

	const { tools } = await client.listTools();
	await client.close();

	return tools.map((t) => ({
		name: t.name,
		description: t.description,
		inputSchema: t.inputSchema as Record<string, unknown>,
	}));
}

// ── Register tools from schemas ─────────────────────────────────────────────

async function registerTools(pi: ExtensionAPI, tools: CachedTool[], token: string) {
	const Type = await importTypeBox();

	for (const tool of tools) {
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

		pi.registerTool({
			name: tool.name,
			label: tool.name.replace(/_/g, " "),
			description: tool.description ?? tool.name,
			parameters,
			async execute(_toolCallId, params, _signal) {
				// Lazy connect on first tool call
				const { Client, StreamableHTTPClientTransport } = await importMcpSdk();
				const client = new Client({ name: "pi-sifttext", version: "1.0.0" });
				const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
					requestInit: { headers: { Authorization: `Bearer ${token}` } },
				});
				await client.connect(transport);
				const result = await client.callTool({
					name: tool.name,
					arguments: params as Record<string, unknown>,
				});
				await client.close();
				if (result.isError) {
					throw new Error(`Tool error: ${JSON.stringify(result.content)}`);
				}
				const text = result.content
					.filter((c): c is { type: "text"; text: string } => c.type === "text")
					.map((c) => c.text)
					.join("\n");
				return {
					content: [{ type: "text", text: text || JSON.stringify(result.content) }],
					details: {},
				};
			},
		});
	}
}

// ── Entry point ─────────────────────────────────────────────────────────────

export default async function (pi: ExtensionAPI) {
	const token = process.env.SIFTTEXT_API_KEY;
	if (!token) {
		console.warn("[sifttext-mcp] SIFTTEXT_API_KEY not set — skipping SiftText tools");
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
			console.warn("[sifttext-mcp] Could not fetch tool schemas — skipping");
			return;
		}
		// Save cache for next time
		try {
			fs.writeFileSync(CACHE_FILE, JSON.stringify(tools, null, "\t"), "utf-8");
		} catch {}
	}

	// 3. Register tools from cache (instant — TypeBox import only, no MCP SDK)
	await registerTools(pi, tools, token);
	console.log(`[sifttext-mcp] Registered ${tools.length} SiftText tools`);
}
