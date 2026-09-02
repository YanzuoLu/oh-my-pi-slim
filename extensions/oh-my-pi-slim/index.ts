import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getAgentDir,
  parseFrontmatter,
  type ExtensionAPI,
  type ExtensionContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { registerAskRuntime } from "./ask-runtime.js";
import { AskTuiDriver } from "./ask-tui.js";
import { cleanupLegacySubagentSetup, ensurePackageSetup } from "./bootstrap.js";
import {
  applyCacheRetentionForRequest,
  CACHE_STATE_ENTRY_TYPE,
  makeCacheState,
  replayCacheState,
  type CacheRetention,
} from "./cache-retention.js";
import {
  GOAL_CONTINUATION_MESSAGE_TYPE,
  GOAL_REMINDER_MESSAGE_TYPE,
  registerGoalRuntime,
  type GoalRuntime,
} from "./goal-runtime.js";
import { registerLoopRuntime } from "./loop-runtime.js";
import { MONITOR_NOTIFICATION_TYPE, registerMonitorRuntime } from "./monitor-runtime.js";
import { removeMainPiDocumentation, removeMainPiIdentity } from "./prompt-context.js";
import { SPECIALIST_NAMES, type SpecialistName } from "./subagent-core.js";
import { registerSubagentRuntime } from "./subagent-runtime.js";
import { SUBAGENT_NOTIFICATION_TYPE } from "./subagent-transcript-renderer.js";
import { createSubagentViewer } from "./subagent-viewer.js";
import { widgetStackHost } from "./widget-stack-host.js";
import type { WidgetStackSectionId } from "./widget-stack.js";

const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(EXTENSION_DIR, "../..");
const ORCHESTRATOR_PROMPT = parseFrontmatter(readFileSync(join(EXTENSION_DIR, "orchestrator.md"), "utf8")).body.trim();
const PACKAGE_VERSION = readPackageVersion(join(PACKAGE_ROOT, "package.json"));
const CONFIG_FILE = "oh-my-pi-slim.json";
const ROLE_NAMES = ["orchestrator", ...SPECIALIST_NAMES] as const;
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const TRUE_VALUES = /^(1|true|yes|on)$/i;
const SAFE_PRESET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SAFE_MODEL_PART = /^[A-Za-z0-9][A-Za-z0-9._:/+@-]*$/;
const LIFECYCLE_TOOLS = new Set(["subagent", "contact_supervisor"]);

const PHASE_REMINDER = `<system-reminder>
!IMPORTANT! Scheduler workflow: First choose the lightest workflow that fits the work. If direct execution is justified, complete it and verify proportionately. Otherwise: plan lanes/dependencies → dispatch background specialists → continue non-overlapping work when available → await completion notifications → reconcile terminal results → verify. !END!
</system-reminder>`;
const PHASE_REMINDER_MESSAGE_TYPE = "oh-my-pi-slim:phase-reminder";

interface ReminderMessage {
  customType: string;
  content: string;
  display: false;
}

function makePhaseReminderMessage(): ReminderMessage {
  return {
    customType: PHASE_REMINDER_MESSAGE_TYPE,
    content: PHASE_REMINDER,
    display: false,
  };
}

function makeGoalReminderMessage(content: string): ReminderMessage {
  return {
    customType: GOAL_REMINDER_MESSAGE_TYPE,
    content,
    display: false,
  };
}

export function createLaunchMessageSender(
  pi: Pick<ExtensionAPI, "sendMessage">,
  state: {
    sessionCtx: () => Pick<ExtensionContext, "isIdle"> | undefined;
    hasActivePreset: () => boolean;
    goalReminder: () => string | undefined;
    reminders: () => ReminderConfig;
  },
): ExtensionAPI["sendMessage"] {
  return (message, options) => {
    if (state.sessionCtx()?.isIdle() === true && options?.triggerTurn === true) {
      const goalReminder = state.goalReminder();
      const reminders = state.reminders();
      const hasActiveGoal = goalReminder !== undefined;
      if (reminders.phase && (state.hasActivePreset() || hasActiveGoal)) {
        pi.sendMessage(makePhaseReminderMessage(), { triggerTurn: false });
      }
      if (reminders.goal && hasActiveGoal) {
        pi.sendMessage(makeGoalReminderMessage(goalReminder), { triggerTurn: false });
      }
    }
    pi.sendMessage(message, options);
  };
}

