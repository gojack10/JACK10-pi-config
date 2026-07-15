import { execFileSync } from "node:child_process";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

const fitToWidth = (s: string, width: number): string => {
	if (width <= 0) return "";
	if (visibleWidth(s) <= width) return s;
	return truncateToWidth(s, width, "…");
};

const wrapAndDim = (text: string, width: number, separator: string, themeFn: (t: string) => string): string[] => {
	const sections = text.split(separator);
	const lines: string[] = [];
	let currentLine = "";
	for (const section of sections) {
		const candidate = currentLine ? currentLine + separator + section : section;
		if (visibleWidth(candidate) > width) {
			if (currentLine) lines.push(themeFn(fitToWidth(currentLine, width)));
			currentLine = section;
		} else {
			currentLine = candidate;
		}
	}
	if (currentLine) lines.push(themeFn(fitToWidth(currentLine, width)));
	return lines.length ? lines : [themeFn(fitToWidth(text, width))];
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

const appendPipeSegment = (state: FooterLineState, segment: string, width: number): void => {
	const candidate = state.currentLine ? `${state.currentLine} | ${segment}` : segment;
	if (visibleWidth(candidate) > width) {
		if (state.currentLine) {
			state.lines.push(fitToWidth(state.currentLine, width));
		}
		state.currentLine = segment;
	} else {
		state.currentLine = candidate;
	}
};

const appendSessionTokens = (state: FooterLineState, tokens: string[], width: number): void => {
	let sessionStarted = false;
	for (const token of tokens) {
		const separator = state.currentLine ? (sessionStarted ? " " : " | ") : "";
		const candidate = state.currentLine ? `${state.currentLine}${separator}${token}` : token;
		if (visibleWidth(candidate) > width) {
			if (state.currentLine) {
				state.lines.push(fitToWidth(state.currentLine, width));
			}
			state.currentLine = token;
		} else {
			state.currentLine = candidate;
		}
		sessionStarted = true;
	}
};

function sanitizeStatusText(text: string): string {
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

function formatTokens(count: number): string {
	if (!Number.isFinite(count) || count <= 0) return "0";
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
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
		return execFileSync("git", ["status", "--porcelain", "--ignore-submodules=dirty"], {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim().length > 0;
	} catch {
		return false;
	}
}

function getTemperature(): number | null {
	try {
		const configPath = `${process.env.HOME || process.env.USERPROFILE}/.pi/agent/temperature.json`;
		const fs = require("node:fs");
		const data = JSON.parse(fs.readFileSync(configPath, "utf-8")) as { temp?: number };
		return data.temp ?? null;
	} catch {
		return null;
	}
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;

		ctx.ui.setFooter((tui, theme, footerData) => {
			const unsubscribe = footerData.onBranchChange(() => tui.requestRender());

			return {
				dispose: unsubscribe,
				invalidate() {},
				render(width: number): string[] {
					let totalInput = 0;
					let totalOutput = 0;
					let totalCacheRead = 0;
					let totalCacheWrite = 0;
					let totalCost = 0;

					for (const entry of ctx.sessionManager.getEntries()) {
						if (entry.type === "message" && entry.message.role === "assistant") {
							const message = entry.message as AssistantMessage;
							totalInput += message.usage.input;
							totalOutput += message.usage.output;
							totalCacheRead += message.usage.cacheRead;
							totalCacheWrite += message.usage.cacheWrite;
							totalCost += message.usage.cost.total;
						}
					}

					const contextUsage = ctx.getContextUsage();
					const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
					const currentTokens = contextUsage?.tokens ?? 0;
					const currentPercent = contextUsage?.percent ?? 0;
					const usingSubscription = ctx.model ? ctx.modelRegistry.isUsingOAuth(ctx.model) : false;
					const modelName = ctx.model?.id ?? "no-model";
					const isClaudeCodeModel = ctx.model?.provider === "claude-code";
					const isLocal = Boolean(ctx.model && String((ctx.model as any).baseURL ?? (ctx.model as any).baseUrl ?? "").match(/localhost|127\.0\.0\.1/i));
					const thinkingSuffix =
						ctx.model?.reasoning && !isClaudeCodeModel ? ` ${pi.getThinkingLevel()}` : "";

					const cwd = ctx.sessionManager.getCwd();
					const branch = footerData.getGitBranch();
					const gitPrompt = branch
						? `${isGitDirty(cwd) ? theme.fg("error", "*") : ""}${theme.fg("success", `[${branch}]`)}`
						: "";
					const cwdPrompt = `${gitPrompt}${theme.fg("accent", `[${getDisplayPath(cwd)}]`)}`;

					const showCacheWrite = !isLocal && totalCacheWrite > 0;
					const dim = theme.fg.bind(theme, "dim");
					const lineState: FooterLineState = { lines: [], currentLine: "" };

					appendPipeSegment(lineState, `CWD: ${cwdPrompt}`, width);
					appendPipeSegment(
						lineState,
						`CURRENT: ${formatTokens(currentTokens)}/${formatTokens(contextWindow)} (${currentPercent.toFixed(1)}%)`,
						width,
					);
					appendSessionTokens(
						lineState,
						[
							`SESSION:`,
							`↑${formatTokens(totalInput)}`,
							`↓${formatTokens(totalOutput)}`,
							`CR:${formatTokens(totalCacheRead)}`,
							...(showCacheWrite ? [`CW:${formatTokens(totalCacheWrite)}`] : []),
							isLocal ? "(LOCAL)" : `$${totalCost.toFixed(3)}`,
							...(usingSubscription ? ["(SUB)"] : []),
						],
						width,
					);
					appendPipeSegment(lineState, `TEMP: ${getTemperature() ?? "(DEFAULT)"}`, width);
					appendPipeSegment(lineState, `MODEL: ${modelName}${thinkingSuffix}`, width);
					flushFooterLine(lineState, width);

					const lines: string[] = lineState.lines.map(dim);

					const extensionStatuses = footerData.getExtensionStatuses();
					if (extensionStatuses.size > 0) {
						const statusLine = Array.from(extensionStatuses.entries())
							.sort(([a], [b]) => a.localeCompare(b))
							.map(([, text]) => sanitizeStatusText(text))
							.join(" ");
						lines.push(...wrapAndDim(statusLine, width, " | ", dim));
					}

					return lines;
				},
			};
		});
	});
}
