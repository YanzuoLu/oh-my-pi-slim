import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { Box, Container, Markdown, Spacer, Text, type Component } from "@earendil-works/pi-tui";

export const SUBAGENT_NOTIFICATION_TYPE = "oh-my-pi-slim:subagent-notification";

type UnknownRecord = Record<string, unknown>;
type ToolResultLike = { content?: unknown; details?: unknown };
type ToolRenderContextLike = { cwd?: string; args?: unknown };
type MessageLike = { content?: unknown; details?: unknown };
type MessageRenderOptionsLike = { outputPad?: number };

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

function compactRunHeader(run: UnknownRecord, theme: Theme, statusOverride?: string): Text {
  const identity = runIdentity(run);
  const status = statusOverride ?? identity.status;
  return new Text(
    `${statusGlyph(status, theme)} ${theme.fg("toolTitle", theme.bold(identity.agent))} ${theme.fg("accent", `[${identity.id}]`)} ${theme.fg("muted", `· ${status}`)}`,
    0,
    0,
  );
}

function addRequest(container: Container, theme: Theme, value: unknown, numberedLabel?: string): void {
  const request = asRecord(value);
  if (!request) return;
  container.addChild(new Spacer(1));
  const label = numberedLabel ?? "Request";
  container.addChild(new Text(
    `${theme.fg("warning", "!")} ${theme.fg("toolTitle", theme.bold(label))} ${theme.fg("accent", `[${displayValue(request.id)}]`)}`,
    0,
    0,
  ));
  addField(container, theme, "Run", request.runId);
  addField(container, theme, "Reason", request.reason);
  if (typeof request.message === "string") addFullSection(container, theme, "Message", request.message);
  if (request.interview !== undefined) addFullSection(container, theme, "Interview", displayValue(request.interview));
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

function fallbackResult(result: ToolResultLike, theme: Theme, partial: boolean): Component {
  const text = contentText(result.content);
  if (text) return fullBody(text, theme, 0);
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

function immediateAck(run: UnknownRecord, action: string, args: UnknownRecord, theme: Theme): Container {
  const { agent, id, status } = runIdentity(run);
  const terminal = TERMINAL_STATUSES.has(status);
  let glyph = terminal ? statusGlyph(status, theme) : theme.fg("success", "✓");
  let text: string;
  if (terminal && (action === "steer" || action === "interrupt")) {
    text = `${agent} [${id}] · already ${status}`;
  } else if (action === "resume") {
    const source = asString(args.id) ?? asString(run.sourceRunId) ?? "unknown source";
    text = `Resumed [${source}] → ${agent} [${id}] · ${status}`;
  } else if (action === "steer") {
    text = `Steer requested · ${agent} [${id}] · ${status}`;
  } else if (action === "interrupt") {
    glyph = theme.fg("warning", "!");
    text = `Interrupt requested · ${agent} [${id}] · ${status}`;
  } else {
    text = `Started ${agent} [${id}] · ${status}`;
  }
  const container = new Container();
  container.addChild(new Text(`${glyph} ${theme.fg("toolOutput", text)}`, 0, 0));
  if (terminal) addFinalOutput(container, theme, run);
  return container;
}

function renderRunList(runs: unknown[], theme: Theme): Container {
  const container = new Container();
  container.addChild(styledTitle(theme, "Retained subagent run status", `· ${runs.length}`));
  if (runs.length === 0) {
    container.addChild(new Text(theme.fg("dim", "No retained runs."), 0, 0));
    return container;
  }
  runs.forEach((value) => {
    const run = asRecord(value) ?? {};
    const { status } = runIdentity(run);
    container.addChild(new Spacer(1));
    container.addChild(compactRunHeader(run, theme));
    if (status !== "waiting") return;
    const requestId = asString(run.requestId);
    const reason = asString(run.reason);
    if (requestId || reason) {
      const identity = requestId ? ` [${requestId}]` : "";
      const detail = reason ? ` · ${reason}` : "";
      container.addChild(new Text(theme.fg("dim", `Request${identity}${detail}`), 0, 0));
    }
  });
  return container;
}

export function renderSubagentCall(argsValue: unknown, theme: Theme, context: ToolRenderContextLike = {}): Component {
  const args = asRecord(argsValue) ?? {};
  const action = asString(args.action) ?? "fresh";
  const container = new Container();
  container.addChild(styledTitle(theme, "subagent", `· ${action}`));
  addField(container, theme, "Action", action);

  if (action === "fresh") {
    addField(container, theme, "Agent", args.agent, "(pending)");
    addField(container, theme, "Cwd", args.cwd ?? context.cwd, "(parent session cwd)");
    if (typeof args.task === "string") addFullSection(container, theme, "Task", args.task);
    else addField(container, theme, "Task", undefined, "(pending)");
  } else if (action === "resume") {
    addField(container, theme, "Source run", args.id, "(pending)");
    if (typeof args.message === "string") addFullSection(container, theme, "Continuation task", args.message);
    else addField(container, theme, "Continuation task", undefined, "(pending)");
  } else if (action === "steer") {
    addField(container, theme, "Run", args.id, "(pending)");
    if (typeof args.message === "string") addFullSection(container, theme, "Guidance", args.message);
    else addField(container, theme, "Guidance", undefined, "(pending)");
  } else if (action === "interrupt") {
    addField(container, theme, "Run", args.id, "(pending)");
  } else if (action === "list") {
    container.addChild(new Spacer(1));
    container.addChild(new Text(
      theme.fg("toolOutput", "Returns retained run identity and current status, plus waiting request identity when present."),
      0,
      0,
    ));
  } else {
    addField(container, theme, "Run", args.id);
    if (typeof args.message === "string") addFullSection(container, theme, "Message", args.message);
  }
  return container;
}

export function renderSubagentResult(
  result: ToolResultLike,
  options: { isPartial?: boolean } = {},
  theme: Theme,
  context: ToolRenderContextLike = {},
): Component {
  const details = asRecord(result.details);
  const { action, args } = actionFromContext(context, "fresh");
  const runs = details?.runs;
  if (action === "list" && Array.isArray(runs)) return spacedToolResult(renderRunList(runs, theme));
  const run = asRecord(details?.run);
  if (run) return spacedToolResult(immediateAck(run, action, args, theme));
  if (Array.isArray(runs)) return spacedToolResult(renderRunList(runs, theme));
  return spacedToolResult(fallbackResult(result, theme, options.isPartial === true));
}

export function renderSupervisorCall(argsValue: unknown, theme: Theme): Component {
  const args = asRecord(argsValue) ?? {};
  const action = asString(args.action) ?? "pending";
  const container = new Container();
  container.addChild(styledTitle(theme, "subagent_supervisor", `· ${action}`));
  addField(container, theme, "Action", action);
  if (action === "pending") {
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("toolOutput", "Returns every pending supervisor request in full."), 0, 0));
  } else if (action === "reply") {
    addField(container, theme, "Request", args.replyTo, "(pending)");
    if (typeof args.message === "string") addFullSection(container, theme, "Reply", args.message);
    else addField(container, theme, "Reply", undefined, "(pending)");
  }
  return container;
}

