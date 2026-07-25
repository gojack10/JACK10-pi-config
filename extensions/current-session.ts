import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "get_current_session",
		label: "Current Session",
		description:
			"Return the current Pi session ID and exact JSONL file path. Use when a skill or agent needs to inspect its own transcript or locate its session file without filesystem guessing.",
		promptSnippet:
			"Get the current Pi session ID, exact JSONL path, cwd, and persistence state",
		parameters: Type.Object({}),

		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const sessionFile = ctx.sessionManager.getSessionFile();
			const result = {
				sessionId: ctx.sessionManager.getSessionId(),
				sessionFile: sessionFile ?? null,
				cwd: ctx.sessionManager.getCwd(),
				persisted: Boolean(sessionFile),
			};

			return {
				content: [{ type: "text", text: JSON.stringify(result) }],
				details: result,
			};
		},
	});
}
