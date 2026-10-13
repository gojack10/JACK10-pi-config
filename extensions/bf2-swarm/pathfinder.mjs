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

export const PATHFINDER_ENTRY = '1aec93e4-a313-4948-828c-610c535e18a5';
export const PATHFINDER_AGENT = '1f887f9a-2e1e-4c10-9969-db3f81237ce0';
export function pathfinderMission(settings) {
  return `You are @PATHFINDER, the floor's Pathfinder. Complete the common launch instructions' required reads below, then read Factory Pathfinder Entry ${PATHFINDER_ENTRY} and Pathfinder Agent ${PATHFINDER_AGENT} before choosing work. Pathfinder replaces the common entry's peer identity and self-selected worker assignment; its project reads, board and lifecycle mechanics still apply.
Use the floor's current goal resolved through that same project entry. Directed @PATHFINDER board requests supply review questions; the continuation locator preserves unfinished review state.
Use the floor checkout and project instructions to find relevant code. Preserve existing project permissions and write boundaries; discovering another path grants no write authority. Model settings and project instructions govern resources. Return findings through the factory board and existing work owners. Stop dependent work and report missing required reads or authority. Follow the common Stop, settlement and recovery instructions.

Common floor launch instructions:
${settings.bootstrap}

Factory Pathfinder assignment:
${JSON.stringify({
    identity: '@PATHFINDER', floor: settings.floorId, cwd: settings.cwd, roots: settings.roots,
    instructions: settings.instructions, entry: PATHFINDER_ENTRY, agent: PATHFINDER_AGENT,
    continuation: settings.pathfinder.continuation ?? null,
  }, null, 2)}\n`;
}
