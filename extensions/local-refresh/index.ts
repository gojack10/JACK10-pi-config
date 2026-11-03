/** /local-refresh — read the local model-refresh procedure; no hosted knowledge connection. */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { knowledgeGuidePath } from "../_shared/knowledge.mjs";

const NODE_PATH = knowledgeGuidePath("local-refresh");

export default function (pi: ExtensionAPI) {
  pi.registerCommand("local-refresh", {
    description: "Read the local model-refresh procedure and send as user message",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      try {
        const content = await readFile(NODE_PATH, "utf8");

        pi.sendUserMessage(
          `Please follow this local skill from ${NODE_PATH}. Read ${knowledgeGuidePath("local-ai")} and its applicable current service contracts first; preserve provider scope, managed admission and existing launch authority. Use uv for Python examples. This command grants no model request, GPU work or configuration-change permission beyond the user's actual request.\n\n${content}`
        );
        ctx.ui.notify("Node content sent to agent", "success");
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`local-refresh failed: ${message}`, "error");
      }
    },
  });
}
