export type UsageTotals = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
};

type UsageEntry = {
	type: string;
	timestamp?: string;
	message?: {
		role?: string;
		usage?: {
			input?: number;
			output?: number;
			cacheRead?: number;
			cacheWrite?: number;
			cost?: { total?: number };
		};
	};
};

const resetTypes = new Set(["compaction", "model_change", "thinking_level_change"]);

const emptyUsage = (): UsageTotals => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });

const numberOrZero = (value: number | undefined): number => (Number.isFinite(value) ? value! : 0);

const belongsToSession = (entry: UsageEntry, startedAt: number): boolean => {
	const timestamp = Date.parse(entry.timestamp ?? "");
	return !Number.isFinite(startedAt) || !Number.isFinite(timestamp) || timestamp >= startedAt;
};

const addUsage = (totals: UsageTotals, entry: UsageEntry): void => {
	if (entry.type !== "message" || entry.message?.role !== "assistant") return;

	const usage = entry.message.usage;
	if (!usage) return;
	totals.input += numberOrZero(usage.input);
	totals.output += numberOrZero(usage.output);
	totals.cacheRead += numberOrZero(usage.cacheRead);
	totals.cacheWrite += numberOrZero(usage.cacheWrite);
	totals.cost += numberOrZero(usage.cost?.total);
};

const sumUsage = (entries: UsageEntry[], startedAt: number): UsageTotals => {
	const totals = emptyUsage();
	for (const entry of entries) {
		if (belongsToSession(entry, startedAt)) addUsage(totals, entry);
	}
	return totals;
};

export const getSessionUsage = (entries: UsageEntry[], sessionStartedAt: string): UsageTotals =>
	sumUsage(entries, Date.parse(sessionStartedAt));

export const getCurrentRunUsage = (entries: UsageEntry[], sessionStartedAt: string): UsageTotals => {
	const startedAt = Date.parse(sessionStartedAt);
	let startIndex = 0;

	for (const [index, entry] of entries.entries()) {
		if (belongsToSession(entry, startedAt) && resetTypes.has(entry.type)) startIndex = index + 1;
	}

	return sumUsage(entries.slice(startIndex), startedAt);
};
