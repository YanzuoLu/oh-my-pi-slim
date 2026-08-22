import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { legacyRunAbstract } from "./subagent-core.js";

export const RUN_FILE_VERSION = 1 as const;
export const RUN_STATUSES = [
  "starting",
  "running",
  "waiting",
  "completed",
  "failed",
  "interrupted",
] as const;
export const CONTROL_TYPES = ["interrupt", "steer", "reply"] as const;
export const GOAL_STATS_DIR_NAME = "omps-goal-stats";
export const GOAL_STATS_VERSION = 1 as const;

let controlSequence = 0;

export type DetachedRunStatus = (typeof RUN_STATUSES)[number];
export type ControlType = (typeof CONTROL_TYPES)[number];

export interface PiInvocation {
  command: string;
  args: string[];
}

export interface DetachedLaunchConfig {
  v: 1;
  runId: string;
  token: string;
  ownerSessionId: string;
  agent: string;
  abstract: string;
  task: string;
  cwd: string;
  model: string;
  deniedTools: string[];
  systemPrompt: string;
  approve: boolean;
  childSessionDir: string;
  resumeSessionFile?: string;
  /**
   * Internal resume-only preflight marker: the source run's model spec when a resume crosses model bases.
   * The runner compacts the reused child session once before its first prompt; nothing outside the runner reads it.
   */
  resumeCompactFrom?: string;
  piInvocation: PiInvocation;
  env: Record<string, string>;
  createdAt: string;
}

export interface DetachedRunActivity {
  turnCount: number;
  toolUses: number;
  activeTools: Record<string, { name: string; startedAt?: string }>;
  responseText: string;
  tokens: number;
  contextPercent?: number;
  compactionCount: number;
}

export interface DetachedRunnerIdentity {
  v: 1;
  token: string;
  runId: string;
  pid: number;
  processIdentity: string;
}

export interface DetachedRunState extends DetachedRunActivity {
  /** Cumulative provider usage for Goal accounting; tokens remains context occupancy for the existing widget contract. */
  providerTokens?: number;
  v: 1;
  token: string;
  runId: string;
  pid: number;
  heartbeatAt: string;
  status: DetachedRunStatus;
  sessionFile?: string;
  request?: Record<string, unknown>;
  waitingSeq?: number;
  output?: string;
  error?: string;
  updatedAt: string;
}

export interface DetachedControlMessage {
  v: 1;
  token: string;
  type: ControlType;
  message?: string;
  waitingSeq?: number;
}

export interface RunPaths {
  runRoot: string;
  ownerDir: string;
  runDir: string;
  configFile: string;
  stateFile: string;
  identityFile: string;
  controlDir: string;
  logFile: string;
}

export interface GoalRunStatsSidecar {
  version: 1;
  runId: string;
  tokens: number;
  tools: number;
  turns: number;
  compactions: number;
}

export interface GoalStatsSidecarPaths {
  root: string;
  ownerDir: string;
  file: string;
}

/** Result of a guarded delete: `removed` also covers an already-absent target, which never warrants a warning. */
export interface SafeRemoval {
  removed: boolean;
  reason?: string;
}

export interface InvocationSeams {
  argv?: readonly string[];
  execPath?: string;
  exists?: (path: string) => boolean;
  probeRuntime?: (command: "node" | "bun") => boolean;
}

