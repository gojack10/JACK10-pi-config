import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

const inheritedSubagentEnv = {
  TMUX_PANE: process.env.TMUX_PANE,
  PI_SUBAGENT_MANIFEST: process.env.PI_SUBAGENT_MANIFEST,
};
delete process.env.TMUX_PANE;
delete process.env.PI_SUBAGENT_MANIFEST;
test.after(() => {
  for (const [key, value] of Object.entries(inheritedSubagentEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const execFileAsync = promisify(execFile);
const { loadExtensions } = await import(pathToFileURL(join(homedir(),
  ".local/share/pi-mono/packages/coding-agent/dist/core/extensions/loader.js")).href);
const { SessionManager } = await import(pathToFileURL(join(homedir(),
  ".local/share/pi-mono/packages/coding-agent/dist/index.js")).href);
const extensionPath = fileURLToPath(new URL("../subagent-launch.ts", import.meta.url));
const taskOutcomeExtensionPath = fileURLToPath(new URL("../task-outcomes.ts", import.meta.url));
const monitorPath = fileURLToPath(new URL("./monitor.mjs", import.meta.url));

async function tmux(args: string[]): Promise<string> {
  const result = await execFileAsync("tmux", args, { encoding: "utf8" });
  return result.stdout.trim();
}
async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 300; i++) { if (await check()) return; await delay(20); }
  assert.fail("timed out");
}

test("subagent_launch arms the shared monitor before a fake interactive child starts", { timeout: 15000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), "subagent-launch-test-"));
  const parentSession = `pi-subagent-test-${process.pid}-${Date.now()}`;
  const oldPath = process.env.PATH;
  const oldPane = process.env.TMUX_PANE;
  const fakePi = join(dir, "pi");
  await writeFile(fakePi, `#!/bin/sh
set -eu
pane="$TMUX_PANE"
manifest=$(tmux show-options -qv -t "$pane" @pi_subagent_manifest)
job=$(tmux show-options -qv -t "$pane" @pi_subagent_job_id)
attempt=$(sed -n 's/.*"attemptId":"\\([^\"]*\\)".*/\\1/p' "$manifest")
session_id=$(sed -n 's/.*"sessionId":"\\([^\"]*\\)".*/\\1/p' "$manifest")
mode=$(sed -n 's/.*"mode":"\\([^\"]*\\)".*/\\1/p' "$manifest")
report=$(sed -n 's/.*"reportPath":"\\([^\"]*\\)".*/\\1/p' "$manifest")
session_file="$manifest.session.jsonl"
session_id="actual-pi-$job"
printf '{"type":"session","id":"%s"}\\n' "$session_id" > "$session_file"
tmux set-option -q -t "$pane" @pi_session_file "$session_file"
gen=$(tmux show-options -qv -t "$pane" @pi_start_generation)
tmux set-option -q -t "$pane" @pi_start_generation $((gen + 1))
start=$(tmux show-options -qv -t "$pane" @pi_start_channel)
tmux set-option -qu -t "$pane" @pi_start_channel
tmux wait-for -S "$start"
sleep .15
if [ "$mode" = task ]; then
  printf 'fake task report\\n' > "$report"
  outcome=completed
else
  outcome=dialogue_settled
  report=
fi
channel=$(tmux show-options -qv -t "$pane" @pi_outcome_channel)
tmux set-option -q -t "$pane" @pi_outcome "{\\"session_id\\":\\"$session_id\\",\\"job_id\\":\\"$job\\",\\"attempt_id\\":\\"$attempt\\",\\"mode\\":\\"$mode\\",\\"outcome\\":\\"$outcome\\",\\"source\\":\\"model\\",\\"report\\":\\"$report\\",\\"session_file\\":\\"$session_file\\"}"
tmux set-option -q -t "$pane" @pi_outcome_generation 1
tmux wait-for -S "$channel"
sleep .5
`, { mode: 0o700 });
  await chmod(fakePi, 0o700);
  await tmux(["new-session", "-d", "-s", parentSession, "-c", dir]);
  const parentPane = await tmux(["list-panes", "-t", parentSession, "-F", "#{pane_id}"]);
  process.env.PATH = `${dir}:${oldPath ?? ""}`;
  process.env.TMUX_PANE = parentPane;
  let childSession: string | undefined;
  try {
    const { extensions, errors, runtime } = await loadExtensions([extensionPath], dir);
    assert.deepEqual(errors, []);
    const messages: Array<{ text: string; options: any }> = [];
    runtime.sendUserMessage = (text: string, options: any) => messages.push({ text, options });
    const ctx: any = {
      cwd: dir,
      mode: "tui",
      sessionManager: SessionManager.inMemory(dir),
      modelRegistry: {
        find: (provider: string, model: string) => provider === "fake-provider" && model === "fake-model"
          ? { provider, id: model, reasoning: true, thinkingLevelMap: { xhigh: "xhigh", max: "max" } } : undefined,
        getAvailable: () => [{ provider: "fake-provider", id: "fake-model", reasoning: true,
          thinkingLevelMap: { xhigh: "xhigh", max: "max" } }],
      },
    };
    const owner = extensions.find(extension => extension.tools.has("subagent_launch"));
    assert.ok(owner);
    const mission = join(dir, "mission.md");
    const report = join(dir, "report.md");
    await writeFile(mission, "Do the fake task.\n");
    const result: any = await owner.tools.get("subagent_launch")!.definition.execute("test", {
      jobs: [{ provider: "fake-provider", model: "fake-model", thinking: "xhigh", mission_file: mission,
        cwd: dir, session_label: "single", mode: "task", report_file: report }],
    }, undefined, undefined, ctx);
    assert.equal(result.details.jobs[0].status, "running");
    childSession = result.details.jobs[0].session_label;
    assert.ok(result.details.jobs[0].manifest_file);
    const childPane = await tmux(["list-panes", "-t", childSession!, "-F", "#{pane_id}"]);
    const parentId = await tmux(["display-message", "-p", "-t", parentPane, "#{session_id}"]);
    const childId = await tmux(["display-message", "-p", "-t", childPane, "#{session_id}"]);
    const rows = await tmux(["list-sessions", "-F", "#{session_id}|#{@pi_subagent_parent_id}"]);
    assert.ok(rows.split("\n").includes(`${childId}|${parentId}`));
    const boot = await readFile(await tmux(["show-options", "-qv", "-t", childPane, "@pi_subagent_boot_file"]), "utf8");
    assert.doesNotMatch(boot, /--no-extensions/);
    assert.match(boot, /--extension/);
    assert.equal(await readFile(mission, "utf8"), "Do the fake task.\n");
    await until(() => messages.length === 1);
    assert.equal(messages[0].options.deliverAs, "steer");
    assert.match(messages[0].text, new RegExp(result.details.jobs[0].job));
    assert.match(messages[0].text, /completed/);
    assert.equal(await readFile(report, "utf8"), "fake task report\n");
  } finally {
    process.env.PATH = oldPath;
    if (oldPane === undefined) delete process.env.TMUX_PANE;
    else process.env.TMUX_PANE = oldPane;
    if (childSession) await tmux(["kill-session", "-t", childSession]).catch(() => {});
    await tmux(["kill-session", "-t", parentSession]).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test("subagent_launch rejects an explicitly unsupported thinking level before tmux setup", { timeout: 5000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), "subagent-route-test-"));
  const parentSession = `pi-subagent-route-${process.pid}-${Date.now()}`;
  const oldPane = process.env.TMUX_PANE;
  await tmux(["new-session", "-d", "-s", parentSession, "-c", dir]);
  const parentPane = await tmux(["list-panes", "-t", parentSession, "-F", "#{pane_id}"]);
  process.env.TMUX_PANE = parentPane;
  try {
    const { extensions, errors, runtime } = await loadExtensions([extensionPath], dir);
    assert.deepEqual(errors, []);
    let execCalls = 0;
    runtime.exec = async () => {
      execCalls++;
      throw new Error("tmux must not run for an invalid route");
    };
    const ctx: any = {
      cwd: dir,
      mode: "tui",
      sessionManager: SessionManager.inMemory(dir),
      modelRegistry: {
        find: (provider: string, model: string) => provider === "fake-provider" && model === "unsupported-model"
          ? { provider, id: model, reasoning: true, thinkingLevelMap: { xhigh: null, max: null } } : undefined,
        getAvailable: () => [{ provider: "fake-provider", id: "unsupported-model", reasoning: true,
          thinkingLevelMap: { xhigh: null, max: null } }],
      },
    };
    const owner = extensions.find(extension => extension.tools.has("subagent_launch"));
    assert.ok(owner);
    const mission = join(dir, "mission.md");
    const report = join(dir, "report.md");
    await writeFile(mission, "Do not start this route.\n");
    await assert.rejects(
      owner.tools.get("subagent_launch")!.definition.execute("test", {
        jobs: [{ provider: "fake-provider", model: "unsupported-model", thinking: "xhigh", mission_file: mission,
          cwd: dir, session_label: "unsupported", mode: "task", report_file: report }],
      }, undefined, undefined, ctx),
      /does not support thinking level xhigh/,
    );
    assert.equal(execCalls, 0);
  } finally {
    if (oldPane === undefined) delete process.env.TMUX_PANE;
    else process.env.TMUX_PANE = oldPane;
    await tmux(["kill-session", "-t", parentSession]).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test("subagent_followup replaces the monitor while preserving the batch after settled input", { timeout: 20000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), "subagent-followup-test-"));
  const parentSession = `pi-subagent-followup-${process.pid}-${Date.now()}`;
  const oldPath = process.env.PATH;
  const oldPane = process.env.TMUX_PANE;
  const fakePi = join(dir, "pi");
  await writeFile(fakePi, `#!/bin/sh
set -eu
pane="$TMUX_PANE"
last=
count=0
while :; do
  manifest=$(tmux show-options -qv -t "$pane" @pi_subagent_manifest)
  attempt=$(sed -n 's/.*"attemptId":"\\([^\"]*\\)".*/\\1/p' "$manifest")
  session_id=$(sed -n 's/.*"sessionId":"\\([^\"]*\\)".*/\\1/p' "$manifest")
  if [ "$attempt" = "$last" ]; then sleep .02; continue; fi
  last="$attempt"
  job=$(tmux show-options -qv -t "$pane" @pi_subagent_job_id)
  mode=$(sed -n 's/.*"mode":"\\([^\"]*\\)".*/\\1/p' "$manifest")
  report=$(sed -n 's/.*"reportPath":"\\([^\"]*\\)".*/\\1/p' "$manifest")
  session_file="$manifest.session.jsonl"
  printf '{"type":"session","id":"%s"}\n' "$session_id" > "$session_file"
  tmux set-option -q -t "$pane" @pi_session_file "$session_file"
  gen=$(tmux show-options -qv -t "$pane" @pi_start_generation)
  tmux set-option -q -t "$pane" @pi_start_generation $((gen + 1))
  start=$(tmux show-options -qv -t "$pane" @pi_start_channel)
  tmux set-option -qu -t "$pane" @pi_start_channel
  tmux wait-for -S "$start"
  if [ "$count" -eq 0 ]; then
    channel=$(tmux show-options -qv -t "$pane" @pi_outcome_channel)
    tmux set-option -q -t "$pane" @pi_outcome "{\\"session_id\\":\\"$session_id\\",\\"job_id\\":\\"$job\\",\\"attempt_id\\":\\"$attempt\\",\\"mode\\":\\"$mode\\",\\"outcome\\":\\"needs_input\\",\\"source\\":\\"model\\",\\"final\\":false,\\"summary\\":\\"need a continuation\\"}"
    outcome_gen=$(tmux show-options -qv -t "$pane" @pi_outcome_generation)
    tmux set-option -q -t "$pane" @pi_outcome_generation $((outcome_gen + 1))
    tmux wait-for -S "$channel"
    settled=$(tmux show-options -qv -t "$pane" @pi_settled_generation)
    tmux set-option -q -t "$pane" @pi_settled_generation $((settled + 1))
  else
    printf 'follow-up report\\n' > "$report"
    channel=$(tmux show-options -qv -t "$pane" @pi_outcome_channel)
    tmux set-option -q -t "$pane" @pi_outcome "{\\"session_id\\":\\"$session_id\\",\\"job_id\\":\\"$job\\",\\"attempt_id\\":\\"$attempt\\",\\"mode\\":\\"$mode\\",\\"outcome\\":\\"completed\\",\\"source\\":\\"model\\",\\"final\\":true,\\"report\\":\\"$report\\"}"
    outcome_gen=$(tmux show-options -qv -t "$pane" @pi_outcome_generation)
    tmux set-option -q -t "$pane" @pi_outcome_generation $((outcome_gen + 1))
    tmux wait-for -S "$channel"
    settled=$(tmux show-options -qv -t "$pane" @pi_settled_generation)
    tmux set-option -q -t "$pane" @pi_settled_generation $((settled + 1))
    sleep .2
    exit 0
  fi
  count=$((count + 1))
done
`, { mode: 0o700 });
  await tmux(["new-session", "-d", "-s", parentSession, "-c", dir]);
  const parentPane = await tmux(["list-panes", "-t", parentSession, "-F", "#{pane_id}"]);
  process.env.PATH = `${dir}:${oldPath ?? ""}`;
  process.env.TMUX_PANE = parentPane;
  let childSession: string | undefined;
  try {
    const { extensions, errors, runtime } = await loadExtensions([extensionPath], dir);
    assert.deepEqual(errors, []);
    const messages: Array<{ text: string; options: any }> = [];
    runtime.sendUserMessage = (text: string, options: any) => messages.push({ text, options });
    const ctx: any = {
      cwd: dir,
      mode: "tui",
      sessionManager: SessionManager.inMemory(dir),
      modelRegistry: {
        find: (provider: string, model: string) => provider === "fake-provider" && model === "fake-model"
          ? { provider, id: model, reasoning: true, thinkingLevelMap: { xhigh: "xhigh", max: "max" } } : undefined,
        getAvailable: () => [{ provider: "fake-provider", id: "fake-model", reasoning: true,
          thinkingLevelMap: { xhigh: "xhigh", max: "max" } }],
      },
    };
    const owner = extensions.find(extension => extension.tools.has("subagent_launch"));
    assert.ok(owner);
    const launch = owner.tools.get("subagent_launch")!.definition;
    const followup = owner.tools.get("subagent_followup")!.definition;
    const mission = join(dir, "mission.md");
    const followupMission = join(dir, "followup.md");
    const report = join(dir, "followup-report.md");
    await writeFile(mission, "Ask for input.\n");
    await writeFile(followupMission, "Continue after input.\n");
    const first: any = await launch.execute("test", {
      jobs: [{ provider: "fake-provider", model: "fake-model", thinking: "xhigh", mission_file: mission,
        cwd: dir, session_label: "followup", mode: "task", report_file: join(dir, "initial-report.md") }],
    }, undefined, undefined, ctx);
    const firstJob = first.details.jobs[0];
    assert.equal(firstJob.status, "running");
    childSession = firstJob.session_label;
    const bg = (globalThis[Symbol.for("pi.background-jobs.manager-registry")] as WeakMap<object, any>).get(ctx.sessionManager);
    assert.ok(bg);
    await until(async () => await tmux(["show-options", "-qv", "-t", firstJob.pane_id, "@pi_settled_generation"]) === "1");
    const second: any = await followup.execute("test", {
      job_id: firstJob.job,
      session_id: firstJob.session_id,
      provider: "fake-provider",
      model: "fake-model",
      thinking: "xhigh",
      mission_file: followupMission,
      cwd: dir,
      session_label: "followup",
      mode: "task",
      report_file: report,
    }, undefined, undefined, ctx);
    assert.equal(second.details.status, "running");
    assert.equal(second.details.batch_id, firstJob.batch_id);
    assert.equal(bg.stats().jobs, 1);
    await until(() => messages.some(message => /All 1 background job/.test(message.text)));
    assert.equal(await readFile(report, "utf8"), "follow-up report\n");
  } finally {
    process.env.PATH = oldPath;
    if (oldPane === undefined) delete process.env.TMUX_PANE;
    else process.env.TMUX_PANE = oldPane;
    if (childSession) await tmux(["kill-session", "-t", childSession]).catch(() => {});
    await tmux(["kill-session", "-t", parentSession]).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test("follow-ups reject busy and finished panes without consuming fresh report paths", { timeout: 20000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), "subagent-followup-preflight-test-"));
  const parentSession = `pi-subagent-preflight-${process.pid}-${Date.now()}`;
  const oldPath = process.env.PATH;
  const oldPane = process.env.TMUX_PANE;
  const fakePi = join(dir, "pi");
  await writeFile(fakePi, `#!/bin/sh
set -eu
pane="$TMUX_PANE"
last=
count=0
while :; do
  manifest=$(tmux show-options -qv -t "$pane" @pi_subagent_manifest)
  attempt=$(sed -n 's/.*"attemptId":"\\([^\\"]*\\)".*/\\1/p' "$manifest")
  if [ "$attempt" = "$last" ]; then sleep .02; continue; fi
  last="$attempt"
  job=$(tmux show-options -qv -t "$pane" @pi_subagent_job_id)
  session_id=$(sed -n 's/.*"sessionId":"\\([^\\"]*\\)".*/\\1/p' "$manifest")
  mode=$(sed -n 's/.*"mode":"\\([^\\"]*\\)".*/\\1/p' "$manifest")
  report=$(sed -n 's/.*"reportPath":"\\([^\\"]*\\)".*/\\1/p' "$manifest")
  session_file="$manifest.session.jsonl"
  printf '{"type":"session","id":"%s"}\\n' "$session_id" > "$session_file"
  tmux set-option -q -t "$pane" @pi_session_file "$session_file"
  start_gen=$(tmux show-options -qv -t "$pane" @pi_start_generation)
  tmux set-option -q -t "$pane" @pi_start_generation $((start_gen + 1))
  start=$(tmux show-options -qv -t "$pane" @pi_start_channel)
  tmux set-option -qu -t "$pane" @pi_start_channel
  tmux wait-for -S "$start"
  if [ "$count" -eq 0 ]; then
    sleep .25
    settled=$(tmux show-options -qv -t "$pane" @pi_settled_generation)
    tmux set-option -q -t "$pane" @pi_settled_generation $((settled + 1))
  else
    printf 'follow-up report\\n' > "$report"
    channel=$(tmux show-options -qv -t "$pane" @pi_outcome_channel)
    tmux set-option -q -t "$pane" @pi_outcome "{\\"session_id\\":\\"$session_id\\",\\"job_id\\":\\"$job\\",\\"attempt_id\\":\\"$attempt\\",\\"mode\\":\\"$mode\\",\\"outcome\\":\\"completed\\",\\"source\\":\\"model\\",\\"final\\":true,\\"report\\":\\"$report\\"}"
    outcome_gen=$(tmux show-options -qv -t "$pane" @pi_outcome_generation)
    tmux set-option -q -t "$pane" @pi_outcome_generation $((outcome_gen + 1))
    tmux wait-for -S "$channel"
    settled=$(tmux show-options -qv -t "$pane" @pi_settled_generation)
    tmux set-option -q -t "$pane" @pi_settled_generation $((settled + 1))
    sleep 1
    while :; do sleep 1; done
  fi
  count=$((count + 1))
done
`, { mode: 0o700 });
  await chmod(fakePi, 0o700);
  await tmux(["new-session", "-d", "-s", parentSession, "-c", dir]);
  const parentPane = await tmux(["list-panes", "-t", parentSession, "-F", "#{pane_id}"]);
  process.env.PATH = `${dir}:${oldPath ?? ""}`;
  process.env.TMUX_PANE = parentPane;
  const reservation = (path: string) => join(tmpdir(), `pi-subagent-report-${createHash("sha256").update(path).digest("hex")}.reserve`);
  const absent = async (path: string) => assert.rejects(lstat(path), { code: "ENOENT" });
  let childSession: string | undefined;
  let retrySession: string | undefined;
  try {
    const { extensions, errors, runtime } = await loadExtensions([extensionPath], dir);
    assert.deepEqual(errors, []);
    const messages: Array<{ text: string; options: any }> = [];
    runtime.sendUserMessage = (text: string, options: any) => messages.push({ text, options });
    const ctx: any = {
      cwd: dir,
      mode: "tui",
      sessionManager: SessionManager.inMemory(dir),
      modelRegistry: {
        find: (provider: string, model: string) => provider === "fake-provider" && model === "fake-model"
          ? { provider, id: model, reasoning: true, thinkingLevelMap: { xhigh: "xhigh", max: "max" } } : undefined,
        getAvailable: () => [{ provider: "fake-provider", id: "fake-model", reasoning: true,
          thinkingLevelMap: { xhigh: "xhigh", max: "max" } }],
      },
    };
    const owner = extensions.find(extension => extension.tools.has("subagent_launch"));
    assert.ok(owner);
    const launch = owner.tools.get("subagent_launch")!.definition;
    const followup = owner.tools.get("subagent_followup")!.definition;
    const mission = join(dir, "mission.md");
    const retryMission = join(dir, "retry.md");
    const busyReport = join(dir, "busy-report.md");
    const finishedReport = join(dir, "finished-report.md");
    await writeFile(mission, "Hold the first turn.\\n");
    await writeFile(retryMission, "Continue the saved task.\\n");
    const first: any = await launch.execute("test", {
      jobs: [{ provider: "fake-provider", model: "fake-model", thinking: "xhigh", mission_file: mission,
        cwd: dir, session_label: "preflight", mode: "task", report_file: join(dir, "initial-report.md") }],
    }, undefined, undefined, ctx);
    const firstJob = first.details.jobs[0];
    assert.equal(firstJob.status, "running");
    childSession = firstJob.session_label;
    await assert.rejects(
      followup.execute("test", { job_id: firstJob.job, session_id: firstJob.session_id,
        provider: "fake-provider", model: "fake-model", thinking: "xhigh", mission_file: retryMission,
        cwd: dir, session_label: "preflight", mode: "task", report_file: busyReport }, undefined, undefined, ctx),
      /still handling its current turn/,
    );
    await absent(busyReport);
    await absent(reservation(busyReport));
    await until(async () => await tmux(["show-options", "-qv", "-t", firstJob.pane_id, "@pi_settled_generation"]) === "1");
    const second: any = await followup.execute("test", { job_id: firstJob.job, session_id: firstJob.session_id,
      provider: "fake-provider", model: "fake-model", thinking: "xhigh", mission_file: retryMission,
      cwd: dir, session_label: "preflight", mode: "task", report_file: busyReport }, undefined, undefined, ctx);
    assert.equal(second.details.status, "running");
    await until(() => messages.some(message => /All 1 background job/.test(message.text)));
    assert.equal(await readFile(busyReport, "utf8"), "follow-up report\n");
    await assert.rejects(
      followup.execute("test", { job_id: firstJob.job, session_id: firstJob.session_id,
        provider: "fake-provider", model: "fake-model", thinking: "xhigh", mission_file: retryMission,
        cwd: dir, session_label: "preflight", mode: "task", report_file: finishedReport }, undefined, undefined, ctx),
      /already has a final monitored outcome/,
    );
    await absent(finishedReport);
    await absent(reservation(finishedReport));
    const retry: any = await launch.execute("test", {
      jobs: [{ provider: "fake-provider", model: "fake-model", thinking: "xhigh", mission_file: mission,
        cwd: dir, session_label: "preflight-retry", mode: "task", report_file: finishedReport }],
    }, undefined, undefined, ctx);
    assert.equal(retry.details.jobs[0].status, "running");
    retrySession = retry.details.jobs[0].session_label;
  } finally {
    process.env.PATH = oldPath;
    if (oldPane === undefined) delete process.env.TMUX_PANE;
    else process.env.TMUX_PANE = oldPane;
    if (retrySession) await tmux(["kill-session", "-t", retrySession]).catch(() => {});
    if (childSession) await tmux(["kill-session", "-t", childSession]).catch(() => {});
    await tmux(["kill-session", "-t", parentSession]).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test("technical launcher setup failure preserves transport source for parent and batch", { timeout: 10000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), "subagent-launch-setup-failure-test-"));
  const parentSession = `pi-subagent-setup-failure-${process.pid}-${Date.now()}`;
  const oldPath = process.env.PATH;
  const oldPane = process.env.TMUX_PANE;
  const fakeTmux = join(dir, "tmux");
  const parentSessionManager = SessionManager.inMemory(dir);
  await writeFile(fakeTmux, `#!/bin/sh
printf 'setup-denied\n' >&2
exit 1
`, { mode: 0o700 });
  await chmod(fakeTmux, 0o700);
  await tmux(["new-session", "-d", "-s", parentSession, "-c", dir]);
  const parentPane = await tmux(["list-panes", "-t", parentSession, "-F", "#{pane_id}"]);
  process.env.PATH = `${dir}:${oldPath ?? ""}`;
  process.env.TMUX_PANE = parentPane;
  try {
    const { extensions, errors, runtime } = await loadExtensions([extensionPath, taskOutcomeExtensionPath], dir);
    assert.deepEqual(errors, []);
    const messages: Array<{ text: string; options: any }> = [];
    runtime.sendUserMessage = (text: string, options: any) => messages.push({ text, options });
    runtime.appendEntry = (customType: string, data: unknown) => parentSessionManager.appendCustomEntry(customType, data);
    const ctx: any = {
      cwd: dir,
      mode: "tui",
      sessionManager: parentSessionManager,
      modelRegistry: {
        find: (provider: string, model: string) => provider === "fake-provider" && model === "fake-model"
          ? { provider, id: model, reasoning: true, thinkingLevelMap: { xhigh: "xhigh" } } : undefined,
        getAvailable: () => [{ provider: "fake-provider", id: "fake-model", reasoning: true,
          thinkingLevelMap: { xhigh: "xhigh" } }],
      },
    };
    const taskExtension = extensions.find(extension => extension.tools.has("report_outcome"));
    assert.ok(taskExtension);
    await taskExtension.handlers.get("session_start")?.[0]({ reason: "startup" }, ctx);
    const parentManager = (globalThis[Symbol.for("pi.task-outcomes.manager-registry")] as WeakMap<object, any>).get(parentSessionManager);
    assert.ok(parentManager);
    parentManager.activateContract({ jobId: "parent-job", attemptId: "parent-attempt", mode: "dialogue" });
    const owner = extensions.find(extension => extension.tools.has("subagent_launch"));
    assert.ok(owner);
    const mission = join(dir, "mission.md");
    const report = join(dir, "report.md");
    await writeFile(mission, "This must not start.\\n");
    const result: any = await owner.tools.get("subagent_launch")!.definition.execute("test", {
      jobs: [{ provider: "fake-provider", model: "fake-model", thinking: "xhigh", mission_file: mission,
        cwd: dir, session_label: "setup-failure", mode: "task", report_file: report }],
    }, undefined, undefined, ctx);
    assert.equal(result.details.jobs[0].status, "setup_failed");
    const batchId = result.details.batch_id;
    const background = (globalThis[Symbol.for("pi.background-jobs.manager-registry")] as WeakMap<object, any>).get(parentSessionManager);
    assert.ok(background);
    const batchReport = background.getReport(batchId);
    assert.ok(batchReport);
    assert.equal(batchReport.completions[0].source, "transport");
    assert.match(batchReport.text, /\[transport\]/);
    const child = parentManager.snapshot().active?.childJobIds.at(-1);
    assert.ok(child);
    const childOutcome = parentManager.snapshot().active?.pendingWork;
    assert.deepEqual(childOutcome, []);
    const event = parentSessionManager.getBranch().find((entry: any) => entry.customType === "task-outcome/v1" && entry.data?.kind === "child_outcome");
    assert.equal(event?.data.source, "transport");
    assert.ok(messages.some(message => /\[transport\]/.test(message.text)));
  } finally {
    process.env.PATH = oldPath;
    if (oldPane === undefined) delete process.env.TMUX_PANE;
    else process.env.TMUX_PANE = oldPane;
    await tmux(["kill-session", "-t", parentSession]).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test("load-buffer release failure keeps transport source through monitor and parent", { timeout: 40000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "subagent-launch-release-failure-test-"));
  const parentSession = `pi-subagent-release-failure-${process.pid}-${Date.now()}`;
  const oldPath = process.env.PATH;
  const oldPane = process.env.TMUX_PANE;
  const realTmux = (await execFileAsync("which", ["tmux"], { encoding: "utf8" })).stdout.trim();
  const fakeTmux = join(dir, "tmux");
  const parentSessionManager = SessionManager.inMemory(dir);
  await writeFile(fakeTmux, `#!/bin/sh
if [ "\${1:-}" = load-buffer ]; then
  printf 'release-denied\\n' >&2
  exit 1
fi
exec ${realTmux} "$@"
`, { mode: 0o700 });
  await chmod(fakeTmux, 0o700);
  await tmux(["new-session", "-d", "-s", parentSession, "-c", dir]);
  const parentPane = await tmux(["list-panes", "-t", parentSession, "-F", "#{pane_id}"]);
  process.env.PATH = `${dir}:${oldPath ?? ""}`;
  process.env.TMUX_PANE = parentPane;
  let childSession: string | undefined;
  try {
    const { extensions, errors, runtime } = await loadExtensions([extensionPath, taskOutcomeExtensionPath], dir);
    assert.deepEqual(errors, []);
    const messages: Array<{ text: string; options: any }> = [];
    runtime.sendUserMessage = (text: string, options: any) => messages.push({ text, options });
    runtime.appendEntry = (customType: string, data: unknown) => parentSessionManager.appendCustomEntry(customType, data);
    const ctx: any = {
      cwd: dir,
      mode: "tui",
      sessionManager: parentSessionManager,
      modelRegistry: {
        find: (provider: string, model: string) => provider === "fake-provider" && model === "fake-model"
          ? { provider, id: model, reasoning: true, thinkingLevelMap: { xhigh: "xhigh" } } : undefined,
        getAvailable: () => [{ provider: "fake-provider", id: "fake-model", reasoning: true,
          thinkingLevelMap: { xhigh: "xhigh" } }],
      },
    };
    const taskExtension = extensions.find(extension => extension.tools.has("report_outcome"));
    assert.ok(taskExtension);
    await taskExtension.handlers.get("session_start")?.[0]({ reason: "startup" }, ctx);
    const parentManager = (globalThis[Symbol.for("pi.task-outcomes.manager-registry")] as WeakMap<object, any>).get(parentSessionManager);
    assert.ok(parentManager);
    parentManager.activateContract({ jobId: "parent-release-job", attemptId: "parent-release-attempt", mode: "dialogue" });
    const owner = extensions.find(extension => extension.tools.has("subagent_launch"));
    assert.ok(owner);
    const mission = join(dir, "mission.md");
    const report = join(dir, "report.md");
    await writeFile(mission, "The release must fail before paste.\\n");
    const result: any = await owner.tools.get("subagent_launch")!.definition.execute("test", {
      jobs: [{ provider: "fake-provider", model: "fake-model", thinking: "xhigh", mission_file: mission,
        cwd: dir, session_label: "release-failure", mode: "task", report_file: report }],
    }, undefined, undefined, ctx);
    const job = result.details.jobs[0];
    assert.equal(job.status, "release_failed");
    childSession = job.session_label;
    const background = (globalThis[Symbol.for("pi.background-jobs.manager-registry")] as WeakMap<object, any>).get(parentSessionManager);
    assert.ok(background);
    let batchReport: any;
    for (let i = 0; i < 1800 && !batchReport; i++) {
      batchReport = background.getReport(result.details.batch_id);
      if (!batchReport) await delay(20);
    }
    assert.ok(batchReport, "release failure batch did not settle");
    assert.equal(batchReport.completions[0].source, "transport");
    assert.match(batchReport.completions[0].summary, /release_failed: release-denied/);
    const event = parentSessionManager.getBranch().find((entry: any) => entry.customType === "task-outcome/v1" && entry.data?.kind === "child_outcome");
    assert.equal(event?.data.source, "transport");
    assert.match(event?.data.summary, /release_failed: release-denied/);
    assert.ok(messages.some(message => /\[transport\].*release_failed: release-denied/.test(message.text)));
  } finally {
    process.env.PATH = oldPath;
    if (oldPane === undefined) delete process.env.TMUX_PANE;
    else process.env.TMUX_PANE = oldPane;
    if (childSession) await tmux(["kill-session", "-t", childSession]).catch(() => {});
    await tmux(["kill-session", "-t", parentSession]).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test("monitor rejects a nonempty report symlink at final validation", { timeout: 5000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), "subagent-monitor-test-"));
  const session = `pi-subagent-monitor-${process.pid}-${Date.now()}`;
  const job = "monitor-job";
  const attempt = "monitor-attempt";
  try {
    await tmux(["new-session", "-d", "-s", session, "-c", dir]);
    const pane = await tmux(["list-panes", "-t", session, "-F", "#{pane_id}"]);
    const report = join(dir, "report.md");
    await writeFile(report, "");
    const identity = await lstat(report);
    const target = join(dir, "unrelated.md");
    await writeFile(target, "unrelated nonempty target\n");
    await unlink(report);
    await symlink(target, report);
    const sessionFile = join(dir, "session.jsonl");
    await writeFile(sessionFile, JSON.stringify({ type: "session", id: "monitor-session" }) + "\n");
    const manifest = join(dir, "manifest.json");
    await writeFile(manifest, JSON.stringify({ version: 1, jobId: job, attemptId: attempt,
      sessionId: "monitor-session", mode: "task", reportPath: report,
      reportIdentity: { dev: String(identity.dev), ino: String(identity.ino) }, activatedAt: Date.now(),
      startChannel: "unused-start", startGeneration: 0, outcomeGeneration: 0 }));
    const set = async (option: string, value: string) => tmux(["set-option", "-q", "-t", pane, option, value]);
    await set("@pi_subagent_job_id", job);
    await set("@pi_subagent_manifest", manifest);
    await set("@pi_start_generation", "1");
    await set("@pi_session_file", sessionFile);
    await set("@pi_outcome", JSON.stringify({ session_id: "monitor-session", job_id: job, attempt_id: attempt,
      mode: "task", outcome: "completed", source: "model", final: true, report }));
    await set("@pi_outcome_generation", "1");
    const result = await execFileAsync(process.execPath, [monitorPath, JSON.stringify({
      paneId: pane, manifestOption: "@pi_subagent_manifest", outcomeOption: "@pi_outcome",
      outcomeGenerationOption: "@pi_outcome_generation", startGenerationOption: "@pi_start_generation",
      sessionFileOption: "@pi_session_file", pollMs: 10, startTimeoutMs: 1000, jobId: job, attemptId: attempt,
    })], { encoding: "utf8" });
    const final = result.stdout.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)).find(value => value.kind === "final");
    assert.equal(final.outcome, "failed");
  } finally {
    await tmux(["kill-session", "-t", session]).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});
