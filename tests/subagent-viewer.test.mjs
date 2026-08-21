import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { registerHooks } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
import test from "node:test";

const piEntry = realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim());
const piRoot = dirname(dirname(piEntry));
const dependencyMap = {
  "@earendil-works/pi-coding-agent": pathToFileURL(`${piRoot}/dist/index.js`).href,
  "@earendil-works/pi-tui": pathToFileURL(`${piRoot}/node_modules/@earendil-works/pi-tui/dist/index.js`).href,
  "./semantic-glyph.js": new URL("../extensions/oh-my-pi-slim/semantic-glyph.ts", import.meta.url).href,
  "./subagent-core.js": new URL("../extensions/oh-my-pi-slim/subagent-core.ts", import.meta.url).href,
  "./subagent-model-display.js": new URL("../extensions/oh-my-pi-slim/subagent-model-display.ts", import.meta.url).href,
  "./subagent-viewer-data.js": new URL("../extensions/oh-my-pi-slim/subagent-viewer-data.ts", import.meta.url).href,
  "./subagent-widget-display.js": new URL("../extensions/oh-my-pi-slim/subagent-widget-display.ts", import.meta.url).href,
  "./subagent-widget-glyphs.js": new URL("../extensions/oh-my-pi-slim/subagent-widget-glyphs.ts", import.meta.url).href,
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    const url = dependencyMap[specifier];
    return url ? { url, shortCircuit: true } : nextResolve(specifier, context);
  },
});

const { visibleWidth } = await import("@earendil-works/pi-tui");
const {
  VIEWER_MAX_ARGS_CHARS,
  VIEWER_MAX_BLOCK_LINES,
  VIEWER_MAX_ENTRIES,
  VIEWER_MAX_FILE_BYTES,
  VIEWER_MAX_TRANSCRIPT_LINES,
  cycleViewerSelection,
  isViewerStatus,
  lastAssistantText,
  liveTextIsRedundant,
  loadViewerTranscript,
  neighborAfterViewerRemoval,
  renderViewerEntry,
  renderViewerLive,
  renderViewerTranscript,
  resolveViewerSessionFile,
  sanitizeViewerInline,
  sanitizeViewerText,
  wrapViewerText,
} = await import("../extensions/oh-my-pi-slim/subagent-viewer-data.ts");
const {
  SubagentViewer,
  VIEWER_EMPTY_MESSAGE,
  VIEWER_GONE_TICKS,
  VIEWER_READ_ONLY_LABEL,
  VIEWER_REFRESH_MS,
  createSubagentViewer,
} = await import("../extensions/oh-my-pi-slim/subagent-viewer.ts");
const { createOverlayHost } = await import("./fixtures/overlay-host.mjs");

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CACHE = join(ROOT, ".cache");
mkdirSync(CACHE, { recursive: true });

const theme = {
  fg: (_color, text) => text,
  bold: (text) => text,
};

const KEY = {
  left: "\x1b[D",
  right: "\x1b[C",
  ctrlShiftLeft: "\x1b[1;6D",
  ctrlShiftRight: "\x1b[1;6C",
  up: "\x1b[A",
  down: "\x1b[B",
  pageUp: "\x1b[5~",
  pageDown: "\x1b[6~",
  home: "\x1b[H",
  end: "\x1b[F",
  escape: "\x1b",
};

const flush = () => new Promise((resolve) => setImmediate(resolve));

const VIEWER_NOW_MS = Date.parse("2026-04-17T01:02:03.000Z");
const VIEWER_NOW_CLOCK = new Date(VIEWER_NOW_MS)
  .toTimeString()
  .slice(0, 8);

function runSnapshot(overrides = {}) {
  return {
    id: "run-a",
    agent: "fixer",
    abstract: "fix the parser",
    status: "running",
    live: true,
    model: "provider/model:high",
    createdAt: "2026-04-17T00:00:00.000Z",
    updatedAt: "2026-04-17T00:00:10.000Z",
    sessionFile: "/child/sessions/run-a.jsonl",
    activity: {
      turnCount: 2,
      toolUses: 3,
      activeTools: {},
      responseText: "",
      tokens: 1200,
      compactionCount: 0,
    },
    ...overrides,
  };
}

function transcriptOf(entries, extra = {}) {
  return { status: "ok", entries, hiddenEntries: 0, fingerprint: "fp-1", ...extra };
}

function messageEntry(id, parentId, message) {
  return { type: "message", id, parentId, timestamp: "2026-04-17T00:00:00.000Z", message };
}

function assistantText(id, parentId, text) {
  return messageEntry(id, parentId, { role: "assistant", content: [{ type: "text", text }], timestamp: 0 });
}

function createHarness({
  runs = [runSnapshot()],
  childSessionDir = "/child/sessions",
  loadTranscript,
  rows = 24,
  columns = 80,
} = {}) {
  const state = {
    runs,
    childSessionDir,
    notifications: [],
    customCalls: [],
    intervals: [],
    loads: [],
    renders: 0,
    disposes: 0,
    component: undefined,
    resolved: false,
    handles: [],
  };
  const host = createOverlayHost({ rows, columns, theme, onRender: () => { state.renders += 1; } });
  const ui = {
    notify(message, type) { state.notifications.push({ message, type }); },
    custom(factory, options) {
      state.customCalls.push(options);
      return host.custom((tui, tuiTheme, keybindings, done) => {
        const component = factory(tui, tuiTheme, keybindings, done);
        state.component = component;
        return component;
      }, {
        ...options,
        onHandle: (handle) => {
          state.handles.push(handle);
          options?.onHandle?.(handle);
        },
      }, {
        onResolve: () => { state.resolved = true; },
        onDispose: () => { state.disposes += 1; },
      });
    },
  };
  const tui = host.tui;
  const viewer = new SubagentViewer({
    snapshot: () => ({ runs: state.runs, childSessionDir: state.childSessionDir }),
    loadTranscript: loadTranscript ?? ((dir, sessionFile, fingerprint) => {
      state.loads.push({ dir, sessionFile, fingerprint });
      return { status: "ok", fingerprint: `fp-${sessionFile}`, transcript: transcriptOf([], { fingerprint: `fp-${sessionFile}` }) };
    }),
    setInterval(callback, ms) {
      const timer = { callback, ms, cleared: false };
      state.intervals.push(timer);
      return timer;
    },
    clearInterval(timer) { timer.cleared = true; },
    nowMs: () => VIEWER_NOW_MS,
    refreshMs: VIEWER_REFRESH_MS,
  });
  return {
    ...state,
    get component() { return state.component; },
    get renders() { return state.renders; },
    get notifications() { return state.notifications; },
    get customCalls() { return state.customCalls; },
    get loads() { return state.loads; },
    get intervals() { return state.intervals; },
    get disposes() { return state.disposes; },
    get resolved() { return state.resolved; },
    viewer,
    ui,
    tui,
    host,
    get handles() { return state.handles; },
    /** Components currently mounted as overlay entries, bottom to top. */
    get overlays() { return host.entries().map((entry) => entry.component); },
    setRuns(next) { state.runs = next; },
    setRows(next) { tui.terminal.rows = next; },
    tick() {
      for (const timer of state.intervals) if (!timer.cleared) timer.callback();
    },
    key(data) { state.component?.handleInput(data); },
    lines(width = columns) { return state.component.render(width).map((line) => stripVTControlCharacters(line)); },
    /** Raw renderer output, with nothing stripped, so escape assertions are end to end. */
    rawLines(width = columns) { return state.component.render(width); },
    /** Pushes a foreign overlay above the viewer, exactly as another package's overlay would. */
    pushForeignOverlay(options = {}) { return host.pushForeignOverlay(options); },
    /** Simulates a host that hides the top overlay without ever resolving its custom promise. */
    hideTopOverlayWithoutResolving() { host.tui.hideOverlay(); },
  };
}

/**
 * Opens the overlay and hands back the still-pending open promise inside a plain container.
 * Returning the promise directly would make the caller's `await` wait for the viewer to close.
 */
async function openViewer(harness, direction = 1) {
  const opened = harness.viewer.handleShortcut(harness.ui, direction, { enabled: true });
  await flush();
  return { opened };
}

/* ---------------------------------------------------------------------------------------------- */

test("Main is item 0 of one cycle that wraps in both directions", () => {
  const ids = ["a", "b", "c"];
  assert.equal(cycleViewerSelection(ids, undefined, 1), "a");
  assert.equal(cycleViewerSelection(ids, "a", 1), "b");
  assert.equal(cycleViewerSelection(ids, "b", 1), "c");
  assert.equal(cycleViewerSelection(ids, "c", 1), undefined);
  assert.equal(cycleViewerSelection(ids, undefined, -1), "c");
  assert.equal(cycleViewerSelection(ids, "c", -1), "b");
  assert.equal(cycleViewerSelection(ids, "b", -1), "a");
  assert.equal(cycleViewerSelection(ids, "a", -1), undefined);
});

