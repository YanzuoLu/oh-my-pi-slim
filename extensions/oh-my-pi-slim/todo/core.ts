import { TODO_TOOL_ERRORS } from "../tool-contracts.js";

const TODO_RECEIPTS = {
  appended: (subject: string) => `Appended "${subject}".`,
  deleted: (subject: string) => `Deleted "${subject}".`,
  cleared: "Cleared all items.",
  noChange: "No change.",
  noChangeFor: (subject: string) => `No change for "${subject}".`,
  renamed: (before: string, after: string) => `Renamed "${before}" to "${after}".`,
  modified: (subject: string, changes: readonly string[]) => `Modified "${subject}": ${changes.join(", ")}.`,
} as const;

export const TODO_SNAPSHOT_TYPE = "oh-my-pi-slim:todo-update";
export const TODO_SNAPSHOT_VERSION = 1 as const;

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoTask {
  subject: string;
  abstract: string;
  status: TodoStatus;
  blockedBy: string[];
}

export interface AppendOperation {
  op: "append";
  subject: string;
  abstract: string;
  blockedBy?: string[];
}

export interface ModifyOperation {
  op: "modify";
  target: string;
  newSubject?: string;
  abstract?: string;
  status?: TodoStatus;
  blockedBy?: string[];
}

export interface DeleteOperation {
  op: "delete";
  target: string;
}

export interface ClearOperation {
  op: "clear";
}

export type TodoOperation = AppendOperation | ModifyOperation | DeleteOperation | ClearOperation;

export interface TodoReceipt {
  operation: number;
  kind: "append" | "modify" | "rename" | "status" | "delete" | "no-change" | "clear";
  text: string;
}

export interface TodoSnapshotDetails {
  type: typeof TODO_SNAPSHOT_TYPE;
  version: typeof TODO_SNAPSHOT_VERSION;
  state: {
    version: typeof TODO_SNAPSHOT_VERSION;
    tasks: TodoTask[];
  };
  receipts: TodoReceipt[];
  operations: TodoOperation[];
}

const STATUSES = new Set<TodoStatus>(["pending", "in_progress", "completed"]);
const TASK_KEYS = ["abstract", "blockedBy", "status", "subject"];
const DETAILS_KEYS = ["operations", "receipts", "state", "type", "version"];
const STATE_KEYS = ["tasks", "version"];
const RECEIPT_KEYS = ["kind", "operation", "text"];
const RECEIPT_KINDS = new Set<TodoReceipt["kind"]>([
  "append", "modify", "rename", "status", "delete", "no-change", "clear",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function cleanText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(TODO_TOOL_ERRORS.nonEmptyString(field));
  }
  return value.trim();
}

function cleanSubjectList(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new Error(TODO_TOOL_ERRORS.array(field));
  const result: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const subject = cleanText(value[index], `${field}[${index}]`);
    if (!seen.has(subject)) {
      seen.add(subject);
      result.push(subject);
    }
  }
  return result;
}

function cloneTasks(tasks: readonly TodoTask[]): TodoTask[] {
  return tasks.map((task) => ({ ...task, blockedBy: [...task.blockedBy] }));
}

function cloneOperation(operation: TodoOperation): TodoOperation {
  if (operation.op === "clear") return { op: "clear" };
  if (operation.op === "delete") return { op: "delete", target: operation.target };
  if (operation.op === "append") {
    return {
      op: "append",
      subject: operation.subject,
      abstract: operation.abstract,
      ...(operation.blockedBy ? { blockedBy: [...operation.blockedBy] } : {}),
    };
  }
  return {
    op: "modify",
    target: operation.target,
    ...(operation.newSubject !== undefined ? { newSubject: operation.newSubject } : {}),
    ...(operation.abstract !== undefined ? { abstract: operation.abstract } : {}),
    ...(operation.status !== undefined ? { status: operation.status } : {}),
    ...(operation.blockedBy !== undefined ? { blockedBy: [...operation.blockedBy] } : {}),
  };
}