const RELOAD_PRESET_STORE_KEY = "__ompsActivePresetForReload";
const WIDGET_STACK_OWNER = "oh-my-pi-slim:extension";
const OWNED_WIDGET_SECTIONS: readonly WidgetStackSectionId[] = ["goal", "agents", "monitors", "loops"];

type RoleName = (typeof ROLE_NAMES)[number];
type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

interface RolePreset {
  provider: string;
  model: string;
  thinking: ThinkingLevel;
}

export type Preset = Record<RoleName, RolePreset>;
type DenyConfig = Record<SpecialistName, string[]>;

export interface ReminderConfig {
  phase: boolean;
  goal: boolean;
}

interface PresetConfig {
  defaultPreset?: string;
  presets: Record<string, Preset>;
  deny: DenyConfig;
  reminders: ReminderConfig;
  observerFallbackPresets: Set<string>;
}

interface TreeNotificationHold {
  generation: number;
  signal: AbortSignal;
  abortListener: () => void;
  shutdownComplete: boolean;
  abortPending: boolean;
}

type ImmediateScheduler = (callback: () => void) => unknown;

export class NotificationDeliveryPauseGate {
  private generation = 0;
  private paused = false;
  private readonly setPaused: (paused: boolean) => void;
  private readonly defer: ImmediateScheduler;

  constructor(setPaused: (paused: boolean) => void, defer: ImmediateScheduler = (callback) => setImmediate(callback)) {
    this.setPaused = setPaused;
    this.defer = defer;
  }

  pause(): number {
    this.generation += 1;
    this.paused = true;
    this.setPaused(true);
    return this.generation;
  }

  currentGeneration(): number {
    return this.generation;
  }

  isPaused(): boolean {
    return this.paused;
  }

  isCurrent(generation: number): boolean {
    return this.paused && this.generation === generation;
  }

  release(generation: number): boolean {
    if (!this.isCurrent(generation)) return false;
    this.paused = false;
    this.setPaused(false);
    return true;
  }

  releaseDeferred(generation: number): void {
    this.defer(() => this.release(generation));
  }

  invalidate(): void {
    this.generation += 1;
  }

