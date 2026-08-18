import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { pathToFileURL } from "node:url";
import test from "node:test";

const piEntry = realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim());
const piRoot = dirname(dirname(piEntry));
const dependencyMap = {
  "@earendil-works/pi-tui": pathToFileURL(`${piRoot}/node_modules/@earendil-works/pi-tui/dist/index.js`).href,
  "./subagent-core.js": new URL("../extensions/oh-my-pi-slim/subagent-core.ts", import.meta.url).href,
  "./subagent-model-display.js": new URL("../extensions/oh-my-pi-slim/subagent-model-display.ts", import.meta.url).href,
  "./subagent-widget-renderer.js": new URL("../extensions/oh-my-pi-slim/subagent-widget-renderer.ts", import.meta.url).href,
  "./subagent-widget-display.js": new URL("../extensions/oh-my-pi-slim/subagent-widget-display.ts", import.meta.url).href,
  "./subagent-widget-glyphs.js": new URL("../extensions/oh-my-pi-slim/subagent-widget-glyphs.ts", import.meta.url).href,
  "./subagent-run-files.js": new URL("../extensions/oh-my-pi-slim/subagent-run-files.ts", import.meta.url).href,
  "./semantic-glyph.js": new URL("../extensions/oh-my-pi-slim/semantic-glyph.ts", import.meta.url).href,
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    const url = dependencyMap[specifier];
    return url ? { url, shortCircuit: true } : nextResolve(specifier, context);
  },
});

const { visibleWidth } = await import("@earendil-works/pi-tui");
const {
  SubagentRegistry,
  restoreRunJournal,
  sortRetainedSubagentRuns,
} = await import("../extensions/oh-my-pi-slim/subagent-core.ts");
const { SubagentWidget, assembleSubagentWidgetState } = await import("../extensions/oh-my-pi-slim/subagent-widget.ts");
const {
  MAX_SUBAGENT_WIDGET_LINES,
  formatWidgetModel,
  renderActiveRunLines,
  renderFinishedRunLine,
  renderSubagentWidgetLines,
} = await import("../extensions/oh-my-pi-slim/subagent-widget-renderer.ts");

const NOW_MS = Date.parse("2026-04-17T00:00:00.000Z");
const theme = {
  fg: (_color, text) => text,
  bold: (text) => `**${text}**`,
};
const vtTheme = {
  fg: (_color, text) => `\u001b[36m${text}\u001b[0m`,
  bold: (text) => `\u001b[1m${text}\u001b[22m`,
};

function run(overrides = {}) {
  return {
    id: "run-1",
    agent: "fixer",
    abstract: "implement the widget",
    task: "full implementation details",
    cwd: "/repo",
    model: "provider/model:high",
    deniedTools: [],
    status: "completed",
    createdAt: "2026-04-16T23:59:55.000Z",
    updatedAt: "2026-04-17T00:00:00.000Z",
    ...overrides,
  };
}

test("widget state treats starting as queued and waiting as active", () => {
  assert.deepEqual(assembleSubagentWidgetState([
    run({ id: "q", status: "starting" }),
    run({ id: "r", status: "running" }),
    run({ id: "w", status: "waiting" }),
    run({ id: "f", status: "failed" }),
  ]), {
    runningCount: 1,
    waitingCount: 1,
    queuedCount: 1,
    hasFinished: true,
    hasActive: true,
  });
});

test("model formatter parses provider and known thinking suffixes with safe fallbacks", () => {
  for (const thinking of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
    assert.equal(formatWidgetModel(`openai/gpt-5.6-sol:${thinking}`), `(openai) gpt-5.6-sol • ${thinking}`);
  }
  assert.equal(formatWidgetModel("provider/model:variant:max"), "(provider) model:variant • max");
  assert.equal(formatWidgetModel("anthropic/claude-opus-4-6"), "(anthropic) claude-opus-4-6");
  assert.equal(formatWidgetModel("custom/model:experimental"), "(custom) model:experimental");
  assert.equal(formatWidgetModel("model-without-provider:high"), "model-without-provider:high");
  assert.equal(formatWidgetModel("/missing-provider:high"), "/missing-provider:high");
});

