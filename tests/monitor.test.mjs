import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import test, { beforeEach } from "node:test";
import { piRoot } from "./fixtures/pi-install.mjs";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@earendil-works/pi-coding-agent") return { url: pathToFileURL(`${piRoot}/dist/index.js`).href, shortCircuit: true };
    if (specifier === "@earendil-works/pi-tui") return { url: pathToFileURL(`${piRoot}/node_modules/@earendil-works/pi-tui/dist/index.js`).href, shortCircuit: true };
    if (specifier === "typebox") return { url: pathToFileURL(`${piRoot}/node_modules/typebox/build/index.mjs`).href, shortCircuit: true };
    if (specifier === "../tool-contracts.js") return { url: new URL("../extensions/oh-my-pi-slim/tool-contracts.ts", import.meta.url).href, shortCircuit: true };
    if (specifier === "./transcript-renderer.js") return { url: new URL("../extensions/oh-my-pi-slim/monitor/transcript-renderer.ts", import.meta.url).href, shortCircuit: true };
    if (specifier === "./widget.js") return { url: new URL("../extensions/oh-my-pi-slim/monitor/widget.ts", import.meta.url).href, shortCircuit: true };
    if (specifier === "./runtime.js") return { url: new URL("../extensions/oh-my-pi-slim/monitor/runtime.ts", import.meta.url).href, shortCircuit: true };
    if (specifier === "../semantic-glyph.js") return { url: new URL("../extensions/oh-my-pi-slim/semantic-glyph.ts", import.meta.url).href, shortCircuit: true };
    if (specifier === "../widget-stack.js") return { url: new URL("../extensions/oh-my-pi-slim/widget-stack.ts", import.meta.url).href, shortCircuit: true };
    if (specifier === "../widget-stack-host.js") return { url: new URL("../extensions/oh-my-pi-slim/widget-stack-host.ts", import.meta.url).href, shortCircuit: true };
    if (specifier === "./widget-expansion.js") return { url: new URL("../extensions/oh-my-pi-slim/widget-expansion.ts", import.meta.url).href, shortCircuit: true };
    if (specifier === "./widget-stack.js") return { url: new URL("../extensions/oh-my-pi-slim/widget-stack.ts", import.meta.url).href, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});

const {
  MONITOR_NOTIFICATION_TYPE,
  MonitorRuntime,
  registerMonitorRuntime,
} = await import("../extensions/oh-my-pi-slim/monitor/runtime.ts");
const {
  MONITOR_ACTIONS,
  MONITOR_PUBLIC_FIELDS,
  MONITOR_TOOL_CONTRACT,
  monitorParameters,
} = await import("../extensions/oh-my-pi-slim/tool-contracts.ts");
const { resetWidgetStackHost } = await import("../extensions/oh-my-pi-slim/widget-stack-host.ts");

beforeEach(() => resetWidgetStackHost());

function wait(milliseconds = 0) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function fakeChild(pid = 24680) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.unref = () => {};
  queueMicrotask(() => child.emit("spawn"));
  return child;
}

function closeChild(child, code = 0, signal = null) {
  child.stdout.end();
  child.stderr.end();
  child.emit("exit", code, signal);
  child.emit("close", code, signal);
}

function createHarness(options = {}) {
  mkdirSync(join(process.cwd(), ".cache"), { recursive: true });
  const logRoot = mkdtempSync(join(process.cwd(), ".cache", "monitor-test-"));
  const tools = new Map();
  const messages = [];
  const pi = {
    registerTool(definition) { tools.set(definition.name, definition); },
    registerMessageRenderer() {},
    sendMessage(message, sendOptions) { messages.push({ message, options: sendOptions }); },
  };
  const runtime = new MonitorRuntime(pi, {
    platform: "linux",
    eventBatchMs: 5,
    makeLogRoot: () => logRoot,
    ...options,
  });
  runtime.registerTool();
  const ctx = { cwd: process.cwd() };
  return {
    runtime,
    tools,
    messages,
    ctx,
    execute(params) { return tools.get("monitor").execute("call", params, undefined, undefined, ctx); },
    async close(children = []) {
      for (const child of children) if (child.listenerCount("close")) closeChild(child);
      await runtime.shutdown();
      rmSync(logRoot, { recursive: true, force: true });
    },
  };
}

function ack(runtime, sent) {
  return runtime.acknowledgeNotificationMessage({
    role: "custom",
    customType: MONITOR_NOTIFICATION_TYPE,
    details: sent.message.details,
  });
}

