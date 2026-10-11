// Cooperative run state, not authentication against agents rewriting local files.
import { randomBytes } from 'node:crypto';

export function lifecycleStore(db, transaction, config, insertPost) {
  const exists = () => !!db.prepare("SELECT name FROM sqlite_master WHERE name='swarm_run'").get();
  const getVote = row => row && { ...row, electorate: JSON.parse(row.electorate) };
  const openVote = () => getVote(db.prepare("SELECT * FROM swarm_votes WHERE result='open'").get());
  const status = () => {
    if (!exists()) throw new Error('this board has no experimental lifecycle');
    const run = db.prepare('SELECT * FROM swarm_run').get();
    return { ...run, config: JSON.parse(run.config), vote: openVote(), workers: db.prepare('SELECT * FROM swarm_workers ORDER BY rowid').all() };
  };
  const worker = () => {
    status();
    const row = db.prepare('SELECT * FROM swarm_workers WHERE session=?').get(config.session);
    if (!row || !['active', 'retiring'].includes(row.state)) throw new Error('operation requires a registered active worker session');
    return row;
  };
  const controller = () => { if (config.session !== 'controller') throw new Error('owner operation requires controller'); };
  const system = text => insertPost(text, 'controller', '[system]', 'system');
  const closeVote = (vote, result, text) => {
    db.prepare('UPDATE swarm_votes SET result=? WHERE number=? AND result=\'open\'').run(result, vote.number);
    system(`Pause request #${vote.number}: ${JSON.stringify(vote.reason)}. ${text}`);
  };
  const cancelDeparture = session => {
    const vote = openVote();
    if (vote?.electorate.some(v => v.session === session)) closeVote(vote, 'cancelled', 'Electorate changed, work continues');
  };
  const queuedStart = () => {
    const run = status();
    if (run.status === 'running') return;
    db.prepare('UPDATE swarm_run SET reconvene=1').run();
    if (!run.workers.some(w => !w.cleaned)) advanceDrain();
  };
  const stop = () => {
    const run = status();
    const vote = openVote();
    if (vote) closeVote(vote, 'cancelled', 'JACK stopped the factory');
    const next = run.workers.some(w => !w.cleaned) ? 'stopping' : 'stopped';
    db.prepare('UPDATE swarm_run SET status=?, request=NULL, reconvene=0').run(next);
    if (run.status !== next || run.reconvene) system('JACK requested a stop, agents finish safely with no replacements');
  };
  const advanceDrain = () => {
    const run = status();
    if (run.status === 'running' || run.workers.some(w => !w.cleaned)) return;
    if (run.reconvene) {
      db.prepare("UPDATE swarm_run SET status='running', request=NULL, reconvene=0").run();
      system('JACK reconvened the factory with fresh capacity');
    } else if (run.status === 'stopping') {
      db.prepare("UPDATE swarm_run SET status='stopped'").run();
      system('Factory stopped');
    }
  };
  const keyCheck = key => {
    if (typeof key !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(key)) throw new Error('request key must be 1-128 letters, digits, ._-');
  };
  return {
    status,
    initialize(settings) {
      if (exists()) throw new Error('run already initialized; use status/resume');
      if (!db.prepare('PRAGMA table_info(board_posts)').all().some(c => c.name === 'role')) throw new Error('legacy board format; start a fresh run');
      transaction(() => {
        db.exec(`CREATE TABLE swarm_run (id INTEGER PRIMARY KEY CHECK(id=1), status TEXT NOT NULL, request INTEGER, config TEXT NOT NULL, controller INTEGER, tmux_parent TEXT,
            reconvene INTEGER NOT NULL DEFAULT 0, wake_from INTEGER, room_pid INTEGER, room_port INTEGER, room_token TEXT NOT NULL);
          CREATE TABLE swarm_workers (session TEXT PRIMARY KEY, sender TEXT NOT NULL UNIQUE, pane TEXT NOT NULL,
            state TEXT NOT NULL, handoff INTEGER, cleaned INTEGER NOT NULL DEFAULT 0, tmux_session TEXT);
          CREATE UNIQUE INDEX swarm_live_panes ON swarm_workers(pane) WHERE cleaned=0;
          CREATE TABLE swarm_votes (number INTEGER PRIMARY KEY, proposer TEXT NOT NULL, key TEXT NOT NULL, reason TEXT NOT NULL,
            electorate TEXT NOT NULL, result TEXT NOT NULL, UNIQUE(proposer,key));
          CREATE UNIQUE INDEX swarm_one_vote ON swarm_votes(result) WHERE result='open';
          CREATE TABLE swarm_commands (key TEXT PRIMARY KEY, action TEXT NOT NULL, text TEXT, number INTEGER);`);
        db.prepare("INSERT INTO swarm_run(id,status,config,room_token) VALUES (1,'running',?,?)").run(JSON.stringify(settings), randomBytes(32).toString('hex'));
      });
    },
    addWorker(session, sender, pane, launch) {
      return transaction(() => {
        if (status().status !== 'running') return false;
        if (db.prepare('SELECT COUNT(*) AS n FROM swarm_workers WHERE cleaned=0').get().n >= 3) return false;
        db.prepare('INSERT INTO board_sessions(session,sender) VALUES (?,?)').run(session, sender);
        db.prepare("INSERT INTO swarm_workers(session,sender,pane,state) VALUES (?,?,?,'launching')").run(session, sender, pane);
        // Synchronous tmux setup, never agent work inside this transaction.
        if (launch) {
          try { launch(receipt => db.prepare('UPDATE swarm_workers SET pane=?, tmux_session=? WHERE session=?').run(receipt.pane, receipt.session, session)); }
          catch (error) {
            db.prepare("UPDATE swarm_workers SET state='launch-failed', cleaned=? WHERE session=?").run(error.ownedChild ? 0 : 1, session);
            system(`${sender} launch failed: ${String(error.message).slice(0, 1000)}. Retrying after ordinary delay.`);
          }
        }
        return true;
      });
    },
    ready() {
      transaction(() => {
        const changed = db.prepare("UPDATE swarm_workers SET state='active' WHERE session=? AND state='launching'").run(config.session).changes;
        if (changed) system(`${config.sender} joined`);
        else if (worker().state !== 'active') throw new Error('worker is not launchable');
      });
    },
    done(text) {
      return transaction(() => {
        if (worker().handoff !== null) throw new Error('retirement already requested');
        const number = insertPost(text);
        cancelDeparture(config.session);
        db.prepare("UPDATE swarm_workers SET handoff=?, state='retiring' WHERE session=?").run(number, config.session);
        return number;
      });
    },
    settled() {
      // ONLY the native clean agent_settled notification, never a polling inference.
      return db.prepare("UPDATE swarm_workers SET state='retired' WHERE session=? AND state='retiring' AND handoff IS NOT NULL").run(config.session).changes > 0;
    },
    cleaned(session) {
      transaction(() => {
        const changed = db.prepare('UPDATE swarm_workers SET cleaned=1 WHERE session=? AND cleaned=0').run(session).changes;
        if (changed) {
          cancelDeparture(session);
          const row = db.prepare('SELECT sender,state FROM swarm_workers WHERE session=?').get(session);
          system(`${row.sender} left${row.state === 'retired' ? ' after saving progress' : ''}`);
        }
      });
    },
    advanceDrain() { return transaction(() => { advanceDrain(); return status(); }); },
    acceptsInput() {
      if (!exists()) return true;
      const run = status();
      return run.status === 'running' && run.workers.some(w => w.session === config.session && w.state === 'active');
    },
    pause(key, reason) {
      return transaction(() => {
        keyCheck(key);
        const run = status();
        const prior = getVote(db.prepare('SELECT * FROM swarm_votes WHERE proposer=? AND key=?').get(config.session, key));
        if (prior) {
          if (prior.reason !== reason) throw new Error('request key already has an immutable reason');
          return prior;
        }
        if (run.status !== 'running' || worker().state !== 'active') throw new Error('pause requires an active worker in a running run');
        if (typeof reason !== 'string' || !reason.trim()) throw new Error('pause requires a nonempty reason');
        const current = openVote();
        if (current) throw new Error(`pause request #${current.number} is already open`);
        const peers = run.workers.filter(w => !w.cleaned);
        if (peers.length !== 3 || peers.some(w => w.state !== 'active')) throw new Error('pause requires three current active peers, no capacity gaps');
        const number = system(`${config.sender} requested pause for factory owner: ${reason}`);
        const electorate = peers.map(w => ({ session: w.session, sender: w.sender, answer: w.session === config.session ? 'yes' : null }));
        db.prepare("INSERT INTO swarm_votes VALUES (?,?,?,?,?,'open')").run(number, config.session, key, reason, JSON.stringify(electorate));
        return openVote();
      });
    },
    vote(number, answer) {
      return transaction(() => {
        if (!Number.isSafeInteger(number) || number < 1 || !['yes','no'].includes(answer)) throw new Error('vote requires pause request number and yes/no');
        const vote = getVote(db.prepare('SELECT * FROM swarm_votes WHERE number=?').get(number));
        if (!vote) throw new Error('unknown pause request');
        const voter = vote.electorate.find(v => v.session === config.session);
        if (!voter) throw new Error('not a member of this fixed electorate');
        if (voter.answer) {
          if (voter.answer !== answer) throw new Error('ballot is immutable');
          return vote; // Stable retry even after final closure, no new posts.
        }
        if (vote.result !== 'open') throw new Error(`pause request is ${vote.result}`);
        const run = status();
        if (run.status !== 'running' || worker().state !== 'active') throw new Error('votes require a current active worker');
        voter.answer = answer;
        db.prepare('UPDATE swarm_votes SET electorate=? WHERE number=?').run(JSON.stringify(vote.electorate), number);
        system(`${config.sender} voted ${answer} on pause request #${number}`);
        if (answer === 'no') closeVote(vote, 'rejected', 'One no, work continues');
        else if (vote.electorate.every(v => v.answer === 'yes')) {
          closeVote(vote, 'agreed', 'Three yes, waiting for JACK');
          db.prepare("UPDATE swarm_run SET status='waiting', request=?, reconvene=0, wake_from=NULL").run(number);
        }
        return getVote(db.prepare('SELECT * FROM swarm_votes WHERE number=?').get(number));
      });
    },
    ownerCommand(key, action, text = null) {
      controller(); keyCheck(key);
      if (!['message','start','stop'].includes(action) || (action !== 'message' && text !== null)) throw new Error('invalid owner command');
      return transaction(() => {
        const prior = db.prepare('SELECT * FROM swarm_commands WHERE key=?').get(key);
        if (prior) {
          if (prior.action !== action || prior.text !== text) throw new Error('command key already used with different input');
          return prior;
        }
        const run = status();
        let number = null;
        if (action === 'message') {
          number = insertPost(text, 'owner', 'JACK', 'owner');
          if (run.status !== 'running') {
            db.prepare('UPDATE swarm_run SET wake_from=COALESCE(wake_from,?)').run(number);
            queuedStart();
          }
        } else if (action === 'start') queuedStart();
        else stop();
        db.prepare('INSERT INTO swarm_commands VALUES (?,?,?,?)').run(key, action, text, number);
        return { key, action, text, number };
      });
    },
    lost(session, launchError) {
      transaction(() => {
        const row = db.prepare('SELECT * FROM swarm_workers WHERE session=?').get(session);
        if (!row || !['launching','active','retiring'].includes(row.state)) return;
        cancelDeparture(session);
        const state = launchError ? 'launch-failed' : row.handoff === null ? 'exited' : 'exited-with-handoff';
        db.prepare('UPDATE swarm_workers SET state=? WHERE session=?').run(state, session);
        system(launchError ? `${row.sender} launch failed: ${launchError}. Retrying after ordinary delay.` :
          row.handoff === null ? `${row.sender} exited without a retirement message.` :
            `${row.sender} exited after handoff #${row.handoff}, without safe settlement evidence.`);
      });
    },
    controllerSetup(launch) {
      return transaction(() => {
        const parent = launch(status().tmux_parent);
        db.prepare('UPDATE swarm_run SET tmux_parent=?').run(parent);
        return parent;
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
    roomSetup(launch) {
      controller();
      return transaction(() => {
        const run = status();
        if (run.room_pid !== null) {
          try { process.kill(run.room_pid, 0); return { pid: run.room_pid, port: run.room_port, token: run.room_token }; }
          catch (error) { if (error.code !== 'ESRCH') throw error; }
        }
        const pid = launch();
        db.prepare('UPDATE swarm_run SET room_pid=?, room_port=NULL').run(pid);
        return { pid, port: null, token: run.room_token };
      });
    },
    roomPublish(pid, port) { controller(); return db.prepare('UPDATE swarm_run SET room_port=? WHERE room_pid=?').run(port, pid).changes > 0; },
    roomRelease(pid) { db.prepare('UPDATE swarm_run SET room_pid=NULL, room_port=NULL WHERE room_pid=?').run(pid); },
    stop() { controller(); return transaction(stop); },
    resume() {
      controller();
      transaction(() => {
        if (status().workers.some(w => !w.cleaned)) throw new Error('resume requires old workers to finish/exit first; inspect status');
        queuedStart();
      });
    },
  };
}
