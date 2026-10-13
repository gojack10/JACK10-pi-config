// Pathfinder uses the existing session substrate, outside configured peer membership.
export const PATHFINDER_SLOT = '@PATHFINDER';
export const ABSENCE_MS = 30 * 60 * 1000;
export const pathfinderAddress = worker => worker.slot === PATHFINDER_SLOT ? 'PATHFINDER' : worker.sender;
export const isPathfinderRequest = text => /(^|[^A-Za-z0-9_@/\\.\-])@PATHFINDER(?![A-Za-z0-9_@/\\.\-])/.test(
  text.replace(/```[\s\S]*?(?:```|$)|`[^`\n]*`/g, ''));

export function pathfinderStore(db, config) {
  const enabled = () => !!config.floor;
  const state = () => enabled() && db.prepare('SELECT * FROM floor_pathfinder').get();
  return {
    state,
    reset(running) {
      if (!enabled()) return;
      const configured = JSON.parse(db.prepare('SELECT settings FROM floor_settings').get().settings).pathfinder;
      const present = db.prepare('SELECT session FROM swarm_workers WHERE slot=? AND cleaned=0').get(PATHFINDER_SLOT);
      db.prepare('UPDATE floor_pathfinder SET absent_since=?').run(running && configured && !present ? Date.now() : null);
    },
    present() { if (enabled()) db.prepare('UPDATE floor_pathfinder SET absent_since=NULL').run(); },
    delivered(through) {
      if (enabled() && db.prepare('SELECT slot FROM swarm_workers WHERE session=?').get(config.session)?.slot === PATHFINDER_SLOT)
        db.prepare('UPDATE floor_pathfinder SET delivered=MAX(delivered,?)').run(through);
    },
    requests() {
      if (!enabled()) return [];
      return db.prepare(`SELECT number,text FROM board_posts WHERE number > ? AND role IN ('owner','peer')
        AND text LIKE '%@PATHFINDER%' AND session NOT IN (SELECT session FROM swarm_workers WHERE slot=?) ORDER BY number`)
        .all(state().delivered, PATHFINDER_SLOT).filter(p => isPathfinderRequest(p.text)).map(p => p.number);
    },
    due(run) {
      if (!enabled() || run.status !== 'running' || !run.floor.pathfinder || run.workers.some(w => !w.cleaned && w.slot === PATHFINDER_SLOT)) return false;
      if (state().absent_since === null) this.reset(true);
      return this.requests().length > 0 || Date.now() - state().absent_since >= ABSENCE_MS;
    },
  };
}

export function pathfinderMission(settings) {
  const { bootstrap, provider, model, thinking, contextWarning, ...assignment } = settings.pathfinder;
  return `${bootstrap}\n\nFactory Pathfinder assignment:\n${JSON.stringify({
    identity: '@PATHFINDER', floor: settings.floorId, cwd: settings.cwd, roots: settings.roots,
    instructions: settings.instructions, ...assignment,
  }, null, 2)}\n`;
}
