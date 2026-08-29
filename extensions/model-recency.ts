import {
	closeSync,
	existsSync,
	openSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, Model } from "@mariozechner/pi-coding-agent";

interface RecencyEntry { provider: string; modelId: string }
interface RecencyCache { order: RecencyEntry[] }

const AGENT_DIR = join(homedir(), ".pi", "agent");
const CACHE_PATH = join(AGENT_DIR, "model-recency.json");
const REGISTRY_PATH = join(AGENT_DIR, "codex-accounts.json");
const PERSONAL_PROVIDER = "openai-codex-personal";
const MAX_ENTRIES = 50;
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 5_000;

const key = (entry: RecencyEntry): string => `${entry.provider}\0${entry.modelId}`;
const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const accountProviders = (): Set<string> => {
	try {
		const raw = JSON.parse(readFileSync(REGISTRY_PATH, "utf8")) as { accounts?: Array<{ providerId?: unknown }> };
		return new Set((raw.accounts ?? []).flatMap((account) =>
			typeof account.providerId === "string" ? [account.providerId] : [],
		));
	} catch {
		return new Set();
	}
};

const loadCache = (path = CACHE_PATH): RecencyEntry[] => {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<RecencyCache>;
		if (!Array.isArray(parsed.order)) return [];
		return parsed.order.filter((entry): entry is RecencyEntry =>
			typeof entry?.provider === "string" && typeof entry?.modelId === "string",
		);
	} catch {
		return [];
	}
};

export const bumpRecencyOrder = (
	order: RecencyEntry[],
	model: RecencyEntry,
	providers: Set<string>,
): RecencyEntry[] => {
	const canonical = providers.has(model.provider)
		? { provider: PERSONAL_PROVIDER, modelId: model.modelId }
		: model;
	return [canonical, ...order]
		.filter((entry, index, entries) => !providers.has(entry.provider)
			&& entries.findIndex((candidate) => key(candidate) === key(entry)) === index)
		.slice(0, MAX_ENTRIES);
};

const acquireLock = async (path: string): Promise<number> => {
	const startedAt = Date.now();
	while (true) {
		try {
			return openSync(path, "wx", 0o600);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			try {
				if (Date.now() - statSync(path).mtimeMs > LOCK_STALE_MS) unlinkSync(path);
			} catch (statError) {
				if ((statError as NodeJS.ErrnoException).code !== "ENOENT") throw statError;
			}
			if (Date.now() - startedAt >= LOCK_WAIT_MS) throw new Error(`timed out waiting for ${path}`);
			await sleep(10 + Math.floor(Math.random() * 20));
		}
	}
};

export const updateRecencyFile = async (
	path: string,
	model: RecencyEntry,
	providers: Set<string>,
): Promise<RecencyEntry[]> => {
	const lockPath = `${path}.lock`;
	const handle = await acquireLock(lockPath);
	try {
		const order = bumpRecencyOrder(loadCache(path), model, providers);
		const tempPath = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
		writeFileSync(tempPath, `${JSON.stringify({ order } satisfies RecencyCache, null, 2)}\n`, { mode: 0o600 });
		try {
			renameSync(tempPath, path);
		} finally {
			if (existsSync(tempPath)) unlinkSync(tempPath);
		}
		return order;
	} finally {
		closeSync(handle);
		try { unlinkSync(lockPath); } catch {}
	}
};

export default function modelRecencyExtension(pi: ExtensionAPI) {
	const providers = accountProviders();
	let recentOrder = loadCache().filter((entry) => !providers.has(entry.provider));
	let pending = Promise.resolve();

	const publish = () => {
		pi.events.emit("model-recency:update", { order: recentOrder });
		pi.appendEntry("model-recency", { order: recentOrder });
	};
	const bump = (model: Model<any> | undefined) => {
		if (!model) return pending;
		pending = pending.catch(() => undefined).then(async () => {
			recentOrder = await updateRecencyFile(CACHE_PATH, {
				provider: model.provider,
				modelId: model.id,
			}, providers);
			publish();
		});
		return pending;
	};
	const bumpCurrent = (_event: unknown, ctx: ExtensionContext) => bump(ctx.model);

	pi.on("session_start", bumpCurrent);
	pi.on("session_switch", bumpCurrent);
	pi.on("session_tree", bumpCurrent);
	pi.on("model_select", (event) => bump(event.model));
}
