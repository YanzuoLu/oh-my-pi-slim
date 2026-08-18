import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { Box, Container, Markdown, Spacer, Text, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { legacyRunAbstract } from "./subagent-core.js";
import { formatSemanticGlyphPrefix } from "./semantic-glyph.js";

export const SUBAGENT_NOTIFICATION_TYPE = "oh-my-pi-slim:subagent-notification";

type UnknownRecord = Record<string, unknown>;
type ToolResultLike = { content?: unknown; details?: unknown };
type ToolRenderContextLike = { cwd?: string; args?: unknown; expanded?: boolean };
type ToolResultRenderOptionsLike = { isPartial?: boolean; expanded?: boolean };
type MessageLike = { content?: unknown; details?: unknown };
type MessageRenderOptionsLike = { outputPad?: number; expanded?: boolean };

const RAW_HTML_TAG = /<\/?[A-Za-z][^>]*>/;
const LIVE_STATUSES = new Set(["starting", "running"]);
const TERMINAL_STATUSES = new Set(["completed", "failed", "interrupted"]);

function asRecord(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function displayValue(value: unknown, fallback = "—"): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === undefined || value === null) return fallback;
  try { return JSON.stringify(value, null, 2) ?? String(value); } catch { return String(value); }
}

function contentText(content: unknown): string {
  if (!Array.isArray(content)) return typeof content === "string" ? content : "";
  return content.map((item) => {
    const block = asRecord(item);
    if (block?.type === "text" && typeof block.text === "string") return block.text;
    return displayValue(item, "");
  }).join("\n");
}