export interface DetachedLaunchOptions {
  cwd?: string;
  env?: Record<string, string>;
  logFile?: string;
  invocationSeams?: InvocationSeams;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isSafePathSegment(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}

function requireSafePathSegment(value: string, label: string): void {
  if (!isSafePathSegment(value)) throw new Error(`${label} is not a safe path segment.`);
}

export function getRunRoot(ownerSessionDir: string): string {
  return resolve(ownerSessionDir, "omps-subagent-runs");
}

export function getGoalStatsRoot(ownerSessionDir: string): string {
  return resolve(ownerSessionDir, GOAL_STATS_DIR_NAME);
}

export function getGoalStatsSidecarPaths(root: string, ownerSessionId: string, runId: string): GoalStatsSidecarPaths {
  requireSafePathSegment(ownerSessionId, "ownerSessionId");
  requireSafePathSegment(runId, "runId");
  const normalizedRoot = resolve(root);
  const ownerDir = resolve(normalizedRoot, ownerSessionId);
  const file = resolve(ownerDir, `${runId}.json`);
  if (dirname(ownerDir) !== normalizedRoot || dirname(file) !== ownerDir || basename(file) !== `${runId}.json`) {
    throw new Error("Goal stats sidecar path escaped its session-owned root.");
  }
  return { root: normalizedRoot, ownerDir, file };
}

export function getRunPaths(runRoot: string, ownerSessionId: string, runId: string): RunPaths {
  requireSafePathSegment(ownerSessionId, "ownerSessionId");
  requireSafePathSegment(runId, "runId");
  const normalizedRoot = resolve(runRoot);
  const ownerDir = join(normalizedRoot, ownerSessionId);
  const runDir = join(ownerDir, runId);
  return {
    runRoot: normalizedRoot,
    ownerDir,
    runDir,
    configFile: join(runDir, "launch.json"),
    stateFile: join(runDir, "state.json"),
    identityFile: join(runDir, "runner.json"),
    controlDir: join(runDir, "control"),
    logFile: join(runDir, "runner.log"),
  };
}

export function ensureRunPaths(paths: RunPaths): void {
  for (const directory of [paths.runRoot, paths.ownerDir, paths.runDir, paths.controlDir]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
  }
}

export function listOwnerRunIds(runRoot: string, ownerSessionId: string): string[] {
  requireSafePathSegment(ownerSessionId, "ownerSessionId");
  const ownerDir = getRunPaths(runRoot, ownerSessionId, "placeholder").ownerDir;
  try {
    const ownerStat = lstatSync(ownerDir);
    if (!ownerStat.isDirectory() || ownerStat.isSymbolicLink()) return [];
    return readdirSync(ownerDir)
      .filter((name) => isSafePathSegment(name))
      .filter((name) => {
        try {
          const entry = lstatSync(join(ownerDir, name));
          return entry.isDirectory() && !entry.isSymbolicLink();
        } catch { return false; }
      })
      .sort();
  } catch {
    return [];
  }
}

export function removeRunFiles(paths: RunPaths): void {
  const ownerDir = resolve(paths.ownerDir);
  const runDir = resolve(paths.runDir);
  const runRoot = resolve(paths.runRoot);
  if (
    !isSafePathSegment(basename(ownerDir)) || dirname(ownerDir) !== runRoot ||
    !isSafePathSegment(basename(runDir)) || dirname(runDir) !== ownerDir
  ) {
    throw new Error("Refusing to remove an unsafe detached run directory.");
  }
  if (!existsSync(runDir)) return;
  const ownerStat = lstatSync(ownerDir);
  const runStat = lstatSync(runDir);
  if (ownerStat.isSymbolicLink() || runStat.isSymbolicLink() || !runStat.isDirectory()) {
    throw new Error("Refusing to remove a linked or non-directory detached run path.");
  }
  rmSync(runDir, { recursive: true, force: true });
}

function removalError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Removes one child session file only when it truly resides inside this parent session's child session root.
 * Resolves the real parent directory first so symlinked parents and `..` segments cannot escape containment.
 */
export function removeChildSessionFile(childSessionDir: string, sessionFile: string): SafeRemoval {
  if (!isNonBlankString(childSessionDir) || !isNonBlankString(sessionFile)) {
    return { removed: false, reason: "Child session path is empty." };
  }
  let root: string;
  try { root = realpathSync(resolve(childSessionDir)); }
  catch { return { removed: true }; }
  const requested = resolve(sessionFile);
  let target: string;
  try { target = resolve(realpathSync(dirname(requested)), basename(requested)); }
  catch { return { removed: true }; }
  const inside = relative(root, target);
  if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) {
    return { removed: false, reason: `Session file ${sessionFile} is outside this session's child session directory.` };
  }
  let stat;
  try { stat = lstatSync(target); }
  catch { return { removed: true }; }
  if (stat.isSymbolicLink()) return { removed: false, reason: `Session file ${sessionFile} is a symbolic link.` };
  if (!stat.isFile()) return { removed: false, reason: `Session file ${sessionFile} is not a regular file.` };
  try {
    unlinkSync(target);
    return { removed: true };
  } catch (error) {
    return { removed: false, reason: removalError(error) };
  }
}

function isGoalRunStatsSidecar(value: unknown): value is GoalRunStatsSidecar {
  if (!isRecord(value) || Object.keys(value).sort().join(",") !== "compactions,runId,tokens,tools,turns,version") return false;
  if (value.version !== GOAL_STATS_VERSION || !isNonEmptyString(value.runId) || !isSafePathSegment(value.runId)) return false;
  return [value.tokens, value.tools, value.turns, value.compactions]
    .every((item) => typeof item === "number" && Number.isSafeInteger(item) && item >= 0);
}

