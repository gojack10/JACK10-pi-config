/**
 * ctrl-s-prompt-stash — rolling prompt stash with durable history (Option B).
 *
 * Journal: ~/.pi/agent/prompt-stashes.jsonl — one JSON event per line,
 * append-only, mode 0600. push records the stashed text; pop marks it
 * restored. State is replayed from the file on demand (no watchers, no
 * locks: appends are the only mutation, so concurrent pi instances cannot
 * lose each other's events, and a torn or corrupt line is skipped and
 * reported, never fatal). Unreadable file = stash disabled, never
 * silently empty.
 *
 * ctrl+s (rolling swap):
 *   editor has text  -> push current text, then bring the newest active
 *                        stash into the editor (swap). Stack empty -> park
 *                        and clear.
 *   editor is empty  -> newest active stash into the editor (pop).
 * /stash: plain pi selector of every entry, newest first (● active,
 *   ○ parked/restored); picking one swaps it in the same way — current
 *   editor text is auto-stashed first, never a confirm dialog.
 * Picker churn (/model, /tree, /compact) and post-submit input replay a
 *   pending restore into an empty editor, then pop it once confirmed.
 * Feedback stays minimal: the same two widget lines as before.
 */

import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, openSync, readFileSync, statSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";

const STASH_PATH = join(homedir(), ".pi", "agent", "prompt-stashes.jsonl");

export interface StashEntry {
  id: string;
  at: string;
  cwd: string;
  text: string;
  active: boolean;
}

interface StashState {
  entries: StashEntry[];
  damaged: number;
}

export function replayStash(raw: string): { entries: StashEntry[]; damaged: number } {
  const entries: StashEntry[] = [];
  let damaged = 0;
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    let event: { op?: unknown; id?: unknown; at?: unknown; cwd?: unknown; text?: unknown };
    try {
      event = JSON.parse(line);
    } catch {
      damaged += 1;
      continue;
    }
    if (event.op === "push" && typeof event.id === "string" && typeof event.text === "string") {
      const pushId = event.id;
      const pushTextValue = event.text;
      const pushAt = typeof event.at === "string" ? event.at : "";
      const pushCwd = typeof event.cwd === "string" ? event.cwd : "";
      if (!entries.some((entry) => entry.id === pushId)) {
        entries.push({ id: pushId, at: pushAt, cwd: pushCwd, text: pushTextValue, active: true });
      }
    } else if (event.op === "pop" && typeof event.id === "string") {
      const popIdValue = event.id;
      for (const entry of entries) {
        if (entry.id === popIdValue) entry.active = false;
      }
    } else {
      damaged += 1;
    }
  }
  return { entries, damaged };
}

export function newestActive(entries: StashEntry[]): StashEntry | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index].active) return entries[index];
  }
  return undefined;
}

