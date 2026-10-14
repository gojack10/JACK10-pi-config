// Machine-owned jobs: no worker credential, recipient, model wake or project acceptance.
import { randomUUID, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, renameSync, writeFileSync, realpathSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createServer, createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const json = path => JSON.parse(readFileSync(path, 'utf8'));
const atomic = (path, value) => {
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value) + '\n', { mode: 0o600, flag: 'wx' });
  renameSync(temporary, path);
};
const processes = () => {
  const result = spawnSync('ps', ['-axo', 'pid=,pgid=,stat=,lstart='], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } });
  if (result.error || result.status !== 0) throw new Error('job process identity unavailable');
  return result.stdout.trim().split('\n').map(line => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
    if (!match) throw new Error('job process identity output is invalid; drain not established');
    const [, pid, group, state, birth] = match;
    return { pid: Number(pid), group: Number(group), state, birth };
  }).filter(p => p.pid !== result.pid); // Inspection is not a command descendant to drain.
};
const identity = pid => processes().find(p => p.pid === pid);
const alive = receipt => !!receipt && processes().some(p => p.pid === receipt.pid && p.birth === receipt.birth && !p.state.startsWith('Z'));
const validReceipt = (id, receipt) => !!receipt && receipt.id === id && ['exited','cancelled','abnormal'].includes(receipt.state) &&
  (receipt.code === null || Number.isSafeInteger(receipt.code)) && (receipt.signal === null || typeof receipt.signal === 'string') &&
  typeof receipt.drained === 'boolean' && !(receipt.state === 'exited' && receipt.code === null && receipt.signal === null);

