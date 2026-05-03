import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { truncateToWidth } from "@mariozechner/pi-tui";

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
					let totalCost = 0;

					for (const entry of ctx.sessionManager.getEntries()) {
						if (entry.type === "message" && entry.message.role === "assistant") {
							const message = entry.message as AssistantMessage;
							totalInput += message.usage.input;
							totalOutput += message.usage.output;
							totalCacheRead += message.usage.cacheRead;
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
					const thinkingSuffix =
						ctx.model?.reasoning && !isClaudeCodeModel ? ` ${pi.getThinkingLevel()}` : "";

					let pwd = getDisplayPath(ctx.sessionManager.getCwd());
					const branch = footerData.getGitBranch();
					if (branch) {
						pwd = `${pwd} (${branch})`;
					}

					const sessionName = ctx.sessionManager.getSessionName();
					if (sessionName) {
						pwd = `${pwd} • ${sessionName}`;
					}

					const pwdLine = truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "..."));
					const statsLine =
						`CURRENT: ${formatTokens(currentTokens)}/${formatTokens(contextWindow)} (${currentPercent.toFixed(1)}%)` +
						` | SESSION: ↑${formatTokens(totalInput)} ↓${formatTokens(totalOutput)} CR:${formatTokens(totalCacheRead)}` +
						` $${totalCost.toFixed(3)}${usingSubscription ? " (SUB)" : ""}` +
						` | MODEL: ${modelName}${thinkingSuffix}`;

					const lines = [pwdLine, truncateToWidth(theme.fg("dim", statsLine), width, theme.fg("dim", "..."))];

					const extensionStatuses = footerData.getExtensionStatuses();
					if (extensionStatuses.size > 0) {
						const statusLine = Array.from(extensionStatuses.entries())
							.sort(([a], [b]) => a.localeCompare(b))
							.map(([, text]) => sanitizeStatusText(text))
							.join(" ");
						lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "...")));
					}

					return lines;
				},
			};
		});
	});
}
