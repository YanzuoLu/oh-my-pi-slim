import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { GoalExecutionStats, GoalStatus, GoalView } from "./goal-runtime.js";
import { formatSemanticGlyphPrefix } from "./semantic-glyph.js";

export const GOAL_WIDGET_KEY = "oh-my-pi-slim:goal";

const ANSI_PATTERN = /[\u001b\u009b](?:\][^\u0007]*(?:\u0007|\u001b\\)|[\[\]()#;?]*(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*)?\u0007|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~])))/g;
const INLINE_CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f]/g;

export interface GoalWidgetTui {
  requestRender(force?: boolean): void;
}

interface GoalWidgetUI {
  readonly theme: Theme;
  setWidget(
    key: string,
    content: undefined | ((tui: GoalWidgetTui, theme: Theme) => { render(width: number): string[]; invalidate(): void }),
    options?: { placement?: "aboveEditor" | "belowEditor" },
  ): void;
}

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
function isGoalPursuing(status: GoalStatus): boolean {
  return status === "active" || status === "retry_wait";
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

function detailLine(view: GoalView, theme: Theme, width: number, nowMs: number): string {
  const goal = view.goal!;
  const parts = [
    formatGoalElapsed(view.elapsedMs ?? 0),
    `${view.continuationCount} cont`,
    countLabel(view.ownedChildRunCount, "run"),
  ];
  if (goal.status === "retry_wait") parts.push(`retry in ${formatGoalCountdown(goal.nextRetryAt, nowMs)}`);
  else if (goal.status === "paused" && goal.pauseReason) parts.push(`paused ${sanitizeGoalText(goal.pauseReason)}`);
  parts.push(statsLabel("main", view.main), statsLabel("child", view.children));
  return truncateToWidth(theme.fg("dim", parts.join(" · ")), Math.max(1, width), "…");
}

export function renderGoalWidgetLines(
  view: GoalView,
  theme: Theme,
  width: number,
  nowMs = Date.now(),
): string[] {
  if (!view.goal) return [];
  return [headingLine(view, theme, width), detailLine(view, theme, width, nowMs)];
}

export class GoalWidget {
  private ui: GoalWidgetUI | undefined;
  private tui: GoalWidgetTui | undefined;
  private registered = false;
  private timer: unknown;
  private readonly getView: () => GoalView;
  private readonly nowMs: () => number;
  private readonly setIntervalFn: (callback: () => void, milliseconds: number) => unknown;
  private readonly clearIntervalFn: (timer: unknown) => void;

  constructor(getView: () => GoalView, options: GoalWidgetOptions = {}) {
    this.getView = getView;
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.setIntervalFn = options.setInterval ?? ((callback, milliseconds) => setInterval(callback, milliseconds));
    this.clearIntervalFn = options.clearInterval ?? ((timer) => clearInterval(timer as ReturnType<typeof setInterval>));
  }

  setContext(ui: ExtensionUIContext | undefined): void {
    const next = ui as GoalWidgetUI | undefined;
    if (this.ui === next) {
      this.update();
      return;
    }
    if (this.registered && this.ui) this.ui.setWidget(GOAL_WIDGET_KEY, undefined);
    this.stopTimer();
    this.ui = next;
    this.tui = undefined;
    this.registered = false;
    this.update();
  }

  private ensureTimer(): void {
    if (this.timer !== undefined) return;
    this.timer = this.setIntervalFn(() => {
      if (!this.ui || !this.registered || !this.getView().goal) {
        this.update();
        return;
      }
      this.tui?.requestRender();
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
      return;
    }
    const view = this.getView();
    if (!view.goal) {
      if (this.registered) this.ui.setWidget(GOAL_WIDGET_KEY, undefined);
      this.registered = false;
      this.tui = undefined;
      this.stopTimer();
      return;
    }
    this.ensureTimer();
    if (!this.registered) {
      this.ui.setWidget(GOAL_WIDGET_KEY, (tui, theme) => {
        this.tui = tui;
        return {
          render: (width: number) => renderGoalWidgetLines(this.getView(), this.ui?.theme ?? theme, width, this.nowMs()),
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
    if (this.registered && this.ui) this.ui.setWidget(GOAL_WIDGET_KEY, undefined);
    this.ui = undefined;
    this.tui = undefined;
    this.registered = false;
  }
}
