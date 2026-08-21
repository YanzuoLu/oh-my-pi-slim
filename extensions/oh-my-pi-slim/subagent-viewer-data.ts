/**
 * Read-only data layer for the Subagent viewer.
 *
 * Everything here is pure or read-only: it clones runtime state, resolves and reads child session
 * files under a strict containment contract, and turns entries into width-safe display lines.
 * No function in this module writes a file, mutates runtime state, or touches session control.
 */

import { closeSync, lstatSync, openSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
  buildContextEntries,
  parseSessionEntries,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { RunStatus, SpecialistName, SupervisorRequest } from "./subagent-core.js";

/** Largest child session file the viewer reads whole. Larger files degrade to a read-only tail. */
export const VIEWER_MAX_FILE_BYTES = 2 * 1024 * 1024;
/** Newest context entries kept for rendering; older ones are summarized by a single hidden-count line. */
export const VIEWER_MAX_ENTRIES = 400;
/** Character budget for one rendered text block before it is tail-trimmed. */
export const VIEWER_MAX_BLOCK_CHARS = 4000;
/** Line budget for one rendered block, applied after wrapping. */
export const VIEWER_MAX_BLOCK_LINES = 120;
/** Total rendered transcript line budget, so a huge session can never produce unbounded output. */
export const VIEWER_MAX_TRANSCRIPT_LINES = 4000;
/** Character budget for one rendered tool-call argument summary. */
export const VIEWER_MAX_ARGS_CHARS = 160;
/** Character budget for the live partial response, matching the detached runner's own 2 KB bound. */
export const VIEWER_MAX_LIVE_CHARS = 2 * 1024;

const CONTROL_PATTERN = /[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;
const VIEWER_STATUSES = new Set<RunStatus>(["running", "waiting"]);

export interface ViewerActiveTool {
  readonly name: string;
  readonly startedAt?: string;
}

export interface ViewerRunActivity {
  readonly turnCount: number;
  readonly toolUses: number;
  readonly activeTools: Record<string, ViewerActiveTool>;
  readonly responseText: string;
  readonly tokens: number;
  readonly contextPercent?: number;
  readonly compactionCount: number;
}

/** One deep-cloned running or waiting run. The viewer never receives a live registry object. */
export interface ViewerRunSnapshot {
  readonly id: string;
  readonly agent: SpecialistName;
  readonly abstract: string;
  readonly status: "running" | "waiting";
  readonly live: boolean;
  readonly model: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly sessionFile?: string;
  readonly request?: SupervisorRequest;
  readonly activity: ViewerRunActivity;
}

export interface ViewerSnapshot {
  readonly runs: readonly ViewerRunSnapshot[];
  readonly childSessionDir?: string;
}

export interface ViewerTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

export function isViewerStatus(status: RunStatus): status is "running" | "waiting" {
  return VIEWER_STATUSES.has(status);
}

export function sanitizeViewerText(value: string): string {
  return stripTerminalSequences(value)
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "  ")
    .replace(CONTROL_PATTERN, " ");
}

export function sanitizeViewerInline(value: string): string {
  return sanitizeViewerText(value).replace(/\n/g, " ").trim();
}

function boundedTail(text: string, maxChars: number): { text: string; trimmed: boolean } {
  const characters = Array.from(text);
  if (characters.length <= maxChars) return { text, trimmed: false };
  return { text: characters.slice(characters.length - maxChars).join(""), trimmed: true };
}

function boundedHead(text: string, maxChars: number): string {
  const characters = Array.from(text);
  return characters.length <= maxChars ? text : `${characters.slice(0, maxChars).join("")}…`;
}

/** Every viewer line goes through this, so no rendered row can exceed the overlay width. */
export function viewerLine(text: string, width: number): string {
  return truncateToWidth(text, Math.max(1, width), "");
}

export function wrapViewerText(text: string, width: number, prefix = ""): string[] {
  const safeWidth = Math.max(1, width);
  const prefixWidth = visibleWidth(prefix);
  const bodyWidth = Math.max(1, safeWidth - prefixWidth);
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (paragraph === "") {
      lines.push(prefix === "" ? "" : viewerLine(prefix, safeWidth));
      continue;
    }
    const wrapped = wrapTextWithAnsi(paragraph, bodyWidth);
    if (wrapped.length === 0) lines.push(prefix === "" ? "" : viewerLine(prefix, safeWidth));
    for (const line of wrapped) lines.push(viewerLine(`${prefix}${line}`, safeWidth));
  }
  return lines;
}

