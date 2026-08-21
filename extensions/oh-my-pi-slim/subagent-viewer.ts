/**
 * Read-only Subagent viewer.
 *
 * The viewer is a single full-screen overlay that owns its own layout. Row 0 is already transcript:
 * every identity, activity, and navigation row lives at the bottom, in the same place the Main UI
 * keeps its dock. The transcript itself is rendered by Pi's own transcript components, so it reads
 * like Main rather than like a second, competing renderer.
 *
 * The viewer never writes: no session entry, no control file, no run file, no session switch,
 * no editor replacement, and no draft mutation. Its only host-state interaction is Pi's single
 * global tool-output expansion flag, which Main and every run deliberately share.
 */

import {
  Key,
  matchesKey,
  visibleWidth,
  type Component,
  type Focusable,
  type KeybindingsManager,
  type OverlayHandle,
  type TUI,
} from "@earendil-works/pi-tui";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { RunStatus } from "./subagent-core.js";
import { formatSubagentModel } from "./subagent-model-display.js";
import { formatWidgetTokens, formatWidgetTurns } from "./subagent-widget-display.js";
import { readWidgetExpanded, widgetExpandHint, widgetExpandKey } from "./widget-expansion.js";
import {
  cycleViewerSelection,
  formatViewerElapsed,
  loadViewerTranscript,
  neighborAfterViewerRemoval,
  renderViewerLive,
  sameViewerTranscript,
  sanitizeViewerInline,
  sanitizeViewerText,
  viewerLine,
  wrapViewerText,
  type ViewerRunSnapshot,
  type ViewerSnapshot,
  type ViewerTheme,
  type ViewerTranscript,
} from "./subagent-viewer-data.js";
import {
  buildViewerTranscriptBody,
  readViewerTranscriptSettings,
  type ViewerOutcome,
  viewerSettingsKey,
  VIEWER_DEFAULT_SETTINGS,
  type ViewerTranscriptBody,
  type ViewerTranscriptSettings,
} from "./subagent-viewer-transcript.js";

export const VIEWER_EMPTY_MESSAGE = "No retained subagent runs.";
/** Bottom-status colour and word for every retained lifecycle status. */
export const VIEWER_STATUS_STYLE: Readonly<Record<RunStatus, { color: string; label: string }>> = {
  starting: { color: "dim", label: "starting" },
  running: { color: "accent", label: "running" },
  waiting: { color: "warning", label: "waiting" },
  completed: { color: "success", label: "completed" },
  failed: { color: "error", label: "failed" },
  interrupted: { color: "warning", label: "interrupted" },
};
const VIEWER_TERMINAL_STATUSES = new Set<RunStatus>(["completed", "failed", "interrupted"]);
const VIEWER_LIVE_STATUSES = new Set<RunStatus>(["running", "waiting"]);

export function isViewerTerminalStatus(status: RunStatus): boolean {
  return VIEWER_TERMINAL_STATUSES.has(status);
}
export const VIEWER_READ_ONLY_LABEL = "Read-Only";
export const VIEWER_REFRESH_MS = 250;
/** Rows the live/waiting block may occupy before it is trimmed, so the transcript keeps the screen. */
export const VIEWER_MAX_LIVE_LINES = 6;
/** Consecutive empty-overlay observations before the viewer decides the host dropped its entry. */
export const VIEWER_GONE_TICKS = 2;
/**
 * Minimal SGR mouse reporting, enabled only while a regular-mode overlay is mounted.
 * `?1000` reports button presses (wheel notches included) and `?1006` asks for the SGR encoding.
 * Motion tracking is deliberately not enabled, so Shift-drag still reaches the terminal's own
 * selection and the Main scrollback keeps working the moment the viewer disables it again.
 */
