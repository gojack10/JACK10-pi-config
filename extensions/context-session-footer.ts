import { execFileSync } from "node:child_process";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import {
	type CacheLifetime,
	getCacheFooterStatus,
	getCurrentRunUsage,
	getLastModelRequestAt,
	getLatestReportedCacheLifetime,
	getModelCacheLifetime,
	getRequestCacheLifetime,
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

function isGitDirty(cwd: string): boolean {
	try {
		return (
			execFileSync(
				"git",
				["status", "--porcelain", "--ignore-submodules=dirty"],
				{
					cwd,
					encoding: "utf8",
					stdio: ["ignore", "pipe", "ignore"],
				},
			).trim().length > 0
		);
	} catch {
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
	const observedLifetimes = new Map<string, CacheLifetime>();
	let requestRender: (() => void) | undefined;
	const modelKey = (
		provider: string | undefined,
		model: string | undefined,
	): string => `${provider}/${model}`;

	pi.on("before_provider_request", (event, ctx) => {
		if (!ctx.model) return;
		const fallback = getModelCacheLifetime(
			ctx.model,
			process.env.PI_CACHE_RETENTION === "long",
		);
		observedLifetimes.set(
			modelKey(ctx.model.provider, ctx.model.id),
			getRequestCacheLifetime(event.payload, fallback),
		);
		requestRender?.();
	});

	pi.on("model_select", () => requestRender?.());

	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;

		ctx.ui.setFooter((tui, theme, footerData) => {
			const rerender = () => tui.requestRender();
			requestRender = rerender;
			const unsubscribe = footerData.onBranchChange(rerender);
			const timer = setInterval(rerender, 15_000);

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
					const providerName = ctx.model?.provider ?? "no-provider";
					const fallbackLifetime =
						observedLifetimes.get(modelKey(providerName, modelName)) ??
						getModelCacheLifetime(
							ctx.model,
							process.env.PI_CACHE_RETENTION === "long",
						);
					const lifetime = getLatestReportedCacheLifetime(
						branchEntries,
						providerName,
						modelName,
						fallbackLifetime,
					);
					const cacheStatus = getCacheFooterStatus(
						lifetime,
						getLastModelRequestAt(
							branchEntries,
							providerName,
							modelName,
							sessionStartedAt,
						),
					);
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
					appendPipeSegment(lineState, cacheStatus, width, dim);
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
					flushFooterLine(lineState, width);

					return lineState.lines;
				},
			};
		});
	});
}
