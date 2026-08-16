import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getAgentDir,
  parseFrontmatter,
  SettingsManager,
  shouldCompact,
  type ExtensionAPI,
  type ExtensionContext,
  type TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import { cleanupLegacySubagentSetup, ensurePackageSetup } from "./bootstrap.js";
import { removeMainPiDocumentation, removeMainPiIdentity } from "./prompt-context.js";
import { SPECIALIST_NAMES, type SpecialistName } from "./subagent-core.js";
import { registerSubagentRuntime } from "./subagent-runtime.js";
import { SUBAGENT_NOTIFICATION_TYPE } from "./subagent-transcript-renderer.js";

const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(EXTENSION_DIR, "../..");
const ORCHESTRATOR_PROMPT = parseFrontmatter(readFileSync(join(EXTENSION_DIR, "orchestrator.md"), "utf8")).body.trim();
const CONFIG_FILE = "oh-my-pi-slim.json";
const ROLE_NAMES = ["orchestrator", ...SPECIALIST_NAMES] as const;
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const FILE_TOOLS = new Set(["read", "edit", "write"]);
const TRUE_VALUES = /^(1|true|yes|on)$/i;
const SAFE_PRESET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SAFE_MODEL_PART = /^[A-Za-z0-9][A-Za-z0-9._:/+@-]*$/;
const LIFECYCLE_TOOLS = new Set(["subagent", "subagent_supervisor", "contact_supervisor"]);

const PHASE_REMINDER = `<system-reminder>
!IMPORTANT! Scheduler workflow: First choose the lightest workflow that fits the work. If direct execution is justified, complete it and verify proportionately. Otherwise: plan lanes/dependencies → dispatch background specialists → track task IDs → wait for hook-driven completion → reconcile terminal results → verify. !END!
</system-reminder>`;

const RELOAD_PRESET_STORE_KEY = "__ompsActivePresetForReload";
const CHECKPOINT_RESUME_TEXT = "Resume the user's latest intent. Re-read kept recent messages above the summary to confirm the latest request. If it supersedes earlier plans in the summary, follow it. If no work remains, say so briefly; do not invent work.";

type RoleName = (typeof ROLE_NAMES)[number];
type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

interface RolePreset {
  provider: string;
  model: string;
  thinking: ThinkingLevel;
}

type Preset = Record<RoleName, RolePreset>;
type DenyConfig = Record<SpecialistName, string[]>;

interface PresetConfig {
  defaultPreset?: string;
  presets: Record<string, Preset>;
  deny: DenyConfig;
  observerFallbackPresets: Set<string>;
}

interface CheckpointTool {
  id: string;
  name: string;
}

function envEnabled(): boolean {
  return TRUE_VALUES.test(String(process.env.OMPS_ENABLE ?? "").trim());
}

function envPreset(): string | undefined {
  const value = String(process.env.OMPS_PRESET ?? "").trim();
  return value || undefined;
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} must be a non-empty string.`);
  return value.trim();
}

function modelPart(value: unknown, field: string): string {
  const result = nonEmptyString(value, field);
  if (!SAFE_MODEL_PART.test(result)) throw new Error(`${field} contains unsupported characters.`);
  return result;
}

function parseRolePreset(value: unknown, field: string): RolePreset {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object.`);
  const object = value as Record<string, unknown>;
  const thinking = nonEmptyString(object.thinking, `${field}.thinking`).toLowerCase();
  if (!THINKING_LEVELS.has(thinking)) {
    throw new Error(`${field}.thinking must be one of: ${[...THINKING_LEVELS].join(", ")}.`);
  }
  return {
    provider: modelPart(object.provider, `${field}.provider`),
    model: modelPart(object.model, `${field}.model`),
    thinking: thinking as ThinkingLevel,
  };
}

function emptyDenyConfig(): DenyConfig {
  return Object.fromEntries(SPECIALIST_NAMES.map((role) => [role, []])) as DenyConfig;
}

