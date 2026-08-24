/** /vega exclusively connects this Pi session to VEGA voice. */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const BASE_URL = "https://vega.redacted.invalid";
const POLL_MS = 2000;

function authHeader(): string {
  try { return readFileSync(`${homedir()}/.vega-auth`, "utf8").trim(); }
  catch { return ""; }
}

function textOf(message: any): string {
  const content = message?.content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content.map((part) => part?.type === "text" ? part.text ?? "" : "").join("").trim();
}

export default function (pi: ExtensionAPI) {
  let token = "";
  let timer: ReturnType<typeof setInterval> | null = null;

  function headers(extra: Record<string, string> = {}) {
    return {
      "User-Agent": "curl/8.7.1",
      Authorization: authHeader(),
      ...(token ? { "X-Vega-Session": token } : {}),
      ...extra,
    };
  }

  async function poll() {
    if (!token) return;
    try {
      const r = await fetch(`${BASE_URL}/prompt/next`, {
        headers: headers(),
        signal: AbortSignal.timeout(2000),
      });
      if (!r.ok) return;
      const text = ((await r.json())?.text ?? "").trim();
      if (!text) return;
      try { pi.sendUserMessage(text); }
      catch { pi.sendUserMessage(text, { deliverAs: "steer" }); }
    } catch { /* retry next tick */ }
  }

  pi.on("message_end", (event) => {
    if (!token || event.message.role !== "assistant") return;
    const text = textOf(event.message);
    if (!text) return;
    void fetch(`${BASE_URL}/inject`, {
      method: "POST",
      headers: headers({ "Content-Type": "text/plain; charset=utf-8" }),
      body: text,
      signal: AbortSignal.timeout(2000),
    }).catch(() => {});
  });

  pi.registerCommand("vega", {
    description: "Toggle exclusive VEGA voice control for this session",
    handler: async (_args, ctx) => {
      if (token) {
        clearInterval(timer!);
        timer = null;
        const oldToken = token;
        token = "";
        void fetch(`${BASE_URL}/session/release`, {
          method: "POST",
          headers: { ...headers(), "X-Vega-Session": oldToken },
          signal: AbortSignal.timeout(2000),
        }).catch(() => {});
        ctx.ui.notify("VEGA voice OFF", "info");
        return;
      }
      try {
        const r = await fetch(`${BASE_URL}/session/claim`, {
          method: "POST",
          headers: headers(),
          signal: AbortSignal.timeout(3000),
        });
        if (!r.ok) throw new Error(`server returned ${r.status}`);
        token = String((await r.json()).token ?? "");
        if (!token) throw new Error("server returned no token");
        timer = setInterval(poll, POLL_MS);
        ctx.ui.notify("VEGA voice ON — this is the only active session", "info");
      } catch (error) {
        token = "";
        ctx.ui.notify(`VEGA unavailable: ${error}`, "error");
      }
    },
  });

  pi.on("session_shutdown", () => {
    if (timer) clearInterval(timer);
    timer = null;
  });
}