test("monitor exposes only the event-watcher contract", () => {
  const schema = JSON.parse(JSON.stringify(monitorParameters));
  assert.equal(schema.type, "object");
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(Object.keys(schema.properties).sort(), [...MONITOR_PUBLIC_FIELDS].sort());
  assert.deepEqual(schema.properties.action.anyOf.map((branch) => branch.const), [...MONITOR_ACTIONS]);
  assert.deepEqual([...MONITOR_ACTIONS], ["create", "list", "check", "stop", "clear"]);
  assert.deepEqual([...MONITOR_PUBLIC_FIELDS], ["action", "abstract", "command", "cwd", "id"]);
  assert.match(MONITOR_TOOL_CONTRACT.description, /Each stdout line becomes an event notification/);
  assert.match(MONITOR_TOOL_CONTRACT.description, /Each stdout line is an event/);
  for (const removed of ["checkAfter", "notifyOn", "start", "end"]) assert.equal(removed in schema.properties, false);

  const windowsTools = [];
  assert.equal(registerMonitorRuntime({ registerTool(tool) { windowsTools.push(tool); } }, { platform: "win32" }), undefined);
  assert.deepEqual(windowsTools, []);
});

test("actions enforce their small field sets", async (t) => {
  const child = fakeChild();
  const harness = createHarness({ spawn: () => child, resolveShell: () => "/bin/bash" });
  t.after(() => harness.close([child]));

  await assert.rejects(harness.execute({ action: "create", abstract: "watch", command: "x", id: "00000001" }), /does not accept field/);
  await assert.rejects(harness.execute({ action: "create", abstract: " ", command: "x" }), /abstract must be a non-empty/);
  await assert.rejects(harness.execute({ action: "create", abstract: "watch", command: " " }), /command must be a non-empty/);
  await assert.rejects(harness.execute({ action: "list", id: "00000001" }), /does not accept field/);
  await assert.rejects(harness.execute({ action: "check", id: "ABCDEF12" }), /exact 8-character/);
  await assert.rejects(harness.execute({ action: "status", id: "00000001" }), /Unsupported action/);
  await assert.rejects(harness.execute({ action: "delete", id: "00000001" }), /Unsupported action/);
});

test("create is atomic on spawn failure", async () => {
  const harness = createHarness({ spawn() { throw new Error("spawn unavailable"); }, resolveShell: () => "/bin/bash" });
  await assert.rejects(harness.execute({ action: "create", abstract: "watch", command: "echo event" }), /spawn unavailable/);
  assert.deepEqual(harness.runtime.list(), []);
  await harness.close();
});

test("stdout lines become one event batch while stderr stays out of notifications", async (t) => {
  const child = fakeChild();
  const harness = createHarness({ spawn: () => child, resolveShell: () => "/bin/bash", randomHex: () => "11111111" });
  t.after(() => harness.close([child]));
  const created = await harness.execute({ action: "create", abstract: "deploy events", command: "unused" });
  assert.deepEqual(JSON.parse(created.content[0].text), { id: "11111111", status: "running" });

  child.stdout.write("ready\nfailed\n");
  child.stderr.write("diagnostic only\n");
  await wait(15);

  assert.equal(harness.messages.length, 1);
  const sent = harness.messages[0];
  assert.deepEqual(sent.options, { deliverAs: "steer", triggerTurn: true });
  assert.equal(sent.message.details.kind, "update");
  assert.equal(sent.message.details.status, "running");
  assert.deepEqual(sent.message.details.lines.map((line) => [line.stream, line.text]), [
    ["stdout", "ready"],
    ["stdout", "failed"],
  ]);
  assert.doesNotMatch(sent.message.content, /diagnostic only/);
});

test("check returns bounded recent stdout and stderr", async (t) => {
  const child = fakeChild();
  const harness = createHarness({ spawn: () => child, resolveShell: () => "/bin/bash", randomHex: () => "22222222" });
  t.after(() => harness.close([child]));
  await harness.execute({ action: "create", abstract: "events", command: "unused" });
  child.stdout.write("event\n");
  child.stderr.write("warning\n");
  await wait();

  const checked = await harness.execute({ action: "check", id: "22222222" });
  assert.deepEqual(JSON.parse(checked.content[0].text), {
    id: "22222222",
    status: "running",
    output: "[stdout] event\n[stderr] warning",
  });
  assert.deepEqual(checked.details.monitor.combined.map((line) => line.stream), ["stdout", "stderr"]);
});

