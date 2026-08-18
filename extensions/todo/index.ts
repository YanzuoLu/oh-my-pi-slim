import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text, type Component } from "@earendil-works/pi-tui";
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
  sanitizeTodoBody,
  sanitizeTodoText,
  TodoWidget,
} from "./widget.js";

const statusSchema = Type.Union([
  Type.Literal("pending"),
  Type.Literal("in_progress"),
  Type.Literal("completed"),
], { description: "Select pending, in_progress, or completed." });

const appendDependencySchema = Type.Array(Type.String({ description: "Use an existing exact subject." }), {
  description: "Add initial dependencies by exact subject.",
});

const addDependencySchema = Type.Array(Type.String({ description: "Use an existing exact subject." }), {
  description: "Add dependencies by exact subject.",
});

const removeDependencySchema = Type.Array(Type.String({ description: "Use an existing exact subject." }), {
  description: "Remove dependencies by exact subject.",
});

export const appendOperationSchema = Type.Object({
  op: Type.Literal("append"),
  subject: Type.String({ description: "Provide a unique item subject." }),
  abstract: Type.String({ description: "Provide a short item summary." }),
  blockedBy: Type.Optional(appendDependencySchema),
}, { additionalProperties: false });

export const modifyOperationSchema = Type.Object({
  op: Type.Literal("modify"),
  target: Type.String({ description: "Use the exact current subject." }),
  newSubject: Type.Optional(Type.String({ description: "Provide a unique replacement subject." })),
  abstract: Type.Optional(Type.String({ description: "Provide a short replacement summary." })),
  status: Type.Optional(statusSchema),
  addBlockedBy: Type.Optional(addDependencySchema),
  removeBlockedBy: Type.Optional(removeDependencySchema),
}, { additionalProperties: false });

export const deleteOperationSchema = Type.Object({
  op: Type.Literal("delete"),
  target: Type.String({ description: "Use the exact subject to delete." }),
}, { additionalProperties: false });

export const clearOperationSchema = Type.Object({
  op: Type.Literal("clear"),
}, {
  additionalProperties: false,
  description: "Apply clear at most once in an update.",
});

export const todoOperationSchema = Type.Union([
  appendOperationSchema,
  modifyOperationSchema,
  deleteOperationSchema,
  clearOperationSchema,
]);

export const todoParameters = Type.Object({
  action: Type.Union([
    Type.Literal("list"),
    Type.Literal("update"),
  ], { description: "Select list to read state or update to apply operations." }),
  operations: Type.Optional(Type.Array(todoOperationSchema, {
    minItems: 1,
    description: "For update, provide operations in execution order. Omit this field for list.",
  })),
}, { additionalProperties: false });

