import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  constants as fsConstants,
  existsSync,
  openSync as nativeOpenSync,
  readSync as nativeReadSync,
  realpathSync,
  renameSync as nativeRenameSync,
  writeSync as nativeWriteSync,
} from "node:fs";
import { registerHooks } from "node:module";
import { dirname } from "node:path";
import { PassThrough } from "node:stream";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import test, { beforeEach } from "node:test";

const piEntry = realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim());
const piRoot = dirname(dirname(piEntry));
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@earendil-works/pi-coding-agent") return { url: pathToFileURL(`${piRoot}/dist/index.js`).href, shortCircuit: true };
    if (specifier === "@earendil-works/pi-tui") return { url: pathToFileURL(`${piRoot}/node_modules/@earendil-works/pi-tui/dist/index.js`).href, shortCircuit: true };
    if (specifier === "typebox") return { url: pathToFileURL(`${piRoot}/node_modules/typebox/build/index.mjs`).href, shortCircuit: true };
    if (specifier === "./monitor-transcript-renderer.js") return { url: new URL("../extensions/oh-my-pi-slim/monitor-transcript-renderer.ts", import.meta.url).href, shortCircuit: true };
    if (specifier === "./monitor-widget.js") return { url: new URL("../extensions/oh-my-pi-slim/monitor-widget.ts", import.meta.url).href, shortCircuit: true };
    if (specifier === "./monitor-runtime.js") return { url: new URL("../extensions/oh-my-pi-slim/monitor-runtime.ts", import.meta.url).href, shortCircuit: true };
    if (specifier === "./semantic-glyph.js") return { url: new URL("../extensions/oh-my-pi-slim/semantic-glyph.ts", import.meta.url).href, shortCircuit: true };
    if (specifier === "./widget-expansion.js") return { url: new URL("../extensions/oh-my-pi-slim/widget-expansion.ts", import.meta.url).href, shortCircuit: true };
    if (specifier === "./widget-stack.js") return { url: new URL("../extensions/oh-my-pi-slim/widget-stack.ts", import.meta.url).href, shortCircuit: true };
    if (specifier === "./widget-stack-host.js") return { url: new URL("../extensions/oh-my-pi-slim/widget-stack-host.ts", import.meta.url).href, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});

const {
  MONITOR_ACTIONS,
  MONITOR_MAX_CHECK_AFTER_MS,
  MONITOR_MIN_CHECK_AFTER_MS,
  MONITOR_NOTIFICATION_TYPE,
  MONITOR_PUBLIC_FIELDS,
  MonitorRuntime,
  canonicalizeMonitorCheckAfter,
  monitorParameters,
  parseMonitorCheckAfter,
  registerMonitorRuntime,
} = await import("../extensions/oh-my-pi-slim/monitor-runtime.ts");
const { resetWidgetStackHost } = await import("../extensions/oh-my-pi-slim/widget-stack-host.ts");

// The aggregate widget host is a process-wide singleton, so every test starts from an empty one.
beforeEach(() => resetWidgetStackHost());

function wait(milliseconds = 0) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
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

function createHarness(options = {}) {
  const tools = new Map();
  const messages = [];
  const pi = {
    registerTool(definition) { tools.set(definition.name, definition); },
    registerMessageRenderer() {},
    sendMessage(message, sendOptions) { messages.push({ message, options: sendOptions }); },
  };
  const runtime = new MonitorRuntime(pi, options);
  runtime.registerTool();
  const ctx = { cwd: process.cwd() };
  return {
    runtime,
    tools,
    messages,
    ctx,
    execute(params) { return tools.get("monitor").execute("call", params, undefined, undefined, ctx); },
  };
}

function closeChild(child, code = 0, signal = null) {
  child.stdout.end();
  child.stderr.end();
  child.emit("exit", code, signal);
  child.emit("close", code, signal);
}

function ack(runtime, sent) {
  return runtime.acknowledgeNotificationMessage({ role: "custom", customType: MONITOR_NOTIFICATION_TYPE, details: sent.message.details });
}

test("monitor schema and registration expose the exact portable main-only contract", () => {
  const schema = JSON.parse(JSON.stringify(monitorParameters));
  assert.equal(schema.type, "object");
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.anyOf, undefined);
  assert.equal(schema.oneOf, undefined);
  assert.deepEqual(Object.keys(schema.properties).sort(), [...MONITOR_PUBLIC_FIELDS].sort());
  assert.deepEqual(schema.properties.action.anyOf.map((branch) => branch.const), MONITOR_ACTIONS);
  assert.equal(schema.properties.notifyOn.maxItems, 20);
  assert.equal(schema.properties.notifyOn.items.maxLength, 500);

  const harness = createHarness({ platform: "linux" });
  const tool = harness.tools.get("monitor");
  assert.equal(tool.executionMode, "sequential");
  assert.equal(harness.tools.size, 1);
  assert.equal(tool.description, "Run and manage long-running foreground Bash commands on POSIX systems while Pi remains available. Each monitor owns the command's foreground process group. Matcher notifications carry the current status and only the new lines that matched a `notifyOn` literal. Terminal notifications carry the final status, exit code, signal, error, and any matched lines no earlier notification delivered. A failed or killed command also adds a bounded recent diagnostic tail. A silence reminder arrives whenever a running command produces no output for its `checkAfter` threshold. Summary notifications report rate-limited matcher batches. `notifyOn` performs case-sensitive literal matching. `monitor list` returns compact retained records. `monitor status` returns one record's full retained state and combined logs. `monitor stop` terminates a running group and returns its complete terminal state. `monitor delete` removes one terminal record, while `monitor clear` removes all terminal records. Running records must be stopped only after user agreement. Terminal records remain available until deletion or clearing. Runtime shutdown terminates active groups and clears retained monitor data.");
  assert.equal(tool.promptSnippet, "Supervise long-running foreground commands.");
  assert.deepEqual(tool.promptGuidelines, [
    "Never detach a `monitor create` command with nohup, setsid, disown, trailing &, or another daemon escape.",
    "Do not poll a running monitor with repeated `monitor status` calls.",
    "Matcher updates carry matching lines, terminal updates add pending matches and bounded failure tails, and `monitor status` returns everything retained.",
  ]);
  assert.equal(schema.properties.action.description, "Choose an action. create requires abstract, command, and checkAfter, with optional cwd and notifyOn. stop, delete, and status require id. clear and list accept no other fields. status optionally accepts start and end.");
  assert.equal(schema.properties.command.description, "Foreground Bash command for create. Do not use nohup, setsid, disown, trailing &, or another detach escape.");
  assert.equal(schema.properties.checkAfter.type, "string");
  assert.equal(schema.required?.includes("checkAfter") ?? false, false, "the shared action schema keeps checkAfter optional at the root");
  assert.equal(schema.properties.checkAfter.description, "Required silence threshold for create, from 10s through 7d. A reminder arrives whenever the command stays silent that long. Format: one positive integer plus s, m, h, or d.");
  assert.equal(schema.properties.end.description, "Reverse log offset ending the status window. Defaults to 100 and must exceed start by at most 2000.");

  const windowsTools = [];
  assert.equal(registerMonitorRuntime({ registerTool(toolValue) { windowsTools.push(toolValue); } }, { platform: "win32" }), undefined);
  assert.deepEqual(windowsTools, []);
});

test("actions isolate fields and validate trimmed values, notify literals, windows, and exact IDs", async (t) => {
  const children = [];
  const harness = createHarness({
    spawn() { const child = fakeChild(25000 + children.length); children.push(child); return child; },
    resolveShell: () => "/bin/bash",
  });
  t.after(async () => { for (const child of children) if (child.listenerCount("close")) closeChild(child); await harness.runtime.shutdown(); });

  await assert.rejects(harness.execute({ action: "create", checkAfter: "10m", abstract: "x", command: "x", id: "12345678" }), /does not accept field/);
  await assert.rejects(harness.execute({ action: "list", id: "12345678" }), /does not accept field/);
  await assert.rejects(harness.execute({ action: "clear", id: "12345678" }), /does not accept field/);
  await assert.rejects(harness.execute({ action: "stop", id: "12345678", command: "x" }), /does not accept field/);
  await assert.rejects(harness.execute({ action: "status", id: "12345678", command: "x" }), /does not accept field/);
  await assert.rejects(harness.execute({ action: "create", checkAfter: "10m", abstract: " ", command: "x" }), /abstract must be a non-empty/);
  await assert.rejects(harness.execute({ action: "create", checkAfter: "10m", abstract: "x", command: " " }), /command must be a non-empty/);
  await assert.rejects(harness.execute({ action: "create", checkAfter: "10m", abstract: "x", command: "x", notifyOn: ["A", "A"] }), /duplicate literal/);
  await assert.rejects(harness.execute({ action: "create", checkAfter: "10m", abstract: "x", command: "x", notifyOn: [" "] }), /non-empty/);
  await assert.rejects(harness.execute({ action: "create", checkAfter: "10m", abstract: "x", command: "x", notifyOn: ["x".repeat(501)] }), /at most 500/);
  await assert.rejects(harness.execute({ action: "create", checkAfter: "10m", abstract: "x", command: "x", notifyOn: Array.from({ length: 21 }, (_, i) => String(i)) }), /at most 20/);
  await assert.rejects(harness.execute({ action: "status", id: "ABCDEF12" }), /exact 8-character/);
  await assert.rejects(harness.execute({ action: "delete", id: "abcdef1" }), /exact 8-character/);
});

test("spawn failure is atomic while IDs collide safely and cwd defaults from context", async (t) => {
  const failed = createHarness({ spawn() { throw new Error("spawn unavailable"); }, resolveShell: () => "/bin/bash", randomHex: () => "00000001" });
  await assert.rejects(failed.execute({ action: "create", checkAfter: "10m", abstract: "a", command: "echo a" }), /spawn unavailable/);
  assert.deepEqual(failed.runtime.list(), []);
  await failed.runtime.shutdown();

  const children = [];
  const ids = ["00000001", "00000001", "00000002"];
  const harness = createHarness({
    randomHex: () => ids.shift(),
    spawn() { const child = fakeChild(26000 + children.length); children.push(child); return child; },
    resolveShell: () => "/bin/bash",
  });
  t.after(async () => { children.forEach((child) => closeChild(child)); await harness.runtime.shutdown(); });
  const first = await harness.execute({ action: "create", checkAfter: "10m", abstract: " first ", command: " echo first " });
  const second = await harness.execute({ action: "create", checkAfter: "10m", abstract: "second", command: "echo second" });
  assert.equal(first.details.monitor.id, "00000001");
  assert.equal(second.details.monitor.id, "00000002");
  assert.equal(first.details.monitor.abstract, "first");
  assert.equal(first.details.monitor.command, "echo first");
  assert.equal(first.details.monitor.cwd, process.cwd());
  assert.deepEqual(harness.runtime.list().map((item) => item.id), ["00000001", "00000002"]);
});

