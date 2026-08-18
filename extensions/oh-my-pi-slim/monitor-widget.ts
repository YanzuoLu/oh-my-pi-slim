import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { MonitorStateChange, MonitorStatus } from "./monitor-runtime.js";

export const MONITOR_WIDGET_KEY = "oh-my-pi-slim:monitors";
export const MAX_MONITOR_WIDGET_LINES = 12;
export const MAX_VISIBLE_MONITORS = 10;
export const MONITOR_RENDER_THROTTLE_MS = 110;

const ANSI_PATTERN = /[\u001b\u009b](?:\][^\u0007]*(?:\u0007|\u001b\\)|[\[\]()#;?]*(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*)?\u0007|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~])))/g;
const INLINE_CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f]/g;

export interface MonitorWidgetItem {
  id: string;
  status: MonitorStatus;
  abstract: string;
  createdAt: string;
  endedAt: string | null;
}

export interface MonitorWidgetTui {
  requestRender(force?: boolean): void;
}

interface MonitorWidgetUI {
  readonly theme: Theme;
  setWidget(
    key: string,
    content: undefined | ((tui: MonitorWidgetTui, theme: Theme) => { render(width: number): string[]; invalidate(): void }),
    options?: { placement?: "aboveEditor" | "belowEditor" },
  ): void;
}

export interface MonitorWidgetOptions {
  throttleMs?: number;
  setTimeout?: (callback: () => void, milliseconds: number) => unknown;
  clearTimeout?: (timer: unknown) => void;
}

export function sanitizeMonitorText(value: unknown): string {
  return String(value ?? "").replace(ANSI_PATTERN, "").replace(INLINE_CONTROL_PATTERN, " ");
}

export function sanitizeMonitorBody(value: unknown): string {
  return String(value ?? "")
    .replace(ANSI_PATTERN, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, " ");
}

