import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from '@earendil-works/pi-ai';
import { handoffTool, installWorker } from '../extensions/bf2-swarm/worker.mjs';
import { getBackgroundJobManager } from '../extensions/background-jobs/manager.ts';

export default function (pi: ExtensionAPI) {
  const worker = installWorker(pi, process.env, ctx => getBackgroundJobManager(pi, ctx).stats().running === 0);
  if (!worker) return;
  pi.registerTool(handoffTool(worker, Type.Object({ handoff: Type.String({ minLength: 1 }) })));
}
