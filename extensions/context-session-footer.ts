import { execFileSync } from "node:child_process";
import type {
	ExtensionAPI,
	Theme,
	ThemeColor,
} from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import {
	cacheStatus,
	type CacheStatusRow,
} from "./cache-status/store.ts";
import {
	getCacheTimerColor,
	getCurrentRunUsage,
	getSessionUsage,
	type UsageTotals,
} from "./context-session-footer/session-usage.ts";

const fitToWidth = (s: string, width: number): string => {
	if (width <= 0) return "";
	if (visibleWidth(s) <= width) return s;
	return truncateToWidth(s, width, "…");
};

type FooterLineState = {
	lines: string[];
	currentLine: string;
};

const flushFooterLine = (state: FooterLineState, width: number): void => {
	if (!state.currentLine) return;
	state.lines.push(fitToWidth(state.currentLine, width));
	state.currentLine = "";
};

const appendPipeSegment = (
	state: FooterLineState,
	segment: string,
	width: number,
	themeFn: (text: string) => string,
): void => {
	const styledSegment = themeFn(segment);
	const separator = themeFn(" | ");
	const candidate = state.currentLine
		? `${state.currentLine}${separator}${styledSegment}`
		: styledSegment;
	if (visibleWidth(candidate) > width) {
		if (state.currentLine) {
			state.lines.push(fitToWidth(state.currentLine, width));
		}
		state.currentLine = styledSegment;
	} else {
		state.currentLine = candidate;
	}
};

const appendSessionTokens = (
	state: FooterLineState,
	tokens: string[],
	width: number,
	themeFn: (text: string) => string,
): void => {
	let sessionStarted = false;
	for (const token of tokens) {
		const separatorText = state.currentLine
			? sessionStarted
				? " "
				: " | "
			: "";
		const separator = separatorText ? themeFn(separatorText) : "";
		const styledToken = themeFn(token);
		const candidate = state.currentLine
			? `${state.currentLine}${separator}${styledToken}`
			: styledToken;
		if (visibleWidth(candidate) > width) {
			if (state.currentLine) {
				state.lines.push(fitToWidth(state.currentLine, width));
			}
			state.currentLine = styledToken;
		} else {
			state.currentLine = candidate;
		}
		sessionStarted = true;
	}
};

