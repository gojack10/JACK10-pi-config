import {
	quotaBarColorForRemainingPercent,
	quotaBarForRemainingPercent,
} from "../codex-quota-extension/placement.ts";
import type { QuotaStatus } from "../codex-quota-extension/store.ts";
import { formatFooterDuration } from "./duration.ts";

type QuotaTheme = {
	fg(color: "dim" | "text" | "warning" | "error", text: string): string;
};

const timer = (at: number, now: number) => formatFooterDuration(at * 1000 - now);

export function renderQuotaLines(
	status: QuotaStatus | undefined,
	width: number,
	theme: QuotaTheme,
	now: number,
	visibleWidth: (text: string) => number,
	fitToWidth: (text: string, width: number) => string,
): string[] {
	if (!status) return [];
	const prefix = "CODEX GLOBAL ";
	if (status.global === undefined) return [theme.fg("dim", `${prefix}NO DATA`)];
	const percentage = status.global;
	const amount = `${String(Math.round(percentage)).padStart(3)}%`;
	const schedule = status.refillAt
		? `${status.routable ? "REFILL" : "RECOVERY"} IN ${timer(status.refillAt, now)}`
		: "";
	const warning = !status.routable ? "BLOCKED" : status.aged ? "STALE" : "";
	const suffix = [schedule, warning].filter(Boolean).join(" / ");
	const line = `${theme.fg("dim", prefix)}${theme.fg(quotaBarColorForRemainingPercent(percentage), quotaBarForRemainingPercent(percentage))}${theme.fg("dim", `  ${amount}${suffix ? `   ${suffix}` : ""}`)}`;
	return [visibleWidth(line) > width ? fitToWidth(line, width) : line];
}
