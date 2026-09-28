import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ponytail: literal Pi shell-tool guard, not a GPU/OS sandbox; use a separate
// process/Metal isolation boundary if arbitrary same-user scripts must be denied.
const UNMANAGED_KEV = /\bkev(?:\.serve|[\\/]serve\.py)\b|:8009\b/i;

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", (event) => {
		if (!["bash", "bash_bg", "powershell"].includes(event.toolName)) return;
		const command = event.input.command;
		if (typeof command === "string" && UNMANAGED_KEV.test(command)) {
			return {
				block: true,
				reason: "Unmanaged Kev entry blocked. Use the managed :8002/v1/systemone route; do not launch kev.serve or call :8009 from Pi.",
			};
		}
	});
}
