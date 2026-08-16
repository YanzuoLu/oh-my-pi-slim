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
  SUPERVISOR_ACTIONS,
  SUPERVISOR_PUBLIC_FIELDS,
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
  getPiInvocation,
  getProcessIdentity,
  getRunPaths,
  getRunRoot,
  isPidAlive,
  launchDetachedRunner,
  listOwnerRunIds,
  readLaunchConfig,
  readRunnerIdentity,
  readRunState,
  removeRunFiles,
  tailLog,
  writeControl,
  type DetachedLaunchConfig,
  type DetachedRunActivity,
  type DetachedRunState,
  type InvocationSeams,
  type RunPaths,
} from "./subagent-run-files.js";
import {
  SUBAGENT_NOTIFICATION_TYPE,
  renderSubagentCall,
  renderSubagentNotification,
  renderSubagentResult,
  renderSupervisorCall,
  renderSupervisorResult,
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
const LIFECYCLE_TOOLS = new Set(["subagent", "subagent_supervisor", "contact_supervisor"]);

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
}

interface RuntimeInput {
  agent?: unknown;
  task?: unknown;
  cwd?: unknown;
  action?: unknown;
  id?: unknown;
  message?: unknown;
}

interface SupervisorInput {
  action?: unknown;
  replyTo?: unknown;
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

interface PendingReply {
  requestId: string;
  sentAt: number;
}

interface RunStatusSummary {
  id: string;
  agent: SpecialistName;
  status: RunStatus;
  live: boolean;
  sourceRunId?: string;
  requestId?: string;
  reason?: SupervisorRequest["reason"];
}

interface NotificationDelivery {
  runId: string;
  event: RunStatus;
  requestId?: string;
  deliveryKey: string;
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

function notificationDeliveryKey(runId: string, event: RunStatus, requestId?: string): string | undefined {
  if (event === "waiting") {
    if (!requestId) return;
    return `oh-my-pi-slim:subagent-notification:${JSON.stringify([runId, event, requestId])}`;
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
  const requestId = typeof details.requestId === "string" ? details.requestId : undefined;
  const derivedKey = notificationDeliveryKey(runId, event, requestId);
  if (!derivedKey) return;
  if (details.deliveryKey !== undefined && details.deliveryKey !== derivedKey) return;
  return { runId, event, requestId, deliveryKey: derivedKey };
}

function stateRequest(value: Record<string, unknown> | undefined, runId: string): SupervisorRequest | undefined {
  if (!value) return;
  if (
    typeof value.id !== "string" || value.runId !== runId ||
    !["need_decision", "interview_request", "progress_update"].includes(String(value.reason)) ||
    typeof value.message !== "string" || typeof value.createdAt !== "string" ||
    (value.interview !== undefined && (!value.interview || typeof value.interview !== "object" || Array.isArray(value.interview)))
  ) return;
  return {
    id: value.id,
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

export const subagentParameters = Type.Object({
  agent: Type.Optional(Type.String({ description: "Specialist role for create" })),
  task: Type.Optional(Type.String({ description: "Objective for create" })),
  cwd: Type.Optional(Type.String({ description: "Working directory for create" })),
  action: Type.Union(SUBAGENT_ACTIONS.map((action) => Type.Literal(action)), {
    description: "Create, list, steer, interrupt, or resume a run",
  }),
  id: Type.Optional(Type.String({ description: "Run ID for steer, interrupt, or resume" })),
  message: Type.Optional(Type.String({ description: "Guidance for steer or the continuation objective for resume" })),
}, { additionalProperties: false });

export const supervisorParameters = Type.Object({
  action: Type.Union(SUPERVISOR_ACTIONS.map((action) => Type.Literal(action)), {
    description: "View pending requests or reply",
  }),
  replyTo: Type.Optional(Type.String({ description: "Pending supervisor request ID to answer" })),
  message: Type.Optional(Type.String({ description: "Reply that continues the waiting specialist" })),
}, { additionalProperties: false });

if (
  JSON.stringify(publicSchemaKeys(subagentParameters)) !== JSON.stringify([...SUBAGENT_PUBLIC_FIELDS].sort()) ||
  JSON.stringify(publicSchemaKeys(supervisorParameters)) !== JSON.stringify([...SUPERVISOR_PUBLIC_FIELDS].sort())
) {
  throw new Error("OMPS subagent tool schemas drifted from their public field contracts.");
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
  private readonly widget: SubagentWidget;
  private readonly activity = new Map<string, DetachedRunActivity>();
  private readonly health = new Map<string, RunHealth>();
  private readonly pendingReplies = new Map<string, PendingReply>();
  private readonly queuedNotifications = new Set<string>();
  private readonly reconciling = new Set<string>();
  private readonly unsubscribeRegistry: () => void;
  private ctx?: ExtensionContext;
  private ownerSessionId?: string;
  private runRoot?: string;
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
    this.widget = new SubagentWidget(() => this.registry.list().map((run) => ({ ...run, activity: this.activity.get(run.id) })));
    this.unsubscribeRegistry = this.registry.subscribe(() => this.widget.update());
  }

  setModelResolver(resolver?: ModelResolver): void {
    this.modelResolver = resolver;
  }

  setDenyResolver(resolver?: DenyResolver): void {
    this.denyResolver = resolver;
  }

  registerTools(): void {
    this.pi.registerMessageRenderer(SUBAGENT_NOTIFICATION_TYPE, renderSubagentNotification);
    this.pi.registerTool({
      name: "subagent",
      label: "Subagent",
      description: "Create a package specialist asynchronously and receive a new run ID with status starting. Lifecycle notifications deliver waiting requests and terminal results through steer at the next safe model boundary. Use list for retained run status, steer for running work, interrupt for active work, and resume for saved child sessions.",
      promptSnippet: "Create and manage asynchronous package specialist runs.",
      promptGuidelines: [
        "subagent create supplies agent, task, and optional cwd and returns the new run with status starting.",
        "A waiting subagent lifecycle notification is delivered through steer at the next safe model boundary and contains the run ID, request ID, reason, and message.",
        "A completed, failed, or interrupted subagent lifecycle notification is delivered through steer at the next safe model boundary and contains the run ID and every stored output and error field for that transition.",
        "subagent list reports retained run identity, current status, liveness, optional source run ID, and waiting request ID/reason; it never returns task, activity, or historical results.",
        "subagent steer sends a message to a running run.",
        "subagent interrupt sends an interruption request to a starting, running, or waiting run; its lifecycle notification reports the actual terminal status.",
        "subagent resume accepts a completed, failed, or interrupted run ID with a saved child session.",
        "subagent resume returns a new run ID; subsequent steer, interrupt, and resume actions use the new run ID.",
      ],
      parameters: subagentParameters,
      execute: async (_toolCallId, params) => this.executeSubagent(params as RuntimeInput),
      renderCall: renderSubagentCall,
      renderResult: renderSubagentResult,
    });
    this.pi.registerTool({
      name: "subagent_supervisor",
      label: "Subagent Supervisor",
      description: "View waiting specialist requests and reply to continue a specialist. The next waiting or terminal transition uses one visible custom message delivered through steer at the next safe model boundary.",
      promptSnippet: "Inspect waiting child requests and reply by request ID.",
      promptGuidelines: [
        "subagent_supervisor pending returns each waiting request with its request ID and run ID.",
        "subagent_supervisor reply accepts a request ID and message.",
        "After subagent_supervisor reply, the same run ID returns to running with saved child-session context; its next waiting, completed, failed, or interrupted transition sends one visible custom message through steer at the next safe model boundary.",
      ],
      parameters: supervisorParameters,
      execute: async (_toolCallId, params) => this.executeSupervisor(params as SupervisorInput),
      renderCall: renderSupervisorCall,
      renderResult: renderSupervisorResult,
    });
  }

  async restore(ctx: ExtensionContext): Promise<void> {
    this.stopPoller();
    this.widget.dispose();
    this.activity.clear();
    this.health.clear();
    this.pendingReplies.clear();
    this.queuedNotifications.clear();
    this.ctx = ctx;
    this.ownerSessionId = ctx.sessionManager.getSessionId();
    this.runRoot = getRunRoot(ctx.sessionManager.getSessionDir());
    this.modelResolver = undefined;
    this.denyResolver = undefined;
    this.shuttingDown = false;
    this.widget.setUICtx(ctx.mode === "tui" ? ctx.ui as unknown as SubagentWidgetUI : undefined);

    const entries: unknown[] = [];
    const deliveredNotifications = new Map<string, NotificationDelivery>();
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === SNAPSHOT_TYPE) entries.push(entry.data);
      if (entry.type === "custom_message" && entry.customType === SUBAGENT_NOTIFICATION_TYPE) {
        const delivery = notificationDeliveryFromDetails(entry.details);
        if (delivery) deliveredNotifications.set(delivery.deliveryKey, delivery);
      }
    }
    const restored = restoreRunJournal(entries, this.now());
    this.registry.restore(restored.runs);
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
    const activeIds = this.registry.list().filter((run) => ACTIVE_STATUSES.has(run.status)).map((run) => run.id);
    await Promise.all(activeIds.map((id) => this.terminateRun(id, "Parent session shut down.", false)));
    this.widget.dispose();
    this.activity.clear();
    this.health.clear();
    this.pendingReplies.clear();
    this.queuedNotifications.clear();
    this.ctx = undefined;
    this.ownerSessionId = undefined;
    this.runRoot = undefined;
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
    if (this.ctx) this.pi.appendEntry(SNAPSHOT_TYPE, runJournalEntry(run));
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
      if (run.status !== "waiting" || !run.request) return;
      const deliveryKey = notificationDeliveryKey(run.id, event, run.request.id);
      return deliveryKey ? { runId: run.id, event, requestId: run.request.id, deliveryKey } : undefined;
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
      ? `\nRequest ${run.request.id} (${run.request.reason}): ${run.request.message}`
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
          requestId: delivery.requestId,
          reason: run.request?.reason,
          deliveryKey: delivery.deliveryKey,
        },
      },
      { deliverAs: "steer", triggerTurn: true },
    );
  }

  private deliverPendingNotification(id: string): void {
    if (this.shuttingDown) return;
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
    this.pendingReplies.delete(id);
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
    const waitingRequestChanged = current.status === "waiting" && state.status === "waiting" &&
      !sameRequest(current.request, request);
    const enteredWaiting = current.status !== "waiting" && state.status === "waiting";
    const enteredTerminal = !isTerminalStatus(current.status) && isTerminalStatus(state.status);
    const clearWaitingPending = state.status === "running" && current.notificationPending === "waiting";
    const notificationPending = enteredTerminal
      ? state.status
      : notify && (enteredWaiting || waitingRequestChanged)
        ? "waiting"
        : clearWaitingPending ? undefined : current.notificationPending;
    const logicalChange = current.status !== state.status || current.sessionFile !== state.sessionFile ||
      current.output !== state.output || current.error !== state.error || !sameRequest(current.request, request) ||
      current.notificationPending !== notificationPending;
    let next = current;
    if (logicalChange) {
      next = this.updateRun(id, {
        status: state.status,
        sessionFile: state.sessionFile,
        request,
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
      this.pendingReplies.delete(id);
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
          this.pendingReplies.delete(id);
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

      const pendingReply = this.pendingReplies.get(id);
      const request = stateRequest(state.request, id);
      let suppressWaitingReply = false;
      if (pendingReply) {
        if (state.status === "running" || isTerminalStatus(state.status) || request?.id !== pendingReply.requestId) {
          this.pendingReplies.delete(id);
        } else if (state.status === "waiting" && this.nowMs() - pendingReply.sentAt < this.graceMs) {
          suppressWaitingReply = true;
        } else if (this.nowMs() - pendingReply.sentAt >= this.graceMs) {
          this.pendingReplies.delete(id);
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
    this.pendingReplies.delete(id);
    if (notify) this.deliverPendingNotification(id);
    if (safeToCleanup) this.cleanupRun(id);
  }

  private formatRunStatus(run: PersistedRun): RunStatusSummary {
    const request = run.status === "waiting" ? run.request : undefined;
    return {
      id: run.id,
      agent: run.agent,
      status: run.status,
      live: this.registry.isLive(run.id),
      ...(run.sourceRunId !== undefined ? { sourceRunId: run.sourceRunId } : {}),
      ...(request !== undefined ? { requestId: request.id, reason: request.reason } : {}),
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
    const createFields = ["agent", "task", "cwd"].filter((field) => input[field as keyof RuntimeInput] !== undefined);
    if (createFields.length > 0) throw new Error(`${action} does not accept create field(s): ${createFields.join(", ")}.`);
    if (action === "list" && (input.id !== undefined || input.message !== undefined)) throw new Error("list does not accept id or message.");
    if (action === "interrupt" && input.message !== undefined) throw new Error("interrupt does not accept message.");

    if (action === "list") {
      await this.reconcileAll();
      const runs = this.registry.list().map((run) => this.formatRunStatus(run));
      return toolText(JSON.stringify(runs, null, 2), { runs });
    }

    const id = requireString(input.id, "id");
    await this.reconcileRun(id);
    if (action === "resume") return this.resume(id, requireString(input.message, "message"));
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

  private async resume(sourceId: string, message: string) {
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

  private async executeSupervisor(input: SupervisorInput) {
    rejectUnknownFields(input, SUPERVISOR_PUBLIC_FIELDS, "subagent_supervisor");
    const action = requireString(input.action, "action");
    if (!SUPERVISOR_ACTIONS.includes(action as (typeof SUPERVISOR_ACTIONS)[number])) throw new Error(`Unsupported supervisor action: ${action}`);
    if (action !== "reply" && (input.replyTo !== undefined || input.message !== undefined)) throw new Error(`${action} does not accept replyTo or message.`);
    await this.reconcileAll();
    if (action === "pending") {
      const pending = this.registry.pending();
      return toolText(JSON.stringify(pending, null, 2), { pending });
    }
    const replyTo = requireString(input.replyTo, "replyTo");
    const message = requireString(input.message, "message");
    const request = this.registry.pending().find((item) => item.id === replyTo);
    if (!request) throw new Error(`Unknown pending supervisor request: ${replyTo}`);
    await this.reconcileRun(request.runId);
    const current = this.registry.require(request.runId);
    if (current.status !== "waiting" || current.request?.id !== replyTo || !this.registry.isLive(request.runId)) {
      throw new Error(`Supervisor request ${replyTo} is no longer attached to a live runner.`);
    }
    const target = this.validConfig(request.runId);
    if (!target) throw new Error(`Run ${request.runId} has no valid detached control target.`);
    this.controlWriter(target.paths, target.config.token, "reply", message, replyTo);
    this.pendingReplies.set(request.runId, { requestId: replyTo, sentAt: this.nowMs() });
    const running = this.updateRun(request.runId, {
      status: "running",
      request: undefined,
      notificationPending: current.notificationPending === "waiting" ? undefined : current.notificationPending,
      updatedAt: this.now(),
    });
    return toolText(`Replied to ${replyTo}; run ${request.runId} is running.`, { run: this.formatRun(running) });
  }
}

export function registerSubagentRuntime(pi: ExtensionAPI, options?: RuntimeOptions): OmpsSubagentRuntime {
  const runtime = new OmpsSubagentRuntime(pi, options);
  runtime.registerTools();
  return runtime;
}