test("stream decoding reconstructs UTF-8 and chunks, normalizes CR, sanitizes controls, truncates long lines, and flushes EOF once", async (t) => {
  let child;
  const harness = createHarness({
    randomHex: () => "11111111",
    partialLineMaxBytes: 20,
    spawn() { child = fakeChild(); return child; },
    resolveShell: () => "/bin/bash",
  });
  t.after(async () => harness.runtime.shutdown());
  await harness.execute({ action: "create", checkAfter: "10m", abstract: "decode", command: "unused" });
  const snowman = Buffer.from("snow ☃\n");
  child.stdout.write(Buffer.concat([Buffer.from("split "), snowman.subarray(0, 6)]));
  child.stdout.write(snowman.subarray(6));
  child.stderr.write("progress 1\rprogress 2\r\n");
  child.stdout.write("\u001b[31mred\u001b[0m\u0001\n");
  child.stdout.write("abcdefghijklmnopqrstuvwxyz");
  closeChild(child, 0, null);
  await wait();
  const status = (await harness.execute({ action: "status", id: "11111111", start: 0, end: 100 })).details.monitor;
  assert.equal(status.status, "completed");
  assert.deepEqual(status.combined.map((line) => [line.stream, line.text]), [
    ["stdout", "split snow ☃"],
    ["stderr", "progress 1"],
    ["stderr", "progress 2"],
    ["stdout", "red"],
    ["stdout", "abcdefghijklmnopqrst … [truncated 6 bytes]"],
  ]);
  assert.deepEqual(status.combined.map((line) => line.seq), [1, 2, 3, 4, 5]);
  assert.equal(status.logLines, 5);
  assert.equal(harness.messages.length, 1, "EOF and close produce one terminal notification");
});

test("terminal notifications use the injected sendMessage seam without changing payload or options", async (t) => {
  let child;
  const seamCalls = [];
  const harness = createHarness({
    randomHex: () => "21212121",
    spawn() { child = fakeChild(); return child; },
    resolveShell: () => "/bin/bash",
    sendMessage(message, options) { seamCalls.push({ message, options }); },
  });
  t.after(async () => { if (child.listenerCount("close")) closeChild(child); await harness.runtime.shutdown(); });

  await harness.execute({ action: "create", checkAfter: "10m", abstract: "sender seam", command: "unused" });
  child.stdout.write("terminal output\n");
  closeChild(child, 0, null);
  await wait();

  assert.equal(harness.messages.length, 0, "the injected sender bypasses Pi sendMessage");
  assert.equal(seamCalls.length, 1);
  const sent = seamCalls[0];
  const pending = [...harness.runtime.notifications.values()][0];
  assert.ok(pending);
  assert.equal(sent.message.customType, MONITOR_NOTIFICATION_TYPE);
  assert.equal(sent.message.content, pending.content);
  assert.equal(sent.message.display, true);
  assert.deepEqual(sent.message.details, { ...pending.details, deliveryKey: pending.deliveryKey });
  assert.equal(sent.message.details.deliveryKey, pending.deliveryKey);
  assert.deepEqual(sent.options, { deliverAs: "steer", triggerTurn: true });
  assert.equal(sent.message.details.status, "completed", "the seam receives a real terminal notification");
});

test("reverse status pagination returns chronological combined lines and never advances notification cursor", async (t) => {
  let child;
  const harness = createHarness({
    randomHex: () => "22222222",
    matcherBatchMs: 5,
    spawn() { child = fakeChild(); return child; },
    resolveShell: () => "/bin/bash",
  });
  t.after(async () => harness.runtime.shutdown());
  await harness.execute({ action: "create", checkAfter: "10m", abstract: "paging", command: "unused", notifyOn: ["hit"] });
  child.stdout.write("one\ntwo hit\nthree\nfour\n");
  const page = (await harness.execute({ action: "status", id: "22222222", start: 1, end: 3 })).details.monitor;
  assert.deepEqual(page.combined.map((line) => line.text), ["two hit", "three"]);
  await assert.rejects(harness.execute({ action: "status", id: "22222222", start: 2, end: 2 }), /0 <= start < end/);
  await assert.rejects(harness.execute({ action: "status", id: "22222222", start: 0, end: 2001 }), /at most 2000/);
  await wait(10);
  assert.deepEqual(harness.messages[0].message.details.lines.map((line) => line.text), ["two hit"]);
  assert.doesNotMatch(harness.messages[0].message.content, /\[stdout\] one|\[stdout\] three|\[stdout\] four/);
  closeChild(child);
});

test("matcher batches repeat matches, aggregate keywords, cap lines, rate-limit globally, and emit a summary", async (t) => {
  let now = 1_000;
  const children = [];
  const messages = [];
  const tools = new Map();
  const pi = { registerTool(tool) { tools.set(tool.name, tool); }, registerMessageRenderer() {}, sendMessage(message, options) { messages.push({ message, options }); } };
  const runtime = new MonitorRuntime(pi, {
    nowMs: () => now,
    randomHex: (() => { let id = 1; return () => String(id++).padStart(8, "0"); })(),
    spawn() { const child = fakeChild(27000 + children.length); children.push(child); return child; },
    resolveShell: () => "/bin/bash",
    matcherBatchMs: 2,
    rateLimitCount: 2,
    rateLimitWindowMs: 20,
  });
  runtime.registerTool();
  const execute = (params) => tools.get("monitor").execute("call", params, undefined, undefined, { cwd: process.cwd() });
  t.after(async () => { children.forEach((child) => { if (child.listenerCount("close")) closeChild(child); }); await runtime.shutdown(); });
  const first = await execute({ action: "create", checkAfter: "10m", abstract: "first", command: "unused", notifyOn: ["A", "B"] });
  const second = await execute({ action: "create", checkAfter: "10m", abstract: "second", command: "unused", notifyOn: ["X"] });
  children[0].stdout.write(`${Array.from({ length: 105 }, (_, i) => `A${i}`).join("\n")}\nB A\n`);
  await wait(5);
  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0].message.details.matched.sort(), ["A", "B"]);
  assert.equal(messages[0].message.details.lines.length, 100);
  assert.equal(messages[0].message.details.omitted, 6);
  children[0].stdout.write("A again\n");
  await wait(5);
  children[1].stdout.write("X suppressed\n");
  await wait(5);
  assert.equal(messages.length, 2, "third global matcher batch is suppressed");
  let secondStatus = (await execute({ action: "status", id: second.details.monitor.id })).details.monitor;
  assert.equal(secondStatus.suppressedCount, 1);
  now += 25;
  await wait(25);
  assert.equal(messages.length, 3);
  assert.equal(messages[2].message.details.kind, "summary");
  assert.match(messages[2].message.content, /Use monitor status/);
  const firstStatus = (await execute({ action: "status", id: first.details.monitor.id })).details.monitor;
  assert.equal(firstStatus.matchedCount, 108);
});

test("notification gate, acknowledgement, retry, terminal blocker, retention, and delete cancellation work together", async (t) => {
  let child;
  let attempts = 0;
  const sent = [];
  const tools = new Map();
  const runtime = new MonitorRuntime({
    registerTool(tool) { tools.set(tool.name, tool); },
    registerMessageRenderer() {},
    sendMessage(message, options) {
      attempts += 1;
      if (attempts === 1) throw new Error("queue busy");
      sent.push({ message, options });
    },
  }, {
    randomHex: () => "33333333",
    spawn() { child = fakeChild(); return child; },
    resolveShell: () => "/bin/bash",
    matcherBatchMs: 2,
  });
  runtime.registerTool();
  const execute = (params) => tools.get("monitor").execute("call", params, undefined, undefined, { cwd: process.cwd() });
  t.after(async () => runtime.shutdown());
  runtime.setDeliveryPaused(true);
  const created = await execute({ action: "create", checkAfter: "10m", abstract: "notify", command: "unused", notifyOn: ["hit"] });
  child.stdout.write("hit\n");
  await wait(5);
  assert.equal(attempts, 0);
  runtime.setDeliveryPaused(false);
  assert.equal(attempts, 1);
  runtime.retryQueuedNotificationsAfterAgentSettled();
  assert.equal(attempts, 2);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].options, { deliverAs: "steer", triggerTurn: true });
  assert.equal((await execute({ action: "status", id: "33333333" })).details.monitor.notificationCount, 1, "safe retry counts one logical notification");
  assert.equal(ack(runtime, sent[0]), true);

  child.stdout.write("tail\n");
  closeChild(child, 7, null);
  await wait();
  assert.equal(runtime.hasRunning(), false);
  assert.equal(runtime.hasBlockingWork(), true, "undelivered terminal notification blocks Goal");
  const terminal = sent.at(-1);
  assert.equal(terminal.message.details.kind, "update");
  assert.equal(terminal.message.details.status, "failed");
  assert.equal(terminal.message.details.exitCode, 7);
  assert.equal(existsSync(created.details.monitor.logPath), true, "terminal logs remain until delete");
  await execute({ action: "delete", id: "33333333" });
  assert.equal(existsSync(created.details.monitor.logPath), false);
  assert.equal(runtime.hasBlockingWork(), true, "delete cannot retract a notification already handed to Pi");
  assert.equal(ack(runtime, terminal), true);
  assert.equal(runtime.hasBlockingWork(), false);
  await assert.rejects(execute({ action: "status", id: "33333333" }), /was not found/);
});

test("delete cancels terminal and matcher notifications that are still gated", async (t) => {
  let child;
  const harness = createHarness({
    randomHex: () => "34343434",
    spawn() { child = fakeChild(); return child; },
    resolveShell: () => "/bin/bash",
    matcherBatchMs: 2,
  });
  t.after(async () => harness.runtime.shutdown());
  harness.runtime.setDeliveryPaused(true);
  await harness.execute({ action: "create", checkAfter: "10m", abstract: "cancel", command: "unused", notifyOn: ["hit"] });
  child.stdout.write("hit\n");
  await wait(5);
  closeChild(child);
  await wait();
  await harness.execute({ action: "delete", id: "34343434" });
  harness.runtime.setDeliveryPaused(false);
  assert.equal(harness.messages.length, 0);
  assert.equal(harness.runtime.hasBlockingWork(), false);
});

test("stop owns terminal delivery, sends TERM then KILL, preserves the real killed state, and retains logs", async (t) => {
  let child;
  const signals = [];
  const harness = createHarness({
    randomHex: () => "44444444",
    spawn() { child = fakeChild(44444); return child; },
    resolveShell: () => "/bin/bash",
    deleteGraceMs: 1,
    sleep: async () => {},
    killGroup(pid, signal) {
      signals.push([pid, signal]);
      if (signal === "SIGKILL") closeChild(child, null, "SIGKILL");
    },
  });
  t.after(async () => harness.runtime.shutdown());
  const created = await harness.execute({ action: "create", checkAfter: "10m", abstract: "stop", command: "unused" });
  const stopped = await harness.execute({ action: "stop", id: "44444444" });
  assert.deepEqual(signals, [[44444, "SIGTERM"], [44444, 0], [44444, "SIGKILL"]]);
  assert.equal(stopped.details.changed, true);
  assert.equal(stopped.details.outcome, "stopped");
  assert.equal(stopped.details.warning, null);
  assert.equal(stopped.details.monitor.status, "killed");
  assert.equal(stopped.details.monitor.signal, "SIGKILL");
  assert.equal(harness.messages.length, 0, "stop suppresses its independently queued terminal notification");
  assert.equal(harness.runtime.hasBlockingWork(), false);
  assert.equal(existsSync(created.details.monitor.logPath), true, "stop retains the record and log");
  await harness.execute({ action: "delete", id: "44444444" });
});