/* ------------------------------------------------------------------------------------------------
 * Cycle navigation. Main is item 0 and every direction wraps through Main exactly once.
 * ---------------------------------------------------------------------------------------------- */

/**
 * Cycles Main and the active run IDs in one ring.
 * Returns undefined for Main, so `super+right` walks Main → first → … → last → Main.
 */
export function cycleViewerSelection(
  runIds: readonly string[],
  current: string | undefined,
  direction: 1 | -1,
): string | undefined {
  if (runIds.length === 0) return undefined;
  const items: (string | undefined)[] = [undefined, ...runIds];
  const index = current === undefined ? 0 : items.indexOf(current);
  if (index < 0) return direction === 1 ? runIds[0] : runIds[runIds.length - 1];
  return items[(index + direction + items.length) % items.length];
}

/**
 * Picks the replacement selection after the current run leaves the active set.
 * The run that took over the removed position wins, otherwise the closest earlier run, otherwise Main.
 */
export function neighborAfterViewerRemoval(
  previousIds: readonly string[],
  nextIds: readonly string[],
  removedId: string,
): string | undefined {
  if (nextIds.length === 0) return undefined;
  const index = previousIds.indexOf(removedId);
  if (index < 0) return nextIds[0];
  return nextIds[Math.min(index, nextIds.length - 1)];
}

/* ------------------------------------------------------------------------------------------------
 * Child session file access. Read-only, containment-checked, and bounded.
 * ---------------------------------------------------------------------------------------------- */

export type ViewerPathResolution =
  | { status: "ok"; path: string }
  | { status: "waiting"; reason: string }
  | { status: "rejected"; reason: string };

/**
 * Resolves a snapshot session path to a real file inside this session's child session directory.
 * Symlinks, directories, and any path that escapes the child session root are rejected outright.
 */
export function resolveViewerSessionFile(
  childSessionDir: string | undefined,
  sessionFile: string | undefined,
): ViewerPathResolution {
  if (!childSessionDir || childSessionDir.trim() === "") {
    return { status: "waiting", reason: "This session has no child session directory yet." };
  }
  if (!sessionFile || sessionFile.trim() === "") {
    return { status: "waiting", reason: "The run has not published a session file yet." };
  }
  let root: string;
  try { root = realpathSync(resolve(childSessionDir)); }
  catch { return { status: "waiting", reason: "The child session directory does not exist yet." }; }
  const requested = resolve(sessionFile);
  let target: string;
  try { target = resolve(realpathSync(dirname(requested)), basename(requested)); }
  catch { return { status: "waiting", reason: "The child session file has not been created yet." }; }
  const inside = relative(root, target);
  // Only a real `..` path segment escapes the root. A sibling-looking name such as `..foo.jsonl`
  // stays inside it, so prefix matching on ".." alone would reject a legitimate child file.
  const escapes = inside === ".." || inside.startsWith(`..${sep}`) || inside.startsWith("../");
  if (inside === "" || escapes || isAbsolute(inside)) {
    return { status: "rejected", reason: "Session file is outside this session's child session directory." };
  }
  let stat;
  try { stat = lstatSync(target); }
  catch { return { status: "waiting", reason: "The child session file has not been created yet." }; }
  if (stat.isSymbolicLink()) return { status: "rejected", reason: "Session file is a symbolic link." };
  if (!stat.isFile()) return { status: "rejected", reason: "Session file is not a regular file." };
  // TOCTOU note: the path can still be replaced between this check and the open below. That race is
  // the host's to win, and the worst case here is a bounded read-only read of another file the same
  // user already owns; the viewer never writes, executes, or follows what it reads.
  return { status: "ok", path: target };
}