test("completion sends one terminal notification after outstanding events", async (t) => {
  const child = fakeChild();
  const harness = createHarness({ spawn: () => child, resolveShell: () => "/bin/bash", randomHex: () => "33333333" });
  t.after(() => harness.close([child]));
  await harness.execute({ action: "create", abstract: "events", command: "unused" });
  child.stdout.write("event\n");
  await wait(15);
  assert.equal(harness.messages.length, 1);
  closeChild(child, 0);
  assert.equal(harness.messages.length, 1, "terminal delivery waits behind the unacknowledged event");
  assert.equal(ack(harness.runtime, harness.messages[0]), true);
  assert.equal(harness.messages.length, 2);
  const terminal = harness.messages[1].message;
  assert.equal(terminal.details.status, "completed");
  assert.equal(terminal.details.exitCode, 0);
  assert.deepEqual(terminal.details.lines, []);
  assert.match(terminal.content, /status completed/);
});

test("failed completion includes stderr diagnostics", async (t) => {
  const child = fakeChild();
  const harness = createHarness({ spawn: () => child, resolveShell: () => "/bin/bash", randomHex: () => "44444444" });
  t.after(() => harness.close([child]));
  await harness.execute({ action: "create", abstract: "events", command: "unused" });
  child.stderr.write("fatal detail\n");
  closeChild(child, 2);
  assert.equal(harness.messages.length, 1);
  const terminal = harness.messages[0].message;
  assert.equal(terminal.details.status, "failed");
  assert.equal(terminal.details.exitCode, 2);
  assert.deepEqual(terminal.details.lines.map((line) => [line.stream, line.text]), [["stderr", "fatal detail"]]);
  assert.match(terminal.content, /fatal detail/);
});

test("stop owns termination and returns the final state without a terminal notification", async (t) => {
  const child = fakeChild();
  const signals = [];
  const harness = createHarness({
    spawn: () => child,
    resolveShell: () => "/bin/bash",
    randomHex: () => "55555555",
    killGroup(_pid, signal) {
      signals.push(signal);
      queueMicrotask(() => closeChild(child, null, signal));
    },
  });
  t.after(() => harness.close([child]));
  await harness.execute({ action: "create", abstract: "events", command: "unused" });
  const stopped = await harness.execute({ action: "stop", id: "55555555" });
  assert.deepEqual(signals, ["SIGTERM"]);
  assert.equal(stopped.details.monitor.status, "killed");
  assert.deepEqual(JSON.parse(stopped.content[0].text), {
    id: "55555555",
    status: "killed",
    exitCode: null,
    signal: "SIGTERM",
  });
  assert.equal(harness.messages.length, 0);
});

test("clear removes terminal monitors and refuses running ones", async (t) => {
  const children = [fakeChild(1), fakeChild(2)];
  let index = 0;
  const ids = ["66666666", "77777777"];
  const harness = createHarness({ spawn: () => children[index++], resolveShell: () => "/bin/bash", randomHex: () => ids.shift() });
  t.after(() => harness.close(children));
  await harness.execute({ action: "create", abstract: "first", command: "unused" });
  await assert.rejects(harness.execute({ action: "clear" }), /requires every monitor to be terminal/);
  closeChild(children[0]);
  const cleared = await harness.execute({ action: "clear" });
  assert.deepEqual(JSON.parse(cleared.content[0].text), { clearedCount: 1 });
  assert.deepEqual(harness.runtime.list(), []);
});

test("paused delivery coalesces stdout events and preserves one terminal update", async (t) => {
  const child = fakeChild();
  const harness = createHarness({ spawn: () => child, resolveShell: () => "/bin/bash", randomHex: () => "88888888" });
  t.after(() => harness.close([child]));
  await harness.execute({ action: "create", abstract: "events", command: "unused" });
  harness.runtime.setDeliveryPaused(true);
  child.stdout.write("one\n");
  await wait(10);
  child.stdout.write("two\n");
  await wait(10);
  closeChild(child);
  assert.equal(harness.messages.length, 0);
  harness.runtime.setDeliveryPaused(false);
  assert.equal(harness.messages.length, 1);
  assert.equal(harness.messages[0].message.details.status, "completed");
  assert.deepEqual(harness.messages[0].message.details.lines.map((line) => line.text), ["one", "two"]);
});
