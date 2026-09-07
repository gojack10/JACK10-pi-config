import {
	quotaBarColorForRemainingPercent,
	quotaBarForRemainingPercent,
} from "../codex-quota-extension/placement.ts";
import type { QuotaBucketRow } from "../codex-quota-extension/store.ts";
import { formatFooterCountdown } from "./duration.ts";

type QuotaTheme = {
	fg(color: "dim" | "text" | "warning" | "error", text: string): string;
};

export function renderQuotaLines(
	status: QuotaBucketRow[] | undefined,
	width: number,
	theme: QuotaTheme,
	now: number,
	visibleWidth: (text: string) => number,
	fitToWidth: (text: string, width: number) => string,
): string[] {
	if (!status) return [];
	return status.map((row) => {
		const prefix = `CODEX ${row.bucket.padEnd(4)} ${row.window.padEnd(4)} `;
		const amount = `${row.remaining.toFixed(1).padStart(5)}%`;
		const schedule = row.increases.slice(0, 2).length
			? row.increases
					.slice(0, 2)
					.map((refill, index) => {
						const time = formatFooterCountdown(refill.at * 1000 - now);
						const size = refill.percent >= 100 ? "FULL" : `+${refill.percent.toFixed(0)}%`;
						return index === 0 ? `RESETS ${time} ${size}` : `- ${time} ${size}`;
					})
					.join(" ")
			: row.verifying
				? "RESETS ?"
				: "";
		const badge = row.blocked ? "BLOCKED" : row.stale ? "STALE" : "";
		const suffix = [schedule, badge].filter(Boolean).join(" ");
		const line = `${theme.fg("dim", prefix)}${theme.fg(quotaBarColorForRemainingPercent(row.remaining), quotaBarForRemainingPercent(row.remaining))}${theme.fg("dim", ` ${amount}${suffix ? `   ${suffix}` : ""}`)}`;
		return visibleWidth(line) > width ? fitToWidth(line, width) : line;
	});
}
