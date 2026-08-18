export const SPECIALIST_NAMES = ["explorer", "librarian", "oracle", "designer", "fixer", "observer"] as const;

export const RUN_STATUSES = [
  "starting",
  "running",
  "waiting",
  "completed",
  "failed",
  "interrupted",
] as const;

export const TERMINAL_RUN_STATUSES = new Set<RunStatus>([
  "completed",
  "failed",
  "interrupted",
]);

export const SUBAGENT_ACTIONS = [
  "create",
  "list",
  "interrupt",
  "steer",
  "resume",
  "reply",
  "clear",
] as const;

export const SUBAGENT_PUBLIC_FIELDS = [
  "agent",
  "abstract",
  "task",
  "cwd",
  "action",
  "id",
  "message",
] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];
export type SpecialistName = (typeof SPECIALIST_NAMES)[number];

export interface SupervisorRequest {
  runId: string;
  reason: "need_decision" | "interview_request" | "progress_update";
  message: string;
  interview?: Record<string, unknown>;
  createdAt: string;
}

export interface PersistedRun {
  id: string;
  agent: SpecialistName;
  abstract: string;
  task: string;
  cwd: string;
  model: string;
  deniedTools: string[];
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  sourceRunId?: string;
  sessionFile?: string;
  output?: string;
  error?: string;
  request?: SupervisorRequest;
  waitingSeq?: number;
  notificationPending?: RunStatus;
}

export interface LegacyRuntimeSnapshot {
  version: 1;
  runs: PersistedRun[];
}

export interface RunJournalUpsert {
  version: 2;
  run: PersistedRun;
}

/** Versioned full-registry replacement written by `subagent clear`; the latest one wins during replay. */
export interface RunJournalReplacement {
  version: 3;
  runs: PersistedRun[];
}

export interface RestoredRunJournal {
  runs: PersistedRun[];
  activeRunIds: string[];
  clearedRunIds: string[];
}

export interface RunSummary extends PersistedRun {
  live: boolean;
}

export interface SubagentLaunchInput {
  agent?: unknown;
  abstract?: unknown;
  task?: unknown;
  cwd?: unknown;
  action?: unknown;
  id?: unknown;
  message?: unknown;
}

export function isTerminalStatus(status: RunStatus): boolean {
  return TERMINAL_RUN_STATUSES.has(status);
}

type RetainedRunSortFields = Pick<PersistedRun, "id" | "status" | "createdAt" | "updatedAt">;

function retainedRunPriority(status: RunStatus): number {
  if (status === "running" || status === "waiting") return 0;
  if (status === "starting") return 1;
  return 2;
}

export function compareRetainedSubagentRuns(left: RetainedRunSortFields, right: RetainedRunSortFields): number {
  const priority = retainedRunPriority(left.status) - retainedRunPriority(right.status);
  if (priority !== 0) return priority;
  if (isTerminalStatus(left.status) && isTerminalStatus(right.status)) {
    const updated = right.updatedAt.localeCompare(left.updatedAt);
    if (updated !== 0) return updated;
    const created = right.createdAt.localeCompare(left.createdAt);
    if (created !== 0) return created;
    return left.id.localeCompare(right.id);
  }
  const created = left.createdAt.localeCompare(right.createdAt);
  return created !== 0 ? created : left.id.localeCompare(right.id);
}

export function sortRetainedSubagentRuns<T extends RetainedRunSortFields>(runs: readonly T[]): T[] {
  return [...runs].sort(compareRetainedSubagentRuns);
}

