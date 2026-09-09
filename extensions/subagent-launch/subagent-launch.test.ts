import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

const execFileAsync = promisify(execFile);
const { loadExtensions } = await import(pathToFileURL(join(homedir(),
  ".local/share/pi-mono/packages/coding-agent/dist/core/extensions/loader.js")).href);
const { SessionManager } = await import(pathToFileURL(join(homedir(),
  ".local/share/pi-mono/packages/coding-agent/dist/index.js")).href);
const extensionPath = fileURLToPath(new URL("../subagent-launch.ts", import.meta.url));

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
mode=$(sed -n 's/.*"mode":"\\([^\"]*\\)".*/\\1/p' "$manifest")
report=$(sed -n 's/.*"reportPath":"\\([^\"]*\\)".*/\\1/p' "$manifest")
session_file="$manifest.session.jsonl"
printf '{"fake":true}\\n' > "$session_file"
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
tmux set-option -q -t "$pane" @pi_outcome "{\\"session_id\\":\\"fake-session\\",\\"job_id\\":\\"$job\\",\\"attempt_id\\":\\"$attempt\\",\\"mode\\":\\"$mode\\",\\"outcome\\":\\"$outcome\\",\\"source\\":\\"model\\",\\"report\\":\\"$report\\",\\"session_file\\":\\"$session_file\\"}"
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
          ? { provider, id: model, reasoning: true } : undefined,
        getAvailable: () => [{ provider: "fake-provider", id: "fake-model", reasoning: true }],
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