export function relAge(at: string): string {
  const ms = Date.now() - Date.parse(at);
  if (!Number.isFinite(ms) || ms < 0) return "?";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function previewOf(text: string): string {
  const flat = text.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return flat.length > 42 ? `${flat.slice(0, 41)}…` : flat;
}

export function rowOf(entry: StashEntry): string {
  const project = entry.cwd.replace(/\/+$/, "").split("/").pop() ?? entry.cwd;
  const lines = entry.text.split("\n").length;
  const bytes = Buffer.byteLength(entry.text, "utf8");
  return `${entry.active ? "●" : "○"} ${entry.id}  ${relAge(entry.at)}  ${project}  “${previewOf(entry.text)}”  ${lines} lines · ${bytes} B`;
}

let stashCache: (StashState & { size: number; mtimeMs: number }) | undefined;

function loadState(): StashState {
  let stat;
  try {
    stat = statSync(STASH_PATH);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { entries: [], damaged: 0 };
    return { entries: [], damaged: -1 };
  }
  if (stashCache && stashCache.size === stat.size && stashCache.mtimeMs === stat.mtimeMs) return stashCache;
  let state: StashState;
  try {
    state = replayStash(readFileSync(STASH_PATH, "utf8"));
  } catch {
    return { entries: [], damaged: -1 };
  }
  stashCache = { ...state, size: stat.size, mtimeMs: stat.mtimeMs };
  return stashCache;
}

function appendDurable(line: string): void {
  const fd = openSync(STASH_PATH, "a", 0o600);
  try {
    const data = Buffer.from(`${line}\n`, "utf8");
    let written = 0;
    while (written < data.length) {
      written += writeSync(fd, data, written, data.length - written);
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function pushText(text: string, cwd: string): StashEntry {
  const entry: StashEntry = {
    id: randomUUID().replace(/-/g, "").slice(0, 8),
    at: new Date().toISOString(),
    cwd,
    text,
    active: true,
  };
  appendDurable(JSON.stringify({ v: 1, op: "push", id: entry.id, at: entry.at, cwd: entry.cwd, text: entry.text }));
  return entry;
}

function popId(id: string): void {
  appendDurable(JSON.stringify({ v: 1, op: "pop", id, at: new Date().toISOString() }));
}

let stashWidgetTimer: ReturnType<typeof setTimeout> | undefined;

function showWidget(ctx: ExtensionContext, message: string): void {
  if (stashWidgetTimer) {
    clearTimeout(stashWidgetTimer);
    stashWidgetTimer = undefined;
  }
  ctx.ui.setWidget("prompt-stash", (tui, thm) => {
    const container = new Container();
    container.addChild(new Spacer(1));
    container.addChild(new Text(thm.fg("text", message), 1, 0));
    return container;
  }, { placement: "aboveEditor" });
  if (message === "Prompt restored") {
    stashWidgetTimer = setTimeout(() => {
      stashWidgetTimer = undefined;
      ctx.ui.setWidget("prompt-stash", undefined);
    }, 3000);
  }
}

function clearWidget(ctx: ExtensionContext): void {
  if (stashWidgetTimer) {
    clearTimeout(stashWidgetTimer);
    stashWidgetTimer = undefined;
  }
  ctx.ui.setWidget("prompt-stash", undefined);
}

let restoreGeneration = 0;
let slashRestorePending = false;
let restoreSnapshot: StashEntry | undefined;
let restoreTimers: Array<ReturnType<typeof setTimeout>> = [];

function resetPending(): void {
  cancelRestoreTimers();
  restoreGeneration += 1;
  restoreSnapshot = undefined;
  slashRestorePending = false;
}

function cancelRestoreTimers(): void {
  for (const timer of restoreTimers) clearTimeout(timer);
  restoreTimers = [];
}

function finishRestore(ctx: ExtensionContext): void {
  const entry = restoreSnapshot;
  restoreSnapshot = undefined;
  restoreGeneration += 1;
  slashRestorePending = false;
  cancelRestoreTimers();
  if (entry) {
    // A failed pop append here is safe: the item stays active, which can
    // only cause a duplicate restore, never a loss.
    try { popId(entry.id); } catch {}
    showWidget(ctx, "Prompt restored");
  }
}

function scheduleRestore(ctx: ExtensionContext, slash: boolean): void {
  const state = loadState();
  if (state.damaged === -1 || !newestActive(state.entries)) {
    resetPending();
    return;
  }
  cancelRestoreTimers();
  restoreGeneration += 1;
  const generation = restoreGeneration;
  slashRestorePending = slash;
  restoreSnapshot = newestActive(state.entries);
  let restored = false;
  const delays = slash ? [50, 150, 300, 600, 1000, 1500, 2500, 4000, 6000] : [0, 25, 100, 250];
  for (const delay of delays) {
    restoreTimers.push(setTimeout(() => {
      if (generation !== restoreGeneration || !restoreSnapshot) return;
      const current = ctx.ui.getEditorText();
      if (current.length === 0) {
        ctx.ui.setEditorText(restoreSnapshot.text);
        restored = true;
        if (!slash) finishRestore(ctx);
        return;
      }
      if (restored && current === restoreSnapshot.text) finishRestore(ctx);
    }, delay));
  }
}

export default function ctrlSPromptStash(pi: ExtensionAPI) {
  const wireReplay = (ctx: ExtensionContext) => {
    if (!slashRestorePending || !restoreSnapshot) return;
    scheduleRestore(ctx, true);
  };

  pi.on("model_select", async (_event, ctx) => {
    wireReplay(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    wireReplay(ctx);
  });

  pi.on("session_compact", async (_event, ctx) => {
    wireReplay(ctx);
  });

  pi.on("input", async (event, ctx) => {
    if (event.source !== "interactive") return { action: "continue" as const };
    const text = event.text.trim();
    if (text.length === 0) return { action: "continue" as const };
    scheduleRestore(ctx, text.startsWith("/"));
    return { action: "continue" as const };
  });

  pi.on("session_start", async (event, ctx) => {
    resetPending();
    const state = loadState();
    if (state.damaged === -1) {
      ctx.ui.notify("prompt stash: stash file unreadable — stash disabled", "error");
      return;
    }
    if (state.damaged > 0) {
      ctx.ui.notify(`prompt stash: skipped ${state.damaged} damaged line(s) — kept on disk`, "warning");
    }
    if (event.reason === "startup") {
      const activeCount = state.entries.filter((entry) => entry.active).length;
      if (activeCount > 0) {
        ctx.ui.notify(`Recovered ${activeCount} stashed prompt${activeCount === 1 ? "" : "s"} — ctrl+s or /stash`, "info");
      }
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    resetPending();
    clearWidget(ctx);
  });

  pi.registerShortcut("ctrl+s", {
    description: "Stash or restore the current editor prompt",
    handler: async (ctx) => {
      resetPending();
      const current = ctx.ui.getEditorText();
      const state = loadState();
      if (state.damaged === -1) {
        ctx.ui.notify("prompt stash: stash file unreadable — stash disabled", "error");
        return;
      }
      if (current.trim().length === 0) {
        const entry = newestActive(state.entries);
        if (!entry) return;
        try {
          popId(entry.id);
        } catch {
          ctx.ui.notify("prompt stash: write failed", "error");
          return;
        }
        ctx.ui.setEditorText(entry.text);
        showWidget(ctx, "Prompt restored");
        return;
      }
      const newest = newestActive(state.entries);
      try {
        pushText(current, ctx.cwd);
      } catch {
        ctx.ui.notify("prompt stash: write failed — editor kept", "error");
        return;
      }
      if (newest) {
        try {
          popId(newest.id);
        } catch {
          ctx.ui.notify("prompt stash: write failed", "error");
        }
        ctx.ui.setEditorText(newest.text);
      } else {
        ctx.ui.setEditorText("");
      }
      showWidget(ctx, "Prompt stashed");
    },
  });

  pi.registerCommand("stash", {
    description: "Browse stashed prompts",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;
      const editorAtOpen = ctx.ui.getEditorText();
      const state = loadState();
      if (state.damaged === -1) {
        ctx.ui.notify("prompt stash: stash file unreadable — stash disabled", "error");
        return;
      }
      if (state.entries.length === 0) {
        ctx.ui.notify("No stashed prompts yet — ctrl+s stashes the editor", "info");
        return;
      }
      const ordered = [...state.entries].reverse();
      const rows = ordered.map(rowOf);
      const choice = await ctx.ui.select("Stashed prompts", rows);
      if (typeof choice !== "string") {
        if (ctx.ui.getEditorText().length === 0 && editorAtOpen.trim().length > 0) {
          ctx.ui.setEditorText(editorAtOpen);
        }
        return;
      }
      const index = rows.indexOf(choice);
      if (index < 0) return;
      const entry = ordered[index];
      const hadText = editorAtOpen.trim().length > 0;
      if (hadText) {
        try {
          pushText(editorAtOpen, ctx.cwd);
        } catch {
          ctx.ui.notify("prompt stash: write failed — editor kept", "error");
          if (ctx.ui.getEditorText().length === 0) ctx.ui.setEditorText(editorAtOpen);
          return;
        }
      }
      if (entry.active) {
        try {
          popId(entry.id);
        } catch {
          ctx.ui.notify("prompt stash: write failed", "error");
        }
      }
      ctx.ui.setEditorText(entry.text);
      showWidget(ctx, hadText ? "Prompt stashed" : "Prompt restored");
    },
  });
}
