import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { beforeEach } from "node:test";
import { piRoot } from "./fixtures/pi-install.mjs";
const dependencyMap = {
  "@earendil-works/pi-coding-agent": pathToFileURL(`${piRoot}/dist/index.js`).href,
  "@earendil-works/pi-tui": pathToFileURL(`${piRoot}/node_modules/@earendil-works/pi-tui/dist/index.js`).href,
  typebox: pathToFileURL(`${piRoot}/node_modules/typebox/build/index.mjs`).href,
  "./core.js": new URL("../extensions/todo/core.ts", import.meta.url).href,
  "./widget.js": new URL("../extensions/todo/widget.ts", import.meta.url).href,
  "../oh-my-pi-slim/semantic-glyph.js": new URL("../extensions/oh-my-pi-slim/semantic-glyph.ts", import.meta.url).href,
  "../oh-my-pi-slim/widget-expansion.js": new URL("../extensions/oh-my-pi-slim/widget-expansion.ts", import.meta.url).href,
  "../oh-my-pi-slim/widget-stack.js": new URL("../extensions/oh-my-pi-slim/widget-stack.ts", import.meta.url).href,
  "../oh-my-pi-slim/widget-stack-host.js": new URL("../extensions/oh-my-pi-slim/widget-stack-host.ts", import.meta.url).href,
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
const core = await import("../extensions/todo/core.ts");
const todoModule = await import("../extensions/todo/index.ts");
const {
  WIDGET_STACK_KEY,
  resetWidgetStackHost,
  widgetStackHost,
} = await import("../extensions/oh-my-pi-slim/widget-stack-host.ts");

beforeEach(() => resetWidgetStackHost());
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
  isTodoTaskBlocked,
  renderTodoLines,
  selectTodoWidgetLayout,
  sortTodoTasksForWidget,
} = widgetModule;

const theme = {
  fg: (_color, text) => text,
  bold: (text) => text,
  strikethrough: (text) => `~${text}~`,
};
const vtTheme = {
  fg: (_color, text) => `\u001b[36m${text}\u001b[0m`,
  bold: (text) => `\u001b[1m${text}\u001b[22m`,
  strikethrough: (text) => `\u001b[9m${text}\u001b[29m`,
};
const roleAnsiTheme = {
  fg: (color, text) => {
    const code = { accent: 35, dim: 2, success: 32, text: 37, toolOutput: 36, toolTitle: 34, warning: 33, error: 31 }[color] ?? 39;
    return `\u001b[${code}m${text}\u001b[0m`;
  },
  bold: (text) => `\u001b[1m${text}\u001b[22m`,
  strikethrough: (text) => `\u001b[9m${text}\u001b[29m`,
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
  getToolsExpanded,
} = {}) {
  const tools = [];
  const commands = [];
  const shortcuts = [];
  const handlers = new Map();
  const widgetCalls = [];
  let widgetComponent;
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
      if (typeof content === "function") widgetComponent = content(tui, theme);
      else widgetComponent = undefined;
    },
  };
  if (getToolsExpanded) ui.getToolsExpanded = getToolsExpanded;
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
    get widgetComponent() { return widgetComponent; },
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

function renderComponentLines(component, width = 240) {
  return component.render(width).map((line) => line.trimEnd());
}

function renderComponent(component, width = 240) {
  return renderComponentLines(component, width).join("\n").replace(/^\n+|\n+$/g, "");
}

function assertBlankResultSeparator(component) {
  const lines = renderComponentLines(component);
  assert.equal(lines[0], "");
  assert.notEqual(lines[1], "");
}

function schemaObjects(schema) {
  return schema.anyOf ?? schema.oneOf ?? [];
}

function assertSteSentence(sentence) {
  const words = sentence.match(/[A-Za-z0-9_]+(?:-[A-Za-z0-9_]+)*/g) ?? [];
  assert.ok(words.length <= 20, `Model sentence exceeds 20 words: ${sentence}`);
  assert.doesNotMatch(sentence, /;/, `Model sentence must not use a semicolon: ${sentence}`);
}

function assertSteBlock(block) {
  const sentences = block.split(/(?<=[.!?])\s+/).filter(Boolean);
  assert.ok(sentences.length > 0);
  for (const sentence of sentences) assertSteSentence(sentence);
}

test("registers exactly one todo tool with exact actions and strict schemas", () => {
  const harness = createHarness({ mode: "rpc" });
  assert.deepEqual(harness.tools.map((tool) => tool.name), ["todo"]);
  assert.equal(harness.tool.executionMode, "sequential");
  assert.deepEqual(harness.commands, []);
  assert.deepEqual(harness.shortcuts, []);
  assert.equal(todoParameters.type, "object");
  assert.equal(todoParameters.additionalProperties, false);
  assert.equal(todoParameters.anyOf, undefined);
  assert.equal(todoParameters.oneOf, undefined);
  assert.deepEqual(todoParameters.required, ["action"]);
  assert.deepEqual(Object.keys(todoParameters.properties).sort(), ["action", "operations"]);
  assert.deepEqual(schemaObjects(todoParameters.properties.action).map((schema) => schema.const).sort(), ["list", "update"]);
  assert.equal(todoParameters.properties.action.description, "Choose list or update. list accepts no operations. update requires one or more ordered operations.");
  assert.equal(todoParameters.properties.operations.minItems, 1);
  assert.equal(todoParameters.properties.operations.maxItems, undefined);
  assert.equal(todoParameters.properties.operations.description, "Ordered append, modify, delete, or clear operations for update. Omit for list.");
  const operations = schemaObjects(todoParameters.properties.operations.items);
  assert.deepEqual(operations.map((schema) => schema.properties.op.const).sort(), ["append", "clear", "delete", "modify"]);
  assert.ok(operations.every((schema) => schema.additionalProperties === false));
  const append = operations.find((schema) => schema.properties.op.const === "append");
  const modify = operations.find((schema) => schema.properties.op.const === "modify");
  const remove = operations.find((schema) => schema.properties.op.const === "delete");
  const clear = operations.find((schema) => schema.properties.op.const === "clear");
  assert.equal(clear.description, "Use clear at most once.");
  assert.deepEqual(Object.fromEntries(operations.map((schema) => [schema.properties.op.const, schema.properties.op.description])), {
    append: "append requires subject and abstract, with optional blockedBy.",
    modify: "modify requires target and at least one changed field.",
    delete: "delete requires target.",
    clear: "clear accepts no other fields.",
  });
  assert.equal(modify.minProperties, undefined);
  assert.equal(remove.type, "object");
  assert.equal(remove.anyOf, undefined);
  assert.equal(remove.oneOf, undefined);
  assert.deepEqual(Object.keys(remove.properties).sort(), ["op", "target"]);
  assert.deepEqual(remove.required.slice().sort(), ["op", "target"]);
  assert.equal(remove.properties.target.description, "Exact subject to delete.");
  assert.equal("confirmed" in remove.properties, false);
  assert.equal("confirmed" in clear.properties, false);
  const dependencyDescriptions = [
    append.properties.blockedBy.description,
    modify.properties.addBlockedBy.description,
    modify.properties.removeBlockedBy.description,
  ];
  assert.deepEqual(dependencyDescriptions, [
    "Initial dependencies for the appended item.",
    "Dependencies to add to the target item.",
    "Dependencies to remove from the target item.",
  ]);
  assert.equal(new Set(dependencyDescriptions).size, 3);
  for (const schema of [append.properties.blockedBy, modify.properties.addBlockedBy, modify.properties.removeBlockedBy]) {
    assert.equal(schema.items.description, "Exact subject of an existing item.");
  }
  assert.equal(modify.properties.status.description, "Replacement status: pending, in_progress, or completed.");
  assert.throws(() => applyTodoUpdate([], [{ op: "append", subject: "A", abstract: "a", unknown: true }]), /unknown fields/);
  assert.throws(() => applyTodoUpdate([task("A")], [{ op: "delete", target: "A", unknown: true }]), /delete contains unknown fields/);
  assert.throws(() => applyTodoUpdate([task("A")], [{ op: "delete", target: "A", status: "completed" }]), /delete contains unknown fields/);
  assert.throws(() => applyTodoUpdate([task("A")], [{ op: "delete", target: "A", confirmed: true }]), /delete contains unknown fields/);
  assert.throws(() => applyTodoUpdate([], [{ op: "clear", confirmed: true }]), /clear contains unknown fields/);
  assert.throws(() => applyTodoUpdate([task("A")], [{ op: "delete" }]), /delete target must be a non-empty string/);
});

