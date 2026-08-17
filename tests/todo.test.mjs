import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const piEntry = realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim());
const piRoot = dirname(dirname(piEntry));
const dependencyMap = {
  "@earendil-works/pi-coding-agent": pathToFileURL(`${piRoot}/dist/index.js`).href,
  "@earendil-works/pi-tui": pathToFileURL(`${piRoot}/node_modules/@earendil-works/pi-tui/dist/index.js`).href,
  typebox: pathToFileURL(`${piRoot}/node_modules/typebox/build/index.mjs`).href,
  "./core.js": new URL("../extensions/todo/core.ts", import.meta.url).href,
  "./widget.js": new URL("../extensions/todo/widget.ts", import.meta.url).href,
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    const url = dependencyMap[specifier];
    return url ? { url, shortCircuit: true } : nextResolve(specifier, context);
  },
});

const core = await import("../extensions/todo/core.ts");
const todoModule = await import("../extensions/todo/index.ts");
const widgetModule = await import("../extensions/todo/widget.ts");
const {
  applyTodoUpdate,
  makeTodoSnapshot,
  parseTodoSnapshot,
  replayTodoBranch,
} = core;
const {
  TODO_PROMPT_GUIDELINES,
  todoParameters,
} = todoModule;
const {
  MAX_TODO_WIDGET_LINES,
  renderTodoLines,
  selectTodoWidgetLayout,
} = widgetModule;

const theme = {
  fg: (_color, text) => text,
  bold: (text) => text,
  strikethrough: (text) => `~${text}~`,
};

function task(subject, status = "pending", blockedBy = [], abstract = `${subject} summary`) {
  return { subject, abstract, status, blockedBy };
}

function branchResult(details, { isError = false } = {}) {
  return {
    type: "message",
    message: { role: "toolResult", toolName: "todo", details, isError },
  };
}

function createHarness({
  id = "main",
  mode = "tui",
  branch = [],
  getAllTools = () => { throw new Error("runtime not initialized"); },
} = {}) {
  const tools = [];
  const commands = [];
  const shortcuts = [];
  const handlers = new Map();
  const widgetCalls = [];
  let renders = 0;
  const pi = {
    getAllTools,
    registerTool(definition) { tools.push(definition); },
    registerCommand(name) { commands.push(name); },
    registerShortcut(name) { shortcuts.push(name); },
    on(name, handler) {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
    },
  };
  const tui = { requestRender() { renders += 1; } };
  const ui = {
    theme,
    setWidget(key, content, options) {
      widgetCalls.push({ key, content, options });
      if (typeof content === "function") content(tui, theme);
    },
  };
  const ctx = {
    mode,
    hasUI: mode === "tui" || mode === "rpc",
    ui,
    sessionManager: {
      getSessionId: () => id,
      getBranch: () => branch,
    },
  };
  todoModule.default(pi);
  const emit = (name, event = {}) => {
    for (const handler of handlers.get(name) ?? []) handler(event, ctx);
  };
  return {
    pi, tools, commands, shortcuts, handlers, widgetCalls, ctx, emit,
    setBranch(next) { branch = next; },
    get renders() { return renders; },
    tool: tools[0],
  };
}

function runUpdate(tool, ctx, operations) {
  return tool.execute("call", { action: "update", operations }, undefined, undefined, ctx);
}

function runList(tool, ctx) {
  return tool.execute("call", { action: "list" }, undefined, undefined, ctx);
}

function stateFrom(result) {
  return result.details.state.tasks;
}

function schemaObjects(schema) {
  return schema.anyOf ?? schema.oneOf ?? [];
}

