import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONFIG_DIR_NAME,
  getAgentDir,
  loadProjectContextFiles,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ensurePackageAssets, removePackageAssets } from "./bootstrap.js";
import {
  cancelledResumeOutcome,
  resumeCompletedRecord,
  type ResumeOutcome,
  type SubagentRegistry,
} from "./auto-resume.js";
import { AgentOperationClaims } from "./operation-claims.js";
import {
  injectSharedProjectContext,
  injectToolGuidance,
  removeChildPiIdentity,
  removeMainPiIdentity,
  renderProjectContext,
  renderToolGuidance,
} from "./prompt-context.js";

const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(EXTENSION_DIR, "../..");
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
const CHILD_AGENT_TAG = /^<active_agent\s+name="[^"]+"\s*\/>/;
const TRUE_VALUES = /^(1|true|yes|on)$/i;
const SAFE_PRESET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SAFE_MODEL_PART = /^[A-Za-z0-9][A-Za-z0-9._:/+@-]*$/;
const STOP_TOOL = "stop_subagent";
const STEER_TOOL = "steer_subagent";
const SUBAGENT_MANAGER_KEY = Symbol.for("pi-subagents:manager");

const PHASE_REMINDER = `<orchestration-reminder>
Scheduler workflow: understand the request; map lanes and dependencies; dispatch independent specialists in the background; track agent IDs and write ownership; do not poll running agents; reconcile automatic completion notifications; inspect the real changes; verify the result.
</orchestration-reminder>`;

type RoleName = (typeof ROLE_NAMES)[number];
type SpecialistName = (typeof SPECIALIST_NAMES)[number];
type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
type SessionRole = "unknown" | "main" | "child";

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

function combinedResumeResult(outcome: ResumeOutcome): string {
  const previous = outcome.previousResult.trim() || "(no previous output)";
  const resumed = outcome.newResult.trim() || "(no new output)";
  const action = outcome.failure
    ? "oh-my-pi-slim could not automatically resume the same session."
    : "oh-my-pi-slim automatically resumed the same session with the steering message.";
  const failure = outcome.failure ? `\n\nAutomatic resume failed: ${outcome.failure}` : "";
  return `Agent ${outcome.agentId} had already ${outcome.previousStatus}. ${action}\n\n` +
    `Previous result:\n${previous}\n\nResumed result:\n${resumed}${failure}`;
}

function toolResultText(content: Array<{ type?: string; text?: string }>): string {
  return content
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n");
}

function isCompletedSteerRejection(text: string, agentId: string): boolean {
  return text.includes(`Agent "${agentId}" is not running`) &&
    /\(status: (completed|steered)\)/.test(text) &&
    text.includes("Cannot steer a non-running agent.");
}

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

function availablePresetsMessage(config: PresetConfig): string {
  return `Available presets: ${Object.keys(config.presets).join(", ")}. Default: ${config.defaultPreset ?? "none"}.\nUsage: /preset <name>`;
}

