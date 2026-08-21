/**
 * Read-only Subagent viewer.
 *
 * The viewer is a single full-screen overlay that owns its own layout: header, transcript,
 * live/waiting block, a `Read-Only` input placeholder, and a navigation footer. Main is item 0 of
 * the same cycle, so leaving the last run closes the overlay and returns to the untouched Main UI.
 *
 * The viewer never writes: no session entry, no control file, no run file, no session switch,
 * no editor replacement, and no draft mutation. Every byte it shows comes from a cloned runtime
 * snapshot or from a bounded read-only child JSONL read.
 */

import {
  Key,
  matchesKey,
  visibleWidth,
  type Component,
  type Focusable,
  type OverlayHandle,
  type TUI,
} from "@earendil-works/pi-tui";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { formatSubagentModel } from "./subagent-model-display.js";
import { formatWidgetMs, formatWidgetTokens, formatWidgetTurns } from "./subagent-widget-display.js";
import {
  cycleViewerSelection,
  loadViewerTranscript,
  neighborAfterViewerRemoval,
  renderViewerLive,
  renderViewerTranscript,
  sanitizeViewerInline,
  sanitizeViewerText,
  viewerLine,
  wrapViewerText,
  type ViewerRunSnapshot,
  type ViewerSnapshot,
  type ViewerTheme,
  type ViewerTranscript,
} from "./subagent-viewer-data.js";

export const VIEWER_EMPTY_MESSAGE = "No running or waiting subagents.";
export const VIEWER_READ_ONLY_LABEL = "Read-Only";
export const VIEWER_REFRESH_MS = 250;
/** Rows the live/waiting block may occupy before it is trimmed, so the transcript keeps the screen. */
export const VIEWER_MAX_LIVE_LINES = 6;
/** Consecutive empty-overlay observations before the viewer decides the host dropped its entry. */
export const VIEWER_GONE_TICKS = 2;
const VIEWER_MIN_TRANSCRIPT_ROWS = 3;
const VIEWER_FALLBACK_ROWS = 24;
const VIEWER_FALLBACK_WIDTH = 80;

type TimerHandle = unknown;

export interface ViewerViewState {
  scroll: number;
  follow: boolean;
}

interface ViewerModel {
  readonly run: ViewerRunSnapshot | undefined;
  readonly index: number;
  readonly total: number;
  readonly transcript: ViewerTranscript | undefined;
  readonly state: ViewerViewState;
  readonly updatedAtMs: number | undefined;
  readonly revision: number;
}

export type SubagentViewerUI = Pick<ExtensionUIContext, "custom" | "notify">;

export interface SubagentViewerOptions {
  snapshot: () => ViewerSnapshot;
  loadTranscript?: typeof loadViewerTranscript;
  setInterval?: (callback: () => void, ms: number) => TimerHandle;
  clearInterval?: (timer: TimerHandle) => void;
  nowMs?: () => number;
  refreshMs?: number;
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
 * Full-screen read-only overlay component.
 * It renders exactly the terminal viewport, so nothing of the underlying Main UI shows through.
 */
export class SubagentViewerComponent implements Component, Focusable {
  private readonly tui: TUI;
  private readonly theme: ViewerTheme;
  private readonly controller: SubagentViewerKeyTarget;
  private cache: { width: number; revision: number; rows: number; lines: string[] } | undefined;
  /** Transcript body cache, so an activity-only revision bump never re-renders 4000 lines. */
  private bodyCache: { width: number; transcript: ViewerTranscript | undefined; lines: string[] } | undefined;
  private lastWidth = VIEWER_FALLBACK_WIDTH;
  private _focused = false;

  constructor(options: { tui: TUI; theme: ViewerTheme; controller: SubagentViewerKeyTarget }) {
    this.tui = options.tui;
    this.theme = options.theme;
    this.controller = options.controller;
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
  }

  invalidate(): void {
    this.cache = undefined;
  }

  private rows(): number {
    const rows = this.tui.terminal?.rows;
    return Number.isFinite(rows) && Number(rows) > 0 ? Math.floor(Number(rows)) : VIEWER_FALLBACK_ROWS;
  }

  /** Transcript rows currently visible, used by the controller for page and follow arithmetic. */
  viewportRows(): number {
    return this.layout(this.controller.model(), this.lastWidth, this.rows()).transcriptRows;
  }

