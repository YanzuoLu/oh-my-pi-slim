import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONFIG_DIR_NAME,
  getAgentDir,
  SettingsManager,
  shouldCompact,
  type ExtensionAPI,
  type ExtensionContext,
  type TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import {
  ensureNativePackageSetup,
  getDefaultPresetPath,
  restoreNativePackageSetup,
} from "./bootstrap.js";
import {
  removeMainPiDocumentation,
  removeMainPiIdentity,
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
const LEGACY_TINTIN_FACADE = [
  "Agent",
  "get_subagent_result",
  "steer_subagent",
] as const;
const REQUIRED_NATIVE_TOOLS = ["subagent", "subagent_wait"] as const;
const DENIED_ACTIONS = new Set([
  "create",
  "update",
  "delete",
  "eject",
  "enable",
  "append-step",
  "refine",
  "refine.show",
  "refine.rollback",
]);
const RESUME_LAUNCH_OVERRIDE_FIELDS = [
  "agent",
  "model",
  "thinking",
  "turnBudget",
] as const;
const FORBIDDEN_SCHEDULE_CHILD_FIELDS = new Set([
  "action",
  "workflowScript",
  "tasks",
  "chain",
  "parallel",
  "step",
  "steps",
  "config",
  "concurrency",
  "chainDir",
]);
const FILE_TOOLS = new Set(["read", "edit", "write"]);
const TRUE_VALUES = /^(1|true|yes|on)$/i;
const SAFE_PRESET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SAFE_MODEL_PART = /^[A-Za-z0-9][A-Za-z0-9._:/+@-]*$/;
const CANONICAL_SCHEDULE_SCRIPT = /^\s*return\s+runs\.run\s*\(\s*("(?:\\.|[^"\\])*")\s*,\s*(\{[\s\S]*\})\s*\)\s*;?\s*$/;

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

type MutableInput = Record<string, unknown>;

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function envEnabled(): boolean {
  return TRUE_VALUES.test(String(process.env.OMPS_ENABLE ?? "").trim());
}

function envPreset(): string | undefined {
  const value = String(process.env.OMPS_PRESET ?? "").trim();
  return value || undefined;
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
  const packagePath = getDefaultPresetPath(PACKAGE_ROOT);
  if (!existsSync(packagePath)) {
    throw new Error(`Package preset is missing: ${packagePath}`);
  }

  let config = parseConfigFile(packagePath);
  if (Object.keys(config.presets).length === 0) {
    throw new Error(`Package preset contains no presets: ${packagePath}`);
  }

  const globalPath = join(getAgentDir(), CONFIG_FILE);
  if (existsSync(globalPath)) {
    config = mergeConfig(config, parseConfigFile(globalPath));
  }

  const projectPath = join(ctx.cwd, CONFIG_DIR_NAME, CONFIG_FILE);
  if (existsSync(projectPath)) {
    if (!ctx.isProjectTrusted()) {
      throw new Error(
        `Refusing project preset config from untrusted project: ${projectPath}. Approve the project or use the compatibility user config at ${globalPath}.`,
      );
    }
    config = mergeConfig(config, parseConfigFile(projectPath));
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

function launchModelName(role: RolePreset): string {
  return `${fullModelName(role)}:${role.thinking}`;
}

function availablePresetsMessage(config: PresetConfig): string {
  return `Available presets: ${Object.keys(config.presets).join(", ")}. Default: ${config.defaultPreset ?? "none"}.\nUsage: /preset <name>`;
}

function isAnthropicOAuth(ctx: ExtensionContext): boolean {
  return ctx.model?.provider === "anthropic" &&
    ctx.model?.api === "anthropic-messages" &&
    ctx.modelRegistry.isUsingOAuth(ctx.model);
}

function toolSourceText(tool: unknown): string {
  if (!tool || typeof tool !== "object") return "";
  const object = tool as Record<string, unknown>;
  const sourceInfo = object.sourceInfo;
  const info = sourceInfo && typeof sourceInfo === "object"
    ? sourceInfo as Record<string, unknown>
    : {};
  return [object.provenance, info.provenance, info.path, info.source, info.baseDir]
    .filter((value): value is string => typeof value === "string")
    .join("\n");
}

function assertNativeBackend(pi: ExtensionAPI): void {
  const tools = pi.getAllTools();
  const legacy = tools.find((tool) =>
    toolSourceText(tool).includes("@tintinweb/pi-subagents")
  );
  if (legacy) {
    throw new Error(
      `oh-my-pi-slim refuses legacy @tintinweb/pi-subagents tool "${legacy.name}" from ${toolSourceText(legacy) || "unknown source"}. Remove the legacy backend before starting Pi.`,
    );
  }

  const names = new Set(tools.map((tool) => tool.name));
  if (LEGACY_TINTIN_FACADE.every((name) => names.has(name))) {
    throw new Error(
      `oh-my-pi-slim refuses the legacy pi-subagents facade: ${LEGACY_TINTIN_FACADE.join(", ")}. Remove the legacy backend before starting Pi.`,
    );
  }

  const missing = REQUIRED_NATIVE_TOOLS.filter((name) => !names.has(name));
  if (missing.length > 0) {
    throw new Error(
      `oh-my-pi-slim requires pi-subagents@0.49.0 to load first. Missing native tool(s): ${missing.join(", ")}.`,
    );
  }
}

function presetRole(value: unknown): SpecialistName {
  if (typeof value !== "string") {
    throw new Error("agent must be one of explorer, librarian, oracle, designer, or fixer.");
  }
  const agent = value.trim();
  if (!ALLOWED_AGENT_TYPES.has(agent)) {
    throw new Error(
      `agent "${agent || "(empty)"}" is not allowed. Use the exact bare name explorer, librarian, oracle, designer, or fixer.`,
    );
  }
  return agent as SpecialistName;
}

function applyFreshPreset(child: MutableInput, preset: Preset): void {
  const role = presetRole(child.agent);
  child.agent = role;
  child.model = launchModelName(preset[role]);
  delete child.thinking;
  delete child.turnBudget;
}

function resumeOverrideFields(input: MutableInput): string[] {
  return RESUME_LAUNCH_OVERRIDE_FIELDS.filter((field) => hasOwn(input, field));
}

function parseCanonicalScheduleScript(script: unknown): { key: string; child: MutableInput } {
  if (typeof script !== "string") {
    throw new Error("schedule.create requires a canonical workflowScript string.");
  }
  const match = CANONICAL_SCHEDULE_SCRIPT.exec(script);
  if (!match) {
    throw new Error(
      "schedule.create workflowScript must be exactly: return runs.run(<JSON string key>, <strict JSON object child>);",
    );
  }

  let key: unknown;
  let child: unknown;
  try {
    key = JSON.parse(match[1]);
    child = JSON.parse(match[2]);
  } catch (error) {
    throw new Error(
      `schedule.create workflowScript must contain strict JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (typeof key !== "string") {
    throw new Error("schedule.create runs.run key must be a JSON string.");
  }
  const normalizedKey = key.trim();
  if (!normalizedKey) {
    throw new Error("schedule.create runs.run key must be non-empty after trimming.");
  }
  if (!child || typeof child !== "object" || Array.isArray(child)) {
    throw new Error("schedule.create runs.run child must be a strict JSON object.");
  }
  return { key: normalizedKey, child: child as MutableInput };
}

function mutateScheduleCreate(input: MutableInput, preset: Preset): void {
  const { key, child } = parseCanonicalScheduleScript(input.workflowScript);
  const forbidden = Object.keys(child).filter((field) => FORBIDDEN_SCHEDULE_CHILD_FIELDS.has(field));
  if (forbidden.length > 0) {
    throw new Error(`schedule.create child cannot contain management or nested fields: ${forbidden.join(", ")}.`);
  }

  if (hasOwn(child, "task") && typeof child.task !== "string") {
    throw new Error("schedule.create child task must be a string when provided.");
  }

  if (hasOwn(child, "resume")) {
    if (typeof child.resume !== "string" || !child.resume.trim()) {
      throw new Error("schedule.create resume must be a non-empty retained run ID.");
    }
    if (hasOwn(child, "agent")) {
      throw new Error("schedule.create resume child cannot also specify agent.");
    }
    const overrides = resumeOverrideFields(child);
    if (overrides.length > 0) {
      throw new Error(
        `schedule.create resume preserves the source run contract; remove launch override field(s): ${overrides.join(", ")}.`,
      );
    }
    child.resume = child.resume.trim();
  } else {
    applyFreshPreset(child, preset);
  }

  input.workflowScript = `return runs.run(${JSON.stringify(key)}, ${JSON.stringify(child)});`;
  delete input.model;
  delete input.thinking;
  delete input.turnBudget;
}

interface CheckpointTool {
  id: string;
  name: string;
}

function completedToolBatch(event: TurnEndEvent): CheckpointTool[] | undefined {
  if (event.message.role !== "assistant" || event.message.stopReason !== "toolUse") return;

  const tools: CheckpointTool[] = [];
  const callsById = new Map<string, string>();
  for (const content of event.message.content) {
    if (content.type !== "toolCall") continue;
    if (callsById.has(content.id)) return;
    callsById.set(content.id, content.name);
    tools.push({ id: content.id, name: content.name });
  }
  if (tools.length === 0 || event.toolResults.length !== tools.length) return;

  const resultIds = new Set<string>();
  for (const result of event.toolResults) {
    if (resultIds.has(result.toolCallId)) return;
    resultIds.add(result.toolCallId);
    if (callsById.get(result.toolCallId) !== result.toolName) return;
  }

  return tools;
}

export default function ohMyPiSlim(pi: ExtensionAPI): void {
  if (process.env.PI_SUBAGENT_CHILD === "1") return;

  let active = false;
  let nudgeSentThisUserTurn = false;
  let activePresetName: string | undefined;
  let activePreset: Preset | undefined;
  let originalModel: ExtensionContext["model"];
  let originalThinking: ThinkingLevel | undefined;
  let sessionCtx: ExtensionContext | undefined;
  let sessionEpoch = 0;
  let pendingCheckpoint: {
    epoch: number;
    tools: CheckpointTool[];
    sawThresholdCompaction: boolean;
    resumeScheduled: boolean;
  } | undefined;
  let fileToolSeenThisTurn = false;

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
    if (!ctx.hasUI) return;
    const text = active ? `orchestrator${activePresetName ? `:${activePresetName}` : ""}` : undefined;
    ctx.ui.setStatus(
      "oh-my-pi-slim",
      text ? ctx.ui.theme.fg("accent", text) : undefined,
    );
  }

  function invalidateCheckpoint(): void {
    sessionEpoch += 1;
    pendingCheckpoint = undefined;
    fileToolSeenThisTurn = false;
  }

  function scheduleCheckpointResume(
    checkpoint: NonNullable<typeof pendingCheckpoint>,
    ctx: ExtensionContext,
  ): void {
    if (pendingCheckpoint !== checkpoint || checkpoint.resumeScheduled) return;
    checkpoint.resumeScheduled = true;

    setImmediate(() => {
      if (
        pendingCheckpoint !== checkpoint ||
        checkpoint.epoch !== sessionEpoch ||
        !active
      ) return;

      pendingCheckpoint = undefined;
      const completedTools = checkpoint.tools.map(({ id, name }) => `- ${id}: ${name}`).join("\n");
      const resumeText = `This is a new post-compaction turn, not a transparent continuation.\n\nCompleted tool calls at the checkpoint:\n${completedTools}\n\nContinue from the compacted context. Do not repeat these calls solely because the turn restarted. Re-fetch only when needed to verify state or recover missing information.`;
      report(
        ctx,
        "Pi compaction completed; starting a best-effort extension user turn from the checkpoint.",
        "warning",
      );
      pi.sendUserMessage(resumeText, { deliverAs: "followUp" });
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
    assertNativeBackend(pi);
    ensureNativePackageSetup(PACKAGE_ROOT);

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
    updateStatus(ctx);
  }

  async function deactivate(ctx: ExtensionContext): Promise<void> {
    invalidateCheckpoint();
    active = false;
    activePresetName = undefined;
    activePreset = undefined;
    nudgeSentThisUserTurn = false;
    if (originalModel) await pi.setModel(originalModel);
    if (originalThinking !== undefined) pi.setThinkingLevel(originalThinking);
    originalModel = undefined;
    originalThinking = undefined;
    updateStatus(ctx);
  }

  pi.registerCommand("preset", {
    description: "Switch the oh-my-pi-slim preset: /preset <name>",
    getArgumentCompletions: (argumentPrefix) => {
      if (!sessionCtx) return null;
      let config: PresetConfig;
      try {
        config = loadPresetConfig(sessionCtx);
      } catch {
        return null;
      }
      const query = argumentPrefix.trim().toLowerCase();
      const items = Object.entries(config.presets)
        .filter(([name]) => name.toLowerCase().includes(query))
        .map(([name, preset]) => ({
          value: name,
          label: name,
          description: name === config.defaultPreset
            ? `${fullModelName(preset.orchestrator)} ${preset.orchestrator.thinking} · default`
            : `${fullModelName(preset.orchestrator)} ${preset.orchestrator.thinking}`,
        }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      const requestedPreset = args.trim();
      if (!requestedPreset) {
        try {
          report(ctx, availablePresetsMessage(loadPresetConfig(ctx)), "info");
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
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const action = (parts[0] ?? "on").toLowerCase();

      if (action === "uninstall") {
        if (active) await deactivate(ctx);
        const cleanup = restoreNativePackageSetup();
        const summary = [
          "Restored the native pi-subagents user settings and backend config recorded before oh-my-pi-slim setup.",
          `Removed empty restored file(s): ${cleanup.removed.length}.`,
          `Preserved restored file(s): ${cleanup.preserved.length}.`,
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
    invalidateCheckpoint();
    sessionCtx = ctx;
    active = false;
    activePresetName = undefined;
    activePreset = undefined;
    originalModel = undefined;
    originalThinking = undefined;
    nudgeSentThisUserTurn = false;

    try {
      assertNativeBackend(pi);
      ensureNativePackageSetup(PACKAGE_ROOT);
    } catch (error) {
      report(ctx, error instanceof Error ? error.message : String(error), "error");
      return;
    }

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

  pi.on("session_before_switch", () => {
    invalidateCheckpoint();
  });

  pi.on("input", (event) => {
    if (!active || event.source === "extension") return;
    pendingCheckpoint = undefined;
    nudgeSentThisUserTurn = false;
  });

  pi.on("before_agent_start", (event, ctx) => {
    if (!active || !activePreset || !activePresetName) return;

    let systemPrompt = removeMainPiDocumentation(event.systemPrompt);
    if (isAnthropicOAuth(ctx)) systemPrompt = removeMainPiIdentity(systemPrompt);
    return {
      systemPrompt: `${systemPrompt}\n\n${ORCHESTRATOR_PROMPT}`,
      message: {
        customType: "oh-my-pi-slim:phase-reminder",
        content: PHASE_REMINDER,
        display: false,
      },
    };
  });

  pi.on("tool_call", (event) => {
    if (!active || event.toolName !== "subagent") return;
    if (!activePreset) {
      return { block: true, reason: "oh-my-pi-slim: no active preset is available." };
    }

    const input = event.input as MutableInput;
    if (!hasOwn(input, "action")) {
      if (hasOwn(input, "workflowScript")) {
        return {
          block: true,
          reason:
            "oh-my-pi-slim blocks direct workflowScript execution. Launch one fresh specialist with subagent({ agent, task? }); constrained schedules use action:\"schedule.create\".",
        };
      }
      if (hasOwn(input, "resume")) {
        return {
          block: true,
          reason:
            "oh-my-pi-slim fresh launches cannot use resume. Use subagent({ action: \"resume\", id, message }) and omit launch overrides.",
        };
      }

      try {
        applyFreshPreset(input, activePreset);
        input.context = "fresh";
      } catch (error) {
        return { block: true, reason: `oh-my-pi-slim: ${error instanceof Error ? error.message : String(error)}` };
      }
      return;
    }

    const action = typeof input.action === "string" ? input.action.trim() : "";
    if (DENIED_ACTIONS.has(action)) {
      return {
        block: true,
        reason: `oh-my-pi-slim blocks native subagent action "${action}" while orchestration is active.`,
      };
    }

    if (action === "resume") {
      const overrides = resumeOverrideFields(input);
      if (overrides.length > 0) {
        return {
          block: true,
          reason:
            `oh-my-pi-slim native resume preserves the source model and thinking contract and unlimited turns. Remove prohibited field(s): ${overrides.join(", ")}.`,
        };
      }
      return;
    }

    if (action === "schedule.create") {
      try {
        mutateScheduleCreate(input, activePreset);
      } catch (error) {
        return { block: true, reason: `oh-my-pi-slim: ${error instanceof Error ? error.message : String(error)}` };
      }
    }
  });

  pi.on("tool_execution_end", (event) => {
    if (active && FILE_TOOLS.has(event.toolName)) fileToolSeenThisTurn = true;
  });

  pi.on("turn_end", (event, ctx) => {
    const sawFileTool = fileToolSeenThisTurn;
    fileToolSeenThisTurn = false;
    if (!active) return;

    const tools = completedToolBatch(event);
    if (tools && !pendingCheckpoint && !ctx.hasPendingMessages()) {
      const usage = ctx.getContextUsage();
      if (usage && usage.tokens !== null && usage.contextWindow !== null) {
        const settings = SettingsManager.create(
          ctx.cwd,
          getAgentDir(),
          { projectTrusted: ctx.isProjectTrusted() },
        ).getCompactionSettings();
        if (shouldCompact(usage.tokens, usage.contextWindow, settings)) {
          const checkpoint = {
            epoch: sessionEpoch,
            tools,
            sawThresholdCompaction: false,
            resumeScheduled: false,
          };
          pendingCheckpoint = checkpoint;
          report(
            ctx,
            "Context reached Pi's native compaction threshold; checkpointing after the completed tool batch.",
            "info",
          );
          ctx.abort();
          return;
        }
      }
    }

    if (sawFileTool && !nudgeSentThisUserTurn && !ctx.hasPendingMessages()) {
      nudgeSentThisUserTurn = true;
      pi.sendMessage(
        {
          customType: "oh-my-pi-slim:file-nudge",
          content: PHASE_REMINDER,
          display: false,
        },
        { deliverAs: "steer", triggerTurn: true },
      );
    }
  });

  pi.on("session_compact", (event) => {
    if (
      pendingCheckpoint?.epoch === sessionEpoch &&
      event.reason === "threshold" &&
      event.willRetry === false
    ) {
      pendingCheckpoint.sawThresholdCompaction = true;
    }
  });

  pi.on("agent_settled", (_event, ctx) => {
    const checkpoint = pendingCheckpoint;
    if (!checkpoint || checkpoint.epoch !== sessionEpoch) return;
    if (checkpoint.sawThresholdCompaction) {
      scheduleCheckpointResume(checkpoint, ctx);
      return;
    }

    pendingCheckpoint = undefined;
    report(
      ctx,
      "OMPS stopped the previous low-level run after a complete tool batch, but Pi did not complete threshold compaction; automatic checkpoint resume was not started.",
      "warning",
    );
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    invalidateCheckpoint();
    if (active) {
      active = false;
      if (originalModel) await pi.setModel(originalModel);
      if (originalThinking !== undefined) pi.setThinkingLevel(originalThinking);
    }
    sessionCtx = undefined;
    activePresetName = undefined;
    activePreset = undefined;
    originalModel = undefined;
    originalThinking = undefined;
    nudgeSentThisUserTurn = false;
    if (ctx.hasUI) ctx.ui.setStatus("oh-my-pi-slim", undefined);
  });
}