test("registers exactly one todo tool with exact actions and strict schemas", () => {
  const harness = createHarness({ mode: "rpc" });
  assert.deepEqual(harness.tools.map((tool) => tool.name), ["todo"]);
  assert.equal(harness.tool.executionMode, "sequential");
  assert.deepEqual(harness.commands, []);
  assert.deepEqual(harness.shortcuts, []);
  const top = schemaObjects(todoParameters);
  assert.equal(top.length, 2);
  assert.deepEqual(top.map((schema) => schema.properties.action.const).sort(), ["list", "update"]);
  for (const schema of top) {
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(Object.keys(schema.properties).sort(), schema.properties.action.const === "list" ? ["action"] : ["action", "operations"]);
  }
  const list = top.find((schema) => schema.properties.action.const === "list");
  const update = top.find((schema) => schema.properties.action.const === "update");
  assert.deepEqual(list.required, ["action"]);
  assert.equal(update.properties.operations.minItems, 1);
  assert.equal(update.properties.operations.maxItems, undefined);
  const operations = schemaObjects(update.properties.operations.items);
  assert.deepEqual(operations.map((schema) => schema.properties.op.const).sort(), ["append", "clear", "modify"]);
  assert.ok(operations.every((schema) => schema.additionalProperties === false));
  assert.equal(operations.find((schema) => schema.properties.op.const === "modify").minProperties, 2);
  assert.throws(() => applyTodoUpdate([], [{ op: "append", subject: "A", abstract: "a", unknown: true }]), /unknown fields/);
});

test("append and modify can target an earlier append in one atomic batch", () => {
  const result = applyTodoUpdate([], [
    { op: "append", subject: " Build  API ", abstract: " API summary " },
    { op: "modify", target: " Build  API ", newSubject: "Ship  API", abstract: "Ship summary", status: "in_progress" },
  ]);
  assert.deepEqual(result.tasks, [task("Ship  API", "in_progress", [], "Ship summary")]);
  assert.equal(result.receipts[0].kind, "append");
  assert.equal(result.receipts[1].kind, "rename");
  assert.equal(result.receipts[1].text, 'Renamed "Build  API" to "Ship  API". Modified "Ship  API": status pending to in_progress, abstract.');
});

test("failed updates roll back for operation, uniqueness, dependency, graph, and clear errors", () => {
  const initial = [task("A"), task("B")];
  const cases = [
    [{ op: "modify", target: "missing", status: "completed" }],
    [{ op: "append", subject: "A", abstract: "duplicate" }],
    [{ op: "append", subject: "C", abstract: "c", blockedBy: ["later"] }],
    [{ op: "modify", target: "A", addBlockedBy: ["A"] }],
    [{ op: "modify", target: "A", addBlockedBy: ["B"] }, { op: "modify", target: "B", addBlockedBy: ["A"] }],
    [{ op: "clear" }],
  ];
  for (const operations of cases) {
    const snapshot = structuredClone(initial);
    assert.throws(() => applyTodoUpdate(initial, operations), /todo update failed at operation \d+:/);
    assert.deepEqual(initial, snapshot);
  }
});

test("subjects stay case-sensitive and rename rewrites every dependency atomically", () => {
  const result = applyTodoUpdate([], [
    { op: "append", subject: "A", abstract: "a" },
    { op: "append", subject: "a", abstract: "lower" },
    { op: "append", subject: "Use A", abstract: "use", blockedBy: ["A"] },
    { op: "modify", target: "A", newSubject: "Core" },
  ]);
  assert.deepEqual(result.tasks.map((item) => item.subject), ["Core", "a", "Use A"]);
  assert.deepEqual(result.tasks[2].blockedBy, ["Core"]);
  assert.throws(() => applyTodoUpdate(result.tasks, [{ op: "modify", target: "core", status: "completed" }]), /target "core"/);
});

test("blockedBy rejects forward, missing, self, and cycles while remove runs before add", () => {
  assert.throws(() => applyTodoUpdate([], [
    { op: "append", subject: "A", abstract: "a", blockedBy: ["B"] },
    { op: "append", subject: "B", abstract: "b" },
  ]), /does not exist yet/);
  const base = [task("A"), task("B"), task("C", "pending", ["A"] )];
  const changed = applyTodoUpdate(base, [{
    op: "modify", target: "C", removeBlockedBy: ["missing", "A"], addBlockedBy: ["A", "B", "B"],
  }]);
  assert.deepEqual(changed.tasks[2].blockedBy, ["A", "B"]);
  assert.throws(() => applyTodoUpdate(base, [{ op: "modify", target: "C", addBlockedBy: ["missing"] }]), /does not exist yet/);
  assert.throws(() => applyTodoUpdate(base, [{ op: "modify", target: "C", addBlockedBy: ["C"] }]), /depend on itself/);
});

