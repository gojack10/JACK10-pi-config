import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
  getBackgroundJobManager,
  releaseBackgroundJobManager,
  type BackgroundJobOutcomeStatus,
} from "./manager.ts";

export default function consumerTestExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "background_jobs_consumer",
    label: "background_jobs_consumer",
    description: "Test-only second consumer of the shared background job manager.",
    parameters: Type.Object({
      action: Type.String(),
      batch_id: Type.Optional(Type.String()),
      command: Type.Optional(Type.String()),
      label: Type.Optional(Type.String()),
      message: Type.Optional(Type.String()),
      outcome_id: Type.Optional(Type.String()),
      status: Type.Optional(Type.String()),
      expected: Type.Optional(Type.Integer({ minimum: 1 })),
    }),
    async execute(_id, args, _signal, _onUpdate, ctx) {
      const manager = getBackgroundJobManager(pi, ctx);
      const batchId = args.batch_id ?? "test-batch";
      let started: ReturnType<typeof manager.start> | undefined;
      switch (args.action) {
        case "open":
          manager.openBatch(batchId, args.expected);
          break;
        case "start":
          const options = {
            command: args.command ?? "true",
            cwd: ctx.cwd,
            label: args.label,
          };
          started = args.batch_id === undefined
            ? manager.start(options)
            : manager.start(options, { batchId });
          break;
        case "close":
          manager.closeBatch(batchId);
          break;
        case "needs_input":
          manager.notifyNeedsInput(batchId, args.message ?? "Input required");
          break;
        case "register":
          manager.registerOutcome(batchId, args.outcome_id ?? args.label ?? "outcome");
          break;
        case "fail_report": {
          const batch = manager.openBatch(batchId, 1);
          manager.attach(() => Promise.reject(new Error("delivery failed")));
          batch.recordOutcome({
            id: args.outcome_id ?? "outcome",
            status: (args.status ?? "failed") as BackgroundJobOutcomeStatus,
            summary: args.message,
          });
          batch.close();
          break;
        }
        case "report":
          break;
        case "outcome":
          manager.recordOutcome(batchId, {
            id: args.outcome_id ?? args.label ?? "outcome",
            status: (args.status ?? "completed") as BackgroundJobOutcomeStatus,
            summary: args.message,
          });
          break;
        case "stats":
          break;
        default:
          throw new Error(`Unknown test action: ${args.action}`);
      }
      const details = {
        ...manager.stats(),
        ...(started ? { job_id: started.job.id } : {}),
        ...(args.action === "report" || args.action === "fail_report"
          ? { report: manager.getReport(batchId) }
          : {}),
      };
      return {
        content: [{ type: "text", text: JSON.stringify(details) }],
        details,
      };
    },
  });

  pi.on("session_shutdown", (_event, ctx) => {
    releaseBackgroundJobManager(ctx);
  });
}
