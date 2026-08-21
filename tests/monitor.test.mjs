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
import test from "node:test";

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
  assert.equal(tool.description, "Run and manage long-running foreground Bash commands on POSIX systems while Pi remains available. Each monitor owns the command's foreground process group. Matcher and terminal notifications carry the current status and only the output added since the previous notification. A silence reminder arrives whenever a running command produces no output for its `checkAfter` threshold. Summary notifications report rate-limited matcher batches. `notifyOn` performs case-sensitive literal matching. `monitor list` returns compact retained records. `monitor status` returns one record's full retained state and combined logs. `monitor delete` stops a running group when needed and removes its retained record. Terminal records remain available until deletion. Runtime shutdown terminates active groups and clears retained monitor data.");
  assert.equal(tool.promptSnippet, "Supervise long-running foreground commands.");
  assert.deepEqual(tool.promptGuidelines, [
    "Never detach a `monitor create` command with nohup, setsid, disown, trailing &, or another daemon escape.",
    "Do not poll a running monitor with repeated `monitor status` calls.",
    "`monitor list` summarizes records, notifications carry current status and incremental output, and `monitor status` returns full retained state and logs.",
  ]);
  assert.equal(schema.properties.action.description, "Choose an action. create requires abstract, command, and checkAfter, with optional cwd and notifyOn. delete requires id. status requires id, with optional start and end. list accepts no other fields.");
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
  assert.match(harness.messages[0].message.content, /one/);
  assert.match(harness.messages[0].message.content, /four/);
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

test("active delete sends TERM then KILL to the process group, confirms close, removes logs, and sends no terminal notification", async (t) => {
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
  const created = await harness.execute({ action: "create", checkAfter: "10m", abstract: "delete", command: "unused" });
  const deleted = await harness.execute({ action: "delete", id: "44444444" });
  assert.deepEqual(signals, [[44444, "SIGTERM"], [44444, 0], [44444, "SIGKILL"]]);
  assert.equal(deleted.details.deleted, true);
  assert.equal(harness.messages.length, 0);
  assert.equal(existsSync(created.details.monitor.logPath), false);
});

test("delete bounds the post-KILL wait, resolves once, destroys held pipes, and returns a detached-descendant warning", async (t) => {
  let child;
  const signals = [];
  const harness = createHarness({
    randomHex: () => "45454545",
    spawn() { child = fakeChild(45454); return child; },
    resolveShell: () => "/bin/bash",
    deleteGraceMs: 1,
    finalKillWaitMs: 1,
    sleep: async () => {},
    killGroup(pid, signal) { signals.push([pid, signal]); },
  });
  t.after(async () => harness.runtime.shutdown());
  const created = await harness.execute({ action: "create", checkAfter: "10m", abstract: "held pipe", command: "unused" });
  const deleted = await harness.execute({ action: "delete", id: "45454545" });
  assert.deepEqual(signals, [[45454, "SIGTERM"], [45454, 0], [45454, "SIGKILL"]]);
  assert.equal(deleted.details.forced, true);
  assert.match(deleted.details.warning, /detached descendant may remain/i);
  assert.equal(child.stdout.destroyed, true);
  assert.equal(child.stderr.destroyed, true);
  assert.deepEqual(harness.runtime.list(), []);
  assert.equal(existsSync(created.details.monitor.logPath), false);
});

