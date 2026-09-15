import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  existingTaskOutcomeManager,
  type MaintenanceLease,
  type TaskOutcomeManager,
} from "../task-outcomes/manager.ts";
import { cleanSessionFile } from "../tool-call-clean/index.ts";

export const RECOVERY_OPTION = "@pi_subagent_recovery";
export const RECOVERY_COMMAND = "subagent-clean-and-continue";
const exec = promisify(execFile);
const safeId = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);

export function registerContextRecovery(pi: ExtensionAPI): void {
  pi.on("input", (_event, ctx) => {
    if (existingTaskOutcomeManager(ctx)?.snapshot().active?.state !== "context_paused") return;
    ctx.ui.notify("Assignment paused for context. Use subagent_clean_and_continue from the parent.", "warning");
    return { action: "handled" };
  });

  pi.registerCommand(RECOVERY_COMMAND, {
    description: "Parent-authorized cleanup and continuation of the current context-paused assignment",
    async handler(args, ctx) {
      const nonce = args.trim();
      const pane = process.env.TMUX_PANE;
      if (!safeId(nonce) || !pane || !/^%\d+$/.test(pane)) throw new Error("invalid recovery request");
      const readRequest = async () => JSON.parse((await exec("tmux", ["show-options", "-qv", "-t", pane, RECOVERY_OPTION])).stdout);
      const request = await readRequest();
      if (request?.nonce !== nonce || request.status !== "pending" ||
          ![request.jobId, request.attemptId, request.sessionId, request.pauseId].every(safeId)) {
        throw new Error("recovery request is stale or malformed");
      }
      const acknowledge = async (status: string, fields: Record<string, unknown> = {}) => {
        if ((await readRequest()).nonce !== nonce) throw new Error("recovery request was replaced");
        await exec("tmux", ["set-option", "-q", "-t", pane, RECOVERY_OPTION,
          JSON.stringify({ ...request, status, ...fields })]);
      };
      let maintenanceLease: MaintenanceLease | undefined;
      let maintenanceManager: TaskOutcomeManager | undefined;
      try {
        // Never queue a cleanup behind an unrelated active turn.
        if (!ctx.isIdle()) throw new Error("worker is not idle; no cleanup performed");
        await ctx.waitForIdle();
        if (ctx.hasPendingMessages()) throw new Error("queued messages remain; refusing to discard them during cleanup");
        const task = existingTaskOutcomeManager(ctx);
        if (!task) throw new Error("paused assignment task manager is unavailable");
        const snapshot = task.snapshot().active;
        if (!snapshot || snapshot.jobId !== request.jobId || snapshot.attemptId !== request.attemptId ||
            snapshot.state !== "context_paused" || !snapshot.contextPause || snapshot.contextPause.id !== request.pauseId) {
          throw new Error("recovery does not match the paused assignment");
        }
        const contextPause = snapshot.contextPause;
        const taskManager = task;
        maintenanceManager = taskManager;
        const liveSession = (await exec("tmux", ["show-options", "-qv", "-t", pane, "@pi_subagent_session_id"])).stdout.trim();
        if (liveSession !== request.sessionId) throw new Error("saved subagent session changed");
        // Pending child/background work no longer refuses cleanup: the refresh is
        // in place (same manager/runtime), and completion still gates on drained work.
        const file = ctx.sessionManager.getSessionFile();
        const sessionId = ctx.sessionManager.getSessionId();
        const modelId = ctx.model?.id;
        if (!file) throw new Error("context cleanup requires a saved session");
        // Refuse infeasible cleanup before persisting maintenance intent. The
        // drained callback repeats validation against the sealed current branch.
        cleanSessionFile(file, ctx.sessionManager.getLeafId(), contextPause.limit, true);
        const lease: MaintenanceLease = taskManager.beginMaintenance(file);
        maintenanceLease = lease;
        let result: ReturnType<typeof cleanSessionFile> | undefined;
        const switched = await ctx.switchSession(file, {
          maintenance: {
            token: lease,
            beforeReplace: () => {
              result = cleanSessionFile(file, ctx.sessionManager.getLeafId(), contextPause.limit);
              if (!result.changed) {
                return { replace: false, afterNoReplace: () => taskManager.resumeMaintenance(lease) };
              }
              return { replace: true };
            },
          },
          async withSession(live) {
            if (live.sessionManager.getSessionId() !== sessionId) throw new Error("Pi session identity changed during cleanup");
            if (!modelId || live.model?.id !== modelId) throw new Error("session model changed during cleanup; assignment remains paused");
            const resumed = existingTaskOutcomeManager(live);
            if (!resumed) throw new Error("live task manager is unavailable");
            resumed.resumeMaintenance(lease);
            // Use the refreshed runtime's usage (the same estimator used by the guard).
            const tokens = live.getContextUsage()?.tokens;
            if (tokens == null) throw new Error("cleaned context usage is unavailable; assignment remains paused");
            resumed.resumeAfterContextClean(request.jobId, request.attemptId, request.pauseId, tokens);
            try {
              await acknowledge("resume_requested", { beforeTokens: result?.beforeTokens, afterTokens: tokens });
              await live.sendUserMessage("Tool outputs were cleaned. Continue the same assignment from retained progress; the report path and completion requirements are unchanged.");
            } catch (error) {
              // If dispatch never started, leave a recoverable assignment, not an
              // active contract with no running turn. Already-final outcomes stay final.
              resumed.pauseForContext(contextPause.reason, contextPause.limit);
              throw error;
            }
          },
        });
        if (switched.cancelled) {
          throw new Error("session reload cancelled; assignment remains paused");
        }
      } catch (error) {
        if (maintenanceLease) maintenanceManager?.failMaintenance(maintenanceLease, error, { resume: true });
        const message = (error instanceof Error ? error.message : String(error))
          .replace(/\b(api[_-]?key|token|password|secret|authorization)\b(\s*[:=]\s*)(?:bearer\s+)?\S+/gi, "$1$2[redacted]")
          .slice(0, 2048);
        await acknowledge("error", { error: message });
      }
    },
  });
}
