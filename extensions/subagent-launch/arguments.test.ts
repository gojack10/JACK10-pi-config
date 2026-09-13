import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const packages = join(homedir(), ".local/share/pi-mono/packages");
const { loadExtensions } = await import(pathToFileURL(join(packages,
  "coding-agent/dist/core/extensions/loader.js")).href);
const { validateToolArguments } = await import(pathToFileURL(join(packages,
  "ai/dist/utils/validation.js")).href);
const { extensions, errors } = await loadExtensions([
  fileURLToPath(new URL("../subagent-launch.ts", import.meta.url)),
], fileURLToPath(new URL("../../", import.meta.url)));
assert.deepEqual(errors, []);
const owner = extensions.find(extension => extension.tools.has("subagent_launch"));
assert.ok(owner);
const tool = owner.tools.get("subagent_launch")!.definition;
assert.equal(typeof tool.prepareArguments, "function");
assert.equal(owner.tools.get("subagent_followup")!.definition.prepareArguments, undefined);
const prepare = tool.prepareArguments!;
// Match Pi's preparation -> validation boundary; never call execute or launch a child.
const validate = (arguments_: unknown) => validateToolArguments(tool, {
  type: "toolCall", id: "arguments-test", name: tool.name, arguments: prepare(arguments_),
});

// Saved incident's string-valued jobs shape and shorthand route; paths sanitized.
// Schema acceptance is not route availability or permission to execute.
const saved = Object.freeze({ jobs: '[{"cwd":"/tmp","mode":"task","mission_file":"/tmp/mission.md","model":"astra","provider":"codex-personal","report_file":"/tmp/report.md","session_label":"eval-a","thinking":"xhigh"}]' });
const job = JSON.parse(saved.jobs)[0];

test("registered launch preserves native arrays and decodes a saved jobs string without mutation", () => {
  const native = Object.freeze({ jobs: Object.freeze([Object.freeze(job)]) });
  assert.equal(prepare(native), native);
  assert.deepEqual(validate(native), native);
  assert.throws(() => validateToolArguments(tool, {
    name: tool.name, arguments: saved,
  }), /jobs\.0: must be object/);
  assert.notEqual(prepare(saved), saved);
  assert.deepEqual(prepare(saved), native);
  assert.deepEqual(validate(saved), native);
  assert.equal(typeof saved.jobs, "string");
});

test("registered launch leaves malformed, non-array and double-encoded jobs for schema rejection", () => {
  for (const jobs of ["[", "null", "false", "1", "{}", JSON.stringify(job), JSON.stringify(saved.jobs)]) {
    const input = { jobs };
    assert.equal(prepare(input), input);
    assert.throws(() => validate(input), /Validation failed for tool "subagent_launch"/);
  }
  for (const input of [null, false, 1, saved.jobs, [], {}]) {
    assert.equal(prepare(input), input);
    assert.throws(() => validate(input), /Validation failed for tool "subagent_launch"/);
  }
});

test("registered launch retains array bounds and strict item/top-level validation", () => {
  for (const jobs of [
    [], Array(17).fill(job), [null], ["not an object"], [JSON.stringify(job)], [{}],
    [{ ...job, provider: "" }], [{ ...job, thinking: "auto" }], [{ ...job, mode: "other" }],
    [{ ...job, cwd: {} }], [{ ...job, extra: true }],
    ...[39, 81].map(friendly_stop_percent => [{ ...job, friendly_stop_percent }]),
  ]) {
    for (const value of [jobs, JSON.stringify(jobs)]) {
      assert.throws(() => validate({ jobs: value }), /Validation failed for tool "subagent_launch"/, JSON.stringify(value));
    }
  }
  for (const jobs of [[job], saved.jobs]) {
    assert.throws(() => validate({ jobs, extra: true }), /Validation failed for tool "subagent_launch"/);
  }
  const maximum = { jobs: Array(16).fill(job) };
  assert.deepEqual(validate({ jobs: JSON.stringify(maximum.jobs) }), maximum);
});
