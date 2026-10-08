import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realpathSync } from 'node:fs';
import * as P from './parallel-core.mjs';
import { ParallelController } from './parallel-controller.mjs';

const RUN = '11111111-1111-4111-8111-111111111111', OWNER = '22222222-2222-4222-8222-222222222222';
const TASK = 'aaaaaaaa-0000-4000-8000-000000000000', NODE = 'bbbbbbbb-0000-4000-8000-000000000000';

const packet = (overrides = {}) => ({
  task: TASK, fence: ['src/rows.rs'], observer: 'rows-observe',
  sources: [{ node: NODE, revision: '2026-10-08T07:07:49.752787+00:00', clause: 'A row lists each descendant once in sibling order.' }],
  cases: [{ input: { rows: [] }, expected_output: { rows: [] } }, { input: 'not json', expect_nonzero: true }],
  limits: 'Finite pure cases; not concurrency or publication evidence.',
  ...overrides,
});
const review = { sources_read: [NODE], challenges: [{ input: { rows: [1, 2] }, expected_output: { rows: [2, 1] } }], rationale: 'Author omitted multi-row order.' };

function ready() { return realpathSync(mkdtempSync(join(tmpdir(), 'factory-setup-'))); }

// The controller supplies its own runtime directory; use the same shape the code tests use.
function controller(directory) {
  const config = P.buildConfig({ runNode: RUN, owner: OWNER, cwd: directory, directory, overrides: { codex_seats: 1 } });
  mkdirSync(join(directory, 'attempts'), { recursive: true });
  writeFileSync(join(directory, 'config.json'), JSON.stringify(config));
  const ctl = new ParallelController(directory, { now: () => 1000, sleep: async () => {}, primaryRequired: async () => false });
  ctl.state = P.initialState(config, 1000);
  return ctl;
}

async function propose(ctl, body, session = 'author-session') {
  const attempt = P.startAttempt(ctl.state, { kind: 'dispatcher', engine: 'fallback', events: [] });
  attempt.dir = join(ctl.dir, 'attempts', `d${attempt.id}`);
  mkdirSync(attempt.dir, { recursive: true });
  attempt.setup_packet = join(attempt.dir, 'setup-packet.json');
  attempt.receipt = { session_id: session };
  writeFileSync(attempt.setup_packet, JSON.stringify(body));
  await ctl.setupTransition(attempt, { task: TASK, action: 'propose', packet: attempt.setup_packet }, 2000);
  return attempt;
}

