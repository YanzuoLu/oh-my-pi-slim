import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { beforeEach } from "node:test";

const piEntry = realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim());
const piRoot = dirname(dirname(piEntry));
const dependencyMap = {
  "@earendil-works/pi-ai": pathToFileURL(`${piRoot}/node_modules/@earendil-works/pi-ai/dist/index.js`).href,
  "@earendil-works/pi-coding-agent": pathToFileURL(`${piRoot}/dist/index.js`).href,
  "@earendil-works/pi-tui": pathToFileURL(`${piRoot}/node_modules/@earendil-works/pi-tui/dist/index.js`).href,
  typebox: pathToFileURL(`${piRoot}/node_modules/typebox/build/index.mjs`).href,
  "./ask-runtime.js": new URL("../extensions/oh-my-pi-slim/ask-runtime.ts", import.meta.url).href,
  "./ask-transcript-renderer.js": new URL("../extensions/oh-my-pi-slim/ask-transcript-renderer.ts", import.meta.url).href,
  "./ask-tui.js": new URL("../extensions/oh-my-pi-slim/ask-tui.ts", import.meta.url).href,
  "./bootstrap.js": new URL("../extensions/oh-my-pi-slim/bootstrap.ts", import.meta.url).href,
  "./cache-retention.js": new URL("../extensions/oh-my-pi-slim/cache-retention.ts", import.meta.url).href,
  "./fast-mode.js": new URL("../extensions/oh-my-pi-slim/fast-mode.ts", import.meta.url).href,
  "./goal-runtime.js": new URL("../extensions/oh-my-pi-slim/goal-runtime.ts", import.meta.url).href,
  "./goal-transcript-renderer.js": new URL("../extensions/oh-my-pi-slim/goal-transcript-renderer.ts", import.meta.url).href,
  "./goal-widget.js": new URL("../extensions/oh-my-pi-slim/goal-widget.ts", import.meta.url).href,
  "./loop-runtime.js": new URL("../extensions/oh-my-pi-slim/loop-runtime.ts", import.meta.url).href,
  "./monitor-runtime.js": new URL("../extensions/oh-my-pi-slim/monitor-runtime.ts", import.meta.url).href,
  "./monitor-transcript-renderer.js": new URL("../extensions/oh-my-pi-slim/monitor-transcript-renderer.ts", import.meta.url).href,
  "./monitor-widget.js": new URL("../extensions/oh-my-pi-slim/monitor-widget.ts", import.meta.url).href,
  "./loop-transcript-renderer.js": new URL("../extensions/oh-my-pi-slim/loop-transcript-renderer.ts", import.meta.url).href,
  "./loop-widget.js": new URL("../extensions/oh-my-pi-slim/loop-widget.ts", import.meta.url).href,
  "./prompt-context.js": new URL("../extensions/oh-my-pi-slim/prompt-context.ts", import.meta.url).href,
  "./subagent-checkpoint.js": new URL("../extensions/oh-my-pi-slim/subagent-checkpoint.ts", import.meta.url).href,
  "./subagent-core.js": new URL("../extensions/oh-my-pi-slim/subagent-core.ts", import.meta.url).href,
  "./subagent-runtime.js": new URL("../extensions/oh-my-pi-slim/subagent-runtime.ts", import.meta.url).href,
  "./subagent-model-display.js": new URL("../extensions/oh-my-pi-slim/subagent-model-display.ts", import.meta.url).href,
  "./subagent-run-files.js": new URL("../extensions/oh-my-pi-slim/subagent-run-files.ts", import.meta.url).href,
  "./subagent-transcript-renderer.js": new URL("../extensions/oh-my-pi-slim/subagent-transcript-renderer.ts", import.meta.url).href,
  "./subagent-viewer-data.js": new URL("../extensions/oh-my-pi-slim/subagent-viewer-data.ts", import.meta.url).href,
  "./subagent-viewer-transcript.js": new URL("../extensions/oh-my-pi-slim/subagent-viewer-transcript.ts", import.meta.url).href,
  "./subagent-viewer.js": new URL("../extensions/oh-my-pi-slim/subagent-viewer.ts", import.meta.url).href,
  "./subagent-widget.js": new URL("../extensions/oh-my-pi-slim/subagent-widget.ts", import.meta.url).href,
  "./subagent-widget-renderer.js": new URL("../extensions/oh-my-pi-slim/subagent-widget-renderer.ts", import.meta.url).href,
  "./subagent-widget-display.js": new URL("../extensions/oh-my-pi-slim/subagent-widget-display.ts", import.meta.url).href,
  "./subagent-widget-glyphs.js": new URL("../extensions/oh-my-pi-slim/subagent-widget-glyphs.ts", import.meta.url).href,
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

const {
  LOOP_ACTIONS,
  LOOP_MAX_INTERVAL_MS,
  LOOP_MESSAGE_TYPE,
  LOOP_MIN_INTERVAL_MS,
  LOOP_PUBLIC_FIELDS,
  LoopRuntime,
  canonicalizeLoopInterval,
  loopParameters,
  parseLoopInterval,
  registerLoopRuntime,
} = await import("../extensions/oh-my-pi-slim/loop-runtime.ts");
const { createLaunchMessageSender, default: ohMyPiSlim } = await import("../extensions/oh-my-pi-slim/index.ts");
const { OmpsSubagentRuntime } = await import("../extensions/oh-my-pi-slim/subagent-runtime.ts");
const { resetWidgetStackHost } = await import("../extensions/oh-my-pi-slim/widget-stack-host.ts");

// The aggregate widget host is a process-wide singleton, so every test starts from an empty one.
beforeEach(() => resetWidgetStackHost());

const START_MS = Date.parse("2026-05-01T00:00:00.000Z");
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CACHE = join(ROOT, ".cache");
mkdirSync(CACHE, { recursive: true });

function createHarness({ ids = ["00000001", "00000002", "00000003"], send, runCallbackOnClear = false } = {}) {
  let now = START_MS;
  let idIndex = 0;
  const tools = new Map();
  const commands = new Map();
  const messageRenderers = new Map();
  const timers = [];
  const cleared = [];
  const deferred = [];
  const messages = [];
  const pi = {
    registerTool(definition) { tools.set(definition.name, definition); },
    registerCommand(name, definition) { commands.set(name, definition); },
    registerMessageRenderer(type, renderer) { messageRenderers.set(type, renderer); },
    sendMessage(message, options) {
      if (send) return send(message, options, { advance: (milliseconds) => { now += milliseconds; } });
      messages.push({ message, options });
    },
    sendUserMessage() {},
  };
  const runtime = new LoopRuntime(pi, {
    nowMs: () => now,
    randomHex: () => ids[idIndex++] ?? "ffffffff",
    setTimeout(callback, milliseconds) {
      const timer = { callback, milliseconds, cleared: false, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimeout(timer) {
      timer.cleared = true;
      cleared.push(timer);
      if (runCallbackOnClear) timer.callback();
    },
    defer(callback) { deferred.push(callback); },
  });
  runtime.registerTool();
  return {
    runtime, tools, commands, messageRenderers, timers, cleared, deferred, messages,
    advance(milliseconds) { now += milliseconds; },
    now: () => now,
    flushOne() {
      const callback = deferred.shift();
      assert.equal(typeof callback, "function", "expected one deferred callback");
      callback();
    },
    fire(timer) {
      assert.equal(timer.cleared, false, "cannot fire a cleared timer");
      timer.callback();
      this.flushOne();
    },
    execute(params) { return tools.get("loop").execute("call", params); },
  };
}

function publicKeys(loop) {
  return Object.keys(loop).sort();
}

const PUBLIC_LOOP_KEYS = [
  "id", "abstract", "prompt", "interval", "status", "createdAt", "updatedAt", "nextFireAt",
  "fireCount", "failureCount", "lastFiredAt", "lastFailedAt", "lastError",
].sort();

test("loop schema has a provider-portable root and exact public actions", () => {
  const schema = JSON.parse(JSON.stringify(loopParameters));
  assert.equal(schema.type, "object");
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.anyOf, undefined);
  assert.equal(schema.oneOf, undefined);
  assert.deepEqual(Object.keys(schema.properties).sort(), [...LOOP_PUBLIC_FIELDS].sort());
  assert.deepEqual(LOOP_ACTIONS, ["create", "delete", "clear", "modify", "list", "pause", "resume"]);
  assert.deepEqual(schema.properties.action.anyOf.map((branch) => branch.const), LOOP_ACTIONS);
  for (const field of ["id", "interval", "abstract", "prompt"]) {
    assert.equal("maxLength" in schema.properties[field], false);
  }

  const harness = createHarness();
  const tool = harness.tools.get("loop");
  assert.equal(tool.executionMode, "sequential");
  assert.equal(tool.description, "Create and manage runtime-only fixed-delay loops from 10s through 7d. Creation and resume wait one full interval before firing. Each later delay starts only after the previous tick finishes. Each fire delivers the stored prompt for a future turn. Active loops must be paused before deletion or clearing. Loop state survives compaction and tree navigation within the current runtime. Reload, session replacement, and shutdown clear every loop. Actions return current loop state, change receipts, clear receipts, or the retained loop list.");
  assert.equal(tool.promptSnippet, "Manage fixed-delay prompt loops.");
  assert.deepEqual(tool.promptGuidelines, [
    "Call `loop create` only for a user message beginning with `/loop`.",
    "For bare `/loop`, call `loop list` and explain `/loop <interval> <prompt>`.",
    "Make every `loop create` prompt self-contained and repeatable for future turns.",
  ]);
  assert.equal(schema.properties.action.description, "Choose an action. create requires interval, abstract, and prompt. modify requires id and at least one changed field. delete, pause, and resume require id. clear and list accept no other fields.");
  assert.equal(schema.properties.interval.description, "Fixed delay for create or modify, from 10s through 7d. Format: one positive integer plus s, m, h, or d.");
  assert.equal(typeof tool.renderCall, "function");
  assert.equal(typeof tool.renderResult, "function");
  assert.equal(typeof harness.messageRenderers.get(LOOP_MESSAGE_TYPE), "function");
});

test("duration parsing is strict, bounded, and canonicalizes to the largest exact unit", () => {
  assert.equal(LOOP_MIN_INTERVAL_MS, 10_000);
  assert.equal(LOOP_MAX_INTERVAL_MS, 604_800_000);
  assert.deepEqual(parseLoopInterval(" 60s "), { interval: "1m", milliseconds: 60_000 });
  assert.deepEqual(parseLoopInterval("120m"), { interval: "2h", milliseconds: 7_200_000 });
  assert.deepEqual(parseLoopInterval("48h"), { interval: "2d", milliseconds: 172_800_000 });
  assert.deepEqual(parseLoopInterval("7d"), { interval: "7d", milliseconds: LOOP_MAX_INTERVAL_MS });
  assert.equal(canonicalizeLoopInterval(86_400_000), "1d");
  assert.equal(canonicalizeLoopInterval(3_600_000), "1h");
  assert.equal(canonicalizeLoopInterval(60_000), "1m");
  assert.equal(canonicalizeLoopInterval(10_000), "10s");
  for (const invalid of ["", "0s", "01s", "+10s", "10", "10ms", "1.5m", "10S", "9s", "8d", "999999999999999999999999999999999999h"]) {
    assert.throws(() => parseLoopInterval(invalid));
  }
});

test("runtime enforces exact action fields, required fields, trimmed text, and exact IDs", async () => {
  const harness = createHarness();
  const valid = {
    create: { action: "create", interval: "10s", abstract: " a ", prompt: " p " },
    list: { action: "list" },
  };
  for (const [action, extra] of Object.entries({
    create: { id: "00000001" },
    delete: { interval: "10s" },
    pause: { prompt: "x" },
    resume: { abstract: "x" },
    clear: { id: "00000001" },
    list: { id: "00000001" },
  })) {
    await assert.rejects(harness.execute({ ...(valid[action] ?? { action, id: "00000001" }), ...extra }), /does not accept field/);
  }
  await assert.rejects(harness.execute({ action: "clear-all" }), /Unsupported loop action: clear-all/);
  await assert.rejects(harness.execute({ action: "create", interval: "10s", abstract: "x" }), /requires prompt/);
  await assert.rejects(harness.execute({ action: "modify", id: "00000001" }), /requires at least one/);
  await assert.rejects(harness.execute({ action: "delete", id: "0000000" }), /exact 8-character/);
  await assert.rejects(harness.execute({ action: "list", unknown: true }), /does not accept field/);
  await assert.rejects(harness.execute({ action: "clear", confirmed: true }), /does not accept field\(s\): confirmed/);

  const emptyClear = await harness.execute({ action: "clear" });
  assert.deepEqual(emptyClear.details, { cleared: true, changed: false, clearedCount: 0, ids: [] });
  const created = await harness.execute(valid.create);
  assert.equal(created.details.loop.abstract, "a");
  assert.equal(created.details.loop.prompt, "p");
  assert.deepEqual(publicKeys(created.details.loop), PUBLIC_LOOP_KEYS);
  await assert.rejects(harness.execute({ action: "pause", id: "0000000A" }), /lowercase hexadecimal/);
  await assert.rejects(harness.execute({ action: "pause", id: "00000002" }), /was not found/);
});

test("CRUD preserves creation order, permits duplicate configurations, retries ID collisions, and returns complete JSON", async () => {
  const harness = createHarness({ ids: ["00000001", "00000001", "00000002"] });
  const config = { action: "create", interval: "10s", abstract: "same", prompt: "same prompt" };
  const first = await harness.execute(config);
  const second = await harness.execute(config);
  assert.equal(first.details.loop.id, "00000001");
  assert.equal(second.details.loop.id, "00000002");
  const listed = await harness.execute({ action: "list" });
  assert.deepEqual(listed.details.loops.map((loop) => loop.id), ["00000001", "00000002"]);
  assert.deepEqual(JSON.parse(listed.content[0].text), listed.details.loops);
  for (const loop of listed.details.loops) {
    assert.deepEqual(publicKeys(loop), PUBLIC_LOOP_KEYS);
    assert.equal(loop.fireCount, 0);
    assert.equal(loop.failureCount, 0);
    assert.equal(loop.lastFiredAt, null);
    assert.equal(loop.lastFailedAt, null);
    assert.equal(loop.lastError, null);
  }
  await harness.execute({ action: "pause", id: "00000001" });
  const deleted = await harness.execute({ action: "delete", id: "00000001" });
  assert.deepEqual(deleted.details, { id: "00000001", deleted: true });
  assert.deepEqual(harness.runtime.list().map((loop) => loop.id), ["00000002"]);
  await assert.rejects(harness.execute({ action: "delete", id: "00000001" }), /was not found/);
});

test("delete rejects active loops without touching timers or gated fires and removes paused loops", async () => {
  const harness = createHarness();
  await harness.execute({ action: "create", interval: "10s", abstract: "protected", prompt: "protected prompt" });
  harness.runtime.setDeliveryPaused(true);
  harness.advance(10_000);
  harness.fire(harness.timers[0]);
  const nextTimer = harness.timers[1];
  const before = structuredClone(harness.runtime.list()[0]);
  const tokenBeforeReject = harness.runtime.loops.get("00000001").timerToken;

  await assert.rejects(
    harness.execute({ action: "delete", id: "00000001" }),
    /Loop 00000001 has status active[\s\S]*Ask the user whether to pause this loop, then retry delete only if they agree\./,
  );
  assert.deepEqual(harness.runtime.list()[0], before);
  assert.equal(harness.runtime.loops.get("00000001").timerToken, tokenBeforeReject);
  assert.equal(nextTimer.cleared, false, "active rejection does not cancel the current timer");
  assert.equal(harness.runtime.gatedFires.length, 1, "active rejection preserves gated fires");

  harness.runtime.setDeliveryPaused(false);
  assert.equal(harness.messages.length, 1, "the preserved gated fire remains deliverable");
  await harness.execute({ action: "pause", id: "00000001" });
  const record = harness.runtime.loops.get("00000001");
  const tokenBeforeDelete = record.timerToken;
  const deleted = await harness.execute({ action: "delete", id: "00000001" });
  assert.deepEqual(deleted.details, { id: "00000001", deleted: true });
  assert.equal(record.timerToken, tokenBeforeDelete + 1, "paused delete calls cancelTimer even after pause");
  assert.deepEqual(harness.runtime.list(), []);
});

test("clear atomically rejects mixed active loops and clears all paused loops without resetting runtime", async () => {
  const harness = createHarness();
  await harness.execute({ action: "create", interval: "10s", abstract: "paused one", prompt: "first prompt" });
  await harness.execute({ action: "create", interval: "10s", abstract: "active two", prompt: "second prompt" });
  await harness.execute({ action: "pause", id: "00000001" });
  harness.runtime.setDeliveryPaused(true);
  harness.advance(10_000);
  harness.fire(harness.timers[1]);
  const activeTimer = harness.timers[2];
  const before = structuredClone(harness.runtime.list());
  const generation = harness.runtime.generation;
  const tokens = new Map([...harness.runtime.loops].map(([id, loop]) => [id, loop.timerToken]));

  await assert.rejects(
    harness.execute({ action: "clear" }),
    (error) => {
      assert.match(error.message, /00000002 \(active two\)/);
      assert.doesNotMatch(error.message, /00000001 \(paused one\)/);
      assert.match(error.message, /Ask the user whether to pause these loops, then retry clear only if they agree\./);
      return true;
    },
  );
  assert.deepEqual(harness.runtime.list(), before, "mixed active clear refusal is atomic");
  assert.equal(harness.runtime.generation, generation);
  assert.equal(activeTimer.cleared, false);
  assert.equal(harness.runtime.gatedFires.length, 1);
  for (const [id, token] of tokens) assert.equal(harness.runtime.loops.get(id).timerToken, token);

  await harness.execute({ action: "pause", id: "00000002" });
  harness.runtime.gatedFires.push(Object.freeze({
    generation,
    id: "deadbeef",
    abstract: "stale gated",
    interval: "10s",
    firedAt: new Date(harness.now()).toISOString(),
    prompt: "must not deliver",
  }));
  const pausedRecords = [...harness.runtime.loops.values()].map((loop) => ({ loop, token: loop.timerToken }));
  const cleared = await harness.execute({ action: "clear" });
  assert.equal(cleared.content[0].text, "Cleared 2 loops.");
  assert.deepEqual(cleared.details, {
    cleared: true,
    changed: true,
    clearedCount: 2,
    ids: ["00000001", "00000002"],
  });
  for (const { loop, token } of pausedRecords) {
    assert.equal(loop.timerToken, token + 1, `clear redundantly canceled paused loop ${loop.id}`);
  }
  assert.deepEqual(harness.runtime.list(), []);
  assert.equal(harness.runtime.gatedFires.length, 0);
  assert.equal(harness.runtime.generation, generation);
  assert.equal(harness.runtime.shuttingDown, false);
  harness.runtime.setDeliveryPaused(false);
  assert.equal(harness.messages.length, 0, "clear discards every gated fire");

  const empty = await harness.execute({ action: "clear" });
  assert.equal(empty.content[0].text, "No loops to clear.");
  assert.deepEqual(empty.details, { cleared: true, changed: false, clearedCount: 0, ids: [] });
  assert.equal(harness.runtime.generation, generation);
});

test("clear leaves stale deferred callbacks inert while later create and fire still work", async () => {
  const harness = createHarness();
  await harness.execute({ action: "create", interval: "10s", abstract: "stale", prompt: "stale prompt" });
  harness.advance(10_000);
  harness.timers[0].callback();
  assert.equal(harness.deferred.length, 1);
  await harness.execute({ action: "pause", id: "00000001" });
  const generation = harness.runtime.generation;
  await harness.execute({ action: "clear" });
  assert.equal(harness.runtime.generation, generation);
  harness.flushOne();
  assert.equal(harness.messages.length, 0, "the callback deferred before clear no-ops after its loop is removed");

  const created = await harness.execute({ action: "create", interval: "10s", abstract: "fresh", prompt: "fresh prompt" });
  assert.equal(created.details.loop.id, "00000002");
  harness.advance(10_000);
  harness.fire(harness.timers[1]);
  assert.equal(harness.messages.length, 1);
  assert.equal(harness.messages[0].message.details.id, "00000002");
  assert.equal(harness.runtime.list()[0].fireCount, 1);
});

test("create waits one full interval and recursive one-shot scheduling uses fixed delay after fire handling", async () => {
  const sent = [];
  const harness = createHarness({
    send(message, options, clock) {
      sent.push({ message, options });
      clock.advance(3_000);
    },
  });
  const created = await harness.execute({ action: "create", interval: "10s", abstract: "tick", prompt: "do it" });
  assert.equal(harness.timers.length, 1);
  assert.equal(harness.timers[0].milliseconds, 10_000);
  assert.equal(created.details.loop.nextFireAt, "2026-05-01T00:00:10.000Z");
  assert.equal(sent.length, 0);

  harness.advance(10_000);
  harness.fire(harness.timers[0]);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].options, { deliverAs: "steer", triggerTurn: true });
  assert.equal(sent[0].message.customType, LOOP_MESSAGE_TYPE);
  assert.equal(sent[0].message.details.fireCount, 1);
  assert.equal(sent[0].message.details.firedAt, "2026-05-01T00:00:10.000Z");
  assert.match(sent[0].message.content, /Loop 00000001 fired/);
  assert.match(sent[0].message.content, /Abstract: tick/);
  assert.match(sent[0].message.content, /Interval: 10s/);
  assert.match(sent[0].message.content, /Successful fire count: 1/);
  assert.match(sent[0].message.content, /Prompt:\ndo it/);
  assert.equal(harness.timers.length, 2);
  assert.equal(harness.timers[1].milliseconds, 10_000);
  assert.equal(harness.runtime.list()[0].nextFireAt, "2026-05-01T00:00:23.000Z");
});

