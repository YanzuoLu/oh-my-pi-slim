import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import test, { beforeEach } from "node:test";
import { piRoot } from "./fixtures/pi-install.mjs";
const dependencyMap = {
  "@earendil-works/pi-coding-agent": pathToFileURL(`${piRoot}/dist/index.js`).href,
  "@earendil-works/pi-tui": pathToFileURL(`${piRoot}/node_modules/@earendil-works/pi-tui/dist/index.js`).href,
  typebox: pathToFileURL(`${piRoot}/node_modules/typebox/build/index.mjs`).href,
  "../tool-contracts.js": new URL("../extensions/oh-my-pi-slim/tool-contracts.ts", import.meta.url).href,
  "./transcript-renderer.js": new URL("../extensions/oh-my-pi-slim/goal/transcript-renderer.ts", import.meta.url).href,
  "./widget.js": new URL("../extensions/oh-my-pi-slim/goal/widget.ts", import.meta.url).href,
  "./runtime.js": new URL("../extensions/oh-my-pi-slim/goal/runtime.ts", import.meta.url).href,
  "../semantic-glyph.js": new URL("../extensions/oh-my-pi-slim/semantic-glyph.ts", import.meta.url).href,
  "../widget-stack.js": new URL("../extensions/oh-my-pi-slim/widget-stack.ts", import.meta.url).href,
  "../widget-stack-host.js": new URL("../extensions/oh-my-pi-slim/widget-stack-host.ts", import.meta.url).href,
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
  GOAL_CONTINUATION_MESSAGE_TYPE,
  GOAL_RETRY_BACKOFF_MS,
  GOAL_STATE_ENTRY_TYPE,
  GOAL_STATE_MESSAGE_TYPE,
  GoalRuntime,
  deriveMainGoalStats,
  isGoalTombstoneData,
  parseGoalContinuationMessageDetails,
  parseGoalSnapshot,
  replayGoalBranch,
  retryDelayMs,
} = await import("../extensions/oh-my-pi-slim/goal/runtime.ts");
const {
  GOAL_ACTIONS,
  GOAL_PUBLIC_FIELDS,
  GOAL_TOOL_CONTRACT,
  GOAL_TOOL_ERRORS,
  goalContinuationContent,
  goalModelResult,
  goalParameters,
} = await import("../extensions/oh-my-pi-slim/tool-contracts.ts");
const { resetWidgetStackHost } = await import("../extensions/oh-my-pi-slim/widget-stack-host.ts");

// The aggregate widget host is a process-wide singleton, so every test starts from an empty one.
beforeEach(() => resetWidgetStackHost());

const START_MS = Date.parse("2026-06-01T00:00:00.000Z");

