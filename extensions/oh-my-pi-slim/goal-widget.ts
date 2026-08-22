import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { GoalExecutionStats, GoalStatus, GoalView } from "./goal-runtime.js";
import { formatSemanticGlyphPrefix } from "./semantic-glyph.js";
import { widgetStackHost, type WidgetStackUI } from "./widget-stack-host.js";
import type { WidgetStackSection } from "./widget-stack.js";

export const GOAL_SECTION_ID = "goal";
export const GOAL_WIDGET_OWNER = "oh-my-pi-slim:goal-widget";

const ANSI_PATTERN = /[\u001b\u009b](?:\][^\u0007]*(?:\u0007|\u001b\\)|[\[\]()#;?]*(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*)?\u0007|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~])))/g;
const INLINE_CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f]/g;

export interface GoalWidgetOptions {
  nowMs?: () => number;
  setInterval?: (callback: () => void, milliseconds: number) => unknown;
  clearInterval?: (timer: unknown) => void;
}

export function sanitizeGoalText(value: unknown): string {
  return String(value ?? "").replace(ANSI_PATTERN, "").replace(INLINE_CONTROL_PATTERN, " ");
}

export function sanitizeGoalBody(value: unknown): string {
  return String(value ?? "")
    .replace(ANSI_PATTERN, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, " ");
}

function statusRole(status: GoalStatus): "accent" | "warning" | "dim" | "success" | "error" {
  if (status === "active") return "accent";
  if (status === "retry_wait") return "warning";
  if (status === "paused") return "dim";
  if (status === "completed") return "success";
  return "error";
}

export function goalStatusGlyph(status: GoalStatus, theme: Theme): string {
  if (status === "active") return theme.fg("accent", "↻");
  if (status === "paused") return theme.fg("dim", "Ⅱ");
  if (status === "retry_wait") return theme.fg("warning", "◷");
  if (status === "completed") return theme.fg("success", "✓");
  return theme.fg("error", "×");
}

export function formatGoalElapsed(milliseconds: number): string {
  let seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const days = Math.floor(seconds / 86_400);
  seconds -= days * 86_400;
  const hours = Math.floor(seconds / 3_600);
  seconds -= hours * 3_600;
  const minutes = Math.floor(seconds / 60);
  seconds -= minutes * 60;
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  if (minutes > 0) return `${minutes}m`;
  return `${seconds}s`;
}

export function formatGoalCountdown(nextRetryAt: string | null, nowMs: number): string {
  if (!nextRetryAt) return "0s";
  const parsed = Date.parse(nextRetryAt);
  if (!Number.isFinite(parsed)) return "0s";
  return formatGoalElapsed(Math.max(0, Math.ceil((parsed - nowMs) / 1_000) * 1_000));
}

export function compactGoalTokens(value: number): string {
  const safe = Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  if (safe < 1_000) return String(safe);
  const compact = (amount: number, suffix: string): string => {
    const rounded = amount >= 100 ? Math.round(amount) : Math.round(amount * 10) / 10;
    return `${String(rounded).replace(/\.0$/, "")}${suffix}`;
  };
  if (safe < 1_000_000) return compact(safe / 1_000, "k");
  return compact(safe / 1_000_000, "M");
}

