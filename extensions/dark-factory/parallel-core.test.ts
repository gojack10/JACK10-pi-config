import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  addEvent, buildConfig, dispatcherEngine, finishDispatcher, finishWorker, initialState, overlaps, ossIdle, parseRunNode,
  planAssignments, startAttempt, takeEvents, terminalStatus, usageLimit, validateDispatcherReport, validateWorkerReport,
} from './parallel-core.mjs';

const RUN = '11111111-1111-4111-8111-111111111111';
const OWNER = '22222222-2222-4222-8222-222222222222';
const id = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
const config = () => buildConfig({ runNode: RUN, owner: OWNER, repos: [], directory: '/run', cwd: '/home' });
const scopes = (...ids: string[]) => Object.fromEntries(ids.map(node => [node, [node, OWNER]]));
const dispatched = (tasks: Array<{ node_id: string; depends_on: string[]; scope: string }>, disposition = 'tasks') =>
  ({ kind: 'report', report: validateDispatcherReport({ version: 1, role: 'dispatcher', disposition, summary: 's', tasks,
    stop_running: [], updated_nodes: [], questions_for_jack: disposition === 'blocked' ? ['q'] : [] }) });

test('RUN parsing takes only the labelled OWNER and read-only repository lines', () => {
  const text = `- OWNER: [[Extract Contracts|${OWNER}]]. Tasks follow...
- Read-only repository: \`~/projects/example\`, pinned at \`abcdef0\` (clean). Never modify it.
- Read-only evidence trees: [[Code Ideas|${id(3)}@${RUN}]]`;
  const parsed = parseRunNode(text);
  assert.equal(parsed.owner, OWNER);
  assert.deepEqual(parsed.repos, ['~/projects/example']);
  assert.equal(parseRunNode(`- OWNER: the child named Census (node \`${id(4)}\`).`).owner, id(4));
});

test('config fills OSS first and allows per-run route overrides', () => {
  const luna = { provider: 'openai-codex-personal', model: 'gpt-5.6-luna', thinking: 'high' };
  const c = buildConfig({ runNode: RUN, owner: OWNER, directory: '/r', cwd: '/h', overrides: { routes: { oss: luna, codex: luna, fallback: luna } } });
  assert.deepEqual(c.seats.map(seat => seat.id), ['oss', 'codex-1', 'codex-2', 'codex-3']);
  assert.ok(c.seats.every(seat => seat.route.model === 'gpt-5.6-luna'));
  assert.equal(c.dispatcher.fallback.model, 'gpt-5.6-luna');
  const defaults = buildConfig({ runNode: RUN, owner: OWNER, directory: '/r', cwd: '/h' });
  assert.equal(defaults.seats[0].route.model, 'qwen3.8-flash-next');
  assert.equal(defaults.dispatcher.engine, 'fallback');
  assert.deepEqual(defaults.dispatcher.fallback, { provider: 'openai-codex-personal', model: 'gpt-6.1-sol', thinking: 'high' });
  assert.throws(() => buildConfig({ runNode: RUN, owner: OWNER, directory: '/r', cwd: '/h', overrides: { dispatcher_engine: 'typo' } }), /dispatcher_engine/);
});

test('dispatcher reports follow the role-node schema', () => {
  const base = { version: 1, role: 'dispatcher', disposition: 'tasks', summary: 'x', tasks: [{ node_id: id(1), depends_on: [], scope: id(1) }] };
  assert.equal(validateDispatcherReport(JSON.stringify(base)).tasks.length, 1);
  for (const bad of [
    { ...base, role: 'worker' }, { ...base, disposition: 'next' }, { ...base, summary: '' },
    { ...base, tasks: [{ node_id: 'x', depends_on: [], scope: id(1) }] },
    { ...base, tasks: [{ node_id: id(1), depends_on: [id(1)], scope: id(1) }] },
    { ...base, tasks: [{ node_id: id(1), depends_on: [], scope: id(1) }, { node_id: id(1), depends_on: [], scope: id(2) }] },
    { ...base, disposition: 'done' },
    { ...base, disposition: 'blocked', tasks: [] },
  ]) assert.throws(() => validateDispatcherReport(JSON.stringify(bad)));
  assert.equal(validateDispatcherReport({ ...base, disposition: 'blocked', tasks: [], questions_for_jack: ['which?'] }).disposition, 'blocked');
  assert.throws(() => validateDispatcherReport('not json'), /not valid JSON/);
});