function createHarness(options = {}) {
  let now = START_MS;
  let idle = true;
  let pendingMessages = false;
  let leaf = null;
  let entrySequence = 0;
  const branch = [];
  const tools = new Map();
  const commands = new Map();
  const sent = [];
  const deferred = [];
  const timers = [];
  const pi = {
    registerTool(definition) { tools.set(definition.name, definition); },
    registerCommand(name, definition) { commands.set(name, definition); },
    registerMessageRenderer() {},
    appendEntry(customType, data) {
      const entry = { type: "custom", id: `e${++entrySequence}`, parentId: leaf, customType, data };
      branch.push(entry);
      leaf = entry.id;
    },
    sendMessage(message, sendOptions) {
      sent.push({ message: structuredClone(message), options: { ...sendOptions } });
      if (sendOptions.triggerTurn === false) {
        const entry = {
          type: "custom_message", id: `e${++entrySequence}`, parentId: leaf,
          customType: message.customType, content: message.content, display: message.display, details: structuredClone(message.details),
        };
        branch.push(entry);
        leaf = entry.id;
      } else {
        idle = false;
      }
    },
    sendUserMessage(text, sendOptions) { sent.push({ user: text, options: { ...sendOptions } }); },
  };
  const ctx = {
    mode: "rpc",
    hasUI: true,
    ui: {},
    isIdle: () => idle,
    hasPendingMessages: () => pendingMessages,
    sessionManager: {
      getBranch: () => branch,
      getSessionId: () => "session-1",
      getLeafId: () => leaf,
    },
  };
  const runtime = new GoalRuntime(pi, {
    sendContinuationMessage: options.sendContinuationMessage,
    nowMs: () => now,
    randomKey: () => (typeof options.randomKey === "function" ? options.randomKey() : options.randomKey ?? "instance-1"),
    defer: (callback) => deferred.push(callback),
    setTimeout(callback, milliseconds) {
      const timer = { callback, milliseconds, cleared: false, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimeout(timer) { timer.cleared = true; },
    isNotificationDeliveryPaused: () => options.notificationPaused?.() ?? false,
    hasActiveSubagents: () => options.activeSubagents?.() ?? false,
    hasPendingSubagentNotifications: () => options.pendingSubagentNotifications?.() ?? false,
    hasBlockingMonitors: () => options.blockingMonitors?.() ?? false,
    askWaitingCount: () => options.askWaiting?.() ?? 0,
    childStats: options.childStats,
  });
  runtime.register();
  runtime.restore(ctx, false);
  return {
    runtime, tools, commands, sent, deferred, timers, branch, ctx,
    execute(params) { return tools.get("goal").execute("call", params); },
    setIdle(value) { idle = value; },
    setPending(value) { pendingMessages = value; },
    advance(milliseconds) { now += milliseconds; },
    flush() {
      const callback = deferred.shift();
      assert.equal(typeof callback, "function", "expected deferred Goal work");
      callback();
    },
    appendMessage(message) {
      const entry = { type: "message", id: `e${++entrySequence}`, parentId: leaf, message };
      branch.push(entry);
      leaf = entry.id;
    },
    appendContinuation(message) {
      const entry = {
        type: "custom_message", id: `e${++entrySequence}`, parentId: leaf,
        customType: message.customType, content: message.content, display: message.display, details: structuredClone(message.details),
      };
      branch.push(entry);
      leaf = entry.id;
    },
  };
}

function eventContext(ctx, overrides = {}) {
  return {
    ...ctx,
    sessionManager: {
      ...ctx.sessionManager,
      getBranch: () => overrides.branch ?? ctx.sessionManager.getBranch(),
      getSessionId: () => overrides.sessionId ?? ctx.sessionManager.getSessionId(),
      getLeafId: () => "leafId" in overrides ? overrides.leafId : ctx.sessionManager.getLeafId(),
    },
  };
}

const createInput = {
  action: "create",
  abstract: "Ship the Goal core",
  objective: "Implement the frozen nonvisual Goal behavior.",
  criteria: ["Schema is strict", "Continuation is gated"],
};

function publicKeys(goal) {
  return Object.keys(goal).sort();
}

function resultDto(result) {
  const text = result.content[0].text;
  assert.equal(text.includes("\n"), false, "Goal success content must be compact single-line JSON");
  return JSON.parse(text);
}

const PUBLIC_STATUS_KEYS = [
  "status", "abstract", "objective", "criteria", "createdAt", "updatedAt", "endedAt", "pauseReason",
  "retryAttempt", "nextRetryAt", "lastProviderError", "noProgressCount", "evidence",
].sort();

test("Goal schema is a strict portable object with isolated public actions", async () => {
  const schema = JSON.parse(JSON.stringify(goalParameters));
  assert.equal(schema.type, "object");
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.anyOf, undefined);
  assert.equal(schema.oneOf, undefined);
  assert.deepEqual(Object.keys(schema.properties).sort(), [...GOAL_PUBLIC_FIELDS].sort());
  assert.deepEqual(schema.properties.action.anyOf.map((branch) => branch.const), GOAL_ACTIONS);
  assert.equal(schema.properties.criteria.minItems, 1);
  assert.equal(schema.properties.criteria.maxItems, 8);

  const harness = createHarness();
  const tool = harness.tools.get("goal");
  assert.equal(tool.executionMode, "sequential");
  assert.equal(tool.description, GOAL_TOOL_CONTRACT.description);
  assert.equal(tool.promptSnippet, undefined);
  assert.equal(tool.promptGuidelines, undefined);
  assert.equal(schema.properties.action.description, GOAL_TOOL_CONTRACT.parameters.properties.action.description);
  assert.deepEqual([...GOAL_ACTIONS], ["create", "check", "modify", "pause", "resume", "complete", "clear"]);
  assert.equal("confirmed" in schema.properties, false);
  for (const invalid of [
    { ...createInput, reason: "extra" },
    { action: "check", evidence: [] },
    { action: "complete" },
    { action: "resume", reason: "extra" },
    { action: "clear", reason: "extra" },
    { action: "clear", abstract: "extra" },
    { action: "clear", evidence: ["extra"] },
  ]) await assert.rejects(harness.execute(invalid));
  await assert.rejects(harness.execute({ action: "clear", reason: "extra" }), /clear does not accept field\(s\): reason\./);
  await assert.rejects(harness.execute({ ...createInput, criteria: [] }), /from 1 through 8/);
  await assert.rejects(harness.execute({ ...createInput, criteria: ["ok", "   "] }), /non-empty/);
});

test("create, modify, terminal replacement, evidence, and no-op receipts preserve the frozen business contract", async () => {
  const harness = createHarness();
  const none = await harness.execute({ action: "check" });
  assert.deepEqual(none.details, { goal: null, changed: false });
  assert.deepEqual(resultDto(none), { status: "none" });

  const created = await harness.execute(createInput);
  assert.equal(created.details.goal.status, "active");
  assert.deepEqual(publicKeys(created.details.goal), PUBLIC_STATUS_KEYS);
  assert.deepEqual(resultDto(created), { status: "active" });
  await assert.rejects(harness.execute(createInput), /no Goal or a completed Goal/);
  harness.runtime.ownRun("owned-before-modify");

  const paused = await harness.execute({ action: "pause" });
  assert.equal(paused.details.goal.status, "paused");
  assert.equal(paused.details.goal.pauseReason, null);
  const pausedAgain = await harness.execute({ action: "pause" });
  assert.equal(pausedAgain.details.changed, false);
  assert.deepEqual(resultDto(pausedAgain), { status: "paused" });

  const modified = await harness.execute({
    action: "modify", abstract: "Updated", objective: "Updated objective", criteria: ["One"],
  });
  assert.equal(modified.details.goal.status, "active");
  assert.equal(modified.details.goal.createdAt, created.details.goal.createdAt);
  assert.equal(harness.runtime.goalView().ownedChildRunCount, 1);
  assert.equal(modified.details.goal.pauseReason, null);
  assert.deepEqual(resultDto(modified), { status: "active" });

  await assert.rejects(harness.execute({ action: "complete", evidence: ["one", "two"] }), /exactly 1 items/);
  const completed = await harness.execute({ action: "complete", evidence: ["proof"] });
  assert.equal(completed.details.goal.status, "completed");
  assert.deepEqual(completed.details.goal.evidence, ["proof"]);
  assert.ok(completed.details.goal.endedAt);
  await assert.rejects(harness.execute({ action: "resume" }), /terminal/);

  const replacement = await harness.execute({ ...createInput, abstract: "Replacement" });
  assert.equal(replacement.details.goal.status, "active");
  assert.notEqual(replacement.details.goal.createdAt, undefined);
  assert.equal(harness.runtime.goalView().ownedChildRunCount, 0);
});

test("Goal actions return compact receipts while check returns the reviewable state", async () => {
  const harness = createHarness();

  assert.deepEqual(resultDto(await harness.execute({ action: "check" })), { status: "none" });
  assert.deepEqual(resultDto(await harness.execute({ action: "clear" })), { status: "none" });

  const created = await harness.execute(createInput);
  assert.deepEqual(resultDto(created), { status: "active" });
  const status = await harness.execute({ action: "check" });
  assert.deepEqual(resultDto(status), goalModelResult("check", status.details.goal));
  assert.deepEqual(resultDto(await harness.execute({ action: "resume" })), { status: "active" });

  const paused = await harness.execute({ action: "pause" });
  assert.deepEqual(resultDto(paused), { status: "paused" });
  assert.deepEqual(resultDto(await harness.execute({ action: "pause" })), { status: "paused" });
  const resumed = await harness.execute({ action: "resume" });
  assert.deepEqual(resultDto(resumed), { status: "active" });

  const modified = await harness.execute({
    action: "modify", abstract: "Updated", objective: "Updated objective", criteria: ["One"],
  });
  assert.deepEqual(resultDto(modified), { status: "active" });
  assert.deepEqual(resultDto(await harness.execute({ action: "complete", evidence: ["proof"] })), { status: "completed" });
  assert.deepEqual(resultDto(await harness.execute({ action: "clear" })), { status: "none" });

});

test("check and repeated pause or resume no-ops do not append snapshots or mutate state", async () => {
  const harness = createHarness();
  await harness.execute(createInput);
  const afterCreate = harness.branch.length;
  const activeBefore = structuredClone(harness.runtime.status());
  await harness.execute({ action: "check" });
  await harness.execute({ action: "resume" });
  assert.equal(harness.branch.length, afterCreate);
  assert.deepEqual(harness.runtime.status(), activeBefore);

  await harness.execute({ action: "pause" });
  const afterPause = harness.branch.length;
  const pausedBefore = structuredClone(harness.runtime.status());
  await harness.execute({ action: "check" });
  await harness.execute({ action: "pause" });
  assert.equal(harness.branch.length, afterPause);
  assert.deepEqual(harness.runtime.status(), pausedBefore);
});

test("retry-success cleanup is internally guarded against terminal state mutation", async () => {
  const harness = createHarness();
  await harness.execute({ ...createInput, criteria: ["done"] });
  await harness.execute({ action: "complete", evidence: ["proof"] });
  const before = structuredClone(harness.runtime.status());
  const entries = harness.branch.length;
  harness.runtime.clearRetryAfterSuccess();
  assert.deepEqual(harness.runtime.status(), before);
  assert.equal(harness.branch.length, entries);
});

test("snapshot replay is strict, latest-valid, branch-local, and restoration pauses pursuing states", async () => {
  const harness = createHarness();
  await harness.execute(createInput);
  const valid = structuredClone(harness.branch.findLast((entry) => entry.customType === GOAL_STATE_ENTRY_TYPE).data);
  assert.ok(parseGoalSnapshot(valid));
  assert.equal(parseGoalSnapshot({ ...valid, unknown: true }), undefined);
  assert.equal(parseGoalSnapshot({ ...valid, version: 999 }), undefined);
  assert.equal(parseGoalSnapshot({ ...valid, goal: { ...valid.goal, criteria: [" "] } }), undefined);

  const entries = [
    { type: "custom", customType: GOAL_STATE_ENTRY_TYPE, data: valid },
    { type: "custom", customType: GOAL_STATE_ENTRY_TYPE, data: { bad: true } },
  ];
  assert.equal(replayGoalBranch(entries).goal.abstract, valid.goal.abstract);

  const restored = createHarness();
  restored.branch.push(...entries);
  restored.runtime.restore(restored.ctx, true);
  assert.equal(restored.runtime.status().status, "paused");
  assert.equal(restored.runtime.status().pauseReason, "session_restored");
  assert.equal(restored.branch.at(-2).customType, GOAL_STATE_ENTRY_TYPE);
  assert.equal(restored.sent.at(-1).message.details.event, "session_restored");
});

test("Goal continuation content describes the active contract", async () => {
  const harness = createHarness();
  const created = await harness.execute(createInput);
  const goal = created.details.goal;
  assert.equal(goalContinuationContent(goal), [
    "Continue pursuing the active Goal.",
    "",
    "Abstract: Ship the Goal core",
    "",
    "Objective:",
    "Implement the frozen nonvisual Goal behavior.",
    "",
    "Completion criteria:",
    "1. Schema is strict",
    "2. Continuation is gated",
    "",
    "Do not ask the user questions while this Goal is active.",
    "Continue making concrete progress toward every criterion.",
    "Use `todo`, `monitor`, and `subagent` when useful.",
    "If safe progress is blocked, call `goal` with `action: \"pause\"`.",
    "Call `goal` with `action: \"complete\"` only with one evidence entry for every criterion.",
  ].join("\n"));

});

test("continuation waits for the full safe gate, uses steer with acknowledgement, and external input invalidates deferred work", async () => {
  let activeSubagents = true;
  const harness = createHarness({ activeSubagents: () => activeSubagents });
  await harness.execute(createInput);
  harness.runtime.onAgentSettled(harness.ctx);
  harness.flush();
  assert.equal(harness.sent.some((item) => item.message?.customType === GOAL_CONTINUATION_MESSAGE_TYPE), false);

  activeSubagents = false;
  harness.runtime.onAgentSettled(harness.ctx);
  harness.runtime.onExternalUserInput();
  harness.flush();
  assert.equal(harness.sent.some((item) => item.message?.customType === GOAL_CONTINUATION_MESSAGE_TYPE), false);

  harness.setIdle(true);
  harness.runtime.onAgentSettled(harness.ctx);
  harness.flush();
  const continuation = harness.sent.findLast((item) => item.message?.customType === GOAL_CONTINUATION_MESSAGE_TYPE);
  assert.ok(continuation);
  assert.deepEqual(continuation.options, { deliverAs: "steer", triggerTurn: true });
  assert.equal(continuation.message.content.startsWith("Continue pursuing the active Goal."), true);
  assert.equal(continuation.message.details.continuationNumber, 1);
  assert.deepEqual(parseGoalContinuationMessageDetails(continuation.message.details), continuation.message.details);
  assert.equal(parseGoalContinuationMessageDetails({ ...continuation.message.details, continuationNumber: undefined }), undefined);
  assert.equal(parseGoalContinuationMessageDetails({ ...continuation.message.details, continuationNumber: 0 }), undefined);
  harness.appendContinuation(continuation.message);
  assert.equal(harness.runtime.acknowledgeContinuationMessage({ role: "custom", ...continuation.message }), true);
  assert.equal(harness.runtime.goalView().continuationCount, 1);
});

test("deferred continuation requires the exact captured branch until delivery", async () => {
  const harness = createHarness();
  await harness.execute(createInput);
  harness.runtime.onAgentSettled(harness.ctx);
  harness.appendMessage({ role: "assistant", content: [], stopReason: "stop" });
  harness.flush();
  assert.equal(harness.sent.some((item) => item.message?.customType === GOAL_CONTINUATION_MESSAGE_TYPE), false);

  harness.runtime.onAgentSettled(harness.ctx);
  harness.flush();
  assert.equal(harness.sent.filter((item) => item.message?.customType === GOAL_CONTINUATION_MESSAGE_TYPE).length, 1);
});

test("continuation seam preserves automatic classification while Goal state messages stay on Pi", async () => {
  const continuationLaunches = [];
  let runtime;
  const automatic = createHarness({
    sendContinuationMessage(message, options) {
      continuationLaunches.push({ message, options });
      runtime.onAgentStart(automatic.ctx);
    },
  });
  runtime = automatic.runtime;
  await automatic.execute(createInput);
  runtime.onAgentSettled(automatic.ctx);
  automatic.flush();
  assert.equal(continuationLaunches.length, 1);
  assert.equal(continuationLaunches[0].message.customType, GOAL_CONTINUATION_MESSAGE_TYPE);
  assert.deepEqual(continuationLaunches[0].options, { deliverAs: "steer", triggerTurn: true });
  assert.equal(automatic.sent.some((item) => item.message?.customType === GOAL_CONTINUATION_MESSAGE_TYPE), false);

  runtime.onAgentEnd({ messages: [{ role: "assistant", stopReason: "stop" }] });
  automatic.setIdle(true);
  runtime.onAgentSettled(automatic.ctx);
  assert.equal(runtime.status().noProgressCount, 1, "pendingAutoRunKey is visible before the synchronous continuation sender starts the run");

  const stateSeam = [];
  const state = createHarness({
    sendContinuationMessage(message, options) { stateSeam.push({ message, options }); },
  });
  await state.execute(createInput);
  state.runtime.onAgentStart(state.ctx);
  state.runtime.onAgentEnd({ messages: [{ role: "assistant", stopReason: "aborted" }] });
  state.runtime.onAgentSettled(state.ctx);
  assert.equal(stateSeam.length, 0, "automatic Goal state events do not use the continuation launch seam");
  const stateMessage = state.sent.findLast((item) => item.message?.customType === GOAL_STATE_MESSAGE_TYPE);
  assert.ok(stateMessage);
  assert.equal(stateMessage.message.details.event, "user_abort");
  assert.deepEqual(stateMessage.options, { deliverAs: "steer", triggerTurn: false });
});

test("provider failures use unbounded frozen backoff, timer-safe activation, and success reset", async () => {
  const harness = createHarness();
  await harness.execute(createInput);
  harness.runtime.onAgentStart(harness.ctx);
  harness.runtime.onAgentEnd({ messages: [{ role: "assistant", stopReason: "error", errorMessage: "rate limited" }] });
  harness.runtime.onAgentSettled(harness.ctx);
  assert.equal(harness.runtime.status().status, "retry_wait");
  assert.equal(harness.runtime.status().retryAttempt, 1);
  assert.equal(harness.timers[0].milliseconds, 10_000);
  assert.deepEqual(GOAL_RETRY_BACKOFF_MS, [10_000, 30_000, 60_000, 300_000, 900_000, 3_600_000]);
  assert.equal(retryDelayMs(7), 3_600_000);

  harness.setIdle(true);
  harness.advance(10_000);
  harness.timers[0].callback();
  assert.equal(harness.runtime.status().status, "active");
  assert.equal(harness.runtime.status().retryAttempt, 1);
  harness.flush();
  const continuation = harness.sent.findLast((item) => item.message?.customType === GOAL_CONTINUATION_MESSAGE_TYPE);
  harness.appendContinuation(continuation.message);
  harness.runtime.acknowledgeContinuationMessage({ role: "custom", ...continuation.message });
  harness.runtime.onAgentStart(harness.ctx);
  harness.runtime.onAgentEnd({ messages: [{ role: "assistant", stopReason: "stop", usage: {} }] });
  harness.setIdle(true);
  harness.runtime.onAgentSettled(harness.ctx);
  assert.equal(harness.runtime.status().status, "active");
  assert.equal(harness.runtime.status().retryAttempt, 0);
  assert.equal(harness.runtime.status().lastProviderError, null);
});

test("user abort pauses only when the complete Goal delivery gate is idle", async () => {
  const harness = createHarness();
  await harness.execute(createInput);
  harness.runtime.onAgentStart(harness.ctx);
  harness.runtime.onAgentEnd({ messages: [{ role: "assistant", stopReason: "aborted" }] });
  harness.runtime.onAgentSettled(harness.ctx);
  assert.equal(harness.runtime.status().status, "paused");
  assert.equal(harness.runtime.status().pauseReason, "user_abort");
  assert.equal(harness.sent.filter((item) => item.message?.customType === GOAL_STATE_MESSAGE_TYPE).length, 1);
  assert.equal(harness.timers.length, 0);
});

test("distinct Pi event contexts with stable delivery identity still allow user-abort pause", async () => {
  const harness = createHarness();
  await harness.execute(createInput);
  const startCtx = eventContext(harness.ctx);
  const settledCtx = eventContext(harness.ctx);
  assert.notEqual(startCtx, settledCtx);

  harness.runtime.onAgentStart(startCtx);
  harness.runtime.onAgentEnd({ messages: [{ role: "assistant", stopReason: "aborted" }] });
  harness.runtime.onAgentSettled(settledCtx);

  assert.equal(harness.runtime.status().status, "paused");
  assert.equal(harness.runtime.status().pauseReason, "user_abort");
});

test("distinct Pi event contexts allow normal branch descendants", async () => {
  const harness = createHarness();
  await harness.execute(createInput);
  const startCtx = eventContext(harness.ctx);
  harness.runtime.onAgentStart(startCtx);
  harness.appendMessage({ role: "assistant", content: [], stopReason: "toolUse" });
  harness.appendMessage({ role: "toolResult", content: [] });
  const settledCtx = eventContext(harness.ctx);

  harness.runtime.onAgentEnd({ messages: [{ role: "assistant", stopReason: "aborted" }] });
  harness.runtime.onAgentSettled(settledCtx);

  assert.equal(harness.runtime.status().status, "paused");
  assert.equal(harness.runtime.status().pauseReason, "user_abort");
});

test("distinct Pi event contexts reject changed session, ancestor branch, or divergent branch", async () => {
  for (const mismatch of [
    { name: "session", overrides: { sessionId: "session-2" } },
    { name: "ancestor", overrides: { branch: [], leafId: null } },
    {
      name: "divergent",
      overrides: { branch: [{ type: "message", id: "fork-1", parentId: null, message: { role: "user", content: "fork" } }], leafId: "fork-1" },
    },
  ]) {
    const harness = createHarness();
    await harness.execute(createInput);
    const startCtx = eventContext(harness.ctx);
    const settledCtx = eventContext(harness.ctx, mismatch.overrides);
    const entries = goalStateEntries(harness.branch).length;

    harness.runtime.onAgentStart(startCtx);
    harness.runtime.onAgentEnd({ messages: [{ role: "assistant", stopReason: "aborted" }] });
    harness.runtime.onAgentSettled(settledCtx);

    assert.equal(harness.runtime.status().status, "active", mismatch.name);
    assert.equal(goalStateEntries(harness.branch).length, entries, mismatch.name);
    assert.equal(harness.sent.some((item) => item.message?.customType === GOAL_STATE_MESSAGE_TYPE), false, mismatch.name);
  }
});

test("agent-start identity becomes stale when external input arrives before an aborted settle", async () => {
  const harness = createHarness();
  await harness.execute(createInput);
  const startCtx = eventContext(harness.ctx);
  const settledCtx = eventContext(harness.ctx);
  harness.runtime.onAgentStart(startCtx);
  harness.runtime.onExternalUserInput();
  const entries = goalStateEntries(harness.branch).length;

  harness.runtime.onAgentEnd({ messages: [{ role: "assistant", stopReason: "aborted" }] });
  harness.runtime.onAgentSettled(settledCtx);

  assert.equal(harness.runtime.status().status, "active");
  assert.equal(harness.runtime.status().pauseReason, null);
  assert.equal(harness.runtime.status().noProgressCount, 0);
  assert.equal(goalStateEntries(harness.branch).length, entries);
  assert.equal(harness.sent.some((item) => item.message?.customType === GOAL_STATE_MESSAGE_TYPE), false);
  assert.equal(harness.timers.length, 0);
  harness.flush();
  assert.equal(harness.sent.filter((item) => item.message?.customType === GOAL_CONTINUATION_MESSAGE_TYPE).length, 1);
});

test("agent-start identity becomes stale when Goal generation changes before an aborted settle", async () => {
  const harness = createHarness();
  await harness.execute(createInput);
  const startCtx = eventContext(harness.ctx);
  harness.runtime.onAgentStart(startCtx);
  harness.runtime.ownRun("child-created-during-run");
  const entries = goalStateEntries(harness.branch).length;

  harness.runtime.onAgentEnd({ messages: [{ role: "assistant", stopReason: "aborted" }] });
  harness.runtime.onAgentSettled(eventContext(harness.ctx));

  assert.equal(harness.runtime.status().status, "active");
  assert.equal(harness.runtime.status().pauseReason, null);
  assert.equal(goalStateEntries(harness.branch).length, entries);
  assert.equal(harness.sent.some((item) => item.message?.customType === GOAL_STATE_MESSAGE_TYPE), false);
  assert.equal(harness.timers.length, 0);
});

test("aborted settle without an agent-start delivery candidate does not pause", async () => {
  const harness = createHarness();
  await harness.execute(createInput);
  harness.runtime.onAgentEnd({ messages: [{ role: "assistant", stopReason: "aborted" }] });
  harness.runtime.onAgentSettled(harness.ctx);
  assert.equal(harness.runtime.status().status, "active");
  assert.equal(harness.runtime.status().pauseReason, null);
  assert.equal(harness.sent.some((item) => item.message?.customType === GOAL_STATE_MESSAGE_TYPE), false);
});

test("every Goal delivery blocker suppresses user-abort pause without state, event, or timer writes", async () => {
  const cases = [
    { name: "ctx non-idle", prepare: (harness) => harness.setIdle(false) },
    { name: "pending messages", prepare: (harness) => harness.setPending(true) },
    { name: "Goal delivery pause", prepare: (harness) => harness.runtime.setDeliveryPaused(true) },
    { name: "notification delivery pause", options: { notificationPaused: () => true } },
    { name: "active subagent", options: { activeSubagents: () => true } },
    { name: "pending subagent notification", options: { pendingSubagentNotifications: () => true } },
    { name: "blocking monitor", options: { blockingMonitors: () => true } },
    { name: "waiting Ask", options: { askWaiting: () => 1 } },
  ];

  for (const blocker of cases) {
    const harness = createHarness(blocker.options);
    await harness.execute(createInput);
    blocker.prepare?.(harness);
    const entries = goalStateEntries(harness.branch).length;
    const events = harness.sent.filter((item) => item.message?.customType === GOAL_STATE_MESSAGE_TYPE).length;

    harness.runtime.onAgentStart(harness.ctx);
    harness.runtime.onAgentEnd({ messages: [{ role: "assistant", stopReason: "aborted" }] });
    harness.runtime.onAgentSettled(harness.ctx);

    assert.equal(harness.runtime.status().status, "active", blocker.name);
    assert.equal(harness.runtime.status().pauseReason, null, blocker.name);
    assert.equal(harness.runtime.status().noProgressCount, 0, blocker.name);
    assert.equal(goalStateEntries(harness.branch).length, entries, blocker.name);
    assert.equal(harness.sent.filter((item) => item.message?.customType === GOAL_STATE_MESSAGE_TYPE).length, events, blocker.name);
    assert.equal(harness.timers.length, 0, blocker.name);
    harness.flush();
    assert.equal(harness.sent.some((item) => item.message?.customType === GOAL_CONTINUATION_MESSAGE_TYPE), false, blocker.name);
  }
});

test("package lifecycle releases naturally reschedule suppressed user aborts", async () => {
  const cases = [
    { name: "active subagent", options: (blocked) => ({ activeSubagents: () => blocked.value }) },
    { name: "pending subagent notification", options: (blocked) => ({ pendingSubagentNotifications: () => blocked.value }) },
    { name: "blocking monitor", options: (blocked) => ({ blockingMonitors: () => blocked.value }) },
    { name: "waiting Ask", options: (blocked) => ({ askWaiting: () => blocked.value ? 1 : 0 }) },
  ];

  for (const blocker of cases) {
    const blocked = { value: false };
    const harness = createHarness(blocker.options(blocked));
    await harness.execute(createInput);
    harness.runtime.onAgentSettled(harness.ctx);
    harness.flush();
    const oldContinuation = harness.sent.findLast((item) => item.message?.customType === GOAL_CONTINUATION_MESSAGE_TYPE);

    harness.runtime.onAgentStart(harness.ctx);
    blocked.value = true;
    harness.setIdle(true);
    harness.runtime.onAgentEnd({ messages: [{ role: "assistant", stopReason: "aborted" }] });
    harness.runtime.onAgentSettled(harness.ctx);
    assert.equal(harness.runtime.status().status, "active", blocker.name);
    harness.flush();
    assert.equal(harness.sent.filter((item) => item.message?.customType === GOAL_CONTINUATION_MESSAGE_TYPE).length, 1, blocker.name);

    blocked.value = false;
    harness.runtime.notePackageLifecycleChange();
    harness.flush();
    const resumed = harness.sent.findLast((item) => item.message?.customType === GOAL_CONTINUATION_MESSAGE_TYPE);
    assert.equal(harness.sent.filter((item) => item.message?.customType === GOAL_CONTINUATION_MESSAGE_TYPE).length, 2, blocker.name);
    assert.notEqual(resumed.message.details.deliveryKey, oldContinuation.message.details.deliveryKey, blocker.name);
  }
});

test("Goal delivery release naturally reschedules a suppressed user abort", async () => {
  const harness = createHarness();
  await harness.execute(createInput);
  harness.runtime.onAgentStart(harness.ctx);
  harness.runtime.setDeliveryPaused(true);
  harness.runtime.onAgentEnd({ messages: [{ role: "assistant", stopReason: "aborted" }] });
  harness.runtime.onAgentSettled(harness.ctx);
  assert.equal(harness.runtime.status().status, "active");
  harness.flush();
  assert.equal(harness.sent.some((item) => item.message?.customType === GOAL_CONTINUATION_MESSAGE_TYPE), false);

  harness.runtime.setDeliveryPaused(false);
  harness.flush();
  assert.equal(harness.sent.filter((item) => item.message?.customType === GOAL_CONTINUATION_MESSAGE_TYPE).length, 1);
});

test("suppressed user abort preserves no-progress and invalidates old continuation before lifecycle reevaluation", async () => {
  let activeSubagents = false;
  const harness = createHarness({ activeSubagents: () => activeSubagents });
  await harness.execute(createInput);

  harness.runtime.onAgentSettled(harness.ctx);
  harness.flush();
  harness.runtime.onAgentStart(harness.ctx);
  harness.runtime.onAgentEnd({ messages: [{ role: "assistant", stopReason: "stop" }] });
  harness.setIdle(true);
  harness.runtime.onAgentSettled(harness.ctx);
  assert.equal(harness.runtime.status().noProgressCount, 1);
  harness.flush();
  const oldContinuation = harness.sent.findLast((item) => item.message?.customType === GOAL_CONTINUATION_MESSAGE_TYPE);

  harness.runtime.onAgentStart(harness.ctx);
  activeSubagents = true;
  harness.setIdle(true);
  const entries = goalStateEntries(harness.branch).length;
  harness.runtime.onAgentEnd({ messages: [{ role: "assistant", stopReason: "aborted" }] });
  harness.runtime.onAgentSettled(harness.ctx);
  assert.equal(harness.runtime.status().status, "active");
  assert.equal(harness.runtime.status().noProgressCount, 1);
  assert.equal(goalStateEntries(harness.branch).length, entries);
  assert.equal(harness.sent.some((item) => item.message?.customType === GOAL_STATE_MESSAGE_TYPE), false);
  assert.equal(harness.timers.length, 0);
  harness.flush();
  assert.equal(harness.sent.filter((item) => item.message?.customType === GOAL_CONTINUATION_MESSAGE_TYPE).length, 2);

  activeSubagents = false;
  harness.runtime.notePackageLifecycleChange();
  harness.flush();
  const resumedContinuation = harness.sent.findLast((item) => item.message?.customType === GOAL_CONTINUATION_MESSAGE_TYPE);
  assert.equal(harness.sent.filter((item) => item.message?.customType === GOAL_CONTINUATION_MESSAGE_TYPE).length, 3);
  assert.notEqual(resumedContinuation.message.details.deliveryKey, oldContinuation.message.details.deliveryKey);
  assert.equal(harness.runtime.status().status, "active");
  assert.equal(harness.runtime.status().noProgressCount, 1);
});

test("no-progress counts only automatic continuation runs", async () => {
  const stalled = createHarness();
  await stalled.execute(createInput);
  for (let round = 0; round < 3; round += 1) {
    stalled.setIdle(true);
    stalled.runtime.onAgentSettled(stalled.ctx);
    stalled.flush();
    const continuation = stalled.sent.findLast((item) => item.message?.customType === GOAL_CONTINUATION_MESSAGE_TYPE);
    stalled.appendContinuation(continuation.message);
    stalled.runtime.acknowledgeContinuationMessage({ role: "custom", ...continuation.message });
    stalled.runtime.onAgentStart(stalled.ctx);
    stalled.runtime.onAgentEnd({ messages: [{ role: "assistant", stopReason: "stop" }] });
    stalled.setIdle(true);
    stalled.runtime.onAgentSettled(stalled.ctx);
    if (round < 2) stalled.flush();
  }
  assert.equal(stalled.runtime.status().status, "paused");
  assert.equal(stalled.runtime.status().pauseReason, "no_progress");
  assert.equal(stalled.runtime.status().noProgressCount, 3);
});

test("ownership and Goal view stats stay private from status and derive from branch/provider usage", async () => {
  const harness = createHarness({
    childStats: (ids) => ({ runCount: ids.length, tokens: 40, tools: 4, turns: 3, compactions: 1 }),
  });
  await harness.execute(createInput);
  harness.runtime.ownRun("child-1");
  harness.appendMessage({
    role: "assistant",
    content: [{ type: "toolCall", id: "t1", name: "read", arguments: {} }],
    usage: { input: 10, output: 2, cacheRead: 3, cacheWrite: 1 },
    stopReason: "toolUse",
  });
  harness.appendMessage({ role: "toolResult", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } });
  harness.branch.push({ type: "compaction", id: "cmp", parentId: harness.branch.at(-1).id, usage: { input: 5, output: 1, cacheRead: 0, cacheWrite: 0 } });
  harness.runtime.refreshUI();
  const view = harness.runtime.goalView();
  assert.equal(view.ownedChildRunCount, 1);
  assert.deepEqual(view.children, { runCount: 1, tokens: 40, tools: 4, turns: 3, compactions: 1 });
  assert.deepEqual(view.main, { tokens: 24, tools: 1, turns: 1, compactions: 1 });
  assert.deepEqual(publicKeys(harness.runtime.status()), PUBLIC_STATUS_KEYS);
  assert.equal("ownedRunIds" in harness.runtime.status(), false);
  assert.equal("continuationCount" in harness.runtime.status(), false);

  const stats = deriveMainGoalStats(harness.branch, harness.branch.find((entry) => entry.customType === GOAL_STATE_ENTRY_TYPE).data.instanceKey);
  assert.deepEqual(stats, view.main);
});

