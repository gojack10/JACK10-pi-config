import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';

// Pure seat/event/report rules for the parallel factory (Parallel Execution Contract d96507db).
// No model turns, no IO beyond existence checks for reported evidence paths.

export const ROLE_NODES = {
  dispatcher: '49953135-1fed-4cf7-a418-6f7373568021',
  worker: '1f813223-62ad-4e2c-bde2-11f217d5f3e5',
};
export const ROUTES = {
  oss: { provider: 'local', model: 'qwen3.8-flash-next', thinking: 'xhigh' },
  codex: { provider: 'openai-codex-personal', model: 'gpt-6.1-sol', thinking: 'high' },
};
export const CLAUDE = { model: 'claude-opus-5-5[1m]', effort: 'xhigh' };
export const REST_DEFAULT_MS = 30 * 60_000;
export const CONTINUE_LIMIT = 3;
export const DISPATCH_FAILURE_LIMIT = 3;
export const PROVIDER_FAILURE_LIMIT = 3;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const isNodeId = value => typeof value === 'string' && UUID.test(value);

export function buildConfig({ runNode, owner, repos = [], directory, cwd, overrides = {} }) {
  if (!isNodeId(runNode) || !isNodeId(owner)) throw Error('RUN and OWNER must be node UUIDs');
  const routes = { ...ROUTES, ...overrides.routes };
  const fallback = overrides.routes?.fallback ?? routes.codex;
  const dispatcherEngine = overrides.dispatcher_engine ?? 'fallback';
  if (!['fallback', 'claude'].includes(dispatcherEngine)) throw Error('dispatcher_engine must be fallback or claude');
  const codexSeats = overrides.codex_seats ?? 3;
  if (!Number.isInteger(codexSeats) || codexSeats < 0 || codexSeats > 3) throw Error('codex_seats must be 0-3');
  // OSS first, then Codex: seat order is the fill order.
  const seats = [{ id: 'oss', kind: 'oss', route: routes.oss },
    ...Array.from({ length: codexSeats }, (_, i) => ({ id: `codex-${i + 1}`, kind: 'codex', route: routes.codex }))];
  for (const seat of seats) {
    const route = overrides.seat_routes?.[seat.id] ?? seat.route;
    if (!route?.provider || !route.model || !route.thinking) throw Error(`seat ${seat.id} needs provider/model/thinking`);
    seat.route = route;
  }
  return {
    version: 1, run_node: runNode, owner, readonly_repos: repos, directory, cwd,
    roles: { ...ROLE_NODES, ...overrides.roles },
    seats,
    dispatcher: { engine: dispatcherEngine, claude: { ...CLAUDE, ...overrides.claude }, fallback },
    faults: overrides.faults ?? {},
  };
}