export function jobStore(db, transaction, config, insertPost) {
  const exists = () => !!db.prepare("SELECT name FROM sqlite_master WHERE name='factory_jobs'").get();
  if (exists()) transaction(() => {
    if (!db.prepare('PRAGMA table_info(factory_jobs)').all().some(c => c.name === 'handled')) db.exec('ALTER TABLE factory_jobs ADD COLUMN handled TEXT');
  });
  const list = () => exists() ? db.prepare('SELECT * FROM factory_jobs ORDER BY rowid').all().map(row => ({ ...row, manifest: JSON.parse(row.manifest), terminal: row.terminal && JSON.parse(row.terminal), handled: row.handled ? JSON.parse(row.handled) : null })) : [];
  const terminal = (id, receipt) => transaction(() => {
    const row = list().find(j => j.id === id);
    if (!row) throw new Error('unknown independent job');
    if (row.terminal_number !== null) return row.terminal_number;
    if (!validReceipt(id, receipt)) throw new Error('invalid job terminal receipt');
    const number = insertPost(`Independent job ${id}: ${receipt.state}; ${receipt.code === null ? 'exit code unknown' : `exit code ${receipt.code}`}; ${receipt.signal ?? 'no signal'}; process-group drain ${receipt.drained ? 'verified' : 'not established'}. Owner: ${row.manifest.owner ?? 'not supplied'}. Artifacts: ${row.manifest.dir}; receipt: ${join(row.manifest.dir, 'terminal.json')}${receipt.error ? `; ${receipt.error}` : ''}`, 'controller', '[system]', 'system');
    db.prepare('UPDATE factory_jobs SET terminal=?, terminal_number=? WHERE id=? AND terminal_number IS NULL').run(JSON.stringify(receipt), number, id);
    return number;
  });
  return {
    list, terminal,
    pending: () => list().filter(j => j.terminal_number !== null && !j.handled),
    handle(id, reason) {
      if (typeof reason !== 'string' || !reason.trim() || reason.includes('\0') || Buffer.byteLength(reason) > 4096) throw new Error('handling requires a nonempty evidence/action pointer, at most 4096 bytes without NUL');
      return transaction(() => {
        if (config.session !== 'controller') {
          const worker = db.prepare('SELECT state FROM swarm_workers WHERE session=?').get(config.session);
          if (!worker || !['active','retiring'].includes(worker.state)) throw new Error('job handling requires an active/retiring peer or outside operator');
        }
        const row = list().find(j => j.id === id);
        if (!row) throw new Error('unknown independent job');
        if (row.terminal_number === null) throw new Error('job has no terminal result to handle');
        if (row.handled) return row.handled;
        const handled = { at: new Date().toISOString(), session: config.session, sender: config.sender, reason };
        db.prepare('UPDATE factory_jobs SET handled=? WHERE id=? AND handled IS NULL').run(JSON.stringify(handled), id);
        return handled;
      });
    },
    register(manifest, launch) {
      return transaction(() => {
        if (config.session !== 'controller') {
          const row = db.prepare('SELECT state,retire_requested FROM swarm_workers WHERE session=?').get(config.session);
          if (!row || row.state !== 'active' || row.retire_requested) throw new Error('independent launch requires a working active peer');
        }
        const status = db.prepare('SELECT status FROM swarm_run').get()?.status;
        if (manifest.stoppedOperation !== undefined) {
          if (config.session !== 'controller' || manifest.origin !== config.session) throw new Error('stopped operation requires an outside authorized operator');
          if (typeof manifest.stoppedOperation !== 'string' || !manifest.stoppedOperation.trim() || manifest.stoppedOperation.includes('\0') || Buffer.byteLength(manifest.stoppedOperation) > 4096 || !manifest.owner) throw new Error('stopped operation requires an owner and bounded explicit authorization reason');
          if (status !== 'stopped' || db.prepare('SELECT 1 FROM swarm_workers WHERE cleaned=0 LIMIT 1').get()) throw new Error('stopped operation requires a stopped, drained floor');
        } else if (status !== 'running') throw new Error('independent launch requires a running floor');
        db.exec(`CREATE TABLE IF NOT EXISTS factory_jobs (id TEXT PRIMARY KEY, manifest TEXT NOT NULL, terminal TEXT, terminal_number INTEGER UNIQUE, handled TEXT);`);
        const prior = list().find(j => j.id === manifest.id);
        if (prior) {
          if (JSON.stringify(prior.manifest) !== JSON.stringify(manifest)) throw new Error('job key already used with different input');
          return prior;
        }
        // Durable registration precedes process release. An uncertain launch is never retried.
        db.prepare('INSERT INTO factory_jobs(id,manifest) VALUES (?,?)').run(manifest.id, JSON.stringify(manifest));
        try { launch(); }
        catch (error) {
          const receipt = { id: manifest.id, state: 'abnormal', code: null, signal: null, drained: false, error: `Launch not established: ${error.message}` };
          const number = insertPost(`Independent job ${manifest.id}: abnormal; launch/exit/drain not established. Artifacts: ${manifest.dir}; ${receipt.error}`, 'controller', '[system]', 'system');
          db.prepare('UPDATE factory_jobs SET terminal=?,terminal_number=? WHERE id=?').run(JSON.stringify(receipt), number, manifest.id);
        }
        return list().find(j => j.id === manifest.id);
      });
    },
    observe() {
      for (const row of list().filter(j => j.terminal_number === null)) {
        const path = join(row.manifest.dir, 'terminal.json');
        if (existsSync(path)) {
          let receipt;
          try { receipt = json(path); }
          catch (error) { receipt = { id: row.id, state: 'abnormal', code: null, signal: null, drained: false, error: `Terminal receipt unreadable: ${error.message}` }; }
          if (!validReceipt(row.id, receipt)) receipt = { id: row.id, state: 'abnormal', code: null, signal: null, drained: false, error: 'Terminal receipt identity/content invalid; effects and drain uncertain.' };
          terminal(row.id, receipt); continue;
        }
        const startPath = join(row.manifest.dir, 'runner.json');
        if (!existsSync(startPath)) {
          terminal(row.id, { id: row.id, state: 'abnormal', code: null, signal: null, drained: false,
            error: 'START receipt missing; execution, exit and drain uncertain. No automatic relaunch.' });
          continue; // An abnormal observation does not assert process exit.
        }
        const start = json(startPath);
        if (start.id !== row.id) throw new Error('job runner receipt identity mismatch');
        if (!alive(start)) terminal(row.id, { id: row.id, state: 'abnormal', code: null, signal: null, drained: false,
          error: 'Runner exited without a terminal receipt; command effects and child drain are uncertain.' });
      }
      return list();
    },
    terminalNumbers: (includeHandled = false) => list().filter(j => j.terminal_number !== null && (includeHandled || !j.handled)).map(j => j.terminal_number),
  };
}

