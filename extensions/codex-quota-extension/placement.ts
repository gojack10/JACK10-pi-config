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