function validateGraph(tasks: readonly TodoTask[]): void {
  const bySubject = new Map(tasks.map((task) => [task.subject, task]));
  for (const task of tasks) {
    for (const dependency of task.blockedBy) {
      if (!bySubject.has(dependency)) {
        throw new Error(TODO_TOOL_ERRORS.missingDependency(task.subject, dependency));
      }
      if (dependency === task.subject) {
        throw new Error(TODO_TOOL_ERRORS.selfDependency(task.subject));
      }
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (subject: string): void => {
    if (visiting.has(subject)) throw new Error(TODO_TOOL_ERRORS.dependencyCycle(subject));
    if (visited.has(subject)) return;
    visiting.add(subject);
    for (const dependency of bySubject.get(subject)?.blockedBy ?? []) visit(dependency);
    visiting.delete(subject);
    visited.add(subject);
  };
  for (const task of tasks) visit(task.subject);

  for (const task of tasks) {
    if (task.status === "pending") continue;
    for (const dependency of task.blockedBy) {
      if (bySubject.get(dependency)?.status !== "completed") {
        throw new Error(TODO_TOOL_ERRORS.incompleteDependency(task.subject, dependency));
      }
    }
  }
}

export function validateTodoState(tasks: readonly TodoTask[]): void {
  const subjects = new Set<string>();
  for (const task of tasks) {
    const subject = cleanText(task.subject, "task.subject");
    const abstract = cleanText(task.abstract, `task "${subject}" abstract`);
    if (subject !== task.subject) throw new Error(TODO_TOOL_ERRORS.subjectNotCanonical(task.subject));
    if (abstract !== task.abstract) throw new Error(TODO_TOOL_ERRORS.abstractNotCanonical(subject));
    if (!STATUSES.has(task.status)) throw new Error(TODO_TOOL_ERRORS.invalidStatus(subject));
    if (subjects.has(subject)) throw new Error(TODO_TOOL_ERRORS.duplicateSubject(subject));
    subjects.add(subject);
    const dependencies = cleanSubjectList(task.blockedBy, `task "${subject}" blockedBy`);
    if (dependencies.length !== task.blockedBy.length || dependencies.some((value, index) => value !== task.blockedBy[index])) {
      throw new Error(TODO_TOOL_ERRORS.blockedByNotCanonical(subject));
    }
  }
  validateGraph(tasks);
}

function normalizeOperation(raw: TodoOperation, number: number): TodoOperation {
  if (!isRecord(raw)) throw new Error(TODO_TOOL_ERRORS.operationObject);
  if (raw.op === "clear") {
    if (!hasExactKeys(raw, ["op"])) throw new Error(TODO_TOOL_ERRORS.unknownOperationFields("clear"));
    return { op: "clear" };
  }
  if (raw.op === "append") {
    const allowed = new Set(["op", "subject", "abstract", "blockedBy"]);
    if (Object.keys(raw).some((key) => !allowed.has(key))) throw new Error(TODO_TOOL_ERRORS.unknownOperationFields("append"));
    return {
      op: "append",
      subject: cleanText(raw.subject, "append subject"),
      abstract: cleanText(raw.abstract, "append abstract"),
      ...(raw.blockedBy === undefined ? {} : { blockedBy: cleanSubjectList(raw.blockedBy, "append blockedBy") }),
    };
  }
  if (raw.op === "delete") {
    const allowed = new Set(["op", "target"]);
    if (Object.keys(raw).some((key) => !allowed.has(key))) throw new Error(TODO_TOOL_ERRORS.unknownOperationFields("delete"));
    return { op: "delete", target: cleanText(raw.target, "delete target") };
  }
  if (raw.op === "modify") {
    const mutable = ["newSubject", "abstract", "status", "blockedBy"] as const;
    const allowed = new Set(["op", "target", ...mutable]);
    if (Object.keys(raw).some((key) => !allowed.has(key))) throw new Error(TODO_TOOL_ERRORS.unknownOperationFields("modify"));
    if (!mutable.some((key) => raw[key] !== undefined)) throw new Error(TODO_TOOL_ERRORS.modifyFields);
    if (raw.status !== undefined && !STATUSES.has(raw.status as TodoStatus)) throw new Error(TODO_TOOL_ERRORS.modifyStatus);
    return {
      op: "modify",
      target: cleanText(raw.target, "modify target"),
      ...(raw.newSubject === undefined ? {} : { newSubject: cleanText(raw.newSubject, "modify newSubject") }),
      ...(raw.abstract === undefined ? {} : { abstract: cleanText(raw.abstract, "modify abstract") }),
      ...(raw.status === undefined ? {} : { status: raw.status as TodoStatus }),
      ...(raw.blockedBy === undefined ? {} : { blockedBy: cleanSubjectList(raw.blockedBy, "modify blockedBy") }),
    };
  }
  throw new Error(TODO_TOOL_ERRORS.unknownOperation(raw.op));
}

function appendReceipt(number: number, subject: string): TodoReceipt {
  return { operation: number, kind: "append", text: TODO_RECEIPTS.appended(subject) };
}

function deleteReceipt(number: number, subject: string): TodoReceipt {
  return { operation: number, kind: "delete", text: TODO_RECEIPTS.deleted(subject) };
}

function clearReceipt(number: number, changed: boolean): TodoReceipt {
  return changed
    ? { operation: number, kind: "clear", text: TODO_RECEIPTS.cleared }
    : { operation: number, kind: "no-change", text: TODO_RECEIPTS.noChange };
}

function modifyReceipt(
  number: number,
  oldTask: TodoTask,
  nextTask: TodoTask,
  changedDependencies: boolean,
): TodoReceipt {
  const changes: string[] = [];
  if (oldTask.status !== nextTask.status) changes.push(`status ${oldTask.status} to ${nextTask.status}`);
  if (oldTask.abstract !== nextTask.abstract) changes.push("abstract");
  if (changedDependencies) changes.push("blockedBy");
  const renamed = oldTask.subject !== nextTask.subject;
  if (!renamed && changes.length === 0) {
    return { operation: number, kind: "no-change", text: TODO_RECEIPTS.noChangeFor(nextTask.subject) };
  }
  if (renamed) {
    const rename = TODO_RECEIPTS.renamed(oldTask.subject, nextTask.subject);
    const text = changes.length > 0
      ? `${rename} ${TODO_RECEIPTS.modified(nextTask.subject, changes)}`
      : rename;
    return { operation: number, kind: "rename", text };
  }
  const kind = oldTask.status !== nextTask.status && changes.length === 1 ? "status" : "modify";
  return { operation: number, kind, text: TODO_RECEIPTS.modified(nextTask.subject, changes) };
}

export function applyTodoUpdate(
  current: readonly TodoTask[],
  rawOperations: readonly TodoOperation[],
): { tasks: TodoTask[]; operations: TodoOperation[]; receipts: TodoReceipt[] } {
  if (!Array.isArray(rawOperations) || rawOperations.length === 0) {
    throw new Error(TODO_TOOL_ERRORS.updateFailed(1, TODO_TOOL_ERRORS.operationsArray));
  }
  const draft = cloneTasks(current);
  const operations: TodoOperation[] = [];
  const receipts: TodoReceipt[] = [];
  let clearSeen = false;

  for (let index = 0; index < rawOperations.length; index += 1) {
    const number = index + 1;
    try {
      const operation = normalizeOperation(rawOperations[index] as TodoOperation, number);
      operations.push(operation);
      if (operation.op === "clear") {
        if (clearSeen) throw new Error(TODO_TOOL_ERRORS.repeatedClear);
        clearSeen = true;
        const inProgress = draft.filter((task) => task.status === "in_progress");
        if (inProgress.length > 0) {
          const subjects = inProgress.map((task) => `"${task.subject}"`).join(", ");
          throw new Error(TODO_TOOL_ERRORS.clearActive(subjects));
        }
        const changed = draft.length > 0;
        draft.splice(0, draft.length);
        receipts.push(clearReceipt(number, changed));
        continue;
      }

      if (operation.op === "append") {
        if (draft.some((task) => task.subject === operation.subject)) {
          throw new Error(TODO_TOOL_ERRORS.subjectExists(operation.subject));
        }
        const blockedBy = operation.blockedBy ?? [];
        const existing = new Set(draft.map((task) => task.subject));
        for (const dependency of blockedBy) {
          if (!existing.has(dependency)) throw new Error(TODO_TOOL_ERRORS.dependencyMissing(dependency));
          if (dependency === operation.subject) throw new Error(TODO_TOOL_ERRORS.selfDependency(operation.subject));
        }
        draft.push({
          subject: operation.subject,
          abstract: operation.abstract,
          status: "pending",
          blockedBy: [...blockedBy],
        });
        receipts.push(appendReceipt(number, operation.subject));
        continue;
      }

      if (operation.op === "delete") {
        const index = draft.findIndex((task) => task.subject === operation.target);
        if (index < 0) throw new Error(TODO_TOOL_ERRORS.targetMissing(operation.target));
        if (draft[index].status === "in_progress") {
          throw new Error(TODO_TOOL_ERRORS.deleteActive(operation.target));
        }
        const referrers = draft
          .filter((task) => task.subject !== operation.target && task.blockedBy.includes(operation.target))
          .map((task) => `"${task.subject}"`);
        if (referrers.length > 0) {
          throw new Error(TODO_TOOL_ERRORS.deleteReferenced(operation.target, referrers.join(", ")));
        }
        draft.splice(index, 1);
        receipts.push(deleteReceipt(number, operation.target));
        continue;
      }

      const taskIndex = draft.findIndex((task) => task.subject === operation.target);
      if (taskIndex < 0) throw new Error(TODO_TOOL_ERRORS.targetMissing(operation.target));
      const before = { ...draft[taskIndex], blockedBy: [...draft[taskIndex].blockedBy] };
      const task = draft[taskIndex];

      if (operation.newSubject !== undefined && operation.newSubject !== task.subject) {
        if (draft.some((candidate, candidateIndex) => candidateIndex !== taskIndex && candidate.subject === operation.newSubject)) {
          throw new Error(TODO_TOOL_ERRORS.subjectExists(operation.newSubject));
        }
        const oldSubject = task.subject;
        task.subject = operation.newSubject;
        for (const candidate of draft) {
          candidate.blockedBy = candidate.blockedBy.map((dependency) => dependency === oldSubject ? operation.newSubject! : dependency);
        }
      }
      if (operation.abstract !== undefined) task.abstract = operation.abstract;
      if (operation.status !== undefined) task.status = operation.status;

      const dependencyBefore = [...task.blockedBy];
      if (operation.blockedBy !== undefined) {
        const existing = new Set(draft.map((candidate) => candidate.subject));
        for (const dependency of operation.blockedBy) {
          if (!existing.has(dependency)) throw new Error(TODO_TOOL_ERRORS.dependencyMissing(dependency));
          if (dependency === task.subject) throw new Error(TODO_TOOL_ERRORS.selfDependency(task.subject));
        }
        task.blockedBy = [...operation.blockedBy];
      }
      receipts.push(modifyReceipt(number, before, task, JSON.stringify(dependencyBefore) !== JSON.stringify(task.blockedBy)));
    } catch (error) {
      throw new Error(TODO_TOOL_ERRORS.updateFailed(number, error));
    }
  }

  try {
    validateTodoState(draft);
  } catch (error) {
    const number = rawOperations.length;
    throw new Error(TODO_TOOL_ERRORS.updateFailed(number, error));
  }
  return { tasks: cloneTasks(draft), operations: operations.map(cloneOperation), receipts: receipts.map((receipt) => ({ ...receipt })) };
}

function parseTask(value: unknown): TodoTask | undefined {
  if (!isRecord(value) || !hasExactKeys(value, TASK_KEYS)) return undefined;
  if (typeof value.subject !== "string" || typeof value.abstract !== "string") return undefined;
  if (!STATUSES.has(value.status as TodoStatus) || !Array.isArray(value.blockedBy)) return undefined;
  if (!value.blockedBy.every((item) => typeof item === "string")) return undefined;
  return {
    subject: value.subject,
    abstract: value.abstract,
    status: value.status as TodoStatus,
    blockedBy: [...value.blockedBy] as string[],
  };
}

function parseReceipt(value: unknown): TodoReceipt | undefined {
  if (!isRecord(value) || !hasExactKeys(value, RECEIPT_KEYS)) return undefined;
  if (!Number.isInteger(value.operation) || (value.operation as number) < 1) return undefined;
  if (!RECEIPT_KINDS.has(value.kind as TodoReceipt["kind"]) || typeof value.text !== "string") return undefined;
  return { operation: value.operation as number, kind: value.kind as TodoReceipt["kind"], text: value.text };
}

export function parseTodoSnapshot(value: unknown): TodoSnapshotDetails | undefined {
  if (!isRecord(value) || !hasExactKeys(value, DETAILS_KEYS)) return undefined;
  if (value.type !== TODO_SNAPSHOT_TYPE || value.version !== TODO_SNAPSHOT_VERSION) return undefined;
  if (!isRecord(value.state) || !hasExactKeys(value.state, STATE_KEYS)) return undefined;
  if (value.state.version !== TODO_SNAPSHOT_VERSION || !Array.isArray(value.state.tasks)) return undefined;
  if (!Array.isArray(value.receipts) || !Array.isArray(value.operations)) return undefined;
  const tasks = value.state.tasks.map(parseTask);
  const receipts = value.receipts.map(parseReceipt);
  if (tasks.some((task) => !task) || receipts.some((receipt) => !receipt)) return undefined;
  try {
    validateTodoState(tasks as TodoTask[]);
    const normalizedOperations = value.operations.map((operation, index) => normalizeOperation(operation as TodoOperation, index + 1));
    if (normalizedOperations.length !== receipts.length) return undefined;
    return {
      type: TODO_SNAPSHOT_TYPE,
      version: TODO_SNAPSHOT_VERSION,
      state: { version: TODO_SNAPSHOT_VERSION, tasks: cloneTasks(tasks as TodoTask[]) },
      receipts: (receipts as TodoReceipt[]).map((receipt) => ({ ...receipt })),
      operations: normalizedOperations.map(cloneOperation),
    };
  } catch {
    return undefined;
  }
}

export function replayTodoBranch(branch: Iterable<unknown>): TodoTask[] {
  let tasks: TodoTask[] = [];
  for (const entry of branch) {
    const record = entry as { type?: string; message?: { role?: string; toolName?: string; details?: unknown; isError?: boolean } };
    if (record.type !== "message") continue;
    if (record.message?.role !== "toolResult" || record.message.toolName !== "todo" || record.message.isError === true) continue;
    const snapshot = parseTodoSnapshot(record.message.details);
    if (snapshot) tasks = cloneTasks(snapshot.state.tasks);
  }
  return tasks;
}

export function makeTodoSnapshot(
  tasks: readonly TodoTask[],
  operations: readonly TodoOperation[],
  receipts: readonly TodoReceipt[],
): TodoSnapshotDetails {
  return {
    type: TODO_SNAPSHOT_TYPE,
    version: TODO_SNAPSHOT_VERSION,
    state: { version: TODO_SNAPSHOT_VERSION, tasks: cloneTasks(tasks) },
    receipts: receipts.map((receipt) => ({ ...receipt })),
    operations: operations.map(cloneOperation),
  };
}

export function cloneTodoTasks(tasks: readonly TodoTask[]): TodoTask[] {
  return cloneTasks(tasks);
}