/** Reads at most `maxBytes` from the end of a file without ever loading the whole thing. */
function readBoundedText(path: string, size: number, maxBytes: number): { text: string; truncated: boolean } {
  if (size <= maxBytes) return { text: readFileSync(path, "utf8"), truncated: false };
  const descriptor = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(maxBytes);
    const read = readSync(descriptor, buffer, 0, maxBytes, size - maxBytes);
    const text = buffer.subarray(0, read).toString("utf8");
    const newline = text.indexOf("\n");
    return { text: newline >= 0 ? text.slice(newline + 1) : "", truncated: true };
  } finally {
    closeSync(descriptor);
  }
}

export interface ViewerTranscript {
  /** `ok` carries entries, `waiting` means the file is not readable yet, `rejected` means refused. */
  readonly status: "ok" | "waiting" | "rejected";
  readonly entries: readonly SessionEntry[];
  readonly hiddenEntries: number;
  readonly warning?: string;
  readonly fingerprint?: string;
}

export interface ViewerTranscriptLoad {
  readonly status: "ok" | "waiting" | "rejected" | "unchanged";
  readonly transcript?: ViewerTranscript;
  readonly fingerprint?: string;
}

/** True for the one `session` header row, which is metadata rather than a branch node. */
function isSessionHeaderRow(value: unknown): boolean {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && (value as Record<string, unknown>).type === "session";
}

/**
 * Strict shape gate for one parsed JSONL row.
 *
 * `parseSessionEntries` only guarantees the line was valid JSON, so it happily returns `null`,
 * numbers, strings, and arrays. Pi's branch helpers index rows by `entry.id` and follow
 * `entry.parentId`, so anything that is not a plain object with a usable string id and a
 * `string | null | undefined` parentId must never reach them.
 */
function viewerEntryOf(value: unknown): SessionEntry | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  if (typeof row.type !== "string" || row.type === "" || row.type === "session") return undefined;
  if (typeof row.id !== "string" || row.id === "") return undefined;
  const parentId = row.parentId;
  if (parentId !== null && parentId !== undefined && (typeof parentId !== "string" || parentId === "")) {
    return undefined;
  }
  // A row that claims itself as its own parent is the cheapest possible infinite walk.
  if (parentId === row.id) return undefined;
  return value as unknown as SessionEntry;
}

type ViewerBranchCheck = { ok: true } | { ok: false; reason: string };

/**
 * Proves the parent graph is acyclic and id-unique before any Pi helper walks it.
 *
 * `buildContextEntries` follows `parentId` through an id index with no visited set, so a duplicate
 * id or any parent cycle hangs the whole process. Every node is visited at most twice here: once
 * while walking and once when the walk is proven, so the check is linear and always terminates.
 */
function checkViewerBranches(entries: readonly SessionEntry[]): ViewerBranchCheck {
  const index = new Map<string, SessionEntry>();
  for (const entry of entries) {
    if (index.has(entry.id)) return { ok: false, reason: "duplicate entry id" };
    index.set(entry.id, entry);
  }
  const proven = new Set<string>();
  const walking = new Set<string>();
  for (const entry of entries) {
    if (proven.has(entry.id)) continue;
    const chain: string[] = [];
    let current: SessionEntry | undefined = entry;
    while (current !== undefined) {
      if (proven.has(current.id)) break;
      if (walking.has(current.id)) return { ok: false, reason: "parent cycle" };
      walking.add(current.id);
      chain.push(current.id);
      // Belt and braces: no acyclic chain can be longer than the entry count.
      if (chain.length > entries.length) return { ok: false, reason: "parent chain too long" };
      const parentId = (current as { parentId?: unknown }).parentId;
      current = typeof parentId === "string" ? index.get(parentId) : undefined;
    }
    for (const id of chain) {
      walking.delete(id);
      proven.add(id);
    }
  }
  return { ok: true };
}

