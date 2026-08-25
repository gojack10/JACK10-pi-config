import {
	QUOTA_TEXT_COLOR,
	quotaBarColorForRemainingPercent,
	quotaBarForRemainingPercent,
} from "../codex-quota-extension/placement.ts";
import type { QuotaStatus } from "../codex-quota-extension/store.ts";

type QuotaTheme = {
	fg(color: "dim" | "text" | "warning" | "error", text: string): string;
};

export const formatQuotaCountdown = (milliseconds: number): string => {
	const total = Math.max(0, Math.ceil(milliseconds / 1000));
	if (total < 3600) {
		const minutes = Math.floor(total / 60);
		return `${String(minutes).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
	}
	const hours = Math.floor(total / 3600);
	if (hours < 48)
		return `${String(hours).padStart(2, "0")}:${String(Math.floor((total % 3600) / 60)).padStart(2, "0")}`;
	return `${Math.floor(hours / 24)}d ${hours % 24}h`;
};

export const renderQuotaLine = (
	status: QuotaStatus | undefined,
	width: number,
	theme: QuotaTheme,
	now: number = Date.now(),
	besideCache = false,
	measure: (text: string) => number = (text) => text.length,
	fit: (text: string, width: number) => string = (text, limit) => text.slice(0, limit),
): string | undefined => {
	const grey = (text: string) => theme.fg(QUOTA_TEXT_COLOR, text);
	if (!status) {
		const text = besideCache ? "Q STALE" : "CODEX   5H   --   |   WEEK --   |   STALE";
		return fit(theme.fg("error", text), width);
	}
	if (status.stale) {
		const text = besideCache ? "Q STALE" : "CODEX   5H   --   |   WEEK --   |   STALE";
		return fit(theme.fg("error", text), width);
	}
	const colorFor = (value: number) => status.aged ? "dim" : quotaBarColorForRemainingPercent(value);
	const back = `BACK ${status.recoveryAt === undefined ? "?" : formatQuotaCountdown(status.recoveryAt * 1000 - now)}`;
	if (besideCache) {
		if (!status.routable) return fit(theme.fg("error", `Q ${back}`), width);
		if (status.h5 === undefined || status.week === undefined) return undefined;
		return fit(
			`${grey("Q 5H ")}${theme.fg(colorFor(status.h5), `${Math.round(status.h5)}%`)}${grey(" · W ")}${theme.fg(colorFor(status.week), `${Math.round(status.week)}%`)}`,
			width,
		);
	}
	const pool = (label: string, value: number | undefined, cells: number) => {
		if (value === undefined) return grey(`${label} --`);
		const color = colorFor(value);
		return `${grey(label)}${theme.fg(color, quotaBarForRemainingPercent(value, cells))}${grey(" ")}${theme.fg(color, `${String(Math.round(value)).padStart(3, " ")}%`)}`;
	};
	const edgeBlocked = !status.routable && (status.h5 ?? 0) > 0 && (status.week ?? 0) > 0;
	const suffix = !status.routable
		? `${grey("   |   ")}${theme.fg("error", `${edgeBlocked ? "BLOCKED · " : ""}${back}`)}`
		: "";
	const full = `${grey("CODEX   ")}${pool("5H   ", status.h5, 10)}${grey("   |   ")}${pool("WEEK ", status.week, 10)}${suffix}`;
	if (measure(full) <= width) return full;
	const compact = `${pool("5H ", status.h5, 5)}${grey("  ")}${pool("W ", status.week, 5)}${suffix}`;
	if (measure(compact) <= width) return compact;
	let minimal: string;
	if (!status.routable) {
		const gate = status.h5 === 0 ? "5H 0%" : status.week === 0 ? "W 0%" : edgeBlocked ? "BLOCKED" : "5H --";
		minimal = `${theme.fg("error", gate)}${grey("  ")}${theme.fg("error", back)}`;
	} else {
		minimal = `${grey("5H ")}${theme.fg(colorFor(status.h5 ?? 0), `${Math.round(status.h5 ?? 0)}%`)}${grey("  W ")}${theme.fg(colorFor(status.week ?? 0), `${Math.round(status.week ?? 0)}%`)}`;
	}
	return fit(minimal, width);
};
