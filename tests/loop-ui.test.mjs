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
  "./loop-runtime.js": new URL("../extensions/oh-my-pi-slim/loop-runtime.ts", import.meta.url).href,
  "./loop-transcript-renderer.js": new URL("../extensions/oh-my-pi-slim/loop-transcript-renderer.ts", import.meta.url).href,
  "./loop-widget.js": new URL("../extensions/oh-my-pi-slim/loop-widget.ts", import.meta.url).href,
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
const { LoopRuntime } = await import("../extensions/oh-my-pi-slim/loop-runtime.ts");
const {
  renderLoopCall,
  renderLoopFire,
  renderLoopResult,
} = await import("../extensions/oh-my-pi-slim/loop-transcript-renderer.ts");
const {
  MAX_LOOP_WIDGET_LINES,
  LoopWidget,
  renderLoopWidgetLines,
} = await import("../extensions/oh-my-pi-slim/loop-widget.ts");
const {
  WIDGET_STACK_KEY,
  resetWidgetStackHost,
} = await import("../extensions/oh-my-pi-slim/widget-stack-host.ts");

beforeEach(() => resetWidgetStackHost());

const NOW_MS = Date.parse("2026-05-01T00:00:00.000Z");
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

function loop(overrides = {}) {
  return {
    id: "00000001",
    abstract: "Review the latest project state",
    prompt: "Read the full project state.\nThen report every relevant change.",
    interval: "10s",
    status: "active",
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z",
    nextFireAt: "2026-05-01T00:00:10.000Z",
    fireCount: 0,
    failureCount: 0,
    lastFiredAt: null,
    lastFailedAt: null,
    lastError: null,
    ...overrides,
  };
}

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

function escaped(value) {
  return new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
}

test("Loop widget renders exact heading, glyph priority, counts, order, and two-line entries", () => {
  const loops = [
    loop({ id: "00000001", abstract: "later", nextFireAt: "2026-05-01T00:00:30.000Z", fireCount: 2 }),
    loop({
      id: "00000002", abstract: "failed last time", nextFireAt: "2026-05-01T00:00:10.000Z",
      failureCount: 1, lastError: "queue unavailable", lastFailedAt: "2026-05-01T00:00:00.000Z",
    }),
    loop({ id: "00000003", abstract: "paused with old error", status: "paused", nextFireAt: null, lastError: "old", createdAt: "2026-04-30T23:59:00.000Z", fireCount: 1 }),
    loop({ id: "00000004", abstract: "middle", nextFireAt: "2026-05-01T00:00:20.000Z", fireCount: 1 }),
  ];
  const lines = renderLoopWidgetLines(loops, theme, 120, NOW_MS);
  assert.equal(lines[0], "●  Loops");
  assert.doesNotMatch(lines[0], /\(|\)|\d/, "the Loops heading carries no active/total ratio");
  assert.match(lines[1], /^├─ !  failed last time \[00000002\]$/);
  assert.equal(lines[2], "│  └─ Every 10s · next in 10s · 0 fires · 1 failure: queue unavailable");
  assert.match(lines[3], /^├─ ↻  middle \[00000004\]$/);
  assert.equal(lines[4], "│  └─ Every 10s · next in 20s · 1 fire");
  assert.match(lines[5], /^├─ ↻  later \[00000001\]$/);
  assert.equal(lines[6], "│  └─ Every 10s · next in 30s · 2 fires");
  assert.match(lines[7], /^└─ Ⅱ  paused with old error \[00000003\]$/);
  assert.doesNotMatch(lines.join("\n"), /[↻!Ⅱ●] [^ ]|[↻!Ⅱ●] {3}/);
  assert.equal(lines[8], "   └─ Every 10s · paused · 1 fire");
  assert.equal(lines.length, 9);
});