  private headerLines(model: ViewerModel, width: number): string[] {
    const theme = this.theme;
    const run = model.run;
    if (!run) return [padToWidth(theme.fg("dim", "No running or waiting subagent."), width)];
    const status = run.status === "waiting"
      ? theme.fg("warning", "waiting")
      : theme.fg("accent", "running");
    const title = [
      theme.bold(theme.fg("accent", `Subagent ${model.index + 1}/${model.total}`)),
      `${theme.bold(sanitizeViewerInline(run.agent))} ${theme.fg("dim", `[${sanitizeViewerInline(run.id)}]`)}`,
      status,
      theme.fg("muted", sanitizeViewerInline(run.abstract)),
    ].join(theme.fg("dim", " · "));
    const activity = run.activity;
    const stats = [
      run.live ? theme.fg("success", "live") : theme.fg("warning", "not live"),
      // The model string comes from a child run file, so it is untrusted text like everything else.
      sanitizeViewerInline(formatSubagentModel(sanitizeViewerText(run.model))),
      formatWidgetTurns(activity.turnCount),
      `${activity.toolUses} tool use${activity.toolUses === 1 ? "" : "s"}`,
      formatWidgetTokens(activity.tokens),
      ...(activity.compactionCount > 0 ? [`${activity.compactionCount} compaction${activity.compactionCount === 1 ? "" : "s"}`] : []),
      formatWidgetMs(this.controller.now() - Date.parse(run.createdAt)),
    ].join(" · ");
    return [padToWidth(title, width), padToWidth(theme.fg("dim", stats), width)];
  }

  /**
   * Hints wrap across as many rows as the width needs, and the meta row is always exactly one line.
   * Both the layout pass and the render pass call this with the same width, so the height agrees.
   */
  private footerLines(model: ViewerModel, width: number, total: number, rows: number): string[] {
    const theme = this.theme;
    const scroll = model.state.scroll;
    const position = total === 0
      ? "0/0"
      : `${Math.min(total, scroll + 1)}-${Math.min(total, scroll + rows)}/${total}`;
    const hints = [
      "←/→ or ⌘←/⌘→ run",
      "↑/↓ line",
      "PgUp/PgDn page",
      "Home/End edge",
      `f follow ${model.state.follow ? "on" : "off"}`,
      "r refresh",
      "Esc/q Main",
    ].join(" · ");
    const warning = model.transcript?.warning;
    const meta = `${position} · updated ${timeOfDay(model.updatedAtMs)}${warning ? ` · ${sanitizeViewerInline(warning)}` : ""}`;
    return [
      ...wrapViewerText(hints, width).map((line) => padToWidth(theme.fg("dim", line), width)),
      padToWidth(theme.fg(warning ? "warning" : "dim", meta), width),
    ];
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
    if (!model.run || !model.transcript) return [];
    const lines = renderViewerLive(model.run, model.transcript, width, this.theme);
    if (lines.length <= VIEWER_MAX_LIVE_LINES) return lines;
    return [
      ...lines.slice(0, VIEWER_MAX_LIVE_LINES - 1),
      viewerLine(this.theme.fg("dim", `… ${lines.length - VIEWER_MAX_LIVE_LINES + 1} more live line(s)`), width),
    ];
  }

