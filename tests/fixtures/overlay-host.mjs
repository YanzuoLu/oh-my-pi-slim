/**
 * A test host with the real overlay semantics of pi-tui's `TuiBase` plus the coding agent's
 * `InteractiveMode.showExtensionCustom`. Shared by every suite that asserts overlay ownership.
 *
 * The parts that decide the viewer's close contract are reproduced exactly:
 * - `showOverlay` returns an `OverlayHandle` whose `hide()` splices that one entry by identity and
 *   is idempotent, no matter where the entry sits in the stack.
 * - `hideOverlay()` pops the topmost entry unconditionally. That is what the host's `done` callback
 *   calls, so resolving `done` while not on top dismisses somebody else's overlay.
 * - removing an entry retargets every surviving entry's `preFocus` away from it, so focus is never
 *   restored to a component that is no longer mounted.
 * - the overlay is mounted one microtask after the factory returns, and a `done` before that mount
 *   marks the open closed so the component is never shown at all.
 * - `nonCapturing` entries never take focus, and `hidden` entries neither render nor take focus.
 */
export function createOverlayHost({
  rows = 24,
  columns = 80,
  theme,
  mode = "regular",
  keybindings,
  onRender = () => {},
} = {}) {
  const stack = [];
  const writes = [];
  let focusOrder = 0;
  let focused = null;

  const isVisible = (entry) => !entry.hidden;
  const setFocus = (component) => {
    if (focused && focused !== component && typeof focused === "object") focused.focused = false;
    focused = component ?? null;
    if (component && typeof component === "object") component.focused = true;
  };
  const topVisibleCapturing = () => {
    const candidates = stack.filter((entry) => isVisible(entry) && entry.options?.nonCapturing !== true);
    return candidates.sort((a, b) => a.focusOrder - b.focusOrder).at(-1);
  };
  const removeEntry = (entry) => {
    const index = stack.indexOf(entry);
    if (index === -1) return false;
    for (const other of stack) {
      if (other !== entry && other.preFocus === entry.component) other.preFocus = entry.preFocus;
    }
    stack.splice(index, 1);
    if (focused === entry.component) {
      if (typeof entry.component === "object") entry.component.focused = false;
      setFocus(topVisibleCapturing()?.component ?? entry.preFocus ?? null);
    }
    return true;
  };

  const tui = {
    mode,
    // Only the members the viewer is allowed to touch: dimensions and a raw write for the
    // temporary wheel-reporting mode.
    terminal: { rows, columns, write(data) { writes.push(data); } },
    requestRender() { onRender(); },
    hasOverlay: () => stack.some(isVisible),
    getFocusedComponent: () => focused,
    showOverlay(component, options) {
      const entry = { component, options, preFocus: focused, hidden: false, focusOrder: ++focusOrder };
      stack.push(entry);
      if (options?.nonCapturing !== true && isVisible(entry)) setFocus(component);
      return {
        hide: () => { removeEntry(entry); },
        setHidden: (hidden) => {
          if (entry.hidden === hidden) return;
          entry.hidden = hidden;
          if (hidden) {
            if (focused === component) setFocus(topVisibleCapturing()?.component ?? entry.preFocus ?? null);
          } else if (options?.nonCapturing !== true) {
            entry.focusOrder = ++focusOrder;
            setFocus(component);
          }
        },
        isHidden: () => entry.hidden,
        focus: () => { entry.focusOrder = ++focusOrder; setFocus(component); },
        unfocus: () => setFocus(topVisibleCapturing()?.component ?? null),
        isFocused: () => focused === component,
      };
    },
    hideOverlay() {
      const entry = stack[stack.length - 1];
      if (entry) removeEntry(entry);
    },
  };

  return {
    tui,
    writes: () => [...writes],
    entries: () => [...stack],
    components: () => stack.map((entry) => entry.component),
    contains: (component) => stack.some((entry) => entry.component === component),
    focusedComponent: () => focused,
    /** Mounts a foreign overlay above whatever is already there, like another package would. */
    pushForeignOverlay(options = {}) {
      const component = { focused: false, render: () => ["foreign"], handleInput() {} };
      return { component, handle: tui.showOverlay(component, options) };
    },
    custom(factory, options, hooks = {}) {
      return new Promise((resolve) => {
        let component;
        let closed = false;
        const done = (value) => {
          if (closed) return;
          closed = true;
          tui.hideOverlay();
          hooks.onResolve?.();
          resolve(value);
          component?.dispose?.();
          hooks.onDispose?.();
        };
        component = factory(tui, theme, keybindings ?? { matches: () => false }, done);
        void Promise.resolve().then(() => {
          if (closed) return;
          const handle = tui.showOverlay(component, options?.overlayOptions);
          options?.onHandle?.(handle);
        });
      });
    },
  };
}
