/**
 * Adapted from gotgenes/pi-packages packages/pi-subagents/src/ui/widget-renderer.ts.
 * Copyright (c) 2026 tintinweb. MIT licensed; see THIRD_PARTY_NOTICES.md.
 */

import { truncateToWidth } from "@earendil-works/pi-tui";
import type { PersistedRun, RunStatus } from "./subagent-core.js";
import type { DetachedRunActivity } from "./subagent-run-files.js";
import {
  describeWidgetActivity,
  formatWidgetMs,
  formatWidgetSessionTokens,
  formatWidgetTurns,
  type WidgetTheme,
} from "./subagent-widget-display.js";
import { SUBAGENT_WIDGET_GLYPHS, SUBAGENT_WIDGET_SPINNER } from "./subagent-widget-glyphs.js";

export type { WidgetTheme } from "./subagent-widget-display.js";
export { formatWidgetMs } from "./subagent-widget-display.js";
export { SUBAGENT_WIDGET_GLYPHS, SUBAGENT_WIDGET_SPINNER } from "./subagent-widget-glyphs.js";

export type WidgetRun = Pick<
  PersistedRun,
  "id" | "agent" | "task" | "model" | "status" | "createdAt" | "updatedAt" | "error" | "request"
> & { readonly activity?: DetachedRunActivity };

export const MAX_SUBAGENT_WIDGET_LINES = 12;
const ACTIVE_STATUSES = new Set<RunStatus>(["starting", "running", "waiting"]);
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export function formatWidgetModel(canonicalModel: string): string {
  const slash = canonicalModel.indexOf("/");
  if (slash <= 0 || slash >= canonicalModel.length - 1) return canonicalModel;
  const provider = canonicalModel.slice(0, slash);
  let model = canonicalModel.slice(slash + 1);
  if (!provider.trim() || !model.trim()) return canonicalModel;

  let thinking: string | undefined;
  const colon = model.lastIndexOf(":");
  if (colon > 0) {
    const candidate = model.slice(colon + 1);
    if (THINKING_LEVELS.has(candidate) && model.slice(0, colon).trim()) {
      thinking = candidate;
      model = model.slice(0, colon);
    }
  }
  return `(${provider}) ${model}${thinking ? ` • ${thinking}` : ""}`;
}

function shortTask(task: string): string {
  return task.split("\n").find((line) => line.trim())?.trim() ?? "";
}

function elapsed(run: WidgetRun, nowMs: number): string {
  const start = Date.parse(run.createdAt);
  const end = ACTIVE_STATUSES.has(run.status) ? nowMs : Date.parse(run.updatedAt);
  return formatWidgetMs((Number.isFinite(end) ? end : nowMs) - (Number.isFinite(start) ? start : nowMs));
}

function runName(run: WidgetRun, theme: WidgetTheme): string {
  return `${run.agent} ${theme.fg("dim", `[${run.id.slice(0, 8)}]`)}`;
}

function stats(run: WidgetRun, theme: WidgetTheme, nowMs: number): string {
  const activity = run.activity;
  const parts = [formatWidgetTurns(activity?.turnCount ?? 0)];
  if ((activity?.toolUses ?? 0) > 0) {
    const uses = activity!.toolUses;
    parts.push(`${uses} tool use${uses === 1 ? "" : "s"}`);
  }
  if ((activity?.tokens ?? 0) > 0) {
    parts.push(formatWidgetSessionTokens(
      activity!.tokens,
      activity!.contextPercent,
      theme,
      activity!.compactionCount,
    ));
  }
  parts.push(elapsed(run, nowMs));
  return parts.join(" · ");
}

export function renderFinishedRunLine(run: WidgetRun, theme: WidgetTheme, nowMs = Date.now()): string {
  let icon: string;
  let statusText = "";
  if (run.status === "completed") {
    icon = theme.fg("success", SUBAGENT_WIDGET_GLYPHS.success);
  } else if (run.status === "interrupted") {
    icon = theme.fg("error", SUBAGENT_WIDGET_GLYPHS.failure);
    statusText = theme.fg("warning", " interrupted");
  } else {
    icon = theme.fg("error", SUBAGENT_WIDGET_GLYPHS.failure);
    const message = run.error ? `: ${run.error.slice(0, 60)}` : "";
    statusText = theme.fg("error", ` failed${message}`);
  }
  return `${icon} ${theme.fg("dim", runName(run, theme))}  ${theme.fg("dim", shortTask(run.task))} ${theme.fg("dim", "·")} ${theme.fg("dim", stats(run, theme, nowMs))}${statusText}`;
}

export function renderActiveRunLines(
  run: WidgetRun,
  spinnerFrame: number,
  theme: WidgetTheme,
  nowMs = Date.now(),
): [header: string, stats: string, activity: string] {
  const waiting = run.status === "waiting";
  const indicator = waiting
    ? theme.fg("warning", SUBAGENT_WIDGET_GLYPHS.waiting)
    : theme.fg("accent", SUBAGENT_WIDGET_SPINNER[spinnerFrame % SUBAGENT_WIDGET_SPINNER.length]);
  const state = waiting ? ` ${theme.fg("warning", "waiting")}` : "";
  const header = `${indicator} ${theme.bold(runName(run, theme))}${state}  ${theme.fg("muted", shortTask(run.task))}`;
  const statsLine = theme.fg("dim", `${formatWidgetModel(run.model)} · ${stats(run, theme, nowMs)}`);
  const activityText = waiting
    ? run.request?.message || "supervisor reply required"
    : describeWidgetActivity(run.activity?.activeTools ?? {}, run.activity?.responseText);
  return [header, statsLine, theme.fg(waiting ? "warning" : "dim", activityText)];
}