export const TODO_PROMPT_SNIPPET = "Track session work, dependencies, and progress.";
export const TODO_PROMPT_GUIDELINES = [
  "Treat `todo` as the session-local planning ledger for work, dependencies, and progress.",
  "Use `todo list` to inspect current plan state before uncertain updates.",
  "Use `todo update` for atomic ordered changes that should succeed or fail together.",
  "Append new user tasks through `todo update` instead of replacing existing `todo` items.",
  "Preserve existing `todo` items unless the user or current work requires a change.",
  "Complete every `todo` dependency before starting or completing a dependent item.",
  "Allow multiple `todo` items in progress when work genuinely proceeds concurrently.",
  "Delete a `todo` item only after removing every `blockedBy` reference to it.",
  "Finish current in-progress `todo` work before appended tasks unless blocked or explicitly reordered.",
  "Apply `clear` through `todo update` only after current items finish, then append the new task group.",
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

function addCallField(container: Container, theme: Theme, label: string, value: unknown, indent = 0): void {
  container.addChild(new Text(
    `${theme.fg("dim", `${label}:`)} ${theme.fg("toolOutput", sanitizeTodoText(value ?? "—"))}`,
    indent,
    0,
  ));
}

function addCallSection(container: Container, theme: Theme, label: string, value: unknown, indent = 0): void {
  container.addChild(new Text(theme.fg("dim", `${label}:`), indent, 0));
  container.addChild(new Text(theme.fg("toolOutput", sanitizeTodoBody(value)), indent + 2, 0));
}

function addCallList(container: Container, theme: Theme, label: string, values: readonly string[], indent = 0): void {
  container.addChild(new Text(theme.fg("dim", `${label}:`), indent, 0));
  if (values.length === 0) {
    container.addChild(new Text(theme.fg("dim", "—"), indent + 2, 0));
    return;
  }
  for (const value of values) {
    container.addChild(new Text(`${theme.fg("dim", "-")} ${theme.fg("toolOutput", sanitizeTodoText(value))}`, indent + 2, 0));
  }
}

function spacedTodoResult(component: Component): Container {
  const container = new Container();
  container.addChild(new Spacer(1));
  container.addChild(component);
  return container;
}

function todoCallTitle(theme: Theme, action: string, expanded: boolean): Text {
  const detail = `· ${action}${expanded ? "" : " (ctrl+o to expand)"}`;
  return new Text(
    `${theme.fg("toolTitle", theme.bold("todo"))} ${theme.fg("muted", detail)}`,
    0,
    0,
  );
}

function safeFallbackLine(text: string): string {
  const line = text.split(/\r?\n/).find((value) => value.trim()) ?? "";
  return sanitizeTodoText(line).trim();
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
    description: "Read or atomically update the current session todo list. Failed update batches leave the list unchanged.",
    promptSnippet: TODO_PROMPT_SNIPPET,
    promptGuidelines: [...TODO_PROMPT_GUIDELINES],
    parameters: todoParameters,

    execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const id = sessionId(ctx);
      if (params.action === "list") {
        if (params.operations !== undefined) throw new Error("todo list does not accept operations.");
        const tasks = readState(id);
        const details: TodoListDetails = { type: "oh-my-pi-slim:todo-list", tasks: cloneTodoTasks(tasks) };
        return {
          content: [{ type: "text", text: JSON.stringify(tasks) }],
          details,
        };
      }
      if (params.action !== "update") throw new Error(`Unknown todo action: ${String(params.action)}.`);
      if (!Array.isArray(params.operations) || params.operations.length === 0) {
        throw new Error("todo update requires at least one operation.");
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

    renderCall(args, theme, context) {
      const action = args.action === "update" ? "update" : "list";
      const expanded = context.expanded === true;
      const container = new Container();
      container.addChild(todoCallTitle(theme, action, expanded));
      if (action === "list" || !expanded) return container;

      const operations = Array.isArray(args.operations) ? args.operations as TodoOperation[] : [];
      container.addChild(new Spacer(1));
      addCallField(container, theme, "Operations", operations.length);
      for (let index = 0; index < operations.length; index += 1) {
        const operation = operations[index];
        const label = operation.op === "append"
          ? "Append"
          : operation.op === "modify"
            ? "Modify"
            : operation.op === "delete" ? "Delete" : "Clear";
        container.addChild(new Spacer(1));
        container.addChild(new Text(
          `${theme.fg("dim", `${index + 1}.`)} ${theme.fg("toolTitle", theme.bold(label))}`,
          0,
          0,
        ));
        if (operation.op === "append") {
          addCallField(container, theme, "Subject", operation.subject, 2);
          addCallSection(container, theme, "Abstract", operation.abstract, 2);
          addCallList(container, theme, "Blocked by", operation.blockedBy ?? [], 2);
        } else if (operation.op === "modify") {
          addCallField(container, theme, "Target", operation.target, 2);
          if (operation.newSubject !== undefined) addCallField(container, theme, "New subject", operation.newSubject, 2);
          if (operation.status !== undefined) addCallField(container, theme, "Status", operation.status, 2);
          if (operation.abstract !== undefined) addCallSection(container, theme, "Abstract", operation.abstract, 2);
          if (operation.addBlockedBy !== undefined) addCallList(container, theme, "Add blocked by", operation.addBlockedBy, 2);
          if (operation.removeBlockedBy !== undefined) addCallList(container, theme, "Remove blocked by", operation.removeBlockedBy, 2);
        } else if (operation.op === "delete") {
          addCallField(container, theme, "Target", operation.target, 2);
        }
      }
      return container;
    },

    renderResult(result, options, theme) {
      const expanded = options.expanded === true;
      if (isListDetails(result.details)) return spacedTodoResult(renderTodoListResult(result.details.tasks, theme, expanded));
      const snapshot = parseTodoSnapshot(result.details) as TodoSnapshotDetails | undefined;
      if (snapshot) return spacedTodoResult(renderTodoReceipts(snapshot.receipts, snapshot.operations, theme, expanded));
      const text = textContent(result);
      if (!text) {
        return spacedTodoResult(new Text(
          theme.fg(options.isPartial ? "warning" : "dim", options.isPartial ? "Result pending…" : "No result content."),
          0,
          0,
        ));
      }
      return spacedTodoResult(new Text(theme.fg("toolOutput", expanded ? sanitizeTodoBody(text) : safeFallbackLine(text)), 0, 0));
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
