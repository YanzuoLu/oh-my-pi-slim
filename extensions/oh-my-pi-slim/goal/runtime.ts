import { randomUUID } from "node:crypto";
import type {
  AgentEndEvent,
  ExtensionAPI,
  ExtensionContext,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import {
  GOAL_ACTIONS,
  GOAL_TOOL_CONTRACT,
  GOAL_TOOL_ERRORS,
  goalContinuationContent,
  goalModelResult,
  goalStateEventContent,
  modelJsonResult,
} from "../tool-contracts.js";
import { renderGoalCall, renderGoalContinuation, renderGoalResult, renderGoalState } from "./transcript-renderer.js";
import { GoalWidget } from "./widget.js";

export const GOAL_STATE_ENTRY_TYPE = "oh-my-pi-slim:goal-state";
export const GOAL_CONTINUATION_MESSAGE_TYPE = "oh-my-pi-slim:goal-continuation";
export const GOAL_STATE_MESSAGE_TYPE = "oh-my-pi-slim:goal-state-event";
export const GOAL_SNAPSHOT_VERSION = 1;
export const GOAL_RETRY_BACKOFF_MS = [10_000, 30_000, 60_000, 300_000, 900_000, 3_600_000] as const;

export type GoalAction = (typeof GOAL_ACTIONS)[number];
export type GoalStatus = "active" | "retry_wait" | "paused" | "completed";
export type GoalAutomaticEvent = "user_abort" | "no_progress" | "provider_retry_wait" | "provider_retry_active" | "session_restored";

export interface PublicGoalState {
  status: GoalStatus;
  abstract: string;
  objective: string;
  criteria: string[];
  createdAt: string;
  updatedAt: string;
  endedAt: string | null;
  pauseReason: string | null;
  retryAttempt: number;
  nextRetryAt: string | null;
  lastProviderError: string | null;
  noProgressCount: number;
  evidence: string[] | null;
}

export interface GoalSnapshot {
  version: 1;
  instanceKey: string;
  generation: number;
  goal: PublicGoalState;
  ownedRunIds: string[];
}

export interface GoalExecutionStats {
  tokens: number;
  tools: number;
  turns: number;
  compactions: number;
}

export interface GoalChildStats extends GoalExecutionStats {
  runCount: number;
}

export interface GoalView {
  goal: PublicGoalState | null;
  elapsedMs: number | null;
  continuationCount: number;
  ownedChildRunCount: number;
  main: GoalExecutionStats;
  children: GoalChildStats;
}

export interface GoalContinuationMessageDetails {
  type: typeof GOAL_CONTINUATION_MESSAGE_TYPE;
  deliveryKey: string;
  continuationNumber: number;
  goal: PublicGoalState;
}

export interface GoalStateMessageDetails {
  type: typeof GOAL_STATE_MESSAGE_TYPE;
  event: GoalAutomaticEvent;
  reason: string;
  goal: PublicGoalState;
}

export interface GoalInput {
  action?: unknown;
  abstract?: unknown;
  objective?: unknown;
  criteria?: unknown;
  evidence?: unknown;
}

interface PendingContinuation {
  instanceKey: string;
  generation: number;
  sessionEpoch: number;
  sessionId: string;
  branchLeafId: string | null;
  externalInputGeneration: number;
  deliveryKey: string;
  continuationNumber: number;
  content: string;
}

interface DeliveryCandidate {
  instanceKey: string;
  generation: number;
  externalInputGeneration: number;
  sessionEpoch: number;
  sessionId: string;
  branchLeafId: string | null;
  branchEntryIds: string[];
  branchPolicy: "exact" | "descendant";
}

interface LogicalRun {
  automatic: boolean;
  toolCalls: number;
  activitySerial: number;
  externalInputGeneration: number;
  deliveryCandidate?: DeliveryCandidate;
}

interface FinalAssistant {
  stopReason?: string;
  errorMessage?: string;
}

type GoalTimerHandle = ReturnType<typeof setTimeout>;
type GoalStateListener = (goal: PublicGoalState | null) => void;

export interface GoalRuntimeOptions {
  sendContinuationMessage?: ExtensionAPI["sendMessage"];
  nowMs?: () => number;
  randomKey?: () => string;
  defer?: (callback: () => void) => void;
  setTimeout?: (callback: () => void, milliseconds: number) => GoalTimerHandle;
  clearTimeout?: (timer: GoalTimerHandle) => void;
  setInterval?: (callback: () => void, milliseconds: number) => unknown;
  clearInterval?: (timer: unknown) => void;
  isNotificationDeliveryPaused?: () => boolean;
  hasActiveSubagents?: () => boolean;
  hasPendingSubagentNotifications?: () => boolean;
  hasBlockingMonitors?: () => boolean;
  askWaitingCount?: () => number;
  childStats?: (ownedRunIds: readonly string[]) => GoalChildStats;
}

const ACTION_FIELDS: Record<GoalAction, readonly string[]> = {
  create: ["action", "abstract", "objective", "criteria"],
  modify: ["action", "abstract", "objective", "criteria"],
  check: ["action"],
  pause: ["action"],
  resume: ["action"],
  complete: ["action", "evidence"],
  clear: ["action"],
};

function goalResult(action: GoalAction, goal: PublicGoalState | null, changed: boolean) {
  const resultGoal = goal ? cloneGoal(goal) : null;
  const details = { goal: resultGoal, changed };
  return modelJsonResult(goalModelResult(action, resultGoal), details);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(GOAL_TOOL_ERRORS.object(label));
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return keys.length === wanted.length && keys.every((key, index) => key === wanted[index]);
}

function trimmedString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(GOAL_TOOL_ERRORS.nonEmptyString(field));
  return value.trim();
}

function trimmedStringArray(value: unknown, field: string, minimum = 1, maximum = 8): string[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    throw new Error(GOAL_TOOL_ERRORS.stringArrayRange(field, minimum, maximum));
  }
  return value.map((item, index) => trimmedString(item, `${field}[${index}]`));
}

function validIso(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function nullableString(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && value.trim() !== "" && value === value.trim());
}

function nullableIso(value: unknown): value is string | null {
  return value === null || validIso(value);
}

function nullableStringArray(value: unknown): value is string[] | null {
  return value === null || (Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim() !== "" && item === item.trim()));
}

