/**
 * /browser — load browser-harness SKILL.md and send it as a user message.
 *
 * Reads the skill file from the local browser-harness checkout,
 * uses the provided instruction (or prompts if blank),
 * then injects it as a user message so the LLM can read and act on it.
 *
 * Usage:
 *   /browser              — prompts for instruction
 *   /browser book a flight — uses instruction directly
 *
 * Skill source: ~/projects/browser-harness/SKILL.md
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";

const SKILL_PATH = join(process.env.HOME || "/Users/jack", "projects", "browser-harness", "SKILL.md");

export default function (pi: ExtensionAPI) {
  pi.registerCommand("browser", {
    description: "Load browser-harness SKILL.md, prompt for focus, send as user message",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      try {
        // Read the skill file
        let content: string;
        try {
          content = readFileSync(SKILL_PATH, "utf-8");
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          ctx.ui.notify(`Failed to read SKILL.md: ${message}`, "error");
          return;
        }

        // Use provided instruction or prompt if blank
        const focus = args?.trim()
          ? args.trim()
          : await ctx.ui.input(
              "What do you want the agent to do with browser-harness? (blank for full skill)",
              "",
            );

        const focusBlock = focus?.trim()
          ? `Instruction: ${focus.trim()}`
          : "Instruction: (full SKILL.md — agent decides how to use)";

        pi.sendUserMessage(
          `please read and perform this skill\n\n${focusBlock}\n\n${content}`,
        );
        ctx.ui.notify("browser-harness skill sent to agent", "success");
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`browser-harness extension failed: ${message}`, "error");
      }
    },
  });
}
