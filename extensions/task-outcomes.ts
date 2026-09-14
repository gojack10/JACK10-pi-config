import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
  getTaskOutcomeManager,
  releaseTaskOutcomeManager,
  type DeclaredOutcome,
} from "./task-outcomes/manager.ts";

const outcomes = ["completed", "blocked", "needs_input", "failed"] as const;

export default function taskOutcomes(pi: ExtensionAPI) {
  pi.registerTool({
    name: "report_outcome",
    label: "report_outcome",
    description:
      "Declare the explicit outcome of the active task attempt. The active launch contract supplies the job, attempt, and report path; do not invent or select another job. In task mode, completed requires a readable nonempty report and no registered child/background work still running. A declaration is provisional until the declaring turn settles cleanly; clean dialogue responses are returned separately and verbatim.",
    parameters: Type.Object({
      outcome: StringEnum(outcomes, { description: "completed, blocked, needs_input, or failed" }),
      summary: Type.String({ description: "Short structured outcome summary", minLength: 1, maxLength: 20_000 }),
    }, { additionalProperties: false }),
    async execute(_id, { outcome, summary }, _signal, _onUpdate, ctx) {
      const result = await getTaskOutcomeManager(pi, ctx).declare(outcome as DeclaredOutcome, summary);
      return {
        content: [{ type: "text", text: `${result.outcome} declared for ${result.jobId}/${result.attemptId}; settlement will finalize it.` }],
        details: result,
        terminate: result.terminate,
      };
    },
  });

  pi.registerCommand("task-cancel", {
    description: "Cancel the active task attempt without relaunching it",
    handler: async (_args, ctx) => {
      const manager = getTaskOutcomeManager(pi, ctx);
      manager.requestCancellation("task_cancel", "explicit /task-cancel");
      ctx.abort();
      await ctx.waitForIdle();
    },
  });

  pi.on("session_start", (_event, ctx) => {
    const manager = getTaskOutcomeManager(pi, ctx);
    manager.restore();
    manager.ingestLauncherContract();
  });
  pi.on("before_agent_start", (event, ctx) => {
    const manager = getTaskOutcomeManager(pi, ctx);
    manager.ingestLauncherContract();
    const contract = manager.taskInstruction();
    if (contract) return { systemPrompt: `${event.systemPrompt}\n\n${contract}` };
  });
  pi.on("session_tree", (_event, ctx) => {
    getTaskOutcomeManager(pi, ctx).onSessionTree();
  });
  pi.on("agent_start", (_event, ctx) => {
    getTaskOutcomeManager(pi, ctx).onAgentStart();
  });
  pi.on("turn_start", (event, ctx) => {
    getTaskOutcomeManager(pi, ctx).onTurnStart(event.turnIndex);
  });
  pi.on("turn_end", (event, ctx) => {
    getTaskOutcomeManager(pi, ctx).onTurnEnd(event.message);
  });
  pi.on("agent_end", (event, ctx) => {
    getTaskOutcomeManager(pi, ctx).onAgentEnd(event.messages, event.interruption);
  });
  pi.on("agent_settled", async (_event, ctx) => {
    await getTaskOutcomeManager(pi, ctx).onAgentSettled(ctx.hasPendingMessages?.() ?? false);
  });
  pi.on("session_shutdown", (event, ctx) => {
    getTaskOutcomeManager(pi, ctx).shutdown(`session ${event.reason}`);
    releaseTaskOutcomeManager(ctx);
  });
}
