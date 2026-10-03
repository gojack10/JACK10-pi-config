import { appendFileSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { readMonitorReceipt, sessionBranch } from '../task-outcomes/monitor-receipt.mjs';

export const ROUTE = { provider: 'local', model: 'qwen3.8-flash-next', thinking: 'xhigh' };
export const ROOT = 'ef189bb9-0df0-4ee8-950f-12f3c4ee243c';
const TASKS = {
  bf2: { name: 'bf2', route: ROUTE, root: ROOT, ready: 'ready_for_user_test' },
  yc: { name: 'yc', route: { provider: 'openai-codex-personal', model: 'gpt-6.1-sol', thinking: 'xhigh' },
    root: '091fb17d-2764-4bfd-9f30-d59d03f6d077', ready: 'ready_for_interview' },
};
export function taskSettings(name = 'bf2') {
  if (['yc-profile', 'yc-read-0', 'yc-read-1', 'yc-read-2'].includes(name)) {
    return { ...TASKS.yc, name, ready: name === 'yc-profile' ? 'profile_ready' : 'reads_complete' };
  }
  if (!Object.hasOwn(TASKS, name)) throw Error(`Unknown factory task: ${name}`);
  return TASKS[name];
}
export function taskRuns(base, name = 'bf2') {
  taskSettings(name);
  // Keep the live legacy BF2 controller's LOCK/LAST paths unchanged.
  return name === 'bf2' ? base : join(base, name);
}
export function factoryActivity(sessionNames, processCommands, directory, name = 'bf2') {
  taskSettings(name);
  return {
    sessions: sessionNames.filter(session => new RegExp(`^${name}-(factory|planner|worker)-`).test(session)),
    controller: processCommands.some(command => command.includes('dark-factory/run.mjs controller') && command.includes(directory)),
  };
}
export function save(path, value) {
  writeFileSync(`${path}.tmp`, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}
export function validateReport(text, role, smoke = false, project = taskSettings()) {
  const r = JSON.parse(text);
  if (r.version !== 1 || r.role !== role || typeof r.summary !== 'string' || !r.summary.trim()) throw Error('invalid report identity/summary');
  const allowed = role === 'planner' ? ['next', project.ready, 'blocked', 'continue'] : ['worked', 'blocked', 'continue'];
  if (!allowed.includes(r.disposition)) throw Error('invalid disposition');
  if (!Array.isArray(r.evidence) || !r.evidence.every(p => typeof p === 'string' && isAbsolute(p) && existsSync(p))) throw Error('missing evidence');
  if (!Array.isArray(r.updated_nodes) || !r.updated_nodes.every(id => typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id))) throw Error('invalid updated_nodes');
  if (smoke && r.updated_nodes.length) throw Error('smoke must not mutate tree');
  if (!smoke && !['blocked', 'continue'].includes(r.disposition)) {
    if (project.name === 'bf2' && r.updated_nodes.length === 0) throw Error('completed project work requires verified tree writes');
    if (project.name !== 'bf2' && r.evidence.length === 0) throw Error('completed project work requires evidence');
  }
  if (r.disposition === 'next' && (!r.task || typeof r.task.instruction !== 'string' || !r.task.instruction.trim() || typeof r.task.acceptance !== 'string' || !r.task.acceptance.trim())) throw Error('next requires bounded task and acceptance');
  if (r.disposition === 'ready_for_user_test' && (smoke || r.evidence.length < 2 || typeof r.launch_command !== 'string' || !r.launch_command.trim())) throw Error('ready requires launch command and launch/UI evidence');
  if (['ready_for_interview', 'profile_ready', 'video_ready'].includes(r.disposition) && (smoke || r.evidence.length < 2 || !r.updated_nodes.length)) throw Error('ready requires coverage/profile evidence and verified profile node IDs');
  return r;
}

// Use the monitor-selected ancestry and exact attempt identity, never a prose mention of 80%.
export function readAttemptResult(receipt) {
  const manifest = JSON.parse(readFileSync(receipt.manifest_file, 'utf8'));
  if (manifest.jobId !== receipt.job || manifest.attemptId !== receipt.attempt_id || manifest.reportPath !== receipt.report_file) {
    throw Error('factory attempt identity mismatch');
  }
  const text = readFileSync(receipt.session_file, 'utf8');
  const sessionId = JSON.parse(text.split('\n')[0]).id;
  const outcome = readMonitorReceipt(receipt.session_file, { sessionId, jobId: receipt.job, attemptId: receipt.attempt_id,
    mode: 'task', reportPath: receipt.report_file, reportIdentity: manifest.reportIdentity });
  if (outcome.state !== 'final' || outcome.payload.source !== 'model' || !['completed', 'blocked'].includes(outcome.payload.outcome)) {
    throw Error('factory attempt has no settled model report');
  }
  const stat = statSync(receipt.report_file);
  if (!stat.isFile() || !stat.size || String(stat.dev) !== manifest.reportIdentity.dev || String(stat.ino) !== manifest.reportIdentity.ino) {
    throw Error('factory report identity changed');
  }
  const reportText = readFileSync(receipt.report_file, 'utf8');
  if (outcome.payload.report_text !== undefined && outcome.payload.report_text !== reportText) throw Error('factory report changed after settlement');
  const contextStopped = sessionBranch(text, sessionId, outcome.branchLeafId).some(entry =>
    entry.type === 'custom' && entry.customType === 'rlm-friendly-stop-state' && entry.data?.version === 2 &&
    entry.data.jobId === receipt.job && entry.data.attemptId === receipt.attempt_id);
  return { text: reportText, receipt, outcome, contextStopped };
}

export function isContinuation(report, contextStopped) {
  return report.disposition === 'continue' || (contextStopped && report.disposition === 'blocked');
}

export function continuationAfterStop(state, history) {
  const last = history.at(-1);
  if (state.status !== 'stopped' || !last?.receipt || !last.reportPath || last.step + 1 !== state.step ||
      !['planner', 'worker'].includes(last.role) ||
      (!['next', 'worked'].includes(last.report?.disposition) && !last.contextCheckpoint)) {
    throw Error('Graceful-stop continuation requires the immediately preceding verified checkpoint.');
  }
  return { ...state, role: state.role ?? (last.contextCheckpoint ? last.role : last.role === 'worker' ? 'planner' : 'worker'),
    previous: last.reportPath, ...(last.contextCheckpoint ? { task: last.task } : {}) };
}

// The adapter owns canonical tmux START/outcome verification; the loop never infers success from exit.
export async function runLoop({ directory, smoke, runStep, project = taskSettings(), resume, assignments, maxSteps = smoke ? 2 : 10000 }) {
  const statePath = join(directory, 'state.json');
  if (existsSync(statePath) && !resume) throw Error('existing run: reconcile its retained attempt before restarting; no blind replay');
  let previous = resume?.previous ?? null, task = resume?.task ?? null;
  let assignmentIndex = resume?.assignmentIndex ?? 0;
  let role = assignments ? 'worker' : resume?.role ?? ((resume?.step ?? 1) % 2 ? 'planner' : 'worker');
  if (assignments && previous && JSON.parse(readFileSync(previous, 'utf8')).tree_id !== assignments[assignmentIndex]?.tree_id) previous = null;
  const fingerprints = new Set();
  for (let step = resume?.step ?? 1; step <= maxSteps; step++) {
    if (assignments && assignmentIndex === assignments.length) {
      save(statePath, { status: 'reads_complete', step, assignmentIndex, previous }); return;
    }
    if (assignments) task = assignments[assignmentIndex];
    if (existsSync(join(directory, 'STOP'))) { save(statePath, { status: 'stopped', step, role, previous, task, assignmentIndex }); return; }
    save(statePath, { status: 'running', step, role, previous, task, assignmentIndex });
    const reportPath = join(directory, `${step}-${role}.json`);
    const result = await runStep({ step, role, reportPath, previous, task });
    const report = validateReport(result.text, role, smoke, project);
    const contextCheckpoint = isContinuation(report, result.contextStopped);
    if (assignments && report.disposition === 'worked') {
      if (report.tree_id !== task.tree_id || report.updated_nodes.length) throw Error('reader report tree identity/write mismatch');
      const packet = report.tree_packet;
      if (typeof packet !== 'string' || !isAbsolute(packet) || !report.evidence.includes(packet)) throw Error('missing reader evidence packet');
      const data = JSON.parse(readFileSync(packet, 'utf8'));
      if (data.tree_id !== task.tree_id || data.root_id !== task.root_id || data.outline_complete !== true ||
          !Array.isArray(data.content_read_ids) || !data.content_read_ids.includes(task.root_id) ||
          !Array.isArray(data.findings) || !Array.isArray(data.exclusions) ||
          !Array.isArray(data.remaining_work) || data.remaining_work.length) throw Error('invalid tree coverage packet');
    }
    const completed = { step, role, reportPath, receipt: result.receipt, report, task, assignmentIndex, contextCheckpoint: !!contextCheckpoint };
    appendFileSync(join(directory, 'history.jsonl'), JSON.stringify(completed) + '\n');
    save(statePath, { status: contextCheckpoint ? 'context_checkpoint' : 'checkpoint', ...completed });
    previous = reportPath;
    if (contextCheckpoint) continue; // Fresh agent, same role/assignment, retained partial report.
    if (report.disposition === 'blocked' || report.disposition === project.ready) {
      save(statePath, { status: report.disposition, ...completed }); return;
    }
    if (assignments) {
      assignmentIndex++;
      previous = null;
      const entries = readFileSync(join(directory, 'history.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
      save(join(directory, 'completed-trees.json'), entries.filter(e => e.report.disposition === 'worked').map(e =>
        ({ tree_id: e.task.tree_id, root_id: e.task.root_id, tree_packet: e.report.tree_packet, reportPath: e.reportPath })));
      continue;
    }
    if (role === 'planner') {
      const fingerprint = createHash('sha256').update(JSON.stringify(report.task)).digest('hex');
      if (fingerprints.has(fingerprint)) throw Error('identical task repeated: stopping instead of blind retry');
      fingerprints.add(fingerprint);
      task = report.task;
    }
    role = role === 'planner' ? 'worker' : 'planner';
  }
  save(statePath, { status: smoke ? 'smoke_passed' : 'step_limit', steps: maxSteps, previous });
}

export function mission({ role, reportPath, previous, task, smoke, directory, contract, project = taskSettings() }) {
  const ready = project.name === 'bf2'
    ? 'ready_for_user_test (requires launch_command:string and at least two evidence files: actual launch log and actual game UI evidence)'
    : `${project.ready} (requires at least two evidence artifacts proving this lane's coverage/validation, plus verified node IDs; stop before human dialogue)`;
  const schema = `Write ONLY a JSON object into ${reportPath} (the launcher has reserved this file; write in place, do not rename it). Fields: version:1, role:${JSON.stringify(role)}, disposition, summary:string, evidence:absolute-existing-artifact-path[], updated_nodes:UUID[]. Planner dispositions: next (requires task:{instruction:string,acceptance:string}), ${ready}, blocked, or continue. Worker dispositions: worked, blocked, or continue. If FRIENDLY STOP interrupts unfinished work, use continue, recording completed work, exact evidence, remaining work and the next bounded action; the factory gives the same assignment and this report to a fresh agent of the same role. This does not complete the assignment. Reserve blocked for a real prerequisite/authority/safety blocker, not context capacity. A successor must read its preceding checkpoint and resume unfinished work, verify any landed effects before writing, and not replay completed actions or spend an already-used launch budget. Use completed in report_outcome after the valid report is written, even for a disproved hypothesis, context checkpoint or completed blocked-status report. A technical inability to finish the report is failed. End the turn after report_outcome. Do not launch child agents or untracked background processes. Do not change model/provider/thinking. No human dialogue is available.`;
  if (smoke) return `Read-only transport smoke, not project research. Do not read SiftText or methodology nodes: this is a bounded file-reading fixture. No bash, network, game launch, code edits, or tree writes. Use read on ${join(directory, 'fixture.txt')}${previous ? ` and preceding report ${previous}` : ''}. ${role === 'planner' ? 'Return next with a tiny task asking the worker to report the fixture text, acceptance exact fixture text.' : 'Report the fixture text and whether the preceding planner report was readable; return worked.'} Evidence lists the fixture path. updated_nodes is []. Your only write is your reserved report. ${schema}`;
  if (project.name !== 'bf2') return `${contract}\n\nROLE: ${role}. Project owner: ${project.root}. Run directory: ${directory}. Previous report: ${previous ?? 'none (initial entry)'}.\n${role === 'planner'
    ? `Review the current checkpoint, preceding report and actual evidence. Select exactly one bounded next task under the contract, with named inputs, acceptance check, result recipient and stop condition. The report task object is the assignment artifact; do not perform the worker task. Advance phases only after their coverage and landed content are verified. Return ${project.ready} only at this lane's contract completion boundary, or blocked for an unresolved prerequisite. Never manufacture Jack's answers.`
    : `Execute only this assigned task: ${JSON.stringify(task)}. Verify inputs, read the applicable rules and source material, perform the task and checks, reconcile only authorized changes, and read back changed nodes. Return evidence and remaining uncertainty, not a self-selected next assignment. Artifact-only tasks may have updated_nodes:[]; report actual writes, never invented IDs.`}\n${schema}`;
  return `${contract}\n\nROLE: ${role}. BF2 owner: ${ROOT}. Run directory: ${directory}. Previous report: ${previous ?? 'none (initial entry)'}.\n${role === 'planner' ? 'Read the current tree and required project entry rules. Review the previous report and load-bearing evidence, if any. Choose exactly one bounded next assignment. Reuse an existing node where possible. A reconciliation of stale/contradicted nodes is a legitimate worker assignment. Commit and read back the assignment before returning next. Do not perform the research assignment yourself. Review evidence, not just PASS claims. Never declare the game ready based on model progress or process survival.' : `Execute only the assigned bounded task: ${JSON.stringify(task)}. Read its owner, prerequisites and required rules. Verify inputs; perform the work and checks, commit results and affected corrections, and read back the changed nodes. Do not select the next task. Record failures truthfully; a failed experiment is a result, not permission to abandon the game outcome.`}\n${schema}`;
}
