import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CHANNEL_OPTION = "@pi_done_channel";

export default function (pi: ExtensionAPI) {
	pi.on("agent_settled", async (_event, ctx) => {
		const pane = process.env.TMUX_PANE;
		if (!pane || ctx.mode !== "tui") return;

		const option = await pi.exec("tmux", ["show-options", "-qv", "-t", pane, CHANNEL_OPTION]);
		const channel = option.stdout.trim();
		if (!channel) return;

		await pi.exec("tmux", ["set-option", "-qu", "-t", pane, CHANNEL_OPTION]);
		await pi.exec("tmux", ["wait-for", "-S", channel]);
	});
}
