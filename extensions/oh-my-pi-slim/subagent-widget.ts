/**
 * Adapted from gotgenes/pi-packages packages/pi-subagents/src/ui/agent-widget.ts.
 * Copyright (c) 2026 tintinweb. MIT licensed; see THIRD_PARTY_NOTICES.md.
 */

import type { PersistedRun, RunStatus } from "./subagent-core.js";
import { renderSubagentWidgetLines, type WidgetTheme } from "./subagent-widget-renderer.js";

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

export function assembleSubagentWidgetState(
  runs: readonly RunSummary[],
  shouldShowFinished: (runId: string, status: RunStatus) => boolean,
): SubagentWidgetState {
  let runningCount = 0;
  let waitingCount = 0;
  let queuedCount = 0;
  let hasFinished = false;
  for (const run of runs) {
    if (run.status === "running") runningCount += 1;
    else if (run.status === "waiting") waitingCount += 1;
    else if (run.status === "starting") queuedCount += 1;
    else if (shouldShowFinished(run.id, run.status)) hasFinished = true;
  }
  return {
    runningCount,
    waitingCount,
    queuedCount,
    hasFinished,
    hasActive: runningCount > 0 || waitingCount > 0 || queuedCount > 0,
  };
}

export interface SubagentWidgetTui {
  readonly terminal: { readonly columns: number };
  requestRender(): void;
}

export interface SubagentWidgetUI {
  setStatus(key: string, text: string | undefined): void;
  setWidget(
    key: string,
    content: undefined | ((tui: SubagentWidgetTui, theme: WidgetTheme) => { render(): string[]; invalidate(): void }),
    options?: { placement?: "aboveEditor" | "belowEditor" },
  ): void;
}

interface WidgetOptions {
  setInterval?: (callback: () => void, ms: number) => unknown;
  clearInterval?: (timer: unknown) => void;
}

const ERROR_STATUSES = new Set<RunStatus>(["failed", "interrupted"]);

export class SubagentWidget {
  private uiCtx: SubagentWidgetUI | undefined;
  private widgetFrame = 0;
  private widgetInterval: unknown;
  private finishedTurnAge = new Map<string, number>();
  private widgetRegistered = false;
  private tui: SubagentWidgetTui | undefined;
  private lastStatusText: string | undefined;
  private readonly listRuns: () => PersistedRun[];
  private readonly setIntervalFn: (callback: () => void, ms: number) => unknown;
  private readonly clearIntervalFn: (timer: unknown) => void;
  private static readonly ERROR_LINGER_TURNS = 2;

  constructor(listRuns: () => PersistedRun[], options: WidgetOptions = {}) {
    this.listRuns = listRuns;
    this.setIntervalFn = options.setInterval ?? ((callback, ms) => setInterval(callback, ms));
    this.clearIntervalFn = options.clearInterval ?? ((timer) => clearInterval(timer as ReturnType<typeof setInterval>));
  }

  setUICtx(ctx: SubagentWidgetUI | undefined): void {
    if (ctx === this.uiCtx) return;
    this.uiCtx = ctx;
    this.widgetRegistered = false;
    this.tui = undefined;
    this.lastStatusText = undefined;
  }

  onTurnStart(): void {
    for (const [id, age] of this.finishedTurnAge) this.finishedTurnAge.set(id, age + 1);
    this.update();
  }

  private ensureTimer(): void {
    this.widgetInterval ??= this.setIntervalFn(() => this.update(), 80);
  }

  private shouldShowFinished(runId: string, status: RunStatus): boolean {
    const age = this.finishedTurnAge.get(runId) ?? 0;
    return age < (ERROR_STATUSES.has(status) ? SubagentWidget.ERROR_LINGER_TURNS : 1);
  }

  private seedFinishedRuns(runs: readonly PersistedRun[]): void {
    for (const run of runs) {
      if (!run.status || run.status === "starting" || run.status === "running" || run.status === "waiting") continue;
      if (!this.finishedTurnAge.has(run.id)) this.finishedTurnAge.set(run.id, 0);
    }
  }

  private clearWidget(runs: readonly PersistedRun[]): void {
    if (this.widgetRegistered) {
      this.uiCtx!.setWidget("omps-subagents", undefined);
      this.widgetRegistered = false;
      this.tui = undefined;
    }
    if (this.lastStatusText !== undefined) {
      this.uiCtx!.setStatus("subagents", undefined);
      this.lastStatusText = undefined;
    }
    if (this.widgetInterval !== undefined) {
      this.clearIntervalFn(this.widgetInterval);
      this.widgetInterval = undefined;
    }
    for (const [id] of this.finishedTurnAge) {
      if (!runs.some((run) => run.id === id)) this.finishedTurnAge.delete(id);
    }
  }

  private updateStatusBar(state: SubagentWidgetState): void {
    const parts: string[] = [];
    if (state.runningCount > 0) parts.push(`${state.runningCount} running`);
    if (state.waitingCount > 0) parts.push(`${state.waitingCount} waiting`);
    if (state.queuedCount > 0) parts.push(`${state.queuedCount} queued`);
    const total = state.runningCount + state.waitingCount + state.queuedCount;
    const next = total > 0 ? `${parts.join(", ")} agent${total === 1 ? "" : "s"}` : undefined;
    if (next !== this.lastStatusText) {
      this.uiCtx!.setStatus("subagents", next);
      this.lastStatusText = next;
    }
  }

  update(): void {
    if (!this.uiCtx) return;
    const runs = this.listRuns();
    this.seedFinishedRuns(runs);
    const state = assembleSubagentWidgetState(runs, (id, status) => this.shouldShowFinished(id, status));
    if (!state.hasActive && !state.hasFinished) {
      this.clearWidget(runs);
      return;
    }

    if (state.hasActive) this.ensureTimer();
    this.updateStatusBar(state);
    this.widgetFrame += 1;
    if (!this.widgetRegistered) {
      this.uiCtx.setWidget("omps-subagents", (tui, theme) => {
        this.tui = tui;
        return {
          render: () => renderSubagentWidgetLines({
            runs: this.listRuns(),
            spinnerFrame: this.widgetFrame,
            terminalWidth: tui.terminal.columns,
            theme,
            shouldShowFinished: (id, status) => this.shouldShowFinished(id, status),
          }),
          invalidate: () => {
            this.widgetRegistered = false;
            this.tui = undefined;
          },
        };
      }, { placement: "aboveEditor" });
      this.widgetRegistered = true;
    } else {
      this.tui?.requestRender();
    }
  }

  dispose(): void {
    if (this.widgetInterval !== undefined) {
      this.clearIntervalFn(this.widgetInterval);
      this.widgetInterval = undefined;
    }
    if (this.uiCtx) {
      this.uiCtx.setWidget("omps-subagents", undefined);
      this.uiCtx.setStatus("subagents", undefined);
    }
    this.widgetRegistered = false;
    this.tui = undefined;
    this.lastStatusText = undefined;
  }
}
