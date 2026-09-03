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
  "./core.js": new URL("../extensions/oh-my-pi-slim/subagent/core.ts", import.meta.url).href,
  "./legacy-abstract.js": new URL("../extensions/oh-my-pi-slim/subagent/legacy-abstract.ts", import.meta.url).href,
  "./model-display.js": new URL("../extensions/oh-my-pi-slim/subagent/model-display.ts", import.meta.url).href,
  "./widget-renderer.js": new URL("../extensions/oh-my-pi-slim/subagent/widget-renderer.ts", import.meta.url).href,
  "./widget-display.js": new URL("../extensions/oh-my-pi-slim/subagent/widget-display.ts", import.meta.url).href,
  "./widget-glyphs.js": new URL("../extensions/oh-my-pi-slim/subagent/widget-glyphs.ts", import.meta.url).href,
  "./run-files.js": new URL("../extensions/oh-my-pi-slim/subagent/run-files.ts", import.meta.url).href,
  "../semantic-glyph.js": new URL("../extensions/oh-my-pi-slim/semantic-glyph.ts", import.meta.url).href,
  "../widget-expansion.js": new URL("../extensions/oh-my-pi-slim/widget-expansion.ts", import.meta.url).href,
  "../widget-stack.js": new URL("../extensions/oh-my-pi-slim/widget-stack.ts", import.meta.url).href,
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
  SubagentRegistry,
  restoreRunJournal,
  sortRetainedSubagentRuns,
} = await import("../extensions/oh-my-pi-slim/subagent/core.ts");
const { SubagentWidget, assembleSubagentWidgetState } = await import("../extensions/oh-my-pi-slim/subagent/widget.ts");
const {
  WIDGET_STACK_KEY,
  resetWidgetStackHost,
} = await import("../extensions/oh-my-pi-slim/widget-stack-host.ts");

beforeEach(() => resetWidgetStackHost());
const {
  MAX_SUBAGENT_WIDGET_LINES,
  SUBAGENT_WIDGET_SPINNER,
  formatWidgetModel,
  renderActiveRunLine,
  renderFinishedRunLine,
  renderSubagentWidgetLines,
} = await import("../extensions/oh-my-pi-slim/subagent/widget-renderer.ts");

const {
  modelSpecBase,
  parseModelSpec,
  sameModelSpecBase,
} = await import("../extensions/oh-my-pi-slim/subagent/model-display.ts");

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

const VIEWER_HINT = " · ctrl+shift+←/→ viewer";

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
  assert.deepEqual(widgetIds, ["waitone", "runlate", "starting"]);
  assert.doesNotMatch(widgetLines.join("\n"), /\[termnew\]|\[termold\]/);

  const ties = [
    run({ id: "terminal-b", status: "completed", createdAt: "2026-04-16T23:50:00.000Z", updatedAt: "2026-04-16T23:59:00.000Z" }),
    run({ id: "terminal-a", status: "failed", createdAt: "2026-04-16T23:50:00.000Z", updatedAt: "2026-04-16T23:59:00.000Z" }),
    run({ id: "waiting-b", status: "waiting", createdAt: "2026-04-16T23:48:00.000Z" }),
    run({ id: "running-a", status: "running", createdAt: "2026-04-16T23:48:00.000Z" }),
  ];
  assert.deepEqual(sortRetainedSubagentRuns(ties).map((item) => item.id), ["running-a", "waiting-b", "terminal-a", "terminal-b"]);
});

