import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { registerHooks } from "node:module";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";
import test from "node:test";

const piEntry = realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim());
const piRoot = dirname(dirname(piEntry));
const dependencyMap = {
  "@earendil-works/pi-coding-agent": pathToFileURL(`${piRoot}/dist/index.js`).href,
  "@earendil-works/pi-tui": pathToFileURL(`${piRoot}/node_modules/@earendil-works/pi-tui/dist/index.js`).href,
  typebox: pathToFileURL(`${piRoot}/node_modules/typebox/build/index.mjs`).href,
  "./goal-transcript-renderer.js": new URL("../extensions/oh-my-pi-slim/goal-transcript-renderer.ts", import.meta.url).href,
  "./goal-widget.js": new URL("../extensions/oh-my-pi-slim/goal-widget.ts", import.meta.url).href,
  "./goal-runtime.js": new URL("../extensions/oh-my-pi-slim/goal-runtime.ts", import.meta.url).href,
  "./semantic-glyph.js": new URL("../extensions/oh-my-pi-slim/semantic-glyph.ts", import.meta.url).href,
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    const url = dependencyMap[specifier];
    return url ? { url, shortCircuit: true } : nextResolve(specifier, context);
  },
});

const {
  GOAL_ACTIONS,
  GOAL_CONTINUATION_MESSAGE_TYPE,
  GOAL_PUBLIC_FIELDS,
  GOAL_RETRY_BACKOFF_MS,
  GOAL_STATE_ENTRY_TYPE,
  GoalRuntime,
  deriveMainGoalStats,
  goalActivationContent,
  goalContinuationContent,
  goalParameters,
  goalPhaseReminder,
  parseGoalContinuationMessageDetails,
  parseGoalSnapshot,
  replayGoalBranch,
  retryDelayMs,
} = await import("../extensions/oh-my-pi-slim/goal-runtime.ts");

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
    nowMs: () => now,
    randomKey: () => options.randomKey ?? "instance-1",
    defer: (callback) => deferred.push(callback),
    setTimeout(callback, milliseconds) {
      const timer = { callback, milliseconds, cleared: false, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimeout(timer) { timer.cleared = true; },
    hasPendingCheckpoint: () => options.pendingCheckpoint?.() ?? false,
    isNotificationDeliveryPaused: () => options.notificationPaused?.() ?? false,
    hasActiveSubagents: () => options.activeSubagents?.() ?? false,
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

const createInput = {
  action: "create",
  abstract: "Ship the Goal core",
  objective: "Implement the frozen nonvisual Goal behavior.",
  criteria: ["Schema is strict", "Continuation is gated"],
};

function publicKeys(goal) {
  return Object.keys(goal).sort();
}

const PUBLIC_STATUS_KEYS = [
  "status", "abstract", "objective", "criteria", "createdAt", "updatedAt", "endedAt", "pauseReason",
  "retryAttempt", "nextRetryAt", "lastProviderError", "noProgressCount", "evidence", "cancelReason",
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
  assert.equal(tool.description, "Create and manage one durable branch-local Goal with autonomous continuation and explicit completion evidence. Restored unfinished Goals remain paused until resumed.");
  assert.equal(tool.promptSnippet, "Manage one durable branch-local Goal.");
  assert.deepEqual(tool.promptGuidelines, [
    "Create a Goal with `goal create` only from a user message that starts with `/goal`.",
    "For a bare `/goal`, call `goal status` and explain `/goal <objective>`.",
    "Treat an active Goal as one durable contract, not as a `todo` checklist.",
    "Continue an active Goal autonomously until completion or a blocker requires `goal pause`.",
    "Let Goal continuation wait while subagents, monitors, Ask, pending messages, or user input require attention.",
    "Prioritize resolving Goal blockers before unrelated work.",
    "Expect provider failures during a Goal to enter `retry_wait` automatically.",
    "Expect repeated automatic Goal runs without progress to pause the Goal for review.",
    "Use `goal status` to inspect the branch-local Goal without changing it.",
    "Use `goal modify` when the complete objective or completion contract must be replaced.",
    "Use `goal pause` when safe progress cannot continue.",
    "Expect a user abort to pause the active Goal rather than cancel it.",
    "Use `goal resume` when a paused Goal can continue autonomously.",
    "Treat restored unfinished Goals as paused until `goal resume` explicitly restarts them.",
    "Use `goal cancel` only when the user explicitly abandons the Goal.",
    "Use `goal complete` only after every criterion has concrete evidence.",
  ]);
  assert.equal(schema.properties.action.description, "Select the Goal action. Create and modify use abstract, objective, and criteria. Pause and cancel use reason. Complete uses evidence. Status and resume use no other fields.");
  for (const invalid of [
    { ...createInput, reason: "extra" },
    { action: "status", evidence: [] },
    { action: "pause" },
    { action: "complete" },
    { action: "resume", reason: "extra" },
  ]) await assert.rejects(harness.execute(invalid));
  await assert.rejects(harness.execute({ ...createInput, criteria: [] }), /from 1 through 8/);
  await assert.rejects(harness.execute({ ...createInput, criteria: ["ok", "   "] }), /non-empty/);
});

test("create, modify, terminal replacement, evidence, and no-op receipts preserve the frozen business contract", async () => {
  const harness = createHarness();
  const none = await harness.execute({ action: "status" });
  assert.deepEqual(none.details, { goal: null, changed: false });
  assert.equal(none.content[0].text, "No Goal.");

  const created = await harness.execute(createInput);
  assert.equal(created.details.goal.status, "active");
  assert.deepEqual(publicKeys(created.details.goal), PUBLIC_STATUS_KEYS);
  assert.equal(created.content[0].text, goalActivationContent("created", created.details.goal));
  const exactActivation = [
    "Goal created and active.",
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
    "Pursue this Goal now.",
    "Do not ask the user questions while this Goal is active.",
    "Continue until every criterion has concrete evidence.",
    "Use Todo, Monitor, and Subagents when useful.",
    "If safe progress is blocked, call `goal pause` with a concrete reason.",
    "Call `goal complete` only with one evidence entry for every criterion.",
  ].join("\n");
  assert.equal(created.content[0].text, exactActivation);
  assert.equal(goalActivationContent("modified", created.details.goal), exactActivation.replace("Goal created and active.", "Goal modified and active."));
  assert.equal(goalActivationContent("resumed", created.details.goal), exactActivation.replace("Goal created and active.", "Goal resumed and active."));
  await assert.rejects(harness.execute(createInput), /no Goal or a terminal Goal/);
  harness.runtime.ownRun("owned-before-modify");

  const paused = await harness.execute({ action: "pause", reason: "blocked" });
  assert.equal(paused.details.goal.status, "paused");
  assert.equal(paused.details.goal.pauseReason, "blocked");
  const pausedAgain = await harness.execute({ action: "pause", reason: "ignored" });
  assert.equal(pausedAgain.details.changed, false);
  assert.match(pausedAgain.content[0].text, /No change/);

  const modified = await harness.execute({
    action: "modify", abstract: "Updated", objective: "Updated objective", criteria: ["One"],
  });
  assert.equal(modified.details.goal.status, "active");
  assert.equal(modified.details.goal.createdAt, created.details.goal.createdAt);
  assert.equal(harness.runtime.goalView().ownedChildRunCount, 1);
  assert.equal(modified.details.goal.pauseReason, null);
  assert.equal(modified.content[0].text, goalActivationContent("modified", modified.details.goal));

  await assert.rejects(harness.execute({ action: "complete", evidence: ["one", "two"] }), /exactly 1 items/);
  const completed = await harness.execute({ action: "complete", evidence: ["proof"] });
  assert.equal(completed.details.goal.status, "completed");
  assert.deepEqual(completed.details.goal.evidence, ["proof"]);
  assert.ok(completed.details.goal.endedAt);
  await assert.rejects(harness.execute({ action: "resume" }), /terminal/);
  await assert.rejects(harness.execute({ action: "cancel", reason: "late" }), /terminal/);

  const replacement = await harness.execute({ ...createInput, abstract: "Replacement" });
  assert.equal(replacement.details.goal.status, "active");
  assert.notEqual(replacement.details.goal.createdAt, undefined);
  assert.equal(harness.runtime.goalView().ownedChildRunCount, 0);
});

test("status and repeated pause or resume no-ops do not append snapshots or mutate state", async () => {
  const harness = createHarness();
  await harness.execute(createInput);
  const afterCreate = harness.branch.length;
  const activeBefore = structuredClone(harness.runtime.status());
  await harness.execute({ action: "status" });
  await harness.execute({ action: "resume" });
  assert.equal(harness.branch.length, afterCreate);
  assert.deepEqual(harness.runtime.status(), activeBefore);

  await harness.execute({ action: "pause", reason: "blocked" });
  const afterPause = harness.branch.length;
  const pausedBefore = structuredClone(harness.runtime.status());
  await harness.execute({ action: "status" });
  await harness.execute({ action: "pause", reason: "different ignored reason" });
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

test("phase and model-facing continuation text use exact independent blocks", async () => {
  const harness = createHarness();
  const created = await harness.execute(createInput);
  const goal = created.details.goal;
  assert.equal(goalPhaseReminder(goal.abstract), `<system-reminder>\n!IMPORTANT! You are pursuing the active Goal: Ship the Goal core. Keep this run aligned with it and continue making concrete progress. !END!\n</system-reminder>`);
  assert.equal(harness.runtime.phaseReminder(), goalPhaseReminder(goal.abstract));
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
    "Use Todo, Monitor, and Subagents when useful.",
    "If safe progress is blocked, call `goal pause` with a concrete reason.",
    "Call `goal complete` only with one evidence entry for every criterion.",
  ].join("\n"));
  await harness.execute({ action: "pause", reason: "blocker" });
  assert.equal(harness.runtime.phaseReminder(), undefined);
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

test("provider failures use unbounded frozen backoff, timer-safe activation, and success reset", async () => {
  const harness = createHarness();
  await harness.execute(createInput);
  harness.runtime.onAgentStart();
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
  harness.runtime.onAgentStart();
  harness.runtime.onAgentEnd({ messages: [{ role: "assistant", stopReason: "stop", usage: {} }] });
  harness.setIdle(true);
  harness.runtime.onAgentSettled(harness.ctx);
  assert.equal(harness.runtime.status().status, "active");
  assert.equal(harness.runtime.status().retryAttempt, 0);
  assert.equal(harness.runtime.status().lastProviderError, null);
});

test("user abort pauses, host abort does not, and no-progress counts only automatic continuation runs", async () => {
  const userAbort = createHarness();
  await userAbort.execute(createInput);
  userAbort.runtime.onAgentStart();
  userAbort.runtime.onAgentEnd({ messages: [{ role: "assistant", stopReason: "aborted" }] });
  userAbort.runtime.onAgentSettled(userAbort.ctx);
  assert.equal(userAbort.runtime.status().status, "paused");
  assert.equal(userAbort.runtime.status().pauseReason, "user_abort");

  const hostAbort = createHarness();
  await hostAbort.execute(createInput);
  hostAbort.runtime.onAgentStart();
  hostAbort.runtime.markHostAbort();
  hostAbort.runtime.onAgentEnd({ messages: [{ role: "assistant", stopReason: "aborted" }] });
  hostAbort.runtime.onAgentSettled(hostAbort.ctx, { suppressContinuation: true });
  assert.equal(hostAbort.runtime.status().status, "active");

  const stalled = createHarness();
  await stalled.execute(createInput);
  for (let round = 0; round < 3; round += 1) {
    stalled.setIdle(true);
    stalled.runtime.onAgentSettled(stalled.ctx);
    stalled.flush();
    const continuation = stalled.sent.findLast((item) => item.message?.customType === GOAL_CONTINUATION_MESSAGE_TYPE);
    stalled.appendContinuation(continuation.message);
    stalled.runtime.acknowledgeContinuationMessage({ role: "custom", ...continuation.message });
    stalled.runtime.onAgentStart();
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
