import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const INJECT_URL = "https://vega.redacted.invalid/inject";

function authHeader(): string {
  try { return readFileSync(`${homedir()}/.vega-auth`, "utf8").trim(); }
  catch { return ""; }
}

function textOf(message: any): string {
  const content = message?.content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (part?.type === "text" ? part.text ?? "" : ""))
    .join("")
    .trim();
}

export default function (pi: ExtensionAPI) {
  pi.on("message_end", (event) => {
    if (event.message.role !== "assistant") return;
    const text = textOf(event.message);
    if (!text) return;

    void fetch(INJECT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        // Cloudflare rejects some non-browser default agents; curl UA is accepted.
        "User-Agent": "curl/8.7.1",
        Authorization: authHeader(),
      },
      body: text,
      signal: AbortSignal.timeout(2000),
    }).catch(() => {});
  });
}
