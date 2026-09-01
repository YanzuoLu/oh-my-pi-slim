import { keyText } from "@earendil-works/pi-coding-agent";

/**
 * Shared access to Pi's own global tool-output expansion state for the persistent
 * Goal widget and subagent viewer. The package owns no expansion state of its own:
 * no keybinding is registered, no editor is wrapped, and nothing is persisted.
 */

/** Pi's documented default for `app.tools.expand`, used only when no keybinding registry is loaded yet. */
export const DEFAULT_WIDGET_EXPAND_KEY = "ctrl+o";

export interface WidgetExpansionSource {
  getToolsExpanded?: () => boolean;
}

/**
 * Read Pi's live expansion state on every call, never at widget registration time.
 * A UI without the getter (older hosts, test doubles, fallback surfaces) stays expanded
 * so the previous full-body behaviour is preserved.
 */
export function readWidgetExpanded(ui: WidgetExpansionSource | undefined): boolean {
  if (!ui || typeof ui.getToolsExpanded !== "function") return true;
  try {
    return ui.getToolsExpanded() !== false;
  } catch {
    return true;
  }
}

/** The configured key for `app.tools.expand`, falling back to Pi's default binding. */
export function widgetExpandKey(): string {
  try {
    return keyText("app.tools.expand").trim() || DEFAULT_WIDGET_EXPAND_KEY;
  } catch {
    return DEFAULT_WIDGET_EXPAND_KEY;
  }
}

/**
 * Plain, theme-free hint used by the subagent viewer when collapsed rows are hidden.
 * The viewer wraps this whole segment—separator included—in a single dim role.
 */
export function widgetExpandHint(): string {
  return ` · ${widgetExpandKey()} to expand`;
}
