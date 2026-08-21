/**
 * Adapted from gotgenes/pi-packages packages/pi-subagents/src/ui/widget-renderer.ts.
 * Copyright (c) 2026 tintinweb. MIT licensed; see THIRD_PARTY_NOTICES.md.
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { sortRetainedSubagentRuns, type PersistedRun, type RunStatus } from "./subagent-core.js";
import { formatSubagentModel } from "./subagent-model-display.js";
import type { DetachedRunActivity } from "./subagent-run-files.js";
import { formatSemanticGlyphPrefix } from "./semantic-glyph.js";
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
export { formatSubagentModel as formatWidgetModel } from "./subagent-model-display.js";
export { SUBAGENT_WIDGET_GLYPHS, SUBAGENT_WIDGET_SPINNER } from "./subagent-widget-glyphs.js";

export type WidgetRun = Pick<
  PersistedRun,
  "id" | "agent" | "abstract" | "model" | "status" | "createdAt" | "updatedAt" | "error" | "request"
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
  return `${formatSemanticGlyphPrefix(icon)}${theme.fg("dim", runName(run, theme))}  ${theme.fg("dim", shortAbstract(run.abstract))} ${theme.fg("dim", "·")} ${theme.fg("dim", stats(run, theme, nowMs))}${statusText}`;
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
  const header = `${formatSemanticGlyphPrefix(indicator)}${theme.bold(runName(run, theme))}${state}  ${theme.fg("muted", shortAbstract(run.abstract))}`;
  const statsLine = theme.fg("dim", `${formatSubagentModel(run.model)} · ${stats(run, theme, nowMs)}`);
  const activityText = waiting
    ? run.request?.message || "supervisor reply required"
    : describeWidgetActivity(run.activity?.activeTools ?? {}, run.activity?.responseText);
  return [header, statsLine, theme.fg(waiting ? "warning" : "dim", activityText)];
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
    ? theme.bold(`Agents (${terminal}/${runs.length})`)
    : `Agents (${terminal}/${runs.length})`;
  return `${formatSemanticGlyphPrefix(theme.fg(color, glyph))}${theme.fg(color, label)}`;
}

/** Appends the collapsed hint only when the separator-through-expand segment fits whole; never half of it. */
function subagentHeadingLine(heading: string, hint: string, theme: WidgetTheme, width: number): string {
  if (hint !== "" && visibleWidth(heading) + visibleWidth(hint) <= width) {
    return `${heading}${theme.fg("dim", hint)}`;
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
  finishedLines: string[];
  activeLines: [header: string, stats: string, activity: string][];
  queuedLines: string[];
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
  const queuedLines = categories.queued.map((run) => truncate(
    theme.fg("dim", "├─") + ` ${formatSemanticGlyphPrefix(theme.fg("muted", SUBAGENT_WIDGET_GLYPHS.queued))}${theme.fg("dim", runName(run, theme))}  ${theme.fg("dim", shortAbstract(run.abstract))} ${theme.fg("dim", "·")} ${theme.fg("dim", stats(run, theme, nowMs))} ${theme.fg("muted", "queued")}`,
  ));
  return { finishedLines, activeLines, queuedLines };
}

function assembleWithinBudget(heading: string, sections: Sections): string[] {
  const lines = [heading];
  for (const entry of sections.activeLines) lines.push(...entry);
  lines.push(...sections.queuedLines, ...sections.finishedLines);
  if (sections.finishedLines.length > 0) {
    const last = lines.length - 1;
    lines[last] = lines[last].replace("├─", "└─");
  } else if (sections.queuedLines.length > 0) {
    const last = lines.length - 1;
    lines[last] = lines[last].replace("├─", "└─");
  } else if (sections.activeLines.length > 0) {
    const headerIndex = lines.length - 3;
    lines[headerIndex] = lines[headerIndex].replace("├─", "└─");
    lines[headerIndex + 1] = lines[headerIndex + 1].replace("│  ", "   ");
    lines[headerIndex + 2] = lines[headerIndex + 2].replace("│  ", "   ");
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
  for (const line of sections.queuedLines) {
    if (budget >= 1) {
      lines.push(line);
      budget -= 1;
    } else hiddenQueued += 1;
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
  nowMs?: number;
  expanded?: boolean;
  hint?: string;
}): string[] {
  const { runs, spinnerFrame, terminalWidth, theme } = params;
  const nowMs = params.nowMs ?? Date.now();
  const expanded = params.expanded ?? true;
  const categories = categorizeRuns(sortRetainedSubagentRuns(runs));
  const hasActive = categories.active.length > 0 || categories.queued.length > 0;
  if (!hasActive && categories.finished.length === 0) return [];
  const policyHidden = expanded ? 0 : categories.finished.length;
  const shown: Categories = expanded ? categories : { ...categories, finished: [] };
  const truncate = (line: string) => truncateToWidth(line, terminalWidth);
  const heading = subagentHeadingLine(
    subagentWidgetHeading(runs, theme),
    policyHidden > 0 ? params.hint ?? "" : "",
    theme,
    terminalWidth,
  );
  const sections = buildSections(shown, spinnerFrame, theme, truncate, nowMs);
  const maxBody = MAX_SUBAGENT_WIDGET_LINES - 1;
  const totalBody = sections.finishedLines.length + sections.activeLines.length * 3 + sections.queuedLines.length;
  return totalBody <= maxBody
    ? assembleWithinBudget(heading, sections)
    : assembleOverflow(heading, sections, maxBody, truncate, theme);
}
