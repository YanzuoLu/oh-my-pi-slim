import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { PublicLoop } from "./loop-runtime.js";
import { formatSemanticGlyphPrefix } from "./semantic-glyph.js";

export const LOOP_WIDGET_KEY = "oh-my-pi-slim:loops";
export const MAX_LOOP_WIDGET_LINES = 12;
export const MAX_VISIBLE_LOOPS = 5;

export interface LoopWidgetTui {
  requestRender(force?: boolean): void;
}

interface LoopWidgetUI {
  readonly theme: Theme;
  setWidget(
    key: string,
    content: undefined | ((tui: LoopWidgetTui, theme: Theme) => { render(width: number): string[]; invalidate(): void }),
    options?: { placement?: "aboveEditor" | "belowEditor" },
  ): void;
}

export interface LoopWidgetOptions {
  nowMs?: () => number;
  setInterval?: (callback: () => void, milliseconds: number) => unknown;
  clearInterval?: (timer: unknown) => void;
}

export function sanitizeLoopText(value: unknown): string {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
}

export function sanitizeLoopBody(value: unknown): string {
  return String(value ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, " ");
}

function parsedTime(value: string | null): number {
  if (value === null) return Number.POSITIVE_INFINITY;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

export function sortLoopsForDisplay(loops: readonly PublicLoop[]): PublicLoop[] {
  return loops
    .map((loop, index) => ({ loop, index }))
    .sort((left, right) => {
      if (left.loop.status !== right.loop.status) return left.loop.status === "active" ? -1 : 1;
      if (left.loop.status === "active") {
        const leftNext = parsedTime(left.loop.nextFireAt);
        const rightNext = parsedTime(right.loop.nextFireAt);
        if (leftNext !== rightNext) return leftNext < rightNext ? -1 : 1;
      }
      const leftCreated = parsedTime(left.loop.createdAt);
      const rightCreated = parsedTime(right.loop.createdAt);
      return leftCreated === rightCreated ? left.index - right.index : leftCreated < rightCreated ? -1 : 1;
    })
    .map(({ loop }) => loop);
}

export function formatLoopCountdown(nextFireAt: string | null, nowMs: number): string {
  const next = parsedTime(nextFireAt);
  if (!Number.isFinite(next)) return "—";
  let seconds = Math.max(0, Math.ceil((next - nowMs) / 1_000));
  const days = Math.floor(seconds / 86_400);
  seconds -= days * 86_400;
  const hours = Math.floor(seconds / 3_600);
  seconds -= hours * 3_600;
  const minutes = Math.floor(seconds / 60);
  seconds -= minutes * 60;
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  if (minutes > 0) return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  return `${seconds}s`;
}

function fireLabel(count: number): string {
  return `${count} fire${count === 1 ? "" : "s"}`;
}

function failureLabel(count: number): string {
  return `${count} failure${count === 1 ? "" : "s"}`;
}

function loopGlyph(loop: PublicLoop, theme: Theme): string {
  if (loop.status === "paused") return theme.fg("dim", "Ⅱ");
  if (loop.lastError) return theme.fg("error", "!");
  return theme.fg("accent", "↻");
}

function firstLine(
  loop: PublicLoop,
  theme: Theme,
  width: number,
  branch: "├─" | "└─",
): string {
  const prefix = `${theme.fg("dim", branch)} ${formatSemanticGlyphPrefix(loopGlyph(loop, theme))}`;
  const suffix = ` ${theme.fg("dim", `[${sanitizeLoopText(loop.id).slice(0, 8)}]`)}`;
  const abstractWidth = Math.max(0, width - visibleWidth(prefix) - visibleWidth(suffix));
  const abstract = truncateToWidth(sanitizeLoopText(loop.abstract), abstractWidth, "…");
  return truncateToWidth(`${prefix}${theme.fg(loop.status === "paused" ? "muted" : "text", abstract)}${suffix}`, Math.max(1, width), "…");
}

function secondLine(loop: PublicLoop, theme: Theme, width: number, continues: boolean, nowMs: number): string {
  const tree = theme.fg("dim", continues ? "│  └─" : "   └─");
  const parts = [`Every ${sanitizeLoopText(loop.interval)}`];
  if (loop.status === "paused") {
    parts.push("paused", fireLabel(loop.fireCount));
  } else {
    parts.push(`next in ${formatLoopCountdown(loop.nextFireAt, nowMs)}`, fireLabel(loop.fireCount));
    if (loop.lastError) parts.push(`${failureLabel(loop.failureCount)}: ${sanitizeLoopText(loop.lastError)}`);
  }
  return truncateToWidth(`${tree} ${theme.fg(loop.lastError && loop.status === "active" ? "error" : "dim", parts.join(" · "))}`, Math.max(1, width), "…");
}

/** Ratio-free heading: filled accent bold while any loop is active, hollow dim once every loop is paused. */
function loopWidgetHeading(loops: readonly PublicLoop[], theme: Theme): string {
  const active = loops.some((loop) => loop.status === "active");
  const role = active ? "accent" : "dim";
  const glyph = active ? theme.bold("●") : "○";
  const label = active ? theme.bold("Loops") : "Loops";
  return `${formatSemanticGlyphPrefix(theme.fg(role, glyph))}${theme.fg(role, label)}`;
}

export function renderLoopWidgetLines(
  loops: readonly PublicLoop[],
  theme: Theme,
  width: number,
  nowMs = Date.now(),
): string[] {
  if (loops.length === 0) return [];
  const safeWidth = Math.max(1, width);
  const sorted = sortLoopsForDisplay(loops);
  const visible = sorted.slice(0, MAX_VISIBLE_LOOPS);
  const hidden = sorted.length - visible.length;
  const lines = [truncateToWidth(loopWidgetHeading(sorted, theme), safeWidth, "…")];

  for (let index = 0; index < visible.length; index += 1) {
    const continues = index < visible.length - 1 || hidden > 0;
    lines.push(firstLine(visible[index], theme, safeWidth, continues ? "├─" : "└─"));
    lines.push(secondLine(visible[index], theme, safeWidth, continues, nowMs));
  }
  if (hidden > 0) {
    lines.push(truncateToWidth(`${theme.fg("dim", "└─")} ${theme.fg("dim", `… ${hidden} more`)}`, safeWidth, "…"));
  }
  return lines.slice(0, MAX_LOOP_WIDGET_LINES);
}

export class LoopWidget {
  private ui: LoopWidgetUI | undefined;
  private tui: LoopWidgetTui | undefined;
  private registered = false;
  private timer: unknown;
  private readonly listLoops: () => PublicLoop[];
  private readonly nowMs: () => number;
  private readonly setIntervalFn: (callback: () => void, milliseconds: number) => unknown;
  private readonly clearIntervalFn: (timer: unknown) => void;

  constructor(listLoops: () => PublicLoop[], options: LoopWidgetOptions = {}) {
    this.listLoops = listLoops;
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.setIntervalFn = options.setInterval ?? ((callback, milliseconds) => setInterval(callback, milliseconds));
    this.clearIntervalFn = options.clearInterval ?? ((timer) => clearInterval(timer as ReturnType<typeof setInterval>));
  }

  setContext(ui: ExtensionUIContext | undefined): void {
    const next = ui as LoopWidgetUI | undefined;
    if (this.ui === next) {
      this.update();
      return;
    }
    if (this.registered && this.ui) this.ui.setWidget(LOOP_WIDGET_KEY, undefined);
    this.stopTimer();
    this.ui = next;
    this.tui = undefined;
    this.registered = false;
    this.update();
  }

  private ensureTimer(): void {
    if (this.timer !== undefined) return;
    this.timer = this.setIntervalFn(() => this.update(), 1_000);
    (this.timer as { unref?: () => void }).unref?.();
  }

  private stopTimer(): void {
    if (this.timer === undefined) return;
    this.clearIntervalFn(this.timer);
    this.timer = undefined;
  }

  update(): void {
    if (!this.ui) {
      this.stopTimer();
      return;
    }
    const loops = this.listLoops();
    if (loops.length === 0) {
      if (this.registered) this.ui.setWidget(LOOP_WIDGET_KEY, undefined);
      this.registered = false;
      this.tui = undefined;
      this.stopTimer();
      return;
    }

    this.ensureTimer();
    if (!this.registered) {
      this.ui.setWidget(LOOP_WIDGET_KEY, (tui, theme) => {
        this.tui = tui;
        return {
          render: (width: number) => renderLoopWidgetLines(this.listLoops(), this.ui?.theme ?? theme, width, this.nowMs()),
          invalidate() {},
        };
      }, { placement: "aboveEditor" });
      this.registered = true;
      return;
    }
    this.tui?.requestRender();
  }

  dispose(): void {
    this.stopTimer();
    if (this.registered && this.ui) this.ui.setWidget(LOOP_WIDGET_KEY, undefined);
    this.ui = undefined;
    this.tui = undefined;
    this.registered = false;
  }
}