export function launchJob(board, config, { id, command, cwd, owner = null, stoppedOperation }) {
  if (typeof id !== 'string' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(id)) throw new Error('job key must be a fresh UUID, retained for uncertain retries');
  if (typeof command !== 'string' || !command.trim() || command.includes('\0') || Buffer.byteLength(command) > 65536) throw new Error('job command must be nonempty bounded text without NUL');
  if (owner !== null && (typeof owner !== 'string' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(owner))) throw new Error('job owner must be a node UUID');
  const state = board.lifecycle.status();
  if (!state.floor) throw new Error('independent jobs require a registered factory floor');
  cwd = realpathSync(cwd);
  const revision = spawnSync('git', ['-C', cwd, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  if (revision.error || revision.status !== 0) throw new Error('job cwd needs an existing Git revision; dirty drafts remain in place');
  const dir = join(state.config.runDir, 'jobs', id);
  const manifest = { id, command, cwd, revision: revision.stdout.trim(), owner, dir, database: config.database, run: config.run, floor: state.config.floorId,
    origin: config.session, log: join(dir, 'output.log'), receipt: join(dir, 'terminal.json'),
    ...(stoppedOperation !== undefined ? { stoppedOperation } : {}) };
  // Stable retries read the original manifest instead of allocating another process.
  const previous = board.jobs.list().find(j => j.id === id);
  if (previous) {
    if (previous.manifest.command !== command || previous.manifest.cwd !== cwd || previous.manifest.owner !== owner || previous.manifest.origin !== config.session || previous.manifest.stoppedOperation !== stoppedOperation) throw new Error('job key already used with different input');
    return previous;
  }
  let child;
  let result;
  try { result = board.jobs.register(manifest, () => {
    mkdirSync(dirname(dir), { recursive: true, mode: 0o700 }); mkdirSync(dir, { mode: 0o700 });
    atomic(join(dir, 'manifest.json'), manifest);
    // Short Unix-socket path, unguessable local capability. Not an auth sandbox.
    const control = { socket: join(tmpdir(), `factory-job-${randomBytes(12).toString('hex')}.sock`), token: randomBytes(32).toString('hex') };
    atomic(join(dir, 'control.json'), control);
    const fd = openSync(join(dir, 'runner.log'), 'a', 0o600);
    try {
      // Spawn gated on stdin: commit registration before a command can execute.
      child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--runner', join(dir, 'manifest.json')], { detached: true, stdio: ['pipe', fd, fd],
        env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(BF2_|FACTORY_|PI_SUBAGENT|PI_RLM_)/.test(key) && !['TMUX','TMUX_PANE','PI_SESSION_ID','PI_SESSION_FILE'].includes(key))) });
      child.on('error', error => console.error(`Independent job ${id}: ${error.message}; inspect retained registration`));
      child.stdin?.on('error', error => console.error(`Independent job ${id}: boot release ${error.message}`));
      if (!child.pid) throw new Error('runner PID absent; no command release');
      const start = identity(child.pid);
      if (!start?.birth) throw new Error('runner identity not established; no command release');
      atomic(join(dir, 'runner.json'), { id, pid: child.pid, birth: start.birth });
    } finally { closeSync(fd); }
  }); }
  catch (error) { child?.stdin?.end(); child?.unref(); throw error; }
  child?.stdin?.end(result.terminal ? '' : 'release\n'); child?.unref();
  return result;
}

export async function cancelJob(row) {
  if (!row) throw new Error('unknown independent job');
  if (row.terminal?.drained) return row.terminal;
  const control = json(join(row.manifest.dir, 'control.json'));
  // The runner, not a possibly reused PID, receives the request and verifies its own group.
  return new Promise((resolve, reject) => {
    const socket = createConnection(control.socket); let text = '';
    socket.setTimeout(10000, () => socket.destroy(new Error('job cancellation receipt unavailable; inspect state, do not assume drain')));
    socket.on('connect', () => socket.write(JSON.stringify({ id: row.id, token: control.token, action: 'cancel' }) + '\n'));
    socket.on('data', chunk => { text += chunk; if (Buffer.byteLength(text) > 65536) socket.destroy(new Error('invalid cancellation response')); });
    socket.on('error', reject);
    socket.on('end', () => { try { const receipt = JSON.parse(text); if (!receipt.drained || receipt.id !== row.id) throw new Error(receipt.error ?? 'job drain not established'); resolve(receipt); } catch (error) { reject(error); } });
  });
}