test('worker reports follow the role-node schema', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pf-worker-'));
  try {
    const file = join(dir, 'evidence.txt');
    writeFileSync(file, 'x');
    const base = { version: 1, role: 'worker', disposition: 'worked', summary: 'done', evidence: [file], updated_nodes: [id(1)], remaining_work: '', next_action: '' };
    assert.equal(validateWorkerReport(JSON.stringify(base)).disposition, 'worked');
    assert.equal(validateWorkerReport({ ...base, evidence: [], remaining_work: undefined, next_action: undefined }).next_action, '');
    for (const bad of [{ ...base, evidence: ['relative'] }, { ...base, evidence: [join(dir, 'missing')] }, { ...base, updated_nodes: ['x'] },
      { ...base, disposition: 'continue' }, { ...base, disposition: 'next' }]) assert.throws(() => validateWorkerReport(bad));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('usage limits parse their stated reset, else rest 30 minutes', () => {
  const now = Date.UTC(2026, 9, 5, 12, 0, 0);
  assert.equal(usageLimit('You have hit your ChatGPT usage limit (plus plan). Try again in ~42 min.', now)?.resetAt, now + 42 * 60_000);
  assert.equal(usageLimit('provider/transport failure: usage_limit_reached', now)?.resetAt, now + 30 * 60_000);
  const claude = usageLimit("rate_limit: You've hit your limit · resets 3pm (America/Los_Angeles)", now)!;
  assert.ok(claude.resetAt > now && claude.resetAt <= now + 24 * 3600_000);
  assert.equal(new Date(claude.resetAt).getHours(), 15);
  assert.equal(usageLimit('model_not_found: no such model', now), undefined);
  assert.equal(usageLimit('network error', now), undefined);
});

test('scopes overlap through ancestry; unknown ancestry overlaps conservatively', () => {
  const tree = { [id(1)]: [id(1), OWNER], [id(2)]: [id(2), id(1), OWNER], [id(3)]: [id(3), OWNER] };
  assert.equal(overlaps(id(1), id(2), tree), true);
  assert.equal(overlaps(id(2), id(3), tree), false);
  assert.equal(overlaps(id(3), id(9), tree), true);
});

test('seat filling is OSS first, dependency-aware and keeps write scopes disjoint', () => {
  const c = config(), s = initialState(c, 0);
  Object.assign(s.scopes, scopes(id(1), id(2), id(3), id(4)));
  s.scopes[id(5)] = [id(5), id(1), OWNER];
  finishDispatcher(s, startAttempt(s, { kind: 'dispatcher', engine: 'claude', events: takeEvents(s) }).id, dispatched([
    { node_id: id(1), depends_on: [], scope: id(1) },
    { node_id: id(5), depends_on: [], scope: id(5) },
    { node_id: id(2), depends_on: [], scope: id(2) },
    { node_id: id(3), depends_on: [], scope: id(3) },
    { node_id: id(4), depends_on: [id(1), id(2), id(3)], scope: id(4) },
  ]), 1);
  const plan = planAssignments(s, c, 2);
  assert.deepEqual(plan, [{ seat: 'oss', task: id(1) }, { seat: 'codex-1', task: id(2) }, { seat: 'codex-2', task: id(3) }]);
});

test('worker outcomes: worked, continue handoff, third continue, usage-limit rest and requeue', () => {
  const c = config(), s = initialState(c, 0);
  Object.assign(s.scopes, scopes(id(1), id(2)));
  finishDispatcher(s, startAttempt(s, { kind: 'dispatcher', engine: 'claude', events: takeEvents(s) }).id,
    dispatched([{ node_id: id(1), depends_on: [], scope: id(1) }, { node_id: id(2), depends_on: [], scope: id(2) }]), 1);
  const worker = (seat: string, task: string) => startAttempt(s, { kind: 'worker', seat, seat_kind: seat === 'oss' ? 'oss' : 'codex', task });
  const report = (disposition: string) => ({ kind: 'report', report: { disposition }, reportPath: `/r/${disposition}.json` });

  finishWorker(s, worker('codex-2', id(2)).id, { kind: 'usage_limit', resetAt: 5000, reason: 'limit' }, 10);
  assert.equal(s.seats['codex-2'].resting_until, 5000);
  assert.equal(s.tasks[id(2)].status, 'queued');
  assert.equal(s.pending_events.length, 0, 'capacity is not a dispatcher event');
  assert.deepEqual(planAssignments(s, c, 20).map(a => a.seat), ['oss', 'codex-1']);

  for (let i = 1; i <= 3; i++) {
    finishWorker(s, worker('oss', id(1)).id, report('continue'), 100 + i);
    assert.equal(s.tasks[id(1)].continues, i);
    assert.equal(s.tasks[id(1)].previous, '/r/continue.json');
  }
  assert.equal(s.tasks[id(1)].status, 'needs_split');
  assert.deepEqual(s.pending_events.map(event => event.type), ['task_continued_three_times']);
  finishWorker(s, worker('codex-1', id(2)).id, report('worked'), 200);
  assert.equal(s.tasks[id(2)].status, 'worked');
  assert.equal(s.wake, true);
});

test('one dispatcher at a time; failures hand the same events to a fallback dispatcher', () => {
  const c = config(), s = initialState(c, 0);
  addEvent(s, { type: 'human_wake' }, 0);
  const first = startAttempt(s, { kind: 'dispatcher', engine: dispatcherEngine(s, 0), events: takeEvents(s) });
  addEvent(s, { type: 'task_finished', task: id(1) }, 1);
  addEvent(s, { type: 'task_finished', task: id(2) }, 2);
  assert.equal(s.dispatcher.attempt, first.id);
  finishDispatcher(s, first.id, dispatched([]), 3);
  const events = takeEvents(s);
  assert.deepEqual(events.map(event => event.task), [id(1), id(2)], 'coalesced into one wake');
  const second = startAttempt(s, { kind: 'dispatcher', engine: dispatcherEngine(s, 4), events });
  assert.equal(second.engine, 'claude');
  finishDispatcher(s, second.id, { kind: 'error', summary: 'model_not_found' }, 5);
  assert.equal(dispatcherEngine(s, 6), 'fallback');
  const third = startAttempt(s, { kind: 'dispatcher', engine: 'fallback', events: takeEvents(s) });
  assert.deepEqual(third.events.map(event => event.task), [id(1), id(2)]);
  finishDispatcher(s, third.id, dispatched([], 'done'), 7);
  assert.equal(dispatcherEngine(s, 8), 'claude');
  assert.equal(terminalStatus(s, c, 9), 'done');
  finishDispatcher(s, startAttempt(s, { kind: 'dispatcher', engine: 'claude', events: [] }).id, { kind: 'usage_limit', resetAt: 100 }, 10);
  assert.equal(dispatcherEngine(s, 50), 'fallback');
  assert.equal(dispatcherEngine(s, 100), 'claude');
});

test('an idle OSS seat wakes the dispatcher once, never while a wake is already due', () => {
  const c = config(), s = initialState(c, 0);
  assert.equal(ossIdle(s, c, 0, []), false, 'start-up wake already covers the idle seat');
  s.oss_idle_emitted = false;
  addEvent(s, { type: 'task_finished' }, 1);
  assert.equal(ossIdle(s, c, 1, []), false);
  takeEvents(s);
  assert.equal(ossIdle(s, c, 2, []), true);
  takeEvents(s);
  assert.equal(ossIdle(s, c, 3, []), false);
});

test('rejected tasks never enter the queue; stop_running marks running tasks obsolete', () => {
  const c = config(), s = initialState(c, 0);
  Object.assign(s.scopes, scopes(id(1)));
  finishDispatcher(s, startAttempt(s, { kind: 'dispatcher', engine: 'claude', events: [] }).id,
    dispatched([{ node_id: id(1), depends_on: [], scope: id(1) }]), 1);
  const w = startAttempt(s, { kind: 'worker', seat: 'oss', seat_kind: 'oss', task: id(1) });
  const effects = finishDispatcher(s, startAttempt(s, { kind: 'dispatcher', engine: 'claude', events: [] }).id,
    { kind: 'report', report: { ...dispatched([{ node_id: id(7), depends_on: [], scope: id(7) }]).report, stop_running: [id(1)] } }, 2,
    new Map([[id(7), 'outside the write fence']]));
  assert.deepEqual(effects.rejected, [id(7)]);
  assert.equal(s.tasks[id(7)], undefined);
  assert.equal(s.tasks[id(1)].stop_requested, 'obsolete');
  finishWorker(s, w.id, { kind: 'report', report: { disposition: 'continue' }, reportPath: '/r/c.json' }, 3);
  assert.equal(s.tasks[id(1)].status, 'stopped');
});

test('repeated provider failures rest seats and requeue, then reach the dispatcher on the third', () => {
  const c = config(), s = initialState(c, 0);
  Object.assign(s.scopes, scopes(id(1)));
  finishDispatcher(s, startAttempt(s, { kind: 'dispatcher', engine: 'claude', events: takeEvents(s) }).id,
    dispatched([{ node_id: id(1), depends_on: [], scope: id(1) }]), 1);
  const fail = (seat: string, at: number) => finishWorker(s, startAttempt(s, { kind: 'worker', seat, seat_kind: seat === 'oss' ? 'oss' : 'codex', task: id(1) }).id,
    { kind: 'provider_failure', resetAt: at + 1000, summary: 'provider/transport failure: connection refused' }, at);
  fail('oss', 10);
  assert.equal(s.seats.oss.resting_until, 1010);
  assert.equal(s.tasks[id(1)].status, 'queued');
  assert.deepEqual(planAssignments(s, c, 20), [{ seat: 'codex-1', task: id(1) }]);
  fail('codex-1', 30);
  assert.equal(s.pending_events.length, 0);
  fail('codex-2', 40);
  assert.equal(s.tasks[id(1)].status, 'errored');
  assert.equal(s.seats['codex-2'].resting_until, null, 'the third failure is a task problem, not seat capacity');
  assert.deepEqual(s.pending_events.map(event => event.type), ['task_errored']);
});
