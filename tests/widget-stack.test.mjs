import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import test, { beforeEach } from "node:test";
import { piRoot } from "./fixtures/pi-install.mjs";
const dependencyMap = {
  "@earendil-works/pi-coding-agent": pathToFileURL(`${piRoot}/dist/index.js`).href,
  "@earendil-works/pi-tui": pathToFileURL(`${piRoot}/node_modules/@earendil-works/pi-tui/dist/index.js`).href,
  typebox: pathToFileURL(`${piRoot}/node_modules/typebox/build/index.mjs`).href,
  "./goal-widget.js": new URL("../extensions/oh-my-pi-slim/goal-widget.ts", import.meta.url).href,
  "./loop-widget.js": new URL("../extensions/oh-my-pi-slim/loop-widget.ts", import.meta.url).href,
  "./monitor-widget.js": new URL("../extensions/oh-my-pi-slim/monitor-widget.ts", import.meta.url).href,
  "./semantic-glyph.js": new URL("../extensions/oh-my-pi-slim/semantic-glyph.ts", import.meta.url).href,
  "./subagent-core.js": new URL("../extensions/oh-my-pi-slim/subagent-core.ts", import.meta.url).href,
  "./subagent-model-display.js": new URL("../extensions/oh-my-pi-slim/subagent-model-display.ts", import.meta.url).href,
  "./subagent-widget.js": new URL("../extensions/oh-my-pi-slim/subagent-widget.ts", import.meta.url).href,
  "./subagent-widget-display.js": new URL("../extensions/oh-my-pi-slim/subagent-widget-display.ts", import.meta.url).href,
  "./subagent-widget-glyphs.js": new URL("../extensions/oh-my-pi-slim/subagent-widget-glyphs.ts", import.meta.url).href,
  "./subagent-widget-renderer.js": new URL("../extensions/oh-my-pi-slim/subagent-widget-renderer.ts", import.meta.url).href,
  "./subagent-run-files.js": new URL("../extensions/oh-my-pi-slim/subagent-run-files.ts", import.meta.url).href,
  "./widget-expansion.js": new URL("../extensions/oh-my-pi-slim/widget-expansion.ts", import.meta.url).href,
  "./widget-stack.js": new URL("../extensions/oh-my-pi-slim/widget-stack.ts", import.meta.url).href,
  "./widget-stack-host.js": new URL("../extensions/oh-my-pi-slim/widget-stack-host.ts", import.meta.url).href,
  "../oh-my-pi-slim/semantic-glyph.js": new URL("../extensions/oh-my-pi-slim/semantic-glyph.ts", import.meta.url).href,
  "../oh-my-pi-slim/widget-expansion.js": new URL("../extensions/oh-my-pi-slim/widget-expansion.ts", import.meta.url).href,
  "../oh-my-pi-slim/widget-stack.js": new URL("../extensions/oh-my-pi-slim/widget-stack.ts", import.meta.url).href,
  "../oh-my-pi-slim/widget-stack-host.js": new URL("../extensions/oh-my-pi-slim/widget-stack-host.ts", import.meta.url).href,
  "./core.js": new URL("../extensions/todo/core.ts", import.meta.url).href,
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    const url = dependencyMap[specifier];
    return url ? { url, shortCircuit: true } : nextResolve(specifier, context);
  },
});

const {
  WIDGET_STACK_HOST_GLOBAL_KEY,
  WIDGET_STACK_HOST_PROTOCOL,
  WIDGET_STACK_KEY,
  resetWidgetStackHost,
  widgetStackHost,
} = await import("../extensions/oh-my-pi-slim/widget-stack-host.ts");
const {
  WIDGET_STACK_SECTION_IDS,
  orderWidgetStackSections,
  renderWidgetStack,
} = await import("../extensions/oh-my-pi-slim/widget-stack.ts");
const { visibleWidth } = await import("@earendil-works/pi-tui");
const { GoalWidget } = await import("../extensions/oh-my-pi-slim/goal-widget.ts");
const { TodoWidget } = await import("../extensions/todo/widget.ts");
const { SubagentWidget } = await import("../extensions/oh-my-pi-slim/subagent-widget.ts");
const { MonitorWidget } = await import("../extensions/oh-my-pi-slim/monitor-widget.ts");
const { LoopWidget } = await import("../extensions/oh-my-pi-slim/loop-widget.ts");

