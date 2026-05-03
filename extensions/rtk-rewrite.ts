import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { isToolCallEventType } from "@mariozechner/pi-coding-agent";
import { execSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * RTK Rewrite Extension
 *
 * Hooks bash tool_call and transparently rewrites commands through
 * `rtk rewrite` before execution. The agent sees filtered/compressed
 * output but never knows rtk is involved.
 *
 * All rewrite logic lives in rtk itself (src/discover/registry.rs).
 * This extension is a thin delegate — when new filters are added to
 * rtk, it picks them up automatically with zero changes.
 *
 * Improvements ported from rtk's Claude Code hook (hook_cmd.rs):
 *  1. Short-circuit heredoc / arithmetic / already-rtk — skip subprocess
 *  2. RTK_DISABLED=1 support — per-command opt-out escape hatch
 *  3. Config-driven exclude list (RTK_EXCLUDE env + ~/.config/rtk/rewrite-exclude.txt)
 *  4. Optional audit logging (RTK_REWRITE_AUDIT=1)
 *  5. LRU result cache — avoids repeated subprocesses for common commands
 *  6. Async spawn — non-blocking (replaces spawnSync)
 */

// ── Cache ──────────────────────────────────────────────────────

class LruCache<K, V> {
  private map = new Map<K, V>();
  constructor(private max: number) {}

  get(key: K): V | undefined {
    const value = this.map.get(key);
    if (value !== undefined) {
      // Move to end (most-recently-used)
      this.map.delete(key);
      this.map.set(key, value);
    }
    return value;
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.max) {
      // Delete least-recently-used (first entry)
      const first = this.map.keys().next().value!;
      this.map.delete(first);
    }
    this.map.set(key, value);
  }
}

const rewriteCache = new LruCache<string, string | null>(100);

// ── Pre-flight regexps (short-circuit) ─────────────────────────

// `rtk rewrite` would return null for these anyway; avoid the subprocess.

// Already-rtk: "rtk git status", "rtk"
const RE_RTK_ALREADY = /^rtk(?:\s|$)/;

// Heredocs: "cat <<EOF\n…\nEOF" — can't filter streaming input
const RE_HEREDOC = /<<-?\s*.*\n/s;

// Arithmetic expansion: "$((1+1))"
const RE_ARITHMETIC = /\$\(\(/;

// RTK_DISABLED=1 in env prefix — user opted this command out
const RE_RTK_DISABLED = /^RTK_DISABLED=1\b/i;

function shouldSkipRewrite(command: string): boolean {
  return (
    RE_RTK_ALREADY.test(command) ||
    RE_HEREDOC.test(command) ||
    RE_ARITHMETIC.test(command)
  );
}

// ── Exclusion config ──────────────────────────────────────────

let excludePatterns: string[] | null = null;

function loadExcludePatterns(): string[] {
  if (excludePatterns !== null) return excludePatterns;

  const patterns: string[] = [];

  // 1. RTK_EXCLUDE env var (comma-separated prefixes or /regex/flags)
  const envExclude = process.env.RTK_EXCLUDE;
  if (envExclude) {
    patterns.push(
      ...envExclude
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    );
  }

  // 2. ~/.config/rtk/rewrite-exclude.txt (one per line, # comments)
  try {
    const home = process.env.HOME || process.env.USERPROFILE || "";
    const configPath = resolve(home, ".config", "rtk", "rewrite-exclude.txt");
    if (existsSync(configPath)) {
      const content = readFileSync(configPath, "utf-8");
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith("#")) {
          patterns.push(trimmed);
        }
      }
    }
  } catch {
    // config file is optional
  }

  excludePatterns = patterns;
  return patterns;
}

function isExcluded(command: string): boolean {
  const patterns = loadExcludePatterns();
  return patterns.some((pat) => {
    // Regex syntax: /pattern/flags
    const m = pat.match(/^\/(.+)\/([a-z]*)$/);
    if (m) {
      try {
        return new RegExp(m[1], m[2]).test(command);
      } catch {
        return false;
      }
    }
    // Plain prefix match
    return command.startsWith(pat);
  });
}

// ── Rewrite engine ─────────────────────────────────────────────

async function tryRewrite(command: string): Promise<string | null> {
  // Check LRU cache first — same commands repeat across tool calls
  const cached = rewriteCache.get(command);
  if (cached !== undefined) return cached;

  const result = await tryRewriteSubprocess(command);
  rewriteCache.set(command, result);
  return result;
}

function tryRewriteSubprocess(command: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn("rtk", ["rewrite", command], {
      timeout: 2000,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.on("error", () => resolve(null));
    child.on("close", () => {
      const rewritten = stdout.trim();
      resolve(rewritten.length > 0 ? rewritten : null);
    });
  });
}

// ── Audit logging ──────────────────────────────────────────────

function auditLog(original: string, rewritten: string): void {
  if (process.env.RTK_REWRITE_AUDIT !== "1") return;

  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  console.error(`[rtk-rewrite] ${ts}  rewrite  ${original}  →  ${rewritten}`);
}

// ── Main hook ──────────────────────────────────────────────────

export default function rtkRewrite(pi: ExtensionAPI) {
  let rtkAvailable: boolean | null = null;

  function checkRtk(): boolean {
    if (rtkAvailable !== null) return rtkAvailable;
    try {
      execSync("command -v rtk", { stdio: "ignore", timeout: 2000 });
      rtkAvailable = true;
    } catch {
      rtkAvailable = false;
    }
    return rtkAvailable;
  }

  pi.on("tool_call", async (event, _ctx: ExtensionContext) => {
    // Only intercept bash tool calls
    if (!isToolCallEventType("bash", event)) return;

    // Lazy-check rtk availability (checks once, caches result)
    if (!checkRtk()) return;

    const command = event.input.command;
    if (typeof command !== "string" || command.length === 0) return;

    // (1) RTK_DISABLED=1 env prefix — explicit opt-out for this command
    if (RE_RTK_DISABLED.test(command)) return;

    // (2) Short-circuit: heredocs, arithmetic, already-rtk
    //     `rtk rewrite` returns null for these anyway; avoid the fork
    if (shouldSkipRewrite(command)) return;

    // (3) Config-driven exclude list
    if (isExcluded(command)) return;

    // (4/5/6) Async rewrite with LRU cache (non-blocking subprocess)
    const rewritten = await tryRewrite(command);
    if (!rewritten || rewritten === command) return;

    // Mutate the command in place — the model generated the original,
    // but rtk's filtered output is what it'll see in the result.
    event.input.command = rewritten;

    auditLog(command, rewritten);
  });
}
