import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import * as P from './parallel-core.mjs';
import * as G from './parallel-code.mjs';

// Deterministic parallel-factory controller. Transport/tree access uses injected deps;
// opt-in code tasks use the native Git helper against explicitly configured repositories.

export const save = (path, value) => {
  writeFileSync(`${path}.tmp`, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
};
const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
const STOP_TEXT = 'FACTORY CONTROLLER: stop now. Write your continue report to REPORT as the Worker Role\'s Friendly stop section says, then call report_outcome and end your turn.';
const ALIVE_MS = 15_000;
const EXTERNAL_MS = 60_000;
export const CLAUDE_IDLE_MS = 30 * 60_000;

export class ParallelController {
  constructor(directory, deps) {
    this.dir = directory;
    this.deps = deps;
    this.config = readJson(join(directory, 'config.json'));
    this.statePath = join(directory, 'state.json');
    this.short = this.config.run_node.slice(0, 8);
    this.inflight = new Set();
    this.checked = new Map();
    this.externalAt = 0;
  }

  log(type, data = {}) {
    const t = this.deps.now();
    appendFileSync(join(this.dir, 'history.jsonl'), JSON.stringify({ at: new Date(t).toISOString(), t, type, ...data }) + '\n');
  }
  persist() { save(this.statePath, this.state); }
  track(promise) {
    const tracked = promise.finally(() => this.inflight.delete(tracked));
    this.inflight.add(tracked);
  }

  async run() {
    await this.start();
    let failures = 0;
    for (;;) {
      try {
        if (await this.tick()) return this.state.status;
        failures = 0;
      } catch (error) {
        failures += 1;
        this.log('tick_error', { error: String(error?.stack ?? error) });
        if (failures >= 20) {
          this.state.status = 'error';
          this.state.error = String(error);
          this.persist();
          throw error;
        }
      }
      await this.deps.sleep(1000);
    }
  }

  async start() {
    const now = this.deps.now();
    if (existsSync(this.statePath)) {
      this.state = readJson(this.statePath);
      const previous = this.state.status;
      // Resume means the operator handled whatever stopped the run.
      Object.assign(this.state, { status: 'running', stop: null, attention: null, error: undefined });
      // A stop consumed by the previous controller must not stop a fresh attempt after resume/crash.
      for (const task of Object.values(this.state.tasks)) delete task.stop_requested;
      this.state.dispatcher.failures = 0;
      this.log('controller_resumed', { previous, pid: process.pid });
      await this.readopt(now);
    } else {
      this.state = P.initialState(this.config, now);
      P.addEvent(this.state, { type: 'human_wake', note: 'start-parallel' }, now);
      this.log('controller_started', { pid: process.pid, run_node: this.config.run_node, owner: this.config.owner,
        seats: this.config.seats, dispatcher: this.config.dispatcher, readonly_repos: this.config.readonly_repos, faults: this.config.faults });
    }
    const primaryRequired = await this.deps.primaryRequired?.(this.config.run_node) ?? false;
    if (this.state.primary_required === true && !primaryRequired) {
      this.state.attention ??= { reason: 'mandatory primary-seat authority disappeared from RUN; operator must reconcile before admission', at: now };
    }
    this.state.primary_required = primaryRequired;
    if (primaryRequired && !this.state.seats.oss.attempt) this.state.oss_idle_emitted = false;
    if (this.state.code_pin && (!this.config.code || this.state.code_pin !== G.codePin(this.config))) {
      this.codeAttention('code configuration removed/changed; acceptance/ownership must not be weakened', now);
      this.flushEvents();
      this.persist();
      return;
    }
    if (this.config.code) {
      G.validateCodeConfig(this.config.code);
      if (!this.state.code_pin) await G.preflightCode(this.config);
      this.repoLock = await G.repoLock(this.config, this.dir);
      this.state.code_pin ??= G.codePin(this.config);
      this.state.code_main ??= this.config.code.main_head;
      if (Object.values(this.state.attempts).some(a => a.status === 'ambiguous') ||
          Object.values(this.state.tasks).some(task => task.code?.allocating && task.status !== 'running')) {
        this.codeAttention('ambiguous code launch/allocation remains; operator must reconcile retained sessions and Git identities', now);
      }
      try { await this.codeMainCheck(true); } catch (error) { this.codeAttention(String(error), now); }
    }
    await this.fenceCheck(now, 'controller start');
    this.flushEvents();
    this.persist();
  }

  // An attempt caught mid-launch by a controller crash has no receipt: close it and give its work back.
  async readopt(now) {
    for (const attempt of P.running(this.state)) {
      if (attempt.status !== 'launching') continue;
      if (attempt.kind === 'worker' && this.state.tasks[attempt.task].code) {
        // A missing START receipt does not prove a code worker never mutated Git/main.
        attempt.status = 'ambiguous';
        this.state.tasks[attempt.task].status = 'errored';
        this.state.seats[attempt.seat].attempt = null;
        this.codeAttention(`code launch ${attempt.id} has no durable receipt; inspect its session/draft before recovery`, now);
        this.log('code_launch_ambiguous', { attempt: attempt.id, task: attempt.task, label: attempt.label });
        continue;
      }
      await this.deps.killSessionsWithPrefix(attempt.label);
      attempt.status = 'abandoned';
      attempt.finished_at = now;
      if (attempt.kind === 'worker') {
        const task = this.state.tasks[attempt.task];
        Object.assign(task, { status: 'queued', front: true });
        if (this.state.seats[attempt.seat].attempt === attempt.id) this.state.seats[attempt.seat].attempt = null;
      } else {
        this.state.pending_events.unshift(...attempt.events);
        this.state.wake = true;
        this.state.dispatcher.attempt = null;
      }
      this.log('attempt_abandoned', { attempt: attempt.id, kind: attempt.kind, task: attempt.task });
    }
  }

  async tick() {
    const now = this.deps.now();
    await this.readInbox(now);
    this.endRests(now);
    await this.requestStops(now);
    for (const attempt of P.running(this.state)) {
      if (attempt.status !== 'running') continue;
      if (attempt.awaiting_input) {
        if (!(await this.alive(attempt, attempt.receipt.session_label, now))) {
          await this.settle(attempt, { kind: 'error', summary: 'worker transport lost while awaiting human input; retain draft and verify background-work drain before retry' }, now);
        }
        continue;
      }
      // Do not sample main mid-publication. Settled sibling code reports wait for the grant holder.
      const publisher = this.state.merge?.task;
      if (publisher && publisher !== attempt.task && this.state.tasks[publisher]?.code.phase === 'publish' &&
          this.state.tasks[publisher]?.status === 'running' && this.state.tasks[attempt.task]?.code) continue;
      if (attempt.engine === 'claude') await this.pollClaude(attempt, now);
      else await this.pollPi(attempt, now);
    }
    await this.refreshExternal(now);
    await this.advanceMerge(now);
    const assignments = P.planAssignments(this.state, this.config, now);
    for (const assignment of assignments) this.launchWorker(assignment, now);
    P.ossIdle(this.state, this.config, now, assignments);
    if (this.state.wake && !this.state.dispatcher.attempt && this.state.status === 'running' && !this.state.stop && !this.state.attention && !(this.state.awaiting_input?.length)) {
      this.launchDispatcher(now);
    }
    this.flushEvents();
    const terminal = this.inflight.size ? undefined : P.terminalStatus(this.state, this.config, now);
    if (terminal) {
      this.state.status = terminal;
      this.log('terminal', { status: terminal, attention: this.state.attention ?? undefined });
      if (!this.state.merge && !this.state.attention && !Object.values(this.state.attempts).some(a => a.status === 'ambiguous')) {
        G.releaseRepoLock(this.repoLock, this.dir);
      }
    }
    this.persist();
    return !!terminal;
  }

  flushEvents() {
    for (const event of this.state.pending_events) {
      if (event.logged) continue;
      event.logged = true;
      this.log('event', { event: { ...event, logged: undefined } });
    }
  }

  async readInbox(now) {
    const inbox = join(this.dir, 'inbox');
    if (!existsSync(inbox)) return;
    for (const name of readdirSync(inbox).filter(name => name.endsWith('.json')).sort()) {
      const path = join(inbox, name);
      let command;
      try { command = readJson(path); } catch { continue; }
      rmSync(path, { force: true });
      if (command.type === 'wake') P.addEvent(this.state, { type: 'human_wake', note: command.note ?? 'factory wake' }, now);
      else if (command.type === 'stop') this.state.stop = { requested: now, now: !!command.now };
      else if (command.type === 'answer') await this.answerWorker(command, now);
      this.log('inbox', { command: command.type === 'answer' ? { type: command.type, task: command.task, text: '[redacted]' } : { command } });
    }
  }

  async answerWorker(command, now) {
    const pending = this.state.awaiting_input?.find(item => item.task === command.task);
    if (!pending || typeof command.text !== 'string' || !command.text.trim()) {
      this.log('worker_input_rejected', { task: command.task, reason: 'no matching pending question or empty answer' });
      return;
    }
    const attempt = this.state.attempts[pending.attempt];
    if (!attempt || attempt.status !== 'running' || !attempt.awaiting_input || !this.deps.followupPi) {
      this.log('worker_input_rejected', { task: command.task, attempt: pending.attempt, reason: 'saved worker cannot be safely continued' });
      return;
    }
    const resume = (attempt.resume_count ?? 0) + 1;
    attempt.resume_count = resume;
    const dir = join(attempt.dir, `input-${resume}`);
    mkdirSync(dir, { recursive: true });
    const report = join(dir, 'report.json');
    const codePath = attempt.code ? join(dir, 'code.json') : undefined;
    if (codePath) save(codePath, { ...this.config.code, ...attempt.code, task: attempt.task, seat: attempt.seat,
      merge: this.state.merge?.task === attempt.task ? this.state.merge : null });
    const mission = join(dir, 'mission.md');
    const input = command.text.trim();
    const prompt = P.workerPrompt({ role: this.config.roles.worker, run: this.config.run_node, task: attempt.task,
      report, previous: attempt.report, artifacts: join(this.dir, 'artifacts', attempt.task), code: codePath });
    writeFileSync(mission, `${prompt}\nPending question:\n${pending.question}\n\nHuman answer (applies only to this task; preserve all existing RUN authority):\n${input}\n`);
    const policy = this.deps.writePolicy(dir, { report, route: attempt.route, role: 'worker', code: attempt.code });
    try {
      const receipt = await this.deps.followupPi({ label: attempt.receipt.session_label, route: attempt.route, missionFile: mission,
        reportFile: report, extensionFiles: [policy], cwd: attempt.code?.worktree ?? this.config.cwd,
        job: attempt.receipt.job, sessionId: attempt.receipt.session_id });
      if (!['running', 'start_timeout', 'queued'].includes(receipt?.status)) throw Error(`follow-up did not start: ${receipt?.status ?? 'no receipt'}`);
      const oldAttempt = attempt.receipt.attempt_id;
      attempt.previous_report = attempt.report;
      attempt.report = report;
      attempt.dir = dir;
      attempt.receipt = receipt;
      attempt.resume_count = resume;
      delete attempt.awaiting_input;
      this.state.awaiting_input = this.state.awaiting_input.filter(item => item.attempt !== pending.attempt);
      this.log('worker_input_accepted', { task: attempt.task, attempt: attempt.id, previous_transport_attempt: oldAttempt,
        transport_attempt: receipt.attempt_id, resume, report });
    } catch (error) {
      pending.error = String(error);
      this.log('worker_input_followup_failed', { task: attempt.task, attempt: attempt.id, error: String(error) });
    }
    this.persist();
  }

  endRests(now) {
    for (const [id, seat] of Object.entries(this.state.seats)) {
      if (seat.resting_until && seat.resting_until <= now) {
        seat.resting_until = null;
        this.log('seat_rest_ended', { seat: id });
      }
    }
    const d = this.state.dispatcher;
    if (d.claude_resting_until && d.claude_resting_until <= now) {
      d.claude_resting_until = null;
      this.log('seat_rest_ended', { seat: 'claude-dispatcher' });
    }
  }

  async requestStops(now) {
    const everyone = this.state.stop?.now || this.state.attention;
    for (const attempt of P.running(this.state)) {
      if (attempt.kind !== 'worker' || attempt.status !== 'running' || attempt.stop_sent) continue;
      const task = this.state.tasks[attempt.task];
      if (!task.stop_requested && everyone) task.stop_requested = 'operator';
      if (!task.stop_requested) continue;
      attempt.stop_sent = now;
      await this.deps.sendToPane(attempt.receipt.session_label, STOP_TEXT);
      this.log('stop_message', { attempt: attempt.id, task: attempt.task, reason: task.stop_requested });
    }
  }

  launchWorker({ seat, task }, now) {
    const seatConfig = this.config.seats.find(entry => entry.id === seat);
    const record = this.state.tasks[task];
    const attempt = P.startAttempt(this.state, { kind: 'worker', engine: 'pi', seat, seat_kind: seatConfig.kind, task,
      route: seatConfig.route, previous: record.previous ?? null, launched_at: now });
    attempt.dir = join(this.dir, 'attempts', `${attempt.id}-worker-${seat}`);
    attempt.report = join(attempt.dir, 'report.json');
    attempt.label = `pf-${this.short}-${seat}-${attempt.id}`;
    if (record.code) {
      if (!record.code.worktree) {
        record.code = G.allocation(this.config, record);
        record.code.allocating = true;
      }
      attempt.code = structuredClone(record.code);
      attempt.merge = this.state.merge?.task === task ? structuredClone(this.state.merge) : null;
    }
    const artifacts = join(this.dir, 'artifacts', task);
    mkdirSync(attempt.dir, { recursive: true });
    mkdirSync(artifacts, { recursive: true });
    const mission = join(attempt.dir, 'mission.md');
    const codePath = record.code ? join(attempt.dir, 'code.json') : undefined;
    if (codePath) save(codePath, { ...this.config.code, ...attempt.code, task, seat, merge: attempt.merge });
    writeFileSync(mission, P.workerPrompt({ role: this.config.roles.worker, run: this.config.run_node, task,
      report: attempt.report, previous: attempt.previous, artifacts, code: codePath }));
    const fault = this.seatFault(seat);
    if (fault) attempt.fault = fault;
    const policy = this.deps.writePolicy(attempt.dir, { report: attempt.report, route: seatConfig.route, role: 'worker', fault, code: attempt.code });
    this.log('worker_launch', { attempt: attempt.id, seat, task, route: seatConfig.route, previous: attempt.previous, fault: !!fault });
    this.persist();
    this.track((async () => {
      if (record.code) {
        try {
          await this.codeMainCheck();
          if (record.code.allocating) {
            await G.prepareCode(this.config, record.code);
            delete record.code.allocating;
            this.persist();
          }
          await G.worktreeIdentity(this.config, record.code);
          if (record.code.phase === 'publish') await this.checkedCandidate(record);
        } catch (error) {
          P.finishWorker(this.state, attempt.id, { kind: 'error', summary: String(error) }, this.deps.now());
          this.codeAttention(String(error), this.deps.now());
          this.persist();
          return;
        }
      }
      try {
        const receipt = await this.deps.launchPi({ label: attempt.label, route: seatConfig.route, missionFile: mission,
          reportFile: attempt.report, extensionFiles: [policy], cwd: record.code?.worktree ?? this.config.cwd });
        await this.launched(attempt, receipt);
      } catch (error) { await this.launched(attempt, { status: 'setup_failed', error: String(error?.message ?? error) }); }
    })());
  }

  codeAttention(reason, now) {
    this.state.attention ??= { reason, at: now };
    this.log('code_attention', { reason });
  }

  async codeMainCheck(allowPublished = false) {
    if (!this.config.code) return;
    if (G.codePin(readJson(join(this.dir, 'config.json'))) !== this.state.code_pin) throw Error('code configuration changed while running');
    const head = await G.mainIdentity(this.config.code);
    const merge = this.state.merge;
    const publishing = merge && this.state.tasks[merge.task]?.code.phase === 'publish' &&
      P.running(this.state).some(a => a.task === merge.task && a.code?.phase === 'publish');
    if (head !== this.state.code_main && !(allowPublished && publishing && head === merge.candidate)) {
      throw Error(`main moved unexpectedly: expected ${this.state.code_main}, found ${head}`);
    }
  }

  requeueMerge(attempt) {
    const task = this.state.tasks[attempt.task];
    if (task.code && task.code.phase !== 'develop' && task.status === 'queued') task.status = 'merge_queued';
  }

  async advanceMerge(now) {
    if (!this.config.code || this.state.stop || this.state.attention || this.state.awaiting_input?.length || this.state.status !== 'running' ||
        ['done', 'blocked'].includes(this.state.dispatcher.last?.disposition)) return;
    try {
      if (this.state.merge && this.state.tasks[this.state.merge.task]?.status === 'running') return;
      await this.codeMainCheck();
      if (!this.state.merge) {
        const task = this.state.order.map(id => this.state.tasks[id]).find(t => t.status === 'merge_queued');
        if (!task) return;
        this.state.merge = { task: task.node_id, main: this.state.code_main };
        this.log('merge_reserved', this.state.merge);
        this.persist(); // Reservation precedes every worker turn/gate, including crash windows.
      }
      const task = this.state.tasks[this.state.merge.task];
      if (!['queued', 'merge_queued'].includes(task.status)) return;
      if (task.code.phase === 'publish' && P.running(this.state).some(a => a.task !== task.node_id &&
          a.status === 'launching' && this.state.tasks[a.task]?.code)) return;
      const active = Object.values(this.state.tasks).filter(t => t.status === 'running');
      if (active.some(t => P.overlaps(t.scope, task.scope, this.state.scopes))) return;
      const seat = this.config.seats.find(s => task.seats.includes(s.id) && P.seatFree(this.state, s.id, now));
      if (seat) this.launchWorker({ seat: seat.id, task: task.node_id }, now);
    } catch (error) { this.codeAttention(String(error), now); }
  }

  async checkedCandidate(task) {
    const merge = this.state.merge;
    if (!merge || merge.task !== task.node_id || merge.candidate !== task.code.candidate || !merge.checks?.length ||
        merge.main !== this.state.code_main) throw Error('missing/stale exact-candidate merge grant');
    await this.codeMainCheck();
    await G.candidateIdentity(this.config, task.code, merge.candidate, merge.main);
  }

  async codeOutcome(attempt, outcome, now) {
    const task = this.state.tasks[attempt.task], code = task.code;
    if (!code) {
      if (outcome.report?.code || outcome.report?.disposition === 'candidate') throw Error('tree task cannot return code publication');
      return;
    }
    if (outcome.kind !== 'report') {
      if (code.phase === 'publish') throw Error('publication outcome is ambiguous; retain grant/main/draft for operator recovery');
      return;
    }
    const r = outcome.report, identity = r.code;
    // Rejection of this worker's own submission is a task outcome: evidence retained, dispatcher retries.
    const taskFault = async (work) => { try { return await work; } catch (error) { throw error instanceof G.TaskFault ? error : new G.TaskFault(String(error.message ?? error)); } };
    if (!identity || identity.worktree !== code.worktree || identity.branch !== code.branch || identity.base !== code.base) {
      throw new G.TaskFault('worker report does not match owned worktree/branch/base');
    }
    await taskFault(G.worktreeIdentity(this.config, code));
    if (['continue', 'blocked'].includes(r.disposition)) {
      await this.codeMainCheck();
      code.draft_head = await G.git(code.worktree, 'rev-parse', 'HEAD');
      if (identity.candidate && identity.candidate !== code.draft_head) throw new G.TaskFault('checkpoint candidate differs from retained draft HEAD');
      return; // Retain dirty/untracked drafts, candidate, phase and exact next action.
    }
    if (code.phase !== 'publish') {
      if (r.disposition !== 'candidate') throw new G.TaskFault('code development/reconciliation must return candidate, not worked');
      const base = code.phase === 'reconcile' ? this.state.merge?.main : code.base;
      if (!base || (code.phase === 'reconcile' && identity.main !== base)) throw new G.TaskFault('reconcile report requires the exact reserved main SHA');
      await this.codeMainCheck();
      await taskFault(G.candidateIdentity(this.config, code, identity.candidate, base, this.state.code_main));
      if (code.candidate) await G.git(code.worktree, 'merge-base', '--is-ancestor', code.candidate, identity.candidate);
      code.candidate = identity.candidate;
      if (task.stop_requested === 'obsolete') return;
      if (code.phase === 'reconcile') {
        this.state.merge.candidate = code.candidate;
        this.persist();
        const checks = await G.runCodeChecks(this.config, code, 'candidate', code.candidate, base, attempt.dir);
        await this.codeMainCheck();
        await taskFault(G.candidateIdentity(this.config, code, code.candidate, base));
        this.state.merge.checks = checks;
        code.phase = 'publish';
        this.log('candidate_checked', { task: task.node_id, ...this.state.merge });
      } else code.phase = 'reconcile';
    } else {
      const merge = this.state.merge;
      if (!merge || merge.task !== task.node_id || !merge.checks?.length || r.disposition !== 'worked' ||
          identity.candidate !== merge.candidate || identity.main !== merge.candidate) throw Error('publication report does not match checked grant');
      await G.candidateIdentity(this.config, code, merge.candidate, merge.main);
      if (await G.mainIdentity(this.config.code) !== merge.candidate) throw Error('main is not the exact checked candidate');
      const checks = await G.runCodeChecks(this.config, code, 'main', merge.candidate, merge.main, attempt.dir);
      await this.codeMainCheck(true);
      if (await G.mainIdentity(this.config.code) !== merge.candidate) throw Error('main changed during main gates');
      await G.candidateIdentity(this.config, code, merge.candidate, merge.main);
      code.main_checks = checks;
      code.phase = 'landed';
      this.state.code_main = merge.candidate;
      this.log('code_published', { task: task.node_id, ...merge, main_checks: checks });
      this.state.merge = null;
    }
  }

  seatFault(seat) {
    const fault = this.config.faults?.seat_usage_limit;
    if (!fault || fault.seat !== seat || this.state.seats[seat].launches > (fault.launches ?? 1)) return undefined;
    return `You have hit your ChatGPT usage limit (factory fault injection). Try again in ~${fault.minutes ?? 2} min.`;
  }

  async launched(attempt, receipt) {
    const now = this.deps.now();
    attempt.receipt = receipt;
    if (['running', 'start_timeout'].includes(receipt?.status)) {
      attempt.status = 'running';
      this.log(`${attempt.kind}_started`, { attempt: attempt.id, session: receipt.session_label, job: receipt.job });
    } else {
      // No model ran: the route itself is unavailable. Treat as capacity and give the work back unchanged.
      if (receipt?.session_label) await this.deps.killSession(receipt.session_label);
      const summary = `launch failed: ${receipt?.error ?? receipt?.status}`;
      if (attempt.kind === 'worker') {
        P.finishWorker(this.state, attempt.id, { kind: 'launch_failed', resetAt: now + P.REST_DEFAULT_MS, summary }, now);
        this.requeueMerge(attempt);
        this.log('seat_rested', { seat: attempt.seat, until: new Date(now + P.REST_DEFAULT_MS).toISOString(), reason: summary, task: attempt.task });
      } else {
        P.finishDispatcher(this.state, attempt.id, { kind: 'error', summary }, now);
        this.log('dispatcher_finish', { attempt: attempt.id, engine: attempt.engine, outcome: 'error', summary });
      }
    }
    this.flushEvents();
    this.persist();
  }

  launchDispatcher(now) {
    const engine = this.config.dispatcher.engine === 'fallback' ? 'fallback' : P.dispatcherEngine(this.state, now);
    const events = P.takeEvents(this.state).map(({ logged, ...event }) => event);
    const attempt = P.startAttempt(this.state, { kind: 'dispatcher', engine, events, launched_at: now });
    attempt.dir = join(this.dir, 'attempts', `${attempt.id}-dispatcher-${engine}`);
    attempt.report = join(attempt.dir, 'report.json');
    attempt.label = `pf-${this.short}-dispatch-${attempt.id}`;
    mkdirSync(attempt.dir, { recursive: true });
    const eventsPath = join(attempt.dir, 'events.json'), statePath = join(attempt.dir, 'state.json');
    save(eventsPath, events);
    save(statePath, P.dispatcherSnapshot(this.state, this.config, now));
    const prompt = P.dispatcherPrompt({ role: this.config.roles.dispatcher, run: this.config.run_node, events: eventsPath,
      state: statePath, report: attempt.report, tools: engine === 'claude' ? 'the `sifttext` CLI through Bash' : 'your SiftText tools' });
    const missionFile = join(attempt.dir, 'mission.md');
    writeFileSync(missionFile, prompt);
    const fault = engine === 'claude' && this.config.faults?.claude_failure?.wake === this.state.dispatcher.wakes;
    if (fault) attempt.fault = 'claude model forced unavailable';
    this.log('dispatcher_launch', { attempt: attempt.id, engine, wake: this.state.dispatcher.wakes,
      events: events.map(event => event.type), fault: !!fault });
    this.persist();
    if (engine === 'claude') {
      const claude = this.config.dispatcher.claude;
      attempt.claude_session = randomUUID();
      this.track(this.deps.launchClaude({ label: attempt.label, model: fault ? (this.config.faults.claude_failure.model ?? 'claude-nonexistent-fault') : claude.model,
        effort: claude.effort, promptFile: missionFile, sessionId: attempt.claude_session, attemptDir: attempt.dir, report: attempt.report })
        .then(info => this.launched(attempt, { status: 'running', session_label: attempt.label, ...info }))
        .catch(error => this.launched(attempt, { status: 'setup_failed', error: String(error?.message ?? error) })));
    } else {
      const route = this.config.dispatcher.fallback;
      const policy = this.deps.writePolicy(attempt.dir, { report: attempt.report, route, role: 'dispatcher' });
      this.track(this.deps.launchPi({ label: attempt.label, route, missionFile, reportFile: attempt.report, extensionFiles: [policy], cwd: this.config.cwd })
        .then(receipt => this.launched(attempt, receipt))
        .catch(error => this.launched(attempt, { status: 'setup_failed', error: String(error?.message ?? error) })));
    }
  }

  async alive(attempt, label, now) {
    if (now - (this.checked.get(attempt.id) ?? 0) < ALIVE_MS) return true;
    this.checked.set(attempt.id, now);
    return this.deps.sessionAlive(label);
  }

  async pollPi(attempt, now) {
    let result = await this.deps.piOutcome(attempt.receipt);
    if (!result) {
      if (await this.alive(attempt, attempt.receipt.session_label, now)) return;
      result = await this.deps.piOutcome(attempt.receipt) ??
        { status: 'failed', source: 'transport', summary: 'tmux session disappeared without a durable outcome' };
    }
    if (result.status === 'needs_input') {
      attempt.awaiting_input = { at: now, question: result.summary };
      this.state.awaiting_input ??= [];
      const existing = this.state.awaiting_input.find(item => item.attempt === attempt.id);
      const pending = { task: attempt.task, attempt: attempt.id, seat: attempt.seat, question: result.summary, at: now };
      if (existing) Object.assign(existing, pending); else this.state.awaiting_input.push(pending);
      this.log('worker_needs_input', pending);
      this.persist();
      return;
    }
    let outcome;
    if (result.status === 'failed') {
      const limit = P.usageLimit(result.summary, now);
      if (limit) outcome = { kind: 'usage_limit', ...limit };
      else if (attempt.kind === 'worker' && result.source === 'technical' && /^provider\/transport failure/.test(result.summary ?? '')) {
        outcome = { kind: 'provider_failure', resetAt: now + P.REST_DEFAULT_MS, reason: result.summary, summary: result.summary };
      } else outcome = { kind: 'error', summary: result.summary };
    } else {
      try {
        const text = result.text ?? readFileSync(attempt.report, 'utf8');
        const report = attempt.kind === 'worker' ? P.validateWorkerReport(text) : P.validateDispatcherReport(text);
        if (attempt.kind === 'worker' && result.contextStopped && report.disposition === 'blocked') {
          report.disposition = 'continue';
          if (this.state.tasks[attempt.task].code && !report.next_action.trim()) throw Error('code context checkpoint requires next_action');
        }
        outcome = { kind: 'report', report, reportPath: attempt.report };
      } catch (error) {
        outcome = { kind: 'error', summary: `invalid ${attempt.kind} report: ${error.message}` };
      }
    }
    await this.settle(attempt, outcome, now);
  }

  async pollClaude(attempt, now) {
    const failure = join(attempt.dir, 'claude-failure.json'), stopped = join(attempt.dir, 'claude-stop.json');
    let outcome;
    if (existsSync(failure)) {
      const f = readJson(failure);
      const text = `${f.error ?? ''}: ${f.message ?? ''}`;
      const limit = P.usageLimit(text, now);
      outcome = limit ? { kind: 'usage_limit', ...limit } : { kind: 'error', summary: `Claude StopFailure ${text}` };
    } else if (existsSync(stopped)) {
      const s = readJson(stopped);
      outcome = this.claudeReport(attempt) ?? { kind: 'error', summary: `Claude stopped without a valid report: ${s.error ?? 'unknown'}` };
    } else if (!(await this.alive(attempt, attempt.label, now))) {
      outcome = this.claudeReport(attempt) ?? { kind: 'error', summary: 'Claude session exited without a report' };
    } else {
      const transcript = attempt.receipt?.transcript;
      const touched = transcript && existsSync(transcript) ? statSync(transcript).mtimeMs : attempt.launched_at;
      if (now - Math.max(touched, attempt.launched_at) < CLAUDE_IDLE_MS) return;
      outcome = { kind: 'error', summary: `Claude dispatcher inactive for ${CLAUDE_IDLE_MS / 60000} minutes` };
    }
    await this.settle(attempt, outcome, now);
  }

  claudeReport(attempt) {
    try { return { kind: 'report', report: P.validateDispatcherReport(readFileSync(attempt.report, 'utf8')), reportPath: attempt.report }; }
    catch { return undefined; }
  }

  async settle(attempt, outcome, now) {
    // Vet before closing: a failed tree lookup retries next tick with the session intact.
    if (attempt.kind === 'dispatcher' && outcome.kind === 'report' && outcome.report.disposition === 'done' &&
        Object.values(this.state.tasks).some(task => !['worked', 'stopped'].includes(task.status))) {
      outcome = { kind: 'error', summary: 'done refused: unfinished tasks remain (private candidates are not main publication)' };
    }
    const rejected = attempt.kind === 'dispatcher' && outcome.kind === 'report' ? await this.vetTasks(outcome.report) : new Map();
    if (attempt.kind === 'worker') {
      this.state.awaiting_input = (this.state.awaiting_input ?? []).filter(item => item.attempt !== attempt.id);
      delete attempt.awaiting_input;
      try { await this.codeOutcome(attempt, outcome, now); }
      catch (error) {
        if (error instanceof G.TaskFault) {
          // One bad item: reject it, keep the draft/evidence, free the reservation, and let the dispatcher decide.
          if (this.state.merge?.task === attempt.task) {
            this.state.tasks[attempt.task].code.phase = 'reconcile';
            this.log('merge_released', { task: attempt.task, reason: 'candidate rejected before publication grant' });
            this.state.merge = null;
          }
          this.log('candidate_rejected', { attempt: attempt.id, task: attempt.task, reason: String(error.message ?? error) });
        } else this.codeAttention(String(error), now);
        outcome = { kind: 'error', summary: String(error) };
      }
    }
    await this.deps.killSession(attempt.engine === 'claude' ? attempt.label : attempt.receipt.session_label);
    if (attempt.kind === 'worker') {
      P.finishWorker(this.state, attempt.id, outcome, now);
      this.requeueMerge(attempt);
      if (this.state.tasks[attempt.task].status === 'stopped' && this.state.merge?.task === attempt.task) {
        this.log('merge_cancelled', { task: attempt.task, reason: 'settled obsolete before publication' });
        this.state.tasks[attempt.task].code.phase = 'reconcile';
        this.state.merge = null;
      }
      this.log('worker_finish', { attempt: attempt.id, seat: attempt.seat, task: attempt.task, outcome: outcome.kind,
        disposition: outcome.report?.disposition, summary: outcome.report?.summary ?? outcome.summary ?? outcome.reason,
        report: outcome.reportPath, updated_nodes: outcome.report?.updated_nodes, evidence: outcome.report?.evidence });
      if (['usage_limit', 'provider_failure'].includes(outcome.kind) && this.state.seats[attempt.seat].resting_until === outcome.resetAt) {
        this.log('seat_rested', { seat: attempt.seat, until: new Date(outcome.resetAt).toISOString(), reason: outcome.reason, task: attempt.task });
      }
      await this.fenceCheck(now, attempt.id);
    } else {
      const effects = P.finishDispatcher(this.state, attempt.id, outcome, now, rejected);
      this.log('dispatcher_finish', { attempt: attempt.id, engine: attempt.engine, outcome: outcome.kind,
        disposition: outcome.report?.disposition, summary: outcome.report?.summary ?? outcome.summary ?? outcome.reason,
        tasks: outcome.report?.tasks, questions_for_jack: outcome.report?.questions_for_jack, effects,
        rejected: Object.fromEntries(rejected) });
      if (outcome.kind !== 'report') this.log('events_requeued', { attempt: attempt.id, events: attempt.events.map(event => event.type) });
      if (outcome.kind === 'usage_limit' && attempt.engine === 'claude') {
        this.log('seat_rested', { seat: 'claude-dispatcher', until: new Date(outcome.resetAt).toISOString(), reason: outcome.reason });
      }
      if (this.state.attention) this.log('attention', this.state.attention);
    }
    this.flushEvents();
    this.persist();
  }

  // Mechanical fence rules only: task and scope nodes must exist inside OWNER's subtree.
  async vetTasks(report) {
    const owner = this.config.owner;
    const ids = [...new Set(report.tasks.flatMap(task => [task.node_id, task.scope]))];
    const ancestry = ids.length ? await this.deps.ancestors(ids) : new Map();
    const rejected = new Map();
    for (const task of report.tasks) {
      const node = ancestry.get(task.node_id), scope = ancestry.get(task.scope);
      if (!node) rejected.set(task.node_id, 'task node not found');
      else if (task.node_id === owner || !node.includes(owner)) rejected.set(task.node_id, 'task node is outside the write fence');
      else if (!scope) rejected.set(task.node_id, 'write scope node not found');
      else if (!scope.includes(owner)) rejected.set(task.node_id, 'write scope is outside the write fence');
      else {
        try {
          G.vetCodeTask(task, this.config, this.state.tasks[task.node_id]);
          this.state.scopes[task.scope] = scope;
        } catch (error) { rejected.set(task.node_id, error.message); }
      }
    }
    if (this.state.primary_required) {
      const primary = this.config.seats.find(seat => seat.kind === 'oss');
      const active = primary && this.state.seats[primary.id]?.attempt;
      const primaryRunning = active && this.state.attempts[active]?.status === 'running';
      const primaryOrder = primary && report.tasks.some(task => !rejected.has(task.node_id) && (!task.seats || task.seats.includes(primary.id)));
      if (!primary || (!primaryRunning && !primaryOrder)) {
        for (const task of report.tasks) if (!rejected.has(task.node_id)) {
          rejected.set(task.node_id, 'RUN requires an active OSS primary contribution; do not admit Sol-only work');
        }
      }
    }
    const listed = new Set(report.tasks.map(task => task.node_id));
    const external = report.tasks.flatMap(task => task.depends_on).filter(id => !listed.has(id) && !this.state.tasks[id]);
    if (external.length) Object.assign(this.state.external, Object.fromEntries(await this.deps.statuses([...new Set(external)])));
    return rejected;
  }

  async refreshExternal(now) {
    if (now - this.externalAt < EXTERNAL_MS) return;
    const waiting = Object.values(this.state.tasks).filter(task => task.status === 'queued').flatMap(task => task.depends_on)
      .filter(id => !this.state.tasks[id] && this.state.external[id] !== 'resolved');
    this.externalAt = now;
    if (waiting.length) Object.assign(this.state.external, Object.fromEntries(await this.deps.statuses([...new Set(waiting)])));
  }

  async fenceCheck(now, attempt) {
    if (!this.config.readonly_repos.length) return;
    const results = await this.deps.fence(this.config.readonly_repos);
    const pinned = this.config.fence_heads ?? {};
    const dirty = results.filter(result => result.porcelain.trim() || (pinned[result.repo] && pinned[result.repo] !== result.head));
    this.log('fence_check', { attempt, clean: !dirty.length,
      repos: results.map(result => ({ repo: result.repo, head: result.head, dirty: !!result.porcelain.trim() })) });
    if (dirty.length && !this.state.attention) {
      this.state.attention = { reason: `read-only repository changed: ${dirty.map(result => result.repo).join(', ')}`, at: now,
        details: dirty.map(result => ({ repo: result.repo, head: result.head, porcelain: result.porcelain.slice(0, 2000) })) };
      this.log('attention', this.state.attention);
    }
  }
}