export const VIEWER_MOUSE_ENABLE = "\x1b[?1000h\x1b[?1006h";
export const VIEWER_MOUSE_DISABLE = "\x1b[?1006l\x1b[?1000l";
/** One transcript row per wheel notch, matching Pi's own fullscreen wheel step. */
export const VIEWER_WHEEL_LINES = 1;
const VIEWER_MIN_TRANSCRIPT_ROWS = 3;
const VIEWER_FALLBACK_ROWS = 24;
const VIEWER_FALLBACK_WIDTH = 80;
const SGR_MOUSE_PATTERN = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/;
const X10_MOUSE_PATTERN = /^\x1b\[M[\s\S]{3}$/;

type TimerHandle = unknown;

export interface ViewerViewState {
  scroll: number;
  follow: boolean;
  /**
   * Set when the user turned follow off while already at the end.
   *
   * While it is set, nothing implicit re-arms follow: not growth, not a resize clamp, and not
   * another Down, PageDown, or wheel notch that lands on the end again. Only `f` turning follow
   * back on or `End` clears it, plus deliberately leaving the end on the way up.
   */
  suppressed: boolean;
}

interface ViewerModel {
  readonly run: ViewerRunSnapshot | undefined;
  readonly outcome: ViewerOutcome | undefined;
  readonly placeholder: string | undefined;
  readonly index: number;
  readonly total: number;
  readonly transcript: ViewerTranscript | undefined;
  readonly state: ViewerViewState;
  readonly updatedAtMs: number | undefined;
  readonly bodyRevision: number;
  readonly statusRevision: number;
  readonly bodyKey: string;
  readonly expanded: boolean;
  readonly settings: ViewerTranscriptSettings;
  readonly cwd: string | undefined;
}

export type SubagentViewerUI = Pick<
  ExtensionUIContext,
  "custom" | "notify" | "getToolsExpanded" | "setToolsExpanded"
>;

export interface SubagentViewerOptions {
  snapshot: () => ViewerSnapshot;
  loadTranscript?: typeof loadViewerTranscript;
  buildBody?: typeof buildViewerTranscriptBody;
  readSettings?: typeof readViewerTranscriptSettings;
  setInterval?: (callback: () => void, ms: number) => TimerHandle;
  clearInterval?: (timer: TimerHandle) => void;
  nowMs?: () => number;
  refreshMs?: number;
}

export interface ViewerShortcutOptions {
  enabled?: boolean;
  cwd?: string;
  projectTrusted?: boolean;
}

function timeOfDay(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return "never";
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function errorText(error: unknown): string {
  return sanitizeViewerInline(error instanceof Error ? error.message : String(error)) || "unknown error";
}

function padToWidth(line: string, width: number): string {
  const trimmed = viewerLine(line, width);
  return `${trimmed}${" ".repeat(Math.max(0, width - visibleWidth(trimmed)))}`;
}

/**
 * Joins status segments and drops the least important ones until the row fits.
 * Truncating instead would silently eat the tail, which is where the live elapsed clock sits.
 */
export function fitViewerSegments(
  segments: readonly string[],
  dropOrder: readonly number[],
  width: number,
): string {
  const kept = new Set(segments.map((_, index) => index));
  const compose = () => segments.filter((_, index) => kept.has(index)).join(" · ");
  for (const index of dropOrder) {
    if (visibleWidth(compose()) <= width) break;
    kept.delete(index);
  }
  return compose();
}

/** Terminal result for the body's outcome block, or undefined while the run can still change. */
export function viewerOutcomeOf(run: ViewerRunSnapshot | undefined): ViewerOutcome | undefined {
  if (!run || !isViewerTerminalStatus(run.status)) return undefined;
  return {
    status: run.status,
    output: run.output,
    error: run.error,
    sourceRunId: run.sourceRunId,
  };
}

/** Stable digest of the outcome block's own content. */
export function viewerOutcomeKey(outcome: ViewerOutcome | undefined): string {
  if (!outcome) return "";
  return `${outcome.status}:${(outcome.error ?? "").length}:${(outcome.output ?? "").length}`;
}

/**
 * Body note for a run with no readable transcript.
 *
 * A starting run has not published a session file yet, which is normal and must read as pending
 * rather than as a failure, and it must stay the same string on every poll so the body is built
 * once instead of every 250 ms.
 */
export function viewerPlaceholderOf(
  run: ViewerRunSnapshot | undefined,
  transcript: ViewerTranscript | undefined,
): string | undefined {
  if (!run) return undefined;
  if (transcript && transcript.status === "ok" && transcript.entries.length > 0) return undefined;
  if (run.status === "starting") return "This run has not published a child session file yet.";
  if (isViewerTerminalStatus(run.status)) {
    if (!transcript || transcript.status !== "ok") return "This run kept no readable child session file.";
    return undefined;
  }
  return undefined;
}

/** Wheel notch direction, or undefined when the sequence is any other mouse report. */
export function parseViewerWheel(data: string): -1 | 1 | undefined {
  const sgr = SGR_MOUSE_PATTERN.exec(data);
  if (sgr) {
    const button = Number.parseInt(sgr[1], 10);
    if ((button & 64) === 0) return undefined;
    const direction = button & 3;
    return direction === 0 ? -1 : direction === 1 ? 1 : undefined;
  }
  if (X10_MOUSE_PATTERN.test(data)) {
    const button = data.charCodeAt(3) - 32;
    if ((button & 64) === 0) return undefined;
    const direction = button & 3;
    return direction === 0 ? -1 : direction === 1 ? 1 : undefined;
  }
  return undefined;
}

/** Any mouse report, wheel or not. Non-wheel reports are swallowed instead of typed into the UI. */
export function isViewerMouseSequence(data: string): boolean {
  return SGR_MOUSE_PATTERN.test(data) || X10_MOUSE_PATTERN.test(data);
}

/**
 * Full-screen read-only overlay component.
 * It renders exactly the terminal viewport, so nothing of the underlying Main UI shows through.
 */
export class SubagentViewerComponent implements Component, Focusable {
  private readonly tui: TUI;
  private readonly theme: ViewerTheme;
  private readonly keybindings: KeybindingsManager | undefined;
  private readonly controller: SubagentViewerKeyTarget;
  private frameCache: { key: string; lines: string[] } | undefined;
  /** The built component tree. Rebuilt only when the body key changes, never on a clock tick. */
  private body: { key: string; body: ViewerTranscriptBody } | undefined;
  private lastWidth = VIEWER_FALLBACK_WIDTH;
  private _focused = false;
  private disposed = false;

  constructor(options: {
    tui: TUI;
    theme: ViewerTheme;
    keybindings?: KeybindingsManager;
    controller: SubagentViewerKeyTarget;
  }) {
    this.tui = options.tui;
    this.theme = options.theme;
    this.keybindings = options.keybindings;
    this.controller = options.controller;
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
  }

  /** Theme-level invalidation: drop the frame and let the built components re-render themselves. */
  invalidate(): void {
    this.frameCache = undefined;
    this.body?.body.invalidate();
  }

  /** Cheap invalidation used by activity, clock, and scroll updates. The body tree is untouched. */
  invalidateFrame(): void {
    this.frameCache = undefined;
  }

  private rows(): number {
    const rows = this.tui.terminal?.rows;
    return Number.isFinite(rows) && Number(rows) > 0 ? Math.floor(Number(rows)) : VIEWER_FALLBACK_ROWS;
  }

  /** Transcript rows currently visible, used by the controller for page arithmetic. */
  viewportRows(): number {
    return this.layout(this.controller.model(), this.lastWidth, this.rows()).transcriptRows;
  }

  private statusLines(model: ViewerModel, width: number): string[] {
    const theme = this.theme;
    const run = model.run;
    if (!run) return [padToWidth(theme.fg("dim", "No retained subagent run."), width)];
    const style = VIEWER_STATUS_STYLE[run.status] ?? VIEWER_STATUS_STYLE.starting;
    const title = [
      theme.bold(theme.fg("accent", `Subagent ${model.index + 1}/${model.total}`)),
      `${theme.bold(sanitizeViewerInline(run.agent))} ${theme.fg("dim", `[${sanitizeViewerInline(run.id)}]`)}`,
      theme.fg(style.color, style.label),
      theme.fg("muted", sanitizeViewerInline(run.abstract)),
    ].join(theme.fg("dim", " · "));
    const activity = run.activity;
    const terminal = isViewerTerminalStatus(run.status);
    const segments = [
      // Liveness is a statement about a process that is still there, so a finished run omits it.
      terminal ? "" : run.live ? theme.fg("success", "live") : theme.fg("warning", "not live"),
      // The model string comes from a child run file, so it is untrusted text like everything else.
      sanitizeViewerInline(formatSubagentModel(sanitizeViewerText(run.model))),
      run.sourceRunId ? theme.fg("dim", `from ${sanitizeViewerInline(run.sourceRunId)}`) : "",
      formatWidgetTurns(activity.turnCount),
      `${activity.toolUses} tool use${activity.toolUses === 1 ? "" : "s"}`,
      formatWidgetTokens(activity.tokens),
      activity.compactionCount > 0 ? `${activity.compactionCount} compaction${activity.compactionCount === 1 ? "" : "s"}` : "",
      this.controller.elapsed(),
    ].filter((segment) => segment !== "");
    // The leading status word and the trailing elapsed value are never dropped; the middle can go.
    const dropOrder = segments.map((_, index) => index).slice(1, -1).reverse();
    const stats = fitViewerSegments(segments, dropOrder, width);
    return [padToWidth(title, width), padToWidth(theme.fg("dim", stats), width)];
  }

  /**
   * Hint rows wrap to the width; the meta row is always exactly one line.
   * Both the layout pass and the render pass call this with the same width, so the height agrees.
   */
  private hintLines(model: ViewerModel, width: number): string[] {
    const theme = this.theme;
    const hints = [
      "←/→ or Ctrl+Shift+←/→ run",
      "↑/↓ line",
      "PgUp/PgDn page",
      "Home/End edge",
      `f follow ${model.state.follow ? "on" : "off"}`,
      `${this.controller.expandKey()} ${model.expanded ? "expanded" : "collapsed"}`,
      "r refresh",
      "Esc/q Main",
    ].join(" · ");
    return wrapViewerText(hints, width).map((line) => padToWidth(theme.fg("dim", line), width));
  }

  private metaLine(model: ViewerModel, width: number, total: number, rows: number): string {
    const theme = this.theme;
    const scroll = model.state.scroll;
    const position = total === 0
      ? "0/0"
      : `${Math.min(total, scroll + 1)}-${Math.min(total, scroll + rows)}/${total}`;
    const warning = model.transcript?.warning;
    const meta = `${position} · updated ${timeOfDay(model.updatedAtMs)}${warning ? ` · ${sanitizeViewerInline(warning)}` : ""}`;
    return padToWidth(theme.fg(warning ? "warning" : "dim", meta), width);
  }

  private readOnlyLines(width: number): string[] {
    const theme = this.theme;
    const border = theme.fg("dim", "─".repeat(Math.max(1, width)));
    return [
      padToWidth(border, width),
      padToWidth(` ${theme.fg("muted", VIEWER_READ_ONLY_LABEL)}`, width),
      padToWidth(border, width),
    ];
  }

  private liveLines(model: ViewerModel, width: number): string[] {
    // A starting run has nothing live yet and a terminal run has nothing live any more; neither may
    // borrow the running presentation.
    if (!model.run || !model.transcript || !VIEWER_LIVE_STATUSES.has(model.run.status)) return [];
    const lines = renderViewerLive(model.run, model.transcript, width, this.theme, {
      expanded: model.expanded,
      expandHint: this.controller.expandHint(),
    });
    if (lines.length <= VIEWER_MAX_LIVE_LINES) return lines;
    return [
      ...lines.slice(0, VIEWER_MAX_LIVE_LINES - 1),
      viewerLine(this.theme.fg("dim", `… ${lines.length - VIEWER_MAX_LIVE_LINES + 1} more live line(s)`), width),
    ];
  }

  /**
   * Fits the fixed bottom rows into the terminal.
   *
   * Survival order, worst first: the live block goes, then the activity row, then the Read-Only
   * borders, then the key hints, then the meta row. The transcript keeps at least one row, and the
   * `Read-Only` row plus the status title outlive everything else because they are the only proof
   * of what is on screen and that it cannot be typed into.
   */
  private layout(model: ViewerModel, width: number, rows: number): {
    live: string[];
    readOnly: string[];
    status: string[];
    hints: string[];
    meta: boolean;
    transcriptRows: number;
  } {
    const fullStatus = this.statusLines(model, width);
    const fullReadOnly = this.readOnlyLines(width);
    const fullHints = this.hintLines(model, width);
    let live = this.liveLines(model, width);
    let status = fullStatus;
    let readOnly = fullReadOnly;
    let hints = fullHints;
    let meta = true;
    const chrome = () =>
      (live.length > 0 ? live.length + 1 : 0) + readOnly.length + status.length + hints.length + (meta ? 1 : 0);
    if (chrome() + VIEWER_MIN_TRANSCRIPT_ROWS > rows) live = [];
    if (chrome() + VIEWER_MIN_TRANSCRIPT_ROWS > rows) status = fullStatus.slice(0, 1);
    if (chrome() + 1 > rows) readOnly = [fullReadOnly[1]];
    if (chrome() + 1 > rows) hints = [];
    if (chrome() + 1 > rows) meta = false;
    return { live, readOnly, status, hints, meta, transcriptRows: Math.max(1, rows - chrome()) };
  }

  /** Builds or reuses the transcript component tree. Only a body-key change rebuilds it. */
  private transcriptBody(model: ViewerModel): ViewerTranscriptBody {
    if (this.body && this.body.key === model.bodyKey) return this.body.body;
    const previous = this.body;
    const body = this.controller.buildBody({
      transcript: model.transcript,
      tui: this.tui,
      theme: this.theme,
      cwd: model.cwd,
      expanded: model.expanded,
      settings: model.settings,
      outcome: model.outcome,
      placeholder: model.placeholder,
    });
    this.body = { key: model.bodyKey, body };
    if (previous) {
      try { previous.body.dispose(); }
      catch { /* the replaced tree is unreachable either way */ }
    }
    return body;
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const rows = this.rows();
    this.lastWidth = safeWidth;
    const model = this.controller.model();
    const state = model.state;
    const frameKey = [
      safeWidth, rows, model.bodyRevision, model.statusRevision,
      state.scroll, state.follow ? 1 : 0, state.suppressed ? 1 : 0,
    ].join(":");
    if (this.frameCache && this.frameCache.key === frameKey) return this.frameCache.lines;

    const theme = this.theme;
    const { live, readOnly, status, hints, meta, transcriptRows } = this.layout(model, safeWidth, rows);
    const body = this.transcriptBody(model).render(safeWidth);
    const maxScroll = Math.max(0, body.length - transcriptRows);
    // Content growth pins a following view to the end; a clamp alone never means the user arrived.
    if (state.follow) state.scroll = maxScroll;
    state.scroll = Math.max(0, Math.min(state.scroll, maxScroll));
    this.controller.noteViewport(body.length, transcriptRows);
    const visible = body.slice(state.scroll, state.scroll + transcriptRows);
    const separator = padToWidth(theme.fg("dim", "─".repeat(safeWidth)), safeWidth);

    const lines: string[] = [];
    for (let index = 0; index < transcriptRows; index += 1) {
      lines.push(padToWidth(visible[index] ?? "", safeWidth));
    }
    if (live.length > 0) {
      lines.push(separator);
      for (const line of live) lines.push(padToWidth(line, safeWidth));
    }
    // Host limitation: an inline terminal image already drawn by the Main UI is a raw escape the
    // host composites, so it can still bleed through an overlay row. The viewer's own output never
    // contains one, because every transcript byte goes through the sanitizer first.
    lines.push(...readOnly);
    lines.push(...status);
    lines.push(...hints);
    if (meta) lines.push(this.metaLine(model, safeWidth, body.length, transcriptRows));
    while (lines.length < rows) lines.push(padToWidth("", safeWidth));
    const clamped = lines.slice(0, Math.max(1, rows));
    this.frameCache = { key: frameKey, lines: clamped };
    return clamped;
  }

  handleInput(data: string): void {
    const wheel = parseViewerWheel(data);
    if (wheel !== undefined) {
      this.controller.scrollBy(wheel * VIEWER_WHEEL_LINES);
      return;
    }
    // Clicks, drags, and releases are reports the viewer asked for but does not use. Swallowing
    // them keeps raw escape bytes from leaking into any other handler.
    if (isViewerMouseSequence(data)) return;
    if (this.keybindings?.matches(data, "app.tools.expand") === true) {
      this.controller.toggleExpanded();
      return;
    }
    if (matchesKey(data, Key.ctrlShift("right")) || matchesKey(data, Key.right)) {
      this.controller.step(1);
      return;
    }
    if (matchesKey(data, Key.ctrlShift("left")) || matchesKey(data, Key.left)) {
      this.controller.step(-1);
      return;
    }
    if (matchesKey(data, Key.escape) || matchesKey(data, "q")) {
      this.controller.requestClose();
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.controller.scrollBy(-1);
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.controller.scrollBy(1);
      return;
    }
    if (matchesKey(data, Key.pageUp)) {
      this.controller.scrollBy(-this.viewportRows());
      return;
    }
    if (matchesKey(data, Key.pageDown)) {
      this.controller.scrollBy(this.viewportRows());
      return;
    }
    if (matchesKey(data, Key.home)) {
      this.controller.scrollToTop();
      return;
    }
    if (matchesKey(data, Key.end)) {
      this.controller.scrollToBottom();
      return;
    }
    if (matchesKey(data, "f")) {
      this.controller.toggleFollow();
      return;
    }
    if (matchesKey(data, "r")) this.controller.refreshNow();
  }

  /** Releases the built transcript tree. Safe to call more than once. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const body = this.body;
    this.body = undefined;
    this.frameCache = undefined;
    if (!body) return;
    try { body.body.dispose(); }
    catch { /* best-effort release */ }
  }
}

