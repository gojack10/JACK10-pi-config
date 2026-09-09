import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { lstat, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

const execFileAsync = promisify(execFile);
const monitorPath = fileURLToPath(new URL("./monitor.mjs", import.meta.url));

async function tmux(args: string[]): Promise<string> {
  const result = await execFileAsync("tmux", args, { encoding: "utf8" });
  return result.stdout.trim();
}
async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 300; i++) { if (await check()) return; await delay(10); }
  assert.fail("timed out");
}

const monitorConfig = (pane: string, jobId: string, attemptId: string) => JSON.stringify({
  paneId: pane,
  manifestOption: "@pi_subagent_manifest",
  outcomeOption: "@pi_outcome",
  outcomeGenerationOption: "@pi_outcome_generation",
  startGenerationOption: "@pi_start_generation",
  sessionFileOption: "@pi_session_file",
  pollMs: 10,
  startTimeoutMs: 1000,
  jobId,
  attemptId,
});

 test("monitor rejects a replaced regular report and a FIFO without blocking", { timeout: 10000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), "subagent-monitor-report-test-"));
  const session = `pi-subagent-report-${process.pid}-${Date.now()}`;
  try {
    await tmux(["new-session", "-d", "-s", session, "-c", dir]);
    const pane = await tmux(["list-panes", "-t", session, "-F", "#{pane_id}"]);
    const sessionFile = join(dir, "session.jsonl");
    await writeFile(sessionFile, "session\n");
    const set = async (option: string, value: string) => tmux(["set-option", "-q", "-t", pane, option, value]);
    await set("@pi_subagent_job_id", "report-job");
    await set("@pi_start_generation", "1");
    await set("@pi_session_file", sessionFile);
    const run = async (report: string, identity: { dev: string; ino: string }) => {
      const manifest = join(dir, `${report.split("/").at(-1)}.manifest.json`);
      await writeFile(manifest, JSON.stringify({ version: 1, jobId: "report-job", attemptId: "report-attempt",
        sessionId: "report-session", mode: "task", reportPath: report,
        reportIdentity: identity, activatedAt: Date.now(), startChannel: "unused-start",
        startGeneration: 0, outcomeGeneration: 0 }));
      await set("@pi_subagent_manifest", manifest);
      await set("@pi_outcome", JSON.stringify({ session_id: "report-session", job_id: "report-job",
        attempt_id: "report-attempt", mode: "task", outcome: "completed", source: "model", final: true, report }));
      await set("@pi_outcome_generation", "1");
      const result = await execFileAsync(process.execPath, [monitorPath, monitorConfig(pane, "report-job", "report-attempt")], {
        encoding: "utf8", timeout: 1000,
      });
      return result.stdout.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)).find(value => value.kind === "final");
    };

    const replacement = join(dir, "replacement.md");
    await writeFile(replacement, "");
    const replacementIdentity = await lstat(replacement);
    await unlink(replacement);
    await writeFile(replacement, "unrelated replacement\n");
    const replacedFinal = await run(replacement, { dev: String(replacementIdentity.dev), ino: String(replacementIdentity.ino) });
    assert.equal(replacedFinal.outcome, "failed");
    assert.equal(replacedFinal.source, "protocol");

    const fifo = join(dir, "report.fifo");
    await writeFile(fifo, "");
    const fifoIdentity = await lstat(fifo);
    await unlink(fifo);
    await execFileAsync("mkfifo", [fifo]);
    const fifoFinal = await run(fifo, { dev: String(fifoIdentity.dev), ino: String(fifoIdentity.ino) });
    assert.equal(fifoFinal.outcome, "failed");
    assert.equal(fifoFinal.source, "protocol");
  } finally {
    await tmux(["kill-session", "-t", session]).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

 test("monitor emits one technical transport final when the child pane disappears after START", { timeout: 10000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), "subagent-monitor-loss-test-"));
  const session = `pi-subagent-loss-${process.pid}-${Date.now()}`;
  let child: ReturnType<typeof spawn> | undefined;
  try {
    await tmux(["new-session", "-d", "-s", session, "-c", dir]);
    const pane = await tmux(["list-panes", "-t", session, "-F", "#{pane_id}"]);
    const sessionFile = join(dir, "session.jsonl");
    const manifest = join(dir, "manifest.json");
    await writeFile(sessionFile, "session\n");
    await writeFile(manifest, JSON.stringify({ version: 1, jobId: "loss-job", attemptId: "loss-attempt",
      sessionId: "loss-session", mode: "dialogue", startChannel: "unused-start",
      startGeneration: 0, outcomeGeneration: 0 }));
    const set = async (option: string, value: string) => tmux(["set-option", "-q", "-t", pane, option, value]);
    await set("@pi_subagent_job_id", "loss-job");
    await set("@pi_subagent_manifest", manifest);
    await set("@pi_start_generation", "1");
    await set("@pi_session_file", sessionFile);
    const markers: any[] = [];
    child = spawn(process.execPath, [monitorPath, monitorConfig(pane, "loss-job", "loss-attempt")], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout!.setEncoding("utf8").on("data", chunk => {
      for (const line of String(chunk).split(/\r?\n/).filter(Boolean)) markers.push(JSON.parse(line));
    });
    await until(() => markers.some(marker => marker.kind === "start"));
    await tmux(["kill-session", "-t", session]);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { child?.kill("SIGTERM"); reject(new Error("monitor did not exit after pane loss")); }, 1500);
      child!.once("close", () => { clearTimeout(timer); resolve(); });
    });
    const finals = markers.filter(marker => marker.kind === "final");
    assert.equal(finals.length, 1);
    assert.equal(finals[0].outcome, "transport_lost");
    assert.equal(finals[0].source, "transport");
    assert.equal(finals[0].technical, true);
    assert.equal(finals[0].final, true);
  } finally {
    child?.kill("SIGTERM");
    await tmux(["kill-session", "-t", session]).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

 test("monitor ignores a foreign session receipt before accepting the matching session", { timeout: 10000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), "subagent-monitor-session-test-"));
  const session = `pi-subagent-session-${process.pid}-${Date.now()}`;
  let child: ReturnType<typeof spawn> | undefined;
  try {
    await tmux(["new-session", "-d", "-s", session, "-c", dir]);
    const pane = await tmux(["list-panes", "-t", session, "-F", "#{pane_id}"]);
    const sessionFile = join(dir, "session.jsonl");
    const manifest = join(dir, "manifest.json");
    await writeFile(sessionFile, "session\n");
    await writeFile(manifest, JSON.stringify({ version: 1, jobId: "session-job", attemptId: "session-attempt",
      sessionId: "expected-session", mode: "dialogue", startChannel: "unused-start",
      startGeneration: 0, outcomeGeneration: 0 }));
    const set = async (option: string, value: string) => tmux(["set-option", "-q", "-t", pane, option, value]);
    await set("@pi_subagent_job_id", "session-job");
    await set("@pi_subagent_manifest", manifest);
    await set("@pi_start_generation", "1");
    await set("@pi_session_file", sessionFile);
    await set("@pi_outcome", JSON.stringify({ session_id: "foreign-session", job_id: "session-job",
      attempt_id: "session-attempt", mode: "dialogue", outcome: "completed", source: "model", final: true }));
    await set("@pi_outcome_generation", "1");
    const markers: any[] = [];
    child = spawn(process.execPath, [monitorPath, monitorConfig(pane, "session-job", "session-attempt")], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout!.setEncoding("utf8").on("data", chunk => {
      for (const line of String(chunk).split(/\r?\n/).filter(Boolean)) markers.push(JSON.parse(line));
    });
    await until(() => markers.some(marker => marker.kind === "evidence"));
    assert.equal(markers.some(marker => marker.kind === "final"), false);
    await set("@pi_outcome", JSON.stringify({ session_id: "expected-session", job_id: "session-job",
      attempt_id: "session-attempt", mode: "dialogue", outcome: "dialogue_settled", source: "model", final: true }));
    await set("@pi_outcome_generation", "2");
    await until(() => markers.some(marker => marker.kind === "final"));
    assert.equal(markers.at(-1).outcome, "completed");
  } finally {
    child?.kill("SIGTERM");
    await tmux(["kill-session", "-t", session]).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

 test("monitor preserves a terminal transport receipt instead of protocol-failing it", { timeout: 10000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), "subagent-monitor-transport-test-"));
  const session = `pi-subagent-transport-${process.pid}-${Date.now()}`;
  try {
    await tmux(["new-session", "-d", "-s", session, "-c", dir]);
    const pane = await tmux(["list-panes", "-t", session, "-F", "#{pane_id}"]);
    const sessionFile = join(dir, "session.jsonl");
    const manifest = join(dir, "manifest.json");
    await writeFile(sessionFile, "session\n");
    await writeFile(manifest, JSON.stringify({ version: 1, jobId: "transport-job", attemptId: "transport-attempt",
      sessionId: "transport-session", mode: "dialogue", startChannel: "unused-start",
      startGeneration: 0, outcomeGeneration: 0 }));
    const set = async (option: string, value: string) => tmux(["set-option", "-q", "-t", pane, option, value]);
    await set("@pi_subagent_job_id", "transport-job");
    await set("@pi_subagent_manifest", manifest);
    await set("@pi_start_generation", "1");
    await set("@pi_session_file", sessionFile);
    await set("@pi_outcome", JSON.stringify({ session_id: "transport-session", job_id: "transport-job",
      attempt_id: "transport-attempt", mode: "dialogue", outcome: "transport_lost", source: "transport", final: false,
      summary: "child session disappeared" }));
    await set("@pi_outcome_generation", "1");
    const result = await execFileAsync(process.execPath, [monitorPath, monitorConfig(pane, "transport-job", "transport-attempt")], {
      encoding: "utf8", timeout: 1000,
    });
    const final = result.stdout.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)).find(value => value.kind === "final");
    assert.equal(final.outcome, "transport_lost");
    assert.equal(final.source, "transport");
    assert.equal(final.technical, true);
    assert.equal(final.final, true);
    assert.doesNotMatch(final.summary, /protocol_incomplete/);
  } finally {
    await tmux(["kill-session", "-t", session]).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});