test("cycle handles a single run, an empty set, and an unknown current run", () => {
  assert.equal(cycleViewerSelection(["only"], undefined, 1), "only");
  assert.equal(cycleViewerSelection(["only"], "only", 1), undefined);
  assert.equal(cycleViewerSelection(["only"], undefined, -1), "only");
  assert.equal(cycleViewerSelection(["only"], "only", -1), undefined);
  assert.equal(cycleViewerSelection([], undefined, 1), undefined);
  assert.equal(cycleViewerSelection([], "gone", -1), undefined);
  assert.equal(cycleViewerSelection(["a", "b"], "gone", 1), "a");
  assert.equal(cycleViewerSelection(["a", "b"], "gone", -1), "b");
});

test("removal picks the run that took the vacated position, then the closest earlier run", () => {
  assert.equal(neighborAfterViewerRemoval(["a", "b", "c"], ["a", "c"], "b"), "c");
  assert.equal(neighborAfterViewerRemoval(["a", "b", "c"], ["b", "c"], "a"), "b");
  assert.equal(neighborAfterViewerRemoval(["a", "b", "c"], ["a", "b"], "c"), "b");
  assert.equal(neighborAfterViewerRemoval(["a"], [], "a"), undefined);
  assert.equal(neighborAfterViewerRemoval([], ["x"], "a"), "x");
});

test("only running and waiting runs belong to the viewer cycle", () => {
  assert.equal(isViewerStatus("running"), true);
  assert.equal(isViewerStatus("waiting"), true);
  for (const status of ["starting", "completed", "failed", "interrupted"]) {
    assert.equal(isViewerStatus(status), false);
  }
});

test("an empty active set notifies exactly once and never opens the overlay", async () => {
  const harness = createHarness({ runs: [] });
  await harness.viewer.handleShortcut(harness.ui, 1, { enabled: true });
  assert.deepEqual(harness.notifications, [{ message: VIEWER_EMPTY_MESSAGE, type: "info" }]);
  assert.equal(harness.customCalls.length, 0);
  assert.equal(harness.viewer.isOpen(), false);
  assert.equal(VIEWER_EMPTY_MESSAGE, "No running or waiting subagents.");
});

test("a disabled host never opens the viewer and never notifies", async () => {
  const harness = createHarness();
  await harness.viewer.handleShortcut(harness.ui, 1, { enabled: false });
  assert.equal(harness.customCalls.length, 0);
  assert.equal(harness.notifications.length, 0);
  assert.equal(harness.viewer.isOpen(), false);
});

test("the overlay opens full screen at the viewport origin", async () => {
  const harness = createHarness();
  const { opened } = await openViewer(harness);
  assert.equal(harness.customCalls.length, 1);
  assert.equal(harness.customCalls[0].overlay, true);
  assert.deepEqual(harness.customCalls[0].overlayOptions, {
    width: "100%", maxHeight: "100%", row: 0, col: 0, margin: 0,
  });
  // The public handle hook is how the viewer later removes exactly its own overlay entry.
  assert.equal(typeof harness.customCalls[0].onHandle, "function");
  assert.deepEqual(Object.keys(harness.customCalls[0]).sort(), ["onHandle", "overlay", "overlayOptions"]);
  assert.equal(harness.handles.length, 1);
  assert.equal(harness.viewer.isOpen(), true);
  assert.equal(harness.host.contains(harness.component), true);
  harness.viewer.close();
  await opened;
  assert.equal(harness.viewer.isOpen(), false);
  assert.equal(harness.host.entries().length, 0);
});

test("ctrl+shift+right starts at the first run and ctrl+shift+left starts at the last run", async () => {
  const runs = [runSnapshot({ id: "a" }), runSnapshot({ id: "b" }), runSnapshot({ id: "c" })];
  const forward = createHarness({ runs });
  const { opened: forwardOpen } = await openViewer(forward, 1);
  assert.equal(forward.viewer.currentRun(), "a");
  forward.viewer.close();
  await forwardOpen;

  const backward = createHarness({ runs });
  const { opened: backwardOpen } = await openViewer(backward, -1);
  assert.equal(backward.viewer.currentRun(), "c");
  backward.viewer.close();
  await backwardOpen;
});

test("plain and ctrl+shift arrows cycle identically and leaving the ring returns to Main", async () => {
  const runs = [runSnapshot({ id: "a" }), runSnapshot({ id: "b" })];
  for (const [next, previous] of [[KEY.right, KEY.left], [KEY.ctrlShiftRight, KEY.ctrlShiftLeft]]) {
    const harness = createHarness({ runs });
    const { opened } = await openViewer(harness, 1);
    assert.equal(harness.viewer.currentRun(), "a");
    harness.key(next);
    assert.equal(harness.viewer.currentRun(), "b");
    harness.key(previous);
    assert.equal(harness.viewer.currentRun(), "a");
    harness.key(previous);
    await opened;
    assert.equal(harness.viewer.isOpen(), false);

    const forwardHarness = createHarness({ runs });
    const { opened: forwardOpened } = await openViewer(forwardHarness, 1);
    forwardHarness.key(next);
    forwardHarness.key(next);
    await forwardOpened;
    assert.equal(forwardHarness.viewer.isOpen(), false);
  }
});

test("Escape and q return to Main", async () => {
  for (const key of [KEY.escape, "q"]) {
    const harness = createHarness();
    const { opened } = await openViewer(harness);
    const component = harness.component;
    harness.key(key);
    await opened;
    assert.equal(harness.viewer.isOpen(), false);
    assert.equal(harness.host.contains(component), false, "the viewer entry must be gone");
    assert.equal(harness.host.entries().length, 0);
    assert.equal(harness.intervals[0].cleared, true);
  }
});

test("a run that reaches a terminal status hands the view to its neighbor", async () => {
  const runs = [runSnapshot({ id: "a" }), runSnapshot({ id: "b" }), runSnapshot({ id: "c" })];
  const harness = createHarness({ runs });
  const { opened } = await openViewer(harness);
  harness.key(KEY.right);
  assert.equal(harness.viewer.currentRun(), "b");
  harness.setRuns([runs[0], runs[2]]);
  harness.tick();
  assert.equal(harness.viewer.currentRun(), "c");
  harness.setRuns([runs[0]]);
  harness.tick();
  assert.equal(harness.viewer.currentRun(), "a");
  harness.setRuns([]);
  harness.tick();
  await opened;
  assert.equal(harness.viewer.isOpen(), false);
});

test("a new run joins the cycle without moving the current selection", async () => {
  const first = runSnapshot({ id: "a" });
  const harness = createHarness({ runs: [first] });
  const { opened } = await openViewer(harness);
  assert.equal(harness.viewer.currentRun(), "a");
  harness.setRuns([first, runSnapshot({ id: "b" })]);
  harness.tick();
  assert.equal(harness.viewer.currentRun(), "a");
  harness.key(KEY.right);
  assert.equal(harness.viewer.currentRun(), "b");
  harness.viewer.close();
  await opened;
});

test("waiting and running transitions keep the same run on screen", async () => {
  const harness = createHarness({ runs: [runSnapshot({ id: "a" })] });
  const { opened } = await openViewer(harness);
  harness.setRuns([runSnapshot({
    id: "a",
    status: "waiting",
    request: {
      runId: "a",
      reason: "need_decision",
      message: "Pick a lane.",
      createdAt: "2026-04-17T00:01:00.000Z",
    },
  })]);
  harness.tick();
  await flush();
  assert.equal(harness.viewer.currentRun(), "a");
  assert.ok(harness.lines().some((line) => line.includes("waiting")));
  harness.setRuns([runSnapshot({ id: "a", status: "running" })]);
  harness.tick();
  await flush();
  assert.equal(harness.viewer.currentRun(), "a");
  assert.ok(harness.lines().some((line) => line.includes("running")));
  harness.viewer.close();
  await opened;
});

test("each run keeps its own scroll and follow state across switches", async () => {
  const runs = [runSnapshot({ id: "a" }), runSnapshot({ id: "b" })];
  const body = Array.from({ length: 40 }, (_, index) => assistantText(`m${index}`, index === 0 ? null : `m${index - 1}`, `line ${index}`));
  const harness = createHarness({
    runs,
    loadTranscript: (_dir, sessionFile) => ({
      status: "ok",
      fingerprint: `fp-${sessionFile}`,
      transcript: transcriptOf(body, { fingerprint: `fp-${sessionFile}` }),
    }),
  });
  const { opened } = await openViewer(harness);
  harness.lines();
  harness.key(KEY.home);
  harness.lines();
  assert.equal(harness.viewer.model().state.scroll, 0);
  assert.equal(harness.viewer.model().state.follow, false);

  harness.key(KEY.right);
  await flush();
  harness.lines();
  assert.equal(harness.viewer.model().state.follow, true);
  const followedScroll = harness.viewer.model().state.scroll;
  assert.ok(followedScroll > 0);

  harness.key(KEY.left);
  await flush();
  harness.lines();
  assert.equal(harness.viewer.model().state.scroll, 0);
  assert.equal(harness.viewer.model().state.follow, false);
  harness.viewer.close();
  await opened;
});