function countLabel(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function statsLabel(owner: "main" | "child", stats: GoalExecutionStats): string {
  return `${owner} ${compactGoalTokens(stats.tokens)} tok/${countLabel(stats.tools, "tool")}/${countLabel(stats.turns, "turn")}/${countLabel(stats.compactions, "comp", "comp")}`;
}

/** Pursuing goals keep working; idle goals are parked, finished, or abandoned. */
export function isGoalPursuing(status: GoalStatus): boolean {
  return status === "active" || status === "retry_wait";
}

/** The prefix's own pursuing test, shared with the widget stack so both agree by construction. */
export function isGoalViewPursuing(view: GoalView): boolean {
  return view.goal ? isGoalPursuing(view.goal.status) : false;
}

/** Ratio-free prefix shared with the other persistent widgets: filled accent-or-warning bold, or hollow dim. */
function goalWidgetPrefix(status: GoalStatus, theme: Theme): string {
  const pursuing = isGoalPursuing(status);
  const role = pursuing ? statusRole(status) : "dim";
  const glyph = pursuing ? theme.bold("●") : "○";
  const label = pursuing ? theme.bold("Goal") : "Goal";
  return `${formatSemanticGlyphPrefix(theme.fg(role, glyph))}${theme.fg(role, label)}`;
}

function headingLine(view: GoalView, theme: Theme, width: number): string {
  const goal = view.goal!;
  const safeWidth = Math.max(1, width);
  const role = statusRole(goal.status);
  const heading = `${goalWidgetPrefix(goal.status, theme)} ${theme.fg("dim", "·")} ${formatSemanticGlyphPrefix(goalStatusGlyph(goal.status, theme))}${theme.fg(role, sanitizeGoalText(goal.status))} ${theme.fg("dim", "·")} `;
  if (visibleWidth(heading) >= safeWidth) return truncateToWidth(heading.trimEnd(), safeWidth, "…");
  const abstractWidth = safeWidth - visibleWidth(heading);
  const abstract = truncateToWidth(sanitizeGoalText(goal.abstract), abstractWidth, "…");
  return `${heading}${theme.fg("text", abstract)}`;
}

/** The Goal body is always a single detail row, so it always takes the last-child branch. */
function detailLine(view: GoalView, theme: Theme, width: number, nowMs: number): string {
  const goal = view.goal!;
  const tree = theme.fg("dim", "└─");
  const parts = [
    formatGoalElapsed(view.elapsedMs ?? 0),
    `${view.continuationCount} cont`,
    countLabel(view.ownedChildRunCount, "run"),
  ];
  if (goal.status === "retry_wait") parts.push(`retry in ${formatGoalCountdown(goal.nextRetryAt, nowMs)}`);
  else if (goal.status === "paused" && goal.pauseReason) parts.push(`paused ${sanitizeGoalText(goal.pauseReason)}`);
  parts.push(statsLabel("main", view.main), statsLabel("child", view.children));
  return truncateToWidth(`${tree} ${theme.fg("dim", parts.join(" · "))}`, Math.max(1, width), "…");
}

/**
 * A completed Goal is a receipt rather than live work, so it is the only status that gives a row
 * back when Pi's tool output is collapsed: the heading always stays, and the detail row is dropped.
 * Every other status keeps both rows in either state, because a Goal that is still being pursued,
 * parked, or cancelled must never hide its elapsed time, continuations, runs, or token cost.
 * The expansion flag is read from the aggregate host on every render and never stored here.
 */
export function renderGoalWidgetLines(
  view: GoalView,
  theme: Theme,
  width: number,
  nowMs = Date.now(),
  expanded = true,
): string[] {
  if (!view.goal) return [];
  const heading = headingLine(view, theme, width);
  if (!expanded && view.goal.status === "completed") return [heading];
  return [heading, detailLine(view, theme, width, nowMs)];
}

export class GoalWidget {
  private ui: WidgetStackUI | undefined;
  private published = false;
  private timer: unknown;
  private readonly section: WidgetStackSection;
  private readonly getView: () => GoalView;
  private readonly nowMs: () => number;
  private readonly setIntervalFn: (callback: () => void, milliseconds: number) => unknown;
  private readonly clearIntervalFn: (timer: unknown) => void;

  constructor(getView: () => GoalView, options: GoalWidgetOptions = {}) {
    this.getView = getView;
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.setIntervalFn = options.setInterval ?? ((callback, milliseconds) => setInterval(callback, milliseconds));
    this.clearIntervalFn = options.clearInterval ?? ((timer) => clearInterval(timer as ReturnType<typeof setInterval>));
    this.section = {
      id: GOAL_SECTION_ID,
      isActive: () => isGoalViewPursuing(this.getView()),
      render: (input) => renderGoalWidgetLines(this.getView(), input.theme, input.width, this.nowMs(), input.expanded),
    };
  }

  setContext(ui: ExtensionUIContext | undefined): void {
    const next: WidgetStackUI | undefined = ui;
    if (this.ui === next) {
      // Re-binding the same UI is how a tree restore reclaims the host after `dispose` released it.
      if (next) widgetStackHost().bind(GOAL_WIDGET_OWNER, next);
      this.update();
      return;
    }
    this.retract();
    if (this.ui) widgetStackHost().unbind(GOAL_WIDGET_OWNER, this.ui);
    this.stopTimer();
    this.ui = next;
    if (next) widgetStackHost().bind(GOAL_WIDGET_OWNER, next);
    this.update();
  }

  /** Removes this widget's own section; the host clears the aggregate only when the last one leaves. */
  private retract(): void {
    if (!this.published) return;
    this.published = false;
    widgetStackHost().publish(GOAL_SECTION_ID, undefined);
  }

  private ensureTimer(): void {
    if (this.timer !== undefined) return;
    this.timer = this.setIntervalFn(() => {
      // A tick that lands after unbind or dispose falls through to update and never republishes.
      if (!this.ui || !this.published || !this.getView().goal) {
        this.update();
        return;
      }
      widgetStackHost().requestRender();
    }, 1_000);
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
      this.retract();
      return;
    }
    const view = this.getView();
    if (!view.goal) {
      this.retract();
      this.stopTimer();
      return;
    }
    this.ensureTimer();
    if (!this.published) {
      this.published = true;
      widgetStackHost().publish(GOAL_SECTION_ID, this.section);
      return;
    }
    widgetStackHost().requestRender();
  }

  dispose(): void {
    this.stopTimer();
    this.retract();
    if (this.ui) widgetStackHost().unbind(GOAL_WIDGET_OWNER, this.ui);
    this.ui = undefined;
  }
}