test('a check packet is data, reviewed by another session, then registered with its challenges', async () => {
  const directory = ready();
  try {
    const ctl = controller(directory);
    await propose(ctl, packet());
    const pending = ctl.state.setup;
    assert.equal(pending.task, TASK);
    assert.match(pending.proposal_hash, /^[0-9a-f]{64}$/);
    assert.ok(ctl.state.wake, 'review needs the next fresh dispatcher');
    const snapshot = readFileSync(pending.packet, 'utf8');
    assert.match(snapshot, /sibling order/, 'the proposal is snapshotted outside the attempt directory');

    // Same session cannot approve its own proposal.
    const same = P.startAttempt(ctl.state, { kind: 'dispatcher', engine: 'fallback', events: [] });
    same.dir = join(ctl.dir, 'attempts', `d${same.id}`); mkdirSync(same.dir, { recursive: true });
    same.setup_packet = join(same.dir, 'setup-packet.json'); same.receipt = { session_id: 'author-session' };
    writeFileSync(same.setup_packet, JSON.stringify(review));
    await ctl.setupTransition(same, { task: TASK, action: 'review', packet: same.setup_packet, proposal_hash: pending.proposal_hash, verdict: 'approve' }, 3000);
    assert.equal(ctl.state.checks[pending.check], undefined, 'self-review must not register');

    // A fresh reviewer registers proposal plus its own challenges.
    const other = P.startAttempt(ctl.state, { kind: 'dispatcher', engine: 'fallback', events: [] });
    other.dir = join(ctl.dir, 'attempts', `d${other.id}`); mkdirSync(other.dir, { recursive: true });
    other.setup_packet = join(other.dir, 'setup-packet.json'); other.receipt = { session_id: 'reviewer-session' };
    writeFileSync(other.setup_packet, JSON.stringify(review));
    await ctl.setupTransition(other, { task: TASK, action: 'review', packet: other.setup_packet, proposal_hash: pending.proposal_hash, verdict: 'approve' }, 4000);
    const registered = ctl.state.checks[pending.check];
    assert.equal(registered.cases.length, 3, 'author cases plus reviewer challenges');
    assert.equal(registered.reviewer, 'reviewer-session');
    assert.equal(ctl.state.setup, null);
    assert.ok(ctl.state.pending_events.some(event => event.type === 'check_registered'));

    // Admission binds to a registered check only.
    const order = { node_id: TASK, scope: TASK, depends_on: [], checks: [pending.check] };
    assert.ok(ctl.state.checks[order.checks[0]]);
    assert.throws(() => P.validateDispatcherReport(JSON.stringify({ version: 1, role: 'dispatcher', disposition: 'tasks', summary: 'x',
      tasks: [{ ...order, checks: ['not-a-registered-id'] }], stop_running: [], updated_nodes: [], questions_for_jack: [] })), /registered check IDs/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('unverified setup requests are refused with the exact reason', async () => {
  const directory = ready();
  try {
    const ctl = controller(directory);
    // No clause citation.
    await propose(ctl, { ...packet(), sources: [] });
    assert.equal(ctl.state.setup, null);
    assert.match(ctl.state.pending_events.at(-1).reason, /must cite at least one governing clause/);
    // No rejecting control.
    await propose(ctl, { ...packet(), cases: [{ input: 1, expected_output: 1 }] });
    assert.match(ctl.state.pending_events.at(-1).reason, /needs positive cases and a rejecting control/);
    // Model-authored executable is not a packet.
    await propose(ctl, { ...packet(), argv: ['/bin/sh', '-c', 'true'] });
    assert.match(ctl.state.pending_events.at(-1).reason, /exactly task, fence, observer, sources, cases and limits/);
    // A proposal snapshot that changes after proposal cannot be registered.
    await propose(ctl, packet());
    const pending = ctl.state.setup;
    writeFileSync(pending.packet, JSON.stringify(packet({ limits: 'tampered' })));
    const other = P.startAttempt(ctl.state, { kind: 'dispatcher', engine: 'fallback', events: [] });
    other.dir = join(ctl.dir, 'attempts', `d${other.id}`); mkdirSync(other.dir, { recursive: true });
    other.setup_packet = join(other.dir, 'setup-packet.json'); other.receipt = { session_id: 'reviewer-2' };
    writeFileSync(other.setup_packet, JSON.stringify(review));
    await ctl.setupTransition(other, { task: TASK, action: 'review', packet: other.setup_packet, proposal_hash: pending.proposal_hash, verdict: 'approve' }, 5000);
    assert.equal(ctl.state.checks[pending.check], undefined);
    assert.match(ctl.state.pending_events.at(-1).reason, /snapshot changed/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('recovery resumes only provably quiet assignments', async () => {
  const directory = ready();
  try {
    const ctl = controller(directory);
    const unsafe = ['bbbbbbbb-0000-4000-8000-000000000001','bbbbbbbb-0000-4000-8000-000000000002','bbbbbbbb-0000-4000-8000-000000000003','bbbbbbbb-0000-4000-8000-000000000004','bbbbbbbb-0000-4000-8000-000000000005','bbbbbbbb-0000-4000-8000-000000000006'];
    const add = (id: string, status: string, extra = {}) => { ctl.state.tasks[id] = { node_id: id, status, scope: id, depends_on: [],
      continues: 2, attempts: [], code: { worktree: `/wt/${id}`, phase: 'develop', candidate: null }, ...extra }; ctl.state.order.push(id); };
    add(TASK, 'errored');
    add(unsafe[0], 'running');
    add(unsafe[1], 'stopped');
    add(unsafe[2], 'worked');
    add(unsafe[3], 'merge_queued');
    add(unsafe[4], 'blocked');
    add(unsafe[5], 'blocked');
    ctl.state.merge = { task: unsafe[5] };
    P.startAttempt(ctl.state, { kind: 'worker', seat: 'oss', seat_kind: 'oss', task: unsafe[4] });
    ctl.state.attempts[Object.keys(ctl.state.attempts).at(-1)].status = 'ambiguous';

    await ctl.applyRecoveries([{ node_id: TASK, reason: 'settled transport loss, draft drained' },
      { node_id: unsafe[0], reason: 'live' },
      { node_id: unsafe[1], reason: 'cancelled' },
      { node_id: unsafe[2], reason: 'accepted' },
      { node_id: unsafe[3], reason: 'pending publication' },
      { node_id: unsafe[4], reason: 'ambiguous attempt' },
      { node_id: unsafe[5], reason: 'reservation held' },
      { node_id: 'missing-missing-missing-missing-missingmissing', reason: 'unknown' }], 5000);

    assert.equal(ctl.state.tasks[TASK].status, 'queued');
    assert.equal(ctl.state.tasks[TASK].front, true);
    assert.equal(ctl.state.tasks[TASK].continues, 0, 'recovery must not inherit the old continue count');
    assert.equal(ctl.state.tasks[TASK].code.worktree, `/wt/${TASK}`, 'recovery resumes the retained draft identity');
        for (const id of unsafe) assert.notEqual(ctl.state.tasks[id].status, 'queued', id + ' must not be requeued');
    const refused = ctl.state.pending_events.filter(event => event.type === 'recovery_refused').map(event => event.task);
    assert.equal(refused.length, 7, 'every unsafe or unknown recovery is refused with a reason');
    assert.ok(ctl.state.pending_events.some(event => event.type === 'task_requeued' && event.task === TASK));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
