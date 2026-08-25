export type QuotaSegment = "5H" | "WEEK" | "TOTAL";

export const quotaPlacementForProvider = (
	provider: string | undefined,
): "above" | "beside" =>
	provider?.startsWith("openai-codex") ? "above" : "beside";

export const quotaSegmentsForProvider = (
	provider: string | undefined,
): readonly QuotaSegment[] =>
	provider?.startsWith("openai-codex")
		? ["5H", "WEEK", "TOTAL"]
		: ["TOTAL"];

export const QUOTA_TEXT_COLOR = "dim" as const;

export const quotaBarColorForUsedPercent = (
	pctUsed: number,
): "text" | "warning" | "error" => {
	const remaining = 100 - Math.max(0, Math.min(100, pctUsed));
	if (remaining <= 15) return "error";
	if (remaining < 30) return "warning";
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