test("synchronous injected timeout callbacks activate after commit without losing fires or atomic create failures", async () => {
  const tools = new Map();
  const deferred = [];
  const messages = [];
  let arms = 0;
  const pi = {
    registerTool(definition) { tools.set(definition.name, definition); },
    registerMessageRenderer() {},
    sendMessage(message, options) { messages.push({ message, options }); },
  };
  const runtime = new LoopRuntime(pi, {
    nowMs: () => START_MS,
    randomHex: () => "00000001",
    setTimeout(callback, milliseconds) {
      arms += 1;
      callback();
      return { milliseconds, unref() {} };
    },
    clearTimeout() {},
    defer(callback) { deferred.push(callback); },
  });
  runtime.registerTool();
  const created = await tools.get("loop").execute("create", {
    action: "create", interval: "10s", abstract: "sync seam", prompt: "sync prompt",
  });
  assert.equal(created.details.loop.fireCount, 0);
  assert.equal(runtime.list().length, 1);
  assert.equal(arms, 1);
  assert.equal(deferred.length, 1, "an early timeout waits for schedule activation and the existing defer seam");

  deferred.shift()();
  assert.equal(messages.length, 1);
  assert.equal(messages[0].message.details.fireCount, 1);
  assert.equal(runtime.list()[0].fireCount, 1);
  assert.equal(arms, 2, "the first early fire rearms the recursive one-shot schedule");
  assert.equal(deferred.length, 1);

  deferred.shift()();
  assert.equal(messages.length, 2);
  assert.equal(messages[1].message.details.fireCount, 2);
  assert.equal(runtime.list()[0].fireCount, 2);
  assert.equal(arms, 3);
  runtime.shutdown();
  deferred.shift()();
  assert.equal(messages.length, 2, "shutdown invalidates the next synchronously armed deferred fire");

  const failedTools = new Map();
  const failedRuntime = new LoopRuntime({
    registerTool(definition) { failedTools.set(definition.name, definition); },
    registerMessageRenderer() {},
    sendMessage() {},
  }, {
    nowMs: () => START_MS,
    randomHex: () => "00000002",
    setTimeout() { throw new Error("scheduler unavailable"); },
    clearTimeout() {},
    defer(callback) { callback(); },
  });
  failedRuntime.registerTool();
  await assert.rejects(failedTools.get("loop").execute("create", {
    action: "create", interval: "10s", abstract: "fail", prompt: "fail prompt",
  }), /scheduler unavailable/);
  assert.deepEqual(failedRuntime.list(), [], "prepare failure never leaves an unarmed loop in the registry");
});

