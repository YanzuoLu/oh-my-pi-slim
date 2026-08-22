import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { pathToFileURL } from "node:url";
import test, { beforeEach } from "node:test";

const piEntry = realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim());
const piRoot = dirname(dirname(piEntry));
const dependencyMap = {
  "@earendil-works/pi-coding-agent": pathToFileURL(`${piRoot}/dist/index.js`).href,
  "@earendil-works/pi-tui": pathToFileURL(`${piRoot}/node_modules/@earendil-works/pi-tui/dist/index.js`).href,
  "./subagent-core.js": new URL("../extensions/oh-my-pi-slim/subagent-core.ts", import.meta.url).href,
  "./subagent-model-display.js": new URL("../extensions/oh-my-pi-slim/subagent-model-display.ts", import.meta.url).href,
  "./subagent-widget-renderer.js": new URL("../extensions/oh-my-pi-slim/subagent-widget-renderer.ts", import.meta.url).href,
  "./subagent-widget-display.js": new URL("../extensions/oh-my-pi-slim/subagent-widget-display.ts", import.meta.url).href,
  "./subagent-widget-glyphs.js": new URL("../extensions/oh-my-pi-slim/subagent-widget-glyphs.ts", import.meta.url).href,
  "./subagent-run-files.js": new URL("../extensions/oh-my-pi-slim/subagent-run-files.ts", import.meta.url).href,
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

const { KeybindingsManager, setKeybindings, TUI_KEYBINDINGS, visibleWidth } = await import("@earendil-works/pi-tui");
const { widgetExpandHint } = await import("../extensions/oh-my-pi-slim/widget-expansion.ts");
const {
  SubagentRegistry,
  restoreRunJournal,
  sortRetainedSubagentRuns,
} = await import("../extensions/oh-my-pi-slim/subagent-core.ts");
const { SubagentWidget, assembleSubagentWidgetState } = await import("../extensions/oh-my-pi-slim/subagent-widget.ts");
const {
  WIDGET_STACK_KEY,
  resetWidgetStackHost,
} = await import("../extensions/oh-my-pi-slim/widget-stack-host.ts");

beforeEach(() => resetWidgetStackHost());
const {
  MAX_SUBAGENT_WIDGET_LINES,
  formatWidgetModel,
  renderActiveRunLines,
  renderFinishedRunLine,
  renderSubagentWidgetLines,
} = await import("../extensions/oh-my-pi-slim/subagent-widget-renderer.ts");

const {
  modelSpecBase,
  parseModelSpec,
  sameModelSpecBase,
} = await import("../extensions/oh-my-pi-slim/subagent-model-display.ts");

const NOW_MS = Date.parse("2026-04-17T00:00:00.000Z");
const theme = {
  fg: (_color, text) => text,
  bold: (text) => `**${text}**`,
};
const vtTheme = {
  fg: (_color, text) => `\u001b[36m${text}\u001b[0m`,
  bold: (text) => `\u001b[1m${text}\u001b[22m`,
};
const roleAnsiTheme = {
  fg: (color, text) => {
    const code = { accent: 35, dim: 2, success: 32, muted: 90, warning: 33, error: 31 }[color] ?? 39;
    return `\u001b[${code}m${text}\u001b[0m`;
  },
  bold: (text) => `\u001b[1m${text}\u001b[22m`,
};

const DEFAULT_HINT = " · ctrl+o to expand";

/** Installs a user-configured `app.tools.expand` binding so the hint proves it reads the live keymap. */
function withConfiguredExpandKey(keys, body) {
  setKeybindings(new KeybindingsManager(
    { ...TUI_KEYBINDINGS, "app.tools.expand": { defaultKeys: "ctrl+o", description: "Toggle tool output" } },
    { "app.tools.expand": keys },
  ));
  try { body(); } finally { setKeybindings(null); }
}

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

test("shared model spec parsing splits only known thinking suffixes and compares provider/model bases", () => {
  for (const thinking of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
    assert.deepEqual(parseModelSpec(`openai/gpt-5.6-sol:${thinking}`), {
      provider: "openai", model: "gpt-5.6-sol", thinking, base: "openai/gpt-5.6-sol",
    });
  }
  assert.deepEqual(parseModelSpec("provider/model:variant:max"), {
    provider: "provider", model: "model:variant", thinking: "max", base: "provider/model:variant",
  });
  assert.deepEqual(parseModelSpec("custom/model:experimental"), {
    provider: "custom", model: "model:experimental", thinking: undefined, base: "custom/model:experimental",
  });
  assert.deepEqual(parseModelSpec("model-without-provider:high"), {
    provider: undefined, model: "model-without-provider", thinking: "high", base: "model-without-provider",
  });
  assert.deepEqual(parseModelSpec("/missing-provider:high"), {
    provider: undefined, model: "/missing-provider", thinking: "high", base: "/missing-provider",
  });

  assert.equal(modelSpecBase("  anthropic/claude-opus-4-6:xhigh  "), "anthropic/claude-opus-4-6");
  assert.equal(sameModelSpecBase("provider/model:low", "provider/model:high"), true);
  assert.equal(sameModelSpecBase("provider/model", "provider/model:high"), true);
  assert.equal(sameModelSpecBase("provider/model:2025-01-01", "provider/model"), false,
    "a colon that is not a known thinking level belongs to the model ID");
  assert.equal(sameModelSpecBase("provider-a/model", "provider-b/model"), false);
  assert.equal(sameModelSpecBase("provider/model-a", "provider/model-b"), false);
  assert.equal(sameModelSpecBase("provider/model:max", "  provider/model:off "), true);
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
    "**●**  **Agents (1/3)**",
    "├─ ⠋  **fixer [live]**  implement the widget",
    "│  ├─ (openai) gpt-5.6-sol • xhigh · ↻  0 · 5.0s",
    "│  └─ thinking…",
    "├─ ◦  fixer [queue]  implement the widget · ↻  0 · 5.0s queued",
    "└─ ✓  fixer [done]  implement the widget · ↻  0 · 5.0s",
  ]);
  assert.doesNotMatch(lines.join("\n").replaceAll("**", ""), /[●⠋↻◦✓] [^ ]|[●⠋↻◦✓] {3}/);
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
  assert.equal(lines[0], "**●**  **Agents (2/9)**", "hidden rows never change the retained counts");
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
  assert.equal(orderedOverflow[0], "**●**  **Agents (8/10)**", "two hidden terminal rows still count toward the heading");
  assert.deepEqual(visibleIds, ["active", "starting", "term-7", "term-6", "term-5", "term-4", "term-3", "term-2"]);
  assert.equal(orderedOverflow.at(-1), "└─ +2 more (2 finished)");
  assert.doesNotMatch(orderedOverflow.join("\n"), /term-0|term-1/);
});