// A second, independent copy of the same source files stands in for Pi's per-extension Jiti graphs.
const secondGraph = await import("../extensions/oh-my-pi-slim/widget-stack-host.ts?graph=todo");

beforeEach(() => resetWidgetStackHost());

const theme = {
  fg: (_color, text) => text,
  bg: (_color, text) => text,
  bold: (text) => text,
  strikethrough: (text) => `~${text}~`,
};

const NOW_MS = Date.parse("2026-06-01T00:12:00.000Z");
const SECTION_ORDER = ["goal", "todos", "agents", "monitors", "loops"];

function goalView(status) {
  return {
    goal: {
      status,
      abstract: `goal-${status}`,
      objective: "objective",
      criteria: ["one"],
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
    },
    elapsedMs: 60_000,
    continuationCount: 1,
    ownedChildRunCount: 0,
    main: { tokens: 10, tools: 1, turns: 1, compactions: 0 },
    children: { runCount: 0, tokens: 0, tools: 0, turns: 0, compactions: 0 },
  };
}

function todoTask(status) {
  return { subject: `todo-${status}`, abstract: "abstract", status, blockedBy: [] };
}

function subagentRun(status) {
  return {
    id: `run-${status}`,
    agent: "fixer",
    abstract: `agent-${status}`,
    task: "task",
    cwd: "/repo",
    model: "provider/model",
    deniedTools: [],
    status,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:10:00.000Z",
  };
}

function monitorItem(status) {
  return {
    id: `0000000${status === "running" ? 1 : 2}`,
    abstract: `monitor-${status}`,
    status,
    createdAt: "2026-06-01T00:00:00.000Z",
    endedAt: status === "running" ? null : "2026-06-01T00:05:00.000Z",
  };
}

function loopItem(status) {
  return {
    id: "0000000a",
    abstract: `loop-${status}`,
    prompt: "prompt",
    interval: "10s",
    status,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    nextFireAt: "2026-06-01T00:00:10.000Z",
    fireCount: 0,
    failureCount: 0,
    lastFiredAt: null,
    lastFailedAt: null,
    lastError: null,
  };
}

