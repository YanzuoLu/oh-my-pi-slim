export type SubagentStatus =
  | "queued"
  | "running"
  | "completed"
  | "steered"
  | "aborted"
  | "stopped"
  | "error";

export interface SubagentSession {
  messages: Array<Record<string, any>>;
  prompt(message: string, options?: { expandPromptTemplates?: boolean }): Promise<void>;
  abort(): void;
  subscribe(listener: (event: Record<string, any>) => void): () => void;
  isStreaming?: boolean;
}

export interface SubagentRecord {
  id: string;
  type: string;
  description: string;
  isBackground?: boolean;
  status: SubagentStatus;
  result?: string;
  error?: string;
  toolUses: number;
  startedAt: number;
  completedAt?: number;
  session?: SubagentSession;
  abortController?: AbortController;
  promise?: Promise<string>;
  lifetimeUsage?: { input: number; output: number; cacheWrite: number };
  compactionCount?: number;
  resultConsumed?: boolean;
}

export interface SubagentRegistry {
  getRecord(id: string): unknown;
}

export interface ResumeOutcome {
  agentId: string;
  previousResult: string;
  previousStatus: "completed" | "steered";
  newResult: string;
  status: SubagentStatus;
  failure?: string;
}

export interface ResumeLifecycle {
  emit(name: "subagents:started" | "subagents:completed" | "subagents:failed", data: Record<string, unknown>): void;
  append(data: Record<string, unknown>): void;
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part && typeof part === "object" && (part as { type?: unknown }).type === "text")
    .map((part) => String((part as { text?: unknown }).text ?? ""))
    .join("");
}

function recordResult(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  return typeof (value as { result?: unknown }).result === "string"
    ? (value as { result: string }).result
    : "";
}

function isTerminalStatus(value: unknown): value is "completed" | "steered" {
  return value === "completed" || value === "steered";
}

function isCompatibleRecord(value: unknown, agentId: string): value is SubagentRecord & { session: SubagentSession } {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<SubagentRecord>;
  const session = record.session as Partial<SubagentSession> | undefined;
  return record.id === agentId &&
    typeof record.type === "string" &&
    typeof record.description === "string" &&
    isTerminalStatus(record.status) &&
    typeof record.toolUses === "number" &&
    typeof record.startedAt === "number" &&
    !!session &&
    Array.isArray(session.messages) &&
    typeof session.prompt === "function" &&
    typeof session.abort === "function" &&
    typeof session.subscribe === "function";
}

function unavailableOutcome(
  agentId: string,
  rejectedStatus: "completed" | "steered",
  record: unknown,
  failure: string,
): ResumeOutcome {
  if (record && typeof record === "object") {
    (record as { resultConsumed?: boolean }).resultConsumed = true;
  }
  return {
    agentId,
    previousResult: recordResult(record),
    previousStatus: rejectedStatus,
    newResult: "",
    status: "error",
    failure,
  };
}

function safeEmit(lifecycle: ResumeLifecycle, name: Parameters<ResumeLifecycle["emit"]>[0], data: Record<string, unknown>): void {
  try {
    lifecycle.emit(name, data);
  } catch {
    // Lifecycle observers must not strand the shared record in a running state.
  }
}

function lifecycleData(record: SubagentRecord): Record<string, unknown> {
  const durationMs = record.completedAt
    ? record.completedAt - record.startedAt
    : Date.now() - record.startedAt;
  const usage = record.lifetimeUsage;
  const total = usage ? usage.input + usage.output + usage.cacheWrite : 0;
  return {
    id: record.id,
    type: record.type,
    description: record.description,
    result: record.result,
    error: record.error,
    status: record.status,
    toolUses: record.toolUses,
    durationMs,
    tokens: total > 0 && usage
      ? { input: usage.input, output: usage.output, total }
      : undefined,
  };
}

