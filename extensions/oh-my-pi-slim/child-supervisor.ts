import {
  getAgentDir,
  SettingsManager,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  CHECKPOINT_RESUME_TEXT,
  completedToolBatch,
  contextUsageNeedsCheckpoint,
} from "./subagent-checkpoint.js";

const REASONS = ["need_decision", "interview_request", "progress_update"] as const;

export const contactSupervisorParameters = Type.Object({
  reason: Type.Union(REASONS.map((reason) => Type.Literal(reason)), {
    description: "Select the supervisor request type.",
  }),
  message: Type.Optional(Type.String({ description: "Provide the complete request context for the orchestrator." })),
  interview: Type.Optional(Type.Object({
    title: Type.Optional(Type.String({ description: "Provide a short interview title." })),
    questions: Type.Optional(Type.Array(Type.Object({
      id: Type.Optional(Type.String({ description: "Provide a short question identifier." })),
      prompt: Type.String({ description: "Provide the question text." }),
      options: Type.Optional(Type.Array(Type.String(), { description: "Provide the answer options." })),
    }), { description: "Provide the structured interview questions." })),
  }, { description: "Provide structured interview details." })),
}, { additionalProperties: false });

export default function childSupervisor(pi: ExtensionAPI): void {
  if (process.env.OMPS_SUBAGENT_CHILD !== "1" || process.env.PI_SUBAGENT_CHILD !== "1") return;

  let pendingCheckpoint: { cycle: number } | undefined;
  let checkpointCycle = 0;
  let contactedSupervisorThisTurn = false;

  function clearCheckpointState(): void {
    pendingCheckpoint = undefined;
    contactedSupervisorThisTurn = false;
  }

  pi.registerTool({
    name: "contact_supervisor",
    label: "Contact Supervisor",
    description: "Request an orchestrator reply and pause the child run until the reply arrives.",
    promptSnippet: "Request an orchestrator reply from a child run.",
    promptGuidelines: [
      "Contact the orchestrator through `contact_supervisor` when a decision, interview, or progress update needs acknowledgement.",
      "Request a structured interview through `contact_supervisor` when authored questions will help the orchestrator decide.",
      "Treat every `contact_supervisor` request as a waiting transition, including progress updates.",
      "Resume child work only after the orchestrator replies to `contact_supervisor`.",
    ],
    parameters: contactSupervisorParameters,
    async execute(_toolCallId, params) {
      const runId = process.env.OMPS_PARENT_RUN_ID;
      if (!runId) throw new Error("OMPS parent run identity is missing.");
      const request = {
        runId,
        reason: params.reason,
        message: params.message?.trim() || params.reason,
        interview: params.interview,
        createdAt: new Date().toISOString(),
      };
      return {
        content: [{ type: "text", text: `Yielded to supervisor for run ${runId}.` }],
        details: { request },
        terminate: true,
      };
    },
  });

  pi.on("session_start", () => {
    clearCheckpointState();
    pi.setActiveTools(pi.getAllTools().map((tool) => tool.name));
  });

  pi.on("turn_start", () => {
    contactedSupervisorThisTurn = false;
  });

  pi.on("tool_execution_end", (event) => {
    if (event.toolName === "contact_supervisor") contactedSupervisorThisTurn = true;
  });

  pi.on("turn_end", (event, ctx) => {
    if (
      !completedToolBatch(event) || pendingCheckpoint || ctx.hasPendingMessages() ||
      contactedSupervisorThisTurn
    ) return;
    const usage = ctx.getContextUsage();
    const settings = SettingsManager.create(ctx.cwd, getAgentDir(), {
      projectTrusted: ctx.isProjectTrusted(),
    }).getCompactionSettings();
    if (!contextUsageNeedsCheckpoint(usage, settings)) return;
    pendingCheckpoint = { cycle: ++checkpointCycle };
    ctx.abort();
  });

  pi.on("session_compact", (event) => {
    if (!pendingCheckpoint || event.reason !== "threshold" || event.willRetry !== false) return;
    pi.sendUserMessage(CHECKPOINT_RESUME_TEXT, { deliverAs: "followUp" });
    pendingCheckpoint = undefined;
  });

  pi.on("agent_settled", () => {
    if (!pendingCheckpoint) return;
    const cycle = pendingCheckpoint.cycle;
    pendingCheckpoint = undefined;
    console.error(`[oh-my-pi-slim] Child checkpoint cycle ${cycle} ended before Pi completed threshold compaction; automatic resume was not started.`);
  });

  pi.on("session_shutdown", clearCheckpointState);
}
