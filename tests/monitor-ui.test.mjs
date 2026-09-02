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
  "../tool-contracts.js": new URL("../extensions/oh-my-pi-slim/tool-contracts.ts", import.meta.url).href,
  "./runtime.js": new URL("../extensions/oh-my-pi-slim/monitor/runtime.ts", import.meta.url).href,
  "./widget.js": new URL("../extensions/oh-my-pi-slim/monitor/widget.ts", import.meta.url).href,
  "../semantic-glyph.js": new URL("../extensions/oh-my-pi-slim/semantic-glyph.ts", import.meta.url).href,
  "../widget-stack-host.js": new URL("../extensions/oh-my-pi-slim/widget-stack-host.ts", import.meta.url).href,
  "./widget-expansion.js": new URL("../extensions/oh-my-pi-slim/widget-expansion.ts", import.meta.url).href,
  "./widget-stack.js": new URL("../extensions/oh-my-pi-slim/widget-stack.ts", import.meta.url).href,
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    const url = dependencyMap[specifier];
    return url ? { url, shortCircuit: true } : nextResolve(specifier, context);
  },
});

const { visibleWidth } = await import("@earendil-works/pi-tui");
const {
  renderMonitorCall,
  renderMonitorNotification,
  renderMonitorResult,
} = await import("../extensions/oh-my-pi-slim/monitor/transcript-renderer.ts");
const { renderMonitorWidgetLines } = await import("../extensions/oh-my-pi-slim/monitor/widget.ts");
const { resetWidgetStackHost } = await import("../extensions/oh-my-pi-slim/widget-stack-host.ts");

beforeEach(() => resetWidgetStackHost());

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

function monitor(overrides = {}) {
  return {
    id: "00000001",
    abstract: "Errors in deploy.log",
    command: "tail -f deploy.log | grep --line-buffered ERROR",
    cwd: "/workspace/project",
    pid: 24680,
    status: "running",
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:02.000Z",
    lastOutputAt: "2026-05-01T00:00:02.000Z",
    endedAt: null,
    exitCode: null,
    signal: null,
    error: null,
    notificationCount: 2,
    logPath: "/workspace/.cache/00000001.jsonl",
    logBytes: 1024,
    logLines: 2,
    droppedBytes: 0,
    droppedLines: 0,
    returned: 2,
    omitted: 0,
    truncated: false,
    combined: [
      { seq: 1, timestamp: "2026-05-01T00:00:01.000Z", stream: "stdout", text: "ERROR one" },
      { seq: 2, timestamp: "2026-05-01T00:00:02.000Z", stream: "stderr", text: "diagnostic" },
    ],
    ...overrides,
  };
}

test("Monitor widget shows only retained process state and stays width safe", () => {
  const items = [
    { id: "00000001", abstract: "errors", status: "running", createdAt: "2026-05-01T00:00:00.000Z", endedAt: null },
    { id: "00000002", abstract: "finished", status: "completed", createdAt: "2026-05-01T00:00:00.000Z", endedAt: "2026-05-01T00:01:00.000Z" },
  ];
  const lines = renderMonitorWidgetLines(items, theme, 80);
  assert.match(lines[0], /Monitors \(1\/2\)/);
  assert.match(lines.join("\n"), /errors/);
  assert.doesNotMatch(lines.join("\n"), /finished/);
  for (const width of [8, 24, 48]) {
    assert.ok(renderMonitorWidgetLines(items, theme, width).every((line) => visibleWidth(line) <= width));
  }
});

test("Monitor calls render the five public actions without removed fields", () => {
  const cases = [
    { action: "create", abstract: "errors", command: "tail -f app.log", cwd: "/workspace" },
    { action: "list" },
    { action: "check", id: "00000001" },
    { action: "stop", id: "00000001" },
    { action: "clear" },
  ];
  for (const args of cases) {
    const before = structuredClone(args);
    const expanded = render(renderMonitorCall(args, theme, { cwd: "/workspace", expanded: true }));
    assert.match(expanded, new RegExp(`monitor · ${args.action}`));
    assert.doesNotMatch(expanded, /Check after|Notify on|Start|End|Window/);
    assert.deepEqual(args, before);
  }
  assert.match(render(renderMonitorCall(cases[0], theme, { expanded: true })), /tail -f app\.log/);
  assert.match(render(renderMonitorCall(cases[2], theme, { expanded: true })), /ID: 00000001/);
});