export function parseDenyConfig(value: unknown, field: string): DenyConfig {
  const deny = emptyDenyConfig();
  if (value === undefined) return deny;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object.`);
  const object = value as Record<string, unknown>;
  const unknownRoles = Object.keys(object).filter((role) => !SPECIALIST_NAMES.includes(role as SpecialistName));
  if (unknownRoles.length > 0) throw new Error(`${field} contains unknown role(s): ${unknownRoles.join(", ")}.`);
  for (const role of SPECIALIST_NAMES) {
    const raw = object[role];
    if (raw === undefined) continue;
    if (!Array.isArray(raw)) throw new Error(`${field}.${role} must be an array of exact tool names.`);
    const seen = new Set<string>();
    for (let index = 0; index < raw.length; index += 1) {
      const tool = nonEmptyString(raw[index], `${field}.${role}[${index}]`);
      if (tool.includes(",")) throw new Error(`${field}.${role}[${index}] must not contain a comma.`);
      if (LIFECYCLE_TOOLS.has(tool)) throw new Error(`${field}.${role} cannot deny lifecycle tool "${tool}".`);
      if (seen.has(tool)) throw new Error(`${field}.${role} contains duplicate tool "${tool}".`);
      seen.add(tool);
      deny[role].push(tool);
    }
  }
  return deny;
}

export function parseConfigFile(path: string): PresetConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${path} must contain a JSON object.`);
  const object = raw as Record<string, unknown>;
  const rawPresets = object.presets;
  if (!rawPresets || typeof rawPresets !== "object" || Array.isArray(rawPresets)) {
    throw new Error(`${path}.presets must be an object.`);
  }

  const presets: Record<string, Preset> = {};
  const observerFallbackPresets = new Set<string>();
  for (const [presetName, rawPreset] of Object.entries(rawPresets as Record<string, unknown>)) {
    if (!SAFE_PRESET_NAME.test(presetName)) {
      throw new Error(`${path}.presets contains invalid name "${presetName}". Use letters, numbers, dot, underscore, or hyphen.`);
    }
    if (!rawPreset || typeof rawPreset !== "object" || Array.isArray(rawPreset)) {
      throw new Error(`${path}.presets.${presetName} must be an object.`);
    }
    const presetObject = rawPreset as Record<string, unknown>;
    const preset = {} as Preset;
    for (const role of ROLE_NAMES) {
      if (role === "observer" && presetObject.observer === undefined) {
        preset.observer = { ...preset.explorer };
        observerFallbackPresets.add(presetName);
      } else {
        preset[role] = parseRolePreset(presetObject[role], `${path}.presets.${presetName}.${role}`);
      }
    }
    presets[presetName] = preset;
  }

  const defaultPreset = object.defaultPreset === undefined
    ? undefined
    : nonEmptyString(object.defaultPreset, `${path}.defaultPreset`);
  return {
    defaultPreset,
    presets,
    deny: parseDenyConfig(object.deny, `${path}.deny`),
    observerFallbackPresets,
  };
}

function loadPresetConfig(): PresetConfig {
  const userPath = join(getAgentDir(), CONFIG_FILE);
  if (!existsSync(userPath)) {
    throw new Error(`User preset config is missing: ${userPath}. Enable bootstrap and restart Pi to rebuild it from the bundled example, or create it manually before using oh-my-pi-slim.`);
  }
  const config = parseConfigFile(userPath);
  if (Object.keys(config.presets).length === 0) throw new Error(`User preset config contains no presets: ${userPath}`);
  if (config.defaultPreset && !config.presets[config.defaultPreset]) {
    throw new Error(`defaultPreset "${config.defaultPreset}" does not exist. Available presets: ${Object.keys(config.presets).join(", ")}.`);
  }
  return config;
}

function fullModelName(role: RolePreset): string {
  return `${role.provider}/${role.model}`;
}