test("every scroll key moves the viewport and follow reattaches to the tail", async () => {
  const body = Array.from({ length: 60 }, (_, index) => assistantText(`m${index}`, index === 0 ? null : `m${index - 1}`, `line ${index}`));
  const harness = createHarness({
    loadTranscript: () => ({ status: "ok", fingerprint: "fp", transcript: transcriptOf(body) }),
  });
  const { opened } = await openViewer(harness);
  harness.lines();
  const bottom = harness.viewer.model().state.scroll;
  assert.ok(bottom > 0);

  harness.key(KEY.up);
  harness.lines();
  assert.equal(harness.viewer.model().state.scroll, bottom - 1);
  assert.equal(harness.viewer.model().state.follow, false);

  harness.key(KEY.down);
  harness.lines();
  assert.equal(harness.viewer.model().state.scroll, bottom);

  harness.key(KEY.home);
  harness.lines();
  assert.equal(harness.viewer.model().state.scroll, 0);

  const page = harness.component.viewportRows();
  harness.key(KEY.pageDown);
  harness.lines();
  assert.equal(harness.viewer.model().state.scroll, Math.min(bottom, page));

  harness.key(KEY.pageUp);
  harness.lines();
  assert.equal(harness.viewer.model().state.scroll, 0);

  harness.key(KEY.end);
  harness.lines();
  assert.equal(harness.viewer.model().state.follow, true);
  assert.equal(harness.viewer.model().state.scroll, bottom);

  harness.key("f");
  harness.lines();
  assert.equal(harness.viewer.model().state.follow, false);
  harness.key("f");
  harness.lines();
  assert.equal(harness.viewer.model().state.follow, true);
  harness.viewer.close();
  await opened;
});

test("r forces an immediate re-read even when the fingerprint is unchanged", async () => {
  const harness = createHarness();
  const { opened } = await openViewer(harness);
  await flush();
  const before = harness.loads.length;
  harness.key("r");
  await flush();
  assert.equal(harness.loads.length, before + 1);
  assert.equal(harness.loads.at(-1).fingerprint, undefined);
  harness.viewer.close();
  await opened;
});

test("r pressed during an in-flight read still forces the follow-up read", async () => {
  const pending = [];
  const harness = createHarness({
    loadTranscript: (_dir, _sessionFile, fingerprint) => new Promise((resolve) => {
      pending.push({ fingerprint, resolve });
    }),
  });
  const { opened } = await openViewer(harness);
  assert.equal(pending.length, 1);

  harness.key("r");
  await flush();
  assert.equal(pending.length, 1, "the read stays single-flight");

  pending[0].resolve({ status: "ok", fingerprint: "fp-1", transcript: transcriptOf([]) });
  await flush();
  assert.equal(pending.length, 2);
  assert.equal(pending[1].fingerprint, undefined, "the queued read must keep the force intent");

  pending[1].resolve({ status: "unchanged", fingerprint: "fp-1" });
  await flush();
  harness.viewer.close();
  await opened;
});

test("the refresh timer runs at 250 ms and is cleared on close", async () => {
  const harness = createHarness();
  const { opened } = await openViewer(harness);
  assert.equal(harness.intervals.length, 1);
  assert.equal(harness.intervals[0].ms, 250);
  assert.equal(VIEWER_REFRESH_MS, 250);
  harness.viewer.close();
  await opened;
  assert.equal(harness.intervals[0].cleared, true);
});

test("transcript reads are single-flight and an unchanged fingerprint is reused", async () => {
  let pending;
  let calls = 0;
  const harness = createHarness({
    loadTranscript: () => {
      calls += 1;
      return new Promise((resolve) => { pending = resolve; });
    },
  });
  const { opened } = await openViewer(harness);
  assert.equal(calls, 1);
  harness.tick();
  harness.tick();
  await flush();
  assert.equal(calls, 1);
  pending({ status: "ok", fingerprint: "fp-1", transcript: transcriptOf([]) });
  await flush();
  assert.equal(calls, 2);
  pending({ status: "unchanged", fingerprint: "fp-1" });
  await flush();
  harness.viewer.close();
  await opened;
});

test("a read that completes after close cannot render or revive the viewer", async () => {
  let resolveRead;
  const harness = createHarness({
    loadTranscript: () => new Promise((resolve) => { resolveRead = resolve; }),
  });
  const { opened } = await openViewer(harness);
  const rendersBefore = harness.renders;
  harness.viewer.close();
  await opened;
  resolveRead({ status: "ok", fingerprint: "late", transcript: transcriptOf([assistantText("m1", null, "late text")]) });
  await flush();
  assert.equal(harness.renders, rendersBefore);
  assert.equal(harness.viewer.isOpen(), false);
});

test("a timer tick after close never reopens the viewer", async () => {
  const harness = createHarness();
  const { opened } = await openViewer(harness);
  const timer = harness.intervals[0];
  harness.viewer.close();
  await opened;
  timer.cleared = false;
  timer.callback();
  await flush();
  assert.equal(harness.viewer.isOpen(), false);
  assert.equal(harness.customCalls.length, 1);
});

test("closing tears down before the overlay promise settles", async () => {
  const harness = createHarness();
  const { opened } = await openViewer(harness);
  harness.viewer.close();
  assert.equal(harness.viewer.isOpen(), false);
  assert.equal(harness.intervals[0].cleared, true);
  await opened;
  const { opened: reopened } = await openViewer(harness);
  assert.equal(harness.customCalls.length, 2);
  assert.equal(harness.viewer.isOpen(), true);
  harness.viewer.close();
  await reopened;
});

test("a host that drops the overlay without resolving never wedges the viewer", async () => {
  const harness = createHarness();
  const stuckUi = {
    notify: (message, type) => harness.ui.notify(message, type),
    custom: (factory, options) => {
      harness.customCalls.push(options);
      factory(harness.tui, theme, {}, () => {});
      return new Promise(() => {});
    },
  };
  const abandoned = harness.viewer.handleShortcut(stuckUi, 1, { enabled: true });
  await flush();
  assert.equal(harness.viewer.isOpen(), true);
  harness.viewer.close();
  assert.equal(harness.viewer.isOpen(), false);
  const { opened } = await openViewer(harness);
  assert.equal(harness.customCalls.length, 2);
  harness.viewer.close();
  await opened;
  assert.equal(harness.viewer.isOpen(), false);
  void abandoned;
});

test("a close that lands before the host builds the component is not adopted", async () => {
  const harness = createHarness();
  let deferredFactory;
  const lateUi = {
    notify: (message, type) => harness.ui.notify(message, type),
    custom: (factory, options) => {
      harness.customCalls.push(options);
      return new Promise((resolve) => {
        deferredFactory = () => factory(harness.tui, theme, {}, resolve);
      });
    },
  };
  const abandoned = lateUi.custom ? harness.viewer.handleShortcut(lateUi, 1, { enabled: true }) : undefined;
  await flush();
  harness.viewer.close();
  assert.equal(harness.viewer.isOpen(), false);
  const orphan = deferredFactory();
  await flush();
  await abandoned;
  assert.equal(harness.viewer.isOpen(), false);
  assert.equal(harness.renders, 0);
  assert.equal(orphan.render(80).length > 0, true);
  assert.equal(harness.resolved || harness.host.entries().length === 0, true);
});

test("a deferred factory whose close already ran never resolves done over a foreign overlay", async () => {
  const harness = createHarness();
  const foreign = harness.pushForeignOverlay();
  let deferredFactory;
  let resolvedLate = false;
  const lateUi = {
    notify: (message, type) => harness.ui.notify(message, type),
    custom: (factory, options) => new Promise(() => {
      harness.customCalls.push(options);
      deferredFactory = () => {
        const component = factory(harness.tui, theme, {}, () => {
          resolvedLate = true;
          harness.tui.hideOverlay();
        });
        options?.onHandle?.(harness.tui.showOverlay(component, options?.overlayOptions));
        return component;
      };
    }),
  };
  const abandoned = harness.viewer.handleShortcut(lateUi, 1, { enabled: true });
  await flush();
  harness.viewer.close();
  assert.equal(harness.viewer.isOpen(), false);

  deferredFactory();
  await flush();
  await abandoned;
  assert.equal(resolvedLate, false, "done must never pop the foreign overlay");
  assert.deepEqual(harness.overlays, [foreign.component], "the late entry removes itself again");
  assert.equal(harness.intervals[0].cleared, true);
});

