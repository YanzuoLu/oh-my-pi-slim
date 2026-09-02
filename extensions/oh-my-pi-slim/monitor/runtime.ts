import { randomBytes } from "node:crypto";
import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  accessSync,
  chmodSync,
  closeSync,
  constants,
  mkdtempSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, isAbsolute, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { ExtensionAPI, ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import {
  modelJsonResult,
  MONITOR_ACTIONS,
  monitorClearModelResult,
  monitorCreateModelResult,
  MONITOR_DIAGNOSTICS,
  monitorListModelResult,
  MONITOR_PUBLIC_FIELDS,
  monitorStatusModelResult,
  monitorStopModelResult,
  monitorUpdateContent,
  MONITOR_TOOL_CONTRACT,
  MONITOR_TOOL_ERRORS,
} from "../tool-contracts.js";
import {
  renderMonitorCall,
  renderMonitorNotification,
  renderMonitorResult,
} from "./transcript-renderer.js";
import { MonitorWidget, type MonitorWidgetItem } from "./widget.js";


export const MONITOR_NOTIFICATION_TYPE = "oh-my-pi-slim:monitor-notification";
export const MONITOR_STATUSES = ["running", "completed", "failed", "killed"] as const;

export type MonitorAction = (typeof MONITOR_ACTIONS)[number];
export type MonitorStatus = (typeof MONITOR_STATUSES)[number];
export type MonitorStream = "stdout" | "stderr";
export type MonitorNotificationKind = "event" | "terminal";
export type MonitorStateChangeReason = "lifecycle" | "output" | "notification";

export interface MonitorCombinedLine {
  seq: number;
  timestamp: string;
  stream: MonitorStream;
  text: string;
}

export interface MonitorListItem {
  id: string;
  status: MonitorStatus;
  abstract: string;
}

export interface MonitorOperationalState {
  id: string;
  abstract: string;
  command: string;
  cwd: string;
  pid: number;
  status: MonitorStatus;
  createdAt: string;
  updatedAt: string;
  lastOutputAt: string | null;
  endedAt: string | null;
  exitCode: number | null;
  signal: string | null;
  error: string | null;
  notificationCount: number;
  logPath: string;
  logBytes: number;
  logLines: number;
  droppedBytes: number;
  droppedLines: number;
  returned: number;
  omitted: number;
  truncated: boolean;
  combined: MonitorCombinedLine[];
}

export interface MonitorStateChange {
  type: "created" | "updated" | "deleted" | "reset";
  reason: MonitorStateChangeReason;
  id?: string;
  status?: MonitorStatus;
}

export interface MonitorInput {
  action?: unknown;
  abstract?: unknown;
  command?: unknown;
  cwd?: unknown;
  id?: unknown;
}

interface StructuredLogLine extends MonitorCombinedLine {
  marker?: true;
}

interface StreamState {
  decoder: StringDecoder;
  partial: string;
  partialBytes: number;
  pendingCR: boolean;
  truncated: boolean;
  truncatedBytes: number;
  flushed: boolean;
}

interface MonitorRecord {
  id: string;
  abstract: string;
  command: string;
  cwd: string;
  pid: number;
  status: MonitorStatus;
  createdAt: string;
  updatedAt: string;
  lastOutputAt: string | null;
  endedAt: string | null;
  exitCode: number | null;
  signal: string | null;
  error: string | null;
  notificationCount: number;
  logPath: string;
  logFd: number;
  logBytes: number;
  logLines: number;
  droppedBytes: number;
  droppedLines: number;
  nextSeq: number;
  handedCursor: number;
  recentLines: MonitorCombinedLine[];
  pendingEventLines: MonitorCombinedLine[];
  pendingEventTotal: number;
  child: ChildProcessWithoutNullStreams;
  streams: Record<MonitorStream, StreamState>;
  eventTimer?: TimerHandle;
  exitCodeSeen: number | null;
  signalSeen: string | null;
  processError: string | null;
  terminating: boolean;
  stopOwned: boolean;
  generation: number;
  terminalPromise: Promise<void>;
  terminalResolved: boolean;
  resolveTerminal: () => void;
  listeners: Array<{ emitter: { removeListener(event: string, listener: (...args: any[]) => void): unknown }; event: string; listener: (...args: any[]) => void }>;
}

interface NotificationAggregate {
  monitorId: string;
  kind: MonitorNotificationKind;
  lines: Map<number, MonitorCombinedLine>;
  totalLines: number;
  coveredThrough?: number;
  diagnosticFromSeq?: number;
}

interface FrozenNotification {
  deliveryKey: string;
  monitorId: string;
  kind: MonitorNotificationKind;
  content: string;
  details: Readonly<Record<string, unknown>>;
  generation: number;
}

interface NotificationLane {
  pending?: NotificationAggregate;
  inFlight?: FrozenNotification;
}

interface MonitorFs {
  openSync(path: string, flags: number, mode?: number): number;
  closeSync(fd: number): void;
  readSync(fd: number, buffer: Buffer, offset: number, length: number, position: number | null): number;
  writeSync(fd: number, buffer: Buffer, offset: number, length: number, position: number | null): number;
  renameSync(oldPath: string, newPath: string): void;
  rmSync(path: string, options?: { force?: boolean; recursive?: boolean }): void;
  statSync(path: string): { size: number };
}

interface LogScanResult {
  lines: MonitorCombinedLine[];
  requested: number;
  scanFailed: boolean;
  lineTruncated: boolean;
}

interface NotificationLines {
  lines: MonitorCombinedLine[];
  totalNew: number;
  omitted: number;
  truncated: boolean;
}

type TimerHandle = ReturnType<typeof setTimeout>;
type SpawnFn = typeof nodeSpawn;
type SendMessage = (
  message: { customType: string; content: string; display: boolean; details: Record<string, unknown> },
  options: { deliverAs: "steer"; triggerTurn: true },
) => void;

export interface MonitorRuntimeOptions {
  platform?: NodeJS.Platform;
  nowMs?: () => number;
  randomHex?: () => string;
  spawn?: SpawnFn;
  resolveShell?: () => string;
  killGroup?: (pid: number, signal: NodeJS.Signals | 0) => void;
  setTimeout?: (callback: () => void, milliseconds: number) => TimerHandle;
  clearTimeout?: (timer: TimerHandle) => void;
  sleep?: (milliseconds: number) => Promise<void>;
  sendMessage?: SendMessage;
  logCapBytes?: number;
  logRetainBytes?: number;
  partialLineMaxBytes?: number;
  eventBatchMs?: number;
  deleteGraceMs?: number;
  finalKillWaitMs?: number;
  shutdownGraceMs?: number;
  recentLineLimit?: number;
  notificationContentMaxBytes?: number;
  notificationDetailsMaxBytes?: number;
  toolContentMaxBytes?: number;
  makeLogRoot?: () => string;
  fs?: Partial<MonitorFs>;
}

const ACTION_FIELDS: Record<MonitorAction, readonly string[]> = {
  create: ["action", "abstract", "command", "cwd"],
  stop: ["action", "id"],
  clear: ["action"],
  list: ["action"],
  check: ["action", "id"],
};
const ANSI_PATTERN = /[\u001b\u009b](?:\][^\u0007]*(?:\u0007|\u001b\\)|[\[\]()#;?]*(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*)?\u0007|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~])))/g;
const CONTROL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;
const DEFAULT_LOG_CAP = 64 * 1024 * 1024;
const DEFAULT_LOG_RETAIN = 32 * 1024 * 1024;
const DEFAULT_PARTIAL_MAX = 64 * 1024;
const DEFAULT_RECENT_LINES = 100;
const NOTIFICATION_LINE_CAP = 100;
const TERMINAL_DIAGNOSTIC_TAIL_LINES = 20;
const NOTIFICATION_RETRY_DELAY_MS = 100;
const DEFAULT_NOTIFICATION_CONTENT_MAX = 50 * 1024;
const DEFAULT_NOTIFICATION_DETAILS_MAX = 96 * 1024;
const DEFAULT_TOOL_CONTENT_MAX = 50 * 1024;
const STATUS_SCAN_CHUNK = 64 * 1024;
const STATUS_LINE_COLLECTION_MAX = 80 * 1024;
const RESPONSE_COMMAND_MAX = 16 * 1024;
const RESPONSE_TEXT_MAX = 4 * 1024;

const DEFAULT_FS: MonitorFs = {
  openSync,
  closeSync,
  readSync,
  writeSync,
  renameSync,
  rmSync,
  statSync,
};

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(MONITOR_TOOL_ERRORS.inputObject);
  return value as Record<string, unknown>;
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function trimmedString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(MONITOR_TOOL_ERRORS.nonEmptyString(field));
  return value.trim();
}

function exactId(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}$/.test(value)) {
    throw new Error(MONITOR_TOOL_ERRORS.exactId);
  }
  return value;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sanitizeText(text: string): string {
  return text.replace(ANSI_PATTERN, "").replace(CONTROL_PATTERN, "");
}