test("scheduler failures preserve active modify and paused resume atomicity", async () => {
  const tools = new Map();
  const timers = [];
  let failSchedule = false;
  const runtime = new LoopRuntime({
    registerTool(definition) { tools.set(definition.name, definition); },
    registerMessageRenderer() {},
    sendMessage() {},
  }, {
    nowMs: () => START_MS,
    randomHex: () => "00000001",
    setTimeout(callback, milliseconds) {
      if (failSchedule) throw new Error("scheduler unavailable");
      const timer = { callback, milliseconds, cleared: false, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimeout(timer) { timer.cleared = true; },
    defer(callback) { callback(); },
  });
  runtime.registerTool();
  const execute = (params) => tools.get("loop").execute("call", params);
  await execute({ action: "create", interval: "10s", abstract: "atomic", prompt: "atomic prompt" });
  const activeBefore = structuredClone(runtime.list()[0]);
  failSchedule = true;
  await assert.rejects(execute({ action: "modify", id: "00000001", interval: "20s", abstract: "changed" }), /scheduler unavailable/);
  assert.deepEqual(runtime.list()[0], activeBefore);
  assert.equal(timers[0].cleared, false);

  await execute({ action: "pause", id: "00000001" });
  const pausedBefore = structuredClone(runtime.list()[0]);
  await assert.rejects(execute({ action: "resume", id: "00000001" }), /scheduler unavailable/);
  assert.deepEqual(runtime.list()[0], pausedBefore);
});

test("pause, resume, and modify apply no-op and timer-reset rules", async () => {
  const harness = createHarness();
  const created = await harness.execute({ action: "create", interval: "60s", abstract: "old", prompt: "old prompt" });
  assert.equal(created.details.loop.interval, "1m");
  const firstTimer = harness.timers[0];
  const firstNext = created.details.loop.nextFireAt;
  const firstUpdated = created.details.loop.updatedAt;

  harness.advance(5_000);
  const abstractOnly = await harness.execute({ action: "modify", id: "00000001", abstract: "new" });
  assert.equal(abstractOnly.details.changed, true);
  assert.equal(harness.timers.length, 1);
  assert.equal(abstractOnly.details.loop.nextFireAt, firstNext);
  const equivalent = await harness.execute({ action: "modify", id: "00000001", interval: "60s" });
  assert.equal(equivalent.details.changed, false);
  assert.equal(harness.timers.length, 1);

  const paused = await harness.execute({ action: "pause", id: "00000001" });
  assert.equal(paused.details.loop.status, "paused");
  assert.equal(paused.details.loop.nextFireAt, null);
  assert.equal(firstTimer.cleared, true);
  const pausedAgain = await harness.execute({ action: "pause", id: "00000001" });
  assert.equal(pausedAgain.details.changed, false);
  assert.equal(pausedAgain.details.loop.updatedAt, paused.details.loop.updatedAt);

  const pausedModified = await harness.execute({ action: "modify", id: "00000001", interval: "2m", prompt: "new prompt" });
  assert.equal(pausedModified.details.loop.interval, "2m");
  assert.equal(harness.timers.length, 1, "paused interval changes do not create timers");
  harness.advance(7_000);
  const resumed = await harness.execute({ action: "resume", id: "00000001" });
  assert.equal(resumed.details.loop.status, "active");
  assert.equal(resumed.details.loop.nextFireAt, "2026-05-01T00:02:12.000Z");
  assert.equal(harness.timers.at(-1).milliseconds, 120_000);
  const resumedAgain = await harness.execute({ action: "resume", id: "00000001" });
  assert.equal(resumedAgain.details.changed, false);
  assert.equal(harness.timers.length, 2);

  harness.advance(1_000);
  const changedInterval = await harness.execute({ action: "modify", id: "00000001", interval: "3m" });
  assert.equal(changedInterval.details.loop.nextFireAt, "2026-05-01T00:03:13.000Z");
  assert.equal(harness.timers.at(-2).cleared, true);
  assert.equal(harness.timers.at(-1).milliseconds, 180_000);
  assert.notEqual(changedInterval.details.loop.updatedAt, firstUpdated);
});

test("stale timer callbacks no-op after interval modify, pause, or delete while latest config wins before snapshot creation", async () => {
  const harness = createHarness();
  await harness.execute({ action: "create", interval: "10s", abstract: "initial", prompt: "initial prompt" });
  const firstTimer = harness.timers[0];

  harness.advance(10_000);
  firstTimer.callback();
  assert.equal(harness.deferred.length, 1, "the timer callback has entered the event loop before snapshot creation");
  await harness.execute({ action: "modify", id: "00000001", abstract: "latest", prompt: "latest prompt" });
  harness.flushOne();
  assert.equal(harness.messages.length, 1);
  assert.equal(harness.messages[0].message.details.abstract, "latest");
  assert.equal(harness.messages[0].message.details.prompt, "latest prompt");

  const beforeIntervalChange = harness.timers.at(-1);
  beforeIntervalChange.callback();
  assert.equal(harness.deferred.length, 1);
  await harness.execute({ action: "modify", id: "00000001", interval: "20s" });
  harness.flushOne();
  assert.equal(harness.messages.length, 1, "an entered callback becomes stale after interval rescheduling");

  const beforePause = harness.timers.at(-1);
  await harness.execute({ action: "pause", id: "00000001" });
  beforePause.callback();
  assert.equal(harness.deferred.length, 0, "a cleared callback becomes stale after pause");
  assert.equal(harness.messages.length, 1);

  await harness.execute({ action: "resume", id: "00000001" });
  const beforeDelete = harness.timers.at(-1);
  await assert.rejects(harness.execute({ action: "delete", id: "00000001" }), /has status active/);
  await harness.execute({ action: "pause", id: "00000001" });
  await harness.execute({ action: "delete", id: "00000001" });
  beforeDelete.callback();
  assert.equal(harness.deferred.length, 0, "a cleared callback becomes stale after delete");
  assert.equal(harness.messages.length, 1);
});

test("invalid modifications validate first and leave state and timers unchanged", async () => {
  const harness = createHarness();
  await harness.execute({ action: "create", interval: "10s", abstract: "old", prompt: "old prompt" });
  const before = structuredClone(harness.runtime.list()[0]);
  const timer = harness.timers[0];
  await assert.rejects(harness.execute({
    action: "modify", id: "00000001", interval: "9s", abstract: "new", prompt: "new prompt",
  }), /between 10s and 7d/);
  assert.deepEqual(harness.runtime.list()[0], before);
  assert.equal(timer.cleared, false);
  await assert.rejects(harness.execute({ action: "modify", id: "00000001", abstract: "   " }), /non-empty/);
  assert.deepEqual(harness.runtime.list()[0], before);
});

test("fire accounting changes only after send success and retains failure history", async () => {
  let attempt = 0;
  const delivered = [];
  const harness = createHarness({
    send(message, options) {
      attempt += 1;
      if (attempt === 1) throw new Error("queue unavailable");
      delivered.push({ message, options });
    },
  });
  await harness.execute({ action: "create", interval: "10s", abstract: "count", prompt: "count prompt" });
  harness.advance(10_000);
  harness.fire(harness.timers[0]);
  let loop = harness.runtime.list()[0];
  assert.equal(loop.fireCount, 0);
  assert.equal(loop.failureCount, 1);
  assert.equal(loop.lastFailedAt, "2026-05-01T00:00:10.000Z");
  assert.equal(loop.lastError, "queue unavailable");

  harness.advance(10_000);
  harness.fire(harness.timers[1]);
  loop = harness.runtime.list()[0];
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].message.details.fireCount, 1);
  assert.equal(loop.fireCount, 1);
  assert.equal(loop.failureCount, 1);
  assert.equal(loop.lastFiredAt, "2026-05-01T00:00:20.000Z");
  assert.equal(loop.lastFailedAt, "2026-05-01T00:00:10.000Z");
  assert.equal(loop.lastError, null);
});

