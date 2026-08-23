import type { Theme } from "@earendil-works/pi-coding-agent";
import { Box, Container, Spacer, Text, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import type {
  MonitorAction,
  MonitorCombinedLine,
  MonitorListItem,
  MonitorOperationalState,
  MonitorStatus,
} from "./monitor-runtime.js";
import {
  monitorStatusGlyph,
  sanitizeMonitorBody,
  sanitizeMonitorText,
} from "./monitor-widget.js";
import { formatSemanticGlyphPrefix } from "./semantic-glyph.js";

type UnknownRecord = Record<string, unknown>;
type ToolResultLike = { content?: unknown; details?: unknown };
type ToolRenderContextLike = { cwd?: string; args?: unknown; expanded?: boolean };
type ToolResultRenderOptionsLike = { isPartial?: boolean; expanded?: boolean; isError?: boolean };
type MessageLike = { content?: unknown; details?: unknown };
type MessageRenderOptionsLike = { outputPad?: number; expanded?: boolean };

const STATUSES = new Set<MonitorStatus>(["running", "completed", "failed", "killed"]);
const STOP_OUTCOMES = new Set(["already-terminal", "stopped", "raced", "unconfirmed"]);

function asRecord(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function asNullableString(value: unknown): string | null | undefined {
  return value === null ? null : asString(value);
}

function asNullableNumber(value: unknown): number | null | undefined {
  return value === null ? null : asNumber(value);
}

function asStatus(value: unknown): MonitorStatus | undefined {
  return typeof value === "string" && STATUSES.has(value as MonitorStatus) ? value as MonitorStatus : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) return;
  return [...value];
}

function displayValue(value: unknown, fallback = "—"): string {
  if (typeof value === "string") return sanitizeMonitorText(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null || value === undefined) return fallback;
  try { return sanitizeMonitorText(JSON.stringify(value, null, 2) ?? String(value)); } catch { return sanitizeMonitorText(value); }
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
  return sanitizeMonitorText(line).trim();
}

class WidthSafeLine implements Component {
  private readonly value: string;
  private readonly paddingX: number;

  constructor(value: string, paddingX = 0) {
    this.value = value;
    this.paddingX = paddingX;
  }

  render(width: number): string[] {
    const contentWidth = Math.max(1, width - this.paddingX * 2);
    return [`${" ".repeat(this.paddingX)}${truncateToWidth(this.value, contentWidth, "…")}`];
  }

  invalidate(): void {}
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

function styledTitle(theme: Theme, action: string, expanded: boolean): Text {
  const safeAction = sanitizeMonitorText(action);
  return new Text(
    `${theme.fg("toolTitle", theme.bold("monitor"))} ${theme.fg("muted", `· ${safeAction}${expanded ? "" : " (ctrl+o to expand)"}`)}`,
    0,
    0,
  );
}

function addField(container: Container, theme: Theme, label: string, value: unknown, indent = 0, fallback = "—"): void {
  container.addChild(new Text(
    `${theme.fg("dim", `${label}:`)} ${theme.fg("toolOutput", displayValue(value, fallback))}`,
    indent,
    0,
  ));
}

function addSection(container: Container, theme: Theme, label: string, value: unknown, indent = 0): void {
  container.addChild(new Text(theme.fg("dim", `${label}:`), indent, 0));
  container.addChild(new Text(theme.fg("toolOutput", sanitizeMonitorBody(value)), indent + 2, 0));
}

function addStringList(container: Container, theme: Theme, label: string, values: readonly string[], indent = 0): void {
  container.addChild(new Text(theme.fg("dim", `${label}:`), indent, 0));
  if (values.length === 0) {
    container.addChild(new Text(theme.fg("dim", "—"), indent + 2, 0));
    return;
  }
  for (const value of values) {
    container.addChild(new Text(`${theme.fg("dim", "-")} ${theme.fg("toolOutput", sanitizeMonitorText(value))}`, indent + 2, 0));
  }
}

function spacedResult(component: Component): Container {
  const container = new Container();
  container.addChild(new Spacer(1));
  container.addChild(component);
  return container;
}

function combinedLine(line: MonitorCombinedLine, theme: Theme): Text {
  const metadata = `#${line.seq} ${sanitizeMonitorText(line.timestamp)} `;
  const streamRole = line.stream === "stderr" ? "warning" : "accent";
  return new Text(
    `${theme.fg("dim", metadata)}${theme.fg(streamRole, `[${line.stream}]`)} ${theme.fg("toolOutput", sanitizeMonitorBody(line.text))}`,
    2,
    0,
  );
}

function addCombinedLines(container: Container, theme: Theme, label: string, lines: readonly MonitorCombinedLine[]): void {
  container.addChild(new Text(theme.fg("dim", `${label}:`), 0, 0));
  if (lines.length === 0) {
    container.addChild(new Text(theme.fg("dim", "—"), 2, 0));
    return;
  }
  for (const line of lines) container.addChild(combinedLine(line, theme));
}

function combinedLineFromValue(value: unknown): MonitorCombinedLine | undefined {
  const line = asRecord(value);
  const seq = asNumber(line?.seq);
  const timestamp = asString(line?.timestamp);
  const stream = line?.stream === "stdout" || line?.stream === "stderr" ? line.stream : undefined;
  const text = asString(line?.text);
  if (seq === undefined || !timestamp || !stream || text === undefined) return;
  return { seq, timestamp, stream, text };
}

function combinedLinesFromValue(value: unknown): MonitorCombinedLine[] | undefined {
  if (!Array.isArray(value)) return;
  const lines = value.map(combinedLineFromValue);
  return lines.every(Boolean) ? lines as MonitorCombinedLine[] : undefined;
}

function operationalStateFromValue(value: unknown): MonitorOperationalState | undefined {
  const state = asRecord(value);
  if (!state) return;
  const id = asString(state.id);
  const abstract = asString(state.abstract);
  const command = asString(state.command);
  const cwd = asString(state.cwd);
  const pid = asNumber(state.pid);
  const status = asStatus(state.status);
  const createdAt = asString(state.createdAt);
  const updatedAt = asString(state.updatedAt);
  const lastOutputAt = state.lastOutputAt === undefined ? null : asNullableString(state.lastOutputAt);
  const checkAfter = state.checkAfter === undefined ? "" : asString(state.checkAfter);
  const endedAt = asNullableString(state.endedAt);
  const exitCode = asNullableNumber(state.exitCode);
  const signal = asNullableString(state.signal);
  const error = asNullableString(state.error);
  const notifyOn = stringArray(state.notifyOn);
  const matchedCount = asNumber(state.matchedCount);
  const notificationCount = asNumber(state.notificationCount);
  const suppressedCount = asNumber(state.suppressedCount);
  const logPath = asString(state.logPath);
  const logBytes = asNumber(state.logBytes);
  const logLines = asNumber(state.logLines);
  const droppedBytes = asNumber(state.droppedBytes);
  const droppedLines = asNumber(state.droppedLines);
  const start = asNumber(state.start);
  const end = asNumber(state.end);
  const returned = asNumber(state.returned);
  const omitted = asNumber(state.omitted);
  const truncated = asBoolean(state.truncated);
  const combined = combinedLinesFromValue(state.combined);
  if (!id || abstract === undefined || command === undefined || cwd === undefined || pid === undefined || !status || !createdAt ||
      !updatedAt || lastOutputAt === undefined || checkAfter === undefined ||
      endedAt === undefined || exitCode === undefined || signal === undefined || error === undefined || !notifyOn ||
      matchedCount === undefined || notificationCount === undefined || suppressedCount === undefined || !logPath || logBytes === undefined ||
      logLines === undefined || droppedBytes === undefined || droppedLines === undefined || start === undefined || end === undefined ||
      returned === undefined || omitted === undefined || truncated === undefined || !combined) return;
  return {
    id, abstract, command, cwd, pid, status, createdAt, updatedAt, lastOutputAt, endedAt, exitCode, signal, error,
    checkAfter, notifyOn, matchedCount, notificationCount, suppressedCount, logPath, logBytes, logLines, droppedBytes, droppedLines,
    start, end, returned, omitted, truncated, combined,
  };
}

function listItemFromValue(value: unknown): MonitorListItem | undefined {
  const item = asRecord(value);
  const id = asString(item?.id);
  const status = asStatus(item?.status);
  const abstract = asString(item?.abstract);
  if (!id || !status || abstract === undefined) return;
  return { id, status, abstract };
}

function listItemsFromValue(value: unknown): MonitorListItem[] | undefined {
  if (!Array.isArray(value)) return;
  const items = value.map(listItemFromValue);
  return items.every(Boolean) ? items as MonitorListItem[] : undefined;
}

function compactStateLine(state: MonitorOperationalState, theme: Theme): string {
  const suffix = `${theme.fg("dim", `· ${state.status} · ${state.returned} returned · ${state.omitted} omitted${state.truncated ? " · truncated" : ""}`)}`;
  return `${formatSemanticGlyphPrefix(monitorStatusGlyph(state.status, theme))}${theme.fg("toolTitle", theme.bold(`Monitor [${sanitizeMonitorText(state.id)}]`))} ${theme.fg("toolOutput", sanitizeMonitorText(state.abstract))} ${suffix}`;
}

function operationalHeading(state: MonitorOperationalState, theme: Theme): Text {
  return new Text(
    `${formatSemanticGlyphPrefix(monitorStatusGlyph(state.status, theme))}${theme.fg("toolTitle", theme.bold(`Monitor [${sanitizeMonitorText(state.id)}]`))} ${theme.fg("muted", `· ${sanitizeMonitorText(state.abstract)} · ${state.status}`)}`,
    0,
    0,
  );
}

function renderOperationalState(
  state: MonitorOperationalState,
  theme: Theme,
  includeCombined = true,
  includeHeading = true,
): Container {
  const container = new Container();
  if (includeHeading) container.addChild(operationalHeading(state, theme));
  addField(container, theme, "ID", state.id, 2);
  addSection(container, theme, "Abstract", state.abstract, 2);
  addSection(container, theme, "Command", state.command, 2);
  addField(container, theme, "Cwd", state.cwd, 2);
  addField(container, theme, "PID", state.pid, 2);
  addField(container, theme, "Status", state.status, 2);
  addField(container, theme, "Created", state.createdAt, 2);
  addField(container, theme, "Updated", state.updatedAt, 2);
  addField(container, theme, "Last output", state.lastOutputAt, 2);
  addField(container, theme, "Ended", state.endedAt, 2);
  addField(container, theme, "Exit code", state.exitCode, 2);
  addField(container, theme, "Signal", state.signal, 2);
  addSection(container, theme, "Error", state.error ?? "—", 2);
  addField(container, theme, "Check after", state.checkAfter === "" ? null : state.checkAfter, 2);
  addStringList(container, theme, "Matchers", state.notifyOn, 2);
  addField(container, theme, "Matched", state.matchedCount, 2);
  addField(container, theme, "Notifications", state.notificationCount, 2);
  addField(container, theme, "Suppressed", state.suppressedCount, 2);
  addField(container, theme, "Log path", state.logPath, 2);
  addField(container, theme, "Log bytes", state.logBytes, 2);
  addField(container, theme, "Log lines", state.logLines, 2);
  addField(container, theme, "Dropped bytes", state.droppedBytes, 2);
  addField(container, theme, "Dropped lines", state.droppedLines, 2);
  addField(container, theme, "Window", `[${state.start},${state.end})`, 2);
  addField(container, theme, "Returned", state.returned, 2);
  addField(container, theme, "Omitted", state.omitted, 2);
  addField(container, theme, "Truncated", state.truncated, 2);
  if (includeCombined) addCombinedLines(container, theme, "Combined lines", state.combined);
  return container;
}

function renderMonitorList(monitors: readonly MonitorListItem[], theme: Theme, expanded: boolean): Container {
  const running = monitors.filter((monitor) => monitor.status === "running").length;
  const terminal = monitors.length - running;
  const active = running > 0;
  const role = active ? "accent" : "dim";
  const glyph = active ? theme.bold("●") : "○";
  const label = active ? theme.bold(`Monitors (${terminal}/${monitors.length})`) : `Monitors (${terminal}/${monitors.length})`;
  const container = new Container();
  container.addChild(new Text(
    `${formatSemanticGlyphPrefix(theme.fg(role, glyph))}${theme.fg(role, label)}`,
    0,
    0,
  ));
  if (!expanded) return container;
  if (monitors.length === 0) {
    container.addChild(new Text(theme.fg("dim", "No monitors."), 0, 0));
    return container;
  }
  for (const monitor of monitors) {
    container.addChild(new Spacer(1));
    container.addChild(new Text(
      `${formatSemanticGlyphPrefix(monitorStatusGlyph(monitor.status, theme))}${theme.fg("toolOutput", sanitizeMonitorText(monitor.abstract))} ${theme.fg("dim", `[${sanitizeMonitorText(monitor.id)}] · ${monitor.status}`)}`,
      0,
      0,
    ));
  }
  return container;
}

function stopReceipt(details: UnknownRecord, state: MonitorOperationalState, theme: Theme, expanded: boolean): Container | undefined {
  const changed = asBoolean(details.changed);
  const outcome = asString(details.outcome);
  const warning = asNullableString(details.warning);
  if (changed === undefined || !outcome || !STOP_OUTCOMES.has(outcome) || warning === undefined) return;
  const glyph = !changed
    ? theme.fg("dim", "○")
    : outcome === "unconfirmed"
      ? theme.fg("error", "!")
      : monitorStatusGlyph(state.status, theme);
  const warningTail = warning ? " · warning" : "";
  const summary = `${formatSemanticGlyphPrefix(glyph)}${theme.fg("toolOutput", `Monitor [${sanitizeMonitorText(state.id)}] · ${state.status} · ${outcome}${warningTail}`)}`;
  const container = new Container();
  container.addChild(new Text(summary, 0, 0));
  if (!expanded) return container;
  addField(container, theme, "Outcome", outcome, 2);
  addSection(container, theme, "Warning", warning ?? "—", 2);
  container.addChild(new Spacer(1));
  container.addChild(renderOperationalState(state, theme, true, false));
  return container;
}

function clearReceipt(details: UnknownRecord, theme: Theme, expanded: boolean): Container | undefined {
  if (details.cleared !== true || typeof details.changed !== "boolean") return;
  const clearedCount = asNumber(details.clearedCount);
  const ids = stringArray(details.ids);
  const warnings = stringArray(details.warnings);
  if (clearedCount === undefined || !Number.isInteger(clearedCount) || clearedCount < 0 || !ids || !warnings) return;
  const glyph = details.changed ? theme.fg("success", "✓") : theme.fg("dim", "○");
  const summary = details.changed ? `Cleared ${clearedCount} monitors` : "No monitors to clear";
  const warningTail = warnings.length > 0 ? ` · ${warnings.length} warning${warnings.length === 1 ? "" : "s"}` : "";
  const container = new Container();
  container.addChild(new Text(`${formatSemanticGlyphPrefix(glyph)}${theme.fg("toolOutput", `${summary}${warningTail}`)}`, 0, 0));
  if (!expanded) return container;
  if (ids.length > 0) {
    container.addChild(new Spacer(1));
    addStringList(container, theme, "Monitor IDs", ids);
  }
  if (warnings.length > 0) {
    container.addChild(new Spacer(1));
    addStringList(container, theme, "Warnings", warnings);
  }
  return container;
}

function deleteReceipt(details: UnknownRecord, theme: Theme, expanded: boolean): Container | undefined {
  const id = asString(details.id);
  const status = asStatus(details.status);
  const warning = asNullableString(details.warning);
  if (!id || details.deleted !== true || details.changed !== true || !status || status === "running" || warning === undefined) return;
  const warningTail = warning ? " · warning" : "";
  const container = new Container();
  container.addChild(new Text(
    `${formatSemanticGlyphPrefix(theme.fg("success", "✓"))}${theme.fg("toolOutput", `Deleted monitor [${sanitizeMonitorText(id)}] · ${status}${warningTail}`)}`,
    0,
    0,
  ));
  if (!expanded) return container;
  addField(container, theme, "ID", id, 2);
  addField(container, theme, "Status", status, 2);
  addSection(container, theme, "Warning", warning ?? "—", 2);
  return container;
}

function fallbackResult(result: ToolResultLike, options: ToolResultRenderOptionsLike, theme: Theme): Component {
  const text = contentText(result.content);
  if (text) {
    if (options.expanded === true || options.isError === true) {
      return new Text(theme.fg(options.isError ? "error" : "toolOutput", sanitizeMonitorBody(text)), 0, 0);
    }
    return new WidthSafeLine(theme.fg("toolOutput", safeFirstLine(text)));
  }
  return new Text(
    theme.fg(options.isPartial ? "warning" : "dim", options.isPartial ? "Result pending…" : "No result content."),
    0,
    0,
  );
}

export function renderMonitorCall(argsValue: unknown, theme: Theme, context: ToolRenderContextLike = {}): Component {
  const args = asRecord(argsValue) ?? {};
  const action = asString(args.action) ?? "create";
  const expanded = context.expanded === true;
  const container = new Container();
  container.addChild(styledTitle(theme, action, expanded));

  if (action === "create") {
    if (expanded) {
      addSection(container, theme, "Abstract", args.abstract);
      addSection(container, theme, "Command", args.command);
      addField(container, theme, "Cwd", args.cwd ?? context.cwd, 0, "(current cwd)");
      addField(container, theme, "Check after", args.checkAfter);
      addStringList(container, theme, "Notify on", stringArray(args.notifyOn) ?? []);
    } else {
      addField(container, theme, "Abstract", args.abstract);
    }
  } else if (action === "delete" || action === "stop") {
    addField(container, theme, "ID", args.id);
  } else if (action === "status") {
    const start = asNumber(args.start) ?? 0;
    const end = asNumber(args.end) ?? 100;
    addField(container, theme, "ID", args.id);
    if (expanded) {
      addField(container, theme, "Start", start);
      addField(container, theme, "End", end);
    }
    addField(container, theme, "Window", `[${start},${end})`);
  }
  return container;
}

export function renderMonitorResult(
  result: ToolResultLike,
  options: ToolResultRenderOptionsLike = {},
  theme: Theme,
  context: ToolRenderContextLike = {},
): Component {
  const args = asRecord(context.args) ?? {};
  const action = (asString(args.action) ?? "create") as MonitorAction;
  const details = asRecord(result.details);

  if (action === "list") {
    const monitors = listItemsFromValue(details?.monitors);
    return spacedResult(monitors ? renderMonitorList(monitors, theme, options.expanded === true) : fallbackResult(result, options, theme));
  }

  if (action === "clear" && details) {
    const receipt = clearReceipt(details, theme, options.expanded === true);
    if (receipt) return spacedResult(receipt);
  }

  if (action === "delete" && details) {
    const receipt = deleteReceipt(details, theme, options.expanded === true);
    if (receipt) return spacedResult(receipt);
  }

  const state = operationalStateFromValue(details?.monitor);
  if (action === "stop" && details && state) {
    const receipt = stopReceipt(details, state, theme, options.expanded === true);
    if (receipt) return spacedResult(receipt);
  }
  if (!state) return spacedResult(fallbackResult(result, options, theme));
  if (options.expanded === true) return spacedResult(renderOperationalState(state, theme));
  return spacedResult(new WidthSafeLine(compactStateLine(state, theme)));
}

interface UpdateNotification {
  id: string;
  abstract: string;
  status: MonitorStatus;
  matched: string[];
  exitCode: number | null;
  signal: string | null;
  error: string | null;
  lines: MonitorCombinedLine[];
  omitted: number;
  truncated: boolean;
}

function updateNotification(value: UnknownRecord): UpdateNotification | undefined {
  const id = asString(value.id);
  const abstract = asString(value.abstract);
  const status = asStatus(value.status);
  const matched = stringArray(value.matched);
  const exitCode = asNullableNumber(value.exitCode);
  const signal = asNullableString(value.signal);
  const error = asNullableString(value.error);
  const lines = combinedLinesFromValue(value.lines);
  const omitted = asNumber(value.omitted);
  const truncated = asBoolean(value.truncated);
  if (!id || abstract === undefined || !status || !matched || exitCode === undefined || signal === undefined ||
      error === undefined || !lines || omitted === undefined || truncated === undefined) return;
  return { id, abstract, status, matched, exitCode, signal, error, lines, omitted, truncated };
}

/** One layout for every matcher and terminal update: current status first, then the incremental lines. */
function renderUpdateNotification(details: UpdateNotification, expanded: boolean, theme: Theme): Component {
  const running = details.status === "running";
  const matchedSuffix = running && details.matched.length > 0 ? ` · matched ${details.matched.length}` : "";
  const head = `${formatSemanticGlyphPrefix(monitorStatusGlyph(details.status, theme))}${theme.fg("customMessageText", `Monitor [${sanitizeMonitorText(details.id)}] · ${sanitizeMonitorText(details.abstract)}`)}`;
  const tail = theme.fg("customMessageText", ` · ${details.status}${matchedSuffix}`);
  if (!expanded) return new ExpandableNotificationLine(head, tail, theme);
  const container = new Container();
  container.addChild(new Text(`${head}${tail}`, 0, 0));
  addField(container, theme, "Status", details.status);
  addStringList(container, theme, "Matched", details.matched);
  if (!running) {
    addField(container, theme, "Exit code", details.exitCode);
    addField(container, theme, "Signal", details.signal);
    addSection(container, theme, "Error", details.error ?? "—");
  }
  addField(container, theme, "Omitted", details.omitted);
  addField(container, theme, "Truncated", details.truncated);
  addCombinedLines(container, theme, "Incremental lines", details.lines);
  return container;
}

interface SilenceNotification {
  id: string;
  abstract: string;
  status: MonitorStatus;
  checkAfter: string;
  silentFor: string;
  silentForMs: number;
  lastOutputAt: string | null;
}

function silenceNotification(value: UnknownRecord): SilenceNotification | undefined {
  const id = asString(value.id);
  const abstract = asString(value.abstract);
  const status = asStatus(value.status);
  const checkAfter = asString(value.checkAfter);
  const silentFor = asString(value.silentFor);
  const silentForMs = asNumber(value.silentForMs);
  const lastOutputAt = asNullableString(value.lastOutputAt);
  if (!id || abstract === undefined || !status || !checkAfter || !silentFor || silentForMs === undefined ||
      lastOutputAt === undefined) return;
  return { id, abstract, status, checkAfter, silentFor, silentForMs, lastOutputAt };
}

/** Silence reminders keep their own layout: no incremental lines, only how long the monitor has stayed quiet. */
function renderSilenceNotification(details: SilenceNotification, expanded: boolean, theme: Theme): Component {
  const head = `${formatSemanticGlyphPrefix(monitorStatusGlyph(details.status, theme))}${theme.fg("customMessageText", `Monitor [${sanitizeMonitorText(details.id)}] · ${sanitizeMonitorText(details.abstract)}`)}`;
  const tail = theme.fg("customMessageText", ` · silent ${sanitizeMonitorText(details.silentFor)}`);
  if (!expanded) return new ExpandableNotificationLine(head, tail, theme);
  const container = new Container();
  container.addChild(new Text(`${head}${tail}`, 0, 0));
  addField(container, theme, "Status", details.status);
  addField(container, theme, "Check after", details.checkAfter);
  addField(container, theme, "Silent for", details.silentFor);
  addField(container, theme, "Last output", details.lastOutputAt);
  return container;
}

interface MatcherNotification {
  id: string;
  abstract: string;
  matched: string[];
  lines: MonitorCombinedLine[];
  omitted: number;
  truncated: boolean;
}

/** Legacy pre-`update` matcher payload retained so already-persisted sessions still render in full. */
function matcherNotification(value: UnknownRecord): MatcherNotification | undefined {
  const id = asString(value.id);
  const abstract = asString(value.abstract);
  const matched = stringArray(value.matched);
  const lines = combinedLinesFromValue(value.lines);
  const omitted = asNumber(value.omitted);
  const truncated = asBoolean(value.truncated);
  if (!id || abstract === undefined || !matched || !lines || omitted === undefined || truncated === undefined) return;
  return { id, abstract, matched, lines, omitted, truncated };
}

function renderMatcherNotification(details: MatcherNotification, expanded: boolean, theme: Theme): Component {
  const head = `${formatSemanticGlyphPrefix(monitorStatusGlyph("running", theme))}${theme.fg("customMessageText", `Monitor [${sanitizeMonitorText(details.id)}] · ${sanitizeMonitorText(details.abstract)}`)}`;
  const tail = theme.fg("customMessageText", ` · matched ${details.matched.length}`);
  if (!expanded) return new ExpandableNotificationLine(head, tail, theme);
  const container = new Container();
  container.addChild(new Text(`${head}${tail}`, 0, 0));
  addStringList(container, theme, "Matched", details.matched);
  addField(container, theme, "Omitted", details.omitted);
  addField(container, theme, "Truncated", details.truncated);
  addCombinedLines(container, theme, "Incremental lines", details.lines);
  return container;
}

interface SummaryMonitor {
  id: string;
  abstract: string;
  status: MonitorStatus;
  suppressedBatches: number;
  suppressedLines: number;
}

function summaryMonitor(value: unknown): SummaryMonitor | undefined {
  const item = asRecord(value);
  const id = asString(item?.id);
  const abstract = asString(item?.abstract);
  const status = asStatus(item?.status);
  const suppressedBatches = asNumber(item?.suppressedBatches);
  const suppressedLines = asNumber(item?.suppressedLines);
  if (!id || abstract === undefined || !status || suppressedBatches === undefined || suppressedLines === undefined) return;
  return { id, abstract, status, suppressedBatches, suppressedLines };
}

function renderSummaryNotification(details: UnknownRecord, expanded: boolean, theme: Theme): Component | undefined {
  if (!Array.isArray(details.monitors)) return;
  const monitors = details.monitors.map(summaryMonitor);
  const omittedMonitors = asNumber(details.omittedMonitors);
  const truncated = asBoolean(details.truncated);
  if (monitors.some((monitor) => !monitor) || omittedMonitors === undefined || truncated === undefined) return;
  const title = `${formatSemanticGlyphPrefix(theme.fg("warning", "!"))}${theme.fg("customMessageText", "Monitors · rate limited")}`;
  if (!expanded) return new ExpandableNotificationLine(title, "", theme);
  const container = new Container();
  container.addChild(new Text(title, 0, 0));
  for (const monitor of monitors as SummaryMonitor[]) {
    container.addChild(new Text(
      `${formatSemanticGlyphPrefix(monitorStatusGlyph(monitor.status, theme))}${theme.fg("customMessageText", `Monitor [${sanitizeMonitorText(monitor.id)}] · ${sanitizeMonitorText(monitor.abstract)}`)}`,
      0,
      0,
    ));
    addField(container, theme, "Suppressed batches", monitor.suppressedBatches, 2);
    addField(container, theme, "Suppressed lines", monitor.suppressedLines, 2);
  }
  addField(container, theme, "Omitted monitors", omittedMonitors);
  addField(container, theme, "Truncated", truncated);
  return container;
}

/** Legacy pre-`update` terminal payload whose `status` field carried a whole operational state object. */
function renderTerminalNotification(details: UnknownRecord, expanded: boolean, theme: Theme): Component | undefined {
  const id = asString(details.id);
  const abstract = asString(details.abstract);
  const state = operationalStateFromValue(details.status);
  const lines = combinedLinesFromValue(details.lines);
  const omitted = asNumber(details.omitted);
  const truncated = asBoolean(details.truncated);
  if (!id || abstract === undefined || !state || !lines || omitted === undefined || truncated === undefined) return;
  const head = `${formatSemanticGlyphPrefix(monitorStatusGlyph(state.status, theme))}${theme.fg("customMessageText", `Monitor [${sanitizeMonitorText(id)}] · ${sanitizeMonitorText(abstract)}`)}`;
  const tail = theme.fg("customMessageText", ` · ${state.status}`);
  if (!expanded) return new ExpandableNotificationLine(head, tail, theme);
  const container = new Container();
  container.addChild(new Text(`${head}${tail}`, 0, 0));
  container.addChild(new Spacer(1));
  container.addChild(renderOperationalState(state, theme, true, false));
  container.addChild(new Spacer(1));
  addField(container, theme, "Incremental omitted", omitted);
  addField(container, theme, "Incremental truncated", truncated);
  addCombinedLines(container, theme, "Incremental lines", lines);
  return container;
}

function fallbackNotification(message: MessageLike, options: MessageRenderOptionsLike, theme: Theme): Component {
  const text = typeof message.content === "string" ? message.content : contentText(message.content);
  if (!text) return new Text("", 0, 0);
  if (options.expanded === true) return new Text(theme.fg("customMessageText", sanitizeMonitorBody(text)), 0, 0);
  return new ExpandableNotificationLine(theme.fg("customMessageText", safeFirstLine(text)), "", theme);
}

export function renderMonitorNotification(
  message: MessageLike,
  options: MessageRenderOptionsLike = {},
  theme: Theme,
): Component {
  const details = asRecord(message.details);
  let content: Component | undefined;
  if (details?.kind === "update") {
    const parsed = updateNotification(details);
    if (parsed) content = renderUpdateNotification(parsed, options.expanded === true, theme);
  } else if (details?.kind === "silence") {
    const parsed = silenceNotification(details);
    if (parsed) content = renderSilenceNotification(parsed, options.expanded === true, theme);
  } else if (details?.kind === "matcher") {
    const parsed = matcherNotification(details);
    if (parsed) content = renderMatcherNotification(parsed, options.expanded === true, theme);
  } else if (details?.kind === "terminal") {
    content = renderTerminalNotification(details, options.expanded === true, theme);
  } else if (details?.kind === "summary") {
    content = renderSummaryNotification(details, options.expanded === true, theme);
  }
  content ??= fallbackNotification(message, options, theme);
  const box = new Box(options.outputPad ?? 1, 1, (text) => theme.bg("customMessageBg", text));
  box.addChild(content);
  return box;
}

