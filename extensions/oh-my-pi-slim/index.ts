import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONFIG_DIR_NAME,
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const ORCHESTRATOR_PROMPT = readFileSync(join(EXTENSION_DIR, "orchestrator.md"), "utf8").trim();
const CONFIG_FILE = "oh-my-pi-slim.json";

const SPECIALIST_NAMES = [
  "explorer",
  "librarian",
  "oracle",
  "designer",
  "fixer",
] as const;
const ROLE_NAMES = ["orchestrator", ...SPECIALIST_NAMES] as const;
const ALLOWED_AGENT_TYPES = new Set<string>(SPECIALIST_NAMES);
const THINKING_LEVELS = new Set([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

const FILE_TOOLS = new Set(["read", "edit", "write"]);
const CHILD_AGENT_TAG = /<active_agent\s+name="[^"]+"\s*\/>/;
const TRUE_VALUES = /^(1|true|yes|on)$/i;
const SAFE_PRESET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SAFE_MODEL_PART = /^[A-Za-z0-9][A-Za-z0-9._:/+@-]*$/;
const STOP_TOOL = "stop_subagent";

const PHASE_REMINDER = `<orchestration-reminder>
Scheduler workflow: understand the request; map lanes and dependencies; dispatch independent specialists in the background; track agent IDs and write ownership; do not poll running agents; reconcile automatic completion notifications; inspect the real changes; verify the result.
</orchestration-reminder>`;

type RoleName = (typeof ROLE_NAMES)[number];
type SpecialistName = (typeof SPECIALIST_NAMES)[number];
type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

interface RolePreset {
  provider: string;
  model: string;
  thinking: ThinkingLevel;
}

type Preset = Record<RoleName, RolePreset>;

interface PresetConfig {
  defaultPreset?: string;
  presets: Record<string, Preset>;
}

type RpcReply<T = void> =
  | { success: true; data?: T }
  | { success: false; error: string };

function envEnabled(): boolean {
  return TRUE_VALUES.test(String(process.env.OMPS_ENABLE ?? "").trim());
}

function envPreset(): string | undefined {
  const value = String(process.env.OMPS_PRESET ?? "").trim();
  return value || undefined;
}

function normalizeAgentType(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must be a non-empty string.`);
  }
  return value.trim();
}

function modelPart(value: unknown, field: string): string {
  const result = nonEmptyString(value, field);
  if (!SAFE_MODEL_PART.test(result)) {
    throw new Error(`${field} contains unsupported characters.`);
  }
  return result;
}

function parseRolePreset(value: unknown, field: string): RolePreset {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object.`);
  }

  const object = value as Record<string, unknown>;
  const thinking = nonEmptyString(object.thinking, `${field}.thinking`).toLowerCase();
  if (!THINKING_LEVELS.has(thinking)) {
    throw new Error(
      `${field}.thinking must be one of: ${[...THINKING_LEVELS].join(", ")}.`,
    );
  }

  return {
    provider: modelPart(object.provider, `${field}.provider`),
    model: modelPart(object.model, `${field}.model`),
    thinking: thinking as ThinkingLevel,
  };
}

function parseConfigFile(path: string): PresetConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(
      `${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${path} must contain a JSON object.`);
  }

  const object = raw as Record<string, unknown>;
  const rawPresets = object.presets;
  if (!rawPresets || typeof rawPresets !== "object" || Array.isArray(rawPresets)) {
    throw new Error(`${path}.presets must be an object.`);
  }

  const presets: Record<string, Preset> = {};
  for (const [presetName, rawPreset] of Object.entries(rawPresets as Record<string, unknown>)) {
    if (!SAFE_PRESET_NAME.test(presetName)) {
      throw new Error(
        `${path}.presets contains invalid name "${presetName}". Use letters, numbers, dot, underscore, or hyphen.`,
      );
    }
    if (!rawPreset || typeof rawPreset !== "object" || Array.isArray(rawPreset)) {
      throw new Error(`${path}.presets.${presetName} must be an object.`);
    }

    const presetObject = rawPreset as Record<string, unknown>;
    const preset = {} as Preset;
    for (const role of ROLE_NAMES) {
      preset[role] = parseRolePreset(
        presetObject[role],
        `${path}.presets.${presetName}.${role}`,
      );
    }
    presets[presetName] = preset;
  }

  const defaultPreset = object.defaultPreset === undefined
    ? undefined
    : nonEmptyString(object.defaultPreset, `${path}.defaultPreset`);

  return { defaultPreset, presets };
}