test("paused delivery gate retains FIFO immutable snapshots and pause/delete cancel gated records", async () => {
  const harness = createHarness();
  await harness.execute({ action: "create", interval: "10s", abstract: "first-old", prompt: "first old prompt" });
  await harness.execute({ action: "create", interval: "10s", abstract: "second-old", prompt: "second old prompt" });
  harness.runtime.setDeliveryPaused(true);
  harness.advance(10_000);
  harness.fire(harness.timers[0]);
  harness.fire(harness.timers[1]);
  assert.equal(harness.messages.length, 0);

  await harness.execute({ action: "modify", id: "00000001", abstract: "first-new", prompt: "first new prompt" });
  harness.advance(5_000);
  harness.runtime.setDeliveryPaused(false);
  assert.deepEqual(harness.messages.map(({ message }) => [message.details.id, message.details.abstract, message.details.prompt]), [
    ["00000001", "first-old", "first old prompt"],
    ["00000002", "second-old", "second old prompt"],
  ]);
  assert.deepEqual(harness.messages.map(({ message }) => message.details.fireCount), [1, 1]);
  assert.deepEqual(harness.messages.map(({ message }) => message.details.firedAt), [
    "2026-05-01T00:00:10.000Z",
    "2026-05-01T00:00:10.000Z",
  ], "gated details retain each timer fire time instead of the later gate-release time");

  harness.runtime.setDeliveryPaused(true);
  harness.advance(10_000);
  harness.fire(harness.timers[2]);
  harness.fire(harness.timers[3]);
  await harness.execute({ action: "pause", id: "00000001" });
  await harness.execute({ action: "pause", id: "00000002" });
  await harness.execute({ action: "delete", id: "00000002" });
  assert.equal(harness.runtime.list()[0].fireCount, 1);
  assert.equal(harness.runtime.list()[0].failureCount, 0);
  harness.runtime.setDeliveryPaused(false);
  assert.equal(harness.messages.length, 2, "pause and delete remove all undelivered snapshots for their IDs");
  assert.equal(harness.runtime.list()[0].fireCount, 1, "canceled gated fires never increment fireCount");
  assert.equal(harness.runtime.list()[0].failureCount, 0, "canceled gated fires never increment failureCount");
});

test("delivery gate keeps every independent fire without coalescing or backlog limits", async () => {
  const harness = createHarness();
  await harness.execute({ action: "create", interval: "10s", abstract: "many", prompt: "future work" });
  harness.runtime.setDeliveryPaused(true);
  let timer = harness.timers[0];
  for (let index = 0; index < 25; index += 1) {
    harness.advance(10_000);
    harness.fire(timer);
    timer = harness.timers.at(-1);
  }
  assert.equal(harness.messages.length, 0);
  harness.runtime.setDeliveryPaused(false);
  assert.equal(harness.messages.length, 25);
  assert.ok(harness.messages.every(({ options }) => options.deliverAs === "steer" && options.triggerTurn === true));
  assert.deepEqual(harness.messages.map(({ message }) => message.details.fireCount), Array.from({ length: 25 }, (_, index) => index + 1));
  assert.equal(new Set(harness.messages.map(({ message }) => message)).size, 25);
  assert.equal(harness.runtime.list()[0].fireCount, 25);
});

