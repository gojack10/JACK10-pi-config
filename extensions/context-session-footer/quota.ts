import {
	quotaBarColorForRemainingPercent,
	quotaBarForRemainingPercent,
} from "../codex-quota-extension/placement.ts";
import type { QuotaIncrease, QuotaStatus } from "../codex-quota-extension/store.ts";
import { formatFooterDuration } from "./duration.ts";

type QuotaTheme = {
	fg(color: "dim" | "text" | "warning" | "error", text: string): string;
};

const timer = (at: number, now: number) => formatFooterDuration(at * 1000 - now);

const formatPercentage = (value: number) => value.toFixed(1);

export function renderQuotaLines(
	status: QuotaStatus | undefined,
	width: number,
	theme: QuotaTheme,
	now: number,
	visibleWidth: (text: string) => number,
	fitToWidth: (text: string, width: number) => string,
): string[] {
	if (!status) return [];
	const render = (
		label: "5H" | "WEEK",
		percentage: number | undefined,
		increases: QuotaIncrease[],
		verifying: boolean,
	) => {
		const prefix = `CODEX ${label.padEnd(4)} `;
		if (percentage === undefined) return theme.fg("dim", `${prefix}NO DATA`);
		const amount = `${percentage.toFixed(1).padStart(5)}%`;
		const schedule = [
			...(verifying ? ["VERIFYING"] : []),
			...increases.map((increase) => `+${formatPercentage(increase.percent)}% IN ${timer(increase.at, now)}`),
		].join(" / ");
		const warning = !status.routable ? "BLOCKED" : status.aged ? "STALE" : "";
		const suffix = [schedule, warning].filter(Boolean).join(" / ");
		return `${theme.fg("dim", prefix)}${theme.fg(quotaBarColorForRemainingPercent(percentage), quotaBarForRemainingPercent(percentage))}${theme.fg("dim", `  ${amount}${suffix ? `   ${suffix}` : ""}`)}`;
	};
	return [
		render("5H", status.h5, status.h5Increases, status.h5Verifying),
		render("WEEK", status.week, status.weekIncreases, status.weekVerifying),
	].map((line) => visibleWidth(line) > width ? fitToWidth(line, width) : line);
}
