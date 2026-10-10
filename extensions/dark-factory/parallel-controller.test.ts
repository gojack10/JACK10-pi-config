import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildConfig, initialState, planAssignments } from './parallel-core.mjs';
import { ParallelController, save } from './parallel-controller.mjs';

const RUN = '11111111-1111-4111-8111-111111111111';
const OWNER = '22222222-2222-4222-8222-222222222222';
const A = 'aaaaaaaa-0000-4000-8000-000000000000', B = 'bbbbbbbb-0000-4000-8000-000000000000';
const C = 'cccccccc-0000-4000-8000-000000000000', D = 'dddddddd-0000-4000-8000-000000000000';
const field = (text: string, key: string) => new RegExp(`^${key}: (\\S+)`, 'm').exec(text)?.[1];

test('reconcile wake consumes old settlements without admission until a fresh task decision', async () => {
  const directory = setup({});
  try {
    const config = JSON.parse(readFileSync(join(directory, 'config.json'), 'utf8'));
    const state = initialState(config, 1);
    state.seq = 2;
    state.tasks[A] = { node_id: A, scope: A, seats: ['oss'], depends_on: [], status: 'running', continues: 0, attempts: ['1'] };
    state.order = [A];
    state.scopes[A] = [A, OWNER];
    state.seats.oss.attempt = '1';
    state.attempts['1'] = { id: '1', kind: 'worker', seat: 'oss', seat_kind: 'oss', route: config.seats[0].route,
      task: A, status: 'running', engine: 'fallback', receipt: { session_label: 'old-worker' } };
    state.attempts['2'] = { id: '2', kind: 'dispatcher', status: 'running', engine: 'fallback', events: [],
      receipt: { session_label: 'old-dispatcher' } };
    state.dispatcher.attempt = '2';
    save(join(directory, 'state.json'), state);
    mkdirSync(join(directory, 'inbox'));
    save(join(directory, 'inbox', 'wake.json'), { type: 'wake', reconcile: true, note: 'reconcile current ownership' });
    const { deps } = harness(directory);
    const controller = new ParallelController(directory, deps);
    await controller.start();
    await controller.readInbox(2);
    const worker = { kind: 'report', reportPath: '/retained-worker', report: { disposition: 'continue', summary: 'unfinished assigned check' } };
    await controller.settle(controller.state.attempts['1'], worker, 3);
    const report = { disposition: 'tasks', summary: 'old proposal partitions', tasks: [{ node_id: B, scope: B, depends_on: [], seats: ['codex-1'] }], stop_running: [] };
    await controller.settle(controller.state.attempts['2'], { kind: 'report', report, reportPath: '/retained-dispatcher' }, 4);
    assert.equal(controller.state.tasks[A].previous, '/retained-worker');
    assert.equal(controller.state.tasks[A].status, 'queued');
    assert.ok(controller.state.admission_hold);
    assert.deepEqual(planAssignments(controller.state, config, 5), []);
    controller.persist();
    const resumed = new ParallelController(directory, deps);
    await resumed.start();
    assert.ok(resumed.state.admission_hold, 'hold survives restart');
    const fresh = id => ({ id, kind: 'dispatcher', status: 'running', engine: 'fallback', events: [], receipt: { session_label: 'fresh-' + id } });
    for (const [id, outcome] of [
      ['3', { kind: 'error', summary: 'failed transport' }],
      ['4', { kind: 'report', report: { ...report, disposition: 'continue', tasks: [] }, reportPath: '/handoff' }],
      ['5', { kind: 'report', report: { ...report, tasks: [{ node_id: OWNER, scope: OWNER, depends_on: [] }] }, reportPath: '/rejected' }],
    ]) {
      resumed.state.attempts[id] = fresh(id);
      await resumed.settle(resumed.state.attempts[id], outcome, 6);
      assert.ok(resumed.state.admission_hold, 'failure/continue/rejection cannot release hold');
    }
    resumed.state.attempts['6'] = fresh('6');
    await resumed.settle(resumed.state.attempts['6'], { kind: 'report', report: { ...report, tasks: [], stop_running: [A] }, reportPath: '/fresh' }, 7);
    assert.equal(resumed.state.admission_hold, undefined);
    assert.equal(resumed.state.tasks[A].status, 'stopped');
    assert.deepEqual(planAssignments(resumed.state, config, 8), [{ seat: 'codex-1', task: B }]);
    assert.equal(resumed.state.attempts['1'].outcome.disposition, 'continue');
    assert.equal(resumed.state.attempts['2'].outcome.disposition, 'tasks');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

// Simulated seats on a simulated clock: no tmux, models or tree access.
function harness(directory: string, { dirty = false, needsInputTask, primaryRequired = false, solOnlyPlan = false }: { dirty?: boolean; needsInputTask?: string; primaryRequired?: boolean; solOnlyPlan?: boolean } = {}) {
  let t = 1_000_000_000_000;
  const scheduled: Array<{ at: number; run: () => void }> = [];
  const later = (ms: number, run: () => void) => scheduled.push({ at: t + ms, run });
  const policies = new Map<string, any>(), killed = new Set<string>(), messages: string[] = [];
  const outcomes = new Map<string, any>();
  let jobs = 0, answerQueued = false;
  const followups: any[] = [];
  const dispatcherReport = (statePath: string) => {
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    if (!state.tasks.length) return { version: 1, role: 'dispatcher', disposition: 'tasks', summary: 'first tasks', updated_nodes: [A, B, C, D],
      tasks: solOnlyPlan ? [{ node_id: A, depends_on: [], scope: A, seats: ['codex-1'] }] :
        [A, B, C].map(node => ({ node_id: node, depends_on: [], scope: node })).concat([{ node_id: D, depends_on: [A, B, C], scope: D }]),
      stop_running: [], questions_for_jack: [] };
    const done = state.tasks.every((task: any) => task.status === 'worked');
    return { version: 1, role: 'dispatcher', disposition: done ? 'done' : 'tasks', summary: done ? 'acceptance met' : 'nothing new', tasks: [],
      stop_running: [], updated_nodes: [], questions_for_jack: [] };
  };
  const deps = {
    now: () => t,
    primaryRequired: async () => primaryRequired,
    sleep: async (ms: number) => {
      t += ms;
      for (const item of scheduled.splice(0).sort((x, y) => x.at - y.at)) {
        if (item.at <= t) item.run(); else scheduled.push(item);
      }
      await new Promise(resolve => setImmediate(resolve));
    },
    writePolicy: (dir: string, policy: any) => { policies.set(dir, policy); return join(dir, 'policy.ts'); },
    launchPi: async ({ label, missionFile, reportFile }: any) => {
      const job = `job-${++jobs}`, mission = readFileSync(missionFile, 'utf8'), policy = policies.get(dirname(reportFile));
      const receipt = { status: 'running', job, batch_id: `batch-${jobs}`, session_id: `session-${jobs}`,
        session_label: `${label}-x`, report_file: reportFile };
      if (policy.fault) later(1000, () => outcomes.set(job, { status: 'failed', source: 'technical', summary: `provider/transport failure: ${policy.fault}` }));
      else if (policy.role === 'dispatcher') later(20_000, () => {
        writeFileSync(reportFile, JSON.stringify(dispatcherReport(field(mission, 'STATE')!)));
        outcomes.set(job, { status: 'completed', source: 'model', summary: 'ok' });
      });
      else {
        const task = field(mission, 'TASK')!;
        if (task === needsInputTask) later(30_000, () => outcomes.set(job, { status: 'needs_input', source: 'model', summary: `Task ${task} needs human input: choose the checked continuation` }));
        else later(task === B ? 35_000 : 30_000, () => {
          writeFileSync(reportFile, JSON.stringify({ version: 1, role: 'worker', disposition: 'worked', summary: `counted ${task}`, evidence: [],
            updated_nodes: [task], remaining_work: '', next_action: '' }));
          outcomes.set(job, { status: 'completed', source: 'model', summary: 'ok' });
        });
      }
      return receipt;
    },
    followupPi: async ({ label, route, reportFile, job: oldJob, sessionId }: any) => {
      const job = `job-${++jobs}`, receipt = { status: 'running', job, batch_id: `batch-${jobs}`, attempt_id: `followup-${jobs}`,
        session_id: sessionId, session_label: label, report_file: reportFile, route };
      followups.push({ oldJob, sessionId, label, route, reportFile, sessionWasLive: !killed.has(label) });
      later(10_000, () => {
        const task = field(readFileSync(join(dirname(reportFile), 'mission.md'), 'utf8'), 'TASK');
        writeFileSync(reportFile, JSON.stringify({ version: 1, role: 'worker', disposition: 'worked', summary: `resumed ${task}`, evidence: [],
          updated_nodes: [task], remaining_work: '', next_action: '' }));
        outcomes.set(job, { status: 'completed', source: 'model', summary: `resumed ${oldJob}` });
      });
      return receipt;
    },
    piOutcome: async (receipt: any) => {
      const outcome = outcomes.get(receipt.job);
      if (outcome?.status === 'needs_input' && !answerQueued) {
        answerQueued = true;
        later(1000, () => { mkdirSync(join(directory, 'inbox'), { recursive: true });
          save(join(directory, 'inbox', 'answer.json'), { type: 'answer', task: needsInputTask, text: 'Use the accepted checked option.' }); });
      }
      return outcome && { ...outcome, text: outcome.status === 'completed' ? readFileSync(receipt.report_file, 'utf8') : undefined };
    },
    launchClaude: async ({ model, promptFile, attemptDir, report }: any) => {
      const prompt = readFileSync(promptFile, 'utf8');
      if (model.includes('nonexistent')) later(5000, () => save(join(attemptDir, 'claude-failure.json'), { error: 'model_not_found', message: 'no model' }));
      else later(40_000, () => {
        writeFileSync(report, JSON.stringify(dispatcherReport(field(prompt, 'STATE')!)));
        save(join(attemptDir, 'claude-stop.json'), { valid: true });
      });
      return { transcript: join(attemptDir, 'none.jsonl') };
    },
    sessionAlive: async (label: string) => !killed.has(label),
    killSession: async (label: string) => { killed.add(label); },
    killSessionsWithPrefix: async () => {},
    sendToPane: async (label: string, text: string) => { messages.push(`${label}: ${text}`); },
    fence: async (repos: string[]) => repos.map(repo => ({ repo, head: 'abc', porcelain: dirty && t > 1_000_000_060_000 ? '?? stray.txt\n' : '' })),
    ancestors: async (ids: string[]) => new Map(ids.map(id => [id, [id, OWNER]])),
    statuses: async (ids: string[]) => new Map(ids.map(id => [id, 'in_progress'])),
  };
  return { deps, messages, killed, followups };
}

function setup(faults: unknown, dispatcherEngine?: string) {
  const directory = mkdtempSync(join(tmpdir(), 'pf-controller-'));
  const luna = { provider: 'openai-codex-personal', model: 'gpt-5.6-luna', thinking: 'high' };
  const config = buildConfig({ runNode: RUN, owner: OWNER, repos: ['/repo'], directory, cwd: directory,
    overrides: { codex_seats: 3, routes: { oss: luna, codex: luna, fallback: luna }, faults,
      ...(dispatcherEngine ? { dispatcher_engine: dispatcherEngine } : {}) } });
  save(join(directory, 'config.json'), { ...config, fence_heads: { '/repo': 'abc' } });
  return directory;
}
const history = (directory: string) => readFileSync(join(directory, 'history.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));

test('smoke-shaped run: parallel seats, dependency gate, seat rest, coalesced wakes, Claude fallback, done', async () => {
  const directory = setup({ seat_usage_limit: { seat: 'codex-2', launches: 1, minutes: 2 }, claude_failure: { wake: 3 } }, 'claude');
  try {
    const { deps } = harness(directory);
    const status = await new ParallelController(directory, deps).run();
    assert.equal(status, 'done');
    const rows = history(directory);
    const launches = rows.filter(row => row.type === 'worker_launch');
    const finishes = rows.filter(row => row.type === 'worker_finish');
    const span = (attempt: string) => ({ start: launches.find(row => row.attempt === attempt).t, end: finishes.find(row => row.attempt === attempt).t });
    const worked = finishes.filter(row => row.disposition === 'worked');
    assert.deepEqual(worked.map(row => row.task).sort(), [A, B, C, D]);
    const spans = worked.map(row => span(row.attempt));
    assert.ok(spans.some((x, i) => spans.some((y, j) => i !== j && x.start < y.end && y.start < x.end)), 'two workers overlapped');
    const dStart = launches.find(row => row.task === D).t;
    assert.ok(worked.filter(row => row.task !== D).every(row => row.t <= dStart), 'D started only after A, B and C finished');
    const rested = rows.find(row => row.type === 'seat_rested');
    assert.equal(rested.seat, 'codex-2');
    assert.ok(worked.some(row => row.task === rested.task && row.seat !== 'codex-2'), 'rested task completed elsewhere');
    const wakes = rows.filter(row => row.type === 'dispatcher_launch');
    assert.ok(wakes.some(row => row.events.length >= 2), 'events coalesced into one wake');
    const failed = rows.find(row => row.type === 'dispatcher_finish' && row.engine === 'claude' && row.outcome === 'error');
    assert.ok(failed && rows.some(row => row.type === 'dispatcher_launch' && row.engine === 'fallback' && row.t >= failed.t), 'Codex fallback after Claude failure');
    assert.equal(rows.filter(row => row.type === 'dispatcher_finish').at(-1).disposition, 'done');
    assert.ok(rows.filter(row => row.type === 'fence_check').every(row => row.clean));
    assert.equal(rows.filter(row => row.type === 'dispatcher_launch' && row.engine === 'claude').length >= 3, true);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('default dispatcher uses Pi on every wake and after resume without launching Claude', async () => {
  const directory = setup({});
  try {
    const { deps } = harness(directory);
    const launches: any[] = [];
    const launchPi = deps.launchPi;
    deps.launchPi = async args => { launches.push(args); return launchPi(args); };
    deps.launchClaude = async () => { throw Error('Claude must not launch'); };
    assert.equal(await new ParallelController(directory, deps).run(), 'done');
    mkdirSync(join(directory, 'inbox'));
    save(join(directory, 'inbox', 'wake.json'), { type: 'wake', note: 'resume' });
    assert.equal(await new ParallelController(directory, deps).run(), 'done');
    const dispatchers = history(directory).filter(row => row.type === 'dispatcher_launch');
    assert.ok(dispatchers.length > 1);
    assert.ok(dispatchers.every(row => row.engine === 'fallback'));
    const route = JSON.parse(readFileSync(join(directory, 'config.json'), 'utf8')).dispatcher.fallback;
    const piDispatchers = launches.filter(args => args.label.includes('-dispatch-'));
    assert.equal(piDispatchers.length, dispatchers.length);
    assert.ok(piDispatchers.every(args => JSON.stringify(args.route) === JSON.stringify(route)));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('needs_input pauses admissions, preserves the worker, and resumes the same route after an explicit answer', async () => {
  const directory = setup({});
  try {
    const { deps, messages, followups } = harness(directory, { needsInputTask: A });
    assert.equal(await new ParallelController(directory, deps).run(), 'done');
    const rows = history(directory);
    const waiting = rows.find(row => row.type === 'worker_needs_input');
    const resumed = rows.find(row => row.type === 'worker_input_accepted');
    const finish = rows.find(row => row.type === 'worker_finish' && row.task === A);
    assert.ok(waiting && resumed && finish);
    assert.equal(finish.disposition, 'worked');
    assert.equal(followups.length, 1);
    const launch = rows.find(row => row.type === 'worker_launch' && row.task === A);
    assert.equal(followups[0].oldJob, rows.find(row => row.type === 'worker_started' && row.attempt === launch.attempt).job);
    assert.equal(followups[0].sessionWasLive, true);
    assert.equal(followups[0].route.model, 'gpt-5.6-luna');
    assert.deepEqual(JSON.parse(readFileSync(join(directory, 'state.json'), 'utf8')).awaiting_input, []);
    assert.ok(!messages.some(message => message.includes('FACTORY CONTROLLER: stop now')));
    assert.equal(rows.some(row => row.type === 'worker_launch' && row.task === C && row.t > waiting.t && row.t < resumed.t), false,
      'no new task is admitted before the primary receives its answer');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('mandatory-primary RUN rejects Sol-only orders instead of starting them', async () => {
  const directory = setup({});
  try {
    const { deps } = harness(directory, { primaryRequired: true, solOnlyPlan: true });
    assert.equal(await new ParallelController(directory, deps).run(), 'needs_attention');
    const rows = history(directory);
    assert.equal(rows.filter(row => row.type === 'worker_launch').length, 0);
    assert.ok(rows.some(row => row.type === 'dispatcher_finish' && /active OSS primary contribution/.test(row.rejected?.[A] ?? '')));
    assert.equal(JSON.parse(readFileSync(join(directory, 'state.json'), 'utf8')).primary_required, true);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('a dirty read-only repository stops the run as needs_attention and asks running workers to report', async () => {
  const directory = setup({}, 'claude');
  try {
    const { deps, messages } = harness(directory, { dirty: true });
    const status = await new ParallelController(directory, deps).run();
    assert.equal(status, 'needs_attention');
    const rows = history(directory);
    assert.ok(rows.some(row => row.type === 'attention' && /read-only repository changed/.test(row.reason)));
    assert.ok(messages.length >= 1, 'running workers were told to stop');
    assert.equal(rows.filter(row => row.type === 'worker_launch' && row.t > rows.find(r => r.type === 'attention').t).length, 0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

for (const codexSeats of [3, 4, 6]) test(`saved two-seat blocked run resumes with ${codexSeats + 1} real seats without resetting retained state`, async () => {
  const directory = setup({});
  try {
    const config = JSON.parse(readFileSync(join(directory, 'config.json'), 'utf8'));
    const saved = initialState({ ...config, seats: config.seats.slice(0, 2) }, 100);
    config.seats = buildConfig({ runNode: RUN, owner: OWNER, directory, cwd: directory,
      overrides: { codex_seats: codexSeats, routes: { oss: config.seats[0].route, codex: config.seats[1].route } } }).seats;
    save(join(directory, 'config.json'), config);
    const tasks = Array.from({ length: codexSeats + 1 }, (_, i) => `${String(i + 1).padStart(8, '0')}-0000-4000-8000-000000000000`);
    Object.assign(saved, { status: 'blocked', seq: 139 });
    saved.seats.oss.launches = 33;
    saved.seats['codex-1'].launches = 21;
    saved.seats['codex-1'].resting_until = 999;
    saved.dispatcher.wakes = 85;
    saved.dispatcher.last = { disposition: 'blocked', at: 99, attempt: '139' };
    saved.attempts['139'] = { id: '139', kind: 'dispatcher', status: 'finished', report: '/retained/report.json',
      receipt: { job: 'retained-job', attempt_id: 'retained-attempt' } };
    for (const [i, id] of tasks.entries()) {
      saved.tasks[id] = { node_id: id, scope: id, seats: [config.seats[i].id], depends_on: [], status: 'queued',
        continues: 2, attempts: ['retained-worker'], previous: '/retained/previous.json' };
      saved.scopes[id] = [id, OWNER];
      saved.order.push(id);
    }
    const retained = 'eeeeeeee-0000-4000-8000-000000000000';
    saved.tasks[retained] = { node_id: retained, status: 'worked', seats: ['oss'], attempts: ['135'],
      last_report: '/retained/worker-report.json', code: { files: ['src/owned.rs'], worktree: '/retained/draft',
        branch: 'retained-branch', base: 'a'.repeat(40), candidate: 'b'.repeat(40), phase: 'landed' } };
    saved.order.push(retained);
    saved.attempts['135'] = { id: '135', kind: 'worker', seat: 'oss', task: retained, status: 'finished',
      report: '/retained/worker-report.json', receipt: { job: 'retained-worker-job', attempt_id: 'retained-worker-attempt' } };
    save(join(directory, 'state.json'), saved);
    const { deps } = harness(directory);
    const controller = new ParallelController(directory, deps);
    await controller.start();
    const expected = structuredClone(saved);
    expected.status = 'running';
    expected.primary_required = false;
    for (const seat of config.seats.slice(2)) expected.seats[seat.id] = { attempt: null, resting_until: null, launches: 0 };
    assert.deepEqual(JSON.parse(readFileSync(join(directory, 'state.json'), 'utf8')), expected);
    assert.deepEqual(planAssignments(controller.state, config, deps.now()), [], 'blocked dispatcher still guards admission');
    await controller.start();
    assert.deepEqual(controller.state.seats, expected.seats, 'reconciliation is idempotent');
    mkdirSync(join(directory, 'inbox'));
    save(join(directory, 'inbox', 'wake.json'), { type: 'wake', note: 'approved pool expansion' });
    await controller.tick();
    await Promise.all(controller.inflight);
    assert.equal(controller.state.dispatcher.attempt, '140', 'fresh dispatcher owns task selection');
    assert.deepEqual(controller.state.attempts['139'], saved.attempts['139']);
    for (let i = 0; i < 21; i++) { await deps.sleep(1000); await controller.tick(); }
    await Promise.all(controller.inflight);
    const launches = history(directory).filter(row => row.type === 'worker_started');
    assert.equal(launches.length, codexSeats + 1, 'all configured worker seats actually start');
    assert.deepEqual(Object.values(controller.state.attempts).filter((a: any) => a.kind === 'worker' && a.status === 'running').map((a: any) => a.seat),
      config.seats.map((s: any) => s.id));
    assert.deepEqual(Object.values(controller.state.seats).map((s: any) => s.launches), [34, 22, ...Array(codexSeats - 1).fill(1)]);
    assert.deepEqual(controller.state.tasks[retained], saved.tasks[retained]);
    assert.deepEqual(controller.state.attempts['135'], saved.attempts['135']);
    for (const id of tasks) {
      assert.equal(controller.state.tasks[id].previous, saved.tasks[id].previous);
      assert.equal(controller.state.tasks[id].continues, 2);
      assert.equal(controller.state.tasks[id].attempts[0], 'retained-worker');
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('seat resume preserves active ownership and refuses destructive pools or changed unresolved routes before writes', async () => {
  const directory = setup({});
  try {
    const config = JSON.parse(readFileSync(join(directory, 'config.json'), 'utf8'));
    const saved = initialState({ ...config, seats: config.seats.slice(0, 2) }, 100);
    saved.seq = 12;
    saved.seats.oss = { launches: 7, attempt: '12', resting_until: 999 };
    saved.tasks[A] = { node_id: A, status: 'running', attempts: ['12'], code: { worktree: '/retained', base: 'base' } };
    saved.attempts['12'] = { id: '12', kind: 'worker', status: 'running', task: A, seat: 'oss', seat_kind: 'oss',
      route: config.seats[0].route, receipt: { job: 'owned-job', attempt_id: 'owned-attempt' } };
    const { deps } = harness(directory);
    save(join(directory, 'state.json'), saved);
    const controller = new ParallelController(directory, deps);
    await controller.start();
    assert.deepEqual(controller.state.seats.oss, saved.seats.oss);
    assert.deepEqual(controller.state.tasks, saved.tasks);
    assert.deepEqual(controller.state.attempts, saved.attempts);
    for (const invalid of [
      { ...config, seats: config.seats.filter((s: any) => s.id !== 'codex-1') },
      { ...config, seats: [...config.seats, config.seats[0]] },
      { ...config, seats: [...config.seats, { id: 'codex-7', kind: 'codex', route: config.seats[1].route }] },
      { ...config, seats: config.seats.map((s: any) => s.id === 'oss' ? { ...s, route: { ...s.route, thinking: 'low' } } : s) },
    ]) {
      save(join(directory, 'config.json'), invalid);
      save(join(directory, 'state.json'), saved);
      const before = readFileSync(join(directory, 'state.json'), 'utf8');
      await assert.rejects(new ParallelController(directory, deps).start(), /cannot be removed|duplicate|route cannot change|invalid configured seat/);
      assert.equal(readFileSync(join(directory, 'state.json'), 'utf8'), before);
    }
    save(join(directory, 'config.json'), config);
    saved.attempts['12'].seat = 'codex-2';
    save(join(directory, 'state.json'), saved);
    await assert.rejects(new ParallelController(directory, deps).start(), /has no saved seat/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('wake and stop arrive through the inbox; resume continues the retained state', async () => {
  const directory = setup({});
  try {
    const { deps } = harness(directory);
    mkdirSync(join(directory, 'inbox'));
    save(join(directory, 'inbox', '1-stop.json'), { type: 'stop', now: false });
    assert.equal(await new ParallelController(directory, deps).run(), 'stopped');
    const before = JSON.parse(readFileSync(join(directory, 'state.json'), 'utf8'));
    assert.equal(before.dispatcher.wakes, 0);
    assert.equal(await new ParallelController(directory, deps).run(), 'done');
    assert.ok(history(directory).some(row => row.type === 'controller_resumed' && row.previous === 'stopped'));
    save(join(directory, 'inbox', '2-wake.json'), { type: 'wake', note: 'jack' });
    assert.equal(await new ParallelController(directory, deps).run(), 'done');
    assert.ok(existsSync(join(directory, 'state.json')));
    assert.ok(history(directory).some(row => row.type === 'dispatcher_launch' && row.events.includes('human_wake') && row.t > before.created_at));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
