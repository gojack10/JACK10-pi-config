/**
 * Debate Extension — Two-LLM debate, you are the moderator.
 *
 * Usage:
 *   /debate "Is Rust better than Python for CLI apps?"
 *   /debate-conclude   — end the debate (also works mid-turn)
 *   Esc                 — abort current turn, debate pauses
 *
 * Flow:
 *   A (FOR) speaks  ->  B (AGAINST) speaks  ->  [picker appears]
 *
 *   Picker options after every completed round:
 *     - Continue           -> next round immediately
 *     - Continue + steer   -> add moderator guidance, then next round
 *     - Decide winner      -> pick FOR / AGAINST / Neither / Tie
 *                             (optional reason), verdict injected, next round
 *     - End debate         -> final summary, debate ends
 *
 *   Debaters alternate forever.  You end it when you're done.
 *
 * Design:
 *   - System prompt is CONSTANT (never changes) -> max API cache hits.
 *   - Per-turn role goes in the user message, not the system prompt.
 *   - Todo-* tools gated during debate, restored on end.
 *   - Verdicts & reasons are injected into chat history.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { debateEvents } from "./_debate-shared/debate-events";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Side = "FOR" | "AGAINST";
type DebaterId = "A" | "B";
type VerdictWinner = "FOR" | "AGAINST" | "NEITHER" | "TIE";

interface DebateTurn {
  debater: DebaterId;
  side: Side;
  round: number;
  content: string;
}

interface DebateVerdict {
  round: number;
  winner: VerdictWinner;
  reason?: string;
}

interface DebateState {
  topic: string;
  turnIndex: number;                    // 0-based, total turns taken
  debaterOrder: [DebaterId, DebaterId]; // [firstSpeaker, secondSpeaker]
  transcript: DebateTurn[];
  verdicts: DebateVerdict[];
}

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let debate: DebateState | null = null;
let savedTools: string[] | null = null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const coinFlip = (): boolean => Math.random() < 0.5;

function buildOrder(): [DebaterId, DebaterId] {
  return coinFlip() ? ["A", "B"] : ["B", "A"];
}

const SIDE_OF: Record<DebaterId, Side> = { A: "FOR", B: "AGAINST" };

function currentDebater(s: DebateState): DebaterId {
  return s.debaterOrder[s.turnIndex % 2];
}

function currentSide(s: DebateState): Side {
  return SIDE_OF[currentDebater(s)];
}

function roundNum(s: DebateState): number {
  return Math.floor(s.turnIndex / 2) + 1;
}

/** True when both A and B have spoken in the current round pair. */
function roundJustCompleted(s: DebateState): boolean {
  return s.turnIndex > 0 && s.turnIndex % 2 === 0;
}

function turnLabel(s: DebateState): string {
  const r = roundNum(s);
  if (r === 1 && s.turnIndex < 2) return "Opening";
  return `Round ${r}`;
}

function extractAssistantContent(messages: any[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant") {
      const c = msg.content;
      if (typeof c === "string") return c;
      if (Array.isArray(c)) {
        return c
          .filter((b: any) => b.type === "text")
          .map((b: any) => b.text)
          .join("\n");
      }
      return String(c ?? "");
    }
  }
  return "[No argument recorded]";
}

// ---------------------------------------------------------------------------
// System prompt — constant, never modified per-turn (cache-friendly)
// ---------------------------------------------------------------------------

const DEBATE_SYSTEM = [
  ``,
  `==========  DEBATE MODE  ==========`,
  ``,
  `You are participating in an ongoing 1v1 debate.  Two debaters alternate:`,
  `  * Debater A  argues FOR  the proposition.`,
  `  * Debater B  argues AGAINST the proposition.`,
  ``,
  `Each user message tells you which debater you are.`,
  ``,
  `RULES:`,
  `- Stay in character as the debater indicated -- do NOT acknowledge you are an AI.`,
  `- Directly address the other debater's points.`,
  `- Be concise but persuasive (2-4 paragraphs).`,
  `- Use logic, evidence, and clear reasoning.`,
  `- The moderator may inject feedback between rounds -- incorporate it naturally.`,
  `- After each round the moderator may declare a verdict (FOR won / AGAINST won /`,
  `  Neither / Tie) with an optional reason.  The debate continues regardless.`,
  `  Use the feedback to sharpen your arguments.`,
  ``,
].join("\n");

// ---------------------------------------------------------------------------
// Tool gating
// ---------------------------------------------------------------------------

function gateDebateTools(pi: ExtensionAPI) {
  if (savedTools !== null) return;
  savedTools = pi.getActiveTools().map((t) => t.name);
  const filtered = pi
    .getActiveTools()
    .filter((t) => !t.name?.startsWith("todo"))
    .map((t) => t.name);
  pi.setActiveTools(filtered);
}

function restoreTools(pi: ExtensionAPI) {
  if (savedTools === null) return;
  pi.setActiveTools(savedTools);
  savedTools = null;
}

// ---------------------------------------------------------------------------
// Debate lifecycle
// ---------------------------------------------------------------------------