interface ViewerEntrySelection {
  readonly entries: SessionEntry[];
  readonly warnings: string[];
}

/**
 * Turns raw JSONL text into the entries the viewer will render.
 *
 * Never throws and never hands a possibly cyclic graph to a Pi helper. Invalid branch metadata and
 * a truncated head both degrade to bounded file order with a footer warning, because file order
 * still shows the tail a follower needs while branch resolution would collapse to one entry.
 */
function selectViewerEntries(text: string, truncated: boolean): ViewerEntrySelection {
  const warnings: string[] = [];
  try {
    const parsed = parseSessionEntries(text) as unknown as unknown[];
    const accepted: SessionEntry[] = [];
    let dropped = 0;
    for (const row of Array.isArray(parsed) ? parsed : []) {
      if (isSessionHeaderRow(row)) continue;
      const entry = viewerEntryOf(row);
      if (entry === undefined) {
        dropped += 1;
        continue;
      }
      accepted.push(entry);
    }
    if (dropped > 0) warnings.push(`${dropped} unusable entr${dropped === 1 ? "y" : "ies"} skipped.`);
    if (truncated) {
      // The head is gone, so every ancestor chain is incomplete and branch resolution would keep
      // only the last entry. The already-warned file-order tail is the useful, safe answer.
      return { entries: accepted, warnings };
    }
    const branches = checkViewerBranches(accepted);
    if (!branches.ok) {
      warnings.push(`Unusable branch metadata (${branches.reason}): showing file order.`);
      return { entries: accepted, warnings };
    }
    return { entries: buildContextEntries(accepted.slice()), warnings };
  } catch (error) {
    warnings.push(`Transcript could not be read: ${error instanceof Error ? error.message : String(error)}`);
    return { entries: [], warnings };
  }
}

function fingerprintOf(path: string): { fingerprint: string; size: number } | undefined {
  try {
    const stat = statSync(path);
    return { fingerprint: `${stat.size}:${stat.mtimeMs}:${stat.ino}`, size: stat.size };
  } catch {
    return undefined;
  }
}

/**
 * Loads one child transcript.
 * `previousFingerprint` short-circuits an unchanged file, so an idle run never re-reads its JSONL.
 */
export function loadViewerTranscript(
  childSessionDir: string | undefined,
  sessionFile: string | undefined,
  previousFingerprint?: string,
): ViewerTranscriptLoad {
  const resolved = resolveViewerSessionFile(childSessionDir, sessionFile);
  if (resolved.status !== "ok") {
    return {
      status: resolved.status,
      transcript: { status: resolved.status, entries: [], hiddenEntries: 0, warning: resolved.reason },
    };
  }
  const stat = fingerprintOf(resolved.path);
  if (!stat) {
    return {
      status: "waiting",
      transcript: {
        status: "waiting",
        entries: [],
        hiddenEntries: 0,
        warning: "The child session file has not been created yet.",
      },
    };
  }
  if (previousFingerprint !== undefined && previousFingerprint === stat.fingerprint) {
    return { status: "unchanged", fingerprint: stat.fingerprint };
  }
  let read: { text: string; truncated: boolean };
  try { read = readBoundedText(resolved.path, stat.size, VIEWER_MAX_FILE_BYTES); }
  catch (error) {
    return {
      status: "waiting",
      fingerprint: stat.fingerprint,
      transcript: {
        status: "waiting",
        entries: [],
        hiddenEntries: 0,
        warning: `Child session file is not readable: ${error instanceof Error ? error.message : String(error)}`,
        fingerprint: stat.fingerprint,
      },
    };
  }
  // parseSessionEntries drops malformed lines, which is exactly the tolerance a concurrently
  // appended tail line needs. A truncated head is dropped by readBoundedText the same way.
  // selectViewerEntries never throws, so a corrupt file still yields a cacheable fingerprint and
  // the 250 ms tick sees `unchanged` instead of re-reading and re-failing forever.
  const warnings: string[] = [];
  if (read.truncated) {
    warnings.push(`Large session file: showing only the last ${Math.round(VIEWER_MAX_FILE_BYTES / 1024)} KB in file order.`);
  }
  const selected = selectViewerEntries(read.text, read.truncated);
  warnings.push(...selected.warnings);
  const active = selected.entries;
  const hiddenEntries = Math.max(0, active.length - VIEWER_MAX_ENTRIES);
  return {
    status: "ok",
    fingerprint: stat.fingerprint,
    transcript: {
      status: "ok",
      entries: hiddenEntries > 0 ? active.slice(active.length - VIEWER_MAX_ENTRIES) : active,
      hiddenEntries,
      warning: warnings.length > 0 ? warnings.join(" ") : undefined,
      fingerprint: stat.fingerprint,
    },
  };
}