test("compact/tree-style gate cycles preserve loops while shutdown clears timers, generations, and gated fires", async () => {
  const harness = createHarness({ runCallbackOnClear: true });
  await harness.execute({ action: "create", interval: "10s", abstract: "keep", prompt: "keep prompt" });
  const staleTimer = harness.timers[0];
  harness.runtime.setDeliveryPaused(true);
  harness.advance(10_000);
  harness.fire(staleTimer);
  assert.equal(harness.runtime.list().length, 1, "pausing delivery does not clear runtime memory");
  harness.runtime.setDeliveryPaused(false);
  assert.equal(harness.runtime.list().length, 1, "releasing delivery preserves runtime memory");
  assert.equal(harness.messages.length, 1);

  const nextTimer = harness.timers[1];
  harness.runtime.setDeliveryPaused(true);
  harness.advance(10_000);
  harness.fire(nextTimer);
  assert.equal(harness.messages.length, 1, "the second fire remains gated");
  const enteredTimer = harness.timers[2];
  harness.advance(10_000);
  enteredTimer.callback();
  assert.equal(harness.deferred.length, 1);
  await harness.execute({ action: "create", interval: "10s", abstract: "clear-order", prompt: "clear-order prompt" });
  const activeTimer = harness.timers[3];

  harness.runtime.shutdown();
  harness.runtime.shutdown();
  harness.flushOne();
  harness.runtime.setDeliveryPaused(false);
  assert.deepEqual(harness.runtime.list(), []);
  assert.equal(harness.messages.length, 1, "shutdown generation invalidates deferred and discards gated fires");
  assert.equal(enteredTimer.cleared, false, "already-fired one-shot timers need no redundant clear");
  assert.equal(activeTimer.cleared, true, "shutdown clears active timers after invalidating its generation");
  assert.equal(harness.cleared.length, 1);
  assert.equal(harness.deferred.length, 0, "a callback invoked by clearTimeout observes the stopped generation and no-ops");

  harness.runtime.reset();
  const recreated = await harness.execute({ action: "create", interval: "10s", abstract: "new", prompt: "new prompt" });
  assert.equal(recreated.details.loop.id, "00000003");
});

test("custom fire messages use a fixed non-command banner even when the future prompt starts with /loop", async () => {
  const harness = createHarness();
  await harness.execute({
    action: "create",
    interval: "10s",
    abstract: "slash body",
    prompt: "/loop create another loop only as future prompt text",
  });
  harness.advance(10_000);
  harness.fire(harness.timers[0]);
  assert.equal(harness.messages.length, 1);
  const fire = harness.messages[0].message;
  assert.equal(fire.customType, LOOP_MESSAGE_TYPE);
  assert.equal(fire.content.startsWith("Loop 00000001 fired.\n"), true);
  assert.equal(fire.content.startsWith("/"), false);
  assert.match(fire.content, /Prompt:\n\/loop create another loop only as future prompt text$/);
});

test("launch wrapper injects independent reminders only for idle lifecycle launches", () => {
  const launchTypes = [
    "oh-my-pi-slim:monitor-notification",
    "oh-my-pi-slim:subagent-notification",
    "oh-my-pi-slim:goal-continuation",
  ];
  const goalContent = "<system-reminder>active Goal</system-reminder>";
  const run = ({ preset, goal, idle = true, types = launchTypes }) => {
    const sent = [];
    const sessionCtx = { isIdle: () => idle };
    const pi = {
      sendMessage(message, options) {
        sent.push({ message, options });
        if (options?.triggerTurn === true) idle = false;
      },
    };
    const sendLaunchMessage = createLaunchMessageSender(pi, {
      sessionCtx: () => sessionCtx,
      hasActivePreset: () => preset,
      goalReminder: () => goal ? goalContent : undefined,
    });
    for (const customType of types) {
      const launch = {
        customType,
        content: `${customType} content`,
        display: true,
        details: { customType, nested: { unchanged: true } },
      };
      const options = { deliverAs: "steer", triggerTurn: true };
      sendLaunchMessage(launch, options);
      assert.strictEqual(sent.at(-1).message, launch);
      assert.strictEqual(sent.at(-1).options, options);
    }
    return sent;
  };

  const expectedTypes = new Map([
    ["false:false", ["oh-my-pi-slim:monitor-notification"]],
    ["true:false", ["oh-my-pi-slim:phase-reminder", "oh-my-pi-slim:monitor-notification"]],
    ["false:true", ["oh-my-pi-slim:phase-reminder", "oh-my-pi-slim:goal-reminder", "oh-my-pi-slim:monitor-notification"]],
    ["true:true", ["oh-my-pi-slim:phase-reminder", "oh-my-pi-slim:goal-reminder", "oh-my-pi-slim:monitor-notification"]],
  ]);
  for (const preset of [false, true]) {
    for (const goal of [false, true]) {
      const sent = run({ preset, goal, types: [launchTypes[0]] });
      assert.deepEqual(sent.map(({ message }) => message.customType), expectedTypes.get(`${preset}:${goal}`));
      assert.deepEqual(sent.map(({ options }) => options.triggerTurn), goal
        ? [false, false, true]
        : preset ? [false, true] : [true]);
      if (goal) {
        assert.equal(sent[0].message.content.includes(goalContent), false, "phase and Goal content stay independent");
        assert.equal(sent[1].message.content, goalContent);
      }
    }
  }

  for (const customType of launchTypes) {
    const sent = run({ preset: true, goal: true, types: [customType] });
    assert.deepEqual(sent.map(({ message }) => message.customType), [
      "oh-my-pi-slim:phase-reminder",
      "oh-my-pi-slim:goal-reminder",
      customType,
    ]);
    assert.deepEqual(sent.map(({ options }) => options.triggerTurn), [false, false, true]);
    assert.deepEqual(sent[2].message.details, { customType, nested: { unchanged: true } });
  }

  const streaming = run({ preset: true, goal: true, idle: false, types: [launchTypes[1]] });
  assert.deepEqual(streaming.map(({ message }) => message.customType), [launchTypes[1]]);

  const consecutive = run({ preset: true, goal: true, types: [launchTypes[0], launchTypes[1]] });
  assert.deepEqual(consecutive.map(({ message }) => message.customType), [
    "oh-my-pi-slim:phase-reminder",
    "oh-my-pi-slim:goal-reminder",
    launchTypes[0],
    launchTypes[1],
  ], "synchronous triggerTurn state change lets only the first producer inject reminders");

});

test("slash command forwards raw loop text as a real user message with idle and busy semantics", async () => {
  const tools = new Map();
  const commands = new Map();
  const sent = [];
  const pi = {
    registerTool(definition) { tools.set(definition.name, definition); },
    registerCommand(name, definition) { commands.set(name, definition); },
    registerMessageRenderer() {},
    sendMessage() {},
    sendUserMessage(text, options) { sent.push({ text, options }); },
  };
  registerLoopRuntime(pi, { randomHex: () => "00000001" });
  const command = commands.get("loop");
  assert.equal(command.description, "Forward a loop request to the model.");
  await command.handler("", { isIdle: () => true });
  await command.handler("  create every ten seconds", { isIdle: () => false });
  assert.deepEqual(sent, [
    { text: "/loop", options: { expandPromptTemplates: false } },
    { text: "/loop   create every ten seconds", options: { deliverAs: "steer", expandPromptTemplates: false } },
  ]);
});

