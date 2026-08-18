import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { formatSemanticGlyphPrefix } from "../oh-my-pi-slim/semantic-glyph.js";
import { readWidgetExpanded, widgetExpandHint } from "../oh-my-pi-slim/widget-expansion.js";
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
    ? ` ${formatSemanticGlyphPrefix(theme.fg("dim", "⛓"))}${theme.fg("dim", task.blockedBy.map(sanitizeTodoText).join(", "))}`
    : "";
  return `${formatSemanticGlyphPrefix(taskGlyph(task, theme))}${taskSubject(task, theme)}${blocked}`;
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

function todoWidgetHeading(tasks: readonly TodoTask[], theme: Theme): string {
  const completed = tasks.filter((task) => task.status === "completed").length;
  const active = completed < tasks.length;
  const color = active ? "accent" : "dim";
  const glyph = active ? theme.bold("●") : "○";
  const label = active ? theme.bold(`Todos (${completed}/${tasks.length})`) : `Todos (${completed}/${tasks.length})`;
  return `${formatSemanticGlyphPrefix(theme.fg(color, glyph))}${theme.fg(color, label)}`;
}

/** Appends the collapsed hint only when the separator-through-expand segment fits whole; never half of it. */
function todoHeadingLine(heading: string, hint: string, theme: Theme, width: number): string {
  if (hint !== "" && visibleWidth(heading) + visibleWidth(hint) <= width) {
    return `${heading}${theme.fg("dim", hint)}`;
  }
  return truncateToWidth(heading, width, "…");
}

export function isTodoTaskBlocked(task: TodoTask, tasks: readonly TodoTask[]): boolean {
  const bySubject = new Map(tasks.map((candidate) => [candidate.subject, candidate]));
  return task.blockedBy.some((dependency) => bySubject.get(dependency)?.status !== "completed");
}

export function sortTodoTasksForWidget(tasks: readonly TodoTask[]): TodoTask[] {
  const ranked = tasks.map((task, index) => {
    let priority: number;
    if (task.status === "in_progress") priority = 0;
    else if (task.status === "pending") priority = isTodoTaskBlocked(task, tasks) ? 2 : 1;
    else priority = 3;
    return { task, index, priority };
  });
  ranked.sort((left, right) => {
    if (left.priority !== right.priority) return left.priority - right.priority;
    if (left.priority === 3) return right.index - left.index;
    return left.index - right.index;
  });
  return ranked.map(({ task }) => task);
}

/**
 * Ranks against the whole ledger first so blocked-ness and order never depend on the collapsed
 * filter, then drops completed rows when collapsed and finally applies the line budget.
 */
export function selectTodoWidgetLayout(
  tasks: readonly TodoTask[],
  maxLines = MAX_TODO_WIDGET_LINES,
  expanded = true,
): { visible: TodoTask[]; hidden: TodoTask[] } {
  const ranked = sortTodoTasksForWidget(tasks);
  const sorted = expanded ? ranked : ranked.filter((task) => task.status !== "completed");
  const directBudget = Math.max(0, maxLines - 1);
  if (sorted.length <= directBudget) return { visible: sorted, hidden: [] };
  const taskBudget = Math.max(0, maxLines - 2);
  return {
    visible: sorted.slice(0, taskBudget),
    hidden: sorted.slice(taskBudget),
  };
}

export function renderTodoLines(
  tasks: readonly TodoTask[],
  theme: Theme,
  width: number,
  maxLines = MAX_TODO_WIDGET_LINES,
  expanded = true,
  hint = "",
): string[] {
  if (tasks.length === 0 || maxLines <= 0) return [];
  const safeWidth = Math.max(1, width);
  const truncate = (line: string): string => truncateToWidth(line, safeWidth, "…");
  const policyHidden = expanded ? 0 : tasks.filter((task) => task.status === "completed").length;
  const lines = [todoHeadingLine(todoWidgetHeading(tasks, theme), policyHidden > 0 ? hint : "", theme, safeWidth)];
  const layout = selectTodoWidgetLayout(tasks, maxLines, expanded);
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
  container.addChild(new Text(
    `${formatSemanticGlyphPrefix(theme.fg("accent", theme.bold("●")))}${theme.fg("accent", theme.bold(`Todos (${completed}/${tasks.length})`))}`,
    0,
    0,
  ));
  if (!expanded) return container;
  for (const task of tasks) {
    container.addChild(new Spacer(1));
    container.addChild(new Text(
      `${formatSemanticGlyphPrefix(statusGlyph(task.status, theme))}${theme.fg("toolTitle", theme.bold(sanitizeTodoText(task.subject)))}`,
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
  return `${formatSemanticGlyphPrefix(statusGlyph(match[1] as TodoTask["status"], theme))}→ ${formatSemanticGlyphPrefix(statusGlyph(match[2] as TodoTask["status"], theme))}`;
}

export function renderTodoReceipts(
  receipts: readonly TodoReceipt[],
  operations: readonly TodoOperation[],
  theme: Theme,
  expanded = false,
): Component {
  const append = operations.filter((operation) => operation.op === "append").length;
  const modify = operations.filter((operation) => operation.op === "modify").length;
  const deletes = operations.filter((operation) => operation.op === "delete").length;
  const clear = operations.filter((operation) => operation.op === "clear").length;
  const noChange = receipts.filter((receipt) => receipt.kind === "no-change").length;
  const changed = receipts.length - noChange;
  const container = new Container();
  container.addChild(new Text(
    `${formatSemanticGlyphPrefix(theme.fg("success", "✓"))}${theme.fg("toolOutput", `Applied ${append} append · ${modify} modify · ${deletes} delete · ${clear} clear → ${changed} changed · ${noChange} no-change`)}`,
    0,
    0,
  ));
  if (!expanded) return container;
  for (const receipt of receipts) {
    const transition = receiptStatusTransition(receipt, theme);
    const glyph = transition ?? (receipt.kind === "no-change"
      ? theme.fg("dim", "○")
      : receipt.kind === "clear" || receipt.kind === "delete"
        ? theme.fg("warning", "✓")
        : theme.fg("success", "✓"));
    container.addChild(new Spacer(1));
    container.addChild(new Text(
      `${theme.fg("dim", `${receipt.operation}.`)} ${transition ?? formatSemanticGlyphPrefix(glyph)}${theme.fg("toolOutput", sanitizeTodoText(receipt.text))}`,
      0,
      0,
    ));
  }
  return container;
}

export class TodoWidget {
  private ui: (ExtensionUIContext & { getToolsExpanded?(): boolean }) | undefined;
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
          render: (width: number) => renderTodoLines(
            this.tasks,
            this.ui?.theme ?? theme,
            width,
            MAX_TODO_WIDGET_LINES,
            readWidgetExpanded(this.ui),
            widgetExpandHint(),
          ),
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