test("only one viewer and one open promise exist at a time", async () => {
  const harness = createHarness();
  const { opened } = await openViewer(harness);
  await harness.viewer.handleShortcut(harness.ui, 1, { enabled: true });
  await harness.viewer.handleShortcut(harness.ui, -1, { enabled: true });
  assert.equal(harness.customCalls.length, 1);
  harness.viewer.close();
  await opened;
});

test("reset closes the viewer and drops retained per-run view state", async () => {
  const harness = createHarness();
  const { opened } = await openViewer(harness);
  harness.lines();
  harness.key(KEY.home);
  harness.viewer.reset();
  await opened;
  assert.equal(harness.viewer.isOpen(), false);
  assert.equal(harness.viewer.currentRun(), undefined);
  assert.equal(harness.intervals[0].cleared, true);
});

test("dispose is idempotent and leaves no live timer", async () => {
  const harness = createHarness();
  const { opened } = await openViewer(harness);
  harness.viewer.dispose();
  await opened;
  harness.viewer.dispose();
  assert.equal(harness.intervals.every((timer) => timer.cleared), true);
  assert.equal(harness.viewer.isOpen(), false);
});

/* ------------------------------------------------------------------------------------------------
 * Overlay ownership: the viewer removes exactly its own entry through the public OverlayHandle.
 * ---------------------------------------------------------------------------------------------- */

test("a close under a foreign capturing overlay removes only the viewer entry, with no zombie", async () => {
  const harness = createHarness();
  const { opened } = await openViewer(harness);
  const component = harness.component;
  const foreign = harness.pushForeignOverlay();
  assert.deepEqual(harness.overlays, [component, foreign.component]);
  assert.equal(harness.host.focusedComponent(), foreign.component, "a capturing overlay takes focus");

  harness.viewer.close();
  await opened;
  assert.equal(harness.viewer.isOpen(), false, "the close completes immediately, with no retry");
  assert.equal(harness.resolved, false, "the host's done must never run while the viewer is buried");
  assert.deepEqual(harness.overlays, [foreign.component], "only the viewer entry may be removed");
  assert.equal(harness.host.contains(component), false);
  assert.equal(harness.intervals[0].cleared, true, "the 250 ms timer must not outlive the close");

  // Closing the foreign overlay must return to Main, not resurrect a full-screen viewer entry.
  foreign.handle.hide();
  assert.deepEqual(harness.overlays, []);
  assert.equal(harness.host.focusedComponent(), null);

  const rendersBefore = harness.renders;
  harness.intervals[0].cleared = false;
  harness.intervals[0].callback();
  await flush();
  assert.equal(harness.viewer.isOpen(), false);
  assert.equal(harness.renders, rendersBefore, "no read or tick may repaint a closed viewer");
  assert.deepEqual(harness.overlays, [], "the viewer must never come back");
});

test("a foreign non-capturing or temporarily hidden overlay is never popped by a viewer close", async () => {
  for (const foreignOptions of [{ nonCapturing: true }, {}]) {
    const harness = createHarness();
    const { opened } = await openViewer(harness);
    const component = harness.component;
    const foreign = harness.pushForeignOverlay(foreignOptions);
    if (foreignOptions.nonCapturing !== true) foreign.handle.setHidden(true);

    // Neither shape makes the foreign entry the focused or the visually frontmost overlay, which
    // is exactly the case a focus-based ownership guess would get wrong.
    assert.notEqual(harness.host.focusedComponent(), foreign.component);
    assert.deepEqual(harness.overlays, [component, foreign.component]);

    harness.viewer.close();
    await opened;
    assert.equal(harness.viewer.isOpen(), false);
    assert.equal(harness.resolved, false);
    assert.deepEqual(harness.overlays, [foreign.component], "the foreign entry must survive");
    assert.equal(harness.host.contains(component), false, "the viewer entry must be gone");
    assert.equal(harness.intervals[0].cleared, true);

    foreign.handle.hide();
    assert.deepEqual(harness.overlays, []);
  }
});

test("a host that hides the viewer entry without resolving is healed by the refresh timer", async () => {
  const harness = createHarness();
  const { opened } = await openViewer(harness);
  const component = harness.component;
  harness.tick();
  harness.hideTopOverlayWithoutResolving();
  assert.equal(harness.resolved, false);
  assert.equal(harness.host.contains(component), false);
  for (let index = 0; index < VIEWER_GONE_TICKS - 1; index += 1) {
    harness.tick();
    assert.equal(harness.viewer.isOpen(), true, "one empty observation is not proof");
  }
  harness.tick();
  await opened;
  assert.equal(harness.viewer.isOpen(), false);
  assert.equal(harness.intervals[0].cleared, true);
  assert.deepEqual(harness.overlays, [], "the idempotent handle.hide must not disturb the stack");

  const { opened: reopened } = await openViewer(harness);
  assert.equal(harness.customCalls.length, 2);
  assert.equal(harness.overlays.length, 1);
  harness.viewer.close();
  await reopened;
  assert.deepEqual(harness.overlays, []);
});

test("a close that lands before the overlay is mounted leaves no entry behind", async () => {
  const harness = createHarness();
  const opened = harness.viewer.handleShortcut(harness.ui, 1, { enabled: true });
  // The host mounts one microtask after the factory returns, so close here beats the mount.
  harness.viewer.close();
  assert.equal(harness.viewer.isOpen(), false);
  await opened;
  await flush();
  assert.deepEqual(harness.overlays, [], "the factory result must never be mounted");
  assert.equal(harness.intervals[0].cleared, true);
});

test("a close before mount under a foreign overlay hides the late entry instead of popping theirs", async () => {
  const harness = createHarness();
  const foreign = harness.pushForeignOverlay();
  const opened = harness.viewer.handleShortcut(harness.ui, 1, { enabled: true });
  harness.viewer.close();
  assert.equal(harness.viewer.isOpen(), false);
  assert.equal(harness.resolved, false, "done must not pop the foreign overlay");
  await opened;
  await flush();
  assert.deepEqual(harness.overlays, [foreign.component], "a late mount must remove itself again");
  assert.equal(harness.intervals[0].cleared, true);
});

test("a synchronous ui.custom throw notifies once and leaves the viewer reopenable", async () => {
  const harness = createHarness();
  let shouldThrow = true;
  const throwingUi = {
    notify: (message, type) => harness.ui.notify(message, type),
    custom: (factory, options) => {
      if (shouldThrow) {
        shouldThrow = false;
        throw new Error("overlay host is gone");
      }
      return harness.ui.custom(factory, options);
    },
  };
  await harness.viewer.handleShortcut(throwingUi, 1, { enabled: true });
  assert.equal(harness.viewer.isOpen(), false);
  assert.equal(harness.customCalls.length, 0);
  assert.equal(harness.notifications.length, 1);
  assert.equal(harness.notifications[0].type, "error");
  assert.match(harness.notifications[0].message, /Subagent viewer could not open: overlay host is gone/);
  assert.equal(harness.intervals.length, 1);
  assert.equal(harness.intervals[0].cleared, true, "a failed open must not leave a timer behind");

  const opened = harness.viewer.handleShortcut(throwingUi, 1, { enabled: true });
  await flush();
  assert.equal(harness.viewer.isOpen(), true, "the next shortcut press must open again");
  assert.equal(harness.customCalls.length, 1);
  harness.viewer.close();
  await opened;
  assert.equal(harness.notifications.length, 1);
});

test("an asynchronously rejected overlay promise notifies once and never revives", async () => {
  const harness = createHarness();
  let rejectOverlay;
  const failingUi = {
    notify: (message, type) => harness.ui.notify(message, type),
    custom: (factory, options) => {
      harness.customCalls.push(options);
      factory(harness.tui, theme, {}, () => {});
      return new Promise((_resolve, reject) => { rejectOverlay = reject; });
    },
  };
  const opened = harness.viewer.handleShortcut(failingUi, 1, { enabled: true });
  await flush();
  rejectOverlay(new Error("overlay crashed"));
  await opened;
  assert.equal(harness.viewer.isOpen(), false);
  assert.equal(harness.intervals[0].cleared, true);
  assert.equal(harness.notifications.length, 1);
  assert.match(harness.notifications[0].message, /Subagent viewer closed with an error: overlay crashed/);
});

/* ---------------------------------------------------------------------------------------------- */

