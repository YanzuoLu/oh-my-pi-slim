import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { stripVTControlCharacters } from "node:util";
import { pathToFileURL } from "node:url";
import test, { beforeEach } from "node:test";
import { piRoot } from "./fixtures/pi-install.mjs";
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
  SUBAGENT_WIDGET_SPINNER,
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
const VIEWER_HINT = " · ctrl+shift+←/→ viewer";
const COMBINED_HINT = `${VIEWER_HINT}${DEFAULT_HINT}`;

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

test("pure active renderer uses two exact lines and terminal renderers keep outcome icons", () => {
  const [runningSummary, runningStats] = renderActiveRunLines(
    run({ status: "running", model: "openai/gpt-5.6-sol:xhigh", updatedAt: "2026-04-16T23:59:56.000Z" }),
    0,
    theme,
    NOW_MS,
  );
  assert.equal(runningSummary, "⠋  **fixer [run-1]**  implement the widget · thinking…");
  assert.equal(runningStats, "(openai) gpt-5.6-sol • xhigh · ↻  0 · 5.0s");
  assert.doesNotMatch(runningSummary, /↻|tool use|token|5\.0s/);
  assert.match(runningStats, /^\(openai\) gpt-5\.6-sol • xhigh · ↻  0/);

  const [waitingSummary, waitingStats] = renderActiveRunLines(run({
    status: "waiting",
    model: "openai/gpt-5.6-sol:xhigh",
    request: { runId: "run-1", reason: "need_decision", message: "Choose A or B", createdAt: "now" },
  }), 3, theme, NOW_MS);
  assert.equal(waitingSummary, "!  **fixer [run-1]** waiting  implement the widget · Choose A or B");
  assert.equal(waitingStats, "(openai) gpt-5.6-sol • xhigh · ↻  0 · 5.0s");
  assert.doesNotMatch(`${runningSummary}\n${waitingSummary}\n${runningStats}`, /[⠋!↻] [^ ]|[⠋!↻] {3}/);

  const [styledRunning] = renderActiveRunLines(run({ status: "running" }), 0, roleAnsiTheme, NOW_MS);
  const [styledWaiting] = renderActiveRunLines(run({
    status: "waiting",
    request: { runId: "run-1", reason: "need_decision", message: "Choose A or B", createdAt: "now" },
  }), 0, roleAnsiTheme, NOW_MS);
  assert.match(styledRunning, /\u001b\[2m · \u001b\[0m\u001b\[2mthinking…\u001b\[0m$/, "running activity and its separator stay dim");
  assert.match(styledWaiting, /\u001b\[2m · \u001b\[0m\u001b\[33mChoose A or B\u001b\[0m$/, "waiting activity keeps the warning role after a dim separator");

  assert.match(renderFinishedRunLine(run({ status: "completed" }), theme, NOW_MS), /✓/);
  assert.match(renderFinishedRunLine(run({ status: "failed", error: "boom" }), theme, NOW_MS), /✗.*failed: boom/);
  assert.match(renderFinishedRunLine(run({ status: "interrupted" }), theme, NOW_MS), /✗.*interrupted/);
});

test("multiline waiting messages and terminal errors stay newline-free and preserve atomic renderer layout", () => {
  const waiting = run({
    id: "waiting-multiline",
    status: "waiting",
    request: {
      runId: "waiting-multiline",
      reason: "need_decision",
      message: "\nChoose the safe option\nDo not render this second line",
      createdAt: "now",
    },
  });
  const failed = run({
    id: "failed-multiline",
    status: "failed",
    error: "\nPrimary failure\nstack detail must stay hidden",
  });
  const activeLines = renderActiveRunLines(waiting, 0, theme, NOW_MS);
  const finishedLine = renderFinishedRunLine(failed, theme, NOW_MS);
  const widgetLines = renderSubagentWidgetLines({
    runs: [failed, waiting],
    spinnerFrame: 0,
    terminalWidth: 200,
    theme,
    nowMs: NOW_MS,
  });

  assert.equal(activeLines.length, 2, "a waiting run remains one atomic two-line entry");
  assert.equal(widgetLines.length, 4, "the heading, two-line waiting entry, and terminal entry stay atomic");
  assert.match(activeLines[0], /Choose the safe option$/);
  assert.doesNotMatch(activeLines[0], /Do not render this second line/);
  assert.match(finishedLine, /failed: Primary failure$/);
  assert.doesNotMatch(finishedLine, /stack detail must stay hidden/);
  for (const line of [...activeLines, finishedLine, ...widgetLines]) {
    assert.equal(typeof line, "string");
    assert.equal(line.includes("\n"), false, "every returned renderer string is one physical line");
  }
});

test("activity formatting keeps the abstract before activity and model before stats, tools, response, tokens, context, and compactions", () => {
  const [toolSummary, toolStats] = renderActiveRunLines(run({
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
  assert.equal(toolSummary, "⠋  **fixer [run-1]**  implement the widget · reading, searching 2 patterns…");
  assert.equal(toolStats, "(openai) gpt-5.6-sol • minimal · ↻  3 · 2 tool uses · 12.3k token (72% · ⇊  2) · 5.0s");

  const [responseSummary, responseStats] = renderActiveRunLines(run({
    status: "running",
    activity: {
      turnCount: 1, toolUses: 0, activeTools: {},
      responseText: "A concise response line that is visible\nsecond line",
      tokens: 0, compactionCount: 0,
    },
  }), 0, theme, NOW_MS);
  assert.equal(responseStats, "(provider) model • high · ↻  1 · 5.0s");
  assert.equal(responseSummary, "⠋  **fixer [run-1]**  implement the widget · A concise response line that is visible");
});

test("pure widget renderer preserves the two-line active tree and queued summary", () => {
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
    "├─ ⠋  **fixer [live]**  implement the widget · thinking…",
    "│  └─ (openai) gpt-5.6-sol • xhigh · ↻  0 · 5.0s",
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

  const priorityPrefix = "└─ ⠋  fixer [priority]  摘要优先🙂";
  const priorityLines = renderSubagentWidgetLines({
    runs: [run({
      id: "priority",
      status: "running",
      abstract: "摘要优先🙂",
      activity: {
        turnCount: 1, toolUses: 0, activeTools: {}, responseText: "ACTIVITY-TAIL",
        tokens: 0, compactionCount: 0,
      },
    })],
    spinnerFrame: 0,
    terminalWidth: visibleWidth(priorityPrefix),
    theme: vtTheme,
    nowMs: NOW_MS,
  });
  assert.equal(stripVTControlCharacters(priorityLines[1]), priorityPrefix, "narrow wide-character output keeps the complete identity and abstract prefix before dropping activity");
  assert.doesNotMatch(priorityLines.join("\n"), /ACTIVITY-TAIL/);
  assert.ok(priorityLines.every((line) => visibleWidth(line) <= visibleWidth(priorityPrefix)));
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
  assert.match(lines[1], /active-0.*waiting.*implement the widget · supervisor reply required/);
  assert.match(lines[2], /^│  └─ \(openai\) gpt-5\.6-sol • xhigh · ↻  0/);
  assert.match(lines[3], /active-1.* · thinking…$/);
  assert.match(lines[5], /active-2.* · thinking…$/);
  assert.match(lines[7], /active-3.* · thinking…$/);
  assert.match(lines[9], /active-4.* · thinking…$/);
  assert.equal(lines[11], "└─ +4 more (2 queued, 2 finished)");
  assert.doesNotMatch(lines.join("\n"), /queue-|finished-/);

  const terminalRuns = Array.from({ length: 9 }, (_, index) => run({
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
  assert.equal(orderedOverflow[0], "**●**  **Agents (9/11)**", "two hidden terminal rows still count toward the heading");
  assert.deepEqual(visibleIds, ["active", "starting", "term-8", "term-7", "term-6", "term-5", "term-4", "term-3", "term-2"]);
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

test("collapsed Agents body keeps starting, running, and waiting rows while hiding terminal rows", () => {
  const runs = [
    run({ id: "live", status: "running", model: "openai/gpt-5.6-sol:xhigh", updatedAt: "2026-04-16T23:59:56.000Z" }),
    run({ id: "held", status: "waiting", model: "openai/gpt-5.6-sol:xhigh" }),
    run({ id: "queue", status: "starting" }),
    run({ id: "ok", status: "completed" }),
    run({ id: "bad", status: "failed", error: "boom" }),
    run({ id: "stopped", status: "interrupted" }),
  ];
  const originalRuns = structuredClone(runs);
  const render = (overrides) => renderSubagentWidgetLines({
    runs, spinnerFrame: 0, terminalWidth: 200, theme, nowMs: NOW_MS, ...overrides,
  });

  const expanded = render({});
  assert.deepEqual(render({ expanded: true, hint: DEFAULT_HINT }), expanded, "expanded keeps the previous body byte for byte");
  assert.equal(expanded.length, 9);
  assert.match(expanded.join("\n"), /\[queue\].*queued/);
  assert.match(expanded.join("\n"), /\[ok\]|\[bad\]|\[stopped\]/);

  assert.deepEqual(render({ expanded: false, hint: DEFAULT_HINT }), [
    `**●**  **Agents (3/6)**${COMBINED_HINT}`,
    "├─ !  **fixer [held]** waiting  implement the widget · supervisor reply required",
    "│  └─ (openai) gpt-5.6-sol • xhigh · ↻  0 · 5.0s",
    "├─ ⠋  **fixer [live]**  implement the widget · thinking…",
    "│  └─ (openai) gpt-5.6-sol • xhigh · ↻  0 · 5.0s",
    "└─ ◦  fixer [queue]  implement the widget · ↻  0 · 5.0s queued",
  ]);

  const liveOnly = runs.filter((value) => ["starting", "running", "waiting"].includes(value.status));
  assert.deepEqual(
    renderSubagentWidgetLines({ runs: liveOnly, spinnerFrame: 0, terminalWidth: 200, theme, nowMs: NOW_MS, expanded: false, hint: DEFAULT_HINT }),
    renderSubagentWidgetLines({ runs: liveOnly, spinnerFrame: 0, terminalWidth: 200, theme, nowMs: NOW_MS }),
    "a collapsed widget with nothing policy-hidden shows no hint",
  );

  const startingOnly = [run({ id: "queue", status: "starting" })];
  assert.deepEqual(
    renderSubagentWidgetLines({ runs: startingOnly, spinnerFrame: 0, terminalWidth: 200, theme, nowMs: NOW_MS, expanded: false, hint: DEFAULT_HINT }),
    [
      "**●**  **Agents (0/1)**",
      "└─ ◦  fixer [queue]  implement the widget · ↻  0 · 5.0s queued",
    ],
    "starting stays live in the heading and visible as a collapsed queued row",
  );
  assert.match(
    renderSubagentWidgetLines({ runs: startingOnly, spinnerFrame: 0, terminalWidth: 200, theme: roleAnsiTheme, nowMs: NOW_MS, expanded: false, hint: DEFAULT_HINT })[0],
    /^\u001b\[35m\u001b\[1m●/,
    "starting keeps the active heading role while its row remains visible",
  );

  const terminalOnly = runs.filter((value) => !["starting", "running", "waiting"].includes(value.status));
  const idle = { runs: terminalOnly, spinnerFrame: 0, terminalWidth: 200, theme, nowMs: NOW_MS };
  assert.deepEqual(
    renderSubagentWidgetLines({ ...idle, expanded: false, hint: DEFAULT_HINT }),
    [`○  Agents (3/3)${COMBINED_HINT}`],
    "an all-terminal collapsed widget keeps a heading-only body with no tree",
  );
  assert.equal(renderSubagentWidgetLines({ ...idle, expanded: true, hint: DEFAULT_HINT }).length, 4);

  const soloActive = renderSubagentWidgetLines({
    runs: [runs[0], runs[3]], spinnerFrame: 0, terminalWidth: 200, theme, nowMs: NOW_MS, expanded: false, hint: DEFAULT_HINT,
  });
  assert.deepEqual(soloActive, [
    `**●**  **Agents (1/2)**${COMBINED_HINT}`,
    "└─ ⠋  **fixer [live]**  implement the widget · thinking…",
    "   └─ (openai) gpt-5.6-sol • xhigh · ↻  0 · 5.0s",
  ], "the last collapsed active entry keeps its two-line block and closes the tree");
  assert.deepEqual(runs, originalRuns, "expanded and collapsed rendering leave retained run data unchanged");
  assert.deepEqual(renderSubagentWidgetLines({ runs: [], spinnerFrame: 0, terminalWidth: 200, theme, nowMs: NOW_MS, expanded: false, hint: DEFAULT_HINT }), []);
});

test("collapsed Agents hint degrades from Viewer plus expand to expand-only to no semantic hint", () => {
  const mixed = [run({ id: "live", status: "running" }), run({ id: "ok", status: "completed" })];
  const originalMixed = structuredClone(mixed);
  const terminalOnly = [run({ id: "ok", status: "completed" })];
  const liveOnly = [run({ id: "live", status: "running" })];
  const heading = (runs, widgetTheme, terminalWidth, overrides = {}) => renderSubagentWidgetLines({
    runs, spinnerFrame: 0, terminalWidth, theme: widgetTheme, nowMs: NOW_MS,
    expanded: false, hint: DEFAULT_HINT, ...overrides,
  })[0];
  const idleBase = "○  Agents (1/1)";
  const full = `${idleBase}${COMBINED_HINT}`;
  const expandOnly = `${idleBase}${DEFAULT_HINT}`;

  assert.equal(heading(terminalOnly, theme, visibleWidth(full)), full, "wide headings show Viewer before expand");
  assert.equal(
    heading(terminalOnly, theme, visibleWidth(expandOnly)),
    expandOnly,
    "medium headings preserve the complete original expand hint",
  );
  assert.equal(
    heading(terminalOnly, theme, visibleWidth(expandOnly) - 1),
    idleBase,
    "tight headings drop both semantic hint segments instead of truncating either one",
  );

  const dimCombinedHint = `\u001b[2m${COMBINED_HINT}\u001b[0m`;
  const dimExpandHint = `\u001b[2m${DEFAULT_HINT}\u001b[0m`;
  const activeHeading = heading(mixed, roleAnsiTheme, 200);
  assert.equal(
    activeHeading,
    `\u001b[35m\u001b[1m●\u001b[22m\u001b[0m  \u001b[35m\u001b[1mAgents (1/2)\u001b[22m\u001b[0m${dimCombinedHint}`,
  );
  const idleHeading = heading(terminalOnly, roleAnsiTheme, visibleWidth(full));
  assert.equal(idleHeading, `\u001b[2m○\u001b[0m  \u001b[2mAgents (1/1)\u001b[0m${dimCombinedHint}`);
  const mediumAnsi = heading(terminalOnly, roleAnsiTheme, visibleWidth(expandOnly));
  assert.equal(mediumAnsi, `\u001b[2m○\u001b[0m  \u001b[2mAgents (1/1)\u001b[0m${dimExpandHint}`);
  for (const [line, width] of [
    [idleHeading, visibleWidth(full)],
    [mediumAnsi, visibleWidth(expandOnly)],
    [heading(terminalOnly, roleAnsiTheme, visibleWidth(expandOnly) - 1), visibleWidth(expandOnly) - 1],
  ]) assert.ok(visibleWidth(line) <= width);
  assert.doesNotMatch(
    activeHeading.slice(activeHeading.indexOf(dimCombinedHint)),
    /\u001b\[1m/,
    "Viewer and expand hints share one dim non-bold segment",
  );

  assert.doesNotMatch(heading(mixed, theme, 200, { expanded: true }), /viewer|expand/, "expanded mode keeps the heading hint-free");
  assert.doesNotMatch(heading(liveOnly, theme, 200), /viewer|expand/, "no policy-hidden rows keeps the collapsed heading hint-free");

  withConfiguredExpandKey("ctrl+shift+e", () => {
    const configuredExpandHint = widgetExpandHint();
    assert.equal(configuredExpandHint, " · ctrl+shift+e to expand");
    assert.equal(
      renderSubagentWidgetLines({
        runs: mixed, spinnerFrame: 0, terminalWidth: 200, theme, nowMs: NOW_MS, expanded: false, hint: configuredExpandHint,
      })[0],
      `**●**  **Agents (1/2)**${VIEWER_HINT}${configuredExpandHint}`,
      "Viewer remains fixed while the existing expand hint follows its configured binding",
    );
  });
  assert.equal(widgetExpandHint(), DEFAULT_HINT, "an unconfigured keymap falls back to Pi's default binding");

  for (const width of [1, 5, 10, visibleWidth(idleBase)]) {
    const narrow = heading(terminalOnly, theme, width);
    assert.ok(visibleWidth(narrow) <= width, `width ${width} must stay inside the terminal`);
    assert.doesNotMatch(narrow, /·|viewer|expand|ctrl|←|→/, `width ${width} must not expose a partial semantic hint`);
  }
  assert.deepEqual(mixed, originalMixed, "hint rendering leaves retained run data unchanged");
});

test("collapsed Agents overflow keeps queued rows eligible and terminal policy-hidden runs out of more", () => {
  const runs = [
    ...Array.from({ length: 6 }, (_, index) => run({
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
  assert.equal(collapsed[0], `**●**  **Agents (4/11)**${COMBINED_HINT}`, "heading counts ignore policy filtering and overflow");
  assert.equal(collapsed.at(-1), "└─ +2 more (1 active, 1 queued)", "overflow counts both eligible active and queued rows");
  assert.doesNotMatch(collapsed.join("\n"), /finished-|queue-0|active-5/);
  assert.equal(collapsed.slice(1, -1).length, 10, "the 12-line budget keeps five whole two-line active blocks");
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
    setWidget(key, content) {
      widgetCalls.push({ key, content });
      component = typeof content === "function" ? content(tui, theme) : undefined;
    },
  });

  widget.update();
  const registrations = widgetCalls.filter((call) => typeof call.content === "function").length;
  assert.equal(component.render().length, 4);

  expanded = false;
  const collapsed = component.render();
  assert.equal(collapsed[0], `**●**  **Agents (1/2)**${COMBINED_HINT}`);
  assert.equal(collapsed.length, 3);
  assert.equal(
    widgetCalls.filter((call) => typeof call.content === "function").length,
    registrations,
    "Ctrl+O must not re-register the widget",
  );

  expanded = true;
  assert.equal(component.render().length, 4, "Ctrl+O toggles straight back to the full body");
  assert.equal(widgetCalls.filter((call) => typeof call.content === "function").length, registrations);

  const legacyCalls = [];
  let legacyComponent;
  const legacyWidget = new SubagentWidget(() => runs, { setInterval() { return "timer"; }, clearInterval() {} });
  legacyWidget.setUICtx({
    setWidget(key, content) {
      legacyCalls.push({ key, content });
      legacyComponent = typeof content === "function" ? content(tui, theme) : undefined;
    },
  });
  legacyWidget.update();
  assert.equal(legacyComponent.render().length, 4, "a host without getToolsExpanded stays expanded");
  assert.doesNotMatch(legacyComponent.render().join("\n"), /to expand/);
});

test("manual and runtime-style updates refresh without advancing the spinner frame", () => {
  let runs = [run({ status: "running" })];
  const intervals = [];
  const cleared = [];
  const widgetCalls = [];
  let component;
  let renders = 0;
  const widget = new SubagentWidget(() => runs, {
    setInterval(callback, ms) { intervals.push({ callback, ms, token: Symbol("timer") }); return intervals.at(-1).token; },
    clearInterval(token) { cleared.push(token); },
  });
  const tui = { terminal: { columns: 120 }, requestRender() { renders += 1; } };
  const ui = {
    setWidget(key, content, options) {
      widgetCalls.push({ key, content, options });
      if (typeof content === "function") component = content(tui, theme);
    },
  };
  const runningGlyph = () => /^[├└]─ (\S+)/.exec(component.render().find((line) => line.includes("[run-1]")))?.[1];
  widget.setUICtx(ui);
  widget.update();
  assert.equal(intervals.length, 1);
  assert.equal(intervals[0].ms, 80);
  assert.equal(widgetCalls.length, 1);
  assert.equal(widgetCalls[0].key, WIDGET_STACK_KEY, "Agents joins the one aggregate widget instead of owning a key");
  assert.deepEqual(widgetCalls[0].options, { placement: "aboveEditor" });
  assert.equal(runningGlyph(), SUBAGENT_WIDGET_SPINNER[0]);

  for (let update = 0; update < 5; update += 1) widget.update();
  assert.equal(runningGlyph(), SUBAGENT_WIDGET_SPINNER[0], "consecutive manual updates keep the current glyph");
  assert.equal(renders, 5, "every manual update still requests a render");

  intervals[0].callback();
  assert.equal(runningGlyph(), SUBAGENT_WIDGET_SPINNER[1], "one 80ms callback advances exactly one frame");
  assert.equal(renders, 6);

  for (let update = 0; update < 5; update += 1) {
    runs = [run({ status: "running", activity: { turnCount: update } })];
    widget.update();
  }
  assert.equal(runningGlyph(), SUBAGENT_WIDGET_SPINNER[1], "runtime-style activity updates cannot accelerate the spinner");
  assert.equal(widgetCalls.length, 1, "the factory must not be replaced on later updates");
  assert.equal(renders, 11);

  runs = [run({ status: "completed" })];
  widget.update();
  widget.onTurnStart();
  assert.equal(typeof widgetCalls.at(-1).content, "function", "a retained terminal run keeps the widget registered");
  assert.equal(cleared.length, 0, "the tick timer stops only when nothing is retained");

  runs = [];
  widget.update();
  assert.equal(widgetCalls.at(-1).content, undefined, "clearing every retained run removes the widget");
  assert.equal(cleared.length, 1);
});

test("one timer tick advances one shared frame regardless of active run counts", () => {
  const runs = [
    run({ id: "run-a", status: "running" }),
    run({ id: "run-b", status: "running" }),
    run({ id: "wait-a", status: "waiting" }),
    run({ id: "wait-b", status: "waiting" }),
    run({ id: "start-a", status: "starting" }),
    run({ id: "start-b", status: "starting" }),
  ];
  const intervals = [];
  let component;
  const widget = new SubagentWidget(() => runs, {
    setInterval(callback, ms) { intervals.push({ callback, ms }); return "timer"; },
    clearInterval() {},
  });
  const tui = { terminal: { columns: 200 }, requestRender() {} };
  widget.setUICtx({
    setWidget(_key, content) {
      if (typeof content === "function") component = content(tui, theme);
    },
  });
  const glyph = (id) => /^[├└]─ (\S+)/.exec(component.render().find((line) => line.includes(`[${id}]`)))?.[1];

  widget.update();
  assert.equal(intervals.length, 1);
  assert.deepEqual([glyph("run-a"), glyph("run-b")], [SUBAGENT_WIDGET_SPINNER[0], SUBAGENT_WIDGET_SPINNER[0]]);
  assert.deepEqual([glyph("wait-a"), glyph("wait-b")], ["!", "!"]);
  assert.deepEqual([glyph("start-a"), glyph("start-b")], ["◦", "◦"]);

  intervals[0].callback();
  assert.deepEqual(
    [glyph("run-a"), glyph("run-b")],
    [SUBAGENT_WIDGET_SPINNER[1], SUBAGENT_WIDGET_SPINNER[1]],
    "multiple running rows share the same single-frame advance",
  );
  assert.deepEqual([glyph("wait-a"), glyph("wait-b")], ["!", "!"], "waiting rows stay static");
  assert.deepEqual([glyph("start-a"), glyph("start-b")], ["◦", "◦"], "starting rows stay static");
});

test("terminal runs never drop or linger out and dispose clears widget and timer", () => {
  let runs = [run({ status: "failed", error: "boom" })];
  const widgetCalls = [];
  const cleared = [];
  const widget = new SubagentWidget(() => runs, {
    setInterval() { return "timer"; },
    clearInterval(timer) { cleared.push(timer); },
  });
  const ui = {
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
  assert.deepEqual(cleared, ["timer"]);
});
