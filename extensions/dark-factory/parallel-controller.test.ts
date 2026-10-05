import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildConfig } from './parallel-core.mjs';
import { ParallelController, save } from './parallel-controller.mjs';

const RUN = '11111111-1111-4111-8111-111111111111';
const OWNER = '22222222-2222-4222-8222-222222222222';
const A = 'aaaaaaaa-0000-4000-8000-000000000000', B = 'bbbbbbbb-0000-4000-8000-000000000000';
const C = 'cccccccc-0000-4000-8000-000000000000', D = 'dddddddd-0000-4000-8000-000000000000';
const field = (text: string, key: string) => new RegExp(`^${key}: (\\S+)`, 'm').exec(text)?.[1];

// Simulated seats on a simulated clock: no tmux, models or tree access.
function harness(directory: string, { dirty = false } = {}) {
  let t = 1_000_000_000_000;
  const scheduled: Array<{ at: number; run: () => void }> = [];
  const later = (ms: number, run: () => void) => scheduled.push({ at: t + ms, run });
  const policies = new Map<string, any>(), killed = new Set<string>(), messages: string[] = [];
  const outcomes = new Map<string, any>();
  let jobs = 0;
  const dispatcherReport = (statePath: string) => {
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    if (!state.tasks.length) return { version: 1, role: 'dispatcher', disposition: 'tasks', summary: 'first tasks', updated_nodes: [A, B, C, D],
      tasks: [A, B, C].map(node => ({ node_id: node, depends_on: [], scope: node })).concat([{ node_id: D, depends_on: [A, B, C], scope: D }]),
      stop_running: [], questions_for_jack: [] };
    const done = state.tasks.every((task: any) => task.status === 'worked');
    return { version: 1, role: 'dispatcher', disposition: done ? 'done' : 'tasks', summary: done ? 'acceptance met' : 'nothing new', tasks: [],
      stop_running: [], updated_nodes: [], questions_for_jack: [] };
  };
  const deps = {
    now: () => t,
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
      const receipt = { status: 'running', job, batch_id: `batch-${jobs}`, session_label: `${label}-x`, report_file: reportFile };
      if (policy.fault) later(1000, () => outcomes.set(job, { status: 'failed', source: 'technical', summary: `provider/transport failure: ${policy.fault}` }));
      else if (policy.role === 'dispatcher') later(20_000, () => {
        writeFileSync(reportFile, JSON.stringify(dispatcherReport(field(mission, 'STATE')!)));
        outcomes.set(job, { status: 'completed', source: 'model', summary: 'ok' });
      });
      else {
        const task = field(mission, 'TASK')!;
        later(task === B ? 35_000 : 30_000, () => {
          writeFileSync(reportFile, JSON.stringify({ version: 1, role: 'worker', disposition: 'worked', summary: `counted ${task}`, evidence: [],
            updated_nodes: [task], remaining_work: '', next_action: '' }));
          outcomes.set(job, { status: 'completed', source: 'model', summary: 'ok' });
        });
      }
      return receipt;
    },
    piOutcome: async (receipt: any) => {
      const outcome = outcomes.get(receipt.job);
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
  return { deps, messages };
}

function setup(faults: unknown, dispatcherEngine?: string) {
  const directory = mkdtempSync(join(tmpdir(), 'pf-controller-'));
  const luna = { provider: 'openai-codex-personal', model: 'gpt-5.6-luna', thinking: 'high' };
  const config = buildConfig({ runNode: RUN, owner: OWNER, repos: ['/repo'], directory, cwd: directory,
    overrides: { routes: { oss: luna, codex: luna, fallback: luna }, faults,
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
