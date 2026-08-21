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
/** Character budget for one live-overlay text block before it is tail-trimmed. */
export const VIEWER_MAX_BLOCK_CHARS = 4000;
/**
 * Character budget for one transcript block handed to a Pi component.
 *
 * A transcript block is a finished message, so its ending carries the answer, the failure, or the
 * final tool output. The budget is therefore large enough that a normal block is never cut, and a
 * block that does exceed it keeps both ends instead of a head with a misleading ellipsis.
 */
export const VIEWER_MAX_TRANSCRIPT_BLOCK_CHARS = 64 * 1024;
/** Line budget for one rendered block, applied after wrapping. */
export const VIEWER_MAX_BLOCK_LINES = 120;
/** Total rendered transcript line budget, so a huge session can never produce unbounded output. */
export const VIEWER_MAX_TRANSCRIPT_LINES = 4000;
/** Character budget for one rendered tool-call argument summary. */
export const VIEWER_MAX_ARGS_CHARS = 160;
/** Character budget for the live partial response, matching the detached runner's own 2 KB bound. */
export const VIEWER_MAX_LIVE_CHARS = 2 * 1024;

const CONTROL_PATTERN = /[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;

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

/**
 * One deep-cloned retained run, in every lifecycle status the registry keeps.
 * The viewer never receives a live registry object, and its membership is exactly the retained set.
 */
export interface ViewerRunSnapshot {
  readonly id: string;
  readonly agent: SpecialistName;
  readonly abstract: string;
  readonly status: RunStatus;
  readonly live: boolean;
  readonly model: string;
  /** The run's own working directory, used to resolve Pi's built-in tool renderers. */
  readonly cwd: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly sessionFile?: string;
  /** Set when this run continued another run's saved child session. */
  readonly sourceRunId?: string;
  /** Retained terminal result, shown in the outcome block. */
  readonly output?: string;
  readonly error?: string;
  readonly request?: SupervisorRequest;
  readonly activity: ViewerRunActivity;
  /**
   * Last entry timestamp this run is allowed to show, set only for a terminal run.
   *
   * A resumed run appends to the same child session file, so without this bound a finished source
   * run would start showing its successor's turns. Terminal runs are frozen at their own end.
   */
  readonly transcriptCutoff?: string;
}

export interface ViewerSnapshot {
  readonly runs: readonly ViewerRunSnapshot[];
  readonly childSessionDir?: string;
}

export interface ViewerTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
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

/**
 * Bounded head copy, for short inline values only: tool-call argument strings and one-line details.
 *
 * This is the head bound: it keeps the beginning and marks the cut with a trailing `…`, which is
 * correct for a value that is only ever shown as a summary. A transcript block must not use it,
 * because the trailing `…` would claim the message ends there. Use `boundViewerBlockText` instead.
 */
export function boundViewerText(text: string, maxChars: number): string {
  return boundedHead(text, Math.max(1, maxChars));
}

/**
 * Bounded head-and-tail copy used before any untrusted transcript text reaches a Pi component.
 *
 * Text within the budget is returned untouched, so an ordinary block is never truncated. Beyond it,
 * the head and the tail together stay inside the budget and an explicit marker states how many code
 * points were dropped between them. The real ending is always present, so the block can never end
 * in an ellipsis that hides the last thing the child actually said.
 */
export function boundViewerBlockText(
  text: string,
  maxChars: number = VIEWER_MAX_TRANSCRIPT_BLOCK_CHARS,
): string {
  const budget = Math.max(1, Math.floor(maxChars));
  // Code points, not UTF-16 units: a budget must never split a surrogate pair.
  const characters = Array.from(text);
  if (characters.length <= budget) return text;
  // The tail wins the odd character: the ending is the part that must survive.
  const tailBudget = Math.max(1, Math.ceil(budget / 2));
  const headBudget = budget - tailBudget;
  const omitted = characters.length - headBudget - tailBudget;
  const tail = characters.slice(characters.length - tailBudget).join("");
  const marker = `… ${omitted} characters omitted …`;
  if (headBudget <= 0) return `${marker}\n${tail}`;
  return `${characters.slice(0, headBudget).join("")}\n${marker}\n${tail}`;
}

/**
 * Human-readable elapsed time for the bottom status row.
 * The row repaints on a one-second bucket, so the format never shows sub-second digits.
 */
export function formatViewerElapsed(startedAt: string, nowMs: number): string {
  const started = Date.parse(startedAt);
  if (!Number.isFinite(started) || !Number.isFinite(nowMs)) return "—";
  const seconds = Math.max(0, Math.floor((nowMs - started) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
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
 * Cycles Main and the retained run IDs in one ring.
 * Returns undefined for Main, so `ctrl+shift+right` walks Main → first → … → last → Main.
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
 * Picks the replacement selection after the current run leaves the retained set, which only
 * `subagent clear` can do.
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
  /**
   * Stable digest of the selected entries, independent of the file's size and mtime.
   *
   * A resumed run appends to the same file, so a finished source run keeps seeing a new fingerprint
   * for content its cutoff already excludes. Comparing this key instead keeps that read from
   * rebuilding an unchanged body.
   */
  readonly contentKey?: string;
}

export interface ViewerTranscriptLoad {
  readonly status: "ok" | "waiting" | "rejected" | "unchanged";
  readonly transcript?: ViewerTranscript;
  readonly fingerprint?: string;
  readonly contentKey?: string;
}

export interface ViewerTranscriptLoadOptions {
  /** File identity from the previous read; an identical one skips the read entirely. */
  readonly previousFingerprint?: string;
  /** Selected-entry digest from the previous read; an identical one skips the rebuild. */
  readonly previousContentKey?: string;
  /** Terminal runs never show an entry newer than this ISO timestamp. */
  readonly cutoff?: string;
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
 * Keeps only the entries a terminal run is allowed to show.
 *
 * Fail-closed by construction: with a cutoff in force, an entry whose outer timestamp is missing or
 * unparsable is dropped rather than trusted, so appended continuation turns can never reappear in a
 * finished run's transcript by omitting or corrupting their timestamp.
 */
function applyViewerCutoff(
  entries: readonly SessionEntry[],
  cutoff: string | undefined,
): { entries: SessionEntry[]; skipped: number } {
  if (cutoff === undefined) return { entries: [...entries], skipped: 0 };
  const limit = Date.parse(cutoff);
  if (!Number.isFinite(limit)) return { entries: [...entries], skipped: 0 };
  const kept: SessionEntry[] = [];
  let skipped = 0;
  for (const entry of entries) {
    const stamp = (entry as { timestamp?: unknown }).timestamp;
    const parsed = typeof stamp === "string" ? Date.parse(stamp) : Number.NaN;
    if (!Number.isFinite(parsed)) {
      skipped += 1;
      continue;
    }
    if (parsed <= limit) kept.push(entry);
    else skipped += 1;
  }
  return { entries: kept, skipped };
}

/**
 * Stable digest of the selected entries.
 *
 * Covers the id and timestamp of every selected entry plus the count, which is exactly what decides
 * whether the rendered body can change. It is a display cache key, never a security check, so a
 * cheap non-cryptographic rolling hash is the right tool.
 */
export function viewerContentKey(entries: readonly SessionEntry[]): string {
  let hash = 0x811c9dc5;
  const mix = (text: string): void => {
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
  };
  for (const entry of entries) {
    mix(String((entry as { id?: unknown }).id ?? ""));
    mix("\u0000");
    mix(String((entry as { timestamp?: unknown }).timestamp ?? ""));
    mix("\u0001");
  }
  return `${entries.length}:${hash.toString(36)}`;
}

/**
 * Turns raw JSONL text into the entries the viewer will render.
 *
 * Never throws and never hands a possibly cyclic graph to a Pi helper. Invalid branch metadata and
 * a truncated head both degrade to bounded file order with a footer warning, because file order
 * still shows the tail a follower needs while branch resolution would collapse to one entry.
 */
function selectViewerEntries(text: string, truncated: boolean, cutoff?: string): ViewerEntrySelection {
  const warnings: string[] = [];
  try {
    const parsed = parseSessionEntries(text) as unknown as unknown[];
    const shaped: SessionEntry[] = [];
    let dropped = 0;
    for (const row of Array.isArray(parsed) ? parsed : []) {
      if (isSessionHeaderRow(row)) continue;
      const entry = viewerEntryOf(row);
      if (entry === undefined) {
        dropped += 1;
        continue;
      }
      shaped.push(entry);
    }
    if (dropped > 0) warnings.push(`${dropped} unusable entr${dropped === 1 ? "y" : "ies"} skipped.`);
    // The cutoff runs after the shape gate and before any cycle or branch work, so a resumed run's
    // later entries never take part in this run's branch resolution either.
    const bounded = applyViewerCutoff(shaped, cutoff);
    const accepted = bounded.entries;
    if (bounded.skipped > 0) {
      warnings.push(`${bounded.skipped} entr${bounded.skipped === 1 ? "y" : "ies"} after this run finished ${bounded.skipped === 1 ? "was" : "were"} excluded.`);
    }
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
 * True when two loads describe the same visible transcript.
 *
 * The content key decides it whenever both sides have one. Loads without a key are the empty
 * waiting and rejected results, where the status and the reason are the whole content, so an
 * identical pair must not be treated as new content and rebuilt.
 */
export function sameViewerTranscript(
  left: ViewerTranscript | undefined,
  right: ViewerTranscript | undefined,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  if (left.status !== right.status || left.warning !== right.warning) return false;
  if (left.hiddenEntries !== right.hiddenEntries || left.entries.length !== right.entries.length) return false;
  if (left.contentKey !== undefined || right.contentKey !== undefined) return left.contentKey === right.contentKey;
  return left.entries.length === 0;
}

/**
 * Loads one child transcript.
 *
 * Two independent short circuits keep an idle or finished run cheap: an unchanged file identity
 * skips the read, and an unchanged selected-entry digest skips the rebuild even when a resumed run
 * appended to the same file.
 */
export function loadViewerTranscript(
  childSessionDir: string | undefined,
  sessionFile: string | undefined,
  options: ViewerTranscriptLoadOptions = {},
): ViewerTranscriptLoad {
  const { previousFingerprint, previousContentKey, cutoff } = options;
  // A run with no readable file must answer the same way on every poll, so these results carry a
  // content key too: an unchanged reason returns `unchanged` instead of a fresh transcript object
  // the caller would treat as new content and rebuild for.
  const pending = (
    status: "waiting" | "rejected",
    reason: string,
    fingerprint?: string,
  ): ViewerTranscriptLoad => {
    const key = `${status}:${reason}`;
    if (previousContentKey === key) return { status: "unchanged", contentKey: key, fingerprint };
    return {
      status,
      contentKey: key,
      fingerprint,
      transcript: { status, entries: [], hiddenEntries: 0, warning: reason, fingerprint, contentKey: key },
    };
  };
  const resolved = resolveViewerSessionFile(childSessionDir, sessionFile);
  if (resolved.status !== "ok") return pending(resolved.status, resolved.reason);
  const stat = fingerprintOf(resolved.path);
  if (!stat) return pending("waiting", "The child session file has not been created yet.");
  if (previousFingerprint !== undefined && previousFingerprint === stat.fingerprint) {
    return { status: "unchanged", fingerprint: stat.fingerprint };
  }
  let read: { text: string; truncated: boolean };
  try { read = readBoundedText(resolved.path, stat.size, VIEWER_MAX_FILE_BYTES); }
  catch (error) {
    return pending(
      "waiting",
      `Child session file is not readable: ${error instanceof Error ? error.message : String(error)}`,
      stat.fingerprint,
    );
  }
  // parseSessionEntries drops malformed lines, which is exactly the tolerance a concurrently
  // appended tail line needs. A truncated head is dropped by readBoundedText the same way.
  // selectViewerEntries never throws, so a corrupt file still yields a cacheable fingerprint and
  // the 250 ms tick sees `unchanged` instead of re-reading and re-failing forever.
  const warnings: string[] = [];
  if (read.truncated) {
    warnings.push(`Large session file: showing only the last ${Math.round(VIEWER_MAX_FILE_BYTES / 1024)} KB in file order.`);
  }
  const selected = selectViewerEntries(read.text, read.truncated, cutoff);
  warnings.push(...selected.warnings);
  const active = selected.entries;
  const hiddenEntries = Math.max(0, active.length - VIEWER_MAX_ENTRIES);
  const entries = hiddenEntries > 0 ? active.slice(active.length - VIEWER_MAX_ENTRIES) : active;
  const contentKey = viewerContentKey(entries);
  if (previousContentKey !== undefined && previousContentKey === contentKey) {
    // The file grew, but nothing this run may show changed. The caller records the new file
    // identity and keeps the body it already built.
    return { status: "unchanged", fingerprint: stat.fingerprint, contentKey };
  }
  return {
    status: "ok",
    fingerprint: stat.fingerprint,
    contentKey,
    transcript: {
      status: "ok",
      entries,
      hiddenEntries,
      warning: warnings.length > 0 ? warnings.join(" ") : undefined,
      fingerprint: stat.fingerprint,
      contentKey,
    },
  };
}

/* ------------------------------------------------------------------------------------------------
 * Shared helpers for the live block. Transcript entries are rendered by Pi's own components in
 * subagent-viewer-transcript.ts, so this module keeps only bounded text utilities.
 * ---------------------------------------------------------------------------------------------- */

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
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

function liveHeading(theme: ViewerTheme, color: string, label: string, detail: string, width: number): string {
  const tail = detail ? ` ${theme.fg("dim", detail)}` : "";
  return viewerLine(`${theme.fg(color, "▌")} ${theme.bold(theme.fg(color, label))}${tail}`, width);
}

function firstLine(text: string): string {
  return text.split("\n").find((line) => line.trim() !== "")?.trim() ?? "";
}

function lastLine(text: string): string {
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  return lines.length > 0 ? lines[lines.length - 1].trim() : "";
}

export interface ViewerLiveOptions {
  /** Pi's one global tool-output expansion state, shared with the Main transcript. */
  readonly expanded: boolean;
  /** Ready-made ` · <key> to expand` hint, produced from the user's real keybinding. */
  readonly expandHint: string;
}

/**
 * Live overlay content for one run: the waiting request, active tools, and the partial response
 * that has not reached the child session file yet.
 *
 * Collapsed mode mirrors the package widgets: one summary line per section plus the expand hint.
 */
export function renderViewerLive(
  run: ViewerRunSnapshot,
  transcript: ViewerTranscript,
  width: number,
  theme: ViewerTheme,
  options: ViewerLiveOptions,
): string[] {
  const body = Math.max(1, width - 2);
  const lines: string[] = [];
  const hint = options.expanded ? "" : theme.fg("dim", options.expandHint);
  if (run.status === "waiting" && run.request) {
    const message = sanitizeViewerText(run.request.message);
    lines.push(`${liveHeading(theme, "warning", "waiting", sanitizeViewerInline(run.request.reason), width)}`);
    if (!options.expanded) {
      lines.push(viewerLine(`  ${theme.fg("warning", boundedHead(firstLine(message), VIEWER_MAX_ARGS_CHARS))}${hint}`, width));
      return lines;
    }
    lines.push(...blockLines(message, body, theme, "  ", "warning"));
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
    if (options.expanded) {
      lines.push(liveHeading(theme, "warning", "active tools", "", width));
      lines.push(viewerLine(`  ${theme.fg("warning", boundedHead(tools.join(", "), VIEWER_MAX_ARGS_CHARS))}`, width));
    } else {
      lines.push(viewerLine(
        `${liveHeading(theme, "warning", "active tools", `${tools.length}`, width)}${hint}`,
        width,
      ));
    }
  }
  const live = boundedTail(sanitizeViewerText(run.activity.responseText), VIEWER_MAX_LIVE_CHARS).text.trim();
  if (live !== "" && !liveTextIsRedundant(live, lastAssistantText(transcript))) {
    lines.push(liveHeading(theme, "success", "live response", "not yet on disk", width));
    if (options.expanded) lines.push(...blockLines(live, body, theme, "  ", "dim"));
    else lines.push(viewerLine(`  ${theme.fg("dim", boundedHead(lastLine(live), VIEWER_MAX_ARGS_CHARS))}${hint}`, width));
  }
  return lines;
}