/* ------------------------------------------------------------------------------------------------
 * Entry rendering.
 * ---------------------------------------------------------------------------------------------- */

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function contentText(content: unknown, theme: ViewerTheme): string {
  if (typeof content === "string") return sanitizeViewerText(content);
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const raw of content) {
    const part = record(raw);
    if (!part) continue;
    if (part.type === "text" && typeof part.text === "string") parts.push(sanitizeViewerText(part.text));
    // Image bytes are never rendered: only a placeholder that names the media type.
    else if (part.type === "image") parts.push(theme.fg("muted", `[image ${sanitizeViewerInline(String(part.mimeType ?? "unknown"))}]`));
  }
  return parts.join("\n");
}

function argsSummary(args: unknown): string {
  if (args === undefined) return "";
  let text: string;
  try { text = JSON.stringify(args); }
  catch { return "…"; }
  if (typeof text !== "string") return "";
  return boundedHead(sanitizeViewerInline(text), VIEWER_MAX_ARGS_CHARS);
}

function blockLines(text: string, width: number, theme: ViewerTheme, prefix: string, color?: string): string[] {
  const bounded = boundedTail(text, VIEWER_MAX_BLOCK_CHARS);
  const body = bounded.trimmed ? `…${bounded.text}` : bounded.text;
  const styled = color ? body.split("\n").map((line) => theme.fg(color, line)).join("\n") : body;
  const lines = wrapViewerText(styled, width, prefix);
  if (lines.length <= VIEWER_MAX_BLOCK_LINES) return lines;
  return [
    ...lines.slice(0, VIEWER_MAX_BLOCK_LINES),
    viewerLine(`${prefix}${theme.fg("dim", `… ${lines.length - VIEWER_MAX_BLOCK_LINES} more line(s) hidden`)}`, width),
  ];
}

function heading(theme: ViewerTheme, color: string, label: string, detail: string, width: number): string {
  const tail = detail ? ` ${theme.fg("dim", detail)}` : "";
  return viewerLine(`${theme.fg(color, "▌")} ${theme.bold(theme.fg(color, label))}${tail}`, width);
}