test("slash command resends a real user message with idle and busy steer semantics", async () => {
  const harness = createHarness();
  const command = harness.commands.get("goal");
  assert.equal(command.description, "Forward a goal request to the model.");
  await command.handler("", { isIdle: () => true });
  await command.handler("  ship it", { isIdle: () => false });
  assert.deepEqual(harness.sent.slice(-2), [
    { user: "/goal", options: { expandPromptTemplates: false } },
    { user: "/goal   ship it", options: { deliverAs: "steer", expandPromptTemplates: false } },
  ]);
});

function goalStateEntries(branch) {
  return branch.filter((entry) => entry.type === "custom" && entry.customType === GOAL_STATE_ENTRY_TYPE);
}

function tombstone() {
  return { type: "custom", customType: GOAL_STATE_ENTRY_TYPE, data: null };
}

test("clear is a no-op with no Goal and never appends a tombstone", async () => {
  const harness = createHarness();
  const entries = harness.branch.length;
  const cleared = await harness.execute({ action: "clear" });
  assert.deepEqual(resultDto(cleared), { status: "none" });
  assert.deepEqual(cleared.details, { goal: null, changed: false });
  assert.equal(harness.branch.length, entries);
  assert.equal(harness.runtime.status(), null);

  const again = await harness.execute({ action: "clear" });
  assert.deepEqual(again.details, { goal: null, changed: false });
  assert.equal(harness.branch.length, entries);
});