test("persistent widget heading counts terminal over retained runs with Todo-parity active and idle roles", () => {
  const heading = (runs, widgetTheme = theme, terminalWidth = 200) =>
    renderSubagentWidgetLines({ runs, spinnerFrame: 0, terminalWidth, theme: widgetTheme, nowMs: NOW_MS })[0];
  const mixed = [
    run({ id: "queued", status: "starting" }),
    run({ id: "busy", status: "running" }),
    run({ id: "held", status: "waiting" }),
    run({ id: "ok-1", status: "completed" }),
    run({ id: "ok-2", status: "completed" }),
    run({ id: "bad-1", status: "failed", error: "boom" }),
    run({ id: "bad-2", status: "failed", error: "boom" }),
    run({ id: "stopped", status: "interrupted" }),
  ];
  assert.equal(heading(mixed), "**●**  **Agents (5/8)**");
  assert.equal(
    heading(mixed, roleAnsiTheme),
    "\u001b[35m\u001b[1m●\u001b[22m\u001b[0m  \u001b[35m\u001b[1mAgents (5/8)\u001b[22m\u001b[0m",
  );
  assert.equal(stripVTControlCharacters(heading(mixed, roleAnsiTheme)), "●  Agents (5/8)");
  for (const status of ["starting", "running", "waiting"]) {
    assert.equal(
      heading([run({ id: "live", status }), run({ id: "term", status: "completed" })]),
      "**●**  **Agents (1/2)**",
      `${status} must count as live and stay out of the numerator`,
    );
  }

  const terminalOnly = mixed.filter((value) => !["starting", "running", "waiting"].includes(value.status));
  assert.equal(heading(terminalOnly), "○  Agents (5/5)");
  assert.equal(heading(terminalOnly, roleAnsiTheme), "\u001b[2m○\u001b[0m  \u001b[2mAgents (5/5)\u001b[0m");
  const idleLines = renderSubagentWidgetLines({ runs: terminalOnly, spinnerFrame: 0, terminalWidth: 200, theme: roleAnsiTheme, nowMs: NOW_MS });
  assert.doesNotMatch(idleLines.join("\n"), /\u001b\[35m/, "an all-terminal widget must not render any accent role");
  assert.doesNotMatch(idleLines[0], /\u001b\[1m/, "the idle heading must stay dim without bold emphasis");

  for (const width of [6, 12, 20]) {
    for (const runs of [mixed, terminalOnly]) {
      const narrow = renderSubagentWidgetLines({ runs, spinnerFrame: 0, terminalWidth: width, theme: roleAnsiTheme, nowMs: NOW_MS });
      assert.ok(narrow.every((line) => visibleWidth(line) <= width));
    }
  }
  assert.match(heading(terminalOnly, theme, 6), /^○  /);
  assert.deepEqual(renderSubagentWidgetLines({ runs: [], spinnerFrame: 0, terminalWidth: 200, theme, nowMs: NOW_MS }), []);
});

test("a single retained ID disappearing updates widget counts and the last removal retracts the section", () => {
  let runs = [run({ id: "live", status: "running" }), run({ id: "done", status: "completed" })];
  const widgetCalls = [];
  let component;
  const tui = { terminal: { columns: 120 }, requestRender() {} };
  const widget = new SubagentWidget(() => runs, { setInterval() { return "timer"; }, clearInterval() {} });
  widget.setUICtx({
    setStatus() {},
    setWidget(key, content) {
      widgetCalls.push({ key, content });
      component = typeof content === "function" ? content(tui, theme) : undefined;
    },
  });

  widget.update();
  assert.equal(component.render()[0], "**●**  **Agents (1/2)**");

  runs = [run({ id: "live", status: "waiting" }), run({ id: "done", status: "completed" })];
  widget.update();
  assert.equal(component.render()[0], "**●**  **Agents (1/2)**");

  runs = [run({ id: "live", status: "interrupted" }), run({ id: "done", status: "completed" })];
  widget.update();
  assert.equal(component.render()[0], "○  Agents (2/2)", "the last live run settling flips the heading to idle");

  runs = [...runs, run({ id: "fresh", status: "starting" })];
  widget.onTurnStart();
  assert.equal(component.render()[0], "**●**  **Agents (2/3)**", "a restored or created run flips the heading back to active");

  runs = runs.filter((item) => item.id !== "done");
  widget.update();
  assert.equal(component.render()[0], "**●**  **Agents (1/2)**", "removing one retained ID updates both counts immediately");
  assert.doesNotMatch(component.render().join("\n"), /\[done\]/, "the removed retained ID leaves the widget body");

  runs = runs.filter((item) => item.id !== "live");
  widget.update();
  assert.equal(component.render()[0], "**●**  **Agents (0/1)**");

  runs = [];
  widget.update();
  assert.equal(widgetCalls.at(-1).content, undefined, "removing the last retained ID retracts the widget");
});

test("collapsed Agents body keeps starting, running, and waiting rows and hides every terminal run", () => {
  const runs = [
    run({ id: "live", status: "running", model: "openai/gpt-5.6-sol:xhigh", updatedAt: "2026-04-16T23:59:56.000Z" }),
    run({ id: "held", status: "waiting", model: "openai/gpt-5.6-sol:xhigh" }),
    run({ id: "queue", status: "starting" }),
    run({ id: "ok", status: "completed" }),
    run({ id: "bad", status: "failed", error: "boom" }),
    run({ id: "stopped", status: "interrupted" }),
  ];
  const render = (overrides) => renderSubagentWidgetLines({
    runs, spinnerFrame: 0, terminalWidth: 200, theme, nowMs: NOW_MS, ...overrides,
  });

  const expanded = render({});
  assert.deepEqual(render({ expanded: true, hint: DEFAULT_HINT }), expanded, "expanded keeps the previous body byte for byte");
  assert.equal(expanded.length, 11);

  assert.deepEqual(render({ expanded: false, hint: DEFAULT_HINT }), [
    "**●**  **Agents (3/6)** · ctrl+o to expand",
    "├─ !  **fixer [held]** waiting  implement the widget",
    "│  ├─ (openai) gpt-5.6-sol • xhigh · ↻  0 · 5.0s",
    "│  └─ supervisor reply required",
    "├─ ⠋  **fixer [live]**  implement the widget",
    "│  ├─ (openai) gpt-5.6-sol • xhigh · ↻  0 · 5.0s",
    "│  └─ thinking…",
    "└─ ◦  fixer [queue]  implement the widget · ↻  0 · 5.0s queued",
  ]);

  const liveOnly = runs.filter((value) => ["starting", "running", "waiting"].includes(value.status));
  assert.deepEqual(
    renderSubagentWidgetLines({ runs: liveOnly, spinnerFrame: 0, terminalWidth: 200, theme, nowMs: NOW_MS, expanded: false, hint: DEFAULT_HINT }),
    renderSubagentWidgetLines({ runs: liveOnly, spinnerFrame: 0, terminalWidth: 200, theme, nowMs: NOW_MS }),
    "a collapsed widget with nothing hidden shows no hint at all",
  );

  const terminalOnly = runs.filter((value) => !["starting", "running", "waiting"].includes(value.status));
  const idle = { runs: terminalOnly, spinnerFrame: 0, terminalWidth: 200, theme, nowMs: NOW_MS };
  assert.deepEqual(
    renderSubagentWidgetLines({ ...idle, expanded: false, hint: DEFAULT_HINT }),
    ["○  Agents (3/3) · ctrl+o to expand"],
    "an all-terminal collapsed widget keeps a heading-only body with no tree",
  );
  assert.equal(renderSubagentWidgetLines({ ...idle, expanded: true, hint: DEFAULT_HINT }).length, 4);

  const soloActive = renderSubagentWidgetLines({
    runs: [runs[0], runs[3]], spinnerFrame: 0, terminalWidth: 200, theme, nowMs: NOW_MS, expanded: false, hint: DEFAULT_HINT,
  });
  assert.deepEqual(soloActive, [
    "**●**  **Agents (1/2)** · ctrl+o to expand",
    "└─ ⠋  **fixer [live]**  implement the widget",
    "   ├─ (openai) gpt-5.6-sol • xhigh · ↻  0 · 5.0s",
    "   └─ thinking…",
  ], "the last collapsed active entry keeps its three-line block and closes the tree");
  assert.deepEqual(renderSubagentWidgetLines({ runs: [], spinnerFrame: 0, terminalWidth: 200, theme, nowMs: NOW_MS, expanded: false, hint: DEFAULT_HINT }), []);
});

test("collapsed Agents hint is one dim non-bold segment with the configured key, dropped whole when the width is tight", () => {
  const mixed = [run({ id: "live", status: "running" }), run({ id: "ok", status: "completed" })];
  const terminalOnly = [run({ id: "ok", status: "completed" })];
  const heading = (runs, widgetTheme, terminalWidth) => renderSubagentWidgetLines({
    runs, spinnerFrame: 0, terminalWidth, theme: widgetTheme, nowMs: NOW_MS, expanded: false, hint: DEFAULT_HINT,
  })[0];
  const dimHint = "\u001b[2m · ctrl+o to expand\u001b[0m";

  const activeHeading = heading(mixed, roleAnsiTheme, 200);
  assert.equal(
    activeHeading,
    `\u001b[35m\u001b[1m●\u001b[22m\u001b[0m  \u001b[35m\u001b[1mAgents (1/2)\u001b[22m\u001b[0m${dimHint}`,
  );
  const idleHeading = heading(terminalOnly, roleAnsiTheme, 200);
  assert.equal(idleHeading, `\u001b[2m○\u001b[0m  \u001b[2mAgents (1/1)\u001b[0m${dimHint}`);
  assert.ok(
    activeHeading.endsWith(dimHint) && idleHeading.endsWith(dimHint),
    "the hint renders identically in the active and idle heading states",
  );
  assert.doesNotMatch(activeHeading.slice(activeHeading.indexOf(dimHint)), /\u001b\[1m/, "the hint is never bold");

  withConfiguredExpandKey("ctrl+shift+e", () => {
    assert.equal(widgetExpandHint(), " · ctrl+shift+e to expand");
    assert.equal(
      renderSubagentWidgetLines({
        runs: mixed, spinnerFrame: 0, terminalWidth: 200, theme, nowMs: NOW_MS, expanded: false, hint: widgetExpandHint(),
      })[0],
      "**●**  **Agents (1/2)** · ctrl+shift+e to expand",
    );
  });
  assert.equal(widgetExpandHint(), DEFAULT_HINT, "an unconfigured keymap falls back to Pi's default binding");

  const full = "○  Agents (1/1) · ctrl+o to expand";
  assert.equal(heading(terminalOnly, theme, full.length), full);
  for (const width of [1, 5, 10, 16, full.length - 1]) {
    const narrow = heading(terminalOnly, theme, width);
    assert.ok(visibleWidth(narrow) <= width, `width ${width} must stay inside the terminal`);
    assert.doesNotMatch(narrow, /·|expand|ctrl/, `width ${width} must drop the whole hint, never half of it`);
  }
});

test("collapsed Agents overflow spends the 12-line budget on live runs only and keeps the retained counts", () => {
  const runs = [
    ...Array.from({ length: 5 }, (_, index) => run({
      id: `active-${index}`,
      status: index === 0 ? "waiting" : "running",
      model: "openai/gpt-5.6-sol:xhigh",
    })),
    run({ id: "queue-0", status: "starting" }),
    ...Array.from({ length: 4 }, (_, index) => run({ id: `finished-${index}`, status: "completed" })),
  ];
  const collapsed = renderSubagentWidgetLines({
    runs, spinnerFrame: 0, terminalWidth: 200, theme, nowMs: NOW_MS, expanded: false, hint: DEFAULT_HINT,
  });

  assert.equal(collapsed.length, MAX_SUBAGENT_WIDGET_LINES);
  assert.equal(collapsed[0], "**●**  **Agents (4/10)** · ctrl+o to expand", "heading counts ignore both filtering and overflow");
  assert.equal(collapsed.at(-1), "└─ +2 more (2 active)", "policy-hidden terminal runs stay out of the overflow summary");
  assert.doesNotMatch(collapsed.join("\n"), /finished-/);
  assert.equal(collapsed.slice(1, -1).length, 10, "three whole lines per surviving active run plus the queued row, none split");
});

test("SubagentWidget reads Pi's live expansion state on every render without re-registering the widget", () => {
  let expanded = true;
  const runs = [run({ id: "live", status: "running" }), run({ id: "ok", status: "completed" })];
  const widgetCalls = [];
  let component;
  const tui = { terminal: { columns: 200 }, requestRender() {} };
  const widget = new SubagentWidget(() => runs, { setInterval() { return "timer"; }, clearInterval() {} });
  widget.setUICtx({
    getToolsExpanded: () => expanded,
    setStatus() {},
    setWidget(key, content) {
      widgetCalls.push({ key, content });
      component = typeof content === "function" ? content(tui, theme) : undefined;
    },
  });

  widget.update();
  const registrations = widgetCalls.filter((call) => typeof call.content === "function").length;
  assert.equal(component.render().length, 5);

  expanded = false;
  const collapsed = component.render();
  assert.equal(collapsed[0], "**●**  **Agents (1/2)** · ctrl+o to expand");
  assert.equal(collapsed.length, 4);
  assert.equal(
    widgetCalls.filter((call) => typeof call.content === "function").length,
    registrations,
    "Ctrl+O must not re-register the widget",
  );

  expanded = true;
  assert.equal(component.render().length, 5, "Ctrl+O toggles straight back to the full body");
  assert.equal(widgetCalls.filter((call) => typeof call.content === "function").length, registrations);

  const legacyCalls = [];
  let legacyComponent;
  const legacyWidget = new SubagentWidget(() => runs, { setInterval() { return "timer"; }, clearInterval() {} });
  legacyWidget.setUICtx({
    setStatus() {},
    setWidget(key, content) {
      legacyCalls.push({ key, content });
      legacyComponent = typeof content === "function" ? content(tui, theme) : undefined;
    },
  });
  legacyWidget.update();
  assert.equal(legacyComponent.render().length, 5, "a host without getToolsExpanded stays expanded");
  assert.doesNotMatch(legacyComponent.render().join("\n"), /to expand/);
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
  assert.equal(widgetCalls[0].key, WIDGET_STACK_KEY, "Agents joins the one aggregate widget instead of owning a key");
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