/** The surface the component needs, kept narrow so tests can drive it directly. */
export interface SubagentViewerKeyTarget {
  model(): ViewerModel;
  now(): number;
  elapsed(): string;
  buildBody: typeof buildViewerTranscriptBody;
  noteViewport(contentLines: number, transcriptRows: number): void;
  expandKey(): string;
  expandHint(): string;
  toggleExpanded(): void;
  step(direction: 1 | -1): void;
  requestClose(): void;
  scrollBy(delta: number): void;
  scrollToTop(): void;
  scrollToBottom(): void;
  toggleFollow(): void;
  refreshNow(): void;
}

export class SubagentViewer implements SubagentViewerKeyTarget {
  private readonly options: SubagentViewerOptions;
  private readonly loadTranscript: typeof loadViewerTranscript;
  readonly buildBody: typeof buildViewerTranscriptBody;
  private readonly readSettings: typeof readViewerTranscriptSettings;
  private readonly setIntervalFn: (callback: () => void, ms: number) => TimerHandle;
  private readonly clearIntervalFn: (timer: TimerHandle) => void;
  private readonly nowMs: () => number;
  private readonly refreshMs: number;
  private readonly viewStates = new Map<string, ViewerViewState>();
  private readonly transcripts = new Map<string, ViewerTranscript>();
  private readonly transcriptSeqs = new Map<string, number>();
  private readonly fingerprints = new Map<string, string>();
  private readonly contentKeys = new Map<string, string>();
  private readonly readAt = new Map<string, number>();
  private runs: ViewerRunSnapshot[] = [];
  private retainedIds: string[] = [];
  private childSessionDir: string | undefined;
  private currentRunId: string | undefined;
  private component: SubagentViewerComponent | undefined;
  private ui: SubagentViewerUI | undefined;
  private tui: TUI | undefined;
  private done: ((value: void) => void) | undefined;
  /** The host's handle for this viewer's own overlay entry. Removal is by identity, never by rank. */
  private handle: OverlayHandle | undefined;
  private openPromise: Promise<void> | undefined;
  private abandonOpen: (() => void) | undefined;
  private timer: TimerHandle | undefined;
  private generation = 0;
  private bodyRevision = 0;
  private statusRevision = 0;
  private transcriptSeq = 0;
  private opened = false;
  private goneTicks = 0;
  private readToken: number | undefined;
  private readSequence = 0;
  private pendingRead = false;
  private pendingForce = false;
  private mouseEnabled = false;
  private expanded = true;
  private settings: ViewerTranscriptSettings = VIEWER_DEFAULT_SETTINGS;
  private settingsKey = viewerSettingsKey(VIEWER_DEFAULT_SETTINGS);
  /** The elapsed value as it is actually shown, so a repaint follows the string, not the clock. */
  private lastElapsed = "";
  private contentLines = 0;
  private transcriptRows = 1;

