import type { Theme } from "@earendil-works/pi-coding-agent";
import { readWidgetExpanded, widgetExpandHint } from "./widget-expansion.js";
import { renderWidgetStack, type WidgetStackSection, type WidgetStackSectionId } from "./widget-stack.js";

/**
 * The one and only `setWidget` owner in this package.
 *
 * Pi's extension host loads `extensions/oh-my-pi-slim/index.ts` and `extensions/todo/index.ts`
 * through separate module graphs, so this file is evaluated more than once and a module-level
 * singleton would silently split into two hosts with two competing widget keys. The live host is
 * therefore anchored on `globalThis` under a protocol-versioned key and used purely by shape, never
 * by class identity, so any copy of this module drives the same aggregate widget.
 */

export const WIDGET_STACK_KEY = "oh-my-pi-slim:widgets";
export const WIDGET_STACK_HOST_PROTOCOL = 1;
export const WIDGET_STACK_HOST_GLOBAL_KEY = "__ohMyPiSlimWidgetStackHost_v1";
export const DEFAULT_WIDGET_STACK_WIDTH = 80;

export interface WidgetStackTui {
  readonly terminal?: { readonly columns: number };
  requestRender(force?: boolean): void;
}

export interface WidgetStackComponent {
  render(width?: number): string[];
  invalidate(): void;
}

export interface WidgetStackUI {
  readonly theme?: Theme;
  getToolsExpanded?(): boolean;
  setWidget(
    key: string,
    content: undefined | ((tui: WidgetStackTui, theme: Theme) => WidgetStackComponent),
    options?: { placement?: "aboveEditor" | "belowEditor" },
  ): void;
}

/**
 * `bind`/`unbind` take an owner token because two extensions share one host: the first one to
 * shut down must release only its own claim and must never clear a binding another owner, or a
 * newer session, still depends on. Passing the expected UI makes a late `unbind` a no-op.
 */
export interface WidgetStackHost {
  readonly protocol: number;
  bind(owner: string, ui: WidgetStackUI | undefined): void;
  unbind(owner: string, ui?: WidgetStackUI | undefined): void;
  publish(id: WidgetStackSectionId, section: WidgetStackSection | undefined): void;
  requestRender(): void;
  boundUI(): WidgetStackUI | undefined;
  publishedSectionIds(): WidgetStackSectionId[];
  isRegistered(): boolean;
  reset(): void;
}

/**
 * The width the host passes in is authoritative whenever it is a real, non-negative number,
 * including zero: a zero-column frame is a legitimate instruction to render nothing wide, and
 * silently widening it to the terminal size would overflow the frame. Only a missing, non-finite,
 * or negative width falls back to the terminal, and only then to the default.
 */
function resolveWidth(width: number | undefined, tui: WidgetStackTui): number {
  if (typeof width === "number" && Number.isFinite(width) && width >= 0) return Math.floor(width);
  const columns = tui.terminal?.columns;
  return typeof columns === "number" && Number.isFinite(columns) && columns > 0
    ? Math.floor(columns)
    : DEFAULT_WIDGET_STACK_WIDTH;
}

