/**
 * Adapted from gotgenes/pi-packages packages/pi-subagents/src/ui/agent-widget.ts.
 * Copyright (c) 2026 tintinweb. MIT licensed; see THIRD_PARTY_NOTICES.md.
 */

import type { PersistedRun, RunStatus } from "./subagent-core.js";
import { hasActiveSubagentRuns, renderSubagentWidgetLines } from "./subagent-widget-renderer.js";
import { widgetStackHost, type WidgetStackUI } from "./widget-stack-host.js";
import type { WidgetStackSection } from "./widget-stack.js";

export const AGENTS_SECTION_ID = "agents";
export const AGENTS_WIDGET_OWNER = "oh-my-pi-slim:subagent-widget";

interface RunSummary {
  readonly id: string;
  readonly status: RunStatus;
}

export interface SubagentWidgetState {
  readonly runningCount: number;
  readonly waitingCount: number;
  readonly queuedCount: number;
  readonly hasFinished: boolean;
  readonly hasActive: boolean;
}

/** Retained runs keep the widget mounted until `subagent delete` or `subagent clear` removes them. */
export function assembleSubagentWidgetState(runs: readonly RunSummary[]): SubagentWidgetState {
  let runningCount = 0;
  let waitingCount = 0;
  let queuedCount = 0;
  let hasFinished = false;
  for (const run of runs) {
    if (run.status === "running") runningCount += 1;
    else if (run.status === "waiting") waitingCount += 1;
    else if (run.status === "starting") queuedCount += 1;
    else hasFinished = true;
  }
  return {
    runningCount,
    waitingCount,
    queuedCount,
    hasFinished,
    hasActive: runningCount > 0 || waitingCount > 0 || queuedCount > 0,
  };
}

interface WidgetOptions {
  setInterval?: (callback: () => void, ms: number) => unknown;
  clearInterval?: (timer: unknown) => void;
}

export class SubagentWidget {
  private uiCtx: WidgetStackUI | undefined;
  private widgetFrame = 0;
  private widgetInterval: unknown;
  private published = false;
  private readonly section: WidgetStackSection;
  private readonly listRuns: () => PersistedRun[];
  private readonly setIntervalFn: (callback: () => void, ms: number) => unknown;
  private readonly clearIntervalFn: (timer: unknown) => void;

  constructor(listRuns: () => PersistedRun[], options: WidgetOptions = {}) {
    this.listRuns = listRuns;
    this.setIntervalFn = options.setInterval ?? ((callback, ms) => setInterval(callback, ms));
    this.clearIntervalFn = options.clearInterval ?? ((timer) => clearInterval(timer as ReturnType<typeof setInterval>));
    this.section = {
      id: AGENTS_SECTION_ID,
      isActive: () => hasActiveSubagentRuns(this.listRuns()),
      render: (input) => renderSubagentWidgetLines({
        runs: this.listRuns(),
        spinnerFrame: this.widgetFrame,
        terminalWidth: input.width,
        theme: input.theme,
      }),
    };
  }

  setUICtx(ctx: WidgetStackUI | undefined): void {
    if (ctx === this.uiCtx) {
      // Re-binding the same UI is how a tree restore reclaims the host after `dispose` released it.
      if (ctx) widgetStackHost().bind(AGENTS_WIDGET_OWNER, ctx);
      return;
    }
    this.retract();
    if (this.uiCtx) widgetStackHost().unbind(AGENTS_WIDGET_OWNER, this.uiCtx);
    this.uiCtx = ctx;
    if (ctx) widgetStackHost().bind(AGENTS_WIDGET_OWNER, ctx);
  }

  onTurnStart(): void {
    this.update();
  }

  private ensureTimer(): void {
    this.widgetInterval ??= this.setIntervalFn(() => this.tick(), 80);
  }

  private tick(): void {
    if (!this.uiCtx) return;
    this.widgetFrame += 1;
    this.update();
  }

  /** Removes this widget's own section; the host clears the aggregate only when the last one leaves. */
  private retract(): void {
    if (!this.published) return;
    this.published = false;
    widgetStackHost().publish(AGENTS_SECTION_ID, undefined);
  }

  private clearWidget(): void {
    this.retract();
    if (this.widgetInterval !== undefined) {
      this.clearIntervalFn(this.widgetInterval);
      this.widgetInterval = undefined;
    }
  }

  update(): void {
    if (!this.uiCtx) return;
    const runs = this.listRuns();
    const state = assembleSubagentWidgetState(runs);
    if (!state.hasActive && !state.hasFinished) {
      this.clearWidget();
      return;
    }

    if (state.hasActive) this.ensureTimer();
    if (!this.published) {
      this.published = true;
      widgetStackHost().publish(AGENTS_SECTION_ID, this.section);
      return;
    }
    widgetStackHost().requestRender();
  }

  dispose(): void {
    if (this.widgetInterval !== undefined) {
      this.clearIntervalFn(this.widgetInterval);
      this.widgetInterval = undefined;
    }
    this.retract();
    if (this.uiCtx) widgetStackHost().unbind(AGENTS_WIDGET_OWNER, this.uiCtx);
    // Dropping the UI here is what makes a spinner tick that lands after dispose a no-op.
    this.uiCtx = undefined;
  }
}