function cloneGoal(goal: PublicGoalState): PublicGoalState {
  return {
    ...goal,
    criteria: [...goal.criteria],
    evidence: goal.evidence ? [...goal.evidence] : null,
  };
}

function cloneSnapshot(snapshot: GoalSnapshot): GoalSnapshot {
  return {
    version: GOAL_SNAPSHOT_VERSION,
    instanceKey: snapshot.instanceKey,
    generation: snapshot.generation,
    goal: cloneGoal(snapshot.goal),
    ownedRunIds: [...snapshot.ownedRunIds],
  };
}

function userMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: "text"; text: string } =>
      Boolean(part) && typeof part === "object" && (part as Record<string, unknown>).type === "text" &&
      typeof (part as Record<string, unknown>).text === "string")
    .map((part) => part.text)
    .join("\n");
}

function assertCreateRequestedInCurrentTurn(toolCallId: string, ctx: ExtensionContext): void {
  const branch = ctx.sessionManager.getBranch();
  let toolCallIndex = -1;
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (entry.type !== "message" || entry.message.role !== "assistant" || !Array.isArray(entry.message.content)) continue;
    const ownsCall = entry.message.content.some((part) =>
      part.type === "toolCall" && part.id === toolCallId && part.name === GOAL_TOOL_CONTRACT.name);
    if (!ownsCall) continue;
    toolCallIndex = index;
    break;
  }
  if (toolCallIndex >= 0) {
    for (let index = toolCallIndex - 1; index >= 0; index -= 1) {
      const entry = branch[index];
      if (entry.type === "custom_message") break;
      if (entry.type !== "message" || entry.message.role !== "user") continue;
      if (userMessageText(entry.message.content).includes("/goal")) return;
      break;
    }
  }
  throw new Error(GOAL_TOOL_ERRORS.createTurn);
}

const PUBLIC_GOAL_KEYS = [
  "status", "abstract", "objective", "criteria", "createdAt", "updatedAt", "endedAt", "pauseReason",
  "retryAttempt", "nextRetryAt", "lastProviderError", "noProgressCount", "evidence",
] as const;

export function parseGoalSnapshot(value: unknown): GoalSnapshot | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const root = value as Record<string, unknown>;
  if (!exactKeys(root, ["version", "instanceKey", "generation", "goal", "ownedRunIds"])) return;
  if (root.version !== GOAL_SNAPSHOT_VERSION || typeof root.instanceKey !== "string" || root.instanceKey.trim() === "") return;
  if (!Number.isSafeInteger(root.generation) || Number(root.generation) < 1) return;
  if (!Array.isArray(root.ownedRunIds) || root.ownedRunIds.some((id) => typeof id !== "string" || id.trim() === "" || id !== id.trim())) return;
  if (new Set(root.ownedRunIds).size !== root.ownedRunIds.length) return;
  if (!root.goal || typeof root.goal !== "object" || Array.isArray(root.goal)) return;
  const goal = root.goal as Record<string, unknown>;
  if (!exactKeys(goal, PUBLIC_GOAL_KEYS)) return;
  if (!["active", "retry_wait", "paused", "completed"].includes(String(goal.status))) return;
  if (typeof goal.abstract !== "string" || goal.abstract.trim() === "" || goal.abstract !== goal.abstract.trim()) return;
  if (typeof goal.objective !== "string" || goal.objective.trim() === "" || goal.objective !== goal.objective.trim()) return;
  if (!Array.isArray(goal.criteria) || goal.criteria.length < 1 || goal.criteria.length > 8 ||
      goal.criteria.some((item) => typeof item !== "string" || item.trim() === "" || item !== item.trim())) return;
  if (!validIso(goal.createdAt) || !validIso(goal.updatedAt) || !nullableIso(goal.endedAt)) return;
  if (Date.parse(goal.updatedAt) < Date.parse(goal.createdAt) ||
      (goal.endedAt !== null && Date.parse(goal.endedAt) < Date.parse(goal.createdAt))) return;
  if (!nullableString(goal.pauseReason) || !nullableIso(goal.nextRetryAt) || !nullableString(goal.lastProviderError) ||
      !nullableStringArray(goal.evidence)) return;
  if (!Number.isSafeInteger(goal.retryAttempt) || Number(goal.retryAttempt) < 0) return;
  if (!Number.isSafeInteger(goal.noProgressCount) || Number(goal.noProgressCount) < 0) return;
  if ((goal.retryAttempt === 0) !== (goal.lastProviderError === null)) return;
  const status = goal.status as GoalStatus;
  if ((status === "completed") !== (goal.endedAt !== null)) return;
  if (status === "completed") {
    if (!Array.isArray(goal.evidence) || goal.evidence.length !== goal.criteria.length) return;
  } else if (goal.evidence !== null) return;
  if (status !== "paused" && goal.pauseReason !== null) return;
  if (status === "retry_wait") {
    if (goal.retryAttempt < 1 || goal.nextRetryAt === null || goal.lastProviderError === null || Date.parse(goal.nextRetryAt) < Date.parse(goal.updatedAt)) return;
  } else if (goal.nextRetryAt !== null) return;
  if (status === "active" && goal.noProgressCount >= 3) return;
  if (status === "completed" &&
      (goal.retryAttempt !== 0 || goal.lastProviderError !== null || goal.noProgressCount !== 0)) return;
  return {
    version: GOAL_SNAPSHOT_VERSION,
    instanceKey: root.instanceKey,
    generation: Number(root.generation),
    goal: cloneGoal(goal as unknown as PublicGoalState),
    ownedRunIds: [...root.ownedRunIds] as string[],
  };
}

// A cleared Goal persists as an explicit null payload on the same entry type, so replay must treat
// exactly `null` as an erasure and keep every other malformed payload an ignorable entry.
export function isGoalTombstoneData(value: unknown): boolean {
  return value === null;
}

export function parseGoalContinuationMessageDetails(value: unknown): GoalContinuationMessageDetails | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const details = value as Record<string, unknown>;
  if (!exactKeys(details, ["type", "deliveryKey", "continuationNumber", "goal"]) ||
      details.type !== GOAL_CONTINUATION_MESSAGE_TYPE || typeof details.deliveryKey !== "string" || details.deliveryKey.trim() === "" ||
      !Number.isSafeInteger(details.continuationNumber) || Number(details.continuationNumber) < 1) return;
  const snapshot = parseGoalSnapshot({
    version: GOAL_SNAPSHOT_VERSION,
    instanceKey: "continuation-validator",
    generation: 1,
    goal: details.goal,
    ownedRunIds: [],
  });
  if (!snapshot) return;
  return {
    type: GOAL_CONTINUATION_MESSAGE_TYPE,
    deliveryKey: details.deliveryKey,
    continuationNumber: Number(details.continuationNumber),
    goal: cloneGoal(snapshot.goal),
  };
}