test("shared retained sorting keeps list, restored state, and widget IDs in active, starting, terminal-newest parity", () => {
  const runs = [
    run({ id: "termold", status: "completed", createdAt: "2026-04-16T23:50:00.000Z", updatedAt: "2026-04-16T23:55:00.000Z" }),
    run({ id: "runlate", status: "running", createdAt: "2026-04-16T23:52:00.000Z", updatedAt: "2026-04-17T00:00:00.000Z" }),
    run({ id: "termnew", status: "failed", createdAt: "2026-04-16T23:51:00.000Z", updatedAt: "2026-04-16T23:59:00.000Z", error: "new failure" }),
    run({ id: "starting", status: "starting", createdAt: "2026-04-16T23:49:00.000Z" }),
    run({ id: "waitone", status: "waiting", createdAt: "2026-04-16T23:48:00.000Z" }),
  ];
  const expectedIds = ["waitone", "runlate", "starting", "termnew", "termold"];
  assert.deepEqual(sortRetainedSubagentRuns(runs).map((item) => item.id), expectedIds);

  const registry = new SubagentRegistry();
  for (const value of runs) registry.add(value, value.status === "running" || value.status === "waiting");
  assert.deepEqual(registry.list().map((item) => item.id), expectedIds);
  assert.deepEqual(restoreRunJournal([{ version: 1, runs }]).runs.map((item) => item.id), expectedIds);

  const widgetLines = renderSubagentWidgetLines({ runs, spinnerFrame: 0, terminalWidth: 240, theme, nowMs: NOW_MS });
  const widgetIds = widgetLines
    .filter((line) => /^(?:├─|└─) /.test(line))
    .map((line) => /\[([^\]]+)\]/.exec(line)?.[1])
    .filter(Boolean);
  assert.deepEqual(widgetIds, expectedIds);
  assert.ok(widgetLines.indexOf(widgetLines.find((line) => line.includes("[starting]"))) < widgetLines.indexOf(widgetLines.find((line) => line.includes("[termnew]"))));

  const ties = [
    run({ id: "terminal-b", status: "completed", createdAt: "2026-04-16T23:50:00.000Z", updatedAt: "2026-04-16T23:59:00.000Z" }),
    run({ id: "terminal-a", status: "failed", createdAt: "2026-04-16T23:50:00.000Z", updatedAt: "2026-04-16T23:59:00.000Z" }),
    run({ id: "waiting-b", status: "waiting", createdAt: "2026-04-16T23:48:00.000Z" }),
    run({ id: "running-a", status: "running", createdAt: "2026-04-16T23:48:00.000Z" }),
  ];
  assert.deepEqual(sortRetainedSubagentRuns(ties).map((item) => item.id), ["running-a", "waiting-b", "terminal-a", "terminal-b"]);
});

test("pure active renderer uses three exact lines and terminal renderers keep outcome icons", () => {
  const [runningHeader, runningStats, runningActivity] = renderActiveRunLines(
    run({ status: "running", model: "openai/gpt-5.6-sol:xhigh", updatedAt: "2026-04-16T23:59:56.000Z" }),
    0,
    theme,
    NOW_MS,
  );
  assert.equal(runningHeader, "⠋  **fixer [run-1]**  implement the widget");
  assert.equal(runningStats, "(openai) gpt-5.6-sol • xhigh · ↻  0 · 5.0s");
  assert.equal(runningActivity, "thinking…");
  assert.doesNotMatch(runningHeader, /↻|tool use|token|5\.0s/);
  assert.match(runningStats, /^\(openai\) gpt-5\.6-sol • xhigh · ↻  0/);

  const [waitingHeader, waitingStats, waitingActivity] = renderActiveRunLines(run({
    status: "waiting",
    model: "openai/gpt-5.6-sol:xhigh",
    request: { runId: "run-1", reason: "need_decision", message: "Choose A or B", createdAt: "now" },
  }), 3, theme, NOW_MS);
  assert.equal(waitingHeader, "!  **fixer [run-1]** waiting  implement the widget");
  assert.equal(waitingStats, "(openai) gpt-5.6-sol • xhigh · ↻  0 · 5.0s");
  assert.doesNotMatch(`${runningHeader}\n${waitingHeader}\n${runningStats}`, /[⠋!↻] [^ ]|[⠋!↻] {3}/);
  assert.equal(waitingActivity, "Choose A or B");

  assert.match(renderFinishedRunLine(run({ status: "completed" }), theme, NOW_MS), /✓/);
  assert.match(renderFinishedRunLine(run({ status: "failed", error: "boom" }), theme, NOW_MS), /✗.*failed: boom/);
  assert.match(renderFinishedRunLine(run({ status: "interrupted" }), theme, NOW_MS), /✗.*interrupted/);
});

