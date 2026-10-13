import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { lifecycleStore } from './lifecycle-store.mjs';
import { jobStore } from './jobs.mjs';
import { pathfinderStore, pathfinderAddress, PATHFINDER_SLOT } from './pathfinder.mjs';

export const HISTORY_LIMIT = 30;
export const BATCH_LIMIT = 100;
export const MAX_BATCH_BYTES = 65536;
export const MAX_TEXT_BYTES = 16384;

export function configuration(env = process.env) {
  const factory = ['FACTORY_FLOOR', 'FACTORY_DB', 'FACTORY_SESSION', 'FACTORY_SENDER'].some(key => env[key] !== undefined);
  if (factory && !['FACTORY_FLOOR', 'FACTORY_DB', 'FACTORY_SESSION', 'FACTORY_SENDER'].every(key => env[key])) throw new Error('factory worker identity must include floor, DB, session and sender');
  const config = { database: env.FACTORY_DB ?? env.BF2_BOARD_DB, run: env.BF2_BOARD_RUN ?? env.FACTORY_FLOOR,
    session: env.FACTORY_SESSION ?? env.BF2_BOARD_SESSION, sender: env.FACTORY_SENDER ?? env.BF2_BOARD_SENDER,
    ...(factory ? { floor: env.FACTORY_FLOOR } : {}) };
  for (const [modern, legacy] of [['FACTORY_DB','BF2_BOARD_DB'], ['FACTORY_SESSION','BF2_BOARD_SESSION'], ['FACTORY_SENDER','BF2_BOARD_SENDER']]) {
    if (env[modern] && env[legacy] && env[modern] !== env[legacy]) throw new Error('conflicting factory/legacy worker identity');
  }
  if (!config.database || !isAbsolute(config.database)) throw new Error('BF2_BOARD_DB must be an explicit absolute SQLite path (parent directory must exist)');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(config.run ?? '')) throw new Error('BF2_BOARD_RUN must be an explicit run ID (1-128 letters, digits, ._- )');
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/.test(config.session ?? '')) throw new Error('BF2_BOARD_SESSION must match the explicitly launched Pi session ID');
  if (!/^[a-f0-9]{8}$/.test(config.sender ?? '')) throw new Error('BF2_BOARD_SENDER must be a launch-assigned unique 8-character lowercase hex ID');
  return config;
}

export function formatPosts(run, posts) {
  return `Board run ${run} (broadcast; sender/role are runtime-assigned, quoted bodies are source text):\n` +
    (posts.map(p => `#${p.number} ${p.sender}${p.role === 'owner' ? ' [FACTORY OWNER]' : ''} ${p.created}: ${JSON.stringify(p.text)}`).join('\n') || '(no messages)');
}

