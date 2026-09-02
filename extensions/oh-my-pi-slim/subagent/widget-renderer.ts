/**
 * Adapted from gotgenes/pi-packages packages/pi-subagents/src/ui/widget-renderer.ts.
 * Copyright (c) 2026 tintinweb. MIT licensed; see THIRD_PARTY_NOTICES.md.
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { sortRetainedSubagentRuns, type PersistedRun, type RunStatus } from "./core.js";
import { formatSubagentModel } from "./model-display.js";
import type { DetachedRunActivity } from "./run-files.js";
import { formatSemanticGlyphPrefix } from "../semantic-glyph.js";
import {
  describeWidgetActivity,
  formatWidgetMs,
  formatWidgetSessionTokens,
  formatWidgetTurns,
  type WidgetTheme,
} from "./widget-display.js";
import { SUBAGENT_WIDGET_GLYPHS, SUBAGENT_WIDGET_SPINNER } from "./widget-glyphs.js";

export type { WidgetTheme } from "./widget-display.js";
export { formatWidgetMs } from "./widget-display.js";
export { formatSubagentModel as formatWidgetModel } from "./model-display.js";
export { SUBAGENT_WIDGET_GLYPHS, SUBAGENT_WIDGET_SPINNER } from "./widget-glyphs.js";

export type WidgetRun = Pick<
  PersistedRun,
  "id" | "abstract" | "model" | "status" | "createdAt" | "updatedAt" | "error" | "request"
> & { readonly activity?: DetachedRunActivity };

export const MAX_SUBAGENT_WIDGET_LINES = 12;
const ACTIVE_STATUSES = new Set<RunStatus>(["starting", "running", "waiting"]);

function shortAbstract(abstract: string): string {
  return abstract.split("\n").find((line) => line.trim())?.trim() ?? "";
}

function elapsed(run: WidgetRun, nowMs: number): string {
  const start = Date.parse(run.createdAt);
  const end = ACTIVE_STATUSES.has(run.status) ? nowMs : Date.parse(run.updatedAt);
  return formatWidgetMs((Number.isFinite(end) ? end : nowMs) - (Number.isFinite(start) ? start : nowMs));
}

function runName(run: WidgetRun, theme: WidgetTheme): string {
  return `Subagent ${theme.fg("dim", `[${run.id.slice(0, 8)}]`)}`;
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
    const message = run.error ? `: ${shortAbstract(run.error).slice(0, 60)}` : "";
    statusText = theme.fg("error", ` failed${message}`);
  }
  return `${formatSemanticGlyphPrefix(icon)}${theme.fg("dim", runName(run, theme))}  ${theme.fg("dim", shortAbstract(run.abstract))} ${theme.fg("dim", "·")} ${theme.fg("dim", stats(run, theme, nowMs))}${statusText}`;
}

export type ActiveRunLines = [summary: string, stats: string];

export function renderActiveRunLines(
  run: WidgetRun,
  spinnerFrame: number,
  theme: WidgetTheme,
  nowMs = Date.now(),
  maxSummaryWidth?: number,
): ActiveRunLines {
  const waiting = run.status === "waiting";
  const indicator = waiting
    ? theme.fg("warning", SUBAGENT_WIDGET_GLYPHS.waiting)
    : theme.fg("accent", SUBAGENT_WIDGET_SPINNER[spinnerFrame % SUBAGENT_WIDGET_SPINNER.length]);
  const state = waiting ? ` ${theme.fg("warning", "waiting")}` : "";
  const identity = `${formatSemanticGlyphPrefix(indicator)}${theme.bold(runName(run, theme))}${state}  ${theme.fg("muted", shortAbstract(run.abstract))}`;
  const activityText = waiting
    ? shortAbstract(run.request?.message ?? "") || "supervisor reply required"
    : describeWidgetActivity(run.activity?.activeTools ?? {}, run.activity?.responseText);
  const separator = theme.fg("dim", " · ");
  const summary = `${identity}${separator}${theme.fg(waiting ? "warning" : "dim", activityText)}`;
  const summaryLine = (() => {
    if (maxSummaryWidth === undefined || visibleWidth(summary) <= maxSummaryWidth) return summary;
    if (visibleWidth(identity) > maxSummaryWidth) return truncateToWidth(identity, maxSummaryWidth);
    if (visibleWidth(identity) + visibleWidth(separator) > maxSummaryWidth) return identity;
    return truncateToWidth(summary, maxSummaryWidth);
  })();
  const statsLine = theme.fg("dim", `${formatSubagentModel(run.model)} · ${stats(run, theme, nowMs)}`);
  return [summaryLine, statsLine];
}

/** Counts every retained run directly, so budget, overflow, and sorting never move the heading numbers. */
export function countActiveSubagentRuns(runs: readonly WidgetRun[]): number {
  return runs.filter((run) => ACTIVE_STATUSES.has(run.status)).length;
}

/** The heading's own filled-or-hollow test, shared with the widget stack so both agree by construction. */
export function hasActiveSubagentRuns(runs: readonly WidgetRun[]): boolean {
  return countActiveSubagentRuns(runs) > 0;
}

