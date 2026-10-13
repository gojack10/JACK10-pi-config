import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ensureController, tick, tmux, settingsFor } from '../../bf2-swarm/controller.mjs';
import { openFloor, isOss, ossStatus, claimOss, releaseOss, validateSettings, missingFloorLaunchSettings } from './runtime.mjs';

export function validateFloorLaunch(settings) {
  validateSettings(Object.fromEntries(['name','cwd','roots','instructions','voteCondition','slots','bootstrap','warningText','wrapupText','pathfinder'].map(k => [k, settings[k]])));
  const missing = missingFloorLaunchSettings(settings);
  if (missing.length) throw new Error(`floor start requires launch settings: ${missing.join(', ')}`);
  realpathSync(settings.agentDir);
  const pi = settingsFor(settings.agentDir, settings.cwd);
  if (pi.steeringMode !== 'all' || pi.followUpMode !== 'all') throw new Error('NEW floor sessions require native steeringMode=all and followUpMode=all');
  if ((pi.extensions ?? []).some(e => String(e).includes('rlm-friendly-stop') && !String(e).startsWith('-'))) throw new Error('global friendly-stop must not load in floor workers');
}
export function ensureFloorController(floor, execute = tmux, env = process.env) {
  const state = floor.board.lifecycle.status();
  if (state.status === 'running' || state.reconvene) validateFloorLaunch(state.config);
  return ensureController(floor.board, floor.config, execute, env);
}
export function tickFloor(floor, execute = tmux, env = process.env) {
  // Independent-job observation cannot hold worker cleanup/replacement hostage.
  try { floor.board.jobs.observe(); }
  catch (error) { console.error(`Factory job observation unavailable: ${error.message}; receipts/effects remain uncertain`); }
  // Reconcile only proven cleanup, including a crash between cleanup and lease release.
  const lease = ossStatus({ root: floor.root });
  if (lease.floor === floor.id) {
    const occupant = floor.board.lifecycle.status().workers.find(w => w.session === lease.session);
    if (occupant?.cleaned) releaseOss(floor.root, floor.id, lease.session);
    else if (occupant && lease.selected !== floor.id) floor.board.lifecycle.requestRetirement(lease.session, 'OSS floor selection changed');
    // Missing registration cannot prove a child exited; hold the lease for inspection.
  }
  return tick(floor.board, floor.config, execute, env, {
    validate: validateFloorLaunch,
    cleaned: w => { if (isOss(w.launch_config)) releaseOss(floor.root, floor.id, w.session); },
    allocate: (slot, session, launch) => {
      if (!isOss(slot)) return launch();
      const result = claimOss(floor.root, floor.id, session, launch);
      const worker = floor.board.lifecycle.status().workers.find(w => w.session === session);
      if (worker?.cleaned) releaseOss(floor.root, floor.id, session);
      return result;
    },
  });
}
export async function runFloor(id, { root, execute = tmux, env = process.env } = {}) {
  const floor = openFloor(id, { root });
  try {
    floor.board.lifecycle.claimController(process.pid);
    await new Promise(resolve => {
      let timer;
      const stop = () => { clearInterval(timer); floor.board.lifecycle.releaseController(process.pid); process.off('SIGTERM', stop); process.off('SIGINT', stop); resolve(); };
      const inspect = () => {
        try { tickFloor(floor, execute, env); }
        catch (error) { console.error(`Factory floor ${id}: ${error.message}; retrying after ordinary delay`); }
      };
      process.on('SIGTERM', stop); process.on('SIGINT', stop);
      // Stopped controllers stay available for ordinary UI/CLI wake, not agent capacity.
      timer = setInterval(inspect, 2000); inspect();
    });
  } finally { floor.close(); }
}
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runFloor(process.env.FACTORY_FLOOR, { root: process.env.FACTORY_ROOT }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