test("stop reports raced and already-terminal outcomes and folds pending matches into its complete state once", async (t) => {
  let child;
  const signals = [];
  const harness = createHarness({
    randomHex: () => "45454545",
    spawn() { child = fakeChild(45454); return child; },
    resolveShell: () => "/bin/bash",
    matcherBatchMs: 5_000,
    killGroup(pid, signal) {
      signals.push([pid, signal]);
      if (signal === "SIGTERM") closeChild(child, 0, null);
    },
  });
  t.after(async () => harness.runtime.shutdown());
  await harness.execute({ action: "create", checkAfter: "10m", abstract: "race", command: "unused", notifyOn: ["hit"] });
  child.stdout.write("hit before stop\n");
  await wait();
  const stopped = await harness.execute({ action: "stop", id: "45454545" });
  assert.deepEqual(signals, [[45454, "SIGTERM"]]);
  assert.equal(stopped.details.changed, true);
  assert.equal(stopped.details.outcome, "raced");
  assert.equal(stopped.details.monitor.status, "completed");
  assert.deepEqual(stopped.details.monitor.combined.map((line) => line.text), ["hit before stop"]);
  assert.equal(harness.messages.length, 0);
  const again = await harness.execute({ action: "stop", id: "45454545" });
  assert.equal(again.details.changed, false);
  assert.equal(again.details.outcome, "already-terminal");
  assert.equal(again.details.monitor.status, "completed");
});

test("stop uses a fixed latest-100 scan window even when retained logLines is very large", async (t) => {
  const children = [];
  const ids = ["45111145", "45222245"];
  const harness = createHarness({
    randomHex: () => ids.shift(),
    spawn() { const child = fakeChild(45100 + children.length); children.push(child); return child; },
    resolveShell: () => "/bin/bash",
    killGroup(pid, signal) {
      if (signal !== "SIGTERM") return;
      const child = children.find((candidate) => candidate.pid === pid);
      closeChild(child, null, "SIGTERM");
    },
  });
  t.after(async () => harness.runtime.shutdown());
  await harness.execute({ action: "create", checkAfter: "10m", abstract: "already terminal bounded", command: "unused" });
  await harness.execute({ action: "create", checkAfter: "10m", abstract: "running bounded", command: "unused" });
  for (let index = 0; index < 300; index += 1) {
    children[0].stdout.write(`terminal-${index}\n`);
    children[1].stdout.write(`running-${index}\n`);
  }
  harness.runtime.records.get("45111145").logLines = 500_000;
  harness.runtime.records.get("45222245").logLines = 750_000;
  const scanWindows = [];
  const scanLogTail = harness.runtime.scanLogTail.bind(harness.runtime);
  harness.runtime.scanLogTail = (record, start, end) => {
    scanWindows.push({ id: record.id, start, end });
    return scanLogTail(record, start, end);
  };

  closeChild(children[0], 0, null);
  await wait();
  const already = await harness.execute({ action: "stop", id: "45111145" });
  const running = await harness.execute({ action: "stop", id: "45222245" });

  assert.deepEqual(scanWindows, [
    { id: "45111145", start: 0, end: 100 },
    { id: "45222245", start: 0, end: 100 },
  ]);
  assert.equal(already.details.outcome, "already-terminal");
  assert.equal(running.details.outcome, "stopped");
  assert.equal(already.details.monitor.returned, 100);
  assert.equal(running.details.monitor.returned, 100);
  assert.equal(already.details.monitor.end, 100);
  assert.equal(running.details.monitor.end, 100);
  assert.deepEqual(already.details.monitor.combined.map((line) => line.text), Array.from({ length: 100 }, (_, index) => `terminal-${index + 200}`));
  assert.deepEqual(running.details.monitor.combined.map((line) => line.text), Array.from({ length: 100 }, (_, index) => `running-${index + 200}`));
});

test("stop preserves an already queued matcher update while suppressing only its terminal update", async (t) => {
  let child;
  const harness = createHarness({
    randomHex: () => "45555545",
    spawn() { child = fakeChild(45554); return child; },
    resolveShell: () => "/bin/bash",
    matcherBatchMs: 1,
    killGroup(_pid, signal) { if (signal === "SIGTERM") closeChild(child, null, "SIGTERM"); },
  });
  t.after(async () => harness.runtime.shutdown());
  harness.runtime.setDeliveryPaused(true);
  await harness.execute({ action: "create", checkAfter: "10m", abstract: "queued", command: "unused", notifyOn: ["hit"] });
  child.stdout.write("hit queued\n");
  await wait(5);
  const stopped = await harness.execute({ action: "stop", id: "45555545" });
  assert.equal(stopped.details.outcome, "stopped");
  assert.equal(harness.messages.length, 0);
  harness.runtime.setDeliveryPaused(false);
  assert.equal(harness.messages.length, 1);
  assert.equal(harness.messages[0].message.details.status, "running", "the queued matcher keeps its original notification state");
  assert.deepEqual(harness.messages[0].message.details.lines.map((line) => line.text), ["hit queued"]);
  assert.equal(harness.messages.some((sent) => sent.message.details.status === "killed"), false);
});

test("an unconfirmed stop force-fails and quiesces every resource without deleting retained state", async (t) => {
  let child;
  const signals = [];
  const harness = createHarness({
    randomHex: () => "46464646",
    spawn() { child = fakeChild(46464); return child; },
    resolveShell: () => "/bin/bash",
    deleteGraceMs: 1,
    finalKillWaitMs: 1,
    sleep: async () => {},
    killGroup(pid, signal) { signals.push([pid, signal]); },
  });
  t.after(async () => harness.runtime.shutdown());
  const created = await harness.execute({ action: "create", checkAfter: "10m", abstract: "held pipe", command: "unused" });
  const stopped = await harness.execute({ action: "stop", id: "46464646" });
  assert.deepEqual(signals, [[46464, "SIGTERM"], [46464, 0], [46464, "SIGKILL"]]);
  assert.equal(stopped.details.changed, true);
  assert.equal(stopped.details.outcome, "unconfirmed");
  assert.match(stopped.details.warning, /detached descendant may remain/i);
  assert.equal(stopped.details.monitor.status, "failed");
  assert.match(stopped.details.monitor.error, /unconfirmed/i);
  assert.equal(child.stdout.destroyed, true);
  assert.equal(child.stderr.destroyed, true);
  assert.deepEqual(harness.runtime.list().map((item) => item.id), ["46464646"]);
  assert.equal(existsSync(created.details.monitor.logPath), true);
  assert.equal(harness.messages.length, 0);
  assert.equal(harness.runtime.hasBlockingWork(), false);
});

test("running delete and clear reject with zero mutation, then terminal clear removes every record", async (t) => {
  const children = [];
  const harness = createHarness({
    randomHex: (() => { const ids = ["47474747", "48474747"]; return () => ids.shift(); })(),
    spawn() { const child = fakeChild(47000 + children.length); children.push(child); return child; },
    resolveShell: () => "/bin/bash",
  });
  t.after(async () => harness.runtime.shutdown());
  const first = await harness.execute({ action: "create", checkAfter: "10m", abstract: "first running", command: "unused" });
  const second = await harness.execute({ action: "create", checkAfter: "10m", abstract: "second running", command: "unused" });
  await assert.rejects(
    harness.execute({ action: "delete", id: "47474747" }),
    /Ask the user whether to stop it, then call monitor stop and retry delete only if they agree\./,
  );
  await assert.rejects(
    harness.execute({ action: "clear" }),
    /47474747 \(first running\).*48474747 \(second running\).*Ask the user whether to stop them/,
  );
  assert.deepEqual(harness.runtime.list().map((item) => item.id), ["47474747", "48474747"]);
  assert.equal(existsSync(first.details.monitor.logPath), true);
  assert.equal(existsSync(second.details.monitor.logPath), true);
  closeChild(children[0]);
  closeChild(children[1]);
  await wait();
  const cleared = await harness.execute({ action: "clear" });
  assert.equal(cleared.details.cleared, true);
  assert.equal(cleared.details.changed, true);
  assert.equal(cleared.details.clearedCount, 2);
  assert.deepEqual(new Set(cleared.details.ids), new Set(["47474747", "48474747"]));
  assert.deepEqual(cleared.details.warnings, []);
  assert.deepEqual(harness.runtime.list(), []);
  assert.equal(existsSync(first.details.monitor.logPath), false);
  assert.equal(existsSync(second.details.monitor.logPath), false);
  assert.deepEqual((await harness.execute({ action: "clear" })).details, {
    cleared: true,
    changed: false,
    clearedCount: 0,
    ids: [],
    warnings: [],
  });
});

test("terminal delete and clear report log removal failures but still remove records", async (t) => {
  const children = [];
  const harness = createHarness({
    randomHex: (() => { const ids = ["49474747", "50474747"]; return () => ids.shift(); })(),
    spawn() { const child = fakeChild(49000 + children.length); children.push(child); return child; },
    resolveShell: () => "/bin/bash",
    fs: { rmSync() { throw new Error("rm denied"); } },
  });
  t.after(async () => harness.runtime.shutdown());
  await harness.execute({ action: "create", checkAfter: "10m", abstract: "delete terminal", command: "unused" });
  await harness.execute({ action: "create", checkAfter: "10m", abstract: "clear terminal", command: "unused" });
  closeChild(children[0], 2, null);
  closeChild(children[1], 0, null);
  await wait();
  const deleted = await harness.execute({ action: "delete", id: "49474747" });
  assert.deepEqual({ ...deleted.details, warning: null }, {
    id: "49474747", deleted: true, changed: true, status: "failed", warning: null,
  });
  assert.match(deleted.details.warning, /rm denied/);
  const cleared = await harness.execute({ action: "clear" });
  assert.equal(cleared.details.changed, true);
  assert.deepEqual(cleared.details.ids, ["50474747"]);
  assert.equal(cleared.details.warnings.length, 1);
  assert.match(cleared.details.warnings[0], /50474747.*rm denied/);
  assert.deepEqual(harness.runtime.list(), []);
  assert.equal(harness.runtime.hasBlockingWork(), true, "in-flight terminal notifications survive delete and clear");
  for (const sent of harness.messages) assert.equal(ack(harness.runtime, sent), true);
  assert.equal(harness.runtime.hasBlockingWork(), false);
});

test("matcher delivery uses the bounded recent-line ring without reading the JSONL file", async (t) => {
  let child;
  let readCalls = 0;
  const harness = createHarness({
    randomHex: () => "48484848",
    spawn() { child = fakeChild(); return child; },
    resolveShell: () => "/bin/bash",
    matcherBatchMs: 2,
    fs: { readSync(...args) { readCalls += 1; return nativeReadSync(...args); } },
  });
  t.after(async () => harness.runtime.shutdown());
  const changes = [];
  harness.runtime.subscribe((change) => changes.push(change));
  await harness.execute({ action: "create", checkAfter: "10m", abstract: "ring", command: "unused", notifyOn: ["hit"] });
  readCalls = 0;
  child.stdout.write("before\nhit\nafter\n");
  await wait(5);
  assert.equal(readCalls, 0);
  assert.deepEqual(harness.messages[0].message.details.lines.map((line) => line.text), ["hit"]);
  assert.equal(changes.filter((change) => change.reason === "output").length, 3, "UI subscribers can throttle explicitly tagged high-frequency output changes");
  closeChild(child);
});

