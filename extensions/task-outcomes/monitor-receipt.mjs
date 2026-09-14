import { constants, openSync, closeSync, fstatSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { isDeepStrictEqual } from "node:util";

const id = value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,511}$/.test(value);
export const receiptPath = (file, attempt) => {
  if (!isAbsolute(file) || file.includes("\0") || !id(attempt)) throw new Error("invalid monitor receipt path");
  return `${file}.task-monitor-${attempt}.json`;
};
const readRegular = (path, privateFile = false) => {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || (privateFile && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))) throw new Error("unsafe monitor receipt file");
    return readFileSync(fd, "utf8");
  } finally { closeSync(fd); }
};
export function sessionBranch(text, sessionId, leafId) {
  const rows = text.trim().split("\n").map(line => JSON.parse(line));
  if (rows[0]?.type !== "session" || rows[0].id !== sessionId) throw new Error("monitor session identity mismatch");
  const entries = new Map();
  for (const row of rows.slice(1)) {
    if (!id(row.id) || entries.has(row.id)) throw new Error("invalid or duplicate session entry");
    entries.set(row.id, row);
  }
  const branch = [], seen = new Set();
  for (let next = leafId; next !== null;) {
    const entry = entries.get(next);
    if (!entry || seen.has(next)) throw new Error("incomplete monitor receipt ancestry");
    seen.add(next); branch.push(entry); next = entry.parentId;
  }
  return branch.reverse();
}
const isEvent = entry => entry?.type === "custom" && ["task-outcome/v1", "session-maintenance/v1"].includes(entry.customType) && entry.data?.version === 1;
// Reduce only the writer-selected ancestry, never sidecar order or the last JSONL row.
export function projectBranch(branch, identity) {
  let contract, selected, state, maintenancePrevious, contextPauseId;
  const events = new Map();
  for (const entry of branch) {
    if (!isEvent(entry)) continue;
    const e = entry.data;
    if (events.has(e.eventId) && !isDeepStrictEqual(events.get(e.eventId), e)) throw new Error("conflicting durable event");
    events.set(e.eventId, e);
    const c = e.contract;
    if (e.kind === "contract" && c?.jobId === identity.jobId && c.attemptId === identity.attemptId) {
      if (contract && (c.mode !== contract.mode || c.ownerSessionId !== contract.ownerSessionId || c.reportPath !== contract.reportPath || !isDeepStrictEqual(c.reportIdentity, contract.reportIdentity))) throw new Error("contract identity changed");
      contract = c;
      if (!selected) { selected = entry; state = "active"; }
      continue;
    }
    if (!contract || e.jobId !== identity.jobId || e.attemptId !== identity.attemptId || ["final", "transport_lost"].includes(state)) continue;
    if (e.kind === "maintenance_begin") { maintenancePrevious = { state, selected }; continue; }
    if (e.kind === "maintenance_resume") {
      if (maintenancePrevious) { ({ state, selected } = maintenancePrevious); maintenancePrevious = undefined; }
      continue;
    }
    if (e.kind === "context_pause" && id(e.contextPause?.id) && typeof e.contextPause.reason === "string" && Number.isSafeInteger(e.contextPause.limit) && e.contextPause.limit > 0) {
      state = "context_paused"; contextPauseId = e.contextPause.id;
    } else if (e.kind === "context_resume") {
      if (!contextPauseId || (e.contextPause?.id !== contextPauseId && !e.eventId?.endsWith(`:${contextPauseId}`))) throw new Error("context resume does not match its pause");
      state = "active"; contextPauseId = undefined;
    }
    else if (["maintenance_paused", "maintenance_error"].includes(e.kind)) state = "context_paused";
    else if (e.kind === "transport_lost") state = "transport_lost";
    else if (e.kind === "outcome") state = e.outcome === "needs_input" ? "active" : "final";
    else continue;
    selected = entry;
  }
  if (!contract || !selected) return undefined;
  if (contract.ownerSessionId !== identity.sessionId || contract.mode !== identity.mode ||
      (identity.reportPath !== undefined && contract.reportPath !== identity.reportPath) ||
      (identity.reportIdentity !== undefined && !isDeepStrictEqual(contract.reportIdentity, identity.reportIdentity))) throw new Error("monitor contract identity mismatch");
  const e = selected.data;
  const outcome = state === "active" ? (e.outcome === "needs_input" ? "needs_input" : "active") : e.kind === "context_pause" ? "context_paused" : e.kind === "maintenance_begin" ? "maintenance_paused" : e.outcome;
  const payload = {
    version: 1, session_id: identity.sessionId, job_id: identity.jobId, attempt_id: identity.attemptId,
    mode: identity.mode, outcome, source: e.source ?? "technical", final: state === "final" || state === "transport_lost",
    summary: e.contextPause?.reason ?? e.summary ?? outcome, pause_id: e.contextPause?.id,
    limit: e.contextPause?.limit, report: contract.reportPath, reportIdentity: contract.reportIdentity,
    report_text: e.reportText, maintenance_id: e.maintenance?.maintenanceId,
  };
  return JSON.parse(JSON.stringify({ state, eventId: e.eventId, entryId: selected.id, payload }));
}
export function validateReceipt(value, text, identity) {
  if (value?.version !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 1 ||
      !["sessionId", "jobId", "attemptId", "eventId", "entryId", "branchLeafId"].every(key => id(value[key])) ||
      ["sessionId", "jobId", "attemptId", "mode"].some(key => value[key] !== identity[key])) throw new Error("invalid monitor receipt identity");
  const derived = projectBranch(sessionBranch(text, identity.sessionId, value.branchLeafId), identity);
  if (!derived || !isDeepStrictEqual(derived, { state: value.state, eventId: value.eventId, entryId: value.entryId, payload: value.payload })) throw new Error("monitor receipt does not match selected branch");
  return value;
}
export function readMonitorReceipt(file, identity) {
  const value = JSON.parse(readRegular(receiptPath(file, identity.attemptId), true));
  return validateReceipt(value, readRegular(file), identity);
}
export function publishMonitorReceipt(file, identity, branch, leafId) {
  const derived = projectBranch(branch, identity);
  if (!derived) return undefined;
  const path = receiptPath(file, identity.attemptId);
  let old;
  try { old = JSON.parse(readRegular(path, true)); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const value = { version: 1, ...identity, ...derived, branchLeafId: leafId, revision: (old?.revision ?? 0) + 1 };
  // Prove the runtime branch is actually durable before allowing pause/abort.
  const text = readRegular(file);
  const diskBranch = sessionBranch(text, identity.sessionId, leafId);
  if (!isDeepStrictEqual(JSON.parse(JSON.stringify(branch)), diskBranch)) throw new Error("runtime branch is not durable");
  validateReceipt(value, text, identity);
  if (old) {
    if (["sessionId", "jobId", "attemptId", "mode"].some(key => old[key] !== identity[key])) throw new Error("foreign existing monitor receipt");
    if (old.eventId === value.eventId) {
      if (!isDeepStrictEqual(old.payload, value.payload) || old.state !== value.state) throw new Error("conflicting same-event monitor receipt");
      if (old.branchLeafId === leafId) return old;
    }
    // A deliberate tree move can remove the old final from the selected ancestry.
    // It must replace, not blindly reuse, the old branch's projection.
    if (["final", "transport_lost"].includes(old.state) && old.eventId !== value.eventId &&
        branch.some(entry => entry.id === old.entryId)) throw new Error("monitor finality is absorbing");
  }
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(value), { flag: "wx", mode: 0o600 });
    renameSync(temp, path);
  } finally { try { unlinkSync(temp); } catch (error) { if (error.code !== "ENOENT") throw error; } }
  return value;
}

export function parsePaneHealth(text, paneId) {
  if (!text.trim()) return { kind: "unknown", evidence: "empty pane inventory" };
  const rows = text.trim().split("\n"), seen = new Set();
  let found;
  for (const row of rows) {
    const match = /^(%\d+)\t([01])$/.exec(row);
    if (!match || seen.has(match[1])) return { kind: "unknown", evidence: "malformed pane inventory" };
    seen.add(match[1]);
    if (match[1] === paneId) found = match[2];
  }
  return { kind: found === "0" ? "live" : "dead", evidence: found === "1" ? "pane_dead=1" : found === "0" ? "pane_dead=0" : "pane absent" };
}
export async function observePaneHealth(query, sleep, reconcile, pollMs) {
  const first = await query();
  if (first.kind === "live") return first;
  await reconcile();
  await sleep(pollMs);
  const second = await query();
  await reconcile();
  return first.kind === "dead" && second.kind === "dead" ? second : { kind: second.kind === "live" ? "live" : "unknown", evidence: second.evidence };
}
