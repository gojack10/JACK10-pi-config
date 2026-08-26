/**
 * SiftText MCP Extension for pi
 *
 * Connects to app.sifttext.com/mcp and registers selected ideation tools.
 *
 * Strategy: tool schemas are cached to tool-cache.json. Cache is valid for 24h.
 * On cache hit: tools load instantly (<50ms). On cache miss/expiry: ~2s connect.
 * No background refresh — cache invalidation is time-based only.
 *
 * Auth: set SIFTTEXT_API_KEY env var (sk-... key from SiftText API key management)
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import * as path from "node:path";
import * as fs from "node:fs";
import { execFileSync } from "node:child_process";
import { callMcpTool, initializeMcp, listMcpTools, mcpTextContent } from "../_shared/mcp-http";
import {
	hasSiftTextPullDone,
	inputIncludesSiftTextIdeationWrite,
	isKnownToolWrapper,
	isSiftTextIdeationWriteTool,
	normNodeId,
	rememberSiftTextPullRead,
	requiredSiftTextPullNode,
	siftTextPullBlockReason,
	siftTextToolTargetNodeId,
	SIFTTEXT_COMMIT_PULL_NODES,
	SIFTTEXT_IDEATION_READ_TOOLS,
} from "../_shared/sifttext-pull-gate";

const MCP_URL = "https://app.sifttext.com/mcp";
const CONNECT_TIMEOUT_MS = 2_000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1_000; // 24h — re-fetch schemas once per day
const CACHE_FILE = path.join(__dirname, "tool-cache.json");
const AUTH_ERROR_RE = /MCP HTTP 401|Invalid or expired (?:API key|access token)/i;

let workingTokenCache: string | undefined;

function singleKey(seed?: string): string[] {
	const candidates: string[] = [];
	const seen = new Set<string>();
	const add = (token: string | undefined) => {
		const trimmed = token?.trim();
		if (!trimmed || seen.has(trimmed)) return;
		seen.add(trimmed);
		candidates.push(trimmed);
	};

	add(seed);
	add(process.env.SIFTTEXT_API_KEY);

	try {
		const out = execFileSync("tmux", ["show-environment", "-g", "SIFTTEXT_API_KEY"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		const [, value] = out.split("=", 2);
		add(value);
	} catch {}

	try {
		const out = execFileSync("ps", [""], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
		const re = /(?:^|\s)SIFTTEXT_API_KEY=([^\s]+)/g;
		let match: RegExpExecArray | null;
		while ((match = re.exec(out))) add(match[1]);
	} catch {}

	return candidates;
}

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

function syncToken(token: string) {
	try {
		execFileSync("tmux", ["set-environment", "-g", "SIFTTEXT_API_KEY", token], {
			stdio: ["ignore", "ignore", "ignore"],
		});
	} catch {}
}

async function getWorkingToken(seed?: string): Promise<string | undefined> {
	if (workingTokenCache && (await tokenWorks(workingTokenCache))) return workingTokenCache;

	for (const token of singleKey(seed)) {
		if (await tokenWorks(token)) {
			workingTokenCache = token;
			process.env.SIFTTEXT_API_KEY = token;
			syncToken(token);
			return token;
		}
	}

	workingTokenCache = undefined;
	return seed ?? process.env.SIFTTEXT_API_KEY;
}

function isAuthError(err: unknown): boolean {
	return err instanceof Error && AUTH_ERROR_RE.test(err.message);
}

type CachedTool = {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
};

type SiftTextPullGateState = {
	pullNodeIds: Set<string>;
};

const PULL_STATE_STATE_ENTRY = "sifttext-pull-gate-state";

function freshPullGateState(): SiftTextPullGateState {
	return { pullNodeIds: new Set() };
}

function restorePullGateState(ctx: ExtensionContext, state: SiftTextPullGateState) {
	state.pullNodeIds = new Set();
	const entries = ctx.sessionManager.getEntries();
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i] as { type?: string; customType?: string; data?: Record<string, unknown> };
		if (entry.type !== "custom" || entry.customType !== PULL_STATE_STATE_ENTRY || !entry.data) continue;
		const ids = Array.isArray(entry.data.pullNodeIds)
			? (entry.data.pullNodeIds as unknown[])
			: [];
		state.pullNodeIds = new Set(
			ids
				.filter((id): id is string => typeof id === "string")
				.map(normNodeId)
				.filter((id) => Boolean(requiredSiftTextPullNode(id))),
		);
		return;
	}
}

function persistPullGateState(pi: ExtensionAPI, state: SiftTextPullGateState) {
	pi.appendEntry(PULL_STATE_STATE_ENTRY, {
		pullDone: hasSiftTextPullDone(state),
		pullNodeIds: [...state.pullNodeIds],
	});
}

function registerSiftTextPullGate(pi: ExtensionAPI) {
	const state = freshPullGateState();

	pi.on("session_start", async (_event, ctx) => {
		restorePullGateState(ctx, state);
	});

	pi.on("tool_call", async (event) => {
		const input = (event.input ?? {}) as Record<string, unknown>;

		// Witness the PULL: any read tool that names a required node ID counts.
		if (SIFTTEXT_IDEATION_READ_TOOLS.has(event.toolName) && event.toolName !== "sifttext_sql") {
			const beforeSize = state.pullNodeIds.size;
			const beforeDone = hasSiftTextPullDone(state);
			const read = rememberSiftTextPullRead(state, siftTextToolTargetNodeId(input));
			if (read && (state.pullNodeIds.size !== beforeSize || read.done !== beforeDone)) {
				persistPullGateState(pi, state);
			}
			return;
		}
		if (event.toolName === "sifttext_sql") {
			const query = String((input as { query?: unknown }).query ?? "").toLowerCase();
			let changed = false;
			for (const node of SIFTTEXT_COMMIT_PULL_NODES) {
				const id = normNodeId(node.id);
				if (!state.pullNodeIds.has(id) && query.includes(id)) {
					state.pullNodeIds.add(id);
					changed = true;
				}
			}
			if (changed) persistPullGateState(pi, state);
			return;
		}

		const directWrite = isSiftTextIdeationWriteTool(event.toolName);
		const wrappedWrite = isKnownToolWrapper(event.toolName) && inputIncludesSiftTextIdeationWrite(input);
		if ((directWrite || wrappedWrite) && !hasSiftTextPullDone(state)) {
			return { block: true, reason: siftTextPullBlockReason(state, "sifttext") };
		}
	});
}

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
		if (!SIFTTEXT_IDEATION_READ_TOOLS.has(tool.name) && !isSiftTextIdeationWriteTool(tool.name)) continue;
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

	// 3. Register the global write gate, then tools from cache (instant — TypeBox import only)
	registerSiftTextPullGate(pi);
	const registered = await registerTools(pi, tools, token);
	console.log(`[sifttext-mcp] Registered ${registered} SiftText tools`);
}
