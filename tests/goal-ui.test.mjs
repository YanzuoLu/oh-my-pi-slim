import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { stripVTControlCharacters } from "node:util";
import { pathToFileURL } from "node:url";
import test, { beforeEach } from "node:test";
import { piRoot } from "./fixtures/pi-install.mjs";
const dependencyMap = {
  "@earendil-works/pi-coding-agent": pathToFileURL(`${piRoot}/dist/index.js`).href,
  "@earendil-works/pi-tui": pathToFileURL(`${piRoot}/node_modules/@earendil-works/pi-tui/dist/index.js`).href,
  typebox: pathToFileURL(`${piRoot}/node_modules/typebox/build/index.mjs`).href,
  "./goal-runtime.js": new URL("../extensions/oh-my-pi-slim/goal-runtime.ts", import.meta.url).href,
  "./goal-transcript-renderer.js": new URL("../extensions/oh-my-pi-slim/goal-transcript-renderer.ts", import.meta.url).href,
  "./goal-widget.js": new URL("../extensions/oh-my-pi-slim/goal-widget.ts", import.meta.url).href,
  "./semantic-glyph.js": new URL("../extensions/oh-my-pi-slim/semantic-glyph.ts", import.meta.url).href,
  "./widget-expansion.js": new URL("../extensions/oh-my-pi-slim/widget-expansion.ts", import.meta.url).href,
  "./widget-stack.js": new URL("../extensions/oh-my-pi-slim/widget-stack.ts", import.meta.url).href,
  "./widget-stack-host.js": new URL("../extensions/oh-my-pi-slim/widget-stack-host.ts", import.meta.url).href,
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    const url = dependencyMap[specifier];
    return url ? { url, shortCircuit: true } : nextResolve(specifier, context);
  },
});

const { visibleWidth } = await import("@earendil-works/pi-tui");
const {
  GOAL_CONTINUATION_MESSAGE_TYPE,
  GOAL_STATE_MESSAGE_TYPE,
  GoalRuntime,
  goalActivationContent,
  goalContinuationContent,
} = await import("../extensions/oh-my-pi-slim/goal-runtime.ts");
const {
  renderGoalCall,
  renderGoalContinuation,
  renderGoalResult,
  renderGoalState,
} = await import("../extensions/oh-my-pi-slim/goal-transcript-renderer.ts");
const {
  GoalWidget,
  compactGoalTokens,
  renderGoalWidgetLines,
} = await import("../extensions/oh-my-pi-slim/goal-widget.ts");
const {
  WIDGET_STACK_KEY,
  resetWidgetStackHost,
} = await import("../extensions/oh-my-pi-slim/widget-stack-host.ts");

beforeEach(() => resetWidgetStackHost());

const NOW_MS = Date.parse("2026-06-01T00:12:00.000Z");
const theme = {
  fg: (_color, text) => text,
  bg: (_color, text) => text,
  bold: (text) => text,
};
const vtTheme = {
  fg: (_color, text) => `\u001b[36m${text}\u001b[0m`,
  bg: (_color, text) => `\u001b[40m${text}\u001b[0m`,
  bold: (text) => `\u001b[1m${text}\u001b[22m`,
};
const roleAnsiTheme = {
  fg: (color, text) => {
    const code = { accent: 35, dim: 2, success: 32, text: 37, muted: 90, warning: 33, error: 31 }[color] ?? 39;
    return `\u001b[${code}m${text}\u001b[0m`;
  },
  bg: (_color, text) => text,
  bold: (text) => `\u001b[1m${text}\u001b[22m`,
};

function goal(overrides = {}) {
  return {
    status: "active",
    abstract: "Ship the frozen Goal UI",
    objective: "Implement the complete foreground Goal experience.",
    criteria: ["Widget is exact", "Renderers are safe"],
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:10:00.000Z",
    endedAt: null,
    pauseReason: null,
    retryAttempt: 0,
    nextRetryAt: null,
    lastProviderError: null,
    noProgressCount: 0,
    evidence: null,
    cancelReason: null,
    ...overrides,
  };
}

function view(goalValue = goal(), overrides = {}) {
  return {
    goal: goalValue,
    elapsedMs: 12 * 60_000,
    continuationCount: 7,
    ownedChildRunCount: 4,
    main: { tokens: 84_000, tools: 23, turns: 9, compactions: 2 },
    children: { runCount: 4, tokens: 231_000, tools: 61, turns: 18, compactions: 4 },
    ...overrides,
  };
}

function renderLines(component, width = 240) {
  return component.render(width).map((line) => stripVTControlCharacters(line).trimEnd());
}

function render(component, width = 240) {
  return renderLines(component, width).join("\n").replace(/^\n+|\n+$/g, "");
}

function assertLeadingBlank(component) {
  const lines = renderLines(component);
  assert.equal(lines[0], "");
  assert.notEqual(lines[1], "");
}

function escaped(value) {
  return new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
}