test("final dependency gate permits arbitrary status transitions and enforces completed dependencies", () => {
  const base = [task("Dependency", "completed"), task("Work", "completed", ["Dependency"] )];
  assert.throws(() => applyTodoUpdate(base, [{ op: "modify", target: "Dependency", status: "pending" }]), /requires completed dependency/);
  const reopened = applyTodoUpdate(base, [
    { op: "modify", target: "Dependency", status: "pending" },
    { op: "modify", target: "Work", status: "pending" },
  ]);
  assert.deepEqual(reopened.tasks.map((item) => item.status), ["pending", "pending"]);
  const completedAgain = applyTodoUpdate(reopened.tasks, [
    { op: "modify", target: "Dependency", status: "completed" },
    { op: "modify", target: "Work", status: "in_progress" },
  ]);
  assert.deepEqual(completedAgain.tasks.map((item) => item.status), ["completed", "in_progress"]);
});

test("multiple items can become in_progress in one batch and survive snapshot validation", () => {
  const result = applyTodoUpdate([task("Dependency", "completed")], [
    { op: "append", subject: "First", abstract: "first", blockedBy: ["Dependency"] },
    { op: "append", subject: "Second", abstract: "second", blockedBy: ["Dependency"] },
    { op: "modify", target: "First", status: "in_progress" },
    { op: "modify", target: "Second", status: "in_progress" },
  ]);
  assert.deepEqual(result.tasks.map((item) => item.status), ["completed", "in_progress", "in_progress"]);
  const snapshot = makeTodoSnapshot(result.tasks, result.operations, result.receipts);
  assert.deepEqual(parseTodoSnapshot(snapshot)?.state.tasks, result.tasks);
});

test("clear works at the start, middle, or end and rejects double or unfinished clears", () => {
  const completed = [task("Old", "completed")];
  assert.deepEqual(applyTodoUpdate(completed, [{ op: "clear" }, { op: "append", subject: "New", abstract: "new" }]).tasks, [task("New", "pending", [], "new")]);
  assert.deepEqual(applyTodoUpdate([task("Old")], [
    { op: "modify", target: "Old", status: "completed" },
    { op: "clear" },
    { op: "append", subject: "New", abstract: "new" },
  ]).tasks.length, 1);
  assert.deepEqual(applyTodoUpdate([], [
    { op: "append", subject: "Temporary", abstract: "temporary" },
    { op: "modify", target: "Temporary", status: "completed" },
    { op: "clear" },
  ]).tasks, []);
  assert.deepEqual(applyTodoUpdate(completed, [{ op: "clear" }]).tasks, []);
  assert.throws(() => applyTodoUpdate([task("Old")], [{ op: "clear" }]), /requires every current item/);
  assert.throws(() => applyTodoUpdate([], [{ op: "clear" }, { op: "clear" }]), /only once/);
  const empty = applyTodoUpdate([], [{ op: "clear" }]);
  assert.equal(empty.receipts[0].kind, "no-change");
  assert.equal(empty.receipts[0].text, "No change.");
});

test("modify receipts identify the current target and same-value updates keep snapshots", () => {
  const base = [task("A"), task("Dependency")];
  const status = applyTodoUpdate(base, [{ op: "modify", target: "A", status: "completed" }]);
  assert.equal(status.receipts[0].text, 'Modified "A": status pending to completed.');
  const abstract = applyTodoUpdate(base, [{ op: "modify", target: "A", abstract: "Updated" }]);
  assert.equal(abstract.receipts[0].text, 'Modified "A": abstract.');
  const dependency = applyTodoUpdate(base, [{ op: "modify", target: "A", addBlockedBy: ["Dependency"] }]);
  assert.equal(dependency.receipts[0].text, 'Modified "A": blockedBy.');
  const noChange = applyTodoUpdate(base, [{ op: "modify", target: "A", abstract: "A summary" }]);
  assert.equal(noChange.receipts[0].kind, "no-change");
  assert.equal(noChange.receipts[0].text, 'No change for "A".');
  const snapshot = makeTodoSnapshot(noChange.tasks, noChange.operations, noChange.receipts);
  assert.ok(parseTodoSnapshot(snapshot));
  const harness = createHarness({ mode: "rpc" });
  harness.emit("session_start", { reason: "startup" });
  runUpdate(harness.tool, harness.ctx, [{ op: "append", subject: "A", abstract: "A summary" }]);
  const successfulNoOp = runUpdate(harness.tool, harness.ctx, [{ op: "modify", target: "A", abstract: "A summary" }]);
  assert.ok(parseTodoSnapshot(successfulNoOp.details));
  assert.deepEqual(successfulNoOp.details.state.tasks, [task("A")]);
});

