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
    return nextResolve(specifier, context);
  },
});

const {
  MONITOR_ACTIONS,
  MONITOR_NOTIFICATION_TYPE,
  MONITOR_PUBLIC_FIELDS,
  MonitorRuntime,
  monitorParameters,
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
  assert.equal(tool.description, "Create and manage foreground long-running Bash commands while Pi remains available. Monitor owns each process group. Terminal results remain available until deletion or runtime shutdown.");
  assert.equal(tool.promptSnippet, "Manage foreground long-running commands by monitor ID.");
  assert.deepEqual(tool.promptGuidelines, [
    "Create a monitor for foreground long-running commands that should continue while Pi remains available.",
    "Let monitor own the complete process group for every monitored command.",
    "Never detach a monitor command with nohup, setsid, disown, or a background ampersand.",
    "Use monitor `notifyOn` for case-sensitive literal alerts that merit attention before completion.",
    "Use `monitor list` to inspect current monitors without polling command output.",
    "Do not poll running monitors with repeated `monitor status` calls.",
    "After a monitor terminal notification, call `monitor status` to inspect results, then call `monitor delete`.",
    "Expect runtime shutdown to terminate monitor process groups and discard retained terminal results.",
  ]);
  assert.equal(schema.properties.action.description, "Select the monitor action. Create uses abstract, command, optional cwd, and optional notifyOn. Delete uses id. Status uses id and optional start and end. List uses no other fields.");
  assert.equal(schema.properties.command.description, "Provide one foreground Bash command. Do not use nohup, setsid, disown, a trailing ampersand, or another daemon escape.");
  assert.equal(schema.properties.end.description, "For status, read through this reverse log offset. Set `start` to the prior `end` for older lines.");

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

  await assert.rejects(harness.execute({ action: "create", abstract: "x", command: "x", id: "12345678" }), /does not accept field/);
  await assert.rejects(harness.execute({ action: "list", id: "12345678" }), /does not accept field/);
  await assert.rejects(harness.execute({ action: "status", id: "12345678", command: "x" }), /does not accept field/);
  await assert.rejects(harness.execute({ action: "create", abstract: " ", command: "x" }), /abstract must be a non-empty/);
  await assert.rejects(harness.execute({ action: "create", abstract: "x", command: " " }), /command must be a non-empty/);
  await assert.rejects(harness.execute({ action: "create", abstract: "x", command: "x", notifyOn: ["A", "A"] }), /duplicate literal/);
  await assert.rejects(harness.execute({ action: "create", abstract: "x", command: "x", notifyOn: [" "] }), /non-empty/);
  await assert.rejects(harness.execute({ action: "create", abstract: "x", command: "x", notifyOn: ["x".repeat(501)] }), /at most 500/);
  await assert.rejects(harness.execute({ action: "create", abstract: "x", command: "x", notifyOn: Array.from({ length: 21 }, (_, i) => String(i)) }), /at most 20/);
  await assert.rejects(harness.execute({ action: "status", id: "ABCDEF12" }), /exact 8-character/);
  await assert.rejects(harness.execute({ action: "delete", id: "abcdef1" }), /exact 8-character/);
});

test("spawn failure is atomic while IDs collide safely and cwd defaults from context", async (t) => {
  const failed = createHarness({ spawn() { throw new Error("spawn unavailable"); }, resolveShell: () => "/bin/bash", randomHex: () => "00000001" });
  await assert.rejects(failed.execute({ action: "create", abstract: "a", command: "echo a" }), /spawn unavailable/);
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
  const first = await harness.execute({ action: "create", abstract: " first ", command: " echo first " });
  const second = await harness.execute({ action: "create", abstract: "second", command: "echo second" });
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
  await harness.execute({ action: "create", abstract: "decode", command: "unused" });
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
  await harness.execute({ action: "create", abstract: "paging", command: "unused", notifyOn: ["hit"] });
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
  const first = await execute({ action: "create", abstract: "first", command: "unused", notifyOn: ["A", "B"] });
  const second = await execute({ action: "create", abstract: "second", command: "unused", notifyOn: ["X"] });
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
  const created = await execute({ action: "create", abstract: "notify", command: "unused", notifyOn: ["hit"] });
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
  assert.equal(terminal.message.details.kind, "terminal");
  assert.equal(terminal.message.details.status.status, "failed");
  assert.equal(terminal.message.details.status.exitCode, 7);
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
  await harness.execute({ action: "create", abstract: "cancel", command: "unused", notifyOn: ["hit"] });
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
  const created = await harness.execute({ action: "create", abstract: "delete", command: "unused" });
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
  const created = await harness.execute({ action: "create", abstract: "held pipe", command: "unused" });
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
  await deleteHarness.execute({ action: "create", abstract: "eperm delete", command: "unused" });
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
  const first = await shutdownHarness.execute({ action: "create", abstract: "one", command: "unused" });
  await shutdownHarness.execute({ action: "create", abstract: "two", command: "unused" });
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
  await harness.execute({ action: "create", abstract: "ring", command: "unused", notifyOn: ["hit"] });
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
  const created = await harness.execute({ action: "create", abstract: "payload", command: hugeCommand });
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
  await harness.execute({ action: "create", abstract: "bounded payload", command: "unused", notifyOn: ["MATCH"] });
  for (let index = 0; index < 100; index += 1) child.stdout.write(`MATCH-${index}-${"q".repeat(1000)}\n`);
  await wait(5);
  const matcher = harness.messages[0].message;
  assert.equal(matcher.details.abstract, "bounded payload");
  assert.ok(Buffer.byteLength(matcher.content) <= 50 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify(matcher.details)) <= 96 * 1024);
  assert.equal(matcher.details.truncated, true);
  assert.ok(matcher.details.omitted > 0);
  closeChild(child);
  await wait();
  const terminal = harness.messages.at(-1).message;
  assert.equal(terminal.details.abstract, "bounded payload");
  assert.ok(Buffer.byteLength(terminal.content) <= 50 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify(terminal.details)) <= 96 * 1024);
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
  await harness.execute({ action: "create", abstract: "roll", command: "unused", notifyOn: ["line-29"] });
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
    await harness.execute({ action: "create", abstract: mode, command: "unused" });
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
  await harness.execute({ action: "create", abstract: "remove me", command: "unused", notifyOn: ["hit"] });
  await harness.execute({ action: "create", abstract: "keep me", command: "unused", notifyOn: ["hit"] });
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
  const first = await harness.execute({ action: "create", abstract: "one", command: "unused" });
  const second = await harness.execute({ action: "create", abstract: "two", command: "unused" });
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
  await harness.execute({ action: "create", abstract: "bytes", command: "unused" });
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