export function replayGoalBranch(entries: readonly unknown[]): GoalSnapshot | undefined {
  let latest: GoalSnapshot | undefined;
  for (const value of entries) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const entry = value as Record<string, unknown>;
    if (entry.type !== "custom" || entry.customType !== GOAL_STATE_ENTRY_TYPE) continue;
    if (isGoalTombstoneData(entry.data)) {
      latest = undefined;
      continue;
    }
    const snapshot = parseGoalSnapshot(entry.data);
    if (snapshot) latest = snapshot;
  }
  return latest ? cloneSnapshot(latest) : undefined;
}

function emptyStats(): GoalExecutionStats {
  return { tokens: 0, tools: 0, turns: 0, compactions: 0 };
}

function usageTokens(value: unknown): number {
  if (!value || typeof value !== "object" || Array.isArray(value)) return 0;
  const usage = value as Record<string, unknown>;
  return ["input", "output", "cacheRead", "cacheWrite"]
    .map((field) => typeof usage[field] === "number" && Number.isFinite(usage[field]) && Number(usage[field]) > 0 ? Number(usage[field]) : 0)
    .reduce((sum, amount) => sum + amount, 0);
}

export function deriveMainGoalStats(entries: readonly unknown[], instanceKey: string): GoalExecutionStats {
  const stats = emptyStats();
  let snapshot: GoalSnapshot | undefined;
  for (const value of entries) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const entry = value as Record<string, unknown>;
    if (entry.type === "custom" && entry.customType === GOAL_STATE_ENTRY_TYPE) {
      if (isGoalTombstoneData(entry.data)) {
        snapshot = undefined;
        continue;
      }
      const parsed = parseGoalSnapshot(entry.data);
      if (parsed) snapshot = parsed;
      continue;
    }
    if (!snapshot || snapshot.instanceKey !== instanceKey || (snapshot.goal.status !== "active" && snapshot.goal.status !== "retry_wait")) continue;
    if (entry.type === "compaction") {
      stats.compactions += 1;
      stats.tokens += usageTokens(entry.usage);
      continue;
    }
    if (entry.type !== "message" || !entry.message || typeof entry.message !== "object") continue;
    const message = entry.message as Record<string, unknown>;
    if (message.role === "assistant") {
      stats.turns += 1;
      stats.tokens += usageTokens(message.usage);
      if (Array.isArray(message.content)) {
        stats.tools += message.content.filter((item) => item && typeof item === "object" && (item as Record<string, unknown>).type === "toolCall").length;
      }
    } else if (message.role === "toolResult") {
      stats.tokens += usageTokens(message.usage);
    }
  }
  return stats;
}

export function retryDelayMs(attempt: number): number {
  if (!Number.isSafeInteger(attempt) || attempt < 1) throw new Error("retry attempt must be a positive safe integer.");
  return GOAL_RETRY_BACKOFF_MS[Math.min(attempt - 1, GOAL_RETRY_BACKOFF_MS.length - 1)];
}

export class GoalRuntime {
  private readonly pi: ExtensionAPI;
  private readonly sendContinuationMessage: ExtensionAPI["sendMessage"];
  private readonly nowMs: () => number;
  private readonly randomKey: () => string;
  private readonly defer: (callback: () => void) => void;
  private readonly setTimeoutFn: (callback: () => void, milliseconds: number) => GoalTimerHandle;
  private readonly clearTimeoutFn: (timer: GoalTimerHandle) => void;
  private readonly isNotificationDeliveryPaused: () => boolean;
  private readonly hasActiveSubagents: () => boolean;
  private readonly hasPendingSubagentNotifications: () => boolean;
  private readonly hasBlockingMonitors: () => boolean;
  private readonly askWaitingCount: () => number;
  private readonly childStatsResolver: (ownedRunIds: readonly string[]) => GoalChildStats;
  private readonly listeners = new Set<GoalStateListener>();
  private readonly widget: GoalWidget;
  private snapshot?: GoalSnapshot;
  private ctx?: ExtensionContext;
  private cachedContinuationCount = 0;
  private cachedMainStats: GoalExecutionStats = emptyStats();
  private cachedChildStats: GoalChildStats = { runCount: 0, ...emptyStats() };
  private sessionEpoch = 0;
  private deferredEpoch = 0;
  private externalInputGeneration = 0;
  private activitySerial = 0;
  private deliverySequence = 0;
  private deliveryPaused = false;
  private shuttingDown = false;
  private retryTimer?: GoalTimerHandle;
  private retryTimerGeneration = 0;
  private retryDue = false;
  private pendingContinuation?: PendingContinuation;
  private pendingContinuationRequestKey?: string;
  private pendingAutoRunKey?: string;
  private logicalRun?: LogicalRun;
  private finalAssistant?: FinalAssistant;
  private queuedStateMessages: Array<{ event: GoalAutomaticEvent; reason: string; goal: PublicGoalState }> = [];

  constructor(pi: ExtensionAPI, options: GoalRuntimeOptions = {}) {
    this.pi = pi;
    this.sendContinuationMessage = options.sendContinuationMessage ?? ((message, sendOptions) => this.pi.sendMessage(message, sendOptions));
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.randomKey = options.randomKey ?? (() => randomUUID());
    this.defer = options.defer ?? ((callback) => setImmediate(callback));
    this.setTimeoutFn = options.setTimeout ?? ((callback, milliseconds) => setTimeout(callback, milliseconds));
    this.clearTimeoutFn = options.clearTimeout ?? ((timer) => clearTimeout(timer));
    this.isNotificationDeliveryPaused = options.isNotificationDeliveryPaused ?? (() => false);
    this.hasActiveSubagents = options.hasActiveSubagents ?? (() => false);
    this.hasPendingSubagentNotifications = options.hasPendingSubagentNotifications ?? (() => false);
    this.hasBlockingMonitors = options.hasBlockingMonitors ?? (() => false);
    this.askWaitingCount = options.askWaitingCount ?? (() => 0);
    this.childStatsResolver = options.childStats ?? ((ownedRunIds) => ({ runCount: ownedRunIds.length, ...emptyStats() }));
    this.widget = new GoalWidget(() => this.goalView(), {
      nowMs: this.nowMs,
      setInterval: options.setInterval,
      clearInterval: options.clearInterval,
    });
  }

