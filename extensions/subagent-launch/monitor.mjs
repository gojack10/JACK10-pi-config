import { execFile } from "node:child_process";
import { constants, createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { open, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { readMonitorReceipt, parsePaneHealth, observePaneHealth } from "../task-outcomes/monitor-receipt.mjs";

const config = JSON.parse(process.argv[2] ?? "{}");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const emit = value => process.stdout.write(`${JSON.stringify(value)}\n`);

const tmux = args => new Promise((resolve, reject) => {
  execFile("tmux", args, { encoding: "utf8", timeout: 2000 }, (error, stdout, stderr) => {
    if (error) reject(new Error((stderr || stdout || error.message).trim()));
    else resolve(stdout.trim());
  });
});
const show = async option => {
  try {
    const value = await tmux(["show-options", "-qv", "-t", config.paneId, option]);
    return value || undefined;
  } catch { return undefined; }
};
// Must match Pi's ERROR_RECORD_ENTRY; this monitor is a standalone child process.
const ERROR_RECORD_ENTRY = "pi-error/v1";
const resultModule = config.resultModulePath
  ? await import(pathToFileURL(config.resultModulePath).href).catch(() => undefined)
  : undefined;
// The fallback is only for direct standalone tests; launched monitors receive
// Pi's own Result constructors through the runtime package path.
const success = resultModule?.Success ?? (value => ({ ok: true, value }));
const failure = resultModule?.Failure ?? (error => ({ ok: false, error }));
let errorStorageIntegrity;
const errorText = error => (error instanceof Error ? error.message : String(error))
  .replace(/\b(api[_-]?key|token|password|secret|authorization)\b(\s*[:=]\s*)(?:bearer\s+)?\S+/gi, "$1$2[redacted]")
  .replace(/[\0\x01-\x08\x0b\x0c\x0e-\x1f\x7f]/g, " ")
  .replace(/[\r\n\t]+/g, " ")
  .trim().slice(0, 2048) || "unknown error";
const isMissing = error => error?.code === "ENOENT" || error?.errno === -2 || /\bENOENT\b/.test(error?.message ?? "");
const readStoredError = async () => {
  const path = await sessionFile();
  if (!path || !startedSessionId) return success(undefined);

  const identity = await piSessionId(path);
  if (!identity.ok) {
    // ENOENT before the first durable header is the normal START race. Once
    // START established the file, the same error is genuine read evidence.
    if (isMissing(identity.error) && !sessionFileReady) return success(undefined);
    return failure(identity.error);
  }
  if (!identity.value) return success(undefined); // partial/malformed header; try again
  const liveIdentity = await show(config.sessionIdOption);
  if (identity.value !== startedSessionId || (liveIdentity && liveIdentity !== startedSessionId)) {
    errorStorageIntegrity = "Pi session identity changed while reading the error record";
    return success(undefined);
  }
  sessionFileReady = true;
  try {
    const text = await readFile(path, "utf8");
    for (const line of text.split("\n")) {
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      const record = entry?.type === "custom" && entry.customType === ERROR_RECORD_ENTRY ? entry.data : undefined;
      const correlation = record?.correlation;
      if (record?.version !== 1 || record.source !== "subagent" || record.operation !== "outcome_publication" ||
          typeof record.message !== "string" || record.message.length === 0 || record.message.length > 2048 ||
          /[\0\x01-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(record.message) ||
          correlation?.session_id !== startedSessionId || correlation?.job_id !== expected.jobId ||
          correlation?.attempt_id !== expected.attemptId) continue;
      return success(record.message);
    }
    errorStorageIntegrity = undefined;
    return success(undefined);
  } catch (error) {
    return failure(error);
  }
};
const validIdentity = value => !!value && typeof value.dev === "string" && typeof value.ino === "string" &&
  /^\d+$/.test(value.dev) && /^\d+$/.test(value.ino);
const readProtected = async (path, identity, label) => {
  if (typeof path !== "string" || !path.startsWith("/") || path.includes("\0") || !validIdentity(identity)) {
    throw new Error(`${label} path or identity is invalid`);
  }
  if (typeof constants.O_NOFOLLOW !== "number" || typeof constants.O_NONBLOCK !== "number") {
    throw new Error(`${label} cannot be read safely on this platform`);
  }
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || String(info.dev) !== identity.dev || String(info.ino) !== identity.ino) {
      throw new Error(`${label} no longer matches its publication identity`);
    }
    return await file.readFile({ encoding: "utf8" });
  } finally { await file.close(); }
};
const paneHealth = async () => {
  try { return parsePaneHealth(await tmux(["list-panes", "-a", "-F", "#{pane_id}\t#{pane_dead}"]), config.paneId); }
  catch (error) { return { kind: "unknown", evidence: errorText(error) }; }
};
const confirmedDead = async () => {
  const health = await observePaneHealth(paneHealth, sleep, reconcileDurable, config.pollMs);
  if (health.kind === "unknown") evidence(`pane health unknown: ${health.evidence}`);
  return health.kind === "dead";
};
const readManifest = async () => {
  const path = await show(config.manifestOption);
  if (!path) return undefined;
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    if (value?.version !== 1 || typeof value.jobId !== "string" || typeof value.attemptId !== "string" ||
        typeof value.sessionId !== "string" || value.sessionId.length === 0 ||
        (value.mode !== "task" && value.mode !== "dialogue") || typeof value.startChannel !== "string" ||
        !Number.isSafeInteger(value.startGeneration) || !Number.isSafeInteger(value.outcomeGeneration)) return undefined;
    return value;
  } catch { return undefined; }
};
const generation = async () => {
  const value = Number.parseInt(await show(config.outcomeGenerationOption) ?? "", 10);
  return Number.isSafeInteger(value) ? value : 0;
};
let cachedSessionFile;
const sessionFile = async () => cachedSessionFile ?? await show(config.sessionFileOption);
// Pi owns the identity; the manifest sessionId is only a transport handle.
const piSessionId = async path => {
  if (!path) return success(await show(config.sessionIdOption));
  const stream = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      let header;
      try { header = JSON.parse(line); } catch { continue; }
      return success(header.type === "session" && typeof header.id === "string" && header.id ? header.id : undefined);
    }
    return success(undefined);
  } catch (error) {
    return failure(error);
  } finally { lines.close(); stream.destroy(); }
};
const nonEmptyRegularReport = async (path, manifest) => {
  if (typeof constants.O_NOFOLLOW !== "number" || typeof constants.O_NONBLOCK !== "number") return false;
  const identity = manifest?.reportIdentity;
  if (!identity || typeof identity.dev !== "string" || typeof identity.ino !== "string" ||
      !/^\d+$/.test(identity.dev) || !/^\d+$/.test(identity.ino) ||
      !Number.isSafeInteger(manifest.activatedAt)) return false;
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await file.stat();
    if (!info.isFile() || info.size < 1 || String(info.dev) !== identity.dev || String(info.ino) !== identity.ino) return false;
    if (Number.isFinite(info.birthtimeMs) && info.birthtimeMs + 1 < manifest.activatedAt) return false;
    const buffer = Buffer.alloc(1);
    return (await file.read(buffer, 0, 1, 0)).bytesRead === 1;
  } catch {
    return false;
  } finally {
    if (file) await file.close().catch(() => {});
  }
};
let finalPublished = false;
const transportFailure = (summary, manifest) => {
  if (finalPublished) return;
  finalPublished = true;
  emit({ kind: "final", jobId: manifest?.jobId, attemptId: manifest?.attemptId,
    outcome: "transport_lost", source: "transport", technical: true, final: true,
    summary, report: manifest?.reportPath });
};
const protocolFailure = summary => {
  if (finalPublished) return;
  finalPublished = true;
  emit({ kind: "final", jobId: config.jobId, attemptId: config.attemptId,
    outcome: "failed", source: "protocol", technical: true, final: true, summary });
};
const expected = {
  jobId: config.jobId,
  attemptId: config.attemptId,
  sessionId: typeof config.sessionId === "string" ? config.sessionId : undefined,
  mode: config.mode === "task" || config.mode === "dialogue" ? config.mode : undefined,
};
const matchesExpected = manifest => manifest.jobId === expected.jobId &&
  manifest.attemptId === expected.attemptId &&
  manifest.sessionId === expected.sessionId && manifest.mode === expected.mode &&
  (!cachedManifest || (manifest.reportPath === cachedManifest.reportPath &&
    manifest.reportIdentity?.dev === cachedManifest.reportIdentity?.dev &&
    manifest.reportIdentity?.ino === cachedManifest.reportIdentity?.ino &&
    manifest.activatedAt === cachedManifest.activatedAt));
