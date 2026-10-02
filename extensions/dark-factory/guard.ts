import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { resolve } from 'node:path';
import { routeEntry, type RoutePin } from '../codex-personal/resolution.ts';
import { ROUTE } from './core.mjs';

type Route = { provider: string; model: string; thinking: string };
type Policy = { smoke: boolean; report: string; reads: string[]; route?: Route; task?: string; directory?: string };
const destructiveTreeTools = new Set([
  'sifttext_create_tree', 'sifttext_delete_node', 'sifttext_duplicate_node', 'sifttext_move_node',
  'sifttext_move_cross_tree', 'sifttext_promote_to_root', 'sifttext_reorder_children',
]);
const inside = (path: string, directory: string) => {
  const target = resolve(path), root = resolve(directory);
  return target === root || target.startsWith(root + '/');
};

export function allowedRoute(model: { provider: string; id: string } | undefined, thinking: string, expected: Route, pin?: RoutePin) {
  if (!model || model.id !== expected.model || thinking !== expected.thinking) return false;
  if (expected.provider !== 'openai-codex-personal') return model.provider === expected.provider;
  return pin?.umbrella === expected.provider && pin.model === expected.model && pin.actualProviderId === model.provider;
}

export function allowedTool(name: string, input: any, policy: Policy) {
  if (policy.smoke) {
    if (name === 'report_outcome') return true;
    if (name === 'read') return policy.reads.includes(resolve(input.path ?? ''));
    return name === 'write' && resolve(input.path ?? '') === policy.report;
  }
  if (['subagent_launch', 'subagent_followup'].includes(name)) return false;
  if (policy.task !== 'yc') return true;
  if (['bash', 'bash_bg', 'edit'].includes(name) || destructiveTreeTools.has(name)) return false;
  if (name === 'write') return !!policy.directory && inside(input.path ?? '', policy.directory);
  return true;
}
export function installGuard(pi: ExtensionAPI, policy: Policy) {
  pi.on('session_start', () => {
    pi.setActiveTools(pi.getActiveTools().filter(name => policy.smoke
      ? ['read', 'write', 'report_outcome'].includes(name)
      : !['subagent_launch', 'subagent_followup'].includes(name)));
  });
  pi.on('tool_call', event => allowedTool(event.toolName, event.input, policy)
    ? undefined : { block: true, reason: 'Factory policy: this tool/path is outside the assigned authority.' });
  const routeOK = ctx => allowedRoute(ctx.model, pi.getThinkingLevel(), policy.route ?? ROUTE,
    routeEntry(ctx.sessionManager.getBranch()));
  // A thrown event-handler error is only logged by Pi. Consume invalid startup input;
  // abort the live request signal as well if a provider changes during a turn/retry.
  pi.on('input', (_event, ctx) => {
    if (routeOK(ctx)) return;
    ctx.abort();
    ctx.shutdown();
    return { action: 'handled' as const };
  });
  pi.on('before_provider_request', (_event, ctx) => {
    if (!routeOK(ctx)) {
      ctx.abort();
      throw Error(`Factory route changed; ${JSON.stringify(policy.route ?? ROUTE)} required`);
    }
  });
}