test("activity formatting keeps model first, then stats, tools, response, tokens, context, and compactions", () => {
  const [toolHeader, toolStats, toolActivity] = renderActiveRunLines(run({
    status: "running",
    model: "openai/gpt-5.6-sol:minimal",
    activity: {
      turnCount: 3,
      toolUses: 2,
      activeTools: { a: { name: "read" }, b: { name: "grep" }, c: { name: "grep" } },
      responseText: "ignored while tools run",
      tokens: 12345,
      contextPercent: 72,
      compactionCount: 2,
    },
  }), 0, theme, NOW_MS);
  assert.equal(toolHeader, "⠋  **fixer [run-1]**  implement the widget");
  assert.equal(toolStats, "(openai) gpt-5.6-sol • minimal · ↻  3 · 2 tool uses · 12.3k token (72% · ⇊  2) · 5.0s");
  assert.equal(toolActivity, "reading, searching 2 patterns…");

  const [, responseStats, responseActivity] = renderActiveRunLines(run({
    status: "running",
    activity: {
      turnCount: 1, toolUses: 0, activeTools: {},
      responseText: "A concise response line that is visible\nsecond line",
      tokens: 0, compactionCount: 0,
    },
  }), 0, theme, NOW_MS);
  assert.equal(responseStats, "(provider) model • high · ↻  1 · 5.0s");
  assert.equal(responseActivity, "A concise response line that is visible");
});

test("pure widget renderer preserves the three-line active tree and queued summary", () => {
  const lines = renderSubagentWidgetLines({
    runs: [
      run({ id: "done", status: "completed" }),
      run({ id: "live", status: "running", model: "openai/gpt-5.6-sol:xhigh", updatedAt: "2026-04-16T23:59:56.000Z" }),
      run({ id: "queue", status: "starting" }),
    ],
    spinnerFrame: 0,
    terminalWidth: 200,
    theme,
    nowMs: NOW_MS,
  });
  assert.deepEqual(lines, [
    "●  Agents",
    "├─ ⠋  **fixer [live]**  implement the widget",
    "│  ├─ (openai) gpt-5.6-sol • xhigh · ↻  0 · 5.0s",
    "│  └─ thinking…",
    "├─ ◦  fixer [queue]  implement the widget · ↻  0 · 5.0s queued",
    "└─ ✓  fixer [done]  implement the widget · ↻  0 · 5.0s",
  ]);
  assert.doesNotMatch(lines.join("\n"), /[●⠋↻◦✓] [^ ]|[●⠋↻◦✓] {3}/);
  assert.match(lines.slice(1).join("\n"), /^├─ /, "tree connectors keep their structural separator");

  for (const terminalWidth of [24, 80]) {
    const ansiLines = renderSubagentWidgetLines({
      runs: [run({ id: "ansi", status: "running", model: "openai/gpt-5.6-sol:xhigh" })],
      spinnerFrame: 0,
      terminalWidth,
      theme: vtTheme,
      nowMs: NOW_MS,
    });
    assert.ok(ansiLines.every((line) => visibleWidth(line) <= terminalWidth));
    if (terminalWidth === 80) assert.match(ansiLines.map((line) => stripVTControlCharacters(line)).join("\n"), /↻  0 · 5\.0s/);
  }
});

test("pure widget renderer caps at 12 lines, keeps active entries atomic, and reports overflow exactly", () => {
  const runs = [];
  for (let index = 0; index < 5; index += 1) {
    runs.push(run({
      id: `active-${index}`,
      status: index === 0 ? "waiting" : "running",
      model: "openai/gpt-5.6-sol:xhigh",
    }));
  }
  runs.push(run({ id: "queue-0", status: "starting" }));
  runs.push(run({ id: "queue-1", status: "starting" }));
  runs.push(run({ id: "finished-0", status: "completed" }));
  runs.push(run({ id: "finished-1", status: "completed" }));
  const lines = renderSubagentWidgetLines({
    runs,
    spinnerFrame: 0,
    terminalWidth: 200,
    theme,
    nowMs: NOW_MS,
  });
  assert.equal(lines.length, MAX_SUBAGENT_WIDGET_LINES);
  assert.match(lines[1], /active-0.*waiting/);
  assert.match(lines[2], /^│  ├─ \(openai\) gpt-5\.6-sol • xhigh · ↻  0/);
  assert.equal(lines[3], "│  └─ supervisor reply required");
  assert.match(lines[4], /active-1/);
  assert.match(lines[7], /active-2/);
  assert.doesNotMatch(lines.join("\n"), /active-3|active-4/);
  assert.match(lines[10], /^├─ ◦  fixer \[queue-0\].* queued$/);
  assert.equal(lines[11], "└─ +5 more (2 active, 1 queued, 2 finished)");
  assert.doesNotMatch(lines.join("\n"), /queue-1|finished-/);
  assert.doesNotMatch(lines.join("\n"), /finished-/);

  const terminalRuns = Array.from({ length: 8 }, (_, index) => run({
    id: `term-${index}`,
    status: index % 2 === 0 ? "completed" : "failed",
    createdAt: new Date(Date.parse("2026-04-16T23:40:00.000Z") + index * 1_000).toISOString(),
    updatedAt: new Date(Date.parse("2026-04-16T23:50:00.000Z") + index * 1_000).toISOString(),
    ...(index % 2 === 0 ? {} : { error: `failure-${index}` }),
  }));
  const orderedOverflow = renderSubagentWidgetLines({
    runs: [run({ id: "active", status: "running" }), run({ id: "starting", status: "starting" }), ...terminalRuns],
    spinnerFrame: 0,
    terminalWidth: 240,
    theme,
    nowMs: NOW_MS,
  });
  const visibleIds = orderedOverflow
    .filter((line) => /^(?:├─|└─) /.test(line) && !line.includes("more ("))
    .map((line) => /\[([^\]]+)\]/.exec(line)?.[1])
    .filter(Boolean);
  assert.deepEqual(visibleIds, ["active", "starting", "term-7", "term-6", "term-5", "term-4", "term-3", "term-2"]);
  assert.equal(orderedOverflow.at(-1), "└─ +2 more (2 finished)");
  assert.doesNotMatch(orderedOverflow.join("\n"), /term-0|term-1/);
});

