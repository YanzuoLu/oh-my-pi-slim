/**
 * Adapted from gotgenes/pi-packages packages/pi-subagents/src/ui/glyphs.ts.
 * Copyright (c) 2026 tintinweb. MIT licensed; see THIRD_PARTY_NOTICES.md.
 */

export const SUBAGENT_WIDGET_GLYPHS = {
  turns: "↻",
  compactions: "⇊",
  success: "✓",
  failure: "✗",
  subLine: "⎿",
  queued: "◦",
  agentsActive: "●",
  agentsIdle: "○",
  waiting: "!",
} as const;

export const SUBAGENT_WIDGET_SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