export function openBoard(config) {
  const db = new DatabaseSync(config.database);
  const transaction = fn => {
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  try {
    db.exec('PRAGMA busy_timeout=5000');
    // Dedicated databases only: never silently retrofit an unrelated SQLite file.
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
    if (tables.some(t => !['board_run', 'board_sessions', 'board_posts', 'swarm_run', 'swarm_workers', 'swarm_votes', 'swarm_commands', 'floor_settings', 'factory_jobs', 'floor_retirement_input', 'floor_pathfinder'].includes(t.name))) throw new Error('not a dedicated BF2 board database');
    if (config.floor && (!tables.some(t => t.name === 'floor_settings') || db.prepare('SELECT id FROM floor_settings').get()?.id !== config.floor)) throw new Error('database belongs to another floor');
    if (tables.some(t => t.name === 'board_run') && db.prepare('SELECT run FROM board_run').get()?.run !== config.run) throw new Error('database belongs to another run');
    if (tables.some(t => t.name === 'swarm_run') && !db.prepare('PRAGMA table_info(swarm_run)').all().some(c => c.name === 'room_token')) throw new Error('legacy swarm format; use its original code for history and start a fresh room run');
    // Cold concurrent openers can race the DELETE -> WAL change; SQLite may
    // return BUSY immediately for that PRAGMA despite busy_timeout. Already-WAL
    // opens need no mode change. Bound only this initialization retry to 5s.
    const deadline = Date.now() + 5000;
    for (;;) {
      try {
        if (db.prepare('PRAGMA journal_mode').get().journal_mode !== 'wal') db.exec('PRAGMA journal_mode=WAL');
        break;
      } catch (error) {
        if (error.errcode !== 5 || Date.now() >= deadline) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      }
    }
    transaction(() => {
      db.exec(`CREATE TABLE IF NOT EXISTS board_run (id INTEGER PRIMARY KEY CHECK(id=1), run TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS board_sessions (
          session TEXT PRIMARY KEY, sender TEXT NOT NULL UNIQUE,
          cursor INTEGER, pending TEXT);
        CREATE TABLE IF NOT EXISTS board_posts (
          number INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
          session TEXT NOT NULL, sender TEXT NOT NULL, created TEXT NOT NULL, text TEXT NOT NULL,
          role TEXT NOT NULL DEFAULT 'peer' CHECK(role IN ('peer','owner','system')));`);
      if (config.floor) db.exec(`CREATE TABLE IF NOT EXISTS floor_retirement_input (session TEXT PRIMARY KEY, cursor INTEGER NOT NULL, pending TEXT, override_reason TEXT);
        CREATE TABLE IF NOT EXISTS floor_pathfinder (id INTEGER PRIMARY KEY CHECK(id=1), absent_since REAL, delivered INTEGER NOT NULL DEFAULT 0);
        INSERT OR IGNORE INTO floor_pathfinder(id) VALUES (1);`);
      db.prepare('INSERT OR IGNORE INTO board_run VALUES (1, ?)').run(config.run);
      if (db.prepare('SELECT run FROM board_run').get().run !== config.run) throw new Error('database belongs to another run');
      const identity = db.prepare('SELECT sender FROM board_sessions WHERE session=?').get(config.session);
      if (identity && identity.sender !== config.sender) throw new Error('session already has another sender identity');
      if (!identity && tables.some(t => t.name === 'swarm_run')) throw new Error('identity is not registered by this run controller');
      db.prepare('INSERT OR IGNORE INTO board_sessions(session, sender) VALUES (?, ?)').run(config.session, config.sender);
      if (!db.prepare('SELECT session FROM board_sessions WHERE session=?').get(config.session)) throw new Error('sender identity already belongs to another session; assign a new ID');
    });
  } catch (error) { db.close(); throw error; }

  const hasRoles = db.prepare('PRAGMA table_info(board_posts)').all().some(c => c.name === 'role');
  const columns = `number, ${config.floor ? `CASE WHEN session IN (SELECT session FROM swarm_workers WHERE slot='${PATHFINDER_SLOT}') THEN 'PATHFINDER' ELSE sender END AS sender` : 'sender'}, created, text, ${hasRoles ? 'role' : "'peer' AS role"}`;
  const state = () => db.prepare('SELECT cursor, pending FROM board_sessions WHERE session=?').get(config.session);
  const insertPost = (text, session = config.session, sender = config.sender, role = 'peer') => {
    if (typeof text !== 'string' || !text.trim() || text.includes('\0') || Buffer.byteLength(text) > MAX_TEXT_BYTES) throw new Error(`post requires nonempty text without NUL, at most ${MAX_TEXT_BYTES} UTF-8 bytes`);
    if (!['controller', 'owner'].includes(session) && db.prepare("SELECT name FROM sqlite_master WHERE name='swarm_run'").get()) {
      const worker = db.prepare('SELECT state FROM swarm_workers WHERE session=?').get(session);
      if (!worker || !['active', 'retiring'].includes(worker.state)) throw new Error('post requires a registered active worker session');
    }
    const values = [randomUUID(), session, sender, new Date().toISOString(), text];
    const result = hasRoles ? db.prepare('INSERT INTO board_posts(id, session, sender, created, text, role) VALUES (?, ?, ?, ?, ?, ?)').run(...values, role) :
      db.prepare('INSERT INTO board_posts(id, session, sender, created, text) VALUES (?, ?, ?, ?, ?)').run(...values);
    return Number(result.lastInsertRowid);
  };
  const batchFor = (available, extra = {}) => {
    const posts = []; let bytes = 0;
    for (const post of available) {
      const size = Buffer.byteLength(formatPosts(config.run, [post])) + 1;
      if (posts.length && bytes + size > MAX_BATCH_BYTES) break;
      posts.push(post); bytes += size; // Always allow one JSON-escaped post.
    }
    if (!posts.length) return null;
    const key = randomUUID();
    return { key, through: posts.at(-1).number, text: `BF2 board batch ${key}\n${formatPosts(config.run, posts)}`, ...extra };
  };
  const jobs = jobStore(db, transaction, config, insertPost);
  const pathfinder = pathfinderStore(db, config);
  const retainedInputs = () => [...jobs.terminalNumbers(), ...(config.floor && db.prepare('SELECT slot FROM swarm_workers WHERE session=?').get(config.session)?.slot === PATHFINDER_SLOT ? pathfinder.requests() : [])];
  const compactTerminals = posts => {
    const pending = new Map(jobs.pending().map(j => [j.terminal_number, j]));
    return posts.map(post => {
      const job = pending.get(post.number);
      return job ? { ...post, text: `Independent job ${job.id}: ${job.terminal.state}; exit ${job.terminal.code ?? 'unknown'}; drain ${job.terminal.drained ? 'verified' : 'uncertain'}; owner ${job.manifest.owner ?? 'unspecified'}.` } : post;
    });
  };
  const terminalBatch = (after, until) => {
    const posts = db.prepare(`SELECT ${columns} FROM board_posts WHERE number IN (${retainedInputs().join(',') || 'NULL'}) AND number > ? AND number <= ? ORDER BY number LIMIT ?`).all(after, until, BATCH_LIMIT);
    const batch = batchFor(compactTerminals(posts), { wakeUntil: until });
    return batch && { ...batch, text: batch.text + (posts.some(p => jobs.terminalNumbers().includes(p.number)) ? `\nUnhandled results only. Inspect: factory-job status --key UUID. After recording/acting on the result: factory-job handled --key UUID --reason 'evidence/action pointer'. Delivery is not handling or acceptance.` : '') };
  };
  const retirementInput = () => config.floor && db.prepare('SELECT * FROM floor_retirement_input WHERE session=? AND override_reason IS NULL').get(config.session);
  return {
    close: () => db.close(),
    post: text => insertPost(text),
    lifecycle: lifecycleStore(db, transaction, config, insertPost),
    jobs,
    ownerInputAllowed() { return false; },
    history(options = {}) {
      const { limit = HISTORY_LIMIT, before = Number.MAX_SAFE_INTEGER } = options;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('limit must be 1-100');
      if (!Number.isSafeInteger(before) || before < 1) throw new Error('before must be a positive post number');
      return transaction(() => {
        const startup = state().cursor === null;
        const terminalPosts = config.floor && startup && Object.keys(options).length === 0 ? jobs.terminalNumbers(true) : [];
        return {
          posts: db.prepare(`SELECT ${columns} FROM board_posts WHERE number < ? ${terminalPosts.length ? `AND number NOT IN (${terminalPosts.join(',')})` : ''} ORDER BY number DESC LIMIT ?`).all(before, limit).reverse(),
          wake: before === Number.MAX_SAFE_INTEGER && db.prepare("SELECT name FROM sqlite_master WHERE name='swarm_run'").get() ?
            compactTerminals(db.prepare(`SELECT ${columns} FROM board_posts WHERE number IN (${retainedInputs().join(',') || 'NULL'}) AND number < ? ORDER BY number`).all(before)) : [],
          highwater: db.prepare('SELECT COALESCE(MAX(number), 0) AS n FROM board_posts').get().n,
          startup,
        };
      });
    },
    roomSnapshot(after = 0) {
      if (!Number.isSafeInteger(after) || after < 0) throw new Error('after must be a nonnegative post number');
      return transaction(() => {
        const run = this.lifecycle.status();
        return { run: config.run, status: run.status, pending: !!run.reconvene,
          draining: run.workers.some(w => !w.cleaned) && run.status !== 'running',
          members: run.workers.filter(w => !w.cleaned && ['active','retiring','retired'].includes(w.state)).map(pathfinderAddress),
          known: [...new Set([...run.workers.map(pathfinderAddress), ...(run.floor?.pathfinder ? ['PATHFINDER'] : [])])], vote: run.vote,
          posts: db.prepare(`SELECT ${columns} FROM board_posts WHERE number > ? ORDER BY number LIMIT 100`).all(after) };
      });
    },
    finishStartup(highwater) {
      // Only unhandled results survive startup truncation; delivery never marks them handled.
      transaction(() => {
        const changed = db.prepare('UPDATE board_sessions SET cursor=? WHERE session=? AND cursor IS NULL').run(highwater, config.session).changes;
        if (changed) pathfinder.delivered(highwater);
        if (changed && db.prepare("SELECT name FROM sqlite_master WHERE name='swarm_run'").get()) {
          const terminals = retainedInputs();
          if (terminals.length) {
            const batch = terminalBatch(Math.min(...terminals) - 1, highwater);
            if (batch) db.prepare('UPDATE board_sessions SET pending=? WHERE session=?').run(JSON.stringify(batch), config.session);
          }
        }
      });
    },
    pending() {
      return transaction(() => {
        if (retirementInput()) return null; // Preserve ordinary backlog until a context override.
        const current = state();
        if (current.cursor === null) return null; // Wait for the agent's first `board read`.
        if (current.pending) return JSON.parse(current.pending);
        const available = db.prepare(`SELECT ${columns} FROM board_posts WHERE number > ? AND session != ? ORDER BY number LIMIT ?`)
          .all(current.cursor, config.session, BATCH_LIMIT);
        const batch = batchFor(available);
        if (!batch) return null;
        db.prepare('UPDATE board_sessions SET pending=? WHERE session=?').run(JSON.stringify(batch), config.session);
        return batch;
      });
    },
    confirmPersisted(key) {
      return transaction(() => {
        const current = state();
        if (!current.pending) return;
        const pending = JSON.parse(current.pending);
        if (pending.key !== key) throw new Error('pending batch changed');
        pathfinder.delivered(pending.through);
        if (pending.wakeUntil !== undefined) {
          const next = terminalBatch(pending.through, pending.wakeUntil);
          db.prepare('UPDATE board_sessions SET pending=? WHERE session=?').run(next ? JSON.stringify(next) : null, config.session);
        } else db.prepare('UPDATE board_sessions SET cursor=?, pending=NULL WHERE session=?').run(pending.through, config.session);
      });
    },
  };
}