function resolveBash(): string {
  const candidates: string[] = [];
  const shell = process.env.SHELL;
  if (shell && isAbsolute(shell) && basename(shell) === "bash") candidates.push(shell);
  candidates.push(
    "/bin/bash",
    "/usr/bin/bash",
    "/run/current-system/sw/bin/bash",
    "/nix/var/nix/profiles/default/bin/bash",
    "/opt/homebrew/bin/bash",
    "/usr/local/bin/bash",
  );
  for (const directory of String(process.env.PATH ?? "").split(delimiter)) {
    if (directory && isAbsolute(directory)) candidates.push(join(directory, "bash"));
  }
  for (const candidate of [...new Set(candidates)]) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch { /* try the next trusted absolute candidate */ }
  }
  throw new Error(MONITOR_TOOL_ERRORS.shellMissing);
}

function privateDirectory(path: string): string {
  chmodSync(path, 0o700);
  return path;
}

function eventMessage(value: unknown): Record<string, unknown> | undefined {
  return optionalRecord(value);
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

function utf8Prefix(text: string, maximumBytes: number): string {
  if (maximumBytes <= 0) return "";
  let bytes = 0;
  let end = 0;
  for (const character of text) {
    const nextBytes = Buffer.byteLength(character);
    if (bytes + nextBytes > maximumBytes) break;
    bytes += nextBytes;
    end += character.length;
  }
  return text.slice(0, end);
}

function boundedText(text: string, maximumBytes: number, suffix = " … [truncated]"): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text) <= maximumBytes) return { text, truncated: false };
  const suffixBytes = Buffer.byteLength(suffix);
  return { text: `${utf8Prefix(text, Math.max(0, maximumBytes - suffixBytes))}${suffix}`, truncated: true };
}

function parseStructuredLine(buffer: Buffer): StructuredLogLine | undefined {
  try {
    const line = JSON.parse(buffer.toString("utf8")) as StructuredLogLine;
    if (!Number.isInteger(line.seq) || typeof line.timestamp !== "string") return;
    if (line.stream !== "stdout" && line.stream !== "stderr") return;
    if (typeof line.text !== "string") return;
    return line;
  } catch { return; }
}

if (JSON.stringify(Object.keys(MONITOR_TOOL_CONTRACT.parameters.properties).sort()) !== JSON.stringify([...MONITOR_PUBLIC_FIELDS].sort())) {
  throw new Error("OMPS monitor tool schema drifted from its public field contract.");
}

export class MonitorRuntime {
  private readonly pi: ExtensionAPI;
  private readonly platform: NodeJS.Platform;
  private readonly nowMs: () => number;
  private readonly randomHex: () => string;
  private readonly spawnFn: SpawnFn;
  private readonly resolveShellFn: () => string;
  private readonly killGroupFn: (pid: number, signal: NodeJS.Signals | 0) => void;
  private readonly setTimeoutFn: (callback: () => void, milliseconds: number) => TimerHandle;
  private readonly clearTimeoutFn: (timer: TimerHandle) => void;
  private readonly sleepFn: (milliseconds: number) => Promise<void>;
  private readonly sendMessage: SendMessage;
  private readonly logCapBytes: number;
  private readonly logRetainBytes: number;
  private readonly partialLineMaxBytes: number;
  private readonly eventBatchMs: number;
  private readonly deleteGraceMs: number;
  private readonly finalKillWaitMs: number;
  private readonly shutdownGraceMs: number;
  private readonly recentLineLimit: number;
  private readonly notificationContentMaxBytes: number;
  private readonly notificationDetailsMaxBytes: number;
  private readonly toolContentMaxBytes: number;
  private readonly makeLogRoot: () => string;
  private readonly fs: MonitorFs;
  private readonly records = new Map<string, MonitorRecord>();
  private readonly stopping = new Map<string, Promise<ReturnType<typeof modelJsonResult>>>();
  private readonly notifications = new Map<string, FrozenNotification>();
  private readonly notificationLanes = new Map<string, NotificationLane>();
  private readonly subscribers = new Set<(change: MonitorStateChange) => void>();
  private readonly widget: MonitorWidget;
  private widgetUnsubscribe?: () => void;
  private logRoot?: string;
  private generation = 0;
  private deliveryPaused = false;
  private shuttingDown = false;
  private notificationRetryTimer?: TimerHandle;
  private notificationSequence = 0;
  private shutdownPromise?: Promise<void>;

  constructor(pi: ExtensionAPI, options: MonitorRuntimeOptions = {}) {
    this.pi = pi;
    this.platform = options.platform ?? process.platform;
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.randomHex = options.randomHex ?? (() => randomBytes(4).toString("hex"));
    this.spawnFn = options.spawn ?? nodeSpawn;
    this.resolveShellFn = options.resolveShell ?? resolveBash;
    this.killGroupFn = options.killGroup ?? ((pid, signal) => process.kill(-pid, signal));
    this.setTimeoutFn = options.setTimeout ?? ((callback, milliseconds) => setTimeout(callback, milliseconds));
    this.clearTimeoutFn = options.clearTimeout ?? ((timer) => clearTimeout(timer));
    this.sleepFn = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.sendMessage = options.sendMessage ?? ((message, sendOptions) => this.pi.sendMessage(message, sendOptions));
    this.logCapBytes = options.logCapBytes ?? DEFAULT_LOG_CAP;
    this.logRetainBytes = Math.min(options.logRetainBytes ?? DEFAULT_LOG_RETAIN, this.logCapBytes);
    this.partialLineMaxBytes = options.partialLineMaxBytes ?? DEFAULT_PARTIAL_MAX;
    this.eventBatchMs = options.eventBatchMs ?? 200;
    this.deleteGraceMs = options.deleteGraceMs ?? 3_000;
    this.finalKillWaitMs = options.finalKillWaitMs ?? this.deleteGraceMs;
    this.shutdownGraceMs = options.shutdownGraceMs ?? 1_000;
    this.recentLineLimit = Math.max(100, options.recentLineLimit ?? DEFAULT_RECENT_LINES);
    this.notificationContentMaxBytes = options.notificationContentMaxBytes ?? DEFAULT_NOTIFICATION_CONTENT_MAX;
    this.notificationDetailsMaxBytes = options.notificationDetailsMaxBytes ?? DEFAULT_NOTIFICATION_DETAILS_MAX;
    this.toolContentMaxBytes = options.toolContentMaxBytes ?? DEFAULT_TOOL_CONTENT_MAX;
    this.makeLogRoot = options.makeLogRoot ?? (() => privateDirectory(mkdtempSync(join(tmpdir(), "oh-my-pi-slim-monitor-"))));
    this.fs = { ...DEFAULT_FS, ...options.fs };
    this.widget = new MonitorWidget(() => this.widgetItems(), {
      setTimeout: (callback, milliseconds) => this.setTimeoutFn(callback, milliseconds),
      clearTimeout: (timer) => this.clearTimeoutFn(timer as TimerHandle),
    });
    if (this.logCapBytes < 512 || this.logRetainBytes < 0) throw new Error("monitor log limits are invalid.");
    if (this.notificationContentMaxBytes < 1024 || this.notificationDetailsMaxBytes < 2048 || this.toolContentMaxBytes < 2048) {
      throw new Error("monitor payload limits are invalid.");
    }
  }

