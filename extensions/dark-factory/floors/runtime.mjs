import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { openBoard } from '../../bf2-swarm/board.mjs';
import { openRun } from '../../bf2-swarm/controller.mjs';
export { missingFloorLaunchSettings } from '../../bf2-swarm/lifecycle-store.mjs';

export const DEFAULT_ROOT = join(homedir(), '.local/state/dark-factory/floors');
// Personal is the public selector; private backing account identities remain untracked.
export const ROUTES = Object.freeze([
  { provider: 'openrouter', model: 'xiaomi/mimo-v2.6-pro', thinking: 'high' },
  { provider: 'openai-codex-personal', providerPattern: '^openai-codex(?:-[a-z0-9-]+)?$', model: 'gpt-6.1-sol', thinking: 'high' },
  { provider: 'local', model: 'qwen3.8-flash-next', thinking: 'xhigh' },
  { provider: 'openai-codex-personal', providerPattern: '^openai-codex(?:-[a-z0-9-]+)?$', model: 'gpt-6-luna', thinking: 'high' },
]);
export const isOss = slot => slot?.provider === 'local' && slot.model === 'qwen3.8-flash-next';
const code = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const validId = id => {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(id)) throw new Error('floor/slot ID must be 1-64 letters, digits, _ or -');
  return id;
};
const rootPath = root => {
  if (typeof root !== 'string' || !isAbsolute(root) || /[\0\n\r]/.test(root)) throw new Error('floor root must be an absolute path');
  root = resolve(root);
  let ancestor = root;
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  return join(realpathSync(ancestor), relative(ancestor, root));
};
const text = (value, label, optional = false) => {
  if (optional && value === null) return null;
  if (typeof value !== 'string' || (!optional && !value.trim()) || value.includes('\0') || Buffer.byteLength(value) > 16384) throw new Error(`${label} must be bounded text without NUL`);
  return value;
};
export function validateSettings(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('floor settings must be an object');
  const keys = ['name','cwd','roots','instructions','voteCondition','slots','bootstrap','warningText','wrapupText'];
  if (Object.keys(input).some(k => !keys.includes(k))) throw new Error('unknown floor setting');
  const name = text(input.name, 'name');
  if (!isAbsolute(input.cwd ?? '') || /[\0\n\r]/.test(input.cwd)) throw new Error('cwd must be an absolute checkout path');
  const cwd = realpathSync(input.cwd);
  if (!statSync(cwd).isDirectory() || !existsSync(join(cwd, '.git'))) throw new Error('cwd must be an existing Git checkout');
  if (!Array.isArray(input.roots) || !input.roots.length || input.roots.length > 100 || input.roots.some(r => typeof r !== 'string' || !uuid.test(r))) throw new Error('roots must contain tree starting node UUIDs');
  if (input.instructions != null && (typeof input.instructions !== 'string' || !uuid.test(input.instructions))) throw new Error('instructions must be a tree node UUID or null while stopped');
  const voteCondition = input.voteCondition == null ? null : text(input.voteCondition, 'voteCondition');
  if (!Array.isArray(input.slots) || input.slots.length < 2 || input.slots.length > 10) throw new Error('floor requires 2-10 slots');
  const slots = input.slots.map(s => {
    if (!s || Object.keys(s).some(k => !['id','provider','model','thinking','role','contextWarning'].includes(k))) throw new Error('unknown slot setting');
    const id = validId(s.id);
    if (typeof s.provider !== 'string' || !ROUTES.some(r => (r.providerPattern ? new RegExp(r.providerPattern).test(s.provider) : r.provider === s.provider) && r.model === s.model && r.thinking === s.thinking)) throw new Error('slot requires an explicitly approved provider/model/thinking route');
    const contextWarning = s.contextWarning ?? 80;
    if (typeof contextWarning !== 'number' || !Number.isFinite(contextWarning) || contextWarning <= 0 || contextWarning > 100) throw new Error('contextWarning must be >0 and <=100 percent');
    if (s.role !== undefined && typeof s.role !== 'string') throw new Error('role must be text');
    return { id, provider: s.provider, model: s.model, thinking: s.thinking, role: text(s.role ?? '', 'role', true), contextWarning };
  });
  if (new Set(slots.map(s => s.id)).size !== slots.length || slots.filter(isOss).length > 1) throw new Error('slot IDs must be unique; at most one OSS slot per floor');
  return { name, cwd, roots: [...new Set(input.roots)], instructions: input.instructions ?? null, voteCondition, slots,
    ...Object.fromEntries(['bootstrap','warningText','wrapupText'].map(key => [key, input[key] == null ? null : text(input[key], key)])) };
}
const launchSettings = (settings, root, id, runDir, agentDir) => ({ ...settings, floorId: id, floorRoot: root, root: settings.roots[0],
  agentDir, code, sessionDir: join(runDir, 'sessions'), runDir });