  constructor(options: SubagentViewerOptions) {
    this.options = options;
    this.loadTranscript = options.loadTranscript ?? loadViewerTranscript;
    this.buildBody = options.buildBody ?? buildViewerTranscriptBody;
    this.readSettings = options.readSettings ?? readViewerTranscriptSettings;
    this.setIntervalFn = options.setInterval ?? ((callback, ms) => setInterval(callback, ms));
    this.clearIntervalFn = options.clearInterval ?? ((timer) => clearInterval(timer as ReturnType<typeof setInterval>));
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.refreshMs = options.refreshMs ?? VIEWER_REFRESH_MS;
  }

  isOpen(): boolean {
    return this.opened;
  }

  now(): number {
    return this.nowMs();
  }

  currentRun(): string | undefined {
    return this.opened ? this.currentRunId : undefined;
  }

  /** True only while this viewer owns the temporary regular-mode mouse reporting mode. */
  isMouseEnabled(): boolean {
    return this.mouseEnabled;
  }

  expandKey(): string {
    return widgetExpandKey();
  }

  expandHint(): string {
    return widgetExpandHint();
  }

  noteViewport(contentLines: number, transcriptRows: number): void {
    this.contentLines = Math.max(0, contentLines);
    this.transcriptRows = Math.max(1, transcriptRows);
  }

