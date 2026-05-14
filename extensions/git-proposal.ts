/**
 * /git-proposal — read git-commit-rules.md and send it as a user message
 * so the LLM proposes commit segments using the project's conventions.
 *
 * Usage:
 *   /git-proposal              — reads the rules file and sends it
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const RULES_PATH = join(process.env.HOME || "", ".pi/agent/git-commit-rules.md");

export default function (pi: ExtensionAPI) {
  pi.registerCommand("git-proposal", {
    description: "Read git-commit-rules.md and send as user message for commit segment proposals",
    handler: async (_args: string, ctx: any) => {
      try {
        const rulesContent = readFileSync(RULES_PATH, "utf-8");
        const message = `Please propose commit segments following this template:\n\n${rulesContent}`;
        pi.sendUserMessage(message);
        ctx.ui.notify("Git rules sent to agent", "success");
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`git-proposal failed: ${message}`, "error");
      }
    },
  });
}
