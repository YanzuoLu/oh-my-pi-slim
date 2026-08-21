/**
 * Main-styled transcript body for the read-only Subagent viewer.
 *
 * Every row the viewer shows for a child run is produced by Pi's own root-exported transcript
 * components, so colors, Markdown, spacing, tool framing, and collapsed semantics match the Main
 * transcript by construction instead of by imitation. This module owns three jobs:
 *
 * 1. Turn bounded, sanitized child entries into the same component blocks Main builds.
 * 2. Render those blocks into width-safe lines, with one block failing in isolation.
 * 3. Release every component it built when the body is replaced or the viewer closes.
 *
 * It never executes a child extension's renderer, never hands raw image bytes to a component, and
 * never writes anything: even the presentation settings are read with a plain `readFileSync`, so
 * opening the viewer can never create a directory, a lock file, or a settings file.
 */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  AssistantMessageComponent,
  BashExecutionComponent,
  BranchSummaryMessageComponent,
  CompactionSummaryMessageComponent,
  CustomMessageComponent,
  SkillInvocationMessageComponent,
  ToolExecutionComponent,
  UserMessageComponent,
  getAgentDir,
  getMarkdownTheme,
  parseSkillBlock,
  sessionEntryToContextMessages,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { Spacer, Text, type Component, type MarkdownTheme, type TUI } from "@earendil-works/pi-tui";
import {
  VIEWER_MAX_ARGS_CHARS,
  VIEWER_MAX_BLOCK_CHARS,
  VIEWER_MAX_TRANSCRIPT_LINES,
  boundViewerText,
  sanitizeViewerInline,
  sanitizeViewerText,
  viewerLine,
  type ViewerTheme,
  type ViewerTranscript,
} from "./subagent-viewer-data.js";

/** Shell-integration zone markers Pi's assistant component emits around a Main prompt boundary. */
const PROMPT_ZONE_PATTERN = /\x1b\]133;[A-C](?:;[^\x07\x1b]*)?(?:\x07|\x1b\\)/g;
/** Depth limit for the sanitized copy of tool-call arguments handed to a built-in renderer. */
const ARGS_MAX_DEPTH = 6;
/** Key and element limits for that copy, so a hostile argument object cannot explode the render. */
const ARGS_MAX_KEYS = 64;
const ARGS_MAX_ITEMS = 64;

export interface ViewerTranscriptSettings {
  readonly outputPad: 0 | 1;
  readonly codeBlockIndent: string;
  readonly hideThinkingBlock: boolean;
}

/** Pi's own defaults for the three settings the viewer reads, used whenever a value is missing. */
export const VIEWER_DEFAULT_SETTINGS: ViewerTranscriptSettings = {
  outputPad: 1,
  codeBlockIndent: "  ",
  hideThinkingBlock: false,
};

/** File name of both the global and the project settings file. */
const SETTINGS_FILE = "settings.json";
/** Project-local settings live under Pi's config directory, and only a trusted project is read. */
const PROJECT_SETTINGS_RELATIVE = ".pi/settings.json";

/**
 * The single read seam.
 * Production passes `readFileSync`; tests pass a fake so the assertions never touch a real file.
 */
export type ViewerSettingsFileReader = (path: string) => string;

const defaultSettingsFileReader: ViewerSettingsFileReader = (path) => readFileSync(path, "utf-8");

/** One settings layer, or undefined when the file is missing, unreadable, or not a JSON object. */
function readSettingsLayer(
  path: string,
  readFile: ViewerSettingsFileReader,
): Record<string, unknown> | undefined {
  try {
    return record(JSON.parse(readFile(path)) as unknown);
  } catch {
    return undefined;
  }
}

/**
 * Reads the same presentation settings the Main transcript uses, with a strictly read-only path.
 *
 * Pi's own settings manager is deliberately not used: constructing it takes a lock and can create
 * files next to the host's own settings, which a read-only viewer must never do. The layering is
 * the same one Pi applies — a value defined by a trusted project overrides the global value — and
 * every missing or invalid field falls back to Pi's own default.
 */
