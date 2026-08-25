export const quotaPlacementForProvider = (
	provider: string | undefined,
): "line" | "beside" =>
	provider?.startsWith("openai-codex") ? "line" : "beside";

export const QUOTA_TEXT_COLOR = "dim" as const;

export const quotaBarForRemainingPercent = (
	remaining: number,
	cells = 10,
): string => {
	const filled = Math.round((Math.max(0, Math.min(100, remaining)) / 100) * cells);
	return `${"█".repeat(filled)}${"░".repeat(cells - filled)}`;
};

export const quotaBarColorForRemainingPercent = (
	remaining: number,
): "text" | "warning" | "error" => {
	const clamped = Math.max(0, Math.min(100, remaining));
	if (clamped < 15) return "error";
	if (clamped < 30) return "warning";
	return "text";
};

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
	const tableWidth = Math.max(...lines.slice(cacheStart, cacheEnd).map(measure));
	const available = width - tableWidth - 1;
	if (available <= 0) return false;
	const quota = quotaForWidth(available);
	if (!quota) return false;
	const target = cacheStart + 1;
	const padding = " ".repeat(Math.max(0, tableWidth - measure(lines[target])));
	lines[target] = fit(`${lines[target]}${padding} ${quota}`, width);
	return true;
};
