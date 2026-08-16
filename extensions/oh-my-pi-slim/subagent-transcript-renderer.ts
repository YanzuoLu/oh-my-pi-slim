import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { Box, Container, Markdown, Spacer, Text, type Component } from "@earendil-works/pi-tui";
import { formatSubagentModel } from "./subagent-model-display.js";

export const SUBAGENT_NOTIFICATION_TYPE = "oh-my-pi-slim:subagent-notification";

type UnknownRecord = Record<string, unknown>;
type ToolResultLike = { content?: unknown; details?: unknown };
type ToolRenderContextLike = { cwd?: string };
type MessageLike = { content?: unknown; details?: unknown };
type MessageRenderOptionsLike = { outputPad?: number };

const RAW_HTML_TAG = /<\/?[A-Za-z][^>]*>/;

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

function statusStyle(status: string, theme: Theme): string {
  if (status === "completed") return theme.fg("success", "✓");
  if (status === "failed") return theme.fg("error", "✗");
  if (status === "interrupted") return theme.fg("warning", "✗");
  if (status === "waiting") return theme.fg("warning", "!");
  if (status === "running") return theme.fg("accent", "●");
  if (status === "starting") return theme.fg("muted", "◦");
  return theme.fg("muted", "○");
}

function addRequest(container: Container, theme: Theme, value: unknown): void {
  const request = asRecord(value);
  if (!request) {
    addField(container, theme, "Request", undefined, "none");
    return;
  }
  container.addChild(new Spacer(1));
  container.addChild(new Text(
    `${theme.fg("warning", "!")} ${theme.fg("toolTitle", theme.bold("Request"))} ${theme.fg("accent", `[${displayValue(request.id)}]`)}`,
    0,
    0,
  ));
  addField(container, theme, "Run", request.runId);
  addField(container, theme, "Reason", request.reason);
  addField(container, theme, "Created", request.createdAt);
  if (typeof request.message === "string") addFullSection(container, theme, "Message", request.message);
  if (request.interview !== undefined) {
    addFullSection(container, theme, "Interview", displayValue(request.interview));
  }
}

function addActivity(container: Container, theme: Theme, value: unknown): void {
  const activity = asRecord(value);
  if (!activity) {
    addField(container, theme, "Activity", undefined, "none");
    return;
  }
  container.addChild(new Spacer(1));
  container.addChild(styledTitle(theme, "Activity"));
  addField(container, theme, "Turns", activity.turnCount);
  addField(container, theme, "Tool uses", activity.toolUses);
  addField(container, theme, "Tokens", activity.tokens);
  addField(container, theme, "Context", activity.contextPercent === undefined ? undefined : `${displayValue(activity.contextPercent)}%`);
  addField(container, theme, "Compactions", activity.compactionCount);
  const activeTools = asRecord(activity.activeTools);
  if (activeTools && Object.keys(activeTools).length > 0) {
    addFullSection(container, theme, "Active tools", displayValue(activeTools));
  } else {
    addField(container, theme, "Active tools", undefined, "none");
  }
  if (typeof activity.responseText === "string") {
    addFullSection(container, theme, "Response", activity.responseText);
  }
}

function renderRunSection(value: unknown, theme: Theme, heading?: string): Container {
  const run = asRecord(value) ?? {};
  const status = asString(run.status) ?? "unknown";
  const agent = asString(run.agent) ?? "unknown agent";
  const id = asString(run.id) ?? "unknown id";
  const container = new Container();
  if (heading) container.addChild(styledTitle(theme, heading));
  container.addChild(new Text(
    `${statusStyle(status, theme)} ${theme.fg("toolTitle", theme.bold(agent))} ${theme.fg("accent", `[${id}]`)} ${theme.fg("muted", `· ${status}`)}`,
    0,
    0,
  ));
  const model = asString(run.model);
  addField(container, theme, "Model", model ? formatSubagentModel(model) : undefined);
  addField(container, theme, "Status", status);
  addField(container, theme, "Live", run.live);
  addField(container, theme, "Created", run.createdAt);
  addField(container, theme, "Updated", run.updatedAt);
  addField(container, theme, "Cwd", run.cwd);
  addField(container, theme, "Tools", Array.isArray(run.tools) ? run.tools.join(", ") : run.tools, "none");
  addField(container, theme, "Source run", run.sourceRunId);
  addField(container, theme, "Session", run.sessionFile);
  if (typeof run.task === "string") addFullSection(container, theme, "Task", run.task);
  else addField(container, theme, "Task", undefined, "(pending)");
  addRequest(container, theme, run.request);
  addActivity(container, theme, run.activity);
  if (typeof run.output === "string") addFullSection(container, theme, "Output", run.output);
  if (typeof run.error === "string") addFullSection(container, theme, "Error", run.error);
  return container;
}