function safeFirstLine(text: string): string {
  const line = text.split(/\r?\n/).find((value) => value.trim()) ?? "";
  return line.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim();
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

function styledTitle(theme: Theme, title: string, detail?: string): Text {
  const suffix = detail ? ` ${theme.fg("muted", detail)}` : "";
  return new Text(theme.fg("toolTitle", theme.bold(title)) + suffix, 0, 0);
}

function addField(container: Container, theme: Theme, label: string, value: unknown, fallback = "—"): void {
  container.addChild(new Text(
    `${theme.fg("dim", `${label}:`)} ${theme.fg("toolOutput", displayValue(value, fallback))}`,
    0,
    0,
  ));
}

function fullBody(text: string, theme: Theme, paddingX = 2): Component {
  if (RAW_HTML_TAG.test(text)) return new Text(theme.fg("toolOutput", text), paddingX, 0);
  return new Markdown(
    text,
    paddingX,
    0,
    getMarkdownTheme(),
    { color: (value) => theme.fg("toolOutput", value) },
    { preserveOrderedListMarkers: true, preserveBackslashEscapes: true, renderLatex: false },
  );
}

function addFullSection(container: Container, theme: Theme, label: string, text: string): void {
  container.addChild(new Spacer(1));
  container.addChild(new Text(theme.fg("dim", `${label}:`), 0, 0));
  container.addChild(fullBody(text, theme));
}

function statusGlyph(status: string, theme: Theme): string {
  if (status === "completed") return theme.fg("success", "✓");
  if (status === "failed") return theme.fg("error", "✗");
  if (status === "interrupted") return theme.fg("warning", "✗");
  if (status === "waiting") return theme.fg("warning", "!");
  if (status === "running") return theme.fg("accent", "●");
  if (status === "starting") return theme.fg("muted", "◦");
  return theme.fg("muted", "○");
}

function runIdentity(run: UnknownRecord): { agent: string; id: string; status: string } {
  return {
    agent: asString(run.agent) ?? "unknown agent",
    id: asString(run.id) ?? "unknown id",
    status: asString(run.status) ?? "unknown",
  };
}

function transcriptRunAbstract(run: UnknownRecord): string | undefined {
  if (typeof run.abstract === "string" && run.abstract.trim()) return run.abstract.trim();
  if (typeof run.task === "string") return legacyRunAbstract(run.task);
  return "Legacy run summary unavailable";
}

function compactRunHeaderParts(
  run: UnknownRecord,
  theme: Theme,
  statusOverride?: string,
  includeAbstract = false,
): { head: string; tail: string } {
  const identity = runIdentity(run);
  const status = statusOverride ?? identity.status;
  const abstractText = includeAbstract ? transcriptRunAbstract(run) : undefined;
  const abstract = abstractText ? `  ${abstractText}` : "";
  return {
    head: `${formatSemanticGlyphPrefix(statusGlyph(status, theme))}${theme.fg("toolTitle", theme.bold(identity.agent))} ${theme.fg("accent", `[${identity.id}]`)}`,
    tail: ` ${theme.fg("muted", `· ${status}`)}${abstract}`,
  };
}

function compactRunHeader(run: UnknownRecord, theme: Theme, statusOverride?: string, includeAbstract = false): Text {
  const parts = compactRunHeaderParts(run, theme, statusOverride, includeAbstract);
  return new Text(`${parts.head}${parts.tail}`, 0, 0);
}

function addRequest(container: Container, theme: Theme, value: unknown): void {
  const request = asRecord(value);
  if (!request) return;
  container.addChild(new Spacer(1));
  container.addChild(new Text(
    `${formatSemanticGlyphPrefix(theme.fg("warning", "!"))}${theme.fg("toolTitle", theme.bold("Request"))}`,
    0,
    0,
  ));
  addField(container, theme, "Run", request.runId);
  addField(container, theme, "Reason", request.reason);
  if (typeof request.message === "string") addFullSection(container, theme, "Message", request.message);
  if (request.interview !== undefined) addFullSection(container, theme, "Interview", displayValue(request.interview));
  addField(container, theme, "Created", request.createdAt);
}

function addFinalOutput(container: Container, theme: Theme, run: UnknownRecord): void {
  if (typeof run.output === "string") addFullSection(container, theme, "Output", run.output);
  if (typeof run.error === "string") addFullSection(container, theme, "Error", run.error);
}

function addLiveActivity(container: Container, theme: Theme, value: unknown): void {
  const activity = asRecord(value);
  if (!activity) return;
  if (typeof activity.responseText === "string" && activity.responseText.length > 0) {
    addFullSection(container, theme, "Live response", activity.responseText);
  }
  const activeTools = asRecord(activity.activeTools);
  if (activeTools && Object.keys(activeTools).length > 0) {
    addFullSection(container, theme, "Active tools", displayValue(activeTools));
  }
}

function fallbackResult(result: ToolResultLike, theme: Theme, partial: boolean, expanded: boolean): Component {
  const text = contentText(result.content);
  if (text) {
    if (expanded) return fullBody(text, theme, 0);
    return new Text(theme.fg("toolOutput", safeFirstLine(text)), 0, 0);
  }
  return new Text(theme.fg(partial ? "warning" : "dim", partial ? "Result pending…" : "No result content."), 0, 0);
}

function spacedToolResult(component: Component): Container {
  const container = new Container();
  container.addChild(new Spacer(1));
  container.addChild(component);
  return container;
}

function actionFromContext(context: ToolRenderContextLike, fallback: string): { action: string; args: UnknownRecord } {
  const args = asRecord(context.args) ?? {};
  return { action: asString(args.action) ?? fallback, args };
}

function immediateAck(run: UnknownRecord, action: string, args: UnknownRecord, theme: Theme, expanded: boolean): Container {
  const { agent, id, status } = runIdentity(run);
  const terminal = TERMINAL_STATUSES.has(status);
  let glyph = terminal ? statusGlyph(status, theme) : theme.fg("success", "✓");
  let text: string;
  if (terminal && (action === "steer" || action === "interrupt")) {
    text = `${agent} [${id}] · already ${status}`;
  } else if (action === "resume") {
    const source = asString(args.id) ?? asString(run.sourceRunId) ?? "unknown source";
    text = `Resumed [${source}] → ${agent} [${id}] · ${status}`;
  } else if (action === "reply") {
    text = `Replied · ${agent} [${id}] · ${status}`;
  } else if (action === "steer") {
    text = `Steer requested · ${agent} [${id}] · ${status}`;
  } else if (action === "interrupt") {
    glyph = theme.fg("warning", "!");
    text = `Interrupt requested · ${agent} [${id}] · ${status}`;
  } else {
    text = `Started ${agent} [${id}] · ${status}`;
  }
  const container = new Container();
  container.addChild(new Text(`${formatSemanticGlyphPrefix(glyph)}${theme.fg("toolOutput", text)}`, 0, 0));
  if (terminal && expanded) addFinalOutput(container, theme, run);
  return container;
}

function addRunSummaryDetails(container: Container, theme: Theme, run: UnknownRecord): void {
  addField(container, theme, "Live", run.live);
  if (run.sourceRunId !== undefined) addField(container, theme, "Source run", run.sourceRunId);
  if (run.reason !== undefined) addField(container, theme, "Reason", run.reason);
}

function renderRunStatus(run: UnknownRecord, theme: Theme, expanded: boolean): Container {
  const container = new Container();
  container.addChild(compactRunHeader(run, theme, undefined, true));
  if (!expanded) return container;
  addRunSummaryDetails(container, theme, run);
  if (TERMINAL_STATUSES.has(runIdentity(run).status)) addFinalOutput(container, theme, run);
  return container;
}

function renderRunList(runs: unknown[], theme: Theme, expanded: boolean): Container {
  const container = new Container();
  container.addChild(styledTitle(theme, "Retained subagent run status", `· ${runs.length}`));
  if (runs.length === 0) {
    container.addChild(new Text(theme.fg("dim", "No retained runs."), 0, 0));
    return container;
  }
  runs.forEach((value) => {
    const run = asRecord(value) ?? {};
    container.addChild(new Spacer(1));
    container.addChild(compactRunHeader(run, theme, undefined, true));
    if (expanded) addRunSummaryDetails(container, theme, run);
  });
  return container;
}

function clearReceipt(details: UnknownRecord, theme: Theme, expanded: boolean): Container {
  const clearedCount = typeof details.clearedCount === "number" ? details.clearedCount : 0;
  const warnings = Array.isArray(details.warnings)
    ? details.warnings.filter((warning): warning is string => typeof warning === "string")
    : [];
  const changed = details.changed === true;
  const glyph = changed ? theme.fg("success", "✓") : theme.fg("muted", "○");
  const summary = changed
    ? `Cleared ${clearedCount} retained run${clearedCount === 1 ? "" : "s"}`
    : "No retained runs to clear";
  const tail = warnings.length > 0 ? ` · ${warnings.length} retained item${warnings.length === 1 ? "" : "s"}` : "";
  const container = new Container();
  container.addChild(new Text(`${formatSemanticGlyphPrefix(glyph)}${theme.fg("toolOutput", `${summary}${tail}`)}`, 0, 0));
  if (!expanded || warnings.length === 0) return container;
  container.addChild(new Spacer(1));
  container.addChild(new Text(theme.fg("dim", "Warnings:"), 0, 0));
  for (const warning of warnings) container.addChild(new Text(theme.fg("warning", `• ${warning}`), 0, 0));
  return container;
}

export function renderSubagentCall(argsValue: unknown, theme: Theme, context: ToolRenderContextLike = {}): Component {
  const args = asRecord(argsValue) ?? {};
  const action = asString(args.action) ?? "create";
  const expanded = context.expanded === true;
  const container = new Container();
  const collapsedStatusId = action === "status" && !expanded && typeof args.id === "string"
    ? ` · ${safeFirstLine(args.id)}`
    : "";
  container.addChild(styledTitle(
    theme,
    "subagent",
    `· ${action}${collapsedStatusId}${expanded ? "" : " (ctrl+o to expand)"}`,
  ));

  if (action === "create") {
    addField(container, theme, "Agent", args.agent, "(pending)");
    addField(container, theme, "Abstract", args.abstract, "(pending)");
    if (expanded) {
      addField(container, theme, "Cwd", args.cwd ?? context.cwd, "(parent session cwd)");
      if (typeof args.task === "string") addFullSection(container, theme, "Task", args.task);
      else addField(container, theme, "Task", undefined, "(pending)");
    }
  } else if (action === "resume") {
    addField(container, theme, "Source run", args.id, "(pending)");
    addField(container, theme, "Abstract", args.abstract, "(pending)");
    if (expanded) {
      if (typeof args.message === "string") addFullSection(container, theme, "Continuation task", args.message);
      else addField(container, theme, "Continuation task", undefined, "(pending)");
    }
  } else if (action === "steer") {
    addField(container, theme, "Run", args.id, "(pending)");
    if (expanded) {
      if (typeof args.message === "string") addFullSection(container, theme, "Guidance", args.message);
      else addField(container, theme, "Guidance", undefined, "(pending)");
    }
  } else if (action === "status" || action === "interrupt") {
    if (action !== "status" || expanded) addField(container, theme, "Run", args.id, "(pending)");
  } else if (action === "reply") {
    addField(container, theme, "Run", args.id, "(pending)");
    if (expanded) {
      if (typeof args.message === "string") addFullSection(container, theme, "Reply", args.message);
      else addField(container, theme, "Reply", undefined, "(pending)");
    }
  } else if (action === "list") {
    if (expanded) {
      container.addChild(new Spacer(1));
      container.addChild(new Text(
        theme.fg("toolOutput", "Returns compact public state for every retained run without terminal results."),
        0,
        0,
      ));
    }
  } else if (action === "clear") {
    if (expanded) {
      container.addChild(new Spacer(1));
      container.addChild(new Text(
        theme.fg("toolOutput", "Clears retained Subagent history, run files, and exclusively owned child session files. Unsafe removals remain as warnings."),
        0,
        0,
      ));
    }
  } else {
    addField(container, theme, "Run", args.id);
    if (expanded && typeof args.message === "string") addFullSection(container, theme, "Message", args.message);
  }
  return container;
}

export function renderSubagentResult(
  result: ToolResultLike,
  options: ToolResultRenderOptionsLike = {},
  theme: Theme,
  context: ToolRenderContextLike = {},
): Component {
  const details = asRecord(result.details);
  const { action, args } = actionFromContext(context, "create");
  const expanded = options.expanded === true;
  const runs = details?.runs;
  if (action === "clear" && details && typeof details.clearedCount === "number") {
    return spacedToolResult(clearReceipt(details, theme, expanded));
  }
  if (action === "list" && Array.isArray(runs)) return spacedToolResult(renderRunList(runs, theme, expanded));
  const run = asRecord(details?.run);
  if (action === "status" && run) return spacedToolResult(renderRunStatus(run, theme, expanded));
  if (run) return spacedToolResult(immediateAck(run, action, args, theme, expanded));
  if (Array.isArray(runs)) return spacedToolResult(renderRunList(runs, theme, expanded));
  return spacedToolResult(fallbackResult(result, theme, options.isPartial === true, expanded));
}

export function renderSubagentNotification(
  message: MessageLike,
  options: MessageRenderOptionsLike,
  theme: Theme,
): Component {
  const details = asRecord(message.details);
  const run = asRecord(details?.run);
  if (!run) {
    const content = typeof message.content === "string" ? message.content : displayValue(message.content, "");
    if (!content) return new Text("", 0, 0);
    if (options.expanded === true) return fullBody(content, theme, options.outputPad ?? 0);
    const firstLine = content.split(/\r?\n/).find((line) => line.trim()) ?? "";
    return new ExpandableNotificationLine(
      theme.fg("customMessageText", safeFirstLine(firstLine)),
      "",
      theme,
      options.outputPad ?? 0,
    );
  }

  const event = asString(details?.event) ?? asString(details?.status) ?? asString(run.status) ?? "update";
  const box = new Box(options.outputPad ?? 1, 1, (text) => theme.bg("customMessageBg", text));
  if (options.expanded !== true) {
    const parts = compactRunHeaderParts(run, theme, event);
    box.addChild(new ExpandableNotificationLine(parts.head, parts.tail, theme));
    return box;
  }

  const container = new Container();
  container.addChild(compactRunHeader(run, theme, event));
  if (options.expanded === true) {
    if (TERMINAL_STATUSES.has(event)) {
      addFinalOutput(container, theme, run);
    } else if (event === "waiting") {
      addRequest(container, theme, details?.request ?? run.request);
    } else if (LIVE_STATUSES.has(event) && run.output === undefined) {
      addLiveActivity(container, theme, run.activity);
    }
  }
  box.addChild(container);
  return box;
}
