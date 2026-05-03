/**
 * /sifttext-commit — fetch a SiftText node via MCP and send it as a user message.
 *
 * Connects to app.sifttext.com/mcp, calls ideation_get_node with a
 * hardcoded node ID, and injects the result as a user message so the LLM
 * can read and act on it immediately (no tool round-trip, no token waste).
 *
 * Usage:
 *   /sifttext-commit              — prompts for focus
 *   /sifttext-commit refactor auth — uses focus directly
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";

const NODE_ID = "c72d552d-3499-445b-a8d5-05d0ff7824f2";
const MCP_URL = "https://app.sifttext.com/mcp";

async function importMcpSdk() {
  const [{ Client }, { StreamableHTTPClientTransport }] = await Promise.all([
    import("@modelcontextprotocol/sdk/client/index.js"),
    import("@modelcontextprotocol/sdk/client/streamableHttp.js"),
  ]);
  return { Client, StreamableHTTPClientTransport };
}

async function fetchNodeContent(): Promise<string> {
  const { Client, StreamableHTTPClientTransport } = await importMcpSdk();

  const token = process.env.SIFTTEXT_API_KEY;
  if (!token) {
    throw new Error("SIFTTEXT_API_KEY environment variable is not set");
  }

  const client = new Client({ name: "sifttext-commit", version: "1.0.0" });

  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });

  await client.connect(transport);

  try {
    const result = await client.callTool({
      name: "ideation_get_node",
      arguments: { node_id: NODE_ID },
    });

    const text = result.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n");

    if (result.isError) {
      throw new Error(`MCP tool error: ${text}`);
    }

    return text;
  } finally {
    await client.close();
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("sifttext-commit", {
    description: "Fetch node c72d552d… via MCP, prompt for focus, send as user message",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      try {
        // Use provided focus or prompt if blank
        const focus = args?.trim()
          ? args.trim()
          : await ctx.ui.input(
              "What is the focus of this commit? (blank for model to decide)",
              "",
            );

        const content = await fetchNodeContent();

        const focusBlock = focus?.trim()
          ? `Focus: ${focus.trim()}`
          : "Focus: (model decides based on full context)";

        pi.sendUserMessage(
          `please read and perform this skill\n\n${focusBlock}\n\n${content}`
        );
        ctx.ui.notify("Node content sent to agent", "success");
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`sifttext-commit failed: ${message}`, "error");
      }
    },
  });
}