  register(): void {
    this.pi.registerMessageRenderer(GOAL_CONTINUATION_MESSAGE_TYPE, renderGoalContinuation);
    this.pi.registerMessageRenderer(GOAL_STATE_MESSAGE_TYPE, renderGoalState);
    this.pi.registerTool({
      name: GOAL_TOOL_CONTRACT.name,
      label: "Goal",
      executionMode: "sequential",
      description: GOAL_TOOL_CONTRACT.description,
      parameters: GOAL_TOOL_CONTRACT.parameters,
      execute: async (toolCallId, params, _signal, _onUpdate, ctx) =>
        this.execute(params as GoalInput, toolCallId, ctx),
      renderCall: renderGoalCall,
      renderResult: renderGoalResult,
    });
    this.pi.registerCommand("goal", {
      description: "Forward a goal request to the model.",
      handler: async (args, ctx) => {
        this.onExternalUserInput();
        const raw = args === "" ? "/goal" : `/goal ${args}`;
        this.pi.sendUserMessage(raw, {
          ...(ctx.isIdle() ? {} : { deliverAs: "steer" as const }),
          expandPromptTemplates: false,
        });
      },
    });
  }

  isActive(): boolean {
    return this.snapshot?.goal.status === "active";
  }

  status(): PublicGoalState | null {
    return this.snapshot ? cloneGoal(this.snapshot.goal) : null;
  }

  setUICtx(ui: ExtensionUIContext | undefined): void {
    this.widget.setContext(ui);
  }

  refreshUI(): void {
    this.refreshDerivedView();
    this.widget.update();
  }

  subscribe(listener: GoalStateListener): () => void {
    this.listeners.add(listener);
    listener(this.status());
    return () => this.listeners.delete(listener);
  }

  goalView(): GoalView {
    const snapshot = this.snapshot;
    if (!snapshot) {
      return {
        goal: null,
        elapsedMs: null,
        continuationCount: 0,
        ownedChildRunCount: 0,
        main: emptyStats(),
        children: { runCount: 0, ...emptyStats() },
      };
    }
    const end = snapshot.goal.endedAt ? Date.parse(snapshot.goal.endedAt) : this.nowMs();
    return {
      goal: cloneGoal(snapshot.goal),
      elapsedMs: Math.max(0, end - Date.parse(snapshot.goal.createdAt)),
      continuationCount: this.cachedContinuationCount,
      ownedChildRunCount: snapshot.ownedRunIds.length,
      main: { ...this.cachedMainStats },
      children: { ...this.cachedChildStats },
    };
  }

  private refreshDerivedView(): void {
    const snapshot = this.snapshot;
    const ctx = this.ctx;
    if (!snapshot || !ctx) {
      this.cachedContinuationCount = 0;
      this.cachedMainStats = emptyStats();
      this.cachedChildStats = { runCount: 0, ...emptyStats() };
      return;
    }
    const branch = ctx.sessionManager.getBranch();
    this.cachedContinuationCount = branch.filter((entry) => {
      if (entry.type !== "custom_message" || entry.customType !== GOAL_CONTINUATION_MESSAGE_TYPE) return false;
      const details = entry.details && typeof entry.details === "object" && !Array.isArray(entry.details)
        ? entry.details as Record<string, unknown> : undefined;
      return typeof details?.deliveryKey === "string" && details.deliveryKey.startsWith(`${snapshot.instanceKey}:`);
    }).length;
    this.cachedMainStats = deriveMainGoalStats(branch, snapshot.instanceKey);
    this.cachedChildStats = { ...this.childStatsResolver(snapshot.ownedRunIds) };
  }

  restore(ctx: ExtensionContext, pauseRestored: boolean): void {
    this.clearRuntime(true);
    this.ctx = ctx;
    this.shuttingDown = false;
    this.sessionEpoch += 1;
    this.snapshot = replayGoalBranch(ctx.sessionManager.getBranch());
    if (this.snapshot && pauseRestored && (this.snapshot.goal.status === "active" || this.snapshot.goal.status === "retry_wait")) {
      const now = this.nowIso();
      const next = cloneSnapshot(this.snapshot);
      next.generation += 1;
      next.goal = {
        ...next.goal,
        status: "paused",
        updatedAt: now,
        endedAt: null,
        pauseReason: "session_restored",
        retryAttempt: next.goal.retryAttempt,
        nextRetryAt: null,
        lastProviderError: next.goal.lastProviderError,
        noProgressCount: next.goal.noProgressCount,
        evidence: null,
      };
      this.store(next);
      this.emitStateEvent("session_restored", "session_restored");
      return;
    }
    if (this.snapshot?.goal.status === "retry_wait") this.armRetryTimer();
    this.emit();
  }

  refreshFromBranch(ctx: ExtensionContext): void {
    const currentInstance = this.snapshot?.instanceKey;
    const currentTimer = this.retryTimer;
    const restored = replayGoalBranch(ctx.sessionManager.getBranch());
    this.ctx = ctx;
    this.snapshot = restored;
    if (!restored || restored.instanceKey !== currentInstance || restored.goal.status !== "retry_wait") {
      if (currentTimer !== undefined) this.clearRetryTimer();
    } else if (currentTimer === undefined) {
      this.armRetryTimer();
    }
    this.emit();
  }

  shutdown(): void {
    this.shuttingDown = true;
    this.widget.dispose();
    this.clearRuntime(true);
    this.ctx = undefined;
    this.snapshot = undefined;
    this.refreshDerivedView();
    this.listeners.clear();
  }

  invalidateDeferred(): void {
    this.deferredEpoch += 1;
    this.pendingContinuation = undefined;
    this.pendingContinuationRequestKey = undefined;
    this.pendingAutoRunKey = undefined;
    this.logicalRun = undefined;
    this.finalAssistant = undefined;
  }

  setDeliveryPaused(paused: boolean): void {
    this.deliveryPaused = paused;
    if (paused || this.shuttingDown) return;
    this.flushStateMessages();
    this.reevaluateRetry();
    if (this.isActive() && this.ctx) this.requestContinuation(this.ctx);
  }