test("status scans JSONL from the tail in chunks and bounds large status and create payloads", async (t) => {
  let child;
  let readBytes = 0;
  const hugeCommand = `printf x; ${"x".repeat(80 * 1024)}`;
  const harness = createHarness({
    randomHex: () => "49494949",
    spawn() { child = fakeChild(); return child; },
    resolveShell: () => "/bin/bash",
    fs: {
      readSync(fd, buffer, offset, length, position) {
        const count = nativeReadSync(fd, buffer, offset, length, position);
        readBytes += count;
        return count;
      },
    },
  });
  t.after(async () => harness.runtime.shutdown());
  const created = await harness.execute({ action: "create", checkAfter: "10m", abstract: "payload", command: hugeCommand });
  assert.ok(Buffer.byteLength(created.content[0].text) <= 50 * 1024);
  assert.equal(created.details.monitor.truncated, true);
  for (let index = 0; index < 2000; index += 1) child.stdout.write(`line-${index}-${"z".repeat(120)}\n`);
  readBytes = 0;
  const tailResult = await harness.execute({ action: "status", id: "49494949", start: 0, end: 5 });
  assert.ok(readBytes < tailResult.details.monitor.logBytes, "shallow tail pagination must not read the entire log");
  readBytes = 0;
  const statusResult = await harness.execute({ action: "status", id: "49494949", start: 0, end: 2000 });
  const status = statusResult.details.monitor;
  assert.ok(Buffer.byteLength(statusResult.content[0].text) <= 50 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify(statusResult.details)) <= 96 * 1024);
  assert.equal(status.truncated, true);
  assert.ok(status.returned < 2000);
  assert.equal(status.omitted, 2000 - status.returned);
  assert.match(status.combined.at(-1).text, /line-1999/);
  closeChild(child);
});

test("matcher and terminal payloads include abstract and stay within content and details limits", async (t) => {
  let child;
  const harness = createHarness({
    randomHex: () => "50505050",
    spawn() { child = fakeChild(); return child; },
    resolveShell: () => "/bin/bash",
    matcherBatchMs: 2,
  });
  t.after(async () => harness.runtime.shutdown());
  await harness.execute({ action: "create", checkAfter: "10m", abstract: "bounded payload", command: "unused", notifyOn: ["MATCH"] });
  for (let index = 0; index < 100; index += 1) child.stdout.write(`MATCH-${index}-${"q".repeat(1000)}\n`);
  await wait(5);
  const matcher = harness.messages[0].message;
  assert.equal(matcher.details.abstract, "bounded payload");
  assert.ok(Buffer.byteLength(matcher.content) <= 50 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify(matcher.details)) <= 96 * 1024);
  assert.equal(matcher.details.truncated, true);
  assert.ok(matcher.details.omitted > 0);
  assert.match(matcher.content, /\n\[truncated: omitted \d+ lines and\/or shortened oversized lines; use monitor status\]$/);

  for (let index = 0; index < 150; index += 1) child.stdout.write(`MATCH-tail-${index}\n`);
  closeChild(child);
  await wait();
  const terminal = harness.messages.at(-1).message;
  assert.equal(terminal.details.abstract, "bounded payload");
  assert.ok(Buffer.byteLength(terminal.content) <= 50 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify(terminal.details)) <= 96 * 1024);
  assert.equal(terminal.details.lines.length, 100, "terminal updates reuse the same 100-line incremental cap");
  assert.equal(terminal.details.omitted, 50);
  assert.equal(terminal.details.truncated, true);
  assert.match(terminal.content, /\n\[truncated: omitted 50 lines and\/or shortened oversized lines; use monitor status\]$/);
  for (const field of [
    "command", "cwd", "pid", "createdAt", "updatedAt", "endedAt", "notifyOn", "matchedCount", "notificationCount",
    "suppressedCount", "logPath", "logBytes", "logLines", "droppedBytes", "droppedLines", "start", "end", "returned", "combined",
  ]) assert.equal(field in terminal.details, false, `terminal notification must not carry full state field ${field}`);
  assert.equal(typeof terminal.details.status, "string");

  const state = (await harness.execute({ action: "status", id: "50505050" })).details.monitor;
  assert.equal(state.status, "completed");
  assert.equal(typeof state.logPath, "string");
  assert.ok(state.combined.length > 0, "monitor status stays the only full retained state and log entry point");
});

test("matcher and terminal notifications share one incremental update contract that states current status", async (t) => {
  let child;
  const harness = createHarness({
    randomHex: () => "61616161",
    spawn() { child = fakeChild(); return child; },
    resolveShell: () => "/bin/bash",
    matcherBatchMs: 2,
  });
  t.after(async () => harness.runtime.shutdown());
  await harness.execute({ action: "create", checkAfter: "10m", abstract: "unified", command: "unused", notifyOn: ["hit"] });
  child.stdout.write("before\nhit one\n");
  await wait(5);

  const shape = ["id", "abstract", "kind", "status", "matched", "exitCode", "signal", "error", "lines", "omitted", "truncated", "deliveryKey"];
  const matcher = harness.messages[0].message;
  assert.deepEqual(Object.keys(matcher.details), shape);
  assert.equal(matcher.details.kind, "update");
  assert.equal(matcher.details.status, "running");
  assert.deepEqual(matcher.details.matched, ["hit"]);
  assert.equal(matcher.details.exitCode, null);
  assert.equal(matcher.details.signal, null);
  assert.equal(matcher.details.error, null);
  assert.deepEqual(matcher.details.lines.map((line) => line.text), ["hit one"], "a matcher batch carries only the lines that matched");
  assert.equal(matcher.details.omitted, 0);
  assert.equal(matcher.details.truncated, false);
  assert.deepEqual(matcher.content.split("\n"), [
    "Monitor 61616161 (unified) status running.",
    "Matched: hit.",
    "[stdout] hit one",
  ]);
  assert.doesNotMatch(matcher.content, /Exit code/);

  child.stdout.write("after\nhit two\n");
  closeChild(child, 0, null);
  await wait();
  assert.equal(harness.messages.length, 2);
  const terminal = harness.messages[1].message;
  assert.deepEqual(Object.keys(terminal.details), shape);
  assert.equal(terminal.details.kind, "update");
  assert.equal(terminal.details.status, "completed");
  assert.deepEqual(terminal.details.matched, ["hit"], "a terminal update names the literals its undelivered matches hit");
  assert.equal(terminal.details.exitCode, 0);
  assert.equal(terminal.details.signal, null);
  assert.equal(terminal.details.error, null);
  assert.deepEqual(terminal.content.split("\n"), [
    "Monitor 61616161 (unified) status completed.",
    "Matched: hit.",
    "Exit code: 0; signal: null; error: null.",
    "[stdout] hit two",
  ], "a completed close carries the undelivered match and never the ordinary line before it");

  const matcherSeqs = matcher.details.lines.map((line) => line.seq);
  const terminalSeqs = terminal.details.lines.map((line) => line.seq);
  assert.deepEqual(matcherSeqs, [2]);
  assert.deepEqual(terminalSeqs, [4]);
  assert.equal(terminalSeqs.some((seq) => matcherSeqs.includes(seq)), false, "close after a matcher batch repeats no line");
});

test("terminal updates report completed, failed, and killed while matcher updates always stay running", async (t) => {
  const cases = [
    { id: "62626262", code: 0, signal: null, status: "completed" },
    { id: "63636363", code: 3, signal: null, status: "failed" },
    { id: "64646464", code: null, signal: "SIGTERM", status: "killed" },
  ];
  for (const { id, code, signal, status } of cases) {
    let child;
    const harness = createHarness({
      randomHex: () => id,
      spawn() { child = fakeChild(); return child; },
      resolveShell: () => "/bin/bash",
      matcherBatchMs: 2,
    });
    t.after(async () => harness.runtime.shutdown());
    await harness.execute({ action: "create", checkAfter: "10m", abstract: `end ${status}`, command: "unused", notifyOn: ["hit"] });
    child.stdout.write("hit\n");
    await wait(5);
    assert.equal(harness.messages[0].message.details.status, "running");
    assert.deepEqual(harness.messages[0].message.details.matched, ["hit"]);
    closeChild(child, code, signal);
    await wait();
    const terminal = harness.messages.at(-1).message;
    assert.equal(terminal.details.status, status);
    assert.equal(terminal.details.exitCode, code);
    assert.equal(terminal.details.signal, signal);
    assert.equal(terminal.content.split("\n")[0], `Monitor ${id} (end ${status}) status ${status}.`);
    assert.equal(terminal.content.split("\n")[1], `Exit code: ${code ?? "null"}; signal: ${signal ?? "null"}; error: null.`);
    for (const sent of harness.messages.slice(0, -1)) {
      assert.equal(sent.message.details.status, "running");
      assert.deepEqual(sent.message.details.matched, ["hit"]);
    }
    assert.deepEqual(terminal.details.matched, [], "a batch delivered before the close leaves the terminal update with no literal");
  }
});

test("a matcher batch still pending at close folds its lines into the single terminal update", async (t) => {
  let child;
  const harness = createHarness({
    randomHex: () => "65656565",
    spawn() { child = fakeChild(); return child; },
    resolveShell: () => "/bin/bash",
    matcherBatchMs: 5_000,
  });
  t.after(async () => harness.runtime.shutdown());
  await harness.execute({ action: "create", checkAfter: "10m", abstract: "fold", command: "unused", notifyOn: ["hit"] });
  child.stdout.write("hit one\nhit two\n");
  await wait(5);
  assert.equal(harness.messages.length, 0, "the batch window has not elapsed yet");
  closeChild(child, 0, null);
  await wait();
  assert.equal(harness.messages.length, 1, "the cancelled batch produces no extra notification");
  const terminal = harness.messages[0].message;
  assert.equal(terminal.details.status, "completed");
  assert.deepEqual(terminal.details.matched, ["hit"], "the folded batch keeps its literals in the single terminal update");
  assert.deepEqual(terminal.details.lines.map((line) => line.text), ["hit one", "hit two"]);
  assert.equal(terminal.content.split("\n")[1], "Matched: hit.");
});

test("zero incremental lines stay legal and never replay retained history", async (t) => {
  let child;
  const harness = createHarness({
    randomHex: () => "66666666",
    spawn() { child = fakeChild(); return child; },
    resolveShell: () => "/bin/bash",
    matcherBatchMs: 2,
  });
  t.after(async () => harness.runtime.shutdown());
  await harness.execute({ action: "create", checkAfter: "10m", abstract: "quiet", command: "unused", notifyOn: ["hit"] });
  child.stdout.write("hit now\n");
  await wait(5);
  assert.equal(harness.messages.length, 1);
  closeChild(child, 0, null);
  await wait();
  const terminal = harness.messages[1].message;
  assert.deepEqual(terminal.details.lines, []);
  assert.equal(terminal.details.omitted, 0);
  assert.equal(terminal.details.truncated, false);
  assert.deepEqual(terminal.content.split("\n"), [
    "Monitor 66666666 (quiet) status completed.",
    "Exit code: 0; signal: null; error: null.",
  ]);
  const state = (await harness.execute({ action: "status", id: "66666666" })).details.monitor;
  assert.deepEqual(state.combined.map((line) => line.text), ["hit now"], "retained history stays reachable through monitor status");
});

