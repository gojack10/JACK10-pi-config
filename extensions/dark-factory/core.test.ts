import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { continuationAfterStop, factoryActivity, mission, runLoop, taskRuns, taskSettings, validateReport } from './core.mjs';
import { allowedRoute, allowedTool } from './guard.ts';

const root = '11111111-1111-4111-8111-111111111111';
const project = { ...taskSettings('task', {}), root };
const report = role => ({ version: 1, role, summary: 'fixture result', evidence: [], updated_nodes: [],
  disposition: role === 'planner' ? 'next' : 'worked',
  ...(role === 'planner' ? { task: { instruction: 'read fixture', acceptance: 'exact value' } } : {}) });

test('project identity is local configuration, never a built-in private owner or contract', () => {
  assert.equal(taskSettings('task', {}).root, undefined);
  assert.deepEqual(taskSettings('sample', { sample: project }), { ...project, name: 'sample' });
  assert.throws(() => taskSettings('unknown', {}), /Unknown factory task/);
  assert.throws(() => taskSettings('../escape', {}), /Invalid factory task name/);
  assert.throws(() => taskSettings('sample', null), /Invalid factory project configuration/);
  for (const invalid of [{}, { ...project, root: 'not-a-node' }, { ...project, root: '-'.repeat(36) },
    { ...project, route: {} }, { ...project, route: { ...project.route, thinking: 'invalid' } },
    { ...project, ready: '../escape' }, { ...project, ready: 'next' }]) {
    assert.throws(() => taskSettings('sample', { sample: invalid }), /Invalid factory project configuration/);
  }
  assert.throws(() => mission({ role: 'worker', project: taskSettings('task', {}), directory: '/run' }), /SiftText instruction entry/);
  assert.equal(taskRuns('/runs'), '/runs');
  assert.equal(taskRuns('/runs', 'sample'), '/runs/sample');
  assert.throws(() => taskRuns('/runs', '../escape'), /Invalid factory task name/);
});

test('roles consult the knowledge base and separate report delivery from work completion', () => {
  for (const role of ['planner', 'worker']) for (const smoke of [false, true]) {
    const text = mission({ role, smoke, project, reportPath: '/reserved/report.json', previous: '/previous/report.json',
      directory: '/run', task: { instruction: 'bounded task' } });
    assert.match(text, /report_outcome describes delivery to the controller/);
    assert.match(text, /does NOT claim the assignment, experiment, tree persistence or project succeeded/);
    assert.match(text, /stop substantive work and tree writes immediately/);
    assert.match(text, /parsing JSON alone is not schema validation/);
    assert.match(text, /never replay completed actions or spend an already-used launch budget/);
    assert.match(text, /operator stop or narrower human authorization still limits advancement/);
    if (!smoke) {
      assert.ok(text.includes(root));
      assert.match(text, /knowledge base, not repository contract files/);
    }
    if (role === 'planner') assert.match(text, /controller dispatches only report.task/);
  }
});

test('next requires dispatch fields; readiness requires real evidence and cannot be claimed by smoke', () => {
  const base = report('planner');
  for (const task of [undefined, null, {}, { instruction: 'read' }, { acceptance: 'exact' },
    { instruction: ' ', acceptance: 'exact' }, { instruction: 'read', acceptance: ['exact'] }]) {
    assert.throws(() => validateReport(JSON.stringify({ ...base, task }), 'planner', true, project), /next requires bounded task and acceptance/);
  }
  assert.deepEqual(validateReport(JSON.stringify(base), 'planner', true, project).task, base.task);
  const ready = { ...base, disposition: project.ready, evidence: [process.cwd()] };
  assert.equal(validateReport(JSON.stringify(ready), 'planner', false, project).disposition, project.ready);
  assert.throws(() => validateReport(JSON.stringify(ready), 'planner', true, project), /ready requires/);
  assert.throws(() => validateReport(JSON.stringify({ ...ready, evidence: [] }), 'planner', false, project), /requires evidence/);
});

test('sequential handoff, continuation, STOP, invalid reports and repeated tasks remain safe', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'factory-core-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const roles = [];
  await runLoop({ directory, smoke: true, project, runStep: async ({ role, previous, task }) => {
    roles.push(role);
    if (role === 'worker') { assert.ok(previous); assert.equal(task.instruction, 'read fixture'); }
    return { text: JSON.stringify(report(role)), receipt: { job: role } };
  } });
  assert.deepEqual(roles, ['planner', 'worker']);
  assert.equal(JSON.parse(readFileSync(join(directory, 'state.json'), 'utf8')).status, 'smoke_passed');
  await assert.rejects(runLoop({ directory, smoke: true, project, runStep: () => assert.fail('replayed') }), /existing run/);
  const prior = join(directory, '1-planner.json');
  writeFileSync(prior, JSON.stringify(report('planner')));
  for (const role of ['worker', 'planner']) {
    const step = role === 'worker' ? 2 : 1;
    const checkpoint = { step, role, reportPath: prior, receipt: { job: role }, report: report(role) };
    assert.deepEqual(continuationAfterStop({ status: 'stopped', step: step + 1 }, [checkpoint]),
      { status: 'stopped', step: step + 1, role: role === 'worker' ? 'planner' : 'worker', previous: prior });
    assert.throws(() => continuationAfterStop({ status: 'stopped', step: step + 2 }, [checkpoint]), /verified checkpoint/);
  }
  const stopped = mkdtempSync(join(directory, 'stop-'));
  writeFileSync(join(stopped, 'STOP'), '');
  await runLoop({ directory: stopped, smoke: true, project, runStep: () => assert.fail('ignored STOP') });
  const repeating = mkdtempSync(join(directory, 'repeat-'));
  await assert.rejects(runLoop({ directory: repeating, project, maxSteps: 3,
    runStep: async ({ role }) => ({ text: JSON.stringify({ ...report(role), evidence: [directory] }), receipt: {} }) }), /identical task/);
  const invalid = mkdtempSync(join(directory, 'invalid-'));
  await assert.rejects(runLoop({ directory: invalid, smoke: true, project,
    runStep: async () => ({ text: '{}', receipt: {} }) }), /invalid report/);
});

test('generic task scoping and route/tool guards do not depend on a private lane', () => {
  assert.deepEqual(factoryActivity(['ordinary', 'task-worker-4-x', 'sample-worker-2-x'], ['node dark-factory/run.mjs controller /run'], '/run'),
    { sessions: ['task-worker-4-x'], controller: true });
  assert.deepEqual(factoryActivity(['task-worker-4-x', 'sample-worker-2-x'], ['node elsewhere'], '/run', 'sample'),
    { sessions: ['sample-worker-2-x'], controller: false });
  const policy = { smoke: true, report: '/tmp/result', reads: ['/tmp/input'] };
  assert.ok(allowedTool('read', { path: '/tmp/input' }, policy));
  assert.ok(allowedTool('write', { path: '/tmp/result' }, policy));
  assert.equal(allowedTool('bash', {}, policy), false);
  assert.equal(allowedTool('subagent_launch', {}, { ...policy, smoke: false }), false);
  const expected = { provider: 'openai-codex-personal', model: 'gpt-6-sol', thinking: 'xhigh' };
  const pin = { umbrella: expected.provider, accountKey: 'fixture', model: expected.model,
    actualProviderId: 'openai-codex-primary', feedGeneration: 1, routedAt: 1 };
  assert.ok(allowedRoute({ provider: pin.actualProviderId, id: expected.model }, 'xhigh', expected, pin));
  assert.equal(allowedRoute({ provider: 'openai-codex-other', id: expected.model }, 'xhigh', expected, pin), false);
});