test("tree integration pauses delivery, defers matching release, survives stale generations, and fork stops timers early", async () => {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const originalSetImmediate = globalThis.setImmediate;
  const originalQueueMicrotask = globalThis.queueMicrotask;
  const originalConsoleError = console.error;
  const previousPiChild = process.env.PI_SUBAGENT_CHILD;
  const previousOmpsChild = process.env.OMPS_SUBAGENT_CHILD;
  const timers = [];
  const immediates = [];
  const microtasks = [];
  const messages = [];
  const tools = new Map();
  const handlers = new Map();
  globalThis.setTimeout = (callback, milliseconds) => {
    const timer = { callback, milliseconds, cleared: false, unref() {} };
    timers.push(timer);
    return timer;
  };
  globalThis.clearTimeout = (timer) => { timer.cleared = true; };
  globalThis.setImmediate = (callback) => {
    const immediate = { callback };
    immediates.push(immediate);
    return immediate;
  };
  globalThis.queueMicrotask = (callback) => { microtasks.push(callback); };
  console.error = () => {};
  delete process.env.PI_SUBAGENT_CHILD;
  delete process.env.OMPS_SUBAGENT_CHILD;
  try {
    const pi = {
      registerTool(definition) { tools.set(definition.name, definition); },
      registerCommand() {},
      registerMessageRenderer() {},
      registerFlag() {},
      registerShortcut() {},
      on(name, handler) { handlers.set(name, handler); },
      getAllTools() { return []; },
      sendMessage(message, options) { messages.push({ message, options }); },
      sendUserMessage() {},
    };
    ohMyPiSlim(pi);
    await tools.get("loop").execute("create", {
      action: "create", interval: "10s", abstract: "tree", prompt: "tree prompt",
    });

    const completedTreeController = new AbortController();
    await handlers.get("session_before_tree")({ signal: completedTreeController.signal });
    timers[0].callback();
    assert.equal(microtasks.length, 1);
    microtasks.shift()();
    assert.equal(messages.length, 0, "tree host work holds timer fires in the shared gate");

    const failedRestoreCtx = { hasUI: false, mode: "rpc" };
    await handlers.get("session_tree")({}, failedRestoreCtx);
    assert.equal(messages.length, 0, "session_tree never releases loop delivery synchronously");
    assert.equal(immediates.length, 1, "restore failure still schedules the matching deferred release");
    completedTreeController.abort();
    assert.equal(immediates.length, 1, "session_tree removes ownership of its abort listener");

    const compactSignal = new AbortController();
    handlers.get("session_before_compact")({ reason: "manual", willRetry: false, signal: compactSignal.signal });
    handlers.get("input")({ source: "user" });
    assert.equal(immediates.length, 2);
    immediates.shift().callback();
    assert.equal(messages.length, 0, "a stale tree generation cannot release a newer pause");
    immediates.shift().callback();
    assert.equal(messages.length, 1, "ordinary input releases the current generation without synchronous delivery");

    const canceledTreeController = new AbortController();
    await handlers.get("session_before_tree")({ signal: canceledTreeController.signal });
    timers[1].callback();
    microtasks.shift()();
    assert.equal(messages.length, 1, "a canceled tree keeps its fire gated");
    handlers.get("input")({ source: "user" });
    assert.equal(messages.length, 1);
    immediates.shift().callback();
    assert.equal(messages.length, 2, "ordinary input releases a canceled tree gate");
    canceledTreeController.abort();
    assert.equal(immediates.length, 0, "ordinary input removes canceled-tree abort ownership");

    const activeTimer = timers[2];
    handlers.get("session_before_fork")({});
    assert.equal(activeTimer.cleared, true, "before_fork clears active loop timers immediately");
    activeTimer.callback();
    assert.equal(microtasks.length, 0, "fork-invalidated timer callbacks no-op before entering deferred work");
    const listed = await tools.get("loop").execute("list", { action: "list" });
    assert.deepEqual(listed.details.loops, []);
    assert.equal(messages.length, 2);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    globalThis.setImmediate = originalSetImmediate;
    globalThis.queueMicrotask = originalQueueMicrotask;
    console.error = originalConsoleError;
    if (previousPiChild === undefined) delete process.env.PI_SUBAGENT_CHILD;
    else process.env.PI_SUBAGENT_CHILD = previousPiChild;
    if (previousOmpsChild === undefined) delete process.env.OMPS_SUBAGENT_CHILD;
    else process.env.OMPS_SUBAGENT_CHILD = previousOmpsChild;
  }
});

test("tree abort waits for shutdown completion and shutdown errors release the matching gate before propagation", async () => {
  const originalShutdown = OmpsSubagentRuntime.prototype.shutdown;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const originalSetImmediate = globalThis.setImmediate;
  const originalQueueMicrotask = globalThis.queueMicrotask;
  const previousPiChild = process.env.PI_SUBAGENT_CHILD;
  const previousOmpsChild = process.env.OMPS_SUBAGENT_CHILD;
  const timers = [];
  const immediates = [];
  const microtasks = [];
  const messages = [];
  const tools = new Map();
  const handlers = new Map();
  let finishShutdown;
  OmpsSubagentRuntime.prototype.shutdown = function shutdownAfterTestSignal() {
    return new Promise((resolve) => { finishShutdown = resolve; });
  };
  globalThis.setTimeout = (callback, milliseconds) => {
    const timer = { callback, milliseconds, cleared: false, unref() {} };
    timers.push(timer);
    return timer;
  };
  globalThis.clearTimeout = (timer) => { timer.cleared = true; };
  globalThis.setImmediate = (callback) => {
    const immediate = { callback };
    immediates.push(immediate);
    return immediate;
  };
  globalThis.queueMicrotask = (callback) => { microtasks.push(callback); };
  delete process.env.PI_SUBAGENT_CHILD;
  delete process.env.OMPS_SUBAGENT_CHILD;
  try {
    const pi = {
      registerTool(definition) { tools.set(definition.name, definition); },
      registerCommand() {},
      registerMessageRenderer() {},
      registerFlag() {},
      registerShortcut() {},
      on(name, handler) { handlers.set(name, handler); },
      getAllTools() { return []; },
      sendMessage(message, options) { messages.push({ message, options }); },
      sendUserMessage() {},
    };
    ohMyPiSlim(pi);
    await tools.get("loop").execute("create", {
      action: "create", interval: "10s", abstract: "tree abort", prompt: "tree abort prompt",
    });

    const abortController = new AbortController();
    const beforeTree = handlers.get("session_before_tree")({ signal: abortController.signal });
    abortController.abort();
    timers[0].callback();
    microtasks.shift()();
    assert.equal(messages.length, 0);
    assert.equal(immediates.length, 0, "abort cannot release delivery before subagent shutdown completes");

    finishShutdown();
    await beforeTree;
    assert.equal(immediates.length, 1, "shutdown completion schedules one deferred abort compensation");
    assert.equal(messages.length, 0);
    immediates.shift().callback();
    assert.equal(messages.length, 1);
    abortController.abort();
    assert.equal(immediates.length, 0, "the one-shot abort listener loses ownership after compensation");

    OmpsSubagentRuntime.prototype.shutdown = async function failingShutdown() {
      throw new Error("shutdown failed");
    };
    const failureController = new AbortController();
    await assert.rejects(
      handlers.get("session_before_tree")({ signal: failureController.signal }),
      /shutdown failed/,
    );
    assert.equal(immediates.length, 1, "shutdown failure schedules deferred gate release before propagating");
    timers[1].callback();
    microtasks.shift()();
    assert.equal(messages.length, 1, "the failed tree still gates fires until deferred compensation runs");
    immediates.shift().callback();
    assert.equal(messages.length, 2);
    failureController.abort();
    assert.equal(immediates.length, 0, "shutdown failure removes abort listener ownership");
  } finally {
    OmpsSubagentRuntime.prototype.shutdown = originalShutdown;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    globalThis.setImmediate = originalSetImmediate;
    globalThis.queueMicrotask = originalQueueMicrotask;
    if (previousPiChild === undefined) delete process.env.PI_SUBAGENT_CHILD;
    else process.env.PI_SUBAGENT_CHILD = previousPiChild;
    if (previousOmpsChild === undefined) delete process.env.OMPS_SUBAGENT_CHILD;
    else process.env.OMPS_SUBAGENT_CHILD = previousOmpsChild;
  }
});

