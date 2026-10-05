import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { continuationAfterStop, factoryActivity, mission, runLoop, taskRuns, taskSettings, validateReport } from './core.mjs';
import { allowedRoute, allowedTool } from './guard.ts';

test('every factory role separates report delivery from work completion and preserves handoff safety', () => {
  for (const name of ['bf2', 'yc', 'yc-profile', 'yc-read-0']) {
    for (const role of ['planner', 'worker']) {
      for (const smoke of [false, true]) {
        const text = mission({ role, smoke, project: { ...taskSettings(name), lean: false }, reportPath: '/reserved/report.json',
          previous: '/previous/report.json', directory: '/run', contract: 'contract', task: { instruction: 'bounded task' } });
        assert.match(text, /report_outcome describes delivery to the controller/);
        assert.match(text, /does NOT claim the assignment, experiment, tree persistence or project succeeded/);
        assert.match(text, /stop substantive work and tree writes immediately/);
        assert.match(text, /then read it back to verify valid JSON/);
        assert.match(text, /report_outcome\(\{outcome:"completed"/);
        assert.match(text, /unfinished reconciliation at the context limit -> disposition:"continue" \+ outcome:"completed"/);
        assert.match(text, /missing required permission with a valid blocker report -> disposition:"blocked" \+ outcome:"completed"/);
        assert.match(text, /never replay completed actions or spend an already-used launch budget/);
        assert.match(text, /operator stop or narrower human authorization still limits advancement/);
        assert.match(text, /controller dispatches only report.task/);
        assert.match(text, /parsing JSON alone is not schema validation/);
        assert.match(text, /repair the JSON from existing work—do not repeat the research or tree writes/);
        if (role === 'planner') assert.match(text, /"task": \{\s*"instruction":.*\s*"acceptance":/);
      }
    }
  }
});

const report = role => ({ version: 1, role, summary: 'checked', evidence: [], updated_nodes: [],
  disposition: role === 'planner' ? 'next' : 'worked', ...(role === 'planner' ? { task: { instruction: 'read fixture', acceptance: 'exact value' } } : {}) });

test('next needs its nested dispatch fields even when the assignment is present in prose', () => {
  const base = { ...report('planner'), summary: 'Chosen task: read the fixture; acceptance: exact value.' };
  for (const task of [undefined, null, {}, { instruction: 'read' }, { acceptance: 'exact' },
    { instruction: ' ', acceptance: 'exact' }, { instruction: 'read', acceptance: '' },
    { instruction: 'read', acceptance: ['exact'] }]) {
    assert.throws(() => validateReport(JSON.stringify({ ...base, task }), 'planner', true), /next requires bounded task and acceptance/);
  }
  assert.deepEqual(validateReport(JSON.stringify(base), 'planner', true).task, base.task);
  assert.equal(validateReport(JSON.stringify({ ...base, task: undefined, disposition: 'continue' }), 'planner', true).disposition, 'continue');
});

test('resume preserves a rejected planner report as evidence without dispatching its prose', () => {
  const home = mkdtempSync(join(tmpdir(), 'factory-planner-recovery-'));
  try {
    const base = join(home, '.pi/agent/factory-runs'), directory = join(base, 'retained'), bin = join(home, 'bin');
    mkdirSync(directory, { recursive: true }); mkdirSync(bin);
    writeFileSync(join(bin, 'tmux'), '#!/bin/sh\nexit 0\n', { mode: 0o700 }); // No live tmux/model launch.
    writeFileSync(join(base, 'LAST'), directory);
    const previous = join(directory, '35-worker.json');
    writeFileSync(previous, JSON.stringify(report('worker')));
    writeFileSync(join(directory, 'state.json'), JSON.stringify({ status: 'error', step: 36, role: 'planner', previous }));
    writeFileSync(join(directory, 'config.json'), JSON.stringify({ smoke: true, cwd: home, project: taskSettings(), contract: 'fixture' }));
    const rejected = { ...report('planner'), summary: 'Existing landed assignment; do not replay writes.', task: undefined };
    writeFileSync(join(directory, '36-planner.json'), JSON.stringify(rejected));
    const output = JSON.parse(execFileSync(process.execPath, [fileURLToPath(new URL('./run.mjs', import.meta.url)), 'resume', 'bf2'],
      { encoding: 'utf8', env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` } }));
    const resume = JSON.parse(readFileSync(join(directory, 'config.json'), 'utf8')).resume;
    assert.equal(output.resumed_step, 38);
    assert.equal(resume.role, 'planner');
    assert.equal(resume.task, null);
    assert.equal(resume.previous, join(output.failure_evidence, '36-planner.json'));
    assert.equal(readFileSync(resume.previous, 'utf8'), JSON.stringify(rejected));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

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
    for (const role of ['worker', 'planner']) {
      const step = role === 'worker' ? 2 : 1;
      const checkpoint = { step, role, reportPath: prior, receipt: { job: role }, report: report(role) };
      assert.deepEqual(continuationAfterStop({ status: 'stopped', step: step + 1 }, [checkpoint]),
        { status: 'stopped', step: step + 1, role: role === 'worker' ? 'planner' : 'worker', previous: prior });
      assert.throws(() => continuationAfterStop({ status: 'stopped', step: step + 2 }, [checkpoint]), /verified checkpoint/);
    }
    assert.throws(() => continuationAfterStop({ status: 'stopped', step: 1 }, []), /verified checkpoint/);
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
    assert.ok(allowedTool('read', { path: '/tmp/result' }, policy)); // Report read-back is permitted.
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
    assert.deepEqual(yc.route, { provider: 'openai-codex-personal', model: 'gpt-6.1-sol', thinking: 'high' });
    assert.equal(taskRuns('/runs', 'bf2'), '/runs');
    assert.equal(taskRuns('/runs', 'yc'), '/runs/yc');
    assert.throws(() => taskSettings('unknown'), /Unknown factory task/);
    assert.equal(validateReport(JSON.stringify({ version: 1, role: 'worker', disposition: 'worked',
      summary: 'artifact only', evidence: [root], updated_nodes: [] }), 'worker', false, yc).summary, 'artifact only');
    assert.throws(() => validateReport(JSON.stringify({ version: 1, role: 'planner', disposition: 'ready_for_interview',
      summary: 'not ready', evidence: [root], updated_nodes: [] }), 'planner', false, { ...yc, lean: false }), /ready requires/);
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
