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
  "./semantic-glyph.js": new URL("../extensions/oh-my-pi-slim/semantic-glyph.ts", import.meta.url).href,
  "./widget-expansion.js": new URL("../extensions/oh-my-pi-slim/widget-expansion.ts", import.meta.url).href,
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    const url = dependencyMap[specifier];
    return url ? { url, shortCircuit: true } : nextResolve(specifier, context);
  },
});

const { KeybindingsManager, setKeybindings, TUI_KEYBINDINGS, visibleWidth } = await import("@earendil-works/pi-tui");
const { widgetExpandHint } = await import("../extensions/oh-my-pi-slim/widget-expansion.ts");
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
const roleAnsiTheme = {
  fg: (color, text) => {
    const code = { accent: 35, dim: 2, success: 32, text: 37, muted: 90, warning: 33, error: 31 }[color] ?? 39;
    return `\u001b[${code}m${text}\u001b[0m`;
  },
  bg: (_color, text) => text,
  bold: (text) => `\u001b[1m${text}\u001b[22m`,
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

const DEFAULT_HINT = " · ctrl+o to expand";

/** Installs a user-configured `app.tools.expand` binding so the hint proves it reads the live keymap. */
function withConfiguredExpandKey(keys, body) {
  setKeybindings(new KeybindingsManager(
    { ...TUI_KEYBINDINGS, "app.tools.expand": { defaultKeys: "ctrl+o", description: "Toggle tool output" } },
    { "app.tools.expand": keys },
  ));
  try { body(); } finally { setKeybindings(null); }
}

function withBrokenKeybindings(body) {
  setKeybindings({ getKeys() { throw new Error("keybindings unavailable"); } });
  try { body(); } finally { setKeybindings(null); }
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
  assert.equal(lines[0], "●  Monitors");
  assert.doesNotMatch(lines[0], /\(|\)|\d/, "the Monitors heading carries no running/total ratio");
  assert.equal(lines[1], "├─ ↻  running first [00000001] · running");
  assert.equal(lines[2], "├─ ↻  running later [00000002] · running");
  assert.equal(lines[3], "├─ !  terminal newest [00000004] · failed");
  assert.equal(lines[4], "├─ ×  terminal middle [00000005] · killed");
  assert.equal(lines[5], "└─ ✓  terminal old [00000003] · completed");
  assert.doesNotMatch(lines.join("\n"), /[↻!×✓●○] [^ ]|[↻!×✓●○] {3}/);
  assert.match(lines.slice(1).join("\n"), /^├─ |\n(?:├─ |└─ )/);

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
  const wide = renderMonitorWidgetLines([widgetMonitor()], vtTheme, 100);
  assert.ok(wide.every((line) => visibleWidth(line) <= 100));
  assert.match(stripVTControlCharacters(wide[1]), /^└─ ↻  /);
  const narrow = renderMonitorWidgetLines([widgetMonitor({ abstract: "An extremely long abstract with controls\u0000 and ANSI \u001b[31mred\u001b[0m" })], vtTheme, 38);
  const narrowPlain = narrow.map((line) => stripVTControlCharacters(line));
  assert.ok(narrow.every((line) => visibleWidth(line) <= 38));
  assert.match(narrowPlain[1], /↻  .*\[00000001\] · running$/);
  assert.doesNotMatch(narrowPlain.join("\n"), /\u001b|\u0000|\[31m/);
  assert.deepEqual(renderMonitorWidgetLines([], theme, 80), []);
});

test("Monitor collapsed body keeps only running rows, adds one atomic dim expand hint, and never touches the expanded body", () => {
  const mixed = [
    widgetMonitor({ id: "00000001", abstract: "running first", createdAt: "2026-05-01T00:00:01.000Z" }),
    widgetMonitor({ id: "00000002", abstract: "running later", createdAt: "2026-05-01T00:00:02.000Z" }),
    widgetMonitor({ id: "00000003", abstract: "terminal done", status: "completed", endedAt: "2026-05-01T00:00:03.000Z" }),
    widgetMonitor({ id: "00000004", abstract: "terminal broken", status: "failed", endedAt: "2026-05-01T00:00:04.000Z" }),
    widgetMonitor({ id: "00000005", abstract: "terminal stopped", status: "killed", endedAt: "2026-05-01T00:00:05.000Z" }),
  ];

  assert.deepEqual(renderMonitorWidgetLines(mixed, theme, 100, true, DEFAULT_HINT), renderMonitorWidgetLines(mixed, theme, 100));
  assert.deepEqual(renderMonitorWidgetLines(mixed, theme, 100, false, DEFAULT_HINT), [
    "●  Monitors · ctrl+o to expand",
    "├─ ↻  running first [00000001] · running",
    "└─ ↻  running later [00000002] · running",
  ]);

  const runningOnly = mixed.filter((monitor) => monitor.status === "running");
  assert.deepEqual(
    renderMonitorWidgetLines(runningOnly, theme, 100, false, DEFAULT_HINT),
    renderMonitorWidgetLines(runningOnly, theme, 100),
    "a collapsed widget with nothing hidden shows no hint at all",
  );

  const terminalOnly = mixed.filter((monitor) => monitor.status !== "running");
  assert.deepEqual(renderMonitorWidgetLines(terminalOnly, theme, 100, false, DEFAULT_HINT), ["○  Monitors · ctrl+o to expand"]);
  assert.equal(renderMonitorWidgetLines(terminalOnly, theme, 100, true, DEFAULT_HINT).length, 4);
});

test("Monitor expand hint stays one dim non-bold segment, uses the configured key, and drops whole when the width is tight", () => {
  const mixed = [
    widgetMonitor({ id: "00000001", abstract: "running first" }),
    widgetMonitor({ id: "00000003", abstract: "terminal done", status: "completed", endedAt: "2026-05-01T00:00:03.000Z" }),
  ];
  const terminalOnly = [mixed[1]];
  const dimHint = "\u001b[2m · ctrl+o to expand\u001b[0m";

  const activeHeading = renderMonitorWidgetLines(mixed, roleAnsiTheme, 100, false, DEFAULT_HINT)[0];
  assert.equal(
    activeHeading,
    `\u001b[35m\u001b[1m●\u001b[22m\u001b[0m  \u001b[35m\u001b[1mMonitors\u001b[22m\u001b[0m${dimHint}`,
  );
  const idleHeading = renderMonitorWidgetLines(terminalOnly, roleAnsiTheme, 100, false, DEFAULT_HINT)[0];
  assert.equal(idleHeading, `\u001b[2m○\u001b[0m  \u001b[2mMonitors\u001b[0m${dimHint}`);
  assert.ok(
    activeHeading.endsWith(dimHint) && idleHeading.endsWith(dimHint),
    "the hint renders identically in the active and idle heading states",
  );
  assert.doesNotMatch(activeHeading.slice(activeHeading.indexOf(dimHint)), /\u001b\[1m/, "the hint is never bold");

  withConfiguredExpandKey("ctrl+shift+e", () => {
    assert.equal(widgetExpandHint(), " · ctrl+shift+e to expand");
    assert.equal(
      renderMonitorWidgetLines(mixed, theme, 100, false, widgetExpandHint())[0],
      "●  Monitors · ctrl+shift+e to expand",
    );
  });
  assert.equal(widgetExpandHint(), DEFAULT_HINT, "an unconfigured keymap falls back to Pi's default binding");
  withBrokenKeybindings(() => {
    assert.equal(widgetExpandHint(), DEFAULT_HINT, "a failing keybinding registry falls back without breaking widget render");
  });

  const full = "●  Monitors · ctrl+o to expand";
  assert.equal(renderMonitorWidgetLines(mixed, theme, full.length, false, DEFAULT_HINT)[0], full);
  for (const width of [1, 4, 8, 11, 20, full.length - 1]) {
    const heading = renderMonitorWidgetLines(mixed, theme, width, false, DEFAULT_HINT)[0];
    assert.ok(visibleWidth(heading) <= width, `width ${width} must stay inside the terminal`);
    assert.doesNotMatch(heading, /·|expand|ctrl/, `width ${width} must drop the whole hint, never half of it`);
  }
});

test("Monitor overflow counts only visible running rows and ignores policy-hidden terminal monitors", () => {
  const monitors = [
    ...Array.from({ length: 12 }, (_, index) => widgetMonitor({
      id: String(index + 1).padStart(8, "0"),
      abstract: `running ${index + 1}`,
      createdAt: new Date(Date.parse("2026-05-01T00:00:00.000Z") + index * 1000).toISOString(),
    })),
    ...Array.from({ length: 4 }, (_, index) => widgetMonitor({
      id: String(index + 20).padStart(8, "0"),
      abstract: `terminal ${index + 1}`,
      status: "completed",
      endedAt: new Date(Date.parse("2026-05-01T00:01:00.000Z") + index * 1000).toISOString(),
    })),
  ];

  const expanded = renderMonitorWidgetLines(monitors, theme, 80, true, DEFAULT_HINT);
  assert.equal(expanded.length, MAX_MONITOR_WIDGET_LINES);
  assert.equal(expanded.at(-1), "└─ … 6 more");

  const collapsed = renderMonitorWidgetLines(monitors, theme, 80, false, DEFAULT_HINT);
  assert.equal(collapsed[0], "●  Monitors · ctrl+o to expand");
  assert.equal(collapsed.at(-1), "└─ … 2 more", "only the two budget-hidden running rows are summarised");
  assert.doesNotMatch(collapsed.join("\n"), /terminal /, "policy-hidden terminal rows never reach the body");
  assert.equal(collapsed.length, MAX_MONITOR_WIDGET_LINES);
});

test("MonitorWidget reads Pi's live expansion state on every render without re-registering the widget", () => {
  let expanded = true;
  const monitors = [
    widgetMonitor({ id: "00000001", abstract: "running first" }),
    widgetMonitor({ id: "00000009", abstract: "terminal done", status: "completed", endedAt: "2026-05-01T00:00:03.000Z" }),
  ];
  const calls = [];
  let component;
  const tui = { requestRender() {} };
  const ui = {
    theme,
    getToolsExpanded: () => expanded,
    setWidget(key, content, options) {
      calls.push({ key, content, options });
      component = typeof content === "function" ? content(tui, theme) : undefined;
    },
  };
  const widget = new MonitorWidget(() => monitors, {
    setTimeout(callback, milliseconds) { return { callback, milliseconds, unref() {} }; },
    clearTimeout() {},
  });

  widget.setContext(ui);
  widget.update();
  assert.equal(calls.length, 1);
  assert.equal(component.render(100).length, 3);

  expanded = false;
  assert.deepEqual(component.render(100), ["●  Monitors · ctrl+o to expand", "└─ ↻  running first [00000001] · running"]);
  assert.equal(calls.length, 1, "Ctrl+O must not re-register the widget");

  expanded = true;
  assert.equal(component.render(100).length, 3, "Ctrl+O toggles straight back to the full body");
  assert.equal(calls.length, 1);

  const legacyCalls = [];
  let legacyComponent;
  const legacyWidget = new MonitorWidget(() => monitors, {
    setTimeout(callback, milliseconds) { return { callback, milliseconds, unref() {} }; },
    clearTimeout() {},
  });
  legacyWidget.setContext({
    theme,
    setWidget(key, content) {
      legacyCalls.push({ key, content });
      legacyComponent = typeof content === "function" ? content(tui, theme) : undefined;
    },
  });
  legacyWidget.update();
  assert.equal(legacyComponent.render(100).length, 3, "a host without getToolsExpanded stays expanded");
  assert.doesNotMatch(legacyComponent.render(100).join("\n"), /to expand/);
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
  assert.equal(componentB.render(80)[0], "●  Monitors");

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
    assert.match(collapsed, /^↻  Monitor \[00000001\] Compile the release bundle · running · 2 returned · 5 omitted · truncated$/);
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
    assert.match(text, /^●  Monitors \(1\/4\)/);
    for (const expected of ["↻  first [00000001] · running", "✓  second [00000002] · completed", "!  third [00000003] · failed", "×  fourth [00000004] · killed"]) {
      assert.match(text, escaped(expected));
    }
    assert.doesNotMatch(text, /[↻✓!×●] [^ ]|[↻✓!×●] {3}/);
  }

  const normal = renderMonitorResult({ details: { id: "00000001", deleted: true, forced: false, warning: null } }, { expanded: false }, theme, { args: { action: "delete" } });
  assertBlankSeparator(normal);
  assert.equal(render(normal), "✓  Deleted monitor [00000001]");
  const forcedResult = { details: { id: "00000002", deleted: true, forced: true, warning: "Detached descendant may remain.\nInspect the process group." } };
  const forcedBefore = structuredClone(forcedResult);
  const forced = render(renderMonitorResult(forcedResult, { expanded: false }, theme, { args: { action: "delete" } }));
  assert.match(forced, /^!  Forced deletion · monitor \[00000002\]/);
  assert.match(forced, /Detached descendant may remain\.\n  Inspect the process group\./);
  assert.deepEqual(forcedResult, forcedBefore);
});

test("Monitor unified update notifications collapse by status and expand one incremental layout without full operational state", () => {
  const incremental = monitor().combined;
  const update = (overrides = {}) => ({
    id: "00000001",
    abstract: "compile release",
    kind: "update",
    status: "running",
    matched: [],
    exitCode: null,
    signal: null,
    error: null,
    lines: incremental,
    omitted: 0,
    truncated: false,
    ...overrides,
  });

  const running = {
    content: "MODEL RUNNING CONTENT MUST STAY UNCHANGED",
    details: update({ matched: ["ready", "done"], omitted: 4, truncated: true }),
  };
  const runningBefore = structuredClone(running);
  assert.equal(render(renderMonitorNotification(running, { expanded: false, outputPad: 0 }, theme)).trim(), "↻  Monitor [00000001] · compile release · running · matched 2 (ctrl+o to expand)");
  const runningNarrow = renderLines(renderMonitorNotification(running, { expanded: false, outputPad: 0 }, theme), 32);
  assert.ok(runningNarrow.every((line) => visibleWidth(line) <= 32));
  assert.match(runningNarrow.join("\n").trim(), /\(ctrl\+o to expand\)$/, "a tight width sheds the abstract but never the expand hint");
  assert.match(render(renderMonitorNotification(running, { expanded: false, outputPad: 0 }, theme), 44).trim(), /· matched 2 \(ctrl\+o to expand\)$/);
  const runningExpanded = render(renderMonitorNotification(running, { expanded: true, outputPad: 0 }, theme));
  for (const expected of ["Status: running", "Matched:", "ready", "done", "Omitted: 4", "Truncated: true", "Incremental lines:", "[stdout] ready now", "[stderr] warning  line"]) {
    assert.match(runningExpanded, escaped(expected));
  }
  assert.doesNotMatch(runningExpanded, /Exit code:|Signal:|Error:/, "a running update carries no terminal verdict rows");
  assert.doesNotMatch(runningExpanded, /\(ctrl\+o to expand\)|MODEL RUNNING CONTENT|\u001b|\u0000/);
  assert.deepEqual(running, runningBefore);

  const quiet = { content: "model quiet", details: update({ lines: [] }) };
  assert.equal(render(renderMonitorNotification(quiet, { expanded: false, outputPad: 0 }, theme)).trim(), "↻  Monitor [00000001] · compile release · running (ctrl+o to expand)");
  assert.match(render(renderMonitorNotification(quiet, { expanded: true, outputPad: 0 }, theme)), /Incremental lines:\n  —/);

  for (const [status, glyph, exitCode, signal, error] of [
    ["completed", "✓", 0, null, null],
    ["failed", "!", 7, null, "build failed"],
    ["killed", "×", null, "SIGTERM", null],
  ]) {
    const message = {
      content: `MODEL ${status.toUpperCase()} CONTENT MUST STAY UNCHANGED`,
      details: update({ status, exitCode, signal, error, omitted: 1 }),
    };
    const before = structuredClone(message);
    assert.equal(render(renderMonitorNotification(message, { expanded: false, outputPad: 0 }, theme)).trim(), `${glyph}  Monitor [00000001] · compile release · ${status} (ctrl+o to expand)`);
    const expanded = render(renderMonitorNotification(message, { expanded: true, outputPad: 0 }, theme));
    for (const expectedRow of [
      `Status: ${status}`, "Matched:", `Exit code: ${exitCode ?? "—"}`, `Signal: ${signal ?? "—"}`,
      "Error:", error ?? "—", "Omitted: 1", "Truncated: false", "Incremental lines:", "[stdout] ready now",
    ]) assert.match(expanded, escaped(expectedRow));
    assert.doesNotMatch(
      expanded,
      /PID:|Cwd:|Command:|Log path:|Log bytes:|Log lines:|Combined lines:|Notifications:|Suppressed:|Dropped bytes:|Window:|Returned:|Matchers:/,
      "a terminal update never embeds notification stats, log paths, combined lines, or full operational state",
    );
    assert.doesNotMatch(expanded, /\(ctrl\+o to expand\)|CONTENT MUST STAY UNCHANGED|\u001b|\u0000/);
    assert.deepEqual(message, before);
  }

  const ansiCollapsed = renderMonitorNotification(running, { expanded: false, outputPad: 0 }, roleAnsiTheme).render(240);
  assert.match(stripVTControlCharacters(ansiCollapsed.join("\n")).trim(), /^↻ {2}Monitor \[00000001\] · compile release · running · matched 2/);
  for (const width of [24, 40, 120]) {
    const lines = renderMonitorNotification(running, { expanded: false, outputPad: 0 }, roleAnsiTheme).render(width);
    assert.ok(lines.every((line) => visibleWidth(line) <= width), `collapsed update must fit width ${width}`);
  }
});

test("Monitor legacy matcher, legacy terminal, and global summary notifications still render complete bounded details without changing model content", () => {
  const incremental = monitor().combined;
  const matcher = {
    content: "MODEL MATCHER CONTENT MUST STAY UNCHANGED",
    details: { id: "00000001", abstract: "compile release", kind: "matcher", matched: ["ready", "done"], lines: incremental, omitted: 4, truncated: true },
  };
  const matcherBefore = structuredClone(matcher);
  assert.equal(render(renderMonitorNotification(matcher, { expanded: false, outputPad: 0 }, theme)).trim(), "↻  Monitor [00000001] · compile release · matched 2 (ctrl+o to expand)");
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
  assert.equal(render(renderMonitorNotification(terminal, { expanded: false, outputPad: 0 }, theme)).trim(), "!  Monitor [00000001] · compile release · failed (ctrl+o to expand)");
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
    assert.equal(text, `${glyph}  Monitor [00000001] · Compile the release bundle · ${status} (ctrl+o to expand)`);
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
  assert.equal(render(renderMonitorNotification(summary, { expanded: false, outputPad: 0 }, theme)).trim(), "!  Monitors · rate limited (ctrl+o to expand)");
  const summaryExpanded = render(renderMonitorNotification(summary, { expanded: true, outputPad: 0 }, theme));
  assert.match(summaryExpanded, /^!  Monitors · rate limited\n↻  Monitor \[00000001\]/);
  assert.match(summaryExpanded, /\n×  Monitor \[00000002\]/);
  assert.doesNotMatch(summaryExpanded, /[↻!×] [^ ]|[↻!×] {3}/);
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

  for (const kind of ["terminal", "update", "matcher", undefined]) {
    const message = { content: "Legacy\u001b[31m red\u001b[0m first\nLegacy complete second", details: { kind, malformed: true } };
    const messageBefore = structuredClone(message);
    assert.equal(render(renderMonitorNotification(message, { expanded: false, outputPad: 0 }, theme), 80).trim(), "Legacy red first (ctrl+o to expand)");
    const messageExpanded = render(renderMonitorNotification(message, { expanded: true, outputPad: 0 }, theme));
    assert.match(messageExpanded, /Legacy red first\nLegacy complete second/);
    assert.doesNotMatch(messageExpanded, /\(ctrl\+o to expand\)/);
    assert.deepEqual(message, messageBefore);
  }
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