function mergeConfig(base: PresetConfig, overlay: PresetConfig): PresetConfig {
  return {
    defaultPreset: overlay.defaultPreset ?? base.defaultPreset,
    presets: { ...base.presets, ...overlay.presets },
  };
}

function loadPresetConfig(ctx: ExtensionContext): PresetConfig {
  const globalPath = join(getAgentDir(), CONFIG_FILE);
  const projectPath = join(ctx.cwd, CONFIG_DIR_NAME, CONFIG_FILE);
  let config: PresetConfig = { presets: {} };

  if (existsSync(globalPath)) config = mergeConfig(config, parseConfigFile(globalPath));

  if (existsSync(projectPath)) {
    if (!ctx.isProjectTrusted()) {
      throw new Error(
        `Refusing project preset config from untrusted project: ${projectPath}. Approve the project or use the global config at ${globalPath}.`,
      );
    }
    config = mergeConfig(config, parseConfigFile(projectPath));
  }

  if (Object.keys(config.presets).length === 0) {
    throw new Error(
      `No presets found. Create ${projectPath} or install a global config at ${globalPath}.`,
    );
  }

  if (config.defaultPreset && !config.presets[config.defaultPreset]) {
    throw new Error(
      `defaultPreset "${config.defaultPreset}" does not exist. Available presets: ${Object.keys(config.presets).join(", ")}.`,
    );
  }

  return config;
}

function fullModelName(role: RolePreset): string {
  return `${role.provider}/${role.model}`;
}

function buildPresetPrompt(name: string, preset: Preset): string {
  const specialistLines = SPECIALIST_NAMES.map((role) => {
    const config = preset[role];
    return `- ${role}: model: "${fullModelName(config)}", thinking: "${config.thinking}"`;
  }).join("\n");
  const orchestrator = preset.orchestrator;

  return `<orchestration-preset name="${name}">
The extension has selected the main orchestrator model ${fullModelName(orchestrator)} with requested thinking level ${orchestrator.thinking}.

Every fresh or scheduled Agent call MUST include the exact model and thinking values below. Calls with missing or different values are blocked by the extension:
${specialistLines}

A resumed Agent session retains its existing model and thinking. For Agent calls with resume, omit model and thinking and use the original specialist type.
</orchestration-preset>`;
}

