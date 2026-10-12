// Cooperative run state, not authentication against agents rewriting local files.
import { randomBytes } from 'node:crypto';

export const missingFloorLaunchSettings = settings => ['instructions','voteCondition','bootstrap','warningText','wrapupText'].filter(key => !settings?.[key]);
const requireFloorLaunchSettings = settings => {
  const missing = missingFloorLaunchSettings(settings);
  if (missing.length) throw new Error(`floor start requires launch settings: ${missing.join(', ')}`);
};

export function lifecycleStore(db, transaction, config, insertPost) {
  const exists = () => !!db.prepare("SELECT name FROM sqlite_master WHERE name='swarm_run'").get();
  const floor = () => db.prepare("SELECT name FROM sqlite_master WHERE name='floor_settings'").get() ?
    JSON.parse(db.prepare('SELECT settings FROM floor_settings').get().settings) : null;
  const getVote = row => row && { ...row, electorate: JSON.parse(row.electorate) };
  const openVote = () => getVote(db.prepare("SELECT * FROM swarm_votes WHERE result='open'").get());
  const status = () => {
    if (!exists()) throw new Error('this board has no experimental lifecycle');
    const run = db.prepare('SELECT * FROM swarm_run').get();
    return { ...run, config: JSON.parse(run.config), floor: floor(), vote: openVote(), workers: db.prepare('SELECT * FROM swarm_workers ORDER BY rowid').all().map(w => ({ ...w, ...(w.launch_config ? { launch_config: JSON.parse(w.launch_config) } : {}) })) };
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
  const ownerBallot = () => {
    const settings = floor();
    if (!settings?.voteCondition || openVote()) return openVote();
    const run = status(), peers = run.workers.filter(w => !w.cleaned);
    if (run.status !== 'running' || peers.length !== settings.slots.length || peers.some(w => w.state !== 'active' || w.retire_requested) ||
      settings.slots.some(s => !peers.some(w => w.slot === s.id))) return;
    const number = system(`Owner ballot condition node: ${settings.voteCondition}`);
    db.prepare("INSERT INTO swarm_votes VALUES (?,?,?,?,?,'open')").run(number, 'controller', `round-${number}`, settings.voteCondition,
      JSON.stringify(peers.map(w => ({ session: w.session, sender: w.sender, answer: null }))));
    return openVote();
  };
  const cancelDeparture = session => {
    const vote = openVote();
    if (vote?.electorate.some(v => v.session === session)) closeVote(vote, 'cancelled', 'Electorate changed, work continues');
  };
  const queuedStart = () => {
    const run = status(), settings = floor();
    if (settings) requireFloorLaunchSettings(settings);
    if (run.status === 'running') return;
    db.prepare('UPDATE swarm_run SET reconvene=1').run();
    if (!run.workers.some(w => !w.cleaned)) advanceDrain();
  };
  const retirementInput = session => {
    if (!config.floor) return;
    db.prepare('INSERT INTO floor_retirement_input(session,cursor) VALUES (?, (SELECT COALESCE(MAX(number),0) FROM board_posts)) ON CONFLICT(session) DO UPDATE SET override_reason=NULL').run(session);
  };
  const stop = () => {
    const run = status();
    const vote = openVote();
    if (vote) closeVote(vote, 'cancelled', 'JACK stopped the factory');
    const next = run.workers.some(w => !w.cleaned) ? 'stopping' : 'stopped';
    db.prepare('UPDATE swarm_run SET status=?, request=NULL, reconvene=0').run(next);
    for (const peer of run.workers.filter(w => !w.cleaned)) retirementInput(peer.session);
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
            reconvene INTEGER NOT NULL DEFAULT 0, room_pid INTEGER, room_port INTEGER, room_token TEXT NOT NULL);
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
    addWorker(session, sender, pane, launch, allocation = {}) {
      return transaction(() => {
        if (status().status !== 'running') return false;
        const settings = floor();
        if (db.prepare('SELECT COUNT(*) AS n FROM swarm_workers WHERE cleaned=0').get().n >= (settings?.slots.length ?? 3)) return false;
        const slot = settings?.slots.find(s => s.id === allocation.slot);
        if (settings && (!slot || db.prepare('SELECT session FROM swarm_workers WHERE slot=? AND cleaned=0').get(allocation.slot) ||
          Object.keys(slot).some(k => slot[k] !== allocation.launchConfig?.[k]))) return false;
        const vote = openVote();
        if (vote) closeVote(vote, 'cancelled', 'Electorate changed, work continues');
        db.prepare('INSERT INTO board_sessions(session,sender) VALUES (?,?)').run(session, sender);
        if (settings) db.prepare("INSERT INTO swarm_workers(session,sender,pane,state,slot,launch_config) VALUES (?,?,?,'launching',?,?)").run(session, sender, pane, allocation.slot, JSON.stringify(allocation.launchConfig));
        else db.prepare("INSERT INTO swarm_workers(session,sender,pane,state) VALUES (?,?,?,'launching')").run(session, sender, pane);
        // Synchronous tmux setup, never agent work inside this transaction.
        if (launch) {
          try { launch(receipt => db.prepare('UPDATE swarm_workers SET pane=?, tmux_session=? WHERE session=?').run(receipt.pane, receipt.session, session)); }
          catch (error) {
            db.prepare("UPDATE swarm_workers SET state='launch-failed', cleaned=? WHERE session=?").run(error.ownedChild ? 0 : 1, session);
            system(settings ? `${sender} launch failed: ${String(error.message).slice(0, 1000)}. Session ID: ${session}; JSONL not registered (Pi startup not established). Replacement waits for actual cleanup.` :
              `${sender} launch failed: ${String(error.message).slice(0, 1000)}. Retrying after ordinary delay.`);
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
      return run.status === 'running' && run.workers.some(w => w.session === config.session && w.state === 'active' && !w.retire_requested);
    },
    pause(key, reason) {
      return transaction(() => {
        keyCheck(key);
        const run = status();
        if (run.floor) {
          worker();
          if (!this.acceptsInput()) throw new Error('ballots are unavailable during retirement');
          if (reason !== run.floor.voteCondition) throw new Error('only the owner may configure the floor ballot condition');
          const vote = ownerBallot();
          if (!vote) throw new Error('ballot requires all configured current active peers, no capacity gaps');
          return vote;
        }
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
        if (run.status !== 'running' || worker().state !== 'active' || (run.floor && !this.acceptsInput())) throw new Error('votes require a current working active worker');
        voter.answer = answer;
        db.prepare('UPDATE swarm_votes SET electorate=? WHERE number=?').run(JSON.stringify(vote.electorate), number);
        system(`${config.sender} voted ${answer} on pause request #${number}`);
        if (answer === 'no') closeVote(vote, 'rejected', 'One no, work continues');
        else if (vote.electorate.every(v => v.answer === 'yes')) {
          closeVote(vote, 'agreed', floor() ? 'Unanimous yes, waiting for JACK' : 'Three yes, waiting for JACK');
          db.prepare("UPDATE swarm_run SET status='waiting', request=?, reconvene=0").run(number);
          for (const peer of run.workers.filter(w => !w.cleaned)) retirementInput(peer.session);
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
          return { ...prior };
        }
        const run = status();
        let number = null;
        if (action === 'message') {
          number = insertPost(text, 'owner', 'JACK', 'owner');
          // Floor chat never starts/reconvenes work. Legacy BF2 retains its wake behavior.
          if (run.status !== 'running' && !floor()) queuedStart();
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
        const state = launchError ? (floor() && row.state !== 'launching' ? 'exited-with-error' : 'launch-failed') : row.handoff === null ? 'exited' : 'exited-with-handoff';
        db.prepare('UPDATE swarm_workers SET state=? WHERE session=?').run(state, session);
        if (floor()) {
          system(`${row.sender} ${launchError ? `${row.state === 'launching' ? 'launch failed' : 'failed'}: ${String(launchError).slice(0, 1000)}` : `exited (${state})`}. Session: ${row.session_file ?? 'JSONL not registered; Pi may not have started'}; session ID: ${row.session}. Replacement ${status().status === 'running' ? 'pending after actual cleanup' : 'disabled while floor is not running'}.`);
          return;
        }
        system(launchError ? `${row.sender} launch failed: ${launchError}. Retrying after ordinary delay.` :
          row.handoff === null ? `${row.sender} exited without a retirement message.` :
            `${row.sender} exited after handoff #${row.handoff}, without safe settlement evidence.`);
      });
    },
    recordUsage(percent) {
      if (!floor()) return;
      db.prepare('UPDATE swarm_workers SET context_percent=? WHERE session=?').run(typeof percent === 'number' && Number.isFinite(percent) ? percent : null, config.session);
    },
    recordError(error) {
      if (!floor()) return;
      transaction(() => {
        const row = status().workers.find(w => w.session === config.session), known = error ? String(error).slice(0, 1000) : null;
        if (!row || row.last_error === known) return;
        db.prepare('UPDATE swarm_workers SET last_error=? WHERE session=?').run(known, config.session);
        if (known) system(`${row.sender} reported an assistant error: ${known}. Session: ${row.session_file ?? 'JSONL not registered'}; session ID: ${row.session}. Recovery/exit not yet established.`);
      });
    },
    registerSessionFile(path) {
      if (typeof path !== 'string' || !path.startsWith('/') || /[\0\n\r]/.test(path)) throw new Error('session JSONL must be an absolute path');
      if (!floor()) return; // Legacy schema and prompts remain compatible.
      const row = status().workers.find(w => w.session === config.session && ['launching','active','retiring'].includes(w.state));
      if (!row) throw new Error('JSONL locator requires a registered worker');
      if (row.session_file && row.session_file !== path) throw new Error('worker JSONL locator is immutable');
      db.prepare('UPDATE swarm_workers SET session_file=? WHERE session=?').run(path, config.session);
    },
    contextStop(percent) {
      if (!config.floor) return false; // Unadopted BF2 retains its advisory contract.
      return transaction(() => {
        const run = status(), row = run.workers.find(w => w.session === config.session);
        const overridden = db.prepare('SELECT override_reason FROM floor_retirement_input WHERE session=?').get(config.session)?.override_reason;
        if (run.status !== 'running' || !row || row.state !== 'active' || row.retire_requested || overridden || typeof percent !== 'number' || !Number.isFinite(percent) || percent < row.launch_config.contextWarning) return false;
        cancelDeparture(config.session);
        db.prepare("UPDATE swarm_workers SET retire_requested='context threshold' WHERE session=?").run(config.session);
        retirementInput(config.session);
        return true;
      });
    },
    canReceiveOwner() {
      return !!config.floor && status().workers.some(w => w.session === config.session && w.state === 'active' && !w.cleaned);
    },
    overrideContextStop(session, reason) {
      controller();
      if (!config.floor || typeof reason !== 'string' || !reason.trim() || reason.length > 1000) throw new Error('context override needs a floor and explicit bounded human reason');
      return transaction(() => {
        const row = status().workers.find(w => w.session === session);
        if (status().status !== 'running' || row?.state !== 'active' || row.retire_requested !== 'context threshold') throw new Error('override requires the current context-stopped active worker, not a stopped floor or final done');
        db.prepare('UPDATE floor_retirement_input SET override_reason=? WHERE session=?').run(reason, session);
        db.prepare('UPDATE swarm_workers SET retire_requested=NULL WHERE session=?').run(session);
        system(`Human context override for session ${session}: ${reason}`);
        return true;
      });
    },
    requestRetirement(session, reason) {
      controller();
      return transaction(() => {
        if (!floor()) throw new Error('slot retirement requires a floor');
        if (typeof reason !== 'string' || !reason.trim()) throw new Error('retirement requires a reason');
        cancelDeparture(session);
        retirementInput(session);
        return db.prepare("UPDATE swarm_workers SET retire_requested=CASE WHEN retire_requested='context threshold' THEN ? ELSE COALESCE(retire_requested,?) END WHERE session=? AND cleaned=0").run(reason, reason, session).changes > 0;
      });
    },
    configureFloor(settings, launchSettings) {
      controller();
      return transaction(() => {
        if (!floor()) throw new Error('not a floor');
        const run = status();
        // Live/draining workers still need these inputs for replacement and safe
        // retirement. Refuse atomically, before votes, settings or posts change.
        if (run.status !== 'stopped' || run.reconvene || run.workers.some(w => !w.cleaned)) requireFloorLaunchSettings(settings);
        const old = floor(), vote = openVote();
        if (vote && (old.voteCondition !== settings.voteCondition || JSON.stringify(old.slots.map(s => s.id).sort()) !== JSON.stringify(settings.slots.map(s => s.id).sort()))) closeVote(vote, 'cancelled', 'Owner condition or configured membership changed; old votes invalidated');
        db.prepare('UPDATE floor_settings SET settings=?').run(JSON.stringify(settings));
        db.prepare('UPDATE swarm_run SET config=?').run(JSON.stringify(launchSettings));
        for (const w of status().workers.filter(w => !w.cleaned && !settings.slots.some(s => s.id === w.slot))) {
          db.prepare('UPDATE swarm_workers SET retire_requested=? WHERE session=?').run('slot removed', w.session);
          retirementInput(w.session);
        }
        if (old.voteCondition !== settings.voteCondition) system(`Owner changed ballot condition node: ${settings.voteCondition}. Old votes invalidated.`);
        return floor();
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
