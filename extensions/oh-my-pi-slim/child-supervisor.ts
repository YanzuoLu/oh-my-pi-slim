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
import {
  applyCacheRetentionForRequest,
  CACHE_RETENTION_ENV_VAR,
  cacheRetentionFromEnv,
} from "./cache-retention.js";
const CACHE_RETENTION = cacheRetentionFromEnv(process.env[CACHE_RETENTION_ENV_VAR]) ?? "short";
const REASONS = ["need_decision", "interview_request", "progress_update"] as const;

export const contactSupervisorParameters = Type.Object({
  reason: Type.Union(REASONS.map((reason) => Type.Literal(reason)), {
    description: "Request type: need_decision, interview_request, or progress_update.",
  }),
  message: Type.Optional(Type.String({
    description: "Complete context the orchestrator needs to respond. Defaults to the selected reason when omitted or blank.",
  })),
  interview: Type.Optional(Type.Object({
    title: Type.Optional(Type.String({ description: "Optional short interview title." })),
    questions: Type.Optional(Type.Array(Type.Object({
      id: Type.Optional(Type.String({ description: "Optional short identifier for matching a question." })),
      prompt: Type.String({ description: "Question the orchestrator should answer." }),
      options: Type.Optional(Type.Array(Type.String(), { description: "Optional authored answer choices." })),
    }), { description: "Authored interview questions in display order." })),
  }, { description: "Structured interview details for interview_request." })),
}, { additionalProperties: false });

export default function childSupervisor(pi: ExtensionAPI): void {
  if (process.env.OMPS_SUBAGENT_CHILD !== "1" || process.env.PI_SUBAGENT_CHILD !== "1") return;

  pi.on("before_provider_request", (event, ctx) => {
    const model = ctx.model;
    return applyCacheRetentionForRequest(
      event.payload,
      model,
      CACHE_RETENTION,
      () => model !== undefined && ctx.modelRegistry.isUsingOAuth(model),
    );
  });

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
    description: "Request an orchestrator response for a decision, structured interview, or progress update. Every call moves the child run to waiting, including progress updates. The result records the request context and ends the current child turn. Work continues in the same run after the orchestrator replies.",
    promptSnippet: "Request an orchestrator response.",
    promptGuidelines: [
      "Use `contact_supervisor` whenever child work requires an orchestrator reply.",
      "Every `contact_supervisor` reason waits for that reply, including `progress_update`.",
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
        content: [{ type: "text", text: JSON.stringify({ status: "waiting", reason: params.reason }) }],
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
