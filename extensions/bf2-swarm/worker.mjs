import { configuration, openBoard } from './board.mjs';

export const WARNING = 'Context is at least 80%. Preserve useful progress on the tree and consider a handoff/retirement at a sensible boundary. This is one warning, not a forced stop; tools remain available.';
export const warningType = 'bf2-swarm-warning';
export const wrapup = (run, state) => `BF2 swarm ${run}: ${state.status}. Finish safely, record ${state.status}/inspection state on experiment node ${state.config.instructions} using its instructions, then board done with a handoff. No replacements while ${state.status}; waiting is not BF2 success.`;

const expand = (text, values) => text.replace(/\{(percent|status|instructions|floor|reason)\}/g, (match, key) => String(values[key] ?? match));
export function workerWrapup(run, state, session) {
  const row = state.workers.find(w => w.session === session);
  return state.floor ? expand(row?.launch_config?.wrapupText ?? state.floor.wrapupText, { status: state.status, instructions: state.config.instructions,
    floor: state.config.floorId, reason: row?.retire_requested ?? state.status }) : wrapup(run, state);
}

export function handoffTool(worker, parameters) {
  return {
    name: 'messaged_outcome', label: 'Message handoff and retire',
    description: 'Persist one nonempty board handoff and request retirement after the current turn and tools settle. No separate report or proof text.',
    parameters,
    async execute(_id, params, _signal, _update, ctx) {
      const number = worker.done(params.handoff, ctx);
      return { content: [{ type: 'text', text: `Handoff #${number} stored; safe retirement requested.` }], details: { number }, terminate: true };
    },
  };
}

export function installWorker(pi, env = process.env, drained = () => true) {
  if (env.BF2_SWARM_WORKER !== '1' && !env.FACTORY_SESSION) return;
  const config = configuration(env);
  let board, timer, warned = false, pausedNotice, notifying = false, refused = false;
  const close = () => { clearInterval(timer); timer = undefined; board?.close(); board = undefined; };
  const live = ctx => board && ctx.sessionManager.getSessionId() === config.session;
  const notifyPause = async ctx => {
    if (!live(ctx) || notifying) return;
    const state = board.lifecycle.status();
    const row = state.workers.find(w => w.session === config.session);
    const notice = row?.retire_requested ?? state.status;
    if (!row || row.state !== 'active' || (state.status === 'running' && !row.retire_requested) || pausedNotice === notice) return;
    notifying = true;
    try {
      const receipt = await pi.sendUserMessage(workerWrapup(config.run, state, config.session), {
        deliverAs: 'steer', expandPromptTemplates: false,
        admissionGuard: () => !!live(ctx) && board.lifecycle.status().status === state.status &&
          board.lifecycle.status().workers.some(w => w.session === config.session && w.state === 'active'),
      });
      if (receipt.status === 'admitted') pausedNotice = notice;
    } finally { notifying = false; }
  };
  pi.on('session_start', async (_event, ctx) => {
    close();
    refused = true; // Failed startup must never release the native @file input.
    if (ctx.sessionManager.getSessionId() !== config.session || !ctx.sessionManager.getSessionFile()) throw new Error('swarm requires its configured durable Pi session');
    board = openBoard(config);
    board.lifecycle.registerSessionFile(ctx.sessionManager.getSessionFile());
    const settings = pi.getSettings();
    const queuesReady = settings.steeringMode === 'all' && settings.followUpMode === 'all';
    if (!queuesReady) {
      board.lifecycle.lost(config.session, 'native steeringMode/followUpMode must both be all');
      console.error('BF2 swarm refuses input: native steeringMode/followUpMode must both be all. Fix settings for NEW sessions; do not reload old runs.');
      ctx.shutdown(); return;
    }
    board.lifecycle.ready();
    refused = false;
    warned = ctx.sessionManager.getEntries().some(e => e.type === 'custom' && e.customType === warningType);
    timer = setInterval(() => { void notifyPause(ctx).catch(e => console.error(`BF2 swarm: ${e.message}`)); }, 1000);
    timer.unref();
  });
  pi.on('input', (event, ctx) => {
    if (refused) return { action: 'handled' };
    if (!live(ctx)) return;
    const state = board.lifecycle.status();
    // Results of already-started work must drain; they are not new board inputs.
    if (event.source === 'extension' && event.text.startsWith('SYSTEM (background-jobs): All ') &&
      state.workers.some(w => w.session === config.session && ['active', 'retiring'].includes(w.state))) return;
    // Allow exactly the wrapup USER input while paused, not ordinary board wakes.
    if (!board.lifecycle.acceptsInput() && !(event.source === 'extension' &&
      event.text === workerWrapup(config.run, state, config.session) &&
      state.workers.some(w => w.session === config.session && w.state === 'active'))) return { action: 'handled' };
  });
  pi.on('turn_end', async (_event, ctx) => {
    if (!live(ctx)) return;
    await notifyPause(ctx);
    const percent = ctx.getContextUsage()?.percent;
    const state = board.lifecycle.status(), row = state.workers.find(w => w.session === config.session);
    board.lifecycle.recordUsage(percent);
    const threshold = row?.launch_config?.contextWarning ?? 80;
    if (!warned && typeof percent === 'number' && Number.isFinite(percent) && percent >= threshold && board.lifecycle.acceptsInput()) {
      warned = true;
      pi.appendEntry(warningType, { warned: true });
      const warning = state.floor ? expand(row.launch_config.warningText, { percent: threshold }) : WARNING;
      await pi.sendUserMessage(warning, { deliverAs: 'steer', expandPromptTemplates: false,
        admissionGuard: () => !!live(ctx) && board.lifecycle.acceptsInput() });
    }
  });
  pi.on('message_end', (event, ctx) => {
    if (live(ctx) && event.message?.role === 'assistant') board.lifecycle.recordError(event.message.stopReason === 'error' ? event.message.errorMessage ?? 'assistant ended with error; no further diagnosis available' : null);
  });
  pi.on('agent_settled', (event, ctx) => {
    if (!event.interruption && live(ctx) && drained(ctx)) {
      const row = board.lifecycle.status().workers.find(w => w.session === config.session);
      if (row?.last_error) { board.lifecycle.lost(config.session, row.last_error); ctx.shutdown(); return; }
    }
    // Native settlement has no outcome field; interrupted runs are not safe retirement.
    if (!event.interruption && live(ctx) && drained(ctx) && board.lifecycle.settled()) ctx.shutdown();
  });
  pi.on('session_shutdown', close);
  return {
    done(text, ctx) {
      if (!live(ctx)) throw new Error('swarm worker is not active');
      return board.lifecycle.done(text);
    },
  };
}