const bindManifest = manifest => {
  if (expected.sessionId === undefined) expected.sessionId = manifest.sessionId;
  if (expected.mode === undefined) expected.mode = manifest.mode;
  return matchesExpected(manifest);
};

const manifestDeadline = Date.now() + config.startTimeoutMs;
let lastGeneration;
let activeKey;
let startedKey;
let startedSessionId;
let sessionFileReady = false;
let cachedManifest;
let durableRevision = 0;
let durablePause = false;
const admitted = new Map();
const diagnostic = new Set();
const evidence = summary => {
  if (diagnostic.has(summary)) return;
  diagnostic.add(summary);
  emit({ kind: "evidence", jobId: expected.jobId, attemptId: expected.attemptId, summary });
};
const reconcileDurable = async () => {
  if (!cachedManifest || !cachedSessionFile || !startedSessionId) return;
  let projection;
  try {
    projection = readMonitorReceipt(cachedSessionFile, { sessionId: startedSessionId,
      jobId: expected.jobId, attemptId: expected.attemptId, mode: expected.mode,
      reportPath: cachedManifest.reportPath, reportIdentity: cachedManifest.reportIdentity });
  } catch (error) {
    if (!isMissing(error)) evidence(`ignored invalid durable receipt: ${errorText(error)}`);
    return;
  }
  if (projection.revision < durableRevision) return;
  durableRevision = projection.revision;
  durablePause = projection.state === "context_paused";
  if (projection.state === "active" && projection.payload.outcome === "active") {
    emitOnce({ kind: "active", jobId: expected.jobId, attemptId: expected.attemptId,
      sessionId: startedSessionId, eventId: projection.eventId, revision: projection.revision, final: false });
    return;
  }
  await consumeReceipt({ ...projection.payload, event_id: projection.eventId, revision: projection.revision }, cachedManifest);
};
const emitOnce = marker => {
  if (finalPublished) return;
  const key = marker.eventId ?? `${marker.kind}:${marker.pauseId ?? JSON.stringify(marker)}`;
  const payload = JSON.stringify({ ...marker, revision: undefined });
  if (admitted.has(key)) {
    if (admitted.get(key) !== payload) evidence(`conflicting outcome event ${key}`);
    return;
  }
  admitted.set(key, payload);
  if (marker.kind === "final") finalPublished = true;
  emit(marker);
  if (marker.kind === "final") process.exit(0);
};
const consumeReceipt = async (receipt, manifest, suppliedReportText) => {
      const source = receipt.source ?? "model";
      const reportText = suppliedReportText ?? receipt.report_text;
      const hasReport = typeof reportText === "string";
      const identity = { sessionId: startedSessionId, eventId: receipt.event_id, revision: receipt.revision };
      if (receipt.revision !== undefined && receipt.revision < durableRevision) return;
      if (receipt.outcome === "maintenance_paused" || receipt.outcome === "maintenance_error") {
        emitOnce({ ...identity, kind: receipt.outcome, jobId: receipt.job_id, attemptId: receipt.attempt_id,
          source, final: false, summary: receipt.summary ?? receipt.outcome });
      } else if (receipt.outcome === "needs_input" || (receipt.final === false && receipt.outcome !== "transport_lost")) {
        emitOnce({ ...identity, kind: receipt.outcome === "context_paused" ? "context_paused" : "needs_input",
          jobId: receipt.job_id, attemptId: receipt.attempt_id, pauseId: receipt.pause_id,
          source, final: false, summary: receipt.summary ?? "child requested human input", report: receipt.report });
      } else {
        let outcome = receipt.outcome;
        let finalSource = source;
        let summary = receipt.summary ?? `${outcome} ${manifest.jobId}`;
        if (!(outcome === "transport_lost" && source === "transport")) {
          if (manifest.mode === "dialogue" && (outcome === "dialogue_settled" || outcome === "completed")) {
            if (!hasReport) {
              outcome = "failed"; finalSource = "protocol";
              summary = "protocol_incomplete: settled dialogue has no assistant text report";
            } else outcome = "completed";
          }
          if (!["completed", "blocked", "failed"].includes(outcome)) {
            outcome = "failed"; finalSource = "protocol";
            summary = `protocol_incomplete: unsupported child outcome ${receipt.outcome}`;
          }
          if (manifest.mode === "task" && receipt.outcome === "completed" &&
              (receipt.report !== manifest.reportPath || !(await nonEmptyRegularReport(manifest.reportPath, manifest)))) {
            outcome = "failed"; finalSource = "protocol";
            summary = `protocol_incomplete: missing or mismatched report ${manifest.reportPath}`;
          }
        }
        const marker = { ...identity, kind: "final", jobId: receipt.job_id, attemptId: receipt.attempt_id,
          outcome, source: finalSource, technical: finalSource !== "model", final: true,
          summary, report: receipt.report ?? manifest.reportPath, sessionFile: cachedSessionFile ?? receipt.session_file };
        if (manifest.mode === "dialogue" && outcome === "completed" && hasReport) {
          if (Buffer.byteLength(reportText, "utf8") <= 16 * 1024) marker.reportText = reportText;
          else if (receipt.transport_report_path) marker.dialogueReportPath = receipt.transport_report_path;
          else {
            const path = `${cachedSessionFile}.task-monitor-${expected.attemptId}-${process.pid}.txt`;
            const report = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
            try { await report.writeFile(reportText, "utf8"); } finally { await report.close(); }
            marker.dialogueReportPath = path;
          }
        }
        emitOnce(marker);
      }
};
while (true) {
  const observedManifest = await readManifest();
  const manifest = observedManifest ?? cachedManifest;
  if (!manifest) {
    if (await confirmedDead()) {
      transportFailure("transport_lost: child pane disappeared before a durable outcome", { jobId: config.jobId, attemptId: config.attemptId });
      process.exit(0);
    }
    if (Date.now() >= manifestDeadline) {
      protocolFailure("protocol_incomplete: launcher manifest was missing or invalid");
      process.exit(0);
    }
    await sleep(config.pollMs);
    continue;
  }
  if (!bindManifest(manifest)) {
    protocolFailure("protocol_incomplete: launcher manifest identity changed");
    process.exit(0);
  }
  if (activeKey === undefined && Date.now() >= manifestDeadline) {
    protocolFailure("protocol_incomplete: launcher manifest arrived after the start deadline");
    process.exit(0);
  }
  cachedManifest = manifest;
  const key = `${manifest.jobId}@${manifest.attemptId}`;
  if (activeKey !== key) {
    activeKey = key;
    if (lastGeneration === undefined) lastGeneration = manifest.outcomeGeneration;
    else lastGeneration = Math.max(lastGeneration, manifest.outcomeGeneration);
    const deadline = Date.now() + config.startTimeoutMs;
    while (Date.now() < deadline) {
      const liveManifest = await readManifest();
      if (liveManifest && !bindManifest(liveManifest)) {
        protocolFailure("protocol_incomplete: launcher manifest identity changed");
        process.exit(0);
      }
      const startGeneration = Number.parseInt(await show(config.startGenerationOption) ?? "", 10);
      const file = await sessionFile();
      if (Number.isSafeInteger(startGeneration) && startGeneration > manifest.startGeneration && file) {
        const identity = await piSessionId(file);
        if (!identity.ok) {
          if (!isMissing(identity.error)) {
            transportFailure(`transport_lost: cannot read Pi session header: ${errorText(identity.error)}`, manifest);
            process.exit(0);
          }
          // Pi publishes its identity before creating the JSONL. ENOENT is
          // startup readiness only when that live identity is available.
          const liveIdentity = await show(config.sessionIdOption);
          if (liveIdentity) {
            cachedSessionFile = file;
            startedSessionId = liveIdentity;
            startedKey = key;
            emit({ kind: "start", jobId: manifest.jobId, attemptId: manifest.attemptId,
              sessionId: startedSessionId, sessionFile: file, channel: false });
            break;
          }
        } else if (identity.value) {
          const liveIdentity = await show(config.sessionIdOption);
          if (liveIdentity && liveIdentity !== identity.value) {
            protocolFailure("protocol_incomplete: Pi session identity changed at START");
            process.exit(0);
          }
          cachedSessionFile = file;
          startedSessionId = identity.value;
          sessionFileReady = true;
          startedKey = key;
          emit({ kind: "start", jobId: manifest.jobId, attemptId: manifest.attemptId,
            sessionId: startedSessionId, sessionFile: file, channel: false });
          break;
        }
      }
      if (await confirmedDead()) {
        transportFailure("transport_lost: child pane disappeared before START", manifest);
        process.exit(0);
      }
      await sleep(config.pollMs);
    }
    if (startedKey !== key) {
      emit({ kind: "final", jobId: manifest.jobId, attemptId: manifest.attemptId,
        outcome: "failed", source: "protocol", technical: true, final: true,
        summary: "protocol_incomplete: missing or invalid Pi session header", report: manifest.reportPath });
      process.exit(0);
    }
  }

  await reconcileDurable();
  const currentGeneration = await generation();
  if (currentGeneration > lastGeneration) {
    const currentManifest = await readManifest();
    if (currentManifest && !bindManifest(currentManifest)) {
      protocolFailure("protocol_incomplete: launcher manifest identity changed");
      process.exit(0);
    }
    const raw = await show(config.outcomeOption);
    let shortReceipt;
    try { shortReceipt = raw ? JSON.parse(raw) : undefined; } catch { shortReceipt = undefined; }
    if (!shortReceipt || shortReceipt.job_id !== expected.jobId || shortReceipt.attempt_id !== expected.attemptId ||
        shortReceipt.mode !== expected.mode || shortReceipt.session_id !== startedSessionId ||
        typeof shortReceipt.outcome !== "string" ||
        (shortReceipt.source !== undefined && !["model", "technical", "protocol", "transport"].includes(shortReceipt.source))) {
      evidence(`ignored malformed, foreign, or mismatched outcome generation ${currentGeneration}`);
    } else {
      let receipt = shortReceipt;
      let reportText;
      try {
        if (shortReceipt.receipt_path !== undefined) {
          const receiptText = await readProtected(shortReceipt.receipt_path, shortReceipt.receipt_identity, "outcome receipt");
          receipt = JSON.parse(receiptText);
          if (!receipt || receipt.version !== 1 || receipt.session_id !== shortReceipt.session_id ||
              receipt.job_id !== shortReceipt.job_id || receipt.attempt_id !== shortReceipt.attempt_id ||
              receipt.mode !== shortReceipt.mode || receipt.outcome !== shortReceipt.outcome ||
              receipt.source !== shortReceipt.source || receipt.final !== shortReceipt.final ||
              receipt.event_id !== shortReceipt.event_id || receipt.revision !== shortReceipt.revision) {
            throw new Error("outcome receipt identity does not match its tmux pointer");
          }
          if (receipt.transport_report_present === true) {
            reportText = await readProtected(
              receipt.transport_report_path,
              receipt.transport_report_identity,
              "dialogue report",
            );
          } else if (receipt.transport_report_path !== undefined || receipt.transport_report_identity !== undefined) {
            throw new Error("outcome receipt has an invalid dialogue report publication");
          }
        } else if (Object.prototype.hasOwnProperty.call(receipt, "report_text")) {
          if (typeof receipt.report_text !== "string") throw new Error("inline dialogue report is invalid");
          reportText = receipt.report_text;
        }
      } catch (error) {
        evidence(`cannot read published outcome (retrying): ${errorText(error)}`);
        await reconcileDurable();
        receipt = undefined;
      }
      await reconcileDurable();
      // A projection is authoritative for this attempt; legacy tmux is a fallback only.
      if (receipt) {
        if (!durableRevision || (receipt.revision !== undefined && receipt.revision >= durableRevision)) {
          await consumeReceipt(receipt, manifest, reportText);
        }
        lastGeneration = currentGeneration;
      }
    }
  }

  if (await confirmedDead()) {
    await reconcileDurable(); // Last read before the synchronous terminal latch.
    transportFailure(errorStorageIntegrity
      ? `transport_lost: ${errorStorageIntegrity}; child pane disappeared before a durable outcome`
      : "transport_lost: child pane disappeared before a durable outcome", manifest);
    process.exit(0);
  }

  const storedError = await readStoredError();
  await reconcileDurable();
  if (!durablePause) {
    if (!storedError.ok) {
      transportFailure(`transport_lost: cannot read Pi error record: ${errorText(storedError.error)}`, manifest);
      process.exit(0);
    }
    if (storedError.value) {
      emitOnce({ kind: "final", jobId: expected.jobId, attemptId: expected.attemptId,
        outcome: "failed", source: "transport", technical: true, final: true,
        summary: `Subagent error: ${storedError.value}`, report: manifest.reportPath });
    }
  }

  await sleep(config.pollMs);
}
