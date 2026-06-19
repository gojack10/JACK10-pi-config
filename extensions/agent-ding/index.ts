import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Resolve the sound file next to this extension
const soundPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "ding.mp3",
);

let enabled = false;

// ponytail: global bool, single flag if we ever need more state
// ponytail: afplay is macOS-only, add ffplay/paplay fallback if cross-platform matters

function play() {
  // fire-and-forget, don't await
  const proc = spawn("afplay", [soundPath], { stdio: "ignore" });
  proc.unref();
}

export default function (pi: ExtensionAPI) {
  // Restore state from session
  pi.on("session_start", (_event, ctx) => {
    enabled = false;
    for (const entry of ctx.sessionManager.getEntries()) {
      if (
        entry.type === "custom" &&
        entry.customType === "agent-ding-state"
      ) {
        enabled = entry.data?.enabled === true;
      }
    }
  });

  // Play sound when agent finishes, if enabled
  pi.on("agent_end", () => {
    if (enabled) play();
  });

  // Toggle command
  pi.registerCommand("ping", {
    description: "Toggle notification sound when agent finishes",
    handler: async (_args, ctx) => {
      enabled = !enabled;
      pi.appendEntry("agent-ding-state", { enabled });
      const status = enabled ? "on  🔔" : "off 🔕";
      ctx.ui.notify(`Ping ${status}`, "info");
      if (enabled) play(); // preview the sound
    },
  });
}
