import type { Theme } from "@earendil-works/pi-coding-agent";
import { Box, Container, Spacer, Text, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import type { LoopAction, LoopFireDetails, PublicLoop } from "./loop-runtime.js";
import { sanitizeLoopBody, sanitizeLoopText, sortLoopsForDisplay } from "./loop-widget.js";
import { formatSemanticGlyphPrefix } from "./semantic-glyph.js";

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

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) return;
  return [...value];
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

function activeLoopGlyph(theme: Theme): string {
  return theme.fg("accent", "↻");
}

class LoopFireLine implements Component {
  private readonly details: LoopFireDetails;
  private readonly theme: Theme;

  constructor(details: LoopFireDetails, theme: Theme) {
    this.details = details;
    this.theme = theme;
  }

  render(width: number): string[] {
    const prefix = `${formatSemanticGlyphPrefix(activeLoopGlyph(this.theme))}${this.theme.fg("customMessageText", `Loop [${sanitizeLoopText(this.details.id)}] · `)}`;
    const suffix = this.theme.fg("customMessageText", ` · fire ${this.details.fireCount}`);
    const line = new ExpandableNotificationLine(
      `${prefix}${this.theme.fg("customMessageText", sanitizeLoopText(this.details.abstract))}`,
      suffix,
      this.theme,
    );
    return line.render(width);
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

function addStringList(container: Container, theme: Theme, label: string, values: readonly string[], indent = 0): void {
  container.addChild(new Text(theme.fg("dim", `${label}:`), indent, 0));
  if (values.length === 0) {
    container.addChild(new Text(theme.fg("dim", "—"), indent + 2, 0));
    return;
  }
  for (const value of values) {
    container.addChild(new Text(`${theme.fg("dim", "•")} ${theme.fg("toolOutput", sanitizeLoopText(value))}`, indent + 2, 0));
  }
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

function statusGlyph(loop: PublicLoop, theme: Theme): string {
  if (loop.status === "paused") return theme.fg("dim", "Ⅱ");
  if (loop.lastError) return theme.fg("error", "!");
  return activeLoopGlyph(theme);
}

function loopHeading(loop: PublicLoop, theme: Theme): Text {
  return new Text(
    `${formatSemanticGlyphPrefix(statusGlyph(loop, theme))}${theme.fg("toolTitle", theme.bold(`Loop [${sanitizeLoopText(loop.id)}]`))} ${theme.fg("muted", `· ${loop.status}`)}`,
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
  const role = active > 0 ? "accent" : "dim";
  const glyph = active > 0 ? theme.bold("●") : "○";
  const label = active > 0 ? theme.bold(`Loops (${active}/${sorted.length})`) : `Loops (${active}/${sorted.length})`;
  const container = new Container();
  container.addChild(new Text(
    `${formatSemanticGlyphPrefix(theme.fg(role, glyph))}${theme.fg(role, label)}`,
    0,
    0,
  ));
  if (!expanded) return container;
  if (sorted.length === 0) {
    container.addChild(new Text(theme.fg("dim", "No loops."), 0, 0));
    return container;
  }
  for (const loop of sorted) {
    container.addChild(new Spacer(1));
    addCompleteLoop(container, loop, theme);
  }
  return container;
}

function mutationReceipt(action: LoopAction, loop: PublicLoop | undefined, changed: boolean, id: string | undefined, theme: Theme): Container {
  const container = new Container();
  const displayId = sanitizeLoopText(loop?.id ?? id ?? "unknown");
  if (!changed) {
    container.addChild(new Text(`${formatSemanticGlyphPrefix(theme.fg("dim", "○"))}${theme.fg("toolOutput", `No change · loop [${displayId}]`)}`, 0, 0));
    return container;
  }
  const verbs: Record<Exclude<LoopAction, "list" | "clear">, string> = {
    create: "Created",
    delete: "Deleted",
    modify: "Modified",
    pause: "Paused",
    resume: "Resumed",
  };
  const suffix = loop ? ` · ${loop.status}` : "";
  container.addChild(new Text(
    `${formatSemanticGlyphPrefix(theme.fg("success", "✓"))}${theme.fg("toolOutput", `${verbs[action as Exclude<LoopAction, "list" | "clear">]} loop [${displayId}]${suffix}`)}`,
    0,
    0,
  ));
  return container;
}

function clearReceipt(details: UnknownRecord, theme: Theme, expanded: boolean): Container | undefined {
  if (details.cleared !== true || typeof details.changed !== "boolean") return;
  const clearedCount = asNumber(details.clearedCount);
  const ids = stringArray(details.ids);
  if (clearedCount === undefined || !Number.isInteger(clearedCount) || clearedCount < 0 || !ids) return;
  const changed = details.changed;
  const glyph = changed ? theme.fg("success", "✓") : theme.fg("dim", "○");
  const summary = changed ? `Cleared ${clearedCount} loops` : "No loops to clear";
  const container = new Container();
  container.addChild(new Text(`${formatSemanticGlyphPrefix(glyph)}${theme.fg("toolOutput", summary)}`, 0, 0));
  if (expanded && ids.length > 0) {
    container.addChild(new Spacer(1));
    addStringList(container, theme, "Loop IDs", ids);
  }
  return container;
}

function fallbackResult(result: ToolResultLike, options: ToolResultRenderOptionsLike, theme: Theme): Component {
  const text = contentText(result.content);
  if (text) {
    const complete = options.expanded === true || options.isError === true;
    return new Text(theme.fg(options.isError ? "error" : "toolOutput", complete ? sanitizeLoopBody(text) : safeFirstLine(text)), 0, 0);
  }
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
  if (action === "clear" && details) {
    const receipt = clearReceipt(details, theme, options.expanded === true);
    if (receipt) return spacedResult(receipt);
  }

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
    return new ExpandableNotificationLine(
      theme.fg("customMessageText", safeFirstLine(content)),
      "",
      theme,
      options.outputPad ?? 0,
    );
  }

  const box = new Box(options.outputPad ?? 1, 1, (text) => theme.bg("customMessageBg", text));
  if (options.expanded !== true) {
    box.addChild(new LoopFireLine(details, theme));
    return box;
  }

  const container = new Container();
  container.addChild(new Text(
    `${formatSemanticGlyphPrefix(activeLoopGlyph(theme))}${theme.fg("toolTitle", theme.bold(`Loop [${sanitizeLoopText(details.id)}]`))} ${theme.fg("muted", `· fire ${details.fireCount}`)}`,
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
