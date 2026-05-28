/**
 * /local-refresh — fetch a SiftText node via MCP and send it as a user message.
 *
 * Connects to app.sifttext.com/mcp, calls ideation_get_node with a
 * hardcoded node ID, and injects the result as a user message so the LLM
 * can read and act on it immediately (no tool round-trip, no token waste).
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { callMcpTool, mcpTextContent } from "../_shared/mcp-http";

const NODE_ID = "d36f646c-f719-4383-843b-e4458e76465a";
const MCP_URL = "https://app.sifttext.com/mcp";

async function fetchNodeContent(): Promise<string> {
  const token = process.env.SIFTTEXT_API_KEY;
  if (!token) {
    throw new Error("SIFTTEXT_API_KEY environment variable is not set");
  }

  const result = await callMcpTool(
    MCP_URL,
    token,
    "local-refresh",
    "ideation_get_node",
    { node_id: NODE_ID },
  );

  const text = mcpTextContent(result);
  if (result.isError) {
    throw new Error(`MCP tool error: ${text}`);
  }

  return text;
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("local-refresh", {
    description: "Fetch node d36f646c… via MCP and send as user message",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      try {
        const content = await fetchNodeContent();

        pi.sendUserMessage(
          `please read and perform this skill\n\n--- Node d36f646c-f719-4383-843b-e4458e76465a ---\n\n${content}`
        );
        ctx.ui.notify("Node content sent to agent", "success");
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`local-refresh failed: ${message}`, "error");
      }
    },
  });
}
