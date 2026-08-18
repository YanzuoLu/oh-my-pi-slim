import type { Theme } from "@earendil-works/pi-coding-agent";
import { Box, Container, Spacer, Text, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import type {
  GoalAction,
  GoalAutomaticEvent,
  GoalContinuationMessageDetails,
  GoalStateMessageDetails,
  GoalStatus,
  PublicGoalState,
} from "./goal-runtime.js";
import { goalStatusGlyph, sanitizeGoalBody, sanitizeGoalText } from "./goal-widget.js";
import { formatSemanticGlyphPrefix } from "./semantic-glyph.js";

type UnknownRecord = Record<string, unknown>;
type ToolResultLike = { content?: unknown; details?: unknown };
type ToolRenderContextLike = { args?: unknown; expanded?: boolean };
type ToolResultRenderOptionsLike = { isPartial?: boolean; expanded?: boolean; isError?: boolean };
type MessageLike = { content?: unknown; details?: unknown };
type MessageRenderOptionsLike = { outputPad?: number; expanded?: boolean };

function asRecord(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function contentText(content: unknown): string {
  if (!Array.isArray(content)) return typeof content === "string" ? content : "";
  return content.map((item) => {
    const block = asRecord(item);
    if (block?.type === "text" && typeof block.text === "string") return block.text;
    try { return JSON.stringify(item, null, 2) ?? String(item); } catch { return String(item); }
  }).join("\n");
}

function safeFirstLine(text: string): string {
  const line = text.split(/\r?\n/).find((value) => value.trim()) ?? "";
  return sanitizeGoalText(line).trim();
}

function validStatus(value: unknown): value is GoalStatus {
  return value === "active" || value === "retry_wait" || value === "paused" || value === "completed" || value === "cancelled";
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function goalFromValue(value: unknown): PublicGoalState | undefined {
  const goal = asRecord(value);
  if (!goal || !validStatus(goal.status) || typeof goal.abstract !== "string" || typeof goal.objective !== "string" ||
      !Array.isArray(goal.criteria) || goal.criteria.some((item) => typeof item !== "string") ||
      typeof goal.createdAt !== "string" || typeof goal.updatedAt !== "string" || !nullableString(goal.endedAt) ||
      !nullableString(goal.pauseReason) || !Number.isSafeInteger(goal.retryAttempt) || !nullableString(goal.nextRetryAt) ||
      !nullableString(goal.lastProviderError) || !Number.isSafeInteger(goal.noProgressCount) ||
      !(goal.evidence === null || Array.isArray(goal.evidence) && goal.evidence.every((item) => typeof item === "string")) ||
      !nullableString(goal.cancelReason)) return;
  return {
    status: goal.status,
    abstract: goal.abstract,
    objective: goal.objective,
    criteria: [...goal.criteria] as string[],
    createdAt: goal.createdAt,
    updatedAt: goal.updatedAt,
    endedAt: goal.endedAt,
    pauseReason: goal.pauseReason,
    retryAttempt: Number(goal.retryAttempt),
    nextRetryAt: goal.nextRetryAt,
    lastProviderError: goal.lastProviderError,
    noProgressCount: Number(goal.noProgressCount),
    evidence: goal.evidence === null ? null : [...goal.evidence] as string[],
    cancelReason: goal.cancelReason,
  };
}

function goalDetails(value: unknown): { goal: PublicGoalState | null; changed: boolean } | undefined {
  const details = asRecord(value);
  if (!details || typeof details.changed !== "boolean") return;
  if (details.goal === null) return { goal: null, changed: details.changed };
  const goal = goalFromValue(details.goal);
  return goal ? { goal, changed: details.changed } : undefined;
}

function title(theme: Theme, action: string, expanded: boolean): Text {
  return new Text(
    `${theme.fg("toolTitle", theme.bold("goal"))} ${theme.fg("muted", `· ${sanitizeGoalText(action)}${expanded ? "" : " (ctrl+o to expand)"}`)}`,
    0,
    0,
  );
}

function addField(container: Container, theme: Theme, label: string, value: unknown, indent = 0): void {
  container.addChild(new Text(
    `${theme.fg("dim", `${label}:`)} ${theme.fg("toolOutput", sanitizeGoalText(value ?? "—"))}`,
    indent,
    0,
  ));
}

function addSection(container: Container, theme: Theme, label: string, value: unknown, indent = 0): void {
  container.addChild(new Text(theme.fg("dim", `${label}:`), indent, 0));
  container.addChild(new Text(theme.fg("toolOutput", sanitizeGoalBody(value)), indent + 2, 0));
}

function addList(container: Container, theme: Theme, label: string, values: readonly string[], indent = 0): void {
  container.addChild(new Text(theme.fg("dim", `${label}:`), indent, 0));
  if (values.length === 0) {
    container.addChild(new Text(theme.fg("dim", "—"), indent + 2, 0));
    return;
  }
  for (let index = 0; index < values.length; index += 1) {
    container.addChild(new Text(
      `${theme.fg("dim", `${index + 1}.`)} ${theme.fg("toolOutput", sanitizeGoalText(values[index]))}`,
      indent + 2,
      0,
    ));
  }
}

function addCompleteGoal(container: Container, goal: PublicGoalState, theme: Theme, indent = 0): void {
  addField(container, theme, "Status", goal.status, indent);
  addSection(container, theme, "Abstract", goal.abstract, indent);
  addSection(container, theme, "Objective", goal.objective, indent);
  addList(container, theme, "Criteria", goal.criteria, indent);
  addField(container, theme, "Created", goal.createdAt, indent);
  addField(container, theme, "Updated", goal.updatedAt, indent);
  addField(container, theme, "Ended", goal.endedAt, indent);
  addSection(container, theme, "Pause reason", goal.pauseReason ?? "—", indent);
  addField(container, theme, "Retry attempt", goal.retryAttempt, indent);
  addField(container, theme, "Next retry", goal.nextRetryAt, indent);
  addSection(container, theme, "Last provider error", goal.lastProviderError ?? "—", indent);
  addField(container, theme, "No progress", goal.noProgressCount, indent);
  addList(container, theme, "Evidence", goal.evidence ?? [], indent);
  addSection(container, theme, "Cancel reason", goal.cancelReason ?? "—", indent);
}

function addCriterionEvidence(container: Container, goal: PublicGoalState, theme: Theme): void {
  container.addChild(new Text(theme.fg("dim", "Criterion evidence:"), 0, 0));
  for (let index = 0; index < goal.criteria.length; index += 1) {
    container.addChild(new Text(
      `${theme.fg("dim", `${index + 1}.`)} ${theme.fg("toolOutput", sanitizeGoalText(goal.criteria[index]))}`,
      2,
      0,
    ));
    container.addChild(new Text(
      `${formatSemanticGlyphPrefix(theme.fg("success", "✓"))}${theme.fg("toolOutput", sanitizeGoalText(goal.evidence?.[index] ?? "—"))}`,
      4,
      0,
    ));
  }
}

function spacedResult(component: Component): Container {
  const container = new Container();
  container.addChild(new Spacer(1));
  container.addChild(component);
  return container;
}

function resultSummary(action: GoalAction, goal: PublicGoalState | null, changed: boolean, theme: Theme): Text {
  if (!goal) return new Text(`${formatSemanticGlyphPrefix(theme.fg("dim", "○"))}${theme.fg("toolOutput", "Goal · none")}`, 0, 0);
  const evidenceCount = goal.evidence?.length ?? 0;
  let suffix = goal.status;
  if (action === "pause") suffix = changed ? `paused · ${goal.pauseReason ?? "—"}` : "already paused · no change";
  else if (action === "resume") suffix = changed ? "active" : "already active · no change";
  else if (action === "complete") suffix = `completed · ${evidenceCount} evidence item${evidenceCount === 1 ? "" : "s"}`;
  else if (action === "cancel") suffix = `cancelled · ${goal.cancelReason ?? "—"}`;
  const glyph = changed || action === "status" ? goalStatusGlyph(goal.status, theme) : theme.fg("dim", "○");
  return new Text(
    `${formatSemanticGlyphPrefix(glyph)}${theme.fg("toolTitle", theme.bold("Goal"))} ${theme.fg("muted", "·")} ${theme.fg("toolOutput", sanitizeGoalText(goal.abstract))} ${theme.fg("muted", `· ${sanitizeGoalText(suffix)}`)}`,
    0,
    0,
  );
}

function fallbackResult(result: ToolResultLike, options: ToolResultRenderOptionsLike, theme: Theme): Component {
  const text = contentText(result.content);
  if (text) return new Text(theme.fg("toolOutput", options.expanded === true ? sanitizeGoalBody(text) : safeFirstLine(text)), 0, 0);
  return new Text(
    theme.fg(options.isPartial ? "warning" : "dim", options.isPartial ? "Result pending…" : "No result content."),
    0,
    0,
  );
}

export function renderGoalCall(argsValue: unknown, theme: Theme, context: ToolRenderContextLike = {}): Component {
  const args = asRecord(argsValue) ?? {};
  const action = asString(args.action) ?? "create";
  const expanded = context.expanded === true;
  const container = new Container();
  container.addChild(title(theme, action, expanded));
  if (action === "create" || action === "modify") {
    if (expanded) {
      addSection(container, theme, "Abstract", args.abstract);
      addSection(container, theme, "Objective", args.objective);
      addList(container, theme, "Criteria", Array.isArray(args.criteria) ? args.criteria.map((item) => String(item)) : []);
    } else addField(container, theme, "Abstract", args.abstract);
  } else if (action === "pause" || action === "cancel") {
    if (expanded) addSection(container, theme, "Reason", args.reason);
    else addField(container, theme, "Reason", args.reason);
  } else if (action === "complete") {
    const evidence = Array.isArray(args.evidence) ? args.evidence.map((item) => String(item)) : [];
    if (expanded) addList(container, theme, "Evidence", evidence);
    else addField(container, theme, "Evidence", `${evidence.length} item${evidence.length === 1 ? "" : "s"}`);
  }
  return container;
}

export function renderGoalResult(
  result: ToolResultLike,
  options: ToolResultRenderOptionsLike = {},
  theme: Theme,
  context: ToolRenderContextLike = {},
): Component {
  const args = asRecord(context.args) ?? {};
  const action = (asString(args.action) ?? "status") as GoalAction;
  const details = goalDetails(result.details);
  if (!details) return spacedResult(fallbackResult(result, options, theme));
  const container = new Container();
  container.addChild(resultSummary(action, details.goal, details.changed, theme));
  if (options.expanded === true && details.goal) {
    container.addChild(new Spacer(1));
    addCompleteGoal(container, details.goal, theme);
    if (action === "complete") {
      container.addChild(new Spacer(1));
      addCriterionEvidence(container, details.goal, theme);
    }
    const modelResult = contentText(result.content);
    if (modelResult) {
      container.addChild(new Spacer(1));
      addSection(container, theme, "Model result", modelResult);
    }
  } else if (options.expanded === true) {
    const modelResult = contentText(result.content);
    if (modelResult) addSection(container, theme, "Model result", modelResult);
  }
  return spacedResult(container);
}

class ExpandableNotificationLine implements Component {
  private readonly head: string;
  private readonly tail: string;
  private readonly hint: string;
  private readonly paddingX: number;

  constructor(head: string, tail: string, theme: Theme, paddingX = 0) {
    this.head = head;
    this.tail = tail;
    this.hint = theme.fg("muted", " (ctrl+o to expand)");
    this.paddingX = paddingX;
  }

  render(width: number): string[] {
    const contentWidth = Math.max(1, width - this.paddingX * 2);
    const fixedWidth = visibleWidth(this.tail) + visibleWidth(this.hint);
    const headWidth = Math.max(0, contentWidth - fixedWidth);
    const head = truncateToWidth(this.head, headWidth, "…");
    const line = fixedWidth <= contentWidth
      ? `${head}${this.tail}${this.hint}`
      : `${truncateToWidth(`${this.head}${this.tail}`, Math.max(0, contentWidth - visibleWidth(this.hint)), "…")}${this.hint}`;
    return [`${" ".repeat(this.paddingX)}${truncateToWidth(line, contentWidth, "…")}`];
  }

  invalidate(): void {}
}

function continuationDetails(value: unknown): GoalContinuationMessageDetails | undefined {
  const details = asRecord(value);
  const goal = goalFromValue(details?.goal);
  const deliveryKey = asString(details?.deliveryKey);
  const continuationNumber = asNumber(details?.continuationNumber);
  if (!goal || !deliveryKey || !Number.isSafeInteger(continuationNumber) || Number(continuationNumber) < 1) return;
  return {
    type: "oh-my-pi-slim:goal-continuation",
    deliveryKey,
    continuationNumber: Number(continuationNumber),
    goal,
  };
}

function stateDetails(value: unknown): GoalStateMessageDetails | undefined {
  const details = asRecord(value);
  const goal = goalFromValue(details?.goal);
  const event = asString(details?.event) as GoalAutomaticEvent | undefined;
  const reason = asString(details?.reason);
  if (!goal || !event || !reason) return;
  return { type: "oh-my-pi-slim:goal-state-event", event, reason, goal };
}

function fallbackNotification(message: MessageLike, options: MessageRenderOptionsLike, theme: Theme): Component {
  const content = typeof message.content === "string" ? message.content : contentText(message.content);
  if (!content) return new Text("", 0, 0);
  if (options.expanded === true) return new Text(theme.fg("customMessageText", sanitizeGoalBody(content)), options.outputPad ?? 0, 0);
  return new ExpandableNotificationLine(theme.fg("customMessageText", safeFirstLine(content)), "", theme, options.outputPad ?? 0);
}

export function renderGoalContinuation(
  message: MessageLike,
  options: MessageRenderOptionsLike = {},
  theme: Theme,
): Component {
  const details = continuationDetails(message.details);
  if (!details) return fallbackNotification(message, options, theme);
  const box = new Box(options.outputPad ?? 1, 1, (text) => theme.bg("customMessageBg", text));
  if (options.expanded !== true) {
    box.addChild(new ExpandableNotificationLine(
      `${formatSemanticGlyphPrefix(goalStatusGlyph("active", theme))}${theme.fg("customMessageText", "Goal · ")}${theme.fg("customMessageText", sanitizeGoalText(details.goal.abstract))}`,
      theme.fg("customMessageText", ` · continuation ${details.continuationNumber}`),
      theme,
    ));
    return box;
  }
  const container = new Container();
  container.addChild(new Text(
    `${formatSemanticGlyphPrefix(goalStatusGlyph("active", theme))}${theme.fg("toolTitle", theme.bold("Goal"))} ${theme.fg("muted", `· continuation ${details.continuationNumber}`)}`,
    0,
    0,
  ));
  addCompleteGoal(container, details.goal, theme);
  const content = typeof message.content === "string" ? message.content : contentText(message.content);
  if (content) {
    container.addChild(new Spacer(1));
    addSection(container, theme, "Continuation content", content);
  }
  box.addChild(container);
  return box;
}

export function renderGoalState(
  message: MessageLike,
  options: MessageRenderOptionsLike = {},
  theme: Theme,
): Component {
  const details = stateDetails(message.details);
  if (!details) return fallbackNotification(message, options, theme);
  const box = new Box(options.outputPad ?? 1, 1, (text) => theme.bg("customMessageBg", text));
  if (options.expanded !== true) {
    box.addChild(new ExpandableNotificationLine(
      `${formatSemanticGlyphPrefix(goalStatusGlyph(details.goal.status, theme))}${theme.fg("customMessageText", "Goal · ")}${theme.fg("customMessageText", sanitizeGoalText(details.goal.abstract))}`,
      theme.fg("customMessageText", ` · ${sanitizeGoalText(details.event)}: ${sanitizeGoalText(details.reason)}`),
      theme,
    ));
    return box;
  }
  const container = new Container();
  container.addChild(new Text(
    `${formatSemanticGlyphPrefix(goalStatusGlyph(details.goal.status, theme))}${theme.fg("toolTitle", theme.bold("Goal"))} ${theme.fg("muted", `· ${sanitizeGoalText(details.goal.status)}`)}`,
    0,
    0,
  ));
  addField(container, theme, "Event", details.event);
  addSection(container, theme, "Reason", details.reason);
  addCompleteGoal(container, details.goal, theme);
  box.addChild(container);
  return box;
}
