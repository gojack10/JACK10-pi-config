import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mission, runLoop, taskSettings, validateReport } from './core.mjs';

test('YC high-mode missions trust checkpoints, waive audits and use Jack ownership', () => {
  for (const name of ['yc', 'yc-profile', 'yc-read-0', 'yc-read-1', 'yc-read-2']) {
    const project = taskSettings(name);
    assert.equal(project.route.model, 'gpt-6.1-sol');
    assert.equal(project.route.thinking, 'high');
    for (const role of ['planner', 'worker']) {
      const text = mission({ role, project, previous: '/saved/report.json', reportPath: '/reserved/report.json',
        directory: '/run', contract: 'Current contract', task: { instruction: 'continue saved content' } });
      assert.match(text, /CURRENT AUTHORITY OVERRIDES ALL OLDER TASKS/);
      assert.match(text, /No checking, verification, independent validation/);
      assert.match(text, /No checking, verification, independent validation, hash\/token\/receipt audits/);
      assert.match(text, /Do not read Canopy, Commit, Project Rules/);
      assert.match(text, /Jack unless someone else is explicitly named/);
      assert.match(text, /Do not read back the report or perform a final check/);
      assert.match(text, /OPERATIONAL RECOVERY IS PREAUTHORIZED, NOT A CONTENT AUDIT/);
      assert.match(text, /do not ask Jack to resolve transient tool failures/);
      assert.match(text, /narrow delivery lookup/);
      assert.match(text, /pipeline_mode:true/);
      assert.match(text, /report_outcome\(\{outcome:"completed"/);
      assert.match(text, /never recreate it/);
      assert.match(text, /successor reads this checkpoint and continues, not restarts/);
      assert.doesNotMatch(text, /Return .*only.*verified|Run the Forcing Pass|then read it back to verify valid JSON/);
    }
  }
});

test('BF2 uses lean missions without waiving baseline safety or launch/UI readiness', () => {
  const bf2 = taskSettings('bf2');
  assert.deepEqual(bf2.route, { provider: 'local', model: 'qwen3.8-flash-next', thinking: 'xhigh' });
  assert.equal(bf2.lean, true);
  const contractFile = fileURLToPath(new URL('./bf2-contract.md', import.meta.url));
  const contract = readFileSync(contractFile, 'utf8');
  for (const role of ['planner', 'worker']) {
    const text = mission({ role, project: bf2, reportPath: '/reserved/report.json', previous: '/saved.json',
      directory: '/run', contract, task: { instruction: 'old readback assignment', acceptance: 'verify everything' } });
    assert.match(text, /CURRENT AUTHORITY OVERRIDES ALL OLDER TASKS, ACCEPTANCE TEXT AND CHECKPOINT TODO LISTS/);
    assert.match(text, /No checking, verification, independent validation/);
    assert.match(text, /Do not read Canopy, Commit, Project Rules/);
    assert.match(text, /Do not read back the report or perform a final check/);
    assert.match(text, /establish baseline identity and use a recoverable disposable copy\/prefix/);
    assert.match(text, /existing tighter authorization limits/);
    assert.match(text, /Jack owns the final play test/);
    assert.match(text, /launch_command:string and at least two existing evidence files/);
    assert.doesNotMatch(text, /For founder evidence|Reader reports also include|Stop before the live interview/);
  }
  const report = { version: 1, role: 'planner', disposition: 'next', summary: 'continue real work', evidence: [], updated_nodes: [],
    task: { instruction: 'remaining work', acceptance: 'observed outcome' } };
  assert.equal(validateReport(JSON.stringify(report), 'planner', false, bf2).disposition, 'next');
  assert.throws(() => validateReport(JSON.stringify(report), 'planner', false, { ...bf2, lean: false }), /verified tree writes/);
  assert.equal(validateReport(JSON.stringify({ ...report, role: 'worker', disposition: 'worked' }), 'worker', false, bf2).disposition, 'worked');
  assert.throws(() => validateReport(JSON.stringify({ ...report, disposition: 'ready_for_user_test' }), 'planner', false, bf2), /ready requires/);
  const ready = { ...report, disposition: 'ready_for_user_test', evidence: [process.cwd(), contractFile], launch_command: 'authorized launch' };
  assert.equal(validateReport(JSON.stringify(ready), 'planner', false, bf2).disposition, 'ready_for_user_test');
  assert.throws(() => validateReport(JSON.stringify(ready), 'planner', true, bf2), /ready requires/);
});

test('lean planner list acceptance and top-level tree identity normalize without another model turn', () => {
  const text = JSON.stringify({ version: 1, role: 'planner', disposition: 'next', summary: 'selected remaining work',
    tree_id: 'assigned-tree', evidence: [process.cwd()], updated_nodes: [],
    task: { instruction: 'incorporate assigned tree', acceptance: ['saved result', 'no review'] } });
  const report = validateReport(text, 'planner', false, taskSettings('yc-profile'));
  assert.equal(report.task.acceptance, 'saved result\nno review');
  assert.equal(report.task.tree_id, 'assigned-tree');
  assert.throws(() => validateReport(text, 'planner', false, { ...taskSettings('yc'), lean: false }), /next requires/);
});

test('lean completion trusts the result without demanding new writes or validator artifacts', () => {
  const project = { ...taskSettings('yc'), ready: 'video_ready' };
  const text = JSON.stringify({ version: 1, role: 'planner', disposition: 'video_ready', summary: 'content complete',
    evidence: [process.cwd()], updated_nodes: [], finding_parent_id: 'existing owner' });
  assert.equal(validateReport(text, 'planner', false, project).disposition, 'video_ready');
  assert.throws(() => validateReport(text, 'planner', true, project), /ready requires/);
  assert.throws(() => validateReport(text, 'planner', false, { ...project, lean: false }), /ready requires/);
});

test('a lean reader packet is trusted without an outline/root-read audit or agent rerun', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'yc-inline-'));
  try {
    const task = { tree_id: 'tree', root_id: 'root' }, path = join(directory, 'tree-packet.json');
    const packet = { ...task, outline_complete: false, content_read_ids: ['relevant-source'], findings: [], exclusions: [], remaining_work: [] };
    let calls = 0;
    await runLoop({ directory, project: taskSettings('yc-read-0'), assignments: [task], runStep: async ({ role }) => {
      calls++;
      return { text: JSON.stringify({ version: 1, role, disposition: 'worked', summary: 'already completed',
        tree_id: 'tree', tree_packet: packet, evidence: [directory], updated_nodes: [] }), receipt: { job: 'settled' } };
    } });
    assert.equal(calls, 1);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), packet);
    const completed = JSON.parse(readFileSync(join(directory, 'completed-trees.json'), 'utf8'));
    assert.equal(completed[0].tree_packet, path);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