test("clear erases an active, paused, or completed Goal through a null tombstone", async () => {
  for (const stopped of [
    { action: undefined, status: "active" },
    { action: "pause", status: "paused" },
    { action: "complete", evidence: ["proof one", "proof two"], status: "completed" },
  ]) {
    const harness = createHarness();
    await harness.execute(createInput);
    if (stopped.action) {
      const ended = await harness.execute({ action: stopped.action, ...(stopped.evidence ? { evidence: stopped.evidence } : {}) });
      assert.equal(ended.details.goal.status, stopped.status);
    }
    const before = goalStateEntries(harness.branch).length;

    const cleared = await harness.execute({ action: "clear" });
    assert.deepEqual(resultDto(cleared), { status: "none" });
    assert.deepEqual(cleared.details, { goal: null, changed: true });
    const stateEntries = goalStateEntries(harness.branch);
    assert.equal(stateEntries.length, before + 1);
    const last = stateEntries.at(-1);
    assert.equal(last.customType, GOAL_STATE_ENTRY_TYPE);
    assert.equal(last.data, null);
    assert.equal(harness.runtime.status(), null);
    assert.equal(harness.runtime.isActive(), false);
    const view = harness.runtime.goalView();
    assert.equal(view.goal, null);
    assert.equal(view.elapsedMs, null);
    assert.equal(view.continuationCount, 0);
    assert.equal(view.ownedChildRunCount, 0);
    assert.deepEqual(view.main, { tokens: 0, tools: 0, turns: 0, compactions: 0 });
    assert.deepEqual(view.children, { runCount: 0, tokens: 0, tools: 0, turns: 0, compactions: 0 });

    const repeat = await harness.execute({ action: "clear" });
    assert.deepEqual(repeat.details, { goal: null, changed: false });
    assert.equal(goalStateEntries(harness.branch).length, before + 1);
  }
});

