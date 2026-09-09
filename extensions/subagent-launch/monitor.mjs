import { execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
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

const manifestDeadline = Date.now() + config.startTimeoutMs;
let lastGeneration;
let activeKey;
let startedKey;
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
      const startGeneration = Number.parseInt(await show(config.startGenerationOption) ?? "", 10);
      const file = await sessionFile();
      if (Number.isSafeInteger(startGeneration) && startGeneration > manifest.startGeneration && file) {
        startWait.cancel();
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
    const raw = await show(config.outcomeOption);
    let receipt;
    try { receipt = raw ? JSON.parse(raw) : undefined; } catch { receipt = undefined; }
    const source = receipt && receipt.source === undefined ? "model" : receipt?.source;
    if (!receipt || receipt.job_id !== manifest.jobId || receipt.attempt_id !== manifest.attemptId ||
        receipt.mode !== manifest.mode || receipt.session_id !== manifest.sessionId ||
        typeof receipt.outcome !== "string" ||
        (receipt.source !== undefined && !["model", "technical", "protocol", "transport"].includes(receipt.source))) {
      emit({ kind: "evidence", jobId: manifest.jobId, attemptId: manifest.attemptId,
        summary: `ignored malformed, foreign, or mismatched outcome generation ${currentGeneration}` });
    } else if (receipt.outcome === "needs_input" || (receipt.final === false && receipt.outcome !== "transport_lost")) {
      emit({ kind: "needs_input", jobId: receipt.job_id, attemptId: receipt.attempt_id,
        source, final: false, summary: receipt.summary || "child requested human input", report: receipt.report });
    } else {
      let outcome = receipt.outcome;
      let finalSource = source;
      let summary = receipt.summary || `${outcome} ${manifest.jobId}`;
      if (outcome === "transport_lost" && source === "transport") {
        // A task manager transport record is non-semantic, but terminal for this monitor.
      } else {
        if (manifest.mode === "dialogue" && outcome === "dialogue_settled") outcome = "completed";
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
      emit({ kind: "final", jobId: receipt.job_id, attemptId: receipt.attempt_id,
        outcome, source: finalSource, technical: finalSource !== "model", final: true,
        summary, report: manifest.reportPath, sessionFile: receipt.session_file });
      process.exit(0);
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
