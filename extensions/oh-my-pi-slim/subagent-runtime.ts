import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseFrontmatter,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  SPECIALIST_NAMES,
  SUBAGENT_ACTIONS,
  SUBAGENT_PUBLIC_FIELDS,
  SubagentRegistry,
  isTerminalStatus,
  requireString,
  restoreRunJournal,
  runJournalEntry,
  validateCreateInput,
  type PersistedRun,
  type RunStatus,
  type SpecialistName,
  type SupervisorRequest,
} from "./subagent-core.js";
import {
  atomicWriteJson,
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
} from "./subagent-run-files.js";
import {
  SUBAGENT_NOTIFICATION_TYPE,
  renderSubagentCall,
  renderSubagentNotification,
  renderSubagentResult,
} from "./subagent-transcript-renderer.js";
import { SubagentWidget, type SubagentWidgetUI } from "./subagent-widget.js";

const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(EXTENSION_DIR, "../..");
const AGENTS_DIR = join(PACKAGE_ROOT, "agents");
const CHILD_EXTENSION = join(EXTENSION_DIR, "child-supervisor.ts");
const DETACHED_RUNNER = join(EXTENSION_DIR, "runner", "omps-runner.mjs");
const SNAPSHOT_TYPE = "oh-my-pi-slim:subagents";
const ACTIVE_STATUSES = new Set<RunStatus>(["starting", "running", "waiting"]);
const RUN_STATUSES_FOR_NOTIFICATIONS = new Set<string>(["waiting", "completed", "failed", "interrupted"]);
const SPECIALISTS = new Set<SpecialistName>(SPECIALIST_NAMES);
const DEFAULT_POLL_MS = 250;
const DEFAULT_GRACE_MS = 5000;
const DEFAULT_SHUTDOWN_WAIT_MS = 3500;
const POST_TERM_GRACE_MS = 1500;
const LIFECYCLE_TOOLS = new Set(["subagent", "contact_supervisor"]);

interface AgentDefinition {
  name: SpecialistName;
  description: string;
  systemPrompt: string;
  filePath: string;
}

type ModelResolver = (agent: SpecialistName) => string;
type DenyResolver = (agent: SpecialistName) => string[];

type TimerHandle = ReturnType<typeof setInterval>;

interface RuntimeOptions {
  now?: () => string;
  nowMs?: () => number;
  pollMs?: number;
  graceMs?: number;
  shutdownWaitMs?: number;
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
  agent?: unknown;
  abstract?: unknown;
  task?: unknown;
  cwd?: unknown;
  action?: unknown;
  id?: unknown;
  message?: unknown;
}

type AgentFrontmatter = {
  name?: unknown;
  description?: unknown;
};

interface RunHealth {
  trackedAt: number;
  lastHeartbeat?: string;
  staleSince?: number;
}

interface RepliedSeq {
  waitingSeq: number;
  sentAt: number;
}