function launchModelName(role: RolePreset): string {
  return `${fullModelName(role)}:${role.thinking}`;
}

export function supportsImageInput(model: { input?: readonly string[] }): boolean {
  return Array.isArray(model.input) && model.input.includes("image");
}

function availablePresetsMessage(config: PresetConfig): string {
  return `Available presets: ${Object.keys(config.presets).join(", ")}. Default: ${config.defaultPreset ?? "none"}.\nUsage: /preset <name>`;
}

function isAnthropicOAuth(ctx: ExtensionContext): boolean {
  return ctx.model?.provider === "anthropic" && ctx.model?.api === "anthropic-messages" && ctx.modelRegistry.isUsingOAuth(ctx.model);
}

function toolSourceText(tool: unknown): string {
  if (!tool || typeof tool !== "object") return "";
  const object = tool as Record<string, unknown>;
  const sourceInfo = object.sourceInfo;
  const info = sourceInfo && typeof sourceInfo === "object" ? sourceInfo as Record<string, unknown> : {};
  return [object.provenance, info.provenance, info.path, info.source, info.baseDir]
    .filter((value): value is string => typeof value === "string")
    .join("\n");
}

function assertNoLegacyBackend(pi: ExtensionAPI): void {
  const legacy = pi.getAllTools().find((tool) => /(?:^|[/\\])pi-subagents(?:[/\\]|$)/.test(toolSourceText(tool)));
  if (legacy) {
    throw new Error(`oh-my-pi-slim refuses legacy pi-subagents tool "${legacy.name}" from ${toolSourceText(legacy) || "unknown source"}. Remove the old package before starting Pi.`);
  }
}

function completedToolBatch(event: TurnEndEvent): boolean {
  if (event.message.role !== "assistant" || event.message.stopReason !== "toolUse") return false;
  const tools: CheckpointTool[] = [];
  const callsById = new Map<string, string>();
  for (const content of event.message.content) {
    if (content.type !== "toolCall") continue;
    if (callsById.has(content.id)) return false;
    callsById.set(content.id, content.name);
    tools.push({ id: content.id, name: content.name });
  }
  if (tools.length === 0 || event.toolResults.length !== tools.length) return false;
  const resultIds = new Set<string>();
  for (const result of event.toolResults) {
    if (resultIds.has(result.toolCallId)) return false;
    resultIds.add(result.toolCallId);
    if (callsById.get(result.toolCallId) !== result.toolName) return false;
  }
  return true;
}

