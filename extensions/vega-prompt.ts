/**
 * VEGA voice prompt poller.
 *
 * /vega toggles polling of the TTS daemon's prompt inbox
 * (https://vega.redacted.invalid/prompt/next). Text dictated on the /player page
 * is delivered into THIS session as a user message.
 *
 * OFF by default so multiple pi sessions don't steal each other's prompts —
 * run /vega in the one session you want to drive from your phone.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PROMPT_URL = "https://vega.redacted.invalid/prompt/next";
const POLL_MS = 2000;

function authHeader(): string {
  try { return readFileSync(`${homedir()}/.vega-auth`, "utf8").trim(); }
  catch { return ""; }
}

export default function (pi: ExtensionAPI) {
  let timer: ReturnType<typeof setInterval> | null = null;

  async function poll() {
    try {
      const r = await fetch(PROMPT_URL, {
        headers: {
          "User-Agent": "curl/8.7.1",
          Authorization: authHeader(),
        },
        signal: AbortSignal.timeout(2000),
      });
      if (!r.ok) return;
      const text = ((await r.json())?.text ?? "").trim();
      if (!text) return;
      try {
        pi.sendUserMessage(text);
      } catch {
        // Agent is streaming - queue it instead of dropping it.
        pi.sendUserMessage(text, { deliverAs: "steer" });
      }
    } catch {
      // Daemon down / network blip: silently retry on next tick.
    }
  }

  pi.registerCommand("vega", {
    description: "Toggle VEGA voice prompt polling (drive this session from /player)",
    handler: async (_args, ctx) => {
      if (timer) {
        clearInterval(timer);
        timer = null;
        ctx.ui.notify("VEGA voice polling OFF", "info");
      } else {
        timer = setInterval(poll, POLL_MS);
        ctx.ui.notify("VEGA voice polling ON - dictate at vega.redacted.invalid/player", "info");
      }
    },
  });
}
