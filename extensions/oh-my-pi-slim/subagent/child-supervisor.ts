import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  applyCacheRetentionForRequest,
  CACHE_RETENTION_ENV_VAR,
  cacheRetentionFromEnv,
} from "../cache-retention.js";
import {
  applyFastServiceTier,
  FAST_ENV_VAR,
  fastEnabledFromEnv,
} from "../fast-mode.js";
import {
  CONTACT_SUPERVISOR_ERRORS,
  CONTACT_SUPERVISOR_TOOL_CONTRACT,
  contactSupervisorModelResult,
  modelJson,
} from "../tool-contracts.js";
const CACHE_RETENTION = cacheRetentionFromEnv(process.env[CACHE_RETENTION_ENV_VAR]) ?? "short";
const FAST_ENABLED = fastEnabledFromEnv(process.env[FAST_ENV_VAR]);

export default function childSupervisor(pi: ExtensionAPI): void {
  if (process.env.OMPS_SUBAGENT_CHILD !== "1" || process.env.PI_SUBAGENT_CHILD !== "1") return;

  pi.on("before_provider_request", (event, ctx) => {
    const model = ctx.model;
    const fastPayload = FAST_ENABLED ? applyFastServiceTier(event.payload, model) : undefined;
    return applyCacheRetentionForRequest(
      fastPayload ?? event.payload,
      model,
      CACHE_RETENTION,
      () => model !== undefined && ctx.modelRegistry.isUsingOAuth(model),
    ) ?? fastPayload;
  });

  pi.registerTool({
    name: CONTACT_SUPERVISOR_TOOL_CONTRACT.name,
    label: "Contact Supervisor",
    description: CONTACT_SUPERVISOR_TOOL_CONTRACT.description,
    parameters: CONTACT_SUPERVISOR_TOOL_CONTRACT.parameters,
    async execute(_toolCallId, params) {
      const runId = process.env.OMPS_PARENT_RUN_ID;
      if (!runId) throw new Error(CONTACT_SUPERVISOR_ERRORS.supervisorIdentity);
      const request = {
        runId,
        reason: params.reason,
        message: params.message?.trim() || params.reason,
        interview: params.interview,
        createdAt: new Date().toISOString(),
      };
      return {
        content: [{ type: "text", text: modelJson(contactSupervisorModelResult(params.reason)) }],
        details: { request },
        terminate: true,
      };
    },
  });

  pi.on("session_start", () => {
    pi.setActiveTools(pi.getAllTools().map((tool) => tool.name));
  });
}
