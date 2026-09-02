import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  CACHE_RETENTION_ENV_VAR,
  cacheRetentionEnvValue,
  type CacheRetention,
} from "../cache-retention.js";
import { FAST_ENV_VAR, fastEnvValue } from "../fast-mode.js";
import {
  SubagentRegistry,
  isTerminalStatus,
  requireString,
  restoreRunJournal,
  runJournalClearEntry,
  runJournalEntry,
  runJournalReplacementEntry,
  validateCreateInput,
  type PersistedRun,
  type RunStatus,
  type SubagentRunCheck,
  type SubagentRunSummary,
  type SupervisorRequest,
} from "./core.js";
import {
  SUBAGENT_ACTIONS,
  SUBAGENT_PUBLIC_FIELDS,
  SUBAGENT_TOOL_CONTRACT,
  SUBAGENT_TOOL_ERRORS,
  SUBAGENT_WARNINGS,
  modelJson,
  modelJsonResult,
  subagentActionModelResult,
  subagentClearModelResult,
  subagentDeleteModelResult,
  subagentNotificationContent,
  subagentParameters,
  subagentResumeModelResult,
  subagentRunModelResult,
} from "../tool-contracts.js";
import { sameModelSpecBase } from "./model-display.js";
import {
  atomicWriteJson,
  createForkSessionFile,
  ensureRunPaths,
  getGoalStatsRoot,
  getPiInvocation,
  getProcessIdentity,
  getRunPaths,
  getRunRoot,
  isPidAlive,
  launchDetachedRunner,
  listOwnerRunIds,
  readGoalStatsSidecar,
  readLaunchConfig,
  readRunnerIdentity,
  readRunState,
  removeChildSessionFile,
  removeRunFiles,
  tailLog,
  writeControl,
  writeGoalStatsSidecar,
  type DetachedLaunchConfig,
  type DetachedRunActivity,
  type DetachedRunState,
  type GoalRunStatsSidecar,
  type InvocationSeams,
  type RunPaths,
} from "./run-files.js";
import {
  SUBAGENT_NOTIFICATION_TYPE,
  renderSubagentCall,
  renderSubagentNotification,
  renderSubagentResult,
} from "./transcript-renderer.js";
import {
  type ViewerRunActivity,
  type ViewerRunSnapshot,
  type ViewerSnapshot,
} from "./viewer-data.js";
import { SubagentWidget } from "./widget.js";

const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const CHILD_EXTENSION = join(EXTENSION_DIR, "child-supervisor.ts");
const DETACHED_RUNNER = join(EXTENSION_DIR, "runner", "omps-runner.mjs");
const SNAPSHOT_TYPE = "oh-my-pi-slim:subagents";
const ACTIVE_STATUSES = new Set<RunStatus>(["starting", "running", "waiting"]);
const RUN_STATUSES_FOR_NOTIFICATIONS = new Set<string>(["waiting", "completed", "failed", "interrupted"]);
const DEFAULT_POLL_MS = 250;
const DEFAULT_GRACE_MS = 5000;
const DEFAULT_SHUTDOWN_WAIT_MS = 3500;
const DEFAULT_INTERRUPT_WAIT_MS = 8000;
const POST_TERM_GRACE_MS = 1500;
const INTERRUPT_ERROR = "Interrupted by the supervisor session.";
type CacheRetentionResolver = () => CacheRetention;
type FastModeResolver = () => boolean;

type TimerHandle = ReturnType<typeof setInterval>;

interface RuntimeOptions {
  sendMessage?: ExtensionAPI["sendMessage"];
  now?: () => string;
  nowMs?: () => number;
  pollMs?: number;
  graceMs?: number;
  shutdownWaitMs?: number;
  interruptWaitMs?: number;
  invocationSeams?: InvocationSeams;
  launchRunner?: typeof launchDetachedRunner;
  getProcessIdentity?: (pid: number) => string | undefined;
  pidAlive?: (pid: number) => boolean;
  killPid?: (pid: number, signal: NodeJS.Signals) => void;
  controlWriter?: typeof writeControl;
  setInterval?: (callback: () => void, ms: number) => TimerHandle;
  clearInterval?: (timer: TimerHandle) => void;
  sleep?: (ms: number) => Promise<void>;
  readGoalStats?: typeof readGoalStatsSidecar;
  writeGoalStats?: typeof writeGoalStatsSidecar;
}

interface RuntimeInput {
  abstract?: unknown;
  fork?: unknown;
  cwd?: unknown;
  action?: unknown;
  id?: unknown;
  message?: unknown;
}

interface RunHealth {
  trackedAt: number;
  lastHeartbeat?: string;
  staleSince?: number;
}

interface RepliedSeq {
  waitingSeq: number;
  sentAt: number;
}

export interface SubagentClearReceipt {
  clearedCount: number;
  warnings: string[];
  changed: boolean;
}

export interface SubagentDeleteReceipt {
  id: string;
  deleted: true;
  changed: true;
  warnings: string[];
}

interface NotificationDelivery {
  runId: string;
  event: RunStatus;
  waitingSeq?: number;
  deliveryKey: string;
}

export interface SubagentGoalStats {
  runCount: number;
  tokens: number;
  tools: number;
  turns: number;
  compactions: number;
}

interface GoalRunActivity {
  tokens: number;
  tools: number;
  turns: number;
  compactions: number;
}

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function publicSchemaKeys(schema: { properties?: Record<string, unknown> }): string[] {
  return Object.keys(schema.properties ?? {}).sort();
}

function rejectUnknownFields(input: object, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(input).filter((field) => !allowed.includes(field));
  if (unknown.length > 0) throw new Error(SUBAGENT_TOOL_ERRORS.unknownFields(label, unknown));
}

export function shouldApproveChildProject(projectTrusted: boolean, parentCwd: string, childCwd: string): boolean {
  if (!projectTrusted) return false;
  try {
    const path = relative(realpathSync(parentCwd), realpathSync(childCwd));
    return path === "" || (!path.startsWith("..") && !isAbsolute(path));
  } catch {
    return false;
  }
}

function canonicalSessionFile(path: string): string {
  try { return realpathSync(path); } catch { return resolve(path); }
}

function sameRequest(left: SupervisorRequest | undefined, right: SupervisorRequest | undefined): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

const NOTIFICATION_DELIVERY_PREFIX = "oh-my-pi-slim:subagent-notification:";

function notificationDeliveryKey(runId: string, event: RunStatus, waitingSeq?: number): string | undefined {
  if (event === "waiting") {
    if (!Number.isInteger(waitingSeq) || Number(waitingSeq) < 1) return;
    return `${NOTIFICATION_DELIVERY_PREFIX}${JSON.stringify([runId, event, waitingSeq])}`;
  }
  if (!isTerminalStatus(event)) return;
  return `${NOTIFICATION_DELIVERY_PREFIX}${JSON.stringify([runId, event])}`;
}

function notificationRunIdFromDeliveryKey(deliveryKey: string): string | undefined {
  if (!deliveryKey.startsWith(NOTIFICATION_DELIVERY_PREFIX)) return;
  try {
    const parts: unknown = JSON.parse(deliveryKey.slice(NOTIFICATION_DELIVERY_PREFIX.length));
    return Array.isArray(parts) && typeof parts[0] === "string" ? parts[0] : undefined;
  } catch {
    return;
  }
}

function notificationDeliveryFromDetails(value: unknown): NotificationDelivery | undefined {
  const details = asRecord(value);
  if (!details) return;
  const run = asRecord(details.run);
  const runId = typeof details.runId === "string"
    ? details.runId
    : typeof run?.id === "string" ? run.id : undefined;
  const eventValue = typeof details.event === "string" ? details.event : details.status;
  if (!runId || typeof eventValue !== "string" || !RUN_STATUSES_FOR_NOTIFICATIONS.has(eventValue)) return;
  const event = eventValue as RunStatus;
  const waitingSeq = Number.isInteger(details.waitingSeq) && Number(details.waitingSeq) >= 1
    ? Number(details.waitingSeq)
    : undefined;
  const derivedKey = notificationDeliveryKey(runId, event, waitingSeq);
  if (!derivedKey) return;
  if (details.deliveryKey !== undefined && details.deliveryKey !== derivedKey) return;
  return { runId, event, waitingSeq, deliveryKey: derivedKey };
}

