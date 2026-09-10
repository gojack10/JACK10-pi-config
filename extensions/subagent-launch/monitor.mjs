import { execFile, spawn } from "node:child_process";
import { constants, createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { open, readFile } from "node:fs/promises";

const config = JSON.parse(process.argv[2] ?? "{}");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const emit = value => process.stdout.write(`${JSON.stringify(value)}\n`);

const tmux = args => new Promise((resolve, reject) => {
  execFile("tmux", args, { encoding: "utf8" }, (error, stdout, stderr) => {
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
const paneExists = async () => (await show("@pi_subagent_job_id")) !== undefined;
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
const waitForChannel = (channel, timeoutMs) => {
  if (!channel) return { promise: Promise.resolve(false), cancel: () => {} };
  const child = spawn("tmux", ["wait-for", channel], { stdio: "ignore" });
  let settled = false;
  let timer;
  let resolvePromise;
  const promise = new Promise(resolve => { resolvePromise = resolve; });
  const finish = value => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolvePromise(value);
  };
  child.once("error", () => finish(false));
  child.once("close", code => finish(code === 0));
  timer = setTimeout(() => { try { child.kill("SIGTERM"); } catch {} finish(false); }, timeoutMs);
  return { promise, cancel: () => { try { child.kill("SIGTERM"); } catch {} finish(false); } };
};
const generation = async () => {
  const value = Number.parseInt(await show(config.outcomeGenerationOption) ?? "", 10);
  return Number.isSafeInteger(value) ? value : 0;
};
const sessionFile = async () => await show(config.sessionFileOption);
// Pi owns the identity; the manifest sessionId is only a transport handle.
const piSessionId = async path => {
  const published = await show(config.sessionIdOption);
  if (published) return published;
  if (!path) return undefined;
  const stream = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      const header = JSON.parse(line);
      return header.type === "session" && typeof header.id === "string" && header.id ? header.id : undefined;
    }
  } catch { return undefined; }
  finally { lines.close(); stream.destroy(); }
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
const transportFailure = (summary, manifest) => {
  emit({ kind: "final", jobId: manifest?.jobId, attemptId: manifest?.attemptId,
    outcome: "transport_lost", source: "transport", technical: true, final: true,
    summary, report: manifest?.reportPath });
};
const protocolFailure = summary => {
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
  manifest.sessionId === expected.sessionId && manifest.mode === expected.mode;
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
let signal = waitForChannel(config.outcomeChannel, config.pollMs * 4);

while (true) {
  const manifest = await readManifest();
  if (!manifest) {
    if (!(await paneExists())) {
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
  const key = `${manifest.jobId}@${manifest.attemptId}`;
  if (activeKey !== key) {
    activeKey = key;
    if (lastGeneration === undefined) lastGeneration = manifest.outcomeGeneration;
    else lastGeneration = Math.max(lastGeneration, manifest.outcomeGeneration);
    const deadline = Date.now() + config.startTimeoutMs;
    let observedChannel = false;
    const startWait = waitForChannel(manifest.startChannel, config.pollMs * 4);
    while (Date.now() < deadline) {
      const result = await Promise.race([
        startWait.promise.then(value => ({ kind: "signal", value })),
        sleep(config.pollMs).then(() => ({ kind: "poll", value: false })),
      ]);
      if (result.kind === "signal" && result.value) observedChannel = true;
      const liveManifest = await readManifest();
      if (liveManifest && !bindManifest(liveManifest)) {
        startWait.cancel();
        protocolFailure("protocol_incomplete: launcher manifest identity changed");
        process.exit(0);
      }
      const startGeneration = Number.parseInt(await show(config.startGenerationOption) ?? "", 10);
      const file = await sessionFile();
      if (Number.isSafeInteger(startGeneration) && startGeneration > manifest.startGeneration && file) {
        startWait.cancel();
        startedSessionId = await piSessionId(file);
        if (!startedSessionId) {
          protocolFailure("protocol_incomplete: missing or invalid Pi session header");
          process.exit(0);
        }
        startedKey = key;
        emit({ kind: "start", jobId: manifest.jobId, attemptId: manifest.attemptId,
          sessionFile: file, channel: observedChannel });
        break;
      }
      if (!(await paneExists())) {
        startWait.cancel();
        transportFailure("transport_lost: child pane disappeared before START", manifest);
        process.exit(0);
      }
    }
    if (startedKey !== key) {
      startWait.cancel();
      emit({ kind: "final", jobId: manifest.jobId, attemptId: manifest.attemptId,
        outcome: "failed", source: "protocol", technical: true, final: true,
        summary: "protocol_incomplete: START/session-file receipt timed out", report: manifest.reportPath });
      process.exit(0);
    }
  }

  const currentGeneration = await generation();
  if (currentGeneration > lastGeneration) {
    lastGeneration = currentGeneration;
    const currentManifest = await readManifest();
    if (!currentManifest || !bindManifest(currentManifest)) {
      protocolFailure("protocol_incomplete: launcher manifest identity changed");
      process.exit(0);
    }
    const raw = await show(config.outcomeOption);
    let shortReceipt;
    try { shortReceipt = raw ? JSON.parse(raw) : undefined; } catch { shortReceipt = undefined; }
    const source = shortReceipt && shortReceipt.source === undefined ? "model" : shortReceipt?.source;
    if (!shortReceipt || shortReceipt.job_id !== expected.jobId || shortReceipt.attempt_id !== expected.attemptId ||
        shortReceipt.mode !== expected.mode || shortReceipt.session_id !== startedSessionId ||
        typeof shortReceipt.outcome !== "string" ||
        (shortReceipt.source !== undefined && !["model", "technical", "protocol", "transport"].includes(shortReceipt.source))) {
      emit({ kind: "evidence", jobId: manifest.jobId, attemptId: manifest.attemptId,
        summary: `ignored malformed, foreign, or mismatched outcome generation ${currentGeneration}` });
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
              receipt.source !== shortReceipt.source || receipt.final !== shortReceipt.final) {
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
        transportFailure(`transport_lost: cannot read published outcome: ${error instanceof Error ? error.message : String(error)}`, manifest);
        process.exit(0);
      }
      const hasReport = reportText !== undefined;
      if (receipt.outcome === "needs_input" || (receipt.final === false && receipt.outcome !== "transport_lost")) {
        emit({ kind: "needs_input", jobId: receipt.job_id, attemptId: receipt.attempt_id,
          source, final: false, summary: receipt.summary ?? "child requested human input", report: receipt.report });
      } else {
        let outcome = receipt.outcome;
        let finalSource = source;
        let summary = receipt.summary ?? `${outcome} ${manifest.jobId}`;
        if (outcome === "transport_lost" && source === "transport") {
          // A task manager transport record is non-semantic, but terminal for this monitor.
        } else {
          if (manifest.mode === "dialogue" && (outcome === "dialogue_settled" || outcome === "completed")) {
            if (!hasReport) {
              outcome = "failed";
              finalSource = "protocol";
              summary = "protocol_incomplete: settled dialogue has no assistant text report";
            } else {
              outcome = "completed";
            }
          }
          if (!["completed", "blocked", "failed"].includes(outcome)) {
            outcome = "failed";
            finalSource = "protocol";
            summary = `protocol_incomplete: unsupported child outcome ${receipt.outcome}`;
          }
          if (manifest.mode === "task" && receipt.outcome === "completed") {
            let validReport = receipt.report === manifest.reportPath;
            if (validReport) validReport = await nonEmptyRegularReport(manifest.reportPath, manifest);
            if (!validReport) {
              outcome = "failed";
              finalSource = "protocol";
              summary = `protocol_incomplete: missing or mismatched report ${manifest.reportPath}`;
            }
          }
        }
        const marker = { kind: "final", jobId: receipt.job_id, attemptId: receipt.attempt_id,
          outcome, source: finalSource, technical: finalSource !== "model", final: true,
          summary, report: receipt.report ?? manifest.reportPath, sessionFile: receipt.session_file };
        if (manifest.mode === "dialogue" && outcome === "completed" && hasReport) {
          if (Buffer.byteLength(reportText, "utf8") <= 16 * 1024) marker.reportText = reportText;
          else marker.dialogueReportPath = receipt.transport_report_path;
        }
        emit(marker);
        process.exit(0);
      }
    }
  }

  if (!(await paneExists())) {
    transportFailure("transport_lost: child pane disappeared before a durable outcome", manifest);
    process.exit(0);
  }

  const event = await Promise.race([
    signal.promise.then(value => ({ kind: "signal", value })),
    sleep(config.pollMs).then(() => ({ kind: "poll", value: false })),
  ]);
  if (event.kind === "signal") signal = waitForChannel(config.outcomeChannel, config.pollMs * 4);
}