test("the overlay renders a complete screen with header, Read-Only bar, and footer", async () => {
  const harness = createHarness({ rows: 20 });
  const { opened } = await openViewer(harness);
  await flush();
  const lines = harness.lines(80);
  assert.equal(lines.length, 20);
  for (const line of lines) assert.equal(visibleWidth(line), 80);
  assert.match(lines[0], /^Subagent 1\/1 · fixer \[run-a\] · running · fix the parser/);
  assert.match(lines[1], /live · \(provider\) model • high/);
  assert.ok(lines.some((line) => line.trim() === VIEWER_READ_ONLY_LABEL));
  // The hint row wraps across as many footer rows as the width needs, so the assertion reads the
  // unwrapped hint text rather than a single rendered row.
  const hintText = lines.map((line) => line.trimEnd()).join(" ");
  assert.ok(hintText.includes("←/→ or Ctrl+Shift+←/→ run"));
  assert.ok(hintText.includes("Esc/q Main"));
  assert.ok(hintText.includes("f follow on"));
  assert.ok(lines.at(-1).includes(`updated ${VIEWER_NOW_CLOCK}`));
  assert.ok(lines.at(-1).includes("0/0"));
  harness.viewer.close();
  await opened;
});

test("the viewer keeps every row inside the width at narrow and wide terminals", async () => {
  const entries = [
    messageEntry("m1", null, { role: "user", content: "宽字符宽字符宽字符宽字符宽字符宽字符", timestamp: 0 }),
    assistantText("m2", "m1", "\u001b[31mred\u001b[0m answer with a very long line ".repeat(12)),
  ];
  const harness = createHarness({
    loadTranscript: () => ({ status: "ok", fingerprint: "fp", transcript: transcriptOf(entries) }),
  });
  const { opened } = await openViewer(harness);
  await flush();
  for (const width of [20, 40, 120]) {
    const lines = harness.lines(width);
    for (const line of lines) assert.ok(visibleWidth(line) <= width, `width ${width}: ${JSON.stringify(line)}`);
    assert.equal(lines.some((line) => line.includes("\u001b")), false);
  }
  harness.viewer.close();
  await opened;
});

test("a terminal resize re-lays out the viewer", async () => {
  const harness = createHarness({ rows: 24 });
  const { opened } = await openViewer(harness);
  await flush();
  assert.equal(harness.lines(80).length, 24);
  harness.setRows(40);
  assert.equal(harness.lines(80).length, 40);
  for (const rows of [12, 10, 8, 6]) {
    harness.setRows(rows);
    const short = harness.lines(80);
    assert.equal(short.length, rows, `rows ${rows}`);
    assert.ok(short.some((line) => line.includes(VIEWER_READ_ONLY_LABEL)), `rows ${rows} must keep the Read-Only row`);
    assert.ok(short.at(-1).includes("updated"), `rows ${rows} must keep the footer`);
    for (const line of short) assert.equal(visibleWidth(line), 80);
  }
  harness.viewer.close();
  await opened;
});

/* ---------------------------------------------------------------------------------------------- */

const HOSTILE_TEXT =
  "\u001b[31mred\u001b]8;;http://example.com\u0007link\u001b]0;retitled\u0007\u009b2J\u0000\u0007\u001b_apc\u009c\u001bPdcs\u001b\\tail";
/** Every C0 except newline, plus DEL and the whole C1 block. ESC is checked separately below. */
const UNTRUSTED_BYTE = /[\u0000-\u0009\u000b-\u001a\u001c-\u001f\u007f-\u009f]/;
/** Matches one escape sequence: CSI, OSC, DCS/APC-style, or a lone ESC plus its next byte. */
const ESCAPE_SEQUENCE = /\u001b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[PX^_][^\u001b]*(?:\u001b\\)?|.)/g;
/**
 * The only escape pi-tui's own width helpers re-emit once the content is already sanitized.
 * The assertion below allowlists exactly this byte string rather than stripping anything, so an
 * attacker-supplied sequence that survived sanitizing would still fail the test.
 */
const ALLOWED_ESCAPE = "\u001b[0m";

test("the raw rendered screen carries no untrusted ESC, OSC, C0, or C1 byte", async () => {
  const entries = [
    messageEntry("m1", null, { role: "user", content: HOSTILE_TEXT, timestamp: 0 }),
    messageEntry("m2", "m1", {
      role: "assistant",
      content: [
        { type: "thinking", thinking: HOSTILE_TEXT },
        { type: "text", text: `answer ${HOSTILE_TEXT}` },
        { type: "toolCall", id: "t1", name: `re\u001b[1mad`, arguments: { path: HOSTILE_TEXT } },
      ],
      timestamp: 0,
    }),
    messageEntry("m3", "m2", {
      role: "toolResult",
      toolCallId: "t1",
      toolName: `ba\u0007sh`,
      content: [{ type: "text", text: HOSTILE_TEXT }, { type: "image", data: "AAAA", mimeType: `im\u001b[0mage/png` }],
      isError: true,
      timestamp: 0,
    }),
    messageEntry("m4", "m3", { role: "bashExecution", command: HOSTILE_TEXT, output: HOSTILE_TEXT, timestamp: 0 }),
  ];
  const hostileRun = runSnapshot({
    id: `run\u0007-a`,
    agent: `fi\u001b[5mxer`,
    abstract: HOSTILE_TEXT,
    model: `pro\u001b]8;;x\u0007vider/model:high`,
    status: "waiting",
    request: {
      runId: "run-a",
      reason: `need\u001b[7m_decision`,
      message: HOSTILE_TEXT,
      createdAt: "2026-04-17T00:01:00.000Z",
    },
    activity: {
      turnCount: 1,
      toolUses: 1,
      activeTools: { one: { name: `gr\u001b[9mep` } },
      responseText: HOSTILE_TEXT,
      tokens: 5,
      compactionCount: 1,
    },
  });
  const harness = createHarness({
    runs: [hostileRun],
    loadTranscript: () => ({
      status: "ok",
      fingerprint: "fp",
      transcript: transcriptOf(entries, { warning: `Large \u001b[2Kfile\u0007 warning` }),
    }),
  });
  const { opened } = await openViewer(harness);
  await flush();
  for (const width of [24, 80, 160]) {
    // Asserted on the raw renderer output: stripping first would hide exactly the bug being tested.
    for (const line of harness.rawLines(width)) {
      assert.equal(UNTRUSTED_BYTE.test(line), false, `width ${width}: ${JSON.stringify(line)}`);
      for (const [sequence] of line.matchAll(ESCAPE_SEQUENCE)) {
        assert.equal(sequence, ALLOWED_ESCAPE, `width ${width}: ${JSON.stringify(line)}`);
      }
      assert.equal(line.includes("AAAA"), false, `width ${width}: image bytes must never render`);
    }
  }
  harness.viewer.close();
  await opened;
});

test("sanitizers remove ANSI, OSC, C0, and C1 sequences", () => {
  const dirty = "\u001b[31mred\u001b]8;;http://example.com\u0007link\u001b]8;;\u0007\u0000\u0007\u009b bell\ttab\r\nline";
  const clean = sanitizeViewerText(dirty);
  assert.equal(clean.includes("\u001b"), false);
  assert.equal(clean.includes("\u0000"), false);
  assert.equal(clean.includes("\u0007"), false);
  assert.equal(clean.includes("\u009b"), false);
  assert.equal(clean.includes("\r"), false);
  assert.equal(clean.includes("\t"), false);
  assert.ok(clean.includes("\n"));
  assert.equal(sanitizeViewerInline("a\nb\nc").includes("\n"), false);
});

test("wrapping is width safe for empty text, prefixes, and wide characters", () => {
  assert.deepEqual(wrapViewerText("", 10), [""]);
  assert.deepEqual(wrapViewerText("", 10, "  "), ["  "]);
  for (const line of wrapViewerText("宽字符".repeat(20), 11, "> ")) {
    assert.ok(visibleWidth(line) <= 11);
  }
});

test("entry rendering covers user, assistant, thinking, tool calls, results, and images", () => {
  const width = 60;
  const user = renderViewerEntry(messageEntry("m1", null, {
    role: "user",
    content: [{ type: "text", text: "please look" }, { type: "image", data: "AAAABBBBCCCC", mimeType: "image/png" }],
    timestamp: 0,
  }), width, theme).join("\n");
  assert.match(user, /▌ user/);
  assert.match(user, /please look/);
  assert.match(user, /\[image image\/png\]/);
  assert.equal(user.includes("AAAABBBBCCCC"), false);

  const assistant = renderViewerEntry(messageEntry("m2", "m1", {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "weighing options" },
      { type: "text", text: "here is the answer" },
      { type: "toolCall", id: "t1", name: "read", arguments: { path: "/tmp/a.txt" } },
    ],
    timestamp: 0,
  }), width, theme).join("\n");
  assert.match(assistant, /▌ thinking/);
  assert.match(assistant, /weighing options/);
  assert.match(assistant, /▌ assistant/);
  assert.match(assistant, /here is the answer/);
  assert.match(assistant, /⚙ read/);
  assert.match(assistant, /path/);

  const result = renderViewerEntry(messageEntry("m3", "m2", {
    role: "toolResult",
    toolCallId: "t1",
    toolName: "read",
    content: [{ type: "text", text: "file body" }, { type: "image", data: "ZZZZ", mimeType: "image/jpeg" }],
    isError: false,
    timestamp: 0,
  }), width, theme).join("\n");
  assert.match(result, /↳ read/);
  assert.match(result, /file body/);
  assert.match(result, /\[image image\/jpeg\]/);
  assert.equal(result.includes("ZZZZ"), false);

  const failed = renderViewerEntry(messageEntry("m4", "m3", {
    role: "toolResult",
    toolCallId: "t2",
    toolName: "bash",
    content: [{ type: "text", text: "boom" }],
    isError: true,
    timestamp: 0,
  }), width, theme).join("\n");
  assert.match(failed, /↳ bash/);
  assert.match(failed, /error/);
});

