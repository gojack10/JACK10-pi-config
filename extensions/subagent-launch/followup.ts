import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { existingTaskOutcomeManager, TASK_LAUNCH_MANIFEST_OPTION, TASK_OUTCOME_EVENT } from '../task-outcomes/manager.ts';

export const FOLLOWUP_COMMAND = 'subagent-followup';
export const FOLLOWUP_CAPABILITY_OPTION = '@pi_subagent_followup_session';

export function registerQueuedFollowup(pi: ExtensionAPI): void {
  pi.on('session_start', async (_event, ctx) => {
    const pane = process.env.TMUX_PANE;
    if (pane && /^%\d+$/.test(pane)) await pi.exec('tmux', ['set-option', '-q', '-t', pane,
      FOLLOWUP_CAPABILITY_OPTION, ctx.sessionManager.getSessionId()], { timeout: 2000 });
  });
  // Serialize contract handoffs, not agent messages: Pi owns idle waiting and admission.
  let handoff = Promise.resolve();
  let waitForIdle: (() => Promise<void>) | undefined;
  let settled = Promise.resolve();
  // Capture while busy: isIdle becomes true *inside* agent_settled handlers,
  // before a late call to waitForIdle would wait for their publication to finish.
  pi.on('agent_start', () => { if (waitForIdle) settled = waitForIdle(); });
  const requests = new Map<string, Promise<void>>();
  pi.registerCommand(FOLLOWUP_COMMAND, {
    description: 'Admit a parent-armed follow-up after the current assignment settles',
    handler(args, ctx) {
      const path = args.trim();
      const previous = requests.get(path);
      if (previous) return previous;
      const pane = process.env.TMUX_PANE;
      if (!pane || !/^%\d+$/.test(pane)) throw new Error('follow-up requires its saved tmux pane');
      const request = JSON.parse(readFileSync(path, 'utf8'));
      if (![request.jobId, request.attemptId].every(id => typeof id === 'string' && /^[A-Za-z0-9-]+$/.test(id)) ||
          path !== join(tmpdir(), `${request.jobId}-${request.attemptId}.manifest.json`) || request.dispatchState !== 'queued') {
        throw new Error('invalid queued follow-up manifest');
      }
      const sessionId = ctx.sessionManager.getSessionId();
      waitForIdle = () => ctx.waitForIdle();
      if (!ctx.isIdle()) settled = waitForIdle();
      const tmux = (...args: string[]) => execFileSync('tmux', args, { encoding: 'utf8', timeout: 2000 }).trim();
      const show = (option: string) => tmux('show-options', '-qv', '-t', pane, option);
      const save = (file: string, value: unknown) => {
        const temporary = `${file}.${process.pid}.tmp`;
        writeFileSync(temporary, JSON.stringify(value) + '\n', { mode: 0o600 });
        renameSync(temporary, file);
      };
      const eligible = () => {
        const active = existingTaskOutcomeManager(ctx)?.snapshot().active;
        return !active || active.state === 'awaiting_input' || active.state === 'transport_lost';
      };
      const work = handoff.then(async () => {
        try {
          const text = readFileSync(request.missionFile, 'utf8');
          if (!text.trim()) throw new Error('follow-up mission is empty');
          // Native followUp alone stays inside the current run and suppresses its
          // settlement. A fresh attempt must wait for the full native idle boundary.
          for (;;) {
            await settled;
            await ctx.waitForIdle();
            if (eligible()) break;
            // An idle task may still own children or a context pause. Never steal it.
            await new Promise<void>(resolve => {
              const off = pi.events.on(TASK_OUTCOME_EVENT, () => { off(); resolve(); });
              if (eligible()) { off(); resolve(); }
            });
          }
          let armed = false;
          const admission = await pi.sendUserMessage(text, {
            deliverAs: 'followUp',
            admissionKey: `subagent-followup:${request.jobId}@${request.attemptId}`,
            admissionGuard: () => {
              if (!ctx.isIdle() || ctx.hasPendingMessages() ||
                  ctx.model?.provider !== request.provider || ctx.model?.id !== request.model ||
                  pi.getThinkingLevel() !== request.thinking || ctx.sessionManager.getSessionId() !== sessionId ||
                  show('@pi_session_id') !== sessionId || show('@pi_subagent_job_id') !== request.jobId || show('@pi_subagent_session_id') !== request.sessionId) return false;
              if (armed) return show(TASK_LAUNCH_MANIFEST_OPTION) === path;
              if (!eligible()) return false;
              const oldPath = show(TASK_LAUNCH_MANIFEST_OPTION);
              const old = JSON.parse(readFileSync(oldPath, 'utf8'));
              if (old.jobId !== request.jobId || old.sessionId !== request.sessionId || old.mode !== request.mode ||
                  old.provider !== request.provider || old.model !== request.model || old.thinking !== request.thinking) return false;
              const active = existingTaskOutcomeManager(ctx)?.snapshot().active;
              save(oldPath, { ...old, supersededBy: request.attemptId, supersededState: active?.state ?? 'final' });
              request.startGeneration = Number(show('@pi_start_generation'));
              request.outcomeGeneration = Number(show('@pi_outcome_generation'));
              for (const [option, value] of [[TASK_LAUNCH_MANIFEST_OPTION, path], ['@pi_start_channel', request.startChannel],
                ['@pi_subagent_attempt_id', request.attemptId], ['@pi_subagent_mode', request.mode]]) {
                tmux('set-option', '-q', '-t', pane, option, value);
              }
              request.dispatchState = 'active';
              save(path, request);
              armed = true;
              return true;
            },
          });
          if (admission?.status !== 'admitted' || admission.delivery !== 'turn') {
            throw new Error(admission?.status === 'rejected' ? admission.error : 'follow-up was not admitted as a fresh turn');
          }
        } catch (error) {
          save(path, { ...request, dispatchError: (error instanceof Error ? error.message : String(error)).slice(0, 2048) });
        }
      });
      requests.set(path, work);
      handoff = work.catch(() => {});
      return work;
    },
  });
}
