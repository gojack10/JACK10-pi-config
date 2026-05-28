type JsonRpcResponse = {
	id?: number;
	result?: unknown;
	error?: { message?: string; code?: number; data?: unknown };
};

export type McpToolResult = {
	content?: Array<{ type: string; text?: string }>;
	isError?: boolean;
};

export type McpToolSchema = {
	name: string;
	description?: string;
	inputSchema?: Record<string, unknown>;
};

let nextRequestId = 1;

export async function mcpRequest<T = unknown>(
	url: string,
	token: string,
	method: string,
	params: Record<string, unknown>,
	options: { signal?: AbortSignal } = {},
): Promise<T> {
	const response = await fetch(url, {
		method: "POST",
		signal: options.signal,
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: nextRequestId++,
			method,
			params,
		}),
	});

	const body = await response.text();
	if (!response.ok) {
		throw new Error(`MCP HTTP ${response.status}: ${body}`);
	}

	const message = JSON.parse(body) as JsonRpcResponse;
	if (message.error) {
		throw new Error(message.error.message ?? JSON.stringify(message.error));
	}
	return message.result as T;
}

export async function initializeMcp(
	url: string,
	token: string,
	clientName: string,
	options: { signal?: AbortSignal } = {},
): Promise<void> {
	await mcpRequest(url, token, "initialize", {
		protocolVersion: "2025-03-26",
		capabilities: {},
		clientInfo: { name: clientName, version: "1.0.0" },
	}, options);
}

export async function listMcpTools(
	url: string,
	token: string,
	clientName: string,
	options: { signal?: AbortSignal } = {},
): Promise<McpToolSchema[]> {
	await initializeMcp(url, token, clientName, options);
	const result = await mcpRequest<{ tools?: McpToolSchema[] }>(
		url,
		token,
		"tools/list",
		{},
		options,
	);
	return result.tools ?? [];
}

export async function callMcpTool(
	url: string,
	token: string,
	clientName: string,
	name: string,
	args: Record<string, unknown>,
	options: { signal?: AbortSignal } = {},
): Promise<McpToolResult> {
	await initializeMcp(url, token, clientName, options);
	return mcpRequest<McpToolResult>(
		url,
		token,
		"tools/call",
		{ name, arguments: args },
		options,
	);
}

export function mcpTextContent(result: McpToolResult): string {
	return (result.content ?? [])
		.filter((c): c is { type: "text"; text: string } => c.type === "text" && typeof c.text === "string")
		.map((c) => c.text)
		.join("\n");
}
