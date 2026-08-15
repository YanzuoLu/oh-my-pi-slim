import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const piEntry = realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim());
const piRoot = dirname(dirname(piEntry));
const dependencyMap = {
  "@earendil-works/pi-tui": pathToFileURL(`${piRoot}/node_modules/@earendil-works/pi-tui/dist/index.js`).href,
  "./subagent-core.js": new URL("../extensions/oh-my-pi-slim/subagent-core.ts", import.meta.url).href,
  "./subagent-widget-renderer.js": new URL("../extensions/oh-my-pi-slim/subagent-widget-renderer.ts", import.meta.url).href,
  "./subagent-widget-display.js": new URL("../extensions/oh-my-pi-slim/subagent-widget-display.ts", import.meta.url).href,
  "./subagent-widget-glyphs.js": new URL("../extensions/oh-my-pi-slim/subagent-widget-glyphs.ts", import.meta.url).href,
  "./subagent-run-files.js": new URL("../extensions/oh-my-pi-slim/subagent-run-files.ts", import.meta.url).href,
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    const url = dependencyMap[specifier];
    return url ? { url, shortCircuit: true } : nextResolve(specifier, context);
  },
});

const { SubagentWidget, assembleSubagentWidgetState } = await import("../extensions/oh-my-pi-slim/subagent-widget.ts");
const {
  MAX_SUBAGENT_WIDGET_LINES,
  renderActiveRunLines,
  renderFinishedRunLine,
  renderSubagentWidgetLines,
} = await import("../extensions/oh-my-pi-slim/subagent-widget-renderer.ts");

const NOW_MS = Date.parse("2026-04-17T00:00:00.000Z");
const theme = {
  fg: (_color, text) => text,
  bold: (text) => `**${text}**`,
};

function run(overrides = {}) {
  return {
    id: "run-1",
    agent: "fixer",
    task: "implement the widget",
    cwd: "/repo",
    model: "provider/model:high",
    tools: ["read"],
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
  ], () => true), {
    runningCount: 1,
    waitingCount: 1,
    queuedCount: 1,
    hasFinished: true,
    hasActive: true,
  });
});

test("pure line renderers show spinner, waiting request, and terminal outcome icons", () => {
  const [runningHeader, runningActivity] = renderActiveRunLines(
    run({ status: "running", updatedAt: "2026-04-16T23:59:56.000Z" }), 0, theme, NOW_MS,
  );
  assert.match(runningHeader, /⠋/);
  assert.match(runningHeader, /\*\*fixer \[run-1\]\*\*/);
  assert.match(runningActivity, /thinking/);

  const [waitingHeader, waitingActivity] = renderActiveRunLines(run({
    status: "waiting",
    request: { id: "req", runId: "run-1", reason: "need_decision", message: "Choose A or B", createdAt: "now" },
  }), 3, theme, NOW_MS);
  assert.match(waitingHeader, /!.*waiting/);
  assert.match(waitingActivity, /Choose A or B/);

  assert.match(renderFinishedRunLine(run({ status: "completed" }), theme, NOW_MS), /✓/);
  assert.match(renderFinishedRunLine(run({ status: "failed", error: "boom" }), theme, NOW_MS), /✗.*failed: boom/);
  assert.match(renderFinishedRunLine(run({ status: "interrupted" }), theme, NOW_MS), /✗.*interrupted/);
});

test("activity formatting matches gotgenes stats, tools, response, tokens, context, and compactions", () => {
  const [toolHeader, toolActivity] = renderActiveRunLines(run({
    status: "running",
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
  assert.match(toolHeader, /↻3 · 2 tool uses · 12\.3k token \(72% · ⇊2\) · 5\.0s/);
  assert.match(toolActivity, /reading, searching 2 patterns…/);

  const [, responseActivity] = renderActiveRunLines(run({
    status: "running",
    activity: {
      turnCount: 1, toolUses: 0, activeTools: {},
      responseText: "A concise response line that is visible\nsecond line",
      tokens: 0, compactionCount: 0,
    },
  }), 0, theme, NOW_MS);
  assert.match(responseActivity, /A concise response line that is visible/);
});

test("pure widget renderer preserves tree layout and queued summary", () => {
  const lines = renderSubagentWidgetLines({
    runs: [
      run({ id: "done", status: "completed" }),
      run({ id: "live", status: "running", updatedAt: "2026-04-16T23:59:56.000Z" }),
      run({ id: "queue", status: "starting" }),
    ],
    spinnerFrame: 0,
    terminalWidth: 200,
    theme,
    shouldShowFinished: () => true,
    nowMs: NOW_MS,
  });
  assert.equal(lines.length, 5);
  assert.match(lines[0], /● Agents/);
  assert.match(lines[1], /├─ ✓/);
  assert.match(lines[2], /├─ ⠋/);
  assert.match(lines[3], /│.*⎿/);
  assert.match(lines[4], /└─ ◦ 1 queued/);
});

test("pure widget renderer caps at 12 lines and prioritizes active runs over finished runs", () => {
  const runs = [];
  for (let index = 0; index < 6; index += 1) {
    runs.push(run({ id: `active-${index}`, status: index === 0 ? "waiting" : "running" }));
  }
  runs.push(run({ id: "finished", status: "completed" }));
  const lines = renderSubagentWidgetLines({
    runs,
    spinnerFrame: 0,
    terminalWidth: 200,
    theme,
    shouldShowFinished: () => true,
    nowMs: NOW_MS,
  });
  assert.equal(lines.length, MAX_SUBAGENT_WIDGET_LINES);
  assert.match(lines.at(-1), /\+2 more \(1 active, 1 finished\)/);
  assert.match(lines.join("\n"), /Choose|supervisor reply required/);
  assert.doesNotMatch(lines.join("\n"), /finished\]/);
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
  assert.equal(widgetCalls.at(-1).content, undefined);
  assert.equal(statusCalls.at(-1).text, undefined);
  assert.equal(cleared.length, 1);
});

test("failed runs linger for two turns and dispose clears widget, status, and timer", () => {
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
  widget.onTurnStart();
  assert.equal(typeof widgetCalls.at(-1).content, "function");
  widget.onTurnStart();
  assert.equal(widgetCalls.at(-1).content, undefined);

  runs = [run({ status: "running" })];
  widget.update();
  widget.dispose();
  assert.equal(widgetCalls.at(-1).content, undefined);
  assert.equal(statusCalls.at(-1).text, undefined);
  assert.deepEqual(cleared, ["timer"]);
});