test("Monitor check, list, stop, and clear results render from details", () => {
  const state = monitor();
  const check = { content: [{ type: "text", text: "model check" }], details: { monitor: state } };
  const checkBefore = structuredClone(check);
  const collapsed = render(renderMonitorResult(check, { expanded: false }, theme, { args: { action: "check" } }));
  assert.match(collapsed, /Monitor \[00000001\].*running/);
  const expanded = render(renderMonitorResult(check, { expanded: true }, theme, { args: { action: "check" } }));
  for (const expected of ["Command:", "Notifications: 2", "Combined lines:", "[stdout] ERROR one", "[stderr] diagnostic"]) {
    assert.match(expanded, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.doesNotMatch(expanded, /Matchers|Matched|Suppressed|Check after/);
  assert.deepEqual(check, checkBefore);

  const list = { content: [{ type: "text", text: "[]" }], details: { monitors: [{ id: state.id, status: state.status, abstract: state.abstract }] } };
  assert.match(render(renderMonitorResult(list, { expanded: true }, theme, { args: { action: "list" } })), /Errors in deploy\.log/);

  const stoppedState = monitor({ status: "killed", endedAt: "2026-05-01T00:00:03.000Z", signal: "SIGTERM" });
  const stopped = { content: [{ type: "text", text: "{}" }], details: { monitor: stoppedState } };
  assert.match(render(renderMonitorResult(stopped, { expanded: false }, theme, { args: { action: "stop" } })), /killed/);

  const cleared = { content: [{ type: "text", text: "{}" }], details: { cleared: true, changed: true, clearedCount: 1, ids: [state.id], warnings: [] } };
  assert.match(render(renderMonitorResult(cleared, { expanded: false }, theme, { args: { action: "clear" } })), /Cleared 1 monitors/);
});

test("Monitor event and terminal notifications use one layout", () => {
  const event = {
    content: "Monitor 00000001 event",
    details: {
      id: "00000001",
      abstract: "Errors in deploy.log",
      kind: "update",
      status: "running",
      exitCode: null,
      signal: null,
      error: null,
      lines: [{ seq: 1, timestamp: "2026-05-01T00:00:01.000Z", stream: "stdout", text: "ERROR one" }],
      omitted: 0,
      truncated: false,
    },
  };
  const eventBefore = structuredClone(event);
  assert.match(render(renderMonitorNotification(event, { expanded: false, outputPad: 0 }, theme)), /running \(ctrl\+o to expand\)/);
  const expanded = render(renderMonitorNotification(event, { expanded: true, outputPad: 0 }, theme));
  assert.match(expanded, /Incremental lines:/);
  assert.match(expanded, /\[stdout\] ERROR one/);
  assert.doesNotMatch(expanded, /Matched|Silence|Rate limited/);
  assert.deepEqual(event, eventBefore);

  const terminal = {
    ...event,
    details: { ...event.details, status: "failed", exitCode: 2, error: "observer failed" },
  };
  const terminalExpanded = render(renderMonitorNotification(terminal, { expanded: true, outputPad: 0 }, theme));
  assert.match(terminalExpanded, /Status: failed/);
  assert.match(terminalExpanded, /Exit code: 2/);
  assert.match(terminalExpanded, /observer failed/);
});

test("Monitor renderer falls back to exact model text for malformed details", () => {
  const result = { content: [{ type: "text", text: "Monitor failed\u001b[31m now\u001b[0m\u0000.\nRetry later." }], details: { legacy: true } };
  const before = structuredClone(result);
  assert.match(render(renderMonitorResult(result, { expanded: false, isError: true }, theme, { args: { action: "clear" } })), /Monitor failed now \./);
  assert.doesNotMatch(render(renderMonitorResult(result, { expanded: true, isError: true }, theme, { args: { action: "clear" } })), /\u001b|\u0000/);
  assert.deepEqual(result, before);
});
