import { appendFileSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { readMonitorReceipt, sessionBranch } from '../task-outcomes/monitor-receipt.mjs';
import { homedir } from 'node:os';

export const ROUTE = { provider: 'local', model: 'qwen3.8-flash-next', thinking: 'xhigh' };
const LOCAL_PROJECTS = join(homedir(), '.pi/agent/factory-projects.local.json');
export function taskSettings(name = 'task', projects = existsSync(LOCAL_PROJECTS)
  ? JSON.parse(readFileSync(LOCAL_PROJECTS, 'utf8')) : {}) {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) throw Error('Invalid factory task name');
  if (!projects || typeof projects !== 'object' || Array.isArray(projects)) throw Error('Invalid factory project configuration');
  const project = Object.hasOwn(projects, name) ? projects[name]
    : name === 'task' ? { route: ROUTE, ready: 'complete' } : undefined;
  if (!project) throw Error(`Unknown factory task: ${name}; configure its SiftText instruction entry in ${LOCAL_PROJECTS}`);
  if (!project || typeof project !== 'object' || !project.route ||
      !['provider', 'model', 'thinking'].every(key => typeof project.route[key] === 'string' && project.route[key].trim()) ||
      !['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(project.route.thinking) ||
      typeof project.ready !== 'string' || !/^[a-z][a-z0-9_]*$/.test(project.ready) ||
      ['next', 'worked', 'blocked', 'continue', 'excluded'].includes(project.ready) ||
      (project.root !== undefined && !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(project.root))) throw Error('Invalid factory project configuration');
  return { ...project, name };
}
export function taskRuns(base, name = 'task') {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) throw Error('Invalid factory task name');
  return name === 'task' ? base : join(base, name);
}
export function factoryActivity(sessionNames, processCommands, directory, name = 'task') {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) throw Error('Invalid factory task name');
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
  const allowed = role === 'planner' ? ['next', project.ready, 'blocked', 'continue']
    : ['worked', 'blocked', 'continue', ...(project.ready === 'reads_complete' && project.excludeUnreadable ? ['excluded'] : [])];
  if (!allowed.includes(r.disposition)) throw Error('invalid disposition');
  if (!Array.isArray(r.evidence) || !r.evidence.every(p => typeof p === 'string' && isAbsolute(p) && existsSync(p))) throw Error('missing evidence');
  if (!Array.isArray(r.updated_nodes) || !r.updated_nodes.every(id => typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id))) throw Error('invalid updated_nodes');
  if (smoke && r.updated_nodes.length) throw Error('smoke must not mutate tree');
  if (!smoke && !['blocked', 'continue'].includes(r.disposition)) {
    if (project.requireTreeWrites && r.updated_nodes.length === 0) throw Error('completed project work requires verified tree writes');
    if (r.evidence.length === 0) throw Error('completed project work requires evidence');
  }
  if (project.lean && !smoke && r.disposition === 'next' && Array.isArray(r.task?.acceptance) &&
      r.task.acceptance.every(item => typeof item === 'string')) r.task.acceptance = r.task.acceptance.join('\n');
  if (project.lean && r.disposition === 'next' && r.task &&
      !r.task.tree_id && typeof r.tree_id === 'string') r.task.tree_id = r.tree_id;
  if (r.disposition === 'next' && (!r.task || typeof r.task.instruction !== 'string' || !r.task.instruction.trim() || typeof r.task.acceptance !== 'string' || !r.task.acceptance.trim())) throw Error('next requires bounded task and acceptance');
  if (r.disposition === project.ready && (smoke || r.evidence.length === 0)) throw Error('ready requires evidence from an authorized run');
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
      (!['next', 'worked', 'excluded'].includes(last.report?.disposition) && !last.contextCheckpoint)) {
    throw Error('Graceful-stop continuation requires the immediately preceding verified checkpoint.');
  }
  return { ...state, role: state.role ?? (last.contextCheckpoint ? last.role : last.role === 'worker' ? 'planner' : 'worker'),
    previous: last.reportPath, ...(last.contextCheckpoint ? { task: last.task } : {}) };
}

