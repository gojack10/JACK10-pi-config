import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runLoop, validateReport } from './core.mjs';
import { allowedTool } from './guard.ts';

const report = role => ({ version: 1, role, summary: 'checked', evidence: [], updated_nodes: [],
  disposition: role === 'planner' ? 'next' : 'worked', ...(role === 'planner' ? { task: { instruction: 'read fixture', acceptance: 'exact value' } } : {}) });

test('sequential planner/worker handoff, STOP, invalid reports and repeat detection', async () => {
  const root = mkdtempSync(join(tmpdir(), 'factory-check-'));
  const directory = () => mkdtempSync(join(root, 'run-'));
  try {
    let active = 0; const roles = []; const dir = directory();
    await runLoop({ directory: dir, smoke: true, runStep: async ({ role, previous, task }) => {
      assert.equal(active++, 0);
      if (role === 'worker') { assert.ok(previous); assert.equal(task.instruction, 'read fixture'); }
      await new Promise(r => setTimeout(r, 5));
      roles.push(role); active--;
      return { text: JSON.stringify(report(role)), receipt: { job: role } };
    } });
    assert.deepEqual(roles, ['planner', 'worker']);
    assert.equal(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')).status, 'smoke_passed');
    await assert.rejects(runLoop({ directory: dir, smoke: true, runStep: () => assert.fail('replayed') }), /existing run/);
    const stop = directory(); writeFileSync(join(stop, 'STOP'), '');
    await runLoop({ directory: stop, smoke: true, runStep: () => assert.fail('ignored STOP') });
    await assert.rejects(runLoop({ directory: directory(), smoke: false, maxSteps: 3,
      runStep: async ({ role }) => ({ text: JSON.stringify({ ...report(role), updated_nodes: ['00000000-0000-0000-0000-000000000000'] }), receipt: {} }) }), /identical task/);
    let calls = 0;
    await assert.rejects(runLoop({ directory: directory(), smoke: true,
      runStep: async () => { calls++; return { text: '{}', receipt: {} }; } }), /invalid report/);
    assert.equal(calls, 1);
    assert.throws(() => validateReport(JSON.stringify({ ...report('planner'), disposition: 'ready_for_user_test', updated_nodes: ['00000000-0000-0000-0000-000000000000'] }), 'planner'), /ready requires/);
    const policy = { smoke: true, report: '/tmp/result', reads: ['/tmp/input'] };
    assert.ok(allowedTool('read', { path: '/tmp/input' }, policy));
    assert.ok(allowedTool('write', { path: '/tmp/result' }, policy));
    for (const name of ['bash', 'edit', 'sifttext_crystallize_append', 'subagent_launch']) assert.equal(allowedTool(name, {}, policy), false);
    assert.equal(allowedTool('write', { path: '/tmp/not-report' }, policy), false);
    assert.equal(allowedTool('read', { path: '/tmp/not-input' }, policy), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