function endDebate(pi: ExtensionAPI) {
  debateEvents.active = false;
  debate = null;
  restoreTools(pi);
}

/** Build the user message that triggers the next debater's turn. */
function buildTurnPrompt(s: DebateState, steering?: string): string {
  const d = currentDebater(s);
  const side = currentSide(s);
  const rn = roundNum(s);
  const label = turnLabel(s);
  const steer = steering ? `[Moderator: ${steering}]\n` : "";
  return (
    `${steer}Debater ${d} (${side}) -- ${label}:\n` +
    `Argue ${side} the proposition: ${s.topic}`
  );
}

function sendNextTurn(pi: any, steering?: string) {
  if (!debate) return;
  const prompt = buildTurnPrompt(debate, steering);
  pi.sendUserMessage(prompt);
}

// ---------------------------------------------------------------------------
// Safe string matching (guards against undefined / non-string ctx.ui results)
// ---------------------------------------------------------------------------

function safeStartsWith(value: unknown, prefix: string): boolean {
  return typeof value === "string" && value.startsWith(prefix);
}

function safeIncludes(value: unknown, needle: string): boolean {
  return typeof value === "string" && value.includes(needle);
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  // -- /debate -----------------------------------------------------------

  pi.registerCommand("debate", {
    description: "Start a two-LLM debate. Esc to abort, /debate-conclude to end.",
    handler: async (args, ctx) => {
      if (!args || args.trim().length === 0) {
        ctx.ui.notify(
          'Usage: /debate <topic>\n' +
            'Example: /debate "Is Rust better than Python for CLI apps?"',
          "error",
        );
        return;
      }

      if (debate) {
        const replace = await ctx.ui.confirm(
          "Debate in progress",
          "A debate is already running. Stop it and start a new one?",
        );
        if (!replace) return;
        endDebate(pi);
      }

      // Strip surrounding quotes the user may have typed.
      let topic = args.trim();
      if (
        (topic.startsWith('"') && topic.endsWith('"')) ||
        (topic.startsWith("'") && topic.endsWith("'"))
      ) {
        topic = topic.slice(1, -1).trim();
      }
      if (!topic) {
        ctx.ui.notify("Topic is empty after stripping quotes.", "error");
        return;
      }
      const order = buildOrder();

      debateEvents.active = true;
      debate = {
        topic,
        turnIndex: 0,
        debaterOrder: order,
        transcript: [],
        verdicts: [],
      };

      gateDebateTools(pi);

      const first = order[0];
      const side: Side = first === "A" ? "FOR" : "AGAINST";

      ctx.ui.notify(
        `DEBATE  |  "${topic}"\n` +
          `Debater A -> FOR   |   Debater B -> AGAINST\n` +
          `Coin flip: ${first} (${side}) speaks first.\n` +
          `Runs until you /debate-conclude.  Esc aborts current turn.`,
        "info",
      );

      sendNextTurn(pi);
    },
  });

  // -- /debate-conclude --------------------------------------------------

  pi.registerCommand("debate-conclude", {
    description: "End the current debate and show a final summary",
    handler: async (_args, ctx) => {
      if (!debate) {
        ctx.ui.notify("No debate in progress.", "info");
        return;
      }
      await concludeDebate(pi, ctx);
    },
  });

  // -- System prompt (constant -- never modified per-turn) ---------------

  pi.on("before_agent_start", async (event) => {
    if (!debate) return;
    return { systemPrompt: event.systemPrompt + DEBATE_SYSTEM };
  });

  // -- Turn chaining + picker after each round ---------------------------

  pi.on("agent_end", async (event, ctx) => {
    if (!debate) return;

    // Record the turn.
    const d = currentDebater(debate);
    const side = currentSide(debate);
    const rn = roundNum(debate);
    const content = extractAssistantContent(event.messages);

    debate.transcript.push({ debater: d, side, round: rn, content });
    debate.turnIndex++;

    // If B just spoke -> both have spoken -> show picker.
    if (roundJustCompleted(debate)) {
      // Emit round-complete BEFORE blocking on picker (sequential handlers).
      const lastTwo = debate.transcript.slice(-2);
      if (lastTwo.length === 2) {
        const forTurn = lastTwo.find((t) => t.side === "FOR");
        const againstTurn = lastTwo.find((t) => t.side === "AGAINST");
        if (forTurn && againstTurn) {
          const combined =
            `Debater A (FOR):\n${forTurn.content}\n\n` +
            `Debater B (AGAINST):\n${againstTurn.content}`;
          debateEvents.emit("roundComplete", {
            topic: debate.topic,
            round: rn,
            combined,
          });
        }
      }

      try {
        await showRoundPicker(pi, ctx);
      } catch (err) {
        ctx.ui.notify(`Picker error: ${err}`, "error");
        // Don't end debate -- let user retry or /debate-conclude.
      }
      return;
    }

    // Otherwise A just spoke -> auto-advance to B.
    await new Promise((r) => setTimeout(r, 400));
    sendNextTurn(pi);
  });

  // -- Cleanup -----------------------------------------------------------

  pi.on("session_shutdown", async () => {
    if (debate) restoreTools(pi);
  });
}