function attach(database, id, root, runDir, settings, agentDir) {
  const db = new DatabaseSync(database);
  try {
    db.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
    db.exec(`CREATE TABLE floor_settings (id TEXT PRIMARY KEY, settings TEXT NOT NULL, root TEXT NOT NULL, run_dir TEXT NOT NULL);
      ALTER TABLE swarm_workers ADD COLUMN slot TEXT;
      ALTER TABLE swarm_workers ADD COLUMN launch_config TEXT;
      ALTER TABLE swarm_workers ADD COLUMN session_file TEXT;
      ALTER TABLE swarm_workers ADD COLUMN retire_requested TEXT;
      ALTER TABLE swarm_workers ADD COLUMN context_percent REAL;
      ALTER TABLE swarm_workers ADD COLUMN last_error TEXT;
      CREATE UNIQUE INDEX floor_live_slots ON swarm_workers(slot) WHERE cleaned=0;`);
    db.prepare('INSERT INTO floor_settings VALUES (?,?,?,?)').run(id, JSON.stringify(settings), root, runDir);
    db.prepare("UPDATE swarm_run SET config=?, status='stopped', reconvene=0, request=NULL").run(JSON.stringify(launchSettings(settings, root, id, runDir, agentDir)));
    db.exec('COMMIT');
  } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
  finally { db.close(); }
}
export function createFloor(input, { root = DEFAULT_ROOT, id = randomUUID() } = {}) {
  root = rootPath(root); validId(id);
  const settings = validateSettings(input), dir = join(root, id), database = join(dir, 'floor.sqlite');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  mkdirSync(dir, { mode: 0o700 }); // Refuse an existing namespace.
  let board;
  try {
    mkdirSync(join(dir, 'sessions'), { mode: 0o700 });
    board = openBoard({ database, run: id, session: 'controller', sender: '00000000' });
    board.lifecycle.initialize({});
    attach(database, id, root, dir, settings, process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi/agent'));
  } catch (error) { board?.close(); board = null; rmSync(dir, { recursive: true, force: true }); throw error; }
  finally { board?.close(); }
  return { id, database, name: settings.name, status: 'stopped' };
}
export function openFloor(id, { root = DEFAULT_ROOT } = {}) {
  validId(id); root = rootPath(root);
  const database = join(root, id, 'floor.sqlite');
  if (!existsSync(database)) throw new Error(`unknown floor: ${id}`);
  const db = new DatabaseSync(database, { readOnly: true });
  let metadata, run;
  try { metadata = db.prepare('SELECT * FROM floor_settings').get(); run = db.prepare('SELECT run FROM board_run').get().run; }
  finally { db.close(); }
  if (metadata.id !== id || metadata.root !== root) throw new Error('floor registration does not match requested namespace');
  const config = { database, run, floor: id, session: 'controller', sender: '00000000' }, board = openBoard(config);
  return { id, database, config, board, root,
    settings: () => board.lifecycle.status().floor,
    configure(patch) {
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('configuration patch must be an object');
      const settings = validateSettings({ ...this.settings(), ...patch });
      const current = board.lifecycle.status().config;
      return board.lifecycle.configureFloor(settings, launchSettings(settings, root, id, metadata.run_dir, current.agentDir));
    },
    snapshot(after = 0) {
      const state = board.lifecycle.status();
      return { ...board.roomSnapshot(after), floor: { id, ...state.floor }, workers: state.workers, slots: state.floor.slots };
    },
    command: (key, action, value = null) => board.lifecycle.ownerCommand(key, action, value),
    close: () => board.close() };
}
export function listFloors({ root = DEFAULT_ROOT } = {}) {
  root = rootPath(root);
  if (!existsSync(root)) return [];
  const floors = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !existsSync(join(root, entry.name, 'floor.sqlite'))) continue;
    // Creation publishes floor_settings atomically last. A simultaneous poll
    // must not treat a still-initializing board file as a discoverable floor.
    const db = new DatabaseSync(join(root, entry.name, 'floor.sqlite'), { readOnly: true });
    let registered;
    try { db.exec('PRAGMA busy_timeout=5000'); registered = db.prepare("SELECT name FROM sqlite_master WHERE name='floor_settings'").get(); }
    finally { db.close(); }
    if (!registered) continue;
    const floor = openFloor(entry.name, { root });
    try { const state = floor.board.lifecycle.status(); floors.push({ id: floor.id, database: floor.database, name: state.floor.name, status: state.status }); }
    finally { floor.close(); }
  }
  return floors.sort((a, b) => a.id.localeCompare(b.id));
}
export function adoptFloor(runDir, input, { root = DEFAULT_ROOT, id } = {}) {
  validId(id); root = rootPath(root); runDir = realpathSync(runDir);
  const settings = validateSettings(input), dir = join(root, id);
  if (existsSync(join(dir, 'floor.sqlite'))) {
    const prior = openFloor(id, { root });
    try {
      if (realpathSync(prior.database) !== realpathSync(join(runDir, 'board.sqlite')) || JSON.stringify(prior.settings()) !== JSON.stringify(settings)) throw new Error('floor already adopted with different source or settings');
      return { id, database: prior.database, name: settings.name, status: prior.snapshot().status };
    } finally { prior.close(); }
  }
  const original = openRun(runDir);
  let created = false;
  try {
    const state = original.board.lifecycle.status();
    if (state.status !== 'stopped' || state.workers.some(w => !w.cleaned)) throw new Error('adoption requires a stopped, drained BF2 run');
    if (state.controller !== null) {
      try { process.kill(state.controller, 0); throw new Error('adoption requires the old controller to exit'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    mkdirSync(root, { recursive: true, mode: 0o700 }); mkdirSync(dir, { mode: 0o700 }); created = true;
    // SQLite resolves the symlink to its original file: WAL/history/session paths stay together.
    symlinkSync(original.config.database, join(dir, 'floor.sqlite'));
    attach(original.config.database, id, root, runDir, settings, state.config.agentDir);
    return { id, database: join(dir, 'floor.sqlite'), name: settings.name, status: 'stopped' };
  } catch (error) { if (created) rmSync(dir, { recursive: true, force: true }); throw error; }
  finally { original.board.close(); }
}
function withOss(root, fn) {
  root = rootPath(root); mkdirSync(root, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(root, 'oss.sqlite'));
  try {
    db.exec(`PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS oss (id INTEGER PRIMARY KEY CHECK(id=1), selected TEXT, floor TEXT, session TEXT);
      INSERT OR IGNORE INTO oss(id) VALUES (1); BEGIN IMMEDIATE;`);
    const result = fn(db); db.exec('COMMIT'); return result;
  } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
  finally { db.close(); }
}
export const ossStatus = ({ root = DEFAULT_ROOT } = {}) => withOss(root, db => ({ ...db.prepare('SELECT selected,floor,session FROM oss').get() }));
export function selectOssFloor(id, { root = DEFAULT_ROOT } = {}) {
  if (id !== null) {
    const floor = openFloor(id, { root });
    try { if (!floor.settings().slots.some(isOss)) throw new Error('selected floor needs an OSS slot'); }
    finally { floor.close(); }
  }
  const state = withOss(root, db => { db.prepare('UPDATE oss SET selected=?').run(id); return { ...db.prepare('SELECT selected,floor,session FROM oss').get() }; });
  if (state.floor && state.floor !== id) {
    const old = openFloor(state.floor, { root });
    try { old.board.lifecycle.requestRetirement(state.session, 'OSS floor selection changed'); }
    finally { old.close(); }
  }
  return state;
}
// Hold exactly one lease through actual cleanup; ambiguous crash receipts fail closed.
export function claimOss(root, id, session, launch) {
  const reserved = withOss(root, db => {
    const state = db.prepare('SELECT * FROM oss').get();
    if (state.selected !== id || state.session) return false;
    db.prepare('UPDATE oss SET floor=?,session=?').run(id, session);
    return true;
  });
  if (!reserved) return false;
  // Commit the global lease BEFORE a child can be released. A crash/throw keeps
  // capacity held, even if the floor transaction rolls back after child startup.
  const result = launch();
  if (!result) releaseOss(root, id, session);
  return result;
}
export const releaseOss = (root, id, session) => withOss(root, db => db.prepare('UPDATE oss SET floor=NULL,session=NULL WHERE floor=? AND session=?').run(id, session).changes > 0);