export default function ohMyPiSlim(pi: ExtensionAPI): void {
  if (process.env.PI_SUBAGENT_CHILD === "1" || process.env.OMPS_SUBAGENT_CHILD === "1") return;

  const subagents = registerSubagentRuntime(pi);
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
    description: "Select an oh-my-pi-slim preset from ~/.pi/agent/oh-my-pi-slim.json",
    type: "string",
  });

  function report(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error"): void {
    if (ctx.hasUI) ctx.ui.notify(message, level);
    else console.error(`[oh-my-pi-slim] ${message}`);
  }

  function updateStatus(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    const text = active ? `orchestrator${activePresetName ? `:${activePresetName}` : ""}` : undefined;
    ctx.ui.setStatus("oh-my-pi-slim", text ? ctx.ui.theme.fg("accent", text) : undefined);
  }

  function invalidateCheckpoint(): void {
    sessionEpoch += 1;
    pendingCheckpoint = undefined;
    fileToolSeenThisTurn = false;
  }

  function scheduleCheckpointResume(checkpoint: NonNullable<typeof pendingCheckpoint>, ctx: ExtensionContext): void {
    if (pendingCheckpoint !== checkpoint || checkpoint.resumeScheduled) return;
    checkpoint.resumeScheduled = true;
    setImmediate(() => {
      if (pendingCheckpoint !== checkpoint || checkpoint.epoch !== sessionEpoch || !active) return;
      pendingCheckpoint = undefined;
      report(ctx, "Pi compaction completed; starting a best-effort extension user turn from the checkpoint.", "warning");
      pi.sendUserMessage(CHECKPOINT_RESUME_TEXT, { deliverAs: "followUp" });
    });
  }

  function resolvePresetModels(config: PresetConfig, presetName: string, preset: Preset, ctx: ExtensionContext): void {
    for (const role of ROLE_NAMES) {
      const rolePreset = preset[role];
      const model = ctx.modelRegistry.find(rolePreset.provider, rolePreset.model);
      if (!model) throw new Error(`Preset "${presetName}" role "${role}" references unknown model ${fullModelName(rolePreset)}. Use \`pi --list-models\` to choose an exact provider/model ID.`);
      if (!ctx.modelRegistry.hasConfiguredAuth(model)) throw new Error(`Preset "${presetName}" role "${role}" has no configured authentication for ${fullModelName(rolePreset)}.`);
      if (role === "observer" && !supportsImageInput(model) && !config.observerFallbackPresets.has(presetName)) {
        throw new Error(`Preset "${presetName}" role "observer" requires an image-capable model; ${fullModelName(rolePreset)} does not declare image input.`);
      }
    }
    if (config.observerFallbackPresets.has(presetName)) {
      const fallback = ctx.modelRegistry.find(preset.observer.provider, preset.observer.model);
      const detail = supportsImageInput(fallback ?? {})
        ? `using explorer model ${fullModelName(preset.observer)}`
        : `explorer model ${fullModelName(preset.observer)} is not image-capable`;
      report(ctx, `Preset "${presetName}" has no observer role; ${detail}. Add an explicit observer entry.`, "warning");
    }
  }

  function configureSubagentResolvers(preset: Preset, ctx: ExtensionContext): void {
    subagents.setModelResolver((role) => {
      const rolePreset = preset[role];
      if (role === "observer") {
        const model = ctx.modelRegistry.find(rolePreset.provider, rolePreset.model);
        if (!model || !supportsImageInput(model)) {
          throw new Error(`Observer requires an image-capable model; ${fullModelName(rolePreset)} does not declare image input.`);
        }
      }
      return launchModelName(rolePreset);
    });
    subagents.setDenyResolver((role) => loadPresetConfig().deny[role]);
  }

  async function activate(ctx: ExtensionContext, requestedPreset?: string): Promise<void> {
    assertNoLegacyBackend(pi);
    ensurePackageSetup(PACKAGE_ROOT);
    const config = loadPresetConfig();
    const presetName = requestedPreset || config.defaultPreset;
    if (!presetName) throw new Error(`No preset selected and no defaultPreset configured. Available presets: ${Object.keys(config.presets).join(", ")}.`);
    const preset = config.presets[presetName];
    if (!preset) throw new Error(`Unknown preset "${presetName}". Available presets: ${Object.keys(config.presets).join(", ")}.`);
    resolvePresetModels(config, presetName, preset, ctx);
    const orchestratorModel = ctx.modelRegistry.find(preset.orchestrator.provider, preset.orchestrator.model);
    if (!orchestratorModel) throw new Error(`Model disappeared while applying preset "${presetName}".`);
    if (!active) {
      originalModel = ctx.model;
      originalThinking = pi.getThinkingLevel() as ThinkingLevel;
    }
    if (!await pi.setModel(orchestratorModel)) throw new Error(`Could not activate ${fullModelName(preset.orchestrator)} for preset "${presetName}".`);
    pi.setThinkingLevel(preset.orchestrator.thinking);
    active = true;
    activePresetName = presetName;
    activePreset = preset;
    configureSubagentResolvers(preset, ctx);
    nudgeSentThisUserTurn = false;
    (globalThis as Record<string, unknown>)[RELOAD_PRESET_STORE_KEY] = presetName;
    updateStatus(ctx);
  }

  async function deactivate(ctx: ExtensionContext): Promise<void> {
    invalidateCheckpoint();
    active = false;
    activePresetName = undefined;
    activePreset = undefined;
    subagents.setModelResolver();
    subagents.setDenyResolver();
    nudgeSentThisUserTurn = false;
    delete (globalThis as Record<string, unknown>)[RELOAD_PRESET_STORE_KEY];
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
      try { config = loadPresetConfig(); } catch { return null; }
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
        try { report(ctx, availablePresetsMessage(loadPresetConfig()), "info"); }
        catch (error) { report(ctx, error instanceof Error ? error.message : String(error), "error"); }
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
        const cleanup = cleanupLegacySubagentSetup();
        report(ctx, [
          "Removed OMPS-owned legacy subagent migration state and restored old user settings when safe.",
          ...cleanup.warnings,
          "The user preset file is preserved.",
          "Exit Pi, then run: pi remove git:github.com/YanzuoLu/oh-my-pi-slim",
        ].join("\n"), cleanup.warnings.length > 0 ? "warning" : "info");
        return;
      }
      if (action === "status") {
        report(ctx, active ? `oh-my-pi-slim is enabled with preset "${activePresetName}".` : "oh-my-pi-slim is disabled.", "info");
        return;
      }
      if (action === "presets") {
        try {
          const config = loadPresetConfig();
          report(ctx, `Available presets: ${Object.keys(config.presets).join(", ")}. Default: ${config.defaultPreset ?? "none"}.`, "info");
        } catch (error) { report(ctx, error instanceof Error ? error.message : String(error), "error"); }
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
      } catch (error) { report(ctx, error instanceof Error ? error.message : String(error), "error"); }
    },
  });

  function consumeReloadPresetSlot(): string | undefined {
    const store = globalThis as Record<string, unknown>;
    const saved = store[RELOAD_PRESET_STORE_KEY];
    delete store[RELOAD_PRESET_STORE_KEY];
    return typeof saved === "string" && saved.trim() ? saved.trim() : undefined;
  }

  pi.on("session_start", async (event, ctx) => {
    invalidateCheckpoint();
    sessionCtx = ctx;
    active = false;
    activePresetName = undefined;
    activePreset = undefined;
    subagents.setModelResolver();
    subagents.setDenyResolver();
    originalModel = undefined;
    originalThinking = undefined;
    nudgeSentThisUserTurn = false;
    try {
      assertNoLegacyBackend(pi);
      ensurePackageSetup(PACKAGE_ROOT);
      await subagents.restore(ctx);
    } catch (error) {
      report(ctx, error instanceof Error ? error.message : String(error), "error");
      return;
    }
    const flagPreset = pi.getFlag("omps-preset");
    const requestedPreset = typeof flagPreset === "string" && flagPreset.trim() ? flagPreset.trim() : envPreset();
    const savedPreset = consumeReloadPresetSlot();
    const reloadPreset = event.reason === "reload" ? savedPreset : undefined;
    const shouldActivate = pi.getFlag("omps") === true || envEnabled() || requestedPreset !== undefined || reloadPreset !== undefined;
    if (shouldActivate) {
      try { await activate(ctx, requestedPreset ?? reloadPreset); }
      catch (error) { report(ctx, error instanceof Error ? error.message : String(error), "error"); }
    }
    updateStatus(ctx);
  });

  pi.on("session_before_switch", invalidateCheckpoint);

  pi.on("session_before_tree", async () => {
    invalidateCheckpoint();
    await subagents.shutdown();
  });

  pi.on("session_tree", async (_event, ctx) => {
    sessionCtx = ctx;
    try {
      await subagents.restore(ctx);
      if (activePreset) configureSubagentResolvers(activePreset, ctx);
    } catch (error) {
      report(ctx, error instanceof Error ? error.message : String(error), "error");
    }
    updateStatus(ctx);
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
      message: { customType: "oh-my-pi-slim:phase-reminder", content: PHASE_REMINDER, display: false },
    };
  });

  pi.on("turn_start", () => {
    subagents.onTurnStart();
  });

  pi.on("message_end", (event, ctx) => {
    if (event.message.role !== "custom" || event.message.customType !== SUBAGENT_NOTIFICATION_TYPE) return;
    const message = event.message;
    const deliveryEpoch = sessionEpoch;
    const deliverySessionId = ctx.sessionManager.getSessionId();
    setImmediate(() => {
      if (deliveryEpoch !== sessionEpoch || sessionCtx?.sessionManager.getSessionId() !== deliverySessionId) return;
      subagents.acknowledgeNotificationMessage(message);
    });
  });

  pi.on("tool_execution_end", (event) => {
    if (active && FILE_TOOLS.has(event.toolName)) fileToolSeenThisTurn = true;
  });

  pi.on("turn_end", (event, ctx) => {
    const sawFileTool = fileToolSeenThisTurn;
    fileToolSeenThisTurn = false;
    if (!active) return;
    const completedBatch = completedToolBatch(event);
    if (completedBatch && !pendingCheckpoint && !ctx.hasPendingMessages()) {
      const usage = ctx.getContextUsage();
      if (usage && usage.tokens !== null && usage.contextWindow !== null) {
        const settings = SettingsManager.create(ctx.cwd, getAgentDir(), { projectTrusted: ctx.isProjectTrusted() }).getCompactionSettings();
        if (shouldCompact(usage.tokens, usage.contextWindow, settings)) {
          pendingCheckpoint = { epoch: sessionEpoch, sawThresholdCompaction: false, resumeScheduled: false };
          report(ctx, "Context reached Pi's native compaction threshold; checkpointing after the completed tool batch.", "info");
          ctx.abort();
          return;
        }
      }
    }
    if (sawFileTool && !nudgeSentThisUserTurn && !ctx.hasPendingMessages()) {
      nudgeSentThisUserTurn = true;
      pi.sendMessage(
        { customType: "oh-my-pi-slim:file-nudge", content: PHASE_REMINDER, display: false },
        { deliverAs: "steer", triggerTurn: true },
      );
    }
  });

  pi.on("session_compact", (event) => {
    if (pendingCheckpoint?.epoch === sessionEpoch && event.reason === "threshold" && event.willRetry === false) {
      pendingCheckpoint.sawThresholdCompaction = true;
    }
  });

  pi.on("agent_settled", (_event, ctx) => {
    const deliveryEpoch = sessionEpoch;
    const deliverySessionId = ctx.sessionManager.getSessionId();
    setImmediate(() => {
      if (deliveryEpoch !== sessionEpoch || sessionCtx?.sessionManager.getSessionId() !== deliverySessionId) return;
      subagents.retryQueuedNotificationsAfterAgentSettled();
    });

    const checkpoint = pendingCheckpoint;
    if (!checkpoint || checkpoint.epoch !== sessionEpoch) return;
    if (checkpoint.sawThresholdCompaction) {
      scheduleCheckpointResume(checkpoint, ctx);
      return;
    }
    pendingCheckpoint = undefined;
    report(ctx, "OMPS ended the previous low-level run after a complete tool batch, but Pi did not complete threshold compaction; automatic checkpoint resume was not started.", "warning");
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    invalidateCheckpoint();
    await subagents.shutdown();
    if (active) {
      active = false;
      if (originalModel) await pi.setModel(originalModel);
      if (originalThinking !== undefined) pi.setThinkingLevel(originalThinking);
    }
    sessionCtx = undefined;
    activePresetName = undefined;
    activePreset = undefined;
    subagents.setModelResolver();
    subagents.setDenyResolver();
    originalModel = undefined;
    originalThinking = undefined;
    nudgeSentThisUserTurn = false;
    if (ctx.hasUI) ctx.ui.setStatus("oh-my-pi-slim", undefined);
  });
}