// ---------------------------------------------------------------------------
// Round-complete picker
// ---------------------------------------------------------------------------

async function showRoundPicker(pi: any, ctx: any) {
  if (!debate) return;

  const rn = roundNum(debate);

  const action = await ctx.ui.select(`Round ${rn} complete -- what next?`, [
    "[Continue]  next round",
    "[Continue + steer]  add moderator guidance",
    "[Decide]  winner for this round",
    "[End]  conclude debate",
  ]);

  if (typeof action !== "string") {
    // Dismissed (Esc) -- debate pauses.
    ctx.ui.notify("Debate paused.  Type to interject or /debate-conclude to end.", "info");
    return;
  }

  if (safeStartsWith(action, "[End]")) {
    await concludeDebate(pi, ctx);
    return;
  }

  if (safeStartsWith(action, "[Decide]")) {
    await showVerdictPicker(pi, ctx);
  }

  // Collect steering text if requested.
  let steering: string | undefined;
  if (safeStartsWith(action, "[Continue + steer]")) {
    steering = await ctx.ui.input("Moderator steering (or leave blank):", "");
  }

  // If debate was concluded inside the verdict picker, stop.
  if (!debate) return;

  ctx.ui.notify(`Round ${roundNum(debate)} starting...`, "info");
  await new Promise((r) => setTimeout(r, 400));
  sendNextTurn(pi, steering || undefined);
}

// ---------------------------------------------------------------------------
// Verdict picker (after "[Decide] winner")
// ---------------------------------------------------------------------------

async function showVerdictPicker(pi: any, ctx: any) {
  if (!debate) return;

  const rn = roundNum(debate);

  const winner = await ctx.ui.select(`Who won Round ${rn}?`, [
    "FOR  (Debater A)",
    "AGAINST  (Debater B)",
    "Neither",
    "Tie",
  ]);

  if (typeof winner !== "string") return; // dismissed

  const verdictWinner: VerdictWinner = safeStartsWith(winner, "FOR")
    ? "FOR"
    : safeStartsWith(winner, "AGAINST")
      ? "AGAINST"
      : safeIncludes(winner, "Neither")
        ? "NEITHER"
        : "TIE";

  const reason = await ctx.ui.input("Reason (optional):", "");

  // Record verdict.
  debate.verdicts.push({
    round: rn,
    winner: verdictWinner,
    reason: reason?.trim() || undefined,
  });

  // Build verdict message for chat history.
  const winnerLabel =
    verdictWinner === "FOR"
      ? "FOR (Debater A)"
      : verdictWinner === "AGAINST"
        ? "AGAINST (Debater B)"
        : verdictWinner === "NEITHER"
          ? "Neither"
          : "Tie";
  const reasonSuffix = reason?.trim() ? `  Reason: ${reason.trim()}` : "";

  const verdictMsg = `[Round ${rn} Verdict: ${winnerLabel} won.${reasonSuffix}]`;

  pi.sendMessage(
    { customType: "debate-verdict", content: verdictMsg, display: true },
    { deliverAs: "steer" },
  );

  ctx.ui.notify(verdictMsg, "success");
}

// ---------------------------------------------------------------------------
// Conclude debate
// ---------------------------------------------------------------------------

async function concludeDebate(pi: any, ctx: any) {
  if (!debate) return;

  const state = debate;

  // Build summary lines.
  const bar = "=".repeat(54);
  const lines: string[] = [bar, "DEBATE  CONCLUDED", bar, ""];
  lines.push(`Topic:  "${state.topic}"`);
  lines.push(
    `Turns:  ${state.transcript.length}  |  Rounds:  ${roundNum(state)}`,
  );
  lines.push("");

  // Per-round verdicts.
  if (state.verdicts.length > 0) {
    lines.push("-- Verdicts --");
    for (const v of state.verdicts) {
      const w =
        v.winner === "FOR"
          ? "FOR (A)"
          : v.winner === "AGAINST"
            ? "AGAINST (B)"
            : v.winner;
      const r = v.reason ? ` -- ${v.reason}` : "";
      lines.push(`  Round ${v.round}: ${w}${r}`);
    }
    lines.push("");
  }

  // Transcript preview.
  lines.push("-- Transcript --");
  for (const t of state.transcript) {
    const sideLabel = t.side === "FOR" ? "[FOR]" : "[AGAINST]";
    const preview =
      t.content.length > 180
        ? t.content.slice(0, 180).replace(/\n/g, " ") + "..."
        : t.content.replace(/\n/g, " ");
    lines.push(`${sideLabel}  ${t.debater}  R${t.round}`);
    lines.push(`    ${preview}`);
  }

  ctx.ui.notify(lines.join("\n"), "info");

  // Inject concluding message into chat.
  pi.sendMessage(
    {
      customType: "debate-conclusion",
      content: `Debate concluded after ${state.transcript.length} turns (${roundNum(state)} rounds).`,
      display: true,
    },
    { deliverAs: "steer" },
  );

  endDebate(pi);
}
