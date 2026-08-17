import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  applyTodoUpdate,
  cloneTodoTasks,
  makeTodoSnapshot,
  parseTodoSnapshot,
  replayTodoBranch,
  type TodoOperation,
  type TodoSnapshotDetails,
  type TodoTask,
} from "./core.js";
import {
  renderTodoListResult,
  renderTodoReceipts,
  sanitizeTodoText,
  TodoWidget,
} from "./widget.js";

const statusSchema = Type.Union([
  Type.Literal("pending"),
  Type.Literal("in_progress"),
  Type.Literal("completed"),
], { description: "Select the target item status." });

const subjectListSchema = Type.Array(Type.String({ description: "Use an existing exact subject." }), {
  description: "List exact dependency subjects.",
});

export const appendOperationSchema = Type.Object({
  op: Type.Literal("append"),
  subject: Type.String({ description: "Provide a unique item subject." }),
  abstract: Type.String({ description: "Provide a short item summary." }),
  blockedBy: Type.Optional(subjectListSchema),
}, { additionalProperties: false });

export const modifyOperationSchema = Type.Object({
  op: Type.Literal("modify"),
  target: Type.String({ description: "Use the exact current subject." }),
  newSubject: Type.Optional(Type.String({ description: "Provide a unique replacement subject." })),
  abstract: Type.Optional(Type.String({ description: "Provide a short replacement summary." })),
  status: Type.Optional(statusSchema),
  addBlockedBy: Type.Optional(subjectListSchema),
  removeBlockedBy: Type.Optional(subjectListSchema),
}, { additionalProperties: false, minProperties: 2 });

export const clearOperationSchema = Type.Object({
  op: Type.Literal("clear"),
}, { additionalProperties: false });

export const todoOperationSchema = Type.Union([
  appendOperationSchema,
  modifyOperationSchema,
  clearOperationSchema,
]);

export const todoParameters = Type.Union([
  Type.Object({
    action: Type.Literal("list"),
  }, { additionalProperties: false }),
  Type.Object({
    action: Type.Literal("update"),
    operations: Type.Array(todoOperationSchema, {
      minItems: 1,
      description: "Apply these operations in order.",
    }),
  }, { additionalProperties: false }),
]);

export const TODO_PROMPT_SNIPPET = "Read or update the current session todo list";
export const TODO_PROMPT_GUIDELINES = [
  "Use `todo list` to read the current session's complete list.",
  "Use `todo update` to apply every operation atomically.",
  "For append, provide a unique subject and an abstract.",
  "Use abstract for a short item summary.",
  "For modify, use the exact target subject.",
  "Use only existing subjects in blockedBy.",
  "Complete every dependency before you start or complete an item.",
  "Before a new task group, complete all old items and use clear.",
  "You can complete old items, clear, and append a new group in one update.",
  "Expect any failure to cancel the whole update.",
] as const;

interface TodoListDetails {
  type: "oh-my-pi-slim:todo-list";
  tasks: TodoTask[];
}

function sessionId(ctx: ExtensionContext): string {
  return ctx.sessionManager.getSessionId() ?? "";
}

function textContent(result: { content?: Array<{ type?: string; text?: string }> }): string {
  const item = result.content?.find((content) => content.type === "text");
  return item?.text ?? "";
}

function renderOperation(operation: TodoOperation, number: number): string {
  if (operation.op === "clear") return `${number}. clear`;
  if (operation.op === "append") {
    const blocked = operation.blockedBy?.length
      ? ` blockedBy=[${operation.blockedBy.map((value) => JSON.stringify(sanitizeTodoText(value))).join(", ")}]`
      : "";
    return `${number}. append subject=${JSON.stringify(sanitizeTodoText(operation.subject))} abstract=${JSON.stringify(sanitizeTodoText(operation.abstract))}${blocked}`;
  }
  const fields: string[] = [`target=${JSON.stringify(sanitizeTodoText(operation.target))}`];
  if (operation.newSubject !== undefined) fields.push(`newSubject=${JSON.stringify(sanitizeTodoText(operation.newSubject))}`);
  if (operation.abstract !== undefined) fields.push(`abstract=${JSON.stringify(sanitizeTodoText(operation.abstract))}`);
  if (operation.status !== undefined) fields.push(`status=${operation.status}`);
  if (operation.removeBlockedBy !== undefined) fields.push(`removeBlockedBy=[${operation.removeBlockedBy.map((value) => JSON.stringify(sanitizeTodoText(value))).join(", ")}]`);
  if (operation.addBlockedBy !== undefined) fields.push(`addBlockedBy=[${operation.addBlockedBy.map((value) => JSON.stringify(sanitizeTodoText(value))).join(", ")}]`);
  return `${number}. modify ${fields.join(" ")}`;
}

