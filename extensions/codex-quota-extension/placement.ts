export const quotaPlacementForProvider = (
	provider: string | undefined,
): "above" | "beside" =>
	provider?.startsWith("openai-codex") ? "above" : "beside";

export const appendQuotaBesideCache = (
	lines: string[],
	cacheStart: number,
	cacheEnd: number,
	width: number,
	quotaForWidth: (availableWidth: number) => string | undefined,
	measure: (text: string) => number,
	fit: (text: string, width: number) => string,
): boolean => {
	if (cacheEnd - cacheStart < 3) return false;
	const tableWidth = Math.max(
		...lines.slice(cacheStart, cacheEnd).map(measure),
	);
	const available = width - tableWidth - 1;
	if (available <= 0) return false;
	const quota = quotaForWidth(available);
	if (!quota) return false;
	const target = cacheStart + 1;
	const padding = " ".repeat(Math.max(0, tableWidth - measure(lines[target])));
	lines[target] = fit(`${lines[target]}${padding} ${quota}`, width);
	return true;
};
