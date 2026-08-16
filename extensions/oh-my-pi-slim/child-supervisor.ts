import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const REASONS = ["need_decision", "interview_request", "progress_update"] as const;

export default function childSupervisor(pi: ExtensionAPI): void {
  if (process.env.OMPS_SUBAGENT_CHILD !== "1" || process.env.PI_SUBAGENT_CHILD !== "1") return;

  pi.registerTool({
    name: "contact_supervisor",
    label: "Contact Supervisor",
    description: "Create a supervisor request and move the child run to waiting for an orchestrator reply.",
    promptSnippet: "Create a supervisor request and pause until reply.",
    promptGuidelines: [
      "A call includes reason; optional message adds request context; optional interview carries structured questions.",
      "contact_supervisor returns a request ID and moves the run to waiting; a reply continues the same run ID with saved child-session context.",
      "contact_supervisor reason is need_decision, interview_request, or progress_update; every reason, including progress_update, follows the waiting and reply flow.",
    ],
    parameters: Type.Object({

      reason: Type.Union(REASONS.map((reason) => Type.Literal(reason)), {
        description: "Supervisor request type",
      }),
      message: Type.Optional(Type.String({ description: "Request context for the main orchestrator" })),
      interview: Type.Optional(Type.Object({
        title: Type.Optional(Type.String({ description: "Structured interview title" })),
        questions: Type.Optional(Type.Array(Type.Object({
          id: Type.Optional(Type.String({ description: "Question identifier" })),
          prompt: Type.String({ description: "Question text" }),
          options: Type.Optional(Type.Array(Type.String(), { description: "Answer options" })),
        }), { description: "Structured interview questions" })),
      }, { description: "Structured interview details" })),
    }),
    async execute(_toolCallId, params) {
      const runId = process.env.OMPS_PARENT_RUN_ID;
      if (!runId) throw new Error("OMPS parent run identity is missing.");
      const request = {
        id: randomUUID().slice(0, 8),
        runId,
        reason: params.reason,
        message: params.message?.trim() || params.reason,
        interview: params.interview,
        createdAt: new Date().toISOString(),
      };
      return {
        content: [{ type: "text", text: `Yielded to supervisor request ${request.id}.` }],
        details: { request },
        terminate: true,
      };
    },
  });

  pi.on("session_start", () => {
    pi.setActiveTools(pi.getAllTools().map((tool) => tool.name));
  });
}
