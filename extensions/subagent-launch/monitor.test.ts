import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { lstat, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
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

const monitorConfig = (pane: string, jobId: string, attemptId: string, startTimeoutMs = 1000,
  sessionId?: string, mode?: "task" | "dialogue") => JSON.stringify({
  paneId: pane,
  manifestOption: "@pi_subagent_manifest",
  outcomeOption: "@pi_outcome",
  outcomeGenerationOption: "@pi_outcome_generation",
  startGenerationOption: "@pi_start_generation",
  sessionFileOption: "@pi_session_file",
  sessionIdOption: "@pi_session_id",
  pollMs: 10,
  startTimeoutMs,
  jobId,
  attemptId,
  sessionId,
  mode,
});

 test("monitor fails a live malformed manifest at the bounded start deadline", { timeout: 5000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), "subagent-monitor-manifest-test-"));
  const session = `pi-subagent-manifest-${process.pid}-${Date.now()}`;
  let child: ReturnType<typeof spawn> | undefined;
  try {
    await tmux(["new-session", "-d", "-s", session, "-c", dir]);
    const pane = await tmux(["list-panes", "-t", session, "-F", "#{pane_id}"]);
    const manifest = join(dir, "manifest.json");
    await writeFile(manifest, JSON.stringify({ version: 999 }));
    await tmux(["set-option", "-q", "-t", pane, "@pi_subagent_job_id", "manifest-job"]);
    await tmux(["set-option", "-q", "-t", pane, "@pi_subagent_manifest", manifest]);
    const markers: any[] = [];
    child = spawn(process.execPath, [monitorPath, monitorConfig(pane, "manifest-job", "manifest-attempt", 100)], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout!.setEncoding("utf8").on("data", chunk => {
      for (const line of String(chunk).split(/\r?\n/).filter(Boolean)) markers.push(JSON.parse(line));
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("monitor did not bound malformed manifest")), 1000);
      child!.once("close", () => { clearTimeout(timer); resolve(); });
    });
    const finals = markers.filter(marker => marker.kind === "final");
    assert.equal(finals.length, 1);
    assert.equal(finals[0].outcome, "failed");
    assert.equal(finals[0].source, "protocol");
    assert.equal(finals[0].technical, true);
    assert.equal(finals[0].final, true);
  } finally {
    child?.kill("SIGTERM");
    await tmux(["kill-session", "-t", session]).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

 test("monitor accepts a valid manifest that arrives before the deadline", { timeout: 5000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), "subagent-monitor-manifest-arrival-test-"));
  const session = `pi-subagent-manifest-arrival-${process.pid}-${Date.now()}`;
  let child: ReturnType<typeof spawn> | undefined;
  try {
    await tmux(["new-session", "-d", "-s", session, "-c", dir]);
    const pane = await tmux(["list-panes", "-t", session, "-F", "#{pane_id}"]);
    const badManifest = join(dir, "bad-manifest.json");
    const manifest = join(dir, "manifest.json");
    const sessionFile = join(dir, "session.jsonl");
    await writeFile(badManifest, JSON.stringify({ version: 999 }));
    await writeFile(manifest, JSON.stringify({ version: 1, jobId: "arrival-job", attemptId: "arrival-attempt",
      sessionId: "arrival-session", mode: "dialogue", startChannel: "unused-start",
      startGeneration: 0, outcomeGeneration: 0 }));
    const set = async (option: string, value: string) => tmux(["set-option", "-q", "-t", pane, option, value]);
    await set("@pi_subagent_job_id", "arrival-job");
    await set("@pi_subagent_manifest", badManifest);
    const markers: any[] = [];
    child = spawn(process.execPath, [monitorPath, monitorConfig(pane, "arrival-job", "arrival-attempt", 500)], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout!.setEncoding("utf8").on("data", chunk => {
      for (const line of String(chunk).split(/\r?\n/).filter(Boolean)) markers.push(JSON.parse(line));
    });
    await delay(60);
    await set("@pi_subagent_manifest", manifest);
    await set("@pi_start_generation", "1");
    await set("@pi_session_file", sessionFile);
    await set("@pi_session_id", "arrival-session");
    await until(() => markers.some(marker => marker.kind === "start"));
    assert.equal(markers.filter(marker => marker.kind === "final").length, 0);
    await set("@pi_outcome", JSON.stringify({ session_id: "arrival-session", job_id: "arrival-job",
      attempt_id: "arrival-attempt", mode: "dialogue", outcome: "dialogue_settled", source: "model", final: true,
      report_text: "" }));
    await set("@pi_outcome_generation", "1");
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("monitor did not settle valid manifest")), 1000);
      child!.once("close", () => { clearTimeout(timer); resolve(); });
    });
    const finals = markers.filter(marker => marker.kind === "final");
    assert.equal(finals.length, 1);
    assert.equal(finals[0].outcome, "completed");
    assert.equal(finals[0].source, "model");
  } finally {
    child?.kill("SIGTERM");
    await tmux(["kill-session", "-t", session]).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test("monitor reads protected full dialogue reports without tmux or summary truncation", { timeout: 10000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), "subagent-monitor-dialogue-report-test-"));
  const session = `pi-subagent-dialogue-report-${process.pid}-${Date.now()}`;
  let child: ReturnType<typeof spawn> | undefined;
  try {
    await tmux(["new-session", "-d", "-s", session, "-c", dir]);
    const pane = await tmux(["list-panes", "-t", session, "-F", "#{pane_id}"]);
    const sessionFile = join(dir, "session.jsonl");
    const manifest = join(dir, "manifest.json");
    const report = join(dir, "dialogue-report.txt");
    const receipt = join(dir, "outcome-receipt.json");
    const exact = "😀".repeat(11_000) + "\nleading/trailing  ";
    await writeFile(sessionFile, JSON.stringify({ type: "session", id: "dialogue-report-session" }) + "\n");
    await writeFile(report, exact);
    const reportIdentity = await lstat(report);
    await writeFile(manifest, JSON.stringify({ version: 1, jobId: "dialogue-report-job", attemptId: "dialogue-report-attempt",
      sessionId: "dialogue-report-session", mode: "dialogue", startChannel: "unused-start",
      startGeneration: 0, outcomeGeneration: 0 }));
    const full = { version: 1, session_id: "dialogue-report-session", job_id: "dialogue-report-job",
      attempt_id: "dialogue-report-attempt", mode: "dialogue", outcome: "dialogue_settled", source: "model", final: true,
      summary: "dialogue_settled", transport_report_path: report,
      transport_report_identity: { dev: String(reportIdentity.dev), ino: String(reportIdentity.ino) },
      transport_report_present: true };
    await writeFile(receipt, JSON.stringify(full));
    const receiptIdentity = await lstat(receipt);
    const set = async (option: string, value: string) => tmux(["set-option", "-q", "-t", pane, option, value]);
    await set("@pi_subagent_job_id", "dialogue-report-job");
    await set("@pi_subagent_manifest", manifest);
    await set("@pi_start_generation", "1");
    await set("@pi_session_file", sessionFile);
    const markers: any[] = [];
    child = spawn(process.execPath, [monitorPath, monitorConfig(pane, "dialogue-report-job", "dialogue-report-attempt", 1000,
      "dialogue-report-session", "dialogue")], { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout!.setEncoding("utf8").on("data", chunk => {
      for (const line of String(chunk).split(/\r?\n/).filter(Boolean)) markers.push(JSON.parse(line));
    });
    await until(() => markers.some(marker => marker.kind === "start"));
    await set("@pi_outcome", JSON.stringify({ session_id: "dialogue-report-session", job_id: "dialogue-report-job",
      attempt_id: "dialogue-report-attempt", mode: "dialogue", outcome: "dialogue_settled", source: "model", final: true,
      receipt_path: receipt, receipt_identity: { dev: String(receiptIdentity.dev), ino: String(receiptIdentity.ino) } }));
    await set("@pi_outcome_generation", "1");
    await until(() => markers.some(marker => marker.kind === "final"));
    const final = markers.find(marker => marker.kind === "final");
    assert.equal(final.outcome, "completed");
    assert.equal(final.source, "model");
    assert.equal(final.reportText, undefined);
    assert.equal(final.dialogueReportPath, report);
    assert.equal(await readFile(final.dialogueReportPath, "utf8"), exact);
  } finally {
    child?.kill("SIGTERM");
    await tmux(["kill-session", "-t", session]).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test("monitor turns a published receipt read failure into visible transport evidence", { timeout: 10000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), "subagent-monitor-receipt-failure-test-"));
  const session = `pi-subagent-receipt-failure-${process.pid}-${Date.now()}`;
  let child: ReturnType<typeof spawn> | undefined;
  try {
    await tmux(["new-session", "-d", "-s", session, "-c", dir]);
    const pane = await tmux(["list-panes", "-t", session, "-F", "#{pane_id}"]);
    const sessionFile = join(dir, "session.jsonl");
    const manifest = join(dir, "manifest.json");
    await writeFile(sessionFile, JSON.stringify({ type: "session", id: "receipt-failure-session" }) + "\n");
    await writeFile(manifest, JSON.stringify({ version: 1, jobId: "receipt-failure-job", attemptId: "receipt-failure-attempt",
      sessionId: "receipt-failure-session", mode: "dialogue", startChannel: "unused-start",
      startGeneration: 0, outcomeGeneration: 0 }));
    const set = async (option: string, value: string) => tmux(["set-option", "-q", "-t", pane, option, value]);
    for (const [option, value] of [["@pi_subagent_job_id", "receipt-failure-job"],
      ["@pi_subagent_manifest", manifest], ["@pi_start_generation", "1"], ["@pi_session_file", sessionFile]] as const) {
      await set(option, value);
    }
    const markers: any[] = [];
    child = spawn(process.execPath, [monitorPath, monitorConfig(pane,
      "receipt-failure-job", "receipt-failure-attempt", 1000, "receipt-failure-session", "dialogue")], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout!.setEncoding("utf8").on("data", chunk => {
      for (const line of String(chunk).split(/\r?\n/).filter(Boolean)) markers.push(JSON.parse(line));
    });
    await until(() => markers.some(marker => marker.kind === "start"));
    await set("@pi_outcome", JSON.stringify({ session_id: "receipt-failure-session", job_id: "receipt-failure-job",
      attempt_id: "receipt-failure-attempt", mode: "dialogue", outcome: "dialogue_settled", source: "model", final: true,
      receipt_path: join(dir, "missing-receipt"), receipt_identity: { dev: "1", ino: "1" } }));
    await set("@pi_outcome_generation", "1");
    await until(() => markers.some(marker => marker.kind === "final"));
    const final = markers.find(marker => marker.kind === "final");
    assert.equal(final.outcome, "transport_lost");
    assert.equal(final.source, "transport");
    assert.match(final.summary, /cannot read published outcome/);
  } finally {
    child?.kill("SIGTERM");
    await tmux(["kill-session", "-t", session]).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test("monitor rejects a replaced regular report and a FIFO without blocking", { timeout: 10000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), "subagent-monitor-report-test-"));
  const session = `pi-subagent-report-${process.pid}-${Date.now()}`;
  try {
    await tmux(["new-session", "-d", "-s", session, "-c", dir]);
    const pane = await tmux(["list-panes", "-t", session, "-F", "#{pane_id}"]);
    const sessionFile = join(dir, "session.jsonl");
    await writeFile(sessionFile, JSON.stringify({ type: "session", id: "report-session" }) + "\n");
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
    await writeFile(sessionFile, JSON.stringify({ type: "session", id: "loss-session" }) + "\n");
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

 test("monitor ignores a foreign receipt and accepts the real Pi ID rather than the transport ID", { timeout: 10000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), "subagent-monitor-session-test-"));
  const session = `pi-subagent-session-${process.pid}-${Date.now()}`;
  let child: ReturnType<typeof spawn> | undefined;
  try {
    await tmux(["new-session", "-d", "-s", session, "-c", dir]);
    const pane = await tmux(["list-panes", "-t", session, "-F", "#{pane_id}"]);
    const sessionFile = join(dir, "session.jsonl");
    const manifest = join(dir, "manifest.json");
    await writeFile(sessionFile, JSON.stringify({ type: "session", id: "actual-pi-session" }) + "\n");
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
    await set("@pi_outcome", JSON.stringify({ session_id: "actual-pi-session", job_id: "session-job",
      attempt_id: "session-attempt", mode: "dialogue", outcome: "dialogue_settled", source: "model", final: true,
      report_text: "" }));
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
    await writeFile(sessionFile, JSON.stringify({ type: "session", id: "transport-session" }) + "\n");
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

test("monitor rejects missing or invalid session headers instead of guessing transport identity", { timeout: 10000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "subagent-monitor-header-"));
  const session = `pi-subagent-header-${process.pid}-${Date.now()}`;
  try {
    await tmux(["new-session", "-d", "-s", session, "-c", dir]);
    const pane = await tmux(["list-panes", "-t", session, "-F", "#{pane_id}"]);
    const manifest = join(dir, "manifest.json");
    const file = join(dir, "session.jsonl");
    await writeFile(manifest, JSON.stringify({ version: 1, jobId: "header-job", attemptId: "header-attempt",
      sessionId: "transport-id", mode: "dialogue", startChannel: "unused-start",
      startGeneration: 0, outcomeGeneration: 0 }));
    for (const [option, value] of Object.entries({ "@pi_subagent_job_id": "header-job",
      "@pi_subagent_manifest": manifest, "@pi_session_file": file, "@pi_start_generation": "1" })) {
      await tmux(["set-option", "-q", "-t", pane, option, value]);
    }
    for (const header of [undefined, "not JSON\n", '{"type":"session","id":""}\n']) {
      if (header !== undefined) await writeFile(file, header);
      const result = await execFileAsync(process.execPath, [monitorPath,
        monitorConfig(pane, "header-job", "header-attempt")], { encoding: "utf8", timeout: 1500 });
      const markers = result.stdout.trim().split("\n").map(line => JSON.parse(line));
      assert.equal(markers.length, 1);
      assert.equal(markers[0].source, "protocol");
      assert.match(markers[0].summary, /invalid Pi session header/);
    }
  } finally {
    await tmux(["kill-session", "-t", session]).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test("monitor binds manifest identity and allows same-identity replacement", { timeout: 15000 }, async () => {
  const cases = [
    { name: "foreign session", replacement: { sessionId: "foreign-session" }, receipt: {
      session_id: "foreign-session", job_id: "bound-job", attempt_id: "bound-attempt",
    } },
    { name: "foreign job and attempt", replacement: { jobId: "foreign-job", attemptId: "foreign-attempt" }, receipt: {
      session_id: "bound-session", job_id: "foreign-job", attempt_id: "foreign-attempt",
    } },
    { name: "same identity", replacement: { startChannel: "replacement-start" }, receipt: {
      session_id: "bound-session", job_id: "bound-job", attempt_id: "bound-attempt",
    } },
  ];
  for (const [index, scenario] of cases.entries()) {
    const dir = await mkdtemp(join(tmpdir(), `subagent-monitor-binding-${index}-`));
    const session = `pi-subagent-binding-${process.pid}-${Date.now()}-${index}`;
    let child: ReturnType<typeof spawn> | undefined;
    try {
      await tmux(["new-session", "-d", "-s", session, "-c", dir]);
      const pane = await tmux(["list-panes", "-t", session, "-F", "#{pane_id}"]);
      const sessionFile = join(dir, "session.jsonl");
      const manifest = join(dir, "manifest.json");
      const replacement = join(dir, "replacement.json");
      await writeFile(sessionFile, JSON.stringify({ type: "session", id: "bound-session" }) + "\n");
      const base = { version: 1, jobId: "bound-job", attemptId: "bound-attempt", sessionId: "bound-session",
        mode: "dialogue", startChannel: "initial-start", startGeneration: 0, outcomeGeneration: 0 };
      await writeFile(manifest, JSON.stringify(base));
      const set = async (option: string, value: string) => tmux(["set-option", "-q", "-t", pane, option, value]);
      await set("@pi_subagent_job_id", "bound-job");
      await set("@pi_subagent_manifest", manifest);
      await set("@pi_start_generation", "1");
      await set("@pi_session_file", sessionFile);
      const markers: any[] = [];
      child = spawn(process.execPath, [monitorPath,
        monitorConfig(pane, "bound-job", "bound-attempt", 500, "bound-session", "dialogue")], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout!.setEncoding("utf8").on("data", chunk => {
        for (const line of String(chunk).split(/\r?\n/).filter(Boolean)) markers.push(JSON.parse(line));
      });
      await until(() => markers.some(marker => marker.kind === "start"));
      await writeFile(replacement, JSON.stringify({ ...base, ...scenario.replacement }));
      await set("@pi_subagent_manifest", replacement);
      await set("@pi_outcome", JSON.stringify({ ...scenario.receipt, mode: "dialogue",
        outcome: scenario.name === "same identity" ? "dialogue_settled" : "completed", source: "model", final: true,
        report_text: "" }));
      await set("@pi_outcome_generation", "1");
      await until(() => markers.some(marker => marker.kind === "final"));
      await delay(30);
      const finals = markers.filter(marker => marker.kind === "final");
      assert.equal(finals.length, 1);
      if (scenario.name === "same identity") {
        assert.equal(finals[0].outcome, "completed");
        assert.equal(finals[0].source, "model");
      } else {
        assert.equal(finals[0].jobId, "bound-job");
        assert.equal(finals[0].attemptId, "bound-attempt");
        assert.equal(finals[0].outcome, "failed");
        assert.equal(finals[0].source, "protocol");
        assert.equal(finals[0].technical, true);
      }
    } finally {
      child?.kill("SIGTERM");
      await tmux(["kill-session", "-t", session]).catch(() => {});
      await rm(dir, { recursive: true, force: true });
    }
  }
});