function isListDetails(value: unknown): value is TodoListDetails {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.type === "oh-my-pi-slim:todo-list" && Array.isArray(record.tasks);
}

export default function todoExtension(pi: ExtensionAPI): void {
  const sessions = new Map<string, TodoTask[]>();
  const widget = new TodoWidget();
  let foregroundSession = "";

  const readState = (id: string): TodoTask[] => cloneTodoTasks(sessions.get(id) ?? []);
  const replaceState = (id: string, tasks: readonly TodoTask[]): void => {
    sessions.set(id, cloneTodoTasks(tasks));
  };
  const restore = (ctx: ExtensionContext): void => {
    replaceState(sessionId(ctx), replayTodoBranch(ctx.sessionManager.getBranch()));
  };
  const refreshWidget = (ctx: ExtensionContext): void => {
    const id = sessionId(ctx);
    if (ctx.mode !== "tui" || id !== foregroundSession) return;
    widget.update(readState(id));
  };

  pi.registerTool({
    name: "todo",
    label: "Todo",
    executionMode: "sequential",
    description: "Read or update the current session todo list. Apply updates atomically.",
    promptSnippet: TODO_PROMPT_SNIPPET,
    promptGuidelines: [...TODO_PROMPT_GUIDELINES],
    parameters: todoParameters,

    execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const id = sessionId(ctx);
      if (params.action === "list") {
        const tasks = readState(id);
        const details: TodoListDetails = { type: "oh-my-pi-slim:todo-list", tasks: cloneTodoTasks(tasks) };
        return {
          content: [{ type: "text", text: JSON.stringify(tasks) }],
          details,
        };
      }

      const current = readState(id);
      const result = applyTodoUpdate(current, params.operations as TodoOperation[]);
      replaceState(id, result.tasks);
      const details = makeTodoSnapshot(result.tasks, result.operations, result.receipts);
      refreshWidget(ctx);
      return {
        content: [{
          type: "text",
          text: result.receipts.map((receipt) => `${receipt.operation}. ${sanitizeTodoText(receipt.text)}`).join("\n"),
        }],
        details,
      };
    },

    renderCall(args, theme) {
      if (args.action === "list") return new Text(theme.fg("toolTitle", theme.bold("todo list")), 0, 0);
      const operations = Array.isArray(args.operations) ? args.operations as TodoOperation[] : [];
      const lines = [theme.fg("toolTitle", theme.bold("todo update"))];
      for (let index = 0; index < operations.length; index += 1) {
        lines.push(theme.fg("muted", renderOperation(operations[index], index + 1)));
      }
      return new Text(lines.join("\n"), 0, 0);
    },

    renderResult(result, _options, theme) {
      if (isListDetails(result.details)) return renderTodoListResult(result.details.tasks, theme);
      const snapshot = parseTodoSnapshot(result.details) as TodoSnapshotDetails | undefined;
      if (snapshot) return renderTodoReceipts(snapshot.receipts, theme);
      return new Text(sanitizeTodoText(textContent(result)), 0, 0);
    },
  });

  pi.on("session_start", (_event, ctx) => {
    restore(ctx);
    const id = sessionId(ctx);
    if (ctx.mode === "tui" && foregroundSession === "") {
      foregroundSession = id;
      widget.setContext(ctx.ui);
    }
    refreshWidget(ctx);
  });

  pi.on("session_tree", (_event, ctx) => {
    restore(ctx);
    refreshWidget(ctx);
  });

  pi.on("session_compact", (_event, ctx) => {
    restore(ctx);
    refreshWidget(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    const id = sessionId(ctx);
    sessions.delete(id);
    if (id === foregroundSession) {
      widget.dispose();
      foregroundSession = "";
    }
  });
}
