/**
 * /local-refresh — fetch a SiftText node via MCP and send it as a user message.
 *
 * Connects to app.sifttext.com/mcp, calls ideation_get_node with a
 * hardcoded node ID, and injects the result as a user message so the LLM
 * can read and act on it immediately (no tool round-trip, no token waste).
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";

const NODE_ID = "d36f646c-f719-4383-843b-e4458e76465a";
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

  // Reuse the same auth approach as sifttext-mcp — SIFT sends a session
  // header. The MCP endpoint is authenticated via the pi session cookie /
  // the running process context. Since this runs inside the pi agent
  // harness, we'll just use a plain request — the MCP endpoint handles
  // authentication via the session context that flows through the
  // SiftText platform.
  //
  // However, looking at the existing sifttext-mcp extension, it uses
  // SIFTTEXT_API_KEY. We'll follow that pattern but also support
  // reading from an environment variable the user sets.
  const token = process.env.SIFTTEXT_API_KEY;
  if (!token) {
    throw new Error("SIFTTEXT_API_KEY environment variable is not set");
  }

  const client = new Client({ name: "local-refresh", version: "1.0.0" });

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