interface Categories {
  active: WidgetRun[];
  queued: WidgetRun[];
  finished: WidgetRun[];
}

function categorizeRuns(
  runs: readonly WidgetRun[],
  shouldShowFinished: (runId: string, status: RunStatus) => boolean,
): Categories {
  return {
    active: runs.filter((run) => run.status === "running" || run.status === "waiting"),
    queued: runs.filter((run) => run.status === "starting"),
    finished: runs.filter((run) => !ACTIVE_STATUSES.has(run.status) && shouldShowFinished(run.id, run.status)),
  };
}

interface Sections {
  finishedLines: string[];
  activeLines: [header: string, stats: string, activity: string][];
  queuedLine: string | undefined;
  queuedCount: number;
}

function buildSections(
  categories: Categories,
  spinnerFrame: number,
  theme: WidgetTheme,
  truncate: (line: string) => string,
  nowMs: number,
): Sections {
  const finishedLines = categories.finished.map((run) =>
    truncate(theme.fg("dim", "├─") + " " + renderFinishedRunLine(run, theme, nowMs)));
  const activeLines = categories.active.map((run) => {
    const [header, statsLine, activity] = renderActiveRunLines(run, spinnerFrame, theme, nowMs);
    return [
      truncate(theme.fg("dim", "├─") + ` ${header}`),
      truncate(theme.fg("dim", "│  ├─") + ` ${statsLine}`),
      truncate(theme.fg("dim", "│  └─") + ` ${activity}`),
    ] as [string, string, string];
  });
  const queuedLine = categories.queued.length > 0
    ? truncate(theme.fg("dim", "├─") + ` ${theme.fg("muted", SUBAGENT_WIDGET_GLYPHS.queued)} ${theme.fg("dim", `${categories.queued.length} queued`)}`)
    : undefined;
  return { finishedLines, activeLines, queuedLine, queuedCount: categories.queued.length };
}

function assembleWithinBudget(heading: string, sections: Sections): string[] {
  const lines = [heading, ...sections.finishedLines];
  for (const entry of sections.activeLines) lines.push(...entry);
  if (sections.queuedLine) {
    lines.push(sections.queuedLine.replace("├─", "└─"));
  } else if (sections.activeLines.length > 0) {
    const headerIndex = lines.length - 3;
    lines[headerIndex] = lines[headerIndex].replace("├─", "└─");
    lines[headerIndex + 1] = lines[headerIndex + 1].replace("│  ", "   ");
    lines[headerIndex + 2] = lines[headerIndex + 2].replace("│  ", "   ");
  } else if (sections.finishedLines.length > 0) {
    const last = lines.length - 1;
    lines[last] = lines[last].replace("├─", "└─");
  }
  return lines;
}

function assembleOverflow(
  heading: string,
  sections: Sections,
  maxBody: number,
  truncate: (line: string) => string,
  theme: WidgetTheme,
): string[] {
  const lines = [heading];
  let budget = maxBody - 1;
  let hiddenActive = 0;
  let hiddenQueued = 0;
  let hiddenFinished = 0;
  for (const entry of sections.activeLines) {
    if (budget >= 3) {
      lines.push(...entry);
      budget -= 3;
    } else hiddenActive += 1;
  }
  if (sections.queuedLine) {
    if (budget >= 1) {
      lines.push(sections.queuedLine);
      budget -= 1;
    } else hiddenQueued = sections.queuedCount;
  }
  for (const line of sections.finishedLines) {
    if (budget >= 1) {
      lines.push(line);
      budget -= 1;
    } else hiddenFinished += 1;
  }
  const parts: string[] = [];
  if (hiddenActive > 0) parts.push(`${hiddenActive} active`);
  if (hiddenQueued > 0) parts.push(`${hiddenQueued} queued`);
  if (hiddenFinished > 0) parts.push(`${hiddenFinished} finished`);
  const hiddenTotal = hiddenActive + hiddenQueued + hiddenFinished;
  lines.push(truncate(theme.fg("dim", "└─") + ` ${theme.fg("dim", `+${hiddenTotal} more (${parts.join(", ")})`)}`));
  return lines;
}

export function renderSubagentWidgetLines(params: {
  runs: readonly WidgetRun[];
  spinnerFrame: number;
  terminalWidth: number;
  theme: WidgetTheme;
  shouldShowFinished: (runId: string, status: RunStatus) => boolean;
  nowMs?: number;
}): string[] {
  const { runs, spinnerFrame, terminalWidth, theme, shouldShowFinished } = params;
  const nowMs = params.nowMs ?? Date.now();
  const categories = categorizeRuns(runs, shouldShowFinished);
  const hasActive = categories.active.length > 0 || categories.queued.length > 0;
  if (!hasActive && categories.finished.length === 0) return [];
  const truncate = (line: string) => truncateToWidth(line, terminalWidth);
  const headingColor = hasActive ? "accent" : "dim";
  const headingIcon = hasActive ? SUBAGENT_WIDGET_GLYPHS.agentsActive : SUBAGENT_WIDGET_GLYPHS.agentsIdle;
  const heading = truncate(theme.fg(headingColor, headingIcon) + " " + theme.fg(headingColor, "Agents"));
  const sections = buildSections(categories, spinnerFrame, theme, truncate, nowMs);
  const maxBody = MAX_SUBAGENT_WIDGET_LINES - 1;
  const totalBody = sections.finishedLines.length + sections.activeLines.length * 3 + (sections.queuedLine ? 1 : 0);
  return totalBody <= maxBody
    ? assembleWithinBudget(heading, sections)
    : assembleOverflow(heading, sections, maxBody, truncate, theme);
}