interface RunStatusSummary {
  id: string;
  agent: SpecialistName;
  abstract: string;
  status: RunStatus;
  live: boolean;
  sourceRunId?: string;
  reason?: SupervisorRequest["reason"];
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

function normalizeDeniedTools(value: readonly string[]): string[] {
  const denied: string[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    const tool = requireString(raw, "denied tool");
    if (LIFECYCLE_TOOLS.has(tool)) throw new Error(`${tool} is managed by the subagent lifecycle and cannot be denied.`);
    if (!seen.has(tool)) {
      seen.add(tool);
      denied.push(tool);
    }
  }
  return denied;
}

export function discoverPackageAgents(): Map<SpecialistName, AgentDefinition> {
  const definitions = new Map<SpecialistName, AgentDefinition>();
  const files = readdirSync(AGENTS_DIR).filter((name) => name.endsWith(".md")).sort();
  const expectedFiles = [...SPECIALISTS].map((name) => `${name}.md`).sort();
  if (JSON.stringify(files) !== JSON.stringify(expectedFiles)) {
    throw new Error(`${AGENTS_DIR} must contain exactly: ${expectedFiles.join(", ")}.`);
  }
  for (const file of files) {
    const filePath = join(AGENTS_DIR, file);
    const { frontmatter, body } = parseFrontmatter<AgentFrontmatter>(readFileSync(filePath, "utf8"));
    if (
      typeof frontmatter.name !== "string" ||
      !SPECIALISTS.has(frontmatter.name as SpecialistName) ||
      typeof frontmatter.description !== "string"
    ) continue;
    const name = frontmatter.name as SpecialistName;
    if (definitions.has(name)) throw new Error(`Duplicate package agent: ${name}`);
    definitions.set(name, {
      name,
      description: frontmatter.description,
      systemPrompt: body,
      filePath,
    });
  }
  if (definitions.size !== SPECIALISTS.size) {
    throw new Error(`Expected exactly ${SPECIALISTS.size} package agents in ${AGENTS_DIR}.`);
  }
  return definitions;
}

function toolText(text: string, details?: unknown) {
  return { content: [{ type: "text" as const, text }], details };
}

function publicSchemaKeys(schema: { properties?: Record<string, unknown> }): string[] {
  return Object.keys(schema.properties ?? {}).sort();
}

function rejectUnknownFields(input: object, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(input).filter((field) => !allowed.includes(field));
  if (unknown.length > 0) throw new Error(`${label} does not accept unknown field(s): ${unknown.join(", ")}.`);
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

function notificationDeliveryKey(runId: string, event: RunStatus, waitingSeq?: number): string | undefined {
  if (event === "waiting") {
    if (!Number.isInteger(waitingSeq) || Number(waitingSeq) < 1) return;
    return `oh-my-pi-slim:subagent-notification:${JSON.stringify([runId, event, waitingSeq])}`;
  }
  if (!isTerminalStatus(event)) return;
  return `oh-my-pi-slim:subagent-notification:${JSON.stringify([runId, event])}`;
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

export const subagentParameters = Type.Object({
  agent: Type.Optional(Type.String({ description: "For create, select the specialist role." })),
  abstract: Type.Optional(Type.String({ description: "For create or resume, provide a short run summary." })),
  task: Type.Optional(Type.String({ description: "For create, provide the complete objective." })),
  cwd: Type.Optional(Type.String({ description: "For create, provide a different working directory." })),
  action: Type.Union(SUBAGENT_ACTIONS.map((action) => Type.Literal(action)), {
    description: "Select the run action.",
  }),
  id: Type.Optional(Type.String({ description: "For steer, interrupt, resume, or reply, provide the run ID." })),
  message: Type.Optional(Type.String({
    description: "For steer, provide guidance. For resume, provide the continuation objective. For reply, provide the waiting-request answer.",
  })),
}, { additionalProperties: false });

if (JSON.stringify(publicSchemaKeys(subagentParameters)) !== JSON.stringify([...SUBAGENT_PUBLIC_FIELDS].sort())) {
  throw new Error("OMPS subagent tool schema drifted from its public field contract.");
}

export class OmpsSubagentRuntime {
  readonly registry = new SubagentRegistry();
  private readonly pi: ExtensionAPI;
  private readonly agents: Map<SpecialistName, AgentDefinition>;
  private readonly now: () => string;
  private readonly nowMs: () => number;
  private readonly pollMs: number;
  private readonly graceMs: number;
  private readonly shutdownWaitMs: number;
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
  private readonly reconciling = new Set<string>();
  private notificationDeliveryPaused = false;
  private readonly unsubscribeRegistry: () => void;
  private ctx?: ExtensionContext;
  private ownerSessionId?: string;
  private runRoot?: string;
  private goalStatsRoot?: string;
  private modelResolver?: ModelResolver;
  private denyResolver?: DenyResolver;
  private poller?: TimerHandle;
  private shuttingDown = false;

  constructor(pi: ExtensionAPI, options: RuntimeOptions = {}) {
    this.pi = pi;
    this.agents = discoverPackageAgents();
    this.now = options.now ?? (() => new Date().toISOString());
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.pollMs = options.pollMs ?? DEFAULT_POLL_MS;
    this.graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
    this.shutdownWaitMs = options.shutdownWaitMs ?? DEFAULT_SHUTDOWN_WAIT_MS;
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

  setModelResolver(resolver?: ModelResolver): void {
    this.modelResolver = resolver;
  }

  setDenyResolver(resolver?: DenyResolver): void {
    this.denyResolver = resolver;
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
      name: "subagent",
      label: "Subagent",
      description: "Create specialist runs and manage them by run ID. Resume terminal runs with a new summary and objective. Reply to waiting runs.",
      promptSnippet: "Create or manage specialist runs by ID.",
      promptGuidelines: [
        "Use only `action`, `agent`, `abstract`, `task`, and optional `cwd` for `create`.",
        "For `create`, select `agent` as the specialist role.",
        "For `create`, use `abstract` for a short run summary.",
        "For `create`, use `task` for the complete objective.",
        "For `create`, add `cwd` only for a different working directory.",
        "Expect `create` to return a new run ID.",
        "Use the returned run ID for later actions.",
        "Read each waiting notification before you reply.",
        "Read each waiting notification for the complete request and run ID.",
        "Read each terminal notification for the final output or error.",
        "Use only `action` for `list`.",
        "Use `list` to inspect active starting, running, and waiting runs.",
        "Expect `list` to return ID, agent, abstract, status, live, optional sourceRunId, and optional reason.",
        "Do not use `list` to get requests, activity, or terminal results.",
        "Use only `action`, `id`, and `message` for `steer`.",
        "For `steer`, use a running run ID in `id`.",
        "For `steer`, use `message` for complete guidance.",
        "Use only `action` and `id` for `interrupt`.",
        "For `interrupt`, use a starting, running, or waiting run ID in `id`.",
        "After `interrupt`, read the terminal notification for the actual status.",
        "Use only `action`, `id`, `abstract`, and `message` for `resume`.",
        "Resume only a terminal source run that has saved context.",
        "For `resume`, use the terminal source run ID in `id`.",
        "For `resume`, use `abstract` for a new short run summary.",
        "For `resume`, use `message` for the complete continuation objective.",
        "Expect `resume` to return a new run ID.",
        "Use the new run ID for later actions.",
        "Use only `action`, `id`, and `message` for `reply`.",
        "For `reply`, use a live waiting run ID in `id`.",
        "In `message`, answer the complete waiting request.",
        "Expect `reply` to continue the same run.",
      ],
      parameters: subagentParameters,
      execute: async (_toolCallId, params) => this.executeSubagent(params as RuntimeInput),
      renderCall: renderSubagentCall,
      renderResult: renderSubagentResult,
    });
  }

  async restore(ctx: ExtensionContext, notificationDeliveryPaused = false): Promise<void> {
    this.stopPoller();
    this.widget.dispose();
    this.activity.clear();
    this.goalActivity.clear();
    this.loadedGoalStatsSidecars.clear();
    this.health.clear();
    this.repliedSeqs.clear();
    this.queuedNotifications.clear();
    this.notificationDeliveryPaused = notificationDeliveryPaused;
    this.ctx = ctx;
    this.ownerSessionId = ctx.sessionManager.getSessionId();
    this.runRoot = getRunRoot(ctx.sessionManager.getSessionDir());
    this.goalStatsRoot = getGoalStatsRoot(ctx.sessionManager.getSessionDir());
    this.modelResolver = undefined;
    this.denyResolver = undefined;
    this.shuttingDown = false;
    this.widget.setUICtx(ctx.mode === "tui" ? ctx.ui as unknown as SubagentWidgetUI : undefined);

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
    for (const run of restored.runs) this.loadGoalStatsSidecar(run.id);
    for (const delivery of deliveredNotifications.values()) this.acknowledgeNotificationDelivery(delivery);
    await this.collectRunDirectoryGarbage(new Set(restored.runs.map((run) => run.id)));

    await Promise.all(restored.activeRunIds.map(async (id) => {
      const target = this.validConfig(id);
      const state = target ? readRunState(target.paths) : undefined;
      if (target && state?.token === target.config.token && state.runId === id && isTerminalStatus(state.status)) {
        this.applyState(id, state, true);
      } else {
        await this.terminateRun(id, "Parent session ended before the run completed.", true);
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
    this.shuttingDown = true;
    this.modelResolver = undefined;
    this.denyResolver = undefined;
    this.stopPoller();
    this.queuedNotifications.clear();
    this.notificationDeliveryPaused = false;
    const activeIds = this.registry.list().filter((run) => ACTIVE_STATUSES.has(run.status)).map((run) => run.id);
    await Promise.all(activeIds.map((id) => this.terminateRun(id, "Parent session shut down.", false)));
    this.widget.dispose();
    this.activity.clear();
    this.goalActivity.clear();
    this.loadedGoalStatsSidecars.clear();
    this.health.clear();
    this.repliedSeqs.clear();
    this.queuedNotifications.clear();
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
    if (!this.ctx) return;
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
    const run = this.registry.update(id, patch);
    this.persistRun(run);
    return run;
  }

  private newRunId(): string {
    let id = randomUUID().slice(0, 8);
    while (this.registry.get(id)) id = randomUUID().slice(0, 8);
    return id;
  }

  private pathsFor(id: string): RunPaths {
    if (!this.runRoot || !this.ownerSessionId) throw new Error("Subagent runtime is not attached to a parent session.");
    return getRunPaths(this.runRoot, this.ownerSessionId, id);
  }

  private childSessionDir(): string {
    if (!this.ctx) throw new Error("Subagent runtime is not attached to a parent session.");
    return resolve(this.ctx.sessionManager.getSessionDir(), "omps-subagents");
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

  private async collectRunDirectoryGarbage(branchRunIds: Set<string>): Promise<void> {
    if (!this.runRoot || !this.ownerSessionId) return;
    for (const id of listOwnerRunIds(this.runRoot, this.ownerSessionId)) {
      const branchRun = this.registry.get(id);
      if (branchRun && isTerminalStatus(branchRun.status)) {
        const paths = this.pathsFor(id);
        const config = readLaunchConfig(paths);
        if (!config || config.runId !== id || config.ownerSessionId !== this.ownerSessionId) {
          this.cleanupRun(id);
        } else {
          const stopped = await this.stopVerifiedProcess({ paths, config }, id);
          if (stopped.safeToCleanup) this.cleanupRun(id);
        }
        continue;
      }
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
    const request = run.request
      ? `\n\nRequest:\n${JSON.stringify(run.request, null, 2)}`
      : "";
    const output = run.output !== undefined ? `\n\nOutput: ${run.output}` : "";
    const error = run.error !== undefined ? `\n\nError: ${run.error}` : "";
    this.pi.sendMessage(
      {
        customType: SUBAGENT_NOTIFICATION_TYPE,
        content: `Subagent ${run.id} (${run.agent}) is ${delivery.event}.${request}${output}${error}`,
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

  private deliverPendingNotification(id: string): void {
    if (this.shuttingDown || this.notificationDeliveryPaused) return;
    const run = this.registry.get(id);
    if (!run) return;
    const delivery = this.pendingNotificationDelivery(run);
    if (!delivery || this.queuedNotifications.has(delivery.deliveryKey)) return;
    this.queuedNotifications.add(delivery.deliveryKey);
    try { this.sendNotification(run, delivery); }
    catch { this.queuedNotifications.delete(delivery.deliveryKey); }
  }

  retryQueuedNotificationsAfterAgentSettled(): void {
    const pendingByKey = new Map<string, NotificationDelivery>();
    for (const run of this.registry.list()) {
      const delivery = this.pendingNotificationDelivery(run);
      if (delivery) pendingByKey.set(delivery.deliveryKey, delivery);
    }
    for (const deliveryKey of [...this.queuedNotifications]) {
      const delivery = pendingByKey.get(deliveryKey);
      this.queuedNotifications.delete(deliveryKey);
      if (delivery) this.deliverPendingNotification(delivery.runId);
    }
  }

  private failRun(id: string, error: string, notify = true, cleanup = true): PersistedRun {
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
    if (cleanup) this.cleanupRun(id);
    return this.registry.require(id);
  }

  private applyState(id: string, state: DetachedRunState, notify = true, cleanup = true): PersistedRun {
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
      if (cleanup) this.cleanupRun(id);
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
      this.applyState(id, stopped.state, true, stopped.safeToCleanup);
      return;
    }
    this.failRun(id, error, true, stopped.safeToCleanup);
  }

  private async reconcileRun(id: string): Promise<void> {
    if (this.reconciling.has(id)) return;
    this.reconciling.add(id);
    try {
      const run = this.registry.get(id);
      if (!run || isTerminalStatus(run.status)) return;
      const target = this.validConfig(id);
      if (!target) {
        const paths = this.pathsFor(id);
        if (!existsSync(paths.runDir)) {
          this.updateRun(id, {
            status: "interrupted",
            error: "Detached run directory is missing.",
            request: undefined,
            notificationPending: "interrupted",
            updatedAt: this.now(),
          });
          this.registry.markLive(id, false);
          this.health.delete(id);
          this.repliedSeqs.delete(id);
          this.cleanupRun(id);
          this.deliverPendingNotification(id);
        } else {
          console.error(`[oh-my-pi-slim] Retaining unverifiable detached run directory ${paths.runDir}: launch config is missing or invalid.`);
          this.failRun(id, "Detached launch config is missing or invalid.", true, false);
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
        this.failRun(
          id,
          "Detached runner process exited before publishing a terminal state.",
          true,
          Boolean(this.verifiedProcess(target, id)),
        );
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
    } finally {
      this.reconciling.delete(id);
    }
  }

  private async reconcileAll(): Promise<void> {
    if (this.shuttingDown) return;
    await Promise.all(this.registry.list()
      .filter((run) => ACTIVE_STATUSES.has(run.status))
      .map((run) => this.reconcileRun(run.id)));
  }

  private async terminateRun(id: string, error: string, notify: boolean): Promise<void> {
    const current = this.registry.get(id);
    if (!current || isTerminalStatus(current.status)) return;
    const target = this.validConfig(id);
    let latestState: DetachedRunState | undefined;
    let safeToCleanup = !target;
    if (target) {
      latestState = this.readVerifiedState(target, id);
      if (latestState && isTerminalStatus(latestState.status)) {
        this.applyState(id, latestState, notify);
        return;
      }
      try { this.controlWriter(target.paths, target.config.token, "interrupt"); } catch { /* force termination below */ }
      const deadline = this.nowMs() + this.shutdownWaitMs;
      while (this.nowMs() < deadline) {
        await this.sleep(Math.min(50, Math.max(1, deadline - this.nowMs())));
        latestState = this.readVerifiedState(target, id) ?? latestState;
        if (latestState && isTerminalStatus(latestState.status)) {
          this.applyState(id, latestState, notify);
          return;
        }
      }
      latestState = this.readVerifiedState(target, id) ?? latestState;
      if (latestState && isTerminalStatus(latestState.status)) {
        this.applyState(id, latestState, notify);
        return;
      }
      const stopped = await this.stopVerifiedProcess(target, id);
      latestState = stopped.state ?? latestState;
      safeToCleanup = stopped.safeToCleanup;
      if (latestState && isTerminalStatus(latestState.status)) {
        this.applyState(id, latestState, notify, safeToCleanup);
        return;
      }
      if (latestState) this.activity.set(id, stateActivity(latestState));
    }
    const run = this.registry.require(id);
    this.updateRun(id, {
      status: "interrupted",
      sessionFile: latestState?.sessionFile ?? run.sessionFile,
      output: latestState?.output ?? run.output,
      error,
      request: undefined,
      notificationPending: "interrupted",
      updatedAt: this.now(),
    });
    this.registry.markLive(id, false);
    this.health.delete(id);
    this.repliedSeqs.delete(id);
    if (notify) this.deliverPendingNotification(id);
    if (safeToCleanup) this.cleanupRun(id);
  }

  private formatRunStatus(run: PersistedRun): RunStatusSummary {
    const request = run.status === "waiting" ? run.request : undefined;
    return {
      id: run.id,
      agent: run.agent,
      abstract: run.abstract,
      status: run.status,
      live: this.registry.isLive(run.id),
      ...(run.sourceRunId !== undefined ? { sourceRunId: run.sourceRunId } : {}),
      ...(request !== undefined ? { reason: request.reason } : {}),
    };
  }

  private formatRun(run: PersistedRun) {
    return Object.fromEntries(Object.entries({
      ...run,
      live: this.registry.isLive(run.id),
      activity: this.activity.get(run.id),
    }).filter(([, value]) => value !== undefined));
  }

  private buildLaunchConfig(run: PersistedRun, agent: AgentDefinition, resumeSessionFile?: string): DetachedLaunchConfig {
    if (!this.ctx || !this.ownerSessionId) throw new Error("Subagent runtime is not attached to a parent session.");
    const approve = shouldApproveChildProject(this.ctx.isProjectTrusted(), this.ctx.cwd, run.cwd);
    const args = [
      "--mode", "rpc",
      "--model", run.model,
      approve ? "--approve" : "--no-approve",
      "--session-dir", this.childSessionDir(),
      "--system-prompt", agent.systemPrompt,
    ];
    if (run.deniedTools.length > 0) args.push("--exclude-tools", run.deniedTools.join(","));
    args.push("--extension", CHILD_EXTENSION);
    if (resumeSessionFile) args.push("--session", resumeSessionFile);
    return {
      v: 1,
      runId: run.id,
      token: randomUUID(),
      ownerSessionId: this.ownerSessionId,
      agent: run.agent,
      abstract: run.abstract,
      task: run.task,
      cwd: run.cwd,
      model: run.model,
      deniedTools: [...run.deniedTools],
      systemPrompt: agent.systemPrompt,
      approve,
      childSessionDir: this.childSessionDir(),
      resumeSessionFile,
      piInvocation: getPiInvocation(args, this.invocationSeams),
      env: {
        PI_SUBAGENT_CHILD: "1",
        OMPS_SUBAGENT_CHILD: "1",
        OMPS_PARENT_RUN_ID: run.id,
        OMPS_RUN_ID: run.id,
      },
      createdAt: run.createdAt,
    };
  }

  private async launchRun(run: PersistedRun, resumeSessionFile?: string) {
    const agent = this.agents.get(run.agent);
    if (!agent) throw new Error(`Package agent disappeared: ${run.agent}`);
    const paths = this.pathsFor(run.id);
    ensureRunPaths(paths);
    const config = this.buildLaunchConfig(run, agent, resumeSessionFile);
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
      if (!processIdentity) throw new Error(`Could not capture OS process identity for detached runner PID ${launched.pid}.`);
      atomicWriteJson(paths.identityFile, {
        v: 1,
        token: config.token,
        runId: run.id,
        pid: launched.pid,
        processIdentity,
      });
      this.registry.markLive(run.id, true);
    } catch (error) {
      let safeToCleanup = true;
      if (launchedPid !== undefined) {
        if (this.pidAlive(launchedPid)) {
          try { this.signalProcess(launchedPid, "SIGTERM"); } catch { /* already exited */ }
          await this.sleep(POST_TERM_GRACE_MS);
          if (this.pidAlive(launchedPid)) {
            try { this.signalProcess(launchedPid, "SIGKILL"); } catch { /* already exited */ }
            await this.sleep(POST_TERM_GRACE_MS);
          }
        }
        safeToCleanup = !this.pidAlive(launchedPid);
      }
      this.failRun(run.id, error instanceof Error ? error.message : String(error), true, safeToCleanup);
    }
    const retained = this.registry.require(run.id);
    return toolText(`Created asynchronous run ${run.id} (${run.agent}) with status ${retained.status}.`, {
      run: this.formatRun(retained),
    });
  }

  private async executeSubagent(input: RuntimeInput) {
    rejectUnknownFields(input, SUBAGENT_PUBLIC_FIELDS, "subagent");
    const action = requireString(input.action, "action");
    if (!SUBAGENT_ACTIONS.includes(action as (typeof SUBAGENT_ACTIONS)[number])) {
      throw new Error(`Unsupported subagent action: ${action}`);
    }
    if (action === "create") {
      if (input.id !== undefined || input.message !== undefined) throw new Error("create does not accept id or message.");
      return this.launchCreate(input);
    }
    if (action === "resume") {
      const invalidFields = ["agent", "task", "cwd"].filter((field) => input[field as keyof RuntimeInput] !== undefined);
      if (invalidFields.length > 0) throw new Error(`resume does not accept field(s): ${invalidFields.join(", ")}.`);
      const id = requireString(input.id, "id");
      const abstract = requireString(input.abstract, "abstract");
      const message = requireString(input.message, "message");
      await this.reconcileRun(id);
      return this.resume(id, abstract, message);
    }
    const createFields = ["agent", "abstract", "task", "cwd"].filter((field) => input[field as keyof RuntimeInput] !== undefined);
    if (createFields.length > 0) throw new Error(`${action} does not accept create field(s): ${createFields.join(", ")}.`);
    if (action === "list" && (input.id !== undefined || input.message !== undefined)) throw new Error("list does not accept id or message.");
    if (action === "interrupt" && input.message !== undefined) throw new Error("interrupt does not accept message.");

    if (action === "list") {
      await this.reconcileAll();
      const runs = this.registry.list()
        .filter((run) => ACTIVE_STATUSES.has(run.status))
        .map((run) => this.formatRunStatus(run));
      return toolText(JSON.stringify(runs, null, 2), { runs });
    }

    const id = requireString(input.id, "id");
    await this.reconcileRun(id);
    if (action === "reply") return this.reply(id, requireString(input.message, "message"));
    const run = this.registry.require(id);
    if (isTerminalStatus(run.status)) return toolText(`${id} is already ${run.status}.`, { run: this.formatRun(run) });
    const target = this.validConfig(id);
    if (!target) throw new Error(`Run ${id} has no valid detached control target.`);
    if (action === "steer") {
      if (run.status !== "running") throw new Error(`steer requires a running run; ${id} is ${run.status}.`);
      this.controlWriter(target.paths, target.config.token, "steer", requireString(input.message, "message"));
      return toolText(`Steer requested for ${id}.`, { run: this.formatRun(run) });
    }
    this.controlWriter(target.paths, target.config.token, "interrupt");
    return toolText(`Interrupt requested for ${id}.`, { run: this.formatRun(run) });
  }

  private async launchCreate(input: RuntimeInput) {
    if (this.shuttingDown) throw new Error("Parent session is shutting down.");
    const launch = validateCreateInput(input);
    if (!this.modelResolver || !this.denyResolver) {
      throw new Error("oh-my-pi-slim is inactive; enable a preset before creating a subagent.");
    }
    const model = requireString(this.modelResolver(launch.agent), `preset model for ${launch.agent}`);
    const deniedTools = normalizeDeniedTools(this.denyResolver(launch.agent));
    const now = this.now();
    const agent = this.agents.get(launch.agent);
    if (!agent) throw new Error(`Unknown package agent: ${launch.agent}`);
    const run: PersistedRun = {
      id: this.newRunId(),
      agent: launch.agent,
      abstract: launch.abstract,
      task: launch.task,
      cwd: launch.cwd ? resolve(this.ctx?.cwd ?? process.cwd(), launch.cwd) : this.ctx?.cwd ?? process.cwd(),
      model,
      deniedTools,
      status: "starting",
      createdAt: now,
      updatedAt: now,
    };
    return this.launchRun(run);
  }

  private async resume(sourceId: string, abstract: string, message: string) {
    const source = this.registry.require(sourceId);
    if (!isTerminalStatus(source.status)) throw new Error(`resume requires a terminal source run; ${sourceId} is ${source.status}.`);
    if (!source.sessionFile || !existsSync(source.sessionFile)) throw new Error(`Run ${sourceId} has no recoverable child session file.`);
    const sessionFile = canonicalSessionFile(source.sessionFile);
    const conflicting = this.registry.list().find((run) =>
      run.sessionFile !== undefined && canonicalSessionFile(run.sessionFile) === sessionFile && ACTIVE_STATUSES.has(run.status));
    if (conflicting) throw new Error(`Session ${source.sessionFile} is already active in run ${conflicting.id}.`);
    if (!this.denyResolver) throw new Error("oh-my-pi-slim is inactive; enable a preset before resuming a subagent.");
    const now = this.now();
    const run: PersistedRun = {
      id: this.newRunId(),
      agent: source.agent,
      abstract,
      task: message,
      cwd: source.cwd,
      model: source.model,
      deniedTools: normalizeDeniedTools(this.denyResolver(source.agent)),
      status: "starting",
      sourceRunId: sourceId,
      sessionFile: source.sessionFile,
      createdAt: now,
      updatedAt: now,
    };
    const result = await this.launchRun(run, source.sessionFile);
    const retained = this.registry.require(run.id);
    result.content[0].text = `Resumed ${sourceId} as new detached run ${run.id} with status ${retained.status}.`;
    return result;
  }

  private reply(id: string, message: string) {
    const current = this.registry.require(id);
    if (current.status !== "waiting") throw new Error(`reply requires a waiting run; ${id} is ${current.status}.`);
    if (!this.registry.isLive(id)) throw new Error(`reply requires a live waiting run; ${id} is not live.`);
    if (!current.request) throw new Error(`Run ${id} has no waiting request.`);
    if (!Number.isInteger(current.waitingSeq) || Number(current.waitingSeq) < 1) {
      throw new Error(`Run ${id} has no replyable waiting sequence.`);
    }
    const target = this.validConfig(id);
    if (!target) throw new Error(`Run ${id} has no valid detached control target.`);
    this.controlWriter(target.paths, target.config.token, "reply", message, current.waitingSeq);
    this.repliedSeqs.set(id, { waitingSeq: current.waitingSeq, sentAt: this.nowMs() });
    const running = this.updateRun(id, {
      status: "running",
      request: undefined,
      notificationPending: current.notificationPending === "waiting" ? undefined : current.notificationPending,
      updatedAt: this.now(),
    });
    return toolText(`Replied to run ${id}; it is running.`, { run: this.formatRun(running) });
  }
}

export function registerSubagentRuntime(pi: ExtensionAPI, options?: RuntimeOptions): OmpsSubagentRuntime {
  const runtime = new OmpsSubagentRuntime(pi, options);
  runtime.registerTools();
  return runtime;
}