function persistRecord(lifecycle: ResumeLifecycle, record: SubagentRecord): void {
  try {
    lifecycle.append({
      id: record.id,
      type: record.type,
      description: record.description,
      status: record.status,
      result: record.result,
      error: record.error,
      startedAt: record.startedAt,
      completedAt: record.completedAt,
    });
  } catch {
    // Persistence failures are isolated from the resumed turn's settled state.
  }
}

export function cancelledResumeOutcome(
  registry: SubagentRegistry | undefined,
  agentId: string,
  rejectedStatus: "completed" | "steered",
): ResumeOutcome {
  let record: unknown;
  try {
    record = registry?.getRecord(agentId);
  } catch {
    record = undefined;
  }
  if (record && typeof record === "object") {
    (record as { resultConsumed?: boolean }).resultConsumed = true;
  }
  return {
    agentId,
    previousResult: recordResult(record),
    previousStatus: rejectedStatus,
    newResult: "",
    status: "aborted",
    failure: "Automatic resume was cancelled before the resumed turn started.",
  };
}

export async function resumeCompletedRecord(
  registry: SubagentRegistry | undefined,
  agentId: string,
  message: string,
  rejectedStatus: "completed" | "steered",
  lifecycle: ResumeLifecycle,
  signal?: AbortSignal,
): Promise<ResumeOutcome> {
  if (!registry || typeof registry.getRecord !== "function") {
    return unavailableOutcome(
      agentId,
      rejectedStatus,
      undefined,
      "The pi-subagents manager registry is unavailable or has an incompatible shape; no new agent was spawned.",
    );
  }

  let rawRecord: unknown;
  try {
    rawRecord = registry.getRecord(agentId);
  } catch (error) {
    return unavailableOutcome(
      agentId,
      rejectedStatus,
      undefined,
      `The pi-subagents manager registry failed to read the live record: ${error instanceof Error ? error.message : String(error)}. No new agent was spawned.`,
    );
  }

  if (!isCompatibleRecord(rawRecord, agentId)) {
    return unavailableOutcome(
      agentId,
      rejectedStatus,
      rawRecord,
      `Agent "${agentId}" no longer has a compatible terminal live session (it may have been cleaned up or replaced); no new agent was spawned.`,
    );
  }

  const record = rawRecord;
  const previousResult = record.result ?? "";
  const previousStatus = record.status;
  const session = record.session;
  record.resultConsumed = true;
  const currentSession = record.session;
  if (currentSession !== session) {
    return {
      agentId,
      previousResult,
      previousStatus,
      newResult: "",
      status: "error",
      failure: `Agent "${agentId}" changed sessions before auto-resume could start; no new agent was spawned.`,
    };
  }

  if (signal?.aborted) {
    return {
      agentId,
      previousResult,
      previousStatus,
      newResult: "",
      status: "aborted",
      failure: "Automatic resume was cancelled before the resumed turn started.",
    };
  }
  if (session.isStreaming === true) {
    return {
      agentId,
      previousResult,
      previousStatus,
      newResult: "",
      status: "error",
      failure: `Agent "${agentId}" is not idle, so its terminal session was not resumed.`,
    };
  }

  const controller = new AbortController();
  record.abortController = controller;

  let streamedText = "";
  let lastAssistant: Record<string, any> | undefined;
  let promptFailure: string | undefined;
  let unsubscribe: (() => void) | undefined;
  const abortSession = () => {
    try {
      session.abort();
    } catch {
      // The controller state remains authoritative even if session.abort throws.
    }
  };
  const forwardCallerAbort = () => controller.abort();
  controller.signal.addEventListener("abort", abortSession, { once: true });
  signal?.addEventListener("abort", forwardCallerAbort, { once: true });
  if (signal?.aborted) controller.abort();
  if (controller.signal.aborted) {
    signal?.removeEventListener("abort", forwardCallerAbort);
    controller.signal.removeEventListener("abort", abortSession);
    return {
      agentId,
      previousResult,
      previousStatus,
      newResult: "",
      status: "aborted",
      failure: "Automatic resume was cancelled before the resumed turn started.",
    };
  }

  let resolvePending!: (result: string) => void;
  const pending = new Promise<string>((resolve) => { resolvePending = resolve; });
  record.promise = pending;
  record.status = "running";
  record.startedAt = Date.now();
  record.completedAt = undefined;
  record.result = undefined;
  record.error = undefined;
  record.resultConsumed = true;

  safeEmit(lifecycle, "subagents:started", {
    id: record.id,
    type: record.type,
    description: record.description,
  });

  try {
    unsubscribe = session.subscribe((event) => {
      if (event.type === "message_start" && event.message?.role === "assistant") streamedText = "";
      if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
        streamedText += String(event.assistantMessageEvent.delta ?? "");
      }
      if (event.type === "tool_execution_end") record.toolUses++;
      if (event.type === "message_end" && event.message?.role === "assistant") {
        lastAssistant = event.message;
        if (record.lifetimeUsage) {
          const usage = event.message.usage;
          if (usage) {
            record.lifetimeUsage.input += Number(usage.input ?? 0);
            record.lifetimeUsage.output += Number(usage.output ?? 0);
            record.lifetimeUsage.cacheWrite += Number(usage.cacheWrite ?? 0);
          }
        }
      }
      if (event.type === "compaction_end" && !event.aborted && event.result) {
        record.compactionCount = (record.compactionCount ?? 0) + 1;
      }
    });
    await session.prompt(message, { expandPromptTemplates: false });
  } catch (error) {
    promptFailure = error instanceof Error ? error.message : String(error);
  } finally {
    try {
      unsubscribe?.();
    } catch {
      // Subscription cleanup cannot change the run outcome.
    }
    signal?.removeEventListener("abort", forwardCallerAbort);
    controller.signal.removeEventListener("abort", abortSession);
  }

  let assistant: Record<string, any> | undefined;
  let assistantText = "";
  let newResult = "";
  let status: SubagentStatus;
  let failure: string | undefined;
  try {
    assistant = lastAssistant;
    assistantText = assistant ? messageText(assistant.content).trim() : "";
    newResult = assistant ? (streamedText.trim() || assistantText) : "";

    if (record.status === "stopped") {
      status = "stopped";
      failure = "The resumed turn was stopped before completion.";
    } else if (controller.signal.aborted || signal?.aborted || assistant?.stopReason === "aborted") {
      status = "aborted";
      failure = "The resumed turn was aborted before completion.";
    } else if (promptFailure) {
      status = "error";
      failure = promptFailure;
    } else if (!assistant) {
      status = "error";
      failure = "The resumed prompt produced no new assistant message.";
    } else if (assistant.stopReason === "error") {
      status = "error";
      failure = typeof assistant.errorMessage === "string" && assistant.errorMessage.trim()
        ? assistant.errorMessage.trim()
        : "provider error with no output";
    } else if (assistant.stopReason === "length" && !newResult) {
      status = "error";
      failure = "run hit the output token limit before producing any text";
    } else {
      status = "completed";
    }
  } catch (error) {
    status = record.status === "stopped" ? "stopped" : "error";
    failure = record.status === "stopped"
      ? "The resumed turn was stopped before completion."
      : `Failed to inspect the resumed assistant response: ${error instanceof Error ? error.message : String(error)}`;
  }

  if (record.status !== "stopped") record.status = status;
  record.result = newResult;
  record.error = failure;
  record.completedAt = Date.now();
  record.resultConsumed = true;

  resolvePending(newResult);
  try {
    const eventData = lifecycleData(record);
    safeEmit(lifecycle, record.status === "completed" ? "subagents:completed" : "subagents:failed", eventData);
  } catch {
    // A malformed optional usage payload must not undo the terminal record state.
  }
  persistRecord(lifecycle, record);

  return {
    agentId,
    previousResult,
    previousStatus,
    newResult,
    status: record.status,
    failure,
  };
}
