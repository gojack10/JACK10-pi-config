import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
  getBackgroundJobManager,
  type BackgroundJobOutcomeStatus,
} from "../background-jobs/manager.ts";
import type { TaskMode } from "./manager.ts";
import { getTaskOutcomeManager as getTaskManager } from "./manager.ts";

export default function consumerTestExtension(pi: ExtensionAPI) {
  const events: unknown[] = [];
  pi.events.on("task-outcome", event => events.push(event));

  pi.registerTool({
    name: "task_outcomes_consumer",
    label: "task_outcomes_consumer",
    description: "Test-only launch and monitor adapter for task outcomes.",
    parameters: Type.Object({
      action: Type.String(),
      job_id: Type.Optional(Type.String()),
      attempt_id: Type.Optional(Type.String()),
      mode: Type.Optional(Type.String()),
      report_path: Type.Optional(Type.String()),
      batch_id: Type.Optional(Type.String()),
      child_job_id: Type.Optional(Type.String()),
      status: Type.Optional(Type.String()),
      source: Type.Optional(Type.String()),
      summary: Type.Optional(Type.String()),
      command: Type.Optional(Type.String()),
      children: Type.Optional(Type.Array(Type.String())),
      expected: Type.Optional(Type.Integer({ minimum: 1 })),
    }),
    async execute(_id, args, _signal, _onUpdate, ctx) {
      const manager = getTaskManager(pi, ctx);
      let result: unknown;
      switch (args.action) {
        case "activate":
          result = manager.activateContract({
            jobId: args.job_id ?? "job",
            attemptId: args.attempt_id ?? "attempt",
            mode: (args.mode ?? "task") as TaskMode,
            reportPath: args.report_path,
            batchId: args.batch_id,
            childJobIds: args.children,
          });
          break;
        case "child":
          manager.registerChild(args.job_id ?? "job", args.child_job_id ?? "child");
          break;
        case "child_outcome":
          manager.recordChildOutcome(
            args.job_id ?? "job",
            args.child_job_id ?? "child",
            (args.status ?? "completed") as BackgroundJobOutcomeStatus,
            args.summary ?? "child finished",
            args.source as any,
          );
          break;
        case "background": {
          const batchId = args.batch_id ?? args.job_id;
          if (!batchId) throw new Error("batch_id required");
          const bg = getBackgroundJobManager(pi, ctx);
          const started = bg.start({ command: args.command ?? "true", cwd: ctx.cwd, label: args.job_id }, { batchId });
          result = { job_id: started.job.id, batch_id: batchId };
          break;
        }
        case "close":
          manager.closeBatch(args.batch_id ?? args.job_id ?? "batch");
          break;
        case "batch_open":
          getBackgroundJobManager(pi, ctx).openBatch(args.batch_id ?? args.job_id ?? "batch", args.expected);
          break;
        case "batch_stats":
          result = getBackgroundJobManager(pi, ctx).getBatchStatus(args.batch_id ?? args.job_id ?? "batch");
          break;
        case "snapshot":
          result = { ...manager.snapshot(), events: [...events] };
          break;
        default:
          throw new Error(`Unknown task outcome test action: ${args.action}`);
      }
      return { content: [{ type: "text", text: JSON.stringify(result ?? manager.snapshot()) }], details: result ?? manager.snapshot() };
    },
  });

}