// RUN nodes name their OWNER and read-only repositories in prose; take only the explicit labelled lines.
export function parseRunNode(text) {
  // The OWNER line's first node UUID: a [[Name|uuid]] link, or a structural child reference with its id.
  const owner = /OWNER:[^\n]*?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/.exec(text)?.[1];
  const repos = [];
  for (const line of text.matchAll(/Read-only repositor(?:y|ies):([^\n]*)/g)) {
    for (const path of line[1].matchAll(/`((?:~|\/)[^`]*)`/g)) repos.push(path[1]);
  }
  return { owner, repos };
}

const uuids = (value, name) => {
  if (!Array.isArray(value) || !value.every(isNodeId)) throw Error(`${name} must be an array of node UUIDs`);
  return value;
};
const strings = (value, name) => {
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) throw Error(`${name} must be an array of strings`);
  return value;
};
const parse = text => {
  if (typeof text !== 'string') return text;
  try { return JSON.parse(text); } catch (error) { throw Error(`report is not valid JSON: ${error.message}`); }
};

export function validateDispatcherReport(text) {
  const r = parse(text);
  if (!r || typeof r !== 'object' || r.version !== 1 || r.role !== 'dispatcher') throw Error('report needs version 1 and role "dispatcher"');
  if (!['tasks', 'done', 'blocked'].includes(r.disposition)) throw Error('disposition must be tasks, done or blocked');
  if (typeof r.summary !== 'string' || !r.summary.trim()) throw Error('summary must be a nonempty string');
  if (!Array.isArray(r.tasks)) throw Error('tasks must be an array');
  const seen = new Set();
  const tasks = r.tasks.map((task, index) => {
    if (!task || !isNodeId(task.node_id)) throw Error(`tasks[${index}].node_id must be a node UUID`);
    if (!isNodeId(task.scope)) throw Error(`tasks[${index}].scope must be the write-scope node UUID`);
    uuids(task.depends_on, `tasks[${index}].depends_on`);
    if (task.depends_on.includes(task.node_id)) throw Error(`tasks[${index}] depends on itself`);
    if (seen.has(task.node_id)) throw Error(`task ${task.node_id} is listed twice`);
    seen.add(task.node_id);
    return { node_id: task.node_id, depends_on: [...task.depends_on], scope: task.scope };
  });
  const report = {
    version: 1, role: 'dispatcher', disposition: r.disposition, summary: r.summary, tasks,
    stop_running: uuids(r.stop_running ?? [], 'stop_running'),
    updated_nodes: uuids(r.updated_nodes ?? [], 'updated_nodes'),
    questions_for_jack: strings(r.questions_for_jack ?? [], 'questions_for_jack'),
  };
  if (report.disposition !== 'tasks' && tasks.length) throw Error(`${report.disposition} requires an empty tasks list`);
  if (report.disposition === 'blocked' && !report.questions_for_jack.length) throw Error('blocked requires questions_for_jack');
  return report;
}

export function validateWorkerReport(text) {
  const r = parse(text);
  if (!r || typeof r !== 'object' || r.version !== 1 || r.role !== 'worker') throw Error('report needs version 1 and role "worker"');
  if (!['worked', 'continue', 'blocked'].includes(r.disposition)) throw Error('disposition must be worked, continue or blocked');
  if (typeof r.summary !== 'string' || !r.summary.trim()) throw Error('summary must be a nonempty string');
  strings(r.evidence, 'evidence');
  for (const path of r.evidence) if (!isAbsolute(path) || !existsSync(path)) throw Error(`evidence path must be absolute and exist: ${path}`);
  uuids(r.updated_nodes, 'updated_nodes');
  for (const key of ['remaining_work', 'next_action']) {
    if (r[key] !== undefined && typeof r[key] !== 'string') throw Error(`${key} must be a string`);
  }
  if (r.disposition === 'continue' && !(r.next_action ?? '').trim()) throw Error('continue requires next_action');
  return { ...r, remaining_work: r.remaining_work ?? '', next_action: r.next_action ?? '' };
}

// Codex: "You have hit your ChatGPT usage limit (plus plan). Try again in ~42 min."
// Claude: "You've hit your limit · resets 3pm (America/Los_Angeles)" or StopFailure error "rate_limit".
const LIMIT = /usage[_ ]limit|hit your (?:usage )?limit|usage_not_included|rate[_ ]?limit|too many requests|\b429\b/i;
export function usageLimit(text, now = Date.now()) {
  if (typeof text !== 'string' || !LIMIT.test(text)) return undefined;
  const reason = text.slice(0, 500);
  const minutes = /try again in ~?\s*(\d+)\s*min/i.exec(text);
  if (minutes) return { resetAt: now + Math.max(1, Number(minutes[1])) * 60_000, reason };
  const clock = /resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i.exec(text);
  if (clock) {
    const at = new Date(now);
    let hour = Number(clock[1]) % 12 + (clock[3].toLowerCase() === 'pm' ? 12 : 0);
    at.setHours(hour, Number(clock[2] ?? 0), 0, 0);
    if (at.getTime() <= now) at.setDate(at.getDate() + 1);
    return { resetAt: at.getTime(), reason };
  }
  const epoch = /\|(\d{10})\b/.exec(text);
  if (epoch && Number(epoch[1]) * 1000 > now) return { resetAt: Number(epoch[1]) * 1000, reason };
  return { resetAt: now + REST_DEFAULT_MS, reason };
}

export function initialState(config, now) {
  return {
    version: 1, status: 'running', created_at: now, seq: 0,
    wake: false, pending_events: [], oss_idle_emitted: true,
    tasks: {}, order: [], scopes: {}, external: {},
    seats: Object.fromEntries(config.seats.map(seat => [seat.id, { attempt: null, resting_until: null, launches: 0 }])),
    attempts: {},
    dispatcher: { attempt: null, last: null, failures: 0, wakes: 0, claude_resting_until: null, claude_skip: false },
    stop: null, attention: null, fence: null,
  };
}

export function addEvent(state, event, now) {
  state.pending_events.push({ ...event, at: now });
  state.wake = true;
}

export function seatFree(state, id, now) {
  const seat = state.seats[id];
  return !!seat && !seat.attempt && !(seat.resting_until && seat.resting_until > now);
}

export function depsMet(state, task) {
  return task.depends_on.every(id => state.tasks[id]?.status === 'worked' || state.external[id] === 'resolved');
}

// Write scopes overlap when one is the other or an ancestor of it. Unknown ancestry overlaps conservatively.
export function overlaps(a, b, scopes) {
  if (a === b) return true;
  const up = id => scopes[id];
  if (!up(a) || !up(b)) return true;
  return up(a).includes(b) || up(b).includes(a);
}

const ready = state => state.order.map(id => state.tasks[id])
  .filter(task => task.status === 'queued' && depsMet(state, task))
  .sort((a, b) => Number(!!b.front) - Number(!!a.front));

export function planAssignments(state, config, now) {
  if (state.status !== 'running' || state.stop || state.attention) return [];
  if (['done', 'blocked'].includes(state.dispatcher.last?.disposition)) return [];
  const taken = Object.values(state.tasks).filter(task => task.status === 'running').map(task => task.scope);
  const candidates = ready(state), assignments = [];
  for (const seat of config.seats) {
    if (!seatFree(state, seat.id, now)) continue;
    const pick = candidates.find(task => !assignments.some(a => a.task === task.node_id) &&
      !taken.some(scope => overlaps(scope, task.scope, state.scopes)));
    if (!pick) continue;
    assignments.push({ seat: seat.id, task: pick.node_id });
    taken.push(pick.scope);
  }
  return assignments;
}

// One wake per idle period: only when nothing else will wake the dispatcher.
export function ossIdle(state, config, now, assignments) {
  const oss = config.seats.find(seat => seat.kind === 'oss');
  if (!oss || state.oss_idle_emitted || state.wake || state.dispatcher.attempt) return false;
  if (state.status !== 'running' || state.stop || state.attention) return false;
  if (!seatFree(state, oss.id, now) || assignments.some(a => a.seat === oss.id)) return false;
  state.oss_idle_emitted = true;
  addEvent(state, { type: 'oss_idle', seat: oss.id }, now);
  return true;
}

export function startAttempt(state, attempt) {
  state.seq += 1;
  const id = `${state.seq}`;
  state.attempts[id] = { id, status: 'launching', ...attempt };
  if (attempt.kind === 'worker') {
    const task = state.tasks[attempt.task];
    task.status = 'running';
    task.front = false;
    task.attempts.push(id);
    state.seats[attempt.seat].attempt = id;
    state.seats[attempt.seat].launches += 1;
    if (attempt.seat_kind === 'oss') state.oss_idle_emitted = false;
  } else {
    state.dispatcher.attempt = id;
    state.dispatcher.wakes += 1;
    state.oss_idle_emitted = true;
  }
  return state.attempts[id];
}

export function takeEvents(state) {
  const events = state.pending_events;
  state.pending_events = [];
  state.wake = false;
  return events;
}

export function dispatcherEngine(state, now) {
  const d = state.dispatcher;
  if (d.claude_skip) return 'fallback';
  if (d.claude_resting_until && d.claude_resting_until > now) return 'fallback';
  return 'claude';
}

// outcome: { kind: 'report', report, reportPath } | { kind: 'usage_limit', resetAt, reason } | { kind: 'error', summary }
export function finishWorker(state, id, outcome, now) {
  const attempt = state.attempts[id];
  const task = state.tasks[attempt.task];
  const seat = state.seats[attempt.seat];
  Object.assign(attempt, { status: 'finished', finished_at: now, outcome: outcomeRecord(outcome) });
  if (seat.attempt === id) seat.attempt = null;
  if (outcome.kind === 'provider_failure') {
    // A provider that keeps failing after Pi's own retries is unavailable capacity, not task work.
    // Bounded per task so a task that itself breaks providers still reaches the dispatcher.
    task.provider_failures = (task.provider_failures ?? 0) + 1;
    if (task.provider_failures >= PROVIDER_FAILURE_LIMIT) {
      task.status = 'errored';
      addEvent(state, { type: 'task_errored', task: task.node_id, seat: attempt.seat, summary: outcome.summary }, now);
      return {};
    }
  }
  if (['usage_limit', 'launch_failed', 'provider_failure'].includes(outcome.kind)) {
    // Capacity, not work: rest the seat and requeue the task unchanged for the next free seat.
    seat.resting_until = outcome.resetAt;
    task.status = 'queued';
    task.front = true;
    return { rested: attempt.seat };
  }
  if (outcome.kind === 'error') {
    task.status = 'errored';
    addEvent(state, { type: 'task_errored', task: task.node_id, seat: attempt.seat, summary: outcome.summary }, now);
    return {};
  }
  const report = outcome.report;
  task.last_report = outcome.reportPath;
  if (report.disposition === 'worked') {
    task.status = 'worked';
    addEvent(state, { type: 'task_finished', task: task.node_id, seat: attempt.seat, report: outcome.reportPath }, now);
  } else if (report.disposition === 'blocked') {
    task.status = 'blocked';
    addEvent(state, { type: 'task_blocked', task: task.node_id, seat: attempt.seat, report: outcome.reportPath }, now);
  } else if (task.stop_requested === 'obsolete') {
    task.status = 'stopped';
    task.previous = outcome.reportPath;
  } else {
    task.previous = outcome.reportPath;
    if (task.stop_requested === 'operator') {
      // An operator stop is not a friendly stop: keep the continuation for resume without counting it.
      task.status = 'queued';
      task.front = true;
    } else {
      task.continues += 1;
      if (task.continues >= CONTINUE_LIMIT) {
        task.status = 'needs_split';
        addEvent(state, { type: 'task_continued_three_times', task: task.node_id, seat: attempt.seat, report: outcome.reportPath }, now);
      } else {
        task.status = 'queued';
        task.front = true;
      }
    }
  }
  delete task.stop_requested;
  return {};
}

const outcomeRecord = outcome => outcome.kind === 'report'
  ? { kind: 'report', disposition: outcome.report.disposition, report: outcome.reportPath }
  : { ...outcome, report: undefined };

// check: Map node_id -> rejection reason, computed by the host from tree ancestry before applying.
export function finishDispatcher(state, id, outcome, now, rejected = new Map()) {
  const attempt = state.attempts[id];
  const d = state.dispatcher;
  Object.assign(attempt, { status: 'finished', finished_at: now, outcome: outcomeRecord(outcome) });
  if (d.attempt === id) d.attempt = null;
  if (attempt.engine === 'fallback') d.claude_skip = false;
  if (outcome.kind !== 'report') {
    // Coalescing loses nothing: hand the same events to the next dispatcher.
    state.pending_events.unshift(...attempt.events.map(event => ({ ...event, logged: true })));
    state.wake = true;
    d.failures += 1;
    if (attempt.engine === 'claude') {
      if (outcome.kind === 'usage_limit') d.claude_resting_until = outcome.resetAt;
      else d.claude_skip = true;
    }
    if (d.failures >= DISPATCH_FAILURE_LIMIT) state.attention = { reason: `${d.failures} consecutive dispatcher failures`, at: now };
    return { accepted: [], ignored: [], rejected: [], stop: [] };
  }
  const report = outcome.report;
  const effects = { accepted: [], ignored: [], rejected: [], stop: [] };
  for (const listed of report.tasks) {
    if (rejected.has(listed.node_id)) {
      effects.rejected.push(listed.node_id);
      addEvent(state, { type: 'task_rejected', task: listed.node_id, summary: rejected.get(listed.node_id) }, now);
      continue;
    }
    const known = state.tasks[listed.node_id];
    if (known && ['running', 'worked'].includes(known.status)) { effects.ignored.push(listed.node_id); continue; }
    if (known) Object.assign(known, { depends_on: listed.depends_on, scope: listed.scope, status: 'queued', continues: 0, provider_failures: 0, front: false, relisted_at: now });
    else {
      state.tasks[listed.node_id] = { node_id: listed.node_id, depends_on: listed.depends_on, scope: listed.scope,
        status: 'queued', continues: 0, previous: null, attempts: [], listed_at: now };
      state.order.push(listed.node_id);
    }
    effects.accepted.push(listed.node_id);
  }
  for (const node of report.stop_running) {
    if (state.tasks[node]?.status === 'running') { state.tasks[node].stop_requested = 'obsolete'; effects.stop.push(node); }
  }
  d.last = { disposition: report.disposition, at: now, attempt: id };
  // A report whose every task was refused cannot make progress on its own; count it toward attention.
  d.failures = effects.rejected.length && !effects.accepted.length ? d.failures + 1 : 0;
  if (d.failures >= DISPATCH_FAILURE_LIMIT) state.attention = { reason: `${d.failures} consecutive dispatcher reports without an acceptable task`, at: now };
  return effects;
}

export function running(state) {
  return Object.values(state.attempts).filter(attempt => ['launching', 'running'].includes(attempt.status));
}

// Returns the terminal status once nothing is in flight and nothing can start, else undefined.
export function terminalStatus(state, config, now) {
  if (running(state).length) return undefined;
  if (state.attention) return 'needs_attention';
  if (state.stop) return 'stopped';
  if (state.wake) return undefined;
  if (planAssignments(state, config, now).length) return undefined;
  const queued = Object.values(state.tasks).filter(task => task.status === 'queued');
  const last = state.dispatcher.last?.disposition;
  if (last === 'done') return 'done';
  if (last === 'blocked') return 'blocked';
  const resting = Object.values(state.seats).some(seat => seat.resting_until && seat.resting_until > now);
  if (queued.some(task => depsMet(state, task)) && resting) return undefined;
  return 'idle';
}

export function dispatcherSnapshot(state, config, now) {
  const seatRows = config.seats.map(seat => ({ seat: seat.id, kind: seat.kind, route: seat.route, ...state.seats[seat.id] }));
  return {
    version: 1,
    run_node: config.run_node,
    owner: config.owner,
    running: seatRows.filter(seat => seat.attempt && state.attempts[seat.attempt]?.kind === 'worker')
      .map(seat => ({ task: state.attempts[seat.attempt].task, seat: seat.seat, since: state.attempts[seat.attempt].launched_at })),
    free_seats: seatRows.filter(seat => seatFree(state, seat.seat, now)).map(seat => ({ seat: seat.seat, kind: seat.kind })),
    resting_seats: seatRows.filter(seat => !seat.attempt && seat.resting_until && seat.resting_until > now)
      .map(seat => ({ seat: seat.seat, kind: seat.kind, until: new Date(seat.resting_until).toISOString() })),
    queued_ready: ready(state).map(task => task.node_id),
    waiting_on_dependencies: state.order.filter(id => state.tasks[id].status === 'queued' && !depsMet(state, state.tasks[id])),
    tasks: state.order.map(id => ({ node_id: id, status: state.tasks[id].status, depends_on: state.tasks[id].depends_on,
      scope: state.tasks[id].scope, continues: state.tasks[id].continues })),
  };
}

// Prompts carry pointers only; every instruction lives in the role nodes.
export function dispatcherPrompt({ role, run, events, state, report, tools }) {
  return [
    `You are a factory dispatcher. Read the ROLE node with ${tools} and follow it exactly.`,
    `ROLE: ${role}`, `RUN: ${run}`, `EVENTS: ${events}`, `STATE: ${state}`, `REPORT: ${report}`,
  ].join('\n') + '\n';
}

export function workerPrompt({ role, run, task, report, previous, artifacts }) {
  return [
    'You are a factory worker. Read the ROLE node with your SiftText tools and follow it exactly.',
    `ROLE: ${role}`, `RUN: ${run}`, `TASK: ${task}`, `REPORT: ${report}`,
    ...(previous ? [`PREVIOUS: ${previous}`] : []),
    `ARTIFACTS: ${artifacts} (directory for any files you create)`,
  ].join('\n') + '\n';
}