test("a matcher batch carries one entry per matching line and leaves ordinary lines to monitor status", async (t) => {
  let child;
  const harness = createHarness({
    randomHex: () => "67676767",
    spawn() { child = fakeChild(); return child; },
    resolveShell: () => "/bin/bash",
    matcherBatchMs: 2,
  });
  t.after(async () => harness.runtime.shutdown());
  await harness.execute({ action: "create", checkAfter: "10m", abstract: "filtered", command: "unused", notifyOn: ["hit", "also"] });
  child.stdout.write("noise one\nhit and also\nnoise two\nnoise three\n");
  await wait(5);
  assert.equal(harness.messages.length, 1);
  const matcher = harness.messages[0].message;
  assert.deepEqual(matcher.details.lines.map((line) => line.text), ["hit and also"], "one line matching two literals is delivered once");
  assert.deepEqual([...matcher.details.matched].sort(), ["also", "hit"], "details.matched keeps every literal that hit");
  assert.equal(matcher.details.omitted, 0);
  assert.equal(matcher.details.truncated, false);
  assert.deepEqual(matcher.content.split("\n").filter((line) => line.startsWith("[")), ["[stdout] hit and also"]);

  const state = (await harness.execute({ action: "status", id: "67676767" })).details.monitor;
  assert.deepEqual(state.combined.map((line) => line.text), ["noise one", "hit and also", "noise two", "noise three"]);
  assert.equal(state.matchedCount, 2, "matchedCount still counts every literal hit");
  closeChild(child);
});

test("more matched lines than the notification cap report an accurate omitted count of matches only", async (t) => {
  let child;
  const harness = createHarness({
    randomHex: () => "68686868",
    spawn() { child = fakeChild(); return child; },
    resolveShell: () => "/bin/bash",
    matcherBatchMs: 5,
  });
  t.after(async () => harness.runtime.shutdown());
  await harness.execute({ action: "create", checkAfter: "10m", abstract: "capped", command: "unused", notifyOn: ["MATCH"] });
  for (let index = 0; index < 130; index += 1) child.stdout.write(`noise-${index}\nMATCH-${index}\n`);
  await wait(15);
  const matcher = harness.messages[0].message.details;
  assert.equal(matcher.lines.length, 100);
  assert.equal(matcher.omitted, 30, "omitted counts only the matched lines that did not fit");
  assert.equal(matcher.truncated, true);
  assert.equal(matcher.lines.every((line) => line.text.startsWith("MATCH-")), true);
  assert.deepEqual(matcher.lines.at(0).text, "MATCH-30");
  assert.deepEqual(matcher.lines.at(-1).text, "MATCH-129");
  closeChild(child);
});

test("a rate-limited summary counts suppressed matched lines instead of all suppressed output", async (t) => {
  let now = 1_000;
  const children = [];
  const messages = [];
  const tools = new Map();
  const runtime = new MonitorRuntime({
    registerTool(tool) { tools.set(tool.name, tool); },
    registerMessageRenderer() {},
    sendMessage(message, options) { messages.push({ message, options }); },
  }, {
    nowMs: () => now,
    randomHex: (() => { let id = 70; return () => String(id++).padStart(8, "0"); })(),
    spawn() { const child = fakeChild(28000 + children.length); children.push(child); return child; },
    resolveShell: () => "/bin/bash",
    matcherBatchMs: 2,
    rateLimitCount: 1,
    rateLimitWindowMs: 20,
  });
  runtime.registerTool();
  const execute = (params) => tools.get("monitor").execute("call", params, undefined, undefined, { cwd: process.cwd() });
  t.after(async () => { children.forEach((child) => { if (child.listenerCount("close")) closeChild(child); }); await runtime.shutdown(); });
  await execute({ action: "create", checkAfter: "10m", abstract: "window owner", command: "unused", notifyOn: ["hit"] });
  const suppressed = await execute({ action: "create", checkAfter: "10m", abstract: "suppressed", command: "unused", notifyOn: ["hit"] });
  children[0].stdout.write("hit owner\n");
  await wait(5);
  assert.equal(messages.length, 1, "the first batch consumes the whole rate window");
  children[1].stdout.write("noise\nhit one\nnoise\nhit two\nnoise\nhit three\nnoise\n");
  await wait(5);
  assert.equal(messages.length, 1);
  now += 25;
  await wait(25);
  const summary = messages.at(-1).message.details;
  assert.equal(summary.kind, "summary");
  assert.deepEqual(summary.monitors.map((monitor) => monitor.id), [suppressed.details.monitor.id]);
  assert.equal(summary.monitors[0].suppressedBatches, 1);
  assert.equal(summary.monitors[0].suppressedLines, 3, "suppressedLines counts matched lines, not ordinary output");
});

test("a completed close stays status-only while a failed close adds a bounded diagnostic tail", async (t) => {
  let completedChild;
  const completed = createHarness({
    randomHex: () => "71717171",
    spawn() { completedChild = fakeChild(); return completedChild; },
    resolveShell: () => "/bin/bash",
    matcherBatchMs: 2,
  });
  t.after(async () => completed.runtime.shutdown());
  await completed.execute({ action: "create", checkAfter: "10m", abstract: "clean exit", command: "unused" });
  for (let index = 0; index < 30; index += 1) completedChild.stdout.write(`noise-${index}\n`);
  closeChild(completedChild, 0, null);
  await wait();
  assert.equal(completed.messages.length, 1);
  const completedTerminal = completed.messages[0].message;
  assert.deepEqual(completedTerminal.details.lines, [], "an empty notifyOn leaves a completed close with no lines at all");
  assert.deepEqual(completedTerminal.details.matched, [], "a close without pending matches names no literal");
  assert.doesNotMatch(completedTerminal.content, /Matched:/);
  assert.equal(completedTerminal.details.omitted, 0);
  assert.equal(completedTerminal.details.truncated, false);
  assert.deepEqual(completedTerminal.content.split("\n"), [
    "Monitor 71717171 (clean exit) status completed.",
    "Exit code: 0; signal: null; error: null.",
  ]);
  const completedState = (await completed.execute({ action: "status", id: "71717171", start: 0, end: 100 })).details.monitor;
  assert.equal(completedState.combined.length, 30, "monitor status still returns the whole retained log");

  let failedChild;
  const failed = createHarness({
    randomHex: () => "72727272",
    spawn() { failedChild = fakeChild(); return failedChild; },
    resolveShell: () => "/bin/bash",
    matcherBatchMs: 2,
  });
  t.after(async () => failed.runtime.shutdown());
  await failed.execute({ action: "create", checkAfter: "10m", abstract: "bad exit", command: "unused" });
  for (let index = 0; index < 30; index += 1) failedChild.stdout.write(`noise-${index}\n`);
  closeChild(failedChild, 1, null);
  await wait();
  const failedTerminal = failed.messages[0].message.details;
  assert.equal(failedTerminal.status, "failed");
  assert.equal(failedTerminal.lines.length, 20, "a failure carries the last twenty ordinary lines as diagnostics");
  assert.deepEqual(failedTerminal.lines.at(0).text, "noise-10");
  assert.deepEqual(failedTerminal.lines.at(-1).text, "noise-29");
  assert.equal(failedTerminal.omitted, 10, "omitted stays honest about every new line left behind");
  assert.equal(failedTerminal.truncated, true);
  assert.deepEqual(failedTerminal.matched, [], "a diagnostic tail without pending matches names no literal");
  assert.doesNotMatch(failed.messages[0].message.content, /Matched:/);

  let killedChild;
  const killed = createHarness({
    randomHex: () => "73737373",
    spawn() { killedChild = fakeChild(); return killedChild; },
    resolveShell: () => "/bin/bash",
    matcherBatchMs: 2,
  });
  t.after(async () => killed.runtime.shutdown());
  await killed.execute({ action: "create", checkAfter: "10m", abstract: "signalled", command: "unused" });
  for (let index = 0; index < 5; index += 1) killedChild.stdout.write(`noise-${index}\n`);
  closeChild(killedChild, null, "SIGTERM");
  await wait();
  const killedTerminal = killed.messages[0].message.details;
  assert.equal(killedTerminal.status, "killed");
  assert.equal(killedTerminal.signal, "SIGTERM");
  assert.deepEqual(killedTerminal.lines.map((line) => line.text), ["noise-0", "noise-1", "noise-2", "noise-3", "noise-4"]);
  assert.equal(killedTerminal.omitted, 0);
});

test("a failed close merges pending matches outside the tail with the tail itself by sequence", async (t) => {
  let child;
  const harness = createHarness({
    randomHex: () => "74747474",
    spawn() { child = fakeChild(); return child; },
    resolveShell: () => "/bin/bash",
    matcherBatchMs: 5_000,
  });
  t.after(async () => harness.runtime.shutdown());
  await harness.execute({ action: "create", checkAfter: "10m", abstract: "merge", command: "unused", notifyOn: ["hit"] });
  child.stdout.write("hit early\n");
  for (let index = 0; index < 24; index += 1) child.stdout.write(`noise-${index}\n`);
  child.stdout.write("hit late\n");
  await wait(5);
  assert.equal(harness.messages.length, 0, "the matcher batch window has not elapsed yet");
  closeChild(child, 2, null);
  await wait();
  assert.equal(harness.messages.length, 1, "a pending matcher batch is delivered exactly once through the terminal update");
  const terminal = harness.messages[0].message.details;
  assert.equal(terminal.status, "failed");
  assert.deepEqual(terminal.matched, ["hit"], "the merged failure payload names the literals its pending matches hit");
  assert.equal(harness.messages[0].message.content.split("\n")[1], "Matched: hit.");
  const seqs = terminal.lines.map((line) => line.seq);
  assert.deepEqual(seqs, [...seqs].sort((left, right) => left - right), "merged lines stay ordered by sequence");
  assert.equal(new Set(seqs).size, seqs.length, "a match inside the tail window is never duplicated");
  assert.deepEqual(seqs, [1, ...Array.from({ length: 20 }, (_, index) => index + 7)]);
  assert.equal(terminal.lines.at(0).text, "hit early", "a pending match older than the tail is still delivered");
  assert.equal(terminal.lines.at(-1).text, "hit late");
  assert.equal(terminal.omitted, 5, "omitted counts every new line the merged payload left behind");
  assert.equal(terminal.truncated, true);
  const state = (await harness.execute({ action: "status", id: "74747474", start: 0, end: 100 })).details.monitor;
  assert.equal(state.combined.length, 26, "monitor status stays the full log boundary");
});