function stateRequest(value: Record<string, unknown> | undefined, runId: string): SupervisorRequest | undefined {
  if (!value) return;
  if (
    value.runId !== runId ||
    !["need_decision", "interview_request", "progress_update"].includes(String(value.reason)) ||
    typeof value.message !== "string" || typeof value.createdAt !== "string" ||
    (value.interview !== undefined && (!value.interview || typeof value.interview !== "object" || Array.isArray(value.interview)))
  ) return;
  return {
    runId,
    reason: value.reason as SupervisorRequest["reason"],
    message: value.message,
    interview: value.interview as Record<string, unknown> | undefined,
    createdAt: value.createdAt,
  };
}

/** Structured deep copy for viewer payloads, so no nested runtime object is ever handed out. */
function cloneViewerValue<T>(value: T): T | undefined {
  if (value === undefined) return undefined;
  try { return JSON.parse(JSON.stringify(value)) as T; }
  catch { return undefined; }
}

function compareViewerRunsByCreatedAt(left: ViewerRunSnapshot, right: ViewerRunSnapshot): number {
  const leftCreated = Date.parse(left.createdAt);
  const rightCreated = Date.parse(right.createdAt);
  const leftValid = Number.isFinite(leftCreated);
  const rightValid = Number.isFinite(rightCreated);
  if (leftValid && rightValid && leftCreated !== rightCreated) return leftCreated < rightCreated ? -1 : 1;
  if (leftValid !== rightValid) return leftValid ? -1 : 1;
  if (left.id === right.id) return 0;
  return left.id < right.id ? -1 : 1;
}

function cloneViewerActivity(activity: DetachedRunActivity | undefined): ViewerRunActivity {
  const activeTools: Record<string, { name: string; startedAt?: string }> = {};
  for (const [key, tool] of Object.entries(activity?.activeTools ?? {})) {
    if (!tool || typeof tool.name !== "string") continue;
    activeTools[key] = tool.startedAt === undefined ? { name: tool.name } : { name: tool.name, startedAt: tool.startedAt };
  }
  return {
    turnCount: activity?.turnCount ?? 0,
    toolUses: activity?.toolUses ?? 0,
    activeTools,
    responseText: activity?.responseText ?? "",
    tokens: activity?.tokens ?? 0,
    contextPercent: activity?.contextPercent,
    compactionCount: activity?.compactionCount ?? 0,
  };
}

function stateActivity(state: DetachedRunState): DetachedRunActivity {
  return {
    turnCount: state.turnCount,
    toolUses: state.toolUses,
    activeTools: { ...state.activeTools },
    responseText: state.responseText,
    tokens: state.tokens,
    contextPercent: state.contextPercent,
    compactionCount: state.compactionCount,
  };
}

function parseGoalRunActivity(value: unknown): { runId: string; activity: GoalRunActivity } | undefined {
  const journal = asRecord(value);
  const run = asRecord(journal?.run);
  const stats = asRecord(journal?.goalStats);
  if (journal?.version !== 2 || typeof run?.id !== "string" || !stats) return;
  const fields = ["tokens", "tools", "turns", "compactions"] as const;
  if (fields.some((field) => typeof stats[field] !== "number" || !Number.isFinite(stats[field]) || Number(stats[field]) < 0 || !Number.isInteger(stats[field]))) return;
  return {
    runId: run.id,
    activity: {
      tokens: Number(stats.tokens),
      tools: Number(stats.tools),
      turns: Number(stats.turns),
      compactions: Number(stats.compactions),
    },
  };
}

if (JSON.stringify(publicSchemaKeys(subagentParameters)) !== JSON.stringify([...SUBAGENT_PUBLIC_FIELDS].sort())) {
  throw new Error("OMPS subagent tool schema drifted from its public field contract.");
}

export class OmpsSubagentRuntime {
  readonly registry = new SubagentRegistry();
  private readonly pi: ExtensionAPI;
  private readonly sendMessage: ExtensionAPI["sendMessage"];
  private readonly now: () => string;
  private readonly nowMs: () => number;
  private readonly pollMs: number;
  private readonly graceMs: number;
  private readonly shutdownWaitMs: number;
  private readonly interruptWaitMs: number;
  private readonly invocationSeams?: InvocationSeams;
  private readonly launchRunner: typeof launchDetachedRunner;
  private readonly processIdentity: (pid: number) => string | undefined;
  private readonly pidAlive: (pid: number) => boolean;
  private readonly killPid: (pid: number, signal: NodeJS.Signals) => void;
  private readonly controlWriter: typeof writeControl;
  private readonly setIntervalFn: (callback: () => void, ms: number) => TimerHandle;
  private readonly clearIntervalFn: (timer: TimerHandle) => void;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly readGoalStats: typeof readGoalStatsSidecar;
  private readonly writeGoalStats: typeof writeGoalStatsSidecar;
  private readonly widget: SubagentWidget;
  private readonly activity = new Map<string, DetachedRunActivity>();
  private readonly goalActivity = new Map<string, GoalRunActivity>();
  private readonly loadedGoalStatsSidecars = new Set<string>();
  private readonly runCreatedListeners = new Set<(runId: string) => void>();
  private readonly health = new Map<string, RunHealth>();
  private readonly repliedSeqs = new Map<string, RepliedSeq>();
  private readonly queuedNotifications = new Set<string>();
  /** In-flight reconciliation pass per run, so a later termination can wait it out instead of racing its stop. */
  private readonly reconciling = new Map<string, Promise<void>>();
  private readonly clearedRunIds = new Set<string>();
  /** Run-scoped write and delivery suppression while one terminal retained run is being deleted. */
  private readonly deletingRunIds = new Set<string>();
  /** One shared termination per run, so concurrent interrupts and shutdown never race two stop sequences. */
  private readonly terminating = new Map<string, Promise<PersistedRun>>();
  /** Whether the last termination of a run confirmed that its detached runner actually stopped. */
  /** Run-scoped suppression owned by a synchronous interrupt that will hand back the final result itself. */
  private readonly notificationSuppression = new Map<string, number>();
  private notificationDeliveryPaused = false;
  private clearing = false;
  private readonly unsubscribeRegistry: () => void;
  private ctx?: ExtensionContext;
  private ownerSessionId?: string;
  private runRoot?: string;
  private goalStatsRoot?: string;
  private cacheRetentionResolver: CacheRetentionResolver = () => "short";
  private fastModeResolver: FastModeResolver = () => false;
  private poller?: TimerHandle;
  private shuttingDown = false;
  /** Bumped by restore and shutdown so an in-flight interrupt never hands a result to a replaced session. */
  private generation = 0;

