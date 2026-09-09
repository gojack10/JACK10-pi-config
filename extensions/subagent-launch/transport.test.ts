import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
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
  for (let i = 0; i < 300; i++) { if (await check()) return; await delay(10); }
  assert.fail("timed out");
}

test("launcher carries a terminal transport outcome through the shared batch manager", { timeout: 15000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), "subagent-transport-launch-test-"));
  const parentSession = `pi-subagent-transport-launch-${process.pid}-${Date.now()}`;
  const oldPath = process.env.PATH;
  const oldPane = process.env.TMUX_PANE;
  const fakePi = join(dir, "pi");
  await writeFile(fakePi, `#!/bin/sh
set -eu
pane="$TMUX_PANE"
manifest=$(tmux show-options -qv -t "$pane" @pi_subagent_manifest)
job=$(sed -n 's/.*"jobId":"\\([^\"]*\\)".*/\\1/p' "$manifest")
attempt=$(sed -n 's/.*"attemptId":"\\([^\"]*\\)".*/\\1/p' "$manifest")
session_id=$(sed -n 's/.*"sessionId":"\\([^\"]*\\)".*/\\1/p' "$manifest")
session_file="$manifest.session.jsonl"
printf '{"fake":true}\\n' > "$session_file"
tmux set-option -q -t "$pane" @pi_session_file "$session_file"
gen=$(tmux show-options -qv -t "$pane" @pi_start_generation)
tmux set-option -q -t "$pane" @pi_start_generation $((gen + 1))
start=$(tmux show-options -qv -t "$pane" @pi_start_channel)
tmux set-option -qu -t "$pane" @pi_start_channel
tmux wait-for -S "$start"
sleep .05
channel=$(tmux show-options -qv -t "$pane" @pi_outcome_channel)
tmux set-option -q -t "$pane" @pi_outcome "{\\"session_id\\":\\"$session_id\\",\\"job_id\\":\\"$job\\",\\"attempt_id\\":\\"$attempt\\",\\"mode\\":\\"dialogue\\",\\"outcome\\":\\"transport_lost\\",\\"source\\":\\"transport\\",\\"final\\":false,\\"summary\\":\\"child transport ended\\"}"
tmux set-option -q -t "$pane" @pi_outcome_generation 1
tmux wait-for -S "$channel"
sleep .1
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
    await writeFile(mission, "Report transport evidence.\n");
    const result: any = await owner.tools.get("subagent_launch")!.definition.execute("test", {
      jobs: [{ provider: "fake-provider", model: "fake-model", thinking: "xhigh", mission_file: mission,
        cwd: dir, session_label: "transport", mode: "dialogue" }],
    }, undefined, undefined, ctx);
    assert.equal(result.details.jobs[0].status, "running");
    childSession = result.details.jobs[0].session_label;
    await until(() => messages.length === 1);
    assert.match(messages[0].text, /child transport ended/);
    assert.match(messages[0].text, /\[transport\]/);
    assert.doesNotMatch(messages[0].text, /protocol_incomplete/);
    const background = (globalThis[Symbol.for("pi.background-jobs.manager-registry")] as WeakMap<object, any>)
      .get(ctx.sessionManager);
    assert.equal(background.getReport(result.details.batch_id).completions[0].source, "transport");
  } finally {
    process.env.PATH = oldPath;
    if (oldPane === undefined) delete process.env.TMUX_PANE;
    else process.env.TMUX_PANE = oldPane;
    if (childSession) await tmux(["kill-session", "-t", childSession]).catch(() => {});
    await tmux(["kill-session", "-t", parentSession]).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});
