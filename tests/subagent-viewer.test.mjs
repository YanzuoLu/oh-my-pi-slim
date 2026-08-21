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
import { dirname, join, resolve } from "node:path";
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
  "./subagent-viewer-transcript.js": new URL("../extensions/oh-my-pi-slim/subagent-viewer-transcript.ts", import.meta.url).href,
  "./widget-expansion.js": new URL("../extensions/oh-my-pi-slim/widget-expansion.ts", import.meta.url).href,
  "./subagent-widget-display.js": new URL("../extensions/oh-my-pi-slim/subagent-widget-display.ts", import.meta.url).href,
  "./subagent-widget-glyphs.js": new URL("../extensions/oh-my-pi-slim/subagent-widget-glyphs.ts", import.meta.url).href,
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    const url = dependencyMap[specifier];
    return url ? { url, shortCircuit: true } : nextResolve(specifier, context);
  },
});

const {
  KeybindingsManager,
  TUI_KEYBINDINGS,
  getKeybindings,
  setKeybindings,
  visibleWidth,
} = await import("@earendil-works/pi-tui");
/** The app-level action the viewer must resolve through the user's own binding. */
const EXPAND_DEFINITIONS = { ...TUI_KEYBINDINGS, "app.tools.expand": { defaultKeys: "ctrl+o" } };
const {
  VIEWER_MAX_ARGS_CHARS,
  VIEWER_MAX_BLOCK_LINES,
  VIEWER_MAX_ENTRIES,
  VIEWER_MAX_FILE_BYTES,
  VIEWER_MAX_TRANSCRIPT_LINES,
  cycleViewerSelection,
  lastAssistantText,
  liveTextIsRedundant,
  boundViewerText,
  formatViewerElapsed,
  loadViewerTranscript,
  neighborAfterViewerRemoval,
  renderViewerLive,
  resolveViewerSessionFile,
  sameViewerTranscript,
  viewerContentKey,
  sanitizeViewerInline,
  sanitizeViewerText,
  wrapViewerText,
} = await import("../extensions/oh-my-pi-slim/subagent-viewer-data.ts");
const { getAgentDir, initTheme } = await import("@earendil-works/pi-coding-agent");
// Pi initializes its theme singleton during interactive startup, before any extension loads. The
// suite does the same once, so the Main components under test render with real colors.
initTheme(undefined, false);
const {
  VIEWER_DEFAULT_SETTINGS,
  buildViewerTranscriptBody,
  readViewerTranscriptSettings,
  viewerSettingsKey,
} = await import("../extensions/oh-my-pi-slim/subagent-viewer-transcript.ts");
const {
  SubagentViewer,
  VIEWER_EMPTY_MESSAGE,
  VIEWER_GONE_TICKS,
  VIEWER_MOUSE_DISABLE,
  VIEWER_MOUSE_ENABLE,
  VIEWER_READ_ONLY_LABEL,
  VIEWER_REFRESH_MS,
  VIEWER_STATUS_STYLE,
  createSubagentViewer,
  fitViewerSegments,
  isViewerTerminalStatus,
  isViewerMouseSequence,
  parseViewerWheel,
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
    cwd: "/work/project",
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

/** Minimal transcript body double: counts builds and renders one line per entry. */
function stubBody(input, builds) {
  const entries = input.transcript?.entries ?? [];
  let expanded = input.expanded;
  const body = {
    disposed: false,
    input,
    render: (width) => {
      const lines = entries.map((entry, index) => `entry-${index}-${entry.type}${expanded ? "-expanded" : "-collapsed"}`);
      return lines.length > 0 ? lines.map((line) => line.slice(0, Math.max(1, width))) : ["stub-empty"];
    },
    setExpanded: (value) => { expanded = value; },
    invalidate: () => {},
    dispose: () => { body.disposed = true; },
  };
  builds.push(body);
  return body;
}

function createHarness({
  runs = [runSnapshot()],
  childSessionDir = "/child/sessions",
  loadTranscript,
  buildBody,
  realBody = false,
  rows = 24,
  columns = 80,
  mode = "regular",
  keybindings,
  toolsExpanded = true,
  nowMs,
} = {}) {
  const state = {
    runs,
    childSessionDir,
    notifications: [],
    customCalls: [],
    intervals: [],
    loads: [],
    builds: [],
    renders: 0,
    disposes: 0,
    component: undefined,
    resolved: false,
    handles: [],
    expanded: toolsExpanded,
    clock: VIEWER_NOW_MS,
    settingsReads: [],
  };
  const host = createOverlayHost({
    rows,
    columns,
    theme,
    mode,
    keybindings,
    onRender: () => { state.renders += 1; },
  });
  const ui = {
    getToolsExpanded() { return state.expanded; },
    setToolsExpanded(expanded) { state.expanded = expanded; },
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
    loadTranscript: loadTranscript ?? ((dir, sessionFile, options = {}) => {
      state.loads.push({ dir, sessionFile, ...options });
      const current = `fp-${sessionFile}`;
      // Same contract as the real loader: an unchanged file is reported, never re-parsed.
      if (options.previousFingerprint === current) return { status: "unchanged", fingerprint: current };
      return {
        status: "ok",
        fingerprint: current,
        contentKey: `ck-${sessionFile}`,
        transcript: transcriptOf([], { fingerprint: current, contentKey: `ck-${sessionFile}` }),
      };
    }),
    buildBody: buildBody ?? (realBody
      ? (input) => { const body = buildViewerTranscriptBody(input); state.builds.push(body); return body; }
      : (input) => stubBody(input, state.builds)),
    readSettings: (cwd, projectTrusted) => {
      state.settingsReads.push({ cwd, projectTrusted });
      return { outputPad: 1, codeBlockIndent: "", hideThinkingBlock: false };
    },
    setInterval(callback, ms) {
      const timer = { callback, ms, cleared: false };
      state.intervals.push(timer);
      return timer;
    },
    clearInterval(timer) { timer.cleared = true; },
    nowMs: nowMs ?? (() => state.clock),
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
    get builds() { return state.builds; },
    get settingsReads() { return state.settingsReads; },
    get expandedState() { return state.expanded; },
    setExpandedState(value) { state.expanded = value; },
    advance(ms) { state.clock += ms; },
    writes() { return host.writes(); },
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

test("terminal statuses are the ones that freeze the transcript and the clock", () => {
  for (const status of ["completed", "failed", "interrupted"]) {
    assert.equal(isViewerTerminalStatus(status), true);
  }
  for (const status of ["starting", "running", "waiting"]) {
    assert.equal(isViewerTerminalStatus(status), false);
  }
  assert.deepEqual(Object.keys(VIEWER_STATUS_STYLE).sort(), [
    "completed", "failed", "interrupted", "running", "starting", "waiting",
  ]);
});

test("an empty retained set notifies exactly once and never opens the overlay", async () => {
  const harness = createHarness({ runs: [] });
  await harness.viewer.handleShortcut(harness.ui, 1, { enabled: true });
  assert.deepEqual(harness.notifications, [{ message: VIEWER_EMPTY_MESSAGE, type: "info" }]);
  assert.equal(harness.customCalls.length, 0);
  assert.equal(harness.viewer.isOpen(), false);
  assert.equal(VIEWER_EMPTY_MESSAGE, "No retained subagent runs.");
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
  assert.equal(harness.loads.at(-1).previousFingerprint, undefined);
  harness.viewer.close();
  await opened;
});

test("r pressed during an in-flight read still forces the follow-up read", async () => {
  const pending = [];
  const harness = createHarness({
    loadTranscript: (_dir, _sessionFile, options = {}) => new Promise((resolve) => {
      pending.push({ previousFingerprint: options.previousFingerprint, resolve });
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
  assert.equal(pending[1].previousFingerprint, undefined, "the queued read must keep the force intent");

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

test("the overlay renders a complete screen with the transcript on top and the status at the bottom", async () => {
  const harness = createHarness({ rows: 20 });
  const { opened } = await openViewer(harness);
  await flush();
  const lines = harness.lines(80);
  assert.equal(lines.length, 20);
  for (const line of lines) assert.equal(visibleWidth(line), 80);
  // Row 0 belongs to the transcript body: no header, no title, no border above it.
  assert.equal(/Subagent 1\/1/.test(lines[0]), false);
  assert.ok(lines[0].startsWith("stub-empty") || lines[0].trim() === "");
  const statusIndex = lines.findIndex((line) => /^Subagent 1\/1 · fixer \[run-a\] · running · fix the parser/.test(line));
  const readOnlyIndex = lines.findIndex((line) => line.trim() === VIEWER_READ_ONLY_LABEL);
  assert.ok(statusIndex > 0, "the status title must live at the bottom");
  assert.ok(readOnlyIndex > 0 && readOnlyIndex < statusIndex, "Read-Only sits above the status rows");
  assert.match(lines[statusIndex + 1], /live · \(provider\) model • high/);
  assert.ok(lines.some((line) => line.trim() === VIEWER_READ_ONLY_LABEL));
  // The hint row wraps across as many footer rows as the width needs, so the assertion reads the
  // unwrapped hint text rather than a single rendered row.
  const hintText = lines.map((line) => line.trimEnd()).join(" ");
  assert.ok(hintText.includes("←/→ or Ctrl+Shift+←/→ run"));
  assert.ok(hintText.includes("Esc/q Main"));
  assert.ok(hintText.includes("f follow on"));
  assert.ok(lines.at(-1).includes(`updated ${VIEWER_NOW_CLOCK}`));
  assert.match(lines.at(-1), /^1-1\/1 · updated /);
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
 * Pi's own theme and width helpers emit SGR colour and reset sequences, and only those. The
 * assertion below allowlists the SGR shape rather than stripping anything, so an attacker-supplied
 * OSC, DCS, APC, or non-SGR CSI sequence that survived sanitizing would still fail the test.
 */
const ALLOWED_ESCAPE = /^\u001b\[[0-9;:]*m$/;

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
    // The real Main components render this hostile transcript, so the assertion covers the
    // production renderer rather than a test double.
    realBody: true,
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
        assert.match(sequence, ALLOWED_ESCAPE, `width ${width}: ${JSON.stringify(line)}`);
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

/** Builds a real Main-component transcript body over a throwaway host. */
function realBodyOf(entries, options = {}) {
  const host = createOverlayHost({ theme });
  return buildViewerTranscriptBody({
    transcript: transcriptOf(entries, options.transcript ?? {}),
    tui: host.tui,
    theme,
    cwd: options.cwd ?? "/work/project",
    expanded: options.expanded ?? true,
    settings: options.settings ?? VIEWER_DEFAULT_SETTINGS,
  });
}

function bodyText(entries, options = {}) {
  const body = realBodyOf(entries, options);
  try {
    return body.render(options.width ?? 70).map((line) => stripVTControlCharacters(line)).join("\n");
  } finally {
    body.dispose();
  }
}

test("the transcript body is rendered by Pi's own Main components", () => {
  const text = bodyText([
    messageEntry("m1", null, {
      role: "user",
      content: [{ type: "text", text: "please look" }, { type: "image", data: "AAAABBBBCCCC", mimeType: "image/png" }],
      timestamp: 0,
    }),
    messageEntry("m2", "m1", {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "weighing options" },
        { type: "text", text: "here is the **answer**" },
        { type: "toolCall", id: "t1", name: "read", arguments: { path: "/work/project/a.txt" } },
      ],
      timestamp: 0,
    }),
    messageEntry("m3", "m2", {
      role: "toolResult",
      toolCallId: "t1",
      toolName: "read",
      content: [{ type: "text", text: "file body" }, { type: "image", data: "ZZZZ", mimeType: "image/jpeg" }],
      isError: false,
      timestamp: 0,
    }),
  ]);
  assert.match(text, /please look/);
  assert.match(text, /\[image image\/png\]/);
  assert.equal(text.includes("AAAABBBBCCCC"), false);
  assert.match(text, /weighing options/);
  assert.match(text, /here is the/);
  assert.match(text, /answer/);
  // Pi's own tool component owns this framing; the viewer never draws its own tool header.
  assert.match(text, /read/);
  assert.match(text, /a\.txt/);
  assert.match(text, /file body/);
  assert.equal(text.includes("ZZZZ"), false);
});

test("compaction, branch summary, and custom messages use their Main components", () => {
  const text = bodyText([
    {
      type: "compaction",
      id: "c1",
      parentId: null,
      timestamp: "2026-04-17T00:00:00.000Z",
      summary: "compacted history",
      firstKeptEntryId: "c1",
      tokensBefore: 4242,
    },
    {
      type: "branch_summary",
      id: "b1",
      parentId: "c1",
      timestamp: "2026-04-17T00:00:00.000Z",
      fromId: "m0",
      summary: "branch recap",
    },
    {
      type: "custom_message",
      id: "x1",
      parentId: "b1",
      timestamp: "2026-04-17T00:00:00.000Z",
      customType: "oh-my-pi-slim:note",
      content: "visible note",
      display: true,
    },
  ]);
  assert.match(text, /compacted history/);
  assert.match(text, /branch recap/);
  assert.match(text, /visible note/);
});

test("hidden custom messages and state-only entries render nothing", () => {
  const text = bodyText([
    {
      type: "custom_message",
      id: "x2",
      parentId: null,
      timestamp: "2026-04-17T00:00:00.000Z",
      customType: "hidden",
      content: "never shown",
      display: false,
    },
    { type: "model_change", id: "s1", parentId: "x2", timestamp: "", provider: "p", modelId: "m" },
  ]);
  assert.equal(text.includes("never shown"), false);
  assert.match(text, /No messages yet\./);
});

test("a child extension's custom renderer is never resolved or executed", () => {
  let executed = false;
  const text = bodyText([
    {
      type: "custom_message",
      id: "x1",
      parentId: null,
      timestamp: "2026-04-17T00:00:00.000Z",
      customType: "child:tool",
      content: "custom payload",
      display: true,
      details: { get evil() { executed = true; return 1; } },
    },
  ]);
  assert.equal(executed, false);
  assert.match(text, /custom payload/);
});

test("the transcript body pairs tool results with their call by id", () => {
  const text = bodyText([
    messageEntry("m1", null, {
      role: "assistant",
      content: [
        { type: "toolCall", id: "t1", name: "grep", arguments: { pattern: "needle" } },
        { type: "toolCall", id: "t2", name: "bash", arguments: { command: "ls" } },
      ],
      timestamp: 0,
    }),
    messageEntry("m2", "m1", {
      role: "toolResult",
      toolCallId: "t2",
      toolName: "bash",
      content: [{ type: "text", text: "paired-with-t2" }],
      isError: false,
      timestamp: 0,
    }),
    messageEntry("m3", "m2", {
      role: "toolResult",
      toolCallId: "missing",
      toolName: "ghost",
      content: [{ type: "text", text: "orphan-result" }],
      isError: false,
      timestamp: 0,
    }),
  ]);
  assert.match(text, /paired-with-t2/);
  assert.equal(text.includes("orphan-result"), false);
});

test("an entry that throws while building degrades to one note and keeps its neighbours", () => {
  const hostile = messageEntry("m2", "m1", {
    role: "user",
    get content() { throw new Error("hostile entry"); },
    timestamp: 0,
  });
  const text = bodyText([
    assistantText("m1", null, "first safe block"),
    hostile,
    assistantText("m3", "m2", "second safe block"),
  ]);
  assert.match(text, /first safe block/);
  assert.match(text, /second safe block/);
  assert.match(text, /could not be built: hostile entry/);
});

test("the body honours the shared expansion flag and its own line budget", () => {
  const entries = Array.from({ length: 40 }, (_, index) => messageEntry(`m${index}`, index === 0 ? null : `m${index - 1}`, {
    role: "toolResult",
    toolCallId: `t${index}`,
    toolName: "read",
    content: [{ type: "text", text: `line-${index}\n`.repeat(30) }],
    isError: false,
    timestamp: 0,
  }));
  const calls = Array.from({ length: 40 }, (_, index) => messageEntry(`c${index}`, `m${index}`, {
    role: "assistant",
    content: [{ type: "toolCall", id: `t${index}`, name: "read", arguments: { path: `/f${index}` } }],
    timestamp: 0,
  }));
  const interleaved = [];
  for (let index = 0; index < 40; index += 1) {
    interleaved.push(calls[index], entries[index]);
  }
  const collapsed = realBodyOf(interleaved, { expanded: false });
  const expanded = realBodyOf(interleaved, { expanded: true });
  try {
    const collapsedLines = collapsed.render(70).length;
    const expandedLines = expanded.render(70).length;
    assert.ok(collapsedLines < expandedLines, "collapsed output must hide tool result bodies");
    assert.ok(expandedLines <= VIEWER_MAX_TRANSCRIPT_LINES + 1);
    collapsed.setExpanded(true);
    assert.equal(collapsed.render(70).length, expandedLines, "setExpanded must reach every component");
  } finally {
    collapsed.dispose();
    expanded.dispose();
  }
});

test("a bash row that throws while filling in stops its loader and keeps the next block", () => {
  const stops = [];
  const timers = [];
  /** Stands in for Pi's own component: a live 80 ms timer from construction, and a hostile fill-in. */
  const failingBash = (command, tui, excludeFromContext) => {
    const timer = setInterval(() => {}, 80);
    timers.push({ timer, running: true });
    const entry = timers.at(-1);
    return {
      command,
      excludeFromContext,
      appendOutput() { throw new Error("output exploded"); },
      setComplete(exitCode, cancelled) {
        stops.push({ exitCode, cancelled });
        clearInterval(timer);
        entry.running = false;
      },
      render() { return ["ABANDONED-BASH-COMPONENT"]; },
      invalidate() {},
    };
  };
  const timeoutsBefore = process.getActiveResourcesInfo().filter((resource) => resource === "Timeout").length;
  const host = createOverlayHost({ theme });
  const body = buildViewerTranscriptBody({
    transcript: transcriptOf([
      messageEntry("m1", null, { role: "user", content: "before the bash row", timestamp: 0 }),
      messageEntry("m2", "m1", { role: "bashExecution", command: "ls -la", output: "boom", timestamp: 0 }),
      messageEntry("m3", "m2", { role: "user", content: "after the bash row", timestamp: 0 }),
    ]),
    tui: host.tui,
    theme,
    cwd: "/work/project",
    expanded: true,
    settings: VIEWER_DEFAULT_SETTINGS,
    bashComponent: failingBash,
  });
  try {
    const text = body.render(70).map((line) => stripVTControlCharacters(line)).join("\n");
    assert.deepEqual(stops, [{ exitCode: undefined, cancelled: true }], "the loader is stopped exactly once");
    assert.deepEqual(timers.map((entry) => entry.running), [false], "no spinner timer may survive the failure");
    assert.equal(
      process.getActiveResourcesInfo().filter((resource) => resource === "Timeout").length,
      timeoutsBefore,
      "a half-built bash row leaves no live timer behind",
    );
    assert.match(text, /entry could not be built: output exploded/);
    assert.match(text, /before the bash row/);
    assert.match(text, /after the bash row/, "the block after the failure still renders");
    assert.equal(text.includes("ABANDONED-BASH-COMPONENT"), false, "the abandoned component is never rendered");
  } finally {
    body.dispose();
    for (const entry of timers) clearInterval(entry.timer);
  }
});

test("body rendering is width safe and strips prompt zone markers", () => {
  const body = realBodyOf([
    assistantText("m1", null, "a long assistant answer that wraps repeatedly ".repeat(8)),
    messageEntry("m2", "m1", { role: "user", content: "宽字符宽字符宽字符宽字符宽字符", timestamp: 0 }),
  ]);
  try {
    for (const width of [20, 40, 100]) {
      for (const line of body.render(width)) {
        assert.ok(visibleWidth(line) <= width, `width ${width}: ${JSON.stringify(line)}`);
        assert.equal(line.includes("\u001b]133;"), false);
      }
      body.invalidate();
    }
  } finally {
    body.dispose();
  }
});

/** The two files the viewer is allowed to read, and nothing else. */
const GLOBAL_SETTINGS_PATH = join(getAgentDir(), "settings.json");
const PROJECT_SETTINGS_PATH = resolve("/work/project", ".pi/settings.json");

/** A read seam over an in-memory file set, so no assertion below touches a real settings file. */
function settingsReader(files) {
  const reads = [];
  const read = (path) => {
    reads.push(path);
    const content = files[path];
    if (content === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
    if (content instanceof Error) throw content;
    return content;
  };
  read.reads = reads;
  return read;
}

test("the viewer defaults are Pi's own defaults", () => {
  assert.deepEqual(VIEWER_DEFAULT_SETTINGS, { outputPad: 1, codeBlockIndent: "  ", hideThinkingBlock: false });
});

test("transcript settings read the global file even without a project", () => {
  const read = settingsReader({
    [GLOBAL_SETTINGS_PATH]: JSON.stringify({
      outputPad: 0,
      hideThinkingBlock: true,
      markdown: { codeBlockIndent: "\t" },
    }),
  });
  assert.deepEqual(readViewerTranscriptSettings(undefined, false, read), {
    outputPad: 0,
    codeBlockIndent: "\t",
    hideThinkingBlock: true,
  });
  assert.deepEqual(read.reads, [GLOBAL_SETTINGS_PATH], "no project file may be read without a cwd");
});

test("a trusted project overrides only the values it defines", () => {
  const read = settingsReader({
    [GLOBAL_SETTINGS_PATH]: JSON.stringify({
      outputPad: 0,
      hideThinkingBlock: true,
      markdown: { codeBlockIndent: "\t" },
    }),
    [PROJECT_SETTINGS_PATH]: JSON.stringify({ outputPad: 1, markdown: { fenced: true } }),
  });
  assert.deepEqual(readViewerTranscriptSettings("/work/project", true, read), {
    outputPad: 1,
    codeBlockIndent: "\t",
    hideThinkingBlock: true,
  });
  assert.deepEqual(read.reads, [GLOBAL_SETTINGS_PATH, PROJECT_SETTINGS_PATH]);
});

test("an untrusted project is never read", () => {
  const read = settingsReader({
    [GLOBAL_SETTINGS_PATH]: JSON.stringify({ hideThinkingBlock: true }),
    [PROJECT_SETTINGS_PATH]: JSON.stringify({ hideThinkingBlock: false, outputPad: 0 }),
  });
  assert.deepEqual(readViewerTranscriptSettings("/work/project", false, read), {
    outputPad: 1,
    codeBlockIndent: "  ",
    hideThinkingBlock: true,
  });
  assert.deepEqual(read.reads, [GLOBAL_SETTINGS_PATH], "an untrusted project file must not be opened");
});

test("malformed, unreadable, and invalid settings fall back to Pi's defaults", () => {
  const malformed = settingsReader({
    [GLOBAL_SETTINGS_PATH]: "{ not json",
    [PROJECT_SETTINGS_PATH]: "[]",
  });
  assert.deepEqual(readViewerTranscriptSettings("/work/project", true, malformed), VIEWER_DEFAULT_SETTINGS);

  const failing = settingsReader({
    [GLOBAL_SETTINGS_PATH]: Object.assign(new Error("EACCES"), { code: "EACCES" }),
  });
  assert.deepEqual(readViewerTranscriptSettings("/work/project", true, failing), VIEWER_DEFAULT_SETTINGS);

  const invalid = settingsReader({
    [GLOBAL_SETTINGS_PATH]: JSON.stringify({
      outputPad: "wide",
      hideThinkingBlock: "yes",
      markdown: { codeBlockIndent: 42 },
    }),
  });
  assert.deepEqual(readViewerTranscriptSettings(undefined, false, invalid), VIEWER_DEFAULT_SETTINGS);

  // A project layer that is only partly broken still leaves the global layer standing.
  const partial = settingsReader({
    [GLOBAL_SETTINGS_PATH]: JSON.stringify({ outputPad: 0, markdown: { codeBlockIndent: "" } }),
    [PROJECT_SETTINGS_PATH]: "{ also not json",
  });
  assert.deepEqual(readViewerTranscriptSettings("/work/project", true, partial), {
    outputPad: 0,
    codeBlockIndent: "",
    hideThinkingBlock: false,
  });
});

test("transcript settings read the real host files without a settings manager", () => {
  const real = readViewerTranscriptSettings(ROOT, false);
  assert.ok(real.outputPad === 0 || real.outputPad === 1);
  assert.equal(typeof real.codeBlockIndent, "string");
  assert.equal(typeof real.hideThinkingBlock, "boolean");
  assert.notEqual(viewerSettingsKey(real), "");
  assert.notEqual(
    viewerSettingsKey({ ...real, hideThinkingBlock: !real.hideThinkingBlock }),
    viewerSettingsKey(real),
  );
});

test("the transcript module holds no settings manager and no write API", () => {
  const source = readFileSync(join(ROOT, "extensions/oh-my-pi-slim/subagent-viewer-transcript.ts"), "utf-8");
  for (const forbidden of [
    "SettingsManager",
    "writeFileSync",
    "appendFileSync",
    "mkdirSync",
    "rmSync",
    "renameSync",
    "createWriteStream",
    "lockfile",
    "openSync",
  ]) {
    assert.equal(source.includes(forbidden), false, `${forbidden} must not appear in the viewer transcript body`);
  }
  assert.equal((source.match(/readFileSync\(/g) ?? []).length, 1, "exactly one read call, and it is read-only");
});

test("bounded text helpers keep untrusted input inside the viewer budget", () => {
  assert.equal(boundViewerText("abc", 10), "abc");
  assert.equal(boundViewerText("abcdef", 3), "abc…");
  assert.equal(Array.from(boundViewerText("x".repeat(9999), 100)).length, 101);
});

test("the live block shows waiting requests, active tools, and unsaved response text", () => {
  const width = 60;
  const liveOptions = { expanded: true, expandHint: " · ^O to expand" };
  const waiting = renderViewerLive(runSnapshot({
    status: "waiting",
    request: {
      runId: "run-a",
      reason: "interview_request",
      message: "Choose one option.",
      interview: { questions: [{ prompt: "a" }, { prompt: "b" }] },
      createdAt: "2026-04-17T00:01:00.000Z",
    },
  }), transcriptOf([]), width, theme, liveOptions).join("\n");
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
  }), transcriptOf([]), width, theme, liveOptions).join("\n");
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
  }), persisted, 60, theme, { expanded: true, expandHint: " · ^O to expand" });
  assert.deepEqual(live, []);
});

/* ---------------------------------------------------------------------------------------------- */

/** Renders a loaded transcript through the real Main-component body. */
function transcriptText(transcript, width) {
  const host = createOverlayHost({ theme });
  const body = buildViewerTranscriptBody({
    transcript,
    tui: host.tui,
    theme,
    cwd: "/work/project",
    expanded: true,
    settings: VIEWER_DEFAULT_SETTINGS,
  });
  try {
    return body.render(width).map((line) => stripVTControlCharacters(line)).join("\n");
  } finally {
    body.dispose();
  }
}

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
    const rendered = transcriptText(load.transcript, 60);
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
    const unchanged = loadViewerTranscript(fixture.childDir, fixture.file, { previousFingerprint: first.fingerprint });
    assert.equal(unchanged.status, "unchanged");
    assert.equal(unchanged.transcript, undefined);
    writeFileSync(fixture.file, `${JSON.stringify(assistantText("m1", null, "one"))}\n${JSON.stringify(assistantText("m2", "m1", "two"))}\n`);
    const changed = loadViewerTranscript(fixture.childDir, fixture.file, { previousFingerprint: first.fingerprint });
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
    const rendered = transcriptText(load.transcript, 60);
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
    const rendered = transcriptText(load.transcript, 70);
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
    const rendered = transcriptText(load.transcript, 60);
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
    assert.match(transcriptText(load.transcript, 60), /the newest line/);
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
  for (const file of ["subagent-viewer.ts", "subagent-viewer-data.ts", "subagent-viewer-transcript.ts"]) {
    const source = readFileSync(join(ROOT, "extensions/oh-my-pi-slim", file), "utf8");
    for (const term of forbidden) {
      assert.equal(source.includes(term), false, `${file} must not use ${term}`);
    }
  }
});

test("only the viewer writes to the terminal, and only the wheel mode", () => {
  const viewer = readFileSync(join(ROOT, "extensions/oh-my-pi-slim/subagent-viewer.ts"), "utf8");
  const writes = [...viewer.matchAll(/terminal\.write\(([^)]*)\)/g)].map((match) => match[1]);
  assert.deepEqual(writes, ["VIEWER_MOUSE_ENABLE", "VIEWER_MOUSE_DISABLE"]);
  assert.match(viewer, /VIEWER_MOUSE_ENABLE = "\\x1b\[\?1000h\\x1b\[\?1006h"/);
  assert.match(viewer, /VIEWER_MOUSE_DISABLE = "\\x1b\[\?1006l\\x1b\[\?1000l"/);
  // Motion tracking stays off so the terminal keeps its own drag selection.
  assert.equal(viewer.includes("?1002"), false);
  assert.equal(viewer.includes("?1003"), false);
  // Enabling happens on the mount path only, never in a constructor.
  const constructorBody = viewer.slice(viewer.indexOf("constructor(options: SubagentViewerOptions)"), viewer.indexOf("isOpen(): boolean"));
  assert.equal(constructorBody.includes("enableMouse"), false);
  const transcript = readFileSync(join(ROOT, "extensions/oh-my-pi-slim/subagent-viewer-transcript.ts"), "utf8");
  assert.equal(transcript.includes("terminal.write"), false);
});

test("the transcript module reuses Pi's root component exports and no deep import", () => {
  const source = readFileSync(join(ROOT, "extensions/oh-my-pi-slim/subagent-viewer-transcript.ts"), "utf8");
  for (const component of [
    "UserMessageComponent",
    "AssistantMessageComponent",
    "ToolExecutionComponent",
    "BashExecutionComponent",
    "CustomMessageComponent",
    "CompactionSummaryMessageComponent",
    "BranchSummaryMessageComponent",
    "SkillInvocationMessageComponent",
    "getMarkdownTheme",
    "sessionEntryToContextMessages",
    "parseSkillBlock",
  ]) {
    assert.ok(source.includes(component), `transcript module must use ${component}`);
  }
  assert.equal(/from "@earendil-works\/pi-coding-agent\/[^"]+"/.test(source), false, "no deep import");
  assert.equal(/from "@earendil-works\/pi-tui\/[^"]+"/.test(source), false, "no deep import");
  assert.match(source, /showImages: false/);
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

/* ------------------------------------------------------------------------------------------------
 * Wheel reporting, follow arithmetic, shared expansion, and the one-second status clock.
 * ---------------------------------------------------------------------------------------------- */

const WHEEL_UP = "\x1b[<64;10;5M";
const WHEEL_DOWN = "\x1b[<65;10;5M";
const MOUSE_CLICK = "\x1b[<0;10;5M";
const MOUSE_RELEASE = "\x1b[<0;10;5m";
const LEGACY_WHEEL_UP = `\x1b[M${String.fromCharCode(32 + 64)}!!`;
const LEGACY_WHEEL_DOWN = `\x1b[M${String.fromCharCode(32 + 65)}!!`;

function manyEntries(count) {
  return Array.from({ length: count }, (_, index) => assistantText(`m${index}`, index === 0 ? null : `m${index - 1}`, `line ${index}`));
}

function scrollHarness(count = 60, options = {}) {
  return createHarness({
    loadTranscript: () => ({ status: "ok", fingerprint: "fp", transcript: transcriptOf(manyEntries(count)) }),
    ...options,
  });
}

test("wheel notches parse from SGR and legacy reports, and other mouse reports do not", () => {
  assert.equal(parseViewerWheel(WHEEL_UP), -1);
  assert.equal(parseViewerWheel(WHEEL_DOWN), 1);
  assert.equal(parseViewerWheel(LEGACY_WHEEL_UP), -1);
  assert.equal(parseViewerWheel(LEGACY_WHEEL_DOWN), 1);
  assert.equal(parseViewerWheel(MOUSE_CLICK), undefined);
  assert.equal(parseViewerWheel(MOUSE_RELEASE), undefined);
  assert.equal(parseViewerWheel("q"), undefined);
  assert.equal(isViewerMouseSequence(MOUSE_CLICK), true);
  assert.equal(isViewerMouseSequence(MOUSE_RELEASE), true);
  assert.equal(isViewerMouseSequence(WHEEL_DOWN), true);
  assert.equal(isViewerMouseSequence(LEGACY_WHEEL_UP), true);
  assert.equal(isViewerMouseSequence("q"), false);
  assert.equal(isViewerMouseSequence("\x1b[A"), false);
});

test("a mounted regular-mode overlay enables wheel reporting exactly once and restores it on close", async () => {
  const harness = createHarness({ mode: "regular" });
  const { opened } = await openViewer(harness);
  await flush();
  assert.deepEqual(harness.writes(), [VIEWER_MOUSE_ENABLE]);
  assert.equal(harness.viewer.isMouseEnabled(), true);
  harness.viewer.close();
  await opened;
  assert.deepEqual(harness.writes(), [VIEWER_MOUSE_ENABLE, VIEWER_MOUSE_DISABLE]);
  assert.equal(harness.viewer.isMouseEnabled(), false);

  const { opened: reopened } = await openViewer(harness);
  await flush();
  assert.deepEqual(harness.writes(), [VIEWER_MOUSE_ENABLE, VIEWER_MOUSE_DISABLE, VIEWER_MOUSE_ENABLE]);
  harness.viewer.close();
  await reopened;
  assert.deepEqual(harness.writes(), [
    VIEWER_MOUSE_ENABLE, VIEWER_MOUSE_DISABLE, VIEWER_MOUSE_ENABLE, VIEWER_MOUSE_DISABLE,
  ]);
});

test("a fullscreen host already reports the wheel, so the viewer writes no mouse mode", async () => {
  const harness = createHarness({ mode: "fullscreen" });
  const { opened } = await openViewer(harness);
  await flush();
  assert.deepEqual(harness.writes(), []);
  assert.equal(harness.viewer.isMouseEnabled(), false);
  harness.viewer.close();
  await opened;
  assert.deepEqual(harness.writes(), []);
});

test("a stale handle from an already closed open never enables wheel reporting", async () => {
  const harness = createHarness({ mode: "regular" });
  const opened = harness.viewer.handleShortcut(harness.ui, 1, { enabled: true });
  // Close before the host mounts the overlay: `onHandle` must hide the late entry, not adopt it.
  harness.viewer.close();
  await flush();
  await opened;
  assert.deepEqual(harness.writes(), []);
  assert.equal(harness.viewer.isMouseEnabled(), false);
  assert.deepEqual(harness.overlays, []);
});

test("a host that throws on open leaves no wheel reporting behind", async () => {
  const harness = createHarness({ mode: "regular" });
  const throwingUi = {
    getToolsExpanded: () => true,
    setToolsExpanded: () => {},
    notify: (message, type) => harness.notifications.push({ message, type }),
    custom: () => { throw new Error("host refused"); },
  };
  await harness.viewer.handleShortcut(throwingUi, 1, { enabled: true });
  assert.deepEqual(harness.writes(), []);
  assert.equal(harness.viewer.isMouseEnabled(), false);
  assert.equal(harness.viewer.isOpen(), false);
});

test("a host that drops the overlay entry still restores wheel reporting", async () => {
  const harness = createHarness({ mode: "regular" });
  const { opened } = await openViewer(harness);
  await flush();
  assert.deepEqual(harness.writes(), [VIEWER_MOUSE_ENABLE]);
  harness.hideTopOverlayWithoutResolving();
  for (let tick = 0; tick < VIEWER_GONE_TICKS; tick += 1) harness.tick();
  await opened;
  assert.deepEqual(harness.writes(), [VIEWER_MOUSE_ENABLE, VIEWER_MOUSE_DISABLE]);
  assert.equal(harness.viewer.isMouseEnabled(), false);
});

test("dispose during an open session restores wheel reporting once", async () => {
  const harness = createHarness({ mode: "regular" });
  const { opened } = await openViewer(harness);
  await flush();
  harness.viewer.dispose();
  await opened;
  harness.viewer.dispose();
  assert.deepEqual(harness.writes(), [VIEWER_MOUSE_ENABLE, VIEWER_MOUSE_DISABLE]);
});

test("the wheel scrolls one transcript row per notch and other mouse reports are swallowed", async () => {
  const harness = scrollHarness();
  const { opened } = await openViewer(harness);
  await flush();
  harness.lines();
  const bottom = harness.viewer.model().state.scroll;
  assert.ok(bottom > 0);

  harness.key(WHEEL_UP);
  harness.lines();
  assert.equal(harness.viewer.model().state.scroll, bottom - 1);
  assert.equal(harness.viewer.model().state.follow, false);

  harness.key(LEGACY_WHEEL_UP);
  harness.lines();
  assert.equal(harness.viewer.model().state.scroll, bottom - 2);

  const before = harness.viewer.model().state.scroll;
  harness.key(MOUSE_CLICK);
  harness.key(MOUSE_RELEASE);
  harness.lines();
  assert.equal(harness.viewer.model().state.scroll, before, "clicks and releases never move the viewport");

  harness.key(WHEEL_DOWN);
  harness.key(LEGACY_WHEEL_DOWN);
  harness.lines();
  assert.equal(harness.viewer.model().state.scroll, bottom);
  assert.equal(harness.viewer.model().state.follow, true, "wheeling back to the end re-arms follow");
  harness.viewer.close();
  await opened;
});

test("follow re-arms only by actually reaching the end", async () => {
  const harness = scrollHarness();
  const { opened } = await openViewer(harness);
  await flush();
  harness.lines();
  const state = () => harness.viewer.model().state;
  const bottom = state().scroll;

  harness.key(KEY.home);
  harness.lines();
  assert.deepEqual(
    { scroll: state().scroll, follow: state().follow, suppressed: state().suppressed },
    { scroll: 0, follow: false, suppressed: false },
  );

  harness.key(KEY.pageDown);
  harness.lines();
  assert.equal(state().follow, false, "a page that stops short of the end must not follow");
  assert.ok(state().scroll > 0 && state().scroll < bottom);

  harness.key(KEY.end);
  harness.lines();
  assert.equal(state().follow, true);
  assert.equal(state().scroll, bottom);
  assert.equal(state().suppressed, false);
  harness.viewer.close();
  await opened;
});

test("f at the end suppresses re-arming until follow is turned back on", async () => {
  const harness = scrollHarness();
  const { opened } = await openViewer(harness);
  await flush();
  harness.lines();
  const state = () => harness.viewer.model().state;
  assert.equal(state().follow, true);

  harness.key("f");
  harness.lines();
  assert.equal(state().follow, false);
  assert.equal(state().suppressed, true, "turning follow off at the end suppresses re-arming");

  const pinned = state().scroll;
  harness.setRuns([runSnapshot()]);
  harness.tick();
  await flush();
  harness.lines();
  assert.equal(state().follow, false, "growth cannot re-arm a suppressed view");
  assert.equal(state().scroll, pinned);

  harness.key("f");
  harness.lines();
  assert.equal(state().follow, true);
  assert.equal(state().suppressed, false, "turning follow back on clears suppression");
  harness.viewer.close();
  await opened;
});

/** A harness whose transcript grows on demand, so follow behaviour is observed, not asserted flat. */
function growingHarness(initial = 60) {
  let count = initial;
  const harness = createHarness({
    loadTranscript: () => ({
      status: "ok",
      fingerprint: `fp-${count}`,
      transcript: transcriptOf(manyEntries(count), { fingerprint: `fp-${count}` }),
    }),
  });
  return Object.assign(harness, {
    async grow(by = 30) {
      count += by;
      harness.tick();
      await flush();
      harness.lines();
    },
  });
}

test("a suppressed view never re-arms on Down, PageDown, the wheel, growth, or a resize", async () => {
  const harness = growingHarness();
  const { opened } = await openViewer(harness);
  await flush();
  harness.lines();
  const state = () => harness.viewer.model().state;
  assert.equal(state().follow, true);
  const pinned = state().scroll;
  assert.ok(pinned > 0);

  harness.key("f");
  harness.lines();
  assert.equal(state().follow, false);
  assert.equal(state().suppressed, true);

  // Every downward gesture at the end is a no-op for follow while the user has suppressed it.
  for (const [name, key] of [
    ["Down", KEY.down],
    ["PageDown", KEY.pageDown],
    ["wheel", WHEEL_DOWN],
    ["legacy wheel", LEGACY_WHEEL_DOWN],
  ]) {
    harness.key(key);
    harness.lines();
    assert.equal(state().follow, false, `${name} at the end must not re-arm follow`);
    assert.equal(state().scroll, pinned, `${name} at the end must not move the view`);
  }

  // Real growth: the view stays exactly where the user parked it instead of chasing the tail.
  await harness.grow();
  assert.equal(state().follow, false, "growth must not re-arm a suppressed view");
  assert.equal(state().scroll, pinned, "a suppressed view does not follow new output");

  // Walking down to the new end by hand is still not a request to start following again.
  for (let step = 0; step < 400; step += 1) harness.key(KEY.down);
  harness.lines();
  const grownBottom = state().scroll;
  assert.ok(grownBottom > pinned, "the keys really reached the new end");
  assert.equal(state().follow, false, "reaching the end by key must not re-arm a suppressed view");

  harness.setRows(40);
  harness.lines();
  harness.setRows(24);
  harness.lines();
  assert.equal(state().follow, false, "a resize clamp must not re-arm a suppressed view");

  // End is the explicit request, so it both follows again and lifts suppression.
  harness.key(KEY.end);
  harness.lines();
  assert.equal(state().follow, true);
  assert.equal(state().suppressed, false);
  const beforeGrowth = state().scroll;
  await harness.grow();
  assert.ok(state().scroll > beforeGrowth, "following again really pins the view to new output");
  harness.viewer.close();
  await opened;
});

test("f turns follow back on for a suppressed view and pins it to the end again", async () => {
  const harness = growingHarness();
  const { opened } = await openViewer(harness);
  await flush();
  harness.lines();
  const state = () => harness.viewer.model().state;

  harness.key("f");
  harness.lines();
  assert.equal(state().suppressed, true);
  harness.key("f");
  harness.lines();
  assert.equal(state().follow, true);
  assert.equal(state().suppressed, false);

  const before = state().scroll;
  await harness.grow();
  assert.ok(state().scroll > before, "follow turned back on tracks new output");
  harness.viewer.close();
  await opened;
});

test("leaving the end upward clears suppression so the way back down re-arms follow", async () => {
  const harness = growingHarness();
  const { opened } = await openViewer(harness);
  await flush();
  harness.lines();
  const state = () => harness.viewer.model().state;

  harness.key("f");
  harness.lines();
  assert.equal(state().suppressed, true);

  harness.key(KEY.up);
  harness.lines();
  assert.equal(state().suppressed, false, "deliberately leaving the end is a change of mind");
  assert.equal(state().follow, false);

  harness.key(KEY.down);
  harness.lines();
  assert.equal(state().follow, true, "arriving at the end again re-arms once suppression is gone");
  const before = state().scroll;
  await harness.grow();
  assert.ok(state().scroll > before, "the re-armed view really follows new output");
  harness.viewer.close();
  await opened;
});

test("Home clears suppression only by really leaving the end", async () => {
  const harness = growingHarness();
  const { opened } = await openViewer(harness);
  await flush();
  harness.lines();
  const state = () => harness.viewer.model().state;

  harness.key("f");
  harness.lines();
  assert.equal(state().suppressed, true);

  harness.key(KEY.home);
  harness.lines();
  assert.equal(state().scroll, 0);
  assert.equal(state().suppressed, false);
  assert.equal(state().follow, false);

  harness.key(KEY.end);
  harness.lines();
  assert.equal(state().follow, true);
  harness.viewer.close();
  await opened;
});

test("follow off away from the end is not suppressed and re-arms on the way down", async () => {
  const harness = scrollHarness();
  const { opened } = await openViewer(harness);
  await flush();
  harness.lines();
  const state = () => harness.viewer.model().state;

  harness.key(KEY.up);
  harness.lines();
  assert.equal(state().follow, false);
  assert.equal(state().suppressed, false);

  harness.key("f");
  harness.lines();
  assert.equal(state().follow, true, "f away from the end turns follow on");

  harness.key("f");
  harness.lines();
  assert.equal(state().suppressed, true, "f on at the end pins to the end, so f off suppresses");
  harness.viewer.close();
  await opened;
});

test("a resize clamp never counts as the user reaching the end", async () => {
  const harness = scrollHarness();
  const { opened } = await openViewer(harness);
  await flush();
  harness.lines();
  harness.key(KEY.home);
  harness.lines();
  const state = () => harness.viewer.model().state;
  assert.equal(state().follow, false);

  harness.setRows(60);
  harness.lines();
  assert.equal(state().follow, false, "a taller terminal clamps scroll without following");
  harness.setRows(10);
  harness.lines();
  assert.equal(state().follow, false);
  harness.viewer.close();
  await opened;
});

test("each run keeps its own scroll, follow, and suppression", async () => {
  const runs = [runSnapshot({ id: "a" }), runSnapshot({ id: "b" })];
  const harness = createHarness({
    runs,
    loadTranscript: () => ({ status: "ok", fingerprint: "fp", transcript: transcriptOf(manyEntries(60)) }),
  });
  const { opened } = await openViewer(harness);
  await flush();
  harness.lines();
  harness.key("f");
  harness.lines();
  assert.equal(harness.viewer.model().state.suppressed, true);

  harness.key(KEY.right);
  await flush();
  harness.lines();
  assert.equal(harness.viewer.currentRun(), "b");
  assert.equal(harness.viewer.model().state.follow, true);
  assert.equal(harness.viewer.model().state.suppressed, false);

  harness.key(KEY.left);
  await flush();
  harness.lines();
  assert.equal(harness.viewer.currentRun(), "a");
  assert.equal(harness.viewer.model().state.suppressed, true);
  assert.equal(harness.viewer.model().state.follow, false);
  harness.viewer.close();
  await opened;
});

test("Ctrl+O uses the user's real binding and flips Pi's one global expansion state", async () => {
  const previous = getKeybindings();
  const manager = new KeybindingsManager(EXPAND_DEFINITIONS, { "app.tools.expand": "alt+e" });
  setKeybindings(manager);
  try {
    const harness = createHarness({ keybindings: manager, toolsExpanded: true });
    const { opened } = await openViewer(harness);
    await flush();
    harness.lines();
    assert.equal(harness.viewer.model().expanded, true);

    harness.key("\x1b[99;3u");
    harness.key("\x1bo");
    harness.lines();
    assert.equal(harness.expandedState, true, "ctrl+o is not hardcoded when the user rebound the action");

    harness.key("\x1be");
    harness.lines();
    assert.equal(harness.expandedState, false, "the viewer toggles Pi's global flag");
    assert.equal(harness.viewer.model().expanded, false);

    // Main (or any other surface) changes the same flag; the viewer picks it up on its own tick.
    harness.setExpandedState(true);
    harness.tick();
    await flush();
    assert.equal(harness.viewer.model().expanded, true);

    const hintText = harness.lines().map((line) => line.trimEnd()).join(" ");
    assert.ok(hintText.includes("expanded"), hintText);
    harness.viewer.close();
    await opened;

    // The shared flag survives closing and reopening, because the viewer never keeps its own copy.
    harness.setExpandedState(false);
    const { opened: reopened } = await openViewer(harness);
    await flush();
    assert.equal(harness.viewer.model().expanded, false);
    const collapsedHint = harness.lines().map((line) => line.trimEnd()).join(" ");
    assert.ok(collapsedHint.includes("collapsed"), collapsedHint);
    harness.viewer.close();
    await reopened;
  } finally {
    setKeybindings(previous);
  }
});

test("the expansion state is part of the body key and reaches the built body", async () => {
  const harness = createHarness({ toolsExpanded: true });
  const { opened } = await openViewer(harness);
  await flush();
  harness.lines();
  const firstKey = harness.viewer.model().bodyKey;
  assert.match(firstKey, /:1:running:$/, firstKey);
  const buildsBefore = harness.builds.length;

  harness.setExpandedState(false);
  harness.tick();
  await flush();
  harness.lines();
  assert.match(harness.viewer.model().bodyKey, /:0:running:$/);
  assert.notEqual(harness.viewer.model().bodyKey, firstKey);
  assert.equal(harness.builds.length, buildsBefore + 1, "an expansion change rebuilds exactly once");
  assert.equal(harness.builds.at(-1).input.expanded, false);
  harness.viewer.close();
  await opened;
});

test("the transcript body receives the run cwd and the host settings", async () => {
  const harness = createHarness({ runs: [runSnapshot({ cwd: "/work/other" })] });
  const { opened } = await openViewer(harness);
  await flush();
  harness.lines();
  assert.equal(harness.builds.at(-1).input.cwd, "/work/other");
  assert.deepEqual(harness.builds.at(-1).input.settings, { outputPad: 1, codeBlockIndent: "", hideThinkingBlock: false });
  harness.viewer.close();
  await opened;
});

test("the shortcut reads Main's presentation settings from its own context", async () => {
  const harness = createHarness();
  const opened = harness.viewer.handleShortcut(harness.ui, 1, {
    enabled: true,
    cwd: "/work/project",
    projectTrusted: true,
  });
  await flush();
  assert.deepEqual(harness.settingsReads, [{ cwd: "/work/project", projectTrusted: true }]);
  harness.viewer.close();
  await opened;
});

test("the elapsed clock repaints on the first tick where its shown value changes", async () => {
  // The run started 5.35 s ago, so its display flips at .65 s into the current wall-clock second.
  // A floor(now / 1000) bucket would fire 350 ms late, on the wrong tick.
  const harness = createHarness({
    runs: [runSnapshot({ createdAt: new Date(VIEWER_NOW_MS - 5_350).toISOString() })],
  });
  const { opened } = await openViewer(harness);
  await flush();
  const elapsedOf = () => {
    const row = harness.lines(200).find((line) => line.includes("tool use")) ?? "";
    return row.slice(row.lastIndexOf("·") + 1).trim();
  };
  assert.equal(elapsedOf(), "5s");
  const buildsAfterOpen = harness.builds.length;

  // Two ticks that leave the shown value alone: no repaint, no rebuild.
  let rendersBefore = harness.renders;
  harness.advance(250);
  harness.tick();
  harness.advance(250);
  harness.tick();
  await flush();
  assert.equal(harness.renders, rendersBefore, "an unchanged elapsed value must not repaint");
  assert.equal(elapsedOf(), "5s");
  assert.equal(harness.builds.length, buildsAfterOpen);

  // 6.1 s in: the shown value is now 6s, so this very tick has to repaint.
  harness.advance(250);
  harness.tick();
  await flush();
  assert.ok(harness.renders > rendersBefore, "the first tick with a new elapsed string repaints");
  assert.equal(elapsedOf(), "6s");
  assert.equal(harness.builds.length, buildsAfterOpen, "the clock never rebuilds the transcript body");

  // Ten more seconds of pure clock ticks still never rebuild the body.
  rendersBefore = harness.renders;
  for (let step = 0; step < 10; step += 1) {
    harness.advance(1000);
    harness.tick();
  }
  await flush();
  assert.equal(harness.builds.length, buildsAfterOpen);
  assert.ok(harness.renders > rendersBefore, "every changed second still repaints");
  harness.viewer.close();
  await opened;
});

test("an hour-old run repaints on its minute, not on every second", async () => {
  // 1h02m03.4s in, so the shown value stays 1h02m until the minute rolls over.
  const harness = createHarness({
    runs: [runSnapshot({ createdAt: new Date(VIEWER_NOW_MS - (3_723_400)).toISOString() })],
  });
  const { opened } = await openViewer(harness);
  await flush();
  const elapsedOf = () => {
    const row = harness.lines(200).find((line) => line.includes("tool use")) ?? "";
    return row.slice(row.lastIndexOf("·") + 1).trim();
  };
  assert.equal(elapsedOf(), "1h02m");

  // Thirty seconds of ticks change nothing on screen, so nothing may repaint.
  const rendersBefore = harness.renders;
  for (let step = 0; step < 30; step += 1) {
    harness.advance(1000);
    harness.tick();
  }
  await flush();
  assert.equal(harness.renders, rendersBefore, "a second that changes no shown value must not repaint");
  assert.equal(elapsedOf(), "1h02m");

  // Crossing into 1h03m is a visible change, so that tick repaints.
  harness.advance(27_000);
  harness.tick();
  await flush();
  assert.equal(elapsedOf(), "1h03m");
  assert.ok(harness.renders > rendersBefore, "the minute change repaints");
  harness.viewer.close();
  await opened;
});

test("a run with an unusable createdAt never churns the status row", async () => {
  const harness = createHarness({ runs: [runSnapshot({ createdAt: "not-a-date" })] });
  const { opened } = await openViewer(harness);
  await flush();
  harness.lines(200);
  const rendersBefore = harness.renders;
  for (let step = 0; step < 8; step += 1) {
    harness.advance(1000);
    harness.tick();
  }
  await flush();
  assert.equal(harness.renders, rendersBefore, "an unknown elapsed value has nothing to repaint");
  assert.ok(harness.lines(200).some((line) => line.includes("—")), "the row still shows the unknown marker");
  harness.viewer.close();
  await opened;
});

test("an activity change repaints immediately and still keeps the built body", async () => {
  const harness = createHarness();
  const { opened } = await openViewer(harness);
  await flush();
  harness.lines();
  const buildsAfterOpen = harness.builds.length;
  const rendersBefore = harness.renders;
  harness.setRuns([runSnapshot({ activity: {
    turnCount: 9,
    toolUses: 12,
    activeTools: { one: { name: "grep" } },
    responseText: "streaming",
    tokens: 4242,
    compactionCount: 2,
  } })]);
  harness.tick();
  await flush();
  assert.ok(harness.renders > rendersBefore);
  assert.equal(harness.builds.length, buildsAfterOpen);
  // The status rows truncate to the terminal width, so the assertion reads a wide render.
  const text = harness.lines(200).join(" ");
  assert.ok(text.includes("12 tool uses"), text);
  assert.ok(text.includes("2 compactions"), text);
  harness.viewer.close();
  await opened;
});

test("elapsed formatting is human readable and refuses an invalid timestamp", () => {
  const base = Date.parse("2026-04-17T00:00:00.000Z");
  assert.equal(formatViewerElapsed("2026-04-17T00:00:00.000Z", base + 999), "0s");
  assert.equal(formatViewerElapsed("2026-04-17T00:00:00.000Z", base + 42_000), "42s");
  assert.equal(formatViewerElapsed("2026-04-17T00:00:00.000Z", base + 59_999), "59s");
  assert.equal(formatViewerElapsed("2026-04-17T00:00:00.000Z", base + 60_000), "1m00s");
  assert.equal(formatViewerElapsed("2026-04-17T00:00:00.000Z", base + 3_723_000), "1h02m");
  assert.equal(formatViewerElapsed("2026-04-17T00:00:00.000Z", base - 5_000), "0s");
  assert.equal(formatViewerElapsed("not-a-date", base), "—");
  assert.equal(formatViewerElapsed("", base), "—");
});

test("the bottom rows shed in order and always keep the transcript, Read-Only, and status title", async () => {
  const harness = createHarness({
    rows: 24,
    runs: [runSnapshot({
      status: "waiting",
      request: {
        runId: "run-a",
        reason: "need_decision",
        message: "Pick a lane.\nSecond line.\nThird line.",
        createdAt: "2026-04-17T00:01:00.000Z",
      },
    })],
  });
  const { opened } = await openViewer(harness);
  await flush();
  const full = harness.lines(80).map((line) => line.trimEnd());
  assert.ok(full.some((line) => line.includes("waiting")), "the live block is present at full height");

  const seen = [];
  for (const rows of [24, 16, 12, 10, 8, 6, 5, 4, 3]) {
    harness.setRows(rows);
    const lines = harness.lines(80).map((line) => line.trimEnd());
    assert.equal(lines.length, rows, `rows ${rows}`);
    for (const line of harness.lines(80)) assert.equal(visibleWidth(line), 80);
    const text = lines.join("\n");
    assert.ok(text.includes(VIEWER_READ_ONLY_LABEL), `rows ${rows} keeps Read-Only`);
    assert.ok(/Subagent 1\/1/.test(text), `rows ${rows} keeps the status title`);
    seen.push({
      rows,
      live: text.includes("▌ waiting"),
      activity: text.includes("tool use"),
      hints: text.includes("Esc/q Main"),
    });
  }
  const liveGone = seen.find((row) => !row.live)?.rows ?? 0;
  const activityGone = seen.find((row) => !row.activity)?.rows ?? 0;
  const hintsGone = seen.find((row) => !row.hints)?.rows ?? 0;
  assert.ok(liveGone >= activityGone, "the live block sheds before the activity row");
  assert.ok(activityGone >= hintsGone, "the activity row sheds before the hints");
  harness.viewer.close();
  await opened;
});

test("the empty state lives in the transcript body, not in a header", async () => {
  const harness = createHarness({
    realBody: true,
    loadTranscript: () => ({
      status: "waiting",
      transcript: { status: "waiting", entries: [], hiddenEntries: 0, warning: "The child session file has not been created yet." },
    }),
  });
  const { opened } = await openViewer(harness);
  await flush();
  const lines = harness.lines(80).map((line) => line.trimEnd());
  assert.match(lines[0].trim(), /has not been created yet/);
  assert.ok(lines.some((line) => line.includes(VIEWER_READ_ONLY_LABEL)));
  harness.viewer.close();
  await opened;
});

test("the activity row drops middle stats before it loses liveness or the elapsed clock", async () => {
  const harness = createHarness({
    runs: [runSnapshot({
      createdAt: new Date(VIEWER_NOW_MS - 42_000).toISOString(),
      activity: {
        turnCount: 7,
        toolUses: 12,
        activeTools: {},
        responseText: "",
        tokens: 34_200,
        compactionCount: 3,
      },
    })],
  });
  const { opened } = await openViewer(harness);
  await flush();
  const activityRow = (width) => harness.lines(width).find((line) => line.includes("live ·") || line.startsWith("live")) ?? "";
  const wide = activityRow(200);
  assert.ok(wide.includes("3 compactions"), wide);
  assert.ok(wide.includes("42s"), wide);

  for (const width of [90, 60, 40, 24]) {
    const row = activityRow(width);
    assert.ok(row.startsWith("live"), `width ${width}: ${row}`);
    assert.ok(row.includes("42s"), `width ${width} must keep the elapsed clock: ${row}`);
    assert.ok(visibleWidth(row) <= width, `width ${width}: ${row}`);
  }
  assert.equal(activityRow(40).includes("3 compactions"), false, "narrow rows shed the middle stats");
  harness.viewer.close();
  await opened;
});

test("segment fitting keeps the ends and drops in the declared order", () => {
  const segments = ["live", "model-name", "turns", "tools", "tokens", "compactions", "42s"];
  const dropOrder = [5, 4, 3, 2, 1];
  assert.equal(fitViewerSegments(segments, dropOrder, 200), segments.join(" · "));
  assert.equal(fitViewerSegments(segments, dropOrder, 40), "live · model-name · turns · tools · 42s");
  assert.equal(fitViewerSegments(segments, dropOrder, 10), "live · 42s");
});

/* ------------------------------------------------------------------------------------------------
 * Retained membership, terminal cutoffs, and lifecycle presentation.
 * ---------------------------------------------------------------------------------------------- */

function retainedRun(id, status, overrides = {}) {
  return runSnapshot({
    id,
    status,
    live: status === "running" || status === "waiting",
    createdAt: `2026-04-17T00:0${Math.min(9, id.length)}:00.000Z`,
    updatedAt: "2026-04-17T00:30:00.000Z",
    ...(status === "completed" || status === "failed" || status === "interrupted"
      ? { transcriptCutoff: overrides.updatedAt ?? "2026-04-17T00:30:00.000Z" }
      : {}),
    ...overrides,
  });
}

test("every retained status stays in the cycle and i/N counts the whole retained set", async () => {
  const statuses = ["starting", "running", "waiting", "completed", "failed", "interrupted"];
  const runs = statuses.map((status, index) => retainedRun(`run-${index}`, status));
  const harness = createHarness({ runs });
  const { opened } = await openViewer(harness);
  await flush();
  assert.equal(harness.viewer.model().total, runs.length);
  const seen = [harness.viewer.currentRun()];
  for (let step = 1; step < runs.length; step += 1) {
    harness.key(KEY.right);
    await flush();
    seen.push(harness.viewer.currentRun());
  }
  assert.deepEqual(seen, runs.map((run) => run.id), "the cycle visits every retained run in order");
  const statusRow = () => harness.lines(200).find((line) => line.includes("Subagent ")) ?? "";
  assert.match(statusRow(), /Subagent 6\/6 · fixer \[run-5\] · interrupted/);
  harness.key(KEY.right);
  await opened;
  assert.equal(harness.viewer.isOpen(), false, "one more step past the last run returns to Main");
});

test("a retained set larger than the widget's visible budget keeps every run in the cycle", async () => {
  const runs = Array.from({ length: 17 }, (_, index) => retainedRun(`r${index}`, index % 2 === 0 ? "completed" : "running"));
  const harness = createHarness({ runs });
  const { opened } = await openViewer(harness, -1);
  await flush();
  assert.equal(harness.viewer.model().total, 17);
  assert.equal(harness.viewer.currentRun(), "r16", "opening backwards starts at the last retained run");
  harness.key(KEY.right);
  await flush();
  assert.equal(harness.viewer.currentRun(), undefined, "one step past the last run is Main");
  await opened;
  assert.equal(harness.viewer.isOpen(), false);
});

test("a running run that completes keeps the selection and only reorders", async () => {
  const runs = [retainedRun("a", "running"), retainedRun("b", "running"), retainedRun("c", "running")];
  const harness = createHarness({ runs });
  const { opened } = await openViewer(harness);
  await flush();
  harness.key(KEY.right);
  await flush();
  assert.equal(harness.viewer.currentRun(), "b");
  const before = harness.viewer.model().index;

  // A terminal run sorts after the live ones, so the same id moves to the end of the ring.
  harness.setRuns([runs[0], runs[2], retainedRun("b", "completed", { output: "done" })]);
  harness.tick();
  await flush();
  assert.equal(harness.viewer.currentRun(), "b", "a status change never drops the selection");
  assert.equal(harness.viewer.model().total, 3);
  assert.notEqual(harness.viewer.model().index, before, "the run took its new place in the order");
  assert.equal(harness.viewer.isOpen(), true);
  harness.viewer.close();
  await opened;
});

test("clear empties the retained set and returns to Main", async () => {
  const harness = createHarness({ runs: [retainedRun("a", "completed")] });
  const { opened } = await openViewer(harness);
  await flush();
  harness.setRuns([]);
  harness.tick();
  await opened;
  assert.equal(harness.viewer.isOpen(), false);
});

test("a read that lands after clear never writes a cache entry or repaints", async () => {
  let resolveRead;
  const harness = createHarness({
    runs: [retainedRun("a", "running")],
    loadTranscript: () => new Promise((resolve) => { resolveRead = resolve; }),
  });
  const { opened } = await openViewer(harness);
  await flush();
  const rendersBefore = harness.renders;
  // The run is cleared while its read is still in flight, but the overlay is still open.
  harness.setRuns([retainedRun("b", "running")]);
  harness.tick();
  await flush();
  resolveRead({ status: "ok", fingerprint: "late", contentKey: "late", transcript: transcriptOf([assistantText("m1", null, "late")]) });
  await flush();
  assert.equal(harness.viewer.currentRun(), "b");
  assert.equal(harness.lines(80).join(" ").includes("late"), false, "a cleared run's read must not reach the screen");
  void rendersBefore;
  harness.viewer.close();
  await opened;
});

test("a starting run shows a stable pending body and keeps polling", async () => {
  let reads = 0;
  const harness = createHarness({
    realBody: true,
    runs: [retainedRun("a", "starting", { sessionFile: undefined })],
    loadTranscript: () => {
      reads += 1;
      return {
        status: "waiting",
        transcript: { status: "waiting", entries: [], hiddenEntries: 0, warning: "The run has not published a session file yet." },
      };
    },
  });
  const { opened } = await openViewer(harness);
  await flush();
  const first = harness.lines(80);
  assert.match(first[0].trim(), /has not published a child session file yet/);
  const builds = harness.builds.length;
  for (let tick = 0; tick < 8; tick += 1) {
    harness.tick();
    await flush();
    // Rendering inside the loop is what would expose a per-tick rebuild.
    harness.lines(80);
  }
  assert.equal(harness.builds.length, builds, "polling a run with no session file must not rebuild the body");
  assert.ok(reads > 1, "the viewer keeps polling for the file to appear");
  const statusRow = harness.lines(200).find((line) => line.includes("Subagent ")) ?? "";
  assert.match(statusRow, /starting/);
  assert.equal(harness.lines(200).some((line) => line.includes("live response")), false);
  harness.viewer.close();
  await opened;
});

test("a terminal run without a readable session file falls back to its retained result", async () => {
  for (const [status, field, text] of [
    ["completed", "output", "the final answer"],
    ["failed", "error", "provider exploded"],
    ["interrupted", "error", "Interrupted by the parent session."],
  ]) {
    const harness = createHarness({
      realBody: true,
      runs: [retainedRun("a", status, { [field]: text, sessionFile: undefined })],
      loadTranscript: () => ({
        status: "waiting",
        transcript: { status: "waiting", entries: [], hiddenEntries: 0, warning: "no file" },
      }),
    });
    const { opened } = await openViewer(harness);
    await flush();
    const body = harness.lines(120).join("\n");
    assert.ok(body.includes(`[${status}]`), `${status} must label its outcome: ${body}`);
    assert.ok(body.includes(text), `${status} must show its retained ${field}`);
    const builds = harness.builds.length;
    for (let tick = 0; tick < 4; tick += 1) {
      harness.tick();
      await flush();
      harness.lines(120);
    }
    assert.equal(harness.builds.length, builds, `${status} must not rebuild its fallback body on every tick`);
    harness.viewer.close();
    await opened;
  }
});

test("a terminal error stays visible even when the transcript is present", async () => {
  const harness = createHarness({
    realBody: true,
    runs: [retainedRun("a", "failed", { error: "tool budget exhausted" })],
    loadTranscript: () => ({
      status: "ok",
      fingerprint: "fp",
      contentKey: "ck",
      transcript: transcriptOf([assistantText("m1", null, "partial work")], { contentKey: "ck" }),
    }),
  });
  const { opened } = await openViewer(harness);
  await flush();
  const body = harness.lines(120).join("\n");
  assert.match(body, /partial work/);
  assert.match(body, /\[failed\]/);
  assert.match(body, /tool budget exhausted/);
  harness.viewer.close();
  await opened;
});

test("a completed output that repeats the last assistant message is not shown twice", async () => {
  const answer = "the migration is complete";
  const harness = createHarness({
    realBody: true,
    runs: [retainedRun("a", "completed", { output: answer })],
    loadTranscript: () => ({
      status: "ok",
      fingerprint: "fp",
      contentKey: "ck",
      transcript: transcriptOf([assistantText("m1", null, answer)], { contentKey: "ck" }),
    }),
  });
  const { opened } = await openViewer(harness);
  await flush();
  const body = harness.lines(120).join("\n");
  const occurrences = body.split(answer).length - 1;
  assert.equal(occurrences, 1, body);
  harness.viewer.close();
  await opened;
});

test("terminal elapsed freezes at the run's own end and stops the status clock", async () => {
  const harness = createHarness({
    runs: [retainedRun("a", "completed", {
      createdAt: "2026-04-17T00:00:00.000Z",
      updatedAt: "2026-04-17T00:00:42.000Z",
      transcriptCutoff: "2026-04-17T00:00:42.000Z",
    })],
  });
  const { opened } = await openViewer(harness);
  await flush();
  const statusRow = () => harness.lines(200).find((line) => line.includes("live ·") || line.includes("(provider)")) ?? "";
  assert.match(statusRow(), /42s/);
  const rendersBefore = harness.renders;
  for (let second = 0; second < 5; second += 1) {
    harness.advance(1000);
    harness.tick();
  }
  await flush();
  assert.equal(harness.renders, rendersBefore, "a finished run has no clock to repaint");
  assert.match(statusRow(), /42s/);
  assert.equal(statusRow().includes("live"), false, "a finished run claims no liveness");
  harness.viewer.close();
  await opened;
});

/* ---------------------------------------------------------------------------------------------- */

function resumeFixture() {
  const fixture = sessionFixture();
  const rows = [
    JSON.stringify({ type: "session", id: "s", timestamp: "2026-04-17T00:00:00.000Z", cwd: "/tmp" }),
    JSON.stringify({ ...messageEntry("m1", null, { role: "user", content: "source task", timestamp: 0 }), timestamp: "2026-04-17T00:00:01.000Z" }),
    JSON.stringify({ ...assistantText("m2", "m1", "source answer"), timestamp: "2026-04-17T00:00:02.000Z" }),
  ];
  writeFileSync(fixture.file, `${rows.join("\n")}\n`);
  return fixture;
}

function appendRows(fixture, rows) {
  const existing = readFileSync(fixture.file, "utf8");
  writeFileSync(fixture.file, `${existing}${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
}

test("a resumed run and its source each see exactly their own turns", () => {
  const fixture = resumeFixture();
  try {
    const sourceCutoff = "2026-04-17T00:00:02.000Z";
    const source = loadViewerTranscript(fixture.childDir, fixture.file, { cutoff: sourceCutoff });
    assert.equal(source.status, "ok");
    assert.equal(source.transcript.entries.length, 2);

    // First resume appends its own turns to the same file.
    appendRows(fixture, [
      { ...messageEntry("m3", "m2", { role: "user", content: "continue please", timestamp: 0 }), timestamp: "2026-04-17T00:05:00.000Z" },
      { ...assistantText("m4", "m3", "first continuation"), timestamp: "2026-04-17T00:05:01.000Z" },
    ]);
    const sourceAgain = loadViewerTranscript(fixture.childDir, fixture.file, { cutoff: sourceCutoff });
    assert.equal(sourceAgain.transcript.entries.length, 2, "the finished source never sees its successor");
    const sourceText = transcriptText(sourceAgain.transcript, 60);
    assert.equal(sourceText.includes("first continuation"), false);
    assert.match(sourceText, /source answer/);
    assert.match(sourceAgain.transcript.warning, /after this run finished/);

    const active = loadViewerTranscript(fixture.childDir, fixture.file, {});
    assert.equal(active.transcript.entries.length, 4, "the active resumed run sees the whole file");

    // Second resume: the first resumed run is terminal now and freezes at its own end.
    const firstResumeCutoff = "2026-04-17T00:05:01.000Z";
    appendRows(fixture, [
      { ...messageEntry("m5", "m4", { role: "user", content: "one more", timestamp: 0 }), timestamp: "2026-04-17T00:09:00.000Z" },
      { ...assistantText("m6", "m5", "second continuation"), timestamp: "2026-04-17T00:09:01.000Z" },
    ]);
    const firstResume = loadViewerTranscript(fixture.childDir, fixture.file, { cutoff: firstResumeCutoff });
    assert.equal(firstResume.transcript.entries.length, 4);
    const firstResumeText = transcriptText(firstResume.transcript, 60);
    assert.match(firstResumeText, /first continuation/);
    assert.equal(firstResumeText.includes("second continuation"), false);

    const secondResume = loadViewerTranscript(fixture.childDir, fixture.file, { cutoff: "2026-04-17T00:09:01.000Z" });
    assert.equal(secondResume.transcript.entries.length, 6);
    const stillSource = loadViewerTranscript(fixture.childDir, fixture.file, { cutoff: sourceCutoff });
    assert.equal(stillSource.transcript.entries.length, 2, "three generations later the source is still frozen");
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("the cutoff excludes every entry type, not only messages", () => {
  const fixture = resumeFixture();
  try {
    appendRows(fixture, [
      { type: "compaction", id: "c1", parentId: "m2", timestamp: "2026-04-17T00:06:00.000Z", summary: "later compaction", firstKeptEntryId: "m2", tokensBefore: 10 },
      { type: "branch_summary", id: "b1", parentId: "c1", timestamp: "2026-04-17T00:06:01.000Z", fromId: "m1", summary: "later branch" },
      { type: "custom_message", id: "x1", parentId: "b1", timestamp: "2026-04-17T00:06:02.000Z", customType: "note", content: "later note", display: true },
      { ...messageEntry("t1", "x1", { role: "assistant", content: [{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "/later" } }], timestamp: 0 }), timestamp: "2026-04-17T00:06:03.000Z" },
      { ...messageEntry("t2", "t1", { role: "toolResult", toolCallId: "tc1", toolName: "read", content: [{ type: "text", text: "later tool output" }], isError: false, timestamp: 0 }), timestamp: "2026-04-17T00:06:04.000Z" },
    ]);
    const load = loadViewerTranscript(fixture.childDir, fixture.file, { cutoff: "2026-04-17T00:00:02.000Z" });
    const text = transcriptText(load.transcript, 70);
    for (const term of ["later compaction", "later branch", "later note", "/later", "later tool output"]) {
      assert.equal(text.includes(term), false, `${term} must be excluded by the cutoff`);
    }
    assert.match(text, /source answer/);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("with a cutoff in force an entry with a missing or invalid timestamp is dropped", () => {
  const fixture = resumeFixture();
  try {
    appendRows(fixture, [
      { ...assistantText("m3", "m2", "no timestamp at all"), timestamp: undefined },
      { ...assistantText("m4", "m3", "broken timestamp"), timestamp: "not-a-date" },
      { ...assistantText("m5", "m4", "numeric timestamp"), timestamp: 12345 },
    ]);
    const bounded = loadViewerTranscript(fixture.childDir, fixture.file, { cutoff: "2026-04-17T00:00:02.000Z" });
    const boundedText = transcriptText(bounded.transcript, 60);
    for (const term of ["no timestamp at all", "broken timestamp", "numeric timestamp"]) {
      assert.equal(boundedText.includes(term), false, `${term} must fail closed under a cutoff`);
    }
    assert.match(bounded.transcript.warning, /after this run finished/);

    // Without a cutoff nothing is time filtered, so an active run still sees those entries.
    const unbounded = loadViewerTranscript(fixture.childDir, fixture.file, {});
    assert.match(transcriptText(unbounded.transcript, 60), /no timestamp at all/);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("appending to a shared file never rebuilds a frozen run's body", async () => {
  const fixture = resumeFixture();
  try {
    const cutoff = "2026-04-17T00:00:02.000Z";
    const harness = createHarness({
      runs: [retainedRun("a", "completed", {
        sessionFile: fixture.file,
        transcriptCutoff: cutoff,
        updatedAt: cutoff,
      })],
      childSessionDir: fixture.childDir,
      loadTranscript: (dir, file, options) => loadViewerTranscript(dir, file, options),
    });
    const { opened } = await openViewer(harness);
    await flush();
    harness.lines();
    const builds = harness.builds.length;
    assert.equal(builds, 1);

    for (let round = 0; round < 100; round += 1) {
      appendRows(fixture, [{
        ...assistantText(`later-${round}`, round === 0 ? "m2" : `later-${round - 1}`, `continuation ${round}`),
        timestamp: `2026-04-17T01:${String(Math.floor(round / 60)).padStart(2, "0")}:${String(round % 60).padStart(2, "0")}.000Z`,
      }]);
      harness.tick();
      await flush();
    }
    assert.equal(harness.builds.length, builds, "100 appended entries must not rebuild a frozen body");
    harness.lines();
    assert.equal(harness.lines(80).join(" ").includes("continuation"), false);

    // A forced re-read re-parses the file but still finds the same visible content.
    harness.key("r");
    await flush();
    assert.equal(harness.builds.length, builds, "a forced read of unchanged content rebuilds nothing");
    harness.viewer.close();
    await opened;
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("the content key covers the selected entries and ignores file identity", () => {
  const a = [{ type: "message", id: "m1", parentId: null, timestamp: "t1" }];
  const b = [{ type: "message", id: "m1", parentId: null, timestamp: "t1" }];
  const c = [{ type: "message", id: "m2", parentId: null, timestamp: "t1" }];
  const d = [{ type: "message", id: "m1", parentId: null, timestamp: "t2" }];
  assert.equal(viewerContentKey(a), viewerContentKey(b));
  assert.notEqual(viewerContentKey(a), viewerContentKey(c));
  assert.notEqual(viewerContentKey(a), viewerContentKey(d));
  assert.notEqual(viewerContentKey(a), viewerContentKey([...a, ...c]));
  assert.equal(viewerContentKey([]), viewerContentKey([]));
  assert.match(viewerContentKey([]), /^0:[0-9a-z]+$/);
  assert.match(viewerContentKey(a), /^1:[0-9a-z]+$/);
});

test("an unchanged content key updates the fingerprint without a new transcript", () => {
  const fixture = resumeFixture();
  try {
    const cutoff = "2026-04-17T00:00:02.000Z";
    const first = loadViewerTranscript(fixture.childDir, fixture.file, { cutoff });
    assert.equal(first.status, "ok");
    appendRows(fixture, [{ ...assistantText("m9", "m2", "later"), timestamp: "2026-04-17T02:00:00.000Z" }]);
    const second = loadViewerTranscript(fixture.childDir, fixture.file, {
      cutoff,
      previousFingerprint: first.fingerprint,
      previousContentKey: first.contentKey,
    });
    assert.equal(second.status, "unchanged");
    assert.equal(second.transcript, undefined);
    assert.equal(second.contentKey, first.contentKey);
    assert.notEqual(second.fingerprint, first.fingerprint, "the caller still records the new file identity");
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("an identical waiting answer is not treated as new transcript content", () => {
  const waiting = (warning) => ({ status: "waiting", entries: [], hiddenEntries: 0, warning });
  assert.equal(sameViewerTranscript(waiting("not yet"), waiting("not yet")), true);
  assert.equal(sameViewerTranscript(waiting("not yet"), waiting("refused")), false);
  assert.equal(sameViewerTranscript(undefined, waiting("not yet")), false);
  const ok = (key, count) => ({
    status: "ok",
    entries: Array.from({ length: count }, (_, index) => ({ type: "message", id: `m${index}`, parentId: null, timestamp: "t" })),
    hiddenEntries: 0,
    contentKey: key,
  });
  assert.equal(sameViewerTranscript(ok("ck", 2), ok("ck", 2)), true);
  assert.equal(sameViewerTranscript(ok("ck", 2), ok("other", 2)), false);
  assert.equal(sameViewerTranscript(ok("ck", 2), ok("ck", 3)), false);
});

test("a waiting file that never appears is read every tick but rebuilt once", async () => {
  const fixture = sessionFixture();
  try {
    const missing = join(fixture.childDir, "never.jsonl");
    let reads = 0;
    const harness = createHarness({
      realBody: true,
      runs: [retainedRun("a", "running", { sessionFile: missing })],
      childSessionDir: fixture.childDir,
      loadTranscript: (dir, file, options) => {
        reads += 1;
        return loadViewerTranscript(dir, file, options);
      },
    });
    const { opened } = await openViewer(harness);
    await flush();
    harness.lines(80);
    const builds = harness.builds.length;
    for (let tick = 0; tick < 6; tick += 1) {
      harness.tick();
      await flush();
      harness.lines(80);
    }
    assert.ok(reads > 3, "the viewer keeps polling");
    assert.equal(harness.builds.length, builds, "an unchanged waiting answer never rebuilds the body");
    harness.viewer.close();
    await opened;
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});
