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
