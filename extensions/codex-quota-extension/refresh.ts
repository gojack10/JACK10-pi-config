import { mkdir, open, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { launchLoginProbe } from "../codex-workspaces/probe.ts";
import { CodexUsageStore, loadRegistry } from "./store.ts";

export const REFRESH_MS = 10 * 60_000;
const LOCK_MS = 5 * 60_000; // Three probes take at most 90 seconds.

export async function refreshQuota(feedPath: string, options: {
	registryPath?: string;
	probe?: (provider: string) => Promise<void>;
	now?: number;
} = {}): Promise<boolean> {
	if (process.env.PI_CODEX_ACCOUNT_MAINTENANCE) return false;
	const now = options.now ?? Date.now();
	const registryPath = options.registryPath ?? join(homedir(), ".pi/agent/codex-accounts.json");
	const stamp = `${feedPath}.refresh`;
	const lock = `${stamp}.lock`;
	await mkdir(dirname(feedPath), { recursive: true });
	// ponytail: one fleet-wide check; parallelize only if three small probes become slow.
	const previousLock = await stat(lock).catch((error) => {
		if (error.code !== "ENOENT") throw error;
		return undefined;
	});
	if (previousLock && now - previousLock.mtimeMs > LOCK_MS) await unlink(lock).catch(() => undefined);
	const handle = await open(lock, "wx", 0o600).catch((error) => {
		if (error.code !== "EEXIST") throw error;
		return undefined;
	});
	if (!handle) return false;
	try {
		const lastCheck = await readFile(stamp, "utf8").catch((error) => {
			if (error.code !== "ENOENT") throw error;
			return "0";
		});
		if (now - Number(lastCheck) < REFRESH_MS) return false;
		const registry = await loadRegistry(registryPath);
		const feed = await new CodexUsageStore(feedPath, registry).load();
		await writeFile(stamp, String(now), { mode: 0o600 });
		const probe = options.probe ?? ((provider: string) => new Promise<void>((resolve) => {
			launchLoginProbe(provider, () => resolve(), undefined, registryPath);
		}));
		for (const account of registry.accounts) {
			const sample = feed.accounts.find((entry) => entry.accountKey === account.accountKey);
			if (sample && now - sample.lastAttemptAt < REFRESH_MS) continue;
			await probe(account.providerId);
		}
		return true;
	} finally {
		await handle.close();
		await unlink(lock).catch(() => undefined);
	}
}
