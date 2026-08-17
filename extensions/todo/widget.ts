import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import type { TodoReceipt, TodoTask } from "./core.js";

export const TODO_WIDGET_KEY = "oh-my-pi-slim:todos";
export const MAX_TODO_WIDGET_LINES = 12;

export function sanitizeTodoText(value: unknown): string {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
}

function taskGlyph(task: TodoTask, theme: Theme): string {
  if (task.status === "completed") return theme.fg("success", "✓");
  if (task.status === "in_progress") return theme.fg("accent", "◐");
  return theme.fg("dim", "○");
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
  const lines = [truncate(theme.fg("accent", theme.bold(`Todos (${completed}/${tasks.length})`)))];
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

export function renderTodoListResult(tasks: readonly TodoTask[], theme: Theme): Text {
  if (tasks.length === 0) return new Text(theme.fg("dim", "Todos (0/0)"), 0, 0);
  return new Text(renderTodoLines(tasks, theme, Number.MAX_SAFE_INTEGER, tasks.length + 1).join("\n"), 0, 0);
}

export function renderTodoReceipts(receipts: readonly TodoReceipt[], theme: Theme): Text {
  const text = receipts.map((receipt) => {
    const color = receipt.kind === "no-change" ? "dim" : receipt.kind === "clear" ? "warning" : "success";
    return theme.fg(color, `${receipt.operation}. ${sanitizeTodoText(receipt.text)}`);
  }).join("\n");
  return new Text(text, 0, 0);
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