test("list returns every exact field in append order and never returns a snapshot", () => {
  const harness = createHarness({ mode: "rpc" });
  harness.emit("session_start", { reason: "startup" });
  runUpdate(harness.tool, harness.ctx, [
    { op: "append", subject: "B", abstract: "b" },
    { op: "append", subject: "A", abstract: "a" },
  ]);
  const result = runList(harness.tool, harness.ctx);
  assert.deepEqual(JSON.parse(result.content[0].text), [task("B", "pending", [], "b"), task("A", "pending", [], "a")]);
  assert.equal(result.details.type, "oh-my-pi-slim:todo-list");
  assert.equal(parseTodoSnapshot(result.details), undefined);
  assert.deepEqual(Object.keys(JSON.parse(result.content[0].text)[0]).sort(), ["abstract", "blockedBy", "status", "subject"]);
});

test("replay accepts only valid new snapshots and ignores old external or failed details", () => {
  const valid = makeTodoSnapshot([task("A")], [{ op: "append", subject: "A", abstract: "A summary" }], [
    { operation: 1, kind: "append", text: "Appended \"A\"." },
  ]);
  const oldExternal = { tasks: [{ id: 1, subject: "legacy" }], nextId: 2 };
  const corrupt = structuredClone(valid);
  corrupt.state.tasks.push(task("A"));
  assert.deepEqual(replayTodoBranch([
    branchResult(oldExternal),
    branchResult(valid),
    branchResult(corrupt),
    branchResult(makeTodoSnapshot([task("B")], [{ op: "append", subject: "B", abstract: "B summary" }], [{ operation: 1, kind: "append", text: "B" }]), { isError: true }),
  ]), [task("A")]);
});

test("deep snapshot parsing rejects malformed state invariants and accepts multiple active items", () => {
  const valid = makeTodoSnapshot([
    task("A", "completed"),
    task("B", "in_progress", ["A"]),
    task("C", "in_progress", ["A"]),
  ], [
    { op: "modify", target: "B", status: "in_progress" },
  ], [{ operation: 1, kind: "status", text: "status pending to in_progress." }]);
  assert.ok(parseTodoSnapshot(valid));
  const mutations = [
    (value) => { value.state.tasks[1].subject = "A"; },
    (value) => { value.state.tasks[1].status = "bad"; },
    (value) => { delete value.state.tasks[1].abstract; },
    (value) => { value.state.tasks[1].blockedBy = ["missing"]; },
    (value) => { value.state.tasks[0].blockedBy = ["B"]; },
    (value) => { value.state.tasks[0].status = "pending"; },
  ];
  for (const mutate of mutations) {
    const value = structuredClone(valid);
    mutate(value);
    assert.equal(parseTodoSnapshot(value), undefined);
  }
});

test("startup reload, tree, and compact restore the branch while sessions remain isolated", () => {
  const firstSnapshot = makeTodoSnapshot([task("A")], [{ op: "append", subject: "A", abstract: "A summary" }], [{ operation: 1, kind: "append", text: "A" }]);
  const secondSnapshot = makeTodoSnapshot([task("B")], [{ op: "append", subject: "B", abstract: "B summary" }], [{ operation: 1, kind: "append", text: "B" }]);
  const harness = createHarness({ id: "one", mode: "rpc", branch: [branchResult(firstSnapshot)] });
  harness.emit("session_start", { reason: "reload" });
  assert.deepEqual(JSON.parse(runList(harness.tool, harness.ctx).content[0].text).map((item) => item.subject), ["A"]);
  harness.setBranch([branchResult(secondSnapshot)]);
  harness.emit("session_tree", {});
  assert.deepEqual(JSON.parse(runList(harness.tool, harness.ctx).content[0].text).map((item) => item.subject), ["B"]);
  harness.setBranch([branchResult(firstSnapshot)]);
  harness.emit("session_compact", {});
  assert.deepEqual(JSON.parse(runList(harness.tool, harness.ctx).content[0].text).map((item) => item.subject), ["A"]);

  const secondCtx = { ...harness.ctx, sessionManager: { getSessionId: () => "two", getBranch: () => [] } };
  for (const handler of harness.handlers.get("session_start")) handler({ reason: "startup" }, secondCtx);
  runUpdate(harness.tool, secondCtx, [{ op: "append", subject: "Two", abstract: "two" }]);
  assert.deepEqual(JSON.parse(runList(harness.tool, harness.ctx).content[0].text).map((item) => item.subject), ["A"]);
  assert.deepEqual(JSON.parse(runList(harness.tool, secondCtx).content[0].text).map((item) => item.subject), ["Two"]);
  for (const handler of harness.handlers.get("session_shutdown")) handler({}, secondCtx);
  assert.deepEqual(JSON.parse(runList(harness.tool, secondCtx).content[0].text), []);
});