test("matches already delivered by a matcher batch never repeat in a later failed close", async (t) => {
  let child;
  const harness = createHarness({
    randomHex: () => "75757575",
    spawn() { child = fakeChild(); return child; },
    resolveShell: () => "/bin/bash",
    matcherBatchMs: 2,
  });
  t.after(async () => harness.runtime.shutdown());
  await harness.execute({ action: "create", checkAfter: "10m", abstract: "no replay", command: "unused", notifyOn: ["hit"] });
  child.stdout.write("noise one\nhit one\n");
  await wait(5);
  child.stdout.write("noise two\nhit two\n");
  await wait(5);
  assert.equal(harness.messages.length, 2);
  assert.deepEqual(harness.messages[0].message.details.lines.map((line) => line.text), ["hit one"]);
  assert.deepEqual(harness.messages[1].message.details.lines.map((line) => line.text), ["hit two"], "a second batch never resends the first match");
  closeChild(child, 1, null);
  await wait();
  const terminal = harness.messages.at(-1).message.details;
  assert.equal(terminal.status, "failed");
  assert.deepEqual(terminal.lines, [], "a failure after a matcher batch replays neither delivered matches nor older ordinary lines");
  assert.deepEqual(terminal.matched, [], "literals already reported by a delivered batch never repeat");
  assert.doesNotMatch(harness.messages.at(-1).message.content, /Matched:/);
  assert.equal(terminal.omitted, 0);
  assert.equal(terminal.truncated, false);
});

test("small injected log cap rolls from complete line boundaries with a marker and counters", async (t) => {
  let child;
  const harness = createHarness({
    randomHex: () => "55555555",
    spawn() { child = fakeChild(); return child; },
    resolveShell: () => "/bin/bash",
    logCapBytes: 900,
    logRetainBytes: 350,
    matcherBatchMs: 2,
  });
  t.after(async () => harness.runtime.shutdown());
  await harness.execute({ action: "create", checkAfter: "10m", abstract: "roll", command: "unused", notifyOn: ["line-29"] });
  for (let index = 0; index < 30; index += 1) child.stdout.write(`line-${index}-${"x".repeat(40)}\n`);
  const status = (await harness.execute({ action: "status", id: "55555555", start: 0, end: 100 })).details.monitor;
  assert.ok(status.logBytes <= 900);
  assert.ok(status.droppedBytes > 0);
  assert.ok(status.droppedLines > 0);
  assert.match(status.combined[0].text, /monitor log rollover/);
  assert.match(status.combined.at(-1).text, /line-29/);
  await wait(5);
  const matcher = harness.messages[0].message.details;
  assert.equal(matcher.omitted, 0, "rollover markers do not count as new notification lines");
  assert.equal(matcher.lines.some((line) => /rollover/.test(line.text)), false);
  assert.deepEqual(matcher.lines.map((line) => line.seq), [30], "only the matching line survives into the batch");
  closeChild(child);
});

test("write, rename, and rollover reopen failures stay inside stream listeners and degrade logging safely", async (t) => {
  const cases = ["write", "rename", "reopen"];
  for (const mode of cases) {
    let child;
    let initialPath;
    let renamed = false;
    let dataWrites = 0;
    const harness = createHarness({
      randomHex: () => mode === "write" ? "51515151" : mode === "rename" ? "52525252" : "53535353",
      spawn() { child = fakeChild(); return child; },
      resolveShell: () => "/bin/bash",
      logCapBytes: 900,
      logRetainBytes: 350,
      fs: {
        openSync(path, flags, permissions) {
          if (!initialPath && String(path).endsWith(".jsonl")) initialPath = path;
          if (mode === "reopen" && renamed && path === initialPath && flags === (fsConstants.O_RDWR | fsConstants.O_APPEND)) {
            throw new Error("reopen failed");
          }
          return nativeOpenSync(path, flags, permissions);
        },
        writeSync(fd, buffer, offset, length, position) {
          if (mode === "write" && ++dataWrites === 1) throw new Error("write failed");
          return nativeWriteSync(fd, buffer, offset, length, position);
        },
        renameSync(oldPath, newPath) {
          if (mode === "rename") throw new Error("rename failed");
          nativeRenameSync(oldPath, newPath);
          renamed = true;
        },
      },
    });
    t.after(async () => harness.runtime.shutdown());
    const id = mode === "write" ? "51515151" : mode === "rename" ? "52525252" : "53535353";
    await harness.execute({ action: "create", checkAfter: "10m", abstract: mode, command: "unused" });
    for (let index = 0; index < 30; index += 1) child.stdout.write(`${mode}-${index}-${"x".repeat(40)}\n`);
    const status = (await harness.execute({ action: "status", id })).details.monitor;
    assert.match(status.error, /log (write|rollover)/);
    assert.ok(status.droppedLines > 0);
    assert.equal(harness.runtime.hasRunning(), true, `${mode} failure must not crash or synchronously terminate Pi`);
    closeChild(child);
  }
});

test("deleting one monitor rebuilds a gated global rate summary for the remaining monitors", async (t) => {
  const children = [];
  const harness = createHarness({
    randomHex: (() => { const ids = ["54545454", "55545454"]; return () => ids.shift(); })(),
    spawn() { const child = fakeChild(54000 + children.length); children.push(child); return child; },
    resolveShell: () => "/bin/bash",
    matcherBatchMs: 1,
    rateLimitCount: 0,
    rateLimitWindowMs: 5,
  });
  t.after(async () => harness.runtime.shutdown());
  harness.runtime.setDeliveryPaused(true);
  await harness.execute({ action: "create", checkAfter: "10m", abstract: "remove me", command: "unused", notifyOn: ["hit"] });
  await harness.execute({ action: "create", checkAfter: "10m", abstract: "keep me", command: "unused", notifyOn: ["hit"] });
  children[0].stdout.write("hit first\n");
  children[1].stdout.write("hit second\n");
  await wait(12);
  closeChild(children[0]);
  await wait();
  await harness.execute({ action: "delete", id: "54545454" });
  harness.runtime.setDeliveryPaused(false);
  assert.equal(harness.messages.length, 1);
  const summary = harness.messages[0].message;
  assert.equal(summary.details.kind, "summary");
  assert.deepEqual(summary.details.monitors.map((item) => item.id), ["55545454"]);
  assert.match(summary.content, /keep me/);
  assert.doesNotMatch(summary.content, /remove me/);
  closeChild(children[1]);
});

test("shutdown waits for an owned stop before scanning and never sends duplicate TERM or KILL", async () => {
  let child;
  const signals = [];
  const sleepers = [];
  const harness = createHarness({
    randomHex: () => "59595959",
    spawn() { child = fakeChild(59000); return child; },
    resolveShell: () => "/bin/bash",
    sleep() { return new Promise((resolve) => sleepers.push(resolve)); },
    killGroup(pid, signal) {
      signals.push([pid, signal]);
      if (signal === "SIGKILL") closeChild(child, null, "SIGKILL");
    },
  });
  await harness.execute({ action: "create", checkAfter: "10m", abstract: "concurrent", command: "unused" });
  const stopping = harness.execute({ action: "stop", id: "59595959" });
  await wait();
  assert.deepEqual(signals, [[59000, "SIGTERM"]]);
  const shutdown = harness.runtime.shutdown();
  await wait();
  assert.deepEqual(signals, [[59000, "SIGTERM"]], "shutdown waits instead of signaling a stop-owned process");
  sleepers.shift()();
  const stopped = await stopping;
  await shutdown;
  assert.equal(stopped.details.outcome, "stopped");
  assert.deepEqual(signals, [[59000, "SIGTERM"], [59000, 0], [59000, "SIGKILL"]]);
  assert.deepEqual(harness.runtime.list(), []);
});

test("shutdown invalidates first, signals all groups in parallel, kills survivors, clears blockers and log root, and is idempotent", async () => {
  const children = [];
  const signals = [];
  const harness = createHarness({
    randomHex: (() => { let id = 60; return () => String(id++).padStart(8, "0"); })(),
    spawn() { const child = fakeChild(50000 + children.length); children.push(child); return child; },
    resolveShell: () => "/bin/bash",
    shutdownGraceMs: 1,
    sleep: async () => {},
    killGroup(pid, signal) {
      signals.push([pid, signal]);
      if (signal === "SIGKILL") {
        const child = children.find((candidate) => candidate.pid === pid);
        closeChild(child, null, "SIGKILL");
      }
    },
  });
  const first = await harness.execute({ action: "create", checkAfter: "10m", abstract: "one", command: "unused" });
  const second = await harness.execute({ action: "create", checkAfter: "10m", abstract: "two", command: "unused" });
  const root = dirname(first.details.monitor.logPath);
  assert.equal(dirname(second.details.monitor.logPath), root);
  await harness.runtime.shutdown();
  assert.deepEqual(signals, [
    [50000, "SIGTERM"], [50001, "SIGTERM"],
    [50000, 0], [50001, 0],
    [50000, "SIGKILL"], [50001, "SIGKILL"],
  ]);
  assert.deepEqual(harness.runtime.list(), []);
  assert.equal(harness.runtime.hasBlockingWork(), false);
  assert.equal(existsSync(root), false);
  await harness.runtime.shutdown();
});

test("partial-line truncation reports dropped UTF-8 bytes", async (t) => {
  let child;
  const harness = createHarness({
    randomHex: () => "56565656",
    partialLineMaxBytes: 6,
    spawn() { child = fakeChild(); return child; },
    resolveShell: () => "/bin/bash",
  });
  t.after(async () => harness.runtime.shutdown());
  await harness.execute({ action: "create", checkAfter: "10m", abstract: "bytes", command: "unused" });
  child.stdout.write("☃☃☃");
  closeChild(child);
  await wait();
  const status = (await harness.execute({ action: "status", id: "56565656" })).details.monitor;
  assert.equal(status.combined[0].text, "☃☃ … [truncated 3 bytes]");
});

test("real detached descendant holding a pipe cannot block sequential stop", async (t) => {
  const harness = createHarness({
    randomHex: () => "57575757",
    deleteGraceMs: 40,
    finalKillWaitMs: 40,
  });
  let descendantPid;
  t.after(async () => {
    if (descendantPid) {
      try { process.kill(descendantPid, "SIGKILL"); } catch { /* already gone */ }
    }
    await harness.runtime.shutdown();
  });
  const script = "const {spawn}=require('node:child_process');const c=spawn('/bin/sleep',['30'],{detached:true,stdio:['ignore',1,2]});console.log(c.pid);c.unref();";
  await harness.execute({
    action: "create",
    checkAfter: "10m",
    abstract: "held descendant pipe",
    command: `${shellQuote(process.execPath)} -e ${shellQuote(script)}`,
  });
  for (let index = 0; index < 100; index += 1) {
    const status = (await harness.execute({ action: "status", id: "57575757" })).details.monitor;
    const pidLine = status.combined.find((line) => /^\d+$/.test(line.text));
    if (pidLine) { descendantPid = Number(pidLine.text); break; }
    await wait(5);
  }
  assert.ok(Number.isInteger(descendantPid));
  const started = Date.now();
  const stopped = await harness.execute({ action: "stop", id: "57575757" });
  assert.ok(Date.now() - started < 1000);
  assert.equal(stopped.details.outcome, "unconfirmed");
  assert.match(stopped.details.warning, /detached descendant may remain/i);
  await harness.execute({ action: "delete", id: "57575757" });
  try { process.kill(descendantPid, "SIGKILL"); } catch { /* already gone */ }
  descendantPid = undefined;
});