/** Builds one real instance of all five widgets over mutable data, plus a UI double. */
function stack({ getToolsExpanded } = {}) {
  const state = {
    goal: goalView("active"),
    todos: [todoTask("pending")],
    agents: [subagentRun("running")],
    monitors: [monitorItem("running")],
    loops: [loopItem("active")],
  };
  const calls = [];
  const timers = [];
  let renders = 0;
  let component;
  const tui = { terminal: { columns: 200 }, requestRender() { renders += 1; } };
  const ui = {
    theme,
    setStatus() {},
    setWidget(key, content, options) {
      calls.push({ key, content, options });
      component = typeof content === "function" ? content(tui, theme) : undefined;
    },
  };
  if (getToolsExpanded) ui.getToolsExpanded = getToolsExpanded;
  const clock = {
    setInterval(callback, milliseconds) {
      const timer = { callback, milliseconds, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearInterval() {},
    setTimeout(callback, milliseconds) {
      const timer = { callback, milliseconds, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimeout() {},
  };
  const goal = new GoalWidget(() => state.goal, { nowMs: () => NOW_MS, ...clock });
  const todos = new TodoWidget();
  const agents = new SubagentWidget(() => state.agents, clock);
  const monitors = new MonitorWidget(() => state.monitors, clock);
  const loops = new LoopWidget(() => state.loops, { nowMs: () => NOW_MS, ...clock });

  const bindAll = () => {
    goal.setContext(ui);
    todos.setContext(ui);
    agents.setUICtx(ui);
    monitors.setContext(ui);
    loops.setContext(ui);
  };
  const publishAll = () => {
    goal.update();
    todos.update(state.todos);
    agents.update();
    monitors.update();
    loops.update();
  };
  return {
    state, calls, timers, ui, tui, goal, todos, agents, monitors, loops, bindAll, publishAll,
    get renders() { return renders; },
    get component() { return component; },
    registrations: () => calls.filter((call) => typeof call.content === "function").length,
    clears: () => calls.filter((call) => call.content === undefined).length,
    lines: (width = 200) => component.render(width),
    headings: (width = 200) => component.render(width).filter((line) => /^[●○] {2}/.test(line)),
  };
}

function fakeSection(id, active, lines) {
  return { id, isActive: () => active, render: () => lines };
}

/** Echoes back exactly the width the host resolved for this render. */
function widthSection(id = "monitors") {
  return { id, isActive: () => true, render: (input) => [`w=${input.width}`] };
}

/** A UI double that records setWidget but only runs the factory once `runs` is turned on. */
function recordingUi({ runs = true, columns = 100 } = {}) {
  const calls = [];
  const state = { runs, component: undefined, renders: 0 };
  const tui = { terminal: { columns }, requestRender() { state.renders += 1; } };
  return {
    calls,
    state,
    ui: {
      theme,
      setStatus() {},
      setWidget(key, content, options) {
        calls.push({ key, content, options });
        if (state.runs && typeof content === "function") state.component = content(tui, theme);
        if (content === undefined) state.component = undefined;
      },
    },
    registrations: () => calls.filter((call) => typeof call.content === "function").length,
  };
}

test("the stack sorts every active combination with active sections above idle ones in fixed product order", () => {
  const labels = { goal: "Goal", todos: "Todos", agents: "Agents", monitors: "Monitors", loops: "Loops" };
  for (let mask = 0; mask < 32; mask += 1) {
    const flags = Object.fromEntries(SECTION_ORDER.map((id, index) => [id, (mask & (1 << index)) !== 0]));
    // Feed the sections in reverse product order so the result can only come from the sort.
    const sections = [...SECTION_ORDER].reverse().map((id) => fakeSection(id, flags[id], [labels[id]]));
    const expected = [
      ...SECTION_ORDER.filter((id) => flags[id]),
      ...SECTION_ORDER.filter((id) => !flags[id]),
    ];
    assert.deepEqual(
      orderWidgetStackSections(sections).map((section) => section.id),
      expected,
      `mask ${mask} must keep active sections on top and Goal → Todos → Agents → Monitors → Loops inside each group`,
    );
    assert.deepEqual(
      renderWidgetStack(sections, { width: 80, theme, expanded: true }),
      expected.map((id) => labels[id]),
      `mask ${mask} must concatenate the same order it sorts`,
    );
  }
});

test("the stack concatenates section bodies with no separator, no blank line, and no global cap", () => {
  const sections = [
    fakeSection("loops", false, ["loop-head", "loop-row"]),
    fakeSection("goal", true, ["goal-head", "goal-row"]),
  ];
  const lines = renderWidgetStack(sections, { width: 80, theme, expanded: true });
  assert.deepEqual(lines, ["goal-head", "goal-row", "loop-head", "loop-row"]);
  assert.ok(lines.every((line) => line !== ""), "the stack never inserts a blank line between sections");

  const tall = [
    fakeSection("goal", true, Array.from({ length: 12 }, (_, index) => `goal-${index}`)),
    fakeSection("todos", true, Array.from({ length: 12 }, (_, index) => `todo-${index}`)),
  ];
  assert.equal(
    renderWidgetStack(tall, { width: 80, theme, expanded: true }).length,
    24,
    "each section keeps its own budget and the stack adds no cap of its own",
  );
  assert.deepEqual(renderWidgetStack([], { width: 80, theme, expanded: true }), []);
});

test("every section's active flag comes from the same source as its own heading glyph", () => {
  const cases = [
    ["goal", { goal: goalView("active") }, { goal: goalView("paused") }],
    ["goal", { goal: goalView("retry_wait") }, { goal: goalView("completed") }],
    ["todos", { todos: [todoTask("in_progress")] }, { todos: [todoTask("completed")] }],
    ["todos", { todos: [todoTask("pending")] }, { todos: [todoTask("completed")] }],
    ["agents", { agents: [subagentRun("starting")] }, { agents: [subagentRun("completed")] }],
    ["agents", { agents: [subagentRun("running")] }, { agents: [subagentRun("failed")] }],
    ["agents", { agents: [subagentRun("waiting")] }, { agents: [subagentRun("interrupted")] }],
    ["monitors", { monitors: [monitorItem("running")] }, { monitors: [monitorItem("completed")] }],
    ["monitors", { monitors: [monitorItem("running")] }, { monitors: [monitorItem("killed")] }],
    ["loops", { loops: [loopItem("active")] }, { loops: [loopItem("paused")] }],
  ];
  for (const [id, activeState, idleState] of cases) {
    for (const [patch, expectedActive] of [[activeState, true], [idleState, false]]) {
      const harness = stack();
      Object.assign(harness.state, patch);
      harness.bindAll();
      harness.publishAll();
      const section = harness.component.render(200);
      const heading = section.find((line) => line.startsWith(expectedActive ? "● " : "○ ")
        && new RegExp(`^[●○] {2}${{ goal: "Goal", todos: "Todos", agents: "Agents", monitors: "Monitors", loops: "Loops" }[id]}`).test(line));
      assert.ok(heading, `${id} must render a ${expectedActive ? "filled" : "hollow"} heading for this state`);
      const ordered = harness.component.render(200);
      const rank = ordered.findIndex((line) => line === heading);
      const activeHeadings = ordered.filter((line) => line.startsWith("● ")).length;
      const headingRanks = ordered
        .map((line, index) => ({ line, index }))
        .filter((entry) => /^[●○] {2}/.test(entry.line))
        .map((entry) => entry.index);
      const position = headingRanks.indexOf(rank);
      assert.equal(
        position < activeHeadings,
        expectedActive,
        `${id} sits in the ${expectedActive ? "active" : "idle"} group exactly when its own heading says so`,
      );
    }
  }
});

test("five real widgets register one aggregate key once and reorder on every active flip without touching setWidget", () => {
  const harness = stack();
  harness.bindAll();
  harness.publishAll();
  assert.equal(harness.calls.length, 1, "five widgets produce exactly one setWidget call");
  assert.equal(harness.registrations(), 1, "five sections share exactly one registration");
  assert.equal(harness.calls[0].key, WIDGET_STACK_KEY);
  assert.deepEqual(harness.calls[0].options, { placement: "aboveEditor" });
  assert.deepEqual(harness.headings(), ["●  Goal · ↻  active · goal-active", "●  Todos (0/1)", "●  Agents (0/1)", "●  Monitors (0/1)", "●  Loops"]);

  const flips = [
    ["goal", () => { harness.state.goal = goalView("paused"); harness.goal.update(); }],
    ["todos", () => { harness.state.todos = [todoTask("completed")]; harness.todos.update(harness.state.todos); }],
    ["agents", () => { harness.state.agents = [subagentRun("completed")]; harness.agents.update(); }],
    ["monitors", () => { harness.state.monitors = [monitorItem("completed")]; harness.monitors.update(); }],
    ["loops", () => { harness.state.loops = [loopItem("paused")]; harness.loops.update(); }],
  ];
  for (const [id, flip] of flips) {
    const rendersBefore = harness.renders;
    const callsBefore = harness.calls.length;
    flip();
    assert.equal(harness.calls.length, callsBefore, `${id} going idle must not call setWidget again`);
    assert.ok(harness.renders > rendersBefore, `${id} going idle must request an aggregate render`);
  }
  assert.deepEqual(harness.headings(), ["○  Goal · Ⅱ  paused · goal-paused", "○  Todos (1/1)", "○  Agents (1/1) · ctrl+shift+←/→ viewer", "○  Monitors (1/1)", "○  Loops"]);

  harness.state.monitors = [monitorItem("running")];
  harness.monitors.update();
  assert.equal(harness.registrations(), 1, "flipping back stays inside the same registration");
  assert.deepEqual(harness.headings().slice(0, 2), ["●  Monitors (0/1)", "○  Goal · Ⅱ  paused · goal-paused"]);
});

test("an empty section contributes no lines and the aggregate key is revoked only when every section is gone", () => {
  const harness = stack();
  harness.bindAll();
  harness.publishAll();
  assert.equal(harness.headings().length, 5);

  harness.state.loops = [];
  harness.loops.update();
  assert.equal(harness.clears(), 0, "one empty section never revokes the shared key");
  assert.equal(harness.headings().length, 4);
  assert.doesNotMatch(harness.lines().join("\n"), /Loops/, "an empty section contributes no lines at all");

  harness.state.goal = { goal: null, elapsedMs: null, continuationCount: 0, ownedChildRunCount: 0, main: { tokens: 0, tools: 0, turns: 0, compactions: 0 }, children: { runCount: 0, tokens: 0, tools: 0, turns: 0, compactions: 0 } };
  harness.goal.update();
  harness.state.todos = [];
  harness.todos.update(harness.state.todos);
  harness.state.agents = [];
  harness.agents.update();
  assert.equal(harness.clears(), 0);
  assert.equal(harness.headings().length, 1);

  harness.state.monitors = [];
  harness.monitors.update();
  assert.equal(harness.calls.at(-1).content, undefined, "the last section leaving revokes the aggregate key");
  assert.equal(harness.clears(), 1);

  harness.state.monitors = [monitorItem("running")];
  harness.monitors.update();
  assert.equal(harness.registrations(), 2, "a section returning after a full clear registers the aggregate again");
});

test("a third-party widget keeps its own key and its relative position never moves when a section flips", () => {
  const harness = stack();
  harness.bindAll();
  harness.publishAll();
  harness.ui.setWidget("third-party:notes", () => ({ render: () => ["notes"], invalidate() {} }), { placement: "aboveEditor" });
  const foreignCalls = harness.calls.filter((call) => call.key === "third-party:notes");
  assert.equal(foreignCalls.length, 1);

  const keysBefore = harness.calls.map((call) => call.key);
  harness.state.goal = goalView("paused");
  harness.goal.update();
  harness.state.agents = [subagentRun("completed")];
  harness.agents.update();
  assert.deepEqual(harness.calls.map((call) => call.key), keysBefore, "flips never re-register any key, ours or a third party's");
  assert.equal(
    harness.calls.filter((call) => call.key !== WIDGET_STACK_KEY && call.key !== "third-party:notes").length,
    0,
    "the package owns exactly one widget key",
  );
});

test("the host is a globalThis singleton shared by a second module graph of the same source", () => {
  const first = widgetStackHost();
  const second = secondGraph.widgetStackHost();
  assert.notEqual(secondGraph.widgetStackHost, widgetStackHost, "the two graphs really are separate module copies");
  assert.equal(second, first, "both copies resolve the same host instance");
  assert.equal(first.protocol, WIDGET_STACK_HOST_PROTOCOL);
  assert.equal(secondGraph.WIDGET_STACK_HOST_GLOBAL_KEY, WIDGET_STACK_HOST_GLOBAL_KEY);

  const calls = [];
  let component;
  const tui = { terminal: { columns: 100 }, requestRender() {} };
  const ui = {
    theme,
    setWidget(key, content) {
      calls.push({ key, content });
      component = typeof content === "function" ? content(tui, theme) : undefined;
    },
  };
  // OMPS binds and publishes through one copy, Todo through the other.
  first.bind("oh-my-pi-slim:extension", ui);
  second.bind("oh-my-pi-slim:todo-extension", ui);
  first.publish("monitors", fakeSection("monitors", true, ["monitors"]));
  second.publish("todos", fakeSection("todos", false, ["todos"]));
  assert.equal(calls.length, 1, "two graphs still produce one registration");
  assert.deepEqual(component.render(100), ["monitors", "todos"]);

  // The first extension to shut down must not clear a key the second one still needs.
  first.unbind("oh-my-pi-slim:extension", ui);
  assert.equal(calls.at(-1).content !== undefined, true, "releasing one owner keeps the shared binding alive");
  assert.equal(second.boundUI(), ui);
  second.unbind("oh-my-pi-slim:todo-extension", ui);
  assert.equal(calls.at(-1).content, undefined, "the last owner releasing clears the aggregate");
  assert.equal(first.boundUI(), undefined);

  resetWidgetStackHost();
  assert.notEqual(secondGraph.widgetStackHost(), first, "a reset drops the shared instance for both graphs");
});

test("rebinding moves the aggregate to the new UI and a late unbind never clears a newer binding", () => {
  const host = widgetStackHost();
  const first = [];
  const second = [];
  const makeUi = (calls) => ({ theme, setWidget(key, content) { calls.push({ key, content }); } });
  const uiA = makeUi(first);
  const uiB = makeUi(second);

  host.bind("owner", uiA);
  host.publish("monitors", fakeSection("monitors", true, ["monitors"]));
  assert.equal(first.length, 1);

  host.bind("owner", uiB);
  assert.equal(first.at(-1).content, undefined, "the old UI is cleared before the new one registers");
  assert.equal(second.length, 1);
  assert.equal(typeof second[0].content, "function");

  // A shutdown for the previous session arrives after the rebind and must be ignored.
  host.unbind("owner", uiA);
  assert.equal(host.boundUI(), uiB);
  assert.equal(second.at(-1).content !== undefined, true);
  host.unbind("owner", uiB);
  assert.equal(second.at(-1).content, undefined);
});

test("reload clears the previous providers before a new widget instance publishes the same section", () => {
  const host = widgetStackHost();
  const calls = [];
  let component;
  const tui = { terminal: { columns: 100 }, requestRender() {} };
  const ui = {
    theme,
    setWidget(key, content) {
      calls.push({ key, content });
      component = typeof content === "function" ? content(tui, theme) : undefined;
    },
  };
  host.bind("owner", ui);
  host.publish("loops", fakeSection("loops", true, ["stale loops"]));
  assert.deepEqual(component.render(100), ["stale loops"]);

  for (const id of ["goal", "agents", "monitors", "loops"]) host.publish(id, undefined);
  assert.equal(calls.at(-1).content, undefined, "clearing the last stale section revokes the key");
  assert.deepEqual(host.publishedSectionIds(), []);

  host.publish("loops", fakeSection("loops", true, ["fresh loops"]));
  assert.deepEqual(component.render(100), ["fresh loops"], "the new instance owns the section id outright");
});

test("dispose retracts only its own section and a late timer tick never resurrects it", () => {
  const harness = stack();
  harness.bindAll();
  harness.publishAll();
  const ticks = harness.timers.filter((timer) => timer.milliseconds === 1_000 || timer.milliseconds === 80);
  assert.ok(ticks.length >= 3, "Goal, Loops, and Agents each keep their own tick");

  harness.goal.dispose();
  harness.loops.dispose();
  harness.agents.dispose();
  assert.equal(harness.clears(), 0, "the remaining sections keep the aggregate registered");
  assert.deepEqual(harness.headings(), ["●  Todos (0/1)", "●  Monitors (0/1)"]);

  const rendersAfterDispose = harness.renders;
  const callsAfterDispose = harness.calls.length;
  for (const timer of harness.timers) timer.callback();
  assert.equal(harness.calls.length, callsAfterDispose, "a late tick never re-registers a disposed section");
  assert.deepEqual(harness.headings(), ["●  Todos (0/1)", "●  Monitors (0/1)"], "a late tick never republishes a disposed section");
  assert.ok(harness.renders >= rendersAfterDispose);

  harness.todos.dispose();
  harness.monitors.dispose();
  assert.equal(harness.calls.at(-1).content, undefined);
  assert.equal(widgetStackHost().boundUI(), undefined, "disposing every widget releases the last binding");
});

test("a tree cycle drops the old sections and republishes them on the new UI without orphan rows", () => {
  const harness = stack();
  harness.bindAll();
  harness.publishAll();
  assert.equal(harness.headings().length, 5);

  // before_tree: Goal and Agents release the UI while Monitors, Loops, and Todos survive.
  harness.goal.setContext(undefined);
  harness.agents.dispose();
  assert.deepEqual(harness.headings(), ["●  Todos (0/1)", "●  Monitors (0/1)", "●  Loops"]);
  assert.doesNotMatch(harness.lines().join("\n"), /Goal|Agents/, "the pre-tree branch leaves no orphan rows behind");

  // session_tree: the same UI object comes back and every section returns.
  harness.state.goal = goalView("active");
  harness.state.agents = [subagentRun("running")];
  harness.bindAll();
  harness.publishAll();
  assert.equal(harness.registrations(), 1, "a tree cycle reuses the single registration");
  assert.deepEqual(harness.headings(), ["●  Goal · ↻  active · goal-active", "●  Todos (0/1)", "●  Agents (0/1)", "●  Monitors (0/1)", "●  Loops"]);
});

test("Ctrl+O only changes Goal while compact widgets stay unchanged and the aggregate stays registered once", () => {
  let expanded = true;
  const harness = stack({ getToolsExpanded: () => expanded });
  harness.state.goal = goalView("completed");
  harness.state.todos = [todoTask("pending"), todoTask("completed")];
  harness.state.agents = [subagentRun("running"), subagentRun("completed")];
  harness.state.monitors = [monitorItem("running"), monitorItem("completed")];
  harness.state.loops = [];
  harness.bindAll();
  harness.publishAll();

  const sectionLines = (lines, label) => {
    const start = lines.findIndex((line) => new RegExp(`^[●○]  ${label}`).test(line));
    assert.notEqual(start, -1, `${label} section must be present`);
    const next = lines.findIndex((line, index) => index > start && /^[●○]  /.test(line));
    return lines.slice(start, next === -1 ? undefined : next);
  };
  const compactLabels = ["Todos", "Agents", "Monitors"];
  const before = harness.lines();
  const compactBefore = Object.fromEntries(compactLabels.map((label) => [label, sectionLines(before, label)]));
  const goalBefore = sectionLines(before, "Goal");
  assert.equal(goalBefore.length, 2, "an expanded completed Goal includes its detail row");
  assert.match(compactBefore.Todos[0], /Todos \(1\/2\)/, "the Todo fixture includes a completed item");
  assert.match(compactBefore.Agents[0], /Agents \(1\/2\)/, "the Agent fixture includes a completed run");
  assert.match(compactBefore.Monitors[0], /Monitors \(1\/2\)/, "the Monitor fixture includes a completed process");
  assert.ok(compactLabels.every((label) => !compactBefore[label].join("\n").includes("to expand")));
  const registrations = harness.registrations();

  expanded = false;
  const after = harness.lines();
  for (const label of compactLabels) {
    assert.deepEqual(sectionLines(after, label), compactBefore[label], `${label} output is independent of Ctrl+O`);
  }
  assert.ok(compactLabels.every((label) => !sectionLines(after, label).join("\n").includes("to expand")));
  assert.equal(sectionLines(after, "Goal").length, 1, "the Goal section still receives the live collapsed state");
  assert.equal(harness.registrations(), registrations, "Ctrl+O never re-registers the aggregate");

  expanded = true;
  assert.deepEqual(sectionLines(harness.lines(), "Goal"), goalBefore, "the Goal detail returns from the same live registration");
  assert.equal(harness.registrations(), registrations);

  harness.component.invalidate();
  assert.equal(harness.registrations(), registrations, "invalidate is a no-op and never re-registers");
  assert.ok(harness.lines().length > 0, "invalidate leaves the live component usable");

  const narrow = harness.component.render(24);
  assert.ok(narrow.every((line) => visibleWidth(line) <= 24), "one width reaches every section");
  const fallback = harness.component.render();
  assert.deepEqual(fallback, harness.component.render(200), "a host without an explicit width falls back to the terminal columns");
});

test("a session without a TUI UI publishes freely and still calls setWidget zero times", () => {
  const harness = stack();
  harness.goal.setContext(undefined);
  harness.agents.setUICtx(undefined);
  harness.monitors.setContext(undefined);
  harness.loops.setContext(undefined);
  harness.publishAll();
  assert.deepEqual(harness.calls, [], "an RPC or print session never registers the aggregate");
  assert.equal(widgetStackHost().boundUI(), undefined);
  assert.equal(widgetStackHost().isRegistered(), false);
});

test("a host that ignores component factories, as RPC does, never locks the aggregate into a dead registration", () => {
  const host = widgetStackHost();
  const ignoring = recordingUi({ runs: false });
  host.bind("owner", ignoring.ui);
  host.publish("monitors", fakeSection("monitors", true, ["monitors"]));
  assert.equal(ignoring.registrations(), 1, "the key is still offered to a factory-ignoring host");
  assert.equal(host.isRegistered(), false, "a factory the host never ran is not a live registration");

  host.requestRender();
  host.publish("loops", fakeSection("loops", true, ["loops"]));
  assert.ok(ignoring.registrations() > 1, "later updates retry the factory instead of being dropped");
  assert.equal(host.isRegistered(), false);

  // The key stays claimed, so removing the last section still clears it exactly once.
  host.publish("monitors", undefined);
  host.publish("loops", undefined);
  assert.equal(ignoring.calls.at(-1).content, undefined, "an ignored factory still leaves a clearable key");
  assert.equal(ignoring.calls.filter((call) => call.content === undefined).length, 1);

  // A host that starts running factories takes over on the very next attempt.
  ignoring.state.runs = true;
  host.publish("monitors", fakeSection("monitors", true, ["monitors"]));
  assert.equal(host.isRegistered(), true, "the first executed factory becomes the live registration");
  const registrationsAfterTakeover = ignoring.registrations();
  host.requestRender();
  assert.equal(ignoring.registrations(), registrationsAfterTakeover, "a live handle stops the retries");
  assert.equal(ignoring.state.renders, 1, "a live handle receives the render request instead");
  assert.deepEqual(ignoring.state.component.render(50), ["monitors"]);
});

test("an explicit width is authoritative down to zero and only a missing or invalid width falls back", () => {
  const host = widgetStackHost();
  const target = recordingUi({ columns: 120 });
  host.bind("owner", target.ui);
  host.publish("monitors", widthSection());
  const render = (width) => target.state.component.render(width)[0];

  assert.equal(render(0), "w=0", "a zero-column frame is an instruction, not a missing width");
  assert.equal(render(1), "w=1");
  assert.equal(render(37.9), "w=37", "a fractional width floors instead of falling back");
  assert.equal(render(undefined), "w=120", "a missing width falls back to the terminal columns");
  assert.equal(render(-5), "w=120", "a negative width is invalid and falls back");
  assert.equal(render(Number.NaN), "w=120");
  assert.equal(render(Number.POSITIVE_INFINITY), "w=120");

  resetWidgetStackHost();
  const blind = widgetStackHost();
  const noTerminal = [];
  let component;
  const tui = { requestRender() {} };
  blind.bind("owner", {
    theme,
    setWidget(key, content) {
      noTerminal.push({ key, content });
      component = typeof content === "function" ? content(tui, theme) : undefined;
    },
  });
  blind.publish("monitors", widthSection());
  assert.equal(component.render()[0], "w=80", "no width and no terminal falls back to the documented default");
  assert.equal(component.render(0)[0], "w=0");
});

test("the newest distinct UI wins and only owners of that UI can hold it open", () => {
  const host = widgetStackHost();
  const first = recordingUi();
  const second = recordingUi();
  host.bind("oh-my-pi-slim:extension", first.ui);
  host.publish("monitors", fakeSection("monitors", true, ["monitors"]));
  assert.equal(first.registrations(), 1);

  // A new session binds its own UI while the previous owner has not shut down yet.
  host.bind("oh-my-pi-slim:todo-extension", second.ui);
  assert.equal(first.calls.at(-1).content, undefined, "the superseded UI is cleared immediately");
  assert.equal(second.registrations(), 1, "the newest UI takes the aggregate over");
  assert.equal(host.boundUI(), second.ui);

  // The stale owner's late shutdown must not disturb the live UI.
  host.unbind("oh-my-pi-slim:extension", first.ui);
  assert.equal(host.boundUI(), second.ui, "a late unbind from the superseded owner changes nothing");
  assert.equal(second.calls.at(-1).content !== undefined, true);
  assert.equal(first.calls.filter((call) => call.content === undefined).length, 1, "the old UI is cleared once, not twice");

  // A stale owner that never released cannot keep the live UI alive either.
  host.bind("stale", first.ui);
  assert.equal(host.boundUI(), first.ui, "binding a different UI again moves the aggregate again");
  host.bind("oh-my-pi-slim:todo-extension", second.ui);
  assert.equal(host.boundUI(), second.ui);
  host.unbind("oh-my-pi-slim:todo-extension", second.ui);
  assert.equal(host.boundUI(), undefined, "an owner still recorded against a replaced UI cannot hold the live one open");
  assert.equal(second.calls.at(-1).content, undefined);
});

test("binding no UI releases exactly this owner's recorded claim and nothing else", () => {
  const host = widgetStackHost();
  const target = recordingUi();
  host.bind("oh-my-pi-slim:extension", target.ui);
  host.bind("oh-my-pi-slim:todo-extension", target.ui);
  host.publish("monitors", fakeSection("monitors", true, ["monitors"]));
  assert.equal(target.registrations(), 1);

  host.bind("oh-my-pi-slim:extension", undefined);
  assert.equal(host.boundUI(), target.ui, "one owner leaving keeps the other owner's binding");
  assert.equal(target.calls.at(-1).content !== undefined, true);

  host.bind("unknown-owner", undefined);
  assert.equal(host.boundUI(), target.ui, "releasing an owner that never bound is a no-op");

  host.bind("oh-my-pi-slim:todo-extension", undefined);
  assert.equal(host.boundUI(), undefined);
  assert.equal(target.calls.at(-1).content, undefined);
});

test("section ids are fixed, exhaustive, and unknown ids sort last instead of throwing", () => {
  assert.deepEqual([...WIDGET_STACK_SECTION_IDS], SECTION_ORDER);
  const sections = [fakeSection("mystery", true, ["mystery"]), fakeSection("loops", true, ["loops"])];
  assert.deepEqual(orderWidgetStackSections(sections).map((section) => section.id), ["loops", "mystery"]);
});
