/**
 * Model Recency Extension
 *
 * Tracks model switches to maintain MRU order.
 * Persists to ~/.pi/agent/model-recency.json (survives session restarts).
 * Also writes to session entries so the built-in /model reader picks it up.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

interface RecencyEntry {
	provider: string;
	modelId: string;
}

const CACHE_FILE = path.join(
	process.env.HOME ?? "~",
	".pi/agent/model-recency.json",
);

function readCache(): RecencyEntry[] {
	try {
		const raw = fs.readFileSync(CACHE_FILE, "utf-8");
		const data = JSON.parse(raw);
		if (data?.order && Array.isArray(data.order)) return data.order;
	} catch {
		// File doesn't exist or is corrupt — start fresh
	}
	return [];
}

function writeCache(order: RecencyEntry[]): void {
	try {
		fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
		fs.writeFileSync(CACHE_FILE, JSON.stringify({ order }), "utf-8");
	} catch {
		// Best effort
	}
}

export default function (pi: ExtensionAPI) {
	let recentOrder: RecencyEntry[] = readCache();

	function fullId(provider: string, modelId: string): string {
		return `${provider}/${modelId}`;
	}

	function persist() {
		writeCache(recentOrder);
		// Also write to session so showModelSelector can read it
		pi.appendEntry("model-recency", { order: recentOrder });
	}

	function bump(model: { provider: string; id: string }) {
		const key = fullId(model.provider, model.id);
		recentOrder = recentOrder.filter((e) => fullId(e.provider, e.modelId) !== key);
		recentOrder.unshift({ provider: model.provider, modelId: model.id });
		if (recentOrder.length > 50) recentOrder = recentOrder.slice(0, 50);
		persist();
	}

	pi.on("model_select", (event) => {
		bump(event.model);
	});

	pi.on("session_start", (_event, ctx) => {
		// Reload from file (may have been modified by another session)
		recentOrder = readCache();
		if (ctx.model) bump(ctx.model);
	});

	pi.on("session_tree", (_event, ctx) => {
		recentOrder = readCache();
		if (ctx.model) bump(ctx.model);
	});
}
