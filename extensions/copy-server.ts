/**
 * /copy-server extension — saves last assistant message to /tmp/000-pi/ instead of clipboard.
 *
 * ponytail: single-file extension, no deps, stdlib fs.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const OUT_DIR = "/tmp/000-pi";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("copy-server", {
    description: "Save last agent message to /tmp/000-pi/",
    handler: async (_args, ctx) => {
      if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

      const entries = ctx.sessionManager.getEntries();
      let text = "";
      for (let i = entries.length - 1; i >= 0; i--) {
        const e = entries[i];
        if (e.type !== "message") continue;
        const msg = e.message;
        if (msg.role !== "assistant") continue;
        for (const block of msg.content) {
          if (block.type === "text") text += block.text;
        }
        break;
      }

      if (!text.trim()) {
        ctx.ui.notify("No agent messages to save yet.", "warn");
        return;
      }

      // ponytail: deterministic name, overwrites — add timestamps if history matters
      const file = join(OUT_DIR, "pi-copy.txt");
      writeFileSync(file, text.trim(), "utf-8");
      ctx.ui.notify(`Saved to ${file}`, "info");
    },
  });
}
