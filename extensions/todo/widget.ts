import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import type { TodoOperation, TodoReceipt, TodoTask } from "./core.js";

export const TODO_WIDGET_KEY = "oh-my-pi-slim:todos";
export const MAX_TODO_WIDGET_LINES = 12;

export function sanitizeTodoText(value: unknown): string {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
}

export function sanitizeTodoBody(value: unknown): string {
  return String(value ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, " ");
}

function statusGlyph(status: TodoTask["status"], theme: Theme): string {
  if (status === "completed") return theme.fg("success", "✓");
  if (status === "in_progress") return theme.fg("accent", "◐");
  return theme.fg("dim", "○");
}

function taskGlyph(task: TodoTask, theme: Theme): string {
  return statusGlyph(task.status, theme);
}

function taskSubject(task: TodoTask, theme: Theme): string {
  const subject = sanitizeTodoText(task.subject);
  if (task.status === "completed") return theme.fg("dim", theme.strikethrough(subject));
  if (task.status === "in_progress") return theme.fg("accent", subject);
  return theme.fg("text", subject);
}

function taskLine(task: TodoTask, theme: Theme): string {
  const blocked = task.blockedBy.length > 0
    ? theme.fg("dim", ` ⛓ ${task.blockedBy.map(sanitizeTodoText).join(", ")}`)
    : "";
  return `${taskGlyph(task, theme)} ${taskSubject(task, theme)}${blocked}`;
}

function counts(tasks: readonly TodoTask[]): { completed: number; pending: number; inProgress: number } {
  return {
    completed: tasks.filter((task) => task.status === "completed").length,
    pending: tasks.filter((task) => task.status === "pending").length,
    inProgress: tasks.filter((task) => task.status === "in_progress").length,
  };
}

function hiddenSummary(tasks: readonly TodoTask[]): string {
  const value = counts(tasks);
  const parts: string[] = [];
  if (value.completed > 0) parts.push(`${value.completed} completed`);
  if (value.pending > 0) parts.push(`${value.pending} pending`);
  if (value.inProgress > 0) parts.push(`${value.inProgress} in_progress`);
  return `+${tasks.length} more (${parts.join(", ")})`;
}

export function selectTodoWidgetLayout(
  tasks: readonly TodoTask[],
  maxLines = MAX_TODO_WIDGET_LINES,
): { visible: TodoTask[]; hidden: TodoTask[] } {
  const directBudget = Math.max(0, maxLines - 1);
  if (tasks.length <= directBudget) return { visible: [...tasks], hidden: [] };
  const taskBudget = Math.max(0, maxLines - 2);
  const unfinished = tasks.filter((task) => task.status !== "completed");
  const selected = new Set<TodoTask>();
  for (const task of unfinished.slice(0, taskBudget)) selected.add(task);
  if (selected.size < taskBudget) {
    for (const task of tasks) {
      if (task.status !== "completed") continue;
      selected.add(task);
      if (selected.size >= taskBudget) break;
    }
  }
  return {
    visible: tasks.filter((task) => selected.has(task)),
    hidden: tasks.filter((task) => !selected.has(task)),
  };
}

export function renderTodoLines(
  tasks: readonly TodoTask[],
  theme: Theme,
  width: number,
  maxLines = MAX_TODO_WIDGET_LINES,
): string[] {
  if (tasks.length === 0 || maxLines <= 0) return [];
  const truncate = (line: string): string => truncateToWidth(line, Math.max(1, width), "…");
  const completed = tasks.filter((task) => task.status === "completed").length;
  const lines = [truncate(theme.fg("accent", theme.bold(`● Todos (${completed}/${tasks.length})`)))];
  const layout = selectTodoWidgetLayout(tasks, maxLines);
  for (let index = 0; index < layout.visible.length; index += 1) {
    const last = index === layout.visible.length - 1 && layout.hidden.length === 0;
    lines.push(truncate(`${theme.fg("dim", last ? "└─" : "├─")} ${taskLine(layout.visible[index], theme)}`));
  }
  if (layout.hidden.length > 0 && lines.length < maxLines) {
    lines.push(truncate(`${theme.fg("dim", "└─")} ${theme.fg("dim", hiddenSummary(layout.hidden))}`));
  }
  return lines.slice(0, maxLines);
}

function addResultField(container: Container, theme: Theme, label: string, value: unknown, indent = 0): void {
  container.addChild(new Text(
    `${theme.fg("dim", `${label}:`)} ${theme.fg("toolOutput", sanitizeTodoText(value ?? "—"))}`,
    indent,
    0,
  ));
}

function addResultSection(container: Container, theme: Theme, label: string, value: unknown, indent = 0): void {
  container.addChild(new Text(theme.fg("dim", `${label}:`), indent, 0));
  container.addChild(new Text(theme.fg("toolOutput", sanitizeTodoBody(value)), indent + 2, 0));
}