  ownRun(id: string): void {
    if (!this.isActive() || !this.snapshot || this.snapshot.ownedRunIds.includes(id)) return;
    const next = cloneSnapshot(this.snapshot);
    next.generation += 1;
    next.ownedRunIds.push(id);
    next.goal.updatedAt = this.nowIso();
    this.store(next);
    this.notePackageLifecycleChange();
  }

  onExternalUserInput(): void {
    this.externalInputGeneration += 1;
    this.pendingContinuation = undefined;
    this.pendingContinuationRequestKey = undefined;
    this.pendingAutoRunKey = undefined;
    if (this.snapshot && this.snapshot.goal.noProgressCount !== 0 &&
        (this.snapshot.goal.status === "active" || this.snapshot.goal.status === "retry_wait")) {
      const next = cloneSnapshot(this.snapshot);
      next.generation += 1;
      next.goal.noProgressCount = 0;
      next.goal.updatedAt = this.nowIso();
      this.store(next);
    }
    this.activitySerial += 1;
  }

  notePackageLifecycleChange(): void {
    this.activitySerial += 1;
    this.refreshUI();
    this.reevaluateRetry();
    if (this.isActive() && this.ctx) this.requestContinuation(this.ctx);
  }

  reevaluateAfterHostOperation(ctx: ExtensionContext): void {
    this.ctx = ctx;
    this.reevaluateRetry();
    if (this.isActive()) this.requestContinuation(ctx);
  }

  onAgentStart(ctx: ExtensionContext): void {
    if (this.logicalRun) return;
    const automatic = Boolean(this.pendingAutoRunKey);
    this.logicalRun = {
      automatic,
      toolCalls: 0,
      activitySerial: this.activitySerial,
      externalInputGeneration: this.externalInputGeneration,
      deliveryCandidate: this.captureDeliveryCandidate(ctx, "descendant"),
    };
    this.pendingAutoRunKey = undefined;
    this.finalAssistant = undefined;
  }

  onAgentEnd(event: AgentEndEvent): void {
    this.refreshUI();
    for (let index = event.messages.length - 1; index >= 0; index -= 1) {
      const message = event.messages[index] as unknown as Record<string, unknown>;
      if (message?.role !== "assistant") continue;
      this.finalAssistant = {
        stopReason: typeof message.stopReason === "string" ? message.stopReason : undefined,
        errorMessage: typeof message.errorMessage === "string" ? message.errorMessage : undefined,
      };
      return;
    }
  }

  onToolExecutionStart(): void {
    if (this.logicalRun) this.logicalRun.toolCalls += 1;
    this.refreshUI();
  }

  acknowledgeContinuationMessage(messageValue: unknown): boolean {
    if (!messageValue || typeof messageValue !== "object" || Array.isArray(messageValue)) return false;
    const message = messageValue as Record<string, unknown>;
    if (message.role !== "custom" || message.customType !== GOAL_CONTINUATION_MESSAGE_TYPE) return false;
    const details = parseGoalContinuationMessageDetails(message.details);
    const deliveryKey = details?.deliveryKey;
    if (!deliveryKey || this.pendingContinuation?.deliveryKey !== deliveryKey) return false;
    this.pendingContinuation = undefined;
    this.refreshUI();
    return true;
  }

  onAgentSettled(ctx: ExtensionContext, options: { suppressContinuation?: boolean } = {}): void {
    this.ctx = ctx;
    this.refreshUI();
    const run = this.logicalRun;
    const final = this.finalAssistant;
    this.logicalRun = undefined;
    this.finalAssistant = undefined;

    if (!this.snapshot) return;
    const status = this.snapshot.goal.status;
    if ((status === "active" || status === "retry_wait") && final?.stopReason === "error") {
      this.enterRetryWait(final.errorMessage ?? GOAL_TOOL_ERRORS.providerFailed);
      return;
    }
    if (status === "active" && final?.stopReason === "aborted" && !this.shuttingDown) {
      const safeToPause = run?.deliveryCandidate !== undefined && this.safeToDeliver(run.deliveryCandidate, ctx);
      this.invalidatePendingContinuation();
      if (safeToPause) this.pauseAutomatically("user_abort", "user_abort");
      else if (options.suppressContinuation !== true) this.requestContinuation(ctx);
      return;
    }
    if (final && final.stopReason !== "error" && final.stopReason !== "aborted" &&
        (status === "active" || status === "retry_wait") && this.hasRetryMetadata()) {
      this.clearRetryAfterSuccess();
    }
    if (this.snapshot?.goal.status === "retry_wait" && this.retryDue) {
      this.reevaluateRetry();
      return;
    }
    if (!this.isActive() || !this.snapshot || options.suppressContinuation === true) return;

    if (run?.automatic) {
      const progressed = run.toolCalls > 0 || run.activitySerial !== this.activitySerial ||
        run.externalInputGeneration !== this.externalInputGeneration;
      if (progressed) this.resetNoProgressIfNeeded();
      else this.incrementNoProgress();
    }
    if (!this.isActive()) return;
    this.requestContinuation(ctx);
  }

  async execute(
    inputValue: GoalInput,
    toolCallId: string,
    ctx: ExtensionContext,
  ): Promise<ReturnType<typeof modelJsonResult>> {
    const input = record(inputValue, "goal input");
    const action = trimmedString(input.action, "action") as GoalAction;
    if (!GOAL_ACTIONS.includes(action)) throw new Error(GOAL_TOOL_ERRORS.unsupportedAction(action));
    this.validateActionFields(input, action);

    if (action === "check") {
      if (!this.snapshot) return goalResult(action, null, false);
      return goalResult(action, this.snapshot.goal, false);
    }
    if (action === "clear" && !this.snapshot) return goalResult(action, null, false);
    if (action === "create") return this.create(input, toolCallId, ctx);
    if (!this.snapshot) throw new Error(GOAL_TOOL_ERRORS.missing);
    if (action === "modify") return this.modify(input);
    if (action === "pause") return this.pause();
    if (action === "resume") return this.resume();
    if (action === "complete") return this.complete(input);
    return this.clear();
  }

  private validateActionFields(input: Record<string, unknown>, action: GoalAction): void {
    const allowed = ACTION_FIELDS[action];
    const unknown = Object.keys(input).filter((field) => !allowed.includes(field));
    if (unknown.length > 0) throw new Error(GOAL_TOOL_ERRORS.unknownFields(action, unknown));
    const required = action === "create" || action === "modify"
      ? ["abstract", "objective", "criteria"]
      : action === "complete" ? ["evidence"] : [];
    for (const field of required) if (input[field] === undefined) throw new Error(GOAL_TOOL_ERRORS.required(action, field));
  }

