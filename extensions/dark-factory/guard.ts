import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { resolve } from 'node:path';
import { routeEntry, type RoutePin } from '../codex-personal/resolution.ts';
import { ROUTE } from './core.mjs';

type Route = { provider: string; model: string; thinking: string };
type Policy = { smoke: boolean; report: string; reads: string[]; route?: Route };

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
  return !['subagent_launch', 'subagent_followup'].includes(name);
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
