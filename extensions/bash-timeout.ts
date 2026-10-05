import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createBashToolDefinition } from "@mariozechner/pi-coding-agent";
import { enforceForegroundTimeout } from "./bash-timeout/policy.ts";

export default function (pi: ExtensionAPI) {
	pi.registerTool(enforceForegroundTimeout(createBashToolDefinition(process.cwd())));
}