test("main and child both register Todo while RPC sessions never register widgets", () => {
  const priorChild = process.env.PI_SUBAGENT_CHILD;
  const priorOmpsChild = process.env.OMPS_SUBAGENT_CHILD;
  try {
    delete process.env.PI_SUBAGENT_CHILD;
    delete process.env.OMPS_SUBAGENT_CHILD;
    assert.deepEqual(createHarness({ mode: "rpc" }).tools.map((tool) => tool.name), ["todo"]);
    process.env.PI_SUBAGENT_CHILD = "1";
    process.env.OMPS_SUBAGENT_CHILD = "1";
    const child = createHarness({ id: "child", mode: "rpc" });
    child.emit("session_start", { reason: "startup" });
    runUpdate(child.tool, child.ctx, [{ op: "append", subject: "Child", abstract: "child" }]);
    assert.deepEqual(child.tools.map((tool) => tool.name), ["todo"]);
    assert.deepEqual(child.widgetCalls, []);
  } finally {
    if (priorChild === undefined) delete process.env.PI_SUBAGENT_CHILD; else process.env.PI_SUBAGENT_CHILD = priorChild;
    if (priorOmpsChild === undefined) delete process.env.OMPS_SUBAGENT_CHILD; else process.env.OMPS_SUBAGENT_CHILD = priorOmpsChild;
  }
});

test("widget renders exact glyphs, counts, tree lines, overflow, width, and empty removal", () => {
  const tasks = [
    task("Pending", "pending"),
    task("Active", "in_progress"),
    task("Done", "completed"),
  ];
  const lines = renderTodoLines(tasks, theme, 80);
  assert.equal(lines[0], "Todos (1/3)");
  assert.match(lines[1], /○ Pending/);
  assert.match(lines[2], /◐ Active/);
  assert.match(lines[3], /✓ ~Done~/);
  assert.equal(lines.length, 4);
  const chained = renderTodoLines([task("Blocked", "pending", ["First", "Second"], "hidden abstract")], theme, 80);
  assert.match(chained[1], /○ Blocked ⛓ First, Second$/);
  assert.doesNotMatch(chained[1], /hidden abstract|blocked by|\[|\]/);

  const many = [];
  for (let index = 0; index < 8; index += 1) many.push(task(`done-${index}`, "completed"));
  for (let index = 0; index < 8; index += 1) many.push(task(`pending-${index}`, "pending"));
  many.push(task("active", "in_progress"));
  const layout = selectTodoWidgetLayout(many);
  assert.equal(layout.visible.filter((item) => item.status === "completed").length, 1);
  assert.equal(layout.visible.filter((item) => item.status !== "completed").length, 9);
  const overflow = renderTodoLines(many, theme, 34);
  assert.equal(overflow.length, MAX_TODO_WIDGET_LINES);
  assert.ok(overflow.every((line) => line.length <= 34));
  assert.match(overflow.at(-1), /7 completed/);
  assert.doesNotMatch(overflow.at(-1), /pending|in_progress/);

  const unfinished = Array.from({ length: 14 }, (_, index) => task(`pending-${index}`, "pending"));
  const truncated = renderTodoLines(unfinished, theme, 80);
  assert.equal(truncated.length, 12);
  assert.match(truncated.at(-1), /4 pending/);

  const harness = createHarness({ mode: "tui" });
  harness.emit("session_start", { reason: "startup" });
  assert.deepEqual(harness.widgetCalls, []);
  runUpdate(harness.tool, harness.ctx, [{ op: "append", subject: "A", abstract: "a" }]);
  assert.equal(typeof harness.widgetCalls.at(-1).content, "function");
  runUpdate(harness.tool, harness.ctx, [{ op: "modify", target: "A", status: "completed" }, { op: "clear" }]);
  assert.equal(harness.widgetCalls.at(-1).content, undefined);
});

