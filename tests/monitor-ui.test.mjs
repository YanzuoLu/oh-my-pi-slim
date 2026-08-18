import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname } from "node:path";
import { PassThrough } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { pathToFileURL } from "node:url";
import test from "node:test";

const piEntry = realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim());
const piRoot = dirname(dirname(piEntry));
const dependencyMap = {
  "@earendil-works/pi-coding-agent": pathToFileURL(`${piRoot}/dist/index.js`).href,
  "@earendil-works/pi-tui": pathToFileURL(`${piRoot}/node_modules/@earendil-works/pi-tui/dist/index.js`).href,
  typebox: pathToFileURL(`${piRoot}/node_modules/typebox/build/index.mjs`).href,
  "./monitor-runtime.js": new URL("../extensions/oh-my-pi-slim/monitor-runtime.ts", import.meta.url).href,
  "./monitor-transcript-renderer.js": new URL("../extensions/oh-my-pi-slim/monitor-transcript-renderer.ts", import.meta.url).href,
  "./monitor-widget.js": new URL("../extensions/oh-my-pi-slim/monitor-widget.ts", import.meta.url).href,
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    const url = dependencyMap[specifier];
    return url ? { url, shortCircuit: true } : nextResolve(specifier, context);
  },
});

const { visibleWidth } = await import("@earendil-works/pi-tui");
const {
  MONITOR_NOTIFICATION_TYPE,
  MonitorRuntime,
} = await import("../extensions/oh-my-pi-slim/monitor-runtime.ts");
const {
  renderMonitorCall,
  renderMonitorNotification,
  renderMonitorResult,
} = await import("../extensions/oh-my-pi-slim/monitor-transcript-renderer.ts");
const {
  MAX_MONITOR_WIDGET_LINES,
  MONITOR_RENDER_THROTTLE_MS,
  MONITOR_WIDGET_KEY,
  MonitorWidget,
  renderMonitorWidgetLines,
} = await import("../extensions/oh-my-pi-slim/monitor-widget.ts");

const theme = {
  fg: (_color, text) => text,
  bg: (_color, text) => text,
  bold: (text) => text,
};

function renderLines(component, width = 240) {
  return component.render(width).map((line) => stripVTControlCharacters(line).trimEnd());
}

function render(component, width = 240) {
  return renderLines(component, width).join("\n").replace(/^\n+|\n+$/g, "");
}

function assertBlankSeparator(component) {
  const lines = renderLines(component);
  assert.equal(lines[0], "");
  assert.notEqual(lines[1], "");
}

function monitor(overrides = {}) {
  return {
    id: "00000001",
    abstract: "Compile the release bundle",
    command: "npm run build\nprintf done",
    cwd: "/workspace/project",
    pid: 24680,
    status: "running",
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:02.000Z",
    endedAt: null,
    exitCode: null,
    signal: null,
    error: null,
    notifyOn: ["ready", "failed"],
    matchedCount: 3,
    notificationCount: 2,
    suppressedCount: 1,
    logPath: "/private/logs/00000001.jsonl",
    logBytes: 1024,
    logLines: 7,
    droppedBytes: 11,
    droppedLines: 1,
    start: 0,
    end: 100,
    returned: 2,
    omitted: 5,
    truncated: true,
    combined: [
      { seq: 6, timestamp: "2026-05-01T00:00:01.000Z", stream: "stdout", text: "ready\u001b[31m now" },
      { seq: 7, timestamp: "2026-05-01T00:00:02.000Z", stream: "stderr", text: "warning\u0000 line" },
    ],
    ...overrides,
  };
}

function widgetMonitor(overrides = {}) {
  return {
    id: "00000001",
    abstract: "Compile the release bundle",
    status: "running",
    createdAt: "2026-05-01T00:00:00.000Z",
    endedAt: null,
    ...overrides,
  };
}

function escaped(value) {
  return new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
}

function fakeChild(pid = 24680) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.unref = () => {};
  queueMicrotask(() => child.emit("spawn"));
  return child;
}

function closeChild(child, code = 0, signal = null) {
  child.stdout.end();
  child.stderr.end();
  child.emit("exit", code, signal);
  child.emit("close", code, signal);
}