function renderRequestSection(value: unknown, theme: Theme, index: number): Container {
  const request = asRecord(value) ?? {};
  const container = new Container();
  container.addChild(new Text(
    `${theme.fg("warning", "!")} ${theme.fg("toolTitle", theme.bold(`Request ${index + 1}`))} ${theme.fg("accent", `[${displayValue(request.id)}]`)}`,
    0,
    0,
  ));
  addField(container, theme, "Run", request.runId);
  addField(container, theme, "Reason", request.reason);
  addField(container, theme, "Created", request.createdAt);
  if (typeof request.message === "string") addFullSection(container, theme, "Message", request.message);
  if (request.interview !== undefined) addFullSection(container, theme, "Interview", displayValue(request.interview));
  return container;
}

function fallbackResult(result: ToolResultLike, theme: Theme, partial: boolean): Component {
  const text = contentText(result.content);
  if (text) return fullBody(text, theme, 0);
  return new Text(theme.fg(partial ? "warning" : "dim", partial ? "Result pending…" : "No result content."), 0, 0);
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
      theme.fg("toolOutput", "Returns every retained run with its complete stored result, including full output and error fields."),
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
): Component {
  const details = asRecord(result.details);
  if (details?.run !== undefined) return renderRunSection(details.run, theme, "Subagent result");
  const runs = details?.runs;
  if (Array.isArray(runs)) {
    const container = new Container();
    container.addChild(styledTitle(theme, "Retained subagent runs", `· ${runs.length}`));
    if (runs.length === 0) {
      container.addChild(new Text(theme.fg("dim", "No retained runs."), 0, 0));
      return container;
    }
    runs.forEach((run, index) => {
      container.addChild(new Spacer(1));
      container.addChild(renderRunSection(run, theme, `Run ${index + 1}`));
    });
    return container;
  }
  return fallbackResult(result, theme, options.isPartial === true);
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
): Component {
  const details = asRecord(result.details);
  const pending = details?.pending;
  if (Array.isArray(pending)) {
    const container = new Container();
    container.addChild(styledTitle(theme, "Pending supervisor requests", `· ${pending.length}`));
    if (pending.length === 0) {
      container.addChild(new Text(theme.fg("dim", "No pending requests."), 0, 0));
      return container;
    }
    pending.forEach((request, index) => {
      container.addChild(new Spacer(1));
      container.addChild(renderRequestSection(request, theme, index));
    });
    return container;
  }
  if (details?.run !== undefined) return renderRunSection(details.run, theme, "Supervisor reply result");
  return fallbackResult(result, theme, options.isPartial === true);
}

export function renderSubagentNotification(
  message: MessageLike,
  options: MessageRenderOptionsLike,
  theme: Theme,
): Component {
  const details = asRecord(message.details);
  const event = asString(details?.event) ?? asString(details?.status) ?? "update";
  const box = new Box(options.outputPad ?? 1, 1, (text) => theme.bg("customMessageBg", text));
  const container = new Container();
  container.addChild(new Text(
    `${statusStyle(event, theme)} ${theme.fg("customMessageLabel", theme.bold("Subagent notification"))} ${theme.fg("muted", `· ${event}`)}`,
    0,
    0,
  ));
  if (details?.run !== undefined) {
    container.addChild(new Spacer(1));
    container.addChild(renderRunSection(details.run, theme));
  } else {
    const content = typeof message.content === "string" ? message.content : displayValue(message.content, "");
    if (content) {
      container.addChild(new Spacer(1));
      container.addChild(fullBody(content, theme, 0));
    }
  }
  box.addChild(container);
  return box;
}