test("compaction, branch summary, and custom message entries render as summaries", () => {
  const width = 60;
  const compaction = renderViewerEntry({
    type: "compaction",
    id: "c1",
    parentId: "m1",
    timestamp: "2026-04-17T00:00:00.000Z",
    summary: "compacted history",
    firstKeptEntryId: "m1",
    tokensBefore: 4242,
  }, width, theme).join("\n");
  assert.match(compaction, /⟳ compaction/);
  assert.match(compaction, /4242 tokens before/);
  assert.match(compaction, /compacted history/);

  const branch = renderViewerEntry({
    type: "branch_summary",
    id: "b1",
    parentId: "m1",
    timestamp: "2026-04-17T00:00:00.000Z",
    fromId: "m0",
    summary: "branch recap",
  }, width, theme).join("\n");
  assert.match(branch, /⟳ branch summary/);
  assert.match(branch, /branch recap/);

  const custom = renderViewerEntry({
    type: "custom_message",
    id: "x1",
    parentId: "m1",
    timestamp: "2026-04-17T00:00:00.000Z",
    customType: "oh-my-pi-slim:note",
    content: "visible note",
    display: true,
  }, width, theme).join("\n");
  assert.match(custom, /\[oh-my-pi-slim:note\]/);
  assert.match(custom, /visible note/);

  assert.deepEqual(renderViewerEntry({
    type: "custom_message",
    id: "x2",
    parentId: "m1",
    timestamp: "2026-04-17T00:00:00.000Z",
    customType: "hidden",
    content: "never shown",
    display: false,
  }, width, theme), []);

  for (const type of ["custom", "model_change", "thinking_level_change", "label", "session_info"]) {
    assert.deepEqual(renderViewerEntry({ type, id: "s1", parentId: null, timestamp: "" }, width, theme), []);
  }
});

test("rendered blocks and transcripts stay inside their bounds", () => {
  const width = 40;
  const huge = renderViewerEntry(assistantText("m1", null, "x".repeat(200_000)), width, theme);
  assert.ok(huge.length <= VIEWER_MAX_BLOCK_LINES + 2);
  assert.ok(huge.some((line) => line.includes("more line(s) hidden")) || huge.length <= VIEWER_MAX_BLOCK_LINES + 1);

  const longArgs = renderViewerEntry(messageEntry("m2", null, {
    role: "assistant",
    content: [{ type: "toolCall", id: "t", name: "write", arguments: { text: "y".repeat(5000) } }],
    timestamp: 0,
  }), 400, theme).join("");
  assert.ok(longArgs.length < VIEWER_MAX_ARGS_CHARS + 200);

  const entries = Array.from({ length: 900 }, (_, index) => assistantText(`m${index}`, index === 0 ? null : `m${index - 1}`, "line ".repeat(40)));
  const lines = renderViewerTranscript(transcriptOf(entries, { hiddenEntries: 12 }), width, theme);
  assert.ok(lines.length <= VIEWER_MAX_TRANSCRIPT_LINES + 3);
  assert.match(lines[0], /12 older entries hidden/);
  assert.match(lines[1], /older lines trimmed/);
});

test("the live block shows waiting requests, active tools, and unsaved response text", () => {
  const width = 60;
  const waiting = renderViewerLive(runSnapshot({
    status: "waiting",
    request: {
      runId: "run-a",
      reason: "interview_request",
      message: "Choose one option.",
      interview: { questions: [{ prompt: "a" }, { prompt: "b" }] },
      createdAt: "2026-04-17T00:01:00.000Z",
    },
  }), transcriptOf([]), width, theme).join("\n");
  assert.match(waiting, /▌ waiting/);
  assert.match(waiting, /interview_request/);
  assert.match(waiting, /Choose one option\./);
  assert.match(waiting, /interview: 2 question\(s\)/);

  const running = renderViewerLive(runSnapshot({
    activity: {
      turnCount: 1,
      toolUses: 2,
      activeTools: { one: { name: "grep" }, two: { name: "read" } },
      responseText: "streaming tail",
      tokens: 10,
      compactionCount: 0,
    },
  }), transcriptOf([]), width, theme).join("\n");
  assert.match(running, /active tools/);
  assert.match(running, /grep, read/);
  assert.match(running, /live response/);
  assert.match(running, /streaming tail/);
});

test("the live block never repeats text already persisted on disk", () => {
  const persisted = transcriptOf([assistantText("m1", null, "the final answer is 42")]);
  assert.equal(lastAssistantText(persisted), "the final answer is 42");
  assert.equal(liveTextIsRedundant("the final answer is 42", "the final answer is 42"), true);
  assert.equal(liveTextIsRedundant("answer is 42", "the final answer is 42"), true);
  assert.equal(liveTextIsRedundant("   ", "anything"), true);
  assert.equal(liveTextIsRedundant("a different tail", "the final answer is 42"), false);
  const live = renderViewerLive(runSnapshot({
    activity: { turnCount: 1, toolUses: 0, activeTools: {}, responseText: "the final answer is 42", tokens: 1, compactionCount: 0 },
  }), persisted, 60, theme);
  assert.deepEqual(live, []);
});

/* ---------------------------------------------------------------------------------------------- */

function sessionFixture() {
  const dir = mkdtempSync(join(CACHE, "viewer-session-"));
  const childDir = join(dir, "omps-subagents");
  mkdirSync(childDir, { recursive: true });
  return { dir, childDir, file: join(childDir, "child.jsonl") };
}

