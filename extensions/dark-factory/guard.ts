import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { routeEntry, type RoutePin } from '../codex-personal/resolution.ts';
import { ROUTE, taskSettings, validateReport } from './core.mjs';

type Route = { provider: string; model: string; thinking: string };
type Policy = { smoke: boolean; report: string; reads: string[]; route?: Route;
  role?: 'planner' | 'worker'; project?: ReturnType<typeof taskSettings> };

export function allowedRoute(model: { provider: string; id: string } | undefined, thinking: string, expected: Route, pin?: RoutePin) {
  if (!model || model.id !== expected.model || thinking !== expected.thinking) return false;
  if (expected.provider !== 'openai-codex-personal') return model.provider === expected.provider;
  return pin?.umbrella === expected.provider && pin.model === expected.model && pin.actualProviderId === model.provider;
}

export function allowedTool(name: string, input: any, policy: Policy) {
  if (policy.smoke) {
    if (name === 'report_outcome') return true;
    if (name === 'read') return [policy.report, ...policy.reads].includes(resolve(input.path ?? ''));
    return name === 'write' && resolve(input.path ?? '') === policy.report;
  }
  return !['subagent_launch', 'subagent_followup'].includes(name);
}
export function installGuard(pi: ExtensionAPI, policy: Policy) {
  let providerError = false;
  pi.on('agent_end', event => {
    const last = [...event.messages].reverse().find(message => message.role === 'assistant');
    providerError = !event.interruption && last?.stopReason === 'error';
  });
  pi.on('agent_before_settle', async (event, ctx) => {
    if (!providerError || event.outcome !== 'error' || event.continue || ctx.hasPendingMessages() ||
        existsSync(join(dirname(policy.report), 'STOP'))) return;
    const { existingTaskOutcomeManager } = await import('../task-outcomes/manager.ts');
    const active = existingTaskOutcomeManager(ctx)?.snapshot().active;
    if (!active?.pauseOnInterrupt || active.state !== 'active' || active.declaration || active.pendingWork.length ||
        active.reportPath !== policy.report) return;
    const retries = ctx.sessionManager.getBranch().filter(entry => {
      if (entry.type !== 'custom' || entry.customType !== 'factory-provider-retry') return false;
      const data = entry.data as { jobId?: string; attemptId?: string };
      return data?.jobId === active.jobId && data?.attemptId === active.attemptId;
    }).length;
    if (retries >= 2) return; // Bounded per attempt, survives reload; never overrides a human/policy stop.
    return { continue: true, entries: [
      { type: 'custom', customType: 'factory-provider-retry', data: { jobId: active.jobId, attemptId: active.attemptId, retry: retries + 1 } },
      { type: 'custom_message', customType: 'factory-provider-retry', display: true,
        content: `Provider generation failed. Retry ${retries + 1}/2 in the SAME assignment and attempt. Use retained progress and the existing report; ${(policy.project ?? taskSettings()).lean ? 'trust saved results and recover uncertain delivery only with a narrow marker lookup' : 'verify uncertain effects before acting'}. Do not replay completed work or spent launches. If the report is already valid and tracked work drained, finish report_outcome under the return protocol. No new authority or model change.` },
    ] };
  });
  pi.on('session_start', () => {
    pi.setActiveTools(pi.getActiveTools().filter(name => policy.smoke
      ? ['read', 'write', 'report_outcome'].includes(name)
      : !['subagent_launch', 'subagent_followup'].includes(name)));
  });
  pi.on('tool_call', event => {
    if (!allowedTool(event.toolName, event.input, policy)) return { block: true, reason: 'Factory policy: this tool/path is outside the assigned authority.' };
    if (event.toolName === 'report_outcome' && policy.role && ['completed', 'blocked'].includes(event.input.outcome)) {
      try { validateReport(readFileSync(policy.report, 'utf8'), policy.role, policy.smoke, policy.project ?? taskSettings()); }
      catch (error) { return { block: true, reason: `Factory report validation: ${String(error)}. Repair the reserved JSON report from existing work, then retry report_outcome. Do not repeat research or tree writes; the current attempt remains open.` }; }
    }
  });
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