function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Refusing unsafe private directory: ${path}`);
  chmodSync(path, 0o700);
}

export function writeGoalStatsSidecar(
  root: string,
  ownerSessionId: string,
  stats: GoalRunStatsSidecar,
): boolean {
  try {
    if (!isGoalRunStatsSidecar(stats)) return false;
    const paths = getGoalStatsSidecarPaths(root, ownerSessionId, stats.runId);
    ensurePrivateDirectory(paths.root);
    ensurePrivateDirectory(paths.ownerDir);
    if (existsSync(paths.file)) {
      const current = lstatSync(paths.file);
      if (current.isSymbolicLink() || !current.isFile()) return false;
    }
    atomicWriteJson(paths.file, stats);
    const written = lstatSync(paths.file);
    if (written.isSymbolicLink() || !written.isFile()) return false;
    chmodSync(paths.file, 0o600);
    return true;
  } catch {
    return false;
  }
}

export function readGoalStatsSidecar(root: string, ownerSessionId: string, runId: string): GoalRunStatsSidecar | undefined {
  try {
    const paths = getGoalStatsSidecarPaths(root, ownerSessionId, runId);
    for (const directory of [paths.root, paths.ownerDir]) {
      const stat = lstatSync(directory);
      if (stat.isSymbolicLink() || !stat.isDirectory()) return;
    }
    const stat = lstatSync(paths.file);
    if (stat.isSymbolicLink() || !stat.isFile()) return;
    const value = safeReadJson(paths.file, isGoalRunStatsSidecar);
    return value?.runId === runId ? value : undefined;
  } catch {
    return;
  }
}

export function atomicWriteJson(filePath: string, value: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(filePath), `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  let descriptor = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    closeSync(descriptor);
    descriptor = -1;
    renameSync(temporary, filePath);
    chmodSync(filePath, 0o600);
  } catch (error) {
    if (descriptor >= 0) {
      try { closeSync(descriptor); } catch { /* cleanup continues */ }
    }
    try { unlinkSync(temporary); } catch { /* already renamed or removed */ }
    throw error;
  }
}

export function safeReadJson<T>(filePath: string, validate: (value: unknown) => value is T): T | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(filePath, "utf8"));
    return validate(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export function tailLog(filePath: string, maxBytes = 16 * 1024): string {
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) throw new Error("maxBytes must be a positive integer.");
  try {
    const text = readFileSync(filePath);
    return text.subarray(Math.max(0, text.length - maxBytes)).toString("utf8").replace(/^\uFFFD/, "");
  } catch {
    return "";
  }
}

export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function getProcessIdentity(pid: number): string | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    const result = process.platform === "win32"
      ? spawnSync("powershell.exe", [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"; if ($p) { "$($p.CreationDate)\`n$($p.CommandLine)" }`,
        ], { encoding: "utf8", windowsHide: true, timeout: 2000 })
      : spawnSync("ps", ["-ww", "-o", "lstart=", "-o", "command=", "-p", String(pid)], {
          encoding: "utf8",
          timeout: 2000,
        });
    if (result.status !== 0) return;
    const identity = result.stdout.trim();
    return identity || undefined;
  } catch {
    return;
  }
}

function normalizeDetachedLaunchConfig(value: unknown): DetachedLaunchConfig | undefined {
  if (!isRecord(value) || value.v !== RUN_FILE_VERSION) return;
  if (
    !isNonEmptyString(value.runId) ||
    !isNonEmptyString(value.token) ||
    !isNonEmptyString(value.ownerSessionId) ||
    !isNonEmptyString(value.agent) ||
    !isNonEmptyString(value.task) ||
    !isNonEmptyString(value.cwd) ||
    !isNonEmptyString(value.model) ||
    !Array.isArray(value.deniedTools) || value.deniedTools.some((tool) => !isNonEmptyString(tool)) ||
    typeof value.systemPrompt !== "string" ||
    typeof value.approve !== "boolean" ||
    !isNonEmptyString(value.childSessionDir) ||
    (value.resumeSessionFile !== undefined && !isNonEmptyString(value.resumeSessionFile)) ||
    (value.resumeCompactFrom !== undefined && !isNonEmptyString(value.resumeCompactFrom)) ||
    !isRecord(value.piInvocation) ||
    !isNonEmptyString(value.piInvocation.command) ||
    !Array.isArray(value.piInvocation.args) || value.piInvocation.args.some((arg) => typeof arg !== "string") ||
    !isRecord(value.env) || Object.values(value.env).some((entry) => typeof entry !== "string") ||
    !isNonEmptyString(value.createdAt) ||
    !isSafePathSegment(value.runId) ||
    !isSafePathSegment(value.ownerSessionId)
  ) return;
  const abstract = value.abstract === undefined
    ? legacyRunAbstract(value.task)
    : isNonBlankString(value.abstract) ? value.abstract.trim() : undefined;
  if (!abstract) return;
  return { ...value, abstract } as unknown as DetachedLaunchConfig;
}

