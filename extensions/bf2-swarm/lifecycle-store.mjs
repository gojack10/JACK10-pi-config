// Cooperative run state, not authentication against agents rewriting local files.
export function lifecycleStore(db, transaction, config, insertPost) {
  const exists = () => !!db.prepare("SELECT name FROM sqlite_master WHERE name='swarm_run'").get();
  const status = () => {
    if (!exists()) throw new Error('this board has no experimental lifecycle');
    const run = db.prepare('SELECT * FROM swarm_run').get();
    return { ...run, config: JSON.parse(run.config), workers: db.prepare('SELECT * FROM swarm_workers ORDER BY rowid').all() };
  };
  const worker = () => {
    status();
    const row = db.prepare('SELECT * FROM swarm_workers WHERE session=?').get(config.session);
    if (!row || !['active', 'retiring'].includes(row.state)) throw new Error('operation requires a registered active worker session');
    return row;
  };
  const system = text => insertPost(text, 'controller', '[system]');
  return {
    status,
    initialize(settings) {
      if (exists()) throw new Error('run already initialized; use status/resume');
      transaction(() => {
        db.exec(`CREATE TABLE swarm_run (id INTEGER PRIMARY KEY CHECK(id=1), status TEXT NOT NULL, request INTEGER, config TEXT NOT NULL, controller INTEGER);
          CREATE TABLE swarm_workers (session TEXT PRIMARY KEY, sender TEXT NOT NULL UNIQUE, pane TEXT NOT NULL UNIQUE,
            state TEXT NOT NULL, handoff INTEGER, vote INTEGER);`);
        db.prepare("INSERT INTO swarm_run VALUES (1, 'running', NULL, ?, NULL)").run(JSON.stringify(settings));
      });
    },
    addWorker(session, sender, pane, launch) {
      return transaction(() => {
        if (status().status !== 'running') return false;
        if (db.prepare("SELECT COUNT(*) AS n FROM swarm_workers WHERE state IN ('launching','active','retiring')").get().n >= 3) return false;
        db.prepare('INSERT INTO board_sessions(session,sender) VALUES (?,?)').run(session, sender);
        db.prepare("INSERT INTO swarm_workers(session,sender,pane,state) VALUES (?,?,?,'launching')").run(session, sender, pane);
        // Synchronous tmux setup returns before Pi boot: serialize it with stop/vote.
        // No model, admission await, or agent turn runs inside this transaction.
        if (launch) {
          try { launch(); }
          catch (error) {
            db.prepare("UPDATE swarm_workers SET state='launch-failed' WHERE session=?").run(session);
            system(`${sender} launch failed: ${String(error.message).slice(0, 1000)}. Retrying after ordinary delay.`);
          }
        }
        return true;
      });
    },
    ready() {
      transaction(() => {
        const changed = db.prepare("UPDATE swarm_workers SET state='active' WHERE session=? AND state='launching'").run(config.session).changes;
        if (changed) system(`${config.sender} joined.`);
        else if (worker().state !== 'active') throw new Error('worker is not launchable');
      });
    },
    done(text) {
      return transaction(() => {
        const row = worker();
        if (row.handoff !== null) throw new Error('retirement already requested');
        const number = insertPost(text);
        db.prepare("UPDATE swarm_workers SET handoff=?, state='retiring', vote=NULL WHERE session=?").run(number, config.session);
        return number;
      });
    },
    settled() {
      // ONLY called by the worker's agent_settled notification, never by polling.
      return db.prepare("UPDATE swarm_workers SET state='retired', vote=NULL WHERE session=? AND state='retiring' AND handoff IS NOT NULL").run(config.session).changes > 0;
    },
    acceptsInput() {
      if (!exists()) return true; // Original board-only runs retain their behavior.
      const run = status();
      return run.status === 'running' && run.workers.some(w => w.session === config.session && w.state === 'active');
    },
    vote(request, reason) {
      return transaction(() => {
        const run = status();
        if (run.status !== 'running') throw new Error('votes require a running run');
        if (worker().state !== 'active') throw new Error('retiring workers cannot vote');
        if (!Number.isSafeInteger(request) || request < 1 || !db.prepare('SELECT number FROM board_posts WHERE number=?').get(request)) throw new Error('vote requires an existing request message number');
        // insertPost validates the nonempty reason before any state change.
        if (typeof reason !== 'string' || !reason.trim()) throw new Error('vote requires a reason or node pointer');
        insertPost(`Vote #${request}: ${reason}`);
        db.prepare('UPDATE swarm_workers SET vote=? WHERE session=?').run(request, config.session);
        const peers = db.prepare("SELECT vote FROM swarm_workers WHERE state='active'").all();
        const occupied = db.prepare("SELECT COUNT(*) AS n FROM swarm_workers WHERE state IN ('active','launching','retiring')").get().n;
        if (occupied === 3 && peers.length === 3 && peers.every(p => p.vote === request)) {
          db.prepare("UPDATE swarm_run SET status='waiting', request=?").run(request);
          system(`Run waiting on request #${request}. Inspect experiment node ${run.config.instructions}. Waiting is not BF2 success.`);
        }
        return status().status;
      });
    },
    withdraw() {
      transaction(() => {
        if (status().status !== 'running' || worker().state !== 'active') throw new Error('withdrawal requires an active worker in a running run');
        db.prepare('UPDATE swarm_workers SET vote=NULL WHERE session=?').run(config.session);
        insertPost('Withdrew waiting vote.');
      });
    },
    lost(session, launchError) {
      transaction(() => {
        const row = db.prepare('SELECT * FROM swarm_workers WHERE session=?').get(session);
        if (!row || !['launching','active','retiring','retired'].includes(row.state)) return;
        if (row.state === 'retired') return;
        const state = launchError ? 'launch-failed' : row.handoff === null ? 'exited' : 'exited-with-handoff';
        db.prepare('UPDATE swarm_workers SET state=?, vote=NULL WHERE session=?').run(state, session);
        system(launchError ? `${row.sender} launch failed: ${launchError}. Retrying after ordinary delay.` :
          row.handoff === null ? `${row.sender} exited without a retirement message.` :
            `${row.sender} exited after handoff #${row.handoff}, without safe settlement evidence.`);
      });
    },
    claimController(pid) {
      transaction(() => {
        const previous = status().controller;
        if (previous !== null) {
          try { process.kill(previous, 0); throw new Error('controller PID still exists; refusing duplicate loop'); }
          catch (error) { if (error.code !== 'ESRCH') throw error; }
        }
        db.prepare('UPDATE swarm_run SET controller=?').run(pid);
      });
    },
    releaseController(pid) { db.prepare('UPDATE swarm_run SET controller=NULL WHERE controller=?').run(pid); },
    stop() {
      transaction(() => {
        const run = status();
        if (run.status === 'stopped') return;
        db.prepare("UPDATE swarm_run SET status='stopped', request=NULL").run();
        db.prepare('UPDATE swarm_workers SET vote=NULL').run();
        system('Human stopped this run. Finish safely and retire; no replacements.');
      });
    },
    resume() {
      transaction(() => {
        const run = status();
        if (run.workers.some(w => ['launching','active','retiring'].includes(w.state))) throw new Error('resume requires old workers to finish/exit first; inspect status');
        db.prepare("UPDATE swarm_run SET status='running', request=NULL").run();
        db.prepare('UPDATE swarm_workers SET vote=NULL').run();
        system('Human resumed this run with fresh capacity and cleared votes.');
      });
    },
  };
}
