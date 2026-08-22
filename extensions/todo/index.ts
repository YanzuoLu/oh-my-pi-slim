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
import { widgetStackHost } from "../oh-my-pi-slim/widget-stack-host.js";
import {
  renderTodoListResult,
  renderTodoReceipts,
  sanitizeTodoBody,
  sanitizeTodoText,
  TODO_SECTION_ID,
  TodoWidget,
} from "./widget.js";

const TODO_EXTENSION_OWNER = "oh-my-pi-slim:todo-extension";

const statusSchema = Type.Union([
  Type.Literal("pending"),
  Type.Literal("in_progress"),
  Type.Literal("completed"),
], { description: "Replacement status: pending, in_progress, or completed." });

const appendDependencySchema = Type.Array(Type.String({ description: "Exact subject of an existing item." }), {
  description: "Initial dependencies for the appended item.",
});

const addDependencySchema = Type.Array(Type.String({ description: "Exact subject of an existing item." }), {
  description: "Dependencies to add to the target item.",
});

const removeDependencySchema = Type.Array(Type.String({ description: "Exact subject of an existing item." }), {
  description: "Dependencies to remove from the target item.",
});

export const appendOperationSchema = Type.Object({
  op: Type.Literal("append", { description: "append requires subject and abstract, with optional blockedBy." }),
  subject: Type.String({ description: "Unique subject for the new item." }),
  abstract: Type.String({ description: "Short summary for the new item." }),
  blockedBy: Type.Optional(appendDependencySchema),
}, { additionalProperties: false });

export const modifyOperationSchema = Type.Object({
  op: Type.Literal("modify", {
    description: "modify requires target and at least one changed field.",
  }),
  target: Type.String({ description: "Exact current subject of the item to modify." }),
  newSubject: Type.Optional(Type.String({ description: "Unique replacement subject." })),
  abstract: Type.Optional(Type.String({ description: "Replacement item summary." })),
  status: Type.Optional(statusSchema),
  addBlockedBy: Type.Optional(addDependencySchema),
  removeBlockedBy: Type.Optional(removeDependencySchema),
}, { additionalProperties: false });

export const deleteOperationSchema = Type.Object({
  op: Type.Literal("delete", { description: "delete requires target." }),
  target: Type.String({ description: "Exact subject to delete." }),
}, { additionalProperties: false });

export const clearOperationSchema = Type.Object({
  op: Type.Literal("clear", { description: "clear accepts no other fields." }),
}, {
  additionalProperties: false,
  description: "Use clear at most once.",
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
  ], { description: "Choose list or update. list accepts no operations. update requires one or more ordered operations." }),
  operations: Type.Optional(Type.Array(todoOperationSchema, {
    minItems: 1,
    description: "Ordered append, modify, delete, or clear operations for update. Omit for list.",
  })),
}, { additionalProperties: false });

export const TODO_PROMPT_SNIPPET = "Track session tasks and dependencies.";
export const TODO_PROMPT_GUIDELINES = [
  "Append newly added user work with `todo update` instead of replacing existing items.",
  "Preserve existing `todo` items unless the user or current work requires a change.",
  "Finish current in-progress `todo` work before appended work unless blocked or explicitly reordered.",
  "Complete each `todo` dependency before starting or completing its dependent item.",
  "Remove all `todo` dependency references before deleting a pending or completed target.",
  "Ask whether to set each in_progress `todo` item pending or completed before deleting or clearing it.",
] as const;

export const TODO_CHILD_PROMPT_GUIDELINES = [
  "Keep each child-session `todo` status accurate before contacting the orchestrator.",
  "Use `todo` dependencies to expose blockers before requesting an orchestrator decision.",
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
  // A reload evaluates this module again: drop the previous instance's section before the new
  // widget publishes, so a dead closure can never keep rendering rows for an unloaded extension.
  widgetStackHost().publish(TODO_SECTION_ID, undefined);
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
    description: "Read or atomically update a session-local task ledger. `todo list` returns every item in original order. `todo update` applies ordered append, modify, delete, or clear operations as one batch. Multiple items may be in progress. Dependencies must form an acyclic graph and reference exact existing subjects. Deleting an in_progress item is rejected before dependency checks. Deleting a referenced item is rejected. Clear rejects every current in_progress item. It removes all pending and completed items. Any invalid operation or final graph rolls back the entire batch.",
    promptSnippet: TODO_PROMPT_SNIPPET,
    promptGuidelines: [
      ...TODO_PROMPT_GUIDELINES,
      ...(process.env.PI_SUBAGENT_CHILD === "1" ? TODO_CHILD_PROMPT_GUIDELINES : []),
    ],
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
    if (ctx.mode === "tui") widgetStackHost().bind(TODO_EXTENSION_OWNER, ctx.ui);
    if (ctx.mode === "tui" && foregroundSession === "") {
      foregroundSession = id;
      widget.setContext(ctx.ui);
    }
    refreshWidget(ctx);
  });

  pi.on("session_tree", (_event, ctx) => {
    restore(ctx);
    if (ctx.mode === "tui") widgetStackHost().bind(TODO_EXTENSION_OWNER, ctx.ui);
    refreshWidget(ctx);
  });

  pi.on("session_compact", (_event, ctx) => {
    restore(ctx);
    refreshWidget(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    const id = sessionId(ctx);
    sessions.delete(id);
    // Release only this extension's claim on this session's UI; OMPS may still own the aggregate.
    if (ctx.mode === "tui") widgetStackHost().unbind(TODO_EXTENSION_OWNER, ctx.ui);
    // Dispose unconditionally: the widget owns its own retract-and-unbind guard, and gating it on
    // the foreground id would strand a published section whenever that id no longer matches.
    widget.dispose();
    if (id === foregroundSession) foregroundSession = "";
  });
}