test("main sessions register Ask and runtime tools while child sessions return before registration", async () => {
  function registrationHarness(sessionEntries = []) {
    const tools = [];
    const toolDefinitions = new Map();
    const commands = [];
    const commandDefinitions = new Map();
    const shortcuts = [];
    const renderers = [];
    const handlers = new Map();
    const entries = [];
    const sends = [];
    return {
      tools, toolDefinitions, commands, commandDefinitions, shortcuts, renderers, handlers, entries, sessionEntries, sends,
      pi: {
        registerTool(definition) {
          tools.push(definition.name);
          toolDefinitions.set(definition.name, definition);
        },
        registerCommand(name, definition) {
          commands.push(name);
          commandDefinitions.set(name, definition);
        },
        registerMessageRenderer(customType) { renderers.push(customType); },
        registerFlag() {},
        registerShortcut(shortcut) { shortcuts.push(shortcut); },
        on(name, handler) {
          const registered = handlers.get(name) ?? [];
          registered.push(handler);
          handlers.set(name, registered);
        },
        getAllTools() { return tools.map((name) => ({ name })); },
        getActiveTools() { return [...tools]; },
        getFlag() { return false; },
        getThinkingLevel() { return "medium"; },
        setThinkingLevel() {},
        async setModel() { return true; },
        setActiveTools() {},
        appendEntry(customType, data) {
          const entry = { type: "custom", customType, data };
          entries.push(entry);
          sessionEntries.push(entry);
        },
        sendMessage(...args) { sends.push(["message", ...args]); },
        sendUserMessage(...args) { sends.push(["user", ...args]); },
      },
    };
  }

  const previousPiChild = process.env.PI_SUBAGENT_CHILD;
  const previousOmpsChild = process.env.OMPS_SUBAGENT_CHILD;
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousSkipBootstrap = process.env.OMPS_SKIP_BOOTSTRAP;
  let fastAgentDir;
  try {
    delete process.env.PI_SUBAGENT_CHILD;
    delete process.env.OMPS_SUBAGENT_CHILD;
    const sessionEntries = [];
    const main = registrationHarness(sessionEntries);
    ohMyPiSlim(main.pi);
    assert.ok(main.tools.includes("ask_user_question"));
    assert.ok(main.tools.includes("goal"));
    assert.ok(main.tools.includes("loop"));
    assert.ok(main.tools.includes("monitor"));
    assert.ok(main.tools.includes("subagent"));
    assert.ok(main.commands.includes("goal"));
    assert.ok(main.commands.includes("loop"));
    assert.ok(main.commands.includes("fast"));
    assert.ok(main.commands.includes("cache"));
    assert.equal(main.commands.includes("monitor"), false);
    assert.deepEqual(main.shortcuts, ["ctrl+shift+left", "ctrl+shift+right"], "main sessions register exactly the two viewer shortcuts");
    assert.ok(main.handlers.has("session_before_fork"));
    assert.ok(main.handlers.has("session_before_tree"));
    assert.ok(main.handlers.has("session_tree"));
    assert.ok(main.handlers.has("session_shutdown"));

    const beforeAgentStart = main.handlers.get("before_agent_start");
    assert.equal(beforeAgentStart.length, 2, "main registers exactly two ordered before_agent_start handlers");
    const promptCtx = { mode: "rpc" };
    assert.deepEqual(beforeAgentStart.map((handler) => handler({ systemPrompt: "base" }, promptCtx)), [undefined, undefined]);
    assert.deepEqual(main.sends, [], "reminder handlers never send or enqueue another message");

    fastAgentDir = mkdtempSync(join(CACHE, "fast-main-agent-"));
    process.env.PI_CODING_AGENT_DIR = fastAgentDir;
    process.env.OMPS_SKIP_BOOTSTRAP = "1";
    const legacyConfigPath = join(fastAgentDir, "oh-my-pi-slim.json");
    const legacyConfig = {
      ...JSON.parse(readFileSync(join(ROOT, "config/oh-my-pi-slim.example.json"), "utf8")),
      fast: true,
    };
    writeFileSync(legacyConfigPath, `${JSON.stringify(legacyConfig, null, 2)}\n`);
    const sessionDir = join(fastAgentDir, "sessions");
    mkdirSync(sessionDir, { recursive: true });
    const notifications = [];
    const makeCtx = (
      entries,
      sessionId,
      model = { provider: "openai", api: "openai-responses", id: "gpt-main" },
      usingOAuth = false,
    ) => ({
      cwd: ROOT,
      mode: "rpc",
      hasUI: true,
      ui: {
        theme: { fg: (_color, text) => text },
        notify(message, level) { notifications.push({ message, level }); },
        setStatus() {},
      },
      model,
      modelRegistry: {
        find: (provider, id) => ({ provider, id, input: ["text", "image"] }),
        hasConfiguredAuth: () => true,
        isUsingOAuth: (candidate) => usingOAuth && candidate === model,
      },
      isProjectTrusted: () => true,
      sessionManager: {
        getEntries: () => entries,
        getBranch: () => [],
        getSessionDir: () => sessionDir,
        getSessionId: () => sessionId,
      },
    });
    const fastCtx = makeCtx(sessionEntries, "fast-main-session");
    const sessionStart = main.handlers.get("session_start")[0];
    const providerHook = main.handlers.get("before_provider_request");
    const providerResult = (runtime, ctx, payload = { model: ctx.model.id }) => runtime.handlers.get("before_provider_request")[0](
      { payload },
      ctx,
    );
    assert.equal(providerHook.length, 1, "main unconditionally registers exactly one provider payload hook");
    await sessionStart({ reason: "startup" }, fastCtx);
    assert.equal(JSON.parse(readFileSync(legacyConfigPath, "utf8")).fast, true, "the legal v1.0.0 preset config keeps its legacy field untouched");
    assert.equal(providerResult(main, fastCtx).service_tier, "priority", "empty session entries default Fast Mode on regardless of legacy agent-global config");

    const fastCommand = main.commandDefinitions.get("fast");
    const entriesBeforeUsage = sessionEntries.length;
    await fastCommand.handler("on", fastCtx);
    assert.equal(sessionEntries.length, entriesBeforeUsage, "Fast Mode arguments never append session state");
    assert.deepEqual(notifications.at(-1), { message: "Usage: /fast", level: "warning" });

    await fastCommand.handler("", fastCtx);
    assert.deepEqual(sessionEntries.at(-1), {
      type: "custom",
      customType: "oh-my-pi-slim:fast-state",
      data: { version: 1, fast: false },
    });
    assert.equal(providerResult(main, fastCtx), undefined);
    assert.match(notifications.at(-1).message, /Fast Mode disabled for this Pi session.*account permission.*may fail/);

    await fastCommand.handler("", fastCtx);
    assert.deepEqual(sessionEntries.at(-1).data, { version: 1, fast: true });
    assert.equal(providerResult(main, fastCtx).service_tier, "priority");

    const appendEntry = main.pi.appendEntry;
    main.pi.appendEntry = () => { throw new Error("injected append failure"); };
    await fastCommand.handler("", fastCtx);
    assert.equal(notifications.at(-1).level, "error");
    assert.match(notifications.at(-1).message, /injected append failure/);
    assert.equal(providerResult(main, fastCtx).service_tier, "priority", "append failure does not change in-memory Fast Mode");
    main.pi.appendEntry = appendEntry;

    const anthropicModel = {
      provider: "anthropic",
      api: "anthropic-messages",
      id: "claude-main",
      compat: { supportsLongCacheRetention: true },
    };
    const cacheCtx = makeCtx(sessionEntries, "cache-main-session", anthropicModel, true);
    const cachePayload = (ttl) => ({
      model: "claude-main",
      messages: [{ role: "user", content: [{ type: "text", text: "hello", cache_control: {
        type: "ephemeral",
        ...(ttl ? { ttl } : {}),
      } }] }],
    });
    assert.equal(
      providerResult(main, cacheCtx, cachePayload()).messages[0].content[0].cache_control.ttl,
      "1h",
      "a new session defaults Cache Mode Long",
    );

    const cacheCommand = main.commandDefinitions.get("cache");
    const entriesBeforeCacheUsage = sessionEntries.length;
    await cacheCommand.handler("long", cacheCtx);
    assert.equal(sessionEntries.length, entriesBeforeCacheUsage, "Cache Mode arguments never append session state");
    assert.deepEqual(notifications.at(-1), { message: "Usage: /cache", level: "warning" });

    await cacheCommand.handler("", cacheCtx);
    assert.deepEqual(sessionEntries.at(-1), {
      type: "custom",
      customType: "oh-my-pi-slim:cache-state",
      data: { version: 1, retention: "short" },
    });
    assert.deepEqual(
      providerResult(main, cacheCtx, cachePayload("1h")).messages[0].content[0].cache_control,
      { type: "ephemeral" },
    );
    assert.match(notifications.at(-1).message, /Cache Mode Short requested for this Pi session.*does not guarantee a cache hit/);

    await cacheCommand.handler("", cacheCtx);
    assert.deepEqual(sessionEntries.at(-1).data, { version: 1, retention: "long" });
    assert.equal(providerResult(main, cacheCtx, cachePayload()).messages[0].content[0].cache_control.ttl, "1h");

    main.pi.appendEntry = () => { throw new Error("injected cache append failure"); };
    await cacheCommand.handler("", cacheCtx);
    assert.equal(notifications.at(-1).level, "error");
    assert.match(notifications.at(-1).message, /injected cache append failure/);
    assert.equal(
      providerResult(main, cacheCtx, cachePayload()).messages[0].content[0].cache_control.ttl,
      "1h",
      "append failure does not change in-memory Cache Mode",
    );
    main.pi.appendEntry = appendEntry;

    sessionEntries.push({
      type: "custom",
      customType: "oh-my-pi-slim:fast-state",
      data: { version: 1, fast: false, invalid: true },
    }, {
      type: "custom",
      customType: "oh-my-pi-slim:cache-state",
      data: { version: 1, retention: "short", invalid: true },
    });
    const reload = registrationHarness(sessionEntries);
    ohMyPiSlim(reload.pi);
    const reloadCtx = makeCtx(sessionEntries, "fast-main-session");
    await reload.handlers.get("session_start")[0]({ reason: "reload" }, reloadCtx);
    assert.equal(providerResult(reload, reloadCtx).service_tier, "priority", "reload restores the last valid Fast state from the same full entry log");
    const reloadCacheCtx = makeCtx(sessionEntries, "cache-main-session", anthropicModel, true);
    assert.equal(
      providerResult(reload, reloadCacheCtx, cachePayload()).messages[0].content[0].cache_control.ttl,
      "1h",
      "reload restores the last valid Cache state from the same full entry log",
    );

    for (const reason of ["resume", "fork"]) {
      const restored = registrationHarness(sessionEntries);
      ohMyPiSlim(restored.pi);
      const restoredCtx = makeCtx(sessionEntries, `fast-${reason}-session`);
      await restored.handlers.get("session_start")[0]({ reason }, restoredCtx);
      assert.equal(providerResult(restored, restoredCtx).service_tier, "priority", `${reason} restores or inherits the copied Fast session path state`);
      const restoredCacheCtx = makeCtx(sessionEntries, `cache-${reason}-session`, anthropicModel, true);
      assert.equal(
        providerResult(restored, restoredCacheCtx, cachePayload()).messages[0].content[0].cache_control.ttl,
        "1h",
        `${reason} restores or inherits the copied Cache session path state`,
      );
    }

    const newSession = registrationHarness([]);
    ohMyPiSlim(newSession.pi);
    const newCtx = makeCtx(newSession.sessionEntries, "fast-new-session");
    await newSession.handlers.get("session_start")[0]({ reason: "new" }, newCtx);
    assert.equal(providerResult(newSession, newCtx).service_tier, "priority", "a new empty session defaults Fast Mode on");
    const newCacheCtx = makeCtx(newSession.sessionEntries, "cache-new-session", anthropicModel, true);
    assert.equal(
      providerResult(newSession, newCacheCtx, cachePayload()).messages[0].content[0].cache_control.ttl,
      "1h",
      "a new empty session defaults Cache Mode Long",
    );

    const treeEntries = [{
      type: "custom",
      customType: "oh-my-pi-slim:fast-state",
      data: { version: 1, fast: true },
    }, {
      type: "custom",
      customType: "oh-my-pi-slim:cache-state",
      data: { version: 1, retention: "short" },
    }];
    const treeRuntime = registrationHarness(treeEntries);
    ohMyPiSlim(treeRuntime.pi);
    const treeCtx = makeCtx(treeEntries, "fast-tree-session");
    await treeRuntime.handlers.get("session_start")[0]({ reason: "startup" }, treeCtx);
    treeEntries.push({
      type: "custom",
      customType: "oh-my-pi-slim:fast-state",
      data: { version: 1, fast: false },
    }, {
      type: "custom",
      customType: "oh-my-pi-slim:cache-state",
      data: { version: 1, retention: "long" },
    });
    const entriesBeforeTree = treeEntries.length;
    await treeRuntime.handlers.get("session_tree")[0]({}, treeCtx);
    assert.equal(treeEntries.length, entriesBeforeTree, "tree navigation never appends Fast or Cache Mode state");
    assert.equal(providerResult(treeRuntime, treeCtx).service_tier, "priority", "tree navigation never recomputes session-wide Fast Mode from a branch");
    const treeCacheCtx = makeCtx(treeEntries, "cache-tree-session", anthropicModel, true);
    assert.deepEqual(
      providerResult(treeRuntime, treeCacheCtx, cachePayload("1h")).messages[0].content[0].cache_control,
      { type: "ephemeral" },
      "tree navigation never recomputes session-wide Cache Mode from a branch",
    );

    assert.equal(main.handlers.get("agent_start").length, 1);
    assert.equal(main.handlers.has("message_start"), false);
    assert.equal(main.handlers.has("context"), false);

    await main.commandDefinitions.get("omps").handler("on", fastCtx);
    const presetReminderResults = beforeAgentStart.map((handler) => handler({ systemPrompt: "base" }, fastCtx));
    assert.equal(presetReminderResults[0].message.customType, "oh-my-pi-slim:phase-reminder");
    assert.match(presetReminderResults[0].systemPrompt, /^base\n\n/);
    assert.equal(presetReminderResults[1], undefined);
    await main.commandDefinitions.get("omps").handler("off", fastCtx);

    await main.toolDefinitions.get("goal").execute("goal-create", {
      action: "create",
      abstract: "Independent reminder",
      objective: "Keep Goal guidance separate from phase guidance.",
      criteria: ["Both hidden messages remain independent"],
    });
    const entryCountAfterCreate = main.entries.length;
    const reminderResults = beforeAgentStart.map((handler) => handler({ systemPrompt: "base" }, promptCtx));
    assert.deepEqual(reminderResults, [
      {
        message: {
          customType: "oh-my-pi-slim:phase-reminder",
          content: `<system-reminder>\n!IMPORTANT! Scheduler workflow: First choose the lightest workflow that fits the work. If direct execution is justified, complete it and verify proportionately. Otherwise: plan lanes/dependencies → dispatch background specialists → continue non-overlapping work when available → await completion notifications → reconcile terminal results → verify. !END!\n</system-reminder>`,
          display: false,
        },
      },
      {
        message: {
          customType: "oh-my-pi-slim:goal-reminder",
          content: `<system-reminder>\n!IMPORTANT! You are pursuing the active Goal: Independent reminder. Keep this run aligned with it and continue making concrete progress. !END!\n</system-reminder>`,
          display: false,
        },
      },
    ], "an inactive preset with an active Goal returns phase then Goal reminders in one prompt");
    assert.equal(main.entries.length, entryCountAfterCreate, "reminder handlers append no entries of their own");
    assert.deepEqual(main.sends, [], "reminder handlers create no recursive or additional turn");
    assert.equal(main.renderers.includes("oh-my-pi-slim:goal-reminder"), false, "Goal reminder registers no renderer");

    const source = readFileSync(new URL("../extensions/oh-my-pi-slim/index.ts", import.meta.url), "utf8");
    assert.equal((source.match(/pi\.on\("context"/g) ?? []).length, 0, "main registers no context hook");
    const beforeFork = source.slice(source.indexOf('pi.on("session_before_fork"'), source.indexOf('pi.on("session_before_tree"'));
    const beforeTree = source.slice(source.indexOf('pi.on("session_before_tree"'), source.indexOf('pi.on("session_tree"'));
    const afterTree = source.slice(source.indexOf('pi.on("session_tree"'), source.indexOf('pi.on("input"'));
    assert.match(beforeFork, /invalidateCheckpoint\(false\)[\s\S]*loops\.shutdown\(\)[\s\S]*monitors\?\.shutdown\(\)/, "fork preparation must stop loops and monitors before the host operation");
    assert.doesNotMatch(beforeTree, /loops\.shutdown|loops\.reset|monitors\?\.shutdown|monitors\?\.reset|clearWithoutDelivery/, "tree preparation must preserve loop and monitor runtime state and records");
    assert.match(beforeTree, /const generation = notificationGate\.pause\(\)/, "tree preparation must pause the shared delivery gate");
    assert.match(beforeTree, /event\.signal\.addEventListener\("abort", abortListener, \{ once: true \}\)/, "tree preparation must bind one abort compensation listener");
    assert.match(beforeTree, /await subagents\.shutdown\(\)[\s\S]*hold\.shutdownComplete = true[\s\S]*hold\.abortPending/, "tree abort release must wait for subagent shutdown");
    assert.match(afterTree, /takeTreeNotificationHold\(\)[\s\S]*subagents\.restore\(ctx, notificationGate\.isPaused\(\)\)[\s\S]*finally[\s\S]*notificationGate\.releaseDeferred\(hold\.generation\)/, "tree completion must preserve the current gate state and defer the matching release");
    assert.doesNotMatch(afterTree, /loops\.setDeliveryPaused\(false\)|clearWithoutDelivery/, "session_tree must not release delivery synchronously");

    process.env.PI_SUBAGENT_CHILD = "1";
    const child = registrationHarness();
    ohMyPiSlim(child.pi);
    assert.deepEqual(child.tools, []);
    assert.deepEqual(child.commands, []);
    assert.deepEqual(child.shortcuts, [], "child sessions register no viewer shortcut");
  } finally {
    if (previousPiChild === undefined) delete process.env.PI_SUBAGENT_CHILD;
    else process.env.PI_SUBAGENT_CHILD = previousPiChild;
    if (previousOmpsChild === undefined) delete process.env.OMPS_SUBAGENT_CHILD;
    else process.env.OMPS_SUBAGENT_CHILD = previousOmpsChild;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousSkipBootstrap === undefined) delete process.env.OMPS_SKIP_BOOTSTRAP;
    else process.env.OMPS_SKIP_BOOTSTRAP = previousSkipBootstrap;
    if (fastAgentDir) rmSync(fastAgentDir, { recursive: true, force: true });
  }
});