export function renderSupervisorResult(
  result: ToolResultLike,
  options: { isPartial?: boolean } = {},
  theme: Theme,
  context: ToolRenderContextLike = {},
): Component {
  const details = asRecord(result.details);
  const { action, args } = actionFromContext(context, "pending");
  const pending = details?.pending;
  if (action === "pending" && Array.isArray(pending)) {
    const container = new Container();
    container.addChild(styledTitle(theme, "Pending supervisor requests", `· ${pending.length}`));
    if (pending.length === 0) {
      container.addChild(new Text(theme.fg("dim", "No pending requests."), 0, 0));
      return spacedToolResult(container);
    }
    pending.forEach((request, index) => addRequest(container, theme, request, `Request ${index + 1}`));
    return spacedToolResult(container);
  }
  const run = asRecord(details?.run);
  if (action === "reply" && run) {
    const { agent, id, status } = runIdentity(run);
    const request = asString(args.replyTo) ?? "unknown request";
    const glyph = TERMINAL_STATUSES.has(status) ? statusGlyph(status, theme) : theme.fg("success", "✓");
    return spacedToolResult(new Text(
      `${glyph} ${theme.fg("toolOutput", `Replied [${request}] · ${agent} [${id}] · ${status}`)}`,
      0,
      0,
    ));
  }
  if (Array.isArray(pending)) {
    const container = new Container();
    container.addChild(styledTitle(theme, "Pending supervisor requests", `· ${pending.length}`));
    pending.forEach((request, index) => addRequest(container, theme, request, `Request ${index + 1}`));
    return spacedToolResult(container);
  }
  return spacedToolResult(fallbackResult(result, theme, options.isPartial === true));
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
    return content ? fullBody(content, theme, options.outputPad ?? 0) : new Text("", 0, 0);
  }

  const event = asString(details?.event) ?? asString(details?.status) ?? asString(run.status) ?? "update";
  const box = new Box(options.outputPad ?? 1, 1, (text) => theme.bg("customMessageBg", text));
  const container = new Container();
  container.addChild(compactRunHeader(run, theme, event));
  if (TERMINAL_STATUSES.has(event)) {
    addFinalOutput(container, theme, run);
  } else if (event === "waiting") {
    addRequest(container, theme, run.request);
  } else if (LIVE_STATUSES.has(event) && run.output === undefined) {
    addLiveActivity(container, theme, run.activity);
  }
  box.addChild(container);
  return box;
}