  private create(
    input: Record<string, unknown>,
    toolCallId: string,
    ctx: ExtensionContext,
  ): ReturnType<typeof modelJsonResult> {
    assertCreateRequestedInCurrentTurn(toolCallId, ctx);
    if (this.snapshot && this.snapshot.goal.status !== "completed") {
      throw new Error(GOAL_TOOL_ERRORS.createStatus(this.snapshot.goal.status));
    }
    const now = this.nowIso();
    const snapshot: GoalSnapshot = {
      version: GOAL_SNAPSHOT_VERSION,
      instanceKey: trimmedString(this.randomKey(), "Goal instance key"),
      generation: 1,
      goal: {
        status: "active",
        abstract: trimmedString(input.abstract, "abstract"),
        objective: trimmedString(input.objective, "objective"),
        criteria: trimmedStringArray(input.criteria, "criteria"),
        createdAt: now,
        updatedAt: now,
        endedAt: null,
        pauseReason: null,
        retryAttempt: 0,
        nextRetryAt: null,
        lastProviderError: null,
        noProgressCount: 0,
        evidence: null,
      },
      ownedRunIds: [],
    };
    this.clearRetryTimer();
    this.store(snapshot);
    if (this.logicalRun && !this.logicalRun.deliveryCandidate) {
      this.logicalRun.deliveryCandidate = this.captureDeliveryCandidate(ctx, "descendant");
    }
    return goalResult("create", snapshot.goal, true);
  }

  private modify(input: Record<string, unknown>): ReturnType<typeof modelJsonResult> {
    const snapshot = this.requireMutable("modify");
    const next = cloneSnapshot(snapshot);
    next.generation += 1;
    next.goal = {
      ...next.goal,
      status: "active",
      abstract: trimmedString(input.abstract, "abstract"),
      objective: trimmedString(input.objective, "objective"),
      criteria: trimmedStringArray(input.criteria, "criteria"),
      updatedAt: this.nowIso(),
      endedAt: null,
      pauseReason: null,
      retryAttempt: 0,
      nextRetryAt: null,
      lastProviderError: null,
      noProgressCount: 0,
      evidence: null,
    };
    this.clearRetryTimer();
    this.store(next);
    return goalResult("modify", next.goal, true);
  }

  private pause(): ReturnType<typeof modelJsonResult> {
    const snapshot = this.snapshot as GoalSnapshot;
    if (snapshot.goal.status === "completed") {
      throw new Error(GOAL_TOOL_ERRORS.terminalAction("pause", snapshot.goal.status));
    }
    if (snapshot.goal.status === "paused") {
      return goalResult("pause", snapshot.goal, false);
    }
    const next = cloneSnapshot(snapshot);
    next.generation += 1;
    next.goal.status = "paused";
    next.goal.updatedAt = this.nowIso();
    next.goal.pauseReason = null;
    next.goal.nextRetryAt = null;
    this.clearRetryTimer();
    this.store(next);
    return goalResult("pause", next.goal, true);
  }

  private resume(): ReturnType<typeof modelJsonResult> {
    const snapshot = this.snapshot as GoalSnapshot;
    if (snapshot.goal.status === "completed") {
      throw new Error(GOAL_TOOL_ERRORS.terminalAction("resume", snapshot.goal.status));
    }
    if (snapshot.goal.status === "active") {
      return goalResult("resume", snapshot.goal, false);
    }
    const next = cloneSnapshot(snapshot);
    next.generation += 1;
    next.goal.status = "active";
    next.goal.updatedAt = this.nowIso();
    next.goal.pauseReason = null;
    next.goal.retryAttempt = 0;
    next.goal.nextRetryAt = null;
    next.goal.lastProviderError = null;
    next.goal.noProgressCount = 0;
    this.clearRetryTimer();
    this.store(next);
    return goalResult("resume", next.goal, true);
  }

  private complete(input: Record<string, unknown>): ReturnType<typeof modelJsonResult> {
    const snapshot = this.snapshot as GoalSnapshot;
    if (snapshot.goal.status !== "active") throw new Error(GOAL_TOOL_ERRORS.completeStatus(snapshot.goal.status));
    const evidence = trimmedStringArray(input.evidence, "evidence");
    if (evidence.length !== snapshot.goal.criteria.length) {
      throw new Error(GOAL_TOOL_ERRORS.evidenceCount(snapshot.goal.criteria.length));
    }
    const now = this.nowIso();
    const next = cloneSnapshot(snapshot);
    next.generation += 1;
    next.goal.status = "completed";
    next.goal.updatedAt = now;
    next.goal.endedAt = now;
    next.goal.evidence = evidence;
    next.goal.pauseReason = null;
    next.goal.retryAttempt = 0;
    next.goal.nextRetryAt = null;
    next.goal.lastProviderError = null;
    next.goal.noProgressCount = 0;
    this.clearRetryTimer();
    this.store(next);
    return goalResult("complete", next.goal, true);
  }

  private clear(): ReturnType<typeof modelJsonResult> {
    this.clearRuntime(true);
    this.snapshot = undefined;
    this.pi.appendEntry<null>(GOAL_STATE_ENTRY_TYPE, null);
    this.activitySerial += 1;
    this.emit();
    return goalResult("clear", null, true);
  }

  private requireMutable(action: string): GoalSnapshot {
    const snapshot = this.snapshot as GoalSnapshot;
    if (snapshot.goal.status === "completed") {
      throw new Error(GOAL_TOOL_ERRORS.terminalAction(action, snapshot.goal.status));
    }
    return snapshot;
  }

  private enterRetryWait(error: string): void {
    if (!this.snapshot || (this.snapshot.goal.status !== "active" && this.snapshot.goal.status !== "retry_wait")) return;
    const attempt = this.snapshot.goal.retryAttempt + 1;
    const nowMs = this.nowMs();
    const next = cloneSnapshot(this.snapshot);
    next.generation += 1;
    next.goal.status = "retry_wait";
    next.goal.updatedAt = new Date(nowMs).toISOString();
    next.goal.pauseReason = null;
    next.goal.retryAttempt = attempt;
    next.goal.nextRetryAt = new Date(nowMs + retryDelayMs(attempt)).toISOString();
    next.goal.lastProviderError = typeof error === "string" && error.trim() ? error.trim() : GOAL_TOOL_ERRORS.providerFailed;
    this.store(next);
    this.emitStateEvent("provider_retry_wait", next.goal.lastProviderError as string);
    this.armRetryTimer();
  }