test("widget registers its callback once, ticks at 80ms, then requests render", () => {
  let runs = [run({ status: "running" })];
  const intervals = [];
  const cleared = [];
  const widgetCalls = [];
  const statusCalls = [];
  let renders = 0;
  const widget = new SubagentWidget(() => runs, {
    setInterval(callback, ms) { intervals.push({ callback, ms, token: Symbol("timer") }); return intervals.at(-1).token; },
    clearInterval(token) { cleared.push(token); },
  });
  const tui = { terminal: { columns: 120 }, requestRender() { renders += 1; } };
  const ui = {
    setStatus(key, text) { statusCalls.push({ key, text }); },
    setWidget(key, content, options) {
      widgetCalls.push({ key, content, options });
      if (typeof content === "function") content(tui, theme);
    },
  };
  widget.setUICtx(ui);
  widget.update();
  assert.equal(intervals.length, 1);
  assert.equal(intervals[0].ms, 80);
  assert.equal(widgetCalls.length, 1);
  assert.deepEqual(widgetCalls[0].options, { placement: "aboveEditor" });
  assert.equal(statusCalls.at(-1).text, "1 running agent");

  intervals[0].callback();
  widget.update();
  assert.equal(widgetCalls.length, 1, "the factory must not be replaced on later updates");
  assert.equal(renders, 2);
  assert.equal(statusCalls.length, 1, "unchanged status text must not be reset");

  runs = [run({ status: "completed" })];
  widget.update();
  widget.onTurnStart();
  assert.equal(typeof widgetCalls.at(-1).content, "function", "a retained terminal run keeps the widget registered");
  assert.equal(statusCalls.at(-1).text, undefined, "only active runs drive the status bar");
  assert.equal(cleared.length, 0, "the tick timer stops only when nothing is retained");

  runs = [];
  widget.update();
  assert.equal(widgetCalls.at(-1).content, undefined, "clearing every retained run removes the widget");
  assert.equal(cleared.length, 1);
});

test("terminal runs never drop or linger out and dispose clears widget, status, and timer", () => {
  let runs = [run({ status: "failed", error: "boom" })];
  const widgetCalls = [];
  const statusCalls = [];
  const cleared = [];
  const widget = new SubagentWidget(() => runs, {
    setInterval() { return "timer"; },
    clearInterval(timer) { cleared.push(timer); },
  });
  const ui = {
    setStatus(key, text) { statusCalls.push({ key, text }); },
    setWidget(key, content) { widgetCalls.push({ key, content }); },
  };
  widget.setUICtx(ui);
  widget.update();
  for (let turn = 0; turn < 5; turn += 1) widget.onTurnStart();
  assert.equal(typeof widgetCalls.at(-1).content, "function", "terminal runs stay visible across every later turn");

  runs = [];
  widget.update();
  assert.equal(widgetCalls.at(-1).content, undefined, "clear removes every widget entry");

  runs = [run({ status: "running" })];
  widget.update();
  widget.dispose();
  assert.equal(widgetCalls.at(-1).content, undefined);
  assert.equal(statusCalls.at(-1).text, undefined);
  assert.deepEqual(cleared, ["timer"]);
});