/**
 * Canonical predicate for newly written launch.json files.
 * Legacy files without abstract intentionally fail this type guard and are normalized only by readLaunchConfig().
 */
export function isDetachedLaunchConfig(value: unknown): value is DetachedLaunchConfig {
  return isRecord(value) && isNonBlankString(value.abstract) && normalizeDetachedLaunchConfig(value) !== undefined;
}

export function isDetachedRunnerIdentity(value: unknown): value is DetachedRunnerIdentity {
  return isRecord(value) &&
    Object.keys(value).sort().join(",") === "pid,processIdentity,runId,token,v" &&
    value.v === RUN_FILE_VERSION &&
    isNonEmptyString(value.token) && isNonEmptyString(value.runId) &&
    isSafePathSegment(value.runId) && Number.isInteger(value.pid) && Number(value.pid) > 0 &&
    isNonEmptyString(value.processIdentity);
}

export function isDetachedRunState(value: unknown): value is DetachedRunState {
  if (!isRecord(value) || value.v !== RUN_FILE_VERSION) return false;
  if (
    !isNonEmptyString(value.token) ||
    !isNonEmptyString(value.runId) ||
    !Number.isInteger(value.pid) || Number(value.pid) <= 0 ||
    !isNonEmptyString(value.heartbeatAt) ||
    !RUN_STATUSES.includes(value.status as DetachedRunStatus) ||
    (value.sessionFile !== undefined && typeof value.sessionFile !== "string") ||
    (value.request !== undefined && !isRecord(value.request)) ||
    (value.waitingSeq !== undefined && (!Number.isInteger(value.waitingSeq) || Number(value.waitingSeq) < 1)) ||
    (value.output !== undefined && typeof value.output !== "string") ||
    (value.error !== undefined && typeof value.error !== "string") ||
    !isNonEmptyString(value.updatedAt) ||
    !Number.isInteger(value.turnCount) || Number(value.turnCount) < 0 ||
    !Number.isInteger(value.toolUses) || Number(value.toolUses) < 0 ||
    !isRecord(value.activeTools) ||
    typeof value.responseText !== "string" ||
    typeof value.tokens !== "number" || !Number.isFinite(value.tokens) || Number(value.tokens) < 0 ||
    (value.providerTokens !== undefined && (typeof value.providerTokens !== "number" || !Number.isFinite(value.providerTokens) || Number(value.providerTokens) < 0)) ||
    (value.contextPercent !== undefined && (typeof value.contextPercent !== "number" || !Number.isFinite(value.contextPercent))) ||
    !Number.isInteger(value.compactionCount) || Number(value.compactionCount) < 0
  ) return false;
  return Object.values(value.activeTools).every((tool) =>
    isRecord(tool) && isNonEmptyString(tool.name) && (tool.startedAt === undefined || typeof tool.startedAt === "string"));
}

export function isDetachedControlMessage(value: unknown): value is DetachedControlMessage {
  if (!isRecord(value) || value.v !== RUN_FILE_VERSION || !isNonEmptyString(value.token)) return false;
  if (!CONTROL_TYPES.includes(value.type as ControlType)) return false;
  if ("requestId" in value) return false;
  if (value.message !== undefined && typeof value.message !== "string") return false;
  if (value.waitingSeq !== undefined && (!Number.isInteger(value.waitingSeq) || Number(value.waitingSeq) < 1)) return false;
  if ((value.type === "steer" || value.type === "reply") && !isNonEmptyString(value.message)) return false;
  return value.type !== "reply" || (Number.isInteger(value.waitingSeq) && Number(value.waitingSeq) >= 1);
}