test("clear erases a retry_wait Goal and clears its timer", async () => {
  const retrying = createHarness();
  await retrying.execute(createInput);
  retrying.runtime.onAgentStart(retrying.ctx);
  retrying.runtime.onAgentEnd({ messages: [{ role: "assistant", stopReason: "error", errorMessage: "rate limited" }] });
  retrying.setIdle(false);
  retrying.runtime.onAgentSettled(retrying.ctx);
  assert.equal(retrying.runtime.status().status, "retry_wait");
  const retryEntries = retrying.branch.length;
  const retryTimer = retrying.timers.at(-1);
  const cleared = await retrying.execute({ action: "clear" });
  assert.deepEqual(resultDto(cleared), { status: "none" });
  assert.equal(retrying.branch.length, retryEntries + 1);
  assert.equal(retrying.runtime.status(), null);
  assert.equal(retryTimer.cleared, true);
  assert.equal(goalStateEntries(retrying.branch).at(-1).data, null);
});

test("replay and stats treat only an exact null payload as an erasure", async () => {
  const harness = createHarness();
  await harness.execute(createInput);
  const first = structuredClone(goalStateEntries(harness.branch).at(-1).data);
  await harness.execute({ action: "complete", evidence: ["proof one", "proof two"] });
  const completed = structuredClone(goalStateEntries(harness.branch).at(-1).data);
  const second = { ...structuredClone(first), instanceKey: "instance-2" };

  assert.equal(isGoalTombstoneData(null), true);
  for (const notTombstone of [undefined, {}, [], 0, false, "", "null", "undefined", { data: null }]) {
    assert.equal(isGoalTombstoneData(notTombstone), false);
  }

  assert.equal(replayGoalBranch([{ type: "custom", customType: GOAL_STATE_ENTRY_TYPE, data: completed }, tombstone()]), undefined);
  assert.equal(replayGoalBranch([
    { type: "custom", customType: GOAL_STATE_ENTRY_TYPE, data: completed },
    tombstone(),
    { type: "custom", customType: GOAL_STATE_ENTRY_TYPE, data: second },
  ]).instanceKey, "instance-2");
  assert.equal(replayGoalBranch([
    { type: "custom", customType: GOAL_STATE_ENTRY_TYPE, data: second },
    tombstone(),
    { type: "custom", customType: GOAL_STATE_ENTRY_TYPE, data: { bad: true } },
  ]), undefined);

  // Malformed null-like payloads stay ordinary ignorable entries and never erase the live Goal.
  for (const malformed of [undefined, {}, [], 0, false, "", "null", { version: 1, goal: null }]) {
    const replayed = replayGoalBranch([
      { type: "custom", customType: GOAL_STATE_ENTRY_TYPE, data: first },
      { type: "custom", customType: GOAL_STATE_ENTRY_TYPE, data: malformed },
    ]);
    assert.equal(replayed?.instanceKey, first.instanceKey);
  }
  assert.equal(replayGoalBranch([
    { type: "custom", customType: GOAL_STATE_ENTRY_TYPE, data: first },
    { type: "custom_message", customType: GOAL_STATE_ENTRY_TYPE, data: null },
  ])?.instanceKey, first.instanceKey);

  const usage = { input: 10, output: 0, cacheRead: 0, cacheWrite: 0 };
  const leaked = [
    { type: "custom", customType: GOAL_STATE_ENTRY_TYPE, data: first },
    { type: "message", message: { role: "assistant", content: [], usage, stopReason: "stop" } },
    tombstone(),
    { type: "message", message: { role: "assistant", content: [], usage: { ...usage, input: 99 }, stopReason: "stop" } },
    { type: "compaction", usage: { ...usage, input: 7 } },
  ];
  assert.deepEqual(deriveMainGoalStats(leaked, first.instanceKey), { tokens: 10, tools: 0, turns: 1, compactions: 0 });
});

