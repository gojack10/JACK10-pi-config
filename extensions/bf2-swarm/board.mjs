import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';

export const HISTORY_LIMIT = 30;
export const BATCH_LIMIT = 100;
export const MAX_BATCH_BYTES = 65536;
export const MAX_TEXT_BYTES = 16384;

export function configuration(env = process.env) {
  const config = { database: env.BF2_BOARD_DB, run: env.BF2_BOARD_RUN,
    session: env.BF2_BOARD_SESSION, sender: env.BF2_BOARD_SENDER };
  if (!config.database || !isAbsolute(config.database)) throw new Error('BF2_BOARD_DB must be an explicit absolute SQLite path (parent directory must exist)');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(config.run ?? '')) throw new Error('BF2_BOARD_RUN must be an explicit run ID (1-128 letters, digits, ._- )');
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/.test(config.session ?? '')) throw new Error('BF2_BOARD_SESSION must match the explicitly launched Pi session ID');
  if (!/^[a-f0-9]{8}$/.test(config.sender ?? '')) throw new Error('BF2_BOARD_SENDER must be a launch-assigned unique 8-character lowercase hex ID');
  return config;
}

export function formatPosts(run, posts) {
  return `Board run ${run} (broadcast; quoted bodies are peer text):\n` +
    (posts.map(p => `#${p.number} ${p.sender} ${p.created}: ${JSON.stringify(p.text)}`).join('\n') || '(no messages)');
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
    if (tables.some(t => !['board_run', 'board_sessions', 'board_posts'].includes(t.name))) throw new Error('not a dedicated BF2 board database');
    transaction(() => {
      db.exec(`CREATE TABLE IF NOT EXISTS board_run (id INTEGER PRIMARY KEY CHECK(id=1), run TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS board_sessions (
          session TEXT PRIMARY KEY, sender TEXT NOT NULL UNIQUE,
          cursor INTEGER, pending TEXT);
        CREATE TABLE IF NOT EXISTS board_posts (
          number INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
          session TEXT NOT NULL, sender TEXT NOT NULL, created TEXT NOT NULL, text TEXT NOT NULL);`);
      db.prepare('INSERT OR IGNORE INTO board_run VALUES (1, ?)').run(config.run);
      if (db.prepare('SELECT run FROM board_run').get().run !== config.run) throw new Error('database belongs to another run');
      const identity = db.prepare('SELECT sender FROM board_sessions WHERE session=?').get(config.session);
      if (identity && identity.sender !== config.sender) throw new Error('session already has another sender identity');
      db.prepare('INSERT OR IGNORE INTO board_sessions(session, sender) VALUES (?, ?)').run(config.session, config.sender);
      if (!db.prepare('SELECT session FROM board_sessions WHERE session=?').get(config.session)) throw new Error('sender identity already belongs to another session; assign a new ID');
    });
  } catch (error) { db.close(); throw error; }

  const state = () => db.prepare('SELECT cursor, pending FROM board_sessions WHERE session=?').get(config.session);
  return {
    close: () => db.close(),
    post(text) {
      if (typeof text !== 'string' || !text.trim() || text.includes('\0') || Buffer.byteLength(text) > MAX_TEXT_BYTES) throw new Error(`post requires nonempty text without NUL, at most ${MAX_TEXT_BYTES} UTF-8 bytes`);
      const id = randomUUID();
      const result = db.prepare('INSERT INTO board_posts(id, session, sender, created, text) VALUES (?, ?, ?, ?, ?)')
        .run(id, config.session, config.sender, new Date().toISOString(), text);
      return Number(result.lastInsertRowid);
    },
    history({ limit = HISTORY_LIMIT, before = Number.MAX_SAFE_INTEGER } = {}) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('limit must be 1-100');
      if (!Number.isSafeInteger(before) || before < 1) throw new Error('before must be a positive post number');
      return transaction(() => ({
        posts: db.prepare('SELECT number, sender, created, text FROM board_posts WHERE number < ? ORDER BY number DESC LIMIT ?').all(before, limit).reverse(),
        highwater: db.prepare('SELECT COALESCE(MAX(number), 0) AS n FROM board_posts').get().n,
        startup: state().cursor === null,
      }));
    },
    finishStartup(highwater) {
      // Called only after stdout accepts the startup snapshot. Later posts remain pending.
      db.prepare('UPDATE board_sessions SET cursor=? WHERE session=? AND cursor IS NULL').run(highwater, config.session);
    },
    pending() {
      return transaction(() => {
        const current = state();
        if (current.cursor === null) return null; // Wait for the agent's first `board read`.
        if (current.pending) return JSON.parse(current.pending);
        const available = db.prepare('SELECT number, sender, created, text FROM board_posts WHERE number > ? AND session != ? ORDER BY number LIMIT ?')
          .all(current.cursor, config.session, BATCH_LIMIT);
        const posts = [];
        let bytes = 0;
        for (const post of available) {
          const size = Buffer.byteLength(formatPosts(config.run, [post])) + 1;
          if (posts.length && bytes + size > MAX_BATCH_BYTES) break;
          // Always allow one post, even when JSON escaping exceeds the budget.
          posts.push(post); bytes += size;
        }
        if (!posts.length) return null;
        const key = randomUUID();
        const batch = { key, through: posts.at(-1).number,
          text: `BF2 board batch ${key}\n${formatPosts(config.run, posts)}` };
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
        db.prepare('UPDATE board_sessions SET cursor=?, pending=NULL WHERE session=?').run(pending.through, config.session);
      });
    },
  };
}