test("Loop heading drops the ratio, mirrors the Todo active and idle roles, and never joins Ctrl+O expansion", () => {
  const activeMix = [loop({ id: "00000001" }), loop({ id: "00000002", status: "paused", nextFireAt: null })];
  const allPaused = [
    loop({ id: "00000001", status: "paused", nextFireAt: null }),
    loop({ id: "00000002", status: "paused", nextFireAt: null, abstract: "second parked loop" }),
  ];

  assert.equal(renderLoopWidgetLines(activeMix, theme, 120, NOW_MS)[0], "●  Loops");
  assert.equal(
    renderLoopWidgetLines(activeMix, roleAnsiTheme, 120, NOW_MS)[0],
    "\u001b[35m\u001b[1m●\u001b[22m\u001b[0m  \u001b[35m\u001b[1mLoops\u001b[22m\u001b[0m",
  );

  assert.equal(renderLoopWidgetLines(allPaused, theme, 120, NOW_MS)[0], "○  Loops");
  const idle = renderLoopWidgetLines(allPaused, roleAnsiTheme, 120, NOW_MS);
  assert.equal(idle[0], "\u001b[2m○\u001b[0m  \u001b[2mLoops\u001b[0m");
  assert.doesNotMatch(idle[0], /\u001b\[1m/, "the idle Loops heading stays dim without bold emphasis");
  assert.doesNotMatch(idle.join("\n"), /\u001b\[35m/, "an all-paused Loops widget renders no accent role");

  const expandedBody = renderLoopWidgetLines(allPaused, theme, 120, NOW_MS);
  const collapsedBody = renderLoopWidgetLines(allPaused, theme, 120, NOW_MS);
  assert.deepEqual(collapsedBody, expandedBody, "Loops never filters rows and never appends an expand hint");
  assert.equal(collapsedBody.length, 5);
  assert.doesNotMatch(collapsedBody.join("\n"), /to expand|ctrl\+o/i);
  assert.doesNotMatch(renderLoopWidgetLines(activeMix, theme, 120, NOW_MS).join("\n"), /to expand|ctrl\+o/i);
  assert.equal(renderLoopWidgetLines.length, 3, "the Loops renderer takes no expansion parameters");
});

test("Loop widget caps at 12 lines, preserves entries atomically, and keeps IDs under width truncation", () => {
  const loops = Array.from({ length: 6 }, (_, index) => loop({
    id: `0000000${index + 1}`,
    abstract: `A very long abstract for loop number ${index + 1} that must be truncated safely`,
    nextFireAt: new Date(NOW_MS + (index + 1) * 10_000).toISOString(),
  }));
  const overflow = renderLoopWidgetLines(loops, theme, 80, NOW_MS);
  assert.equal(overflow.length, MAX_LOOP_WIDGET_LINES);
  assert.equal(overflow.at(-1), "└─ … 1 more");
  for (let index = 0; index < 5; index += 1) {
    assert.match(overflow.join("\n"), new RegExp(`\\[0000000${index + 1}\\]`));
  }
  assert.doesNotMatch(overflow.join("\n"), /\[00000006\]/);
  assert.equal(overflow.slice(1, -1).length % 2, 0);

  const wideAnsi = renderLoopWidgetLines([loops[0]], vtTheme, 80, NOW_MS);
  assert.ok(wideAnsi.every((line) => visibleWidth(line) <= 80));
  assert.match(stripVTControlCharacters(wideAnsi[1]), /^└─ ↻  /);
  const narrow = renderLoopWidgetLines([loops[0]], vtTheme, 28, NOW_MS);
  assert.ok(narrow.every((line) => visibleWidth(line) <= 28));
  assert.match(stripVTControlCharacters(narrow[1]), /… \[00000001\]$/);
  assert.equal(renderLoopWidgetLines([], theme, 80, NOW_MS).length, 0);
});

test("LoopWidget uses one shared 1s timer and clears widget and timer for empty, no UI, and dispose", () => {
  let loops = [];
  const intervals = [];
  const cleared = [];
  const widgetCalls = [];
  let renders = 0;
  let component;
  const widget = new LoopWidget(() => loops, {
    nowMs: () => NOW_MS,
    setInterval(callback, milliseconds) {
      const timer = { callback, milliseconds, token: Symbol("loop-ui") };
      intervals.push(timer);
      return timer;
    },
    clearInterval(timer) { cleared.push(timer); },
  });
  const tui = { requestRender() { renders += 1; } };
  const ui = {
    theme,
    setWidget(key, content, options) {
      widgetCalls.push({ key, content, options });
      if (typeof content === "function") component = content(tui, theme);
    },
  };

  widget.setContext(ui);
  assert.deepEqual(widgetCalls, []);
  assert.deepEqual(intervals, []);
  loops = [loop()];
  widget.update();
  widget.update();
  assert.equal(widgetCalls.length, 1);
  assert.equal(widgetCalls[0].key, WIDGET_STACK_KEY, "Loops joins the one aggregate widget instead of owning a key");
  assert.deepEqual(widgetCalls[0].options, { placement: "aboveEditor" });
  assert.equal(intervals.length, 1);
  assert.equal(intervals[0].milliseconds, 1_000);
  assert.deepEqual(component.render(80)[0], "●  Loops");
  component.invalidate();
  const registrationsAfterInvalidate = widgetCalls.length;
  const rendersAfterInvalidate = renders;
  intervals[0].callback();
  assert.equal(renders, rendersAfterInvalidate + 1, "cache invalidation keeps the live TUI handle for timer refreshes");
  assert.equal(widgetCalls.length, registrationsAfterInvalidate, "cache invalidation must not transfer or clear registration ownership");

  loops = [];
  widget.update();
  assert.equal(widgetCalls.at(-1).content, undefined);
  assert.deepEqual(cleared, [intervals[0]]);
  widget.setContext(undefined);
  assert.equal(intervals.length, 1);

  widget.setContext(ui);
  loops = [loop()];
  widget.update();
  assert.equal(intervals.length, 2);
  const clearsBeforeDispose = widgetCalls.filter((call) => call.content === undefined).length;
  widget.dispose();
  assert.equal(widgetCalls.at(-1).content, undefined);
  assert.equal(widgetCalls.filter((call) => call.content === undefined).length, clearsBeforeDispose + 1);
  widget.dispose();
  assert.equal(widgetCalls.filter((call) => call.content === undefined).length, clearsBeforeDispose + 1, "dispose clears an owned registration exactly once");
  assert.deepEqual(cleared, [intervals[0], intervals[1]]);
});

test("Loop runtime refreshes the foreground widget on mutations, tree rebinding, and fire success or failure", async () => {
  let now = NOW_MS;
  let failSend = false;
  const tools = new Map();
  const timers = [];
  const widgetCalls = [];
  let renders = 0;
  let component;
  const pi = {
    registerTool(definition) { tools.set(definition.name, definition); },
    registerMessageRenderer() {},
    sendMessage() {
      if (failSend) throw new Error("delivery unavailable");
    },
  };
  const runtime = new LoopRuntime(pi, {
    nowMs: () => now,
    randomHex: () => "00000001",
    setTimeout(callback, milliseconds) {
      const timer = { callback, milliseconds, cleared: false, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimeout(timer) { timer.cleared = true; },
    defer(callback) { callback(); },
  });
  runtime.registerTool();
  const tui = { requestRender() { renders += 1; } };
  const ui = {
    theme,
    setWidget(key, content, options) {
      widgetCalls.push({ key, content, options });
      if (typeof content === "function") component = content(tui, theme);
    },
  };
  runtime.setUICtx(ui);
  const execute = (params) => tools.get("loop").execute("call", params);

  await execute({ action: "create", interval: "10s", abstract: "runtime", prompt: "future" });
  assert.equal(widgetCalls.length, 1);
  const afterCreate = renders;
  await execute({ action: "modify", id: "00000001", abstract: "runtime changed" });
  await execute({ action: "pause", id: "00000001" });
  await execute({ action: "resume", id: "00000001" });
  assert.ok(renders >= afterCreate + 3);

  const beforeTree = renders;
  runtime.setUICtx(ui);
  runtime.refreshUI();
  assert.ok(renders >= beforeTree + 2);

  now += 10_000;
  timers.at(-1).callback();
  assert.match(stripVTControlCharacters(component.render(100).join("\n")), /↻  runtime changed \[00000001\]/);
  const afterSuccess = renders;
  failSend = true;
  now += 10_000;
  timers.at(-1).callback();
  const failedLines = stripVTControlCharacters(component.render(100).join("\n"));
  assert.ok(renders > afterSuccess);
  assert.match(failedLines, /!  runtime changed \[00000001\]/);
  assert.match(failedLines, /1 failure: delivery unavailable/);

  await execute({ action: "pause", id: "00000001" });
  await execute({ action: "delete", id: "00000001" });
  assert.equal(widgetCalls.at(-1).content, undefined);
  runtime.setUICtx(undefined);
  runtime.shutdown();
});

test("Loop tool calls render all seven actions with uniform collapsed hints and no duplicate Action rows", () => {
  const cases = [
    {
      args: { action: "create", interval: "10s", abstract: "Line one\nLine two\u0000", prompt: "Prompt one\nPrompt two" },
      collapsed: ["Interval: 10s", "Abstract: Line one Line two"],
      hidden: ["Prompt one", "Prompt two"],
      expanded: ["Interval: 10s", "Abstract:", "  Line one", "  Line two", "Prompt:", "  Prompt one", "  Prompt two"],
    },
    {
      args: { action: "modify", id: "00000001", interval: "1m", abstract: "New abstract\ncontinued", prompt: "New prompt\ncontinued" },
      collapsed: ["Loop: 00000001", "Interval: 1m", "Abstract: New abstract continued"],
      hidden: ["New prompt"],
      expanded: ["Loop: 00000001", "Interval: 1m", "Abstract:", "  New abstract", "  continued", "Prompt:", "  New prompt", "  continued"],
    },
    { args: { action: "delete", id: "00000001" }, collapsed: ["Loop: 00000001"], hidden: [], expanded: ["Loop: 00000001"] },
    { args: { action: "clear" }, collapsed: [], hidden: ["Loop:", "ID:"], expanded: [] },
    { args: { action: "pause", id: "00000001" }, collapsed: ["Loop: 00000001"], hidden: [], expanded: ["Loop: 00000001"] },
    { args: { action: "resume", id: "00000001" }, collapsed: ["Loop: 00000001"], hidden: [], expanded: ["Loop: 00000001"] },
    { args: { action: "list" }, collapsed: [], hidden: [], expanded: [] },
  ];

  assert.equal(cases.length, 7);
  for (const value of cases) {
    const before = structuredClone(value.args);
    const collapsed = render(renderLoopCall(value.args, theme, { expanded: false }));
    assert.equal(collapsed.split("\n")[0], `loop · ${value.args.action} (ctrl+o to expand)`);
    for (const expected of value.collapsed) assert.match(collapsed, escaped(expected));
    for (const hidden of value.hidden) assert.doesNotMatch(collapsed, escaped(hidden));
    assert.doesNotMatch(collapsed, /Action:/);

    const expanded = render(renderLoopCall(value.args, theme, { expanded: true }));
    assert.equal(expanded.split("\n")[0], `loop · ${value.args.action}`);
    for (const expected of value.expanded) assert.match(expanded, escaped(expected));
    assert.doesNotMatch(expanded, /\(ctrl\+o to expand\)|Action:|\u0000/);
    assert.deepEqual(value.args, before);
  }
});

test("Loop result rendering prioritizes details for all actions and falls back to compact JSON content", () => {
  const activeLoop = loop();
  const cases = [
    ["create", { loop: activeLoop, changed: true }, "✓  Created loop [00000001] · active"],
    ["modify", { loop: activeLoop, changed: true }, "✓  Modified loop [00000001] · active"],
    ["pause", { loop: { ...activeLoop, status: "paused", nextFireAt: null }, changed: true }, "✓  Paused loop [00000001] · paused"],
    ["resume", { loop: activeLoop, changed: true }, "✓  Resumed loop [00000001] · active"],
    ["delete", { id: "00000001", deleted: true }, "✓  Deleted loop [00000001]"],
    ["clear", { cleared: true, changed: true, clearedCount: 1, ids: ["00000001"] }, "✓  Cleared 1 loops"],
    ["list", { loops: [activeLoop] }, "●  Loops (1/1)"],
  ];

  for (const [action, details, receipt] of cases) {
    const fallback = JSON.stringify({ action, fallback: true });
    const result = { content: [{ type: "text", text: fallback }], details };
    for (const expanded of [false, true]) {
      const output = render(renderLoopResult(result, { expanded }, theme, { args: { action } }));
      assert.match(output, escaped(receipt));
      assert.doesNotMatch(output, escaped(fallback));
    }
  }

  for (const action of ["create", "modify", "pause", "resume", "delete", "clear", "list"]) {
    const fallback = JSON.stringify({ action, fallback: true });
    const result = { content: [{ type: "text", text: fallback }], details: {} };
    assert.equal(render(renderLoopResult(result, { expanded: false }, theme, { args: { action } })), fallback);
    assert.equal(render(renderLoopResult(result, { expanded: true }, theme, { args: { action } })), fallback);
  }
});

test("Loop mutation and list results render compact receipts, no-change, full hierarchy, errors, and blank separators", () => {
  const activeLoop = loop({
    fireCount: 2,
    failureCount: 1,
    lastFiredAt: "2026-05-01T00:00:20.000Z",
    lastFailedAt: "2026-05-01T00:00:10.000Z",
    lastError: "Full failure line one\nFull failure line two",
  });
  const cases = [
    ["create", { details: { loop: activeLoop, changed: true } }, "✓  Created loop [00000001] · active"],
    ["modify", { details: { loop: activeLoop, changed: true } }, "✓  Modified loop [00000001] · active"],
    ["pause", { details: { loop: { ...activeLoop, status: "paused", nextFireAt: null }, changed: true } }, "✓  Paused loop [00000001] · paused"],
    ["resume", { details: { loop: activeLoop, changed: true } }, "✓  Resumed loop [00000001] · active"],
    ["delete", { details: { id: "00000001", deleted: true } }, "✓  Deleted loop [00000001]"],
    ["pause", { details: { loop: { ...activeLoop, status: "paused", nextFireAt: null }, changed: false } }, "○  No change · loop [00000001]"],
  ];
  for (const [action, result, receipt] of cases) {
    const before = structuredClone(result);
    const collapsedComponent = renderLoopResult(result, { expanded: false }, theme, { args: { action } });
    assertBlankSeparator(collapsedComponent);
    assert.equal(render(collapsedComponent), receipt);
    const expandedComponent = renderLoopResult(result, { expanded: true }, theme, { args: { action } });
    assertBlankSeparator(expandedComponent);
    const expanded = render(expandedComponent);
    assert.match(expanded, escaped(receipt));
    if (action !== "delete") {
      for (const expected of [
        "Status:", "Interval: 10s", "Created: 2026-05-01T00:00:00.000Z", "Updated:",
        "Next fire:", "Fires: 2", "Failures: 1", "Last fired:", "Last failed:",
        "Last error:", "Full failure line one", "Full failure line two", "Abstract:", "Prompt:",
        "Read the full project state.", "Then report every relevant change.",
      ]) assert.match(expanded, escaped(expected));
    } else {
      assert.match(expanded, /Loop: 00000001/);
      assert.match(expanded, /Deleted: true/);
    }
    assert.deepEqual(result, before);
  }

  const listResult = { details: { loops: [activeLoop, loop({ id: "00000002", status: "paused", nextFireAt: null, abstract: "Paused loop" })] }, content: [{ type: "text", text: "model list" }] };
  const before = structuredClone(listResult);
  const collapsedComponent = renderLoopResult(listResult, { expanded: false }, theme, { args: { action: "list" } });
  assert.deepEqual(renderLines(collapsedComponent), ["", "●  Loops (1/2)"]);
  const expandedComponent = renderLoopResult(listResult, { expanded: true }, theme, { args: { action: "list" } });
  const expandedLines = renderLines(expandedComponent);
  assert.equal(expandedLines[1], "●  Loops (1/2)");
  assert.equal(expandedLines[2], "", "each expanded loop block starts after one blank line");
  const expanded = render(expandedComponent);
  assert.equal((expanded.match(/Prompt:/g) ?? []).length, 2);
  assert.match(expanded, /Full failure line two/);

  const emptyList = { details: { loops: [] } };
  assert.equal(render(renderLoopResult(emptyList, { expanded: false }, theme, { args: { action: "list" } })), "○  Loops (0/0)");
  assert.equal(render(renderLoopResult(emptyList, { expanded: true }, theme, { args: { action: "list" } })), "○  Loops (0/0)\nNo loops.");
  assert.deepEqual(listResult, before);
});

test("Loop clear receipts render before legacy fallback, stay compact and width-safe, and expand only public IDs", () => {
  const changed = {
    content: [{ type: "text", text: "RAW_CLEAR_MODEL_CONTENT_SENTINEL" }],
    details: {
      cleared: true,
      changed: true,
      clearedCount: 2,
      ids: ["00000001", "00000002"],
      privateTimerHandles: "PRIVATE_CLEAR_SENTINEL",
    },
  };
  const before = structuredClone(changed);
  const context = { args: { action: "clear" } };
  const collapsedComponent = renderLoopResult(changed, { expanded: false }, theme, context);
  assertBlankSeparator(collapsedComponent);
  assert.equal(render(collapsedComponent), "✓  Cleared 2 loops");
  for (const width of [8, 14, 24]) {
    assert.ok(collapsedComponent.render(width).every((line) => visibleWidth(line) <= width));
  }
  const expanded = render(renderLoopResult(changed, { expanded: true }, theme, context));
  assert.match(expanded, /✓  Cleared 2 loops/);
  assert.match(expanded, /Loop IDs:\n  • 00000001\n  • 00000002/);
  assert.doesNotMatch(expanded, /RAW_CLEAR_MODEL_CONTENT_SENTINEL|PRIVATE_CLEAR_SENTINEL|clearedCount|changed:/);
  assert.deepEqual(changed, before);

  const unchanged = {
    content: [{ type: "text", text: "RAW_NOOP_MODEL_CONTENT_SENTINEL" }],
    details: { cleared: true, changed: false, clearedCount: 0, ids: [] },
  };
  const unchangedBefore = structuredClone(unchanged);
  assert.equal(render(renderLoopResult(unchanged, { expanded: false }, theme, context)), "○  No loops to clear");
  assert.equal(render(renderLoopResult(unchanged, { expanded: true }, theme, context)), "○  No loops to clear");
  assert.doesNotMatch(render(renderLoopResult(unchanged, { expanded: true }, theme, context)), /RAW_NOOP_MODEL_CONTENT_SENTINEL/);
  assert.deepEqual(unchanged, unchangedBefore);
});

test("Loop error fallback keeps the complete safe refusal in collapsed and expanded views without mutation", () => {
  const result = {
    content: [{ type: "text", text: "Cannot clear active loops\u0000.\nAsk the user whether to pause these loops, then retry clear only if they agree." }],
    details: { legacy: true },
  };
  const before = structuredClone(result);
  const collapsedComponent = renderLoopResult(result, { expanded: false, isError: true }, theme, { args: { action: "clear" } });
  assertBlankSeparator(collapsedComponent);
  const collapsed = render(collapsedComponent, 38);
  const collapsedFlow = collapsed.replace(/\s+/g, " ");
  assert.match(collapsedFlow, /Cannot clear active loops \./);
  assert.match(collapsedFlow, /Ask the user whether to pause these loops, then retry clear only if they agree\./);
  assert.ok(collapsedComponent.render(38).every((line) => visibleWidth(line) <= 38));
  const expandedComponent = renderLoopResult(result, { expanded: true, isError: true }, theme, { args: { action: "clear" } });
  assertBlankSeparator(expandedComponent);
  assert.match(render(expandedComponent), /Cannot clear active loops \.\nAsk the user whether to pause these loops, then retry clear only if they agree\./);
  assert.deepEqual(result, before);
});

test("Loop fire renderer preserves compact target and suffix under width, expands full metadata, and safely falls back", () => {
  const message = {
    content: "Loop 00000001 fired.\nAbstract: complete\nPrompt:\nFull model prompt",
    details: {
      id: "00000001",
      abstract: "A long fire abstract that should shrink before its suffix disappears",
      interval: "10s",
      fireCount: 3,
      firedAt: "2026-05-01T00:00:30.000Z",
      prompt: "Full prompt line one\nFull prompt line two\u0000",
    },
  };
  const before = structuredClone(message);
  const collapsed = render(renderLoopFire(message, { expanded: false, outputPad: 1 }, theme)).trim();
  assert.equal(collapsed, "↻  Loop [00000001] · A long fire abstract that should shrink before its suffix disappears · fire 3 (ctrl+o to expand)");
  const wideAnsiLines = renderLoopFire(message, { expanded: false, outputPad: 1 }, vtTheme).render(120);
  assert.ok(wideAnsiLines.every((line) => visibleWidth(line) <= 120));
  const narrowLines = renderLoopFire(message, { expanded: false, outputPad: 1 }, vtTheme).render(55);
  assert.ok(narrowLines.every((line) => visibleWidth(line) <= 55));
  assert.match(narrowLines.map((line) => stripVTControlCharacters(line)).join("\n").trim(), /↻  Loop \[00000001\].* · fire 3 \(ctrl\+o to expand\)$/);

  const expanded = render(renderLoopFire(message, { expanded: true, outputPad: 1 }, theme));
  for (const expected of [
    "↻  Loop [00000001] · fire 3", "ID: 00000001", "Interval: 10s", "Fire: 3",
    "Fired at: 2026-05-01T00:00:30.000Z", "Abstract:", "A long fire abstract",
    "Prompt:", "Full prompt line one", "Full prompt line two",
  ]) assert.match(expanded, escaped(expected));
  assert.doesNotMatch(expanded, /\(ctrl\+o to expand\)|\u0000/);
  assert.deepEqual(message, before);

  const fallback = { content: "Legacy first\u0000 line\nLegacy full second", details: { id: "00000001", prompt: "missing fields" } };
  const fallbackBefore = structuredClone(fallback);
  assert.equal(render(renderLoopFire(fallback, { expanded: false, outputPad: 1 }, theme)).trim(), "Legacy first  line (ctrl+o to expand)");
  const fallbackExpanded = render(renderLoopFire(fallback, { expanded: true, outputPad: 1 }, theme));
  assert.match(fallbackExpanded, /Legacy first  line\n Legacy full second|Legacy first  line\nLegacy full second/);
  assert.doesNotMatch(fallbackExpanded, /\(ctrl\+o to expand\)/);
  assert.deepEqual(fallback, fallbackBefore);
});