function messageLines(message: Record<string, unknown>, width: number, theme: ViewerTheme): string[] {
  const body = Math.max(1, width - 2);
  const role = typeof message.role === "string" ? message.role : "";
  if (role === "user") {
    return [heading(theme, "accent", "user", "", width), ...blockLines(contentText(message.content, theme), body, theme, "  ")];
  }
  if (role === "assistant") {
    const lines: string[] = [];
    const content = Array.isArray(message.content) ? message.content : [];
    for (const raw of content) {
      const part = record(raw);
      if (!part) continue;
      if (part.type === "text" && typeof part.text === "string") {
        lines.push(heading(theme, "success", "assistant", "", width));
        lines.push(...blockLines(sanitizeViewerText(part.text), body, theme, "  "));
      } else if (part.type === "thinking" && typeof part.thinking === "string") {
        lines.push(heading(theme, "muted", "thinking", "", width));
        lines.push(...blockLines(sanitizeViewerText(part.thinking), body, theme, "  ", "dim"));
      } else if (part.type === "toolCall") {
        const name = sanitizeViewerInline(String(part.name ?? "tool"));
        lines.push(heading(theme, "warning", `⚙ ${name}`, argsSummary(part.arguments), width));
      }
    }
    if (lines.length === 0 && typeof message.errorMessage === "string") {
      lines.push(heading(theme, "error", "assistant error", "", width));
      lines.push(...blockLines(sanitizeViewerText(message.errorMessage), body, theme, "  ", "error"));
    }
    return lines;
  }
  if (role === "toolResult") {
    const name = sanitizeViewerInline(String(message.toolName ?? "tool"));
    const failed = message.isError === true;
    return [
      heading(theme, failed ? "error" : "dim", `↳ ${name}`, failed ? "error" : "", width),
      ...blockLines(contentText(message.content, theme), body, theme, "  ", failed ? "error" : "dim"),
    ];
  }
  if (role === "bashExecution") {
    return [
      heading(theme, "warning", "! bash", sanitizeViewerInline(String(message.command ?? "")), width),
      ...blockLines(sanitizeViewerText(String(message.output ?? "")), body, theme, "  ", "dim"),
    ];
  }
  if (role === "custom") {
    const customType = sanitizeViewerInline(String(message.customType ?? "custom"));
    if (message.display === false) return [];
    return [
      heading(theme, "accent", `[${customType}]`, "", width),
      ...blockLines(contentText(message.content, theme), body, theme, "  "),
    ];
  }
  if (role === "compactionSummary" || role === "branchSummary") {
    return [
      heading(theme, "warning", role === "compactionSummary" ? "⟳ compaction summary" : "⟳ branch summary", "", width),
      ...blockLines(sanitizeViewerText(String(message.summary ?? "")), body, theme, "  ", "dim"),
    ];
  }
  return [];
}

/** Renders one active-branch entry. Unknown and state-only entry types render nothing at all. */
export function renderViewerEntry(entry: SessionEntry, width: number, theme: ViewerTheme): string[] {
  const body = Math.max(1, width - 2);
  if (entry.type === "message") {
    const message = record((entry as { message?: unknown }).message);
    return message ? messageLines(message, width, theme) : [];
  }
  if (entry.type === "compaction") {
    const compaction = entry as { summary?: unknown; tokensBefore?: unknown };
    const detail = typeof compaction.tokensBefore === "number" ? `${compaction.tokensBefore} tokens before` : "";
    return [
      heading(theme, "warning", "⟳ compaction", detail, width),
      ...blockLines(sanitizeViewerText(String(compaction.summary ?? "")), body, theme, "  ", "dim"),
    ];
  }
  if (entry.type === "branch_summary") {
    const summary = entry as { summary?: unknown };
    return [
      heading(theme, "warning", "⟳ branch summary", "", width),
      ...blockLines(sanitizeViewerText(String(summary.summary ?? "")), body, theme, "  ", "dim"),
    ];
  }
  if (entry.type === "custom_message") {
    const custom = entry as { customType?: unknown; content?: unknown; display?: unknown };
    if (custom.display === false) return [];
    return [
      heading(theme, "accent", `[${sanitizeViewerInline(String(custom.customType ?? "custom"))}]`, "", width),
      ...blockLines(contentText(custom.content, theme), body, theme, "  "),
    ];
  }
  return [];
}

/**
 * Renders newest-first into a line budget and then restores reading order.
 * The tail is what a follower needs, so an over-budget transcript drops its oldest lines.
 */