test("Monitor widget renders exact heading, glyphs, running/terminal order, overflow, width safety, and empty state", () => {
  const monitors = [
    widgetMonitor({ id: "00000003", abstract: "terminal old", status: "completed", createdAt: "2026-04-30T00:00:00.000Z", endedAt: "2026-05-01T00:00:03.000Z" }),
    widgetMonitor({ id: "00000002", abstract: "running later", createdAt: "2026-05-01T00:00:02.000Z" }),
    widgetMonitor({ id: "00000004", abstract: "terminal newest", status: "failed", endedAt: "2026-05-01T00:00:05.000Z" }),
    widgetMonitor({ id: "00000001", abstract: "running first", createdAt: "2026-05-01T00:00:01.000Z" }),
    widgetMonitor({ id: "00000005", abstract: "terminal middle", status: "killed", endedAt: "2026-05-01T00:00:04.000Z" }),
  ];
  const lines = renderMonitorWidgetLines(monitors, theme, 100);
  assert.equal(lines[0], "● Monitors (2/5)");
  assert.equal(lines[1], "├─ ↻ running first [00000001] · running");
  assert.equal(lines[2], "├─ ↻ running later [00000002] · running");
  assert.equal(lines[3], "├─ ! terminal newest [00000004] · failed");
  assert.equal(lines[4], "├─ × terminal middle [00000005] · killed");
  assert.equal(lines[5], "└─ ✓ terminal old [00000003] · completed");

  const overflow = renderMonitorWidgetLines(Array.from({ length: 13 }, (_, index) => widgetMonitor({
    id: String(index + 1).padStart(8, "0"),
    abstract: `monitor ${index + 1}`,
    createdAt: new Date(Date.parse("2026-05-01T00:00:00.000Z") + index * 1000).toISOString(),
  })), theme, 80);
  assert.equal(overflow.length, MAX_MONITOR_WIDGET_LINES);
  assert.equal(overflow.at(-1), "└─ … 3 more");
  assert.match(overflow.join("\n"), /\[00000010\]/);
  assert.doesNotMatch(overflow.join("\n"), /\[00000011\]/);

  const vtTheme = {
    ...theme,
    fg: (_color, text) => `\u001b[36m${text}\u001b[0m`,
    bold: (text) => `\u001b[1m${text}\u001b[22m`,
  };
  const narrow = renderMonitorWidgetLines([widgetMonitor({ abstract: "An extremely long abstract with controls\u0000 and ANSI \u001b[31mred\u001b[0m" })], vtTheme, 38);
  const narrowPlain = narrow.map((line) => stripVTControlCharacters(line));
  assert.ok(narrow.every((line) => visibleWidth(line) <= 38));
  assert.match(narrowPlain[1], /↻ .*\[00000001\] · running$/);
  assert.doesNotMatch(narrowPlain.join("\n"), /\u001b|\u0000|\[31m/);
  assert.deepEqual(renderMonitorWidgetLines([], theme, 80), []);
});

test("MonitorWidget throttles and coalesces output, refreshes lifecycle immediately, registers once, keeps invalidate a no-op, rebinds, and disposes", () => {
  let monitors = [];
  const timers = [];
  const cleared = [];
  const callsA = [];
  const callsB = [];
  let rendersA = 0;
  let rendersB = 0;
  let componentA;
  let componentB;
  const tuiA = { requestRender() { rendersA += 1; } };
  const tuiB = { requestRender() { rendersB += 1; } };
  const uiA = {
    theme,
    setWidget(key, content, options) {
      callsA.push({ key, content, options });
      if (typeof content === "function") componentA = content(tuiA, theme);
    },
  };
  const uiB = {
    theme,
    setWidget(key, content, options) {
      callsB.push({ key, content, options });
      if (typeof content === "function") componentB = content(tuiB, theme);
    },
  };
  const widget = new MonitorWidget(() => monitors, {
    setTimeout(callback, milliseconds) {
      const timer = { callback, milliseconds, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimeout(timer) { cleared.push(timer); },
  });

  widget.setContext(uiA);
  widget.update();
  assert.deepEqual(callsA, []);
  monitors = [widgetMonitor()];
  widget.handleChange({ type: "created", reason: "lifecycle", id: "00000001", status: "running" });
  assert.equal(callsA.length, 1);
  assert.equal(callsA[0].key, MONITOR_WIDGET_KEY);
  assert.deepEqual(callsA[0].options, { placement: "aboveEditor" });
  componentA.invalidate();

  widget.handleChange({ type: "updated", reason: "output", id: "00000001", status: "running" });
  widget.handleChange({ type: "updated", reason: "output", id: "00000001", status: "running" });
  widget.handleChange({ type: "updated", reason: "output", id: "00000001", status: "running" });
  assert.equal(timers.length, 1);
  assert.equal(timers[0].milliseconds, MONITOR_RENDER_THROTTLE_MS);
  assert.equal(rendersA, 0);
  timers[0].callback();
  assert.equal(rendersA, 1);
  assert.equal(callsA.length, 1, "output refresh must not register the same widget again");

  widget.handleChange({ type: "updated", reason: "output", id: "00000001", status: "running" });
  widget.handleChange({ type: "updated", reason: "notification", id: "00000001", status: "running" });
  assert.equal(rendersA, 2, "notification count changes refresh immediately");
  assert.deepEqual(cleared, [timers[1]], "immediate refresh cancels pending output render");

  widget.setContext(uiA);
  widget.update();
  assert.equal(callsA.length, 1, "same UI context retains one registration");
  widget.setContext(uiB);
  assert.equal(callsA.at(-1).content, undefined);
  widget.update();
  assert.equal(callsB.length, 1);
  assert.equal(componentB.render(80)[0], "● Monitors (1/1)");

  monitors = [];
  widget.handleChange({ type: "deleted", reason: "lifecycle", id: "00000001" });
  assert.equal(callsB.at(-1).content, undefined);
  const clearsBeforeDispose = callsB.filter((call) => call.content === undefined).length;
  widget.dispose();
  widget.dispose();
  assert.equal(callsB.filter((call) => call.content === undefined).length, clearsBeforeDispose);
  assert.equal(rendersB, 0);
});

test("MonitorRuntime registers renderers, binds one foreground subscription, survives same-UI tree refresh, rebinds replacement UI, and disposes on reset", async () => {
  const tools = new Map();
  const renderers = new Map();
  const children = [];
  const widgetCallsA = [];
  const widgetCallsB = [];
  let rendersA = 0;
  let rendersB = 0;
  const ui = (calls, renderCounter) => ({
    theme,
    setWidget(key, content, options) {
      calls.push({ key, content, options });
      if (typeof content === "function") content({ requestRender() { renderCounter(); } }, theme);
    },
  });
  const uiA = ui(widgetCallsA, () => { rendersA += 1; });
  const uiB = ui(widgetCallsB, () => { rendersB += 1; });
  const runtime = new MonitorRuntime({
    registerTool(tool) { tools.set(tool.name, tool); },
    registerMessageRenderer(type, renderer) { renderers.set(type, renderer); },
    sendMessage() {},
  }, {
    randomHex: (() => { const ids = ["11111111", "22222222"]; return () => ids.shift(); })(),
    spawn() { const child = fakeChild(25000 + children.length); children.push(child); return child; },
    resolveShell: () => "/bin/bash",
  });
  runtime.registerTool();
  assert.equal(tools.get("monitor").renderCall, renderMonitorCall);
  assert.equal(tools.get("monitor").renderResult, renderMonitorResult);
  assert.equal(renderers.get(MONITOR_NOTIFICATION_TYPE), renderMonitorNotification);

  runtime.setUICtx(uiA);
  runtime.refreshUI();
  const execute = (params) => tools.get("monitor").execute("call", params, undefined, undefined, { cwd: process.cwd() });
  await execute({ action: "create", abstract: "runtime one", command: "unused" });
  assert.equal(widgetCallsA.filter((call) => typeof call.content === "function").length, 1);
  const rendersBeforeTree = rendersA;
  runtime.setUICtx(uiA);
  runtime.refreshUI();
  assert.equal(widgetCallsA.filter((call) => typeof call.content === "function").length, 1);
  assert.equal(rendersA, rendersBeforeTree + 1);

  runtime.setUICtx(uiB);
  runtime.refreshUI();
  assert.equal(widgetCallsA.at(-1).content, undefined);
  assert.equal(widgetCallsB.filter((call) => typeof call.content === "function").length, 1);
  const rendersBeforeTerminal = rendersB;
  closeChild(children[0]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(rendersB, rendersBeforeTerminal + 2, "one subscription handles terminal status and notification-count refresh exactly once each");

  await runtime.reset();
  assert.equal(widgetCallsB.at(-1).content, undefined);
  runtime.setUICtx(uiB);
  runtime.refreshUI();
  await execute({ action: "create", abstract: "runtime two", command: "unused" });
  assert.equal(widgetCallsB.filter((call) => typeof call.content === "function").length, 2, "session reset rebinds the cleared subscriber");
  closeChild(children[1]);
  await runtime.shutdown();
});

test("Monitor tool calls render all four actions with uniform hints, complete expansion, and no duplicate Action row", () => {
  const cases = [
    {
      args: { action: "create", abstract: "Build\nrelease\u0000", command: "npm run build\necho done", cwd: "/workspace", notifyOn: ["ready", "failed"] },
      collapsed: ["Abstract: Build release"],
      hidden: ["npm run build", "Cwd:", "Notify on:"],
      expanded: ["Abstract:", "Build", "release", "Command:", "npm run build", "echo done", "Cwd: /workspace", "Notify on:", "ready", "failed"],
    },
    { args: { action: "delete", id: "00000001" }, collapsed: ["ID: 00000001"], hidden: [], expanded: ["ID: 00000001"] },
    { args: { action: "list" }, collapsed: [], hidden: [], expanded: [] },
    { args: { action: "status", id: "00000001", start: 5, end: 25 }, collapsed: ["ID: 00000001", "Window: [5,25)"], hidden: ["Start:", "End:"], expanded: ["ID: 00000001", "Start: 5", "End: 25", "Window: [5,25)"] },
  ];
  for (const value of cases) {
    const before = structuredClone(value.args);
    const collapsed = render(renderMonitorCall(value.args, theme, { expanded: false, cwd: "/context" }));
    assert.equal(collapsed.split("\n")[0], `monitor · ${value.args.action} (ctrl+o to expand)`);
    for (const expected of value.collapsed) assert.match(collapsed, escaped(expected));
    for (const hidden of value.hidden) assert.doesNotMatch(collapsed, escaped(hidden));
    assert.doesNotMatch(collapsed, /Action:/);

    const expanded = render(renderMonitorCall(value.args, theme, { expanded: true, cwd: "/context" }));
    assert.equal(expanded.split("\n")[0], `monitor · ${value.args.action}`);
    for (const expected of value.expanded) assert.match(expanded, escaped(expected));
    assert.doesNotMatch(expanded, /\(ctrl\+o to expand\)|Action:|\u0000|\u001b/);
    assert.deepEqual(value.args, before);
  }
});

test("Monitor create/status/list/delete results render compact receipts, full operational state, forced warnings, separators, and preserve data", () => {
  const state = monitor();
  for (const action of ["create", "status"]) {
    const result = { content: [{ type: "text", text: "model content" }], details: { monitor: state } };
    const before = structuredClone(result);
    const collapsedComponent = renderMonitorResult(result, { expanded: false }, theme, { args: { action } });
    assertBlankSeparator(collapsedComponent);
    const collapsed = render(collapsedComponent);
    assert.match(collapsed, /^↻ Monitor \[00000001\] Compile the release bundle · running · 2 returned · 5 omitted · truncated$/);
    assert.doesNotMatch(collapsed, /Command:|Log path:|ready now/);

    const expandedComponent = renderMonitorResult(result, { expanded: true }, theme, { args: { action } });
    assertBlankSeparator(expandedComponent);
    const expanded = render(expandedComponent);
    for (const expected of [
      "Monitor [00000001] · Compile the release bundle · running", "Abstract:", "Command:", "npm run build", "printf done",
      "Cwd: /workspace/project", "PID: 24680", "Status: running", "Created:", "Updated:", "Ended: —",
      "Exit code: —", "Signal: —", "Error:", "Matchers:", "ready", "Matched: 3", "Notifications: 2",
      "Suppressed: 1", "Log path: /private/logs/00000001.jsonl", "Log bytes: 1024", "Log lines: 7",
      "Dropped bytes: 11", "Dropped lines: 1", "Window: [0,100)", "Returned: 2", "Omitted: 5",
      "Truncated: true", "Combined lines:", "[stdout] ready now", "[stderr] warning  line",
    ]) assert.match(expanded, escaped(expected));
    assert.doesNotMatch(expanded, /\u001b|\u0000/);
    assert.deepEqual(result, before);
  }

  const listResult = {
    content: [{ type: "text", text: "model list" }],
    details: { monitors: [
      { id: "00000001", status: "running", abstract: "first" },
      { id: "00000002", status: "completed", abstract: "second" },
      { id: "00000003", status: "failed", abstract: "third" },
      { id: "00000004", status: "killed", abstract: "fourth" },
    ] },
  };
  assertBlankSeparator(renderMonitorResult(listResult, { expanded: false }, theme, { args: { action: "list" } }));
  for (const expanded of [false, true]) {
    const text = render(renderMonitorResult(listResult, { expanded }, theme, { args: { action: "list" } }));
    assert.match(text, /^● Monitors \(1\/4\)/);
    for (const expected of ["↻ first [00000001] · running", "✓ second [00000002] · completed", "! third [00000003] · failed", "× fourth [00000004] · killed"]) {
      assert.match(text, escaped(expected));
    }
  }

  const normal = renderMonitorResult({ details: { id: "00000001", deleted: true, forced: false, warning: null } }, { expanded: false }, theme, { args: { action: "delete" } });
  assertBlankSeparator(normal);
  assert.equal(render(normal), "✓ Deleted monitor [00000001]");
  const forcedResult = { details: { id: "00000002", deleted: true, forced: true, warning: "Detached descendant may remain.\nInspect the process group." } };
  const forcedBefore = structuredClone(forcedResult);
  const forced = render(renderMonitorResult(forcedResult, { expanded: false }, theme, { args: { action: "delete" } }));
  assert.match(forced, /^! Forced deletion · monitor \[00000002\]/);
  assert.match(forced, /Detached descendant may remain\.\n  Inspect the process group\./);
  assert.deepEqual(forcedResult, forcedBefore);
});

test("Monitor matcher, terminal, and global summary notifications collapse exactly and expand complete bounded details without changing model content", () => {
  const incremental = monitor().combined;
  const matcher = {
    content: "MODEL MATCHER CONTENT MUST STAY UNCHANGED",
    details: { id: "00000001", abstract: "compile release", kind: "matcher", matched: ["ready", "done"], lines: incremental, omitted: 4, truncated: true },
  };
  const matcherBefore = structuredClone(matcher);
  assert.equal(render(renderMonitorNotification(matcher, { expanded: false, outputPad: 0 }, theme)).trim(), "↻ Monitor [00000001] · compile release · matched 2 (ctrl+o to expand)");
  const matcherNarrow = renderLines(renderMonitorNotification(matcher, { expanded: false, outputPad: 0 }, theme), 32);
  assert.ok(matcherNarrow.every((line) => visibleWidth(line) <= 32));
  assert.match(render(renderMonitorNotification(matcher, { expanded: false, outputPad: 0 }, theme), 32).trim(), /· matched 2 \(ctrl\+o to expand\)$/);
  const matcherExpanded = render(renderMonitorNotification(matcher, { expanded: true, outputPad: 0 }, theme));
  for (const expected of ["Matched:", "ready", "done", "Omitted: 4", "Truncated: true", "Incremental lines:", "[stdout] ready now", "[stderr] warning  line"]) {
    assert.match(matcherExpanded, escaped(expected));
  }
  assert.doesNotMatch(matcherExpanded, /\(ctrl\+o to expand\)|MODEL MATCHER CONTENT/);
  assert.deepEqual(matcher, matcherBefore);

  const terminalState = monitor({ status: "failed", endedAt: "2026-05-01T00:00:03.000Z", exitCode: 7, error: "build failed" });
  const terminal = {
    content: "MODEL TERMINAL CONTENT MUST STAY UNCHANGED",
    details: { id: "00000001", abstract: "compile release", kind: "terminal", status: terminalState, lines: incremental, omitted: 1, truncated: false },
  };
  const terminalBefore = structuredClone(terminal);
  assert.equal(render(renderMonitorNotification(terminal, { expanded: false, outputPad: 0 }, theme)).trim(), "! Monitor [00000001] · compile release · failed (ctrl+o to expand)");
  const terminalExpanded = render(renderMonitorNotification(terminal, { expanded: true, outputPad: 0 }, theme));
  for (const expected of ["Status: failed", "Exit code: 7", "Error:", "build failed", "Notification", "Log path:", "Combined lines:", "Incremental omitted: 1", "Incremental truncated: false", "Incremental lines:"]) {
    assert.match(terminalExpanded, escaped(expected));
  }
  assert.doesNotMatch(terminalExpanded, /\(ctrl\+o to expand\)|MODEL TERMINAL CONTENT/);
  assert.deepEqual(terminal, terminalBefore);
  for (const [status, glyph] of [["completed", "✓"], ["killed", "×"]]) {
    const state = monitor({ status, endedAt: "2026-05-01T00:00:03.000Z", exitCode: status === "completed" ? 0 : null, signal: status === "killed" ? "SIGTERM" : null });
    const text = render(renderMonitorNotification({
      content: `model ${status}`,
      details: { id: state.id, abstract: state.abstract, kind: "terminal", status: state, lines: [], omitted: 0, truncated: false },
    }, { expanded: false, outputPad: 0 }, theme)).trim();
    assert.equal(text, `${glyph} Monitor [00000001] · Compile the release bundle · ${status} (ctrl+o to expand)`);
  }

  const summary = {
    content: "MODEL SUMMARY CONTENT MUST STAY UNCHANGED",
    details: {
      kind: "summary",
      monitors: [
        { id: "00000001", abstract: "first", status: "running", suppressedBatches: 3, suppressedLines: 18 },
        { id: "00000002", abstract: "second", status: "killed", suppressedBatches: 2, suppressedLines: 9 },
      ],
      omittedMonitors: 1,
      truncated: true,
    },
  };
  const summaryBefore = structuredClone(summary);
  assert.equal(render(renderMonitorNotification(summary, { expanded: false, outputPad: 0 }, theme)).trim(), "! Monitors · rate limited (ctrl+o to expand)");
  const summaryExpanded = render(renderMonitorNotification(summary, { expanded: true, outputPad: 0 }, theme));
  for (const expected of ["Monitor [00000001] · first", "Suppressed batches: 3", "Suppressed lines: 18", "Monitor [00000002] · second", "Suppressed batches: 2", "Suppressed lines: 9", "Omitted monitors: 1", "Truncated: true"]) {
    assert.match(summaryExpanded, escaped(expected));
  }
  assert.doesNotMatch(summaryExpanded, /\(ctrl\+o to expand\)|MODEL SUMMARY CONTENT/);
  assert.deepEqual(summary, summaryBefore);
});

test("Monitor renderer fallbacks and errors sanitize controls, collapse width-safely, expand complete content, and do not mutate data", () => {
  const result = { content: [{ type: "text", text: "Failure\u001b[31m red\u001b[0m\u0000 first\nComplete second\nComplete third" }], details: { legacy: true } };
  const before = structuredClone(result);
  const collapsedComponent = renderMonitorResult(result, { expanded: false, isError: true }, theme, { args: { action: "status" } });
  assertBlankSeparator(collapsedComponent);
  assert.equal(render(collapsedComponent, 30), "Failure red  first");
  const expanded = render(renderMonitorResult(result, { expanded: true, isError: true }, theme, { args: { action: "status" } }));
  assert.match(expanded, /Failure red  first\nComplete second\nComplete third/);
  assert.doesNotMatch(expanded, /\u001b|\u0000/);
  assert.deepEqual(result, before);

  const message = { content: "Legacy\u001b[31m red\u001b[0m first\nLegacy complete second", details: { kind: "terminal", malformed: true } };
  const messageBefore = structuredClone(message);
  assert.equal(render(renderMonitorNotification(message, { expanded: false, outputPad: 0 }, theme), 80).trim(), "Legacy red first (ctrl+o to expand)");
  const messageExpanded = render(renderMonitorNotification(message, { expanded: true, outputPad: 0 }, theme));
  assert.match(messageExpanded, /Legacy red first\nLegacy complete second/);
  assert.doesNotMatch(messageExpanded, /\(ctrl\+o to expand\)/);
  assert.deepEqual(message, messageBefore);
});

test("Monitor keeps model-facing list data invariant and never registers a foreground widget without a TUI context", async () => {
  const tools = new Map();
  const widgetCalls = [];
  let child;
  const runtime = new MonitorRuntime({
    registerTool(tool) { tools.set(tool.name, tool); },
    registerMessageRenderer() {},
    sendMessage() {},
  }, {
    randomHex: () => "abcdef12",
    spawn() { child = fakeChild(); return child; },
    resolveShell: () => "/bin/bash",
  });
  runtime.registerTool();
  runtime.setUICtx(undefined);
  runtime.refreshUI();
  const created = await tools.get("monitor").execute("call", { action: "create", abstract: "rpc monitor", command: "unused" }, undefined, undefined, { cwd: process.cwd(), mode: "rpc", ui: { setWidget(...args) { widgetCalls.push(args); } } });
  const listed = await tools.get("monitor").execute("call", { action: "list" }, undefined, undefined, { cwd: process.cwd(), mode: "rpc" });
  assert.deepEqual(Object.keys(listed.details.monitors[0]).sort(), ["abstract", "id", "status"]);
  assert.equal(listed.details.monitors[0].id, created.details.monitor.id);
  assert.deepEqual(widgetCalls, []);
  closeChild(child);
  await runtime.shutdown();
});