test("renderers sanitize controls, show complete calls and receipts, and never copy snapshots into model content", () => {
  const harness = createHarness({ mode: "rpc" });
  harness.emit("session_start", { reason: "startup" });
  const operations = [
    { op: "append", subject: "A\nB", abstract: "summary\u0000" },
    { op: "modify", target: "A\nB", newSubject: "C\tD", status: "in_progress" },
  ];
  const call = harness.tool.renderCall({ action: "update", operations }, theme, {});
  const callText = call.render(200).join("\n");
  assert.doesNotMatch(callText, /\u0000/);
  assert.match(callText, /append/);
  assert.match(callText, /modify/);
  const result = runUpdate(harness.tool, harness.ctx, operations);
  assert.doesNotMatch(result.content[0].text, /"state"|"tasks"|abstract/);
  const rendered = harness.tool.renderResult(result, {}, theme, {});
  const renderedText = rendered.render(200).join("\n");
  assert.match(renderedText, /Appended/);
  assert.match(renderedText, /Renamed/);
  assert.doesNotMatch(renderedText, /oh-my-pi-slim:todo-update|"state"|"tasks"/);
});

test("Todo model metadata follows the STE sentence rules and includes the frozen guidance", () => {
  const harness = createHarness({ mode: "rpc" });
  const metadata = [harness.tool.description, ...harness.tool.promptGuidelines];
  for (const block of metadata) {
    for (const sentence of block.split(/(?<=[.!?])\s+/).filter(Boolean)) {
      const words = sentence.match(/[A-Za-z0-9_]+(?:-[A-Za-z0-9_]+)*/g) ?? [];
      assert.ok(words.length <= 20, `sentence exceeds 20 words: ${sentence}`);
      assert.doesNotMatch(sentence, /;/);
    }
  }
  const text = TODO_PROMPT_GUIDELINES.join("\n");
  for (const term of [
    "current session's complete list", "atomically", "unique subject", "short item summary", "exact target subject",
    "existing subjects", "Complete every dependency", "new task group",
    "complete old items, clear, and append", "cancel the whole update",
  ]) assert.match(text, new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("Todo factory never enumerates tools during initialization", () => {
  const harness = createHarness({
    mode: "rpc",
    getAllTools() { throw new Error("runtime not initialized"); },
  });
  assert.deepEqual(harness.tools.map((tool) => tool.name), ["todo"]);
});

test("real Pi loads only Todo in an isolated RPC smoke without registering a widget", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const cache = join(root, ".cache");
  mkdirSync(cache, { recursive: true });
  const agentDir = mkdtempSync(join(cache, "todo-pi-smoke-"));
  try {
    const result = spawnSync("pi", [
      "--mode", "rpc",
      "--no-session",
      "--offline",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-context-files",
      "--no-builtin-tools",
      "--extension", join(root, "extensions/todo/index.ts"),
      "--extension", join(root, "tests/fixtures/todo-load-probe.ts"),
    ], {
      cwd: root,
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
      input: `${JSON.stringify({ id: "probe", type: "prompt", message: "/todo-load-probe" })}\n`,
      encoding: "utf8",
      timeout: 20_000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const events = result.stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    assert.doesNotMatch(result.stderr, /extension_error|runtime not initialized/i);
    assert.equal(events.some((event) => event.type === "extension_error"), false);
    assert.equal(events.some((event) => event.type === "extension_ui_request" && event.method === "setWidget"), false);
    const notification = events.find((event) => event.type === "extension_ui_request" && event.method === "notify" && event.message?.startsWith("TODO_LOAD_PROBE "));
    assert.ok(notification, result.stdout);
    assert.deepEqual(JSON.parse(notification.message.slice("TODO_LOAD_PROBE ".length)), {
      count: 1,
      actions: ["list", "update"],
    });
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});