export function readViewerTranscriptSettings(
  cwd: string | undefined,
  projectTrusted: boolean,
  readFile: ViewerSettingsFileReader = defaultSettingsFileReader,
): ViewerTranscriptSettings {
  const layers: Record<string, unknown>[] = [];
  let agentDir: string | undefined;
  try { agentDir = getAgentDir(); }
  catch { agentDir = undefined; }
  const global = agentDir === undefined ? undefined : readSettingsLayer(join(agentDir, SETTINGS_FILE), readFile);
  if (global) layers.push(global);
  if (cwd && cwd.trim() !== "" && projectTrusted) {
    const project = readSettingsLayer(resolve(cwd, PROJECT_SETTINGS_RELATIVE), readFile);
    if (project) layers.push(project);
  }

  let rawOutputPad: unknown;
  let rawCodeBlockIndent: unknown;
  let rawHideThinkingBlock: unknown;
  for (const layer of layers) {
    if (layer.outputPad !== undefined) rawOutputPad = layer.outputPad;
    if (layer.hideThinkingBlock !== undefined) rawHideThinkingBlock = layer.hideThinkingBlock;
    const markdown = record(layer.markdown);
    if (markdown?.codeBlockIndent !== undefined) rawCodeBlockIndent = markdown.codeBlockIndent;
  }
  return {
    // Pi reads this as "0 means no padding, anything else means one column".
    outputPad: rawOutputPad === undefined ? VIEWER_DEFAULT_SETTINGS.outputPad : rawOutputPad === 0 ? 0 : 1,
    codeBlockIndent: typeof rawCodeBlockIndent === "string"
      ? rawCodeBlockIndent
      : VIEWER_DEFAULT_SETTINGS.codeBlockIndent,
    hideThinkingBlock: rawHideThinkingBlock === true,
  };
}

export function viewerSettingsKey(settings: ViewerTranscriptSettings): string {
  return `${settings.outputPad}:${settings.hideThinkingBlock ? 1 : 0}:${settings.codeBlockIndent}`;
}

