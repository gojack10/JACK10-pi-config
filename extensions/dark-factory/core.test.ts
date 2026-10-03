import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { factoryActivity, runLoop, taskRuns, taskSettings, validateReport } from './core.mjs';
import { allowedRoute, allowedTool } from './guard.ts';

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
    const retry = directory();
    const prior = join(retry, '1-planner.json');
    writeFileSync(prior, JSON.stringify(report('planner')));
    writeFileSync(join(retry, 'state.json'), JSON.stringify({ status: 'error', step: 2 }));
    await runLoop({ directory: retry, smoke: true, resume: { step: 2, previous: prior, task: report('planner').task },
      runStep: async ({ step, role, previous, task }) => {
        assert.equal(step, 2); assert.equal(role, 'worker'); assert.equal(previous, prior); assert.equal(task.instruction, 'read fixture');
        return { text: JSON.stringify(report(role)), receipt: { job: role } };
      } });
    assert.equal(JSON.parse(readFileSync(join(retry, 'state.json'), 'utf8')).status, 'smoke_passed');
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
    const real = { ...policy, smoke: false };
    assert.ok(allowedTool('bash_bg', {}, real));
    assert.equal(allowedTool('subagent_launch', {}, real), false);
    assert.deepEqual(factoryActivity(['ordinary', 'bf2-worker-4-x', 'yc-worker-2-x'], ['node dark-factory/run.mjs controller /run'], '/run'),
      { sessions: ['bf2-worker-4-x'], controller: true });
    assert.deepEqual(factoryActivity(['bf2-worker-4-x', 'yc-worker-2-x'], ['node elsewhere'], '/run', 'yc'),
      { sessions: ['yc-worker-2-x'], controller: false });
    assert.deepEqual(factoryActivity(['ordinary'], ['node elsewhere'], '/run'), { sessions: [], controller: false });
    assert.equal(validateReport(JSON.stringify({ version: 1, role: 'worker', disposition: 'worked',
      summary: 'directory evidence', evidence: [root], updated_nodes: ['00000000-0000-0000-0000-000000000000'] }), 'worker').summary,
      'directory evidence');
    const yc = taskSettings('yc');
    assert.deepEqual(yc.route, { provider: 'openai-codex-personal', model: 'gpt-6-sol', thinking: 'xhigh' });
    assert.equal(taskRuns('/runs', 'bf2'), '/runs');
    assert.equal(taskRuns('/runs', 'yc'), '/runs/yc');
    assert.throws(() => taskSettings('unknown'), /Unknown factory task/);
    assert.equal(validateReport(JSON.stringify({ version: 1, role: 'worker', disposition: 'worked',
      summary: 'artifact only', evidence: [root], updated_nodes: [] }), 'worker', false, yc).summary, 'artifact only');
    assert.throws(() => validateReport(JSON.stringify({ version: 1, role: 'planner', disposition: 'ready_for_interview',
      summary: 'not ready', evidence: [root], updated_nodes: [] }), 'planner', false, yc), /ready requires/);
    assert.equal(validateReport(JSON.stringify({ version: 1, role: 'planner', disposition: 'ready_for_interview',
      summary: 'ready', evidence: [root, dir], updated_nodes: ['00000000-0000-0000-0000-000000000000'] }),
      'planner', false, yc).disposition, 'ready_for_interview');
    const expected = { provider: 'openai-codex-personal', model: 'gpt-6-sol', thinking: 'xhigh' };
    const pin = { umbrella: expected.provider, accountKey: 'personal', model: expected.model,
      actualProviderId: 'openai-codex-primary', feedGeneration: 1, routedAt: Date.now(), workClass: 'long' as const };
    assert.ok(allowedRoute({ provider: pin.actualProviderId, id: expected.model }, 'xhigh', expected, pin));
    assert.equal(allowedRoute({ provider: pin.actualProviderId, id: expected.model }, 'high', expected, pin), false);
    assert.equal(allowedRoute({ provider: 'openai-codex-other', id: expected.model }, 'xhigh', expected, pin), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