test("session file resolution refuses escapes, links, and directories", () => {
  const fixture = sessionFixture();
  try {
    assert.equal(resolveViewerSessionFile(undefined, "/x").status, "waiting");
    assert.equal(resolveViewerSessionFile(fixture.childDir, undefined).status, "waiting");
    assert.equal(resolveViewerSessionFile(fixture.childDir, fixture.file).status, "waiting");

    writeFileSync(fixture.file, "");
    assert.deepEqual(resolveViewerSessionFile(fixture.childDir, fixture.file), { status: "ok", path: realpathSync(fixture.file) });

    const outside = join(fixture.dir, "outside.jsonl");
    writeFileSync(outside, "");
    const escaped = resolveViewerSessionFile(fixture.childDir, outside);
    assert.equal(escaped.status, "rejected");
    assert.match(escaped.reason, /outside this session's child session directory/);

    const traversal = resolveViewerSessionFile(fixture.childDir, join(fixture.childDir, "..", "outside.jsonl"));
    assert.equal(traversal.status, "rejected");

    const link = join(fixture.childDir, "link.jsonl");
    symlinkSync(outside, link);
    const linked = resolveViewerSessionFile(fixture.childDir, link);
    assert.equal(linked.status, "rejected");
    assert.match(linked.reason, /symbolic link/);

    const directory = join(fixture.childDir, "adir.jsonl");
    mkdirSync(directory);
    const asDirectory = resolveViewerSessionFile(fixture.childDir, directory);
    assert.equal(asDirectory.status, "rejected");
    assert.match(asDirectory.reason, /not a regular file/);

    assert.equal(resolveViewerSessionFile(fixture.childDir, join(fixture.childDir, "missing.jsonl")).status, "waiting");
    assert.equal(resolveViewerSessionFile(join(fixture.dir, "no-such-dir"), fixture.file).status, "waiting");

    // Only a real `..` path segment escapes; a child whose name merely starts with dots does not.
    for (const name of ["..foo.jsonl", "...jsonl", "..dotted"]) {
      const dotted = join(fixture.childDir, name);
      writeFileSync(dotted, "");
      assert.deepEqual(
        resolveViewerSessionFile(fixture.childDir, dotted),
        { status: "ok", path: realpathSync(dotted) },
        `${name} is a legitimate child file`,
      );
    }
    const nested = join(fixture.childDir, "..nested");
    mkdirSync(nested);
    const nestedFile = join(nested, "child.jsonl");
    writeFileSync(nestedFile, "");
    assert.equal(resolveViewerSessionFile(fixture.childDir, nestedFile).status, "ok");
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("a missing child session file reads as waiting, never as an error", () => {
  const fixture = sessionFixture();
  try {
    const load = loadViewerTranscript(fixture.childDir, fixture.file);
    assert.equal(load.status, "waiting");
    assert.match(load.transcript.warning, /not been created yet/);
    assert.deepEqual(load.transcript.entries, []);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("the reader tolerates malformed and partially written trailing lines", () => {
  const fixture = sessionFixture();
  try {
    const lines = [
      JSON.stringify({ type: "session", id: "s", timestamp: "t", cwd: "/tmp" }),
      JSON.stringify(messageEntry("m1", null, { role: "user", content: "hello", timestamp: 0 })),
      "{ this is not json",
      JSON.stringify(assistantText("m2", "m1", "hi there")),
      '{"type":"message","id":"m3","parentId":"m2","mess',
    ];
    writeFileSync(fixture.file, `${lines.join("\n")}\n`);
    const load = loadViewerTranscript(fixture.childDir, fixture.file);
    assert.equal(load.status, "ok");
    assert.equal(load.transcript.entries.length, 2);
    const rendered = renderViewerTranscript(load.transcript, 60, theme).join("\n");
    assert.match(rendered, /hello/);
    assert.match(rendered, /hi there/);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("an unchanged file is not re-read and a changed file is", () => {
  const fixture = sessionFixture();
  try {
    writeFileSync(fixture.file, `${JSON.stringify(assistantText("m1", null, "one"))}\n`);
    const first = loadViewerTranscript(fixture.childDir, fixture.file);
    assert.equal(first.status, "ok");
    const unchanged = loadViewerTranscript(fixture.childDir, fixture.file, first.fingerprint);
    assert.equal(unchanged.status, "unchanged");
    assert.equal(unchanged.transcript, undefined);
    writeFileSync(fixture.file, `${JSON.stringify(assistantText("m1", null, "one"))}\n${JSON.stringify(assistantText("m2", "m1", "two"))}\n`);
    const changed = loadViewerTranscript(fixture.childDir, fixture.file, first.fingerprint);
    assert.equal(changed.status, "ok");
    assert.equal(changed.transcript.entries.length, 2);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("an oversized session file degrades to a bounded read-only tail with a warning", () => {
  const fixture = sessionFixture();
  try {
    const filler = "z".repeat(4000);
    const lines = [];
    let parentId = null;
    for (let index = 0; index < 800; index += 1) {
      lines.push(JSON.stringify(assistantText(`m${index}`, parentId, `${filler} ${index}`)));
      parentId = `m${index}`;
    }
    lines.push(JSON.stringify(assistantText("tail", parentId, "the newest line")));
    writeFileSync(fixture.file, `${lines.join("\n")}\n`);
    assert.ok(statSync(fixture.file).size > VIEWER_MAX_FILE_BYTES);
    const load = loadViewerTranscript(fixture.childDir, fixture.file);
    assert.equal(load.status, "ok");
    assert.match(load.transcript.warning, /Large session file/);
    assert.ok(load.transcript.entries.length > 0);
    assert.ok(load.transcript.entries.length <= VIEWER_MAX_ENTRIES);
    const rendered = renderViewerTranscript(load.transcript, 60, theme).join("\n");
    assert.match(rendered, /the newest line/);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("the reader follows the active compaction-aware branch", () => {
  const fixture = sessionFixture();
  try {
    const entries = [
      { type: "session", id: "s", timestamp: "t", cwd: "/tmp" },
      messageEntry("m1", null, { role: "user", content: "dropped by compaction", timestamp: 0 }),
      messageEntry("m2", "m1", { role: "user", content: "kept after compaction", timestamp: 0 }),
      assistantText("m4", "m1", "abandoned branch"),
      {
        type: "compaction",
        id: "c1",
        parentId: "m2",
        timestamp: "2026-04-17T00:00:00.000Z",
        summary: "summary of the old turns",
        firstKeptEntryId: "m2",
        tokensBefore: 100,
      },
      assistantText("m3", "c1", "after compaction"),
    ];
    writeFileSync(fixture.file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
    const load = loadViewerTranscript(fixture.childDir, fixture.file);
    const rendered = renderViewerTranscript(load.transcript, 70, theme).join("\n");
    assert.match(rendered, /summary of the old turns/);
    assert.match(rendered, /kept after compaction/);
    assert.match(rendered, /after compaction/);
    assert.equal(rendered.includes("dropped by compaction"), false);
    assert.equal(rendered.includes("abandoned branch"), false);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

/**
 * Every case below feeds data that would make Pi's `buildContextEntries` walk a parent chain
 * forever or dereference a non-object. Each read is also wall-clock bounded, so a regression that
 * reintroduces the hang fails loudly instead of hanging the whole test run.
 */
const BRANCH_READ_BUDGET_MS = 2000;

function readWithinBudget(fixture) {
  const started = Date.now();
  const load = loadViewerTranscript(fixture.childDir, fixture.file);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < BRANCH_READ_BUDGET_MS, `read took ${elapsed} ms, which is not a bounded read`);
  return load;
}

function withFixture(lines, assertions) {
  const fixture = sessionFixture();
  try {
    writeFileSync(fixture.file, `${lines.join("\n")}\n`);
    assertions(readWithinBudget(fixture));
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
}

test("null, scalar, array, and shapeless rows never reach the branch helpers", () => {
  withFixture([
    "null",
    "42",
    '"a bare string"',
    "[1, 2, 3]",
    "true",
    JSON.stringify({ type: "session", id: "s", timestamp: "t", cwd: "/tmp" }),
    JSON.stringify({ type: "message", parentId: null, message: { role: "user", content: "no id", timestamp: 0 } }),
    JSON.stringify({ type: "message", id: 7, parentId: null, message: { role: "user", content: "numeric id", timestamp: 0 } }),
    JSON.stringify({ type: "message", id: "", parentId: null, message: { role: "user", content: "empty id", timestamp: 0 } }),
    JSON.stringify({ id: "no-type", parentId: null, message: { role: "user", content: "no type", timestamp: 0 } }),
    JSON.stringify({ type: "message", id: "num-parent", parentId: 12, message: { role: "user", content: "numeric parent", timestamp: 0 } }),
    JSON.stringify({ type: "message", id: "obj-parent", parentId: { a: 1 }, message: { role: "user", content: "object parent", timestamp: 0 } }),
    JSON.stringify({ type: "message", id: "arr-parent", parentId: ["x"], message: { role: "user", content: "array parent", timestamp: 0 } }),
    JSON.stringify(messageEntry("good1", null, { role: "user", content: "first good line", timestamp: 0 })),
    JSON.stringify(assistantText("good2", "good1", "second good line")),
  ], (load) => {
    assert.equal(load.status, "ok");
    assert.deepEqual(load.transcript.entries.map((entry) => entry.id), ["good1", "good2"]);
    assert.match(load.transcript.warning, /unusable entries skipped/);
    assert.ok(load.transcript.fingerprint, "a rejected row must still yield a cacheable fingerprint");
  });
});

test("a self-referencing entry is dropped before any parent walk starts", () => {
  withFixture([
    JSON.stringify(messageEntry("good1", null, { role: "user", content: "first good line", timestamp: 0 })),
    JSON.stringify(assistantText("loop", "loop", "i am my own parent")),
    JSON.stringify(assistantText("good2", "good1", "second good line")),
  ], (load) => {
    assert.equal(load.status, "ok");
    assert.deepEqual(load.transcript.entries.map((entry) => entry.id), ["good1", "good2"]);
    assert.match(load.transcript.warning, /unusable entry skipped/);
  });
});

test("a two-entry parent cycle degrades to file order instead of hanging", () => {
  withFixture([
    JSON.stringify(messageEntry("root", null, { role: "user", content: "the root", timestamp: 0 })),
    JSON.stringify(assistantText("a", "b", "first half of the cycle")),
    JSON.stringify(assistantText("b", "a", "second half of the cycle")),
  ], (load) => {
    assert.equal(load.status, "ok");
    assert.deepEqual(load.transcript.entries.map((entry) => entry.id), ["root", "a", "b"]);
    assert.match(load.transcript.warning, /Unusable branch metadata \(parent cycle\): showing file order/);
    const rendered = renderViewerTranscript(load.transcript, 60, theme).join("\n");
    assert.match(rendered, /the root/);
    assert.match(rendered, /second half of the cycle/);
  });
});

test("a duplicate entry id degrades to file order instead of rewiring the parent chain", () => {
  // Without the duplicate check the id index maps `a` to the last row, so walking from it goes
  // a -> b -> a forever. This is the exact multi-entry cycle a plain re-index would create.
  withFixture([
    JSON.stringify(messageEntry("a", null, { role: "user", content: "the real root", timestamp: 0 })),
    JSON.stringify(assistantText("b", "a", "the child")),
    JSON.stringify(assistantText("a", "b", "the impostor")),
  ], (load) => {
    assert.equal(load.status, "ok");
    assert.equal(load.transcript.entries.length, 3);
    assert.match(load.transcript.warning, /Unusable branch metadata \(duplicate entry id\): showing file order/);
  });
});

test("a dangling parent reference reads cleanly and keeps the whole chain", () => {
  withFixture([
    JSON.stringify(assistantText("orphan", "never-written", "the orphaned head")),
    JSON.stringify(assistantText("next", "orphan", "the orphan's child")),
  ], (load) => {
    assert.equal(load.status, "ok");
    assert.deepEqual(load.transcript.entries.map((entry) => entry.id), ["orphan", "next"]);
    assert.equal(load.transcript.warning, undefined);
  });
});

test("a truncated tail shows the file-order tail rather than collapsing to the last entry", () => {
  const fixture = sessionFixture();
  try {
    // Every tail entry hangs off a head entry the 2 MB bound chops away, so branch resolution
    // would keep exactly one row. File order keeps the tail a follower actually needs.
    const filler = "z".repeat(4000);
    const lines = [JSON.stringify(messageEntry("head", null, { role: "user", content: "the chopped head", timestamp: 0 }))];
    for (let index = 0; index < 800; index += 1) {
      lines.push(JSON.stringify(assistantText(`m${index}`, "head", `${filler} ${index}`)));
    }
    lines.push(JSON.stringify(assistantText("tail", "head", "the newest line")));
    writeFileSync(fixture.file, `${lines.join("\n")}\n`);
    assert.ok(statSync(fixture.file).size > VIEWER_MAX_FILE_BYTES);
    const load = readWithinBudget(fixture);
    assert.equal(load.status, "ok");
    assert.match(load.transcript.warning, /Large session file: showing only the last \d+ KB in file order/);
    assert.ok(load.transcript.entries.length > 1, "a truncated head must not collapse to one entry");
    assert.ok(load.transcript.entries.length <= VIEWER_MAX_ENTRIES);
    assert.equal(load.transcript.entries.at(-1).id, "tail");
    assert.match(renderViewerTranscript(load.transcript, 60, theme).join("\n"), /the newest line/);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("a full viewer session writes nothing inside the session directory", async () => {
  const fixture = sessionFixture();
  try {
    writeFileSync(fixture.file, `${JSON.stringify(assistantText("m1", null, "read only"))}\n`);
    const before = readdirSync(fixture.childDir).map((name) => {
      const stat = statSync(join(fixture.childDir, name));
      return `${name}:${stat.size}:${stat.mtimeMs}`;
    });
    const harness = createHarness({
      runs: [runSnapshot({ sessionFile: fixture.file })],
      childSessionDir: fixture.childDir,
      loadTranscript: undefined,
    });
    const viewer = createSubagentViewer({
      snapshot: () => ({ runs: [runSnapshot({ sessionFile: fixture.file })], childSessionDir: fixture.childDir }),
      setInterval: (callback, ms) => ({ callback, ms }),
      clearInterval: () => {},
    });
    const opened = viewer.handleShortcut(harness.ui, 1, { enabled: true });
    await flush();
    await flush();
    viewer.close();
    await opened;
    const after = readdirSync(fixture.childDir).map((name) => {
      const stat = statSync(join(fixture.childDir, name));
      return `${name}:${stat.size}:${stat.mtimeMs}`;
    });
    assert.deepEqual(after, before);
    assert.equal(readFileSync(fixture.file, "utf8"), `${JSON.stringify(assistantText("m1", null, "read only"))}\n`);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

/* ---------------------------------------------------------------------------------------------- */

test("the viewer sources use no writing or session-control API", () => {
  const forbidden = [
    "switchSession",
    "newSession",
    "navigateTree",
    "fork(",
    "reload(",
    "SessionManager.open",
    "appendEntry",
    "sendMessage",
    "sendUserMessage",
    "writeControl",
    "writeFileSync",
    "atomicWriteJson",
    "mkdirSync",
    "unlinkSync",
    "rmSync",
    "setEditorComponent",
    "setEditorText",
    "pasteToEditor",
    "setWidget",
    "setStatus",
    "setFooter",
    "tui.children",
  ];
  for (const file of ["subagent-viewer.ts", "subagent-viewer-data.ts"]) {
    const source = readFileSync(join(ROOT, "extensions/oh-my-pi-slim", file), "utf8");
    for (const term of forbidden) {
      assert.equal(source.includes(term), false, `${file} must not use ${term}`);
    }
  }
});

test("the main extension registers exactly the two viewer shortcuts and no viewer command", () => {
  const source = readFileSync(join(ROOT, "extensions/oh-my-pi-slim/index.ts"), "utf8");
  const shortcuts = [...source.matchAll(/registerShortcut\(/g)];
  assert.equal(shortcuts.length, 1);
  assert.match(source, /\[\["ctrl\+shift\+left", -1\], \["ctrl\+shift\+right", 1\]\]/);
  assert.doesNotMatch(source, /super\+(?:left|right)/);
  assert.equal(/registerCommand\("(?:viewer|subagent-viewer|agents?)"/.test(source), false);
  assert.match(source, /subagentViewer\.reset\(\)/);
  assert.match(source, /subagentViewer\.dispose\(\)/);
  assert.equal([...source.matchAll(/subagentViewer\.close\(\)/g)].length, 3);
});

test("no production source keeps a super arrow key or a Terminal ESC mapping", () => {
  const files = [
    "extensions/oh-my-pi-slim/index.ts",
    "extensions/oh-my-pi-slim/subagent-viewer.ts",
    "extensions/oh-my-pi-slim/subagent-viewer-data.ts",
    "README.md",
    "README.zh-CN.md",
  ];
  for (const file of files) {
    const source = readFileSync(join(ROOT, file), "utf8");
    assert.doesNotMatch(source, /super\+(?:left|right)/, `${file} must not name a super arrow shortcut`);
    assert.doesNotMatch(source, /Key\.super/, `${file} must not match a super key`);
    assert.doesNotMatch(source, /\[1;9[DC]/, `${file} must not carry the Command arrow ESC sequence`);
    assert.doesNotMatch(source, /Terminal\.app|Send Text|cat -v|\u2318/, `${file} must not document a Terminal key mapping`);
  }
});

test("the viewer overlay matches ctrl+shift arrows and no super arrow", () => {
  const source = readFileSync(join(ROOT, "extensions/oh-my-pi-slim/subagent-viewer.ts"), "utf8");
  assert.ok(source.includes('matchesKey(data, Key.ctrlShift("right")) || matchesKey(data, Key.right)'));
  assert.ok(source.includes('matchesKey(data, Key.ctrlShift("left")) || matchesKey(data, Key.left)'));
  assert.ok(source.includes('"←/→ or Ctrl+Shift+←/→ run"'));
});

test("every session lifecycle handler aborts Ask before it touches the viewer", () => {
  const source = readFileSync(join(ROOT, "extensions/oh-my-pi-slim/index.ts"), "utf8");
  const handlerOf = (event) => {
    const start = source.indexOf(`pi.on("${event}"`);
    assert.ok(start >= 0, `${event} handler must exist`);
    const end = source.indexOf('pi.on("', start + 8);
    return source.slice(start, end < 0 ? undefined : end);
  };
  for (const [event, viewerCall] of [
    ["session_before_switch", "subagentViewer.close()"],
    ["session_before_fork", "subagentViewer.close()"],
    ["session_before_tree", "subagentViewer.close()"],
    ["session_shutdown", "subagentViewer.dispose()"],
  ]) {
    const handler = handlerOf(event);
    const abort = handler.indexOf("asks.abortAll(");
    const viewer = handler.indexOf(viewerCall);
    assert.ok(abort >= 0 && viewer >= 0, `${event} must abort Ask and close the viewer`);
    assert.ok(abort < viewer, `${event} must abort Ask before ${viewerCall}`);
  }
  const start = handlerOf("session_start");
  assert.ok(start.indexOf("asks.reset()") < start.indexOf("subagentViewer.reset()"));
  // Ask coordinates with the viewer through one public hook, not a patched method.
  assert.match(source, /new AskTuiDriver\(ctx\.ui, \{ beforeOpen: \(\) => subagentViewer\.closeAsync\(\) \}\)/);
});

test("a terminal too short for the full chrome clamps instead of overflowing", async () => {
  const harness = createHarness({ rows: 24 });
  const { opened } = await openViewer(harness);
  await flush();
  for (const rows of [5, 4, 3, 2, 1]) {
    harness.setRows(rows);
    const short = harness.lines(80);
    assert.equal(short.length, rows, `rows ${rows} must never overflow the viewport`);
    for (const line of short) assert.equal(visibleWidth(line), 80);
  }
  // Five rows is the smallest layout that still keeps the Read-Only row and the footer.
  harness.setRows(5);
  const five = harness.lines(80);
  assert.ok(five.some((line) => line.includes(VIEWER_READ_ONLY_LABEL)));
  assert.ok(five.at(-1).includes("updated"));
  harness.viewer.close();
  await opened;
});