  private clearRetryAfterSuccess(): void {
    if (!this.snapshot || (this.snapshot.goal.status !== "active" && this.snapshot.goal.status !== "retry_wait")) return;
    const next = cloneSnapshot(this.snapshot);
    next.generation += 1;
    next.goal.status = "active";
    next.goal.updatedAt = this.nowIso();
    next.goal.pauseReason = null;
    next.goal.retryAttempt = 0;
    next.goal.nextRetryAt = null;
    next.goal.lastProviderError = null;
    this.clearRetryTimer();
    this.store(next);
  }

  private hasRetryMetadata(): boolean {
    return Boolean(this.snapshot && (this.snapshot.goal.retryAttempt > 0 || this.snapshot.goal.lastProviderError !== null || this.snapshot.goal.nextRetryAt !== null));
  }

  private pauseAutomatically(event: "user_abort" | "no_progress" | "session_restored", reason: string): void {
    if (!this.snapshot || (this.snapshot.goal.status !== "active" && this.snapshot.goal.status !== "retry_wait")) return;
    const next = cloneSnapshot(this.snapshot);
    next.generation += 1;
    next.goal.status = "paused";
    next.goal.updatedAt = this.nowIso();
    next.goal.pauseReason = reason;
    next.goal.nextRetryAt = null;
    this.clearRetryTimer();
    this.store(next);
    this.emitStateEvent(event, reason);
  }

  private incrementNoProgress(): void {
    if (!this.snapshot || this.snapshot.goal.status !== "active") return;
    const next = cloneSnapshot(this.snapshot);
    next.generation += 1;
    next.goal.noProgressCount += 1;
    next.goal.updatedAt = this.nowIso();
    if (next.goal.noProgressCount >= 3) {
      next.goal.status = "paused";
      next.goal.pauseReason = "no_progress";
      this.store(next);
      this.emitStateEvent("no_progress", "no_progress");
      return;
    }
    this.store(next);
  }

  private resetNoProgressIfNeeded(): void {
    if (!this.snapshot || this.snapshot.goal.noProgressCount === 0) return;
    const next = cloneSnapshot(this.snapshot);
    next.generation += 1;
    next.goal.noProgressCount = 0;
    next.goal.updatedAt = this.nowIso();
    this.store(next);
  }

  private armRetryTimer(): void {
    this.clearRetryTimer();
    if (!this.snapshot || this.snapshot.goal.status !== "retry_wait" || !this.snapshot.goal.nextRetryAt) return;
    const token = ++this.retryTimerGeneration;
    const epoch = this.sessionEpoch;
    const instanceKey = this.snapshot.instanceKey;
    const generation = this.snapshot.generation;
    const delay = Math.max(0, Date.parse(this.snapshot.goal.nextRetryAt) - this.nowMs());
    this.retryTimer = this.setTimeoutFn(() => {
      this.retryTimer = undefined;
      if (token !== this.retryTimerGeneration || epoch !== this.sessionEpoch || this.shuttingDown ||
          this.snapshot?.instanceKey !== instanceKey || this.snapshot.generation !== generation || this.snapshot.goal.status !== "retry_wait") return;
      this.retryDue = true;
      this.reevaluateRetry();
    }, delay);
    (this.retryTimer as { unref?: () => void }).unref?.();
  }

  private clearRetryTimer(): void {
    this.retryTimerGeneration += 1;
    if (this.retryTimer !== undefined) this.clearTimeoutFn(this.retryTimer);
    this.retryTimer = undefined;
    this.retryDue = false;
  }

  private reevaluateRetry(): void {
    const ctx = this.ctx;
    if (!ctx || !this.retryDue || !this.snapshot || this.snapshot.goal.status !== "retry_wait") return;
    const candidate = this.captureDeliveryCandidate(ctx, "exact");
    if (!candidate || !this.safeToDeliver(candidate, ctx)) return;
    this.retryDue = false;
    const next = cloneSnapshot(this.snapshot);
    next.generation += 1;
    next.goal.status = "active";
    next.goal.updatedAt = this.nowIso();
    next.goal.nextRetryAt = null;
    this.store(next);
    this.emitStateEvent("provider_retry_active", "provider_retry_timer_elapsed");
    this.requestContinuation(ctx);
  }

  private requestContinuation(ctx: ExtensionContext): void {
    if (!this.snapshot || this.snapshot.goal.status !== "active" || this.shuttingDown) return;
    const candidate = this.captureDeliveryCandidate(ctx, "exact");
    if (!candidate) return;
    const deferredEpoch = this.deferredEpoch;
    const requestKey = JSON.stringify([
      candidate.instanceKey,
      candidate.generation,
      candidate.sessionEpoch,
      deferredEpoch,
      candidate.sessionId,
      candidate.branchLeafId,
      candidate.branchEntryIds,
      candidate.branchPolicy,
      candidate.externalInputGeneration,
    ]);
    if (this.pendingContinuationRequestKey === requestKey) return;
    this.pendingContinuationRequestKey = requestKey;
    this.defer(() => {
      if (this.pendingContinuationRequestKey === requestKey) this.pendingContinuationRequestKey = undefined;
      if (deferredEpoch !== this.deferredEpoch || !this.safeToDeliver(candidate, ctx)) return;
      const current = this.snapshot as GoalSnapshot;
      let pending = this.pendingContinuation;
      if (!pending || pending.instanceKey !== current.instanceKey || pending.generation !== current.generation ||
          pending.sessionEpoch !== candidate.sessionEpoch || pending.sessionId !== candidate.sessionId) {
        const deliveryKey = `${current.instanceKey}:${current.generation}:${++this.deliverySequence}`;
        pending = {
          instanceKey: current.instanceKey,
          generation: current.generation,
          sessionEpoch: candidate.sessionEpoch,
          sessionId: candidate.sessionId,
          branchLeafId: candidate.branchLeafId,
          externalInputGeneration: candidate.externalInputGeneration,
          deliveryKey,
          continuationNumber: this.cachedContinuationCount + 1,
          content: goalContinuationContent(current.goal),
        };
        this.pendingContinuation = pending;
      }
      this.pendingAutoRunKey = pending.deliveryKey;
      try {
        this.sendContinuationMessage({
          customType: GOAL_CONTINUATION_MESSAGE_TYPE,
          content: pending.content,
          display: true,
          details: {
            type: GOAL_CONTINUATION_MESSAGE_TYPE,
            deliveryKey: pending.deliveryKey,
            continuationNumber: pending.continuationNumber,
            goal: cloneGoal(current.goal),
          } satisfies GoalContinuationMessageDetails,
        }, { deliverAs: "steer", triggerTurn: true });
      } catch {
        this.pendingAutoRunKey = undefined;
      }
    });
  }

