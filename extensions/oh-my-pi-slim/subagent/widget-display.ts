/**
 * Adapted from gotgenes/pi-packages packages/pi-subagents/src/ui/display.ts.
 * Copyright (c) 2026 tintinweb. MIT licensed; see THIRD_PARTY_NOTICES.md.
 */

import { formatSemanticGlyphPrefix } from "../semantic-glyph.js";
import { SUBAGENT_WIDGET_GLYPHS } from "./widget-glyphs.js";

export type WidgetTheme = {
  fg(color: string, text: string): string;
  bold(text: string): string;
};

const TOOL_DISPLAY: Record<string, string> = {
  read: "reading",
  bash: "running command",
  edit: "editing",
  write: "writing",
  grep: "searching",
  find: "finding files",
  ls: "listing",
};

export function formatWidgetTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M token`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k token`;
  return `${count} token`;
}

export function formatWidgetSessionTokens(
  tokens: number,
  percent: number | undefined,
  theme: WidgetTheme,
  compactions = 0,
): string {
  const annotations: string[] = [];
  if (percent !== undefined) {
    const color = percent >= 85 ? "error" : percent >= 70 ? "warning" : "dim";
    annotations.push(theme.fg(color, `${Math.round(percent)}%`));
  }
  if (compactions > 0) annotations.push(`${formatSemanticGlyphPrefix(theme.fg("dim", SUBAGENT_WIDGET_GLYPHS.compactions))}${theme.fg("dim", String(compactions))}`);
  if (annotations.length === 0) return formatWidgetTokens(tokens);
  const separator = theme.fg("dim", " · ");
  return `${formatWidgetTokens(tokens)} ${theme.fg("dim", "(")}${annotations.join(separator)}${theme.fg("dim", ")")}`;
}

export function formatWidgetTurns(turnCount: number): string {
  return `${formatSemanticGlyphPrefix(SUBAGENT_WIDGET_GLYPHS.turns)}${turnCount}`;
}

export function formatWidgetMs(ms: number): string {
  return `${(Math.max(0, ms) / 1000).toFixed(1)}s`;
}

function truncateLine(text: string, length = 60): string {
  const line = text.split("\n").find((value) => value.trim())?.trim() ?? "";
  return line.length <= length ? line : `${line.slice(0, length)}…`;
}

export function describeWidgetActivity(
  activeTools: Readonly<Record<string, { name: string }>>,
  responseText?: string,
): string {
  const groups = new Map<string, number>();
  for (const tool of Object.values(activeTools)) {
    const action = TOOL_DISPLAY[tool.name] ?? tool.name;
    groups.set(action, (groups.get(action) ?? 0) + 1);
  }
  if (groups.size > 0) {
    const parts: string[] = [];
    for (const [action, count] of groups) {
      parts.push(count > 1 ? `${action} ${count} ${action === "searching" ? "patterns" : "files"}` : action);
    }
    return `${parts.join(", ")}…`;
  }
  if (responseText?.trim()) return truncateLine(responseText);
  return "thinking…";
}
