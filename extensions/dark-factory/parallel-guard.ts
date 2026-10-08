import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { readFileSync } from 'node:fs';
import { installGuard } from './guard.ts';
import { validateDispatcherReport, validateWorkerReport } from './parallel-core.mjs';

type Route = { provider: string; model: string; thinking: string };
type Policy = { report: string; route: Route; role: 'worker' | 'dispatcher'; fault?: string;
  code?: { worktree: string; branch: string; base: string; phase: string } };

// Parallel-factory session policy: the shared BF2 route pin and launch-tool block, plus the role-node
// report schema at report_outcome. `fault` is smoke-only injection of a provider usage-limit failure.
export function installParallelGuard(pi: ExtensionAPI, policy: Policy) {
  installGuard(pi, { smoke: false, report: policy.report, reads: [], route: policy.route });
  pi.on('tool_call', event => {
    if (event.toolName !== 'report_outcome' || !['completed', 'blocked'].includes((event.input as { outcome?: string })?.outcome ?? '')) return;
    try {
      const text = readFileSync(policy.report, 'utf8');
      if (policy.role === 'dispatcher') validateDispatcherReport(text);
      else {
        const report = validateWorkerReport(text);
        if (policy.code) {
          const code = report.code;
          if (!code || code.worktree !== policy.code.worktree || code.branch !== policy.code.branch || code.base !== policy.code.base) throw Error('report must retain assigned code identity');
          if (report.disposition === 'worked' && policy.code.phase !== 'publish') throw Error('private candidate is not worked; return candidate for serialized publication');
        } else if (report.code || report.disposition === 'candidate') throw Error('tree task has no code publication authority');
      }
    } catch (error) {
      // A validation error is not fresh permission to declare: it previously induced wait-as-outcome retries.
      return { block: true, reason: `Factory report check: ${error instanceof Error ? error.message : String(error)}. ` +
        `Repair the JSON at ${policy.report} from the work already done. Retry report_outcome only when the task contract permits that outcome and all registered work has drained. ` +
        'If work is still running, end this turn with ordinary assistant text and wait for its completion notification; do not substitute another outcome value. ' +
        'If the attempt is inactive, preserve the report and return the refusal to the controller instead of retrying or starting more task work.' };
    }
  });
  if (policy.fault) {
    const errorMessage = policy.fault;
    pi.on('message_end', event => {
      if (event.message.role !== 'assistant') return;
      return { message: { ...event.message, content: [], stopReason: 'error', errorMessage } };
    });
  }
}