async function runJob(path) {
  const manifest = json(path), control = json(join(manifest.dir, 'control.json'));
  const start = identity(process.pid);
  if (!start?.birth) throw new Error('runner identity unavailable');
  atomic(join(manifest.dir, 'runner.json'), { id: manifest.id, pid: process.pid, birth: start.birth });
  const released = await new Promise(resolve => { let input = ''; process.stdin.on('data', chunk => input += chunk); process.stdin.on('end', () => resolve(input === 'release\n')); });
  // Launcher crash before commit/release leaves honest retained evidence, not execution.
  if (!released) throw new Error('job boot was not released; command not started');
  const { openBoard } = await import('./board.mjs');
  const board = openBoard({ database: manifest.database, run: manifest.run, floor: manifest.floor, session: 'controller', sender: '00000000' });
  if (!board.jobs.list().some(row => row.id === manifest.id && JSON.stringify(row.manifest) === JSON.stringify(manifest))) throw new Error('job registration mismatch');
  let child, group, cancelled = false, exit, failure, timer, killing = false;
  const known = new Map();
  const ownedGroup = () => {
    const members = processes().filter(p => p.group === group && !p.state.startsWith('Z'));
    if (!members.length) return false;
    if (!members.some(p => known.get(p.pid) === p.birth)) throw new Error('job group identity uncertain; cancellation/drain refused');
    for (const member of members) known.set(member.pid, member.birth);
    return true;
  };
  const sockets = new Set();
  const server = createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {}); let input = '';
    socket.on('data', chunk => {
      input += chunk;
      if (Buffer.byteLength(input) > 4096) { socket.destroy(); return; }
      if (!input.includes('\n')) return;
      try {
        const request = JSON.parse(input);
        if (request.id !== manifest.id || request.token !== control.token || request.action !== 'cancel') throw new Error('job cancellation identity mismatch');
        cancelled = true;
        if (!killing && group) {
          killing = true;
          if (ownedGroup()) process.kill(-group, 'SIGTERM');
          setTimeout(() => { try { if (ownedGroup()) process.kill(-group, 'SIGKILL'); } catch (error) { failure = error.message; } }, 1000).unref();
        }
      } catch (error) { socket.end(JSON.stringify({ id: manifest.id, drained: false, error: error.message })); }
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(control.socket, resolve); });
  const fd = openSync(manifest.log, 'a', 0o600);
  // A native group leader pins identity until ordinary descendants drain, even
  // when the shell exits first. Worker cleanup has no handle to this group.
  try { child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--command', path], { cwd: manifest.cwd, detached: true, stdio: ['ignore', fd, fd] }); }
  finally { closeSync(fd); }
  group = child.pid;
  if (group) {
    const birth = identity(group)?.birth ?? null;
    if (birth) known.set(group, birth);
    atomic(join(manifest.dir, 'process.json'), { id: manifest.id, pid: group, group, birth });
  }
  child.on('error', error => { failure = error.message; exit = { code: null, signal: null }; });
  child.on('exit', (code, signal) => { exit = { code, signal }; });
  const receipt = await new Promise(resolve => {
    timer = setInterval(() => {
      try {
        if (group && ownedGroup()) return;
        if (!exit) return;
        const commandReceipt = join(manifest.dir, 'command-exit.json');
        let result = exit;
        try {
          if (existsSync(commandReceipt)) result = json(commandReceipt);
          if (!result || !(result.code === null || Number.isSafeInteger(result.code)) || !(result.signal === null || typeof result.signal === 'string')) throw new Error('invalid command receipt');
        } catch (error) { result = { code: null, signal: null, error: `Command receipt unreadable: ${error.message}` }; }
        const error = failure ?? result.error ?? (!existsSync(commandReceipt) && !cancelled ? 'Command group leader exited without the command receipt; effects uncertain.' : null);
        clearInterval(timer);
        resolve({ id: manifest.id, state: error ? 'abnormal' : cancelled ? 'cancelled' : 'exited', code: result.code, signal: result.signal, drained: true, drainScope: 'process-group',
          ...(error ? { error } : {}), finished: new Date().toISOString() });
      } catch (error) { console.error(error.message); /* Unknown process state cannot certify drain. */ }
    }, 100);
  });
  atomic(manifest.receipt, receipt);
  // Keep retrying event publication independently of workers/controllers. No model is launched.
  for (;;) {
    try { board.jobs.terminal(manifest.id, receipt); break; }
    catch (error) { console.error(error.message); await new Promise(resolve => setTimeout(resolve, 1000)); }
  }
  for (const socket of sockets) socket.end(JSON.stringify(receipt));
  await new Promise(resolve => server.close(resolve));
  try { unlinkSync(control.socket); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  board.close();
}
async function runCommand(path) {
  const manifest = json(path);
  // TERM reaches the entire command group, but this identity stays pinned while
  // observing drain. Escalated KILL is handled honestly by the outer runner.
  process.on('SIGTERM', () => {}); process.on('SIGINT', () => {});
  const child = spawn('/bin/sh', ['-c', manifest.command], { cwd: manifest.cwd, stdio: ['ignore', 'inherit', 'inherit'] });
  const result = await new Promise(resolve => {
    child.on('error', error => resolve({ code: null, signal: null, error: error.message }));
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });
  await new Promise(resolve => {
    const timer = setInterval(() => {
      try {
        if (processes().some(p => p.group === process.pid && p.pid !== process.pid && !p.state.startsWith('Z'))) return;
        clearInterval(timer); resolve();
      } catch (error) { console.error(error.message); }
    }, 100);
  });
  atomic(join(manifest.dir, 'command-exit.json'), result);
}
if (['--runner','--command'].includes(process.argv[2]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  (process.argv[2] === '--runner' ? runJob : runCommand)(process.argv[3]).catch(error => { console.error(error.message); process.exitCode = 1; });
}