function formatTokens(count: number): string {
	if (!Number.isFinite(count) || count <= 0) return "0";
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

const cacheCell = (value: string, width: number): string => {
	const fitted = truncateToWidth(value, width, "…");
	return fitted + " ".repeat(Math.max(0, width - visibleWidth(fitted)));
};

const formatCacheCount = (count: number): string => {
	if (count < 1000) return String(Math.max(0, Math.round(count)));
	if (count < 1_000_000) return `${(count / 1000).toFixed(2)} K`;
	return `${(count / 1_000_000).toFixed(2)} M`;
};

const CACHE_FLASH_MS = 3000;
const CACHE_FLASH_HOLD_MS = 1000;
const CACHE_FLASH_PALETTE = [46, 82, 83, 119, 120, 156, 157, 193, 194, 252];

const cacheFlashText = (
	theme: Theme,
	text: string,
	flashUntil: number,
): string => {
	const elapsed = CACHE_FLASH_MS - Math.max(0, flashUntil - Date.now());
	const progress = Math.max(
		0,
		Math.min(1, (elapsed - CACHE_FLASH_HOLD_MS) / (CACHE_FLASH_MS - CACHE_FLASH_HOLD_MS)),
	);
	if (theme.getColorMode() === "truecolor") {
		const redBlue = Math.round(204 * progress);
		const green = Math.round(255 - 51 * progress);
		return `\x1b[38;2;${redBlue};${green};${redBlue}m${text}\x1b[39m`;
	}
	const color = CACHE_FLASH_PALETTE[
		Math.min(
			CACHE_FLASH_PALETTE.length - 1,
			Math.floor(progress * CACHE_FLASH_PALETTE.length),
		)
	];
	return `\x1b[38;5;${color}m${text}\x1b[39m`;
};

const appendCacheTable = (
	state: FooterLineState,
	rows: CacheStatusRow[],
	width: number,
	theme: Theme,
): void => {
	if (rows.length === 0) return;
	flushFooterLine(state, width);

	const headers = ["PROVIDER", "MODEL", "STATUS", "TIME", "READ", "ADDED"];
	const values = rows.map((row) => {
		const expired =
			row.result !== "CHECKING" &&
			row.result !== "NO CACHE" &&
			row.durationMs !== undefined &&
			row.remainingMs <= 0;
		return [
			row.provider,
			row.model,
			expired ? "EXPIRED" : (row.result ?? "NO CACHE"),
			row.durationMs !== undefined && row.remainingMs > 0
				? formatCacheTimerValue(row.remainingMs)
				: "-",
			row.cacheRead === undefined ? "-" : formatCacheCount(row.cacheRead),
			row.cacheWrite === undefined
				? "-"
				: `+${formatCacheCount(row.cacheWrite)}`,
		];
	});
	const desired = headers.map((header, index) =>
		Math.max(
			visibleWidth(header),
			...values.map((row) => visibleWidth(row[index])),
		),
	);
	const available = Math.max(headers.length, width - (headers.length * 3 + 1));
	const columns = [...desired];
	while (columns.reduce((sum, value) => sum + value, 0) > available) {
		const index = columns.indexOf(Math.max(...columns));
		if (columns[index] <= 1) break;
		columns[index]--;
	}

	const border = (left: string, middle: string, right: string) =>
		`${left}${columns.map((column) => "─".repeat(column + 2)).join(middle)}${right}`;
	const top = `CACHE${"─".repeat(Math.max(0, columns[0] + 3 - "CACHE".length))}${columns
		.slice(1)
		.map((column) => `┬${"─".repeat(column + 2)}`)
		.join("")}┐`;
	state.lines.push(theme.fg("dim", top));

	for (const [index, row] of rows.entries()) {
		const [provider, model, status, time, read, added] = values[index];
		const flashing = (row.flashUntil ?? 0) > Date.now();
		const statusColor: ThemeColor =
			status === "EXPIRED" || status === "NO CACHE" ? "text" : "dim";
		const timeColor: ThemeColor =
			time === "-" ? "text" : getCacheTimerColor(row.remainingMs, row.durationMs);
		const paint = (text: string, color: ThemeColor) =>
			flashing
				? cacheFlashText(theme, text, row.flashUntil ?? 0)
				: theme.fg(color, text);
		state.lines.push(
			`${theme.fg("dim", "│ ")}${paint(cacheCell(provider, columns[0]), "dim")}${theme.fg("dim", " │ ")}${paint(cacheCell(model, columns[1]), "dim")}${theme.fg("dim", " │ ")}${paint(cacheCell(status, columns[2]), statusColor)}${theme.fg("dim", " │ ")}${paint(cacheCell(time, columns[3]), timeColor)}${theme.fg("dim", " │ ")}${paint(cacheCell(read, columns[4]), "dim")}${theme.fg("dim", " │ ")}${paint(cacheCell(added, columns[5]), "dim")}${theme.fg("dim", " │")}`,
		);
	}

	state.lines.push(theme.fg("dim", border("└", "┴", "┘")));
};

const formatCacheTimerValue = (milliseconds: number): string => {
	const total = Math.max(0, Math.ceil(milliseconds / 1000));
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	const seconds = total % 60;
	return [hours, minutes, seconds]
		.map((part) => String(part).padStart(2, "0"))
		.join(":");
};

function usageTokens(
	label: string,
	usage: UsageTotals,
	isLocal: boolean = false,
): string[] {
	return [
		`${label}:`,
		`↑${formatTokens(usage.input)}`,
		`↓${formatTokens(usage.output)}`,
		`CR:${formatTokens(usage.cacheRead)}`,
		...(usage.cacheWrite > 0 ? [`CW:${formatTokens(usage.cacheWrite)}`] : []),
		...(isLocal ? ["(LOCAL)"] : []),
		`$${usage.cost.toFixed(3)}`,
	];
}

function getDisplayPath(cwd: string): string {
	const home = process.env.HOME || process.env.USERPROFILE;
	if (home && cwd.startsWith(home)) {
		return `~${cwd.slice(home.length)}`;
	}
	return cwd;
}

let gitDirtyCache:
	| { cwd: string; dirty: boolean; checkedAt: number }
	| undefined;

function isGitDirty(cwd: string): boolean {
	const now = Date.now();
	if (gitDirtyCache?.cwd === cwd && now - gitDirtyCache.checkedAt < 5000) {
		return gitDirtyCache.dirty;
	}
	try {
		const dirty =
			execFileSync(
				"git",
				["status", "--porcelain", "--ignore-submodules=dirty"],
				{
					cwd,
					encoding: "utf8",
					stdio: ["ignore", "pipe", "ignore"],
				},
			).trim().length > 0;
		gitDirtyCache = { cwd, dirty, checkedAt: now };
		return dirty;
	} catch {
		gitDirtyCache = { cwd, dirty: false, checkedAt: now };
		return false;
	}
}

function getTemperature(): number | null {
	try {
		const configPath = `${process.env.HOME || process.env.USERPROFILE}/.pi/agent/temperature.json`;
		const fs = require("node:fs");
		const data = JSON.parse(fs.readFileSync(configPath, "utf-8")) as {
			temp?: number;
		};
		return data.temp ?? null;
	} catch {
		return null;
	}
}

export default function (pi: ExtensionAPI) {
	let requestRender: (() => void) | undefined;
	pi.events.on("cache-status:update", () => requestRender?.());

	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;

		ctx.ui.setFooter((tui, theme, footerData) => {
			const rerender = () => tui.requestRender();
			requestRender = rerender;
			const unsubscribe = footerData.onBranchChange(rerender);
			const timer = setInterval(rerender, 1000);

			return {
				dispose() {
					clearInterval(timer);
					unsubscribe();
					if (requestRender === rerender) requestRender = undefined;
				},
				invalidate() {},
				render(width: number): string[] {
					const sessionStartedAt =
						ctx.sessionManager.getHeader()?.timestamp ?? "";
					const branchEntries = ctx.sessionManager.getBranch();
					const totalUsage = getSessionUsage(
						ctx.sessionManager.getEntries(),
						sessionStartedAt,
					);
					const runUsage = getCurrentRunUsage(branchEntries, sessionStartedAt);

					const contextUsage = ctx.getContextUsage();
					const contextWindow =
						contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
					const currentTokens = contextUsage?.tokens ?? 0;
					const currentPercent = contextUsage?.percent ?? 0;
					const modelName = ctx.model?.id ?? "no-model";
					const cacheTimers = cacheStatus.getRows();
					const isClaudeCodeModel = ctx.model?.provider === "claude-code";
					const modelUrl = ctx.model as
						| { baseURL?: unknown; baseUrl?: unknown }
						| undefined;
					const isLocal = Boolean(
						String(modelUrl?.baseURL ?? modelUrl?.baseUrl ?? "").match(
							/localhost|127\.0\.0\.1/i,
						),
					);
					const thinkingSuffix =
						ctx.model?.reasoning && !isClaudeCodeModel
							? ` ${pi.getThinkingLevel()}`
							: "";

					const cwd = ctx.sessionManager.getCwd();
					const branch = footerData.getGitBranch();
					const gitPrompt = branch
						? `${isGitDirty(cwd) ? theme.fg("error", "*") : ""}${theme.fg("success", `[${branch}]`)}`
						: "";
					const cwdPrompt = `${gitPrompt}${theme.fg("accent", `[${getDisplayPath(cwd)}]`)}`;

					const dim = theme.fg.bind(theme, "dim");
					const lineState: FooterLineState = { lines: [], currentLine: "" };

					appendPipeSegment(lineState, `CWD: ${cwdPrompt}`, width, dim);
					appendPipeSegment(
						lineState,
						`CTX: ${formatTokens(currentTokens)}/${formatTokens(contextWindow)} (${currentPercent.toFixed(1)}%)`,
						width,
						dim,
					);
					appendSessionTokens(
						lineState,
						usageTokens("RUN", runUsage, isLocal),
						width,
						dim,
					);
					appendSessionTokens(
						lineState,
						usageTokens("TOTAL", totalUsage),
						width,
						dim,
					);
					appendPipeSegment(
						lineState,
						`TEMP: ${getTemperature() ?? "(DEFAULT)"}`,
						width,
						dim,
					);
					appendPipeSegment(
						lineState,
						`MODEL: ${modelName}${thinkingSuffix}`,
						width,
						dim,
					);
					appendCacheTable(lineState, cacheTimers, width, theme);
					flushFooterLine(lineState, width);

					return lineState.lines;
				},
			};
		});
	});
}