function createWidgetStackHost(): WidgetStackHost {
  const sections = new Map<WidgetStackSectionId, WidgetStackSection>();
  const owners = new Map<string, WidgetStackUI>();
  let ui: WidgetStackUI | undefined;
  let tui: WidgetStackTui | undefined;
  // `announced` means the key is claimed on `ui` and still has to be cleared with undefined.
  // `registered` means the host actually ran our factory and handed us a live render handle.
  let announced = false;
  let registered = false;

  const clearWidget = (target: WidgetStackUI | undefined): void => {
    if (announced && target) target.setWidget(WIDGET_STACK_KEY, undefined);
    announced = false;
    registered = false;
    tui = undefined;
  };

  const register = (target: WidgetStackUI): void => {
    // Drop any stale handle first so the flag below can only be set by this registration.
    tui = undefined;
    target.setWidget(WIDGET_STACK_KEY, (nextTui, theme) => {
      tui = nextTui;
      return {
        render: (width?: number) => renderWidgetStack([...sections.values()], {
          width: resolveWidth(width, nextTui),
          theme: ui?.theme ?? theme,
          expanded: readWidgetExpanded(ui),
          hint: widgetExpandHint(),
        }),
        // Theme and layout invalidation never re-registers: the factory reads live state already.
        invalidate() {},
      };
    }, { placement: "aboveEditor" });
    announced = true;
    // Pi's interactive host builds the component inside setWidget, so a TUI session is registered
    // here. A host that ignores component factories (RPC, print, a stub) never runs it, and
    // claiming to be registered there would strand us with a handle that never arrives.
    registered = tui !== undefined;
  };

  const sync = (): void => {
    if (sections.size === 0) {
      clearWidget(ui);
      return;
    }
    if (!ui) return;
    if (!registered) {
      register(ui);
      return;
    }
    tui?.requestRender();
  };

  const host: WidgetStackHost = {
    protocol: WIDGET_STACK_HOST_PROTOCOL,

    /**
     * The newest distinct UI always wins. A new session binding while a previous session's owner
     * has not shut down yet must take the aggregate over immediately, so the old UI is cleared and
     * the new one adopted here rather than waiting for a late `unbind` that may never be exact.
     * The owner table then only lets owners of the *current* UI hold the binding open.
     */
    bind(owner: string, next: WidgetStackUI | undefined): void {
      if (!next) {
        // Binding "no UI" releases exactly this owner's recorded claim and nothing else.
        host.unbind(owner, owners.get(owner));
        return;
      }
      const previous = owners.get(owner);
      owners.set(owner, next);
      // Re-binding an owner that already holds the live UI changes nothing and must not redraw.
      if (previous === next && ui === next) return;
      if (ui !== next) {
        clearWidget(ui);
        ui = next;
      }
      sync();
    },

    unbind(owner: string, expected?: WidgetStackUI | undefined): void {
      const bound = owners.get(owner);
      if (bound === undefined) return;
      // A shutdown arriving after this owner already rebound to a newer UI must not release it.
      if (expected !== undefined && bound !== expected) return;
      owners.delete(owner);
      if (!ui) return;
      // Only an owner of the live UI can hold it open; stale owners of a replaced UI cannot.
      for (const value of owners.values()) if (value === ui) return;
      clearWidget(ui);
      ui = undefined;
    },

    publish(id: WidgetStackSectionId, section: WidgetStackSection | undefined): void {
      if (section === undefined) {
        if (!sections.delete(id)) return;
      } else sections.set(id, section);
      sync();
    },

    requestRender(): void {
      if (!ui || sections.size === 0) return;
      if (!registered) {
        register(ui);
        return;
      }
      tui?.requestRender();
    },

    boundUI: () => ui,
    publishedSectionIds: () => [...sections.keys()],
    isRegistered: () => registered,

    reset(): void {
      sections.clear();
      owners.clear();
      ui = undefined;
      tui = undefined;
      announced = false;
      registered = false;
    },
  };
  return host;
}

function isWidgetStackHost(value: unknown): value is WidgetStackHost {
  if (!value || typeof value !== "object") return false;
  const candidate = value as WidgetStackHost;
  return candidate.protocol === WIDGET_STACK_HOST_PROTOCOL
    && typeof candidate.bind === "function"
    && typeof candidate.unbind === "function"
    && typeof candidate.publish === "function"
    && typeof candidate.requestRender === "function"
    && typeof candidate.reset === "function";
}

/** The process-wide host, created once and shared structurally by every copy of this module. */
export function widgetStackHost(): WidgetStackHost {
  const existing: unknown = Reflect.get(globalThis, WIDGET_STACK_HOST_GLOBAL_KEY);
  if (isWidgetStackHost(existing)) return existing;
  const host = createWidgetStackHost();
  Object.defineProperty(globalThis, WIDGET_STACK_HOST_GLOBAL_KEY, {
    value: host,
    configurable: true,
    writable: true,
    enumerable: false,
  });
  return host;
}

/** Test seam: drops every section, owner, and binding without touching any UI. */
export function resetWidgetStackHost(): void {
  const existing: unknown = Reflect.get(globalThis, WIDGET_STACK_HOST_GLOBAL_KEY);
  if (isWidgetStackHost(existing)) existing.reset();
  Reflect.deleteProperty(globalThis, WIDGET_STACK_HOST_GLOBAL_KEY);
}