export default function ohMyPiSlim(pi: ExtensionAPI): void {
  let active = false;
  let childSession = false;
  let nudgeSentThisUserTurn = false;
  let stopToolRegistered = false;
  let activePresetName: string | undefined;
  let activePreset: Preset | undefined;
  let originalModel: ExtensionContext["model"];
  let originalThinking: ThinkingLevel | undefined;

  pi.registerFlag("omps", {
    description: "Run the main Pi session as the oh-my-pi-slim orchestrator",
    type: "boolean",
    default: false,
  });

  pi.registerFlag("omps-preset", {
    description: `Select an oh-my-pi-slim preset from ${CONFIG_DIR_NAME}/${CONFIG_FILE}`,
    type: "string",
  });

  function report(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error"): void {
    if (ctx.hasUI) ctx.ui.notify(message, level);
    else console.error(`[oh-my-pi-slim] ${message}`);
  }

  function updateStatus(ctx: ExtensionContext): void {
    const text = active && !childSession
      ? `orchestrator${activePresetName ? `:${activePresetName}` : ""}`
      : undefined;
    ctx.ui.setStatus(
      "oh-my-pi-slim",
      text ? ctx.ui.theme.fg("accent", text) : undefined,
    );
  }

  function requestStop(agentId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const requestId = randomUUID();
      const replyEvent = `subagents:rpc:stop:reply:${requestId}`;
      let settled = false;

      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        if (error) reject(error);
        else resolve();
      };

      const unsubscribe = pi.events.on(replyEvent, (reply: RpcReply) => {
        if (reply.success) finish();
        else finish(new Error(reply.error || `Failed to stop subagent ${agentId}.`));
      });

      const timer = setTimeout(() => {
        finish(
          new Error(
            "Timed out waiting for pi-subagents. Confirm @tintinweb/pi-subagents is installed and active.",
          ),
        );
      }, 3_000);

      pi.events.emit("subagents:rpc:stop", { requestId, agentId });
    });
  }

  function ensureStopTool(): void {
    if (stopToolRegistered) return;
    stopToolRegistered = true;

    pi.registerTool({
      name: STOP_TOOL,
      label: "Stop Subagent",
      description:
        "Stop a running or queued pi-subagents agent by ID. Use only when the task is obsolete, unsafe, or conflicts with a replacement plan. Stopping does not roll back file changes.",
      promptSnippet: "Stop an obsolete or conflicting background subagent by ID",
      promptGuidelines: [
        "Use stop_subagent only for an obsolete, unsafe, or conflicting running agent; inspect partial file changes afterward because stopping is not rollback.",
      ],
      parameters: Type.Object({
        agent_id: Type.String({ description: "Agent ID returned by a background Agent call." }),
      }),
      async execute(_toolCallId, params) {
        await requestStop(params.agent_id);
        return {
          content: [
            {
              type: "text",
              text: `Stop requested for subagent ${params.agent_id}. Inspect partial changes before replacement work.`,
            },
          ],
          details: { agentId: params.agent_id },
        };
      },
    });
  }

  function resolvePresetModels(presetName: string, preset: Preset, ctx: ExtensionContext): void {
    for (const role of ROLE_NAMES) {
      const rolePreset = preset[role];
      const model = ctx.modelRegistry.find(rolePreset.provider, rolePreset.model);
      if (!model) {
        throw new Error(
          `Preset "${presetName}" role "${role}" references unknown model ${fullModelName(rolePreset)}. Use \`pi --list-models\` to choose an exact provider/model ID.`,
        );
      }
      if (!ctx.modelRegistry.hasConfiguredAuth(model)) {
        throw new Error(
          `Preset "${presetName}" role "${role}" has no configured authentication for ${fullModelName(rolePreset)}.`,
        );
      }
    }
  }

  async function activate(ctx: ExtensionContext, requestedPreset?: string): Promise<void> {
    const config = loadPresetConfig(ctx);
    const presetName = requestedPreset || config.defaultPreset;
    if (!presetName) {
      throw new Error(
        `No preset selected and no defaultPreset configured. Available presets: ${Object.keys(config.presets).join(", ")}.`,
      );
    }

    const preset = config.presets[presetName];
    if (!preset) {
      throw new Error(
        `Unknown preset "${presetName}". Available presets: ${Object.keys(config.presets).join(", ")}.`,
      );
    }

    resolvePresetModels(presetName, preset, ctx);
    const orchestratorModel = ctx.modelRegistry.find(
      preset.orchestrator.provider,
      preset.orchestrator.model,
    );
    if (!orchestratorModel) {
      throw new Error(`Model disappeared while applying preset "${presetName}".`);
    }

    if (!active) {
      originalModel = ctx.model;
      originalThinking = pi.getThinkingLevel() as ThinkingLevel;
    }

    const changed = await pi.setModel(orchestratorModel);
    if (!changed) {
      throw new Error(
        `Could not activate ${fullModelName(preset.orchestrator)} for preset "${presetName}".`,
      );
    }
    pi.setThinkingLevel(preset.orchestrator.thinking);

    active = true;
    activePresetName = presetName;
    activePreset = preset;
    nudgeSentThisUserTurn = false;
    ensureStopTool();
    updateStatus(ctx);
  }

  async function deactivate(ctx: ExtensionContext): Promise<void> {
    active = false;
    activePresetName = undefined;
    activePreset = undefined;
    nudgeSentThisUserTurn = false;
    if (originalModel) await pi.setModel(originalModel);
    if (originalThinking) pi.setThinkingLevel(originalThinking);
    originalModel = undefined;
    originalThinking = undefined;
    updateStatus(ctx);
  }

  pi.registerCommand("omps", {
    description: "Manage orchestration: /omps [on [preset]|off|status|presets|preset <name>]",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const action = (parts[0] ?? "on").toLowerCase();

      if (action === "status") {
        report(
          ctx,
          active
            ? `oh-my-pi-slim is enabled with preset "${activePresetName}".`
            : "oh-my-pi-slim is disabled.",
          "info",
        );
        return;
      }

      if (action === "presets") {
        try {
          const config = loadPresetConfig(ctx);
          report(
            ctx,
            `Available presets: ${Object.keys(config.presets).join(", ")}. Default: ${config.defaultPreset ?? "none"}.`,
            "info",
          );
        } catch (error) {
          report(ctx, error instanceof Error ? error.message : String(error), "error");
        }
        return;
      }

      if (action === "off") {
        await deactivate(ctx);
        report(ctx, "oh-my-pi-slim orchestrator disabled for this session.", "info");
        return;
      }

      const requestedPreset = action === "preset" ? parts[1] : action === "on" ? parts[1] : undefined;
      if (action === "preset" && !requestedPreset) {
        report(ctx, "Usage: /omps preset <name>", "warning");
        return;
      }
      if (action !== "on" && action !== "preset") {
        report(ctx, "Usage: /omps [on [preset]|off|status|presets|preset <name>]", "warning");
        return;
      }

      try {
        await activate(ctx, requestedPreset);
        report(ctx, `oh-my-pi-slim enabled with preset "${activePresetName}".`, "info");
      } catch (error) {
        report(ctx, error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    childSession = false;
    active = false;
    activePresetName = undefined;
    activePreset = undefined;
    originalModel = undefined;
    originalThinking = undefined;
    nudgeSentThisUserTurn = false;

    const flagPreset = pi.getFlag("omps-preset");
    const requestedPreset = typeof flagPreset === "string" && flagPreset.trim()
      ? flagPreset.trim()
      : envPreset();
    const shouldActivate = pi.getFlag("omps") === true || envEnabled() || requestedPreset !== undefined;

    if (shouldActivate) {
      try {
        await activate(ctx, requestedPreset);
      } catch (error) {
        report(ctx, error instanceof Error ? error.message : String(error), "error");
      }
    }
    updateStatus(ctx);
  });

  pi.on("input", (event) => {
    if (!active || childSession) return;
    if (event.source !== "extension") nudgeSentThisUserTurn = false;
  });

  pi.on("before_agent_start", (event, ctx) => {
    // pi-subagents places this tag in every child session. The orchestrator
    // prompt and main-session gates must never be injected into a specialist.
    if (CHILD_AGENT_TAG.test(event.systemPrompt)) {
      childSession = true;
      updateStatus(ctx);
      return;
    }

    if (!active || !activePreset || !activePresetName) return;

    return {
      systemPrompt: `${event.systemPrompt}\n\n${ORCHESTRATOR_PROMPT}\n\n${buildPresetPrompt(activePresetName, activePreset)}`,
      message: {
        customType: "oh-my-pi-slim:phase-reminder",
        content: PHASE_REMINDER,
        display: false,
      },
    };
  });

  pi.on("tool_call", (event) => {
    if (!active || childSession || event.toolName !== "Agent") return;

    const input = event.input as {
      subagent_type?: unknown;
      model?: unknown;
      thinking?: unknown;
      resume?: unknown;
    };
    const requested = normalizeAgentType(input.subagent_type);
    if (!ALLOWED_AGENT_TYPES.has(requested)) {
      return {
        block: true,
        reason:
          "oh-my-pi-slim: the orchestrator may only launch explorer, librarian, oracle, designer, or fixer. Unknown and built-in agent types are not allowed.",
      };
    }

    // pi-subagents resumes the existing in-memory session and ignores model and
    // thinking overrides. Every original spawn was preset-gated, so resume is safe.
    if (typeof input.resume === "string" && input.resume.trim()) return;

    if (!activePreset || !activePresetName) {
      return { block: true, reason: "oh-my-pi-slim: no active preset is available." };
    }

    const role = requested as SpecialistName;
    const expected = activePreset[role];
    const expectedModel = fullModelName(expected);
    const actualModel = typeof input.model === "string" ? input.model.trim() : "";
    const actualThinking = typeof input.thinking === "string"
      ? input.thinking.trim().toLowerCase()
      : "";

    if (
      actualModel.toLowerCase() !== expectedModel.toLowerCase() ||
      actualThinking !== expected.thinking
    ) {
      return {
        block: true,
        reason:
          `oh-my-pi-slim preset "${activePresetName}" requires ${role} Agent calls to include ` +
          `model: "${expectedModel}" and thinking: "${expected.thinking}". Retry with those exact values.`,
      };
    }
  });

  pi.on("tool_execution_end", (event) => {
    if (!active || childSession || nudgeSentThisUserTurn || !FILE_TOOLS.has(event.toolName)) return;

    nudgeSentThisUserTurn = true;
    pi.sendMessage(
      {
        customType: "oh-my-pi-slim:file-nudge",
        content: PHASE_REMINDER,
        display: false,
      },
      { deliverAs: "steer", triggerTurn: true },
    );
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    // pi.setModel()/setThinkingLevel() update Pi's defaults as well as the live
    // session. Restore the pre-preset state so a startup preset remains scoped
    // to this orchestration session.
    if (active) {
      active = false;
      if (originalModel) await pi.setModel(originalModel);
      if (originalThinking) pi.setThinkingLevel(originalThinking);
    }
    activePresetName = undefined;
    activePreset = undefined;
    originalModel = undefined;
    originalThinking = undefined;
    ctx.ui.setStatus("oh-my-pi-slim", undefined);
  });
}