test("delete and shutdown isolate EPERM or unknown process-group errors and always clear runtime state", async () => {
  const deleteHarness = createHarness({
    randomHex: () => "46464646",
    spawn() { return fakeChild(46464); },
    resolveShell: () => "/bin/bash",
    deleteGraceMs: 1,
    finalKillWaitMs: 1,
    sleep: async () => {},
    killGroup() { const error = new Error("operation denied"); error.code = "EPERM"; throw error; },
  });
  await deleteHarness.execute({ action: "create", checkAfter: "10m", abstract: "eperm delete", command: "unused" });
  const deleted = await deleteHarness.execute({ action: "delete", id: "46464646" });
  assert.equal(deleted.details.forced, true);
  assert.deepEqual(deleteHarness.runtime.list(), []);
  await deleteHarness.runtime.shutdown();

  const children = [];
  const shutdownHarness = createHarness({
    randomHex: (() => { let id = 47; return () => String(id++).padStart(8, "0"); })(),
    spawn() { const child = fakeChild(47000 + children.length); children.push(child); return child; },
    resolveShell: () => "/bin/bash",
    shutdownGraceMs: 1,
    sleep: async () => {},
    killGroup(pid) {
      const error = new Error(pid === 47000 ? "not permitted" : "unknown signal failure");
      if (pid === 47000) error.code = "EPERM";
      throw error;
    },
  });
  const first = await shutdownHarness.execute({ action: "create", checkAfter: "10m", abstract: "one", command: "unused" });
  await shutdownHarness.execute({ action: "create", checkAfter: "10m", abstract: "two", command: "unused" });
  const root = dirname(first.details.monitor.logPath);
  await shutdownHarness.runtime.shutdown();
  assert.deepEqual(shutdownHarness.runtime.list(), []);
  assert.equal(shutdownHarness.runtime.hasBlockingWork(), false);
  assert.equal(existsSync(root), false);
  await shutdownHarness.runtime.shutdown();
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
  assert.deepEqual(harness.messages[0].message.details.lines.map((line) => line.text), ["before", "hit", "after"]);
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

  for (let index = 0; index < 150; index += 1) child.stdout.write(`tail-${index}\n`);
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
  assert.deepEqual(matcher.details.lines.map((line) => line.text), ["before", "hit one"]);
  assert.equal(matcher.details.omitted, 0);
  assert.equal(matcher.details.truncated, false);
  assert.deepEqual(matcher.content.split("\n"), [
    "Monitor 61616161 (unified) status running.",
    "Matched: hit.",
    "[stdout] before",
    "[stdout] hit one",
  ]);
  assert.doesNotMatch(matcher.content, /Exit code/);

  child.stdout.write("after\n");
  closeChild(child, 0, null);
  await wait();
  assert.equal(harness.messages.length, 2);
  const terminal = harness.messages[1].message;
  assert.deepEqual(Object.keys(terminal.details), shape);
  assert.equal(terminal.details.kind, "update");
  assert.equal(terminal.details.status, "completed");
  assert.deepEqual(terminal.details.matched, [], "terminal updates always carry an empty matched array");
  assert.equal(terminal.details.exitCode, 0);
  assert.equal(terminal.details.signal, null);
  assert.equal(terminal.details.error, null);
  assert.deepEqual(terminal.content.split("\n"), [
    "Monitor 61616161 (unified) status completed.",
    "Exit code: 0; signal: null; error: null.",
    "[stdout] after",
  ]);

  const matcherSeqs = matcher.details.lines.map((line) => line.seq);
  const terminalSeqs = terminal.details.lines.map((line) => line.seq);
  assert.deepEqual(matcherSeqs, [1, 2]);
  assert.deepEqual(terminalSeqs, [3]);
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
    for (const sent of harness.messages) {
      if (sent.message.details.matched.length > 0) assert.equal(sent.message.details.status, "running");
    }
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
  assert.deepEqual(terminal.details.matched, []);
  assert.deepEqual(terminal.details.lines.map((line) => line.text), ["hit one", "hit two"]);
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
  assert.equal(matcher.lines.length, 30);
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

test("real detached descendant holding a pipe cannot block sequential delete", async (t) => {
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
  const deleted = await harness.execute({ action: "delete", id: "57575757" });
  assert.ok(Date.now() - started < 1000);
  assert.equal(deleted.details.forced, true);
  assert.match(deleted.content[0].text, /detached descendant may remain/i);
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
  assert.deepEqual(matcher.message.details.lines.map((line) => line.text), ["first line", "hit line"], "reminders never advance the delivered position");
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