test("Todo execute enforces action-specific operations boundaries", () => {
  const harness = createHarness({ mode: "rpc" });
  harness.emit("session_start", { reason: "startup" });
  assert.throws(
    () => harness.tool.execute("call", { action: "list", operations: [{ op: "clear" }] }, undefined, undefined, harness.ctx),
    /list does not accept operations/,
  );
  assert.throws(
    () => harness.tool.execute("call", { action: "update" }, undefined, undefined, harness.ctx),
    /update requires at least one operation/,
  );
  assert.throws(
    () => harness.tool.execute("call", { action: "update", operations: [] }, undefined, undefined, harness.ctx),
    /update requires at least one operation/,
  );
  assert.throws(
    () => harness.tool.execute("call", { action: "unknown" }, undefined, undefined, harness.ctx),
    /Unknown todo action/,
  );
  assert.throws(() => applyTodoUpdate([], [{ op: "modify", target: "missing" }]), /requires at least one mutable field/);
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
    [{ op: "modify", target: "A", status: "in_progress" }, { op: "clear" }],
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

test("clear works at the start, middle, or end for pending and completed items", () => {
  const completed = [task("Old", "completed")];
  assert.deepEqual(applyTodoUpdate(completed, [{ op: "clear" }, { op: "append", subject: "New", abstract: "new" }]).tasks, [task("New", "pending", [], "new")]);
  assert.deepEqual(applyTodoUpdate([task("Old")], [
    { op: "clear" },
    { op: "append", subject: "New", abstract: "new" },
  ]).tasks, [task("New", "pending", [], "new")]);
  assert.deepEqual(applyTodoUpdate([], [
    { op: "append", subject: "Temporary", abstract: "temporary" },
    { op: "clear" },
  ]).tasks, []);
  assert.deepEqual(applyTodoUpdate([task("Pending"), task("Done", "completed")], [{ op: "clear" }]).tasks, []);
  assert.throws(() => applyTodoUpdate([], [{ op: "clear" }, { op: "clear" }]), /only once/);
  const empty = applyTodoUpdate([], [{ op: "clear" }]);
  assert.equal(empty.receipts[0].kind, "no-change");
  assert.equal(empty.receipts[0].text, "No change.");
});

test("delete removes a pending or completed item by exact subject and reports a changed receipt", () => {
  const base = [task("A", "completed"), task("B"), task("C")];
  const result = applyTodoUpdate(base, [{ op: "delete", target: "B" }]);
  assert.deepEqual(result.tasks, [task("A", "completed"), task("C")]);
  assert.deepEqual(result.operations, [{ op: "delete", target: "B" }]);
  assert.equal(result.receipts.length, 1);
  assert.equal(result.receipts[0].kind, "delete");
  assert.equal(result.receipts[0].text, 'Deleted "B".');
  assert.deepEqual(base, [task("A", "completed"), task("B"), task("C")]);
  assert.deepEqual(applyTodoUpdate(base, [{ op: "delete", target: " A " }]).tasks, [task("B"), task("C")]);
  const snapshot = makeTodoSnapshot(result.tasks, result.operations, result.receipts);
  assert.deepEqual(parseTodoSnapshot(snapshot)?.state.tasks, result.tasks);

  assert.throws(() => applyTodoUpdate(base, [{ op: "delete", target: "missing" }]), /todo update failed at operation 1: target "missing" does not exist\./);
  assert.throws(() => applyTodoUpdate(base, [{ op: "delete", target: "b" }]), /target "b" does not exist\./);
  assert.throws(() => applyTodoUpdate([], [{ op: "delete", target: "A" }]), /target "A" does not exist\./);
});

test("delete gates in_progress status before referrers against the current draft", () => {
  const ask = "Ask the user whether to set it back to pending or mark it completed, then retry delete only if they agree.";
  const referenced = [task("Active", "in_progress"), task("Follower", "pending", ["Active"])];
  assert.throws(
    () => applyTodoUpdate(referenced, [{ op: "delete", target: "Active" }]),
    (error) => {
      assert.equal(error.message, `todo update failed at operation 1: cannot delete "Active" while its current status is in_progress. ${ask}`);
      assert.doesNotMatch(error.message, /depend on it/);
      return true;
    },
  );

  const movedOut = applyTodoUpdate([task("Active", "in_progress")], [
    { op: "modify", target: "Active", status: "pending" },
    { op: "delete", target: "Active" },
  ]);
  assert.deepEqual(movedOut.tasks, []);

  const original = [task("Draft")];
  const before = structuredClone(original);
  assert.throws(
    () => applyTodoUpdate(original, [
      { op: "modify", target: "Draft", status: "in_progress" },
      { op: "delete", target: "Draft" },
    ]),
    (error) => {
      assert.equal(error.message, `todo update failed at operation 2: cannot delete "Draft" while its current status is in_progress. ${ask}`);
      return true;
    },
  );
  assert.deepEqual(original, before);
});

test("clear gates every draft in_progress item in draft order and rolls back atomically", () => {
  const ask = "Ask the user whether to set them back to pending or mark them completed, then retry clear only if they agree.";
  const active = [
    task("First", "in_progress"),
    task("Pending"),
    task("Second", "in_progress"),
    task("Done", "completed"),
  ];
  assert.throws(() => applyTodoUpdate(active, [{ op: "clear" }]), (error) => {
    assert.equal(error.message, `todo update failed at operation 1: clear cannot remove in_progress items: "First", "Second". ${ask}`);
    return true;
  });

  const movedOut = applyTodoUpdate(active, [
    { op: "modify", target: "First", status: "pending" },
    { op: "modify", target: "Second", status: "completed" },
    { op: "clear" },
  ]);
  assert.deepEqual(movedOut.tasks, []);

  const original = [task("Pending"), task("Done", "completed")];
  const before = structuredClone(original);
  assert.throws(() => applyTodoUpdate(original, [
    { op: "modify", target: "Pending", status: "in_progress" },
    { op: "clear" },
  ]), (error) => {
    assert.equal(error.message, `todo update failed at operation 2: clear cannot remove in_progress items: "Pending". ${ask}`);
    return true;
  });
  assert.deepEqual(original, before);
});

test("delete refuses to break the dependency graph and names every referrer", () => {
  const base = [task("Core", "completed"), task("Left", "pending", ["Core"]), task("Right", "pending", ["Core"])];
  const snapshot = structuredClone(base);
  assert.throws(
    () => applyTodoUpdate(base, [{ op: "delete", target: "Core" }]),
    /todo update failed at operation 1: cannot delete "Core" because "Left", "Right" depend on it\./,
  );
  assert.deepEqual(base, snapshot);
  assert.throws(
    () => applyTodoUpdate(base, [{ op: "append", subject: "New", abstract: "new" }, { op: "delete", target: "Core" }]),
    /todo update failed at operation 2: cannot delete "Core" because "Left", "Right" depend on it\./,
  );
  assert.deepEqual(base, snapshot);
  const removedOne = applyTodoUpdate(base, [{ op: "modify", target: "Left", removeBlockedBy: ["Core"] }]);
  assert.throws(
    () => applyTodoUpdate(removedOne.tasks, [{ op: "delete", target: "Core" }]),
    /cannot delete "Core" because "Right" depend on it\./,
  );
});

test("delete mixes with modify, append, and clear in one ordered atomic batch", () => {
  const base = [task("Core", "completed"), task("Leaf", "pending", ["Core"])];
  const freed = applyTodoUpdate(base, [
    { op: "modify", target: "Leaf", removeBlockedBy: ["Core"] },
    { op: "delete", target: "Core" },
    { op: "append", subject: "Next", abstract: "next", blockedBy: [] },
  ]);
  assert.deepEqual(freed.tasks.map((item) => item.subject), ["Leaf", "Next"]);
  assert.deepEqual(freed.tasks[0].blockedBy, []);
  assert.deepEqual(freed.receipts.map((receipt) => receipt.kind), ["modify", "delete", "append"]);

  const renamed = applyTodoUpdate(base, [
    { op: "modify", target: "Core", newSubject: "Root" },
    { op: "modify", target: "Leaf", removeBlockedBy: ["Root"] },
    { op: "delete", target: "Root" },
  ]);
  assert.deepEqual(renamed.tasks, [task("Leaf")]);

  const appendThenDelete = applyTodoUpdate([], [
    { op: "append", subject: "Temp", abstract: "temp" },
    { op: "delete", target: "Temp" },
    { op: "append", subject: "Temp", abstract: "reused" },
  ]);
  assert.deepEqual(appendThenDelete.tasks, [task("Temp", "pending", [], "reused")]);

  const cleared = applyTodoUpdate([task("Old", "completed"), task("Draft")], [
    { op: "delete", target: "Draft" },
    { op: "clear" },
    { op: "append", subject: "Fresh", abstract: "fresh" },
  ]);
  assert.deepEqual(cleared.tasks, [task("Fresh", "pending", [], "fresh")]);

  const before = structuredClone(base);
  assert.throws(() => applyTodoUpdate(base, [
    { op: "modify", target: "Leaf", removeBlockedBy: ["Core"] },
    { op: "delete", target: "Core" },
    { op: "delete", target: "missing" },
  ]), /todo update failed at operation 3: target "missing" does not exist\./);
  assert.deepEqual(base, before);

  const clearBase = [task("Old", "completed"), task("Draft"), task("Keep", "in_progress")];
  const clearBefore = structuredClone(clearBase);
  assert.throws(() => applyTodoUpdate(clearBase, [
    { op: "delete", target: "Draft" },
    { op: "clear" },
  ]), /todo update failed at operation 2: clear cannot remove in_progress items: "Keep"\./);
  assert.deepEqual(clearBase, clearBefore);
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

test("update content is compact JSON with complete receipts and minimal unfinished tasks without changing details or UI", () => {
  const harness = createHarness({ mode: "rpc" });
  harness.emit("session_start", { reason: "startup" });
  const result = runUpdate(harness.tool, harness.ctx, [
    { op: "append", subject: "Done", abstract: "finished" },
    { op: "modify", target: "Done", status: "completed" },
    { op: "append", subject: "Pending", abstract: "waiting", blockedBy: ["Done"] },
    { op: "append", subject: "Active", abstract: "working", blockedBy: ["Done"] },
    { op: "modify", target: "Active", status: "in_progress" },
  ]);
  const content = JSON.parse(result.content[0].text);
  const receipts = [
    { operation: 1, kind: "append", text: 'Appended "Done".' },
    { operation: 2, kind: "status", text: 'Modified "Done": status pending to completed.' },
    { operation: 3, kind: "append", text: 'Appended "Pending".' },
    { operation: 4, kind: "append", text: 'Appended "Active".' },
    { operation: 5, kind: "status", text: 'Modified "Active": status pending to in_progress.' },
  ];
  assert.equal(result.content[0].text, JSON.stringify(content));
  assert.deepEqual(Object.keys(content), ["receipts", "unfinished"]);
  assert.deepEqual(content.receipts, receipts);
  assert.deepEqual(content.receipts.map((receipt) => Object.keys(receipt)), [
    ["operation", "kind", "text"],
    ["operation", "kind", "text"],
    ["operation", "kind", "text"],
    ["operation", "kind", "text"],
    ["operation", "kind", "text"],
  ]);
  assert.deepEqual(content.unfinished, [
    { subject: "Pending", status: "pending", blockedBy: ["Done"] },
    { subject: "Active", status: "in_progress", blockedBy: ["Done"] },
  ]);
  assert.deepEqual(content.unfinished.map((item) => Object.keys(item)), [
    ["subject", "status", "blockedBy"],
    ["subject", "status", "blockedBy"],
  ]);
  assert.doesNotMatch(result.content[0].text, /abstract|waiting|working/);

  assert.deepEqual(result.details.receipts, receipts);
  assert.deepEqual(result.details.state.tasks, [
    task("Done", "completed", [], "finished"),
    task("Pending", "pending", ["Done"], "waiting"),
    task("Active", "in_progress", ["Done"], "working"),
  ]);
  assert.equal(
    renderComponent(harness.tool.renderResult(result, { expanded: false }, theme, {})),
    "✓  Applied 3 append · 2 modify · 0 delete · 0 clear → 5 changed · 0 no change",
  );
  assert.match(
    renderComponent(harness.tool.renderResult(result, { expanded: true }, theme, {})),
    /5\. ○  → ◐  Modified "Active": status pending to in_progress\./,
  );
});

test("update content explicitly returns an empty unfinished array with complete receipts", () => {
  const harness = createHarness({ mode: "rpc" });
  harness.emit("session_start", { reason: "startup" });
  const result = runUpdate(harness.tool, harness.ctx, [{ op: "clear" }]);
  const content = JSON.parse(result.content[0].text);
  assert.equal(result.content[0].text, JSON.stringify(content));
  assert.deepEqual(Object.keys(content), ["receipts", "unfinished"]);
  assert.deepEqual(content, {
    receipts: [{ operation: 1, kind: "no-change", text: "No change." }],
    unfinished: [],
  });
});

test("list returns every exact field in append order and never returns a snapshot", () => {
  const harness = createHarness({ mode: "rpc" });
  harness.emit("session_start", { reason: "startup" });
  runUpdate(harness.tool, harness.ctx, [
    { op: "append", subject: "B", abstract: "b" },
    { op: "append", subject: "A", abstract: "a" },
  ]);
  const result = runList(harness.tool, harness.ctx);
  const content = JSON.parse(result.content[0].text);
  assert.equal(result.content[0].text, JSON.stringify(content));
  assert.deepEqual(content, [task("B", "pending", [], "b"), task("A", "pending", [], "a")]);
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

test("session shutdown always disposes the Todo section while RPC and no-UI sessions still never register", () => {
  const tui = createHarness({ mode: "tui" });
  tui.emit("session_start", { reason: "startup" });
  runUpdate(tui.tool, tui.ctx, [{ op: "append", subject: "Open", abstract: "open" }]);
  assert.equal(typeof tui.widgetCalls.at(-1).content, "function");
  assert.equal(tui.widgetCalls.at(-1).key, WIDGET_STACK_KEY, "Todos joins the one aggregate widget instead of owning a key");

  // A shutdown whose session id no longer matches the recorded foreground must still release.
  const renamedCtx = { ...tui.ctx, sessionManager: { ...tui.ctx.sessionManager, getSessionId: () => "renamed" } };
  for (const handler of tui.handlers.get("session_shutdown")) handler({}, renamedCtx);
  assert.equal(tui.widgetCalls.at(-1).content, undefined, "an unmatched shutdown still clears the aggregate");
  assert.equal(widgetStackHost().boundUI(), undefined);

  // Disposing again, and disposing a session that never had a widget, stay no-ops.
  const clears = tui.widgetCalls.filter((call) => call.content === undefined).length;
  for (const handler of tui.handlers.get("session_shutdown")) handler({}, tui.ctx);
  assert.equal(tui.widgetCalls.filter((call) => call.content === undefined).length, clears, "a repeated shutdown clears nothing twice");

  for (const mode of ["rpc", "print"]) {
    const headless = createHarness({ mode });
    headless.emit("session_start", { reason: "startup" });
    runUpdate(headless.tool, headless.ctx, [{ op: "append", subject: "Headless", abstract: "headless" }]);
    for (const handler of headless.handlers.get("session_shutdown")) handler({}, headless.ctx);
    assert.deepEqual(headless.widgetCalls, [], `${mode} sessions never register or clear a widget`);
  }
});

test("widget priority sorts every state from current dependencies without changing task objects", () => {
  const tasks = [
    task("completed-old", "completed"),
    task("blocked-early", "pending", ["open-dependency"]),
    task("ready-dependency", "completed"),
    task("ready-later", "pending", ["ready-dependency"]),
    task("active-first", "in_progress"),
    task("open-dependency", "pending"),
    task("active-second", "in_progress"),
    task("completed-new", "completed"),
  ];
  const before = structuredClone(tasks);
  assert.equal(isTodoTaskBlocked(tasks[1], tasks), true);
  assert.equal(isTodoTaskBlocked(tasks[3], tasks), false);
  assert.deepEqual(sortTodoTasksForWidget(tasks).map((item) => item.subject), [
    "active-first", "active-second", "ready-later", "open-dependency", "blocked-early",
    "completed-new", "ready-dependency", "completed-old",
  ]);
  assert.deepEqual(tasks, before);

  const missingReference = [task("missing-ref", "pending", ["absent"]), task("ready", "pending")];
  assert.equal(isTodoTaskBlocked(missingReference[0], missingReference), true);
  assert.deepEqual(sortTodoTasksForWidget(missingReference).map((item) => item.subject), ["ready", "missing-ref"]);
});

test("widget filters completed rows before slicing, preserves the 12-line budget, and pads semantic glyphs", () => {
  const noOverflow = [
    task("done-old", "completed"),
    ...Array.from({ length: 7 }, (_, index) => task(`pending-${index}`, "pending")),
    task("active", "in_progress"),
    task("done-middle", "completed"),
    task("done-new", "completed"),
  ];
  const direct = selectTodoWidgetLayout(noOverflow);
  assert.equal(direct.visible.length, 8);
  assert.deepEqual(direct.hidden, []);
  assert.deepEqual(direct.visible.map((item) => item.subject), [
    "active", "pending-0", "pending-1", "pending-2", "pending-3", "pending-4", "pending-5", "pending-6",
  ]);
  assert.equal(renderTodoLines(noOverflow, theme, 100).length, 9);

  const overflowTasks = [
    ...Array.from({ length: 4 }, (_, index) => task(`done-${index}`, "completed")),
    ...Array.from({ length: 7 }, (_, index) => task(`ready-${index}`, "pending")),
    task("dependency", "pending"),
    ...Array.from({ length: 3 }, (_, index) => task(`blocked-${index}`, "pending", ["dependency"])),
    task("active", "in_progress"),
  ];
  const overflowLayout = selectTodoWidgetLayout(overflowTasks);
  assert.equal(overflowLayout.visible.length, 10);
  assert.equal(overflowLayout.hidden.length, 2);
  assert.deepEqual(overflowLayout.visible.map((item) => item.subject), [
    "active", "ready-0", "ready-1", "ready-2", "ready-3", "ready-4", "ready-5", "ready-6", "dependency", "blocked-0",
  ]);
  assert.deepEqual(overflowLayout.hidden.map((item) => item.subject), ["blocked-1", "blocked-2"]);
  const overflow = renderTodoLines(overflowTasks, theme, 42);
  assert.equal(overflow.length, MAX_TODO_WIDGET_LINES);
  assert.equal(overflow[0], "●  Todos (4/16)");
  assert.equal(overflow.at(-1), "└─ +2 more (2 pending)");
  assert.doesNotMatch(overflow.join("\n"), /done-/);

  const exact = renderTodoLines([
    task("Pending", "pending"),
    task("Active", "in_progress"),
    task("Done", "completed"),
  ], theme, 80);
  assert.deepEqual(exact, [
    "●  Todos (1/3)",
    "├─ ◐  Active",
    "└─ ○  Pending",
  ]);
  const chained = renderTodoLines([task("Blocked", "pending", ["First", "Second"], "hidden abstract")], theme, 80);
  assert.equal(chained[1], "└─ ○  Blocked ⛓  First, Second");
  assert.doesNotMatch(chained[1], /hidden abstract|blocked by|\[|\]/);
  assert.match(chained[1], /^└─ /, "tree connector spacing stays structural");
  assert.doesNotMatch(exact.join("\n") + chained.join("\n"), /[●◐○✓⛓] [^ ]|[●◐○✓⛓] {3}/);

  for (const width of [12, 24, 34]) {
    const ansi = renderTodoLines(overflowTasks, vtTheme, width);
    assert.ok(ansi.every((line) => visibleWidth(line) <= width));
  }
  assert.deepEqual(renderTodoLines([], theme, 80), []);
});

test("widget headings keep full-ledger counts and all-completed ledgers stay heading-only", () => {
  const activeAnsi = renderTodoLines([task("Pending")], roleAnsiTheme, 80);
  assert.equal(
    activeAnsi[0],
    "\u001b[35m\u001b[1m●\u001b[22m\u001b[0m  \u001b[35m\u001b[1mTodos (0/1)\u001b[22m\u001b[0m",
  );

  const completed = [
    task("First", "completed"),
    task("Dependent", "completed", ["First"]),
    task("Latest", "completed"),
  ];
  assert.deepEqual(renderTodoLines(completed, theme, 80), ["○  Todos (3/3)"]);
  const idleAnsi = renderTodoLines(completed, roleAnsiTheme, 80);
  assert.equal(idleAnsi[0], "\u001b[2m○\u001b[0m  \u001b[2mTodos (3/3)\u001b[0m");
  assert.doesNotMatch(idleAnsi.join("\n"), /\u001b\[35m/, "all-completed widget must not render any accent role");
  assert.doesNotMatch(idleAnsi.join("\n"), /First|Dependent|Latest/);

  for (const width of [6, 12, 18]) {
    const narrow = renderTodoLines(completed, roleAnsiTheme, width);
    assert.ok(narrow.every((line) => visibleWidth(line) <= width));
    assert.doesNotMatch(narrow[0], /●|\u001b\[35m/);
  }
  assert.match(renderTodoLines(completed, theme, 6)[0], /^○  /);

  const completedOverflow = Array.from({ length: 14 }, (_, index) => task(`done-${index}`, "completed"));
  const overflow = renderTodoLines(completedOverflow, theme, 80);
  assert.deepEqual(overflow, ["○  Todos (14/14)"]);
  const overflowAnsi = renderTodoLines(completedOverflow, roleAnsiTheme, 30);
  assert.ok(overflowAnsi.every((line) => visibleWidth(line) <= 30));
  assert.doesNotMatch(overflowAnsi.join("\n"), /\u001b\[35m|done-/);
});

test("widget permanently keeps pending and in_progress rows and hides completed rows without a hint", () => {
  const tasks = [
    task("finished-dependency", "completed"),
    task("open-dependency", "pending"),
    task("ready-work", "pending", ["finished-dependency"]),
    task("blocked-work", "pending", ["open-dependency"]),
    task("active", "in_progress"),
    task("finished-late", "completed"),
  ];

  assert.deepEqual(renderTodoLines(tasks, theme, 80), [
    "●  Todos (2/6)",
    "├─ ◐  active",
    "├─ ○  open-dependency",
    "├─ ○  ready-work ⛓  finished-dependency",
    "└─ ○  blocked-work ⛓  open-dependency",
  ]);
  assert.doesNotMatch(renderTodoLines(tasks, theme, 80).join("\n"), /finished-late|✓|ctrl|expand/i);

  const openOnly = tasks.filter((item) => item.status !== "completed");
  assert.deepEqual(renderTodoLines(openOnly, theme, 80), [
    "●  Todos (0/4)",
    "├─ ◐  active",
    "├─ ○  open-dependency",
    "├─ ○  ready-work ⛓  finished-dependency",
    "└─ ○  blocked-work ⛓  open-dependency",
  ]);

  const completedOnly = tasks.filter((item) => item.status === "completed");
  assert.deepEqual(renderTodoLines(completedOnly, theme, 80), ["○  Todos (2/2)"]);
  assert.deepEqual(renderTodoLines([], theme, 80), []);
});

test("Todo widget overflow counts only unfinished rows while the heading counts the full ledger", () => {
  const tasks = [
    ...Array.from({ length: 6 }, (_, index) => task(`done-${index}`, "completed")),
    ...Array.from({ length: 12 }, (_, index) => task(`open-${index}`, "pending")),
  ];

  const lines = renderTodoLines(tasks, theme, 60);
  assert.equal(lines[0], "●  Todos (6/18)", "heading counts use the full ledger");
  assert.equal(lines.length, MAX_TODO_WIDGET_LINES);
  assert.equal(lines.at(-1), "└─ +2 more (2 pending)", "completed rows stay outside the line budget and overflow");
  assert.doesNotMatch(lines.join("\n"), /done-|ctrl|expand/i);
});

test("TodoWidget ignores Pi's live Ctrl+O state and remains permanently compact", () => {
  let expanded = true;
  const harness = createHarness({ mode: "tui", getToolsExpanded: () => expanded });
  harness.emit("session_start", { reason: "startup" });
  runUpdate(harness.tool, harness.ctx, [
    { op: "append", subject: "Open", abstract: "open" },
    { op: "append", subject: "Done", abstract: "done" },
    { op: "modify", target: "Done", status: "completed" },
  ]);
  const registrations = harness.widgetCalls.filter((call) => typeof call.content === "function").length;
  const compact = ["●  Todos (1/2)", "└─ ○  Open"];

  assert.deepEqual(harness.widgetComponent.render(80), compact);
  expanded = false;
  assert.deepEqual(harness.widgetComponent.render(80), compact);
  assert.doesNotMatch(harness.widgetComponent.render(80).join("\n"), /Done|ctrl|expand/i);
  assert.equal(
    harness.widgetCalls.filter((call) => typeof call.content === "function").length,
    registrations,
    "Ctrl+O state changes must not re-register the widget",
  );

  runUpdate(harness.tool, harness.ctx, [{ op: "modify", target: "Open", status: "completed" }]);
  assert.deepEqual(harness.widgetComponent.render(80), ["○  Todos (2/2)"]);
  assert.notEqual(harness.widgetCalls.at(-1).content, undefined, "a non-empty all-completed ledger keeps its heading");

  expanded = true;
  assert.deepEqual(harness.widgetComponent.render(80), ["○  Todos (2/2)"]);
  assert.equal(
    harness.widgetCalls.filter((call) => typeof call.content === "function").length,
    registrations,
    "Ctrl+O state changes must not alter widget registration",
  );

  runUpdate(harness.tool, harness.ctx, [{ op: "clear" }]);
  assert.equal(harness.widgetCalls.at(-1).content, undefined, "an empty ledger still unregisters");
});

test("widget heading refreshes both ways across update, delete, clear, replay, tree, compact, and session restore", () => {
  const completedSnapshot = makeTodoSnapshot(
    [task("Restored", "completed")],
    [{ op: "append", subject: "Restored", abstract: "Restored summary" }],
    [{ operation: 1, kind: "append", text: "Appended." }],
  );
  const activeSnapshot = makeTodoSnapshot(
    [task("Restored", "pending")],
    [{ op: "append", subject: "Restored", abstract: "Restored summary" }],
    [{ operation: 1, kind: "append", text: "Appended." }],
  );
  const harness = createHarness({ mode: "tui", branch: [branchResult(completedSnapshot)] });
  harness.emit("session_start", { reason: "restore" });
  assert.equal(harness.widgetComponent.render(80)[0], "○  Todos (1/1)");

  harness.setBranch([branchResult(activeSnapshot)]);
  harness.emit("session_tree", {});
  assert.equal(harness.renders, 1);
  assert.equal(harness.widgetComponent.render(80)[0], "●  Todos (0/1)");

  harness.setBranch([branchResult(completedSnapshot)]);
  harness.emit("session_compact", {});
  assert.equal(harness.renders, 2);
  assert.equal(harness.widgetComponent.render(80)[0], "○  Todos (1/1)");

  runUpdate(harness.tool, harness.ctx, [{ op: "append", subject: "Open", abstract: "open" }]);
  assert.equal(harness.widgetComponent.render(80)[0], "●  Todos (1/2)");
  runUpdate(harness.tool, harness.ctx, [{ op: "modify", target: "Open", status: "completed" }]);
  assert.equal(harness.widgetComponent.render(80)[0], "○  Todos (2/2)");
  runUpdate(harness.tool, harness.ctx, [{ op: "modify", target: "Open", status: "in_progress" }]);
  assert.equal(harness.widgetComponent.render(80)[0], "●  Todos (1/2)");
  runUpdate(harness.tool, harness.ctx, [{ op: "modify", target: "Open", status: "completed" }]);
  assert.equal(harness.widgetComponent.render(80)[0], "○  Todos (2/2)");

  runUpdate(harness.tool, harness.ctx, [{ op: "append", subject: "Delete me", abstract: "delete" }]);
  assert.equal(harness.widgetComponent.render(80)[0], "●  Todos (2/3)");
  runUpdate(harness.tool, harness.ctx, [{ op: "delete", target: "Delete me" }]);
  assert.equal(harness.widgetComponent.render(80)[0], "○  Todos (2/2)");

  runUpdate(harness.tool, harness.ctx, [{ op: "clear" }]);
  assert.equal(harness.widgetCalls.at(-1).content, undefined);
  assert.equal(harness.widgetComponent, undefined);
  assert.deepEqual(JSON.parse(runList(harness.tool, harness.ctx).content[0].text), []);

  runUpdate(harness.tool, harness.ctx, [{ op: "append", subject: "Again", abstract: "again" }]);
  assert.equal(harness.widgetComponent.render(80)[0], "●  Todos (0/1)");
});

test("widget immediately reorders after status, dependency completion or restore, and delete while list order stays append-based", () => {
  const harness = createHarness({ mode: "tui" });
  harness.emit("session_start", { reason: "startup" });
  const seeded = runUpdate(harness.tool, harness.ctx, [
    { op: "append", subject: "completed-old", abstract: "old" },
    { op: "modify", target: "completed-old", status: "completed" },
    { op: "append", subject: "completed-new", abstract: "new" },
    { op: "modify", target: "completed-new", status: "completed" },
    { op: "append", subject: "ready-dependency", abstract: "ready dependency" },
    { op: "modify", target: "ready-dependency", status: "completed" },
    { op: "append", subject: "open-dependency", abstract: "open dependency" },
    { op: "append", subject: "ready-work", abstract: "ready work", blockedBy: ["ready-dependency"] },
    { op: "append", subject: "blocked-work", abstract: "blocked work", blockedBy: ["open-dependency"] },
    { op: "append", subject: "active", abstract: "active" },
    { op: "modify", target: "active", status: "in_progress" },
  ]);
  assert.equal(typeof harness.widgetCalls.at(-1).content, "function");
  assert.deepEqual(stateFrom(seeded).map((item) => item.subject), [
    "completed-old", "completed-new", "ready-dependency", "open-dependency", "ready-work", "blocked-work", "active",
  ]);
  assert.deepEqual(harness.widgetComponent.render(100), [
    "●  Todos (3/7)",
    "├─ ◐  active",
    "├─ ○  open-dependency",
    "├─ ○  ready-work ⛓  ready-dependency",
    "└─ ○  blocked-work ⛓  open-dependency",
  ]);

  runUpdate(harness.tool, harness.ctx, [{ op: "modify", target: "open-dependency", status: "completed" }]);
  assert.equal(harness.renders, 1);
  assert.deepEqual(harness.widgetComponent.render(100), [
    "●  Todos (4/7)",
    "├─ ◐  active",
    "├─ ○  ready-work ⛓  ready-dependency",
    "└─ ○  blocked-work ⛓  open-dependency",
  ]);

  runUpdate(harness.tool, harness.ctx, [{ op: "modify", target: "open-dependency", status: "pending" }]);
  assert.equal(harness.renders, 2);
  const restored = harness.widgetComponent.render(100).join("\n");
  assert.ok(restored.indexOf("open-dependency") < restored.indexOf("ready-work"));
  assert.ok(restored.indexOf("ready-work") < restored.indexOf("blocked-work"));

  runUpdate(harness.tool, harness.ctx, [{ op: "modify", target: "active", status: "completed" }]);
  assert.equal(harness.renders, 3);
  assert.doesNotMatch(harness.widgetComponent.render(100).join("\n"), /active/);
  const removed = runUpdate(harness.tool, harness.ctx, [{ op: "delete", target: "active" }]);
  assert.equal(harness.renders, 4);
  assert.doesNotMatch(harness.widgetComponent.render(100).join("\n"), /active/);
  assert.deepEqual(JSON.parse(runList(harness.tool, harness.ctx).content[0].text).map((item) => item.subject), [
    "completed-old", "completed-new", "ready-dependency", "open-dependency", "ready-work", "blocked-work",
  ]);

  const collapsed = renderComponent(harness.tool.renderResult(removed, { expanded: false }, theme, {}));
  assert.equal(collapsed, "✓  Applied 0 append · 0 modify · 1 delete · 0 clear → 1 changed · 0 no change");
  const expanded = renderComponent(harness.tool.renderResult(removed, { expanded: true }, theme, {}));
  assert.match(expanded, /^✓  Applied 0 append · 0 modify · 1 delete · 0 clear → 1 changed · 0 no change/);
  assert.match(expanded, /1\. ✓  Deleted "active"\./);
});

test("Ctrl+O expands Todo list and update calls without changing call data", () => {
  const harness = createHarness({ mode: "rpc" });
  const listArgs = { action: "list" };
  assert.equal(renderComponent(harness.tool.renderCall(listArgs, theme, { expanded: false })), "todo · list (ctrl+o to expand)");
  assert.equal(renderComponent(harness.tool.renderCall(listArgs, theme, { expanded: true })), "todo · list");

  const operations = [
    {
      op: "append", subject: "A\nB", abstract: "Append abstract line one\nAppend abstract line two\u0000",
      blockedBy: ["Dependency\tOne", "Dependency Two"],
    },
    {
      op: "modify", target: "A\nB", newSubject: "C\tD", status: "in_progress",
      abstract: "Modify abstract line one\nModify abstract line two",
      addBlockedBy: ["Added One", "Added Two"], removeBlockedBy: ["Removed One"],
    },
    { op: "delete", target: "Stale\tItem" },
    { op: "clear" },
  ];
  const args = { action: "update", operations };
  const before = structuredClone(args);
  const collapsed = renderComponent(harness.tool.renderCall(args, theme, { expanded: false }));
  assert.equal(collapsed, "todo · update (ctrl+o to expand)");
  assert.doesNotMatch(collapsed, /Action:|Operations:|Append:|Modify:|Delete:|Clear:|A B|Append abstract|Dependency|New subject|Added One|Removed One|Stale/);

  const expandedComponent = harness.tool.renderCall(args, theme, { expanded: true });
  const expandedLines = renderComponentLines(expandedComponent);
  const expanded = renderComponent(expandedComponent);
  for (const value of [
    "todo · update", "Operations: 4", "1. Append", "Subject: A B",
    "Append abstract line one", "Append abstract line two", "Blocked by:", "Dependency One", "Dependency Two",
    "2. Modify", "Target: A B", "New subject: C D", "Status: in_progress",
    "Modify abstract line one", "Modify abstract line two", "Add blocked by:", "Added One", "Added Two",
    "Remove blocked by:", "Removed One", "3. Delete", "Target: Stale Item", "4. Clear",
  ]) assert.match(expanded, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  for (const line of [
    "1. Append",
    "  Subject: A B",
    "  Abstract:",
    "    Append abstract line one",
    "    Append abstract line two",
    "  Blocked by:",
    "    - Dependency One",
    "    - Dependency Two",
    "2. Modify",
    "  Target: A B",
    "  New subject: C D",
    "  Status: in_progress",
    "  Abstract:",
    "    Modify abstract line one",
    "    Modify abstract line two",
    "  Add blocked by:",
    "    - Added One",
    "    - Added Two",
    "  Remove blocked by:",
    "    - Removed One",
    "3. Delete",
    "  Target: Stale Item",
    "4. Clear",
  ]) assert.equal(expandedLines.includes(line), true, `missing exact hierarchy line: ${JSON.stringify(line)}`);
  assert.doesNotMatch(expanded, /\(ctrl\+o to expand\)|Action:|\u0000|\t/);
  assert.deepEqual(args, before);
});

test("Ctrl+O expands Todo update and list results without changing model data", () => {
  const harness = createHarness({ mode: "rpc" });
  harness.emit("session_start", { reason: "startup" });
  const updateResult = runUpdate(harness.tool, harness.ctx, [
    { op: "append", subject: "A", abstract: "Abstract line one\nAbstract line two" },
    { op: "modify", target: "A", status: "completed" },
    { op: "modify", target: "A", status: "completed" },
  ]);
  const updateBefore = structuredClone(updateResult);
  assert.deepEqual(JSON.parse(updateResult.content[0].text), {
    receipts: [
      { operation: 1, kind: "append", text: 'Appended "A".' },
      { operation: 2, kind: "status", text: 'Modified "A": status pending to completed.' },
      { operation: 3, kind: "no-change", text: 'No change for "A".' },
    ],
    unfinished: [],
  });
  assert.equal(updateResult.content[0].text, JSON.stringify(JSON.parse(updateResult.content[0].text)));
  assert.doesNotMatch(updateResult.content[0].text, /"state"|"tasks"/);
  const updateCollapsedComponent = harness.tool.renderResult(updateResult, { expanded: false }, theme, {});
  assertBlankResultSeparator(updateCollapsedComponent);
  const updateCollapsed = renderComponent(updateCollapsedComponent);
  assert.equal(updateCollapsed, "✓  Applied 1 append · 2 modify · 0 delete · 0 clear → 2 changed · 1 no change");
  assert.doesNotMatch(updateCollapsed, /Appended|Modified|No change|Abstract/);
  const updateExpandedComponent = harness.tool.renderResult(updateResult, { expanded: true }, theme, {});
  assertBlankResultSeparator(updateExpandedComponent);
  const updateExpanded = renderComponent(updateExpandedComponent);
  assert.match(updateExpanded, /^✓  Applied 1 append · 2 modify · 0 delete · 0 clear → 2 changed · 1 no change/);
  assert.match(updateExpanded, /1\. ✓  Appended "A"\./);
  assert.match(updateExpanded, /2\. ○  → ✓  Modified "A": status pending to completed\./);
  assert.match(updateExpanded, /3\. ○  No change for "A"\./);
  assert.doesNotMatch(updateExpanded, /[✓○] [^ →]|[✓○] {3}/);
  assert.doesNotMatch(updateExpanded, /oh-my-pi-slim:todo-update|"state"|"tasks"/);
  assert.deepEqual(updateResult, updateBefore);

  const completedListResult = runList(harness.tool, harness.ctx);
  const completedListCollapsed = renderComponent(harness.tool.renderResult(completedListResult, { expanded: false }, theme, {}));
  assert.equal(completedListCollapsed, "○  Todos (1/1)", "an all-completed list result uses the idle heading visual");

  runUpdate(harness.tool, harness.ctx, [{ op: "append", subject: "B", abstract: "Second abstract", blockedBy: ["A"] }]);
  const listResult = runList(harness.tool, harness.ctx);
  const listBefore = structuredClone(listResult);
  const listCollapsedComponent = harness.tool.renderResult(listResult, { expanded: false }, theme, {});
  assertBlankResultSeparator(listCollapsedComponent);
  const listCollapsed = renderComponent(listCollapsedComponent);
  assert.equal(listCollapsed, "●  Todos (1/2)");
  assert.doesNotMatch(listCollapsed, /A|B|Abstract|Status|Blocked/);
  const listExpandedComponent = harness.tool.renderResult(listResult, { expanded: true }, theme, {});
  assertBlankResultSeparator(listExpandedComponent);
  const listExpandedLines = renderComponentLines(listExpandedComponent);
  const listExpanded = renderComponent(listExpandedComponent);
  assert.deepEqual(listExpandedLines.slice(0, 4), ["", "●  Todos (1/2)", "", "✓  A"]);
  for (const value of [
    "●  Todos (1/2)", "✓  A", "Status: completed", "Abstract:", "Abstract line one", "Abstract line two",
    "Blocked by:", "○  B", "Status: pending", "Second abstract", "- A",
  ]) assert.match(listExpanded, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  for (const line of [
    "✓  A",
    "  Status: completed",
    "  Abstract:",
    "    Abstract line one",
    "    Abstract line two",
    "  Blocked by:",
    "    —",
    "○  B",
    "  Status: pending",
    "  Abstract:",
    "    Second abstract",
    "  Blocked by:",
    "    - A",
  ]) assert.equal(listExpandedLines.includes(line), true, `missing exact result hierarchy line: ${JSON.stringify(line)}`);
  assert.deepEqual(listResult, listBefore);
  assert.equal(listResult.content[0].text, JSON.stringify(listResult.details.tasks));

  assert.equal(renderComponent(widgetModule.renderTodoListResult([], theme, false)), "○  Todos (0/0)");
  assert.equal(renderComponent(widgetModule.renderTodoListResult([], theme, true)), "○  Todos (0/0)\nNo todos.");

  const noChangeHarness = createHarness({ mode: "rpc" });
  noChangeHarness.emit("session_start", { reason: "startup" });
  const noChangeResult = runUpdate(noChangeHarness.tool, noChangeHarness.ctx, [{ op: "clear" }]);
  assert.equal(
    renderComponent(noChangeHarness.tool.renderResult(noChangeResult, { expanded: false }, theme, {})),
    "○  Applied 0 append · 0 modify · 0 delete · 1 clear → 0 changed · 1 no change",
  );
  const destructiveReceipts = widgetModule.renderTodoReceipts(
    [
      { operation: 1, kind: "delete", text: 'Deleted "A".' },
      { operation: 2, kind: "clear", text: "Cleared all items." },
    ],
    [{ op: "delete", target: "A" }, { op: "clear" }],
    roleAnsiTheme,
    true,
  ).render(240).join("\n");
  assert.equal((destructiveReceipts.match(/\u001b\[32m✓\u001b\[0m/g) ?? []).length, 3, "top-level, delete, and clear receipts all use success");
  assert.doesNotMatch(destructiveReceipts, /\u001b\[33m✓/);
});

test("Todo fallback safely shows the JSON first line and expands full text", () => {
  const harness = createHarness({ mode: "rpc" });
  const jsonLine = '{"receipts":[],"unfinished":[]}';
  const result = { content: [{ type: "text", text: `${jsonLine}\nFallback\u0000 second\nFallback third` }] };
  const before = structuredClone(result);
  const collapsedComponent = harness.tool.renderResult(result, { expanded: false }, theme, {});
  assertBlankResultSeparator(collapsedComponent);
  const collapsed = renderComponent(collapsedComponent);
  assert.equal(collapsed, jsonLine);
  assert.doesNotMatch(collapsed, /second|third|\u0000/);
  const expandedComponent = harness.tool.renderResult(result, { expanded: true }, theme, {});
  assertBlankResultSeparator(expandedComponent);
  const expanded = renderComponent(expandedComponent);
  assert.match(expanded, /\{"receipts":\[\],"unfinished":\[\]\}\nFallback  second\nFallback third/);
  assert.doesNotMatch(expanded, /\u0000/);
  assert.deepEqual(result, before);
});

test("Todo model metadata matches the exact standalone operational contract", () => {
  const harness = createHarness({ mode: "rpc" });
  for (const block of [harness.tool.description, harness.tool.promptSnippet, ...harness.tool.promptGuidelines]) {
    assertSteBlock(block);
  }
  assert.equal(harness.tool.description, "Read or atomically update a session-local task ledger. `todo list` returns every item in original order. `todo update` applies ordered append, modify, delete, or clear operations as one batch. Multiple items may be in progress. Dependencies must form an acyclic graph and reference exact existing subjects. Deleting an in_progress item is rejected before dependency checks. Deleting a referenced item is rejected. Clear rejects every current in_progress item. It removes all pending and completed items. Any invalid operation or final graph rolls back the entire batch.");
  assert.equal(harness.tool.promptSnippet, "Track session tasks and dependencies.");
  const expectedGuidelines = [
    "Append newly added user work with `todo update` instead of replacing existing items.",
    "Preserve existing `todo` items unless the user or current work requires a change.",
    "Finish current in-progress `todo` work before appended work unless blocked or explicitly reordered.",
    "Complete each `todo` dependency before starting or completing its dependent item.",
    "Remove all `todo` dependency references before deleting a pending or completed target.",
    "Ask whether to set each in_progress `todo` item pending or completed before deleting or clearing it.",
  ];
  assert.deepEqual(TODO_PROMPT_GUIDELINES, expectedGuidelines);
  assert.doesNotMatch(TODO_PROMPT_GUIDELINES.join("\n"), /\b(?:snapshot|replay|store|version|widget|ID)\b/i);
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
      rootType: "object",
      additionalProperties: false,
      rootHasUnion: false,
      actions: ["list", "update"],
    });
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});