  private maxScroll(): number {
    return Math.max(0, this.contentLines - this.transcriptRows);
  }

  /**
   * The elapsed string exactly as the status row renders it for the selected run.
   *
   * The repaint decision compares this display value instead of a wall-clock bucket: a run created
   * mid-second changes its shown value on its own phase, and once the format switches to minutes or
   * hours most seconds change nothing at all.
   */
  private elapsedDisplay(): string {
    const run = this.currentSnapshot();
    if (run === undefined) return "—";
    // A finished run's duration is a fact about the past, so it is frozen at its own end and the
    // one-second status clock stops repainting for it.
    if (isViewerTerminalStatus(run.status)) {
      const ended = Date.parse(run.updatedAt);
      return Number.isFinite(ended) ? formatViewerElapsed(run.createdAt, ended) : "—";
    }
    return formatViewerElapsed(run.createdAt, this.nowMs());
  }

  /** The elapsed string exactly as the status row shows it. */
  elapsed(): string {
    return this.elapsedDisplay();
  }

  private currentSnapshot(): ViewerRunSnapshot | undefined {
    const runId = this.currentRunId;
    return runId === undefined ? undefined : this.runs.find((candidate) => candidate.id === runId);
  }

  model(): ViewerModel {
    const runId = this.currentRunId;
    const run = runId === undefined ? undefined : this.runs.find((candidate) => candidate.id === runId);
    const transcript = runId === undefined ? undefined : this.transcripts.get(runId);
    const seq = runId === undefined ? 0 : this.transcriptSeqs.get(runId) ?? 0;
    const outcome = viewerOutcomeOf(run);
    return {
      run,
      outcome,
      placeholder: viewerPlaceholderOf(run, transcript),
      index: runId === undefined ? -1 : this.retainedIds.indexOf(runId),
      total: this.retainedIds.length,
      transcript,
      state: this.viewState(runId),
      updatedAtMs: runId === undefined ? undefined : this.readAt.get(runId),
      bodyRevision: this.bodyRevision,
      statusRevision: this.statusRevision,
      // The outcome digest is part of the key: a run that reaches a terminal status gains an
      // outcome block, and that is a body change even when the transcript file never moved.
      bodyKey: [
        runId ?? "main",
        seq,
        run?.cwd ?? "",
        this.settingsKey,
        this.expanded ? 1 : 0,
        run?.status ?? "",
        viewerOutcomeKey(outcome),
      ].join(":"),
      expanded: this.expanded,
      settings: this.settings,
      cwd: run?.cwd,
    };
  }

  private viewState(runId: string | undefined): ViewerViewState {
    if (runId === undefined) return { scroll: 0, follow: true, suppressed: false };
    let state = this.viewStates.get(runId);
    if (!state) {
      state = { scroll: 0, follow: true, suppressed: false };
      this.viewStates.set(runId, state);
    }
    return state;
  }

  /** Transcript identity changed: the component tree must be rebuilt. */
  private bumpBody(): void {
    this.bodyRevision += 1;
    this.statusRevision += 1;
  }

  /** Activity, clock, scroll, or hint changed: only the composed frame is stale. */
  private bumpStatus(): void {
    this.statusRevision += 1;
  }

  private requestRender(): void {
    if (!this.opened) return;
    this.component?.invalidateFrame();
    this.tui?.requestRender();
  }

  /**
   * One shortcut press from Main.
   * An empty active set notifies exactly once and leaves the caller in Main with no overlay.
   */
  async handleShortcut(
    ui: SubagentViewerUI,
    direction: 1 | -1,
    options: ViewerShortcutOptions = {},
  ): Promise<void> {
    if (options.enabled === false) return;
    if (this.opened || this.openPromise) return;
    const snapshot = this.options.snapshot();
    const ids = snapshot.runs.map((run) => run.id);
    if (ids.length === 0) {
      ui.notify(VIEWER_EMPTY_MESSAGE, "info");
      return;
    }
    const selected = cycleViewerSelection(ids, undefined, direction);
    if (selected === undefined) {
      ui.notify(VIEWER_EMPTY_MESSAGE, "info");
      return;
    }
    this.settings = this.readSettings(options.cwd, options.projectTrusted === true);
    this.settingsKey = viewerSettingsKey(this.settings);
    await this.openOverlay(ui, snapshot, selected);
  }