test("pure active renderer uses one abstract-first stats line and terminal renderers keep outcome icons", () => {
  const running = renderActiveRunLine(
    run({ status: "running", model: "openai/gpt-5.6-sol:xhigh", updatedAt: "2026-04-16T23:59:56.000Z" }),
    0,
    theme,
    NOW_MS,
  );
  assert.equal(running, "⠋  **implement the widget** [run-1] · ↻  0 · 5.0s");
  assert.doesNotMatch(running, /Subagent|openai|gpt-5\.6-sol|xhigh|thinking/);

  const waiting = renderActiveRunLine(run({
    status: "waiting",
    model: "openai/gpt-5.6-sol:xhigh",
    request: { runId: "run-1", reason: "need_decision", message: "Choose A or B", createdAt: "now" },
  }), 3, theme, NOW_MS);
  assert.equal(waiting, "!  **implement the widget** [run-1] · ↻  0 · 5.0s");
  assert.doesNotMatch(`${running}\n${waiting}`, /Choose A or B|[⠋!↻] [^ ]|[⠋!↻] {3}/);

  const styledRunning = renderActiveRunLine(run({ status: "running" }), 0, roleAnsiTheme, NOW_MS);
  const styledWaiting = renderActiveRunLine(run({ status: "waiting" }), 0, roleAnsiTheme, NOW_MS);
  assert.doesNotMatch(`${styledRunning}\n${styledWaiting}`, /Subagent|provider|model|high|thinking/);

  assert.match(renderFinishedRunLine(run({ status: "completed" }), theme, NOW_MS), /✓/);
  assert.match(renderFinishedRunLine(run({ status: "failed", error: "boom" }), theme, NOW_MS), /✗.*failed: boom/);
  assert.match(renderFinishedRunLine(run({ status: "interrupted" }), theme, NOW_MS), /✗.*interrupted/);
});

test("multiline waiting messages stay hidden and every renderer result remains one physical line", () => {
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
  const activeLine = renderActiveRunLine(waiting, 0, theme, NOW_MS);
  const finishedLine = renderFinishedRunLine(failed, theme, NOW_MS);
  const widgetLines = renderSubagentWidgetLines({
    runs: [failed, waiting],
    spinnerFrame: 0,
    terminalWidth: 200,
    theme,
    nowMs: NOW_MS,
  });

  assert.equal(widgetLines.length, 2, "the heading and waiting run each use one line while terminal rows remain hidden");
  assert.doesNotMatch(widgetLines.join("\n"), /failed-multiline|Primary failure/);
  assert.doesNotMatch(activeLine, /Choose the safe option|Do not render this second line/);
  assert.match(finishedLine, /failed: Primary failure$/);
  assert.doesNotMatch(finishedLine, /stack detail must stay hidden/);
  for (const line of [activeLine, finishedLine, ...widgetLines]) {
    assert.equal(typeof line, "string");
    assert.equal(line.includes("\n"), false, "every returned renderer string is one physical line");
  }
});