export function readLaunchConfig(paths: RunPaths): DetachedLaunchConfig | undefined {
  try {
    return normalizeDetachedLaunchConfig(JSON.parse(readFileSync(paths.configFile, "utf8")));
  } catch {
    return;
  }
}

export function readRunState(paths: RunPaths): DetachedRunState | undefined {
  return safeReadJson(paths.stateFile, isDetachedRunState);
}

export function readRunnerIdentity(paths: RunPaths): DetachedRunnerIdentity | undefined {
  return safeReadJson(paths.identityFile, isDetachedRunnerIdentity);
}

export function writeControl(
  paths: RunPaths,
  token: string,
  type: ControlType,
  message?: string,
  waitingSeq?: number,
): string {
  const control: DetachedControlMessage = { v: RUN_FILE_VERSION, token, type, message, waitingSeq };
  if (!isDetachedControlMessage(control)) throw new Error(`Invalid ${type} control message.`);
  mkdirSync(paths.controlDir, { recursive: true, mode: 0o700 });
  chmodSync(paths.controlDir, 0o700);
  const sequence = String(++controlSequence).padStart(10, "0");
  const name = `${Date.now()}-${process.pid}-${sequence}-${randomUUID()}.json`;
  const filePath = join(paths.controlDir, name);
  atomicWriteJson(filePath, control);
  return filePath;
}

export function readControlInbox(controlDir: string): DetachedControlMessage[] {
  let files: string[];
  try {
    files = readdirSync(controlDir).sort();
  } catch {
    return [];
  }
  const messages: DetachedControlMessage[] = [];
  for (const name of files) {
    const filePath = join(controlDir, name);
    try {
      if (!statSync(filePath).isFile()) continue;
      const message = safeReadJson(filePath, isDetachedControlMessage);
      if (message) messages.push(message);
    } catch {
      // Invalid or concurrently removed inbox entries are ignored.
    } finally {
      try { unlinkSync(filePath); } catch { /* another reader may have removed it */ }
    }
  }
  return messages;
}

function isGenericRuntime(execPath: string): boolean {
  return /^(node|bun)(\.exe)?$/.test(basename(execPath).toLowerCase());
}

function defaultRuntimeProbe(command: "node" | "bun"): boolean {
  const result = spawnSync(command, ["--version"], { stdio: "ignore", timeout: 2000 });
  return result.status === 0;
}

export function getPiInvocation(args: string[], seams: InvocationSeams = {}): PiInvocation {
  const argv = seams.argv ?? process.argv;
  const execPath = seams.execPath ?? process.execPath;
  const fileExists = seams.exists ?? existsSync;
  const currentScript = argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && fileExists(currentScript)) {
    return { command: execPath, args: [currentScript, ...args] };
  }
  if (!isGenericRuntime(execPath)) return { command: execPath, args: [...args] };
  return { command: "pi", args: [...args] };
}

export function getDetachedRunnerInvocation(runnerPath: string, seams: InvocationSeams = {}): PiInvocation {
  const execPath = seams.execPath ?? process.execPath;
  if (isGenericRuntime(execPath)) return { command: execPath, args: [runnerPath] };
  const probe = seams.probeRuntime ?? defaultRuntimeProbe;
  for (const runtime of ["node", "bun"] as const) {
    if (probe(runtime)) return { command: runtime, args: [runnerPath] };
  }
  throw new Error("Detached subagent runner requires Node.js or Bun on PATH; the standalone Pi executable cannot interpret the packaged .mjs runner itself.");
}

export async function launchDetachedRunner(
  configFile: string,
  runnerPath: string,
  options: DetachedLaunchOptions = {},
): Promise<{ pid: number; invocation: PiInvocation }> {
  const invocation = getDetachedRunnerInvocation(runnerPath, options.invocationSeams);
  const logFile = options.logFile ?? join(dirname(configFile), "runner.log");
  mkdirSync(dirname(logFile), { recursive: true, mode: 0o700 });
  const logDescriptor = openSync(logFile, "a", 0o600);
  chmodSync(logFile, 0o600);
  try {
    const child = spawn(invocation.command, [...invocation.args, configFile], {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      detached: true,
      shell: false,
      stdio: ["ignore", logDescriptor, logDescriptor],
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    if (!child.pid) throw new Error("Detached runner started without a PID.");
    child.unref();
    return { pid: child.pid, invocation };
  } finally {
    closeSync(logDescriptor);
  }
}