  private captureDeliveryCandidate(
    ctx: ExtensionContext,
    branchPolicy: DeliveryCandidate["branchPolicy"],
  ): DeliveryCandidate | undefined {
    const snapshot = this.snapshot;
    if (!snapshot || snapshot.goal.status !== "active" && snapshot.goal.status !== "retry_wait") return;
    return {
      instanceKey: snapshot.instanceKey,
      generation: snapshot.generation,
      externalInputGeneration: this.externalInputGeneration,
      sessionEpoch: this.sessionEpoch,
      sessionId: ctx.sessionManager.getSessionId(),
      branchLeafId: ctx.sessionManager.getLeafId(),
      branchEntryIds: ctx.sessionManager.getBranch().map((entry) => entry.id),
      branchPolicy,
    };
  }

  private completeIdle(ctx: ExtensionContext): boolean {
    if (this.deliveryPaused || this.isNotificationDeliveryPaused()) return false;
    if (this.hasActiveSubagents() || this.hasPendingSubagentNotifications() || this.hasBlockingMonitors()) return false;
    if (this.askWaitingCount() !== 0 || !ctx.isIdle() || ctx.hasPendingMessages()) return false;
    return true;
  }

  private branchMatchesCandidate(candidate: DeliveryCandidate, currentCtx: ExtensionContext): boolean {
    const currentEntryIds = currentCtx.sessionManager.getBranch().map((entry) => entry.id);
    const currentLeafId = currentCtx.sessionManager.getLeafId();
    if ((currentEntryIds.at(-1) ?? null) !== currentLeafId) return false;
    if (candidate.branchPolicy === "exact") {
      return currentLeafId === candidate.branchLeafId &&
        currentEntryIds.length === candidate.branchEntryIds.length &&
        candidate.branchEntryIds.every((id, index) => currentEntryIds[index] === id);
    }
    return currentEntryIds.length >= candidate.branchEntryIds.length &&
      candidate.branchEntryIds.every((id, index) => currentEntryIds[index] === id);
  }

  private safeToDeliver(candidate: DeliveryCandidate, currentCtx: ExtensionContext): boolean {
    if (this.shuttingDown || candidate.sessionEpoch < 1 || this.sessionEpoch !== candidate.sessionEpoch) return false;
    if (!this.snapshot || this.snapshot.goal.status !== "active" && this.snapshot.goal.status !== "retry_wait") return false;
    if (this.snapshot.instanceKey !== candidate.instanceKey || this.snapshot.generation !== candidate.generation) return false;
    if (currentCtx.sessionManager.getSessionId() !== candidate.sessionId) return false;
    if (!this.branchMatchesCandidate(candidate, currentCtx)) return false;
    if (this.externalInputGeneration !== candidate.externalInputGeneration) return false;
    return this.completeIdle(currentCtx);
  }

  private invalidatePendingContinuation(): void {
    this.deferredEpoch += 1;
    this.pendingContinuation = undefined;
    this.pendingContinuationRequestKey = undefined;
    this.pendingAutoRunKey = undefined;
  }

  private emitStateEvent(event: GoalAutomaticEvent, reason: string): void {
    if (!this.snapshot) return;
    const message = { event, reason, goal: cloneGoal(this.snapshot.goal) };
    if (this.deliveryPaused || this.isNotificationDeliveryPaused()) {
      this.queuedStateMessages.push(message);
      return;
    }
    this.sendStateMessage(message);
  }

  private flushStateMessages(): void {
    while (!this.deliveryPaused && !this.isNotificationDeliveryPaused() && !this.shuttingDown && this.queuedStateMessages.length > 0) {
      this.sendStateMessage(this.queuedStateMessages.shift() as { event: GoalAutomaticEvent; reason: string; goal: PublicGoalState });
    }
  }

  private sendStateMessage(message: { event: GoalAutomaticEvent; reason: string; goal: PublicGoalState }): void {
    this.pi.sendMessage({
      customType: GOAL_STATE_MESSAGE_TYPE,
      content: goalStateEventContent(message.event, message.goal),
      display: true,
      details: {
        type: GOAL_STATE_MESSAGE_TYPE,
        event: message.event,
        reason: message.reason,
        goal: cloneGoal(message.goal),
      } satisfies GoalStateMessageDetails,
    }, { deliverAs: "steer", triggerTurn: false });
  }

  private store(snapshot: GoalSnapshot): void {
    this.snapshot = cloneSnapshot(snapshot);
    this.pendingContinuation = undefined;
    this.pendingContinuationRequestKey = undefined;
    this.pendingAutoRunKey = undefined;
    this.pi.appendEntry(GOAL_STATE_ENTRY_TYPE, cloneSnapshot(snapshot));
    this.activitySerial += 1;
    this.emit();
  }

  private emit(): void {
    this.refreshDerivedView();
    this.widget.update();
    if (this.listeners.size === 0) return;
    const state = this.status();
    for (const listener of [...this.listeners]) listener(state);
  }

  private nowIso(): string {
    return new Date(this.nowMs()).toISOString();
  }

  private clearRuntime(clearMessages: boolean): void {
    this.deferredEpoch += 1;
    this.clearRetryTimer();
    this.pendingContinuation = undefined;
    this.pendingContinuationRequestKey = undefined;
    this.pendingAutoRunKey = undefined;
    this.logicalRun = undefined;
    this.finalAssistant = undefined;
    this.retryDue = false;
    if (clearMessages) this.queuedStateMessages = [];
  }
}

export function registerGoalRuntime(pi: ExtensionAPI, options?: GoalRuntimeOptions): GoalRuntime {
  const runtime = new GoalRuntime(pi, options);
  runtime.register();
  return runtime;
}