function subagentWidgetHeading(runs: readonly WidgetRun[], theme: WidgetTheme): string {
  const live = countActiveSubagentRuns(runs);
  const terminal = runs.length - live;
  const active = live > 0;
  const color = active ? "accent" : "dim";
  const glyph = active
    ? theme.bold(SUBAGENT_WIDGET_GLYPHS.agentsActive)
    : SUBAGENT_WIDGET_GLYPHS.agentsIdle;
  const label = active
    ? theme.bold(`Subagents (${terminal}/${runs.length})`)
    : `Subagents (${terminal}/${runs.length})`;
  return `${formatSemanticGlyphPrefix(theme.fg(color, glyph))}${theme.fg(color, label)}`;
}

const AGENTS_VIEWER_HINT = " · ctrl+shift+←/→ viewer";

/** Keeps the complete Viewer hint when it fits and never exposes a truncated semantic hint. */
function subagentHeadingLine(heading: string, showViewerHint: boolean, theme: WidgetTheme, width: number): string {
  if (showViewerHint && visibleWidth(heading) + visibleWidth(AGENTS_VIEWER_HINT) <= width) {
    return `${heading}${theme.fg("dim", AGENTS_VIEWER_HINT)}`;
  }
  return truncateToWidth(heading, width);
}

interface Categories {
  active: WidgetRun[];
  queued: WidgetRun[];
  finished: WidgetRun[];
}

function categorizeRuns(runs: readonly WidgetRun[]): Categories {
  return {
    active: runs.filter((run) => run.status === "running" || run.status === "waiting"),
    queued: runs.filter((run) => run.status === "starting"),
    finished: runs.filter((run) => !ACTIVE_STATUSES.has(run.status)),
  };
}

interface Sections {
  activeLines: ActiveRunLines[];
  queuedLines: string[];
}

function buildSections(
  categories: Categories,
  spinnerFrame: number,
  theme: WidgetTheme,
  truncate: (line: string) => string,
  nowMs: number,
  terminalWidth: number,
): Sections {
  const activeLines = categories.active.map((run) => {
    const summaryPrefix = theme.fg("dim", "├─") + " ";
    const [summary, statsLine] = renderActiveRunLines(
      run,
      spinnerFrame,
      theme,
      nowMs,
      Math.max(0, terminalWidth - visibleWidth(summaryPrefix)),
    );
    return [
      truncate(summaryPrefix + summary),
      truncate(theme.fg("dim", "│  └─") + ` ${statsLine}`),
    ] as ActiveRunLines;
  });
  const queuedLines = categories.queued.map((run) => truncate(
    theme.fg("dim", "├─") + ` ${formatSemanticGlyphPrefix(theme.fg("muted", SUBAGENT_WIDGET_GLYPHS.queued))}${theme.fg("dim", runName(run, theme))}  ${theme.fg("dim", shortAbstract(run.abstract))} ${theme.fg("dim", "·")} ${theme.fg("dim", stats(run, theme, nowMs))} ${theme.fg("muted", "queued")}`,
  ));
  return { activeLines, queuedLines };
}

function assembleWithinBudget(heading: string, sections: Sections): string[] {
  const lines = [heading];
  for (const entry of sections.activeLines) lines.push(...entry);
  lines.push(...sections.queuedLines);
  if (sections.queuedLines.length > 0) {
    const last = lines.length - 1;
    lines[last] = lines[last].replace("├─", "└─");
  } else if (sections.activeLines.length > 0) {
    const summaryIndex = lines.length - 2;
    lines[summaryIndex] = lines[summaryIndex].replace("├─", "└─");
    lines[summaryIndex + 1] = lines[summaryIndex + 1].replace("│  ", "   ");
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
  for (const entry of sections.activeLines) {
    if (budget >= 2) {
      lines.push(...entry);
      budget -= 2;
    } else hiddenActive += 1;
  }
  for (const line of sections.queuedLines) {
    if (budget >= 1) {
      lines.push(line);
      budget -= 1;
    } else hiddenQueued += 1;
  }
  const parts: string[] = [];
  if (hiddenActive > 0) parts.push(`${hiddenActive} active`);
  if (hiddenQueued > 0) parts.push(`${hiddenQueued} queued`);
  const hiddenTotal = hiddenActive + hiddenQueued;
  lines.push(truncate(theme.fg("dim", "└─") + ` ${theme.fg("dim", `+${hiddenTotal} more (${parts.join(", ")})`)}`));
  return lines;
}

export function renderSubagentWidgetLines(params: {
  runs: readonly WidgetRun[];
  spinnerFrame: number;
  terminalWidth: number;
  theme: WidgetTheme;
  nowMs?: number;
}): string[] {
  const { runs, spinnerFrame, terminalWidth, theme } = params;
  const nowMs = params.nowMs ?? Date.now();
  const categories = categorizeRuns(sortRetainedSubagentRuns(runs));
  if (runs.length === 0) return [];
  const truncate = (line: string) => truncateToWidth(line, terminalWidth);
  const heading = subagentHeadingLine(
    subagentWidgetHeading(runs, theme),
    categories.finished.length > 0,
    theme,
    terminalWidth,
  );
  const sections = buildSections(categories, spinnerFrame, theme, truncate, nowMs, terminalWidth);
  const maxBody = MAX_SUBAGENT_WIDGET_LINES - 1;
  const totalBody = sections.activeLines.length * 2 + sections.queuedLines.length;
  return totalBody <= maxBody
    ? assembleWithinBudget(heading, sections)
    : assembleOverflow(heading, sections, maxBody, truncate, theme);
}