test("a real foreground bash process uses one combined private log and reaches completed", async (t) => {
  const harness = createHarness({ randomHex: () => "77777777" });
  t.after(async () => harness.runtime.shutdown());
  const created = await harness.execute({
    action: "create",
    checkAfter: "10m",
    abstract: "real",
    command: "printf 'out\\n'; printf 'err\\n' >&2",
  });
  for (let index = 0; index < 100 && harness.runtime.hasRunning(); index += 1) await wait(5);
  const status = (await harness.execute({ action: "status", id: "77777777" })).details.monitor;
  assert.equal(status.status, "completed");
  assert.equal(status.exitCode, 0);
  assert.equal(status.signal, null);
  assert.deepEqual(new Set(status.combined.map((line) => line.stream)), new Set(["stdout", "stderr"]));
  assert.equal((await import("node:fs")).statSync(status.logPath).mode & 0o777, 0o600);
  assert.equal((await import("node:fs")).statSync(dirname(status.logPath)).mode & 0o777, 0o700);
  await harness.execute({ action: "delete", id: created.details.monitor.id });
});

function silenceHarness(options = {}) {
  const { send, ...runtimeOptions } = options;
  const tools = new Map();
  const messages = [];
  const children = [];
  const timers = new Map();
  const created = [];
  const cleared = [];
  const deferred = [];
  let nextTimerId = 1;
  let now = 1_000_000;
  const pi = {
    registerTool(definition) { tools.set(definition.name, definition); },
    registerMessageRenderer() {},
    sendMessage(message, sendOptions) {
      if (send) send(message, sendOptions);
      messages.push({ message, options: sendOptions });
    },
  };
  const runtime = new MonitorRuntime(pi, {
    randomHex: (() => { let id = 1; return () => String(id++).padStart(8, "0"); })(),
    resolveShell: () => "/bin/bash",
    spawn() { const child = fakeChild(70000 + children.length); children.push(child); return child; },
    nowMs: () => now,
    setTimeout(callback, milliseconds) {
      const timer = { id: nextTimerId++, callback, milliseconds, at: now + milliseconds, unrefs: 0, unref() { this.unrefs += 1; } };
      timers.set(timer.id, timer);
      created.push(timer);
      return timer;
    },
    clearTimeout(timer) { cleared.push(timer); timers.delete(timer.id); },
    defer(callback) { deferred.push(callback); },
    ...runtimeOptions,
  });
  runtime.registerTool();
  const ctx = { cwd: process.cwd() };
  const flush = () => { while (deferred.length > 0) deferred.shift()(); };
  const fireOnly = (milliseconds) => {
    now += milliseconds;
    for (const timer of [...timers.values()]) {
      if (timer.at <= now) { timers.delete(timer.id); timer.callback(); }
    }
  };
  return {
    runtime, tools, messages, children, created, cleared, timers, flush, fireOnly,
    nowMs: () => now,
    execute(params) { return tools.get("monitor").execute("call", params, undefined, undefined, ctx); },
    advance(milliseconds) { fireOnly(milliseconds); flush(); },
    pending() { return [...timers.values()]; },
    silences() { return messages.filter((sent) => sent.message.details.kind === "silence"); },
  };
}

test("checkAfter parsing enforces one strict format, inclusive 10s..7d bounds, and canonical units", () => {
  assert.equal(MONITOR_MIN_CHECK_AFTER_MS, 10_000);
  assert.equal(MONITOR_MAX_CHECK_AFTER_MS, 7 * 24 * 60 * 60 * 1_000);

  for (const [input, checkAfter, milliseconds] of [
    ["10s", "10s", 10_000],
    [" 10m ", "10m", 600_000],
    ["60s", "1m", 60_000],
    ["600s", "10m", 600_000],
    ["90s", "90s", 90_000],
    ["120m", "2h", 7_200_000],
    ["1440m", "1d", 86_400_000],
    ["48h", "2d", 172_800_000],
    ["168h", "7d", 604_800_000],
    ["7d", "7d", 604_800_000],
  ]) assert.deepEqual(parseMonitorCheckAfter(input), { checkAfter, milliseconds }, `${input} must canonicalize to ${checkAfter}`);

  for (const input of ["9s", "0d", "8d", "604801s", "10081m", "169h"]) {
    assert.throws(() => parseMonitorCheckAfter(input), /between 10s and 7d inclusive|positive integer and one unit/, `${input} must be rejected`);
  }
  for (const input of ["10", "10x", "10S", "10 s", "1m30s", "1.5m", "-10m", "+10m", "010s", "0s", "1e3s", "", "   ", "10m ago"]) {
    assert.throws(() => parseMonitorCheckAfter(input), /checkAfter must (use one positive integer and one unit|be a non-empty string)/, `${input} must be rejected`);
  }
  for (const input of [600_000, null, undefined, {}, [], true]) {
    assert.throws(() => parseMonitorCheckAfter(input), /checkAfter must be a non-empty string/);
  }

  assert.equal(canonicalizeMonitorCheckAfter(600_000), "10m");
  assert.equal(canonicalizeMonitorCheckAfter(604_800_000), "7d");
  assert.equal(canonicalizeMonitorCheckAfter(10_000), "10s");
  for (const invalid of [0, -1_000, 1.5]) assert.throws(() => canonicalizeMonitorCheckAfter(invalid), /positive safe integer/);
  assert.throws(() => canonicalizeMonitorCheckAfter(1_500), /whole seconds/);
});

test("create requires checkAfter, other actions reject it, and the committed record keeps the canonical value", async (t) => {
  const harness = silenceHarness();
  t.after(async () => harness.runtime.shutdown());

  await assert.rejects(harness.execute({ action: "create", abstract: "a", command: "unused" }), /create requires checkAfter/);
  await assert.rejects(harness.execute({ action: "create", abstract: "a", command: "unused", checkAfter: "5s" }), /between 10s and 7d inclusive/);
  await assert.rejects(harness.execute({ action: "create", abstract: "a", command: "unused", checkAfter: "10 minutes" }), /positive integer and one unit/);
  await assert.rejects(harness.execute({ action: "list", checkAfter: "10m" }), /list does not accept field\(s\): checkAfter/);
  await assert.rejects(harness.execute({ action: "clear", checkAfter: "10m" }), /clear does not accept field\(s\): checkAfter/);
  await assert.rejects(harness.execute({ action: "stop", id: "00000001", checkAfter: "10m" }), /stop does not accept field\(s\): checkAfter/);
  await assert.rejects(harness.execute({ action: "delete", id: "00000001", checkAfter: "10m" }), /delete does not accept field\(s\): checkAfter/);
  await assert.rejects(harness.execute({ action: "status", id: "00000001", checkAfter: "10m" }), /status does not accept field\(s\): checkAfter/);
  assert.deepEqual(harness.runtime.list(), [], "rejected creates leave no retained record");

  const created = await harness.execute({ action: "create", abstract: "canonical", command: "unused", checkAfter: "600s" });
  assert.equal(created.details.monitor.checkAfter, "10m");
  assert.equal(created.details.monitor.lastOutputAt, null);
  assert.equal("silenceReminderCount" in created.details.monitor, false);
  assert.equal("nextCheckAt" in created.details.monitor, false);
  const status = (await harness.execute({ action: "status", id: created.details.monitor.id })).details.monitor;
  assert.equal(status.checkAfter, "10m");
  assert.equal(status.lastOutputAt, null);
  closeChild(harness.children[0]);
  harness.flush();
});

test("a silent monitor reminds once per checkAfter interval with accumulated silence and one unref'd lazy timer", async (t) => {
  const harness = silenceHarness();
  t.after(async () => harness.runtime.shutdown());
  await harness.execute({ action: "create", abstract: "quiet build", command: "unused", checkAfter: "10s" });
  assert.equal(harness.pending().length, 1);
  assert.equal(harness.pending()[0].milliseconds, 10_000);

  harness.advance(9_999);
  assert.equal(harness.silences().length, 0, "the deadline is exclusive of the final millisecond");
  harness.advance(1);
  assert.equal(harness.silences().length, 1);
  const first = harness.silences()[0].message;
  assert.deepEqual(harness.silences()[0].options, { deliverAs: "steer", triggerTurn: true });
  assert.deepEqual(Object.keys(first.details), ["kind", "id", "abstract", "status", "checkAfter", "silentFor", "silentForMs", "lastOutputAt", "deliveryKey"]);
  assert.equal(first.details.kind, "silence");
  assert.equal(first.details.id, "00000001");
  assert.equal(first.details.abstract, "quiet build");
  assert.equal(first.details.status, "running");
  assert.equal(first.details.checkAfter, "10s");
  assert.equal(first.details.silentFor, "10s");
  assert.equal(first.details.silentForMs, 10_000);
  assert.equal(first.details.lastOutputAt, null);
  assert.match(first.content, /Monitor 00000001 \(quiet build\) has produced no stdout or stderr output for 10s\./);
  assert.match(first.content, /Its checkAfter threshold is 10s and it is still running\./);
  assert.match(first.content, /Call monitor status with id 00000001 now to check the current state of this monitor\./);

  assert.equal(ack(harness.runtime, harness.silences()[0]), true);
  harness.advance(10_000);
  assert.equal(harness.silences().length, 2, "an acknowledged reminder allows a fresh reminder next interval");
  const second = harness.silences()[1].message;
  assert.equal(second.details.silentFor, "20s");
  assert.equal(second.details.silentForMs, 20_000);
  assert.notEqual(second.details.deliveryKey, first.details.deliveryKey);

  harness.advance(10_000);
  assert.equal(harness.silences().length, 2, "an unacknowledged reminder never stacks a second delivery");
  harness.runtime.retryQueuedNotificationsAfterAgentSettled();
  assert.equal(harness.silences().length, 3);
  const retried = harness.silences()[2].message;
  assert.equal(retried.details.deliveryKey, second.details.deliveryKey, "the in-place update keeps one delivery key");
  assert.equal(retried.details.silentFor, "30s");
  assert.equal(retried.details.silentForMs, 30_000);

  const status = (await harness.execute({ action: "status", id: "00000001" })).details.monitor;
  assert.equal(status.notificationCount, 2, "a safely retried reminder still counts once");
  assert.equal(status.matchedCount, 0);
  assert.ok(harness.created.every((timer) => timer.unrefs >= 1), "every silence timer is unref'd");
  closeChild(harness.children[0]);
  harness.flush();
});

test("readable silence durations round down to whole seconds across units", async (t) => {
  const harness = silenceHarness();
  t.after(async () => harness.runtime.shutdown());
  await harness.execute({ action: "create", abstract: "long quiet", command: "unused", checkAfter: "1h" });
  harness.advance(3_600_000);
  assert.equal(harness.silences()[0].message.details.silentFor, "1h");
  assert.equal(ack(harness.runtime, harness.silences()[0]), true);
  harness.advance(3_600_000 + 900);
  const second = harness.silences()[1].message.details;
  assert.equal(second.silentFor, "2h");
  assert.equal(second.silentForMs, 7_200_000, "sub-second remainders are dropped");
  assert.equal(ack(harness.runtime, harness.silences()[1]), true);
  harness.advance(3_600_000 + 61_100);
  assert.equal(harness.silences()[2].message.details.silentFor, "3h 1m 2s");
  closeChild(harness.children[0]);
  harness.flush();
});