test("restoring a cleared branch yields no Goal and writes nothing new", async () => {
  const source = createHarness();
  await source.execute(createInput);
  const snapshot = structuredClone(goalStateEntries(source.branch).at(-1).data);

  const restored = createHarness();
  restored.branch.push({ type: "custom", customType: GOAL_STATE_ENTRY_TYPE, data: snapshot }, tombstone());
  const entries = restored.branch.length;
  const sent = restored.sent.length;
  restored.runtime.restore(restored.ctx, true);
  assert.equal(restored.runtime.status(), null);
  assert.equal(restored.branch.length, entries);
  assert.equal(restored.sent.length, sent);
  assert.equal(restored.timers.length, 0);

  restored.runtime.refreshFromBranch(restored.ctx);
  assert.equal(restored.runtime.status(), null);
  assert.equal(restored.branch.length, entries);
});

test("clear notifies subscribers and the widget with a null Goal without an automatic state message", async () => {
  let notificationPaused = true;
  const harness = createHarness({ notificationPaused: () => notificationPaused });
  const observed = [];
  const unsubscribe = harness.runtime.subscribe((goal) => observed.push(goal === null ? null : goal.status));
  assert.deepEqual(observed, [null]);

  await harness.execute(createInput);
  assert.equal(observed.at(-1), "active");
  const stateMessages = harness.sent.filter((item) => item.message?.customType === GOAL_STATE_MESSAGE_TYPE).length;
  await harness.execute({ action: "clear" });
  assert.equal(observed.at(-1), null);
  assert.equal(harness.sent.filter((item) => item.message?.customType === GOAL_STATE_MESSAGE_TYPE).length, stateMessages);

  notificationPaused = false;
  harness.runtime.setDeliveryPaused(false);
  assert.equal(harness.sent.filter((item) => item.message?.customType === GOAL_STATE_MESSAGE_TYPE).length, stateMessages);
  assert.equal(harness.runtime.status(), null);
  unsubscribe();
});