  registerTool(): void {
    if (this.platform === "win32") return;
    this.pi.registerMessageRenderer(MONITOR_NOTIFICATION_TYPE, renderMonitorNotification);
    this.pi.registerTool({
      name: MONITOR_TOOL_CONTRACT.name,
      label: "Monitor",
      executionMode: "sequential",
      description: MONITOR_TOOL_CONTRACT.description,
      parameters: MONITOR_TOOL_CONTRACT.parameters,
      execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => this.execute(params as MonitorInput, ctx),
      renderCall: renderMonitorCall,
      renderResult: renderMonitorResult,
    });
  }

  setUICtx(ui: ExtensionUIContext | undefined): void {
    this.widget.setContext(ui);
    if (!ui) {
      this.widgetUnsubscribe?.();
      this.widgetUnsubscribe = undefined;
      return;
    }
    this.widgetUnsubscribe ??= this.subscribe((change) => this.widget.handleChange(change));
  }

  refreshUI(): void {
    this.widget.update();
  }

  /** Output changes may arrive once per complete line; UI consumers must throttle rendering. */
  subscribe(listener: (change: MonitorStateChange) => void): () => void {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  hasRunning(): boolean {
    return [...this.records.values()].some((record) => record.status === "running");
  }

  /** Reserved for Goal: running monitors and tracked terminal delivery both block completion. */
  hasBlockingWork(): boolean {
    if (this.hasRunning()) return true;
    for (const lane of this.notificationLanes.values()) {
      if (lane.pending?.kind === "terminal" || lane.inFlight?.kind === "terminal") return true;
    }
    return false;
  }

  setDeliveryPaused(paused: boolean): void {
    if (this.deliveryPaused === paused) return;
    this.deliveryPaused = paused;
    if (!paused && !this.shuttingDown) this.flushNotifications();
  }

  /** Acknowledgement advances only the monitor lane whose current immutable delivery key matches exactly. */
  acknowledgeNotificationMessage(messageValue: unknown): boolean {
    const message = eventMessage(messageValue);
    if (message?.role !== "custom" || message.customType !== MONITOR_NOTIFICATION_TYPE) return false;
    const details = optionalRecord(message.details);
    const deliveryKey = details?.deliveryKey;
    if (typeof deliveryKey !== "string") return false;
    const notification = this.notifications.get(deliveryKey);
    if (!notification) return false;
    const lane = this.notificationLanes.get(notification.monitorId);
    if (lane?.inFlight?.deliveryKey !== deliveryKey) return false;
    lane.inFlight = undefined;
    this.notifications.delete(deliveryKey);
    this.pruneNotificationLane(notification.monitorId, lane);
    this.flushMonitorLane(notification.monitorId);
    return true;
  }

  /** Agent-settled may retry pending work, but a delivery already handed to Pi remains immutable until ACK. */
  retryQueuedNotificationsAfterAgentSettled(): void {
    if (this.shuttingDown) return;
    this.flushNotifications();
  }

  list(): MonitorListItem[] {
    return this.sortedRecords().map(({ id, status, abstract }) => ({ id, status, abstract }));
  }

  private sortedRecords(): MonitorRecord[] {
    const running = [...this.records.values()]
      .filter((record) => record.status === "running")
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    const terminal = [...this.records.values()]
      .filter((record) => record.status !== "running")
      .sort((left, right) => String(right.endedAt).localeCompare(String(left.endedAt)));
    return [...running, ...terminal];
  }

  private widgetItems(): MonitorWidgetItem[] {
    return this.sortedRecords().map(({ id, status, abstract, createdAt, endedAt }) => ({
      id, status, abstract, createdAt, endedAt,
    }));
  }

  async execute(inputValue: MonitorInput, ctx?: ExtensionContext): Promise<ReturnType<typeof modelJsonResult>> {
    if (this.platform === "win32") throw new Error(MONITOR_TOOL_ERRORS.posixOnly);
    const input = asRecord(inputValue);
    const action = trimmedString(input.action, "action") as MonitorAction;
    if (!MONITOR_ACTIONS.includes(action)) throw new Error(MONITOR_TOOL_ERRORS.unsupportedAction(action));
    this.validateActionFields(input, action);
    if (action === "list") {
      const monitors = this.list();
      return modelJsonResult(monitorListModelResult(monitors), { monitors });
    }
    if (this.shuttingDown) throw new Error(MONITOR_TOOL_ERRORS.shuttingDown);
    if (action === "create") return this.create(input, ctx);
    if (action === "clear") return this.clear();
    const id = exactId(input.id);
    const record = this.records.get(id);
    if (!record) throw new Error(MONITOR_TOOL_ERRORS.missing(id));
    if (action === "stop") return this.stop(record);
    const state = this.operationalState(record, this.toolContentMaxBytes);
    return modelJsonResult(monitorStatusModelResult(state), { monitor: state });
  }

  async reset(): Promise<void> {
    await this.shutdown();
    this.shutdownPromise = undefined;
    this.shuttingDown = false;
    this.deliveryPaused = false;
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    const pending = this.performShutdown();
    this.shutdownPromise = pending.catch((error) => {
      this.shutdownPromise = undefined;
      this.shuttingDown = false;
      throw error;
    });
    return this.shutdownPromise;
  }

  private async performShutdown(): Promise<void> {
    this.shuttingDown = true;
    this.widgetUnsubscribe?.();
    this.widgetUnsubscribe = undefined;
    this.widget.dispose();
    try {
      const stopping = [...this.stopping.values()];
      if (stopping.length > 0) await Promise.allSettled(stopping);
      this.generation += 1;
      const generation = this.generation;
      const records = [...this.records.values()];
      const active = records.filter((record) => record.status === "running");
      for (const record of active) {
        record.terminating = true;
        this.cancelEventTimer(record);
        this.trySignal(record, "SIGTERM", "shutdown TERM");
      }
      await this.waitForRecords(active, this.shutdownGraceMs, "shutdown TERM wait");
      const survivors = active.filter((record) => this.recordIsCurrent(record, generation) && record.status === "running" && this.safeGroupAlive(record, "shutdown liveness"));
      for (const record of survivors) this.trySignal(record, "SIGKILL", "shutdown KILL");
      await this.waitForRecords(survivors, this.shutdownGraceMs, "shutdown KILL wait");
      for (const record of records) {
        if (!this.recordIsCurrent(record, generation)) continue;
        if (record.status === "running") this.forceTerminal(record, MONITOR_TOOL_ERRORS.shutdownBeforeClose);
      }
    } catch (error) {
      for (const record of this.records.values()) this.appendRecordError(record, MONITOR_DIAGNOSTICS.shutdown(errorText(error)));
    } finally {
      if (this.notificationRetryTimer !== undefined) {
        try { this.clearTimeoutFn(this.notificationRetryTimer); } catch { /* cleanup continues */ }
      }
      this.notificationRetryTimer = undefined;
      this.notifications.clear();
      this.notificationLanes.clear();
      for (const record of this.records.values()) this.quiesceRecord(record);
      this.records.clear();
      this.stopping.clear();
      this.deliveryPaused = false;
      const root = this.logRoot;
      this.logRoot = undefined;
      if (root) {
        try { this.fs.rmSync(root, { recursive: true, force: true }); } catch { /* runtime state still clears */ }
      }
      this.emit({ type: "reset", reason: "lifecycle" });
      this.subscribers.clear();
    }
  }

  private validateActionFields(input: Record<string, unknown>, action: MonitorAction): void {
    const allowed = ACTION_FIELDS[action];
    const unknown = Object.keys(input).filter((field) => !allowed.includes(field));
    if (unknown.length > 0) throw new Error(MONITOR_TOOL_ERRORS.unknownFields(action, unknown));
    const required = action === "create" ? ["abstract", "command"] : action === "list" || action === "clear" ? [] : ["id"];
    for (const field of required) if (input[field] === undefined) throw new Error(MONITOR_TOOL_ERRORS.required(action, field));
  }

  private async create(input: Record<string, unknown>, ctx?: ExtensionContext): Promise<ReturnType<typeof modelJsonResult>> {
    const abstract = trimmedString(input.abstract, "abstract");
    const command = trimmedString(input.command, "command");
    const cwd = input.cwd === undefined ? trimmedString(ctx?.cwd, "cwd") : trimmedString(input.cwd, "cwd");
    const id = this.newId();
    const root = this.ensureLogRoot();
    const logPath = join(root, `${id}.jsonl`);
    const logFd = this.fs.openSync(logPath, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR, 0o600);
    let child: ChildProcessWithoutNullStreams;
    try {
      const shell = this.resolveShellFn();
      child = this.spawnFn(shell, ["-lc", command], {
        cwd,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      }) as unknown as ChildProcessWithoutNullStreams;
      child.unref();
    } catch (error) {
      try { this.fs.closeSync(logFd); } catch { /* create still fails atomically */ }
      try { this.fs.rmSync(logPath, { force: true }); } catch { /* create still fails atomically */ }
      throw error;
    }

    let resolveTerminal = () => {};
    const terminalPromise = new Promise<void>((resolve) => { resolveTerminal = resolve; });
    const now = new Date(this.nowMs()).toISOString();
    const streamState = (): StreamState => ({
      decoder: new StringDecoder("utf8"),
      partial: "",
      partialBytes: 0,
      pendingCR: false,
      truncated: false,
      truncatedBytes: 0,
      flushed: false,
    });
    const record: MonitorRecord = {
      id,
      abstract,
      command,
      cwd,
      pid: child.pid ?? 0,
      status: "running",
      createdAt: now,
      updatedAt: now,
      lastOutputAt: null,
      endedAt: null,
      exitCode: null,
      signal: null,
      error: null,
      notificationCount: 0,
      logPath,
      logFd,
      logBytes: 0,
      logLines: 0,
      droppedBytes: 0,
      droppedLines: 0,
      nextSeq: 1,
      handedCursor: 0,
      recentLines: [],
      pendingEventLines: [],
      pendingEventTotal: 0,
      child,
      streams: { stdout: streamState(), stderr: streamState() },
      exitCodeSeen: null,
      signalSeen: null,
      processError: null,
      terminating: false,
      stopOwned: false,
      generation: this.generation,
      terminalPromise,
      terminalResolved: false,
      resolveTerminal,
      listeners: [],
    };
    this.attachProcess(record);

    try {
      await new Promise<void>((resolve, reject) => {
        const onSpawn = () => {
          cleanup();
          if (!Number.isInteger(record.pid) || record.pid <= 0) {
            reject(new Error(MONITOR_TOOL_ERRORS.invalidPid));
            return;
          }
          if (record.generation !== this.generation || this.shuttingDown) {
            record.terminating = true;
            this.trySignal(record, "SIGKILL", "create rollback KILL");
            reject(new Error(MONITOR_TOOL_ERRORS.changedDuringStart));
            return;
          }
          this.records.set(id, record);
          this.emit({ type: "created", reason: "lifecycle", id, status: record.status });
          resolve();
        };
        const onError = (error: Error) => { cleanup(); reject(error); };
        const cleanup = () => {
          child.removeListener("spawn", onSpawn);
          child.removeListener("error", onError);
        };
        child.once("spawn", onSpawn);
        child.once("error", onError);
      });
    } catch (error) {
      this.records.delete(id);
      this.detachListeners(record);
      try { this.fs.closeSync(record.logFd); } catch { /* create still fails atomically */ }
      try { this.fs.rmSync(logPath, { force: true }); } catch { /* create still fails atomically */ }
      this.resolveTerminalOnce(record);
      throw error;
    }
    const state = this.operationalState(record, this.toolContentMaxBytes);
    return modelJsonResult(monitorCreateModelResult(state.id, state.status), { monitor: state });
  }

  private stop(record: MonitorRecord): Promise<ReturnType<typeof modelJsonResult>> {
    const existing = this.stopping.get(record.id);
    if (existing) return existing;
    if (record.status !== "running") return Promise.resolve(this.stopResult(record));
    const pending = this.stopRunning(record);
    this.stopping.set(record.id, pending);
    pending.then(
      () => { if (this.stopping.get(record.id) === pending) this.stopping.delete(record.id); },
      () => { if (this.stopping.get(record.id) === pending) this.stopping.delete(record.id); },
    );
    return pending;
  }

  private async stopRunning(record: MonitorRecord): Promise<ReturnType<typeof modelJsonResult>> {
    const generation = this.generation;
    record.stopOwned = true;
    record.terminating = true;
    this.cancelEventTimer(record);
    this.dropMutableNotificationState(record);
    this.trySignal(record, "SIGTERM", "stop TERM");
    try {
      await this.waitForRecord(record, this.deleteGraceMs, "stop TERM wait");
      this.requireCurrentRecord(record, generation);
      if (record.status !== "running") return this.stopResult(record);
      if (this.safeGroupAlive(record, "stop liveness")) this.trySignal(record, "SIGKILL", "stop KILL");
      await this.waitForRecord(record, this.finalKillWaitMs, "stop KILL wait");
      this.requireCurrentRecord(record, generation);
      if (record.status !== "running") return this.stopResult(record);
      this.forceTerminal(record, MONITOR_TOOL_ERRORS.stopUnconfirmed);
      return this.stopResult(record);
    } finally {
      record.stopOwned = false;
    }
  }

  private stopResult(record: MonitorRecord): ReturnType<typeof modelJsonResult> {
    const monitor = this.operationalState(record, this.toolContentMaxBytes);
    const content = monitorStopModelResult({
      id: monitor.id,
      status: monitor.status,
      exitCode: monitor.exitCode,
      signal: monitor.signal,
      error: monitor.error,
    });
    return modelJsonResult(content, { monitor });
  }

  private clear(): ReturnType<typeof modelJsonResult> {
    const running = this.sortedRecords().filter((record) => record.status === "running");
    if (running.length > 0) {
      const listed = running.map((record) => `${record.id} (${record.abstract})`).join(", ");
      throw new Error(MONITOR_TOOL_ERRORS.clearRunning(listed));
    }
    const terminal = this.sortedRecords();
    if (terminal.length === 0) {
      const receipt = { cleared: true, changed: false, clearedCount: 0, ids: [] as string[], warnings: [] as string[] };
      return modelJsonResult(monitorClearModelResult(receipt.clearedCount, receipt.warnings), receipt);
    }
    const ids: string[] = [];
    const warnings: string[] = [];
    for (const record of terminal) {
      const warning = this.disposeRecord(record);
      if (warning) warnings.push(MONITOR_DIAGNOSTICS.recordWarning(record.id, warning));
      this.cancelNotifications(record.id);
      this.records.delete(record.id);
      ids.push(record.id);
      this.emit({ type: "deleted", reason: "lifecycle", id: record.id, status: record.status });
    }
    const receipt = { cleared: true, changed: true, clearedCount: ids.length, ids, warnings };
    return modelJsonResult(monitorClearModelResult(receipt.clearedCount, receipt.warnings), receipt);
  }

  private attachProcess(record: MonitorRecord): void {
    const listen = (emitter: any, event: string, listener: (...args: any[]) => void) => {
      emitter.on(event, listener);
      record.listeners.push({ emitter, event, listener });
    };
    listen(record.child.stdout, "data", (chunk: Buffer | string) => this.acceptChunk(record, "stdout", chunk));
    listen(record.child.stderr, "data", (chunk: Buffer | string) => this.acceptChunk(record, "stderr", chunk));
    listen(record.child.stdout, "end", () => this.flushStream(record, "stdout"));
    listen(record.child.stderr, "end", () => this.flushStream(record, "stderr"));
    listen(record.child.stdout, "error", (error: Error) => this.appendRecordError(record, MONITOR_DIAGNOSTICS.stream("stdout", errorText(error))));
    listen(record.child.stderr, "error", (error: Error) => this.appendRecordError(record, MONITOR_DIAGNOSTICS.stream("stderr", errorText(error))));
    listen(record.child, "exit", (code: number | null, signal: NodeJS.Signals | null) => {
      record.exitCodeSeen = code;
      record.signalSeen = signal;
    });
    listen(record.child, "error", (error: Error) => this.appendRecordError(record, errorText(error)));
    listen(record.child, "close", (code: number | null, signal: NodeJS.Signals | null) => {
      record.exitCodeSeen = record.exitCodeSeen ?? code;
      record.signalSeen = record.signalSeen ?? signal;
      this.flushStream(record, "stdout");
      this.flushStream(record, "stderr");
      this.finalize(record);
    });
  }

  private acceptChunk(record: MonitorRecord, stream: MonitorStream, chunk: Buffer | string): void {
    if (record.generation !== this.generation || record.status !== "running") return;
    if (chunk.length > 0) record.lastOutputAt = new Date(this.nowMs()).toISOString();
    try {
      const state = record.streams[stream];
      const text = typeof chunk === "string" ? chunk : state.decoder.write(chunk);
      this.consumeText(record, stream, text, false);
    } catch (error) {
      this.appendRecordError(record, MONITOR_DIAGNOSTICS.logStream(errorText(error)));
    }
  }

  private flushStream(record: MonitorRecord, stream: MonitorStream): void {
    const state = record.streams[stream];
    if (state.flushed) return;
    state.flushed = true;
    try { this.consumeText(record, stream, state.decoder.end(), true); }
    catch (error) { this.appendRecordError(record, MONITOR_DIAGNOSTICS.logEof(errorText(error))); }
  }

  private consumeText(record: MonitorRecord, stream: MonitorStream, text: string, eof: boolean): void {
    const state = record.streams[stream];
    let current = state.pendingCR ? `\r${text}` : text;
    state.pendingCR = false;
    if (!eof && current.endsWith("\r")) {
      state.pendingCR = true;
      current = current.slice(0, -1);
    }
    let start = 0;
    for (let index = 0; index < current.length; index += 1) {
      const character = current[index];
      if (character !== "\n" && character !== "\r") continue;
      this.appendPartial(state, current.slice(start, index));
      if (character === "\r" && current[index + 1] === "\n") index += 1;
      this.finishLine(record, stream, state);
      start = index + 1;
    }
    this.appendPartial(state, current.slice(start));
    if (eof && (state.partial.length > 0 || state.truncated || state.pendingCR)) {
      state.pendingCR = false;
      this.finishLine(record, stream, state);
    }
  }

  private appendPartial(state: StreamState, fragment: string): void {
    if (!fragment) return;
    const fragmentBytes = Buffer.byteLength(fragment);
    if (state.truncated) {
      state.truncatedBytes += fragmentBytes;
      return;
    }
    const availableBytes = this.partialLineMaxBytes - state.partialBytes;
    if (fragmentBytes <= availableBytes) {
      state.partial += fragment;
      state.partialBytes += fragmentBytes;
      return;
    }
    const prefix = utf8Prefix(fragment, Math.max(0, availableBytes));
    state.partial += prefix;
    const prefixBytes = Buffer.byteLength(prefix);
    state.partialBytes += prefixBytes;
    state.truncated = true;
    state.truncatedBytes += fragmentBytes - prefixBytes;
  }

  private finishLine(record: MonitorRecord, stream: MonitorStream, state: StreamState): void {
    const suffix = state.truncated ? MONITOR_DIAGNOSTICS.partialLineTruncated(state.truncatedBytes) : "";
    const text = sanitizeText(`${state.partial}${suffix}`);
    state.partial = "";
    state.partialBytes = 0;
    state.truncated = false;
    state.truncatedBytes = 0;
    this.appendLine(record, stream, text);
  }

  private appendLine(record: MonitorRecord, stream: MonitorStream, text: string): void {
    if (record.generation !== this.generation || record.status !== "running") return;
    const line: MonitorCombinedLine = {
      seq: record.nextSeq,
      timestamp: new Date(this.nowMs()).toISOString(),
      stream,
      text,
    };
    record.nextSeq += 1;
    record.recentLines.push(line);
    if (record.recentLines.length > this.recentLineLimit) record.recentLines.splice(0, record.recentLines.length - this.recentLineLimit);
    this.writeStructuredLine(record, line);
    if (stream === "stdout") {
      record.pendingEventTotal += 1;
      record.pendingEventLines.push(line);
      if (record.pendingEventLines.length > NOTIFICATION_LINE_CAP) {
        record.pendingEventLines.splice(0, record.pendingEventLines.length - NOTIFICATION_LINE_CAP);
      }
      if (!record.terminating) this.scheduleEventBatch(record);
    }
    record.updatedAt = line.timestamp;
    this.emit({ type: "updated", reason: "output", id: record.id, status: record.status });
  }

  private writeStructuredLine(record: MonitorRecord, line: MonitorCombinedLine): void {
    let encoded: Buffer;
    try {
      encoded = this.fitStructuredLine({ ...line }, Math.max(256, this.logCapBytes - 256));
      if (record.logFd < 0) throw new Error(MONITOR_TOOL_ERRORS.logUnavailable);
      if (record.logBytes + encoded.length > this.logCapBytes && !this.rollLog(record, encoded.length, line.timestamp)) {
        this.dropUnwrittenLine(record, encoded.length);
        return;
      }
      encoded = this.fitStructuredLine({ ...line }, this.logCapBytes - record.logBytes);
      this.writeAll(record.logFd, encoded);
      record.logBytes += encoded.length;
      record.logLines += 1;
    } catch (error) {
      this.appendRecordError(record, MONITOR_DIAGNOSTICS.logWrite(errorText(error)));
      this.dropUnwrittenLine(record, Buffer.byteLength(`${JSON.stringify(line)}\n`));
      if (record.logFd >= 0) {
        try { this.fs.closeSync(record.logFd); } catch { /* logging remains disabled */ }
        record.logFd = -1;
      }
      try { record.logBytes = this.fs.statSync(record.logPath).size; } catch { /* retain the last known size */ }
    }
  }

  private fitStructuredLine(line: StructuredLogLine, maximumBytes: number): Buffer {
    let encoded = Buffer.from(`${JSON.stringify(line)}\n`);
    if (encoded.length <= maximumBytes) return encoded;
    const suffix = MONITOR_DIAGNOSTICS.logCapTruncated;
    const suffixBytes = Buffer.byteLength(suffix);
    const base = { ...line, text: suffix };
    const baseBytes = Buffer.byteLength(`${JSON.stringify(base)}\n`);
    if (baseBytes > maximumBytes) throw new Error(MONITOR_TOOL_ERRORS.logCap);
    line.text = `${utf8Prefix(line.text, Math.max(0, maximumBytes - baseBytes + suffixBytes))}${suffix}`;
    encoded = Buffer.from(`${JSON.stringify(line)}\n`);
    while (encoded.length > maximumBytes && line.text.length > suffix.length) {
      line.text = `${utf8Prefix(line.text.slice(0, -suffix.length), Math.max(0, Buffer.byteLength(line.text) - suffixBytes - 16))}${suffix}`;
      encoded = Buffer.from(`${JSON.stringify(line)}\n`);
    }
    if (encoded.length > maximumBytes) throw new Error(MONITOR_TOOL_ERRORS.logCap);
    return encoded;
  }

  private rollLog(record: MonitorRecord, incomingBytes: number, incomingTimestamp: string): boolean {
    const oldBytes = record.logBytes;
    const oldLines = record.logLines;
    let retained = Buffer.alloc(0);
    let retainedLines = 0;
    let readFd = -1;
    let tempFd = -1;
    const tempPath = `${record.logPath}.roll-${process.pid}-${randomBytes(6).toString("hex")}`;
    try {
      const budget = Math.max(0, Math.min(this.logRetainBytes, this.logCapBytes - incomingBytes - 256));
      readFd = this.fs.openSync(record.logPath, constants.O_RDONLY);
      const size = this.fs.statSync(record.logPath).size;
      const readLimit = Math.min(size, budget + this.partialLineMaxBytes + STATUS_SCAN_CHUNK);
      const start = size - readLimit;
      const data = Buffer.alloc(readLimit);
      let read = 0;
      while (read < readLimit) {
        const count = this.fs.readSync(readFd, data, read, readLimit - read, start + read);
        if (count <= 0) break;
        read += count;
      }
      retained = data.subarray(0, read);
      if (start > 0) {
        const firstNewline = retained.indexOf(10);
        retained = firstNewline >= 0 ? retained.subarray(firstNewline + 1) : Buffer.alloc(0);
      }
      if (retained.length > budget) {
        const cut = retained.length - budget;
        const newline = retained.indexOf(10, cut);
        retained = newline >= 0 ? retained.subarray(newline + 1) : Buffer.alloc(0);
      }
      retainedLines = this.countNewlines(retained);

      while (true) {
        const nextDroppedBytes = record.droppedBytes + Math.max(0, oldBytes - retained.length);
        const nextDroppedLines = record.droppedLines + Math.max(0, oldLines - retainedLines);
        const firstNewline = retained.indexOf(10);
        const firstRetained = firstNewline >= 0 ? parseStructuredLine(retained.subarray(0, firstNewline)) : undefined;
        const marker: StructuredLogLine = {
          seq: Math.max(0, (firstRetained?.seq ?? record.nextSeq - 1) - 1),
          timestamp: firstRetained?.timestamp ?? incomingTimestamp,
          stream: "stderr",
          text: MONITOR_DIAGNOSTICS.rollover(nextDroppedLines, nextDroppedBytes),
          marker: true,
        };
        const markerBuffer = this.fitStructuredLine(marker, this.logCapBytes - incomingBytes - retained.length);
        if (markerBuffer.length + retained.length + incomingBytes <= this.logCapBytes) {
          tempFd = this.fs.openSync(tempPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
          this.writeAll(tempFd, markerBuffer);
          this.writeAll(tempFd, retained);
          this.fs.closeSync(tempFd);
          tempFd = -1;
          this.fs.renameSync(tempPath, record.logPath);
          record.droppedBytes = nextDroppedBytes;
          record.droppedLines = nextDroppedLines;
          record.logBytes = markerBuffer.length + retained.length;
          record.logLines = 1 + retainedLines;
          try { this.fs.closeSync(record.logFd); } catch { /* reopen determines availability */ }
          record.logFd = -1;
          record.logFd = this.fs.openSync(record.logPath, constants.O_RDWR | constants.O_APPEND, 0o600);
          return true;
        }
        const newline = retained.indexOf(10);
        if (newline < 0) retained = Buffer.alloc(0);
        else {
          retained = retained.subarray(newline + 1);
          retainedLines = Math.max(0, retainedLines - 1);
        }
      }
    } catch (error) {
      this.appendRecordError(record, MONITOR_DIAGNOSTICS.logRollover(errorText(error)));
      return false;
    } finally {
      if (readFd >= 0) {
        try { this.fs.closeSync(readFd); } catch { /* cleanup continues */ }
      }
      if (tempFd >= 0) {
        try { this.fs.closeSync(tempFd); } catch { /* cleanup continues */ }
      }
      try { this.fs.rmSync(tempPath, { force: true }); } catch { /* cleanup continues */ }
    }
  }

  private writeAll(fd: number, buffer: Buffer): void {
    let offset = 0;
    while (offset < buffer.length) {
      const written = this.fs.writeSync(fd, buffer, offset, buffer.length - offset, null);
      if (written <= 0) throw new Error(MONITOR_TOOL_ERRORS.logWrite);
      offset += written;
    }
  }

  private dropUnwrittenLine(record: MonitorRecord, bytes: number): void {
    record.droppedBytes += Math.max(0, bytes);
    record.droppedLines += 1;
  }

  private countNewlines(buffer: Buffer): number {
    let count = 0;
    for (let index = 0; index < buffer.length; index += 1) if (buffer[index] === 10) count += 1;
    return count;
  }

  private scanLogTail(record: MonitorRecord, maximumLines: number): LogScanResult {
    const selected: MonitorCombinedLine[] = [];
    let selectedBytes = 0;
    let requested = 0;
    let reverseOffset = 0;
    let lineTruncated = false;
    let collectionFull = false;
    let fd = -1;
    try {
      fd = this.fs.openSync(record.logPath, constants.O_RDONLY);
      const size = this.fs.statSync(record.logPath).size;
      let position = size;
      let carry = Buffer.alloc(0);
      const processRaw = (raw: Buffer) => {
        if (raw.length === 0 || reverseOffset >= maximumLines) return;
        const parsed = parseStructuredLine(raw);
        if (!parsed) return;
        reverseOffset += 1;
        requested += 1;
        const bounded = boundedText(parsed.text, 16 * 1024);
        lineTruncated ||= bounded.truncated;
        const publicLine: MonitorCombinedLine = { seq: parsed.seq, timestamp: parsed.timestamp, stream: parsed.stream, text: bounded.text };
        const bytes = jsonBytes(publicLine) + 1;
        if (!collectionFull && selectedBytes + bytes <= STATUS_LINE_COLLECTION_MAX) {
          selected.unshift(publicLine);
          selectedBytes += bytes;
        } else {
          collectionFull = true;
        }
      };
      while (position > 0 && reverseOffset < maximumLines) {
        const length = Math.min(STATUS_SCAN_CHUNK, position);
        position -= length;
        const chunk = Buffer.alloc(length);
        let read = 0;
        while (read < length) {
          const count = this.fs.readSync(fd, chunk, read, length - read, position + read);
          if (count <= 0) break;
          read += count;
        }
        const data = carry.length > 0 ? Buffer.concat([chunk.subarray(0, read), carry]) : chunk.subarray(0, read);
        let lineEnd = data.length;
        for (let index = data.length - 1; index >= 0 && reverseOffset < maximumLines; index -= 1) {
          if (data[index] !== 10) continue;
          if (lineEnd > index + 1) processRaw(data.subarray(index + 1, lineEnd));
          lineEnd = index;
        }
        carry = data.subarray(0, lineEnd);
      }
      if (position === 0 && carry.length > 0 && reverseOffset < maximumLines) processRaw(carry);
      return { lines: selected, requested, scanFailed: false, lineTruncated };
    } catch (error) {
      this.appendRecordError(record, MONITOR_DIAGNOSTICS.logStatus(errorText(error)));
      return { lines: [], requested: 0, scanFailed: true, lineTruncated: false };
    } finally {
      if (fd >= 0) {
        try { this.fs.closeSync(fd); } catch { /* status still returns bounded state */ }
      }
    }
  }

  private operationalState(record: MonitorRecord, maximumBytes: number): MonitorOperationalState {
    const scan = this.scanLogTail(record, DEFAULT_RECENT_LINES);
    try { record.logBytes = this.fs.statSync(record.logPath).size; }
    catch (error) { this.appendRecordError(record, MONITOR_DIAGNOSTICS.logStat(errorText(error))); }
    const abstract = boundedText(record.abstract, RESPONSE_TEXT_MAX);
    const command = boundedText(record.command, RESPONSE_COMMAND_MAX);
    const cwd = boundedText(record.cwd, RESPONSE_TEXT_MAX);
    const error = record.error === null ? { text: null, truncated: false } : boundedText(record.error, RESPONSE_TEXT_MAX);
    const state: MonitorOperationalState = {
      id: record.id,
      abstract: abstract.text,
      command: command.text,
      cwd: cwd.text,
      pid: record.pid,
      status: record.status,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      lastOutputAt: record.lastOutputAt,
      endedAt: record.endedAt,
      exitCode: record.exitCode,
      signal: record.signal,
      error: error.text,
      notificationCount: record.notificationCount,
      logPath: record.logPath,
      logBytes: record.logBytes,
      logLines: record.logLines,
      droppedBytes: record.droppedBytes,
      droppedLines: record.droppedLines,
      returned: scan.lines.length,
      omitted: Math.max(0, scan.requested - scan.lines.length),
      truncated: scan.scanFailed || scan.lineTruncated || abstract.truncated || command.truncated || cwd.truncated || error.truncated || scan.requested > scan.lines.length,
      combined: scan.lines,
    };
    const responseBytes = () => Buffer.byteLength(JSON.stringify(state, null, 2));
    while (state.combined.length > 0 && responseBytes() > maximumBytes) {
      state.combined.shift();
      state.returned = state.combined.length;
      state.omitted += 1;
      state.truncated = true;
    }
    if (responseBytes() > maximumBytes) {
      const compactCommand = boundedText(state.command, 2 * 1024);
      state.command = compactCommand.text;
      state.truncated = true;
    }
    if (responseBytes() > maximumBytes) throw new Error(MONITOR_TOOL_ERRORS.metadataLimit);
    return state;
  }

  private scheduleEventBatch(record: MonitorRecord): void {
    if (record.eventTimer !== undefined) return;
    record.eventTimer = this.setTimeoutFn(() => {
      record.eventTimer = undefined;
      this.flushEventBatch(record);
    }, this.eventBatchMs);
    (record.eventTimer as { unref?: () => void }).unref?.();
  }

  /** A batch becomes managed only after all stdout event lines or their omission count enter its monitor lane. */
  private flushEventBatch(record: MonitorRecord): void {
    if (this.records.get(record.id) !== record || record.generation !== this.generation || record.terminating || record.pendingEventTotal === 0) return;
    const latest = record.nextSeq - 1;
    const payload = this.pendingEventPayload(record);
    const aggregate = this.aggregateFromPayload(record.id, "event", payload);
    aggregate.coveredThrough = latest;
    this.queueAggregate(record, aggregate);
    this.clearPendingEvents(record);
  }

  /** Stdout event lines are recorded once when appended. */
  private pendingEventPayload(record: MonitorRecord): NotificationLines {
    const lines = record.pendingEventLines.map((line) => ({ ...line }));
    const omitted = Math.max(0, record.pendingEventTotal - lines.length);
    return { lines, totalNew: record.pendingEventTotal, omitted, truncated: omitted > 0 };
  }

  private clearPendingEvents(record: MonitorRecord): void {
    record.pendingEventLines = [];
    record.pendingEventTotal = 0;
  }

  /** Terminal diagnostics cover output not yet successfully handed to Pi. */
  private terminalPayload(record: MonitorRecord): NotificationLines {
    const events = this.pendingEventPayload(record);
    if (record.status === "completed") return events;
    const tail = this.notificationLines(record, record.handedCursor, TERMINAL_DIAGNOSTIC_TAIL_LINES);
    const merged = new Map<number, MonitorCombinedLine>();
    for (const line of [...events.lines, ...tail.lines]) merged.set(line.seq, line);
    const lines = [...merged.values()].sort((left, right) => left.seq - right.seq);
    const totalNew = Math.max(tail.totalNew, lines.length);
    const omitted = Math.max(0, totalNew - lines.length);
    return { lines, totalNew, omitted, truncated: omitted > 0 };
  }

  private notificationLines(record: MonitorRecord, cursor: number, maximumLines: number): NotificationLines {
    const latest = record.nextSeq - 1;
    const totalNew = Math.max(0, latest - cursor);
    const available = record.recentLines.filter((line) => line.seq > cursor);
    const lines = available.slice(-maximumLines).map((line) => ({ ...line }));
    const omitted = Math.max(0, totalNew - lines.length);
    return { lines, totalNew, omitted, truncated: omitted > 0 };
  }

  private fitNotificationLines(
    record: MonitorRecord,
    payload: NotificationLines,
    build: (lines: MonitorCombinedLine[], omitted: number, truncated: boolean) => { content: string; details: Record<string, unknown> },
  ): { content: string; details: Record<string, unknown> } {
    let lines = payload.lines.map((line) => ({ ...line, text: boundedText(line.text, 16 * 1024).text }));
    let textTruncated = lines.some((line, index) => line.text !== payload.lines[index]?.text);
    while (true) {
      const omitted = Math.max(0, payload.totalNew - lines.length);
      const built = build(lines, omitted, payload.truncated || textTruncated || omitted > 0);
      if (Buffer.byteLength(built.content) <= this.notificationContentMaxBytes && jsonBytes(built.details) <= this.notificationDetailsMaxBytes - 512) return built;
      if (lines.length === 0) return build([], payload.totalNew, true);
      lines.shift();
      textTruncated = true;
    }
  }

  /** Event and terminal aggregates use the same bounded incremental update shape. */
  private buildUpdateNotification(
    record: MonitorRecord,
    aggregate: NotificationAggregate,
  ): { content: string; details: Record<string, unknown> } {
    const terminal = aggregate.kind === "terminal";
    const payload: NotificationLines = {
      lines: [...aggregate.lines.values()].sort((left, right) => left.seq - right.seq),
      totalNew: aggregate.totalLines,
      omitted: Math.max(0, aggregate.totalLines - aggregate.lines.size),
      truncated: aggregate.totalLines > aggregate.lines.size,
    };
    return this.fitNotificationLines(record, payload, (lines, omitted, truncated) => {
      const abstract = boundedText(record.abstract, RESPONSE_TEXT_MAX).text;
      const exitCode = terminal ? record.exitCode : null;
      const signal = terminal ? record.signal : null;
      const error = terminal && record.error !== null ? boundedText(record.error, RESPONSE_TEXT_MAX).text : null;
      const content = monitorUpdateContent({
        id: record.id,
        abstract,
        status: record.status,
        terminal,
        exitCode,
        signal,
        error,
        lines,
        omitted,
        truncated,
      });
      const details: Record<string, unknown> = {
        id: record.id,
        abstract,
        kind: "update",
        status: terminal ? record.status : "running",
        exitCode,
        signal,
        error,
        lines,
        omitted,
        truncated,
      };
      return { content, details };
    });
  }

  private aggregateFromPayload(
    monitorId: string,
    kind: MonitorNotificationKind,
    payload: NotificationLines,
  ): NotificationAggregate {
    return {
      monitorId,
      kind,
      lines: new Map(payload.lines.map((line) => [line.seq, { ...line }])),
      totalLines: payload.totalNew,
    };
  }

  private cloneAggregate(aggregate: NotificationAggregate): NotificationAggregate {
    return {
      ...aggregate,
      lines: new Map([...aggregate.lines].map(([seq, line]) => [seq, { ...line }])),
    };
  }

  private mergeAggregates(current: NotificationAggregate | undefined, incoming: NotificationAggregate): NotificationAggregate {
    if (!current) return this.cloneAggregate(incoming);
    const kind: MonitorNotificationKind = current.kind === "terminal" || incoming.kind === "terminal" ? "terminal" : "event";
    const lines = new Map(current.lines);
    let overlap = 0;
    for (const [seq, line] of incoming.lines) {
      if (lines.has(seq)) overlap += 1;
      lines.set(seq, { ...line });
    }
    const ordered = [...lines.values()].sort((left, right) => left.seq - right.seq);
    const visible = ordered.slice(-NOTIFICATION_LINE_CAP);
    const terminal = incoming.kind === "terminal" && incoming.diagnosticFromSeq !== undefined
      ? incoming
      : current.kind === "terminal"
        ? current
        : incoming.kind === "terminal"
          ? incoming
          : undefined;
    const totalLines = terminal?.diagnosticFromSeq !== undefined
      ? Math.max(visible.length, terminal.totalLines)
      : Math.max(visible.length, current.totalLines + incoming.totalLines - overlap);
    return {
      monitorId: current.monitorId,
      kind,
      lines: new Map(visible.map((line) => [line.seq, line])),
      totalLines,
      coveredThrough: Math.max(current.coveredThrough ?? 0, incoming.coveredThrough ?? 0) || undefined,
      diagnosticFromSeq: terminal?.diagnosticFromSeq,
    };
  }

  private finalize(record: MonitorRecord): void {
    if (record.status !== "running") return;
    const now = new Date(this.nowMs()).toISOString();
    record.exitCode = record.exitCodeSeen;
    record.signal = record.signalSeen;
    if (record.processError) record.status = "failed";
    else if (record.signalSeen) record.status = "killed";
    else if (record.exitCodeSeen === 0) record.status = "completed";
    else record.status = "failed";
    record.endedAt = now;
    record.updatedAt = now;
    this.finishTerminal(record);
  }

  private forceTerminal(record: MonitorRecord, message: string): void {
    if (record.status !== "running") return;
    const now = new Date(this.nowMs()).toISOString();
    this.appendRecordError(record, message);
    record.status = "failed";
    record.endedAt = now;
    record.updatedAt = now;
    record.exitCode = record.exitCodeSeen;
    record.signal = record.signalSeen;
    this.finishTerminal(record);
  }

  private finishTerminal(record: MonitorRecord): void {
    this.cancelEventTimer(record);
    const payload = this.terminalPayload(record);
    this.clearPendingEvents(record);
    this.quiesceRecord(record);
    this.emit({ type: "updated", reason: "lifecycle", id: record.id, status: record.status });
    if (!record.stopOwned && record.generation === this.generation && !this.shuttingDown) {
      const terminal = this.aggregateFromPayload(record.id, "terminal", payload);
      terminal.coveredThrough = record.nextSeq - 1;
      if (record.status !== "completed") terminal.diagnosticFromSeq = record.handedCursor;
      this.queueAggregate(record, terminal);
    }
  }

  private resolveTerminalOnce(record: MonitorRecord): void {
    if (record.terminalResolved) return;
    record.terminalResolved = true;
    record.resolveTerminal();
  }

  private queueAggregate(record: MonitorRecord, aggregate: NotificationAggregate): void {
    if (this.records.get(record.id) !== record || record.generation !== this.generation) return;
    const lane = this.notificationLanes.get(record.id) ?? {};
    lane.pending = this.mergeAggregates(lane.pending, aggregate);
    this.notificationLanes.set(record.id, lane);
    this.flushMonitorLane(record.id);
  }

  private freezeNotification(record: MonitorRecord, aggregate: NotificationAggregate): FrozenNotification {
    const deliveryKey = `oh-my-pi-slim:monitor:${this.generation}:${++this.notificationSequence}:${randomBytes(8).toString("hex")}`;
    const built = this.buildUpdateNotification(record, aggregate);
    return Object.freeze({
      deliveryKey,
      monitorId: record.id,
      kind: aggregate.kind,
      content: built.content,
      details: Object.freeze({ ...built.details }),
      generation: this.generation,
    });
  }

  private flushNotifications(): void {
    if (this.deliveryPaused || this.shuttingDown) return;
    for (const id of this.notificationLanes.keys()) this.flushMonitorLane(id);
  }

  private flushMonitorLane(id: string): void {
    if (this.deliveryPaused || this.shuttingDown) return;
    const lane = this.notificationLanes.get(id);
    const record = this.records.get(id);
    if (!lane?.pending || lane.inFlight || !record) return;
    let notification: FrozenNotification;
    try {
      notification = this.freezeNotification(record, lane.pending);
    } catch {
      this.scheduleNotificationRetry();
      return;
    }
    const aggregate = lane.pending;
    lane.pending = undefined;
    lane.inFlight = notification;
    try {
      this.sendMessage({
        customType: MONITOR_NOTIFICATION_TYPE,
        content: notification.content,
        display: true,
        details: { ...notification.details, deliveryKey: notification.deliveryKey },
      }, { deliverAs: "steer", triggerTurn: true });
      this.notifications.set(notification.deliveryKey, notification);
      record.handedCursor = Math.max(record.handedCursor, aggregate.coveredThrough ?? 0);
      record.notificationCount += 1;
      this.emit({ type: "updated", reason: "notification", id: record.id, status: record.status });
    } catch {
      if (lane.inFlight === notification) lane.inFlight = undefined;
      lane.pending = lane.pending ? this.mergeAggregates(aggregate, lane.pending) : this.cloneAggregate(aggregate);
      this.scheduleNotificationRetry();
    }
  }

  private scheduleNotificationRetry(): void {
    if (this.notificationRetryTimer !== undefined || this.shuttingDown) return;
    this.notificationRetryTimer = this.setTimeoutFn(() => {
      this.notificationRetryTimer = undefined;
      if (this.deliveryPaused || this.shuttingDown) return;
      this.flushNotifications();
    }, NOTIFICATION_RETRY_DELAY_MS);
    (this.notificationRetryTimer as { unref?: () => void }).unref?.();
  }

  private pruneNotificationLane(id: string, lane: NotificationLane): void {
    if (!lane.pending && !lane.inFlight) this.notificationLanes.delete(id);
  }

  private cancelNotifications(id: string): void {
    const lane = this.notificationLanes.get(id);
    if (lane?.inFlight) this.notifications.delete(lane.inFlight.deliveryKey);
    this.notificationLanes.delete(id);
  }

  private dropMutableNotificationState(record: MonitorRecord): void {
    const lane = this.notificationLanes.get(record.id);
    if (lane) {
      lane.pending = undefined;
      this.pruneNotificationLane(record.id, lane);
    }
    this.clearPendingEvents(record);
  }

  private cancelEventTimer(record: MonitorRecord): void {
    if (record.eventTimer !== undefined) {
      try { this.clearTimeoutFn(record.eventTimer); } catch { /* cleanup continues */ }
    }
    record.eventTimer = undefined;
  }

  private trySignal(record: MonitorRecord, signal: NodeJS.Signals, context: string): boolean {
    try {
      this.killGroupFn(record.pid, signal);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
      this.appendRecordError(record, MONITOR_DIAGNOSTICS.context(context, errorText(error)));
      return false;
    }
  }

  private safeGroupAlive(record: MonitorRecord, context: string): boolean {
    try {
      this.killGroupFn(record.pid, 0);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
      this.appendRecordError(record, MONITOR_DIAGNOSTICS.context(context, errorText(error)));
      return true;
    }
  }

  private async waitForRecord(record: MonitorRecord, milliseconds: number, context: string): Promise<boolean> {
    try {
      return await Promise.race([
        record.terminalPromise.then(() => true),
        this.sleepFn(milliseconds).then(() => false),
      ]);
    } catch (error) {
      this.appendRecordError(record, MONITOR_DIAGNOSTICS.context(context, errorText(error)));
      return false;
    }
  }

  private async waitForRecords(records: MonitorRecord[], milliseconds: number, context: string): Promise<void> {
    if (records.length === 0) return;
    try {
      await Promise.race([
        Promise.all(records.map((record) => record.terminalPromise)),
        this.sleepFn(milliseconds),
      ]);
    } catch (error) {
      for (const record of records) this.appendRecordError(record, MONITOR_DIAGNOSTICS.context(context, errorText(error)));
    }
  }

  private appendRecordError(record: MonitorRecord, message: string): void {
    const combinedError = MONITOR_DIAGNOSTICS.combineErrors(record.error, message);
    const combinedProcessError = MONITOR_DIAGNOSTICS.combineErrors(record.processError, message);
    record.error = boundedText(combinedError, 16 * 1024, MONITOR_DIAGNOSTICS.additionalErrorsTruncated).text;
    record.processError = boundedText(combinedProcessError, 16 * 1024, MONITOR_DIAGNOSTICS.additionalErrorsTruncated).text;
  }

  private quiesceRecord(record: MonitorRecord): void {
    this.cancelEventTimer(record);
    this.detachListeners(record);
    try { record.child.stdout.destroy(); } catch { /* cleanup continues */ }
    try { record.child.stderr.destroy(); } catch { /* cleanup continues */ }
    if (record.logFd >= 0) {
      try { this.fs.closeSync(record.logFd); } catch { /* cleanup continues */ }
      record.logFd = -1;
    }
    this.resolveTerminalOnce(record);
  }

  private removeRecordLog(record: MonitorRecord): string | null {
    try {
      this.fs.rmSync(record.logPath, { force: true });
      return null;
    } catch (error) {
      return `Failed to remove retained log: ${boundedText(errorText(error), RESPONSE_TEXT_MAX).text}`;
    }
  }

  private disposeRecord(record: MonitorRecord): string | null {
    this.quiesceRecord(record);
    return this.removeRecordLog(record);
  }

  private recordIsCurrent(record: MonitorRecord, generation: number): boolean {
    return this.generation === generation && this.records.get(record.id) === record;
  }

  private requireCurrentRecord(record: MonitorRecord, generation: number): void {
    if (!this.recordIsCurrent(record, generation)) {
      throw new Error(MONITOR_TOOL_ERRORS.changedDuringStop(record.id));
    }
  }

  private detachListeners(record: MonitorRecord): void {
    for (const { emitter, event, listener } of record.listeners) {
      try { emitter.removeListener(event, listener); } catch { /* cleanup continues */ }
    }
    record.listeners = [];
  }

  private ensureLogRoot(): string {
    if (!this.logRoot) this.logRoot = this.makeLogRoot();
    return this.logRoot;
  }

  private newId(): string {
    while (true) {
      const id = this.randomHex();
      if (!/^[0-9a-f]{8}$/.test(id)) throw new Error("Monitor ID generator must return 8 lowercase hexadecimal characters.");
      if (!this.records.has(id)) return id;
    }
  }

  private emit(change: MonitorStateChange): void {
    for (const listener of this.subscribers) {
      try { listener(change); } catch { /* subscribers do not own runtime progress */ }
    }
  }
}

export function registerMonitorRuntime(pi: ExtensionAPI, options?: MonitorRuntimeOptions): MonitorRuntime | undefined {
  const runtime = new MonitorRuntime(pi, options);
  if ((options?.platform ?? process.platform) === "win32") return undefined;
  runtime.registerTool();
  return runtime;
}