test("raw output chunks reset silence lazily without clearing or replacing the pending timer", async (t) => {
  const harness = silenceHarness();
  t.after(async () => harness.runtime.shutdown());
  await harness.execute({ action: "create", abstract: "chatty", command: "unused", checkAfter: "10s" });
  const timer = harness.pending()[0];
  const clearedBefore = harness.cleared.length;

  harness.advance(4_000);
  harness.children[0].stdout.write("partial without newline");
  await wait();
  assert.deepEqual(harness.pending(), [timer], "the output hot path never re-arms the timer");
  assert.equal(harness.cleared.length, clearedBefore, "the output hot path never clears the timer");

  harness.advance(6_000);
  assert.equal(harness.silences().length, 0, "the expired timer re-arms for the remaining silence instead of firing");
  assert.equal(harness.pending().length, 1);
  assert.equal(harness.pending()[0].milliseconds, 4_000);

  harness.advance(4_000);
  assert.equal(harness.silences().length, 1);
  assert.equal(harness.silences()[0].message.details.silentFor, "10s");
  assert.equal(harness.silences()[0].message.details.lastOutputAt, new Date(1_004_000).toISOString());
  const status = (await harness.execute({ action: "status", id: "00000001" })).details.monitor;
  assert.equal(status.lastOutputAt, new Date(1_004_000).toISOString());
  closeChild(harness.children[0]);
  harness.flush();
});

test("split UTF-8, pure ANSI, and newline-free chunks all count as activity while EOF flush does not", async (t) => {
  const snowman = Buffer.from("☃");
  const cases = [
    ["split utf-8 lead", () => snowman.subarray(0, 2)],
    ["split utf-8 tail", () => snowman.subarray(2)],
    ["pure ansi", () => Buffer.from("\u001b[31m")],
    ["no newline", () => Buffer.from("still working")],
  ];
  for (const [label, chunk] of cases) {
    const harness = silenceHarness();
    t.after(async () => harness.runtime.shutdown());
    await harness.execute({ action: "create", abstract: label, command: "unused", checkAfter: "10s" });
    harness.advance(6_000);
    harness.children[0].stdout.write(chunk());
    await wait();
    harness.advance(6_000);
    assert.equal(harness.silences().length, 0, `${label} must reset the silence anchor`);
    harness.advance(4_000);
    assert.equal(harness.silences().length, 1, `${label} reminds one full interval after the raw chunk`);
    assert.equal(harness.silences()[0].message.details.silentFor, "10s");

    closeChild(harness.children[0]);
    await wait();
    harness.flush();
    assert.equal(harness.silences().length, 1, "the EOF flush is not new output and creates no reminder");
    assert.equal(harness.pending().length, 0, "a terminal monitor keeps no silence timer");
  }
});

test("a gated or failing delivery keeps exactly one silence reminder that updates in place", async (t) => {
  const gated = silenceHarness();
  t.after(async () => gated.runtime.shutdown());
  gated.runtime.setDeliveryPaused(true);
  await gated.execute({ action: "create", abstract: "gated", command: "unused", checkAfter: "10s" });
  gated.advance(10_000);
  gated.advance(10_000);
  gated.advance(10_000);
  assert.equal(gated.messages.length, 0);
  gated.runtime.setDeliveryPaused(false);
  assert.equal(gated.silences().length, 1, "three gated intervals merge into one reminder");
  assert.equal(gated.silences()[0].message.details.silentFor, "30s");
  assert.equal((await gated.execute({ action: "status", id: "00000001" })).details.monitor.notificationCount, 1);
  closeChild(gated.children[0]);
  gated.flush();

  let attempts = 0;
  const failing = silenceHarness({
    send() { attempts += 1; if (attempts === 1) throw new Error("queue busy"); },
  });
  t.after(async () => failing.runtime.shutdown());
  await failing.execute({ action: "create", abstract: "retry", command: "unused", checkAfter: "10s" });
  failing.advance(10_000);
  assert.equal(attempts, 1);
  assert.equal(failing.messages.length, 0);
  failing.advance(10_000);
  assert.equal(attempts, 2, "a failed send stays retryable and never duplicates the queue entry");
  assert.equal(failing.silences().length, 1);
  assert.equal(failing.silences()[0].message.details.silentFor, "20s");
  failing.runtime.retryQueuedNotificationsAfterAgentSettled();
  assert.equal(failing.silences().length, 2);
  assert.equal((await failing.execute({ action: "status", id: "00000001" })).details.monitor.notificationCount, 1, "one logical reminder counts once");
  closeChild(failing.children[0]);
  failing.flush();
});

test("recovered output retires a queued or in-flight reminder so agent-settled retry never replays it", async (t) => {
  const gated = silenceHarness();
  t.after(async () => gated.runtime.shutdown());
  gated.runtime.setDeliveryPaused(true);
  await gated.execute({ action: "create", abstract: "recovers gated", command: "unused", checkAfter: "10s" });
  gated.advance(10_000);
  gated.children[0].stdout.write("back to work\n");
  await wait();
  gated.runtime.setDeliveryPaused(false);
  assert.equal(gated.messages.length, 0, "output deletes the still-gated reminder");
  closeChild(gated.children[0]);
  await wait();
  gated.flush();
  assert.equal(gated.silences().length, 0);

  const inFlight = silenceHarness();
  t.after(async () => inFlight.runtime.shutdown());
  await inFlight.execute({ action: "create", abstract: "recovers live", command: "unused", checkAfter: "10s" });
  inFlight.advance(10_000);
  assert.equal(inFlight.silences().length, 1);
  inFlight.children[0].stdout.write("back to work\n");
  await wait();
  inFlight.runtime.retryQueuedNotificationsAfterAgentSettled();
  assert.equal(inFlight.silences().length, 1, "a delivered but unacknowledged reminder is not replayed once output returns");
  inFlight.advance(10_000);
  assert.equal(inFlight.silences().length, 2, "silence after recovery starts a fresh reminder");
  assert.equal(inFlight.silences()[1].message.details.silentFor, "10s");
  assert.notEqual(inFlight.silences()[1].message.details.deliveryKey, inFlight.silences()[0].message.details.deliveryKey);
  closeChild(inFlight.children[0]);
  inFlight.flush();
});

test("silence reminders never move the incremental position or consume the matcher rate window", async (t) => {
  const harness = silenceHarness({ matcherBatchMs: 5_000, rateLimitCount: 1, rateLimitWindowMs: 600_000 });
  t.after(async () => harness.runtime.shutdown());
  await harness.execute({ action: "create", abstract: "cursor", command: "unused", checkAfter: "10s", notifyOn: ["hit"] });
  harness.children[0].stdout.write("first line\n");
  await wait();
  harness.advance(10_000);
  assert.equal(ack(harness.runtime, harness.silences()[0]), true);
  harness.advance(10_000);
  assert.equal(harness.silences().length, 2);
  assert.equal(harness.messages.every((sent) => sent.message.details.kind === "silence"), true);

  harness.children[0].stdout.write("hit line\n");
  await wait();
  harness.advance(5_000);
  const matcher = harness.messages.find((sent) => sent.message.details.kind === "update");
  assert.deepEqual(matcher.message.details.lines.map((line) => line.text), ["hit line"], "reminders never advance the delivered position");
  assert.deepEqual(matcher.message.details.matched, ["hit"], "reminders never consume the matcher rate-limit window");

  closeChild(harness.children[0]);
  await wait();
  harness.flush();
  const terminal = harness.messages.at(-1).message;
  assert.equal(terminal.details.kind, "update");
  assert.equal(terminal.details.status, "completed");
});

test("terminal, delete, and shutdown clear the silence timer, drop the reminder, and ignore stale callbacks", async (t) => {
  const terminal = silenceHarness();
  t.after(async () => terminal.runtime.shutdown());
  terminal.runtime.setDeliveryPaused(true);
  await terminal.execute({ action: "create", abstract: "closes", command: "unused", checkAfter: "10s" });
  terminal.advance(10_000);
  closeChild(terminal.children[0]);
  await wait();
  terminal.flush();
  assert.equal(terminal.pending().length, 0, "a terminal monitor keeps no silence timer");
  terminal.runtime.setDeliveryPaused(false);
  assert.equal(terminal.silences().length, 0, "the terminal update supersedes the queued reminder");
  assert.equal(terminal.messages.length, 1);
  assert.equal(terminal.messages[0].message.details.kind, "update");
  assert.equal(terminal.runtime.hasBlockingWork(), true, "only the terminal delivery blocks completion");
  assert.equal(ack(terminal.runtime, terminal.messages[0]), true);
  assert.equal(terminal.runtime.hasBlockingWork(), false, "silence reminders never add blocking work of their own");

  const removed = silenceHarness({ deleteGraceMs: 1, finalKillWaitMs: 1, sleep: async () => {}, killGroup() {} });
  t.after(async () => removed.runtime.shutdown());
  removed.runtime.setDeliveryPaused(true);
  await removed.execute({ action: "create", abstract: "deletes", command: "unused", checkAfter: "10s" });
  removed.advance(10_000);
  await removed.execute({ action: "stop", id: "00000001" });
  await removed.execute({ action: "delete", id: "00000001" });
  removed.runtime.setDeliveryPaused(false);
  assert.equal(removed.messages.length, 0);
  assert.equal(removed.pending().length, 0);
  assert.equal(removed.runtime.hasBlockingWork(), false);

  const stopped = silenceHarness({ shutdownGraceMs: 1, sleep: async () => {}, killGroup() {} });
  await stopped.execute({ action: "create", abstract: "shuts down", command: "unused", checkAfter: "10s" });
  stopped.fireOnly(10_000);
  await stopped.runtime.shutdown();
  assert.equal(stopped.pending().length, 0, "shutdown clears every pending silence timer");
  stopped.flush();
  assert.equal(stopped.silences().length, 0, "a deferred callback that survives shutdown stays inert");

  const reused = silenceHarness({ randomHex: () => "0000beef", deleteGraceMs: 1, finalKillWaitMs: 1, sleep: async () => {}, killGroup() {} });
  t.after(async () => reused.runtime.shutdown());
  await reused.execute({ action: "create", abstract: "first owner", command: "unused", checkAfter: "10s" });
  reused.fireOnly(10_000);
  await reused.execute({ action: "stop", id: "0000beef" });
  await reused.execute({ action: "delete", id: "0000beef" });
  await reused.execute({ action: "create", abstract: "second owner", command: "unused", checkAfter: "10s" });
  reused.flush();
  assert.equal(reused.silences().length, 0, "a stale callback never revives against a reused monitor ID");
  reused.advance(10_000);
  assert.equal(reused.silences().length, 1);
  assert.equal(reused.silences()[0].message.details.abstract, "second owner");
  closeChild(reused.children[1]);
  reused.flush();
});