// The adapter owns canonical tmux START/outcome verification; the loop never infers success from exit.
export async function runLoop({ directory, smoke, runStep, project = taskSettings(), resume, assignments, maxSteps = smoke ? 2 : 10000 }) {
  const statePath = join(directory, 'state.json');
  if (existsSync(statePath) && !resume) throw Error('existing run: reconcile its retained attempt before restarting; no blind replay');
  const nodeAssignments = project.assignmentKind === 'node';
  let previous = resume?.previous ?? null, task = resume?.task ?? null;
  let assignmentIndex = resume?.assignmentIndex ?? 0;
  let role = assignments ? 'worker' : resume?.role ?? ((resume?.step ?? 1) % 2 ? 'planner' : 'worker');
  if (assignments && !nodeAssignments && previous && JSON.parse(readFileSync(previous, 'utf8')).tree_id !== assignments[assignmentIndex]?.tree_id) previous = null;
  const fingerprints = new Set();
  for (let step = resume?.step ?? 1; step <= maxSteps; step++) {
    if (assignments && assignmentIndex === assignments.length) {
      save(statePath, { status: nodeAssignments ? project.ready : 'reads_complete', step, assignmentIndex, previous }); return;
    }
    if (assignments) task = assignments[assignmentIndex];
    if (existsSync(join(directory, 'STOP'))) { save(statePath, { status: 'stopped', step, role, previous, task, assignmentIndex }); return; }
    save(statePath, { status: 'running', step, role, previous, task, assignmentIndex });
    const reportPath = join(directory, `${step}-${role}.json`);
    const result = await runStep({ step, role, reportPath, previous, task });
    const report = validateReport(result.text, role, smoke, project);
    const contextCheckpoint = isContinuation(report, result.contextStopped);
    if (assignments && !nodeAssignments && ['worked', 'excluded'].includes(report.disposition)) {
      if (report.tree_id !== task.tree_id || report.updated_nodes.length) throw Error('reader report tree identity/write mismatch');
      const inline = project.lean && report.tree_packet && typeof report.tree_packet === 'object' && !Array.isArray(report.tree_packet);
      const packet = inline ? join(directory, `${task.tree_id}-packet.json`) : report.tree_packet;
      if (typeof packet !== 'string' || !isAbsolute(packet) || (!inline && !report.evidence.includes(packet))) throw Error('missing reader evidence packet');
      const data = inline ? report.tree_packet : JSON.parse(readFileSync(packet, 'utf8'));
      if (data.tree_id !== task.tree_id || data.root_id !== task.root_id) throw Error('tree packet identity mismatch');
      if (report.disposition === 'excluded') {
        if (data.coverage_status !== 'excluded' || data.exclusion_kind !== 'ai_read_denied' ||
            typeof data.exclusion_reason !== 'string' || !data.exclusion_reason.trim()) throw Error('invalid tree exclusion packet');
      } else if (!project.lean && (data.outline_complete !== true ||
          !Array.isArray(data.content_read_ids) || !data.content_read_ids.includes(task.root_id) ||
          !Array.isArray(data.findings) || !Array.isArray(data.exclusions) ||
          !Array.isArray(data.remaining_work) || data.remaining_work.length)) throw Error('invalid tree coverage packet');
      if (inline) {
        save(packet, data);
        report.tree_packet = packet;
        if (!report.evidence.includes(packet)) report.evidence.push(packet);
      }
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
      if (nodeAssignments) {
        save(join(directory, 'completed-nodes.json'), entries.filter(e => e.report.disposition === 'worked').map(e =>
          ({ owner_id: e.task.owner_id, reportPath: e.reportPath, evidence: e.report.evidence, updated_nodes: e.report.updated_nodes })));
      } else {
        for (const [disposition, file] of [['worked', 'completed-trees.json'], ['excluded', 'excluded-trees.json']]) {
          save(join(directory, file), entries.filter(e => e.report.disposition === disposition).map(e =>
            ({ tree_id: e.task.tree_id, root_id: e.task.root_id, tree_packet: e.report.tree_packet, reportPath: e.reportPath })));
        }
      }
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
  if (!smoke && !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(project.root ?? '')) throw Error('A SiftText instruction entry is required for project work');
  const ready = `${project.ready} (requires evidence and the completion condition from the SiftText instruction entry)`;
  const schema = `Write ONLY a JSON object into ${reportPath} (the launcher has reserved this file; write in place, do not rename it). Fields: version:1, role:${JSON.stringify(role)}, disposition, summary:string, evidence:absolute-existing-artifact-path[], updated_nodes:UUID[]. Planner dispositions: next (requires task:{instruction:string,acceptance:string}), ${ready}, blocked, or continue. Worker dispositions: worked, blocked, or continue${project.ready === 'reads_complete' && project.excludeUnreadable ? ', or excluded for a documented AI read denial under explicit operator authorization' : ''}. Do not launch child agents or untracked background processes. Do not change model/provider/thinking. No human dialogue is available.

## Structured handoff: the report is the controller's input
For disposition:"next", include top-level task with non-empty instruction and acceptance strings. The controller dispatches only report.task; prose, evidence paths, updated_nodes and a landed tree assignment cannot substitute for it. Put the authorized task's owner/inputs, bounded action, recipient and stop conditions in task.instruction, and its observable completion check in task.acceptance. Preserve the existing assignment rather than inventing work to satisfy the schema. When recovery supplies a controller-rejected report, treat its findings and landed effects as evidence to reconcile, not an accepted dispatch; repair the handoff without repeating completed research or tree writes.
${role === 'planner' ? `Illustrative next-report shape (replace placeholders with verified facts; keep these keys):\n${JSON.stringify({ version: 1, role: 'planner', disposition: 'next', summary: '<findings and verified assignment state>', evidence: ['<absolute existing artifact path>'], updated_nodes: ['<actually changed node UUID>'], task: { instruction: '<one bounded authorized assignment, inputs, owner, recipient and stop>', acceptance: '<observable completion check>' } }, null, 2)}` : 'Worker reports return assigned results; they do not select a new task.'}

## Return protocol: work status is not report delivery
The report's disposition describes the work. report_outcome describes delivery to the controller. outcome:"completed" accepts the report for review; it does NOT claim the assignment, experiment, tree persistence or project succeeded. Only the report's disposition and verified evidence can establish those claims.
1. Choose the report disposition: continue when authorized work remains and a fresh agent can resume; blocked for a real prerequisite/authority/safety blocker, not context capacity; otherwise use the role's completed-work disposition only when its acceptance checks are satisfied. Record findings, exact evidence, actually verified changes, pending/unverified effects, remaining work and the next bounded action. A failed or inconclusive experiment is a finding, not a failed delivery.
2. At FRIENDLY STOP, stop substantive work and tree writes immediately. Do not try to finish reconciliation first: preserve unverified writes and remaining checks in the continue report. Drain already-running tracked child/background work; do not launch more.
3. Write the JSON report in place to the reserved path above, then read it back to verify valid JSON, required fields and truthful completed-versus-unfinished claims. Check the selected disposition's required fields too: parsing JSON alone is not schema validation. If report validation rejects delivery, repair the JSON from existing work—do not repeat the research or tree writes, weaken validation, invent evidence or disguise unfinished work as finished. Once the report is valid and tracked work has drained, call report_outcome({outcome:"completed",summary:"<honest report summary, including unfinished work>"}) and end the turn. This applies to continue and blocked reports too. Use outcome:"failed" only when a technical/protocol failure prevents delivery of a valid report or continuation checkpoint; never merely because substantive work, a read-back or reconciliation remains unfinished.
4. The controller validates the report and durable receipt. A continue report hands the same role and assignment to a fresh agent; blocked stops for resolution; verified finished work advances to the next role or the project-specific human boundary. A successor first reads the preceding report and owner checkpoint, verifies uncertain effects before writing, and resumes only remaining work: never replay completed actions or spend an already-used launch budget. An operator stop or narrower human authorization still limits advancement; a delivered report grants no new authority.
Examples: unfinished reconciliation at the context limit -> disposition:"continue" + outcome:"completed"; a disproved hypothesis with checks and reconciliation finished -> disposition:"worked" + outcome:"completed"; missing required permission with a valid blocker report -> disposition:"blocked" + outcome:"completed"; unreadable/unwritable report with no valid checkpoint -> outcome:"failed".`;
  if (smoke) return `Read-only transport smoke, not project research. Do not read SiftText or methodology nodes: this is a bounded file-reading fixture. No bash, network, game launch, code edits, or tree writes. Use read on ${join(directory, 'fixture.txt')}${previous ? ` and preceding report ${previous}` : ''}. ${role === 'planner' ? 'Return next with a tiny task asking the worker to report the fixture text, acceptance exact fixture text.' : 'Report the fixture text and whether the preceding planner report was readable; return worked.'} Evidence lists the fixture path. updated_nodes is []. Your only write is your reserved report. ${schema}`;
  return `Read /Users/jack/sifttext/nodes/${project.root}/node.md with local file tools for current project authority and acceptance conditions. Resolve required links at /Users/jack/sifttext/nodes/<UUID>/node.md; use native private-worktree publication only within the actual grant, never hosted SiftText tools. The knowledge base, not repository contract files, owns the assignment.\n${contract ?? ''}\n\nROLE: ${role}. Run directory: ${directory}. Previous report: ${previous ?? 'none (initial entry)'}.\n${role === 'planner'
    ? `Review the current checkpoint and evidence. Select exactly one bounded next task with named inputs, acceptance check, result recipient and stop condition. Dispatch only through report.task; do not perform the worker task. Return ${project.ready} only when the instruction entry's completion condition is satisfied, or blocked for an unresolved prerequisite.`
    : `Execute only this assigned task: ${JSON.stringify(task)}. Read its SiftText owner, prerequisites and applicable source material. Perform the authorized work and checks; return actual evidence and remaining uncertainty, not a self-selected assignment. Never invent results or changed node IDs.`}\n${schema}`;
}