  private adoptSnapshot(snapshot: ViewerSnapshot): void {
    this.runs = snapshot.runs.map((run) => run);
    this.retainedIds = this.runs.map((run) => run.id);
    this.childSessionDir = snapshot.childSessionDir;
    const known = new Set(this.retainedIds);
    for (const id of [...this.viewStates.keys()]) if (!known.has(id)) this.viewStates.delete(id);
    for (const id of [...this.transcripts.keys()]) if (!known.has(id)) this.transcripts.delete(id);
    for (const id of [...this.transcriptSeqs.keys()]) if (!known.has(id)) this.transcriptSeqs.delete(id);
    for (const id of [...this.fingerprints.keys()]) if (!known.has(id)) this.fingerprints.delete(id);
    for (const id of [...this.contentKeys.keys()]) if (!known.has(id)) this.contentKeys.delete(id);
    for (const id of [...this.readAt.keys()]) if (!known.has(id)) this.readAt.delete(id);
  }

  /**
   * Turns on minimal wheel reporting for a regular-mode overlay.
   * Called only from `onHandle`, so a viewer that never mounts never touches the terminal mode.
   */
  private enableMouse(tui: TUI): void {
    if (this.mouseEnabled) return;
    // Fullscreen hosts already report the wheel and own the mode themselves.
    if (tui.mode !== "regular") return;
    try {
      tui.terminal.write(VIEWER_MOUSE_ENABLE);
      this.mouseEnabled = true;
    } catch {
      this.mouseEnabled = false;
    }
  }

  /** Restores the terminal's own wheel behaviour. Idempotent and safe on every teardown path. */
  private disableMouse(): void {
    if (!this.mouseEnabled) return;
    this.mouseEnabled = false;
    try { this.tui?.terminal.write(VIEWER_MOUSE_DISABLE); }
    catch { /* the terminal is already gone */ }
  }

  private async openOverlay(ui: SubagentViewerUI, snapshot: ViewerSnapshot, runId: string): Promise<void> {
    this.generation += 1;
    const generation = this.generation;
    this.opened = true;
    this.ui = ui;
    this.handle = undefined;
    this.goneTicks = 0;
    this.expanded = readWidgetExpanded(ui);
    this.contentLines = 0;
    this.transcriptRows = 1;
    this.adoptSnapshot(snapshot);
    this.currentRunId = runId;
    this.lastElapsed = this.elapsedDisplay();
    this.viewState(runId);
    this.bumpBody();
    this.startTimer(generation);
    this.scheduleRead(generation);
    let promise: Promise<void>;
    try {
      promise = ui.custom<void>((tui, theme, keybindings, done) => {
        const component = new SubagentViewerComponent({
          tui,
          theme: theme as unknown as ViewerTheme,
          keybindings,
          controller: this,
        });
        // A close that lands before the host builds the component must not adopt this overlay.
        if (generation !== this.generation) {
          if (typeof tui.hasOverlay !== "function" || !tui.hasOverlay()) queueMicrotask(() => done());
          return component;
        }
        this.tui = tui;
        this.done = done;
        this.component = component;
        return component;
      }, {
        overlay: true,
        overlayOptions: { width: "100%", maxHeight: "100%", row: 0, col: 0, margin: 0 },
        // The public handle is the only way to remove exactly this overlay entry, and it is also
        // the only proof that the host really mounted this viewer. Mouse reporting is turned on
        // here and nowhere else.
        onHandle: (handle: OverlayHandle) => {
          if (generation !== this.generation) {
            // The close already ran for this open, so the entry is unwanted the moment it exists.
            try { handle.hide(); } catch { /* the host already dropped this entry */ }
            return;
          }
          this.handle = handle;
          if (this.tui) this.enableMouse(this.tui);
        },
      });
    } catch (error) {
      // A host that throws synchronously never created an overlay. Tear the timer, the generation,
      // and the open state down right here so the very next shortcut press can open again.
      this.teardown(generation);
      ui.notify(`Subagent viewer could not open: ${errorText(error)}`, "error");
      return;
    }
    // A blocked close can abandon the host promise, so the awaited value is the race, not the raw
    // overlay promise. Either way the viewer state is torn down exactly once.
    let openError: unknown;
    const guarded = promise.then(() => undefined, (error: unknown) => { openError = error ?? new Error("unknown error"); });
    const abandoned = new Promise<void>((resolveAbandon) => { this.abandonOpen = resolveAbandon; });
    const settled = Promise.race([guarded, abandoned]).then(() => undefined);
    this.openPromise = settled;
    try {
      await settled;
    } finally {
      this.teardown(generation);
    }
    if (openError !== undefined) ui.notify(`Subagent viewer closed with an error: ${errorText(openError)}`, "error");
  }

  /**
   * True when the host emptied its overlay stack behind this viewer's back.
   * `hasOverlay` is used only for that self-healing signal; it never decides how to close.
   */
  private hostDroppedOverlay(): boolean {
    const tui = this.tui;
    return typeof tui?.hasOverlay === "function" && tui.hasOverlay() === false;
  }

  /**
   * Removes this viewer's own overlay entry and tears the viewer down, in that order.
   *
   * Once the host has handed over an `OverlayHandle`, `handle.hide()` deletes exactly this entry by
   * identity. It is idempotent, it works no matter how many capturing, non-capturing, or
   * temporarily hidden overlays sit above it, and it never touches anybody else's entry. The host's
   * `done` is deliberately not used on that path, because `showExtensionCustom` answers it with an
   * unconditional `hideOverlay()` on the TUI, which pops the top of the stack rather than this
   * viewer.
   */
  private completeClose(): void {
    const generation = this.generation;
    const handle = this.handle;
    const done = this.done;
    this.handle = undefined;
    this.done = undefined;
    const component = this.component;
    if (handle) {
      try { handle.hide(); } catch { /* the host already removed this entry */ }
      try { component?.dispose(); }
      catch { /* a component dispose failure must not block teardown */ }
      this.teardown(generation);
      return;
    }
    // No handle yet: the host has not shown an overlay for this open, so `done` is still the right
    // answer. It is only safe while the stack has nothing for `hideOverlay` to pop; if some other
    // overlay is up, the `onHandle` guard above removes this entry instead.
    const resolvable = done !== undefined && !(typeof this.tui?.hasOverlay === "function" && this.tui.hasOverlay());
    try { component?.dispose(); }
    catch { /* a component dispose failure must not block teardown */ }
    this.teardown(generation);
    if (resolvable && done) done();
  }

