import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text, type Component } from "@earendil-works/pi-tui";
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
  TODO_TOOL_CONTRACT,
  TODO_TOOL_ERRORS,
  todoListContent,
  todoUpdateContent,
} from "../tool-contracts.js";
export {
  appendOperationSchema,
  clearOperationSchema,
  deleteOperationSchema,
  modifyOperationSchema,
  todoOperationSchema,
  todoParameters,
} from "../tool-contracts.js";
import { widgetStackHost } from "../widget-stack-host.js";
import {
  renderTodoListResult,
  renderTodoReceipts,
  sanitizeTodoBody,
  sanitizeTodoText,
  TODO_SECTION_ID,
  TodoWidget,
} from "./widget.js";

const TODO_RUNTIME_OWNER = "oh-my-pi-slim:todo-runtime";

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

export function registerTodoRuntime(pi: ExtensionAPI): void {
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
    name: TODO_TOOL_CONTRACT.name,
    label: "Todo",
    executionMode: "sequential",
    description: TODO_TOOL_CONTRACT.description,
    parameters: TODO_TOOL_CONTRACT.parameters,

    execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const id = sessionId(ctx);
      if (params.action === "list") {
        if (params.operations !== undefined) throw new Error(TODO_TOOL_ERRORS.listOperations);
        const tasks = readState(id);
        const details: TodoListDetails = { type: "oh-my-pi-slim:todo-list", tasks: cloneTodoTasks(tasks) };
        return {
          content: [{ type: "text", text: todoListContent(tasks) }],
          details,
        };
      }
      if (params.action !== "update") throw new Error(TODO_TOOL_ERRORS.unsupportedAction(params.action));
      if (!Array.isArray(params.operations) || params.operations.length === 0) {
        throw new Error(TODO_TOOL_ERRORS.updateOperations);
      }

      const current = readState(id);
      const result = applyTodoUpdate(current, params.operations as TodoOperation[]);
      replaceState(id, result.tasks);
      const details = makeTodoSnapshot(result.tasks, result.operations, result.receipts);
      const unfinished = result.tasks
        .filter((task) => task.status !== "completed")
        .map(({ subject, status, blockedBy }) => ({ subject, status, blockedBy }));
      refreshWidget(ctx);
      return {
        content: [{
          type: "text",
          text: todoUpdateContent(unfinished),
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
          if (operation.blockedBy !== undefined) addCallList(container, theme, "Blocked by", operation.blockedBy, 2);
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
    if (ctx.mode === "tui") widgetStackHost().bind(TODO_RUNTIME_OWNER, ctx.ui);
    if (ctx.mode === "tui" && foregroundSession === "") {
      foregroundSession = id;
      widget.setContext(ctx.ui);
    }
    refreshWidget(ctx);
  });

  pi.on("session_tree", (_event, ctx) => {
    restore(ctx);
    if (ctx.mode === "tui") widgetStackHost().bind(TODO_RUNTIME_OWNER, ctx.ui);
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
    if (ctx.mode === "tui") widgetStackHost().unbind(TODO_RUNTIME_OWNER, ctx.ui);
    // Dispose unconditionally: the widget owns its own retract-and-unbind guard, and gating it on
    // the foreground id would strand a published section whenever that id no longer matches.
    widget.dispose();
    if (id === foregroundSession) foregroundSession = "";
  });
}