test("clearing a paused Goal drops deferred continuation work", async () => {
  const harness = createHarness();
  await harness.execute(createInput);
  harness.runtime.onAgentSettled(harness.ctx);
  assert.equal(harness.deferred.length, 1);

  await harness.execute({ action: "pause" });
  await harness.execute({ action: "clear" });

  // The deferred continuation captured before the pause must expire instead of steering a dead Goal.
  const sentBefore = harness.sent.length;
  while (harness.deferred.length > 0) harness.flush();
  assert.equal(harness.sent.length, sentBefore);
  assert.equal(harness.sent.some((item) => item.message?.customType === GOAL_CONTINUATION_MESSAGE_TYPE), false);
  assert.equal(harness.runtime.status(), null);

  harness.runtime.onAgentStart(harness.ctx);
  harness.runtime.onAgentEnd({ messages: [{ role: "assistant", stopReason: "stop" }] });
  harness.runtime.onAgentSettled(harness.ctx);
  assert.equal(harness.runtime.status(), null);
  assert.equal(harness.deferred.length, 0);
});

test("a Goal created after a clear is a fresh instance whose stats exclude the cleared Goal", async () => {
  const keys = ["instance-1", "instance-2"];
  let created = 0;
  const harness = createHarness({ randomKey: () => keys[Math.min(created++, keys.length - 1)] });
  await harness.execute(createInput);
  harness.runtime.ownRun("child-1");
  harness.appendMessage({
    role: "assistant",
    content: [{ type: "toolCall", id: "t1", name: "read", arguments: {} }],
    usage: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0 },
    stopReason: "toolUse",
  });
  harness.runtime.refreshUI();
  assert.deepEqual(harness.runtime.goalView().main, { tokens: 100, tools: 1, turns: 1, compactions: 0 });

  await harness.execute({ action: "complete", evidence: ["proof one", "proof two"] });
  await harness.execute({ action: "clear" });

  const replacement = await harness.execute({ ...createInput, abstract: "Second Goal" });
  assert.equal(replacement.details.goal.status, "active");
  assert.equal(replacement.details.goal.abstract, "Second Goal");
  assert.equal(replacement.details.changed, true);
  const snapshots = goalStateEntries(harness.branch).filter((entry) => entry.data !== null);
  assert.equal(snapshots.at(-1).data.instanceKey, "instance-2");
  assert.equal(snapshots.at(-1).data.generation, 1);
  assert.deepEqual(snapshots.at(-1).data.ownedRunIds, []);

  harness.appendMessage({
    role: "assistant",
    content: [],
    usage: { input: 5, output: 0, cacheRead: 0, cacheWrite: 0 },
    stopReason: "stop",
  });
  harness.runtime.refreshUI();
  assert.deepEqual(harness.runtime.goalView().main, { tokens: 5, tools: 0, turns: 1, compactions: 0 });
  assert.equal(harness.runtime.goalView().ownedChildRunCount, 0);
  assert.equal(harness.runtime.goalView().continuationCount, 0);
  assert.deepEqual(deriveMainGoalStats(harness.branch, "instance-2"), { tokens: 5, tools: 0, turns: 1, compactions: 0 });
  assert.deepEqual(deriveMainGoalStats(harness.branch, "instance-1"), { tokens: 100, tools: 1, turns: 1, compactions: 0 });
});
