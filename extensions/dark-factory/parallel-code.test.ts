import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as P from './parallel-core.mjs';
import * as G from './parallel-code.mjs';
import { ParallelController, save } from './parallel-controller.mjs';
import { installParallelGuard } from './parallel-guard.ts';

const RUN = '11111111-1111-4111-8111-111111111111', OWNER = '22222222-2222-4222-8222-222222222222';
const A = 'aaaaaaaa-0000-4000-8000-000000000000', B = 'bbbbbbbb-0000-4000-8000-000000000000';
const artifacts = join(dirname(fileURLToPath(import.meta.url)), '../../factory-runs/dark-factory-controller-tests');
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const field = (text: string, key: string) => new RegExp(`^${key}: (.+)$`, 'm').exec(text)?.[1];
function fixture() {
  mkdirSync(artifacts, { recursive: true });
  const directory = realpathSync(mkdtempSync(join(artifacts, 'git-fixture-')));
  const repo = join(directory, 'main'), root = join(directory, 'worktrees');
  mkdirSync(repo); mkdirSync(root);
  git(repo, 'init', '-b', 'main'); git(repo, 'config', 'user.name', 'Fixture'); git(repo, 'config', 'user.email', 'fixture@invalid');
  writeFileSync(join(repo, 'shared.txt'), 'original\n'); writeFileSync(join(repo, 'law.txt'), 'frozen\n');
  git(repo, 'add', '.'); git(repo, 'commit', '-m', 'fixture: initialize');
  const code = { repo, worktree_root: root, main_branch: 'main', main_head: git(repo, 'rev-parse', 'HEAD'),
    allowed_paths: ['shared.txt', 'draft.txt'], frozen_paths: ['law.txt'],
    candidate_checks: [[process.execPath, '-e', 'if (!require("fs").readFileSync("law.txt", "utf8").includes("frozen")) process.exit(1)']],
    main_checks: [[process.execPath, '-e', 'if (!/[AB]/.test(require("fs").readFileSync("shared.txt", "utf8"))) process.exit(1)']] };
  const config = P.buildConfig({ runNode: RUN, owner: OWNER, cwd: directory, directory,
    overrides: { code, codex_seats: 1 } });
  save(join(directory, 'config.json'), config);
  return { directory, repo, config, code, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}
const order = (id: string, seat: string) => ({ node_id: id, depends_on: [], scope: id, seats: [seat], code: { files: ['shared.txt', 'draft.txt'] } });
const dispatch = (tasks: any[], disposition = 'tasks') => ({ version: 1, role: 'dispatcher', disposition, summary: 'fixture', tasks, updated_nodes: [], questions_for_jack: [], stop_running: [] });
const report = (id: string, code: any, disposition: string) => ({ version: 1, role: 'worker', disposition, summary: 'fixture', evidence: [], updated_nodes: [id], next_action: 'resume saved draft', remaining_work: '',
  code: { worktree: code.worktree, branch: code.branch, base: code.base, candidate: code.candidate ?? null, ...(code.main ? { main: code.main } : {}) } });

// Fake launch/receipt transport with real native Git and actual controller scheduling.
// Worker actions are fixture code, not model behavior or an OS isolation claim.
function transport(f: ReturnType<typeof fixture>, options: any = {}) {
  let now = 1000, seq = 0, continued = false;
  const active = new Map<string, any>(), finished = new Map<string, any>(), launches: any[] = [];
  const conflicts: string[] = [], messages: string[] = [];
  const deps = {
    now: () => now,
    sleep: async () => { now += 1000; await new Promise(resolve => setImmediate(resolve)); },
    writePolicy: (dir: string) => join(dir, 'policy.ts'),
    launchPi: async (args: any) => {
      const mission = readFileSync(args.missionFile, 'utf8'), task = field(mission, 'TASK');
      const code = task ? JSON.parse(readFileSync(field(mission, 'CODE')!, 'utf8')) : null;
      if (task) assert.equal(args.cwd, code.worktree, 'launch uses owned private cwd');
      const job = String(++seq), receipt = { status: 'running', job, session_label: args.label, report_file: args.reportFile };
      launches.push({ task, code, receipt });
      active.set(job, { args, mission, task, code, receipt });
      return receipt;
    },
    piOutcome: async (receipt: any) => {
      if (finished.has(receipt.job)) return finished.get(receipt.job);
      const pending = active.get(receipt.job);
      if (!pending) return undefined;
      const { task, code, args, mission } = pending;
      let r;
      if (!task) {
        const snapshot = JSON.parse(readFileSync(field(mission, 'STATE')!, 'utf8'));
        r = dispatch(snapshot.tasks.length ? [] : [order(A, 'oss'), order(B, 'codex-1')],
          snapshot.tasks.length && snapshot.tasks.every((task: any) => task.status === 'worked') ? 'done' : 'tasks');
      } else if (code.phase === 'develop') {
        // Both development sessions must be launched before either returns a candidate.
        if (launches.filter(l => l.code?.phase === 'develop').length < 2) return undefined;
        if (task === A && options.continue && !continued) {
          continued = true; writeFileSync(join(code.worktree, 'draft.txt'), 'retained\n');
          if (options.stopOnContinue) {
            mkdirSync(join(f.directory, 'inbox'), { recursive: true });
            save(join(f.directory, 'inbox', 'stop.json'), { type: 'stop' });
          }
          r = report(task, code, 'continue');
        } else {
          if (task === A && options.continue) assert.equal(readFileSync(join(code.worktree, 'draft.txt'), 'utf8'), 'retained\n');
          writeFileSync(join(code.worktree, 'shared.txt'), `${task === A ? 'A' : 'B'}\n`);
          git(code.worktree, 'add', 'shared.txt', ...(existsSync(join(code.worktree, 'draft.txt')) ? ['draft.txt'] : []));
          git(code.worktree, 'commit', '-m', `fixture: ${task === A ? 'A' : 'B'}`);
          code.candidate = git(code.worktree, 'rev-parse', 'HEAD');
          r = report(task, code, 'candidate');
        }
      } else if (code.phase === 'reconcile') {
        assert.ok(code.merge && code.merge.task === task);
        const before = git(code.worktree, 'rev-parse', 'HEAD');
        try { git(code.worktree, 'merge', '--no-edit', code.merge.main); }
        catch {
          conflicts.push(task);
          assert.match(readFileSync(join(code.worktree, 'shared.txt'), 'utf8'), /<<<<<<</);
          // The second worker resolves the deliberately conflicting independent drafts.
          writeFileSync(join(code.worktree, 'shared.txt'), 'A+B\n');
          git(code.worktree, 'add', 'shared.txt'); git(code.worktree, 'commit', '-m', 'fixture: reconcile both histories');
        }
        git(code.worktree, 'merge-base', '--is-ancestor', before, 'HEAD');
        code.candidate = git(code.worktree, 'rev-parse', 'HEAD'); code.main = code.merge.main;
        r = report(task, code, 'candidate');
      } else {
        assert.equal(code.phase, 'publish');
        assert.ok(code.merge.checks.length);
        assert.equal(git(f.repo, 'rev-parse', 'HEAD'), code.merge.main);
        assert.equal(git(code.worktree, 'rev-parse', 'HEAD'), code.merge.candidate);
        git(f.repo, 'merge', '--ff-only', code.merge.candidate); // Worker, never controller, publishes.
        code.candidate = code.merge.candidate; code.main = git(f.repo, 'rev-parse', 'HEAD');
        r = report(task, code, 'worked');
        if (options.lostPublicationReceipt) return { status: 'failed', source: 'transport', summary: 'lost receipt after native merge' };
      }
      writeFileSync(args.reportFile, JSON.stringify(r));
      const result = { status: 'completed', source: 'model', summary: 'fixture', text: JSON.stringify(r) };
      active.delete(receipt.job); finished.set(receipt.job, result);
      if (code?.phase === 'publish' && options.holdPublicationReceipt) return undefined;
      return result;
    },
    launchClaude: async () => { throw Error('no Claude'); },
    sessionAlive: async () => true, killSession: async () => {}, killSessionsWithPrefix: async () => {},
    sendToPane: async (label: string, text: string) => { messages.push(`${label}: ${text}`); },
    fence: async () => [], ancestors: async (ids: string[]) => new Map(ids.map(id => [id, [id, OWNER]])), statuses: async () => new Map(),
  };
  return { deps, launches, conflicts, messages };
}
const history = (dir: string) => readFileSync(join(dir, 'history.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
const drainLaunches = async (ctl: ParallelController) => { await Promise.all([...ctl.inflight]); };

test('seat constraints, code authority/frozen fences and legacy tree orders', () => {
  const f = fixture();
  try {
    const tasks = [order(A, 'codex-1'), order(B, 'oss')];
    const state = P.initialState(f.config, 0);
    state.scopes = { [A]: [A, OWNER], [B]: [B, OWNER] };
    const attempt = P.startAttempt(state, { kind: 'dispatcher', engine: 'fallback', events: [] });
    P.finishDispatcher(state, attempt.id, { kind: 'report', report: P.validateDispatcherReport(dispatch(tasks)) }, 1);
    assert.deepEqual(P.planAssignments(state, f.config, 2), [{ seat: 'oss', task: B }, { seat: 'codex-1', task: A }]);
    state.tasks[B].depends_on = [A];
    const worker = P.startAttempt(state, { kind: 'worker', seat: 'codex-1', task: A });
    P.finishWorker(state, worker.id, { kind: 'report', report: { disposition: 'candidate' }, reportPath: '/candidate.json' }, 3);
    assert.equal(P.depsMet(state, state.tasks[B]), false, 'private candidate never releases code dependency');
    state.tasks[A].status = 'worked';
    assert.equal(P.depsMet(state, state.tasks[B]), true);
    state.tasks[A].status = 'queued';
    state.tasks[A].stop_requested = 'obsolete';
    const obsolete = P.startAttempt(state, { kind: 'worker', seat: 'codex-1', task: A });
    P.finishWorker(state, obsolete.id, { kind: 'report', report: { disposition: 'candidate' }, reportPath: '/obsolete.json' }, 4);
    assert.equal(state.tasks[A].status, 'stopped', 'obsolete private candidate is retained, not published');
    const tree = P.validateDispatcherReport(dispatch([{ node_id: A, scope: A, depends_on: [] }]));
    assert.equal(tree.tasks[0].code, undefined);
    for (const bad of [
      { ...order(A, 'oss'), seats: ['codex-3'] },
      { ...order(A, 'oss'), code: { files: ['law.txt'] } },
      { ...order(A, 'oss'), code: { files: ['outside.txt'] } },
      { ...order(A, 'oss'), seats: undefined },
    ]) assert.throws(() => G.vetCodeTask(bad, f.config));
    assert.throws(() => G.vetCodeTask(order(A, 'oss'), { ...f.config, code: undefined }), /not enabled/);
    assert.throws(() => G.vetCodeTask(order(A, 'codex-1'), f.config, order(A, 'oss')), /ownership/);
    assert.throws(() => P.validateDispatcherReport(dispatch([{ ...order(A, 'oss'), code: { files: ['shared.txt'], branch: 'evil' } }])), /only files/);
    assert.throws(() => P.buildConfig({ runNode: RUN, owner: OWNER, directory: '/run', cwd: '/home', overrides: { roles: { worker: 'invalid' } } }), /roles/);
  } finally { f.cleanup(); }
});

test('two concurrent drafts, deliberate conflict, exact checked exclusive worker publication, no duplicate on resume', async () => {
  const f = fixture();
  try {
    const t = transport(f);
    const ctl = new ParallelController(f.directory, t.deps);
    assert.equal(await ctl.run(), 'done');
    assert.deepEqual(t.conflicts, [B]);
    assert.equal(readFileSync(join(f.repo, 'shared.txt'), 'utf8'), 'A+B\n');
    assert.equal(readFileSync(join(f.repo, 'law.txt'), 'utf8'), 'frozen\n');
    assert.ok(t.launches.filter(l => l.code?.phase === 'develop').every(l => !l.code.merge));
    const rows = history(f.directory), published = rows.filter(r => r.type === 'code_published');
    assert.equal(published.length, 2);
    const turns = t.launches.filter(l => l.code && l.code.phase !== 'develop');
    assert.deepEqual(turns.map(l => [l.task, l.code.phase]), [[A, 'reconcile'], [A, 'publish'], [B, 'reconcile'], [B, 'publish']]);
    for (const row of published) {
      assert.ok(rows.some(r => r.type === 'candidate_checked' && r.task === row.task && r.candidate === row.candidate && r.main === row.main));
      assert.ok(row.main_checks.every((path: string) => existsSync(path)));
    }
    const heads = git(f.repo, 'rev-list', '--count', 'HEAD');
    assert.equal(await new ParallelController(f.directory, t.deps).run(), 'done');
    assert.equal(git(f.repo, 'rev-list', '--count', 'HEAD'), heads);
    assert.equal(history(f.directory).filter(r => r.type === 'code_published').length, 2);
    writeFileSync(join(artifacts, 'synthetic-merge-history.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  } finally { f.cleanup(); }
});

test('continue/stop/restart preserves dirty draft, candidate/base identity and ready dependencies', async () => {
  const f = fixture();
  try {
    const t = transport(f, { continue: true, stopOnContinue: true });
    const first = new ParallelController(f.directory, t.deps);
    assert.equal(await first.run(), 'stopped');
    const code = first.state.tasks[A].code;
    assert.equal(readFileSync(join(code.worktree, 'draft.txt'), 'utf8'), 'retained\n');
    assert.ok(first.state.tasks[A].previous);
    const next = new ParallelController(f.directory, t.deps);
    assert.equal(await next.run(), 'done');
    assert.equal(next.state.tasks[A].code.worktree, code.worktree);
    assert.equal(next.state.tasks[A].code.base, f.code.main_head);
    assert.equal(readFileSync(join(f.repo, 'draft.txt'), 'utf8'), 'retained\n');
  } finally { f.cleanup(); }
});

test('unsafe repo/path/ref/check inputs and changed candidate are refused', async () => {
  const f = fixture();
  try {
    await G.preflightCode(f.config);
    const lock = await G.repoLock(f.config, f.directory);
    assert.equal(await G.repoLock(f.config, f.directory), lock);
    await assert.rejects(G.repoLock(f.config, join(f.directory, 'another-run')), /lock/);
    G.releaseRepoLock(lock, f.directory);
    for (const change of [{ repo: 'relative' }, { worktree_root: '/' }, { worktree_root: join(f.repo, 'drafts') }, { main_branch: '--evil' },
      { main_branch: 'main..bad' }, { main_head: 'HEAD' }, { allowed_paths: ['../other'] }, { frozen_paths: [] },
      { candidate_checks: [['node', '-e', '']] }, { main_checks: [] }]) assert.throws(() => G.validateCodeConfig({ ...f.code, ...change }));
    for (const path of ['a/../b', './a', 'a//b', '.git/config', '.GIT/config', 'a/*', 'a\\b', 'a\n']) assert.throws(() => G.fileScope([path]));
    await assert.rejects(G.preflightCode({ ...f.config, readonly_repos: [f.repo] }), /also read-only/);
    const alias = join(f.directory, 'alias'); symlinkSync(f.repo, alias);
    await assert.rejects(G.preflightCode({ ...f.config, code: { ...f.code, repo: alias } }), /canonical/);
    const code = G.allocation(f.config, order(A, 'oss'));
    await G.prepareCode(f.config, code);
    writeFileSync(join(code.worktree, 'shared.txt'), 'A\n'); git(code.worktree, 'add', 'shared.txt'); git(code.worktree, 'commit', '-m', 'fixture: A');
    const candidate = git(code.worktree, 'rev-parse', 'HEAD');
    await G.candidateIdentity(f.config, code, candidate, code.base);
    writeFileSync(join(code.worktree, 'shared.txt'), 'changed\n');
    await assert.rejects(G.candidateIdentity(f.config, code, candidate, code.base), /dirty/);
    git(code.worktree, 'add', 'shared.txt'); git(code.worktree, 'commit', '-m', 'fixture: changed');
    await assert.rejects(G.candidateIdentity(f.config, code, candidate, code.base), /changed/);
    writeFileSync(join(code.worktree, ' shared.txt'), 'outside literal authority\n');
    git(code.worktree, 'add', ' shared.txt'); git(code.worktree, 'commit', '-m', 'fixture: leading-space fence violation');
    await assert.rejects(G.candidateIdentity(f.config, code, git(code.worktree, 'rev-parse', 'HEAD'), code.base), /fence:  shared.txt/);
    git(code.worktree, 'rm', ' shared.txt');
    writeFileSync(join(code.worktree, 'law.txt'), 'weakened\n'); git(code.worktree, 'add', 'law.txt'); git(code.worktree, 'commit', '-m', 'fixture: violation');
    await assert.rejects(G.candidateIdentity(f.config, code, git(code.worktree, 'rev-parse', 'HEAD'), code.base), /fence: law.txt/);
    git(code.worktree, 'restore', '--source', code.base, '--', 'law.txt');
    git(code.worktree, 'rm', 'shared.txt'); symlinkSync('law.txt', join(code.worktree, 'shared.txt'));
    git(code.worktree, 'add', 'law.txt', 'shared.txt'); git(code.worktree, 'commit', '-m', 'fixture: symlink violation');
    await assert.rejects(G.candidateIdentity(f.config, code, git(code.worktree, 'rev-parse', 'HEAD'), code.base), /symlink/);
    await assert.rejects(G.worktreeIdentity(f.config, { ...code, branch: 'other' }), /ownership/);
  } finally { f.cleanup(); }
});

test('development fences exclude imported accepted history, not worker edits or unmerged main', async () => {
  const f = fixture();
  try {
    const ctl = new ParallelController(f.directory, transport(f).deps);
    await ctl.start();
    const task = { ...order(A, 'oss'), code: { files: ['draft.txt'] } };
    ctl.state.tasks[A] = task;
    const code = G.allocation(f.config, task);
    ctl.state.tasks[A].code = code;
    await G.prepareCode(f.config, code);

    writeFileSync(join(f.repo, 'shared.txt'), 'accepted sibling\n');
    git(f.repo, 'add', 'shared.txt'); git(f.repo, 'commit', '-m', 'fixture: accepted sibling');
    const accepted = git(f.repo, 'rev-parse', 'HEAD');
    ctl.state.code_main = accepted; // Simulate the controller's previously checked main receipt.
    git(code.worktree, 'merge', '--ff-only', accepted);
    writeFileSync(join(code.worktree, 'draft.txt'), 'task contribution\n');
    git(code.worktree, 'add', 'draft.txt'); git(code.worktree, 'commit', '-m', 'fixture: assigned draft');
    const candidate = git(code.worktree, 'rev-parse', 'HEAD');
    await ctl.codeOutcome({ task: A }, { kind: 'report', report: report(A, { ...code, candidate }, 'candidate') }, 1);
    assert.equal(code.candidate, candidate);
    assert.equal(code.phase, 'reconcile');
    assert.deepEqual(await G.candidateIdentity(f.config, code, candidate, code.base, accepted), ['draft.txt']);

    // Main can advance without being imported: absence of those newer bytes is not a worker edit.
    writeFileSync(join(f.repo, 'shared.txt'), 'newer accepted sibling\n');
    git(f.repo, 'add', 'shared.txt'); git(f.repo, 'commit', '-m', 'fixture: newer main');
    const newer = git(f.repo, 'rev-parse', 'HEAD');
    assert.deepEqual(await G.candidateIdentity(f.config, code, candidate, code.base, newer), ['draft.txt']);

    writeFileSync(join(code.worktree, 'shared.txt'), 'unauthorized sibling edit\n');
    git(code.worktree, 'add', 'shared.txt'); git(code.worktree, 'commit', '-m', 'fixture: unauthorized edit');
    await assert.rejects(G.candidateIdentity(f.config, code, git(code.worktree, 'rev-parse', 'HEAD'), code.base, newer), /fence: shared.txt/);
    git(code.worktree, 'restore', '--source', accepted, '--', 'shared.txt');
    writeFileSync(join(code.worktree, 'law.txt'), 'weakened\n');
    git(code.worktree, 'add', 'shared.txt', 'law.txt'); git(code.worktree, 'commit', '-m', 'fixture: frozen violation');
    await assert.rejects(G.candidateIdentity(f.config, code, git(code.worktree, 'rev-parse', 'HEAD'), code.base, newer), /fence: law.txt/);
  } finally { f.cleanup(); }
});

test('checked grant rejects stale candidate/main and changed gate config before publication', async () => {
  const f = fixture();
  try {
    const t = transport(f), ctl = new ParallelController(f.directory, t.deps);
    await ctl.start();
    for (let i = 0; i < 10 && ctl.state.tasks[A]?.code.phase !== 'publish'; i++) { await ctl.tick(); await drainLaunches(ctl); }
    const task = ctl.state.tasks[A];
    assert.equal(task.code.phase, 'publish');
    await ctl.checkedCandidate(task);
    writeFileSync(join(task.code.worktree, 'shared.txt'), 'later\n');
    await assert.rejects(ctl.checkedCandidate(task), /dirty/);
    git(task.code.worktree, 'restore', 'shared.txt');
    const config = JSON.parse(readFileSync(join(f.directory, 'config.json'), 'utf8'));
    save(join(f.directory, 'config.json'), { ...config, code: { ...config.code, main_checks: [[process.execPath, '-e', 'process.exit(0)']] } });
    await assert.rejects(ctl.checkedCandidate(task), /configuration changed/);
    save(join(f.directory, 'config.json'), config);
    writeFileSync(join(f.repo, 'shared.txt'), 'unexpected\n'); git(f.repo, 'add', 'shared.txt'); git(f.repo, 'commit', '-m', 'fixture: unauthorized main');
    await assert.rejects(ctl.checkedCandidate(task), /main moved/);
  } finally { f.cleanup(); }
});

test('lost publication receipt stays ambiguous, retains lock/candidates and never credits or republishes', async () => {
  const f = fixture();
  try {
    const t = transport(f, { lostPublicationReceipt: true });
    const ctl = new ParallelController(f.directory, t.deps);
    assert.equal(await ctl.run(), 'needs_attention');
    assert.match(ctl.state.attention.reason, /ambiguous/);
    assert.notEqual(ctl.state.tasks[A].status, 'worked');
    assert.ok(ctl.state.merge && existsSync(ctl.repoLock));
    const head = git(f.repo, 'rev-parse', 'HEAD');
    assert.equal(await new ParallelController(f.directory, t.deps).run(), 'needs_attention');
    assert.equal(git(f.repo, 'rev-parse', 'HEAD'), head);
    assert.equal(t.launches.filter(l => l.code?.phase === 'publish').length, 1);
  } finally { f.cleanup(); }
});

test('restart readopts a known receipt; missing launch receipt never kills/requeues code blindly', async () => {
  const f = fixture();
  try {
    const t = transport(f), ctl = new ParallelController(f.directory, t.deps);
    await ctl.start(); await ctl.tick(); await drainLaunches(ctl);
    await ctl.tick(); await drainLaunches(ctl); // Dispatcher settles, both workers receive private identities and START receipts.
    assert.equal(P.running(ctl.state).filter(a => a.kind === 'worker').length, 2);
    const resumed = new ParallelController(f.directory, t.deps);
    assert.equal(await resumed.run(), 'done');
    assert.equal(t.launches.filter(l => l.code?.phase === 'develop').length, 2);
    const state = resumed.state;
    const original = Object.values(state.attempts).find((a: any) => a.kind === 'worker') as any;
    original.status = 'launching'; delete original.receipt;
    state.seats[original.seat].attempt = original.id; state.tasks[original.task].status = 'running';
    save(join(f.directory, 'state.json'), state);
    let killed = false; t.deps.killSessionsWithPrefix = async () => { killed = true; };
    const ambiguous = new ParallelController(f.directory, t.deps);
    assert.equal(await ambiguous.run(), 'needs_attention');
    assert.equal(killed, false);
    assert.equal(ambiguous.state.attempts[original.id].status, 'ambiguous');
    assert.equal(await new ParallelController(f.directory, t.deps).run(), 'needs_attention');
  } finally { f.cleanup(); }
});

test('failed or candidate-mutating gates retain drafts/logs and never grant publication', async () => {
  for (const script of ['process.exit(7)', 'require("fs").writeFileSync("shared.txt", "mutated by gate\\n")']) {
    const f = fixture();
    try {
      f.config.code.candidate_checks = [[process.execPath, '-e', script]];
      save(join(f.directory, 'config.json'), f.config);
      const t = transport(f), ctl = new ParallelController(f.directory, t.deps);
      // A rejected candidate is one bad item on the line: the run keeps moving and the dispatcher decides.
      assert.equal(await ctl.run(), 'idle');
      assert.equal(ctl.state.attention, null);
      assert.equal(ctl.state.tasks[A].status, 'errored');
      assert.equal(git(f.repo, 'rev-parse', 'HEAD'), f.code.main_head);
      assert.equal(t.launches.filter(l => l.code?.phase === 'publish').length, 0);
      assert.equal(ctl.state.merge, null); // reservation released so other work can proceed
      assert.ok(history(f.directory).some(row => row.type === 'candidate_rejected'));
      assert.ok(!history(f.directory).some(row => row.type === 'code_attention'));
      const attempt = Object.values(ctl.state.attempts).find((a: any) => a.code?.phase === 'reconcile') as any;
      assert.ok(existsSync(join(attempt.dir, 'candidate-check-0.log')));
      assert.ok(existsSync(ctl.state.tasks[A].code.worktree));
    } finally { f.cleanup(); }
  }
});

test('restart after worker native merge but before receipt consumption reuses exact grant, not publication', async () => {
  const f = fixture();
  try {
    const t = transport(f, { holdPublicationReceipt: true }), ctl = new ParallelController(f.directory, t.deps);
    await ctl.start();
    for (let i = 0; i < 10 && git(f.repo, 'rev-parse', 'HEAD') === f.code.main_head; i++) { await ctl.tick(); await drainLaunches(ctl); }
    assert.notEqual(git(f.repo, 'rev-parse', 'HEAD'), f.code.main_head);
    assert.equal(ctl.state.tasks[A].status, 'running');
    assert.equal(ctl.state.tasks[A].code.phase, 'publish');
    assert.equal(await new ParallelController(f.directory, t.deps).run(), 'done');
    assert.equal(t.launches.filter(l => l.code?.phase === 'publish' && l.task === A).length, 1);
    assert.equal(history(f.directory).filter(row => row.type === 'code_published' && row.task === A).length, 1);
  } finally { f.cleanup(); }
});

test('restart cannot remove or redirect pinned code config/acceptance, even after done', async () => {
  const f = fixture(), other = fixture();
  try {
    const t = transport(f);
    assert.equal(await new ParallelController(f.directory, t.deps).run(), 'done');
    const count = t.launches.length;
    save(join(f.directory, 'config.json'), { ...f.config, code: { ...f.config.code, repo: other.repo, worktree_root: other.code.worktree_root } });
    assert.equal(await new ParallelController(f.directory, t.deps).run(), 'needs_attention');
    assert.equal(existsSync(join(other.repo, '.git', 'parallel-factory.lock')), false, 'rejected config cannot lock another repo');
    const { code: _code, ...treeConfig } = f.config;
    save(join(f.directory, 'config.json'), treeConfig);
    assert.equal(await new ParallelController(f.directory, t.deps).run(), 'needs_attention');
    assert.equal(t.launches.length, count);
  } finally { f.cleanup(); other.cleanup(); }
});

test('worker guard validates identity and prevents private worked or tree publication reports', () => {
  const f = fixture();
  try {
    const code = G.allocation(f.config, order(A, 'oss'));
    const path = join(f.directory, 'report.json'), handlers: any[] = [];
    const pi: any = { on: (name: string, handler: any) => { if (name === 'tool_call') handlers.push(handler); } };
    installParallelGuard(pi, { report: path, route: P.ROUTES.oss, role: 'worker', code });
    const check = handlers.at(-1), event = { toolName: 'report_outcome', input: { outcome: 'completed' } };
    save(path, report(A, code, 'worked'));
    assert.match(check(event).reason, /private candidate/);
    save(path, report(A, { ...code, candidate: f.code.main_head }, 'candidate'));
    assert.equal(check(event), undefined);
    save(path, report(A, { ...code, worktree: f.repo, candidate: f.code.main_head }, 'candidate'));
    assert.match(check(event).reason, /assigned code identity/);
    assert.throws(() => P.validateWorkerReport({ ...report(A, code, 'candidate'), code: { ...code, base: 'HEAD' } }), /identity/);
    assert.throws(() => P.validateWorkerReport({ ...report(A, code, 'candidate'), code: undefined }), /requires code/);
    const treeHandlers: any[] = [];
    installParallelGuard({ on: (name: string, handler: any) => { if (name === 'tool_call') treeHandlers.push(handler); } } as any,
      { report: path, route: P.ROUTES.oss, role: 'worker' });
    save(path, report(A, { ...code, candidate: f.code.main_head }, 'candidate'));
    assert.match(treeHandlers.at(-1)(event).reason, /no code publication/);
  } finally { f.cleanup(); }
});