export function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must be a non-empty string.`);
  }
  return value.trim();
}

export function validateCreateInput(input: SubagentLaunchInput): {
  agent: SpecialistName;
  abstract: string;
  task: string;
  cwd?: string;
} {
  const agent = requireString(input.agent, "agent");
  if (!SPECIALIST_NAMES.includes(agent as SpecialistName)) {
    throw new Error(`Unknown agent "${agent}". Use explorer, librarian, oracle, designer, fixer, or observer.`);
  }
  return {
    agent: agent as SpecialistName,
    abstract: requireString(input.abstract, "abstract"),
    task: requireString(input.task, "task"),
    cwd: input.cwd === undefined ? undefined : requireString(input.cwd, "cwd"),
  };
}

export function legacyRunAbstract(task: string): string {
  return `${Array.from(task).slice(0, 100).join("")}...`;
}

function isSafePathSegment(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}

function optionalString(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  return typeof value === "string" ? value : null;
}

function parseRequest(value: unknown): SupervisorRequest | undefined | null {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const request = value as Record<string, unknown>;
  if (
    typeof request.runId !== "string" ||
    !["need_decision", "interview_request", "progress_update"].includes(String(request.reason)) ||
    typeof request.message !== "string" ||
    typeof request.createdAt !== "string" ||
    (request.interview !== undefined && (!request.interview || typeof request.interview !== "object" || Array.isArray(request.interview)))
  ) return null;
  return {
    runId: request.runId,
    reason: request.reason as SupervisorRequest["reason"],
    message: request.message,
    interview: request.interview === undefined ? undefined : { ...(request.interview as Record<string, unknown>) },
    createdAt: request.createdAt,
  };
}

export function parsePersistedRun(value: unknown): PersistedRun | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const run = value as Record<string, unknown>;
  const sourceRunId = optionalString(run.sourceRunId);
  const abstract = run.abstract === undefined
    ? typeof run.task === "string" ? legacyRunAbstract(run.task) : null
    : typeof run.abstract === "string" && run.abstract.trim() ? run.abstract.trim() : null;
  const sessionFile = optionalString(run.sessionFile);
  const output = optionalString(run.output);
  const error = optionalString(run.error);
  const request = parseRequest(run.request);
  const notificationPending = optionalString(run.notificationPending);
  const waitingSeq = run.waitingSeq === undefined
    ? undefined
    : Number.isInteger(run.waitingSeq) && Number(run.waitingSeq) >= 1 ? Number(run.waitingSeq) : null;
  const deniedTools = run.deniedTools === undefined
    ? []
    : Array.isArray(run.deniedTools) && run.deniedTools.every((tool) => typeof tool === "string")
      ? [...run.deniedTools] as string[]
      : null;
  if (
    typeof run.id !== "string" ||
    !isSafePathSegment(run.id) ||
    typeof run.agent !== "string" ||
    !SPECIALIST_NAMES.includes(run.agent as SpecialistName) ||
    abstract === null ||
    typeof run.task !== "string" ||
    typeof run.cwd !== "string" ||
    typeof run.model !== "string" ||
    deniedTools === null ||
    !RUN_STATUSES.includes(run.status as RunStatus) ||
    typeof run.createdAt !== "string" ||
    typeof run.updatedAt !== "string" ||
    sourceRunId === null ||
    sessionFile === null ||
    output === null ||
    error === null ||
    request === null ||
    waitingSeq === null ||
    notificationPending === null ||
    (notificationPending !== undefined &&
      notificationPending !== "waiting" && !isTerminalStatus(notificationPending as RunStatus))
  ) return;

  return {
    id: run.id,
    agent: run.agent as SpecialistName,
    abstract,
    task: run.task,
    cwd: run.cwd,
    model: run.model,
    deniedTools,
    status: run.status as RunStatus,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    sourceRunId,
    sessionFile,
    output,
    error,
    request,
    waitingSeq,
    notificationPending: notificationPending as RunStatus | undefined,
  };
}

function cloneRun(run: PersistedRun): PersistedRun {
  return {
    ...run,
    deniedTools: [...run.deniedTools],
    request: run.request
      ? { ...run.request, interview: run.request.interview ? { ...run.request.interview } : undefined }
      : undefined,
  };
}

export function runJournalEntry(run: PersistedRun): RunJournalUpsert {
  return { version: 2, run: cloneRun(run) };
}

export function runJournalReplacementEntry(runs: Iterable<PersistedRun>): RunJournalReplacement {
  return { version: 3, runs: [...runs].map(cloneRun) };
}

export function runJournalClearEntry(): RunJournalReplacement {
  return runJournalReplacementEntry([]);
}

export function restoreRunJournal(values: Iterable<unknown>, _now = new Date().toISOString()): RestoredRunJournal {
  let runs = new Map<string, PersistedRun>();
  const everSeen = new Set<string>();
  for (const value of values) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const entry = value as Record<string, unknown>;
    if ((entry.version === 1 || entry.version === 3) && Array.isArray(entry.runs)) {
      const replacement = new Map<string, PersistedRun>();
      for (const candidate of entry.runs) {
        const run = parsePersistedRun(candidate);
        if (run) {
          replacement.set(run.id, run);
          everSeen.add(run.id);
        }
      }
      runs = replacement;
    } else if (entry.version === 2) {
      const run = parsePersistedRun(entry.run);
      if (run) {
        runs.set(run.id, run);
        everSeen.add(run.id);
      }
    }
  }

  const restored = sortRetainedSubagentRuns([...runs.values()].map(cloneRun));
  const activeRunIds = restored
    .filter((run) => run.status === "starting" || run.status === "running" || run.status === "waiting")
    .map((run) => run.id);
  const clearedRunIds = [...everSeen].filter((id) => !runs.has(id)).sort();
  return { runs: restored, activeRunIds, clearedRunIds };
}

export function restoreSnapshot(value: unknown, now = new Date().toISOString()): LegacyRuntimeSnapshot {
  return { version: 1, runs: restoreRunJournal([value], now).runs };
}

export function extractFinalAssistantText(messages: unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as Record<string, unknown> | undefined;
    if (!message || message.role !== "assistant" || !Array.isArray(message.content)) continue;
    const text = message.content
      .filter((part): part is { type: "text"; text: string } =>
        Boolean(part) && typeof part === "object" && (part as Record<string, unknown>).type === "text" &&
        typeof (part as Record<string, unknown>).text === "string")
      .map((part) => part.text)
      .join("\n")
      .trim();
    if (text) return text;
  }
  return "";
}

export class SubagentRegistry {
  private runs = new Map<string, PersistedRun>();
  private liveIds = new Set<string>();
  private listeners = new Set<() => void>();

  restore(runs: Iterable<PersistedRun>): void {
    this.runs = new Map([...runs].map((run) => [run.id, cloneRun(run)]));
    this.liveIds.clear();
    this.emit();
  }

  clear(): void {
    this.runs = new Map();
    this.liveIds.clear();
    this.emit();
  }

  add(run: PersistedRun, live = false): void {
    if (this.runs.has(run.id)) throw new Error(`Run ${run.id} already exists.`);
    this.runs.set(run.id, cloneRun(run));
    if (live) this.liveIds.add(run.id);
    this.emit();
  }

  get(id: string): PersistedRun | undefined {
    const run = this.runs.get(id);
    return run ? cloneRun(run) : undefined;
  }

  require(id: string): PersistedRun {
    const run = this.runs.get(id);
    if (!run) throw new Error(`Unknown subagent run: ${id}`);
    return cloneRun(run);
  }

  update(id: string, patch: Partial<PersistedRun>): PersistedRun {
    const current = this.require(id);
    const next = cloneRun({
      ...current,
      ...patch,
      deniedTools: patch.deniedTools ? [...patch.deniedTools] : current.deniedTools,
    });
    this.runs.set(id, next);
    if (isTerminalStatus(next.status)) this.liveIds.delete(id);
    this.emit();
    return cloneRun(next);
  }

  markLive(id: string, live: boolean): void {
    this.require(id);
    const wasLive = this.liveIds.has(id);
    if (live) this.liveIds.add(id);
    else this.liveIds.delete(id);
    if (wasLive !== live) this.emit();
  }

  isLive(id: string): boolean {
    return this.liveIds.has(id);
  }

  list(): RunSummary[] {
    return sortRetainedSubagentRuns([...this.runs.values()])
      .map((run) => ({ ...cloneRun(run), live: this.liveIds.has(run.id) }));
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener();
  }
}