  /**
   * One tick reconciles the snapshot and self-heals an overlay entry the host dropped without
   * resolving. There is no close retry any more: a close always completes immediately.
   */
  private startTimer(generation: number): void {
    this.stopTimer();
    const timer = this.setIntervalFn(() => {
      if (generation !== this.generation || !this.opened) return;
      // The host can hide this overlay on its own without ever calling `done`. Two consecutive
      // empty-stack observations mean the entry is gone, so the viewer closes itself. The close
      // path still calls `handle.hide()`, which is a no-op once the entry has been removed.
      if (this.handle !== undefined && this.hostDroppedOverlay()) {
        this.goneTicks += 1;
        if (this.goneTicks >= VIEWER_GONE_TICKS) {
          this.requestClose();
          return;
        }
      } else {
        this.goneTicks = 0;
      }
      this.refresh(generation);
    }, this.refreshMs);
    (timer as { unref?: () => void })?.unref?.();
    this.timer = timer;
  }

  private stopTimer(): void {
    if (this.timer === undefined) return;
    this.clearIntervalFn(this.timer);
    this.timer = undefined;
  }

  /**
   * Periodic reconciliation on the single 250 ms tick.
   * Activity repaints immediately, the elapsed clock repaints when its displayed string changes,
   * and neither ever rebuilds the transcript component tree.
   */
  private refresh(generation: number): void {
    if (generation !== this.generation || !this.opened) return;
    const previousIds = this.retainedIds;
    const snapshot = this.options.snapshot();
    const runId = this.currentRunId;
    const nextIds = snapshot.runs.map((run) => run.id);
    const signature = this.signature();
    this.adoptSnapshot(snapshot);
    // Membership is the retained set, so a lifecycle change only reorders. The only way an id
    // leaves is `subagent clear`, which is exactly when the neighbour rule has to run.
    if (runId !== undefined && !nextIds.includes(runId)) {
      const replacement = neighborAfterViewerRemoval(previousIds, nextIds, runId);
      if (replacement === undefined) {
        this.requestClose();
        return;
      }
      this.select(replacement, generation);
      return;
    }
    this.scheduleRead(generation);
    let repaint = false;
    if (signature !== this.signature()) {
      this.bumpStatus();
      repaint = true;
    }
    // Pi's one global expansion flag can change from Main, another extension, or a reload.
    const expanded = readWidgetExpanded(this.ui);
    if (expanded !== this.expanded) {
      this.expanded = expanded;
      this.bumpBody();
      repaint = true;
    }
    // The clock repaints only when the rendered elapsed string really changes, and it shares this
    // tick's single render request with any activity change above.
    const elapsed = this.elapsedDisplay();
    if (elapsed !== this.lastElapsed) {
      this.lastElapsed = elapsed;
      this.bumpStatus();
      repaint = true;
    }
    if (repaint) this.requestRender();
  }

  /** Cheap change detector, so an idle viewer never repaints beyond its one-second clock. */
  private signature(): string {
    const runId = this.currentRunId;
    const run = runId === undefined ? undefined : this.runs.find((candidate) => candidate.id === runId);
    const transcript = runId === undefined ? undefined : this.transcripts.get(runId);
    return JSON.stringify([
      runId,
      this.retainedIds,
      run?.status,
      run?.live,
      run?.activity.turnCount,
      run?.activity.toolUses,
      run?.activity.tokens,
      run?.activity.compactionCount,
      run?.activity.responseText,
      Object.keys(run?.activity.activeTools ?? {}),
      run?.request?.createdAt,
      run?.request?.message,
      run?.sourceRunId,
      run?.output?.length,
      run?.error?.length,
      run?.transcriptCutoff,
      transcript?.fingerprint,
      transcript?.status,
      transcript?.warning,
    ]);
  }

  private select(runId: string, generation: number): void {
    if (generation !== this.generation || !this.opened) return;
    this.currentRunId = runId;
    this.lastElapsed = this.elapsedDisplay();
    this.viewState(runId);
    this.contentLines = 0;
    this.bumpBody();
    this.scheduleRead(generation, true);
    this.requestRender();
  }

  /**
   * Single-flight read.
   * The generation guard drops a completion that lands after close, and per-run keying keeps an
   * older run's result from ever replacing the transcript of the run now on screen.
   */
  private scheduleRead(generation: number, force = false): void {
    if (generation !== this.generation || !this.opened) return;
    const runId = this.currentRunId;
    if (runId === undefined) return;
    if (this.readToken !== undefined) {
      this.pendingRead = true;
      // `r` pressed while a read is in flight must still force the follow-up read.
      this.pendingForce = this.pendingForce || force;
      return;
    }
    const run = this.runs.find((candidate) => candidate.id === runId);
    if (!run) return;
    // A forced read re-reads the file, but the content key still decides whether anything changed,
    // so `r` on an unchanged transcript never rebuilds the body either.
    const previousFingerprint = force ? undefined : this.fingerprints.get(runId);
    const previousContentKey = this.contentKeys.get(runId);
    const cutoff = run.transcriptCutoff;
    const childSessionDir = this.childSessionDir;
    this.readSequence += 1;
    const token = this.readSequence;
    this.readToken = token;
    void Promise.resolve()
      .then(() => this.loadTranscript(childSessionDir, run.sessionFile, {
        previousFingerprint,
        previousContentKey,
        cutoff,
      }))
      .then((load) => {
        if (generation !== this.generation || !this.opened) return;
        // A run cleared while this read was in flight must never write a cache entry or repaint.
        if (!this.retainedIds.includes(runId)) return;
        if (load.fingerprint !== undefined) this.fingerprints.set(runId, load.fingerprint);
        if (load.contentKey !== undefined) this.contentKeys.set(runId, load.contentKey);
        if (load.status === "unchanged" || !load.transcript) return;
        // A repeated waiting or rejected answer is the same screen; only real change rebuilds.
        if (sameViewerTranscript(this.transcripts.get(runId), load.transcript)) {
          this.readAt.set(runId, this.nowMs());
          return;
        }
        this.transcripts.set(runId, load.transcript);
        this.transcriptSeq += 1;
        this.transcriptSeqs.set(runId, this.transcriptSeq);
        this.readAt.set(runId, this.nowMs());
        this.bumpBody();
        this.requestRender();
      })
      .catch(() => undefined)
      .finally(() => {
        if (this.readToken !== token) return;
        this.readToken = undefined;
        if (!this.pendingRead) return;
        this.pendingRead = false;
        const pendingForce = this.pendingForce;
        this.pendingForce = false;
        this.scheduleRead(generation, pendingForce);
      });
  }

