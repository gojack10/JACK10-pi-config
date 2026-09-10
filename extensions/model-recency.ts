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

export interface RecencyEntry { provider: string; modelId: string }
interface RecencyCache { order: RecencyEntry[] }

const AGENT_DIR = join(homedir(), ".pi", "agent");
const CACHE_PATH = join(AGENT_DIR, "model-recency.json");
const REGISTRY_PATH = join(AGENT_DIR, "codex-accounts.json");
const PERSONAL_PROVIDER = "openai-codex-personal";
const MAX_ENTRIES = 50;
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 5_000;

const key = (entry: RecencyEntry): string => `${entry.provider}\0${entry.modelId}`;
const isUsableModel = (model: Model<any> | undefined): model is Model<any> =>
	!!model && model.provider !== "unknown" && model.id !== "unknown";
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

export async function selectMostRecentModel(
	order: readonly RecencyEntry[],
	options: {
		findModel: (provider: string, modelId: string) => Model<any> | undefined;
		scopedModels: readonly { model: Model<any> }[];
		setModel: (model: Model<any>) => Promise<boolean>;
	},
): Promise<Model<any> | undefined> {
	for (const entry of order) {
		const model = options.findModel(entry.provider, entry.modelId);
		if (!model) continue;
		if (
			options.scopedModels.length > 0 &&
			!options.scopedModels.some((scoped) => scoped.model.provider === model.provider && scoped.model.id === model.id)
		)
			continue;
		try {
			if (await options.setModel(model)) return model;
		} catch {
			// Skip stale or currently unavailable recency entries.
		}
	}
	return undefined;
}

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
		if (!isUsableModel(model)) return pending;
		pending = pending.catch(() => undefined).then(async () => {
			recentOrder = await updateRecencyFile(CACHE_PATH, {
				provider: model.provider,
				modelId: model.id,
			}, providers);
			publish();
		});
		return pending;
	};
	pi.on("session_start", async (_event, ctx) => {
		if (!isUsableModel(ctx.model)) {
			await selectMostRecentModel(recentOrder, {
				findModel: (provider, modelId) => ctx.modelRegistry.find(provider, modelId),
				scopedModels: ctx.scopedModels,
				setModel: (model) => pi.setModel(model),
			});
		}
		await bump(ctx.model);
	});
	const bumpCurrent = (_event: unknown, ctx: ExtensionContext) => bump(ctx.model);
	pi.on("session_switch", bumpCurrent);
	pi.on("session_tree", bumpCurrent);
	pi.on("model_select", (event) => bump(event.model));
}