function markdownThemeFor(settings: ViewerTranscriptSettings): MarkdownTheme {
  return { ...getMarkdownTheme(), codeBlockIndent: settings.codeBlockIndent } as MarkdownTheme;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/**
 * Deep copy of tool-call arguments with every string sanitized and bounded.
 * Built-in renderers read fields such as `path` or `command`, so the shape is preserved while the
 * content stays terminal-safe and bounded in depth, width, and element count.
 */
function sanitizeArgs(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return boundViewerText(sanitizeViewerText(value), VIEWER_MAX_ARGS_CHARS * 4);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (depth >= ARGS_MAX_DEPTH) return undefined;
  if (Array.isArray(value)) {
    return value.slice(0, ARGS_MAX_ITEMS).map((item) => sanitizeArgs(item, depth + 1));
  }
  const object = record(value);
  if (!object) return undefined;
  const copy: Record<string, unknown> = {};
  for (const key of Object.keys(object).slice(0, ARGS_MAX_KEYS)) {
    const sanitized = sanitizeArgs(object[key], depth + 1);
    if (sanitized !== undefined) copy[sanitizeViewerInline(key)] = sanitized;
  }
  return copy;
}

/** Text content parts, sanitized and bounded. Image parts become a placeholder, never bytes. */
function sanitizeContentParts(content: unknown): { type: "text"; text: string }[] {
  if (typeof content === "string") {
    return [{ type: "text", text: boundViewerText(sanitizeViewerText(content), VIEWER_MAX_BLOCK_CHARS) }];
  }
  if (!Array.isArray(content)) return [];
  const parts: { type: "text"; text: string }[] = [];
  for (const raw of content) {
    const part = record(raw);
    if (!part) continue;
    if (part.type === "text" && typeof part.text === "string") {
      parts.push({ type: "text", text: boundViewerText(sanitizeViewerText(part.text), VIEWER_MAX_BLOCK_CHARS) });
    } else if (part.type === "image") {
      // The placeholder replaces the part entirely: no `data` field ever reaches a component.
      parts.push({ type: "text", text: `[image ${sanitizeViewerInline(String(part.mimeType ?? "unknown"))}]` });
    }
  }
  return parts;
}

function contentPlainText(content: unknown): string {
  return sanitizeContentParts(content).map((part) => part.text).join("\n");
}

interface SanitizedAssistant {
  readonly content: unknown[];
  readonly toolCalls: { id: string; name: string; args: unknown }[];
}

function sanitizeAssistant(message: Record<string, unknown>): SanitizedAssistant {
  const content: unknown[] = [];
  const toolCalls: { id: string; name: string; args: unknown }[] = [];
  const parts = Array.isArray(message.content) ? message.content : [];
  for (const raw of parts) {
    const part = record(raw);
    if (!part) continue;
    if (part.type === "text" && typeof part.text === "string") {
      content.push({ type: "text", text: boundViewerText(sanitizeViewerText(part.text), VIEWER_MAX_BLOCK_CHARS) });
    } else if (part.type === "thinking" && typeof part.thinking === "string") {
      content.push({
        type: "thinking",
        thinking: boundViewerText(sanitizeViewerText(part.thinking), VIEWER_MAX_BLOCK_CHARS),
      });
    } else if (part.type === "toolCall") {
      const id = typeof part.id === "string" && part.id !== "" ? part.id : `tool-${toolCalls.length}`;
      const name = sanitizeViewerInline(String(part.name ?? "tool")) || "tool";
      const args = sanitizeArgs(part.arguments) ?? {};
      content.push({ type: "toolCall", id, name, arguments: args });
      toolCalls.push({ id, name, args });
    }
  }
  return { content, toolCalls };
}

interface ViewerBlock {
  readonly label: string;
  readonly components: Component[];
}

interface ToolBlockRef {
  readonly component: ToolExecutionComponent;
}

/**
 * Seam for the one component the viewer must construct before it can fill it in.
 * Production builds Pi's own `BashExecutionComponent`; tests substitute a component that throws.
 */
export type ViewerBashComponentFactory = (
  command: string,
  tui: TUI,
  excludeFromContext: boolean,
) => BashExecutionComponent;

export interface ViewerTranscriptBodyInput {
  readonly transcript: ViewerTranscript | undefined;
  readonly tui: TUI;
  readonly theme: ViewerTheme;
  readonly cwd: string | undefined;
  readonly expanded: boolean;
  readonly settings: ViewerTranscriptSettings;
  readonly bashComponent?: ViewerBashComponentFactory;
}

function expandable(component: Component): component is Component & { setExpanded(expanded: boolean): void } {
  return typeof (component as { setExpanded?: unknown }).setExpanded === "function";
}

function disposable(component: Component): component is Component & { dispose(): void } {
  return typeof (component as { dispose?: unknown }).dispose === "function";
}

/**
 * Stops a half-constructed bash row.
 *
 * `new BashExecutionComponent(...)` starts a `Loader`, and that loader owns a live 80 ms interval
 * from the moment the constructor returns. If filling the component in throws, the component is
 * dropped on the floor, so `setComplete` is called first: it is the public way to stop that timer.
 * Disposal follows only when the host build really exposes it.
 */
function releaseBashComponent(component: BashExecutionComponent): void {
  try { component.setComplete(undefined, true); }
  catch { /* a component that refuses to complete cannot be helped any further */ }
  const asComponent = component as unknown as Component;
  if (!disposable(asComponent)) return;
  try { asComponent.dispose(); }
  catch { /* best-effort release */ }
}

/**
 * One built transcript body.
 *
 * The component tree is built once per transcript identity and reused across scrolling, activity
 * ticks, and clock ticks. Only a new transcript, a new run cwd, a settings change, an expansion
 * change, or a width change rebuilds it.
 */
export class ViewerTranscriptBody {
  private readonly blocks: ViewerBlock[];
  private readonly theme: ViewerTheme;
  private readonly leadingNotes: string[];
  private lineCache: { width: number; lines: string[] } | undefined;
  private disposed = false;

  constructor(blocks: ViewerBlock[], theme: ViewerTheme, leadingNotes: string[]) {
    this.blocks = blocks;
    this.theme = theme;
    this.leadingNotes = leadingNotes;
  }

  setExpanded(expanded: boolean): void {
    for (const block of this.blocks) {
      for (const component of block.components) {
        if (!expandable(component)) continue;
        try { component.setExpanded(expanded); }
        catch { /* one stubborn component must not break the whole body */ }
      }
    }
    this.lineCache = undefined;
  }

  invalidate(): void {
    for (const block of this.blocks) {
      for (const component of block.components) {
        try { component.invalidate(); }
        catch { /* a component that refuses to invalidate still renders from its own cache */ }
      }
    }
    this.lineCache = undefined;
  }

  /** Width-safe lines for the whole body, tail-trimmed to the transcript line budget. */
  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    if (this.lineCache && this.lineCache.width === safeWidth) return this.lineCache.lines;
    const rendered: string[] = [];
    for (const note of this.leadingNotes) rendered.push(viewerLine(this.theme.fg("dim", note), safeWidth));
    for (const block of this.blocks) {
      // A single malformed entry may make one Pi component throw. That block degrades to a note and
      // the rest of the transcript keeps rendering.
      try {
        for (const component of block.components) {
          for (const line of component.render(safeWidth)) {
            rendered.push(viewerLine(line.replace(PROMPT_ZONE_PATTERN, ""), safeWidth));
          }
        }
      } catch (error) {
        rendered.push(viewerLine(
          this.theme.fg("warning", `[${block.label} could not be rendered: ${sanitizeViewerInline(error instanceof Error ? error.message : String(error))}]`),
          safeWidth,
        ));
      }
    }
    const lines = rendered.length > VIEWER_MAX_TRANSCRIPT_LINES
      ? [
        viewerLine(this.theme.fg("dim", "… older lines trimmed to the viewer line budget"), safeWidth),
        ...rendered.slice(rendered.length - VIEWER_MAX_TRANSCRIPT_LINES),
      ]
      : rendered;
    this.lineCache = { width: safeWidth, lines };
    return lines;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const block of this.blocks) {
      for (const component of block.components) {
        if (!disposable(component)) continue;
        try { component.dispose(); }
        catch { /* best-effort release */ }
      }
    }
    this.blocks.length = 0;
    this.lineCache = undefined;
  }
}

