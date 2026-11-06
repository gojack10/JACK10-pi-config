/** Privileged bridge: the renderer receives telemetry, never the proxy key. */
import { ipcMain } from "electron";
import { readFile } from "node:fs/promises";

// Supplied by the local builder from ignored host configuration. Only the
// file's location is embedded in the local app; never its credential contents.
declare const LOCAL_PROGRESS_PROXY_KEY_FILE: string;

ipcMain.handle("local-llm:progress", async (event, threadId: unknown) => {
	if (
		event.senderFrame !== event.sender.mainFrame ||
		!event.senderFrame?.url.startsWith("app://-/") ||
		typeof threadId !== "string" ||
		!/^[a-zA-Z0-9_-]{1,128}$/.test(threadId)
	) {
		throw new Error(
			"Local progress requires a desktop main frame and thread ID",
		);
	}
	try {
		const key = (
			await readFile(LOCAL_PROGRESS_PROXY_KEY_FILE, "utf8")
		).trim();
		const response = await fetch(
			"http://127.0.0.1:8002/v1/local-progress?thread_id=" +
				encodeURIComponent(threadId),
			{
				headers: { Authorization: "Bearer " + key },
				signal: AbortSignal.timeout(2500),
			},
		);
		if (!response.ok) throw new Error("Progress unavailable");
		return await response.json();
	} catch {
		return { version: 1, thread_id: threadId, phase: "unavailable" };
	}
});