  /**
   * Fits the fixed rows into the terminal by dropping the live block first, then the stats row, then
   * the Read-Only borders, then the key hints.
   *
   * The smallest layout this can produce is five rows: title, separator, one transcript row, the
   * `Read-Only` row, and one footer row. Below five rows `render` clamps to the terminal height, so
   * a 4-row terminal loses the footer and a 3-row terminal also loses the `Read-Only` row. Nothing
   * ever overflows the viewport; the survival order is a preference, not a guarantee at any height.
   */
  private layout(model: ViewerModel, width: number, rows: number): {
    header: string[];
    live: string[];
    readOnly: string[];
    footer: string[];
    transcriptRows: number;
  } {
    const fullHeader = this.headerLines(model, width);
    const fullReadOnly = this.readOnlyLines(width);
    const fullFooter = this.footerLines(model, width, 0, 1);
    let header = fullHeader;
    let live = this.liveLines(model, width);
    let readOnly = fullReadOnly;
    let footerRows = fullFooter.length;
    const chrome = () =>
      header.length + 1 + (live.length > 0 ? live.length + 1 : 0) + readOnly.length + footerRows;
    if (chrome() + VIEWER_MIN_TRANSCRIPT_ROWS > rows) live = [];
    if (chrome() + VIEWER_MIN_TRANSCRIPT_ROWS > rows) header = fullHeader.slice(0, 1);
    if (chrome() + 1 > rows) readOnly = [fullReadOnly[1]];
    if (chrome() + 1 > rows) footerRows = 1;
    return {
      header,
      live,
      readOnly,
      footer: fullFooter.slice(fullFooter.length - footerRows),
      transcriptRows: Math.max(1, rows - chrome()),
    };
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const rows = this.rows();
    this.lastWidth = safeWidth;
    const model = this.controller.model();
    if (
      this.cache && this.cache.width === safeWidth &&
      this.cache.revision === model.revision && this.cache.rows === rows
    ) return this.cache.lines;

    const theme = this.theme;
    const { header, live, readOnly, footer, transcriptRows } = this.layout(model, safeWidth, rows);
    // The data layer replaces the transcript object whenever the file changes, so identity is an
    // exact change test. Scroll, follow, and activity updates therefore reuse the rendered body.
    const body = this.bodyCache && this.bodyCache.width === safeWidth && this.bodyCache.transcript === model.transcript
      ? this.bodyCache.lines
      : (() => {
        const lines = model.transcript
          ? renderViewerTranscript(model.transcript, safeWidth, theme)
          : [padToWidth(theme.fg("dim", "Loading transcript…"), safeWidth)];
        this.bodyCache = { width: safeWidth, transcript: model.transcript, lines };
        return lines;
      })();
    const maxScroll = Math.max(0, body.length - transcriptRows);
    if (model.state.follow) model.state.scroll = maxScroll;
    model.state.scroll = Math.max(0, Math.min(model.state.scroll, maxScroll));
    const visible = body.slice(model.state.scroll, model.state.scroll + transcriptRows);
    const separator = padToWidth(theme.fg("dim", "─".repeat(safeWidth)), safeWidth);

    const lines: string[] = [...header, separator];
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
    const rendered = this.footerLines(model, safeWidth, body.length, transcriptRows);
    lines.push(...rendered.slice(rendered.length - footer.length));
    while (lines.length < rows) lines.push(padToWidth("", safeWidth));
    const clamped = lines.slice(0, Math.max(1, rows));
    this.cache = { width: safeWidth, revision: model.revision, rows, lines: clamped };
    return clamped;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.super("right")) || matchesKey(data, Key.right)) {
      this.controller.step(1);
      return;
    }
    if (matchesKey(data, Key.super("left")) || matchesKey(data, Key.left)) {
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
}

/** The key-handling surface the component needs, kept narrow so tests can drive it directly. */
export interface SubagentViewerKeyTarget {
  model(): ViewerModel;
  now(): number;
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
  private readonly setIntervalFn: (callback: () => void, ms: number) => TimerHandle;
  private readonly clearIntervalFn: (timer: TimerHandle) => void;
  private readonly nowMs: () => number;
  private readonly refreshMs: number;
  private readonly viewStates = new Map<string, ViewerViewState>();
  private readonly transcripts = new Map<string, ViewerTranscript>();
  private readonly fingerprints = new Map<string, string>();
  private readonly readAt = new Map<string, number>();
  private runs: ViewerRunSnapshot[] = [];
  private activeIds: string[] = [];
  private childSessionDir: string | undefined;
  private currentRunId: string | undefined;
  private component: SubagentViewerComponent | undefined;
  private tui: TUI | undefined;
  private done: ((value: void) => void) | undefined;
  /** The host's handle for this viewer's own overlay entry. Removal is by identity, never by rank. */
  private handle: OverlayHandle | undefined;
  private openPromise: Promise<void> | undefined;
  private abandonOpen: (() => void) | undefined;
  private timer: TimerHandle | undefined;
  private generation = 0;
  private revision = 0;
  private opened = false;
  private goneTicks = 0;
  private readToken: number | undefined;
  private readSequence = 0;
  private pendingRead = false;
  private pendingForce = false;