export function renderViewerTranscript(
  transcript: ViewerTranscript,
  width: number,
  theme: ViewerTheme,
): string[] {
  const blocks: string[][] = [];
  let budget = VIEWER_MAX_TRANSCRIPT_LINES;
  let trimmed = false;
  for (let index = transcript.entries.length - 1; index >= 0; index -= 1) {
    const block = renderViewerEntry(transcript.entries[index], width, theme);
    if (block.length === 0) continue;
    if (block.length + 1 > budget) {
      trimmed = true;
      break;
    }
    blocks.push(block);
    budget -= block.length + 1;
  }
  blocks.reverse();
  const lines: string[] = [];
  if (transcript.hiddenEntries > 0) {
    lines.push(viewerLine(theme.fg("dim", `… ${transcript.hiddenEntries} older entr${transcript.hiddenEntries === 1 ? "y" : "ies"} hidden`), width));
  }
  if (trimmed) {
    lines.push(viewerLine(theme.fg("dim", "… older lines trimmed to the viewer line budget"), width));
  }
  for (const block of blocks) {
    if (lines.length > 0) lines.push("");
    lines.push(...block);
  }
  return lines;
}

/* ------------------------------------------------------------------------------------------------
 * Live overlay content: partial response, active tools, and the waiting request.
 * ---------------------------------------------------------------------------------------------- */

function normalizeForOverlap(value: string): string {
  return sanitizeViewerText(value).replace(/\s+/g, " ").trim();
}

/** Final assistant text already on disk, used to keep the live block from repeating it. */
export function lastAssistantText(transcript: ViewerTranscript): string {
  for (let index = transcript.entries.length - 1; index >= 0; index -= 1) {
    const entry = transcript.entries[index];
    if (entry.type !== "message") continue;
    const message = record((entry as { message?: unknown }).message);
    if (!message || message.role !== "assistant" || !Array.isArray(message.content)) continue;
    const text = message.content
      .map((raw) => record(raw))
      .filter((part): part is Record<string, unknown> => part?.type === "text" && typeof part.text === "string")
      .map((part) => String(part.text))
      .join("\n")
      .trim();
    if (text) return text;
  }
  return "";
}

/** True when the persisted tail already shows the same text the runner is still streaming. */
export function liveTextIsRedundant(liveText: string, persistedText: string): boolean {
  const live = normalizeForOverlap(liveText);
  if (live === "") return true;
  const persisted = normalizeForOverlap(persistedText);
  if (persisted === "") return false;
  return persisted.includes(live) || live.includes(persisted);
}

export function renderViewerLive(
  run: ViewerRunSnapshot,
  transcript: ViewerTranscript,
  width: number,
  theme: ViewerTheme,
): string[] {
  const body = Math.max(1, width - 2);
  const lines: string[] = [];
  if (run.status === "waiting" && run.request) {
    lines.push(heading(theme, "warning", "waiting", sanitizeViewerInline(run.request.reason), width));
    lines.push(...blockLines(sanitizeViewerText(run.request.message), body, theme, "  ", "warning"));
    const questions = record(run.request.interview)?.questions;
    if (Array.isArray(questions)) {
      lines.push(viewerLine(theme.fg("dim", `  interview: ${questions.length} question(s)`), width));
    }
    return lines;
  }
  const tools = Object.values(run.activity.activeTools)
    .map((tool) => sanitizeViewerInline(tool.name))
    .filter((name) => name !== "");
  if (tools.length > 0) {
    lines.push(heading(theme, "warning", "active tools", "", width));
    lines.push(viewerLine(`  ${theme.fg("warning", boundedHead(tools.join(", "), VIEWER_MAX_ARGS_CHARS))}`, width));
  }
  const live = boundedTail(sanitizeViewerText(run.activity.responseText), VIEWER_MAX_LIVE_CHARS).text.trim();
  if (live !== "" && !liveTextIsRedundant(live, lastAssistantText(transcript))) {
    lines.push(heading(theme, "success", "live response", "not yet on disk", width));
    lines.push(...blockLines(live, body, theme, "  ", "dim"));
  }
  return lines;
}
