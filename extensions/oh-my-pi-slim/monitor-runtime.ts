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
import { Type } from "typebox";
import {
  renderMonitorCall,
  renderMonitorNotification,
  renderMonitorResult,
} from "./monitor-transcript-renderer.js";
import { MonitorWidget, type MonitorWidgetItem } from "./monitor-widget.js";

export const MONITOR_ACTIONS = ["create", "stop", "delete", "clear", "list", "status"] as const;
export const MONITOR_PUBLIC_FIELDS = ["action", "abstract", "command", "cwd", "checkAfter", "notifyOn", "id", "start", "end"] as const;
export const MONITOR_NOTIFICATION_TYPE = "oh-my-pi-slim:monitor-notification";
export const MONITOR_STATUSES = ["running", "completed", "failed", "killed"] as const;
export const MONITOR_MIN_CHECK_AFTER_MS = 10_000;
export const MONITOR_MAX_CHECK_AFTER_MS = 7 * 24 * 60 * 60 * 1_000;

export type MonitorAction = (typeof MONITOR_ACTIONS)[number];
export type MonitorStatus = (typeof MONITOR_STATUSES)[number];
export type MonitorStopOutcome = "already-terminal" | "stopped" | "raced" | "unconfirmed";
export type MonitorStream = "stdout" | "stderr";
export type MonitorNotificationKind = "matcher" | "silence" | "summary" | "terminal";
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

