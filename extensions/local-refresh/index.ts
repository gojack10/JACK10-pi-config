/** /local-refresh — read the local model-refresh procedure; no hosted knowledge connection. */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const NODE_PATH = join(homedir(), "sifttext/nodes/f0000000-0000-4000-8000-5af91e69ec79/node.md");

export default function (pi: ExtensionAPI) {
  pi.registerCommand("local-refresh", {
    description: "Read the local model-refresh procedure and send as user message",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      try {
        const content = await readFile(NODE_PATH, "utf8");

        pi.sendUserMessage(
          `Please follow this local skill from ${NODE_PATH}. Read /Users/USER/sifttext/nodes/f0000000-0000-4000-8000-c25fbb33a111/node.md and its applicable current service contracts first; preserve provider scope, managed admission and existing launch authority. Use uv for Python examples. This command grants no model request, GPU work or configuration-change permission beyond the user's actual request.\n\n${content}`
        );
        ctx.ui.notify("Node content sent to agent", "success");
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`local-refresh failed: ${message}`, "error");
      }
    },
  });
}