test("Goal widget renders five statuses, exact two-line order, stats, elapsed, retry, paused reason, width, and empty state", () => {
  const active = renderGoalWidgetLines(view(), theme, 180, NOW_MS);
  assert.deepEqual(active, [
    "●  Goal · ↻  active · Ship the frozen Goal UI",
    "└─ 12m · 7 cont · 4 runs · main 84k tok/23 tools/9 turns/2 comp · child 231k tok/61 tools/18 turns/4 comp",
  ]);

  const cases = [
    ["active", "↻  active", "●"],
    ["paused", "Ⅱ  paused", "○"],
    ["retry_wait", "◷  retry_wait", "●"],
    ["completed", "✓  completed", "○"],
    ["cancelled", "×  cancelled", "○"],
  ];
  for (const [status, statusLabel, prefixGlyph] of cases) {
    const terminal = status === "completed" || status === "cancelled";
    const value = goal({
      status,
      pauseReason: status === "paused" ? "waiting for release approval" : null,
      retryAttempt: status === "retry_wait" ? 2 : 0,
      nextRetryAt: status === "retry_wait" ? "2026-06-01T00:12:30.000Z" : null,
      lastProviderError: status === "retry_wait" ? "rate limited" : null,
      endedAt: terminal ? "2026-06-01T00:12:00.000Z" : null,
      evidence: status === "completed" ? ["one", "two"] : null,
      cancelReason: status === "cancelled" ? "user requested" : null,
    });
    const lines = renderGoalWidgetLines(view(value), theme, 180, NOW_MS);
    assert.equal(lines.length, 2);
    assert.equal(lines[0], `${prefixGlyph}  Goal · ${statusLabel} · Ship the frozen Goal UI`);
    assert.doesNotMatch(lines[0], /Goal \(/, "the Goal heading carries no ratio");
  }
  assert.doesNotMatch(cases.map(([status]) => renderGoalWidgetLines(view(goal({ status })), theme, 180, NOW_MS)[0]).join("\n"), /[↻Ⅱ◷✓×●○] [^ ]|[↻Ⅱ◷✓×●○] {3}/);

  const retry = renderGoalWidgetLines(view(goal({
    status: "retry_wait", retryAttempt: 2, nextRetryAt: "2026-06-01T00:12:30.000Z", lastProviderError: "rate limited",
  })), theme, 180, NOW_MS)[1];
  assert.equal(retry, "└─ 12m · 7 cont · 4 runs · retry in 30s · main 84k tok/23 tools/9 turns/2 comp · child 231k tok/61 tools/18 turns/4 comp");
  const paused = renderGoalWidgetLines(view(goal({ status: "paused", pauseReason: "waiting for release approval" })), theme, 180, NOW_MS)[1];
  assert.equal(paused, "└─ 12m · 7 cont · 4 runs · paused waiting for release approval · main 84k tok/23 tools/9 turns/2 comp · child 231k tok/61 tools/18 turns/4 comp");

  const singular = renderGoalWidgetLines(view(goal(), {
    continuationCount: 1,
    ownedChildRunCount: 1,
    main: { tokens: 999, tools: 1, turns: 1, compactions: 1 },
    children: { runCount: 1, tokens: 1_250_000, tools: 1, turns: 1, compactions: 1 },
  }), theme, 180, NOW_MS)[1];
  assert.match(singular, /^└─ 12m · 1 cont · 1 run · main 999 tok\/1 tool\/1 turn\/1 comp · child 1\.3M tok\/1 tool\/1 turn\/1 comp$/);
  assert.equal(compactGoalTokens(1_000), "1k");
  assert.equal(compactGoalTokens(1_250_000), "1.3M");

  for (const width of [1, 8, 24, 48, 80]) {
    const narrow = renderGoalWidgetLines(view(goal({ abstract: "Long\u001b[31m unsafe\u001b[0m abstract\u0000 that must truncate" })), vtTheme, width, NOW_MS);
    assert.equal(narrow.length, 2);
    assert.ok(narrow.every((line) => visibleWidth(line) <= width));
    assert.ok(narrow.every((line) => !stripVTControlCharacters(line).includes("\u0000")));
  }
  assert.match(stripVTControlCharacters(renderGoalWidgetLines(view(), vtTheme, 80, NOW_MS)[0]), /^●  Goal · ↻  active/);
  assert.deepEqual(renderGoalWidgetLines(view(null, { elapsedMs: null }), theme, 80, NOW_MS), []);
});

test("Goal prefix marks pursuing versus idle across all five statuses and never joins Ctrl+O expansion", () => {
  const prefix = (status) => renderGoalWidgetLines(view(goal({ status })), roleAnsiTheme, 180, NOW_MS)[0].split(" \u001b[2m·")[0];

  assert.equal(prefix("active"), "\u001b[35m\u001b[1m●\u001b[22m\u001b[0m  \u001b[35m\u001b[1mGoal\u001b[22m\u001b[0m");
  assert.equal(prefix("retry_wait"), "\u001b[33m\u001b[1m●\u001b[22m\u001b[0m  \u001b[33m\u001b[1mGoal\u001b[22m\u001b[0m");
  for (const status of ["paused", "completed", "cancelled"]) {
    assert.equal(prefix(status), "\u001b[2m○\u001b[0m  \u001b[2mGoal\u001b[0m", `${status} must render a hollow dim prefix`);
    assert.doesNotMatch(prefix(status), /\u001b\[1m/, `${status} must not bold the Goal prefix`);
  }

  const completed = renderGoalWidgetLines(view(goal({ status: "completed" })), roleAnsiTheme, 180, NOW_MS)[0];
  assert.match(completed, /\u001b\[32m✓\u001b\[0m  \u001b\[32mcompleted\u001b\[0m/, "the status glyph and text keep their own status colour");
  const cancelled = renderGoalWidgetLines(view(goal({ status: "cancelled" })), roleAnsiTheme, 180, NOW_MS)[0];
  assert.match(cancelled, /\u001b\[31m×\u001b\[0m  \u001b\[31mcancelled\u001b\[0m/);
  assert.match(completed, /\u001b\[37mShip the frozen Goal UI\u001b\[0m$/, "the abstract keeps its existing text role");

  for (const status of ["active", "retry_wait", "paused", "completed", "cancelled"]) {
    for (const expanded of [true, false]) {
      assert.doesNotMatch(
        renderGoalWidgetLines(view(goal({ status })), theme, 180, NOW_MS, expanded).join("\n"),
        /to expand|ctrl\+o/i,
        `${status} must never append an expand hint`,
      );
    }
  }
  assert.equal(renderGoalWidgetLines.length, 3, "expansion stays an optional trailing argument, never a required one");
});

test("Collapsed tool output takes back only the completed Goal's detail row and never rewrites the view", () => {
  for (const status of ["active", "retry_wait", "paused", "completed", "cancelled"]) {
    const terminal = status === "completed" || status === "cancelled";
    const value = view(goal({
      status,
      pauseReason: status === "paused" ? "waiting for release approval" : null,
      retryAttempt: status === "retry_wait" ? 2 : 0,
      nextRetryAt: status === "retry_wait" ? "2026-06-01T00:12:30.000Z" : null,
      endedAt: terminal ? "2026-06-01T00:12:00.000Z" : null,
      evidence: status === "completed" ? ["one", "two"] : null,
      cancelReason: status === "cancelled" ? "user requested" : null,
    }));
    const before = structuredClone(value);
    const expanded = renderGoalWidgetLines(value, theme, 180, NOW_MS, true);
    const collapsed = renderGoalWidgetLines(value, theme, 180, NOW_MS, false);
    assert.deepEqual(renderGoalWidgetLines(value, theme, 180, NOW_MS), expanded, `${status} defaults to the full body`);
    assert.equal(expanded.length, 2, `${status} still renders two lines when expanded`);
    if (status === "completed") {
      assert.deepEqual(collapsed, [expanded[0]], "a finished Goal collapses to its heading alone");
      assert.match(collapsed[0], /^○  Goal · ✓  completed · Ship the frozen Goal UI$/);
    } else {
      assert.deepEqual(collapsed, expanded, `${status} is unfinished and keeps both rows while collapsed`);
    }
    assert.deepEqual(value, before, `${status} rendering writes nothing back into the view`);
  }

  for (const width of [1, 8, 24, 48, 180]) {
    const lines = renderGoalWidgetLines(
      view(goal({ status: "completed", abstract: "Long\u001b[31m unsafe\u001b[0m finished abstract\u0000 that must truncate" })),
      vtTheme,
      width,
      NOW_MS,
      false,
    );
    assert.equal(lines.length, 1);
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
    assert.ok(lines.every((line) => !stripVTControlCharacters(line).includes("\u0000")));
  }
  assert.deepEqual(renderGoalWidgetLines(view(null, { elapsedMs: null }), theme, 80, NOW_MS, false), []);
});

test("The Goal section reads Pi's live expansion state on every aggregate render and never re-registers for it", () => {
  let toolsExpanded = true;
  let current = view(goal({ status: "completed", endedAt: "2026-06-01T00:12:00.000Z", evidence: ["one", "two"] }));
  const calls = [];
  let component;
  const tui = { requestRender() {} };
  const ui = {
    theme,
    getToolsExpanded: () => toolsExpanded,
    setWidget(key, content, options) {
      calls.push({ key, content, options });
      if (typeof content === "function") component = content(tui, theme);
    },
  };
  const widget = new GoalWidget(() => current, {
    nowMs: () => NOW_MS,
    setInterval: (callback, milliseconds) => ({ callback, milliseconds, unref() {} }),
    clearInterval() {},
  });

  widget.setContext(ui);
  assert.equal(calls.length, 1);
  const registrations = calls.length;
  const body = () => renderLines(component, 180).filter((line) => line !== "");

  assert.equal(body().length, 2, "an expanded finished Goal keeps its detail row");
  toolsExpanded = false;
  assert.deepEqual(body(), ["○  Goal · ✓  completed · Ship the frozen Goal UI"]);
  toolsExpanded = true;
  assert.equal(body().length, 2, "expanding again restores the detail row from the live state, with no local copy");

  toolsExpanded = false;
  current = view();
  assert.equal(body().length, 2, "a Goal that is still being pursued is never hidden by the collapsed state");
  assert.equal(calls.length, registrations, "an expansion change redraws the aggregate instead of re-registering it");
  widget.dispose();
});

test("Goal detail row hangs off the heading with the shared dim last-child branch", () => {
  for (const status of ["active", "retry_wait", "paused", "completed", "cancelled"]) {
    const lines = renderGoalWidgetLines(view(goal({ status, pauseReason: status === "paused" ? "held" : null })), roleAnsiTheme, 180, NOW_MS);
    assert.equal(lines.length, 2, `${status} still renders exactly two lines`);
    assert.ok(
      lines[1].startsWith("\u001b[2m\u2514\u2500\u001b[0m "),
      `${status} must open the detail row with the dim last-child branch and one space`,
    );
    assert.doesNotMatch(
      stripVTControlCharacters(lines[0]),
      /[\u2514\u251c\u2502\u2500]/,
      `${status} heading stays the tree root and carries no branch glyph`,
    );
  }

  const plain = renderGoalWidgetLines(view(), theme, 180, NOW_MS);
  assert.equal(
    visibleWidth(stripVTControlCharacters(plain[1]).slice(0, 3)),
    3,
    "the branch prefix occupies three display columns, matching the Agents and Loops entries",
  );
});

test("GoalWidget uses one shared 1s timer, keeps cached rendering, clears empty state, rebinds, and disposes without duplicate setWidget", () => {
  let current = view(null, { elapsedMs: null });
  const intervals = [];
  const cleared = [];
  const firstCalls = [];
  const secondCalls = [];
  let renders = 0;
  let component;
  const widget = new GoalWidget(() => current, {
    nowMs: () => NOW_MS,
    setInterval(callback, milliseconds) {
      const timer = { callback, milliseconds, unrefCalled: false, unref() { this.unrefCalled = true; } };
      intervals.push(timer);
      return timer;
    },
    clearInterval(timer) { cleared.push(timer); },
  });
  const tui = { requestRender() { renders += 1; } };
  const ui = (calls) => ({
    theme,
    setWidget(key, content, options) {
      calls.push({ key, content, options });
      if (typeof content === "function") component = content(tui, theme);
    },
  });
  const first = ui(firstCalls);
  const second = ui(secondCalls);

  widget.setContext(first);
  assert.equal(firstCalls.length, 0);
  current = view();
  widget.update();
  widget.update();
  assert.equal(firstCalls.length, 1);
  assert.equal(firstCalls[0].key, WIDGET_STACK_KEY, "Goal joins the one aggregate widget instead of owning a key");
  assert.deepEqual(firstCalls[0].options, { placement: "aboveEditor" });
  assert.equal(intervals.length, 1);
  assert.equal(intervals[0].milliseconds, 1_000);
  assert.equal(intervals[0].unrefCalled, true);
  component.invalidate();
  const callsAfterInvalidate = firstCalls.length;
  intervals[0].callback();
  assert.equal(renders, 2, "one normal update and one timer render request");
  assert.equal(firstCalls.length, callsAfterInvalidate, "Component.invalidate is a no-op and does not re-register");

  widget.setContext(second);
  assert.equal(firstCalls.at(-1).content, undefined);
  assert.equal(secondCalls.length, 1);
  assert.equal(intervals.length, 2);
  assert.deepEqual(cleared, [intervals[0]]);

  current = view(null, { elapsedMs: null });
  widget.update();
  assert.equal(secondCalls.at(-1).content, undefined);
  assert.deepEqual(cleared, [intervals[0], intervals[1]]);
  widget.dispose();
  const clears = secondCalls.filter((call) => call.content === undefined).length;
  widget.dispose();
  assert.equal(secondCalls.filter((call) => call.content === undefined).length, clears);
});

function runtimeHarness(mode = "tui") {
  let now = NOW_MS;
  let branchReads = 0;
  let leaf = null;
  let sequence = 0;
  const branch = [];
  const tools = new Map();
  const renderers = new Map();
  const widgetCalls = [];
  const intervals = [];
  const cleared = [];
  let renderRequests = 0;
  let component;
  const pi = {
    registerTool(definition) { tools.set(definition.name, definition); },
    registerCommand() {},
    registerMessageRenderer(type, renderer) { renderers.set(type, renderer); },
    appendEntry(customType, data) {
      const entry = { type: "custom", id: `e${++sequence}`, parentId: leaf, customType, data: structuredClone(data) };
      branch.push(entry);
      leaf = entry.id;
    },
    sendMessage() {},
  };
  const tui = { requestRender() { renderRequests += 1; } };
  const ui = {
    theme,
    setWidget(key, content, options) {
      widgetCalls.push({ key, content, options });
      if (typeof content === "function") component = content(tui, theme);
    },
  };
  const ctx = {
    mode,
    ui,
    isIdle: () => false,
    hasPendingMessages: () => false,
    sessionManager: {
      getBranch() { branchReads += 1; return branch; },
      getSessionId: () => "session",
      getLeafId: () => leaf,
    },
  };
  const runtime = new GoalRuntime(pi, {
    nowMs: () => now,
    randomKey: () => "goal-ui-instance",
    defer() {},
    setInterval(callback, milliseconds) {
      const timer = { callback, milliseconds, unref() {} };
      intervals.push(timer);
      return timer;
    },
    clearInterval(timer) { cleared.push(timer); },
    childStats: (ids) => ({ runCount: ids.length, tokens: ids.length * 100, tools: ids.length, turns: ids.length, compactions: 0 }),
  });
  runtime.register();
  runtime.restore(ctx, false);
  runtime.setUICtx(mode === "tui" ? ui : undefined);
  return {
    runtime, ctx, tools, renderers, widgetCalls, intervals, cleared,
    get component() { return component; },
    get branchReads() { return branchReads; },
    get renderRequests() { return renderRequests; },
    advance(milliseconds) { now += milliseconds; },
  };
}

test("GoalRuntime registers package-isomorphic renderers, caches branch stats across timer ticks, refreshes lifecycle stats, rebinds, disposes, and never creates an RPC or print widget", async () => {
  for (const mode of ["rpc", "print"]) {
    const headless = runtimeHarness(mode);
    await headless.tools.get("goal").execute("call", {
      action: "create", abstract: `${mode} goal`, objective: "Stay headless", criteria: ["No widget"],
    });
    assert.equal(headless.widgetCalls.length, 0, `${mode === "rpc" ? "RPC" : "print"} no widget`);
    headless.runtime.shutdown();
  }

  const harness = runtimeHarness("tui");
  const tool = harness.tools.get("goal");
  assert.equal(tool.renderCall, renderGoalCall);
  assert.equal(tool.renderResult, renderGoalResult);
  assert.equal(harness.renderers.get(GOAL_CONTINUATION_MESSAGE_TYPE), renderGoalContinuation);
  assert.equal(harness.renderers.get(GOAL_STATE_MESSAGE_TYPE), renderGoalState);
  await tool.execute("call", {
    action: "create", abstract: "Cached Goal", objective: "Avoid timer scans", criteria: ["Cache stats"],
  });
  assert.equal(harness.widgetCalls.length, 1);
  assert.equal(harness.intervals.length, 1);
  const readsBeforeTick = harness.branchReads;
  const rendersBeforeTick = harness.renderRequests;
  harness.advance(1_000);
  harness.intervals[0].callback();
  harness.component.render(120);
  assert.equal(harness.branchReads, readsBeforeTick, "one shared 1s timer only updates time/countdown and requests render");
  assert.equal(harness.renderRequests, rendersBeforeTick + 1);

  const readsBeforeRefresh = harness.branchReads;
  harness.runtime.onToolExecutionStart();
  assert.ok(harness.branchReads > readsBeforeRefresh, "tool stats changes refresh the derived cache");
  harness.runtime.onAgentSettled(harness.ctx, { suppressContinuation: true });
  harness.runtime.notePackageLifecycleChange();
  harness.runtime.refreshFromBranch(harness.ctx);

  const oldUiCalls = harness.widgetCalls.length;
  const replacementCalls = [];
  const replacementUi = {
    theme,
    setWidget(key, content, options) { replacementCalls.push({ key, content, options }); },
  };
  harness.runtime.setUICtx(replacementUi);
  assert.equal(harness.widgetCalls.at(-1).content, undefined);
  assert.equal(replacementCalls.length, 1);
  assert.ok(harness.widgetCalls.length > oldUiCalls);
  harness.runtime.shutdown();
  assert.equal(replacementCalls.at(-1).content, undefined);
  assert.equal(harness.cleared.length, 2);
});

test("Goal tool renders all eight calls with uniform collapsed hints, action-specific expansion, and data invariance", () => {
  const cases = [
    {
      args: { action: "create", abstract: "Create\u001b[31m goal\u001b[0m", objective: "Full objective\nsecond", criteria: ["One", "Two"] },
      collapsed: ["Abstract: Create goal"], hidden: ["Full objective", "One", "Two"],
      expanded: ["Abstract:", "Create goal", "Objective:", "Full objective", "second", "Criteria:", "1. One", "2. Two"],
    },
    {
      args: { action: "modify", abstract: "Modify goal", objective: "Replacement objective", criteria: ["Replacement"] },
      collapsed: ["Abstract: Modify goal"], hidden: ["Replacement objective", "1. Replacement"],
      expanded: ["Abstract:", "Modify goal", "Objective:", "Replacement objective", "Criteria:", "1. Replacement"],
    },
    { args: { action: "status" }, collapsed: [], hidden: [], expanded: [] },
    { args: { action: "pause", reason: "Blocked\nby approval" }, collapsed: ["Reason: Blocked by approval"], hidden: [], expanded: ["Reason:", "Blocked", "by approval"] },
    { args: { action: "resume" }, collapsed: [], hidden: [], expanded: [] },
    { args: { action: "complete", evidence: ["Proof one", "Proof two"] }, collapsed: ["Evidence: 2 items"], hidden: ["Proof one", "Proof two"], expanded: ["Evidence:", "1. Proof one", "2. Proof two"] },
    { args: { action: "cancel", reason: "No longer needed" }, collapsed: ["Reason: No longer needed"], hidden: [], expanded: ["Reason:", "No longer needed"] },
    { args: { action: "clear" }, collapsed: [], hidden: [], expanded: [] },
  ];
  assert.deepEqual(
    cases.map((value) => value.args.action),
    ["create", "modify", "status", "pause", "resume", "complete", "cancel", "clear"],
    "every Goal action has a call rendering, including the branch-emptying clear",
  );
  for (const value of cases) {
    const before = structuredClone(value.args);
    const collapsed = render(renderGoalCall(value.args, theme, { expanded: false }));
    assert.equal(collapsed.split("\n")[0], `goal · ${value.args.action} (ctrl+o to expand)`);
    for (const expected of value.collapsed) assert.match(collapsed, escaped(expected));
    for (const hidden of value.hidden) assert.doesNotMatch(collapsed, escaped(hidden));
    assert.doesNotMatch(collapsed, /Action:|\u001b/);

    const expanded = render(renderGoalCall(value.args, theme, { expanded: true }));
    assert.equal(expanded.split("\n")[0], `goal · ${value.args.action}`);
    for (const expected of value.expanded) assert.match(expanded, escaped(expected));
    assert.doesNotMatch(expanded, /\(ctrl\+o to expand\)|Action:|\u001b/);
    assert.deepEqual(value.args, before);
  }

  const clearArgs = { action: "clear" };
  const clearBefore = structuredClone(clearArgs);
  assert.deepEqual(
    renderLines(renderGoalCall(clearArgs, theme, { expanded: false })).filter((line) => line !== ""),
    ["goal · clear (ctrl+o to expand)"],
    "a collapsed clear call is the title and nothing else",
  );
  assert.deepEqual(
    renderLines(renderGoalCall(clearArgs, theme, { expanded: true })).filter((line) => line !== ""),
    ["goal · clear"],
    "an expanded clear call invents no fields it was never given",
  );
  assert.deepEqual(clearArgs, clearBefore);
});

test("Goal clear receipts separate a real clear from an already empty branch, keep status none intact, and freeze model data", () => {
  const cleared = {
    content: [{ type: "text", text: "Goal cleared.\nThe branch has no Goal." }],
    details: { goal: null, changed: true },
  };
  const clearedBefore = structuredClone(cleared);
  const clearedCollapsed = renderGoalResult(cleared, { expanded: false }, theme, { args: { action: "clear" } });
  assertLeadingBlank(clearedCollapsed);
  assert.equal(render(clearedCollapsed), "✓  Goal · cleared");
  const clearedExpanded = render(renderGoalResult(cleared, { expanded: true }, theme, { args: { action: "clear" } }));
  assert.equal(clearedExpanded, "✓  Goal · cleared\nModel result:\n  Goal cleared.\n  The branch has no Goal.");
  assert.doesNotMatch(clearedExpanded, /Status:|Abstract:|Objective:|Criteria:|Cancel reason:|Criterion evidence:/);
  assert.match(
    renderGoalResult(cleared, { expanded: false }, roleAnsiTheme, { args: { action: "clear" } }).render(240).join("\n"),
    /\u001b\[32m✓\u001b\[0m {2}/,
    "a clear that removed a Goal reads as a completed change",
  );
  assert.deepEqual(cleared, clearedBefore);

  const unchanged = {
    content: [{ type: "text", text: "No Goal exists on the current branch. No change." }],
    details: { goal: null, changed: false },
  };
  const unchangedBefore = structuredClone(unchanged);
  assert.equal(render(renderGoalResult(unchanged, { expanded: false }, theme, { args: { action: "clear" } })), "○  Goal · none · no change");
  assert.match(
    render(renderGoalResult(unchanged, { expanded: true }, theme, { args: { action: "clear" } })),
    /^○  Goal · none · no change\nModel result:\n  No Goal exists on the current branch\. No change\.$/,
  );
  assert.match(
    renderGoalResult(unchanged, { expanded: false }, roleAnsiTheme, { args: { action: "clear" } }).render(240).join("\n"),
    /\u001b\[2m○\u001b\[0m {2}/,
    "a clear on an empty branch stays hollow and dim",
  );
  assert.deepEqual(unchanged, unchangedBefore);

  for (const changed of [false, true]) {
    const none = { content: [{ type: "text", text: "No Goal." }], details: { goal: null, changed } };
    assert.equal(
      render(renderGoalResult(none, { expanded: false }, theme, { args: { action: "status" } })),
      "○  Goal · none",
      "an ordinary empty status is untouched by the clear receipt",
    );
  }
});

test("A refused clear falls back to the tool's own error, stays width safe, and keeps the whole ask-the-user instruction", () => {
  const message = "clear requires a terminal Goal; the current Goal is active. Ask the user whether to complete or cancel it first.";
  const refused = { content: [{ type: "text", text: message }], details: { code: "invalid_action" } };
  const before = structuredClone(refused);
  for (const width of [24, 40, 80, 240]) {
    for (const expanded of [false, true]) {
      const lines = renderGoalResult(refused, { expanded, isError: true }, vtTheme, { args: { action: "clear" } }).render(width);
      assert.ok(lines.every((line) => visibleWidth(line) <= width), `width ${width} must not overflow`);
      const flat = lines.map((line) => stripVTControlCharacters(line).trim()).filter(Boolean).join(" ").replace(/\s+/g, " ");
      assert.equal(flat, message, `width ${width} wraps the refusal instead of cutting it`);
      assert.doesNotMatch(flat, /…/, "a refusal is never ellipsised away");
    }
  }
  assert.match(
    renderGoalResult(refused, { expanded: false, isError: true }, roleAnsiTheme, { args: { action: "clear" } }).render(240).join("\n"),
    /\u001b\[31m/,
    "a refused call reads as an error",
  );
  assert.deepEqual(refused, before);
});

test("Goal results cover active summaries, status none/goal, pause/resume no-change, evidence, cancel, retry fields, errors, fallback, and frozen model content", () => {
  const active = goal();
  const paused = goal({ status: "paused", pauseReason: "waiting for approval" });
  const completed = goal({ status: "completed", endedAt: "2026-06-01T00:12:00.000Z", evidence: ["Widget test", "Renderer test"] });
  const cancelled = goal({ status: "cancelled", endedAt: "2026-06-01T00:12:00.000Z", cancelReason: "user stopped it" });
  const retry = goal({ status: "retry_wait", retryAttempt: 2, nextRetryAt: "2026-06-01T00:12:30.000Z", lastProviderError: "rate limited" });
  const cases = [
    ["create", active, true, "↻  Goal · Ship the frozen Goal UI · active", goalActivationContent("created", active)],
    ["modify", active, true, "↻  Goal · Ship the frozen Goal UI · active", goalActivationContent("modified", active)],
    ["resume", active, true, "↻  Goal · Ship the frozen Goal UI · active", goalActivationContent("resumed", active)],
    ["resume", active, false, "○  Goal · Ship the frozen Goal UI · already active · no change", `Goal is already active. No change.\n${JSON.stringify(active, null, 2)}`],
    ["pause", paused, true, "Ⅱ  Goal · Ship the frozen Goal UI · paused · waiting for approval", `Goal paused.\n${JSON.stringify(paused, null, 2)}`],
    ["pause", paused, false, "○  Goal · Ship the frozen Goal UI · already paused · no change", `Goal is already paused. No change.\n${JSON.stringify(paused, null, 2)}`],
    ["complete", completed, true, "✓  Goal · Ship the frozen Goal UI · completed · 2 evidence items", `Goal completed.\n${JSON.stringify(completed, null, 2)}`],
    ["cancel", cancelled, true, "×  Goal · Ship the frozen Goal UI · cancelled · user stopped it", `Goal cancelled.\n${JSON.stringify(cancelled, null, 2)}`],
    ["status", retry, false, "◷  Goal · Ship the frozen Goal UI · retry_wait", JSON.stringify(retry, null, 2)],
  ];
  for (const [action, goalValue, changed, summary, modelText] of cases) {
    const result = { content: [{ type: "text", text: modelText }], details: { goal: structuredClone(goalValue), changed } };
    const before = structuredClone(result);
    const collapsedComponent = renderGoalResult(result, { expanded: false }, theme, { args: { action } });
    assertLeadingBlank(collapsedComponent);
    assert.equal(render(collapsedComponent), summary);
    const expandedComponent = renderGoalResult(result, { expanded: true }, theme, { args: { action } });
    assertLeadingBlank(expandedComponent);
    const expanded = render(expandedComponent);
    for (const expected of [summary, "Status:", "Abstract:", "Objective:", "Criteria:", "Created:", "Updated:", "Ended:", "Pause reason:", "Retry attempt:", "Next retry:", "Last provider error:", "No progress:", "Evidence:", "Cancel reason:", "Model result:"]) {
      assert.match(expanded, escaped(expected));
    }
    if (action === "complete") {
      for (const expected of ["Criterion evidence:", "1. Widget is exact", "✓  Widget test", "2. Renderers are safe", "✓  Renderer test"]) assert.match(expanded, escaped(expected));
    }
    if (goalValue.status === "retry_wait") {
      for (const expected of ["Retry attempt: 2", "Next retry: 2026-06-01T00:12:30.000Z", "rate limited"]) assert.match(expanded, escaped(expected));
    }
    assert.match(expanded, escaped(modelText.split("\n")[0]));
    assert.deepEqual(result, before);
  }

  const none = { content: [{ type: "text", text: "No Goal." }], details: { goal: null, changed: false } };
  assert.equal(render(renderGoalResult(none, { expanded: false }, theme, { args: { action: "status" } })), "○  Goal · none");
  assert.match(render(renderGoalResult(none, { expanded: true }, theme, { args: { action: "status" } })), /Model result:\n  No Goal\./);

  const fallback = { content: [{ type: "text", text: "Goal error\u001b[31m red\u001b[0m first\nComplete second\u0000 line" }], details: { malformed: true } };
  const fallbackBefore = structuredClone(fallback);
  const collapsedFallback = renderGoalResult(fallback, { expanded: false, isError: true }, theme, { args: { action: "modify" } });
  assertLeadingBlank(collapsedFallback);
  assert.equal(render(collapsedFallback), "Goal error red first");
  const expandedFallback = render(renderGoalResult(fallback, { expanded: true, isError: true }, theme, { args: { action: "modify" } }));
  assert.match(expandedFallback, /Goal error red first\nComplete second  line/);
  assert.deepEqual(fallback, fallbackBefore);
});

test("Goal continuation and state notifications preserve exact collapsed concepts, full expansion, fallback hints, width safety, and model data invariance", () => {
  const active = goal();
  const continuation = {
    content: goalContinuationContent(active),
    details: {
      type: GOAL_CONTINUATION_MESSAGE_TYPE,
      deliveryKey: "instance:3:1",
      continuationNumber: 7,
      goal: structuredClone(active),
    },
  };
  const continuationBefore = structuredClone(continuation);
  assert.equal(render(renderGoalContinuation(continuation, { expanded: false, outputPad: 1 }, theme)).trim(), "↻  Goal · Ship the frozen Goal UI · continuation 7 (ctrl+o to expand)");
  const continuationWide = renderGoalContinuation(continuation, { expanded: false, outputPad: 1 }, vtTheme).render(100);
  assert.ok(continuationWide.every((line) => visibleWidth(line) <= 100));
  const continuationNarrow = renderGoalContinuation(continuation, { expanded: false, outputPad: 1 }, vtTheme).render(50);
  assert.ok(continuationNarrow.every((line) => visibleWidth(line) <= 50));
  assert.match(continuationNarrow.map((line) => stripVTControlCharacters(line)).join("\n").trim(), /continuation 7 \(ctrl\+o to expand\)$/);
  const continuationExpanded = render(renderGoalContinuation(continuation, { expanded: true, outputPad: 1 }, theme));
  for (const expected of ["↻  Goal · continuation 7", "Status: active", "Objective:", "Criteria:", "Continuation content:", "Continue pursuing the active Goal.", "Call `goal complete`"]) assert.match(continuationExpanded, escaped(expected));
  assert.doesNotMatch(continuationExpanded, /\(ctrl\+o to expand\)/);
  assert.deepEqual(continuation, continuationBefore);

  const paused = goal({ status: "paused", pauseReason: "no_progress", noProgressCount: 3 });
  const state = {
    content: `Goal state changed: no_progress.\nReason: no_progress\n${JSON.stringify(paused, null, 2)}`,
    details: { type: GOAL_STATE_MESSAGE_TYPE, event: "no_progress", reason: "no_progress", goal: structuredClone(paused) },
  };
  const stateBefore = structuredClone(state);
  assert.equal(render(renderGoalState(state, { expanded: false, outputPad: 1 }, theme)).trim(), "Ⅱ  Goal · Ship the frozen Goal UI · no_progress: no_progress (ctrl+o to expand)");
  assert.doesNotMatch(render(renderGoalState(state, { expanded: false, outputPad: 1 }, theme)), /Ⅱ [^ ]|Ⅱ {3}/);
  const activeState = {
    content: "Goal state changed: resumed.",
    details: { type: GOAL_STATE_MESSAGE_TYPE, event: "resumed", reason: "manual resume", goal: structuredClone(active) },
  };
  assert.equal(render(renderGoalState(activeState, { expanded: false, outputPad: 1 }, theme)).trim(), "↻  Goal · Ship the frozen Goal UI · resumed: manual resume (ctrl+o to expand)");
  const stateExpanded = render(renderGoalState(state, { expanded: true, outputPad: 1 }, theme));
  for (const expected of ["Ⅱ  Goal · paused", "Event: no_progress", "Reason:", "no_progress", "Status: paused", "No progress: 3"]) assert.match(stateExpanded, escaped(expected));
  assert.doesNotMatch(stateExpanded, /\(ctrl\+o to expand\)/);
  assert.deepEqual(state, stateBefore);

  for (const renderer of [renderGoalContinuation, renderGoalState]) {
    const fallback = { content: "Legacy\u001b[31m first\u001b[0m\nLegacy full\u0000 second", details: { malformed: true } };
    const before = structuredClone(fallback);
    assert.equal(render(renderer(fallback, { expanded: false, outputPad: 1 }, theme)).trim(), "Legacy first (ctrl+o to expand)");
    const expanded = render(renderer(fallback, { expanded: true, outputPad: 1 }, theme));
    assert.match(expanded, /Legacy first\n ?Legacy full  second/);
    assert.doesNotMatch(expanded, /\(ctrl\+o to expand\)|\u001b|\u0000/);
    assert.deepEqual(fallback, before);
  }
});