export interface ParsedMonitorCheckAfter {
  checkAfter: string;
  milliseconds: number;
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
  checkAfter: string;
  notifyOn: string[];
  matchedCount: number;
  notificationCount: number;
  suppressedCount: number;
  logPath: string;
  logBytes: number;
  logLines: number;
  droppedBytes: number;
  droppedLines: number;
  start: number;
  end: number;
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
  checkAfter?: unknown;
  notifyOn?: unknown;
  id?: unknown;
  start?: unknown;
  end?: unknown;
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
  checkAfter: string;
  checkAfterMs: number;
  lastActivityMs: number;
  silenceTimer?: TimerHandle;
  silenceToken: number;
  notifyOn: string[];
  matchedCount: number;
  notificationCount: number;
  suppressedCount: number;
  logPath: string;
  logFd: number;
  logBytes: number;
  logLines: number;
  droppedBytes: number;
  droppedLines: number;
  nextSeq: number;
  managedCursor: number;
  handedCursor: number;
  recentLines: MonitorCombinedLine[];
  pendingMatchLines: MonitorCombinedLine[];
  pendingMatchTotal: number;
  child: ChildProcessWithoutNullStreams;
  streams: Record<MonitorStream, StreamState>;
  matchKeywords: Set<string>;
  matchTimer?: TimerHandle;
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

interface SummaryItem {
  id: string;
  abstract: string;
  status: MonitorStatus;
  suppressedBatches: number;
  suppressedLines: number;
}

interface NotificationAggregate {
  monitorId: string;
  kind: MonitorNotificationKind;
  matched: Set<string>;
  lines: Map<number, MonitorCombinedLine>;
  totalLines: number;
  suppressedBatches: number;
  suppressedLines: number;
  silenceForMs?: number;
  coveredThrough?: number;
  diagnosticFromSeq?: number;
  readyAtMs?: number;
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

interface PreparedSilenceCheck {
  timer: TimerHandle;
  token: number;
  activate(): void;
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
  defer?: (callback: () => void) => void;
  sleep?: (milliseconds: number) => Promise<void>;
  sendMessage?: SendMessage;
  logCapBytes?: number;
  logRetainBytes?: number;
  partialLineMaxBytes?: number;
  matcherBatchMs?: number;
  deleteGraceMs?: number;
  finalKillWaitMs?: number;
  shutdownGraceMs?: number;
  rateLimitCount?: number;
  rateLimitWindowMs?: number;
  recentLineLimit?: number;
  notificationContentMaxBytes?: number;
  notificationDetailsMaxBytes?: number;
  toolContentMaxBytes?: number;
  makeLogRoot?: () => string;
  fs?: Partial<MonitorFs>;
}

const ACTION_FIELDS: Record<MonitorAction, readonly string[]> = {
  create: ["action", "abstract", "command", "cwd", "checkAfter", "notifyOn"],
  stop: ["action", "id"],
  delete: ["action", "id"],
  clear: ["action"],
  list: ["action"],
  status: ["action", "id", "start", "end"],
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
const CHECK_AFTER_UNIT_MILLISECONDS = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
} as const;
const CHECK_AFTER_CANONICAL_UNITS = [
  ["d", 86_400_000],
  ["h", 3_600_000],
  ["m", 60_000],
  ["s", 1_000],
] as const;
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

function toolText(text: string, details?: unknown) {
  return { content: [{ type: "text" as const, text }], details };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("monitor input must be an object.");
  return value as Record<string, unknown>;
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function trimmedString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} must be a non-empty string.`);
  return value.trim();
}

function exactId(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}$/.test(value)) {
    throw new Error("id must be an exact 8-character lowercase hexadecimal monitor ID.");
  }
  return value;
}

function integer(value: unknown, field: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value)) throw new Error(`${field} must be a safe integer.`);
  return Number(value);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sanitizeText(text: string): string {
  return text.replace(ANSI_PATTERN, "").replace(CONTROL_PATTERN, "");
}

/** Monitor owns its own bounded duration parser so the silence contract never depends on another runtime. */
export function canonicalizeMonitorCheckAfter(milliseconds: number): string {
  if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0) throw new Error("checkAfter milliseconds must be a positive safe integer.");
  for (const [unit, unitMs] of CHECK_AFTER_CANONICAL_UNITS) {
    if (milliseconds % unitMs === 0) return `${milliseconds / unitMs}${unit}`;
  }
  throw new Error("checkAfter milliseconds must resolve to whole seconds.");
}

export function parseMonitorCheckAfter(value: unknown): ParsedMonitorCheckAfter {
  const checkAfter = trimmedString(value, "checkAfter");
  const match = /^([1-9][0-9]*)([smhd])$/.exec(checkAfter);
  if (!match) throw new Error("checkAfter must use one positive integer and one unit: s, m, h, or d.");
  const amount = BigInt(match[1]);
  const unitMs = BigInt(CHECK_AFTER_UNIT_MILLISECONDS[match[2] as keyof typeof CHECK_AFTER_UNIT_MILLISECONDS]);
  const milliseconds = amount * unitMs;
  if (milliseconds < BigInt(MONITOR_MIN_CHECK_AFTER_MS) || milliseconds > BigInt(MONITOR_MAX_CHECK_AFTER_MS)) {
    throw new Error("checkAfter must be between 10s and 7d inclusive.");
  }
  const numericMilliseconds = Number(milliseconds);
  return { checkAfter: canonicalizeMonitorCheckAfter(numericMilliseconds), milliseconds: numericMilliseconds };
}

function formatSilenceDuration(milliseconds: number): string {
  let remaining = Math.max(0, Math.floor(milliseconds / 1_000)) * 1_000;
  const parts: string[] = [];
  for (const [unit, unitMs] of CHECK_AFTER_CANONICAL_UNITS) {
    const count = Math.floor(remaining / unitMs);
    if (count > 0) parts.push(`${count}${unit}`);
    remaining -= count * unitMs;
  }
  return parts.length > 0 ? parts.join(" ") : "0s";
}

function parseNotifyOn(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("notifyOn must be an array of literal strings.");
  if (value.length > 20) throw new Error("notifyOn must contain at most 20 entries.");
  const result: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const matcher = trimmedString(value[index], `notifyOn[${index}]`);
    if (matcher.length > 500) throw new Error(`notifyOn[${index}] must contain at most 500 characters.`);
    if (seen.has(matcher)) throw new Error(`notifyOn contains duplicate literal "${matcher}".`);
    seen.add(matcher);
    result.push(matcher);
  }
  return result;
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
  throw new Error("monitor requires an executable bash on POSIX.");
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

export const monitorParameters = Type.Object({
  action: Type.Union(MONITOR_ACTIONS.map((action) => Type.Literal(action)), {
    description: "Choose an action. create requires abstract, command, and checkAfter, with optional cwd and notifyOn. stop, delete, and status require id. clear and list accept no other fields. status optionally accepts start and end.",
  }),
  abstract: Type.Optional(Type.String({ description: "Short command summary for create." })),
  command: Type.Optional(Type.String({
    description: "Foreground Bash command for create. Do not use nohup, setsid, disown, trailing &, or another detach escape.",
  })),
  cwd: Type.Optional(Type.String({ description: "Working directory for create. Defaults to the current session directory." })),
  checkAfter: Type.Optional(Type.String({
    description: "Required silence threshold for create, from 10s through 7d. A reminder arrives whenever the command stays silent that long. Format: one positive integer plus s, m, h, or d.",
  })),
  notifyOn: Type.Optional(Type.Array(Type.String({ maxLength: 500 }), {
    maxItems: 20,
    uniqueItems: true,
    description: "Up to 20 unique case-sensitive literal matchers for create. Each matcher is at most 500 characters.",
  })),
  id: Type.Optional(Type.String({ description: "Exact eight-character lowercase hexadecimal monitor ID for stop, delete, or status." })),
  start: Type.Optional(Type.Integer({ minimum: 0, description: "Newest retained log lines to skip for status. Defaults to 0." })),
  end: Type.Optional(Type.Integer({
    minimum: 1,
    description: "Reverse log offset ending the status window. Defaults to 100 and must exceed start by at most 2000.",
  })),
}, { additionalProperties: false });

if (JSON.stringify(Object.keys(monitorParameters.properties).sort()) !== JSON.stringify([...MONITOR_PUBLIC_FIELDS].sort())) {
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
  private readonly defer: (callback: () => void) => void;
  private readonly sleepFn: (milliseconds: number) => Promise<void>;
  private readonly sendMessage: SendMessage;
  private readonly logCapBytes: number;
  private readonly logRetainBytes: number;
  private readonly partialLineMaxBytes: number;
  private readonly matcherBatchMs: number;
  private readonly deleteGraceMs: number;
  private readonly finalKillWaitMs: number;
  private readonly shutdownGraceMs: number;
  private readonly rateLimitCount: number;
  private readonly rateLimitWindowMs: number;
  private readonly recentLineLimit: number;
  private readonly notificationContentMaxBytes: number;
  private readonly notificationDetailsMaxBytes: number;
  private readonly toolContentMaxBytes: number;
  private readonly makeLogRoot: () => string;
  private readonly fs: MonitorFs;
  private readonly records = new Map<string, MonitorRecord>();
  private readonly stopping = new Map<string, Promise<ReturnType<typeof toolText>>>();
  private readonly notifications = new Map<string, FrozenNotification>();
  private readonly notificationLanes = new Map<string, NotificationLane>();
  private readonly subscribers = new Set<(change: MonitorStateChange) => void>();
  private readonly widget: MonitorWidget;
  private widgetUnsubscribe?: () => void;
  private readonly sentMatcherAt: number[] = [];
  private logRoot?: string;
  private generation = 0;
  private deliveryPaused = false;
  private shuttingDown = false;
  private summaryTimer?: TimerHandle;
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
    this.defer = options.defer ?? ((callback) => queueMicrotask(callback));
    this.sleepFn = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.sendMessage = options.sendMessage ?? ((message, sendOptions) => this.pi.sendMessage(message, sendOptions));
    this.logCapBytes = options.logCapBytes ?? DEFAULT_LOG_CAP;
    this.logRetainBytes = Math.min(options.logRetainBytes ?? DEFAULT_LOG_RETAIN, this.logCapBytes);
    this.partialLineMaxBytes = options.partialLineMaxBytes ?? DEFAULT_PARTIAL_MAX;
    this.matcherBatchMs = options.matcherBatchMs ?? 100;
    this.deleteGraceMs = options.deleteGraceMs ?? 3_000;
    this.finalKillWaitMs = options.finalKillWaitMs ?? this.deleteGraceMs;
    this.shutdownGraceMs = options.shutdownGraceMs ?? 1_000;
    this.rateLimitCount = options.rateLimitCount ?? 20;
    this.rateLimitWindowMs = options.rateLimitWindowMs ?? 60_000;
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
      name: "monitor",
      label: "Monitor",
      executionMode: "sequential",
      description: "Run and manage long-running foreground Bash commands on POSIX systems while Pi remains available. Each monitor owns the command's foreground process group. Matcher notifications carry the current status and only the new lines that matched a `notifyOn` literal. Terminal notifications carry the final status, exit code, signal, error, and any matched lines no earlier notification delivered. A failed or killed command also adds a bounded recent diagnostic tail. A silence reminder arrives whenever a running command produces no output for its `checkAfter` threshold. Summary notifications report rate-limited matcher batches. `notifyOn` performs case-sensitive literal matching. `monitor list` returns compact retained records. `monitor status` returns one record's full retained state and combined logs. `monitor stop` terminates a running group and returns its complete terminal state. `monitor delete` removes one terminal record, while `monitor clear` removes all terminal records. Running records must be stopped only after user agreement. Terminal records remain available until deletion or clearing. Runtime shutdown terminates active groups and clears retained monitor data.",
      promptSnippet: "Supervise long-running foreground commands.",
      promptGuidelines: [
        "Never detach a `monitor create` command with nohup, setsid, disown, trailing &, or another daemon escape.",
        "Do not poll a running monitor with repeated `monitor status` calls.",
        "Matcher updates carry matching lines, terminal updates add pending matches and bounded failure tails, and `monitor status` returns everything retained.",
      ],
      parameters: monitorParameters,
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

  async execute(inputValue: MonitorInput, ctx?: ExtensionContext): Promise<ReturnType<typeof toolText>> {
    if (this.platform === "win32") throw new Error("monitor is available only on POSIX.");
    const input = asRecord(inputValue);
    const action = trimmedString(input.action, "action") as MonitorAction;
    if (!MONITOR_ACTIONS.includes(action)) throw new Error(`Unsupported monitor action: ${action}`);
    this.validateActionFields(input, action);
    if (action === "list") {
      const monitors = this.list();
      return toolText(JSON.stringify(monitors, null, 2), { monitors });
    }
    if (this.shuttingDown) throw new Error("Monitor runtime is shutting down.");
    if (action === "create") return this.create(input, ctx);
    if (action === "clear") return this.clear();
    const id = exactId(input.id);
    const record = this.records.get(id);
    if (!record) throw new Error(`Monitor ${id} was not found.`);
    if (action === "stop") return this.stop(record);
    if (action === "delete") return this.delete(record);
    const start = integer(input.start, "start", 0);
    const end = integer(input.end, "end", 100);
    if (start < 0 || end <= start) throw new Error("status requires 0 <= start < end.");
    if (end - start > 2_000) throw new Error("status window must contain at most 2000 lines.");
    const state = this.operationalState(record, start, end, this.toolContentMaxBytes);
    return toolText(JSON.stringify(state, null, 2), { monitor: state });
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
        this.cancelSilence(record);
        this.cancelMatchTimer(record);
        this.trySignal(record, "SIGTERM", "shutdown TERM");
      }
      await this.waitForRecords(active, this.shutdownGraceMs, "shutdown TERM wait");
      const survivors = active.filter((record) => this.recordIsCurrent(record, generation) && record.status === "running" && this.safeGroupAlive(record, "shutdown liveness"));
      for (const record of survivors) this.trySignal(record, "SIGKILL", "shutdown KILL");
      await this.waitForRecords(survivors, this.shutdownGraceMs, "shutdown KILL wait");
      for (const record of records) {
        if (!this.recordIsCurrent(record, generation)) continue;
        if (record.status === "running") this.forceTerminal(record, "Monitor runtime shut down before child close was observed.");
      }
    } catch (error) {
      for (const record of this.records.values()) this.appendRecordError(record, `shutdown: ${errorText(error)}`);
    } finally {
      if (this.summaryTimer !== undefined) {
        try { this.clearTimeoutFn(this.summaryTimer); } catch { /* cleanup continues */ }
      }
      if (this.notificationRetryTimer !== undefined) {
        try { this.clearTimeoutFn(this.notificationRetryTimer); } catch { /* cleanup continues */ }
      }
      this.summaryTimer = undefined;
      this.notificationRetryTimer = undefined;
      this.notifications.clear();
      this.notificationLanes.clear();
      this.sentMatcherAt.length = 0;
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
    if (unknown.length > 0) throw new Error(`${action} does not accept field(s): ${unknown.join(", ")}.`);
    const required = action === "create" ? ["abstract", "command", "checkAfter"] : action === "list" || action === "clear" ? [] : ["id"];
    for (const field of required) if (input[field] === undefined) throw new Error(`${action} requires ${field}.`);
  }

  private async create(input: Record<string, unknown>, ctx?: ExtensionContext): Promise<ReturnType<typeof toolText>> {
    const abstract = trimmedString(input.abstract, "abstract");
    const command = trimmedString(input.command, "command");
    const cwd = input.cwd === undefined ? trimmedString(ctx?.cwd, "cwd") : trimmedString(input.cwd, "cwd");
    const check = parseMonitorCheckAfter(input.checkAfter);
    const notifyOn = parseNotifyOn(input.notifyOn);
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
      checkAfter: check.checkAfter,
      checkAfterMs: check.milliseconds,
      lastActivityMs: this.nowMs(),
      silenceToken: 0,
      notifyOn,
      matchedCount: 0,
      notificationCount: 0,
      suppressedCount: 0,
      logPath,
      logFd,
      logBytes: 0,
      logLines: 0,
      droppedBytes: 0,
      droppedLines: 0,
      nextSeq: 1,
      managedCursor: 0,
      handedCursor: 0,
      recentLines: [],
      pendingMatchLines: [],
      pendingMatchTotal: 0,
      child,
      streams: { stdout: streamState(), stderr: streamState() },
      matchKeywords: new Set(),
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
            reject(new Error("monitor spawn did not return a valid PID."));
            return;
          }
          if (record.generation !== this.generation || this.shuttingDown) {
            record.terminating = true;
            this.trySignal(record, "SIGKILL", "create rollback KILL");
            reject(new Error("Monitor runtime changed while the command was starting."));
            return;
          }
          this.records.set(id, record);
          try {
            record.lastActivityMs = this.nowMs();
            this.applySilenceCheck(record, this.prepareSilenceCheck(record, record.checkAfterMs));
          } catch (error) {
            this.records.delete(id);
            record.terminating = true;
            this.trySignal(record, "SIGKILL", "create silence rollback KILL");
            reject(error instanceof Error ? error : new Error(errorText(error)));
            return;
          }
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
      this.cancelSilence(record);
      this.detachListeners(record);
      try { this.fs.closeSync(record.logFd); } catch { /* create still fails atomically */ }
      try { this.fs.rmSync(logPath, { force: true }); } catch { /* create still fails atomically */ }
      this.resolveTerminalOnce(record);
      throw error;
    }
    const state = this.operationalState(record, 0, 100, this.toolContentMaxBytes);
    return toolText(JSON.stringify(state, null, 2), { monitor: state });
  }

  private stop(record: MonitorRecord): Promise<ReturnType<typeof toolText>> {
    const existing = this.stopping.get(record.id);
    if (existing) return existing;
    if (record.status !== "running") return Promise.resolve(this.stopResult(record, false, "already-terminal", null));
    const pending = this.stopRunning(record);
    this.stopping.set(record.id, pending);
    pending.then(
      () => { if (this.stopping.get(record.id) === pending) this.stopping.delete(record.id); },
      () => { if (this.stopping.get(record.id) === pending) this.stopping.delete(record.id); },
    );
    return pending;
  }

  private async stopRunning(record: MonitorRecord): Promise<ReturnType<typeof toolText>> {
    const generation = this.generation;
    record.stopOwned = true;
    record.terminating = true;
    this.cancelSilence(record);
    this.cancelMatchTimer(record);
    this.dropMutableNotificationState(record);
    this.trySignal(record, "SIGTERM", "stop TERM");
    try {
      await this.waitForRecord(record, this.deleteGraceMs, "stop TERM wait");
      this.requireCurrentRecord(record, generation);
      if (record.status !== "running") return this.finishObservedStop(record);
      if (this.safeGroupAlive(record, "stop liveness")) this.trySignal(record, "SIGKILL", "stop KILL");
      await this.waitForRecord(record, this.finalKillWaitMs, "stop KILL wait");
      this.requireCurrentRecord(record, generation);
      if (record.status !== "running") return this.finishObservedStop(record);
      const warning = "Child close was not observed after bounded TERM and KILL waits. Stop is unconfirmed and a detached descendant may remain.";
      this.forceTerminal(record, warning);
      return this.stopResult(record, true, "unconfirmed", warning);
    } finally {
      record.stopOwned = false;
    }
  }

  private finishObservedStop(record: MonitorRecord): ReturnType<typeof toolText> {
    const outcome: MonitorStopOutcome = record.signal === "SIGTERM" || record.signal === "SIGKILL" ? "stopped" : "raced";
    return this.stopResult(record, true, outcome, null);
  }

  private stopResult(
    record: MonitorRecord,
    changed: boolean,
    outcome: MonitorStopOutcome,
    warning: string | null,
  ): ReturnType<typeof toolText> {
    const monitor = this.operationalState(record, 0, 100, this.toolContentMaxBytes);
    return toolText(JSON.stringify(monitor, null, 2), { monitor, changed, outcome, warning });
  }

  private delete(record: MonitorRecord): ReturnType<typeof toolText> {
    if (record.status === "running") {
      throw new Error(`Monitor ${record.id} (${record.abstract}) is running. Ask the user whether to stop it, then call monitor stop and retry delete only if they agree.`);
    }
    const status = record.status;
    const warning = this.disposeRecord(record);
    this.cancelNotifications(record.id);
    this.records.delete(record.id);
    this.emit({ type: "deleted", reason: "lifecycle", id: record.id, status });
    const text = warning ? `Deleted monitor ${record.id}. Warning: ${warning}` : `Deleted monitor ${record.id}.`;
    return toolText(text, { id: record.id, deleted: true, changed: true, status, warning });
  }

  private clear(): ReturnType<typeof toolText> {
    const running = this.sortedRecords().filter((record) => record.status === "running");
    if (running.length > 0) {
      const listed = running.map((record) => `${record.id} (${record.abstract})`).join(", ");
      throw new Error(`Cannot clear while these monitors are running: ${listed}. Ask the user whether to stop them, then call monitor stop for each and retry clear only if they agree.`);
    }
    const terminal = this.sortedRecords();
    if (terminal.length === 0) {
      const receipt = { cleared: true, changed: false, clearedCount: 0, ids: [] as string[], warnings: [] as string[] };
      return toolText(JSON.stringify(receipt), receipt);
    }
    const ids: string[] = [];
    const warnings: string[] = [];
    for (const record of terminal) {
      const warning = this.disposeRecord(record);
      if (warning) warnings.push(`${record.id}: ${warning}`);
      this.cancelNotifications(record.id);
      this.records.delete(record.id);
      ids.push(record.id);
      this.emit({ type: "deleted", reason: "lifecycle", id: record.id, status: record.status });
    }
    const receipt = { cleared: true, changed: true, clearedCount: ids.length, ids, warnings };
    return toolText(JSON.stringify(receipt), receipt);
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
    listen(record.child.stdout, "error", (error: Error) => this.appendRecordError(record, `stdout: ${errorText(error)}`));
    listen(record.child.stderr, "error", (error: Error) => this.appendRecordError(record, `stderr: ${errorText(error)}`));
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
    if (chunk.length > 0) this.noteOutputActivity(record);
    try {
      const state = record.streams[stream];
      const text = typeof chunk === "string" ? chunk : state.decoder.write(chunk);
      this.consumeText(record, stream, text, false);
    } catch (error) {
      this.appendRecordError(record, `log stream: ${errorText(error)}`);
    }
  }

  private flushStream(record: MonitorRecord, stream: MonitorStream): void {
    const state = record.streams[stream];
    if (state.flushed) return;
    state.flushed = true;
    try { this.consumeText(record, stream, state.decoder.end(), true); }
    catch (error) { this.appendRecordError(record, `log EOF: ${errorText(error)}`); }
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
    const suffix = state.truncated ? ` … [truncated ${state.truncatedBytes} bytes]` : "";
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
    const matched = record.notifyOn.filter((matcher) => text.includes(matcher));
    if (matched.length > 0) {
      record.matchedCount += matched.length;
      for (const matcher of matched) record.matchKeywords.add(matcher);
      record.pendingMatchTotal += 1;
      record.pendingMatchLines.push(line);
      if (record.pendingMatchLines.length > NOTIFICATION_LINE_CAP) {
        record.pendingMatchLines.splice(0, record.pendingMatchLines.length - NOTIFICATION_LINE_CAP);
      }
      if (!record.terminating) this.scheduleMatcherBatch(record);
    }
    record.updatedAt = line.timestamp;
    this.emit({ type: "updated", reason: "output", id: record.id, status: record.status });
  }

  private writeStructuredLine(record: MonitorRecord, line: MonitorCombinedLine): void {
    let encoded: Buffer;
    try {
      encoded = this.fitStructuredLine({ ...line }, Math.max(256, this.logCapBytes - 256));
      if (record.logFd < 0) throw new Error("monitor log file is unavailable");
      if (record.logBytes + encoded.length > this.logCapBytes && !this.rollLog(record, encoded.length, line.timestamp)) {
        this.dropUnwrittenLine(record, encoded.length);
        return;
      }
      encoded = this.fitStructuredLine({ ...line }, this.logCapBytes - record.logBytes);
      this.writeAll(record.logFd, encoded);
      record.logBytes += encoded.length;
      record.logLines += 1;
    } catch (error) {
      this.appendRecordError(record, `log write: ${errorText(error)}`);
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
    const suffix = " … [log-cap truncated]";
    const suffixBytes = Buffer.byteLength(suffix);
    const base = { ...line, text: suffix };
    const baseBytes = Buffer.byteLength(`${JSON.stringify(base)}\n`);
    if (baseBytes > maximumBytes) throw new Error("monitor log cap is too small for one structured line");
    line.text = `${utf8Prefix(line.text, Math.max(0, maximumBytes - baseBytes + suffixBytes))}${suffix}`;
    encoded = Buffer.from(`${JSON.stringify(line)}\n`);
    while (encoded.length > maximumBytes && line.text.length > suffix.length) {
      line.text = `${utf8Prefix(line.text.slice(0, -suffix.length), Math.max(0, Buffer.byteLength(line.text) - suffixBytes - 16))}${suffix}`;
      encoded = Buffer.from(`${JSON.stringify(line)}\n`);
    }
    if (encoded.length > maximumBytes) throw new Error("monitor log cap is too small for one structured line");
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
          text: `[monitor log rollover: dropped ${nextDroppedLines} lines and ${nextDroppedBytes} bytes; use monitor status for retained output]`,
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
      this.appendRecordError(record, `log rollover: ${errorText(error)}`);
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
      if (written <= 0) throw new Error("monitor log write made no progress");
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

  private scanLogTail(record: MonitorRecord, start: number, end: number): LogScanResult {
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
        if (raw.length === 0 || reverseOffset >= end) return;
        const parsed = parseStructuredLine(raw);
        if (!parsed) return;
        const offset = reverseOffset;
        reverseOffset += 1;
        if (offset < start || offset >= end) return;
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
      while (position > 0 && reverseOffset < end) {
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
        for (let index = data.length - 1; index >= 0 && reverseOffset < end; index -= 1) {
          if (data[index] !== 10) continue;
          if (lineEnd > index + 1) processRaw(data.subarray(index + 1, lineEnd));
          lineEnd = index;
        }
        carry = data.subarray(0, lineEnd);
      }
      if (position === 0 && carry.length > 0 && reverseOffset < end) processRaw(carry);
      return { lines: selected, requested, scanFailed: false, lineTruncated };
    } catch (error) {
      this.appendRecordError(record, `log status: ${errorText(error)}`);
      return { lines: [], requested: 0, scanFailed: true, lineTruncated: false };
    } finally {
      if (fd >= 0) {
        try { this.fs.closeSync(fd); } catch { /* status still returns bounded state */ }
      }
    }
  }

  private operationalState(record: MonitorRecord, start: number, end: number, maximumBytes: number): MonitorOperationalState {
    const scan = this.scanLogTail(record, start, end);
    try { record.logBytes = this.fs.statSync(record.logPath).size; }
    catch (error) { this.appendRecordError(record, `log stat: ${errorText(error)}`); }
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
      checkAfter: record.checkAfter,
      notifyOn: [...record.notifyOn],
      matchedCount: record.matchedCount,
      notificationCount: record.notificationCount,
      suppressedCount: record.suppressedCount,
      logPath: record.logPath,
      logBytes: record.logBytes,
      logLines: record.logLines,
      droppedBytes: record.droppedBytes,
      droppedLines: record.droppedLines,
      start,
      end,
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
    if (responseBytes() > maximumBytes) throw new Error("monitor operational metadata exceeds the bounded response limit.");
    return state;
  }

  private scheduleMatcherBatch(record: MonitorRecord): void {
    if (record.matchTimer !== undefined) return;
    record.matchTimer = this.setTimeoutFn(() => {
      record.matchTimer = undefined;
      this.flushMatcherBatch(record);
    }, this.matcherBatchMs);
    (record.matchTimer as { unref?: () => void }).unref?.();
  }

  /** A batch becomes managed only after all matching lines or their omission count enter its monitor lane. */
  private flushMatcherBatch(record: MonitorRecord): void {
    if (this.records.get(record.id) !== record || record.generation !== this.generation || record.terminating || record.matchKeywords.size === 0) return;
    const keywords = [...record.matchKeywords];
    const latest = record.nextSeq - 1;
    const payload = this.pendingMatchPayload(record);
    this.expireRateWindow();
    if (this.sentMatcherAt.length >= this.rateLimitCount) {
      const aggregate = this.aggregateFromPayload(record.id, "summary", keywords, payload);
      aggregate.suppressedBatches = 1;
      aggregate.suppressedLines = payload.totalNew;
      aggregate.coveredThrough = latest;
      aggregate.readyAtMs = this.rateSummaryReadyAt();
      this.queueAggregate(record, aggregate);
      record.suppressedCount += 1;
      this.emit({ type: "updated", reason: "notification", id: record.id, status: record.status });
    } else {
      this.sentMatcherAt.push(this.nowMs());
      const aggregate = this.aggregateFromPayload(record.id, "matcher", keywords, payload);
      aggregate.coveredThrough = latest;
      this.queueAggregate(record, aggregate);
    }
    record.matchKeywords.clear();
    this.clearPendingMatches(record);
    record.managedCursor = latest;
  }

  private expireRateWindow(): void {
    const cutoff = this.nowMs() - this.rateLimitWindowMs;
    while (this.sentMatcherAt.length > 0 && this.sentMatcherAt[0] <= cutoff) this.sentMatcherAt.shift();
  }

  private rateSummaryReadyAt(): number {
    return (this.sentMatcherAt[0] ?? this.nowMs()) + this.rateLimitWindowMs;
  }

  private scheduleRateSummary(): void {
    if (this.summaryTimer !== undefined || this.shuttingDown) return;
    let nextReadyAt: number | undefined;
    for (const lane of this.notificationLanes.values()) {
      const readyAt = lane.pending?.readyAtMs;
      if (readyAt !== undefined && (nextReadyAt === undefined || readyAt < nextReadyAt)) nextReadyAt = readyAt;
    }
    if (nextReadyAt === undefined) return;
    this.summaryTimer = this.setTimeoutFn(() => {
      this.summaryTimer = undefined;
      const now = this.nowMs();
      for (const lane of this.notificationLanes.values()) {
        if (lane.pending?.readyAtMs !== undefined && lane.pending.readyAtMs <= now) lane.pending.readyAtMs = undefined;
      }
      this.flushNotifications();
      this.scheduleRateSummary();
    }, Math.max(0, nextReadyAt - this.nowMs()));
    (this.summaryTimer as { unref?: () => void }).unref?.();
  }

  private buildSummaryNotification(record: MonitorRecord, item: SummaryItem, aggregate: NotificationAggregate): { content: string; details: Record<string, unknown> } {
    const visible = { ...item, abstract: boundedText(item.abstract, RESPONSE_TEXT_MAX).text };
    const silence = aggregate.silenceForMs === undefined ? undefined : this.silenceDetails(record, aggregate.silenceForMs);
    const silenceText = silence ? ` It has also produced no output for ${silence.silentFor}.` : "";
    return {
      content: `Monitor matcher notifications were rate-limited. ${visible.id} (${visible.abstract}): ${visible.suppressedBatches} batches and ${visible.suppressedLines} lines.${silenceText} Use monitor status.`,
      details: { kind: "summary", monitors: [visible], omittedMonitors: 0, truncated: false, ...silence },
    };
  }

  /** Matched lines are recorded once per line when they are appended, so one line never repeats per literal. */
  private pendingMatchPayload(record: MonitorRecord): NotificationLines {
    const lines = record.pendingMatchLines.map((line) => ({ ...line }));
    const omitted = Math.max(0, record.pendingMatchTotal - lines.length);
    return { lines, totalNew: record.pendingMatchTotal, omitted, truncated: omitted > 0 };
  }

  private clearPendingMatches(record: MonitorRecord): void {
    record.pendingMatchLines = [];
    record.pendingMatchTotal = 0;
  }

  /** Terminal diagnostics cover output not yet successfully handed to Pi. */
  private terminalPayload(record: MonitorRecord): NotificationLines {
    const matches = this.pendingMatchPayload(record);
    if (record.status === "completed") return matches;
    const tail = this.notificationLines(record, record.handedCursor, TERMINAL_DIAGNOSTIC_TAIL_LINES);
    const merged = new Map<number, MonitorCombinedLine>();
    for (const line of [...matches.lines, ...tail.lines]) merged.set(line.seq, line);
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

  /** Every matcher and terminal aggregate uses the same bounded incremental update shape. */
  private buildUpdateNotification(
    record: MonitorRecord,
    aggregate: NotificationAggregate,
  ): { content: string; details: Record<string, unknown> } {
    const terminal = aggregate.kind === "terminal";
    const matched = [...aggregate.matched].sort();
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
      const heading = [`Monitor ${record.id} (${abstract}) status ${terminal ? record.status : "running"}.`];
      if (matched.length > 0) heading.push(`Matched: ${matched.join(", ")}.`);
      if (aggregate.suppressedBatches > 0) heading.push(`Rate limited: ${aggregate.suppressedBatches} batches and ${aggregate.suppressedLines} lines.`);
      const silence = aggregate.silenceForMs === undefined ? undefined : this.silenceDetails(record, aggregate.silenceForMs);
      if (silence) heading.push(`Silence: no output for ${silence.silentFor}; checkAfter ${silence.checkAfter}.`);
      if (terminal) heading.push(`Exit code: ${exitCode ?? "null"}; signal: ${signal ?? "null"}; error: ${error ?? "null"}.`);
      const truncation = truncated ? `\n[truncated: omitted ${omitted} lines and/or shortened oversized lines; use monitor status]` : "";
      const content = [...heading, ...lines.map((line) => `[${line.stream}] ${line.text}`)].join("\n") + truncation;
      const details: Record<string, unknown> = {
        id: record.id,
        abstract,
        kind: "update",
        status: terminal ? record.status : "running",
        matched,
        exitCode,
        signal,
        error,
        lines,
        omitted,
        truncated,
      };
      if (aggregate.suppressedBatches > 0) {
        details.suppressedBatches = aggregate.suppressedBatches;
        details.suppressedLines = aggregate.suppressedLines;
      }
      if (silence) Object.assign(details, silence);
      return { content, details };
    });
  }

  private aggregateFromPayload(
    monitorId: string,
    kind: "matcher" | "summary" | "terminal",
    matched: string[],
    payload: NotificationLines,
  ): NotificationAggregate {
    return {
      monitorId,
      kind,
      matched: new Set(matched),
      lines: new Map(payload.lines.map((line) => [line.seq, { ...line }])),
      totalLines: payload.totalNew,
      suppressedBatches: 0,
      suppressedLines: 0,
    };
  }

  private cloneAggregate(aggregate: NotificationAggregate): NotificationAggregate {
    return {
      ...aggregate,
      matched: new Set(aggregate.matched),
      lines: new Map([...aggregate.lines].map(([seq, line]) => [seq, { ...line }])),
    };
  }

  private mergeAggregates(current: NotificationAggregate | undefined, incoming: NotificationAggregate): NotificationAggregate {
    if (!current) return this.cloneAggregate(incoming);
    const priorities: Record<MonitorNotificationKind, number> = { silence: 1, summary: 2, matcher: 3, terminal: 4 };
    const kind = priorities[incoming.kind] >= priorities[current.kind] ? incoming.kind : current.kind;
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
    const readyTimes = [current.readyAtMs, incoming.readyAtMs].filter((value): value is number => value !== undefined);
    return {
      monitorId: current.monitorId,
      kind,
      matched: new Set([...current.matched, ...incoming.matched]),
      lines: new Map(visible.map((line) => [line.seq, line])),
      totalLines,
      suppressedBatches: current.suppressedBatches + incoming.suppressedBatches,
      suppressedLines: current.suppressedLines + incoming.suppressedLines,
      silenceForMs: incoming.silenceForMs ?? current.silenceForMs,
      coveredThrough: Math.max(current.coveredThrough ?? 0, incoming.coveredThrough ?? 0) || undefined,
      diagnosticFromSeq: terminal?.diagnosticFromSeq,
      readyAtMs: kind === "summary" && readyTimes.length > 0 ? Math.min(...readyTimes) : undefined,
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
    const pendingSilenceForMs = this.notificationLanes.get(record.id)?.pending?.silenceForMs;
    this.cancelSilence(record);
    this.cancelMatchTimer(record);
    const matched = [...record.matchKeywords];
    const payload = this.terminalPayload(record);
    record.matchKeywords.clear();
    this.clearPendingMatches(record);
    const latest = record.nextSeq - 1;
    this.quiesceRecord(record);
    this.emit({ type: "updated", reason: "lifecycle", id: record.id, status: record.status });
    if (!record.stopOwned && record.generation === this.generation && !this.shuttingDown) {
      const terminal = this.aggregateFromPayload(record.id, "terminal", matched, payload);
      terminal.coveredThrough = record.nextSeq - 1;
      terminal.silenceForMs = pendingSilenceForMs;
      if (record.status !== "completed") terminal.diagnosticFromSeq = record.handedCursor;
      this.queueAggregate(record, terminal);
    }
    record.managedCursor = latest;
  }

  private resolveTerminalOnce(record: MonitorRecord): void {
    if (record.terminalResolved) return;
    record.terminalResolved = true;
    record.resolveTerminal();
  }

  private silenceDetails(record: MonitorRecord, silentForMs: number): {
    checkAfter: string;
    silentFor: string;
    silentForMs: number;
    lastOutputAt: string | null;
  } {
    const silentForRoundedMs = Math.max(0, Math.floor(silentForMs / 1_000)) * 1_000;
    return {
      checkAfter: record.checkAfter,
      silentFor: formatSilenceDuration(silentForRoundedMs),
      silentForMs: silentForRoundedMs,
      lastOutputAt: record.lastOutputAt,
    };
  }

  private buildSilenceNotification(record: MonitorRecord, silentForMs: number): { content: string; details: Record<string, unknown> } {
    const abstract = boundedText(record.abstract, RESPONSE_TEXT_MAX).text;
    const silence = this.silenceDetails(record, silentForMs);
    const content = [
      `Monitor ${record.id} (${abstract}) has produced no stdout or stderr output for ${silence.silentFor}.`,
      `Its checkAfter threshold is ${record.checkAfter} and it is still running.`,
      `Call monitor status with id ${record.id} now to check the current state of this monitor.`,
    ].join(" ");
    const details = {
      kind: "silence",
      id: record.id,
      abstract,
      status: "running",
      ...silence,
    };
    return { content, details };
  }

  /** Only the latest pending silence reminder is retained; an immutable in-flight copy is never rewritten. */
  private notifySilence(record: MonitorRecord, silentForMs: number): void {
    if (record.generation !== this.generation || this.shuttingDown) return;
    this.queueAggregate(record, {
      monitorId: record.id,
      kind: "silence",
      matched: new Set(),
      lines: new Map(),
      totalLines: 0,
      suppressedBatches: 0,
      suppressedLines: 0,
      silenceForMs: silentForMs,
    });
  }

  private queueAggregate(record: MonitorRecord, aggregate: NotificationAggregate): void {
    if (this.records.get(record.id) !== record || record.generation !== this.generation) return;
    const lane = this.notificationLanes.get(record.id) ?? {};
    lane.pending = this.mergeAggregates(lane.pending, aggregate);
    this.notificationLanes.set(record.id, lane);
    this.flushMonitorLane(record.id);
    this.scheduleRateSummary();
  }

  private freezeNotification(record: MonitorRecord, aggregate: NotificationAggregate): FrozenNotification {
    const deliveryKey = `oh-my-pi-slim:monitor:${this.generation}:${++this.notificationSequence}:${randomBytes(8).toString("hex")}`;
    const built = aggregate.kind === "silence"
      ? this.buildSilenceNotification(record, aggregate.silenceForMs ?? 0)
      : aggregate.kind === "summary"
        ? this.buildSummaryNotification(record, {
          id: record.id,
          abstract: record.abstract,
          status: record.status,
          suppressedBatches: aggregate.suppressedBatches,
          suppressedLines: aggregate.suppressedLines,
        }, aggregate)
        : this.buildUpdateNotification(record, aggregate);
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
    if (lane.pending.readyAtMs !== undefined) {
      if (lane.pending.readyAtMs > this.nowMs()) {
        this.scheduleRateSummary();
        return;
      }
      lane.pending.readyAtMs = undefined;
    }
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
    record.matchKeywords.clear();
    this.clearPendingMatches(record);
  }

  private cancelMatchTimer(record: MonitorRecord): void {
    if (record.matchTimer !== undefined) {
      try { this.clearTimeoutFn(record.matchTimer); } catch { /* cleanup continues */ }
    }
    record.matchTimer = undefined;
  }

  /** Raw non-empty chunks are the only silence anchor, so partial UTF-8, unterminated text, and pure ANSI all count. */
  private noteOutputActivity(record: MonitorRecord): void {
    const now = this.nowMs();
    record.lastActivityMs = now;
    record.lastOutputAt = new Date(now).toISOString();
    this.cancelSilenceReminder(record);
  }

  /** Recovered output removes the silence component from any mutable aggregate; an in-flight copy remains ACK-owned. */
  private cancelSilenceReminder(record: MonitorRecord): void {
    const lane = this.notificationLanes.get(record.id);
    const pending = lane?.pending;
    if (!lane || !pending || pending.silenceForMs === undefined) return;
    pending.silenceForMs = undefined;
    if (pending.kind === "silence") lane.pending = undefined;
    this.pruneNotificationLane(record.id, lane);
  }

  private cancelSilenceTimer(record: MonitorRecord): void {
    record.silenceToken += 1;
    if (record.silenceTimer !== undefined) {
      try { this.clearTimeoutFn(record.silenceTimer); } catch { /* cleanup continues */ }
    }
    record.silenceTimer = undefined;
  }

  private cancelSilence(record: MonitorRecord): void {
    this.cancelSilenceTimer(record);
    this.cancelSilenceReminder(record);
  }

  private prepareSilenceCheck(record: MonitorRecord, delayMs: number): PreparedSilenceCheck {
    const generation = this.generation;
    const token = record.silenceToken + 1;
    const delay = Math.min(Math.max(0, delayMs), record.checkAfterMs);
    let active = false;
    let fired = false;
    let firedBeforeActivation = false;
    const onTimeout = () => {
      if (fired) return;
      fired = true;
      if (!active) {
        firedBeforeActivation = true;
        return;
      }
      this.acceptSilenceTimeout(record, token, generation);
    };
    const timer = this.setTimeoutFn(onTimeout, delay);
    (timer as { unref?: () => void }).unref?.();
    return {
      timer,
      token,
      activate: () => {
        active = true;
        if (firedBeforeActivation) this.acceptSilenceTimeout(record, token, generation);
      },
    };
  }

  private applySilenceCheck(record: MonitorRecord, scheduled: PreparedSilenceCheck): void {
    record.silenceTimer = scheduled.timer;
    record.silenceToken = scheduled.token;
    scheduled.activate();
  }

  private acceptSilenceTimeout(record: MonitorRecord, token: number, generation: number): void {
    const current = this.records.get(record.id);
    if (!current || current !== record || current.silenceToken !== token || generation !== this.generation) return;
    current.silenceTimer = undefined;
    this.defer(() => this.onSilenceTimeout(record, token, generation));
  }

  /** One lazy deadline check per monitor: the timer recomputes elapsed silence instead of restarting on every chunk. */
  private onSilenceTimeout(record: MonitorRecord, token: number, generation: number): void {
    if (!this.silenceTimeoutStillOwns(record, token, generation)) return;
    const elapsed = this.nowMs() - record.lastActivityMs;
    if (elapsed < record.checkAfterMs) {
      this.applySilenceCheck(record, this.prepareSilenceCheck(record, record.checkAfterMs - elapsed));
      return;
    }
    this.notifySilence(record, elapsed);
    if (!this.silenceTimeoutStillOwns(record, token, generation)) return;
    this.applySilenceCheck(record, this.prepareSilenceCheck(record, record.checkAfterMs));
  }

  private silenceTimeoutStillOwns(record: MonitorRecord, token: number, generation: number): boolean {
    const current = this.records.get(record.id);
    if (!current || current !== record || current.silenceToken !== token || generation !== this.generation) return false;
    if (record.status !== "running" || record.terminating || this.shuttingDown) return false;
    return true;
  }

  private trySignal(record: MonitorRecord, signal: NodeJS.Signals, context: string): boolean {
    try {
      this.killGroupFn(record.pid, signal);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
      this.appendRecordError(record, `${context}: ${errorText(error)}`);
      return false;
    }
  }

  private safeGroupAlive(record: MonitorRecord, context: string): boolean {
    try {
      this.killGroupFn(record.pid, 0);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
      this.appendRecordError(record, `${context}: ${errorText(error)}`);
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
      this.appendRecordError(record, `${context}: ${errorText(error)}`);
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
      for (const record of records) this.appendRecordError(record, `${context}: ${errorText(error)}`);
    }
  }

  private appendRecordError(record: MonitorRecord, message: string): void {
    const combinedError = record.error ? `${record.error}; ${message}` : message;
    const combinedProcessError = record.processError ? `${record.processError}; ${message}` : message;
    record.error = boundedText(combinedError, 16 * 1024, " … [additional errors truncated]").text;
    record.processError = boundedText(combinedProcessError, 16 * 1024, " … [additional errors truncated]").text;
  }

  private quiesceRecord(record: MonitorRecord): void {
    this.cancelSilence(record);
    this.cancelMatchTimer(record);
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
      throw new Error(`Monitor ${record.id} changed while stop was waiting for terminal state.`);
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