  constructor(pi: ExtensionAPI, options: RuntimeOptions = {}) {
    this.pi = pi;
    this.sendMessage = options.sendMessage ?? ((message, sendOptions) => this.pi.sendMessage(message, sendOptions));
    this.now = options.now ?? (() => new Date().toISOString());
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.pollMs = options.pollMs ?? DEFAULT_POLL_MS;
    this.graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
    this.shutdownWaitMs = options.shutdownWaitMs ?? DEFAULT_SHUTDOWN_WAIT_MS;
    this.interruptWaitMs = options.interruptWaitMs ?? DEFAULT_INTERRUPT_WAIT_MS;
    this.invocationSeams = options.invocationSeams;
    this.launchRunner = options.launchRunner ?? launchDetachedRunner;
    this.processIdentity = options.getProcessIdentity ?? getProcessIdentity;
    this.pidAlive = options.pidAlive ?? isPidAlive;
    this.killPid = options.killPid ?? ((pid, signal) => process.kill(pid, signal));
    this.controlWriter = options.controlWriter ?? writeControl;
    this.setIntervalFn = options.setInterval ?? ((callback, ms) => setInterval(callback, ms));
    this.clearIntervalFn = options.clearInterval ?? ((timer) => clearInterval(timer));
    this.sleep = options.sleep ?? ((ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)));
    this.readGoalStats = options.readGoalStats ?? readGoalStatsSidecar;
    this.writeGoalStats = options.writeGoalStats ?? writeGoalStatsSidecar;
    this.widget = new SubagentWidget(() => this.registry.list().map((run) => ({ ...run, activity: this.activity.get(run.id) })));
    this.unsubscribeRegistry = this.registry.subscribe(() => this.widget.update());
  }

  private supervisorModelSpec(): string {
    const model = this.ctx?.model;
    if (!model) throw new Error(SUBAGENT_TOOL_ERRORS.supervisorModel);
    return `${model.provider}/${model.id}:${this.ctx?.thinkingLevel ?? "off"}`;
  }

  setCacheRetentionResolver(resolver: CacheRetentionResolver = () => "short"): void {
    this.cacheRetentionResolver = resolver;
  }

  setFastModeResolver(resolver: FastModeResolver = () => false): void {
    this.fastModeResolver = resolver;
  }

  setNotificationDeliveryPaused(paused: boolean): void {
    if (this.notificationDeliveryPaused === paused) return;
    this.notificationDeliveryPaused = paused;
    if (paused || this.shuttingDown) return;
    for (const run of this.registry.list()) this.deliverPendingNotification(run.id);
  }

  hasActiveRuns(): boolean {
    return this.registry.list().some((run) => ACTIVE_STATUSES.has(run.status));
  }

  /**
   * Read-only snapshot for the Subagent viewer.
   *
   * Membership is exactly the retained set used by `registry.list()`, the list result, and the
   * Agents widget. Only this snapshot has its own navigation order. Valid `createdAt` values sort
   * oldest first with ID tie-breaking, followed by invalid values in ID order. Status and
   * `updatedAt` therefore never move an existing run, while a resumed run joins at its new creation
   * position. Every field is copied, so the viewer cannot reach runtime-owned objects.
   */
  viewerSnapshot(): ViewerSnapshot {
    const runs: ViewerRunSnapshot[] = [];
    for (const run of this.registry.list()) {
      runs.push({
        id: run.id,
        abstract: run.abstract,
        status: run.status,
        live: this.registry.isLive(run.id),
        model: run.model,
        cwd: run.cwd,
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
        sessionFile: run.sessionFile,
        sourceRunId: run.sourceRunId,
        output: run.output,
        error: run.error,
        request: cloneViewerValue(run.request),
        activity: cloneViewerActivity(this.activity.get(run.id)),
        // A terminal run is frozen at its own end: a later resume appends to the same child session
        // file, and this bound is what keeps those turns out of this run's transcript.
        transcriptCutoff: isTerminalStatus(run.status) ? run.updatedAt : undefined,
      });
    }
    runs.sort(compareViewerRunsByCreatedAt);
    let childSessionDir: string | undefined;
    try { childSessionDir = this.ctx ? this.childSessionDir() : undefined; }
    catch { childSessionDir = undefined; }
    return { runs, childSessionDir };
  }

  hasPendingNotifications(): boolean {
    return this.queuedNotifications.size > 0 || this.registry.list().some((run) => this.pendingNotificationDelivery(run) !== undefined);
  }

  subscribeRunCreated(listener: (runId: string) => void): () => void {
    this.runCreatedListeners.add(listener);
    return () => this.runCreatedListeners.delete(listener);
  }

  goalStats(runIds: readonly string[]): SubagentGoalStats {
    const ids = [...new Set(runIds)];
    const result: SubagentGoalStats = { runCount: ids.length, tokens: 0, tools: 0, turns: 0, compactions: 0 };
    for (const id of ids) {
      this.loadGoalStatsSidecar(id);
      const stats = this.goalActivity.get(id);
      if (!stats) continue;
      result.tokens += stats.tokens;
      result.tools += stats.tools;
      result.turns += stats.turns;
      result.compactions += stats.compactions;
    }
    return result;
  }

  registerTools(): void {
    this.pi.registerMessageRenderer(SUBAGENT_NOTIFICATION_TYPE, renderSubagentNotification);
    this.pi.registerTool({
      name: SUBAGENT_TOOL_CONTRACT.name,
      label: "Subagent",
      description: SUBAGENT_TOOL_CONTRACT.description,
      parameters: SUBAGENT_TOOL_CONTRACT.parameters,
      execute: async (toolCallId, params, signal) => this.executeSubagent(params as RuntimeInput, signal, toolCallId),
      renderCall: renderSubagentCall,
      renderResult: renderSubagentResult,
    });
  }

  async restore(ctx: ExtensionContext, notificationDeliveryPaused = false): Promise<void> {
    this.generation += 1;
    this.stopPoller();
    this.widget.dispose();
    this.activity.clear();
    this.goalActivity.clear();
    this.loadedGoalStatsSidecars.clear();
    this.health.clear();
    this.repliedSeqs.clear();
    this.queuedNotifications.clear();
    this.clearedRunIds.clear();
    // `terminating` and `notificationSuppression` deliberately survive a generation change: an interrupt started by the
    // previous session still owns the only stop sequence for that OS process, and restore or shutdown must share it
    // instead of signaling twice. The generation only blocks the stale handoff, never the shared termination itself.
    this.clearing = false;
    this.notificationDeliveryPaused = notificationDeliveryPaused;
    this.ctx = ctx;
    this.ownerSessionId = ctx.sessionManager.getSessionId();
    this.runRoot = getRunRoot(ctx.sessionManager.getSessionDir());
    this.goalStatsRoot = getGoalStatsRoot(ctx.sessionManager.getSessionDir());
    this.shuttingDown = false;
    this.widget.setUICtx(ctx.mode === "tui" ? ctx.ui : undefined);

    const entries: unknown[] = [];
    const deliveredNotifications = new Map<string, NotificationDelivery>();
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === SNAPSHOT_TYPE) {
        entries.push(entry.data);
        const goalActivity = parseGoalRunActivity(entry.data);
        if (goalActivity) this.goalActivity.set(goalActivity.runId, goalActivity.activity);
      }
      if (entry.type === "custom_message" && entry.customType === SUBAGENT_NOTIFICATION_TYPE) {
        const delivery = notificationDeliveryFromDetails(entry.details);
        if (delivery) deliveredNotifications.set(delivery.deliveryKey, delivery);
      }
    }
    const restored = restoreRunJournal(entries, this.now());
    this.registry.restore(restored.runs);
    for (const id of restored.clearedRunIds) this.clearedRunIds.add(id);
    for (const run of restored.runs) this.loadGoalStatsSidecar(run.id);
    for (const delivery of deliveredNotifications.values()) this.acknowledgeNotificationDelivery(delivery);
    await this.collectRunDirectoryGarbage(new Set(restored.runs.map((run) => run.id)));

    await Promise.all(restored.activeRunIds.map(async (id) => {
      const target = this.validConfig(id);
      const state = target ? readRunState(target.paths) : undefined;
      if (target && state?.token === target.config.token && state.runId === id && isTerminalStatus(state.status)) {
        this.applyState(id, state, true);
      } else {
        await this.terminateRun(id, "Supervisor session ended before the run completed.", true).catch(() => undefined);
      }
    }));
    for (const run of this.registry.list()) this.deliverPendingNotification(run.id);
    this.startPoller();
    this.widget.update();
  }

  onTurnStart(): void {
    this.widget.onTurnStart();
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.generation += 1;
    this.shuttingDown = true;
    this.stopPoller();
    this.queuedNotifications.clear();
    this.clearing = false;
    this.notificationDeliveryPaused = false;
    const activeIds = this.registry.list().filter((run) => ACTIVE_STATUSES.has(run.status)).map((run) => run.id);
    await Promise.all(activeIds.map((id) => this.terminateRun(id, "Supervisor session shut down.", false).catch(() => undefined)));
    this.widget.dispose();
    this.activity.clear();
    this.goalActivity.clear();
    this.loadedGoalStatsSidecars.clear();
    this.health.clear();
    this.repliedSeqs.clear();
    this.queuedNotifications.clear();
    this.clearedRunIds.clear();
    this.notificationDeliveryPaused = false;
    this.ctx = undefined;
    this.ownerSessionId = undefined;
    this.runRoot = undefined;
    this.goalStatsRoot = undefined;
  }

  private startPoller(): void {
    this.poller = this.setIntervalFn(() => {
      void this.reconcileAll().catch((error) => {
        console.error(`[oh-my-pi-slim] Detached run reconciliation failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }, this.pollMs);
    this.poller.unref?.();
  }

  private stopPoller(): void {
    if (!this.poller) return;
    this.clearIntervalFn(this.poller);
    this.poller = undefined;
  }

  private persistRun(run: PersistedRun): void {
    if (!this.ctx || this.clearing || this.deletingRunIds.has(run.id)) return;
    const journal = runJournalEntry(run);
    const goalStats = this.goalActivity.get(run.id);
    this.pi.appendEntry(SNAPSHOT_TYPE, goalStats ? { ...journal, goalStats: { ...goalStats } } : journal);
  }

  private loadGoalStatsSidecar(id: string): void {
    if (this.loadedGoalStatsSidecars.has(id)) return;
    this.loadedGoalStatsSidecars.add(id);
    if (!this.goalStatsRoot || !this.ownerSessionId) return;
    let sidecar: GoalRunStatsSidecar | undefined;
    try { sidecar = this.readGoalStats(this.goalStatsRoot, this.ownerSessionId, id); }
    catch { return; }
    if (!sidecar) return;
    const current = this.goalActivity.get(id);
    const restored: GoalRunActivity = {
      tokens: sidecar.tokens,
      tools: sidecar.tools,
      turns: sidecar.turns,
      compactions: sidecar.compactions,
    };
    this.goalActivity.set(id, current ? {
      tokens: Math.max(current.tokens, restored.tokens),
      tools: Math.max(current.tools, restored.tools),
      turns: Math.max(current.turns, restored.turns),
      compactions: Math.max(current.compactions, restored.compactions),
    } : restored);
  }

  private captureGoalActivity(id: string, state: DetachedRunState): void {
    this.loadGoalStatsSidecar(id);
    const current = this.goalActivity.get(id);
    const observed: GoalRunActivity = {
      tokens: Number.isFinite(state.providerTokens) && Number(state.providerTokens) >= 0 ? Number(state.providerTokens) : 0,
      tools: state.toolUses,
      turns: state.turnCount,
      compactions: state.compactionCount,
    };
    const next: GoalRunActivity = current ? {
      tokens: Math.max(current.tokens, observed.tokens),
      tools: Math.max(current.tools, observed.tools),
      turns: Math.max(current.turns, observed.turns),
      compactions: Math.max(current.compactions, observed.compactions),
    } : observed;
    if (current && current.tokens === next.tokens && current.tools === next.tools &&
        current.turns === next.turns && current.compactions === next.compactions) return;
    this.goalActivity.set(id, next);
    this.loadedGoalStatsSidecars.add(id);
    if (!this.goalStatsRoot || !this.ownerSessionId) return;
    try {
      this.writeGoalStats(this.goalStatsRoot, this.ownerSessionId, {
        version: 1,
        runId: id,
        ...next,
      });
    } catch {
      // Goal stats persistence is best-effort and must never affect subagent lifecycle.
    }
  }

  private updateRun(id: string, patch: Partial<PersistedRun>): PersistedRun {
    if (this.deletingRunIds.has(id)) return this.registry.require(id);
    const run = this.registry.update(id, patch);
    this.persistRun(run);
    return run;
  }

  private newRunId(): string {
    let id = randomUUID().slice(0, 8);
    while (this.registry.get(id) || this.clearedRunIds.has(id)) id = randomUUID().slice(0, 8);
    return id;
  }

  /** Resolves a run for an ID-bearing action and distinguishes removed history from an unknown ID. */
  private requireRun(id: string): PersistedRun {
    const run = this.registry.get(id);
    if (run) return run;
    if (this.clearedRunIds.has(id)) {
      throw new Error(SUBAGENT_TOOL_ERRORS.removed(id));
    }
    return this.registry.require(id);
  }

  private pathsFor(id: string): RunPaths {
    if (!this.runRoot || !this.ownerSessionId) throw new Error(SUBAGENT_TOOL_ERRORS.unattached);
    return getRunPaths(this.runRoot, this.ownerSessionId, id);
  }

  private childSessionDir(): string {
    if (!this.ctx) throw new Error(SUBAGENT_TOOL_ERRORS.unattached);
    return resolve(this.ctx.sessionManager.getSessionDir(), "omps-subagents");
  }

  private createForkSession(toolCallId: string, cwd: string, timestamp: string): string {
    if (!this.ctx) throw new Error(SUBAGENT_TOOL_ERRORS.unattached);
    const batch = [...this.ctx.sessionManager.getEntries()].reverse().find((entry) => {
      if (entry.type !== "message" || entry.message.role !== "assistant" || !Array.isArray(entry.message.content)) return false;
      return entry.message.content.some((part) => part.type === "toolCall" && part.id === toolCallId);
    });
    if (!batch) throw new Error(SUBAGENT_TOOL_ERRORS.forkBatch);
    if (!batch.parentId) throw new Error(SUBAGENT_TOOL_ERRORS.forkRoot);
    const header = this.ctx.sessionManager.getHeader();
    if (!header) throw new Error(SUBAGENT_TOOL_ERRORS.forkHeader);
    return createForkSessionFile(
      this.childSessionDir(),
      cwd,
      this.ctx.sessionManager.getSessionFile(),
      header.version,
      this.ctx.sessionManager.getBranch(batch.parentId),
      timestamp,
    );
  }

  private validConfig(id: string): { paths: RunPaths; config: DetachedLaunchConfig } | undefined {
    const paths = this.pathsFor(id);
    const config = readLaunchConfig(paths);
    if (!config || config.runId !== id || config.ownerSessionId !== this.ownerSessionId) return;
    return { paths, config };
  }

  private signalProcess(pid: number, signal: NodeJS.Signals): void {
    if (process.platform === "win32") {
      this.killPid(pid, signal);
      return;
    }
    try { this.killPid(-pid, signal); } catch { this.killPid(pid, signal); }
  }

  private readVerifiedState(
    target: { paths: RunPaths; config: DetachedLaunchConfig },
    id: string,
  ): DetachedRunState | undefined {
    const state = readRunState(target.paths);
    return state?.token === target.config.token && state.runId === id ? state : undefined;
  }

  private verifiedProcess(
    target: { paths: RunPaths; config: DetachedLaunchConfig },
    id: string,
  ): { pid: number; processIdentity: string } | undefined {
    const identity = readRunnerIdentity(target.paths);
    const state = readRunState(target.paths);
    let reason: string | undefined;
    if (!identity || identity.token !== target.config.token || identity.runId !== id) {
      reason = "runner identity is missing or invalid";
    } else if (state && (state.token !== target.config.token || state.runId !== id)) {
      reason = "runner state is not bound to this launch";
    } else if (state && state.pid !== identity.pid) {
      reason = `state PID ${state.pid} does not match runner PID ${identity.pid}`;
    } else if (!this.pidAlive(identity.pid)) {
      return { pid: identity.pid, processIdentity: identity.processIdentity };
    } else {
      const currentIdentity = this.processIdentity(identity.pid);
      if (!currentIdentity) reason = `OS process identity for PID ${identity.pid} is unavailable`;
      else if (currentIdentity !== identity.processIdentity) reason = `OS process identity for PID ${identity.pid} changed`;
      else return { pid: identity.pid, processIdentity: identity.processIdentity };
    }
    console.error(`[oh-my-pi-slim] Retaining unverifiable detached run directory ${target.paths.runDir}: ${reason}.`);
    return;
  }

  private async stopVerifiedProcess(
    target: { paths: RunPaths; config: DetachedLaunchConfig },
    id: string,
  ): Promise<{ state?: DetachedRunState; safeToCleanup: boolean }> {
    let state = this.readVerifiedState(target, id);
    let processTarget = this.verifiedProcess(target, id);
    if (!processTarget) return { state, safeToCleanup: false };
    if (!this.pidAlive(processTarget.pid)) return { state, safeToCleanup: true };

    try { this.signalProcess(processTarget.pid, "SIGTERM"); } catch { /* already exited */ }
    await this.sleep(POST_TERM_GRACE_MS);
    state = this.readVerifiedState(target, id) ?? state;
    if (!this.pidAlive(processTarget.pid)) return { state, safeToCleanup: true };

    processTarget = this.verifiedProcess(target, id);
    if (!processTarget) return { state, safeToCleanup: false };
    try { this.signalProcess(processTarget.pid, "SIGKILL"); } catch { /* already exited */ }
    await this.sleep(POST_TERM_GRACE_MS);
    state = this.readVerifiedState(target, id) ?? state;
    return { state, safeToCleanup: !this.pidAlive(processTarget.pid) };
  }

  private cleanupRun(id: string): void {
    try { removeRunFiles(this.pathsFor(id)); } catch { /* best-effort GC */ }
  }

  /** Retained runs keep their directories until `subagent clear`; only branch-orphan directories are collected here. */
  private async collectRunDirectoryGarbage(branchRunIds: Set<string>): Promise<void> {
    if (!this.runRoot || !this.ownerSessionId) return;
    for (const id of listOwnerRunIds(this.runRoot, this.ownerSessionId)) {
      if (branchRunIds.has(id)) continue;
      const paths = this.pathsFor(id);
      const config = readLaunchConfig(paths);
      if (!config || config.runId !== id || config.ownerSessionId !== this.ownerSessionId) {
        console.error(`[oh-my-pi-slim] Retaining unverifiable orphan run directory: ${paths.runDir}`);
        continue;
      }
      const target = { paths, config };
      const state = readRunState(paths);
      const verifiedState = state?.token === config.token && state.runId === id ? state : undefined;
      if (state && !verifiedState) {
        console.error(`[oh-my-pi-slim] Retaining orphan run directory with unverifiable state: ${paths.runDir}`);
        continue;
      }
      const stopped = await this.stopVerifiedProcess(target, id);
      if (stopped.safeToCleanup) this.cleanupRun(id);
    }
  }

  private pendingNotificationDelivery(run: PersistedRun): NotificationDelivery | undefined {
    const event = run.notificationPending;
    if (!event) return;
    if (event === "waiting") {
      if (run.status !== "waiting" || !run.request || !run.waitingSeq) return;
      const deliveryKey = notificationDeliveryKey(run.id, event, run.waitingSeq);
      return deliveryKey ? { runId: run.id, event, waitingSeq: run.waitingSeq, deliveryKey } : undefined;
    }
    if (run.status !== event || !isTerminalStatus(event)) return;
    const deliveryKey = notificationDeliveryKey(run.id, event);
    return deliveryKey ? { runId: run.id, event, deliveryKey } : undefined;
  }

  private acknowledgeNotificationDelivery(delivery: NotificationDelivery): boolean {
    if (this.deletingRunIds.has(delivery.runId)) return false;
    this.queuedNotifications.delete(delivery.deliveryKey);
    const run = this.registry.get(delivery.runId);
    if (!run) return false;
    const pending = this.pendingNotificationDelivery(run);
    if (!pending || pending.deliveryKey !== delivery.deliveryKey) return false;
    this.updateRun(run.id, { notificationPending: undefined });
    return true;
  }

  acknowledgeNotificationMessage(messageValue: unknown): boolean {
    const message = asRecord(messageValue);
    if (message?.role !== "custom" || message.customType !== SUBAGENT_NOTIFICATION_TYPE) return false;
    const delivery = notificationDeliveryFromDetails(message.details);
    return delivery ? this.acknowledgeNotificationDelivery(delivery) : false;
  }

  private sendNotification(run: PersistedRun, delivery: NotificationDelivery): void {
    this.sendMessage(
      {
        customType: SUBAGENT_NOTIFICATION_TYPE,
        content: subagentNotificationContent(run.id, delivery.event, run.request, run.output, run.error),
        display: true,
        details: {
          run: this.formatRun(run),
          event: delivery.event,
          runId: run.id,
          status: delivery.event,
          request: run.request,
          waitingSeq: delivery.waitingSeq,
          reason: run.request?.reason,
          deliveryKey: delivery.deliveryKey,
        },
      },
      { deliverAs: "steer", triggerTurn: true },
    );
  }

  /**
   * Single choke point for every automatic lifecycle notification.
   * A run suppressed by an in-flight synchronous interrupt returns its final result through that tool call instead.
   */
  private deliverPendingNotification(id: string): void {
    if (this.shuttingDown || this.clearing || this.deletingRunIds.has(id) ||
        this.notificationDeliveryPaused || this.notificationSuppression.has(id)) return;
    const run = this.registry.get(id);
    if (!run) return;
    const delivery = this.pendingNotificationDelivery(run);
    if (!delivery || this.queuedNotifications.has(delivery.deliveryKey)) return;
    this.queuedNotifications.add(delivery.deliveryKey);
    try { this.sendNotification(run, delivery); }
    catch { this.queuedNotifications.delete(delivery.deliveryKey); }
  }

  private acquireNotificationSuppression(id: string): void {
    this.notificationSuppression.set(id, (this.notificationSuppression.get(id) ?? 0) + 1);
  }

  private releaseNotificationSuppression(id: string): void {
    const held = this.notificationSuppression.get(id);
    if (held === undefined) return;
    if (held <= 1) this.notificationSuppression.delete(id);
    else this.notificationSuppression.set(id, held - 1);
  }

  retryQueuedNotificationsAfterAgentSettled(): void {
    if (this.clearing) return;
    const pendingByKey = new Map<string, NotificationDelivery>();
    for (const run of this.registry.list()) {
      if (this.deletingRunIds.has(run.id)) continue;
      const delivery = this.pendingNotificationDelivery(run);
      if (delivery) pendingByKey.set(delivery.deliveryKey, delivery);
    }
    for (const deliveryKey of [...this.queuedNotifications]) {
      const runId = notificationRunIdFromDeliveryKey(deliveryKey);
      if (runId && this.deletingRunIds.has(runId)) continue;
      const delivery = pendingByKey.get(deliveryKey);
      this.queuedNotifications.delete(deliveryKey);
      if (delivery) this.deliverPendingNotification(delivery.runId);
    }
  }

  private failRun(id: string, error: string, notify = true): PersistedRun {
    const current = this.registry.require(id);
    if (isTerminalStatus(current.status)) return current;
    this.registry.markLive(id, false);
    this.health.delete(id);
    this.repliedSeqs.delete(id);
    const failed = this.updateRun(id, {
      status: "failed",
      error,
      request: undefined,
      notificationPending: "failed",
      updatedAt: this.now(),
    });
    if (notify) this.deliverPendingNotification(id);
    return this.registry.require(id);
  }

  private applyState(id: string, state: DetachedRunState, notify = true): PersistedRun {
    const current = this.registry.require(id);
    this.activity.set(id, stateActivity(state));
    const request = stateRequest(state.request, id);
    const waitingSeq = state.waitingSeq;
    const waitingRequestChanged = current.status === "waiting" && state.status === "waiting" &&
      (current.waitingSeq !== waitingSeq || !sameRequest(current.request, request));
    const enteredWaiting = current.status !== "waiting" && state.status === "waiting";
    const enteredTerminal = !isTerminalStatus(current.status) && isTerminalStatus(state.status);
    const clearWaitingPending = state.status === "running" && current.notificationPending === "waiting";
    const notificationPending = enteredTerminal
      ? state.status
      : notify && (enteredWaiting || waitingRequestChanged)
        ? "waiting"
        : clearWaitingPending ? undefined : current.notificationPending;
    const logicalChange = current.status !== state.status || current.sessionFile !== state.sessionFile ||
      current.waitingSeq !== waitingSeq || current.output !== state.output || current.error !== state.error ||
      !sameRequest(current.request, request) ||
      current.notificationPending !== notificationPending;
    this.captureGoalActivity(id, state);
    let next = current;
    if (logicalChange) {
      next = this.updateRun(id, {
        status: state.status,
        sessionFile: state.sessionFile,
        request,
        waitingSeq,
        output: state.output,
        error: state.error,
        notificationPending,
        updatedAt: state.updatedAt,
      });
      if (notify && notificationPending) this.deliverPendingNotification(id);
      next = this.registry.require(id);
    }
    if (isTerminalStatus(next.status)) {
      this.registry.markLive(id, false);
      this.health.delete(id);
      this.repliedSeqs.delete(id);
    }
    this.widget.update();
    return next;
  }

  private async failUnhealthyRun(
    id: string,
    target: { paths: RunPaths; config: DetachedLaunchConfig },
    error: string,
  ): Promise<void> {
    try { this.controlWriter(target.paths, target.config.token, "interrupt"); } catch { /* force termination below */ }
    const stopped = await this.stopVerifiedProcess(target, id);
    if (stopped.state && isTerminalStatus(stopped.state.status)) {
      this.applyState(id, stopped.state, true);
      return;
    }
    this.failRun(id, error, true);
  }

  private reconcileRun(id: string): Promise<void> {
    if (this.clearing || this.deletingRunIds.has(id)) return Promise.resolve();
    // A run already owned by a termination must never be failed, re-controlled, or re-signaled here:
    // that owner writes the single interrupt control, performs the only stop, and adopts the authoritative terminal state.
    if (this.terminating.has(id)) return Promise.resolve();
    if (this.reconciling.has(id)) return Promise.resolve();
    // The pass owns its own cleanup, so a termination waiting on it can never deadlock this map.
    const pass = this.runReconcilePass(id).finally(() => { this.reconciling.delete(id); });
    pass.catch(() => undefined);
    this.reconciling.set(id, pass);
    return pass;
  }

  private async runReconcilePass(id: string): Promise<void> {
    const run = this.registry.get(id);
    if (!run || isTerminalStatus(run.status)) return;
    const target = this.validConfig(id);
    if (!target) {
      const paths = this.pathsFor(id);
      if (!existsSync(paths.runDir)) {
        this.updateRun(id, {
          status: "interrupted",
          error: SUBAGENT_TOOL_ERRORS.directoryMissing,
          request: undefined,
          notificationPending: "interrupted",
          updatedAt: this.now(),
        });
        this.registry.markLive(id, false);
        this.health.delete(id);
        this.repliedSeqs.delete(id);
        this.deliverPendingNotification(id);
      } else {
        console.error(`[oh-my-pi-slim] Retaining unverifiable detached run directory ${paths.runDir}: launch config is missing or invalid.`);
        this.failRun(id, "Detached launch config is missing or invalid.", true);
      }
      return;
    }

    const state = readRunState(target.paths);
    const health = this.health.get(id) ?? { trackedAt: this.nowMs() };
    this.health.set(id, health);
    if (!state || state.token !== target.config.token || state.runId !== id) {
      this.registry.markLive(id, false);
      if (this.nowMs() - health.trackedAt >= this.graceMs) {
        const log = tailLog(target.paths.logFile).trim();
        await this.failUnhealthyRun(id, target, `Detached runner did not publish valid state.${log ? ` Runner log:\n${log}` : ""}`);
      }
      return;
    }

    const repliedSeq = this.repliedSeqs.get(id);
    let suppressWaitingReply = false;
    if (repliedSeq) {
      if (state.status === "running" || isTerminalStatus(state.status) || state.waitingSeq !== repliedSeq.waitingSeq) {
        this.repliedSeqs.delete(id);
      } else if (state.status === "waiting" && this.nowMs() - repliedSeq.sentAt < this.graceMs) {
        suppressWaitingReply = true;
      } else if (this.nowMs() - repliedSeq.sentAt >= this.graceMs) {
        this.repliedSeqs.delete(id);
      }
    }

    const next = suppressWaitingReply
      ? (this.activity.set(id, stateActivity(state)), this.widget.update(), run)
      : this.applyState(id, state);
    if (isTerminalStatus(next.status)) return;
    if (!this.pidAlive(state.pid)) {
      this.failRun(id, "Detached runner process exited before publishing a terminal state.", true);
      return;
    }
    this.registry.markLive(id, true);

    if (health.lastHeartbeat !== state.heartbeatAt) {
      health.lastHeartbeat = state.heartbeatAt;
      health.staleSince = undefined;
      return;
    }
    const heartbeatMs = Date.parse(state.heartbeatAt);
    if (!Number.isFinite(heartbeatMs) || this.nowMs() - heartbeatMs <= this.graceMs) {
      health.staleSince = undefined;
      return;
    }
    health.staleSince ??= this.nowMs();
    if (this.nowMs() - health.staleSince >= this.graceMs) {
      await this.failUnhealthyRun(id, target, "Detached runner heartbeat no longer advances.");
    }
  }

  private async reconcileAll(): Promise<void> {
    if (this.shuttingDown || this.clearing) return;
    await Promise.all(this.registry.list()
      .filter((run) => ACTIVE_STATUSES.has(run.status))
      .map((run) => this.reconcileRun(run.id)));
  }

  /**
   * Drives one run to a terminal status and resolves with the retained final run.
   * Concurrent callers share a single in-flight termination per run, so interrupt, shutdown, and restore never duplicate it.
   */
  private terminateRun(id: string, error: string, notify: boolean, waitMs = this.shutdownWaitMs): Promise<PersistedRun> {
    const inFlight = this.terminating.get(id);
    if (inFlight) return inFlight;
    const current = this.registry.get(id);
    if (!current) return Promise.reject(new Error(SUBAGENT_TOOL_ERRORS.noLongerRetained(id)));
    if (isTerminalStatus(current.status)) {
      return Promise.resolve(current);
    }
    // Ownership is registered before any termination work starts, so no reconciliation observed in between
    // can write a second control, signal the same process, or overwrite the authoritative terminal state.
    const settled = Promise.resolve()
      .then(() => this.runTermination(id, error, notify, waitMs))
      .finally(() => { this.terminating.delete(id); });
    // An aborted or abandoned caller must never turn a shared termination failure into an unhandled rejection.
    settled.catch(() => undefined);
    this.terminating.set(id, settled);
    return settled;
  }

  private adoptTerminalState(id: string, state: DetachedRunState, notify: boolean): PersistedRun {
    return this.applyState(id, state, notify);
  }

  /**
   * Waits out a reconciliation pass that entered before this termination registered ownership.
   * That pass may already own an interrupt control and a bounded verified stop, so its terminal result is authoritative.
   */
  private async settledByInFlightReconciliation(id: string): Promise<PersistedRun | undefined> {
    const inFlight = this.reconciling.get(id);
    if (!inFlight) return;
    await inFlight.catch(() => undefined);
    const current = this.registry.get(id);
    if (!current) throw new Error(SUBAGENT_TOOL_ERRORS.noLongerRetained(id));
    if (!isTerminalStatus(current.status)) return;
    return current;
  }

  private async runTermination(id: string, error: string, notify: boolean, waitMs: number): Promise<PersistedRun> {
    const reconciled = await this.settledByInFlightReconciliation(id);
    if (reconciled) return reconciled;
    const target = this.validConfig(id);
    let latestState: DetachedRunState | undefined;
    let stopConfirmed = false;
    if (target) {
      latestState = this.readVerifiedState(target, id);
      if (latestState && isTerminalStatus(latestState.status)) return this.adoptTerminalState(id, latestState, notify);
      try { this.controlWriter(target.paths, target.config.token, "interrupt"); } catch { /* force termination below */ }
      const deadline = this.nowMs() + waitMs;
      while (this.nowMs() < deadline) {
        await this.sleep(Math.min(50, Math.max(1, deadline - this.nowMs())));
        latestState = this.readVerifiedState(target, id) ?? latestState;
        if (latestState && isTerminalStatus(latestState.status)) return this.adoptTerminalState(id, latestState, notify);
      }
      latestState = this.readVerifiedState(target, id) ?? latestState;
      if (latestState && isTerminalStatus(latestState.status)) return this.adoptTerminalState(id, latestState, notify);
      const stopped = await this.stopVerifiedProcess(target, id);
      latestState = stopped.state ?? latestState;
      if (latestState && isTerminalStatus(latestState.status)) return this.adoptTerminalState(id, latestState, notify);
      stopConfirmed = stopped.safeToCleanup;
      if (latestState) this.activity.set(id, stateActivity(latestState));
    }
    const run = this.registry.require(id);
    this.updateRun(id, {
      status: "interrupted",
      sessionFile: latestState?.sessionFile ?? run.sessionFile,
      output: latestState?.output ?? run.output,
      error: stopConfirmed ? error : `${error} ${SUBAGENT_TOOL_ERRORS.stopUnconfirmed}`,
      request: undefined,
      notificationPending: "interrupted",
      updatedAt: this.now(),
    });
    this.registry.markLive(id, false);
    this.health.delete(id);
    this.repliedSeqs.delete(id);
    if (notify) this.deliverPendingNotification(id);
    return this.registry.require(id);
  }

  private async awaitWithAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined, message: string): Promise<T> {
    if (!signal) return promise;
    if (signal.aborted) throw abortError(message);
    let onAbort: (() => void) | undefined;
    try {
      return await Promise.race([promise, new Promise<never>((_, reject) => {
        onAbort = () => reject(abortError(message));
        signal.addEventListener("abort", onAbort, { once: true });
      })]);
    } finally {
      if (onAbort) signal.removeEventListener("abort", onAbort);
    }
  }

  /**
   * Stops one live run and hands its complete final result back to the caller.
   * Suppression is acquired synchronously, so the terminal lifecycle notification is never sent, retried, or replayed.
   */
  private async interruptRun(id: string, signal: AbortSignal | undefined) {
    const generation = this.generation;
    this.acquireNotificationSuppression(id);
    try {
      const terminal = await this.awaitWithAbort(
        this.terminateRun(id, INTERRUPT_ERROR, true, this.interruptWaitMs),
        signal,
        `Interrupt of ${id} was aborted before its result was handed back.`,
      );
      if (this.shuttingDown || this.generation !== generation || !this.registry.get(id)) {
        throw new Error(SUBAGENT_TOOL_ERRORS.handoffUnavailable(id, terminal.status));
      }
      // Synchronous handoff: clearing the pending event is what removes this terminal delivery from
      // the queue, from any future agent-settled retry, and from the next session's restore replay.
      const handed = this.registry.require(id);
      if (handed.notificationPending !== undefined) this.updateRun(id, { notificationPending: undefined });
      const final = this.registry.require(id);
      const visible = this.formatRunCheck(final);
      return modelJsonResult(
        subagentActionModelResult(final.id, final.status, final.output, final.error),
        { run: visible },
      );
    } finally {
      this.releaseNotificationSuppression(id);
      this.deliverPendingNotification(id);
    }
  }

  private formatRunSummary(run: PersistedRun): SubagentRunSummary {
    return {
      id: run.id,
      abstract: run.abstract,
      status: run.status,
      ...(run.sourceRunId !== undefined ? { sourceRunId: run.sourceRunId } : {}),
    };
  }

  private formatRunCheck(run: PersistedRun): SubagentRunCheck {
    const summary = this.formatRunSummary(run);
    if (!isTerminalStatus(run.status)) return summary;
    return {
      ...summary,
      ...(run.output !== undefined ? { output: run.output } : {}),
      ...(run.error !== undefined ? { error: run.error } : {}),
    };
  }

  private formatRun(run: PersistedRun) {
    return Object.fromEntries(Object.entries({
      ...run,
      live: this.registry.isLive(run.id),
      activity: this.activity.get(run.id),
    }).filter(([, value]) => value !== undefined));
  }

  private buildLaunchConfig(
    run: PersistedRun,
    resumeSessionFile?: string,
    resumeCompactFrom?: string,
  ): DetachedLaunchConfig {
    if (!this.ctx || !this.ownerSessionId) throw new Error(SUBAGENT_TOOL_ERRORS.unattached);
    const approve = shouldApproveChildProject(this.ctx.isProjectTrusted(), this.ctx.cwd, run.cwd);
    const args = [
      "--mode", "rpc",
      "--model", run.model,
      approve ? "--approve" : "--no-approve",
      "--session-dir", this.childSessionDir(),
    ];
    args.push("--extension", CHILD_EXTENSION);
    if (resumeSessionFile) args.push("--session", resumeSessionFile);
    return {
      v: 1,
      runId: run.id,
      token: randomUUID(),
      ownerSessionId: this.ownerSessionId,
      abstract: run.abstract,
      task: run.task,
      cwd: run.cwd,
      model: run.model,
      approve,
      childSessionDir: this.childSessionDir(),
      resumeSessionFile,
      ...(resumeSessionFile && resumeCompactFrom ? { resumeCompactFrom } : {}),
      piInvocation: getPiInvocation(args, this.invocationSeams),
      env: {
        PI_SUBAGENT_CHILD: "1",
        OMPS_SUBAGENT_CHILD: "1",
        [CACHE_RETENTION_ENV_VAR]: cacheRetentionEnvValue(this.cacheRetentionResolver()),
        [FAST_ENV_VAR]: fastEnvValue(this.fastModeResolver()),
        OMPS_PARENT_RUN_ID: run.id,
        OMPS_RUN_ID: run.id,
      },
      createdAt: run.createdAt,
    };
  }

  private async launchRun(run: PersistedRun, resumeSessionFile?: string, resumeCompactFrom?: string) {
    const paths = this.pathsFor(run.id);
    ensureRunPaths(paths);
    const config = this.buildLaunchConfig(run, resumeSessionFile, resumeCompactFrom);
    atomicWriteJson(paths.configFile, config);
    this.registry.add(run, false);
    this.persistRun(run);
    for (const listener of [...this.runCreatedListeners]) listener(run.id);
    this.health.set(run.id, { trackedAt: this.nowMs() });
    let launchedPid: number | undefined;
    try {
      const launched = await this.launchRunner(paths.configFile, DETACHED_RUNNER, {
        cwd: run.cwd,
        env: config.env,
        logFile: paths.logFile,
        invocationSeams: this.invocationSeams,
      });
      launchedPid = launched.pid;
      const processIdentity = this.processIdentity(launched.pid);
      if (!processIdentity) throw new Error(SUBAGENT_TOOL_ERRORS.processIdentity(launched.pid));
      atomicWriteJson(paths.identityFile, {
        v: 1,
        token: config.token,
        runId: run.id,
        pid: launched.pid,
        processIdentity,
      });
      this.registry.markLive(run.id, true);
    } catch (error) {
      if (launchedPid !== undefined && this.pidAlive(launchedPid)) {
        try { this.signalProcess(launchedPid, "SIGTERM"); } catch { /* already exited */ }
        await this.sleep(POST_TERM_GRACE_MS);
        if (this.pidAlive(launchedPid)) {
          try { this.signalProcess(launchedPid, "SIGKILL"); } catch { /* already exited */ }
          await this.sleep(POST_TERM_GRACE_MS);
        }
      }
      this.failRun(run.id, error instanceof Error ? error.message : String(error), true);
    }
    const retained = this.registry.require(run.id);
    return modelJsonResult(subagentActionModelResult(retained.id, retained.status), {
      run: this.formatRun(retained),
    });
  }

  private async executeSubagent(input: RuntimeInput, signal: AbortSignal | undefined, toolCallId: string) {
    rejectUnknownFields(input, SUBAGENT_PUBLIC_FIELDS, "subagent");
    const action = requireString(input.action, "action");
    if (!SUBAGENT_ACTIONS.includes(action as (typeof SUBAGENT_ACTIONS)[number])) {
      throw new Error(SUBAGENT_TOOL_ERRORS.unsupportedAction(action));
    }
    if (action === "create") {
      if (input.id !== undefined) throw new Error(SUBAGENT_TOOL_ERRORS.createFields);
      return this.launchCreate(input, toolCallId);
    }
    if (action === "resume") {
      if (input.fork !== undefined) throw new Error(SUBAGENT_TOOL_ERRORS.actionCreateFields(action, ["fork"]));
      const id = requireString(input.id, "id");
      const abstract = requireString(input.abstract, "abstract");
      const message = requireString(input.message, "message");
      const cwd = input.cwd === undefined ? undefined : requireString(input.cwd, "cwd");
      await this.reconcileRun(id);
      return this.resume(id, abstract, message, cwd);
    }
    const createFields = ["abstract", "fork", "cwd"].filter((field) => input[field as keyof RuntimeInput] !== undefined);
    if (createFields.length > 0) throw new Error(SUBAGENT_TOOL_ERRORS.actionCreateFields(action, createFields));
    if ((action === "list" || action === "clear") && (input.id !== undefined || input.message !== undefined)) {
      throw new Error(SUBAGENT_TOOL_ERRORS.actionIdMessage(action));
    }
    if ((action === "check" || action === "interrupt" || action === "delete") && input.message !== undefined) {
      throw new Error(SUBAGENT_TOOL_ERRORS.actionMessage(action));
    }

    if (action === "list") {
      await this.reconcileAll();
      const runs = this.registry.list().map((run) => this.formatRunSummary(run));
      return modelJsonResult(runs.map(subagentRunModelResult), { runs });
    }

    if (action === "clear") return this.clearRetainedRuns();

    const id = requireString(input.id, "id");
    if (action === "delete") return this.deleteRetainedRun(id);
    await this.reconcileRun(id);
    if (action === "check") {
      const run = this.formatRunCheck(this.requireRun(id));
      return modelJsonResult(subagentRunModelResult(run), { run });
    }
    if (action === "reply") return this.reply(id, requireString(input.message, "message"));
    const run = this.requireRun(id);
    if (isTerminalStatus(run.status)) {
      const terminalRun = action === "interrupt" ? this.formatRunCheck(run) : this.formatRunSummary(run);
      const receipt = action === "interrupt"
        ? subagentActionModelResult(id, run.status, run.output, run.error)
        : subagentActionModelResult(id, run.status);
      return modelJsonResult(receipt, { run: terminalRun });
    }
    const target = this.validConfig(id);
    if (!target) throw new Error(SUBAGENT_TOOL_ERRORS.noControl(id));
    if (action === "steer") {
      if (run.status !== "running") throw new Error(SUBAGENT_TOOL_ERRORS.steerStatus(id, run.status));
      const message = requireString(input.message, "message");
      if (message.trimStart().startsWith("/")) {
        throw new Error(SUBAGENT_TOOL_ERRORS.steerSlash);
      }
      this.controlWriter(target.paths, target.config.token, "steer", message);
      return modelJsonResult(subagentActionModelResult(id, run.status), { run: this.formatRunSummary(run) });
    }
    return this.interruptRun(id, signal);
  }

  private async launchCreate(input: RuntimeInput, toolCallId: string) {
    if (this.shuttingDown) throw new Error(SUBAGENT_TOOL_ERRORS.shuttingDown);
    const launch = validateCreateInput(input);
    const now = this.now();
    const cwd = launch.cwd ? resolve(this.ctx?.cwd ?? process.cwd(), launch.cwd) : this.ctx?.cwd ?? process.cwd();
    const sessionFile = launch.fork ? this.createForkSession(toolCallId, cwd, now) : undefined;
    const run: PersistedRun = {
      id: this.newRunId(),
      abstract: launch.abstract,
      task: launch.message,
      cwd,
      model: this.supervisorModelSpec(),
      status: "starting",
      ...(sessionFile ? { sessionFile } : {}),
      createdAt: now,
      updatedAt: now,
    };
    return this.launchRun(run, sessionFile);
  }

  private purgeChildSessionFiles(cleared: readonly PersistedRun[], retained: readonly PersistedRun[]): string[] {
    const warnings: string[] = [];
    const childDir = this.childSessionDir();
    const retainedFiles = new Set(retained
      .filter((run) => run.sessionFile !== undefined)
      .map((run) => canonicalSessionFile(run.sessionFile as string)));
    const handled = new Set<string>();
    for (const run of cleared) {
      if (run.sessionFile === undefined) continue;
      const canonical = canonicalSessionFile(run.sessionFile);
      if (handled.has(canonical)) continue;
      handled.add(canonical);
      if (retainedFiles.has(canonical)) {
        warnings.push(SUBAGENT_WARNINGS.sharedSession(run.id));
        continue;
      }
      const removal = removeChildSessionFile(childDir, run.sessionFile);
      if (!removal.removed) warnings.push(SUBAGENT_WARNINGS.sessionRemoval(run.id, removal.reason));
    }
    return warnings;
  }

  /**
   * Removes retained Subagent run directories and exclusively owned child session files.
   * Anything that cannot be removed safely stays on disk and only produces a warning.
   */
  private purgeRetainedRuns(runs: readonly PersistedRun[], retained: readonly PersistedRun[]): string[] {
    const warnings: string[] = [];
    for (const run of runs) {
      try { removeRunFiles(this.pathsFor(run.id)); }
      catch (error) {
        warnings.push(SUBAGENT_WARNINGS.runRemoval(run.id, error instanceof Error ? error.message : String(error)));
      }
    }
    warnings.push(...this.purgeChildSessionFiles(runs, retained));
    return warnings;
  }

  private clearQueuedNotificationsForRun(id: string): void {
    for (const deliveryKey of [...this.queuedNotifications]) {
      if (notificationRunIdFromDeliveryKey(deliveryKey) === id) this.queuedNotifications.delete(deliveryKey);
    }
  }

  private async deleteRetainedRun(id: string) {
    if (this.shuttingDown) throw new Error(SUBAGENT_TOOL_ERRORS.shuttingDown);
    if (this.clearing) throw new Error(SUBAGENT_TOOL_ERRORS.clearRunning);
    if (this.deletingRunIds.has(id)) throw new Error(SUBAGENT_TOOL_ERRORS.deleteRunning(id));

    await this.reconcileRun(id);
    const inFlight = this.reconciling.get(id);
    if (inFlight) await inFlight.catch(() => undefined);
    const target = this.requireRun(id);
    if (ACTIVE_STATUSES.has(target.status)) {
      throw new Error(SUBAGENT_TOOL_ERRORS.deleteActive(id, target.status));
    }

    this.deletingRunIds.add(id);
    try {
      const survivors = this.registry.list().filter((run) => run.id !== id);
      const warnings = this.purgeRetainedRuns([target], survivors);
      this.pi.appendEntry(SNAPSHOT_TYPE, runJournalReplacementEntry(survivors));
      this.registry.delete(id);
      this.clearedRunIds.add(id);
      this.activity.delete(id);
      this.health.delete(id);
      this.repliedSeqs.delete(id);
      this.clearQueuedNotificationsForRun(id);
      const receipt: SubagentDeleteReceipt = { id, deleted: true, changed: true, warnings };
      return modelJsonResult(subagentDeleteModelResult(id, warnings), receipt);
    } finally {
      this.deletingRunIds.delete(id);
    }
  }

  private async clearRetainedRuns() {
    if (this.shuttingDown) throw new Error(SUBAGENT_TOOL_ERRORS.shuttingDown);
    if (this.clearing) throw new Error(SUBAGENT_TOOL_ERRORS.clearRunning);
    await this.reconcileAll();
    const runs = this.registry.list();
    const active = runs.filter((run) => ACTIVE_STATUSES.has(run.status));
    if (active.length > 0) {
      throw new Error(SUBAGENT_TOOL_ERRORS.clearActive(active.map((run) => `${run.id} (${run.status})`).join(", ")));
    }
    const receipt: SubagentClearReceipt = { clearedCount: 0, warnings: [], changed: false };
    if (runs.length === 0) return modelJsonResult(subagentClearModelResult(0, []), receipt);

    this.clearing = true;
    try {
      receipt.warnings = this.purgeRetainedRuns(runs, []);
      receipt.clearedCount = runs.length;
      receipt.changed = true;
      this.pi.appendEntry(SNAPSHOT_TYPE, runJournalClearEntry());
      for (const run of runs) {
        this.clearedRunIds.add(run.id);
        this.activity.delete(run.id);
        this.health.delete(run.id);
        this.repliedSeqs.delete(run.id);
      }
      this.queuedNotifications.clear();
      this.registry.clear();
      this.widget.update();
    } finally {
      this.clearing = false;
    }
    return modelJsonResult(subagentClearModelResult(receipt.clearedCount, receipt.warnings), receipt);
  }

  /**
   * An omitted cwd inherits the source run's working directory, while a relative override resolves like create against the supervisor session.
   *
   * A resumed run always inherits the supervisor session's current model and thinking level.
   * When that crosses a provider/model base, the runner compacts the reused session once before its first prompt.
   */
  private async resume(sourceId: string, abstract: string, message: string, cwd?: string) {
    const source = this.requireRun(sourceId);
    if (!isTerminalStatus(source.status)) throw new Error(SUBAGENT_TOOL_ERRORS.resumeStatus(sourceId, source.status));
    if (!source.sessionFile || !existsSync(source.sessionFile)) throw new Error(SUBAGENT_TOOL_ERRORS.resumeFile(sourceId));
    const sessionFile = canonicalSessionFile(source.sessionFile);
    const conflicting = this.registry.list().find((run) =>
      run.sessionFile !== undefined && canonicalSessionFile(run.sessionFile) === sessionFile && ACTIVE_STATUSES.has(run.status));
    if (conflicting) throw new Error(SUBAGENT_TOOL_ERRORS.sessionConflict(source.sessionFile, conflicting.id));
    const model = this.supervisorModelSpec();
    const resumeCompactFrom = sameModelSpecBase(source.model, model) ? undefined : source.model;
    const now = this.now();
    const run: PersistedRun = {
      id: this.newRunId(),
      abstract,
      task: message,
      cwd: cwd === undefined ? source.cwd : resolve(this.ctx?.cwd ?? process.cwd(), cwd),
      model,
      status: "starting",
      sourceRunId: sourceId,
      sessionFile: source.sessionFile,
      createdAt: now,
      updatedAt: now,
    };
    const result = await this.launchRun(run, source.sessionFile, resumeCompactFrom);
    const retained = this.registry.require(run.id);
    result.content[0].text = modelJson(subagentResumeModelResult(retained.id, sourceId, retained.status));
    return result;
  }

  private reply(id: string, message: string) {
    const current = this.requireRun(id);
    if (current.status !== "waiting") throw new Error(SUBAGENT_TOOL_ERRORS.replyStatus(id, current.status));
    if (!this.registry.isLive(id)) throw new Error(SUBAGENT_TOOL_ERRORS.replyLive(id));
    if (!current.request) throw new Error(SUBAGENT_TOOL_ERRORS.replyRequest(id));
    if (!Number.isInteger(current.waitingSeq) || Number(current.waitingSeq) < 1) {
      throw new Error(SUBAGENT_TOOL_ERRORS.replySequence(id));
    }
    const target = this.validConfig(id);
    if (!target) throw new Error(SUBAGENT_TOOL_ERRORS.noControl(id));
    this.controlWriter(target.paths, target.config.token, "reply", message, current.waitingSeq);
    this.repliedSeqs.set(id, { waitingSeq: current.waitingSeq, sentAt: this.nowMs() });
    const running = this.updateRun(id, {
      status: "running",
      request: undefined,
      notificationPending: current.notificationPending === "waiting" ? undefined : current.notificationPending,
      updatedAt: this.now(),
    });
    return modelJsonResult(subagentActionModelResult(id, running.status), { run: this.formatRunSummary(running) });
  }
}

export function registerSubagentRuntime(pi: ExtensionAPI, options?: RuntimeOptions): OmpsSubagentRuntime {
  const runtime = new OmpsSubagentRuntime(pi, options);
  runtime.registerTools();
  return runtime;
}
