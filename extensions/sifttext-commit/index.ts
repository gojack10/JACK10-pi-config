/** /sifttext-commit — load the canonical local procedure, then request an in-chat commit. */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const NODE_PATH = join(homedir(), "sifttext/nodes/c72d552d-3499-445b-a8d5-05d0ff7824f2/node.md");

export default function (pi: ExtensionAPI) {
  pi.registerCommand("sifttext-commit", {
    description: "Read the local SiftText Commit procedure, prompt for focus, send as user message",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      try {
        // Use provided focus or prompt if blank
        const focus = args?.trim()
          ? args.trim()
          : await ctx.ui.input(
              "What is the focus of this commit? (blank for model to decide)",
              "",
            );

        const content = await readFile(NODE_PATH, "utf8");

        const focusBlock = focus?.trim()
          ? `Focus: ${focus.trim()}`
          : "Focus: (model decides based on full context)";

        pi.sendUserMessage(
          `Run the regular in-chat SiftText Commit for this current conversation, using the current chat context.\n\n${focusBlock}\n\nDo not invoke Commit RLM. Do not snapshot or inspect session JSONL. Do not launch a retrospective synthesis agent. Still satisfy the regular SiftText Commit pre-write reads and human approval gates, and persist only after explicit human approval.\n\nSource: ${NODE_PATH}. Use local file reads for linked procedures and native private-worktree publication; no hosted tool or server gate. Read the installed local Worktree Publication procedure at /Users/jack/.local/share/sifttext/current/nodes/fb1e0c9f-8c04-4baf-91e6-4688856a14af/node.md before persistence. Existing semantic pre-reads, explicit approval and narrower grants still apply.\n\n${content}`,
        );
        ctx.ui.notify("Node content sent to agent", "success");
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`sifttext-commit failed: ${message}`, "error");
      }
    },
  });
}
