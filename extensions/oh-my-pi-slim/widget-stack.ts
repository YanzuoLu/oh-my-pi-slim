import type { Theme } from "@earendil-works/pi-coding-agent";

/**
 * Pure ordering and concatenation layer for the single aggregate foreground widget.
 *
 * Every persistent package widget contributes one section. Sections that are working stay
 * on top, parked and finished sections sink below them, and inside each group the product
 * order Goal → Todos → Agents → Monitors → Loops never changes. Nothing here owns UI state,
 * registers a widget, or rewrites a section's own lines: the section renderers stay the sole
 * authority for their body, line budget, and glyphs.
 */

export const WIDGET_STACK_SECTION_IDS = ["goal", "todos", "agents", "monitors", "loops"] as const;

export type WidgetStackSectionId = typeof WIDGET_STACK_SECTION_IDS[number];

/** Everything a section needs from the host, resolved once per aggregate render. */
export interface WidgetStackRenderInput {
  readonly width: number;
  readonly theme: Theme;
  readonly expanded: boolean;
}

export interface WidgetStackSection {
  readonly id: WidgetStackSectionId;
  /** Same predicate the section's own heading uses to pick its filled or hollow glyph. */
  isActive(): boolean;
  render(input: WidgetStackRenderInput): readonly string[];
}

/** Fixed in-group rank; unknown ids sort after every known section instead of throwing. */
export function widgetStackSectionRank(id: WidgetStackSectionId): number {
  const rank = WIDGET_STACK_SECTION_IDS.indexOf(id);
  return rank < 0 ? WIDGET_STACK_SECTION_IDS.length : rank;
}

/**
 * Active sections first, idle sections after, each group in fixed product order.
 * `isActive` is read exactly once per section so one render can never see a flip mid-sort.
 */
export function orderWidgetStackSections(sections: readonly WidgetStackSection[]): WidgetStackSection[] {
  const active: WidgetStackSection[] = [];
  const idle: WidgetStackSection[] = [];
  for (const section of sections) (section.isActive() ? active : idle).push(section);
  const byRank = (left: WidgetStackSection, right: WidgetStackSection): number =>
    widgetStackSectionRank(left.id) - widgetStackSectionRank(right.id);
  return [...active.sort(byRank), ...idle.sort(byRank)];
}

/** Concatenates ordered section bodies with no separator, no blank line, and no global cap. */
export function renderWidgetStack(
  sections: readonly WidgetStackSection[],
  input: WidgetStackRenderInput,
): string[] {
  const lines: string[] = [];
  for (const section of orderWidgetStackSections(sections)) lines.push(...section.render(input));
  return lines;
}