function addResultList(container: Container, theme: Theme, label: string, values: readonly string[], indent = 0): void {
  container.addChild(new Text(theme.fg("dim", `${label}:`), indent, 0));
  if (values.length === 0) {
    container.addChild(new Text(theme.fg("dim", "—"), indent + 2, 0));
    return;
  }
  for (const value of values) {
    container.addChild(new Text(`${theme.fg("dim", "-")} ${theme.fg("toolOutput", sanitizeTodoText(value))}`, indent + 2, 0));
  }
}

export function renderTodoListResult(tasks: readonly TodoTask[], theme: Theme, expanded = false): Component {
  const completed = tasks.filter((task) => task.status === "completed").length;
  const container = new Container();
  container.addChild(new Text(theme.fg("accent", theme.bold(`● Todos (${completed}/${tasks.length})`)), 0, 0));
  if (!expanded) return container;
  for (const task of tasks) {
    container.addChild(new Spacer(1));
    container.addChild(new Text(
      `${statusGlyph(task.status, theme)} ${theme.fg("toolTitle", theme.bold(sanitizeTodoText(task.subject)))}`,
      0,
      0,
    ));
    addResultField(container, theme, "Status", task.status, 2);
    addResultSection(container, theme, "Abstract", task.abstract, 2);
    addResultList(container, theme, "Blocked by", task.blockedBy, 2);
  }
  return container;
}

function receiptStatusTransition(receipt: TodoReceipt, theme: Theme): string | undefined {
  const match = /\bstatus (pending|in_progress|completed) to (pending|in_progress|completed)\b/.exec(receipt.text);
  if (!match) return;
  return `${statusGlyph(match[1] as TodoTask["status"], theme)} → ${statusGlyph(match[2] as TodoTask["status"], theme)}`;
}

export function renderTodoReceipts(
  receipts: readonly TodoReceipt[],
  operations: readonly TodoOperation[],
  theme: Theme,
  expanded = false,
): Component {
  const append = operations.filter((operation) => operation.op === "append").length;
  const modify = operations.filter((operation) => operation.op === "modify").length;
  const clear = operations.filter((operation) => operation.op === "clear").length;
  const noChange = receipts.filter((receipt) => receipt.kind === "no-change").length;
  const changed = receipts.length - noChange;
  const container = new Container();
  container.addChild(new Text(
    `${theme.fg("success", "✓")} ${theme.fg("toolOutput", `Applied ${append} append · ${modify} modify · ${clear} clear → ${changed} changed · ${noChange} no-change`)}`,
    0,
    0,
  ));
  if (!expanded) return container;
  for (const receipt of receipts) {
    const transition = receiptStatusTransition(receipt, theme);
    const glyph = transition ?? (receipt.kind === "no-change"
      ? theme.fg("dim", "○")
      : receipt.kind === "clear" ? theme.fg("warning", "✓") : theme.fg("success", "✓"));
    container.addChild(new Spacer(1));
    container.addChild(new Text(
      `${theme.fg("dim", `${receipt.operation}.`)} ${glyph} ${theme.fg("toolOutput", sanitizeTodoText(receipt.text))}`,
      0,
      0,
    ));
  }
  return container;
}

export class TodoWidget {
  private ui: ExtensionUIContext | undefined;
  private tui: { requestRender(force?: boolean): void } | undefined;
  private registered = false;
  private tasks: readonly TodoTask[] = [];

  setContext(ui: ExtensionUIContext): void {
    if (this.ui === ui) return;
    if (this.registered && this.ui) this.ui.setWidget(TODO_WIDGET_KEY, undefined);
    this.ui = ui;
    this.tui = undefined;
    this.registered = false;
  }

  update(tasks: readonly TodoTask[]): void {
    this.tasks = tasks;
    if (!this.ui) return;
    if (tasks.length === 0) {
      if (this.registered) this.ui.setWidget(TODO_WIDGET_KEY, undefined);
      this.registered = false;
      this.tui = undefined;
      return;
    }
    if (!this.registered) {
      this.ui.setWidget(TODO_WIDGET_KEY, (tui, theme) => {
        this.tui = tui;
        return {
          render: (width: number) => renderTodoLines(this.tasks, this.ui?.theme ?? theme, width),
          invalidate() {},
        };
      }, { placement: "aboveEditor" });
      this.registered = true;
      return;
    }
    this.tui?.requestRender();
  }

  dispose(): void {
    if (this.registered && this.ui) this.ui.setWidget(TODO_WIDGET_KEY, undefined);
    this.ui = undefined;
    this.tui = undefined;
    this.registered = false;
    this.tasks = [];
  }
}