function parsedTime(value: string | null, fallback: number): number {
  if (value === null) return fallback;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function sortMonitorsForDisplay(monitors: readonly MonitorWidgetItem[]): MonitorWidgetItem[] {
  return monitors
    .map((monitor, index) => ({ monitor, index }))
    .sort((left, right) => {
      const leftRunning = left.monitor.status === "running";
      const rightRunning = right.monitor.status === "running";
      if (leftRunning !== rightRunning) return leftRunning ? -1 : 1;
      if (leftRunning) {
        const leftCreated = parsedTime(left.monitor.createdAt, Number.POSITIVE_INFINITY);
        const rightCreated = parsedTime(right.monitor.createdAt, Number.POSITIVE_INFINITY);
        if (leftCreated !== rightCreated) return leftCreated < rightCreated ? -1 : 1;
      } else {
        const leftEnded = parsedTime(left.monitor.endedAt, Number.NEGATIVE_INFINITY);
        const rightEnded = parsedTime(right.monitor.endedAt, Number.NEGATIVE_INFINITY);
        if (leftEnded !== rightEnded) return leftEnded > rightEnded ? -1 : 1;
      }
      return left.index - right.index;
    })
    .map(({ monitor }) => monitor);
}

export function monitorStatusGlyph(status: MonitorStatus, theme: Theme): string {
  if (status === "running") return theme.fg("accent", "↻");
  if (status === "completed") return theme.fg("success", "✓");
  if (status === "failed") return theme.fg("error", "!");
  return theme.fg("warning", "×");
}

function monitorStatusRole(status: MonitorStatus): "accent" | "success" | "error" | "warning" {
  if (status === "running") return "accent";
  if (status === "completed") return "success";
  if (status === "failed") return "error";
  return "warning";
}

function monitorLine(
  monitor: MonitorWidgetItem,
  theme: Theme,
  width: number,
  branch: "├─" | "└─",
): string {
  const safeWidth = Math.max(1, width);
  const id = sanitizeMonitorText(monitor.id).slice(0, 8);
  const status = sanitizeMonitorText(monitor.status);
  const glyph = monitorStatusGlyph(monitor.status, theme);
  const treePrefix = `${theme.fg("dim", branch)} ${glyph} `;
  const glyphPrefix = `${glyph} `;
  const suffix = ` ${theme.fg("dim", `[${id}]`)} ${theme.fg("dim", "·")} ${theme.fg(monitorStatusRole(monitor.status), status)}`;
  const abstract = sanitizeMonitorText(monitor.abstract).trim();

  let prefix = treePrefix;
  if (visibleWidth(prefix) + visibleWidth(suffix) > safeWidth && visibleWidth(glyphPrefix) + visibleWidth(suffix) <= safeWidth) {
    prefix = glyphPrefix;
  }
  if (visibleWidth(prefix) + visibleWidth(suffix) <= safeWidth) {
    const abstractWidth = Math.max(0, safeWidth - visibleWidth(prefix) - visibleWidth(suffix));
    const body = truncateToWidth(abstract, abstractWidth, "…");
    return `${prefix}${theme.fg("text", body)}${suffix}`;
  }
  if (visibleWidth(suffix.trimStart()) <= safeWidth) return suffix.trimStart();
  return truncateToWidth(`${glyphPrefix}${theme.fg("dim", `[${id}] · ${status}`)}`, safeWidth, "…");
}

export function renderMonitorWidgetLines(
  monitors: readonly MonitorWidgetItem[],
  theme: Theme,
  width: number,
): string[] {
  if (monitors.length === 0) return [];
  const safeWidth = Math.max(1, width);
  const sorted = sortMonitorsForDisplay(monitors);
  const running = sorted.filter((monitor) => monitor.status === "running").length;
  const visible = sorted.slice(0, MAX_VISIBLE_MONITORS);
  const hidden = sorted.length - visible.length;
  const lines = [truncateToWidth(
    theme.fg(running > 0 ? "accent" : "dim", theme.bold(`● Monitors (${running}/${sorted.length})`)),
    safeWidth,
    "…",
  )];

  for (let index = 0; index < visible.length; index += 1) {
    const continues = index < visible.length - 1 || hidden > 0;
    lines.push(monitorLine(visible[index], theme, safeWidth, continues ? "├─" : "└─"));
  }
  if (hidden > 0) {
    lines.push(truncateToWidth(`${theme.fg("dim", "└─")} ${theme.fg("dim", `… ${hidden} more`)}`, safeWidth, "…"));
  }
  return lines.slice(0, MAX_MONITOR_WIDGET_LINES);
}

export class MonitorWidget {
  private ui: MonitorWidgetUI | undefined;
  private tui: MonitorWidgetTui | undefined;
  private registered = false;
  private renderTimer: unknown;
  private readonly listMonitors: () => MonitorWidgetItem[];
  private readonly throttleMs: number;
  private readonly setTimeoutFn: (callback: () => void, milliseconds: number) => unknown;
  private readonly clearTimeoutFn: (timer: unknown) => void;

  constructor(listMonitors: () => MonitorWidgetItem[], options: MonitorWidgetOptions = {}) {
    this.listMonitors = listMonitors;
    this.throttleMs = options.throttleMs ?? MONITOR_RENDER_THROTTLE_MS;
    this.setTimeoutFn = options.setTimeout ?? ((callback, milliseconds) => setTimeout(callback, milliseconds));
    this.clearTimeoutFn = options.clearTimeout ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  }

  setContext(ui: ExtensionUIContext | undefined): void {
    const next = ui as MonitorWidgetUI | undefined;
    if (this.ui === next) return;
    if (this.registered && this.ui) this.ui.setWidget(MONITOR_WIDGET_KEY, undefined);
    this.cancelScheduledRender();
    this.ui = next;
    this.tui = undefined;
    this.registered = false;
  }

  handleChange(change: MonitorStateChange): void {
    if (!this.ui) return;
    if (change.reason === "output") {
      this.scheduleRender();
      return;
    }
    this.update();
  }

  private scheduleRender(): void {
    if (!this.ui) return;
    if (!this.registered) {
      this.update();
      return;
    }
    if (this.renderTimer !== undefined) return;
    this.renderTimer = this.setTimeoutFn(() => {
      this.renderTimer = undefined;
      if (!this.ui || !this.registered) return;
      this.tui?.requestRender();
    }, this.throttleMs);
    (this.renderTimer as { unref?: () => void }).unref?.();
  }

  private cancelScheduledRender(): void {
    if (this.renderTimer === undefined) return;
    this.clearTimeoutFn(this.renderTimer);
    this.renderTimer = undefined;
  }

  update(): void {
    if (!this.ui) {
      this.cancelScheduledRender();
      return;
    }
    const monitors = this.listMonitors();
    if (monitors.length === 0) {
      this.cancelScheduledRender();
      if (this.registered) this.ui.setWidget(MONITOR_WIDGET_KEY, undefined);
      this.registered = false;
      this.tui = undefined;
      return;
    }

    if (!this.registered) {
      this.ui.setWidget(MONITOR_WIDGET_KEY, (tui, theme) => {
        this.tui = tui;
        return {
          render: (width: number) => renderMonitorWidgetLines(this.listMonitors(), this.ui?.theme ?? theme, width),
          invalidate() {},
        };
      }, { placement: "aboveEditor" });
      this.registered = true;
      return;
    }
    this.cancelScheduledRender();
    this.tui?.requestRender();
  }

  dispose(): void {
    this.cancelScheduledRender();
    if (this.registered && this.ui) this.ui.setWidget(MONITOR_WIDGET_KEY, undefined);
    this.ui = undefined;
    this.tui = undefined;
    this.registered = false;
  }
}