function isAnthropicOAuth(ctx: ExtensionContext): boolean {
  return ctx.model?.provider === "anthropic" &&
    ctx.model?.api === "anthropic-messages" &&
    ctx.modelRegistry.isUsingOAuth(ctx.model);
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
  ensurePackageAssets(PACKAGE_ROOT);

  let active = false;
  let sessionRole: SessionRole = "unknown";
  let pendingActivation: { shouldActivate: boolean; requestedPreset?: string } | undefined;
  let childProjectContext: string | undefined;
  let nudgeSentThisUserTurn = false;
  let stopToolRegistered = false;
  let activePresetName: string | undefined;
  let activePreset: Preset | undefined;
  let originalModel: ExtensionContext["model"];
  let originalThinking: ThinkingLevel | undefined;
  const resumeLocks = new Map<string, Promise<void>>();
  const operationClaims = new AgentOperationClaims();

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
    const text = active && sessionRole === "main"
      ? `orchestrator${activePresetName ? `:${activePresetName}` : ""}`
      : undefined;
    ctx.ui.setStatus(
      "oh-my-pi-slim",
      text ? ctx.ui.theme.fg("accent", text) : undefined,
    );
  }

  function subagentRegistry(): SubagentRegistry | undefined {
    const value = (globalThis as Record<PropertyKey, unknown>)[SUBAGENT_MANAGER_KEY];
    if (!value || typeof value !== "object") return undefined;
    const registry = value as Partial<SubagentRegistry>;
    return typeof registry.getRecord === "function" ? registry as SubagentRegistry : undefined;
  }

  async function withResumeLock<T>(agentId: string, operation: () => Promise<T>): Promise<T> {
    const previous = resumeLocks.get(agentId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.catch(() => {}).then(() => current);
    resumeLocks.set(agentId, queued);
    await previous.catch(() => {});
    try {
      return await operation();
    } finally {
      release();
      if (resumeLocks.get(agentId) === queued) resumeLocks.delete(agentId);
    }
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

  pi.registerCommand("preset", {
    description: "Switch the oh-my-pi-slim preset: /preset <name>",
    handler: async (args, ctx) => {
      if (sessionRole === "child") return;
      if (sessionRole === "unknown") {
        sessionRole = "main";
        pendingActivation = undefined;
        updateStatus(ctx);
      }

      const requestedPreset = args.trim();
      if (!requestedPreset) {
        try {
          const config = loadPresetConfig(ctx);
          report(ctx, availablePresetsMessage(config), "info");
        } catch (error) {
          report(ctx, error instanceof Error ? error.message : String(error), "error");
        }
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

  pi.registerCommand("omps", {
    description: "Manage orchestration: /omps [on [preset]|off|status|presets|preset <name>|uninstall]",
    handler: async (args, ctx) => {
      if (sessionRole === "child") return;
      if (sessionRole === "unknown") {
        sessionRole = "main";
        pendingActivation = undefined;
        updateStatus(ctx);
      }
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const action = (parts[0] ?? "on").toLowerCase();

      if (action === "uninstall") {
        if (active) await deactivate(ctx);
        const cleanup = removePackageAssets();
        const summary = [
          `${cleanup.removed.length} package-created file(s) removed.`,
          `${cleanup.preserved.length} pre-existing file(s) preserved.`,
          ...cleanup.warnings,
          "Exit Pi, then run: pi remove git:github.com/YanzuoLu/oh-my-pi-slim",
        ].join("\n");
        report(ctx, summary, cleanup.warnings.length > 0 ? "warning" : "info");
        return;
      }

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
        report(ctx, "Usage: /omps [on [preset]|off|status|presets|preset <name>|uninstall]", "warning");
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
    sessionRole = "unknown";
    pendingActivation = undefined;
    childProjectContext = undefined;
    active = false;
    activePresetName = undefined;
    activePreset = undefined;
    originalModel = undefined;
    originalThinking = undefined;
    nudgeSentThisUserTurn = false;

    let basePrompt = "";
    try {
      basePrompt = ctx.getSystemPrompt();
    } catch {
      basePrompt = "";
    }
    if (basePrompt && CHILD_AGENT_TAG.test(basePrompt)) {
      sessionRole = "child";
      return;
    }

    const flagPreset = pi.getFlag("omps-preset");
    const requestedPreset = typeof flagPreset === "string" && flagPreset.trim()
      ? flagPreset.trim()
      : envPreset();
    const shouldActivate = pi.getFlag("omps") === true || envEnabled() || requestedPreset !== undefined;

    if (!basePrompt) {
      pendingActivation = { shouldActivate, requestedPreset };
      return;
    }

    sessionRole = "main";
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
    if (!active || sessionRole !== "main") return;
    if (event.source !== "extension") nudgeSentThisUserTurn = false;
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (CHILD_AGENT_TAG.test(event.systemPrompt)) {
      pendingActivation = undefined;
      if (sessionRole !== "child" && active) await deactivate(ctx);
      sessionRole = "child";
    } else if (sessionRole === "unknown") {
      sessionRole = "main";
      const pending = pendingActivation;
      pendingActivation = undefined;
      if (pending?.shouldActivate) {
        try {
          await activate(ctx, pending.requestedPreset);
        } catch (error) {
          report(ctx, error instanceof Error ? error.message : String(error), "error");
        }
      }
      updateStatus(ctx);
    }

    if (sessionRole === "child") {
      if (childProjectContext === undefined) {
        childProjectContext = renderProjectContext(loadProjectContextFiles({
          cwd: ctx.cwd,
          agentDir: getAgentDir(),
        }));
      }
      const toolGuidance = renderToolGuidance(event.systemPromptOptions);
      let systemPrompt = injectToolGuidance(event.systemPrompt, toolGuidance);
      systemPrompt = injectSharedProjectContext(systemPrompt, childProjectContext);
      if (isAnthropicOAuth(ctx)) systemPrompt = removeChildPiIdentity(systemPrompt);
      return { systemPrompt };
    }

    if (!active || !activePreset || !activePresetName) return;

    let systemPrompt = event.systemPrompt;
    if (isAnthropicOAuth(ctx)) systemPrompt = removeMainPiIdentity(systemPrompt);
    return {
      systemPrompt: `${systemPrompt}\n\n${ORCHESTRATOR_PROMPT}\n\n${buildPresetPrompt(activePresetName, activePreset)}`,
      message: {
        customType: "oh-my-pi-slim:phase-reminder",
        content: PHASE_REMINDER,
        display: false,
      },
    };
  });

  pi.on("tool_call", (event) => {
    if (!active || sessionRole !== "main") return;

    if (event.toolName === STEER_TOOL) {
      const input = event.input as { agent_id?: unknown };
      if (typeof input.agent_id !== "string" || !input.agent_id.trim()) return;
      const agentId = input.agent_id.trim();
      let status: unknown;
      try {
        status = (subagentRegistry()?.getRecord(agentId) as { status?: unknown } | undefined)?.status;
      } catch {
        status = undefined;
      }
      const claim = operationClaims.claimSteer(agentId, event.toolCallId, status);
      if (!claim.allowed) {
        return {
          block: true,
          reason: `oh-my-pi-slim: agent ${agentId} already has an in-flight ${claim.conflict?.kind} operation. The first operation wins; wait for its tool result.`,
        };
      }
      return;
    }

    if (event.toolName !== "Agent") return;
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
    if (typeof input.resume === "string" && input.resume.trim()) {
      const resumeId = input.resume.trim();
      const claim = operationClaims.claimExplicitResume(resumeId, event.toolCallId);
      if (!claim.allowed) {
        return {
          block: true,
          reason: `oh-my-pi-slim: agent ${resumeId} already has an in-flight ${claim.conflict?.kind} operation. The first operation wins; wait for its tool result.`,
        };
      }
      return;
    }

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

  pi.on("tool_result", async (event, ctx) => {
    if (!active || sessionRole !== "main" || event.toolName !== STEER_TOOL || event.isError) return;
    const input = event.input as { agent_id?: unknown; message?: unknown };
    if (typeof input.agent_id !== "string" || typeof input.message !== "string") return;
    if (!isCompletedSteerRejection(toolResultText(event.content), input.agent_id)) return;

    const rejectedStatus = toolResultText(event.content).includes("(status: steered)")
      ? "steered"
      : "completed";
    const registry = subagentRegistry();
    let outcome: ResumeOutcome;
    try {
      outcome = await withResumeLock(input.agent_id, async () => {
        if (ctx.signal?.aborted) {
          return cancelledResumeOutcome(registry, input.agent_id as string, rejectedStatus);
        }
        return resumeCompletedRecord(
          registry,
          input.agent_id as string,
          input.message as string,
          rejectedStatus,
          {
            emit: (name, data) => pi.events.emit(name, data),
            append: (data) => pi.appendEntry("subagents:record", data),
          },
          ctx.signal,
        );
      });
    } catch (error) {
      outcome = {
        ...cancelledResumeOutcome(registry, input.agent_id, rejectedStatus),
        status: ctx.signal?.aborted ? "aborted" : "error",
        failure: ctx.signal?.aborted
          ? "Automatic resume was cancelled before completion."
          : `Automatic resume failed unexpectedly: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    return {
      content: [{ type: "text", text: combinedResumeResult(outcome) }],
      details: {
        ...(event.details && typeof event.details === "object" ? event.details : {}),
        agentId: outcome.agentId,
        previousStatus: outcome.previousStatus,
        status: outcome.status,
        autoResumeAttempted: true,
        autoResumed: outcome.status === "completed",
      },
      isError: outcome.status !== "completed",
    };
  });

  pi.on("tool_execution_end", (event) => {
    operationClaims.releaseToolCall(event.toolCallId);
    if (!active || sessionRole !== "main" || nudgeSentThisUserTurn || !FILE_TOOLS.has(event.toolName)) return;

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
    operationClaims.clear();
    resumeLocks.clear();

    // pi.setModel()/setThinkingLevel() update Pi's defaults as well as the live
    // session. Restore the pre-preset state so a startup preset remains scoped
    // to this orchestration session.
    if (active) {
      active = false;
      if (originalModel) await pi.setModel(originalModel);
      if (originalThinking) pi.setThinkingLevel(originalThinking);
    }
    sessionRole = "unknown";
    pendingActivation = undefined;
    childProjectContext = undefined;
    activePresetName = undefined;
    activePreset = undefined;
    originalModel = undefined;
    originalThinking = undefined;
    ctx.ui.setStatus("oh-my-pi-slim", undefined);
  });
}