  clearWithoutDelivery(): void {
    this.generation += 1;
    this.paused = false;
  }
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

/** Read the shipped package version once at load so the footer never drifts from package metadata. */
function readPackageVersion(path: string): string {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`oh-my-pi-slim cannot read its package metadata at ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${path} must contain a JSON object.`);
  return nonEmptyString((raw as Record<string, unknown>).version, `${path}.version`);
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

export function parseReminderConfig(value: unknown, field: string): ReminderConfig {
  if (value === undefined) return { phase: false, goal: false };
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object.`);
  const object = value as Record<string, unknown>;
  const phase = object.phase;
  const goal = object.goal;
  if (phase !== undefined && typeof phase !== "boolean") throw new Error(`${field}.phase must be a boolean.`);
  if (goal !== undefined && typeof goal !== "boolean") throw new Error(`${field}.goal must be a boolean.`);
  return {
    phase: typeof phase === "boolean" ? phase : false,
    goal: typeof goal === "boolean" ? goal : false,
  };
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
    reminders: parseReminderConfig(object.reminders, `${path}.reminders`),
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

/** Whether any of the active preset's seven roles uses the exact Anthropic provider. */
export function presetCacheModeEligible(preset: Preset | undefined): boolean {
  return preset !== undefined && Object.values(preset).some((role) => role.provider === "anthropic");
}

/** Footer status content for the active preset. Undefined clears the status slot. */
export function presetStatusContent(
  theme: Pick<Theme, "fg">,
  presetName: string | undefined,
  cacheRetention?: CacheRetention,
  cacheEligible?: boolean,
): string | undefined {
  if (presetName === undefined) return undefined;
  const cacheStatus = cacheEligible && cacheRetention
    ? ` · Anthropic Cache Mode: ${cacheRetention}`
    : "";
  return theme.fg("accent", `OMPS Preset: ${presetName} (v${PACKAGE_VERSION})${cacheStatus}`);
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

export default function ohMyPiSlim(pi: ExtensionAPI): void {
  if (process.env.PI_SUBAGENT_CHILD === "1" || process.env.OMPS_SUBAGENT_CHILD === "1") return;

  // A reload evaluates this module again: drop the previous instance's sections before the new
  // widgets publish, so a dead closure can never keep rendering rows for an unloaded extension.
  for (const id of OWNED_WIDGET_SECTIONS) widgetStackHost().publish(id, undefined);

  let goal: GoalRuntime | undefined;
  let active = false;
  let activePresetName: string | undefined;
  let activePreset: Preset | undefined;
  let sessionCtx: ExtensionContext | undefined;
  let reminders: ReminderConfig = { phase: false, goal: false };
  const sendLaunchMessage = createLaunchMessageSender(pi, {
    sessionCtx: () => sessionCtx,
    hasActivePreset: () => active && activePreset !== undefined && activePresetName !== undefined,
    goalReminder: () => goal?.phaseReminder(),
    reminders: () => reminders,
  });
  const asks = registerAskRuntime(pi);
  const loops = registerLoopRuntime(pi);
  const monitors = registerMonitorRuntime(pi, { sendMessage: sendLaunchMessage });
  const subagents = registerSubagentRuntime(pi, { sendMessage: sendLaunchMessage });
  let cacheRetention: CacheRetention = "short";
  subagents.setCacheRetentionResolver(() => cacheRetention);
  pi.on("before_provider_request", (event, ctx) => {
    const model = ctx.model;
    return applyCacheRetentionForRequest(
      event.payload,
      model,
      cacheRetention,
      () => model !== undefined && ctx.modelRegistry.isUsingOAuth(model),
    );
  });
  // Read-only viewer: it owns no session state, writes nothing, and only reads cloned snapshots.
  const subagentViewer = createSubagentViewer({ snapshot: () => subagents.viewerSnapshot() });
  const notificationGate = new NotificationDeliveryPauseGate((paused) => {
    loops.setDeliveryPaused(paused);
    monitors?.setDeliveryPaused(paused);
    subagents.setNotificationDeliveryPaused(paused);
    goal?.setDeliveryPaused(paused);
  });
  goal = registerGoalRuntime(pi, {
    isNotificationDeliveryPaused: () => notificationGate.isPaused(),
    hasActiveSubagents: () => subagents.hasActiveRuns(),
    hasPendingSubagentNotifications: () => subagents.hasPendingNotifications(),
    hasBlockingMonitors: () => monitors?.hasBlockingWork() ?? false,
    askWaitingCount: () => asks.waitingCount(),
    childStats: (runIds) => subagents.goalStats(runIds),
    sendContinuationMessage: sendLaunchMessage,
  });
  asks.setGoalActiveResolver(() => goal?.isActive() ?? false);
  subagents.subscribeRunCreated((runId) => goal?.ownRun(runId));
  subagents.registry.subscribe(() => goal?.notePackageLifecycleChange());
  asks.subscribe(() => goal?.notePackageLifecycleChange());
  let monitorGoalUnsubscribe: (() => void) | undefined;
  let originalModel: ExtensionContext["model"];
  let originalThinking: ThinkingLevel | undefined;
  let sessionEpoch = 0;
  let treeNotificationHold: TreeNotificationHold | undefined;

  for (const [shortcut, direction] of [["ctrl+shift+left", -1], ["ctrl+shift+right", 1]] as const) {
    pi.registerShortcut(shortcut, {
      description: direction === 1
        ? "Open the read-only Subagent viewer and cycle forward through running or waiting runs"
        : "Open the read-only Subagent viewer and cycle backward through running or waiting runs",
      handler: async (ctx) => {
        // The viewer reads Main's own presentation settings from this context and never writes them.
        await subagentViewer.handleShortcut(ctx.ui, direction, {
          enabled: ctx.hasUI && ctx.mode === "tui",
          cwd: ctx.cwd,
          projectTrusted: ctx.isProjectTrusted(),
        });
      },
    });
  }

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

  function bindAskDriver(ctx?: ExtensionContext): void {
    // The questionnaire owns the screen while it is up, so the read-only viewer closes first and
    // the driver awaits that close before it opens its own overlay.
    asks.setTuiDriver(
      ctx?.hasUI === true && ctx.mode === "tui"
        ? new AskTuiDriver(ctx.ui, { beforeOpen: () => subagentViewer.closeAsync() })
        : undefined,
    );
  }

  function updateStatus(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    ctx.ui.setStatus(
      "oh-my-pi-slim",
      presetStatusContent(
        ctx.ui.theme,
        active ? activePresetName : undefined,
        cacheRetention,
        presetCacheModeEligible(activePreset),
      ),
    );
  }

  function takeTreeNotificationHold(): TreeNotificationHold | undefined {
    const hold = treeNotificationHold;
    if (!hold) return;
    hold.signal.removeEventListener("abort", hold.abortListener);
    treeNotificationHold = undefined;
    return hold;
  }

  function clearTreeNotificationHold(): void {
    takeTreeNotificationHold();
  }

  function releaseTreeNotificationHoldDeferred(hold: TreeNotificationHold): void {
    if (treeNotificationHold !== hold) return;
    takeTreeNotificationHold();
    notificationGate.releaseDeferred(hold.generation);
    const ctx = sessionCtx;
    if (ctx) setImmediate(() => goal?.reevaluateAfterHostOperation(ctx));
  }

  function releaseCurrentNotificationsDeferred(): void {
    const generation = notificationGate.currentGeneration();
    if (treeNotificationHold?.generation === generation) clearTreeNotificationHold();
    notificationGate.releaseDeferred(generation);
  }

  function invalidateDeferredSessionState(): void {
    sessionEpoch += 1;
    goal?.invalidateDeferred();
    notificationGate.invalidate();
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
    // Intentionally reread deny for each create/resume; role models remain fixed at preset activation.
    subagents.setDenyResolver((role) => loadPresetConfig().deny[role]);
  }

  async function activate(ctx: ExtensionContext, requestedPreset?: string, loadedConfig?: PresetConfig): Promise<void> {
    assertNoLegacyBackend(pi);
    ensurePackageSetup(PACKAGE_ROOT);
    const config = loadedConfig ?? loadPresetConfig();
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
    (globalThis as Record<string, unknown>)[RELOAD_PRESET_STORE_KEY] = presetName;
    updateStatus(ctx);
  }

  async function deactivate(ctx: ExtensionContext): Promise<void> {
    active = false;
    activePresetName = undefined;
    activePreset = undefined;
    subagents.setModelResolver();
    subagents.setDenyResolver();
    delete (globalThis as Record<string, unknown>)[RELOAD_PRESET_STORE_KEY];
    if (originalModel) await pi.setModel(originalModel);
    if (originalThinking !== undefined) pi.setThinkingLevel(originalThinking);
    originalModel = undefined;
    originalThinking = undefined;
    updateStatus(ctx);
  }

  pi.registerCommand("cache", {
    description: "Toggle Anthropic cache retention for this Pi session.",
    handler: async (args, ctx) => {
      if (args.trim()) {
        report(ctx, "Usage: /cache", "warning");
        return;
      }
      const next: CacheRetention = cacheRetention === "long" ? "short" : "long";
      try {
        pi.appendEntry(CACHE_STATE_ENTRY_TYPE, makeCacheState(next));
      } catch (error) {
        report(ctx, `Could not update Cache Mode: ${error instanceof Error ? error.message : String(error)}`, "error");
        return;
      }
      cacheRetention = next;
      updateStatus(ctx);
      report(ctx, `Cache Mode ${next === "long" ? "Long" : "Short"} requested for this Pi session. Cache policy applies only to eligible Anthropic OAuth requests and does not guarantee a cache hit.`, "info");
    },
  });

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
    invalidateDeferredSessionState();
    clearTreeNotificationHold();
    widgetStackHost().bind(WIDGET_STACK_OWNER, ctx.mode === "tui" ? ctx.ui : undefined);
    asks.reset();
    subagentViewer.reset();
    bindAskDriver(ctx);
    asks.reconcileHostMode(ctx);
    loops.reset();
    await monitors?.reset();
    monitorGoalUnsubscribe?.();
    monitorGoalUnsubscribe = monitors?.subscribe(() => goal?.notePackageLifecycleChange());
    loops.setUICtx(ctx.mode === "tui" ? ctx.ui : undefined);
    monitors?.setUICtx(ctx.mode === "tui" ? ctx.ui : undefined);
    monitors?.refreshUI();
    goal?.setUICtx(undefined);
    notificationGate.clearWithoutDelivery();
    goal?.setDeliveryPaused(false);
    sessionCtx = ctx;
    // Cache Mode is session-wide across every branch, so replay the full entry log rather than the active branch.
    cacheRetention = replayCacheState(ctx.sessionManager.getEntries());
    reminders = { phase: false, goal: false };
    active = false;
    activePresetName = undefined;
    activePreset = undefined;
    subagents.setModelResolver();
    subagents.setDenyResolver();
    originalModel = undefined;
    originalThinking = undefined;
    goal?.restore(ctx, event.reason === "startup" || event.reason === "reload" || event.reason === "resume" || event.reason === "fork");
    goal?.setUICtx(ctx.mode === "tui" ? ctx.ui : undefined);
    let config: PresetConfig;
    try {
      assertNoLegacyBackend(pi);
      ensurePackageSetup(PACKAGE_ROOT);
      config = loadPresetConfig();
      reminders = config.reminders;
      await subagents.restore(ctx);
    } catch (error) {
      report(ctx, error instanceof Error ? error.message : String(error), "error");
      updateStatus(ctx);
      return;
    }
    const flagPreset = pi.getFlag("omps-preset");
    const requestedPreset = typeof flagPreset === "string" && flagPreset.trim() ? flagPreset.trim() : envPreset();
    const savedPreset = consumeReloadPresetSlot();
    const reloadPreset = event.reason === "reload" ? savedPreset : undefined;
    const shouldActivate = pi.getFlag("omps") === true || envEnabled() || requestedPreset !== undefined || reloadPreset !== undefined;
    if (shouldActivate) {
      try { await activate(ctx, requestedPreset ?? reloadPreset, config); }
      catch (error) { report(ctx, error instanceof Error ? error.message : String(error), "error"); }
    }
    updateStatus(ctx);
  });

  pi.on("session_before_switch", async () => {
    invalidateDeferredSessionState();
    clearTreeNotificationHold();
    // Ask aborts first: its overlay sits above the viewer, and the viewer refuses to resolve while
    // a foreign overlay is on top, so closing it first would only queue a pending close.
    asks.abortAll("Session switch aborted the questionnaire.");
    subagentViewer.close();
    bindAskDriver();
    loops.shutdown();
    goal?.setUICtx(undefined);
    await monitors?.shutdown();
  });

  pi.on("session_before_fork", async () => {
    invalidateDeferredSessionState();
    clearTreeNotificationHold();
    asks.abortAll("Session fork aborted the questionnaire.");
    subagentViewer.close();
    bindAskDriver();
    loops.shutdown();
    goal?.setUICtx(undefined);
    await monitors?.shutdown();
  });

  pi.on("session_before_tree", async (event) => {
    invalidateDeferredSessionState();
    clearTreeNotificationHold();
    asks.abortAll("Session tree navigation aborted the questionnaire.");
    subagentViewer.close();
    bindAskDriver();
    goal?.setUICtx(undefined);
    const generation = notificationGate.pause();
    let hold: TreeNotificationHold;
    const abortListener = () => {
      if (treeNotificationHold !== hold) return;
      hold.abortPending = true;
      if (hold.shutdownComplete) releaseTreeNotificationHoldDeferred(hold);
    };
    hold = {
      generation,
      signal: event.signal,
      abortListener,
      shutdownComplete: false,
      abortPending: false,
    };
    treeNotificationHold = hold;
    event.signal.addEventListener("abort", abortListener, { once: true });
    if (event.signal.aborted) abortListener();
    try {
      await subagents.shutdown();
      hold.shutdownComplete = true;
      if (hold.abortPending) releaseTreeNotificationHoldDeferred(hold);
    } catch (error) {
      hold.shutdownComplete = true;
      releaseTreeNotificationHoldDeferred(hold);
      throw error;
    }
  });

  pi.on("session_tree", async (_event, ctx) => {
    sessionCtx = ctx;
    widgetStackHost().bind(WIDGET_STACK_OWNER, ctx.mode === "tui" ? ctx.ui : undefined);
    bindAskDriver(ctx);
    asks.reconcileHostMode(ctx);
    loops.setUICtx(ctx.mode === "tui" ? ctx.ui : undefined);
    loops.refreshUI();
    monitors?.setUICtx(ctx.mode === "tui" ? ctx.ui : undefined);
    monitors?.refreshUI();
    const hold = takeTreeNotificationHold();
    try {
      await subagents.restore(ctx, notificationGate.isPaused());
      if (activePreset) configureSubagentResolvers(activePreset, ctx);
      goal?.restore(ctx, true);
      goal?.setUICtx(ctx.mode === "tui" ? ctx.ui : undefined);
    } catch (error) {
      report(ctx, error instanceof Error ? error.message : String(error), "error");
    } finally {
      if (hold) notificationGate.releaseDeferred(hold.generation);
    }
    updateStatus(ctx);
  });

  pi.on("input", (event) => {
    if (event.source !== "extension" && notificationGate.isPaused()) {
      releaseCurrentNotificationsDeferred();
    }
    if (event.source !== "extension") goal?.onExternalUserInput();
  });

  pi.on("session_before_compact", (event, ctx) => {
    const generation = notificationGate.pause();
    const releaseAfterAbort = () => {
      setImmediate(() => {
        if (notificationGate.release(generation)) goal?.reevaluateAfterHostOperation(ctx);
      });
    };
    if (event.signal.aborted) releaseAfterAbort();
    else event.signal.addEventListener("abort", releaseAfterAbort, { once: true });
  });

  pi.on("before_agent_start", (event, ctx) => {
    asks.reconcileHostMode(ctx);
    const goalReminder = goal?.phaseReminder();
    const hasPhaseSubject = Boolean(active && activePreset && activePresetName) || goalReminder !== undefined;
    const phaseEnabled = reminders.phase && hasPhaseSubject;
    if (!active || !activePreset || !activePresetName) {
      return phaseEnabled ? { message: makePhaseReminderMessage() } : undefined;
    }
    let systemPrompt = removeMainPiDocumentation(event.systemPrompt);
    if (isAnthropicOAuth(ctx)) systemPrompt = removeMainPiIdentity(systemPrompt);
    return {
      systemPrompt: `${systemPrompt}\n\n${ORCHESTRATOR_PROMPT}`,
      ...(phaseEnabled ? { message: makePhaseReminderMessage() } : {}),
    };
  });

  pi.on("before_agent_start", () => {
    if (!reminders.goal) return;
    const goalReminder = goal?.phaseReminder();
    if (!goalReminder) return;
    return { message: makeGoalReminderMessage(goalReminder) };
  });

  pi.on("agent_start", (_event, ctx) => {
    goal?.onAgentStart(ctx);
  });

  pi.on("agent_end", (event) => {
    goal?.onAgentEnd(event);
  });

  pi.on("turn_start", () => {
    subagents.onTurnStart();
  });

  pi.on("message_end", (event, ctx) => {
    if (event.message.role !== "custom") return;
    const message = event.message;
    if (message.customType === GOAL_CONTINUATION_MESSAGE_TYPE) {
      const deliveryEpoch = sessionEpoch;
      const deliverySessionId = ctx.sessionManager.getSessionId();
      setImmediate(() => {
        if (deliveryEpoch !== sessionEpoch || sessionCtx?.sessionManager.getSessionId() !== deliverySessionId) return;
        goal?.acknowledgeContinuationMessage(message);
      });
      return;
    }
    if (event.message.customType !== SUBAGENT_NOTIFICATION_TYPE && event.message.customType !== MONITOR_NOTIFICATION_TYPE) return;
    // Bind acknowledgement to this session so delayed message_end events cannot acknowledge a new runtime's private key.
    const deliveryEpoch = sessionEpoch;
    const deliverySessionId = ctx.sessionManager.getSessionId();
    setImmediate(() => {
      if (deliveryEpoch !== sessionEpoch || sessionCtx?.sessionManager.getSessionId() !== deliverySessionId) return;
      if (message.customType === SUBAGENT_NOTIFICATION_TYPE) subagents.acknowledgeNotificationMessage(message);
      else monitors?.acknowledgeNotificationMessage(message);
    });
  });

  pi.on("tool_execution_start", () => {
    goal?.onToolExecutionStart();
  });

  pi.on("session_compact", (_event, ctx) => {
    goal?.refreshFromBranch(ctx);
    if (notificationGate.isPaused()) {
      releaseCurrentNotificationsDeferred();
      setImmediate(() => goal?.reevaluateAfterHostOperation(ctx));
    }
  });

  pi.on("agent_settled", (_event, ctx) => {
    // Retry only while this session/runtime still owns the queued private delivery keys.
    const deliveryEpoch = sessionEpoch;
    const deliverySessionId = ctx.sessionManager.getSessionId();
    setImmediate(() => {
      if (deliveryEpoch !== sessionEpoch || sessionCtx?.sessionManager.getSessionId() !== deliverySessionId) return;
      subagents.retryQueuedNotificationsAfterAgentSettled();
      monitors?.retryQueuedNotificationsAfterAgentSettled();
    });

    if (notificationGate.isPaused()) releaseCurrentNotificationsDeferred();
    goal?.onAgentSettled(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    invalidateDeferredSessionState();
    clearTreeNotificationHold();
    // Release only this extension's claim on this session's UI; Todo may still own the aggregate.
    widgetStackHost().unbind(WIDGET_STACK_OWNER, ctx.mode === "tui" ? ctx.ui : undefined);
    asks.abortAll("Session shutdown aborted the questionnaire.");
    subagentViewer.dispose();
    bindAskDriver();
    loops.shutdown();
    goal?.shutdown();
    monitorGoalUnsubscribe?.();
    monitorGoalUnsubscribe = undefined;
    await Promise.all([subagents.shutdown(), monitors?.shutdown()]);
    notificationGate.clearWithoutDelivery();
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
    updateStatus(ctx);
  });
}