test("single-line formatting keeps the abstract before turns, tools, tokens, context, compactions, and elapsed time", () => {
  const toolLine = renderActiveRunLine(run({
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
  assert.equal(toolLine, "⠋  **implement the widget** [run-1] · ↻  3 · 2 tool uses · 12.3k token (72% · ⇊  2) · 5.0s");
  assert.doesNotMatch(toolLine, /openai|gpt-5\.6-sol|minimal|reading|searching|ignored/);

  const responseLine = renderActiveRunLine(run({
    status: "running",
    activity: {
      turnCount: 1, toolUses: 0, activeTools: {},
      responseText: "A concise response line that is visible\nsecond line",
      tokens: 0, compactionCount: 0,
    },
  }), 0, theme, NOW_MS);
  assert.equal(responseLine, "⠋  **implement the widget** [run-1] · ↻  1 · 5.0s");
  assert.doesNotMatch(responseLine, /provider|model|high|concise response/);
});

test("pure widget renderer gives every active and queued run one abstract-first line", () => {
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
    `**●**  **Subagents (1/3)**${VIEWER_HINT}`,
    "├─ ⠋  **implement the widget** [live] · ↻  0 · 5.0s",
    "└─ ◦  implement the widget [queue] · ↻  0 · 5.0s",
  ]);
  assert.doesNotMatch(lines.join("\n"), /\[done\]/);
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

  const priorityPrefix = "└─ ⠋  摘要优先🙂 [priority]";
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
  assert.equal(stripVTControlCharacters(priorityLines[1]), priorityPrefix, "narrow wide-character output keeps the complete abstract and identity before dropping stats");
  assert.doesNotMatch(priorityLines.join("\n"), /ACTIVITY-TAIL/);
  assert.ok(priorityLines.every((line) => visibleWidth(line) <= visibleWidth(priorityPrefix)));
});

test("pure widget renderer caps at 12 lines, counts one line per run, and excludes terminal rows from overflow", () => {
  const runs = [];
  for (let index = 0; index < 11; index += 1) {
    runs.push(run({
      id: `a-${String(index).padStart(2, "0")}`,
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
  assert.equal(lines[0], `**●**  **Subagents (2/15)**${VIEWER_HINT}`, "hidden rows never change the retained counts");
  assert.match(lines[1], /implement the widget.*\[a-00\].*↻  0/);
  assert.match(lines[2], /implement the widget.*\[a-01\].*↻  0/);
  assert.match(lines[10], /implement the widget.*\[a-09\].*↻  0/);
  assert.equal(lines[11], "└─ +3 more (1 active, 2 queued)");
  assert.doesNotMatch(lines.join("\n"), /a-10|queue-|finished-|openai|gpt-5\.6-sol|xhigh|thinking/);

  const terminalRuns = Array.from({ length: 9 }, (_, index) => run({
    id: `term-${index}`,
    status: index % 2 === 0 ? "completed" : "failed",
  }));
  const compact = renderSubagentWidgetLines({
    runs: [run({ id: "active", status: "running" }), run({ id: "starting", status: "starting" }), ...terminalRuns],
    spinnerFrame: 0,
    terminalWidth: 240,
    theme,
    nowMs: NOW_MS,
  });
  assert.equal(compact[0], `**●**  **Subagents (9/11)**${VIEWER_HINT}`);
  assert.equal(compact.length, 3, "terminal history never consumes the line budget");
  assert.match(compact[1], /\[active\]/);
  assert.match(compact[2], /\[starting\]/);
  assert.doesNotMatch(compact.join("\n"), /\[term-/);
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
  assert.equal(heading(mixed), `**●**  **Subagents (5/8)**${VIEWER_HINT}`);
  assert.equal(
    heading(mixed, roleAnsiTheme),
    `\u001b[35m\u001b[1m●\u001b[22m\u001b[0m  \u001b[35m\u001b[1mSubagents (5/8)\u001b[22m\u001b[0m\u001b[2m${VIEWER_HINT}\u001b[0m`,
  );
  assert.equal(stripVTControlCharacters(heading(mixed, roleAnsiTheme)), `●  Subagents (5/8)${VIEWER_HINT}`);
  for (const status of ["starting", "running", "waiting"]) {
    assert.equal(
      heading([run({ id: "live", status }), run({ id: "term", status: "completed" })]),
      `**●**  **Subagents (1/2)**${VIEWER_HINT}`,
      `${status} must count as live and stay out of the numerator`,
    );
  }

  const terminalOnly = mixed.filter((value) => !["starting", "running", "waiting"].includes(value.status));
  assert.equal(heading(terminalOnly), `○  Subagents (5/5)${VIEWER_HINT}`);
  assert.equal(heading(terminalOnly, roleAnsiTheme), `\u001b[2m○\u001b[0m  \u001b[2mSubagents (5/5)\u001b[0m\u001b[2m${VIEWER_HINT}\u001b[0m`);
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
  assert.equal(component.render()[0], `**●**  **Subagents (1/2)**${VIEWER_HINT}`);

  runs = [run({ id: "live", status: "waiting" }), run({ id: "done", status: "completed" })];
  widget.update();
  assert.equal(component.render()[0], `**●**  **Subagents (1/2)**${VIEWER_HINT}`);

  runs = [run({ id: "live", status: "interrupted" }), run({ id: "done", status: "completed" })];
  widget.update();
  assert.equal(component.render()[0], `○  Subagents (2/2)${VIEWER_HINT}`, "the last live run settling flips the heading to idle");

  runs = [...runs, run({ id: "fresh", status: "starting" })];
  widget.onTurnStart();
  assert.equal(component.render()[0], `**●**  **Subagents (2/3)**${VIEWER_HINT}`, "a restored or created run flips the heading back to active");

  runs = runs.filter((item) => item.id !== "done");
  widget.update();
  assert.equal(component.render()[0], `**●**  **Subagents (1/2)**${VIEWER_HINT}`, "removing one retained ID updates both counts immediately");
  assert.doesNotMatch(component.render().join("\n"), /\[done\]/, "the removed retained ID leaves the widget body");

  runs = runs.filter((item) => item.id !== "live");
  widget.update();
  assert.equal(component.render()[0], "**●**  **Subagents (0/1)**");

  runs = [];
  widget.update();
  assert.equal(widgetCalls.at(-1).content, undefined, "removing the last retained ID retracts the widget");
});

test("Subagents body permanently keeps starting, running, and waiting rows while hiding terminal rows", () => {
  const runs = [
    run({ id: "live", status: "running", model: "openai/gpt-5.6-sol:xhigh", updatedAt: "2026-04-16T23:59:56.000Z" }),
    run({ id: "held", status: "waiting", model: "openai/gpt-5.6-sol:xhigh" }),
    run({ id: "queue", status: "starting" }),
    run({ id: "ok", status: "completed" }),
    run({ id: "bad", status: "failed", error: "boom" }),
    run({ id: "stopped", status: "interrupted" }),
  ];
  const originalRuns = structuredClone(runs);

  const lines = renderSubagentWidgetLines({
    runs, spinnerFrame: 0, terminalWidth: 200, theme, nowMs: NOW_MS,
  });
  assert.deepEqual(lines, [
    `**●**  **Subagents (3/6)**${VIEWER_HINT}`,
    "├─ !  **implement the widget** [held] · ↻  0 · 5.0s",
    "├─ ⠋  **implement the widget** [live] · ↻  0 · 5.0s",
    "└─ ◦  implement the widget [queue] · ↻  0 · 5.0s",
  ]);
  assert.doesNotMatch(lines.join("\n"), /\[ok\]|\[bad\]|\[stopped\]|ctrl\+o|expand/);

  const liveOnly = runs.filter((value) => ["starting", "running", "waiting"].includes(value.status));
  assert.doesNotMatch(
    renderSubagentWidgetLines({ runs: liveOnly, spinnerFrame: 0, terminalWidth: 200, theme, nowMs: NOW_MS })[0],
    /viewer|expand/,
    "a widget with no hidden terminal history needs no viewer hint",
  );

  const startingOnly = [run({ id: "queue", status: "starting" })];
  assert.deepEqual(renderSubagentWidgetLines({
    runs: startingOnly, spinnerFrame: 0, terminalWidth: 200, theme, nowMs: NOW_MS,
  }), [
    "**●**  **Subagents (0/1)**",
    "└─ ◦  implement the widget [queue] · ↻  0 · 5.0s",
  ]);

  const terminalOnly = runs.filter((value) => !["starting", "running", "waiting"].includes(value.status));
  assert.deepEqual(renderSubagentWidgetLines({
    runs: terminalOnly, spinnerFrame: 0, terminalWidth: 200, theme, nowMs: NOW_MS,
  }), [`○  Subagents (3/3)${VIEWER_HINT}`], "terminal-only history keeps a heading without terminal rows");

  const soloActive = renderSubagentWidgetLines({
    runs: [runs[0], runs[3]], spinnerFrame: 0, terminalWidth: 200, theme, nowMs: NOW_MS,
  });
  assert.deepEqual(soloActive, [
    `**●**  **Subagents (1/2)**${VIEWER_HINT}`,
    "└─ ⠋  **implement the widget** [live] · ↻  0 · 5.0s",
  ]);
  assert.deepEqual(runs, originalRuns, "compact rendering leaves retained run data unchanged");
  assert.deepEqual(renderSubagentWidgetLines({ runs: [], spinnerFrame: 0, terminalWidth: 200, theme, nowMs: NOW_MS }), []);
});

test("Subagents Viewer hint stays complete when wide and disappears atomically when narrow", () => {
  const mixed = [run({ id: "live", status: "running" }), run({ id: "ok", status: "completed" })];
  const originalMixed = structuredClone(mixed);
  const terminalOnly = [run({ id: "ok", status: "completed" })];
  const liveOnly = [run({ id: "live", status: "running" })];
  const heading = (runs, widgetTheme, terminalWidth) => renderSubagentWidgetLines({
    runs, spinnerFrame: 0, terminalWidth, theme: widgetTheme, nowMs: NOW_MS,
  })[0];
  const idleBase = "○  Subagents (1/1)";
  const full = `${idleBase}${VIEWER_HINT}`;

  assert.equal(heading(terminalOnly, theme, visibleWidth(full)), full);
  assert.equal(
    heading(terminalOnly, theme, visibleWidth(full) - 1),
    idleBase,
    "tight headings drop the Viewer hint instead of truncating it",
  );

  const dimViewerHint = `\u001b[2m${VIEWER_HINT}\u001b[0m`;
  const activeHeading = heading(mixed, roleAnsiTheme, 200);
  assert.equal(
    activeHeading,
    `\u001b[35m\u001b[1m●\u001b[22m\u001b[0m  \u001b[35m\u001b[1mSubagents (1/2)\u001b[22m\u001b[0m${dimViewerHint}`,
  );
  const idleHeading = heading(terminalOnly, roleAnsiTheme, visibleWidth(full));
  assert.equal(idleHeading, `\u001b[2m○\u001b[0m  \u001b[2mSubagents (1/1)\u001b[0m${dimViewerHint}`);
  assert.ok(visibleWidth(idleHeading) <= visibleWidth(full));
  assert.doesNotMatch(activeHeading.slice(activeHeading.indexOf(dimViewerHint)), /\u001b\[1m/);
  assert.doesNotMatch(activeHeading, /ctrl\+o|expand/);
  assert.doesNotMatch(heading(liveOnly, theme, 200), /viewer|expand/);

  for (const width of [1, 5, 10, visibleWidth(idleBase)]) {
    const narrow = heading(terminalOnly, theme, width);
    assert.ok(visibleWidth(narrow) <= width, `width ${width} must stay inside the terminal`);
    assert.doesNotMatch(narrow, /·|viewer|expand|ctrl|←|→/, `width ${width} must not expose a partial semantic hint`);
  }
  assert.deepEqual(mixed, originalMixed, "hint rendering leaves retained run data unchanged");
});

test("compact Subagents overflow keeps queued rows eligible and terminal rows out of more", () => {
  const runs = [
    ...Array.from({ length: 12 }, (_, index) => run({
      id: `a-${String(index).padStart(2, "0")}`,
      status: index === 0 ? "waiting" : "running",
      model: "openai/gpt-5.6-sol:xhigh",
    })),
    run({ id: "queue-0", status: "starting" }),
    ...Array.from({ length: 4 }, (_, index) => run({ id: `finished-${index}`, status: "completed" })),
  ];
  const compact = renderSubagentWidgetLines({
    runs, spinnerFrame: 0, terminalWidth: 200, theme, nowMs: NOW_MS,
  });

  assert.equal(compact.length, MAX_SUBAGENT_WIDGET_LINES);
  assert.equal(compact[0], `**●**  **Subagents (4/17)**${VIEWER_HINT}`, "heading counts ignore row filtering and overflow");
  assert.equal(compact.at(-1), "└─ +3 more (2 active, 1 queued)", "overflow counts both eligible active and queued rows");
  assert.doesNotMatch(compact.join("\n"), /finished-|queue-0|a-10|a-11/);
  assert.equal(compact.slice(1, -1).length, 10, "the 12-line budget keeps ten one-line active entries");
});

test("SubagentWidget ignores Pi expansion state without re-registering the widget", () => {
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
  const initial = component.render();
  assert.equal(initial.length, 2);
  assert.equal(initial[0], `**●**  **Subagents (1/2)**${VIEWER_HINT}`);
  assert.doesNotMatch(initial.join("\n"), /\[ok\]|ctrl\+o|expand/);

  expanded = false;
  assert.deepEqual(component.render(), initial, "Ctrl+O collapse state does not affect Subagents");
  expanded = true;
  assert.deepEqual(component.render(), initial, "Ctrl+O expanded state does not affect Subagents");
  assert.equal(
    widgetCalls.filter((call) => typeof call.content === "function").length,
    registrations,
    "expansion changes must not re-register the widget",
  );
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
