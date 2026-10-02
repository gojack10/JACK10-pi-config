import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { resolve } from 'node:path';

export function allowedTool(name: string, input: any, policy: { smoke: boolean; report: string; reads: string[] }) {
  if (policy.smoke) {
    if (name === 'report_outcome') return true;
    if (name === 'read') return policy.reads.includes(resolve(input.path ?? ''));
    return name === 'write' && resolve(input.path ?? '') === policy.report;
  }
  return !['subagent_launch', 'subagent_followup', 'bash_bg'].includes(name);
}
export function installGuard(pi: ExtensionAPI, policy: { smoke: boolean; report: string; reads: string[] }) {
  pi.on('session_start', () => {
    pi.setActiveTools(pi.getActiveTools().filter(name => policy.smoke
      ? ['read', 'write', 'report_outcome'].includes(name)
      : !['subagent_launch', 'subagent_followup', 'bash_bg'].includes(name)));
  });
  pi.on('tool_call', event => allowedTool(event.toolName, event.input, policy)
    ? undefined : { block: true, reason: 'Factory policy: this tool/path is outside the assigned authority.' });
  pi.on('before_agent_start', (_event, ctx) => {
    if (ctx.model?.provider !== 'local' || ctx.model.id !== 'qwen3.8-flash-next' || pi.getThinkingLevel() !== 'xhigh') {
      throw Error('Factory route changed; local/qwen3.8-flash-next xhigh required');
    }
  });
}