  step(direction: 1 | -1): void {
    if (!this.opened) return;
    const next = cycleViewerSelection(this.retainedIds, this.currentRunId, direction);
    if (next === undefined) {
      this.requestClose();
      return;
    }
    if (next === this.currentRunId) return;
    this.select(next, this.generation);
  }

  /**
   * Bottom-aware scrolling.
   *
   * Moving up always leaves follow, and leaving the end that way clears suppression, so a later
   * scroll back down may re-arm. Moving down re-arms only by actually reaching the end and only
   * while the user has not suppressed it, which is what makes a wheel or PageDown to the bottom
   * behave like `End` in the normal case and behave like nothing at all after `f`.
   */
  scrollBy(delta: number): void {
    if (!this.opened || delta === 0) return;
    const state = this.viewState(this.currentRunId);
    const max = this.maxScroll();
    const next = Math.max(0, Math.min(state.scroll + delta, max));
    state.scroll = next;
    if (delta < 0) {
      state.follow = false;
      // Only really leaving the end counts; an up key that cannot move is not a change of mind.
      if (next < max) state.suppressed = false;
    } else if (next >= max && !state.suppressed) {
      state.follow = true;
    } else {
      state.follow = false;
    }
    this.bumpStatus();
    this.requestRender();
  }

  scrollToTop(): void {
    if (!this.opened) return;
    const state = this.viewState(this.currentRunId);
    state.follow = false;
    // Home leaves the end for real whenever there is anywhere to go, so suppression is done with.
    if (this.maxScroll() > 0) state.suppressed = false;
    state.scroll = 0;
    this.bumpStatus();
    this.requestRender();
  }

  /** `End` is the explicit request to be at the end again, so it also lifts suppression. */
  scrollToBottom(): void {
    if (!this.opened) return;
    const state = this.viewState(this.currentRunId);
    state.follow = true;
    state.suppressed = false;
    state.scroll = this.maxScroll();
    this.bumpStatus();
    this.requestRender();
  }

  /** `f` off at the end suppresses re-arming, so later output cannot silently start following. */
  toggleFollow(): void {
    if (!this.opened) return;
    const state = this.viewState(this.currentRunId);
    if (state.follow) {
      state.follow = false;
      state.suppressed = state.scroll >= this.maxScroll();
    } else {
      state.follow = true;
      state.suppressed = false;
      state.scroll = this.maxScroll();
    }
    this.bumpStatus();
    this.requestRender();
  }

  /**
   * Flips Pi's single global tool-output expansion state.
   * Main, every other viewer run, and the package widgets all read that same flag, so one keypress
   * changes all of them and the value survives closing and reopening the viewer.
   */
  toggleExpanded(): void {
    if (!this.opened) return;
    const ui = this.ui;
    const next = !this.expanded;
    try { ui?.setToolsExpanded?.(next); }
    catch { /* a host without the setter keeps the viewer's read-only view unchanged */ }
    this.expanded = readWidgetExpanded(ui);
    this.bumpBody();
    this.requestRender();
  }

  refreshNow(): void {
    if (!this.opened) return;
    this.scheduleRead(this.generation, true);
  }

  /**
   * Closes immediately by removing this viewer's own overlay entry.
   * Focus and stack rank are irrelevant: the handle identifies the entry, so a foreign overlay on
   * top is neither popped nor a reason to wait.
   */
  requestClose(): void {
    if (!this.opened && this.handle === undefined && this.done === undefined && this.openPromise === undefined) return;
    this.completeClose();
  }

  /** Host-driven close for switch, fork, tree, shutdown, and session start. */
  close(): void {
    if (!this.opened && this.openPromise === undefined) return;
    this.requestClose();
  }

  /**
   * Close and wait until the overlay entry is really gone.
   * `close` removes the entry synchronously, so this only yields on the internal race the opener
   * awaits. Ask calls it before opening its own overlay, which keeps the two out of a microtask
   * race and off each other's screen.
   */
  async closeAsync(): Promise<void> {
    const settled = this.openPromise;
    this.close();
    if (settled === undefined) return;
    try { await settled; }
    catch { /* the host's failure is reported by the opener, not by the closer */ }
  }

  /** A new session starts in Main with no retained per-run view state. */
  reset(): void {
    this.close();
    this.viewStates.clear();
    this.transcripts.clear();
    this.transcriptSeqs.clear();
    this.fingerprints.clear();
    this.contentKeys.clear();
    this.readAt.clear();
    this.runs = [];
    this.retainedIds = [];
    this.childSessionDir = undefined;
    this.currentRunId = undefined;
  }

  private teardown(generation: number): void {
    if (generation !== this.generation) return;
    // Mouse reporting is released before anything else, so the terminal is normal again even if a
    // later step throws. The disable write is a no-op when this viewer never enabled it.
    this.disableMouse();
    // A later timer tick or read completion can no longer match this generation, so nothing revives.
    this.generation += 1;
    this.stopTimer();
    this.opened = false;
    this.goneTicks = 0;
    this.openPromise = undefined;
    this.done = undefined;
    this.handle = undefined;
    try { this.component?.dispose(); }
    catch { /* best-effort release */ }
    this.component = undefined;
    this.tui = undefined;
    this.ui = undefined;
    this.currentRunId = undefined;
    this.readToken = undefined;
    this.pendingRead = false;
    this.pendingForce = false;
    this.contentLines = 0;
    this.transcriptRows = 1;
    // Releasing the awaited race keeps `handleShortcut` from hanging on a promise the host dropped.
    const abandon = this.abandonOpen;
    this.abandonOpen = undefined;
    if (abandon) abandon();
  }

  /** Shutdown path: `reset` already removed this viewer's overlay entry through its own handle. */
  dispose(): void {
    this.reset();
    this.stopTimer();
  }
}

export function createSubagentViewer(options: SubagentViewerOptions): SubagentViewer {
  return new SubagentViewer(options);
}

export type { ViewerModel };