  constructor(options: SubagentViewerOptions) {
    this.options = options;
    this.loadTranscript = options.loadTranscript ?? loadViewerTranscript;
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

  model(): ViewerModel {
    const runId = this.currentRunId;
    const run = runId === undefined ? undefined : this.runs.find((candidate) => candidate.id === runId);
    return {
      run,
      index: runId === undefined ? -1 : this.activeIds.indexOf(runId),
      total: this.activeIds.length,
      transcript: runId === undefined ? undefined : this.transcripts.get(runId),
      state: this.viewState(runId),
      updatedAtMs: runId === undefined ? undefined : this.readAt.get(runId),
      revision: this.revision,
    };
  }

  private viewState(runId: string | undefined): ViewerViewState {
    if (runId === undefined) return { scroll: 0, follow: true };
    let state = this.viewStates.get(runId);
    if (!state) {
      state = { scroll: 0, follow: true };
      this.viewStates.set(runId, state);
    }
    return state;
  }

  private bump(): void {
    this.revision += 1;
  }

  private requestRender(): void {
    if (!this.opened) return;
    this.component?.invalidate();
    this.tui?.requestRender();
  }

  /**
   * One shortcut press from Main.
   * An empty active set notifies exactly once and leaves the caller in Main with no overlay.
   */
  async handleShortcut(
    ui: SubagentViewerUI,
    direction: 1 | -1,
    options: { enabled?: boolean } = {},
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
    await this.openOverlay(ui, snapshot, selected);
  }

  private adoptSnapshot(snapshot: ViewerSnapshot): void {
    this.runs = snapshot.runs.map((run) => run);
    this.activeIds = this.runs.map((run) => run.id);
    this.childSessionDir = snapshot.childSessionDir;
    const known = new Set(this.activeIds);
    for (const id of [...this.viewStates.keys()]) if (!known.has(id)) this.viewStates.delete(id);
    for (const id of [...this.transcripts.keys()]) if (!known.has(id)) this.transcripts.delete(id);
    for (const id of [...this.fingerprints.keys()]) if (!known.has(id)) this.fingerprints.delete(id);
    for (const id of [...this.readAt.keys()]) if (!known.has(id)) this.readAt.delete(id);
  }

  private async openOverlay(ui: SubagentViewerUI, snapshot: ViewerSnapshot, runId: string): Promise<void> {
    this.generation += 1;
    const generation = this.generation;
    this.opened = true;
    this.handle = undefined;
    this.goneTicks = 0;
    this.adoptSnapshot(snapshot);
    this.currentRunId = runId;
    this.viewState(runId);
    this.bump();
    this.startTimer(generation);
    this.scheduleRead(generation);
    let promise: Promise<void>;
    try {
      promise = ui.custom<void>((tui, theme, _keybindings, done) => {
        const component = new SubagentViewerComponent({
          tui,
          theme: theme as unknown as ViewerTheme,
          controller: this,
        });
        // A close that lands before the host builds the component must not adopt this overlay.
        // Resolving marks the open closed so the component is never mounted, but it is only safe
        // while the host has nothing to pop; otherwise the `onHandle` guard below removes the
        // late entry instead of letting `done` dismiss a foreign overlay.
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
        // The public handle is the only way to remove exactly this overlay entry. Without it the
        // host's `done` would call `hideOverlay()`, which pops whatever is on top of the stack.
        onHandle: (handle: OverlayHandle) => {
          if (generation !== this.generation) {
            // The close already ran for this open, so the entry is unwanted the moment it exists.
            try { handle.hide(); } catch { /* the host already dropped this entry */ }
            return;
          }
          this.handle = handle;
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
   * viewer. Under a foreign overlay that would dismiss the foreign one and leave the viewer entry
   * behind as a full-screen zombie that reappears the moment the foreign overlay goes away.
   *
   * The raw `ui.custom` promise stays pending, but the host keeps no promise registry and the handle
   * has already removed its overlay entry. Once local references are cleared, that isolated object
   * island is unreachable and can be collected. The viewer awaits the internal race below, so no
   * caller ever waits on the orphan.
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
      try { (component as { dispose?: () => void } | undefined)?.dispose?.(); }
      catch { /* a component dispose failure must not block teardown */ }
      this.teardown(generation);
      return;
    }
    // No handle yet: the host has not shown an overlay for this open, so `done` is still the right
    // answer. It also marks the pending open as closed, which stops the factory result from ever
    // being mounted. It is only safe while the stack has nothing for `hideOverlay` to pop; if some
    // other overlay is up, the `onHandle` guard above removes this entry instead.
    const resolvable = done !== undefined && !(typeof this.tui?.hasOverlay === "function" && this.tui.hasOverlay());
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

  /** Periodic reconciliation: adopt the new snapshot, keep or move the selection, refresh the read. */
  private refresh(generation: number): void {
    if (generation !== this.generation || !this.opened) return;
    const previousIds = this.activeIds;
    const snapshot = this.options.snapshot();
    const runId = this.currentRunId;
    const nextIds = snapshot.runs.map((run) => run.id);
    const signature = this.signature();
    this.adoptSnapshot(snapshot);
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
    if (signature !== this.signature()) {
      this.bump();
      this.requestRender();
    }
  }

  /** Cheap change detector, so an idle viewer never repaints on the 250 ms tick. */
  private signature(): string {
    const runId = this.currentRunId;
    const run = runId === undefined ? undefined : this.runs.find((candidate) => candidate.id === runId);
    const transcript = runId === undefined ? undefined : this.transcripts.get(runId);
    return JSON.stringify([
      runId,
      this.activeIds,
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
      transcript?.fingerprint,
      transcript?.status,
      transcript?.warning,
    ]);
  }

  private select(runId: string, generation: number): void {
    if (generation !== this.generation || !this.opened) return;
    this.currentRunId = runId;
    this.viewState(runId);
    this.bump();
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
    const fingerprint = force ? undefined : this.fingerprints.get(runId);
    const childSessionDir = this.childSessionDir;
    this.readSequence += 1;
    const token = this.readSequence;
    this.readToken = token;
    void Promise.resolve()
      .then(() => this.loadTranscript(childSessionDir, run.sessionFile, fingerprint))
      .then((load) => {
        if (generation !== this.generation || !this.opened) return;
        if (load.fingerprint !== undefined) this.fingerprints.set(runId, load.fingerprint);
        if (load.status === "unchanged" || !load.transcript) return;
        this.transcripts.set(runId, load.transcript);
        this.readAt.set(runId, this.nowMs());
        this.bump();
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
    const next = cycleViewerSelection(this.activeIds, this.currentRunId, direction);
    if (next === undefined) {
      this.requestClose();
      return;
    }
    if (next === this.currentRunId) return;
    this.select(next, this.generation);
  }

  scrollBy(delta: number): void {
    if (!this.opened) return;
    const state = this.viewState(this.currentRunId);
    state.scroll = Math.max(0, state.scroll + delta);
    state.follow = false;
    this.bump();
    this.requestRender();
  }

  scrollToTop(): void {
    if (!this.opened) return;
    const state = this.viewState(this.currentRunId);
    state.scroll = 0;
    state.follow = false;
    this.bump();
    this.requestRender();
  }

  scrollToBottom(): void {
    if (!this.opened) return;
    const state = this.viewState(this.currentRunId);
    state.follow = true;
    state.scroll = Number.MAX_SAFE_INTEGER;
    this.bump();
    this.requestRender();
  }

  toggleFollow(): void {
    if (!this.opened) return;
    const state = this.viewState(this.currentRunId);
    state.follow = !state.follow;
    if (state.follow) state.scroll = Number.MAX_SAFE_INTEGER;
    this.bump();
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
    this.fingerprints.clear();
    this.readAt.clear();
    this.runs = [];
    this.activeIds = [];
    this.childSessionDir = undefined;
    this.currentRunId = undefined;
  }

  private teardown(generation: number): void {
    if (generation !== this.generation) return;
    // A later timer tick or read completion can no longer match this generation, so nothing revives.
    this.generation += 1;
    this.stopTimer();
    this.opened = false;
    this.goneTicks = 0;
    this.openPromise = undefined;
    this.done = undefined;
    this.handle = undefined;
    this.component = undefined;
    this.tui = undefined;
    this.currentRunId = undefined;
    this.readToken = undefined;
    this.pendingRead = false;
    this.pendingForce = false;
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