function emptyBodyNote(transcript: ViewerTranscript | undefined): string {
  if (!transcript) return "Loading transcript…";
  if (transcript.status === "waiting") return transcript.warning ?? "Waiting for the child session file…";
  if (transcript.status === "rejected") return transcript.warning ?? "Child session file was refused.";
  return "No messages yet.";
}

/**
 * Builds the Main-styled component blocks for one child transcript.
 * Mirrors `renderSessionItems`: same component per message role, same spacers, same expansion state.
 */
export function buildViewerTranscriptBody(input: ViewerTranscriptBodyInput): ViewerTranscriptBody {
  const { transcript, tui, theme, expanded, settings } = input;
  const makeBashComponent: ViewerBashComponentFactory = input.bashComponent
    ?? ((command, hostTui, excludeFromContext) => new BashExecutionComponent(command, hostTui, excludeFromContext));
  const markdownTheme = markdownThemeFor(settings);
  const blocks: ViewerBlock[] = [];
  const notes: string[] = [];
  const cwd = input.cwd && input.cwd.trim() !== "" ? input.cwd : process.cwd();
  if (transcript && transcript.hiddenEntries > 0) {
    notes.push(`… ${transcript.hiddenEntries} older entr${transcript.hiddenEntries === 1 ? "y" : "ies"} hidden`);
  }

  const pendingTools = new Map<string, ToolBlockRef>();
  const push = (label: string, components: Component[]): void => {
    if (components.length === 0) return;
    for (const component of components) {
      if (expandable(component)) {
        try { component.setExpanded(expanded); }
        catch { /* the block still renders in its default state */ }
      }
    }
    blocks.push({ label, components });
  };
  const leadingSpacer = (): Component[] => (blocks.length > 0 ? [new Spacer(1)] : []);

  const noteBlock = (reason: unknown): void => {
    blocks.push({
      label: "entry",
      components: [new Text(
        theme.fg("warning", `[entry could not be built: ${sanitizeViewerInline(reason instanceof Error ? reason.message : String(reason))}]`),
        settings.outputPad,
        0,
      )],
    });
  };

  for (const entry of transcript?.entries ?? []) {
    let messages: unknown[];
    // A hostile or corrupt entry can throw inside Pi's own projection helper, so the failure is
    // reported as one visible block instead of silently dropping the entry.
    try { messages = sessionEntryToContextMessages(entry as SessionEntry) as unknown[]; }
    catch (error) {
      noteBlock(error);
      messages = [];
    }
    for (const raw of messages) {
      const message = record(raw);
      if (!message) continue;
      try {
        if (message.role === "user") {
          const text = contentPlainText(message.content);
          if (text.trim() === "") continue;
          const skill = (() => {
            try { return parseSkillBlock(text); }
            catch { return undefined; }
          })();
          if (skill) {
            push("skill invocation", [
              ...leadingSpacer(),
              new SkillInvocationMessageComponent(skill, markdownTheme),
            ]);
            const userText = record(skill)?.userMessage;
            if (typeof userText === "string" && userText.trim() !== "") {
              push("user message", [new Spacer(1), new UserMessageComponent(userText, markdownTheme, settings.outputPad, [])]);
            }
            continue;
          }
          push("user message", [
            ...leadingSpacer(),
            new UserMessageComponent(text, markdownTheme, settings.outputPad, []),
          ]);
          continue;
        }
        if (message.role === "assistant") {
          const sanitized = sanitizeAssistant(message);
          const assistantMessage = { ...message, content: sanitized.content } as never;
          push("assistant message", [
            new AssistantMessageComponent(
              assistantMessage,
              settings.hideThinkingBlock,
              markdownTheme,
              "Thinking...",
              settings.outputPad,
              [],
            ),
          ]);
          for (const call of sanitized.toolCalls) {
            // No tool definition is passed: the component resolves Pi's own built-in renderers by
            // name, which is exactly what Main does for a tool the session did not register.
            const component = new ToolExecutionComponent(
              call.name,
              call.id,
              call.args,
              { showImages: false },
              undefined,
              tui,
              cwd,
            );
            push(`tool ${call.name}`, [component]);
            pendingTools.set(call.id, { component });
          }
          continue;
        }
        if (message.role === "toolResult") {
          const toolCallId = typeof message.toolCallId === "string" ? message.toolCallId : "";
          const pending = pendingTools.get(toolCallId);
          if (!pending) continue;
          pendingTools.delete(toolCallId);
          pending.component.updateResult({
            content: sanitizeContentParts(message.content),
            details: undefined,
            isError: message.isError === true,
          });
          continue;
        }
        if (message.role === "custom") {
          if (message.display === false) continue;
          const safeMessage = {
            ...message,
            content: sanitizeContentParts(message.content),
            // A child extension's renderer is never resolved or executed by the viewer.
            details: undefined,
          } as never;
          push("custom message", [new CustomMessageComponent(safeMessage, undefined, markdownTheme, settings.outputPad)]);
          continue;
        }
        if (message.role === "compactionSummary") {
          const safeMessage = {
            ...message,
            summary: boundViewerText(sanitizeViewerText(String(message.summary ?? "")), VIEWER_MAX_BLOCK_CHARS),
          } as never;
          push("compaction summary", [new Spacer(1), new CompactionSummaryMessageComponent(safeMessage, markdownTheme)]);
          continue;
        }
        if (message.role === "branchSummary") {
          const safeMessage = {
            ...message,
            summary: boundViewerText(sanitizeViewerText(String(message.summary ?? "")), VIEWER_MAX_BLOCK_CHARS),
          } as never;
          push("branch summary", [new Spacer(1), new BranchSummaryMessageComponent(safeMessage, markdownTheme)]);
          continue;
        }
        if (message.role === "bashExecution") {
          const command = sanitizeViewerInline(String(message.command ?? ""));
          const component = makeBashComponent(command, tui, message.excludeFromContext === true);
          let ready = false;
          try {
            const output = boundViewerText(sanitizeViewerText(String(message.output ?? "")), VIEWER_MAX_BLOCK_CHARS);
            if (output) component.appendOutput(output);
            // Completing immediately stops the component's own spinner timer, which a read-only
            // viewer must never leave running.
            component.setComplete(
              typeof message.exitCode === "number" ? message.exitCode : undefined,
              message.cancelled === true,
            );
            ready = true;
          } finally {
            // A throw anywhere above leaves a component nobody will ever render, with its loader
            // timer still ticking. It is stopped here, before the entry degrades to a note.
            if (!ready) releaseBashComponent(component);
          }
          push("bash execution", [component]);
          continue;
        }
      } catch (error) {
        noteBlock(error);
      }
    }
  }

  if (blocks.length === 0) {
    blocks.push({
      label: "empty transcript",
      components: [new Text(theme.fg("dim", emptyBodyNote(transcript)), settings.outputPad, 0)],
    });
  }
  if (transcript?.warning && transcript.status === "ok") notes.push(sanitizeViewerInline(transcript.warning));
  return new ViewerTranscriptBody(blocks, theme, notes);
}
