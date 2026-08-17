import type { Theme } from "@earendil-works/pi-coding-agent";
import { Box, Container, Spacer, Text, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import type { LoopAction, LoopFireDetails, PublicLoop } from "./loop-runtime.js";
import { sanitizeLoopBody, sanitizeLoopText, sortLoopsForDisplay } from "./loop-widget.js";

type UnknownRecord = Record<string, unknown>;
type ToolResultLike = { content?: unknown; details?: unknown };
type ToolRenderContextLike = { args?: unknown; expanded?: boolean };
type ToolResultRenderOptionsLike = { isPartial?: boolean; expanded?: boolean; isError?: boolean };
type MessageLike = { content?: unknown; details?: unknown };
type MessageRenderOptionsLike = { outputPad?: number; expanded?: boolean };

function asRecord(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : undefined;
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
  return sanitizeLoopText(line).trim();
}

class TruncatedLine implements Component {
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

class LoopFireLine implements Component {
  private readonly details: LoopFireDetails;
  private readonly theme: Theme;

  constructor(details: LoopFireDetails, theme: Theme) {
    this.details = details;
    this.theme = theme;
  }

  render(width: number): string[] {
    const prefix = `${this.theme.fg("accent", "↻")} ${this.theme.fg("customMessageText", `Loop [${sanitizeLoopText(this.details.id)}] · `)}`;
    const suffix = this.theme.fg("customMessageText", ` · fire ${this.details.fireCount}`);
    const abstractWidth = Math.max(0, width - visibleWidth(prefix) - visibleWidth(suffix));
    const abstract = truncateToWidth(sanitizeLoopText(this.details.abstract), abstractWidth, "…");
    return [truncateToWidth(`${prefix}${this.theme.fg("customMessageText", abstract)}${suffix}`, Math.max(1, width), "…")];
  }

  invalidate(): void {}
}

function styledTitle(theme: Theme, title: string, detail?: string): Text {
  const suffix = detail ? ` ${theme.fg("muted", detail)}` : "";
  return new Text(theme.fg("toolTitle", theme.bold(title)) + suffix, 0, 0);
}

function addField(container: Container, theme: Theme, label: string, value: unknown, indent = 0): void {
  container.addChild(new Text(
    `${theme.fg("dim", `${label}:`)} ${theme.fg("toolOutput", sanitizeLoopText(value ?? "—"))}`,
    indent,
    0,
  ));
}

function addSection(container: Container, theme: Theme, label: string, value: unknown, indent = 0): void {
  container.addChild(new Text(theme.fg("dim", `${label}:`), indent, 0));
  container.addChild(new Text(theme.fg("toolOutput", sanitizeLoopBody(value)), indent + 2, 0));
}

function spacedResult(component: Component): Container {
  const container = new Container();
  container.addChild(new Spacer(1));
  container.addChild(component);
  return container;
}

function loopFromValue(value: unknown): PublicLoop | undefined {
  const loop = asRecord(value);
  if (!loop) return;
  const id = asString(loop.id);
  const abstract = asString(loop.abstract);
  const prompt = asString(loop.prompt);
  const interval = asString(loop.interval);
  const status = loop.status === "active" || loop.status === "paused" ? loop.status : undefined;
  const createdAt = asString(loop.createdAt);
  const updatedAt = asString(loop.updatedAt);
  const nextFireAt = loop.nextFireAt === null ? null : asString(loop.nextFireAt);
  const fireCount = asNumber(loop.fireCount);
  const failureCount = asNumber(loop.failureCount);
  const lastFiredAt = loop.lastFiredAt === null ? null : asString(loop.lastFiredAt);
  const lastFailedAt = loop.lastFailedAt === null ? null : asString(loop.lastFailedAt);
  const lastError = loop.lastError === null ? null : asString(loop.lastError);
  if (!id || abstract === undefined || prompt === undefined || !interval || !status || !createdAt || !updatedAt || nextFireAt === undefined ||
      fireCount === undefined || failureCount === undefined || lastFiredAt === undefined || lastFailedAt === undefined || lastError === undefined) return;
  return {
    id, abstract, prompt, interval, status, createdAt, updatedAt, nextFireAt, fireCount, failureCount,
    lastFiredAt, lastFailedAt, lastError,
  };
}

function loopsFromDetails(value: unknown): PublicLoop[] | undefined {
  const details = asRecord(value);
  if (!Array.isArray(details?.loops)) return;
  const loops = details.loops.map(loopFromValue);
  return loops.every(Boolean) ? loops as PublicLoop[] : undefined;
}

function fireFromDetails(value: unknown): LoopFireDetails | undefined {
  const details = asRecord(value);
  const id = asString(details?.id);
  const abstract = asString(details?.abstract);
  const interval = asString(details?.interval);
  const fireCount = asNumber(details?.fireCount);
  const prompt = asString(details?.prompt);
  const firedAt = asString(details?.firedAt);
  if (!id || abstract === undefined || !interval || fireCount === undefined || prompt === undefined || !firedAt) return;
  return { id, abstract, interval, fireCount, prompt, firedAt };
}

function fireLabel(count: number): string {
  return `${count} fire${count === 1 ? "" : "s"}`;
}

function failureLabel(count: number): string {
  return `${count} failure${count === 1 ? "" : "s"}`;
}

function statusGlyph(loop: PublicLoop, theme: Theme): string {
  if (loop.status === "paused") return theme.fg("dim", "Ⅱ");
  if (loop.lastError) return theme.fg("error", "!");
  return theme.fg("accent", "↻");
}

function loopHeading(loop: PublicLoop, theme: Theme): Text {
  return new Text(
    `${statusGlyph(loop, theme)} ${theme.fg("toolTitle", theme.bold(`Loop [${sanitizeLoopText(loop.id)}]`))} ${theme.fg("muted", `· ${loop.status}`)}`,
    0,
    0,
  );
}

function addCompleteLoop(container: Container, loop: PublicLoop, theme: Theme): void {
  container.addChild(loopHeading(loop, theme));
  addField(container, theme, "Status", loop.status, 2);
  addField(container, theme, "Interval", loop.interval, 2);
  addField(container, theme, "Created", loop.createdAt, 2);
  addField(container, theme, "Updated", loop.updatedAt, 2);
  addField(container, theme, "Next fire", loop.nextFireAt, 2);
  addField(container, theme, "Fires", loop.fireCount, 2);
  addField(container, theme, "Failures", loop.failureCount, 2);
  addField(container, theme, "Last fired", loop.lastFiredAt, 2);
  addField(container, theme, "Last failed", loop.lastFailedAt, 2);
  addSection(container, theme, "Last error", loop.lastError ?? "—", 2);
  addSection(container, theme, "Abstract", loop.abstract, 2);
  addSection(container, theme, "Prompt", loop.prompt, 2);
}

function renderLoopList(loops: readonly PublicLoop[], theme: Theme, expanded: boolean): Container {
  const sorted = sortLoopsForDisplay(loops);
  const active = sorted.filter((loop) => loop.status === "active").length;
  const container = new Container();
  container.addChild(new Text(theme.fg(active > 0 ? "accent" : "dim", theme.bold(`● Loops (${active}/${sorted.length})`)), 0, 0));
  for (const loop of sorted) {
    container.addChild(new Spacer(1));
    if (expanded) {
      addCompleteLoop(container, loop, theme);
      continue;
    }
    container.addChild(new Text(
      `${statusGlyph(loop, theme)} ${theme.fg("toolOutput", sanitizeLoopText(loop.abstract))} ${theme.fg("dim", `[${sanitizeLoopText(loop.id)}] · Every ${sanitizeLoopText(loop.interval)} · ${fireLabel(loop.fireCount)}`)}`,
      0,
      0,
    ));
  }
  return container;
}

function mutationReceipt(action: LoopAction, loop: PublicLoop | undefined, changed: boolean, id: string | undefined, theme: Theme): Container {
  const container = new Container();
  const displayId = sanitizeLoopText(loop?.id ?? id ?? "unknown");
  if (!changed) {
    container.addChild(new Text(`${theme.fg("dim", "○")} ${theme.fg("toolOutput", `No change · loop [${displayId}]`)}`, 0, 0));
    return container;
  }
  const verbs: Record<Exclude<LoopAction, "list">, string> = {
    create: "Created",
    delete: "Deleted",
    modify: "Modified",
    pause: "Paused",
    resume: "Resumed",
  };
  const suffix = loop ? ` · ${loop.status}` : "";
  container.addChild(new Text(
    `${theme.fg("success", "✓")} ${theme.fg("toolOutput", `${verbs[action as Exclude<LoopAction, "list">]} loop [${displayId}]${suffix}`)}`,
    0,
    0,
  ));
  return container;
}

function fallbackResult(result: ToolResultLike, options: ToolResultRenderOptionsLike, theme: Theme): Component {
  const text = contentText(result.content);
  if (text) return new Text(theme.fg("toolOutput", options.expanded === true ? sanitizeLoopBody(text) : safeFirstLine(text)), 0, 0);
  return new Text(
    theme.fg(options.isPartial ? "warning" : "dim", options.isPartial ? "Result pending…" : "No result content."),
    0,
    0,
  );
}

export function renderLoopCall(argsValue: unknown, theme: Theme, context: ToolRenderContextLike = {}): Component {
  const args = asRecord(argsValue) ?? {};
  const action = asString(args.action) ?? "create";
  const expanded = context.expanded === true;
  const container = new Container();
  container.addChild(styledTitle(
    theme,
    "loop",
    `· ${action}${expanded ? "" : " (ctrl+o to expand)"}`,
  ));

  if (action === "create") {
    addField(container, theme, "Interval", args.interval, 0);
    if (expanded) addSection(container, theme, "Abstract", args.abstract, 0);
    else addField(container, theme, "Abstract", args.abstract, 0);
    if (expanded) addSection(container, theme, "Prompt", args.prompt, 0);
  } else if (action === "modify") {
    addField(container, theme, "Loop", args.id, 0);
    if (args.interval !== undefined) addField(container, theme, "Interval", args.interval, 0);
    if (args.abstract !== undefined) {
      if (expanded) addSection(container, theme, "Abstract", args.abstract, 0);
      else addField(container, theme, "Abstract", args.abstract, 0);
    }
    if (expanded && args.prompt !== undefined) addSection(container, theme, "Prompt", args.prompt, 0);
  } else if (action === "delete" || action === "pause" || action === "resume") {
    addField(container, theme, "Loop", args.id, 0);
  }
  return container;
}

export function renderLoopResult(
  result: ToolResultLike,
  options: ToolResultRenderOptionsLike = {},
  theme: Theme,
  context: ToolRenderContextLike = {},
): Component {
  const args = asRecord(context.args) ?? {};
  const action = (asString(args.action) ?? "create") as LoopAction;
  if (action === "list") {
    const loops = loopsFromDetails(result.details);
    return spacedResult(loops ? renderLoopList(loops, theme, options.expanded === true) : fallbackResult(result, options, theme));
  }

  const details = asRecord(result.details);
  const loop = loopFromValue(details?.loop);
  const deleted = details?.deleted === true && typeof details.id === "string";
  const changed = details?.changed === false ? false : loop !== undefined || deleted;
  if (!loop && !deleted) return spacedResult(fallbackResult(result, options, theme));

  const container = mutationReceipt(action, loop, changed, deleted ? details?.id as string : undefined, theme);
  if (options.expanded === true && loop) {
    container.addChild(new Spacer(1));
    addCompleteLoop(container, loop, theme);
  } else if (options.expanded === true && deleted) {
    addField(container, theme, "Loop", details?.id, 2);
    addField(container, theme, "Deleted", true, 2);
  }
  return spacedResult(container);
}

export function renderLoopFire(
  message: MessageLike,
  options: MessageRenderOptionsLike = {},
  theme: Theme,
): Component {
  const details = fireFromDetails(message.details);
  if (!details) {
    const content = typeof message.content === "string" ? message.content : contentText(message.content);
    if (!content) return new Text("", 0, 0);
    if (options.expanded === true) return new Text(theme.fg("customMessageText", sanitizeLoopBody(content)), options.outputPad ?? 0, 0);
    return new TruncatedLine(theme.fg("customMessageText", safeFirstLine(content)), options.outputPad ?? 0);
  }

  const box = new Box(options.outputPad ?? 1, 1, (text) => theme.bg("customMessageBg", text));
  if (options.expanded !== true) {
    box.addChild(new LoopFireLine(details, theme));
    return box;
  }

  const container = new Container();
  container.addChild(new Text(
    `${theme.fg("accent", "↻")} ${theme.fg("toolTitle", theme.bold(`Loop [${sanitizeLoopText(details.id)}]`))} ${theme.fg("muted", `· fire ${details.fireCount}`)}`,
    0,
    0,
  ));
  addField(container, theme, "ID", details.id);
  addField(container, theme, "Interval", details.interval);
  addField(container, theme, "Fire", details.fireCount);
  addField(container, theme, "Fired at", details.firedAt);
  addSection(container, theme, "Abstract", details.abstract);
  addSection(container, theme, "Prompt", details.prompt);
  box.addChild(container);
  return box;
}
