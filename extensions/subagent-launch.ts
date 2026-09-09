import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerSubagentTools } from "./subagent-launch/manager.ts";

export default function subagentLaunch(pi: ExtensionAPI) {
  registerSubagentTools(pi);
}
