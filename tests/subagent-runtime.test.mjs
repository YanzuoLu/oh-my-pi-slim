import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { registerHooks } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
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
  CHECKPOINT_RESUME_TEXT,
  completedToolBatch,
  contextUsageNeedsCheckpoint,
} = await import("../extensions/oh-my-pi-slim/subagent-checkpoint.ts");
const {
  SUBAGENT_ACTIONS,
  SUBAGENT_PUBLIC_FIELDS,
  SubagentRegistry,
  legacyRunAbstract,
  restoreRunJournal,
  runJournalEntry,
  sortRetainedSubagentRuns,
  validateCreateInput,
} = await import("../extensions/oh-my-pi-slim/subagent-core.ts");
const {
  OmpsSubagentRuntime,
  discoverPackageAgents,
  shouldApproveChildProject,
  subagentParameters,
} = await import("../extensions/oh-my-pi-slim/subagent-runtime.ts");
const {
  NotificationDeliveryPauseGate,
  parseConfigFile,
  parseDenyConfig,
  supportsImageInput,
} = await import("../extensions/oh-my-pi-slim/index.ts");
const {
  atomicWriteJson,
  getGoalStatsRoot,
  getGoalStatsSidecarPaths,
  getProcessIdentity,
  getRunPaths,
  getRunRoot,
  isDetachedLaunchConfig,
  isDetachedRunnerIdentity,
  listOwnerRunIds,
  readGoalStatsSidecar,
  readLaunchConfig,
  removeChildSessionFile,
  removeRunFiles,
  safeReadJson,
  writeControl,
  writeGoalStatsSidecar,
} = await import("../extensions/oh-my-pi-slim/subagent-run-files.ts");
const { resetWidgetStackHost } = await import("../extensions/oh-my-pi-slim/widget-stack-host.ts");
const {
  MAX_SUBAGENT_WIDGET_LINES,
  renderSubagentWidgetLines,
} = await import("../extensions/oh-my-pi-slim/subagent-widget-renderer.ts");

// The aggregate widget host is a process-wide singleton, so every test starts from an empty one.
beforeEach(() => resetWidgetStackHost());

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CACHE = join(ROOT, ".cache");
const NOW_MS = Date.parse("2026-04-17T00:00:00.000Z");

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

function assertStePromptGuidelines(guidelines) {
  assert.ok(Array.isArray(guidelines));
  for (const guideline of guidelines) {
    assert.equal(guideline.split(/(?<=[.!?])\s+/).filter(Boolean).length, 1, `STE guideline must contain one sentence: ${guideline}`);
    assertSteSentence(guideline);
  }
}
const transcriptTheme = {
  fg: (_color, text) => text,
  bg: (_color, text) => text,
  bold: (text) => text,
};
mkdirSync(CACHE, { recursive: true });

function persistedRun(overrides = {}) {
  return {
    id: "run-1",
    agent: "fixer",
    abstract: "fix summary",
    task: "fix it",
    cwd: ROOT,
    model: "provider/model:high",
    deniedTools: [],
    status: "running",
    createdAt: "2026-04-16T23:59:00.000Z",
    updatedAt: "2026-04-16T23:59:00.000Z",
    ...overrides,
  };
}

function branchEntry(data) {
  return { type: "custom", customType: "oh-my-pi-slim:subagents", data };
}

function goalBranchEntry(ownedRunIds, instanceKey = "goal-instance") {
  return {
    type: "custom",
    customType: "oh-my-pi-slim:goal-state",
    data: {
      version: 1,
      instanceKey,
      generation: 1,
      goal: {
        status: "active",
        abstract: "goal abstract",
        objective: "goal objective",
        criteria: ["one criterion"],
        createdAt: "2026-04-16T23:00:00.000Z",
        updatedAt: "2026-04-16T23:00:00.000Z",
        endedAt: null,
        pauseReason: null,
        retryAttempt: 0,
        nextRetryAt: null,
        lastProviderError: null,
        noProgressCount: 0,
        evidence: null,
        cancelReason: null,
      },
      ownedRunIds: [...ownedRunIds],
    },
  };
}

function seedTerminalRun(harness, overrides = {}) {
  const run = persistedRun({ status: "completed", output: "final output", ...overrides });
  harness.runtime.registry.add(run, false);
  mkdirSync(harness.paths(run.id).controlDir, { recursive: true, mode: 0o700 });
  return run;
}

async function clear(harness) {
  return harness.tools.get("subagent").execute("clear", { action: "clear" });
}

async function deleteRun(harness, id) {
  return harness.tools.get("subagent").execute("delete", { action: "delete", id });
}

function notificationBranchEntry(message) {
  return {
    type: "custom_message",
    customType: message.customType,
    content: message.content,
    display: message.display,
    details: message.details,
  };
}

function deliveredMessage(message, details = message.details) {
  return { role: "custom", customType: message.customType, content: message.content, display: message.display, details };
}

function expectedDeliveryKey(runId, event, waitingSeq) {
  const parts = event === "waiting" ? [runId, event, waitingSeq] : [runId, event];
  return `oh-my-pi-slim:subagent-notification:${JSON.stringify(parts)}`;
}

function createHarness({
  branch = [],
  ownerSessionId = "owner-a",
  mode = "rpc",
  trusted = true,
  shutdownWaitMs = 0,
  interruptWaitMs = 0,
  sleep = async () => {},
  sendMessageError,
  launchError,
  keepAliveAfterKill = false,
  keepAliveAfterTerm = false,
  rejectGroupSignal = false,
  readGoalStats,
  writeGoalStats,
  onJournalWrite,
} = {}) {
  const tempDir = mkdtempSync(join(CACHE, "runtime-harness-"));
  chmodSync(tempDir, 0o700);
  const sessionDir = join(tempDir, "sessions");
  mkdirSync(sessionDir, { recursive: true });
  let clock = NOW_MS;
  const tools = new Map();
  const messageRenderers = new Map();
  const notifications = [];
  const journalWrites = [];
  const launches = [];
  const intervals = [];
  const clearedIntervals = [];
  const killed = [];
  const controlWrites = [];
  const alive = new Set();
  const processIdentities = new Map();
  const widgetCalls = [];
  const pi = {
    registerTool(definition) { tools.set(definition.name, definition); },
    registerMessageRenderer(type, renderer) { messageRenderers.set(type, renderer); },
    appendEntry(type, data) {
      journalWrites.push({ type, data });
      onJournalWrite?.({ type, data });
    },
    sendMessage(message, options) {
      if (sendMessageError) throw sendMessageError;
      notifications.push({ message, options });
    },
  };
  const runtime = new OmpsSubagentRuntime(pi, {
    now: () => new Date(clock).toISOString(),
    nowMs: () => clock,
    pollMs: 250,
    graceMs: 5000,
    shutdownWaitMs,
    interruptWaitMs,
    invocationSeams: { argv: ["pi", "/missing/pi.js"], execPath: "/usr/bin/node", exists: () => false },
    async launchRunner(configFile, runnerPath, options) {
      launches.push({ configFile, runnerPath, options });
      if (launchError) throw launchError;
      return { pid: 999, invocation: { command: process.execPath, args: [runnerPath] } };
    },
    getProcessIdentity(pid) {
      return processIdentities.has(pid) ? processIdentities.get(pid) : `process-${pid}`;
    },
    pidAlive: (pid) => alive.has(pid),
    killPid(pid, signal) {
      killed.push({ pid, signal });
      if (rejectGroupSignal && pid < 0) throw new Error("group signaling unavailable");
      if (!keepAliveAfterKill && !(keepAliveAfterTerm && signal === "SIGTERM")) alive.delete(Math.abs(pid));
    },
    controlWriter(paths, token, type, message, waitingSeq) {
      controlWrites.push({ runId: paths.runDir.split("/").at(-1), token, type, message, waitingSeq });
      return writeControl(paths, token, type, message, waitingSeq);
    },
    setInterval(callback, ms) {
      const timer = { callback, ms, unref() {} };
      intervals.push(timer);
      return timer;
    },
    clearInterval(timer) { clearedIntervals.push(timer); },
    sleep,
    readGoalStats,
    writeGoalStats,
  });
  runtime.registerTools();
  const ui = {
    setWidget(key, content, options) { widgetCalls.push({ key, content, options }); },
  };
  const ctx = {
    cwd: ROOT,
    mode,
    hasUI: true,
    ui,
    isProjectTrusted: () => trusted,
    sessionManager: {
      getBranch: () => branch,
      getSessionDir: () => sessionDir,
      getSessionId: () => ownerSessionId,
    },
  };
  return {
    tempDir, sessionDir, ownerSessionId, runtime, tools, messageRenderers, notifications, journalWrites, launches,
    intervals, clearedIntervals, alive, killed, controlWrites, widgetCalls, ctx,
    advance(ms) { clock += ms; },
    setProcessIdentity(pid, identity) { processIdentities.set(pid, identity); },
    paths(id, owner = ownerSessionId) { return getRunPaths(getRunRoot(sessionDir), owner, id); },
    async restore(notificationDeliveryPaused = false) { await runtime.restore(ctx, notificationDeliveryPaused); },
    cleanup() { rmSync(tempDir, { recursive: true, force: true }); },
  };
}

function stateFor(runId, token, overrides = {}) {
  return {
    v: 1,
    token,
    runId,
    pid: 999,
    heartbeatAt: new Date(NOW_MS).toISOString(),
    status: "running",
    updatedAt: new Date(NOW_MS).toISOString(),
    turnCount: 1,
    toolUses: 0,
    activeTools: {},
    responseText: "",
    tokens: 0,
    compactionCount: 0,
    ...overrides,
  };
}

function readConfig(harness, id) {
  return safeReadJson(harness.paths(id).configFile, isDetachedLaunchConfig);
}

function controls(harness, id) {
  const paths = harness.paths(id);
  try {
    return readdirSync(paths.controlDir).sort().map((name) => JSON.parse(readFileSync(join(paths.controlDir, name), "utf8")));
  } catch {
    return [];
  }
}

async function createRun(harness, overrides = {}) {
  harness.runtime.setModelResolver((agent) => `preset/${agent}:high`);
  harness.runtime.setDenyResolver(() => []);
  return harness.tools.get("subagent").execute("create", {
    action: "create", agent: "fixer", abstract: "detached summary", task: "detached task", ...overrides,
  });
}

/** Interrupt harness with a single-shot sleep hook, so one deterministic event lands inside the interrupt wait window. */
function createInterruptHarness(options = {}) {
  let sleepHook;
  let harness;
  harness = createHarness({
    interruptWaitMs: 50,
    sleep: async (ms) => {
      const hook = sleepHook;
      sleepHook = undefined;
      hook?.();
      harness.advance(ms);
    },
    ...options,
  });
  harness.onNextSleep = (hook) => { sleepHook = hook; };
  harness.takeSleepHook = () => {
    const hook = sleepHook;
    sleepHook = undefined;
    return hook;
  };
  return harness;
}

async function startRunningRun(harness, overrides = {}) {
  const started = await createRun(harness);
  const id = started.details.run.id;
  const config = readConfig(harness, id);
  harness.alive.add(999);
  atomicWriteJson(harness.paths(id).stateFile, stateFor(id, config.token, typeof overrides === "function" ? overrides(id) : overrides));
  await inspect(harness, id);
  return { id, config };
}

async function interrupt(harness, id, signal) {
  return harness.tools.get("subagent").execute("interrupt", { action: "interrupt", id }, signal);
}

async function settleTerminations(harness) {
  for (let attempt = 0; attempt < 50 && harness.runtime.terminating.size > 0; attempt += 1) {
    await Promise.all([...harness.runtime.terminating.values()].map((promise) => promise.catch(() => undefined)));
  }
  await new Promise((resolve) => setImmediate(resolve));
}

async function inspect(harness, id) {
  await harness.tools.get("subagent").execute("list", { action: "list" });
  const run = harness.runtime.registry.require(id);
  return {
    ...run,
    live: harness.runtime.registry.isLive(id),
    activity: harness.runtime.activity.get(id),
  };
}

function completeToolBatchEvent(toolName = "read") {
  return {
    message: {
      role: "assistant",
      stopReason: "toolUse",
      content: [
        { type: "text", text: "working" },
        { type: "toolCall", id: "tool-1", name: toolName, arguments: {} },
      ],
    },
    toolResults: [{ toolCallId: "tool-1", toolName, content: [], isError: false }],
  };
}

async function createChildCheckpointHarness() {
  const tempDir = mkdtempSync(join(CACHE, "child-checkpoint-"));
  const projectConfigDir = join(tempDir, ".pi");
  mkdirSync(projectConfigDir, { recursive: true });
  writeFileSync(join(projectConfigDir, "settings.json"), JSON.stringify({
    compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 20 },
  }));
  const handlers = new Map();
  const sent = [];
  const aborts = [];
  let pendingMessages = false;
  let usage = { tokens: 901, contextWindow: 1000, percent: 90.1 };
  const pi = {
    registerTool() {},
    on(event, handler) { handlers.set(event, handler); },
    getAllTools() { return [{ name: "read" }, { name: "contact_supervisor" }]; },
    setActiveTools() {},
    sendUserMessage(text, options) { sent.push({ text, options }); },
  };
  const previousChild = process.env.OMPS_SUBAGENT_CHILD;
  const previousPiChild = process.env.PI_SUBAGENT_CHILD;
  process.env.OMPS_SUBAGENT_CHILD = "1";
  process.env.PI_SUBAGENT_CHILD = "1";
  try {
    const module = await import(`${new URL("../extensions/oh-my-pi-slim/child-supervisor.ts", import.meta.url).href}?checkpoint=${Date.now()}-${Math.random()}`);
    module.default(pi);
  } finally {
    if (previousChild === undefined) delete process.env.OMPS_SUBAGENT_CHILD;
    else process.env.OMPS_SUBAGENT_CHILD = previousChild;
    if (previousPiChild === undefined) delete process.env.PI_SUBAGENT_CHILD;
    else process.env.PI_SUBAGENT_CHILD = previousPiChild;
  }
  const ctx = {
    cwd: tempDir,
    getContextUsage: () => usage,
    hasPendingMessages: () => pendingMessages,
    isProjectTrusted: () => true,
    abort() { aborts.push("abort"); },
  };
  return {
    tempDir, handlers, sent, aborts, ctx,
    setPendingMessages(value) { pendingMessages = value; },
    setUsage(value) { usage = value; },
    emit(event, payload = {}) {
      const handler = handlers.get(event);
      assert.equal(typeof handler, "function", `missing ${event} handler`);
      return handler(payload, ctx);
    },
    cleanup() { rmSync(tempDir, { recursive: true, force: true }); },
  };
}

test("public schema and package-agent boundaries remain minimal", async () => {
  assert.deepEqual(SUBAGENT_ACTIONS, ["create", "list", "status", "interrupt", "steer", "resume", "reply", "delete", "clear"]);
  assert.deepEqual(SUBAGENT_PUBLIC_FIELDS, ["agent", "abstract", "task", "cwd", "action", "id", "message"]);
  assert.deepEqual(Object.keys(subagentParameters.properties).sort(), [...SUBAGENT_PUBLIC_FIELDS].sort());
  assert.equal(subagentParameters.additionalProperties, false);
  assert.deepEqual(subagentParameters.properties.action.anyOf.map(({ const: action }) => action), SUBAGENT_ACTIONS);
  assert.equal(subagentParameters.required.includes("action"), true);
  assert.equal("maxLength" in subagentParameters.properties.abstract, false);
  assert.deepEqual(Object.fromEntries(Object.entries(subagentParameters.properties).map(([field, schema]) => [field, schema.description])), {
    agent: "Specialist role for create.",
    abstract: "Short run summary for create or resume.",
    task: "Complete bounded objective for create.",
    cwd: "Working directory for create or resume. Relative paths resolve against the parent working directory. Create defaults to the parent working directory. Resume defaults to the source run's working directory.",
    action: "Choose create, list, status, interrupt, steer, resume, reply, delete, or clear. create requires agent, abstract, and task, with optional cwd. status, interrupt, and delete require id. steer and reply require id and message. resume requires id, abstract, and message, with optional cwd. list and clear accept no other fields.",
    id: "Retained run ID for status, steer, interrupt, resume, reply, or delete.",
    message: "New instruction for steer. Complete continuation objective for resume. Complete answer to the waiting request for reply.",
  });
  for (const schema of Object.values(subagentParameters.properties)) assertSteBlock(schema.description);
  assert.deepEqual(validateCreateInput({ agent: "explorer", abstract: " map auth ", task: " map " }), {
    agent: "explorer", abstract: "map auth", task: "map", cwd: undefined,
  });
  assert.throws(() => validateCreateInput({ agent: "explorer", abstract: "  ", task: "x" }), /abstract must be a non-empty string/);
  assert.throws(() => validateCreateInput({ agent: "custom", abstract: "x", task: "x" }), /Unknown agent/);
  assert.deepEqual([...discoverPackageAgents().keys()], ["designer", "explorer", "fixer", "librarian", "observer", "oracle"]);
  assert.equal(shouldApproveChildProject(true, ROOT, join(ROOT, "extensions")), true);
});

test("notification compaction gate defers manual compact release behind a queued user turn", () => {
  const deferred = [];
  const pauseTransitions = [];
  const notifications = [];
  let pending = false;
  let userTurnActive = false;
  const gate = new NotificationDeliveryPauseGate((paused) => {
    pauseTransitions.push(paused);
    if (!paused && pending) {
      pending = false;
      notifications.push({
        userTurnActive,
        options: { deliverAs: "steer", triggerTurn: true },
      });
    }
  }, (callback) => deferred.push(callback));

  const generation = gate.pause();
  pending = true;
  gate.releaseDeferred(generation);
  assert.deepEqual(notifications, [], "session_compact handlers must not synchronously send notifications");
  assert.equal(deferred.length, 1);
  userTurnActive = true;
  deferred.shift()();
  assert.deepEqual(notifications, [{
    userTurnActive: true,
    options: { deliverAs: "steer", triggerTurn: true },
  }]);
  assert.deepEqual(pauseTransitions, [true, false]);
});

test("notification compaction gate covers abort, next-input, checkpoint, failure, stale generation, and shutdown sequences", () => {
  const deferred = [];
  const transitions = [];
  const gate = new NotificationDeliveryPauseGate((paused) => transitions.push(paused), (callback) => deferred.push(callback));
  const flushOne = () => deferred.shift()?.();

  const abortGeneration = gate.pause();
  gate.releaseDeferred(abortGeneration);
  assert.equal(gate.isPaused(), true);
  flushOne();
  assert.equal(gate.isPaused(), false, "manual abort releases only after the deferred callback");

  const errorGeneration = gate.pause();
  gate.releaseDeferred(errorGeneration);
  assert.equal(gate.isPaused(), true, "manual error remains held until the next input schedules release");
  flushOne();
  assert.equal(gate.isPaused(), false);

  const checkpointGeneration = gate.pause();
  assert.equal(gate.isPaused(), true, "checkpoint session_compact keeps delivery paused");
  const continuation = [];
  continuation.push(CHECKPOINT_RESUME_TEXT);
  gate.releaseDeferred(checkpointGeneration);
  assert.equal(gate.isPaused(), true, "checkpoint resume starts before notification release");
  flushOne();
  assert.equal(gate.isPaused(), false);
  assert.deepEqual(continuation, [CHECKPOINT_RESUME_TEXT]);

  const failureGeneration = gate.pause();
  gate.releaseDeferred(failureGeneration);
  flushOne();
  assert.equal(gate.isPaused(), false, "agent_settled failure release clears the gate");

  const staleGeneration = gate.pause();
  gate.releaseDeferred(staleGeneration);
  const currentGeneration = gate.pause();
  flushOne();
  assert.equal(gate.isCurrent(currentGeneration), true, "an older deferred callback cannot unlock a newer compaction");
  gate.releaseDeferred(currentGeneration);
  flushOne();
  assert.equal(gate.isPaused(), false);

  gate.pause();
  gate.clearWithoutDelivery();
  assert.equal(gate.isPaused(), false, "shutdown clears pause state without delivering");
  assert.deepEqual(transitions.filter((paused) => paused === false).length, 5);
});

test("shared checkpoint helpers validate complete tool batches and strict threshold boundaries", () => {
  const valid = completeToolBatchEvent();
  assert.equal(completedToolBatch(valid), true);
  for (const invalid of [
    { ...valid, message: { ...valid.message, role: "user" } },
    { ...valid, message: { ...valid.message, stopReason: "stop" } },
    { ...valid, message: { ...valid.message, content: [{ type: "text", text: "none" }] }, toolResults: [] },
    { ...valid, toolResults: [] },
    { ...valid, message: { ...valid.message, content: [...valid.message.content, { type: "toolCall", id: "tool-1", name: "read", arguments: {} }] } },
    { ...valid, toolResults: [...valid.toolResults, valid.toolResults[0]] },
    { ...valid, toolResults: [{ ...valid.toolResults[0], toolName: "write" }] },
    { ...valid, toolResults: [{ ...valid.toolResults[0], toolCallId: "other" }] },
  ]) assert.equal(completedToolBatch(invalid), false);

  const settings = { enabled: true, reserveTokens: 100, keepRecentTokens: 20 };
  assert.equal(contextUsageNeedsCheckpoint({ tokens: 900, contextWindow: 1000 }, settings), false);
  assert.equal(contextUsageNeedsCheckpoint({ tokens: 901, contextWindow: 1000 }, settings), true);
  assert.equal(contextUsageNeedsCheckpoint({ tokens: null, contextWindow: 1000 }, settings), false);
  assert.equal(contextUsageNeedsCheckpoint({ tokens: 901, contextWindow: 1000 }, { ...settings, enabled: false }), false);
});

test("child checkpoint aborts complete batches and queues exactly one synchronous follow-up per threshold cycle", async () => {
  const harness = await createChildCheckpointHarness();
  try {
    harness.emit("session_start");
    harness.emit("turn_start");
    harness.emit("turn_end", completeToolBatchEvent());
    assert.equal(harness.aborts.length, 1);
    harness.emit("session_compact", { reason: "threshold", willRetry: false });
    assert.deepEqual(harness.sent, [{ text: CHECKPOINT_RESUME_TEXT, options: { deliverAs: "followUp" } }]);
    harness.emit("session_compact", { reason: "threshold", willRetry: false });
    harness.emit("agent_settled");
    assert.equal(harness.sent.length, 1);

    harness.emit("turn_start");
    harness.emit("turn_end", completeToolBatchEvent("grep"));
    assert.equal(harness.aborts.length, 2);
    harness.emit("session_compact", { reason: "threshold", willRetry: false });
    assert.deepEqual(harness.sent.map(({ text }) => text), [CHECKPOINT_RESUME_TEXT, CHECKPOINT_RESUME_TEXT]);
    harness.emit("agent_settled");
  } finally { harness.cleanup(); }
});

test("child checkpoint ignores pending/contact batches and resumes only matching threshold compaction", async () => {
  const harness = await createChildCheckpointHarness();
  const warnings = [];
  const originalError = console.error;
  console.error = (message) => warnings.push(String(message));
  try {
    harness.emit("session_start");
    for (const unknownUsage of [undefined, null]) {
      harness.setUsage(unknownUsage);
      harness.emit("turn_start");
      harness.emit("turn_end", completeToolBatchEvent());
      assert.equal(harness.aborts.length, 0);
    }
    harness.setUsage({ tokens: 901, contextWindow: 1000, percent: 90.1 });
    harness.setPendingMessages(true);
    harness.emit("turn_start");
    harness.emit("turn_end", completeToolBatchEvent());
    assert.equal(harness.aborts.length, 0);
    harness.setPendingMessages(false);

    harness.emit("turn_start");
    harness.emit("tool_execution_end", { toolName: "contact_supervisor" });
    harness.emit("turn_end", completeToolBatchEvent("contact_supervisor"));
    harness.emit("session_compact", { reason: "threshold", willRetry: false });
    harness.emit("agent_settled");
    assert.equal(harness.aborts.length, 0);
    assert.equal(harness.sent.length, 0, "a contact_supervisor batch and its later native compaction never resume");

    harness.emit("turn_start");
    harness.emit("turn_end", completeToolBatchEvent());
    assert.equal(harness.aborts.length, 1);
    harness.emit("session_compact", { reason: "manual", willRetry: false });
    harness.emit("session_compact", { reason: "threshold", willRetry: true });
    assert.equal(harness.sent.length, 0);
    harness.emit("agent_settled");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /automatic resume was not started/);

    harness.emit("session_compact", { reason: "threshold", willRetry: false });
    assert.equal(harness.sent.length, 0, "settled cleanup prevents a later unrelated compaction from resuming");

    harness.emit("turn_start");
    harness.emit("turn_end", completeToolBatchEvent());
    assert.equal(harness.aborts.length, 2);
    harness.emit("session_shutdown");
    harness.emit("session_compact", { reason: "threshold", willRetry: false });
    assert.equal(harness.sent.length, 0);
  } finally {
    console.error = originalError;
    harness.cleanup();
  }
});

test("child Fast Mode hook is snapshot-gated after the child early return", async () => {
  const previous = {
    fast: process.env.OMPS_FAST_MODE,
    ompsChild: process.env.OMPS_SUBAGENT_CHILD,
    piChild: process.env.PI_SUBAGENT_CHILD,
  };
  const load = async (fast, child = true) => {
    if (fast === undefined) delete process.env.OMPS_FAST_MODE;
    else process.env.OMPS_FAST_MODE = fast;
    if (child) {
      process.env.OMPS_SUBAGENT_CHILD = "1";
      process.env.PI_SUBAGENT_CHILD = "1";
    } else {
      delete process.env.OMPS_SUBAGENT_CHILD;
      delete process.env.PI_SUBAGENT_CHILD;
    }
    const handlers = new Map();
    const module = await import(`${new URL("../extensions/oh-my-pi-slim/child-supervisor.ts", import.meta.url).href}?fast-hook=${Date.now()}-${Math.random()}`);
    module.default({
      registerTool() {},
      on(event, handler) {
        const list = handlers.get(event) ?? [];
        list.push(handler);
        handlers.set(event, list);
      },
    });
    return handlers;
  };
  try {
    for (const value of [undefined, "0", "true"]) {
      const handlers = await load(value);
      assert.equal(handlers.has("before_provider_request"), false, `child value ${String(value)} stays default tier`);
      assert.equal(handlers.has("session_start"), true, "ordinary child runtime still registers");
    }
    const enabled = await load("1");
    assert.equal(enabled.get("before_provider_request").length, 1);
    const payload = { model: "gpt-child", service_tier: "default" };
    assert.deepEqual(
      enabled.get("before_provider_request")[0]({ payload }, { model: { provider: "openai-codex", id: "gpt-child" } }),
      { model: "gpt-child", service_tier: "priority" },
    );
    assert.equal(payload.service_tier, "default");

    const mainEarlyPath = await load("1", false);
    assert.deepEqual([...mainEarlyPath.keys()], [], "a non-child process registers none of the child hooks");
  } finally {
    if (previous.fast === undefined) delete process.env.OMPS_FAST_MODE;
    else process.env.OMPS_FAST_MODE = previous.fast;
    if (previous.ompsChild === undefined) delete process.env.OMPS_SUBAGENT_CHILD;
    else process.env.OMPS_SUBAGENT_CHILD = previous.ompsChild;
    if (previous.piChild === undefined) delete process.env.PI_SUBAGENT_CHILD;
    else process.env.PI_SUBAGENT_CHILD = previous.piChild;
  }
});

test("deny config is partial, exact, portable, and protects lifecycle tools", () => {
  const parsed = parseDenyConfig({
    explorer: ["ask_user_question", "FuturePluginTool"],
    observer: ["write"],
  }, "config.deny");
  assert.deepEqual(parsed, {
    explorer: ["ask_user_question", "FuturePluginTool"],
    librarian: [],
    oracle: [],
    designer: [],
    fixer: [],
    observer: ["write"],
  });
  assert.throws(() => parseDenyConfig({ custom: [] }, "config.deny"), /unknown role.*custom/i);
  assert.throws(() => parseDenyConfig({ explorer: "read" }, "config.deny"), /must be an array/i);
  assert.throws(() => parseDenyConfig({ explorer: ["read", "read"] }, "config.deny"), /duplicate tool "read"/i);
  assert.throws(() => parseDenyConfig({ explorer: ["read,write"] }, "config.deny"), /must not contain a comma/i);
  for (const reserved of ["subagent", "contact_supervisor"]) {
    assert.throws(() => parseDenyConfig({ fixer: [reserved] }, "config.deny"), new RegExp(`cannot deny lifecycle tool "${reserved}"`));
  }
  assert.deepEqual(parseDenyConfig({ fixer: ["subagent_supervisor"] }, "config.deny").fixer, ["subagent_supervisor"]);
});

test("old presets inherit observer from explorer and explicit observer config is retained", () => {
  const tempDir = mkdtempSync(join(CACHE, "preset-config-"));
  try {
    const role = (provider, model, thinking = "medium") => ({ provider, model, thinking });
    const oldPreset = {
      orchestrator: role("provider", "orchestrator"),
      explorer: role("provider", "explorer", "low"),
      librarian: role("provider", "librarian"),
      oracle: role("provider", "oracle", "high"),
      designer: role("provider", "designer"),
      fixer: role("provider", "fixer"),
    };
    const configFile = join(tempDir, "config.json");
    writeFileSync(configFile, JSON.stringify({
      defaultPreset: "legacy",
      presets: {
        legacy: oldPreset,
        explicit: { ...oldPreset, observer: role("vision", "observer", "xhigh") },
      },
      deny: { observer: ["ask_user_question"] },
    }));
    const config = parseConfigFile(configFile);
    assert.equal("fast" in config, false, "preset parsing returns no Fast Mode runtime state");
    assert.deepEqual(config.presets.legacy.observer, oldPreset.explorer);
    assert.equal(config.observerFallbackPresets.has("legacy"), true);
    assert.deepEqual(config.presets.explicit.observer, role("vision", "observer", "xhigh"));
    assert.equal(config.observerFallbackPresets.has("explicit"), false);
    assert.deepEqual(config.deny.observer, ["ask_user_question"]);
    for (const legacyFast of [true, false, "true", 1, null, { stale: true }]) {
      writeFileSync(configFile, JSON.stringify({ fast: legacyFast, presets: { legacy: oldPreset } }));
      assert.equal("fast" in parseConfigFile(configFile), false, "arbitrary v1.0.0 fast fields are ignored");
    }
    assert.equal(supportsImageInput({ input: ["text", "image"] }), true);
    assert.equal(supportsImageInput({ input: ["text"] }), false);
  } finally { rmSync(tempDir, { recursive: true, force: true }); }
});

test("approve remains contained by trust, real paths, and the parent project", () => {
  const tempDir = mkdtempSync(join(CACHE, "approve-containment-"));
  try {
    const parent = join(tempDir, "parent");
    const contained = join(parent, "contained");
    const outside = join(tempDir, "outside");
    mkdirSync(contained, { recursive: true });
    mkdirSync(outside, { recursive: true });
    assert.equal(shouldApproveChildProject(false, parent, contained), false, "untrusted projects never approve children");
    assert.equal(shouldApproveChildProject(true, parent, outside), false, "sibling paths are outside the parent project");
    if (process.platform !== "win32") {
      const escape = join(parent, "escape");
      symlinkSync(outside, escape);
      assert.equal(shouldApproveChildProject(true, parent, escape), false, "symlink escapes resolve outside the project");
    }
  } finally { rmSync(tempDir, { recursive: true, force: true }); }
});

test("runtime requires explicit create fields and rejects unknown fields", async () => {
  const harness = createHarness();
  try {
    await harness.restore();
    await assert.rejects(
      harness.tools.get("subagent").execute("create", { action: "create", agent: "fixer", abstract: "x", task: "x", model: "override" }),
      /unknown field.*model/i,
    );
    await assert.rejects(
      harness.tools.get("subagent").execute("create", { action: "create", agent: "fixer", task: "x" }),
      /abstract must be a non-empty string/i,
    );
    await assert.rejects(
      harness.tools.get("subagent").execute("missing", { agent: "fixer", abstract: "x", task: "x" }),
      /action must be a non-empty string/i,
    );
    await assert.rejects(
      harness.tools.get("subagent").execute("list", { action: "list", async: true }),
      /unknown field.*async/i,
    );
    for (const action of ["list", "status", "steer", "interrupt", "reply", "delete"]) {
      await assert.rejects(
        harness.tools.get("subagent").execute(action, { action, abstract: "forbidden" }),
        new RegExp(`${action} does not accept create field\\(s\\): abstract`, "i"),
      );
    }
    await assert.rejects(
      harness.tools.get("subagent").execute("status-unknown", { action: "status", id: "source", extra: true }),
      /subagent does not accept unknown field\(s\): extra/i,
    );
    await assert.rejects(
      harness.tools.get("subagent").execute("status-message", { action: "status", id: "source", message: "forbidden" }),
      /status does not accept message/i,
    );
    await assert.rejects(
      harness.tools.get("subagent").execute("status-missing-id", { action: "status" }),
      /id must be a non-empty string/i,
    );
    await assert.rejects(
      harness.tools.get("subagent").execute("delete-missing-id", { action: "delete" }),
      /id must be a non-empty string/i,
    );
    await assert.rejects(
      harness.tools.get("subagent").execute("delete-message", { action: "delete", id: "source", message: "forbidden" }),
      /delete does not accept message/i,
    );
    await assert.rejects(
      harness.tools.get("subagent").execute("resume-missing-abstract", { action: "resume", id: "source", message: "continue" }),
      /abstract must be a non-empty string/i,
    );
    await assert.rejects(
      harness.tools.get("subagent").execute("resume-blank-abstract", { action: "resume", id: "source", abstract: "   ", message: "continue" }),
      /abstract must be a non-empty string/i,
    );
    await assert.rejects(
      harness.tools.get("subagent").execute("resume-missing-message", { action: "resume", id: "source", abstract: "new summary" }),
      /message must be a non-empty string/i,
    );
    await assert.rejects(
      harness.tools.get("subagent").execute("resume-extra-create-field", {
        action: "resume", id: "source", abstract: "new summary", message: "continue", task: "forbidden",
      }),
      /resume does not accept field\(s\): task/i,
    );
    assert.equal(harness.tools.has("subagent_supervisor"), false);
  } finally { harness.cleanup(); }
});

test("registered subagent metadata describes the unified lifecycle", () => {
  const harness = createHarness();
  try {
    const subagent = harness.tools.get("subagent");
    assert.equal(subagent.description, "Create and manage retained specialist runs through nine lifecycle actions. `subagent create` starts an independent run and returns its run ID immediately. `subagent list` returns a compact overview of every retained run without output or errors. `subagent status` returns one run and includes terminal output or error when available. Waiting and terminal notifications deliver complete requests, results, and errors. `subagent resume` starts a new run from reusable terminal context, optionally in another working directory. `subagent reply` continues the same waiting run after an answer. `subagent steer` sends a new instruction to a running run. `subagent interrupt` stops a live run, waits for its terminal status, and returns that result without a separate notification. `subagent delete` removes one retained run only after it reaches a terminal status. `subagent clear` removes all retained history only when every run is terminal. Reload, tree navigation, and session replacement interrupt active runs but retain their history. Deleting or clearing Subagent history never changes Goal statistics.");
    assert.equal(subagent.promptSnippet, "Delegate and manage specialist runs.");
    assertSteBlock(subagent.description);
    assertSteBlock(subagent.promptSnippet);
    assertStePromptGuidelines(subagent.promptGuidelines);
    const expectedGuidelines = [
      "Delegate bounded specialist work with `subagent create` when an independent lane improves progress.",
      "Give concurrent `subagent create` runs disjoint writer ownership and nonconflicting dependencies.",
      "Do not duplicate work owned by a starting, running, or waiting `subagent` run.",
      "`subagent create` starts new work, while `subagent resume` starts a new run from reusable terminal context.",
      "`subagent list` summarizes retained runs, while `subagent status` returns one run's detailed result.",
      "Use `subagent reply` only to answer the complete request from that same waiting run.",
      "Use `subagent steer` only for a genuine new instruction, not polling or reassurance.",
      "Use `subagent interrupt` only to stop a starting, running, or waiting run and wait for its final result.",
      "`subagent interrupt` is not rollback, so inspect partial file changes before continuing.",
      "Use `subagent delete` for one terminal run, or `subagent clear` when all terminal history should be removed.",
    ];
    assert.equal(subagent.parameters.properties.cwd.description, "Working directory for create or resume. Relative paths resolve against the parent working directory. Create defaults to the parent working directory. Resume defaults to the source run's working directory.");
    assert.equal(subagent.parameters.properties.action.description, "Choose create, list, status, interrupt, steer, resume, reply, delete, or clear. create requires agent, abstract, and task, with optional cwd. status, interrupt, and delete require id. steer and reply require id and message. resume requires id, abstract, and message, with optional cwd. list and clear accept no other fields.");
    assert.equal(subagent.parameters.properties.id.description, "Retained run ID for status, steer, interrupt, resume, reply, or delete.");
    assert.equal(subagent.parameters.properties.message.description, "New instruction for steer. Complete continuation objective for resume. Complete answer to the waiting request for reply.");
    assert.deepEqual(subagent.promptGuidelines, expectedGuidelines);
    const guidelines = subagent.promptGuidelines.join("\n");
    assert.match(guidelines, /subagent list.*subagent status.*detailed result/i);
    assert.doesNotMatch(`${subagent.description}\n${subagent.promptSnippet}\n${guidelines}`, /subagent_supervisor|pending query|replyTo|request ID|waitingSeq|deliveryKey|legacy|saved child-session/i);
    assert.equal(typeof subagent.renderCall, "function");
    assert.equal(typeof subagent.renderResult, "function");
    assert.equal(typeof harness.messageRenderers.get("oh-my-pi-slim:subagent-notification"), "function");
    assert.deepEqual([...harness.tools.keys()], ["subagent"]);
  } finally { harness.cleanup(); }
});

test("subagent list stays compact across all six statuses while status isolates one latest retained result", async () => {
  const harness = createHarness();
  try {
    await harness.restore();
    for (const run of [
      persistedRun({
        id: "status-completed", abstract: "completed abstract", status: "completed",
        createdAt: "2026-04-16T00:00:00.000Z", updatedAt: "2026-04-16T00:00:00.000Z",
        task: "TASK_SENTINEL", output: "OUTPUT_SENTINEL", error: "ERROR_SENTINEL", sourceRunId: "older-run",
      }),
      persistedRun({
        id: "status-failed-new", abstract: "recent terminal abstract", status: "failed",
        createdAt: "2026-04-15T00:00:00.000Z", updatedAt: "2026-04-18T00:00:00.000Z",
        task: "RECENT_TASK_SENTINEL", error: "RECENT_ERROR_SENTINEL",
      }),
      persistedRun({
        id: "status-interrupted", abstract: "interrupted abstract", status: "interrupted",
        createdAt: "2026-04-14T00:00:00.000Z", updatedAt: "2026-04-17T00:00:00.000Z",
        output: "INTERRUPTED_OUTPUT_SENTINEL", error: "INTERRUPTED_ERROR_SENTINEL",
      }),
    ]) harness.runtime.registry.add(run, false);

    const running = await createRun(harness, { abstract: "running abstract", task: "RUNNING_TASK_SENTINEL" });
    const runningId = running.details.run.id;
    const runningConfig = readConfig(harness, runningId);
    harness.alive.add(999);
    atomicWriteJson(harness.paths(runningId).stateFile, stateFor(runningId, runningConfig.token, {
      output: "ACTIVE_OUTPUT_SENTINEL", error: "ACTIVE_ERROR_SENTINEL",
    }));

    const waiting = await createRun(harness, { abstract: "waiting abstract", task: "WAITING_TASK_SENTINEL" });
    const waitingId = waiting.details.run.id;
    const waitingConfig = readConfig(harness, waitingId);
    atomicWriteJson(harness.paths(waitingId).stateFile, stateFor(waitingId, waitingConfig.token, {
      status: "waiting", waitingSeq: 1, output: "WAITING_OUTPUT_SENTINEL", error: "WAITING_ERROR_SENTINEL",
      request: {
        runId: waitingId, reason: "need_decision", message: "REQUEST_MESSAGE_SENTINEL",
        interview: { title: "INTERVIEW_SENTINEL" }, createdAt: "REQUEST_TIMESTAMP_SENTINEL",
      },
    }));
    const starting = await createRun(harness, { abstract: "starting abstract", task: "STARTING_TASK_SENTINEL" });

    const result = await harness.tools.get("subagent").execute("list", { action: "list" });
    const activeIds = sortRetainedSubagentRuns([
      harness.runtime.registry.require(runningId),
      harness.runtime.registry.require(waitingId),
    ]).map((run) => run.id);
    assert.deepEqual(result.details.runs.map((run) => run.id), [
      ...activeIds, starting.details.run.id, "status-failed-new", "status-interrupted", "status-completed",
    ], "list must preserve shared active, starting, terminal-newest priority");
    assert.deepEqual(new Set(result.details.runs.map((run) => run.status)), new Set([
      "starting", "running", "waiting", "completed", "failed", "interrupted",
    ]));
    const byId = new Map(result.details.runs.map((run) => [run.id, run]));
    assert.deepEqual(byId.get("status-completed"), {
      id: "status-completed", agent: "fixer", abstract: "completed abstract", status: "completed", live: false,
      sourceRunId: "older-run",
    });
    assert.deepEqual(byId.get("status-failed-new"), {
      id: "status-failed-new", agent: "fixer", abstract: "recent terminal abstract", status: "failed", live: false,
    });
    assert.deepEqual(byId.get("status-interrupted"), {
      id: "status-interrupted", agent: "fixer", abstract: "interrupted abstract", status: "interrupted", live: false,
    });
    assert.deepEqual(byId.get(runningId), {
      id: runningId, agent: "fixer", abstract: "running abstract", status: "running", live: true,
    });
    assert.deepEqual(byId.get(waitingId), {
      id: waitingId, agent: "fixer", abstract: "waiting abstract", status: "waiting", live: true, reason: "need_decision",
    });
    assert.deepEqual(byId.get(starting.details.run.id), {
      id: starting.details.run.id, agent: "fixer", abstract: "starting abstract", status: "starting", live: false,
    });
    for (const run of result.details.runs) {
      assert.equal("output" in run, false, `${run.status} list entry must not expose output`);
      assert.equal("error" in run, false, `${run.status} list entry must not expose error`);
    }
    assert.deepEqual(JSON.parse(result.content[0].text), result.details.runs);

    const statusIds = [...result.details.runs.map((run) => run.id)];
    for (const id of statusIds) {
      const statusResult = await harness.tools.get("subagent").execute("status", { action: "status", id });
      assert.deepEqual(JSON.parse(statusResult.content[0].text), statusResult.details.run);
      const listed = byId.get(id);
      const statusBase = Object.fromEntries(Object.entries(statusResult.details.run)
        .filter(([field]) => field !== "output" && field !== "error"));
      assert.deepEqual(statusBase, listed, `${id} status base fields must exactly match list`);
      if (statusResult.details.run.status === "completed") {
        assert.equal(statusResult.details.run.output, "OUTPUT_SENTINEL");
        assert.equal(statusResult.details.run.error, "ERROR_SENTINEL");
      } else if (statusResult.details.run.status === "failed") {
        assert.equal(statusResult.details.run.error, "RECENT_ERROR_SENTINEL");
        assert.equal("output" in statusResult.details.run, false);
      } else if (statusResult.details.run.status === "interrupted") {
        assert.equal(statusResult.details.run.output, "INTERRUPTED_OUTPUT_SENTINEL");
        assert.equal(statusResult.details.run.error, "INTERRUPTED_ERROR_SENTINEL");
      } else {
        assert.equal("output" in statusResult.details.run, false, `${id} nonterminal status must omit output`);
        assert.equal("error" in statusResult.details.run, false, `${id} nonterminal status must omit error`);
      }
    }

    const exposed = JSON.stringify({ content: result.content, details: result.details });
    for (const field of [
      "output", "error", "task", "cwd", "model", "deniedTools", "createdAt", "updatedAt", "sessionFile", "activity",
      "notificationPending", "request", "message", "interview", "requestId", "waitingSeq",
    ]) assert.equal(exposed.includes(`\"${field}\"`), false, `${field} must not enter list output`);
    for (const sentinel of [
      "TASK_SENTINEL", "RECENT_TASK_SENTINEL", "RUNNING_TASK_SENTINEL", "WAITING_TASK_SENTINEL",
      "STARTING_TASK_SENTINEL", "REQUEST_MESSAGE_SENTINEL", "INTERVIEW_SENTINEL", "ACTIVE_OUTPUT_SENTINEL",
      "ACTIVE_ERROR_SENTINEL", "WAITING_OUTPUT_SENTINEL", "WAITING_ERROR_SENTINEL", "OUTPUT_SENTINEL",
      "ERROR_SENTINEL", "RECENT_ERROR_SENTINEL", "INTERRUPTED_OUTPUT_SENTINEL", "INTERRUPTED_ERROR_SENTINEL",
    ]) assert.equal(exposed.includes(sentinel), false);
  } finally { harness.cleanup(); }
});

test("subagent status reconciles before reading the latest registry and distinguishes unknown IDs", async () => {
  const harness = createHarness();
  try {
    await harness.restore();
    const created = await createRun(harness, { abstract: "reconcile status", task: "complete before status" });
    const id = created.details.run.id;
    const config = readConfig(harness, id);
    atomicWriteJson(harness.paths(id).stateFile, stateFor(id, config.token, {
      status: "completed", output: "LATEST_STATUS_OUTPUT", error: "LATEST_STATUS_ERROR",
    }));

    const result = await harness.tools.get("subagent").execute("status", { action: "status", id });
    assert.deepEqual(result.details.run, {
      id, agent: "fixer", abstract: "reconcile status", status: "completed", live: false,
      output: "LATEST_STATUS_OUTPUT", error: "LATEST_STATUS_ERROR",
    });
    assert.equal(harness.runtime.registry.require(id).status, "completed");
    await assert.rejects(
      harness.tools.get("subagent").execute("status", { action: "status", id: "never-existed" }),
      /Unknown subagent run: never-existed/,
    );
  } finally { harness.cleanup(); }
});

test("contact_supervisor prompt metadata describes persistent reply-to-continue requests", async () => {
  const previousChild = process.env.OMPS_SUBAGENT_CHILD;
  const previousPiChild = process.env.PI_SUBAGENT_CHILD;
  const previousParentRun = process.env.OMPS_PARENT_RUN_ID;
  process.env.OMPS_SUBAGENT_CHILD = "1";
  process.env.PI_SUBAGENT_CHILD = "1";
  process.env.OMPS_PARENT_RUN_ID = "child-run";
  try {
    let definition;
    let sessionStart;
    let activeTools;
    const allTools = ["read", "bash", "grep", "find", "ls", "project_extension_tool", "contact_supervisor"];
    const module = await import(`${new URL("../extensions/oh-my-pi-slim/child-supervisor.ts", import.meta.url).href}?metadata=1`);
    module.default({
      registerTool(tool) { definition = tool; },
      on(event, handler) { if (event === "session_start") sessionStart = handler; },
      getAllTools() { return allTools.map((name) => ({ name })); },
      setActiveTools(names) { activeTools = names; },
    });
    assert.equal(typeof sessionStart, "function");
    sessionStart();
    assert.deepEqual(activeTools, allTools);
    assert.equal(definition.description, "Request an orchestrator response for a decision, structured interview, or progress update. Every call moves the child run to waiting, including progress updates. The result records the request context and ends the current child turn. Work continues in the same run after the orchestrator replies.");
    assert.equal(definition.promptSnippet, "Request an orchestrator response.");
    assertStePromptGuidelines(definition.promptGuidelines);
    assert.equal(definition.parameters.type, "object");
    assert.equal(definition.parameters.additionalProperties, false);
    assert.equal(definition.parameters.anyOf, undefined);
    assert.equal(definition.parameters.oneOf, undefined);
    assert.equal(definition.parameters.required.includes("message"), false);
    const contactDescriptions = {
      reason: definition.parameters.properties.reason.description,
      message: definition.parameters.properties.message.description,
      interview: definition.parameters.properties.interview.description,
      questions: definition.parameters.properties.interview.properties.questions.description,
      title: definition.parameters.properties.interview.properties.title.description,
      id: definition.parameters.properties.interview.properties.questions.items.properties.id.description,
      prompt: definition.parameters.properties.interview.properties.questions.items.properties.prompt.description,
      options: definition.parameters.properties.interview.properties.questions.items.properties.options.description,
    };
    assert.deepEqual(contactDescriptions, {
      reason: "Request type: need_decision, interview_request, or progress_update.",
      message: "Complete context the orchestrator needs to respond. Defaults to the selected reason when omitted or blank.",
      interview: "Structured interview details for interview_request.",
      questions: "Authored interview questions in display order.",
      title: "Optional short interview title.",
      id: "Optional short identifier for matching a question.",
      prompt: "Question the orchestrator should answer.",
      options: "Optional authored answer choices.",
    });
    for (const description of Object.values(contactDescriptions)) assertSteBlock(description);
    assert.deepEqual(definition.promptGuidelines, [
      "Use `contact_supervisor` whenever child work requires an orchestrator reply.",
      "Every `contact_supervisor` reason waits for that reply, including `progress_update`.",
    ]);
    const guidelines = definition.promptGuidelines.join("\n");
    assert.doesNotMatch(`${definition.description}\n${definition.promptSnippet}\n${guidelines}`, /request ID|UUID|waitingSeq|deliveryKey|legacy|saved child/i);
    const result = await definition.execute("call", { reason: "interview_request", message: "choose", interview: { title: "Choice" } });
    assert.deepEqual(result.details.request, {
      runId: process.env.OMPS_PARENT_RUN_ID,
      reason: "interview_request",
      message: "choose",
      interview: { title: "Choice" },
      createdAt: result.details.request.createdAt,
    });
    assert.equal("id" in result.details.request, false);
  } finally {
    if (previousChild === undefined) delete process.env.OMPS_SUBAGENT_CHILD;
    else process.env.OMPS_SUBAGENT_CHILD = previousChild;
    if (previousPiChild === undefined) delete process.env.PI_SUBAGENT_CHILD;
    else process.env.PI_SUBAGENT_CHILD = previousPiChild;
    if (previousParentRun === undefined) delete process.env.OMPS_PARENT_RUN_ID;
    else process.env.OMPS_PARENT_RUN_ID = previousParentRun;
  }
});

test("SubagentRegistry markLive and delete emit only for real changes", () => {
  const registry = new SubagentRegistry();
  let emissions = 0;
  registry.subscribe(() => { emissions += 1; });
  registry.add(persistedRun(), false);
  assert.equal(emissions, 1);
  registry.markLive("run-1", false);
  assert.equal(emissions, 1);
  registry.markLive("run-1", true);
  assert.equal(emissions, 2);
  registry.markLive("run-1", true);
  assert.equal(emissions, 2);
  assert.equal(registry.delete("run-1"), true);
  assert.equal(emissions, 3);
  assert.equal(registry.get("run-1"), undefined);
  assert.equal(registry.isLive("run-1"), false);
  assert.equal(registry.delete("run-1"), false);
  assert.equal(emissions, 3);
});

test("journal restore preserves folded active status and reports active IDs", () => {
  const restored = restoreRunJournal([
    { version: 1, runs: [persistedRun(), persistedRun({ id: "done", status: "completed" })] },
    { version: 2, run: persistedRun({ id: "done", status: "completed", output: "new" }) },
  ]);
  assert.deepEqual(restored.runs.map(({ id, status }) => [id, status]), [["run-1", "running"], ["done", "completed"]]);
  assert.deepEqual(restored.activeRunIds, ["run-1"]);
  assert.deepEqual(runJournalEntry(restored.runs[0]), { version: 2, run: restored.runs[0] });
});

test("legacy journal normalizes abstract by Unicode code points and strips request id", () => {
  const longTask = `${"中".repeat(98)}😀🚀tail`;
  const legacy = persistedRun({
    id: "legacy-normalized",
    abstract: undefined,
    task: longTask,
    status: "waiting",
    request: {
      id: "legacy-request-id",
      runId: "legacy-normalized",
      reason: "need_decision",
      message: "choose",
      createdAt: "2026-04-16T23:59:30.000Z",
    },
  });
  const restored = restoreRunJournal([{ version: 2, run: legacy }]).runs[0];
  assert.equal(restored.abstract, `${"中".repeat(98)}😀🚀...`);
  assert.equal("id" in restored.request, false);
  assert.equal(legacyRunAbstract("short"), "short...");
});

test("journal restore skips run IDs that are unsafe path segments", () => {
  const restored = restoreRunJournal([
    { version: 1, runs: [persistedRun(), persistedRun({ id: "../escape" })] },
    { version: 2, run: persistedRun({ id: "also/unsafe" }) },
  ]);
  assert.deepEqual(restored.runs.map(({ id }) => id), ["run-1"]);
  assert.deepEqual(restored.activeRunIds, ["run-1"]);
});

test("parent launch reader normalizes legacy missing abstract and rejects blank new abstract", () => {
  const tempDir = mkdtempSync(join(CACHE, "legacy-launch-parent-"));
  try {
    const paths = getRunPaths(join(tempDir, "runs"), "owner", "legacy-run");
    mkdirSync(paths.controlDir, { recursive: true });
    const task = `${"界".repeat(98)}😀🚀tail`;
    const base = {
      v: 1, runId: "legacy-run", token: "token", ownerSessionId: "owner", agent: "fixer",
      task, cwd: ROOT, model: "provider/model:high", deniedTools: [], systemPrompt: "prompt",
      approve: false, childSessionDir: join(tempDir, "children"),
      piInvocation: { command: "pi", args: ["--mode", "rpc"] }, env: {}, createdAt: new Date().toISOString(),
    };
    atomicWriteJson(paths.configFile, base);
    assert.equal(readLaunchConfig(paths).abstract, `${"界".repeat(98)}😀🚀...`);
    atomicWriteJson(paths.configFile, { ...base, abstract: "  concise summary  " });
    assert.equal(readLaunchConfig(paths).abstract, "concise summary");
    atomicWriteJson(paths.configFile, { ...base, abstract: "   " });
    assert.equal(readLaunchConfig(paths), undefined);
    assert.equal(isDetachedLaunchConfig(base), false, "the strict type guard remains canonical for newly written configs");
  } finally { rmSync(tempDir, { recursive: true, force: true }); }
});

test("process identity is non-empty and runner identity validation rejects legacy or extra fields", () => {
  assert.match(getProcessIdentity(process.pid), /\S/);
  const valid = { v: 1, token: "token", runId: "run", pid: process.pid, processIdentity: "created command" };
  assert.equal(isDetachedRunnerIdentity(valid), true);
  assert.equal(isDetachedRunnerIdentity({ ...valid, processIdentity: undefined }), false);
  assert.equal(isDetachedRunnerIdentity({ ...valid, extra: true }), false);
});

test("run-directory helpers list safe owner children and remove only contained run paths", () => {
  const tempDir = mkdtempSync(join(CACHE, "run-files-gc-"));
  try {
    const runRoot = join(tempDir, "runs");
    const paths = getRunPaths(runRoot, "owner-safe", "run-safe");
    mkdirSync(paths.controlDir, { recursive: true, mode: 0o700 });
    assert.deepEqual(listOwnerRunIds(runRoot, "owner-safe"), ["run-safe"]);
    assert.throws(() => removeRunFiles({ ...paths, runDir: join(paths.ownerDir, "..", "escape") }), /unsafe/);
    removeRunFiles(paths);
    assert.equal(existsSync(paths.runDir), false);
  } finally { rmSync(tempDir, { recursive: true, force: true }); }
});

test("Goal stats sidecars enforce private paths, permissions, validation, and symlink safety", () => {
  const tempDir = mkdtempSync(join(CACHE, "goal-stats-sidecar-"));
  try {
    const root = getGoalStatsRoot(join(tempDir, "sessions"));
    const stats = { version: 1, runId: "run-safe", tokens: 120, tools: 3, turns: 4, compactions: 1 };
    assert.equal(writeGoalStatsSidecar(root, "owner-safe", stats), true);
    const paths = getGoalStatsSidecarPaths(root, "owner-safe", "run-safe");
    assert.equal(statSync(paths.root).mode & 0o777, 0o700);
    assert.equal(statSync(paths.ownerDir).mode & 0o777, 0o700);
    assert.equal(statSync(paths.file).mode & 0o777, 0o600);
    assert.deepEqual(readGoalStatsSidecar(root, "owner-safe", "run-safe"), stats);
    assert.throws(() => getGoalStatsSidecarPaths(root, "../escape", "run-safe"), /safe path segment/);
    assert.equal(writeGoalStatsSidecar(root, "owner-safe", { ...stats, runId: "../escape" }), false);

    writeFileSync(paths.file, "{malformed", { mode: 0o600 });
    assert.equal(readGoalStatsSidecar(root, "owner-safe", "run-safe"), undefined);
    rmSync(paths.file, { force: true });
    const target = join(tempDir, "outside.json");
    writeFileSync(target, JSON.stringify(stats));
    symlinkSync(target, paths.file);
    assert.equal(readGoalStatsSidecar(root, "owner-safe", "run-safe"), undefined);
    assert.equal(writeGoalStatsSidecar(root, "owner-safe", stats), false);
    assert.deepEqual(JSON.parse(readFileSync(target, "utf8")), stats);
  } finally { rmSync(tempDir, { recursive: true, force: true }); }
});

test("Goal stats capture writes only actual changes and treats sidecar I/O failure as best-effort", async () => {
  const writes = [];
  const harness = createHarness({
    writeGoalStats(root, ownerSessionId, stats) {
      writes.push({ root, ownerSessionId, stats: structuredClone(stats) });
      if (writes.length === 2) throw new Error("simulated sidecar failure");
      return true;
    },
  });
  try {
    await harness.restore();
    const first = stateFor("old-run", "token", { providerTokens: 50, toolUses: 2, turnCount: 3, compactionCount: 1 });
    harness.runtime.captureGoalActivity("old-run", first);
    harness.runtime.captureGoalActivity("old-run", structuredClone(first));
    assert.equal(writes.length, 1, "unchanged stats do not rewrite the sidecar");
    harness.runtime.captureGoalActivity("old-run", { ...first, providerTokens: 75 });
    assert.equal(writes.length, 2, "actual stats changes attempt one additional atomic write");
    assert.deepEqual(harness.runtime.goalStats(["old-run"]), {
      runCount: 1, tokens: 75, tools: 2, turns: 3, compactions: 1,
    });
  } finally { harness.cleanup(); }
});

test("Goal stats sidecars preserve completed owned-run aggregates across branch restore and run-directory GC", async () => {
  const branchOne = [];
  const harness = createHarness({ branch: branchOne });
  try {
    await harness.restore();
    harness.runtime.captureGoalActivity("old-run", stateFor("old-run", "token", {
      status: "completed", providerTokens: 90, toolUses: 5, turnCount: 6, compactionCount: 2,
    }));
    const sidecar = getGoalStatsSidecarPaths(getGoalStatsRoot(harness.sessionDir), harness.ownerSessionId, "old-run").file;
    assert.equal(existsSync(sidecar), true);
    assert.equal(harness.runtime.goalStats(["old-run"]).tokens, 90);

    branchOne.splice(0);
    await harness.restore();
    assert.deepEqual(harness.runtime.goalStats(["old-run"]), {
      runCount: 1, tokens: 90, tools: 5, turns: 6, compactions: 2,
    });
    assert.equal(existsSync(sidecar), true, "run-directory GC never deletes session-owned Goal stats sidecars");
  } finally { harness.cleanup(); }
});

test("create writes secure detached config, journals once, launches, and returns immediately", async () => {
  const harness = createHarness();
  try {
    await harness.restore();
    const result = await createRun(harness);
    const id = result.details.run.id;
    const config = readConfig(harness, id);
    assert.match(result.content[0].text, new RegExp(`${id}.*status starting`));
    assert.deepEqual(result.details, {
      run: {
        id,
        agent: "fixer",
        abstract: "detached summary",
        task: "detached task",
        cwd: ROOT,
        model: "preset/fixer:high",
        deniedTools: [],
        status: "starting",
        createdAt: new Date(NOW_MS).toISOString(),
        updatedAt: new Date(NOW_MS).toISOString(),
        live: true,
      },
    });
    assert.equal(harness.runtime.registry.isLive(id), true);
    assert.equal(harness.launches.length, 1);
    assert.equal(harness.journalWrites.length, 1);
    assert.equal(config.ownerSessionId, "owner-a");
    assert.equal(config.model, "preset/fixer:high");
    assert.equal(config.abstract, "detached summary");
    assert.deepEqual(config.piInvocation.command, "pi");
    assert.deepEqual(config.piInvocation.args.slice(0, 4), ["--mode", "rpc", "--model", "preset/fixer:high"]);
    assert.equal(config.piInvocation.args.includes("--session-dir"), true);
    assert.equal(config.piInvocation.args.includes("--system-prompt"), true);
    assert.equal(config.piInvocation.args.includes("--tools"), false);
    assert.equal(config.piInvocation.args.includes("--exclude-tools"), false);
    assert.equal(config.piInvocation.args.includes("--extension"), true);
    assert.deepEqual(config.deniedTools, []);
    assert.equal(config.env.OMPS_PARENT_RUN_ID, id);
    assert.equal(config.env.OMPS_FAST_MODE, "0", "children inherit an explicit default-off snapshot");
    const identity = JSON.parse(readFileSync(harness.paths(id).identityFile, "utf8"));
    assert.deepEqual(identity, {
      v: 1,
      token: config.token,
      runId: id,
      pid: 999,
      processIdentity: "process-999",
    });
    assert.equal(isDetachedRunnerIdentity(identity), true);
    assert.equal(statSync(harness.paths(id).identityFile).mode & 0o777, 0o600);
  } finally { harness.cleanup(); }
});

test("create and resume snapshot Fast Mode in both states and override stale shell environment", async () => {
  const harness = createHarness();
  const previousFast = process.env.OMPS_FAST_MODE;
  process.env.OMPS_FAST_MODE = "1";
  try {
    await harness.restore();
    harness.runtime.setFastModeResolver(() => false);
    const createdOff = await createRun(harness, { abstract: "fast off create", task: "off" });
    assert.equal(readConfig(harness, createdOff.details.run.id).env.OMPS_FAST_MODE, "0");

    harness.runtime.setFastModeResolver(() => true);
    const createdOn = await createRun(harness, { abstract: "fast on create", task: "on" });
    assert.equal(readConfig(harness, createdOn.details.run.id).env.OMPS_FAST_MODE, "1");

    const resumeWith = async (sourceId, enabled) => {
      const sessionFile = join(harness.tempDir, `${sourceId}.jsonl`);
      writeFileSync(sessionFile, "session");
      harness.runtime.registry.add(persistedRun({ id: sourceId, status: "completed", sessionFile }));
      harness.runtime.setModelResolver(() => "provider/model:high");
      harness.runtime.setDenyResolver(() => []);
      harness.runtime.setFastModeResolver(() => enabled);
      const resumed = await harness.tools.get("subagent").execute(`resume-${sourceId}`, {
        action: "resume", id: sourceId, abstract: `resume ${sourceId}`, message: "continue",
      });
      return readConfig(harness, resumed.details.run.id).env.OMPS_FAST_MODE;
    };
    assert.equal(await resumeWith("source-fast-off", false), "0");
    assert.equal(await resumeWith("source-fast-on", true), "1");
  } finally {
    if (previousFast === undefined) delete process.env.OMPS_FAST_MODE;
    else process.env.OMPS_FAST_MODE = previousFast;
    harness.cleanup();
  }
});

test("create persists exact deny entries and emits --exclude-tools without a positive allowlist", async () => {
  const harness = createHarness();
  try {
    await harness.restore();
    harness.runtime.setModelResolver((agent) => `preset/${agent}:high`);
    harness.runtime.setDenyResolver(() => ["ask_user_question", "future_plugin_tool"]);
    const result = await harness.tools.get("subagent").execute("create", {
      action: "create",
      agent: "observer",
      abstract: "inspect screenshot",
      task: "inspect the screenshot",
    });
    const id = result.details.run.id;
    const config = readConfig(harness, id);
    assert.equal(result.details.run.agent, "observer");
    assert.deepEqual(result.details.run.deniedTools, ["ask_user_question", "future_plugin_tool"]);
    assert.deepEqual(config.deniedTools, ["ask_user_question", "future_plugin_tool"]);
    assert.equal(config.piInvocation.args.includes("--tools"), false);
    const denyIndex = config.piInvocation.args.indexOf("--exclude-tools");
    assert.notEqual(denyIndex, -1);
    assert.equal(config.piInvocation.args[denyIndex + 1], "ask_user_question,future_plugin_tool");
  } finally { harness.cleanup(); }
});

test("each create resolves the current deny policy while active runs retain launch-time policy", async () => {
  const harness = createHarness();
  try {
    await harness.restore();
    harness.runtime.setModelResolver((agent) => `preset/${agent}:high`);
    let policy = ["first_tool"];
    harness.runtime.setDenyResolver(() => policy);
    const first = await harness.tools.get("subagent").execute("create", {
      action: "create", agent: "fixer", abstract: "first summary", task: "first",
    });
    policy = ["second_tool"];
    const second = await harness.tools.get("subagent").execute("create", {
      action: "create", agent: "explorer", abstract: "second summary", task: "second",
    });
    assert.deepEqual(harness.runtime.registry.get(first.details.run.id).deniedTools, ["first_tool"]);
    assert.deepEqual(harness.runtime.registry.get(second.details.run.id).deniedTools, ["second_tool"]);
    assert.deepEqual(readConfig(harness, first.details.run.id).deniedTools, ["first_tool"]);
    assert.deepEqual(readConfig(harness, second.details.run.id).deniedTools, ["second_tool"]);
  } finally { harness.cleanup(); }
});

test("runtime rejects lifecycle tools from a launch-time deny resolver", async () => {
  const harness = createHarness();
  try {
    await harness.restore();
    harness.runtime.setModelResolver((agent) => `preset/${agent}:high`);
    for (const reserved of ["subagent", "contact_supervisor"]) {
      harness.runtime.setDenyResolver(() => [reserved]);
      await assert.rejects(
        harness.tools.get("subagent").execute("create", { action: "create", agent: "fixer", abstract: "x", task: "x" }),
        new RegExp(`${reserved}.*cannot be denied`),
      );
    }
    assert.equal(harness.runtime.registry.list().length, 0);
    assert.equal(harness.launches.length, 0);
  } finally { harness.cleanup(); }
});

test("create stops the just-spawned PID and retains its directory when process identity is unavailable", async () => {
  const sleeps = [];
  let harness;
  harness = createHarness({
    keepAliveAfterTerm: true,
    sleep: async (ms) => {
      sleeps.push(ms);
      const [run] = harness.runtime.registry.list();
      assert.equal(existsSync(harness.paths(run.id).runDir), true, "run directory remains during termination grace");
      assert.equal(harness.alive.has(999), sleeps.length === 1, "termination waits until exit is confirmed");
    },
  });
  try {
    await harness.restore();
    harness.alive.add(999);
    harness.setProcessIdentity(999, undefined);
    const result = await createRun(harness);
    const run = result.details.run;
    assert.deepEqual(run, {
      id: run.id,
      agent: "fixer",
      abstract: "detached summary",
      task: "detached task",
      cwd: ROOT,
      model: "preset/fixer:high",
      deniedTools: [],
      status: "failed",
      createdAt: new Date(NOW_MS).toISOString(),
      updatedAt: new Date(NOW_MS).toISOString(),
      error: "Could not capture OS process identity for detached runner PID 999.",
      notificationPending: "failed",
      live: false,
    });
    assert.deepEqual(harness.killed, [
      { pid: -999, signal: "SIGTERM" },
      { pid: -999, signal: "SIGKILL" },
    ]);
    assert.deepEqual(sleeps, [1500, 1500]);
    assert.equal(existsSync(harness.paths(run.id).runDir), true, "terminal run directories are retained until clear");
  } finally { harness.cleanup(); }
});

test("create retains the run directory when the just-spawned PID cannot be confirmed exited", async () => {
  const sleeps = [];
  const harness = createHarness({ keepAliveAfterKill: true, sleep: async (ms) => { sleeps.push(ms); } });
  try {
    await harness.restore();
    harness.alive.add(999);
    harness.setProcessIdentity(999, undefined);
    const result = await createRun(harness);
    const run = result.details.run;
    assert.equal(run.status, "failed");
    assert.match(run.error, /capture OS process identity/);
    assert.deepEqual(harness.killed, [
      { pid: -999, signal: "SIGTERM" },
      { pid: -999, signal: "SIGKILL" },
    ]);
    assert.deepEqual(sleeps, [1500, 1500]);
    assert.equal(harness.alive.has(999), true);
    assert.equal(existsSync(harness.paths(run.id).runDir), true);
    assert.equal(harness.journalWrites.length, 2, "starting and failed-pending states are journaled before acknowledgement");
    assert.equal(harness.notifications.length, 1);
  } finally { harness.cleanup(); }
});

test("create failure returns the complete failed run", async () => {
  const harness = createHarness({ launchError: new Error("spawn failed") });
  try {
    await harness.restore();
    const result = await createRun(harness);
    const run = result.details.run;
    assert.match(result.content[0].text, new RegExp(`${run.id}.*status failed`));
    assert.deepEqual(run, {
      id: run.id,
      agent: "fixer",
      abstract: "detached summary",
      task: "detached task",
      cwd: ROOT,
      model: "preset/fixer:high",
      deniedTools: [],
      status: "failed",
      createdAt: new Date(NOW_MS).toISOString(),
      updatedAt: new Date(NOW_MS).toISOString(),
      error: "spawn failed",
      notificationPending: "failed",
      live: false,
    });
    assert.equal(harness.runtime.registry.isLive(run.id), false);
    assert.equal(harness.journalWrites.length, 2, "starting and failed-pending states are journaled before acknowledgement");
    assert.equal(existsSync(harness.paths(run.id).runDir), true, "terminal run directories are retained until clear");
  } finally { harness.cleanup(); }
});

test("poll folds logical state but activity and heartbeat changes do not journal", async () => {
  const harness = createHarness();
  try {
    await harness.restore();
    const started = await createRun(harness);
    const id = started.details.run.id;
    const config = readConfig(harness, id);
    harness.alive.add(999);
    atomicWriteJson(harness.paths(id).stateFile, stateFor(id, config.token, {
      sessionFile: join(harness.tempDir, "child.jsonl"),
      turnCount: 2,
      toolUses: 1,
      activeTools: { read1: { name: "read" } },
      responseText: "working",
      tokens: 1200,
      contextPercent: 45,
      compactionCount: 1,
    }));
    await inspect(harness, id);
    assert.equal(harness.runtime.registry.get(id).status, "running");
    assert.equal(harness.journalWrites.length, 2, "starting and running only");

    atomicWriteJson(harness.paths(id).stateFile, stateFor(id, config.token, {
      heartbeatAt: new Date(NOW_MS + 1000).toISOString(),
      sessionFile: join(harness.tempDir, "child.jsonl"),
      turnCount: 3,
      responseText: "more activity",
    }));
    const status = await inspect(harness, id);
    assert.equal(harness.journalWrites.length, 2);
    assert.equal(status.activity.turnCount, 3);
    assert.equal(status.activity.responseText, "more activity");
  } finally { harness.cleanup(); }
});

test("waiting notification and subagent reply use run ID and waiting sequence", async () => {
  const harness = createHarness();
  try {
    await harness.restore();
    const started = await createRun(harness);
    const id = started.details.run.id;
    const config = readConfig(harness, id);
    harness.alive.add(999);
    atomicWriteJson(harness.paths(id).stateFile, stateFor(id, config.token, {
      status: "waiting", waitingSeq: 1,
      request: {
        runId: id, reason: "need_decision", message: "choose",
        interview: { title: "Choose", questions: [{ prompt: "A or B?" }] },
        createdAt: new Date(NOW_MS).toISOString(),
      },
    }));
    await inspect(harness, id);
    const waitingDelivery = harness.notifications.at(-1);
    const waitingNotification = waitingDelivery.message;
    assert.deepEqual(waitingDelivery.options, { deliverAs: "steer", triggerTurn: true });
    assert.equal(waitingNotification.display, true);
    assert.equal(waitingNotification.details.status, "waiting");
    assert.equal(waitingNotification.details.reason, "need_decision");
    assert.equal(waitingNotification.details.deliveryKey, expectedDeliveryKey(id, "waiting", 1));
    assert.equal(waitingNotification.details.waitingSeq, 1);
    assert.equal(waitingNotification.details.request.message, "choose");
    assert.match(waitingNotification.content, new RegExp(`"runId": "${id}"`));
    assert.match(waitingNotification.content, /"reason": "need_decision"/);
    assert.match(waitingNotification.content, /"interview"/);
    assert.match(waitingNotification.content, /"createdAt"/);
    assert.doesNotMatch(waitingNotification.content, /waitingSeq|request ID|req-1/);
    assert.equal(harness.runtime.registry.get(id).notificationPending, "waiting", "sendMessage does not acknowledge delivery");
    harness.runtime.deliverPendingNotification(id);
    assert.equal(harness.notifications.length, 1, "waiting delivery is queued only once before message_end");
    const reply = await harness.tools.get("subagent").execute("reply", {
      action: "reply", id, message: "option A",
    });
    assert.match(reply.content[0].text, /is running/);
    assert.deepEqual(controls(harness, id).at(-1), {
      v: 1, token: config.token, type: "reply", message: "option A", waitingSeq: 1,
    });
    assert.equal(harness.runtime.registry.get(id).request, undefined);
    assert.equal(harness.runtime.registry.get(id).notificationPending, undefined, "reply keeps the existing waiting-marker clear semantics");

    const notificationsAfterReply = harness.notifications.length;
    atomicWriteJson(harness.paths(id).stateFile, stateFor(id, config.token, {
      status: "waiting",
      heartbeatAt: new Date(NOW_MS + 100).toISOString(),
      turnCount: 7,
      responseText: "runner has not consumed reply yet",
      waitingSeq: 1,
      request: { runId: id, reason: "need_decision", message: "choose", createdAt: new Date(NOW_MS).toISOString() },
    }));
    const stalePoll = await inspect(harness, id);
    assert.equal(harness.runtime.registry.get(id).status, "running", "stale waiting state is suppressed during reply grace");
    assert.equal(harness.runtime.registry.get(id).request, undefined);
    assert.equal(stalePoll.activity.turnCount, 7, "suppressed state still refreshes activity");
    assert.equal(stalePoll.activity.responseText, "runner has not consumed reply yet");
    assert.equal(harness.notifications.length, notificationsAfterReply, "stale waiting does not notify twice");

    atomicWriteJson(harness.paths(id).stateFile, stateFor(id, config.token, { status: "running" }));
    await inspect(harness, id);
    assert.equal(harness.runtime.registry.get(id).status, "running");

    atomicWriteJson(harness.paths(id).stateFile, stateFor(id, config.token, {
      status: "completed", output: "done after reply", responseText: "done after reply",
    }));
    await inspect(harness, id);
    assert.equal(harness.runtime.registry.get(id).status, "completed");
    assert.equal(harness.notifications.at(-1).message.details.status, "completed");
  } finally { harness.cleanup(); }
});

test("subagent reply validation is strict", async () => {
  const harness = createHarness();
  try {
    await harness.restore();
    await assert.rejects(harness.tools.get("subagent").execute("unknown", {
      action: "reply", id: "missing", message: "continue",
    }), /Unknown subagent run/);
    const started = await createRun(harness);
    const id = started.details.run.id;
    const config = readConfig(harness, id);
    harness.alive.add(999);
    atomicWriteJson(harness.paths(id).stateFile, stateFor(id, config.token));
    await inspect(harness, id);
    await assert.rejects(harness.tools.get("subagent").execute("running", {
      action: "reply", id, message: "continue",
    }), /reply requires a waiting run/);
    await assert.rejects(harness.tools.get("subagent").execute("missing-message", {
      action: "reply", id,
    }), /message must be a non-empty string/);
    await assert.rejects(harness.tools.get("subagent").execute("extra", {
      action: "reply", id, message: "continue", abstract: "forbidden",
    }), /reply does not accept create field.*abstract/i);
  } finally { harness.cleanup(); }
});

test("legacy waiting state without waitingSeq is not replyable and writes no control", async () => {
  const harness = createHarness();
  try {
    await harness.restore();
    const started = await createRun(harness);
    const id = started.details.run.id;
    const config = readConfig(harness, id);
    harness.alive.add(999);
    atomicWriteJson(harness.paths(id).stateFile, stateFor(id, config.token, {
      status: "waiting",
      request: {
        id: "legacy-request-id",
        runId: id,
        reason: "need_decision",
        message: "legacy runner request",
        createdAt: new Date(NOW_MS).toISOString(),
      },
    }));
    await inspect(harness, id);
    assert.equal(harness.runtime.registry.get(id).status, "waiting");
    assert.equal(harness.runtime.registry.get(id).waitingSeq, undefined);
    const controlsBefore = harness.controlWrites.length;
    await assert.rejects(
      harness.tools.get("subagent").execute("legacy-reply", { action: "reply", id, message: "continue" }),
      /no replyable waiting sequence/,
    );
    assert.equal(harness.controlWrites.length, controlsBefore);
    assert.deepEqual(controls(harness, id), []);
  } finally { harness.cleanup(); }
});

test("waiting delivery keys isolate sequence cycles and stale acknowledgements", async () => {
  const harness = createHarness();
  try {
    await harness.restore();
    const started = await createRun(harness);
    const id = started.details.run.id;
    const config = readConfig(harness, id);
    harness.alive.add(999);
    atomicWriteJson(harness.paths(id).stateFile, stateFor(id, config.token, {
      status: "waiting", waitingSeq: 1,
      request: { runId: id, reason: "need_decision", message: "old", createdAt: new Date(NOW_MS).toISOString() },
    }));
    await inspect(harness, id);
    const oldMessage = harness.notifications.at(-1).message;
    await harness.tools.get("subagent").execute("reply-old", { action: "reply", id, message: "continue" });
    atomicWriteJson(harness.paths(id).stateFile, stateFor(id, config.token, {
      status: "running", waitingSeq: 1, heartbeatAt: new Date(NOW_MS + 100).toISOString(),
    }));
    await inspect(harness, id);
    atomicWriteJson(harness.paths(id).stateFile, stateFor(id, config.token, {
      status: "waiting", waitingSeq: 2, heartbeatAt: new Date(NOW_MS + 200).toISOString(),
      request: { runId: id, reason: "interview_request", message: "new", createdAt: new Date(NOW_MS + 200).toISOString() },
    }));
    await inspect(harness, id);
    const newMessage = harness.notifications.at(-1).message;
    assert.equal(newMessage.details.deliveryKey, expectedDeliveryKey(id, "waiting", 2));
    assert.notEqual(newMessage.details.deliveryKey, oldMessage.details.deliveryKey);
    assert.equal(harness.runtime.registry.get(id).notificationPending, "waiting");
    assert.equal(harness.runtime.registry.get(id).waitingSeq, 2);

    assert.equal(harness.runtime.acknowledgeNotificationMessage(deliveredMessage(oldMessage)), false);
    assert.equal(harness.runtime.queuedNotifications.has(oldMessage.details.deliveryKey), false);
    assert.equal(harness.runtime.queuedNotifications.has(newMessage.details.deliveryKey), true);
    assert.equal(harness.runtime.registry.get(id).notificationPending, "waiting");
    assert.equal(harness.runtime.acknowledgeNotificationMessage(deliveredMessage(newMessage, {
      runId: id,
      event: "waiting",
      status: "waiting",
      requestId: "legacy-request-id",
      deliveryKey: `oh-my-pi-slim:subagent-notification:${JSON.stringify([id, "waiting", "legacy-request-id"])}`,
    })), false);
    assert.equal(harness.runtime.registry.get(id).notificationPending, "waiting");
    assert.equal(harness.runtime.queuedNotifications.has(newMessage.details.deliveryKey), true,
      "a legacy requestId acknowledgement cannot clear the current waiting sequence");
    const { deliveryKey: _deliveryKey, ...matchingWaitingDetails } = newMessage.details;
    assert.equal(harness.runtime.acknowledgeNotificationMessage(deliveredMessage(newMessage, matchingWaitingDetails)), true);
    assert.equal(harness.runtime.registry.get(id).notificationPending, undefined);
  } finally { harness.cleanup(); }
});

test("waiting-to-waiting sequence replacement creates a new notification after prior acknowledgement", async () => {
  const harness = createHarness();
  try {
    await harness.restore();
    const started = await createRun(harness);
    const id = started.details.run.id;
    const config = readConfig(harness, id);
    harness.alive.add(999);
    atomicWriteJson(harness.paths(id).stateFile, stateFor(id, config.token, {
      status: "waiting", waitingSeq: 1,
      request: { runId: id, reason: "need_decision", message: "first", createdAt: new Date(NOW_MS).toISOString() },
    }));
    await inspect(harness, id);
    const firstMessage = harness.notifications.at(-1).message;
    assert.equal(harness.runtime.acknowledgeNotificationMessage(deliveredMessage(firstMessage)), true);

    atomicWriteJson(harness.paths(id).stateFile, stateFor(id, config.token, {
      status: "waiting", waitingSeq: 2, heartbeatAt: new Date(NOW_MS + 100).toISOString(),
      request: { runId: id, reason: "interview_request", message: "second", createdAt: new Date(NOW_MS + 100).toISOString() },
    }));
    await inspect(harness, id);
    const secondMessage = harness.notifications.at(-1).message;
    assert.equal(harness.notifications.length, 2);
    assert.equal(secondMessage.details.deliveryKey, expectedDeliveryKey(id, "waiting", 2));
    assert.equal(harness.runtime.registry.get(id).notificationPending, "waiting");
    assert.equal(harness.runtime.registry.get(id).waitingSeq, 2);
    assert.equal(harness.runtime.acknowledgeNotificationMessage(deliveredMessage(firstMessage)), false);
    assert.equal(harness.runtime.registry.get(id).notificationPending, "waiting");
  } finally { harness.cleanup(); }
});

test("reply grace suppression still fails a stale waiting runner whose PID dies", async () => {
  const harness = createHarness();
  try {
    await harness.restore();
    const started = await createRun(harness);
    const id = started.details.run.id;
    const config = readConfig(harness, id);
    harness.alive.add(999);
    atomicWriteJson(harness.paths(id).stateFile, stateFor(id, config.token, {
      status: "waiting", waitingSeq: 1,
      request: { runId: id, reason: "need_decision", message: "choose", createdAt: new Date(NOW_MS).toISOString() },
    }));
    await inspect(harness, id);
    await harness.tools.get("subagent").execute("reply", { action: "reply", id, message: "option A" });
    harness.alive.delete(999);
    await inspect(harness, id);
    assert.equal(harness.runtime.registry.get(id).status, "failed");
    assert.match(harness.runtime.registry.get(id).error, /exited/);
  } finally { harness.cleanup(); }
});

test("stale waiting state is restored after the supervisor reply grace expires", async () => {
  const harness = createHarness();
  try {
    await harness.restore();
    const started = await createRun(harness);
    const id = started.details.run.id;
    const config = readConfig(harness, id);
    harness.alive.add(999);
    atomicWriteJson(harness.paths(id).stateFile, stateFor(id, config.token, {
      status: "waiting", waitingSeq: 1,
      request: { runId: id, reason: "need_decision", message: "choose", createdAt: new Date(NOW_MS).toISOString() },
    }));
    await inspect(harness, id);
    await harness.tools.get("subagent").execute("reply", { action: "reply", id, message: "option A" });
    harness.advance(5001);
    await inspect(harness, id);
    assert.equal(harness.runtime.registry.get(id).status, "waiting");
    assert.equal(harness.runtime.registry.get(id).waitingSeq, 1);
    assert.equal(harness.notifications.filter(({ message }) => message.details.status === "waiting").length, 1,
      "the same waiting sequence is not enqueued twice in one session");
  } finally { harness.cleanup(); }
});

test("steer only enqueues a control and returns requested", async () => {
  const harness = createHarness();
  try {
    await harness.restore();
    const started = await createRun(harness);
    const id = started.details.run.id;
    const config = readConfig(harness, id);
    harness.alive.add(999);
    atomicWriteJson(harness.paths(id).stateFile, stateFor(id, config.token));
    await inspect(harness, id);
    await assert.rejects(
      harness.tools.get("subagent").execute("slash-steer", { action: "steer", id, message: "  /compact now" }),
      /steer messages beginning with \/ are unsupported/i,
    );
    assert.equal(controls(harness, id).length, 0, "a slash steer is rejected before any control write");

    const result = await harness.tools.get("subagent").execute("steer", { action: "steer", id, message: "focus" });
    assert.match(result.content[0].text, /requested/i);
    assert.equal(controls(harness, id).at(-1).type, "steer");
    assert.equal(harness.runtime.registry.get(id).status, "running");
  } finally { harness.cleanup(); }
});

test("a steer that loses the terminal race stays compact while the queued notification keeps the only full result", async () => {
  for (const { status, output, error } of [
    { status: "completed", output: "TERMINAL_RACE_OUTPUT_SENTINEL\nsecond output line", error: undefined },
    { status: "failed", output: undefined, error: "TERMINAL_RACE_ERROR_SENTINEL\nsecond error line" },
    { status: "interrupted", output: "TERMINAL_RACE_PARTIAL_SENTINEL", error: "TERMINAL_RACE_STOP_SENTINEL" },
  ]) {
    const harness = createHarness();
    try {
      await harness.restore();
      const started = await createRun(harness, { task: "TERMINAL_RACE_TASK_SENTINEL" });
      const id = started.details.run.id;
      const config = readConfig(harness, id);
      harness.alive.add(999);
      atomicWriteJson(harness.paths(id).stateFile, stateFor(id, config.token));
      await inspect(harness, id);
      assert.equal(harness.runtime.registry.get(id).status, "running");
      assert.equal(harness.notifications.length, 0);

      // The run reaches a terminal status after the model chose steer but before the tool reconciles.
      atomicWriteJson(harness.paths(id).stateFile, stateFor(id, config.token, {
        status,
        output,
        error,
        sessionFile: join(harness.tempDir, "session.jsonl"),
      }));
      const result = await harness.tools.get("subagent").execute("steer", { action: "steer", id, message: "too late" });

      assert.equal(result.content[0].text, `${id} is already ${status}.`);
      assert.deepEqual(Object.keys(result.details.run).sort(), ["abstract", "agent", "id", "live", "status"]);
      assert.deepEqual(result.details.run, { id, agent: "fixer", abstract: "detached summary", status, live: false });
      assert.equal(result.details.run.output, undefined);
      assert.equal(result.details.run.error, undefined);
      assert.equal(result.details.run.activity, undefined);
      assert.equal(result.details.run.task, undefined);
      assert.equal(result.details.run.sessionFile, undefined);
      assert.doesNotMatch(JSON.stringify(result.details), /SENTINEL/);
      assert.equal(controls(harness, id).length, 0, "a terminal run never receives a steer control");

      // The queued terminal lifecycle notification stays the single automatic full-result delivery.
      assert.equal(harness.notifications.length, 1);
      const sent = harness.notifications[0];
      assert.deepEqual(sent.options, { deliverAs: "steer", triggerTurn: true });
      assert.equal(sent.message.details.event, status);
      assert.equal(sent.message.details.deliveryKey, expectedDeliveryKey(id, status));
      assert.equal(sent.message.details.run.output, output);
      assert.equal(sent.message.details.run.error, error);
      assert.equal(sent.message.details.run.task, "TERMINAL_RACE_TASK_SENTINEL");
      assert.equal(harness.runtime.registry.get(id).notificationPending, status);
      assert.equal(harness.runtime.queuedNotifications.has(sent.message.details.deliveryKey), true);

      // Acknowledgement lifecycle is untouched by the compact steer receipt.
      assert.equal(harness.runtime.acknowledgeNotificationMessage(deliveredMessage(sent.message)), true);
      assert.equal(harness.runtime.registry.get(id).notificationPending, undefined);
      assert.equal(harness.runtime.queuedNotifications.has(sent.message.details.deliveryKey), false);
      assert.equal(harness.notifications.length, 1);

      // subagent status remains the explicit entry point for the complete terminal result.
      const statusResult = await harness.tools.get("subagent").execute("status", { action: "status", id });
      assert.equal(statusResult.details.run.output, output);
      assert.equal(statusResult.details.run.error, error);
    } finally { harness.cleanup(); }
  }
});

test("interrupt stops a running run synchronously, returns the full result, and sends no notification", async () => {
  const harness = createInterruptHarness();
  try {
    await harness.restore();
    const { id, config } = await startRunningRun(harness);
    assert.equal(harness.notifications.length, 0);
    harness.onNextSleep(() => atomicWriteJson(harness.paths(id).stateFile, stateFor(id, config.token, {
      status: "interrupted",
      output: "INTERRUPT_PARTIAL_SENTINEL",
      error: "Interrupted by supervisor.",
      sessionFile: join(harness.tempDir, "session.jsonl"),
    })));

    const result = await interrupt(harness, id);

    assert.equal(result.details.outcome, "stopped");
    assert.equal(result.details.run.status, "interrupted");
    assert.equal(result.details.run.output, "INTERRUPT_PARTIAL_SENTINEL");
    assert.equal(result.details.run.error, "Interrupted by supervisor.");
    assert.match(result.content[0].text, /Output: INTERRUPT_PARTIAL_SENTINEL/);
    assert.match(result.content[0].text, /Error: Interrupted by supervisor\./);
    assert.equal(controls(harness, id).filter(({ type }) => type === "interrupt").length, 1);
    assert.deepEqual(harness.killed, [], "a runner that honors the interrupt control is never signaled");

    assert.equal(harness.notifications.length, 0, "the interrupting tool call owns the only delivery");
    assert.equal(harness.runtime.registry.get(id).notificationPending, undefined);
    assert.equal(harness.runtime.queuedNotifications.size, 0);
    const pendingJournal = harness.journalWrites.filter(({ data }) => data.run?.notificationPending === "interrupted");
    assert.equal(pendingJournal.length >= 1, true, "the wait window still journals a crash-safe pending marker");
    assert.equal(harness.journalWrites.at(-1).data.run.notificationPending, undefined);

    harness.runtime.retryQueuedNotificationsAfterAgentSettled();
    assert.equal(harness.notifications.length, 0, "no queued retry can match the handed-back terminal event");

    const next = createHarness({ branch: harness.journalWrites.map(({ data }) => branchEntry(data)) });
    try {
      await next.restore();
      assert.equal(next.runtime.registry.get(id).status, "interrupted");
      assert.equal(next.notifications.length, 0, "a handed-back terminal event never replays after restore");
    } finally { next.cleanup(); }
  } finally { harness.cleanup(); }
});

test("interrupting a waiting run keeps its waiting notification and adds no retry", async () => {
  const harness = createInterruptHarness();
  try {
    await harness.restore();
    const { id, config } = await startRunningRun(harness, (runId) => ({
      status: "waiting",
      waitingSeq: 1,
      request: { runId, reason: "need_decision", message: "choose", createdAt: new Date(NOW_MS).toISOString() },
    }));
    assert.equal(harness.notifications.length, 1);
    assert.equal(harness.notifications[0].message.details.status, "waiting");
    const waitingKey = harness.notifications[0].message.details.deliveryKey;
    assert.equal(harness.runtime.queuedNotifications.has(waitingKey), true);
    harness.onNextSleep(() => atomicWriteJson(harness.paths(id).stateFile, stateFor(id, config.token, {
      status: "interrupted", error: "Interrupted by supervisor.",
    })));

    const result = await interrupt(harness, id);

    assert.equal(result.details.outcome, "stopped");
    assert.equal(result.details.run.status, "interrupted");
    assert.equal(result.details.run.request, undefined);
    assert.equal(harness.notifications.length, 1, "only the earlier waiting notification exists");
    assert.equal(harness.runtime.registry.get(id).notificationPending, undefined);

    harness.runtime.retryQueuedNotificationsAfterAgentSettled();
    assert.equal(harness.notifications.length, 1, "the stale waiting key is dropped without a retry");
    assert.equal(harness.runtime.queuedNotifications.size, 0);
  } finally { harness.cleanup(); }
});

test("interrupt accepts natural completion inside its wait window and never sends a terminal notification", async () => {
  const harness = createInterruptHarness();
  try {
    await harness.restore();
    const { id, config } = await startRunningRun(harness);
    harness.onNextSleep(() => atomicWriteJson(harness.paths(id).stateFile, stateFor(id, config.token, {
      status: "completed", output: "RACED_OUTPUT_SENTINEL", responseText: "RACED_OUTPUT_SENTINEL",
    })));

    const result = await interrupt(harness, id);

    assert.equal(result.details.outcome, "raced");
    assert.equal(result.details.run.status, "completed");
    assert.equal(result.details.run.output, "RACED_OUTPUT_SENTINEL");
    assert.match(result.content[0].text, /reached completed before the interrupt stopped it/);
    assert.match(result.content[0].text, /Output: RACED_OUTPUT_SENTINEL/);
    assert.deepEqual(harness.killed, []);
    assert.equal(harness.notifications.length, 0, "an authoritative natural terminal state is handed back, not notified");
    assert.equal(harness.runtime.registry.get(id).notificationPending, undefined);
    assert.equal(harness.runtime.queuedNotifications.size, 0);
  } finally { harness.cleanup(); }
});

test("interrupt of an already terminal run writes no control and never steals its notification", async () => {
  const harness = createInterruptHarness();
  try {
    await harness.restore();
    const { id, config } = await startRunningRun(harness);
    atomicWriteJson(harness.paths(id).stateFile, stateFor(id, config.token, {
      status: "completed", output: "ALREADY_TERMINAL_SENTINEL", responseText: "ALREADY_TERMINAL_SENTINEL",
    }));

    const result = await interrupt(harness, id);

    assert.equal(result.content[0].text, `${id} is already completed.`);
    assert.equal(result.details.outcome, "already-terminal");
    assert.deepEqual(Object.keys(result.details.run).sort(), ["abstract", "agent", "id", "live", "status"]);
    assert.doesNotMatch(JSON.stringify(result.details), /SENTINEL/);
    assert.equal(controls(harness, id).length, 0, "a terminal run never receives an interrupt control");
    assert.deepEqual(harness.killed, []);

    assert.equal(harness.notifications.length, 1, "the reconciled terminal notification keeps the full result");
    assert.equal(harness.notifications[0].message.details.status, "completed");
    assert.equal(harness.notifications[0].message.details.run.output, "ALREADY_TERMINAL_SENTINEL");
    assert.equal(harness.runtime.registry.get(id).notificationPending, "completed");
  } finally { harness.cleanup(); }
});

test("interrupt escalates to verified SIGTERM then SIGKILL when the runner never publishes a terminal state", async () => {
  const sleeps = [];
  let harness;
  harness = createInterruptHarness({
    keepAliveAfterTerm: true,
    sleep: async (ms) => {
      sleeps.push(ms);
      harness.advance(ms);
    },
  });
  try {
    await harness.restore();
    const { id } = await startRunningRun(harness);

    const result = await interrupt(harness, id);

    assert.equal(result.details.outcome, "stopped");
    assert.equal(result.details.run.status, "interrupted");
    assert.equal(result.details.run.error, "Interrupted by the parent session.");
    assert.deepEqual(harness.killed, [
      { pid: -999, signal: "SIGTERM" },
      { pid: -999, signal: "SIGKILL" },
    ]);
    assert.deepEqual(sleeps.slice(-2), [1500, 1500]);
    assert.equal(controls(harness, id).filter(({ type }) => type === "interrupt").length, 1);
    assert.equal(harness.notifications.length, 0);
    assert.equal(harness.runtime.registry.get(id).notificationPending, undefined);
  } finally { harness.cleanup(); }
});

test("interrupt never signals an unverifiable runner and reports an unconfirmed stop", async () => {
  const errors = [];
  const originalConsoleError = console.error;
  console.error = (...args) => { errors.push(args.join(" ")); };
  const harness = createInterruptHarness();
  try {
    await harness.restore();
    const { id } = await startRunningRun(harness);
    harness.setProcessIdentity(999, "reused-process");

    const result = await interrupt(harness, id);

    assert.equal(result.details.outcome, "unconfirmed");
    assert.equal(result.details.run.status, "interrupted");
    assert.match(result.content[0].text, /did not confirm that it stopped and its run directory is retained/);
    assert.deepEqual(harness.killed, [], "a PID-reused or unverifiable process is never signaled");
    assert.equal(existsSync(harness.paths(id).runDir), true);
    assert.equal(harness.notifications.length, 0);
    assert.equal(harness.runtime.registry.get(id).notificationPending, undefined);
    assert.equal(errors.some((line) => line.includes("Retaining unverifiable detached run directory")), true);
  } finally {
    console.error = originalConsoleError;
    harness.cleanup();
  }
});

test("interrupt of a dead runner adopts the failed reconciliation without a control", async () => {
  const harness = createInterruptHarness();
  try {
    await harness.restore();
    const started = await createRun(harness);
    const id = started.details.run.id;
    const config = readConfig(harness, id);
    harness.alive.add(999);
    atomicWriteJson(harness.paths(id).stateFile, stateFor(id, config.token));
    await inspect(harness, id);
    harness.alive.delete(999);

    const result = await interrupt(harness, id);

    assert.equal(result.details.outcome, "already-terminal");
    assert.equal(result.details.run.status, "failed");
    assert.equal(result.content[0].text, `${id} is already failed.`);
    assert.equal(controls(harness, id).length, 0);
    assert.equal(harness.notifications.length, 1, "the reconciled failure keeps its own notification");
    assert.equal(harness.notifications[0].message.details.status, "failed");
    assert.match(harness.runtime.registry.get(id).error, /exited/);
  } finally { harness.cleanup(); }
});

test("two concurrent interrupts share one termination and both receive the same final result", async () => {
  const harness = createInterruptHarness();
  try {
    await harness.restore();
    const { id, config } = await startRunningRun(harness);
    harness.onNextSleep(() => atomicWriteJson(harness.paths(id).stateFile, stateFor(id, config.token, {
      status: "interrupted", output: "SHARED_STOP_SENTINEL", error: "Interrupted by supervisor.",
    })));

    const [first, second] = await Promise.all([interrupt(harness, id), interrupt(harness, id)]);

    assert.equal(controls(harness, id).filter(({ type }) => type === "interrupt").length, 1,
      "one shared termination writes one interrupt control");
    for (const result of [first, second]) {
      assert.equal(result.details.run.status, "interrupted");
      assert.equal(result.details.run.output, "SHARED_STOP_SENTINEL");
      assert.equal(["stopped", "already-terminal"].includes(result.details.outcome), true);
    }
    assert.equal(harness.notifications.length, 0);
    assert.equal(harness.runtime.registry.get(id).notificationPending, undefined);
    assert.equal(harness.runtime.terminating.size, 0);
  } finally { harness.cleanup(); }
});

test("poller reconciliation during an interrupt never delivers the suppressed terminal notification", async () => {
  const harness = createInterruptHarness();
  try {
    await harness.restore();
    const { id, config } = await startRunningRun(harness);
    harness.onNextSleep(() => {
      atomicWriteJson(harness.paths(id).stateFile, stateFor(id, config.token, {
        status: "interrupted", output: "POLLED_STOP_SENTINEL", error: "Interrupted by supervisor.",
      }));
      for (const timer of harness.intervals) timer.callback();
    });

    const result = await interrupt(harness, id);

    assert.equal(result.details.run.status, "interrupted");
    assert.equal(result.details.run.output, "POLLED_STOP_SENTINEL");
    assert.equal(harness.notifications.length, 0, "the poller shares the run-scoped suppression");
    assert.equal(harness.runtime.registry.get(id).notificationPending, undefined);
    assert.equal(harness.runtime.queuedNotifications.size, 0);
  } finally { harness.cleanup(); }
});

test("poller failure paths never duplicate a termination that an interrupt already owns", async () => {
  for (const mode of ["dead-runner", "stale-heartbeat"]) {
    const harness = createInterruptHarness();
    try {
      await harness.restore();
      const { id, config } = await startRunningRun(harness);
      harness.onNextSleep(() => {
        // The poller observes a failure signature that would normally fail the run, write another interrupt
        // control, and signal the process while the interrupt already owns this termination.
        if (mode === "dead-runner") {
          harness.alive.delete(999);
          for (const timer of harness.intervals) timer.callback();
        } else {
          for (let pass = 0; pass < 2; pass += 1) {
            harness.advance(5001);
            for (const timer of harness.intervals) timer.callback();
          }
        }
        atomicWriteJson(harness.paths(id).stateFile, stateFor(id, config.token, {
          status: "interrupted", output: "OWNED_STOP_SENTINEL", error: "Interrupted by supervisor.",
        }));
      });

      const result = await interrupt(harness, id);

      assert.equal(result.details.outcome, "stopped", `${mode} must not change the owned termination outcome`);
      assert.equal(result.details.run.status, "interrupted");
      assert.equal(result.details.run.output, "OWNED_STOP_SENTINEL");
      assert.equal(result.details.run.error, "Interrupted by supervisor.", `${mode} must not overwrite the authoritative diagnosis`);
      assert.match(result.content[0].text, /Output: OWNED_STOP_SENTINEL/);
      assert.equal(controls(harness, id).filter(({ type }) => type === "interrupt").length, 1,
        `${mode} must not write a second interrupt control`);
      assert.deepEqual(harness.killed, [], `${mode} must not signal a process the termination owner already handles`);
      assert.equal(harness.notifications.length, 0, `${mode} keeps the single direct handoff`);
      assert.equal(harness.runtime.registry.get(id).status, "interrupted");
      assert.equal(harness.runtime.registry.get(id).error, "Interrupted by supervisor.");
      assert.equal(harness.runtime.registry.get(id).notificationPending, undefined);
      assert.equal(harness.runtime.queuedNotifications.size, 0);
      assert.equal(harness.runtime.terminating.size, 0);
    } finally { harness.cleanup(); }
  }
});

test("an interrupt waits out a reconciliation that already owns the stop and never duplicates it", async () => {
  let harness;
  let releaseStopGrace;
  let stopGraceEntered;
  const stopGraceReached = new Promise((resolve) => { stopGraceEntered = resolve; });
  harness = createHarness({
    interruptWaitMs: 50,
    sleep: async (ms) => {
      if (ms === 1500 && releaseStopGrace === undefined) {
        // Park the reconciliation pass inside its verified stop grace, proving it entered the async window.
        const parked = new Promise((resolve) => { releaseStopGrace = resolve; });
        stopGraceEntered();
        await parked;
      }
      harness.advance(ms);
    },
  });
  try {
    await harness.restore();
    const { id } = await startRunningRun(harness);

    // The poller reaches its stale-heartbeat failure first and starts terminating the run itself.
    for (let pass = 0; pass < 2; pass += 1) {
      harness.advance(5001);
      for (const timer of harness.intervals) timer.callback();
      await new Promise((resolve) => setImmediate(resolve));
    }
    await stopGraceReached;
    assert.equal(harness.runtime.reconciling.has(id), true, "the reconciliation pass must still be in flight");
    assert.equal(controls(harness, id).filter(({ type }) => type === "interrupt").length, 1,
      "the reconciliation pass owns the only interrupt control");
    assert.deepEqual(harness.killed, [{ pid: -999, signal: "SIGTERM" }]);
    assert.equal(harness.runtime.registry.get(id).status, "running", "the reconciliation has not concluded yet");

    // The explicit interrupt arrives while that pass is parked, so its own pre-reconcile returns immediately.
    const pending = interrupt(harness, id);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(harness.runtime.terminating.has(id), true, "the explicit termination registered ownership");
    assert.equal(harness.runtime.notificationSuppression.has(id), true, "suppression is held before any await");
    assert.equal(controls(harness, id).filter(({ type }) => type === "interrupt").length, 1,
      "the waiting termination must not write a second control");
    assert.deepEqual(harness.killed, [{ pid: -999, signal: "SIGTERM" }], "the waiting termination must not signal again");

    releaseStopGrace();
    const result = await pending;

    assert.equal(result.details.outcome, "raced");
    assert.equal(result.details.run.status, "failed");
    assert.equal(result.details.run.error, "Detached runner heartbeat no longer advances.",
      "the reconciliation diagnosis stays authoritative");
    assert.match(result.content[0].text, /Error: Detached runner heartbeat no longer advances\./);
    assert.equal(controls(harness, id).filter(({ type }) => type === "interrupt").length, 1,
      "the whole interleaving writes exactly one interrupt control");
    assert.deepEqual(harness.killed, [{ pid: -999, signal: "SIGTERM" }], "the whole interleaving signals exactly once");
    assert.equal(harness.notifications.length, 0, "the explicit interrupt hands back the reconciled result directly");
    assert.equal(harness.runtime.registry.get(id).status, "failed");
    assert.equal(harness.runtime.registry.get(id).error, "Detached runner heartbeat no longer advances.");
    assert.equal(harness.runtime.registry.get(id).notificationPending, undefined);
    assert.equal(harness.runtime.queuedNotifications.size, 0);
    assert.equal(harness.runtime.terminating.size, 0);
    assert.equal(harness.runtime.reconciling.has(id), false);

    harness.runtime.retryQueuedNotificationsAfterAgentSettled();
    assert.equal(harness.notifications.length, 0, "no queued retry can match the handed-back terminal event");
  } finally { harness.cleanup(); }
});

test("an aborted interrupt keeps its control and replays the pending notification exactly once", async () => {
  const controller = new AbortController();
  const harness = createInterruptHarness();
  try {
    await harness.restore();
    const { id, config } = await startRunningRun(harness);
    harness.onNextSleep(() => {
      atomicWriteJson(harness.paths(id).stateFile, stateFor(id, config.token, {
        status: "interrupted", output: "ABORTED_STOP_SENTINEL", error: "Interrupted by supervisor.",
      }));
      controller.abort();
    });

    await assert.rejects(
      harness.tools.get("subagent").execute("interrupt", { action: "interrupt", id }, controller.signal),
      (error) => error.name === "AbortError",
    );

    await settleTerminations(harness);
    assert.equal(controls(harness, id).filter(({ type }) => type === "interrupt").length, 1,
      "an aborted interrupt never reverts its written control");
    assert.equal(harness.runtime.registry.get(id).status, "interrupted");
    assert.equal(harness.runtime.registry.get(id).notificationPending, "interrupted");
    assert.equal(harness.notifications.length, 1, "the retained pending event is delivered exactly once");
    assert.equal(harness.notifications[0].message.details.status, "interrupted");
    assert.equal(harness.notifications[0].message.details.run.output, "ABORTED_STOP_SENTINEL");

    assert.equal(harness.runtime.acknowledgeNotificationMessage(deliveredMessage(harness.notifications[0].message)), true);
    harness.runtime.retryQueuedNotificationsAfterAgentSettled();
    assert.equal(harness.notifications.length, 1, "the acknowledged replay is never repeated");
  } finally { harness.cleanup(); }
});

test("a shutdown during an interrupt refuses the handoff and journals the pending notification for the next session", async () => {
  let harness;
  let shutdown;
  harness = createInterruptHarness({
    sleep: async (ms) => {
      const hook = harness.takeSleepHook();
      hook?.();
      harness.advance(ms);
    },
  });
  try {
    await harness.restore();
    const { id, config } = await startRunningRun(harness);
    harness.onNextSleep(() => {
      atomicWriteJson(harness.paths(id).stateFile, stateFor(id, config.token, {
        status: "interrupted", output: "SHUTDOWN_STOP_SENTINEL", error: "Interrupted by supervisor.",
      }));
      shutdown = harness.runtime.shutdown();
    });

    await assert.rejects(
      harness.tools.get("subagent").execute("interrupt", { action: "interrupt", id }),
      /can no longer hand back its result directly/,
    );
    await shutdown;

    assert.equal(harness.runtime.registry.get(id).status, "interrupted");
    assert.equal(harness.runtime.registry.get(id).notificationPending, "interrupted");
    assert.equal(harness.notifications.length, 0, "the closing parent receives no notification");
    assert.equal(harness.journalWrites.at(-1).data.run.notificationPending, "interrupted");

    const next = createHarness({ branch: harness.journalWrites.map(({ data }) => branchEntry(data)) });
    try {
      await next.restore();
      assert.equal(next.notifications.length, 1, "the next session replays the retained pending event once");
      assert.equal(next.notifications[0].message.details.status, "interrupted");
      assert.match(next.notifications[0].message.content, /SHUTDOWN_STOP_SENTINEL/);
    } finally { next.cleanup(); }
  } finally { harness.cleanup(); }
});

test("a restore during an interrupt refuses the handoff and delivers the pending notification exactly once", async () => {
  const branch = [];
  let harness;
  let restored;
  harness = createInterruptHarness({
    branch,
    onJournalWrite: ({ data }) => branch.push(branchEntry(data)),
    sleep: async (ms) => {
      const hook = harness.takeSleepHook();
      hook?.();
      harness.advance(ms);
    },
  });
  try {
    await harness.restore();
    const { id, config } = await startRunningRun(harness);
    harness.onNextSleep(() => {
      atomicWriteJson(harness.paths(id).stateFile, stateFor(id, config.token, {
        status: "interrupted", output: "RESTORED_STOP_SENTINEL", error: "Interrupted by supervisor.",
      }));
      restored = harness.restore();
    });

    await assert.rejects(
      harness.tools.get("subagent").execute("interrupt", { action: "interrupt", id }),
      /can no longer hand back its result directly/,
    );
    await restored;

    assert.equal(harness.runtime.registry.get(id).status, "interrupted");
    assert.equal(harness.notifications.length, 1, "the replaced session delivers the retained pending event once");
    assert.equal(harness.notifications[0].message.details.status, "interrupted");
    assert.match(harness.notifications[0].message.content, /RESTORED_STOP_SENTINEL/);

    assert.equal(harness.runtime.acknowledgeNotificationMessage(deliveredMessage(harness.notifications[0].message)), true);
    harness.runtime.retryQueuedNotificationsAfterAgentSettled();
    assert.equal(harness.notifications.length, 1, "the acknowledged replay is never repeated");
  } finally { harness.cleanup(); }
});

test("paused runtime holds waiting and terminal notifications, then unpauses each pending delivery once", async () => {
  const harness = createHarness();
  try {
    await harness.restore();
    const waiting = persistedRun({
      id: "waiting-run",
      status: "waiting",
      waitingSeq: 1,
      request: { runId: "waiting-run", reason: "need_decision", message: "choose", createdAt: new Date(NOW_MS).toISOString() },
      notificationPending: "waiting",
    });
    const terminal = persistedRun({
      id: "terminal-run",
      status: "completed",
      output: "done",
      notificationPending: "completed",
    });
    harness.runtime.setNotificationDeliveryPaused(true);
    harness.runtime.registry.restore([waiting, terminal]);
    harness.runtime.deliverPendingNotification(waiting.id);
    harness.runtime.deliverPendingNotification(terminal.id);
    assert.equal(harness.notifications.length, 0);
    assert.equal(harness.runtime.queuedNotifications.size, 0, "paused delivery must not enter the sent-message queue");
    assert.equal(harness.runtime.registry.get(waiting.id).notificationPending, "waiting");
    assert.equal(harness.runtime.registry.get(terminal.id).notificationPending, "completed");

    harness.runtime.setNotificationDeliveryPaused(false);
    assert.equal(harness.notifications.length, 2);
    assert.deepEqual(harness.notifications.map(({ message }) => message.details.status).sort(), ["completed", "waiting"]);
    harness.runtime.setNotificationDeliveryPaused(false);
    assert.equal(harness.notifications.length, 2, "repeated unpause does not send queued deliveries twice");
  } finally { harness.cleanup(); }
});

test("paused runtime preserves queued acknowledgements and releases only new pending notifications", async () => {
  const harness = createHarness();
  try {
    await harness.restore();
    const first = persistedRun({ id: "first", status: "completed", output: "first", notificationPending: "completed" });
    harness.runtime.registry.restore([first]);
    harness.runtime.deliverPendingNotification(first.id);
    const firstMessage = harness.notifications[0].message;
    harness.runtime.setNotificationDeliveryPaused(true);
    assert.equal(harness.runtime.acknowledgeNotificationMessage(deliveredMessage(firstMessage)), true);
    assert.equal(harness.runtime.registry.get(first.id).notificationPending, undefined);

    const second = persistedRun({ id: "second", status: "failed", error: "second", notificationPending: "failed" });
    harness.runtime.registry.restore([harness.runtime.registry.require(first.id), second]);
    harness.runtime.deliverPendingNotification(second.id);
    assert.equal(harness.notifications.length, 1);
    assert.equal(harness.runtime.queuedNotifications.size, 0);
    harness.runtime.setNotificationDeliveryPaused(false);
    assert.equal(harness.notifications.length, 2);
    assert.equal(harness.notifications[1].message.details.runId, second.id);
  } finally { harness.cleanup(); }
});

test("restore and shutdown reset notification pause state safely", async () => {
  const pending = persistedRun({ id: "restore-pending", status: "completed", output: "restored", notificationPending: "completed" });
  const harness = createHarness({ branch: [branchEntry(runJournalEntry(pending))] });
  try {
    harness.runtime.setNotificationDeliveryPaused(true);
    await harness.restore();
    assert.equal(harness.notifications.length, 1, "restore clears a stale gate and replays the persisted pending notification");
    harness.runtime.setNotificationDeliveryPaused(true);
    await harness.runtime.shutdown();
    assert.equal(harness.runtime.notificationDeliveryPaused, false);
    assert.equal(harness.runtime.queuedNotifications.size, 0);
    assert.equal(harness.notifications.length, 1, "shutdown clears the gate without another send");
  } finally { harness.cleanup(); }
});

test("tree restore can preserve notification pause until the shared gate releases", async () => {
  const pending = persistedRun({ id: "tree-pending", status: "completed", output: "restored", notificationPending: "completed" });
  const harness = createHarness({ branch: [branchEntry(runJournalEntry(pending))] });
  try {
    await harness.restore(true);
    assert.equal(harness.runtime.notificationDeliveryPaused, true);
    assert.equal(harness.notifications.length, 0, "tree restore does not deliver while the shared gate remains paused");
    harness.runtime.setNotificationDeliveryPaused(false);
    assert.equal(harness.notifications.length, 1);
    assert.equal(harness.notifications[0].message.details.runId, pending.id);
  } finally { await harness.runtime.shutdown(); harness.cleanup(); }
});

test("terminal notification stays pending until matching delivered message acknowledgement", async () => {
  const harness = createHarness();
  try {
    await harness.restore();
    const started = await createRun(harness, { task: "TASK_DETAILS_SENTINEL" });
    const id = started.details.run.id;
    const config = readConfig(harness, id);
    atomicWriteJson(harness.paths(id).stateFile, stateFor(id, config.token, {
      status: "completed",
      output: "complete output\nsecond output line",
      error: "complete error\nsecond error line",
      responseText: "done",
      sessionFile: join(harness.tempDir, "session.jsonl"),
    }));
    await inspect(harness, id);
    const sent = harness.notifications[0];
    const deliveryKey = expectedDeliveryKey(id, "completed");
    assert.equal(harness.runtime.registry.get(id).status, "completed");
    assert.equal(harness.runtime.registry.isLive(id), false);
    assert.equal(harness.runtime.registry.get(id).notificationPending, "completed");
    assert.equal(harness.journalWrites.length, 2, "starting and terminal-pending states are journaled before delivery acknowledgement");
    assert.equal(existsSync(harness.paths(id).runDir), true, "terminal run directories are retained until clear");
    assert.deepEqual(sent.options, { deliverAs: "steer", triggerTurn: true });
    assert.equal(sent.message.display, true);
    assert.equal(sent.message.details.event, "completed");
    assert.equal(sent.message.details.status, "completed");
    assert.equal(sent.message.details.deliveryKey, deliveryKey);
    assert.equal(sent.message.details.run.id, id);
    assert.equal(sent.message.details.run.task, "TASK_DETAILS_SENTINEL");
    assert.equal(sent.message.details.run.model, "preset/fixer:high");
    assert.equal(sent.message.details.run.output, "complete output\nsecond output line");
    assert.equal(sent.message.details.run.error, "complete error\nsecond error line");
    assert.equal(
      sent.message.content,
      `Subagent ${id} (fixer) is completed.\n\nOutput: complete output\nsecond output line\n\nError: complete error\nsecond error line`,
    );
    assert.doesNotMatch(sent.message.content, /deliveryKey|TASK_DETAILS_SENTINEL|preset\/fixer/,
      "custom-message details remain outside model-facing content");
    assert.equal(harness.notifications.length, 1, "one custom message serves both TUI and model delivery");
    assert.equal(harness.journalWrites.every(({ type }) => type === "oh-my-pi-slim:subagents"), true,
      "notification delivery does not append a second TUI entry");

    harness.runtime.deliverPendingNotification(id);
    harness.runtime.deliverPendingNotification(id);
    assert.equal(harness.notifications.length, 1, "queued delivery is not enqueued twice before message_end");

    for (const wrong of [
      { ...deliveredMessage(sent.message), role: "assistant" },
      { ...deliveredMessage(sent.message), customType: "other" },
      deliveredMessage(sent.message, { ...sent.message.details, runId: "wrong-run", deliveryKey: expectedDeliveryKey("wrong-run", "completed") }),
      deliveredMessage(sent.message, { ...sent.message.details, event: "failed", status: "failed", deliveryKey: expectedDeliveryKey(id, "failed") }),
      deliveredMessage(sent.message, { ...sent.message.details, deliveryKey: "wrong-key" }),
    ]) {
      assert.equal(harness.runtime.acknowledgeNotificationMessage(wrong), false);
      assert.equal(harness.runtime.registry.get(id).notificationPending, "completed");
      assert.equal(harness.journalWrites.length, 2);
    }

    assert.equal(harness.runtime.acknowledgeNotificationMessage(deliveredMessage(sent.message)), true);
    assert.equal(harness.runtime.registry.get(id).notificationPending, undefined);
    assert.equal(harness.journalWrites.length, 3, "matching message_end appends the acknowledgement journal state");
    assert.equal(harness.journalWrites.at(-1).data.run.notificationPending, undefined);

    const notificationRenderer = harness.messageRenderers.get("oh-my-pi-slim:subagent-notification");
    const collapsedNotification = notificationRenderer(
      sent.message,
      { expanded: false, outputPad: 1 },
      transcriptTheme,
    ).render(240).map((line) => stripVTControlCharacters(line)).join("\n");
    assert.match(collapsedNotification, /fixer \[[^\]]+\] · completed/);
    assert.doesNotMatch(collapsedNotification, /complete output|complete error/);
    const expandedNotification = notificationRenderer(
      sent.message,
      { expanded: true, outputPad: 1 },
      transcriptTheme,
    ).render(240).map((line) => stripVTControlCharacters(line)).join("\n");
    assert.match(expandedNotification, /complete output\s*\n\s*second output line/);
    assert.match(expandedNotification, /complete error\s*\n\s*second error line/);
  } finally { harness.cleanup(); }
});

test("agent-settled retry re-enqueues each still-pending delivery at most once per callback", async () => {
  const harness = createHarness();
  try {
    await harness.restore();
    const started = await createRun(harness);
    const id = started.details.run.id;
    const config = readConfig(harness, id);
    atomicWriteJson(harness.paths(id).stateFile, stateFor(id, config.token, {
      status: "completed", output: "retry me", responseText: "retry me",
    }));
    await inspect(harness, id);
    assert.equal(harness.notifications.length, 1);
    assert.equal(harness.runtime.registry.get(id).notificationPending, "completed");
    assert.equal(harness.runtime.queuedNotifications.size, 1);

    harness.runtime.retryQueuedNotificationsAfterAgentSettled();
    assert.equal(harness.notifications.length, 2, "one settled callback retries the delivery exactly once");
    assert.equal(harness.runtime.queuedNotifications.size, 1, "retry re-arms the same queued key without looping");
    harness.runtime.retryQueuedNotificationsAfterAgentSettled();
    assert.equal(harness.notifications.length, 3, "a later settled callback performs at most one further retry");

    const delivered = harness.notifications.at(-1).message;
    assert.equal(harness.runtime.acknowledgeNotificationMessage(deliveredMessage(delivered)), true);
    assert.equal(harness.runtime.registry.get(id).notificationPending, undefined);
    assert.equal(harness.runtime.queuedNotifications.size, 0);
    harness.runtime.retryQueuedNotificationsAfterAgentSettled();
    assert.equal(harness.notifications.length, 3, "message_end acknowledgement before settled retry prevents resend");

    harness.runtime.queuedNotifications.add("stale-without-pending");
    harness.runtime.retryQueuedNotificationsAfterAgentSettled();
    assert.equal(harness.runtime.queuedNotifications.has("stale-without-pending"), false);
    assert.equal(harness.notifications.length, 3, "a stale key without current pending delivery is removed without resend");
  } finally { harness.cleanup(); }
});

test("undelivered pending notification replays once on restore and keeps complete output", async () => {
  const first = createHarness({ sendMessageError: new Error("delivery failed") });
  let branch;
  let id;
  const output = "complete-output-".repeat(6000);
  try {
    await first.restore();
    const started = await createRun(first);
    id = started.details.run.id;
    const config = readConfig(first, id);
    atomicWriteJson(first.paths(id).stateFile, stateFor(id, config.token, {
      status: "completed", output, responseText: "done",
    }));
    const retained = await inspect(first, id);
    assert.equal(retained.output, output);
    assert.equal(first.runtime.registry.get(id).notificationPending, "completed");
    assert.equal(first.notifications.length, 0);
    assert.equal(first.runtime.queuedNotifications.size, 0, "synchronous send failure removes the queued delivery key");
    assert.equal(existsSync(first.paths(id).runDir), true, "terminal run directories are retained until clear");
    branch = first.journalWrites.map(({ data }) => branchEntry(data));
  } finally { first.cleanup(); }

  const restored = createHarness({ branch });
  try {
    await restored.restore();
    assert.equal(restored.notifications.length, 1);
    assert.deepEqual(restored.notifications[0].options, { deliverAs: "steer", triggerTurn: true });
    assert.match(restored.notifications[0].message.content, new RegExp(`${output.slice(0, 100)}`));
    assert.equal(restored.notifications[0].message.content.endsWith(output), true);
    assert.equal(restored.runtime.registry.get(id).notificationPending, "completed");
    restored.runtime.deliverPendingNotification(id);
    assert.equal(restored.notifications.length, 1, "one restore does not enqueue the same pending key twice");
    assert.equal(restored.runtime.acknowledgeNotificationMessage(deliveredMessage(restored.notifications[0].message)), true);
    assert.equal(restored.runtime.registry.get(id).notificationPending, undefined);
    assert.equal(restored.journalWrites.at(-1).data.run.notificationPending, undefined);
  } finally { restored.cleanup(); }
});

test("restore acknowledges persisted new and legacy notification messages without resending", async () => {
  const newRun = persistedRun({ id: "persisted-new", status: "completed", output: "new", notificationPending: "completed" });
  const legacyRun = persistedRun({ id: "persisted-legacy", status: "failed", error: "legacy", notificationPending: "failed" });
  const newKey = expectedDeliveryKey(newRun.id, "completed");
  const branch = [
    branchEntry({ version: 2, run: newRun }),
    notificationBranchEntry({
      customType: "oh-my-pi-slim:subagent-notification",
      content: "new delivered",
      display: true,
      details: { runId: newRun.id, event: "completed", status: "completed", deliveryKey: newKey },
    }),
    branchEntry({ version: 2, run: legacyRun }),
    notificationBranchEntry({
      customType: "oh-my-pi-slim:subagent-notification",
      content: "legacy delivered",
      display: true,
      details: { runId: legacyRun.id, status: "failed" },
    }),
  ];
  const harness = createHarness({ branch });
  try {
    await harness.restore();
    assert.equal(harness.notifications.length, 0);
    assert.equal(harness.runtime.registry.get(newRun.id).notificationPending, undefined);
    assert.equal(harness.runtime.registry.get(legacyRun.id).notificationPending, undefined);
    assert.deepEqual(harness.journalWrites.map(({ data }) => [data.run.id, data.run.notificationPending]), [
      [newRun.id, undefined],
      [legacyRun.id, undefined],
    ]);
  } finally { harness.cleanup(); }
});

test("restore and shutdown clear runtime notification queue state", async () => {
  const harness = createHarness();
  try {
    harness.runtime.queuedNotifications.add("stale-before-restore");
    await harness.restore();
    assert.equal(harness.runtime.queuedNotifications.size, 0);

    const started = await createRun(harness);
    const id = started.details.run.id;
    const config = readConfig(harness, id);
    harness.alive.add(999);
    atomicWriteJson(harness.paths(id).stateFile, stateFor(id, config.token, {
      status: "waiting", waitingSeq: 1,
      request: { runId: id, reason: "progress_update", message: "pause", createdAt: new Date(NOW_MS).toISOString() },
    }));
    await inspect(harness, id);
    assert.equal(harness.runtime.queuedNotifications.size, 1);
    await harness.runtime.shutdown();
    assert.equal(harness.runtime.queuedNotifications.size, 0);
  } finally { harness.cleanup(); }
});

test("legacy terminal history without notificationPending does not replay", async () => {
  const run = persistedRun({ id: "old-terminal", status: "completed", output: "historical" });
  const harness = createHarness({ branch: [branchEntry({ version: 2, run })] });
  try {
    await harness.restore();
    assert.equal(harness.notifications.length, 0);
  } finally { harness.cleanup(); }
});

test("no-state and stale-heartbeat failures honor local grace windows", async () => {
  const noState = createHarness();
  try {
    await noState.restore();
    const started = await createRun(noState);
    const id = started.details.run.id;
    noState.alive.add(999);
    await inspect(noState, id);
    assert.equal(noState.runtime.registry.get(id).status, "starting");
    noState.advance(5001);
    await inspect(noState, id);
    assert.equal(noState.runtime.registry.get(id).status, "failed");
    assert.equal(noState.runtime.registry.isLive(id), false);
    assert.equal(noState.controlWrites.at(-1).type, "interrupt");
    assert.deepEqual(noState.killed, [{ pid: -999, signal: "SIGTERM" }]);
    assert.equal(existsSync(noState.paths(id).runDir), true, "terminal run directories are retained until clear");
  } finally { noState.cleanup(); }

  const stale = createHarness();
  try {
    await stale.restore();
    const started = await createRun(stale);
    const id = started.details.run.id;
    const config = readConfig(stale, id);
    stale.alive.add(999);
    atomicWriteJson(stale.paths(id).stateFile, stateFor(id, config.token));
    await inspect(stale, id);
    stale.advance(6000);
    await inspect(stale, id);
    assert.equal(stale.runtime.registry.get(id).status, "running");
    stale.advance(5001);
    await inspect(stale, id);
    assert.equal(stale.runtime.registry.get(id).status, "failed");
    assert.equal(stale.runtime.registry.isLive(id), false);
    assert.equal(stale.controlWrites.at(-1).type, "interrupt");
    assert.deepEqual(stale.killed, [{ pid: -999, signal: "SIGTERM" }]);
    assert.equal(existsSync(stale.paths(id).runDir), true, "terminal run directories are retained until clear");
  } finally { stale.cleanup(); }
});

test("poller prevents concurrent termination of the same unhealthy run", async () => {
  const sleepers = [];
  const harness = createHarness({
    keepAliveAfterKill: true,
    sleep: () => new Promise((resolveSleep) => sleepers.push(resolveSleep)),
  });
  try {
    await harness.restore();
    const started = await createRun(harness);
    const id = started.details.run.id;
    harness.alive.add(999);
    harness.advance(5001);
    harness.intervals[0].callback();
    await new Promise((resolveImmediate) => setImmediate(resolveImmediate));
    harness.intervals[0].callback();
    await new Promise((resolveImmediate) => setImmediate(resolveImmediate));
    assert.deepEqual(harness.killed, [{ pid: -999, signal: "SIGTERM" }]);
    assert.equal(harness.controlWrites.filter(({ runId }) => runId === id).length, 1);

    sleepers.shift()();
    await new Promise((resolveImmediate) => setImmediate(resolveImmediate));
    assert.deepEqual(harness.killed, [
      { pid: -999, signal: "SIGTERM" },
      { pid: -999, signal: "SIGKILL" },
    ]);
    sleepers.shift()();
    await new Promise((resolveImmediate) => setImmediate(resolveImmediate));
    assert.equal(harness.runtime.registry.get(id).status, "failed");
  } finally { harness.cleanup(); }
});

test("health failure retains a PID-reused run directory without signaling", async () => {
  const harness = createHarness();
  try {
    await harness.restore();
    const started = await createRun(harness);
    const id = started.details.run.id;
    const config = readConfig(harness, id);
    harness.alive.add(999);
    harness.setProcessIdentity(999, "reused-process");
    atomicWriteJson(harness.paths(id).stateFile, stateFor(id, config.token));
    await inspect(harness, id);
    harness.advance(6000);
    await inspect(harness, id);
    harness.advance(5001);
    await inspect(harness, id);
    assert.equal(harness.runtime.registry.get(id).status, "failed");
    assert.deepEqual(harness.killed, []);
    assert.equal(existsSync(harness.paths(id).runDir), true);
  } finally { harness.cleanup(); }
});

test("health termination adopts a terminal state published during TERM grace", async () => {
  let harness;
  let completeDuringGrace;
  harness = createHarness({
    sleep: async () => {
      completeDuringGrace?.();
      completeDuringGrace = undefined;
    },
  });
  try {
    await harness.restore();
    const started = await createRun(harness);
    const id = started.details.run.id;
    const config = readConfig(harness, id);
    harness.alive.add(999);
    harness.advance(5001);
    completeDuringGrace = () => atomicWriteJson(harness.paths(id).stateFile, stateFor(id, config.token, {
      status: "completed", output: "finished during TERM grace", responseText: "finished during TERM grace",
    }));
    await inspect(harness, id);
    assert.equal(harness.runtime.registry.get(id).status, "completed");
    assert.equal(harness.runtime.registry.get(id).output, "finished during TERM grace");
    assert.deepEqual(harness.killed, [{ pid: -999, signal: "SIGTERM" }]);
  } finally { harness.cleanup(); }
});

test("unhealthy SIGSTOP-like runner waits between process-group SIGTERM and SIGKILL", async () => {
  const sleeps = [];
  const harness = createHarness({ keepAliveAfterKill: true, sleep: async (ms) => { sleeps.push(ms); } });
  try {
    await harness.restore();
    const started = await createRun(harness);
    const id = started.details.run.id;
    harness.alive.add(999);
    harness.advance(5001);
    await inspect(harness, id);
    assert.equal(harness.runtime.registry.get(id).status, "failed");
    assert.deepEqual(harness.killed, [
      { pid: -999, signal: "SIGTERM" },
      { pid: -999, signal: "SIGKILL" },
    ]);
    assert.deepEqual(sleeps, [1500, 1500]);
    assert.equal(harness.controlWrites.at(-1).type, "interrupt");
    assert.equal(harness.runtime.registry.isLive(id), false);
  } finally { harness.cleanup(); }
});

test("missing run directories clear health and pending reply bookkeeping", async () => {
  const harness = createHarness();
  try {
    await harness.restore();
    const started = await createRun(harness);
    const id = started.details.run.id;
    harness.runtime.health.set(id, { trackedAt: NOW_MS });
    harness.runtime.repliedSeqs.set(id, { waitingSeq: 1, sentAt: NOW_MS });
    rmSync(harness.paths(id).runDir, { recursive: true, force: true });
    await inspect(harness, id);
    assert.equal(harness.runtime.registry.get(id).status, "interrupted");
    assert.equal(harness.runtime.health.has(id), false);
    assert.equal(harness.runtime.repliedSeqs.has(id), false);
  } finally { harness.cleanup(); }
});

test("invalid launch config retains the unverifiable run directory without signaling", async () => {
  const harness = createHarness();
  const errors = [];
  const originalConsoleError = console.error;
  console.error = (...args) => { errors.push(args.join(" ")); };
  try {
    await harness.restore();
    const started = await createRun(harness);
    const id = started.details.run.id;
    harness.alive.add(999);
    atomicWriteJson(harness.paths(id).configFile, { invalid: true });
    const run = await inspect(harness, id);
    assert.equal(run.status, "failed");
    assert.equal(run.error, "Detached launch config is missing or invalid.");
    assert.deepEqual(harness.killed, []);
    assert.equal(existsSync(harness.paths(id).runDir), true);
    assert.deepEqual(
      harness.journalWrites.map(({ data }) => data.run.status),
      ["starting", "failed"],
      "starting and failed-pending states are journaled before acknowledgement",
    );
    assert.equal(harness.notifications.length, 1);
    assert.equal(harness.notifications[0].message.details.status, "failed");
    assert.match(harness.notifications[0].message.content, /Detached launch config is missing or invalid/);
    assert.deepEqual(errors, [
      `[oh-my-pi-slim] Retaining unverifiable detached run directory ${harness.paths(id).runDir}: launch config is missing or invalid.`,
    ]);
  } finally {
    console.error = originalConsoleError;
    harness.cleanup();
  }
});

test("nonterminal state with a dead PID fails immediately", async () => {
  const harness = createHarness();
  try {
    await harness.restore();
    const started = await createRun(harness);
    const id = started.details.run.id;
    const config = readConfig(harness, id);
    atomicWriteJson(harness.paths(id).stateFile, stateFor(id, config.token));
    await inspect(harness, id);
    assert.equal(harness.runtime.registry.get(id).status, "failed");
    assert.match(harness.runtime.registry.get(id).error, /exited/);
  } finally { harness.cleanup(); }
});

test("shutdown kills a just-launched runner from its verified identity before state exists", async () => {
  const harness = createHarness();
  try {
    await harness.restore();
    const started = await createRun(harness);
    const id = started.details.run.id;
    harness.alive.add(999);
    await harness.runtime.shutdown();
    assert.equal(harness.runtime.registry.get(id).status, "interrupted");
    assert.deepEqual(harness.killed, [{ pid: -999, signal: "SIGTERM" }]);
    assert.equal(harness.journalWrites.at(-1).data.run.status, "interrupted");
  } finally { harness.cleanup(); }
});

test("shutdown retains a PID-reused directory and sends no signal", async () => {
  const harness = createHarness();
  try {
    await harness.restore();
    const started = await createRun(harness);
    const id = started.details.run.id;
    harness.alive.add(999);
    harness.setProcessIdentity(999, "reused-process");
    await harness.runtime.shutdown();
    assert.equal(harness.runtime.registry.get(id).status, "interrupted");
    assert.deepEqual(harness.killed, []);
    assert.equal(existsSync(harness.paths(id).runDir), true);
  } finally { harness.cleanup(); }
});

test("shutdown does not signal when state PID disagrees with runner identity", async () => {
  const harness = createHarness();
  try {
    await harness.restore();
    const started = await createRun(harness);
    const id = started.details.run.id;
    const config = readConfig(harness, id);
    harness.alive.add(999);
    atomicWriteJson(harness.paths(id).stateFile, stateFor(id, config.token, { pid: 998 }));
    await harness.runtime.shutdown();
    assert.equal(harness.runtime.registry.get(id).status, "interrupted");
    assert.deepEqual(harness.killed, []);
    assert.equal(existsSync(harness.paths(id).runDir), true);
  } finally { harness.cleanup(); }
});

test("shutdown process-group signaling falls back to the verified PID", async () => {
  const harness = createHarness({ rejectGroupSignal: true });
  try {
    await harness.restore();
    const started = await createRun(harness);
    const id = started.details.run.id;
    harness.alive.add(999);
    await harness.runtime.shutdown();
    assert.deepEqual(harness.killed, [
      { pid: -999, signal: "SIGTERM" },
      { pid: 999, signal: "SIGTERM" },
    ]);
    assert.equal(harness.runtime.registry.get(id).status, "interrupted");
  } finally { harness.cleanup(); }
});

test("shutdown adopts an already-completed verified state without interrupting or killing it", async () => {
  const harness = createHarness();
  try {
    await harness.restore();
    const started = await createRun(harness);
    const id = started.details.run.id;
    const config = readConfig(harness, id);
    const sessionFile = join(harness.tempDir, "completed.jsonl");
    harness.alive.add(999);
    atomicWriteJson(harness.paths(id).stateFile, stateFor(id, config.token));
    await inspect(harness, id);
    atomicWriteJson(harness.paths(id).stateFile, stateFor(id, config.token, {
      status: "completed", output: "finished before shutdown", responseText: "finished before shutdown", sessionFile,
    }));

    await harness.runtime.shutdown();

    assert.equal(harness.runtime.registry.get(id).status, "completed");
    assert.equal(harness.runtime.registry.get(id).output, "finished before shutdown");
    assert.equal(harness.runtime.registry.get(id).sessionFile, sessionFile);
    assert.deepEqual(controls(harness, id), []);
    assert.deepEqual(harness.killed, []);
    assert.equal(harness.notifications.length, 0);
    assert.equal(harness.runtime.registry.get(id).notificationPending, "completed");
    assert.equal(harness.journalWrites.at(-1).data.run.notificationPending, "completed");

    const next = createHarness({ branch: harness.journalWrites.map(({ data }) => branchEntry(data)) });
    try {
      await next.restore();
      assert.equal(next.notifications.length, 1);
      assert.equal(next.notifications[0].message.details.status, "completed");
      assert.equal(next.notifications[0].message.content.endsWith("finished before shutdown"), true);
      assert.equal(next.runtime.registry.get(id).notificationPending, "completed");
    } finally { next.cleanup(); }
  } finally { harness.cleanup(); }
});

test("shutdown adopts natural completion while waiting for interrupt", async () => {
  let harness;
  let completeOnSleep;
  harness = createHarness({
    shutdownWaitMs: 50,
    sleep: async (ms) => {
      completeOnSleep?.();
      completeOnSleep = undefined;
      harness.advance(ms);
    },
  });
  try {
    await harness.restore();
    const started = await createRun(harness);
    const id = started.details.run.id;
    const config = readConfig(harness, id);
    harness.alive.add(999);
    atomicWriteJson(harness.paths(id).stateFile, stateFor(id, config.token));
    await inspect(harness, id);
    completeOnSleep = () => atomicWriteJson(harness.paths(id).stateFile, stateFor(id, config.token, {
      status: "completed", output: "finished during shutdown", responseText: "finished during shutdown",
    }));

    await harness.runtime.shutdown();

    assert.equal(harness.runtime.registry.get(id).status, "completed");
    assert.equal(harness.runtime.registry.get(id).output, "finished during shutdown");
    assert.equal(harness.controlWrites.at(-1).type, "interrupt");
    assert.deepEqual(harness.killed, []);
    assert.equal(harness.notifications.length, 0);
    assert.equal(harness.runtime.registry.get(id).notificationPending, "completed");
    assert.equal(harness.journalWrites.at(-1).data.run.notificationPending, "completed");
  } finally { harness.cleanup(); }
});

test("shutdown journals a pending interruption and the next runtime delivers it once", async () => {
  const harness = createHarness({ sendMessageError: new Error("closing parent") });
  try {
    await harness.restore();
    const started = await createRun(harness);
    const id = started.details.run.id;
    const config = readConfig(harness, id);
    const sessionFile = join(harness.tempDir, "resume.jsonl");
    writeFileSync(sessionFile, "");
    harness.alive.add(999);
    atomicWriteJson(harness.paths(id).stateFile, stateFor(id, config.token, {
      status: "waiting",
      sessionFile,
      waitingSeq: 1,
      request: { runId: id, reason: "progress_update", message: "checkpoint", createdAt: new Date(NOW_MS).toISOString() },
    }));
    await inspect(harness, id);
    assert.equal(harness.runtime.registry.get(id).notificationPending, "waiting");

    await harness.runtime.shutdown();

    assert.equal(harness.runtime.registry.get(id).status, "interrupted");
    assert.equal(harness.runtime.registry.get(id).sessionFile, sessionFile);
    assert.equal(harness.runtime.registry.get(id).notificationPending, "interrupted");
    assert.equal(harness.controlWrites.at(-1).type, "interrupt");
    assert.deepEqual(harness.killed, [{ pid: -999, signal: "SIGTERM" }]);
    assert.equal(harness.journalWrites.at(-1).data.run.status, "interrupted");
    assert.equal(harness.journalWrites.at(-1).data.run.notificationPending, "interrupted");
    assert.equal(harness.notifications.length, 0, "the closing parent receives no notification");

    const next = createHarness({ branch: harness.journalWrites.map(({ data }) => branchEntry(data)) });
    try {
      await next.restore();
      assert.equal(next.notifications.length, 1);
      assert.equal(next.notifications[0].message.details.status, "interrupted");
      assert.equal(next.notifications[0].message.content.endsWith("Error: Parent session shut down."), true);
      assert.equal(next.runtime.registry.get(id).notificationPending, "interrupted");
    } finally { next.cleanup(); }
  } finally { harness.cleanup(); }
});

test("restore terminates verified live orphans before cleanup and retains branch terminal directories", async () => {
  const terminal = persistedRun({ id: "terminal-leftover", status: "completed", output: "done" });
  let orphanPaths;
  const cleanupObservations = [];
  let harness;
  harness = createHarness({
    branch: [branchEntry({ version: 2, run: terminal })],
    sleep: async () => cleanupObservations.push({
      directoryExists: existsSync(orphanPaths.runDir),
      processAlive: harness.alive.has(6161),
    }),
  });
  try {
    const terminalPaths = harness.paths(terminal.id);
    mkdirSync(terminalPaths.controlDir, { recursive: true, mode: 0o700 });

    const orphanId = "orphan-live";
    orphanPaths = harness.paths(orphanId);
    mkdirSync(orphanPaths.controlDir, { recursive: true, mode: 0o700 });
    const config = {
      v: 1, runId: orphanId, token: "orphan-token", ownerSessionId: harness.ownerSessionId,
      agent: "fixer", abstract: "orphan summary", task: "orphan", cwd: ROOT, model: "provider/model:high",
      deniedTools: [], systemPrompt: "prompt", approve: false,
      childSessionDir: join(harness.tempDir, "children"),
      piInvocation: { command: "pi", args: ["--mode", "rpc"] }, env: {},
      createdAt: new Date(NOW_MS).toISOString(),
    };
    atomicWriteJson(orphanPaths.configFile, config);
    atomicWriteJson(orphanPaths.identityFile, {
      v: 1, token: config.token, runId: orphanId, pid: 6161, processIdentity: "process-6161",
    });
    harness.alive.add(6161);

    await harness.restore();

    assert.deepEqual(harness.killed, [{ pid: -6161, signal: "SIGTERM" }]);
    assert.deepEqual(cleanupObservations, [{ directoryExists: true, processAlive: false }]);
    assert.equal(existsSync(orphanPaths.runDir), false);
    assert.equal(existsSync(terminalPaths.runDir), true, "a branch terminal run keeps its directory until clear");
  } finally { harness.cleanup(); }
});

test("restore GC retains an orphan whose PID was reused", async () => {
  const harness = createHarness();
  try {
    const orphanId = "orphan-reused";
    const paths = harness.paths(orphanId);
    mkdirSync(paths.controlDir, { recursive: true, mode: 0o700 });
    const config = {
      v: 1, runId: orphanId, token: "orphan-token", ownerSessionId: harness.ownerSessionId,
      agent: "fixer", abstract: "orphan summary", task: "orphan", cwd: ROOT, model: "provider/model:high",
      deniedTools: [], systemPrompt: "prompt", approve: false,
      childSessionDir: join(harness.tempDir, "children"),
      piInvocation: { command: "pi", args: ["--mode", "rpc"] }, env: {},
      createdAt: new Date(NOW_MS).toISOString(),
    };
    atomicWriteJson(paths.configFile, config);
    atomicWriteJson(paths.identityFile, {
      v: 1, token: config.token, runId: orphanId, pid: 6162, processIdentity: "original-process",
    });
    harness.alive.add(6162);
    harness.setProcessIdentity(6162, "reused-process");
    await harness.restore();
    assert.deepEqual(harness.killed, []);
    assert.equal(existsSync(paths.runDir), true);
  } finally { harness.cleanup(); }
});

test("restore keeps offline terminal state but interrupts and kills any prior active runner", async () => {
  const activeRun = persistedRun({ id: "active" });
  const terminalRun = persistedRun({ id: "terminal", status: "running" });
  const harness = createHarness({ branch: [branchEntry({ version: 1, runs: [activeRun, terminalRun] })] });
  try {
    for (const run of [activeRun, terminalRun]) {
      const paths = harness.paths(run.id);
      mkdirSync(paths.controlDir, { recursive: true, mode: 0o700 });
      const config = {
        v: 1, runId: run.id, token: `token-${run.id}`, ownerSessionId: harness.ownerSessionId,
        agent: run.agent, abstract: run.abstract, task: run.task, cwd: run.cwd, model: run.model, deniedTools: run.deniedTools,
        systemPrompt: "prompt", approve: false, childSessionDir: join(harness.tempDir, "children"),
        piInvocation: { command: "pi", args: ["--mode", "rpc"] }, env: {}, createdAt: run.createdAt,
      };
      atomicWriteJson(paths.configFile, config);
      atomicWriteJson(paths.stateFile, stateFor(run.id, config.token, {
        status: run.id === "terminal" ? "completed" : "running",
        output: run.id === "terminal" ? "offline done" : undefined,
      }));
      if (run.id === "active") {
        atomicWriteJson(paths.identityFile, {
          v: 1, token: config.token, runId: run.id, pid: 999, processIdentity: "process-999",
        });
      }
    }
    harness.alive.add(999);
    await harness.restore();
    assert.equal(harness.runtime.registry.get("active").status, "interrupted");
    assert.equal(harness.runtime.registry.get("terminal").status, "completed");
    assert.equal(harness.runtime.registry.get("terminal").output, "offline done");
    assert.equal(harness.controlWrites.find(({ runId }) => runId === "active")?.type, "interrupt");
    assert.equal(harness.killed.some(({ pid }) => pid === -999), true);
  } finally { harness.cleanup(); }
});

test("restore kills a prior active runner from verified identity when state is absent", async () => {
  const activeRun = persistedRun({ id: "identity-only" });
  const harness = createHarness({ branch: [branchEntry({ version: 1, runs: [activeRun] })] });
  try {
    const paths = harness.paths(activeRun.id);
    mkdirSync(paths.controlDir, { recursive: true, mode: 0o700 });
    const config = {
      v: 1, runId: activeRun.id, token: "identity-token", ownerSessionId: harness.ownerSessionId,
      agent: activeRun.agent, abstract: activeRun.abstract, task: activeRun.task, cwd: activeRun.cwd, model: activeRun.model, deniedTools: activeRun.deniedTools,
      systemPrompt: "prompt", approve: false, childSessionDir: join(harness.tempDir, "children"),
      piInvocation: { command: "pi", args: ["--mode", "rpc"] }, env: {}, createdAt: activeRun.createdAt,
    };
    atomicWriteJson(paths.configFile, config);
    atomicWriteJson(paths.identityFile, {
      v: 1, token: config.token, runId: activeRun.id, pid: 777, processIdentity: "process-777",
    });
    harness.alive.add(777);
    await harness.restore();
    assert.equal(harness.runtime.registry.get(activeRun.id).status, "interrupted");
    assert.deepEqual(harness.killed, [{ pid: -777, signal: "SIGTERM" }]);
    assert.equal(harness.journalWrites.at(-1).data.run.status, "interrupted");
  } finally { harness.cleanup(); }
});

test("legacy active waiting launch without abstract remains verifiable and is interrupted on restore", async () => {
  const activeRun = persistedRun({ id: "legacy-waiting-launch", abstract: undefined, status: "waiting" });
  const harness = createHarness({ branch: [branchEntry({ version: 1, runs: [activeRun] })] });
  try {
    const paths = harness.paths(activeRun.id);
    mkdirSync(paths.controlDir, { recursive: true, mode: 0o700 });
    const config = {
      v: 1, runId: activeRun.id, token: "legacy-waiting-token", ownerSessionId: harness.ownerSessionId,
      agent: activeRun.agent, task: activeRun.task, cwd: activeRun.cwd, model: activeRun.model, deniedTools: activeRun.deniedTools,
      systemPrompt: "prompt", approve: false, childSessionDir: join(harness.tempDir, "children"),
      piInvocation: { command: "pi", args: ["--mode", "rpc"] }, env: {}, createdAt: activeRun.createdAt,
    };
    atomicWriteJson(paths.configFile, config);
    atomicWriteJson(paths.stateFile, stateFor(activeRun.id, config.token, {
      pid: 776,
      status: "waiting",
      request: {
        id: "legacy-request-id", runId: activeRun.id, reason: "need_decision",
        message: "legacy wait", createdAt: activeRun.createdAt,
      },
    }));
    atomicWriteJson(paths.identityFile, {
      v: 1, token: config.token, runId: activeRun.id, pid: 776, processIdentity: "process-776",
    });
    harness.alive.add(776);
    await harness.restore();
    assert.equal(harness.runtime.registry.get(activeRun.id).abstract, legacyRunAbstract(activeRun.task));
    assert.equal(harness.runtime.registry.get(activeRun.id).status, "interrupted");
    assert.equal(harness.controlWrites.at(-1).type, "interrupt");
    assert.deepEqual(harness.killed, [{ pid: -776, signal: "SIGTERM" }]);
    assert.equal(existsSync(paths.runDir), true, "an interrupted run keeps its directory until clear");
  } finally { harness.cleanup(); }
});

test("restore does not kill an identity whose token does not match launch config", async () => {
  const activeRun = persistedRun({ id: "bad-identity" });
  const harness = createHarness({ branch: [branchEntry({ version: 1, runs: [activeRun] })] });
  try {
    const paths = harness.paths(activeRun.id);
    mkdirSync(paths.controlDir, { recursive: true, mode: 0o700 });
    atomicWriteJson(paths.configFile, {
      v: 1, runId: activeRun.id, token: "config-token", ownerSessionId: harness.ownerSessionId,
      agent: activeRun.agent, abstract: activeRun.abstract, task: activeRun.task, cwd: activeRun.cwd, model: activeRun.model, deniedTools: activeRun.deniedTools,
      systemPrompt: "prompt", approve: false, childSessionDir: join(harness.tempDir, "children"),
      piInvocation: { command: "pi", args: ["--mode", "rpc"] }, env: {}, createdAt: activeRun.createdAt,
    });
    atomicWriteJson(paths.identityFile, {
      v: 1, token: "wrong-token", runId: activeRun.id, pid: 778, processIdentity: "process-778",
    });
    harness.alive.add(778);
    await harness.restore();
    assert.equal(harness.runtime.registry.get(activeRun.id).status, "interrupted");
    assert.deepEqual(harness.killed, []);
    assert.equal(harness.alive.has(778), true);
    assert.equal(existsSync(paths.runDir), true);
  } finally { harness.cleanup(); }
});

test("restore does not signal a reused PID whose OS identity changed", async () => {
  const activeRun = persistedRun({ id: "reused-identity" });
  const harness = createHarness({ branch: [branchEntry({ version: 1, runs: [activeRun] })] });
  try {
    const paths = harness.paths(activeRun.id);
    mkdirSync(paths.controlDir, { recursive: true, mode: 0o700 });
    const config = {
      v: 1, runId: activeRun.id, token: "identity-token", ownerSessionId: harness.ownerSessionId,
      agent: activeRun.agent, abstract: activeRun.abstract, task: activeRun.task, cwd: activeRun.cwd, model: activeRun.model, deniedTools: activeRun.deniedTools,
      systemPrompt: "prompt", approve: false, childSessionDir: join(harness.tempDir, "children"),
      piInvocation: { command: "pi", args: ["--mode", "rpc"] }, env: {}, createdAt: activeRun.createdAt,
    };
    atomicWriteJson(paths.configFile, config);
    atomicWriteJson(paths.identityFile, {
      v: 1, token: config.token, runId: activeRun.id, pid: 779, processIdentity: "original-process",
    });
    harness.alive.add(779);
    harness.setProcessIdentity(779, "reused-process");
    await harness.restore();
    assert.equal(harness.runtime.registry.get(activeRun.id).status, "interrupted");
    assert.deepEqual(harness.killed, []);
    assert.equal(existsSync(paths.runDir), true);
  } finally { harness.cleanup(); }
});

test("restore treats legacy runner identity without processIdentity as unverifiable", async () => {
  const activeRun = persistedRun({ id: "legacy-identity" });
  const harness = createHarness({ branch: [branchEntry({ version: 1, runs: [activeRun] })] });
  try {
    const paths = harness.paths(activeRun.id);
    mkdirSync(paths.controlDir, { recursive: true, mode: 0o700 });
    const config = {
      v: 1, runId: activeRun.id, token: "legacy-token", ownerSessionId: harness.ownerSessionId,
      agent: activeRun.agent, abstract: activeRun.abstract, task: activeRun.task, cwd: activeRun.cwd, model: activeRun.model, deniedTools: activeRun.deniedTools,
      systemPrompt: "prompt", approve: false, childSessionDir: join(harness.tempDir, "children"),
      piInvocation: { command: "pi", args: ["--mode", "rpc"] }, env: {}, createdAt: activeRun.createdAt,
    };
    atomicWriteJson(paths.configFile, config);
    atomicWriteJson(paths.identityFile, { v: 1, token: config.token, runId: activeRun.id, pid: 780 });
    harness.alive.add(780);
    await harness.restore();
    assert.equal(harness.runtime.registry.get(activeRun.id).status, "interrupted");
    assert.deepEqual(harness.killed, []);
    assert.equal(existsSync(paths.runDir), true);
  } finally { harness.cleanup(); }
});

test("legacy active run without a run directory restores as interrupted", async () => {
  const harness = createHarness({ branch: [branchEntry({ version: 1, runs: [persistedRun()] })] });
  try {
    await harness.restore();
    assert.equal(harness.runtime.registry.get("run-1").status, "interrupted");
    assert.equal(harness.journalWrites.at(-1).data.run.status, "interrupted");
    assert.equal(harness.notifications.at(-1).message.details.status, "interrupted");
  } finally { harness.cleanup(); }
});

test("owner session paths are isolated and RPC mode never registers a widget", async () => {
  const harness = createHarness({ ownerSessionId: "owner-b", mode: "rpc" });
  try {
    await harness.restore();
    const started = await createRun(harness);
    const id = started.details.run.id;
    assert.match(harness.paths(id).runDir, /owner-b/);
    assert.equal(harness.widgetCalls.length, 0);
  } finally { harness.cleanup(); }
});

test("main and child share the fixed checkpoint helpers while main keeps settled follow-up scheduling", () => {
  const source = readFileSync(join(ROOT, "extensions/oh-my-pi-slim/index.ts"), "utf8");
  const childSource = readFileSync(join(ROOT, "extensions/oh-my-pi-slim/child-supervisor.ts"), "utf8");
  const checkpointSource = readFileSync(join(ROOT, "extensions/oh-my-pi-slim/subagent-checkpoint.ts"), "utf8");
  const resumeText = "Resume the user's latest intent. Re-read kept recent messages above the summary to confirm the latest request. If it supersedes earlier plans in the summary, follow it. If no work remains, say so briefly; do not invent work.";
  assert.match(source, /pi\.on\("session_before_tree", async \(event\)[\s\S]*const generation = notificationGate\.pause\(\)[\s\S]*event\.signal\.addEventListener\("abort", abortListener, \{ once: true \}\)[\s\S]*await subagents\.shutdown\(\)[\s\S]*hold\.shutdownComplete = true/);
  assert.match(source, /pi\.on\("session_tree", async[\s\S]*takeTreeNotificationHold\(\)[\s\S]*await subagents\.restore\(ctx, notificationGate\.isPaused\(\)\)[\s\S]*finally[\s\S]*notificationGate\.releaseDeferred\(hold\.generation\)[\s\S]*subagents\.setModelResolver/);
  assert.match(source, /pi\.on\("turn_start", \(\) => \{\s*subagents\.onTurnStart\(\)/);
  assert.doesNotMatch(source, /pi\.on\("tool_execution_start", \(\) => \{\s*subagents\.onTurnStart\(\)/);
  assert.match(source, /pi\.on\("message_end", \(event, ctx\) => \{[\s\S]*event\.message\.role !== "custom"[\s\S]*event\.message\.customType !== SUBAGENT_NOTIFICATION_TYPE[\s\S]*deliveryEpoch = sessionEpoch[\s\S]*deliverySessionId = ctx\.sessionManager\.getSessionId\(\)[\s\S]*setImmediate\(\(\) => \{[\s\S]*deliveryEpoch !== sessionEpoch[\s\S]*acknowledgeNotificationMessage\(message\)/);
  assert.match(source, /pi\.on\("agent_settled", \(_event, ctx\) => \{[\s\S]*deliveryEpoch = sessionEpoch[\s\S]*deliverySessionId = ctx\.sessionManager\.getSessionId\(\)[\s\S]*setImmediate\(\(\) => \{[\s\S]*deliveryEpoch !== sessionEpoch[\s\S]*sessionCtx\?\.sessionManager\.getSessionId\(\) !== deliverySessionId[\s\S]*retryQueuedNotificationsAfterAgentSettled\(\)[\s\S]*const checkpoint = pendingCheckpoint[\s\S]*scheduleCheckpointResume/);
  assert.equal(source.indexOf('pi.on("message_end"') < source.indexOf('pi.on("agent_settled"'), true,
    "Pi message_end binding is registered before agent_settled retry so its ack immediate is queued first");
  assert.equal(checkpointSource.includes(`export const CHECKPOINT_RESUME_TEXT = ${JSON.stringify(resumeText)};`), true);
  for (const helper of ["CHECKPOINT_RESUME_TEXT", "completedToolBatch", "contextUsageNeedsCheckpoint"]) {
    assert.match(source, new RegExp(helper));
    assert.match(childSource, new RegExp(helper));
  }
  assert.match(source, /setImmediate\(\(\) => \{[\s\S]*pi\.sendUserMessage\(CHECKPOINT_RESUME_TEXT, \{ deliverAs: "followUp" \}\)/);
  const incompleteWarning = source.indexOf("the Goal scheduler will reevaluate continuation after delivery resumes");
  const incompleteCheckpoint = source.slice(source.lastIndexOf("pendingCheckpoint = undefined", incompleteWarning), incompleteWarning);
  assert.ok(incompleteCheckpoint.indexOf("notificationGate.releaseDeferred(checkpoint.notificationGeneration)") >= 0);
  assert.ok(incompleteCheckpoint.indexOf("notificationGate.releaseDeferred(checkpoint.notificationGeneration)") < incompleteCheckpoint.indexOf("setImmediate(() => goal?.reevaluateAfterHostOperation(ctx))"),
    "incomplete checkpoint releases the shared gate before deferred Goal reevaluation");
  assert.match(childSource, /pi\.on\("session_compact"[\s\S]*pi\.sendUserMessage\(CHECKPOINT_RESUME_TEXT, \{ deliverAs: "followUp" \}\)[\s\S]*pendingCheckpoint = undefined/);
  assert.doesNotMatch(`${source}\n${childSource}`, /checkpoint\.tools|Completed tool calls at the checkpoint|Re-fetch/);
});

test("resume creates a new run ID and a complete --session invocation", async () => {
  const harness = createHarness();
  try {
    await harness.restore();
    const sessionFile = join(harness.tempDir, "source.jsonl");
    writeFileSync(sessionFile, "session");
    harness.runtime.registry.add(persistedRun({ id: "source", status: "interrupted", sessionFile }));
    harness.runtime.setModelResolver(() => "provider/model:high");
    harness.runtime.setDenyResolver(() => ["ask_user_question"]);
    const result = await harness.tools.get("subagent").execute("resume", {
      action: "resume", id: "source", abstract: "  new resume summary  ", message: "continue",
    });
    const id = result.details.run.id;
    const config = readConfig(harness, id);
    assert.match(result.content[0].text, new RegExp(`${id}.*status starting`));
    assert.notEqual(id, "source");
    assert.deepEqual(result.details.run, {
      id,
      agent: "fixer",
      abstract: "new resume summary",
      task: "continue",
      cwd: ROOT,
      model: "provider/model:high",
      deniedTools: ["ask_user_question"],
      status: "starting",
      sourceRunId: "source",
      sessionFile,
      createdAt: new Date(NOW_MS).toISOString(),
      updatedAt: new Date(NOW_MS).toISOString(),
      live: true,
    });
    assert.equal(config.abstract, "new resume summary");
    assert.notEqual(config.abstract, harness.runtime.registry.get("source").abstract);
    assert.equal(config.resumeSessionFile, sessionFile);
    assert.equal("resumeCompactFrom" in config, false, "an unchanged model base writes no preflight marker");
    const sessionIndex = config.piInvocation.args.indexOf("--session");
    assert.equal(config.piInvocation.args[sessionIndex + 1], sessionFile);
    assert.equal(config.runId, id);
    assert.deepEqual(config.deniedTools, ["ask_user_question"]);
    const denyIndex = config.piInvocation.args.indexOf("--exclude-tools");
    assert.notEqual(denyIndex, -1);
    assert.equal(config.piInvocation.args[denyIndex + 1], "ask_user_question");
  } finally { harness.cleanup(); }
});

test("resume inherits the source run working directory and resolves cwd overrides like create", async () => {
  const harness = createHarness();
  const sourceCwd = join(ROOT, "extensions");
  try {
    await harness.restore();
    harness.runtime.setModelResolver(() => "provider/model:high");
    harness.runtime.setDenyResolver(() => []);
    const launchFor = (id) => harness.launches.find((launch) => launch.configFile.includes(id));
    const resumeWith = async (suffix, args) => {
      const sessionFile = join(harness.tempDir, `${suffix}.jsonl`);
      writeFileSync(sessionFile, "session");
      harness.runtime.registry.add(persistedRun({
        id: `source-${suffix}`, status: "completed", sessionFile, cwd: sourceCwd,
      }));
      const result = await harness.tools.get("subagent").execute(`resume-${suffix}`, {
        action: "resume", id: `source-${suffix}`, abstract: `abstract ${suffix}`, message: "continue", ...args,
      });
      const id = result.details.run.id;
      return { id, result, config: readConfig(harness, id), launch: launchFor(id) };
    };

    const inherited = await resumeWith("inherit", {});
    assert.equal(inherited.result.details.run.cwd, sourceCwd, "an omitted cwd inherits the source run working directory");
    assert.equal(inherited.config.cwd, sourceCwd);
    assert.equal(inherited.launch.options.cwd, sourceCwd);
    assert.equal(inherited.config.resumeSessionFile, join(harness.tempDir, "inherit.jsonl"));
    assert.equal(inherited.config.approve, true);
    assert.equal(inherited.config.piInvocation.args.includes("--approve"), true);

    const relative = await resumeWith("relative", { cwd: "extensions/oh-my-pi-slim" });
    const expectedRelative = resolve(ROOT, "extensions/oh-my-pi-slim");
    assert.equal(relative.result.details.run.cwd, expectedRelative, "a relative override resolves against the parent session cwd");
    assert.notEqual(relative.result.details.run.cwd, resolve(sourceCwd, "extensions/oh-my-pi-slim"));
    assert.equal(relative.config.cwd, expectedRelative);
    assert.equal(relative.launch.options.cwd, expectedRelative);
    assert.equal(relative.config.resumeSessionFile, join(harness.tempDir, "relative.jsonl"));

    const absoluteTarget = realpathSync(harness.tempDir);
    const absolute = await resumeWith("absolute", { cwd: absoluteTarget });
    assert.equal(absolute.result.details.run.cwd, absoluteTarget, "an absolute override is used verbatim");
    assert.equal(absolute.config.cwd, absoluteTarget);
    assert.equal(absolute.launch.options.cwd, absoluteTarget);

    const untrimmed = await resumeWith("untrimmed", { cwd: "  extensions  " });
    assert.equal(untrimmed.result.details.run.cwd, sourceCwd, "a padded override still resolves from the trimmed path");

    const missing = await resumeWith("missing", { cwd: "never-created-directory" });
    assert.equal(missing.result.details.run.status, "starting", "resume adds no directory existence precondition");
    assert.equal(missing.config.cwd, resolve(ROOT, "never-created-directory"));

    const outside = await resumeWith("outside", { cwd: dirname(ROOT.replace(/\/$/, "")) });
    assert.equal(outside.config.approve, false, "an out-of-project override reuses the shared no-approve decision");
    assert.equal(outside.config.piInvocation.args.includes("--no-approve"), true);
    assert.equal(outside.config.piInvocation.args.includes("--approve"), false);
    assert.equal(outside.config.resumeSessionFile, join(harness.tempDir, "outside.jsonl"));

    for (const resumed of [inherited, relative, absolute, untrimmed, missing, outside]) {
      assert.equal(resumed.config.agent, "fixer");
      assert.equal(resumed.config.model, "provider/model:high");
      assert.equal(resumed.result.details.run.sourceRunId.startsWith("source-"), true);
    }
  } finally { harness.cleanup(); }
});

test("resume rejects a blank cwd and still refuses agent and task", async () => {
  const harness = createHarness();
  try {
    await harness.restore();
    const subagent = harness.tools.get("subagent");
    const base = { action: "resume", id: "source", abstract: "new summary", message: "continue" };
    for (const cwd of ["", "   ", "\t\n"]) {
      await assert.rejects(
        subagent.execute("resume-blank-cwd", { ...base, cwd }),
        /cwd must be a non-empty string/i,
      );
    }
    for (const cwd of [null, 5, {}, []]) {
      await assert.rejects(
        subagent.execute("resume-typed-cwd", { ...base, cwd }),
        /cwd must be a non-empty string/i,
      );
    }
    assert.equal(harness.launches.length, 0, "a rejected cwd never launches a run");
    await assert.rejects(
      subagent.execute("resume-agent", { ...base, agent: "fixer" }),
      /resume does not accept field\(s\): agent/i,
    );
    await assert.rejects(
      subagent.execute("resume-agent-task", { ...base, agent: "fixer", task: "forbidden", cwd: ROOT }),
      /resume does not accept field\(s\): agent, task/i,
    );
    await assert.rejects(
      subagent.execute("resume-unknown-source", { ...base, cwd: ROOT }),
      /source/i,
    );
  } finally { harness.cleanup(); }
});

test("resume launches the current preset model and marks only a real model-base migration", async () => {
  const harness = createHarness();
  try {
    await harness.restore();
    harness.runtime.setDenyResolver(() => []);
    const resumeWith = async (suffix, sourceModel, targetModel) => {
      const sessionFile = join(harness.tempDir, `${suffix}.jsonl`);
      writeFileSync(sessionFile, "session");
      harness.runtime.registry.add(persistedRun({
        id: `source-${suffix}`, status: "completed", sessionFile, model: sourceModel,
      }));
      harness.runtime.setModelResolver((agent) => {
        assert.equal(agent, "fixer", "the resumed run resolves the source run's own agent");
        return targetModel;
      });
      const result = await harness.tools.get("subagent").execute(`resume-${suffix}`, {
        action: "resume", id: `source-${suffix}`, abstract: `abstract ${suffix}`, message: "continue",
      });
      const id = result.details.run.id;
      return { id, result, config: readConfig(harness, id) };
    };

    const migrated = await resumeWith("migrated", "old-provider/old-model:low", "new-provider/new-model:high");
    assert.equal(migrated.result.details.run.model, "new-provider/new-model:high", "a resumed run uses the current preset model");
    assert.equal(harness.runtime.registry.get(migrated.id).model, "new-provider/new-model:high");
    assert.equal(migrated.config.model, "new-provider/new-model:high");
    const modelIndex = migrated.config.piInvocation.args.indexOf("--model");
    assert.equal(migrated.config.piInvocation.args[modelIndex + 1], "new-provider/new-model:high");
    assert.equal(migrated.config.resumeCompactFrom, "old-provider/old-model:low", "a crossed model base marks the preflight");
    assert.equal(migrated.config.piInvocation.args.includes("--thinking-level"), false);
    assert.equal(readLaunchConfig(harness.paths(migrated.id)).resumeCompactFrom, "old-provider/old-model:low");
    const journaled = harness.journalWrites.filter(({ data }) => data.run?.id === migrated.id);
    assert.equal(journaled.length > 0, true);
    for (const { data } of journaled) {
      assert.equal("resumeCompactFrom" in data.run, false, "the internal marker never reaches a persisted run");
      assert.equal(data.run.model, "new-provider/new-model:high");
    }

    const thinkingOnly = await resumeWith("thinking", "provider/model:low", "provider/model:high");
    assert.equal(thinkingOnly.result.details.run.model, "provider/model:high", "a thinking-only change still uses the new spec");
    assert.equal(thinkingOnly.config.model, "provider/model:high");
    assert.equal("resumeCompactFrom" in thinkingOnly.config, false, "a thinking-only change never compacts");

    const idColon = await resumeWith("id-colon", "provider/model:2025-01-01", "provider/model");
    assert.equal(idColon.config.resumeCompactFrom, "provider/model:2025-01-01",
      "a colon that is not a known thinking level belongs to the model ID");

    const unchanged = await resumeWith("unchanged", "provider/model:high", "provider/model:high");
    assert.equal("resumeCompactFrom" in unchanged.config, false);
  } finally { harness.cleanup(); }
});

test("resume without a preset model resolver fails atomically like an inactive create", async () => {
  const harness = createHarness();
  try {
    await harness.restore();
    const sessionFile = join(harness.tempDir, "source.jsonl");
    writeFileSync(sessionFile, "session");
    harness.runtime.registry.add(persistedRun({ id: "source", status: "completed", sessionFile }));
    const journalsBefore = harness.journalWrites.length;
    const subagent = harness.tools.get("subagent");
    const request = { action: "resume", id: "source", abstract: "new summary", message: "continue" };

    harness.runtime.setDenyResolver(() => []);
    await assert.rejects(
      subagent.execute("resume-no-model", request),
      /oh-my-pi-slim is inactive; enable a preset before resuming a subagent\./,
    );

    harness.runtime.setModelResolver(() => "provider/model:high");
    harness.runtime.setDenyResolver(undefined);
    await assert.rejects(
      subagent.execute("resume-no-deny", request),
      /oh-my-pi-slim is inactive; enable a preset before resuming a subagent\./,
    );

    harness.runtime.setDenyResolver(() => []);
    harness.runtime.setModelResolver(() => "   ");
    await assert.rejects(
      subagent.execute("resume-blank-model", request),
      /preset model for fixer must be a non-empty string\./,
    );

    assert.equal(harness.launches.length, 0, "an unresolved model never launches a runner");
    assert.equal(harness.journalWrites.length, journalsBefore, "an unresolved model never journals a run");
    assert.deepEqual(harness.runtime.registry.list().map((run) => run.id), ["source"]);
    assert.equal(existsSync(getRunRoot(harness.sessionDir)), false, "an unresolved model never creates a run directory");
  } finally { harness.cleanup(); }
});

test("launch configs stay compatible across the optional resume preflight marker", async () => {
  const harness = createHarness();
  try {
    await harness.restore();
    harness.runtime.setModelResolver(() => "provider/model:high");
    harness.runtime.setDenyResolver(() => []);
    const started = await createRun(harness);
    const legacy = readConfig(harness, started.details.run.id);
    assert.equal("resumeCompactFrom" in legacy, false, "create never writes the resume preflight marker");
    assert.equal("steerResponseTimeoutMs" in legacy, false, "normal runtime launches never write the test timeout seam");
    assert.equal(isDetachedLaunchConfig(legacy), true, "an old config without the marker stays valid");
    assert.equal(isDetachedLaunchConfig({ ...legacy, resumeCompactFrom: "old/model:low" }), true);
    assert.equal(isDetachedLaunchConfig({ ...legacy, resumeCompactFrom: "" }), false);
    assert.equal(isDetachedLaunchConfig({ ...legacy, resumeCompactFrom: 5 }), false);
    assert.equal(isDetachedLaunchConfig({ ...legacy, resumeCompactFrom: null }), false);
    assert.equal(isDetachedLaunchConfig({ ...legacy, steerResponseTimeoutMs: 75 }), true);
    for (const steerResponseTimeoutMs of [0, -1, 1.5, "75", null]) {
      assert.equal(isDetachedLaunchConfig({ ...legacy, steerResponseTimeoutMs }), false);
    }

    const runnerCheck = execFileSync(process.execPath, ["--input-type=module", "--eval", [
      'import { readFileSync, writeFileSync } from "node:fs";',
      `const source = readFileSync(${JSON.stringify(join(ROOT, "extensions/oh-my-pi-slim/runner/omps-runner.mjs"))}, "utf8");`,
      'const start = source.indexOf("function normalizeConfig(value)");',
      'const end = source.indexOf("function atomicWriteJson", start);',
      "process.stdout.write(source.slice(start, end));",
    ].join("\n")], { encoding: "utf8" });
    assert.match(runnerCheck, /value\.resumeCompactFrom === undefined \|\| nonEmpty\(value\.resumeCompactFrom\)/,
      "the runner mirrors the same optional marker rule");
    assert.match(runnerCheck, /Number\.isInteger\(value\.steerResponseTimeoutMs\) && value\.steerResponseTimeoutMs > 0/,
      "the runner mirrors the positive-integer timeout seam rule");
  } finally { harness.cleanup(); }
});

test("delete rejects starting, running, and waiting runs without deleting journals or files", async () => {
  for (const status of ["starting", "running", "waiting"]) {
    const harness = createHarness();
    try {
      await harness.restore();
      const created = await createRun(harness, { abstract: `${status} delete guard` });
      const id = created.details.run.id;
      const config = readConfig(harness, id);
      if (status !== "starting") {
        harness.alive.add(999);
        atomicWriteJson(harness.paths(id).stateFile, stateFor(id, config.token, status === "waiting" ? {
          status,
          waitingSeq: 1,
          request: {
            runId: id,
            reason: "need_decision",
            message: "choose",
            createdAt: "2026-04-17T00:00:00.000Z",
          },
        } : { status }));
      }
      await inspect(harness, id);
      const beforeRun = harness.runtime.registry.require(id);
      const beforeJournalCount = harness.journalWrites.length;
      const beforeConfig = readFileSync(harness.paths(id).configFile, "utf8");
      const beforeState = existsSync(harness.paths(id).stateFile)
        ? readFileSync(harness.paths(id).stateFile, "utf8")
        : undefined;

      await assert.rejects(deleteRun(harness, id), (error) => {
        assert.match(error.message, new RegExp(`${id}.*status ${status}`));
        assert.match(error.message, /Ask the user whether to interrupt this run, then retry delete only if they agree\./);
        return true;
      });
      assert.deepEqual(harness.runtime.registry.require(id), beforeRun);
      assert.equal(harness.journalWrites.length, beforeJournalCount);
      assert.equal(readFileSync(harness.paths(id).configFile, "utf8"), beforeConfig);
      assert.equal(existsSync(harness.paths(id).stateFile), beforeState !== undefined);
      if (beforeState !== undefined) assert.equal(readFileSync(harness.paths(id).stateFile, "utf8"), beforeState);
      assert.equal(harness.journalWrites.some(({ data }) => data.version === 3), false);
    } finally { harness.cleanup(); }
  }
});

test("delete succeeds for completed, failed, and interrupted runs and reports removed status", async () => {
  const harness = createHarness();
  try {
    await harness.restore();
    for (const status of ["completed", "failed", "interrupted"]) {
      const id = `delete-${status}`;
      seedTerminalRun(harness, {
        id,
        status,
        output: status === "completed" ? "done" : undefined,
        error: status === "completed" ? undefined : `${status} error`,
      });
      harness.runtime.activity.set(id, stateFor(id, "token"));
      harness.runtime.health.set(id, { trackedAt: NOW_MS });
      harness.runtime.repliedSeqs.set(id, { waitingSeq: 1, sentAt: NOW_MS });
      harness.runtime.terminationConfirmed.set(id, true);
    }

    for (const status of ["completed", "failed", "interrupted"]) {
      const id = `delete-${status}`;
      const result = await deleteRun(harness, id);
      assert.equal(result.content[0].text, `Deleted retained subagent run ${id}.`);
      assert.deepEqual(result.details, { id, deleted: true, changed: true, warnings: [] });
      assert.equal(harness.runtime.registry.get(id), undefined);
      assert.equal(harness.runtime.clearedRunIds.has(id), true);
      assert.equal(harness.runtime.activity.has(id), false);
      assert.equal(harness.runtime.health.has(id), false);
      assert.equal(harness.runtime.repliedSeqs.has(id), false);
      assert.equal(harness.runtime.terminationConfirmed.has(id), false);
      await assert.rejects(
        harness.tools.get("subagent").execute("status", { action: "status", id }),
        new RegExp(`Run ${id} was removed from the retained subagent history`),
      );
    }
    assert.equal(harness.journalWrites.filter(({ data }) => data.version === 3).length, 3);
    assert.equal(harness.journalWrites.some(({ data }) => data.version === 4), false);
  } finally { harness.cleanup(); }
});

test("delete purges run files and only exclusively owned child sessions while preserving warnings", async () => {
  const harness = createHarness();
  try {
    await harness.restore();
    const childDir = join(harness.sessionDir, "omps-subagents");
    mkdirSync(childDir, { recursive: true, mode: 0o700 });

    const exclusive = join(childDir, "exclusive.jsonl");
    writeFileSync(exclusive, "{}\n");
    seedTerminalRun(harness, { id: "exclusive-run", sessionFile: exclusive });
    const exclusiveResult = await deleteRun(harness, "exclusive-run");
    assert.deepEqual(exclusiveResult.details.warnings, []);
    assert.equal(existsSync(harness.paths("exclusive-run").runDir), false);
    assert.equal(existsSync(exclusive), false);

    const shared = join(childDir, "shared.jsonl");
    writeFileSync(shared, "{}\n");
    seedTerminalRun(harness, { id: "shared-source", sessionFile: shared });
    seedTerminalRun(harness, { id: "shared-resume", sessionFile: shared, sourceRunId: "shared-source" });
    const sharedResult = await deleteRun(harness, "shared-source");
    assert.equal(existsSync(shared), true);
    assert.match(sharedResult.details.warnings.join("\n"), /another retained run still references it/);
    assert.equal(harness.runtime.registry.get("shared-resume").sessionFile, shared);

    const linkedId = "warning-run";
    const linkedPaths = harness.paths(linkedId);
    mkdirSync(dirname(linkedPaths.runDir), { recursive: true, mode: 0o700 });
    const realRunDir = join(harness.tempDir, "real-warning-run");
    mkdirSync(realRunDir, { recursive: true, mode: 0o700 });
    symlinkSync(realRunDir, linkedPaths.runDir);
    const outsideSession = join(harness.tempDir, "outside-delete.jsonl");
    writeFileSync(outsideSession, "{}\n");
    harness.runtime.registry.add(persistedRun({ id: linkedId, status: "failed", sessionFile: outsideSession }), false);

    const warningResult = await deleteRun(harness, linkedId);
    const warnings = warningResult.details.warnings.join("\n");
    assert.match(warnings, /Retained run directory for warning-run/);
    assert.match(warnings, /Retained child session file for warning-run: .*outside this session's child session directory/);
    assert.equal(existsSync(realRunDir), true);
    assert.equal(existsSync(outsideSession), true);
    assert.equal(harness.runtime.registry.get(linkedId), undefined);
  } finally { harness.cleanup(); }
});

test("delete writes a version-3 replacement and suppresses a late target upsert during the guard", async () => {
  let harness;
  let target;
  harness = createHarness({
    onJournalWrite({ data }) {
      if (data.version !== 3) return;
      harness.runtime.persistRun(target);
      harness.runtime.deliverPendingNotification(target.id);
      harness.runtime.retryQueuedNotificationsAfterAgentSettled();
    },
  });
  let branch;
  try {
    await harness.restore();
    target = seedTerminalRun(harness, {
      id: "journal-delete",
      notificationPending: "completed",
    });
    harness.runtime.persistRun(target);
    harness.runtime.queuedNotifications.add(expectedDeliveryKey(target.id, "completed"));
    const result = await deleteRun(harness, target.id);
    assert.equal(result.details.deleted, true);
    const replacementIndex = harness.journalWrites.findIndex(({ data }) => data.version === 3);
    assert.notEqual(replacementIndex, -1);
    assert.equal(harness.journalWrites.slice(replacementIndex + 1)
      .some(({ data }) => data.version === 2 && data.run?.id === target.id), false);
    assert.deepEqual(harness.journalWrites[replacementIndex].data, { version: 3, runs: [] });
    assert.equal(harness.notifications.length, 0);
    branch = harness.journalWrites.map(({ data }) => branchEntry(data));
  } finally { harness.cleanup(); }

  const restored = createHarness({ branch });
  try {
    await restored.restore();
    assert.equal(restored.runtime.registry.get(target.id), undefined);
    await assert.rejects(
      restored.tools.get("subagent").execute("status", { action: "status", id: target.id }),
      /was removed from the retained subagent history/,
    );
  } finally { restored.cleanup(); }
});

test("delete waits for an existing reconciliation promise before removing the run", async () => {
  const harness = createHarness();
  let release;
  try {
    await harness.restore();
    seedTerminalRun(harness, { id: "reconcile-delete" });
    const inFlight = new Promise((resolvePromise) => { release = resolvePromise; });
    harness.runtime.reconciling.set("reconcile-delete", inFlight);

    const deleting = deleteRun(harness, "reconcile-delete");
    await new Promise((resolveImmediate) => setImmediate(resolveImmediate));
    assert.notEqual(harness.runtime.registry.get("reconcile-delete"), undefined);
    assert.equal(harness.journalWrites.some(({ data }) => data.version === 3), false);

    release();
    const result = await deleting;
    assert.equal(result.details.deleted, true);
    assert.equal(harness.runtime.registry.get("reconcile-delete"), undefined);
  } finally { harness.cleanup(); }
});

test("delete keeps the registry unchanged when replacement append fails and retries after missing-file cleanup", async () => {
  let failAppend = true;
  const harness = createHarness({
    onJournalWrite({ data }) {
      if (failAppend && data.version === 3) throw new Error("simulated append failure");
    },
  });
  try {
    await harness.restore();
    seedTerminalRun(harness, { id: "append-failure", notificationPending: "completed" });
    const deliveryKey = expectedDeliveryKey("append-failure", "completed");
    harness.runtime.queuedNotifications.add(deliveryKey);

    await assert.rejects(deleteRun(harness, "append-failure"), /simulated append failure/);
    assert.notEqual(harness.runtime.registry.get("append-failure"), undefined);
    assert.equal(harness.runtime.clearedRunIds.has("append-failure"), false);
    assert.equal(harness.runtime.deletingRunIds.has("append-failure"), false);
    assert.equal(harness.runtime.queuedNotifications.has(deliveryKey), true);
    assert.equal(existsSync(harness.paths("append-failure").runDir), false);

    failAppend = false;
    const result = await deleteRun(harness, "append-failure");
    assert.deepEqual(result.details.warnings, []);
    assert.equal(harness.runtime.registry.get("append-failure"), undefined);
  } finally { harness.cleanup(); }
});

test("delete cancels only target notifications and leaves other queued delivery intact", async () => {
  let harness;
  harness = createHarness({
    onJournalWrite({ data }) {
      if (data.version !== 3) return;
      harness.runtime.deliverPendingNotification("notify-target");
      harness.runtime.retryQueuedNotificationsAfterAgentSettled();
    },
  });
  try {
    await harness.restore();
    for (const id of ["notify-target", "notify-other"]) {
      seedTerminalRun(harness, { id, notificationPending: "completed" });
      harness.runtime.queuedNotifications.add(expectedDeliveryKey(id, "completed"));
    }

    await deleteRun(harness, "notify-target");
    assert.equal(harness.notifications.some(({ message }) => message.details.runId === "notify-target"), false);
    assert.equal(harness.runtime.queuedNotifications.has(expectedDeliveryKey("notify-target", "completed")), false);
    assert.equal(harness.notifications.filter(({ message }) => message.details.runId === "notify-other").length, 1);
    assert.equal(harness.runtime.queuedNotifications.has(expectedDeliveryKey("notify-other", "completed")), true);
    assert.notEqual(harness.runtime.registry.get("notify-other"), undefined);
  } finally { harness.cleanup(); }
});

test("delete never changes Goal statistics, sidecars, or lazy-load bookkeeping", async () => {
  let statsReads = 0;
  const harness = createHarness({
    readGoalStats() {
      statsReads += 1;
      throw new Error("delete must not read Goal stats");
    },
  });
  try {
    await harness.restore();
    const id = "goal-delete";
    seedTerminalRun(harness, { id });
    const stats = { tokens: 77, tools: 4, turns: 5, compactions: 2 };
    harness.runtime.goalActivity.set(id, structuredClone(stats));
    harness.runtime.loadedGoalStatsSidecars.add(id);
    const sidecarStats = { version: 1, runId: id, ...stats };
    assert.equal(writeGoalStatsSidecar(getGoalStatsRoot(harness.sessionDir), harness.ownerSessionId, sidecarStats), true);
    const sidecar = getGoalStatsSidecarPaths(getGoalStatsRoot(harness.sessionDir), harness.ownerSessionId, id).file;
    const beforeSidecar = readFileSync(sidecar, "utf8");

    await deleteRun(harness, id);
    assert.deepEqual(harness.runtime.goalActivity.get(id), stats);
    assert.equal(harness.runtime.loadedGoalStatsSidecars.has(id), true);
    assert.equal(readFileSync(sidecar, "utf8"), beforeSidecar);
    assert.deepEqual(harness.runtime.goalStats([id]), {
      runCount: 1,
      tokens: 77,
      tools: 4,
      turns: 5,
      compactions: 2,
    });
    assert.equal(statsReads, 0);
  } finally { harness.cleanup(); }
});

test("reload and restore retain terminal results for status until clear removes the run", async () => {
  const restored = createHarness({
    branch: [branchEntry({ version: 1, runs: [persistedRun({
      id: "restored-terminal", status: "completed", abstract: "restored result",
      output: "RESTORED_OUTPUT", error: "RESTORED_ERROR",
    })] })],
  });
  try {
    await restored.restore();
    const status = await restored.tools.get("subagent").execute("status", {
      action: "status", id: "restored-terminal",
    });
    assert.deepEqual(status.details.run, {
      id: "restored-terminal", agent: "fixer", abstract: "restored result",
      status: "completed", live: false, output: "RESTORED_OUTPUT", error: "RESTORED_ERROR",
    });
    assert.deepEqual(JSON.parse(status.content[0].text), status.details.run);
    await clear(restored);
    await assert.rejects(
      restored.tools.get("subagent").execute("status", { action: "status", id: "restored-terminal" }),
      /was removed from the retained subagent history/,
    );
  } finally { restored.cleanup(); }
});

test("clear rejects while any run stays active and changes nothing", async () => {
  const harness = createHarness();
  try {
    await harness.restore();
    const started = await createRun(harness);
    const id = started.details.run.id;
    const config = readConfig(harness, id);
    harness.alive.add(999);
    atomicWriteJson(harness.paths(id).stateFile, stateFor(id, config.token));
    await inspect(harness, id);
    seedTerminalRun(harness, { id: "already-done" });
    const journalCount = harness.journalWrites.length;

    await assert.rejects(clear(harness), (error) => {
      assert.match(error.message, /clear requires every retained run to reach a terminal status/);
      assert.match(error.message, new RegExp(`${id} \\(running\\)`));
      assert.match(error.message, /Ask the user whether to interrupt these active runs, then retry clear only if they agree\./);
      return true;
    });
    assert.deepEqual(harness.runtime.registry.list().map((run) => run.id).sort(), ["already-done", id].sort());
    assert.equal(harness.journalWrites.length, journalCount, "a rejected clear appends no journal entry");
    assert.equal(existsSync(harness.paths(id).runDir), true);
    assert.equal(existsSync(harness.paths("already-done").runDir), true);

    for (const status of ["starting", "waiting"]) {
      harness.runtime.registry.update(id, { status });
      await assert.rejects(clear(harness), /clear requires every retained run to reach a terminal status/);
    }
  } finally { harness.cleanup(); }
});

test("clear on empty terminal history is a no-change without a clear journal entry", async () => {
  const harness = createHarness();
  try {
    await harness.restore();
    const result = await clear(harness);
    assert.deepEqual(result.details, { clearedCount: 0, warnings: [], changed: false });
    assert.equal(result.content[0].text, "No retained subagent runs to clear.");
    assert.deepEqual(harness.journalWrites, []);

    const collapsed = stripVTControlCharacters(harness.tools.get("subagent")
      .renderResult(result, { expanded: false }, transcriptTheme, { args: { action: "clear" } })
      .render(200).join("\n")).trim();
    assert.equal(collapsed, "○  No retained runs to clear");
  } finally { harness.cleanup(); }
});

test("clear removes terminal run directories and appends one version-3 replacement snapshot", async () => {
  const harness = createHarness();
  let branch;
  let id;
  try {
    await harness.restore();
    const started = await createRun(harness);
    id = started.details.run.id;
    const config = readConfig(harness, id);
    atomicWriteJson(harness.paths(id).stateFile, stateFor(id, config.token, {
      status: "completed", output: "terminal output", responseText: "done",
    }));
    await inspect(harness, id);
    assert.equal(existsSync(harness.paths(id).runDir), true);
    assert.equal(existsSync(harness.paths(id).configFile), true);
    assert.equal(existsSync(harness.paths(id).stateFile), true);

    const result = await clear(harness);
    assert.equal(result.details.clearedCount, 1);
    assert.equal(result.details.changed, true);
    assert.equal(existsSync(harness.paths(id).runDir), false, "clear removes the run directory, state, and config");
    assert.deepEqual(harness.runtime.registry.list(), []);
    assert.deepEqual(harness.journalWrites.at(-1), {
      type: "oh-my-pi-slim:subagents",
      data: { version: 3, runs: [] },
    });
    assert.equal(harness.journalWrites.filter(({ data }) => data.version === 3).length, 1);
    assert.equal(harness.journalWrites.some(({ data }) => data.version === 2), true, "earlier v2 upserts stay in history");
    branch = harness.journalWrites.map(({ data }) => branchEntry(data));
  } finally { harness.cleanup(); }

  const restored = createHarness({ branch });
  try {
    await restored.restore();
    assert.deepEqual(restored.runtime.registry.list(), [], "the latest version-3 replacement wins on replay");
    assert.equal(restored.notifications.length, 0, "cleared runs never replay a pending notification");
    const listed = await restored.tools.get("subagent").execute("list", { action: "list" });
    assert.deepEqual(listed.details.runs, []);
    await assert.rejects(
      restored.tools.get("subagent").execute("resume", { action: "resume", id, abstract: "again", message: "again" }),
      new RegExp(`Run ${id} was removed from the retained subagent history and is no longer available`),
    );
  } finally { restored.cleanup(); }
});

test("clear replay stays empty over legacy version-1 and version-2 history and later upserts still fold", async () => {
  const legacy = persistedRun({ id: "legacy-one", status: "completed", output: "legacy output" });
  const upsert = persistedRun({ id: "upsert-one", status: "failed", error: "boom" });
  const afterClear = persistedRun({ id: "after-clear", status: "completed", createdAt: "2026-04-17T01:00:00.000Z" });
  const clearedOnly = createHarness({
    branch: [
      branchEntry({ version: 1, runs: [legacy] }),
      branchEntry({ version: 2, run: upsert }),
      branchEntry({ version: 3, runs: [] }),
    ],
  });
  try {
    await clearedOnly.restore();
    assert.deepEqual(clearedOnly.runtime.registry.list(), []);
    for (const id of ["legacy-one", "upsert-one"]) {
      await assert.rejects(
        clearedOnly.tools.get("subagent").execute("steer", { action: "steer", id, message: "go" }),
        new RegExp(`Run ${id} was removed from the retained subagent history and is no longer available`),
      );
    }
  } finally { clearedOnly.cleanup(); }

  const resumedHistory = createHarness({
    branch: [
      branchEntry({ version: 1, runs: [legacy] }),
      branchEntry({ version: 3, runs: [] }),
      branchEntry({ version: 2, run: afterClear }),
    ],
  });
  try {
    await resumedHistory.restore();
    assert.deepEqual(resumedHistory.runtime.registry.list().map((run) => run.id), ["after-clear"]);
    await assert.rejects(
      resumedHistory.tools.get("subagent").execute("interrupt", { action: "interrupt", id: "legacy-one" }),
      /was removed from the retained subagent history/,
    );
    await assert.rejects(
      resumedHistory.tools.get("subagent").execute("interrupt", { action: "interrupt", id: "never-existed" }),
      /Unknown subagent run: never-existed/,
    );
  } finally { resumedHistory.cleanup(); }
});

test("clear removes owned child session files once and warns about shared, escaped, and linked paths", async () => {
  const harness = createHarness();
  try {
    await harness.restore();
    const childDir = join(harness.sessionDir, "omps-subagents");
    mkdirSync(childDir, { recursive: true, mode: 0o700 });
    const shared = join(childDir, "shared.jsonl");
    const linked = join(childDir, "linked.jsonl");
    const linkTarget = join(harness.tempDir, "link-target.jsonl");
    const outside = join(harness.tempDir, "outside.jsonl");
    const nested = join(childDir, "nested");
    mkdirSync(nested, { recursive: true, mode: 0o700 });
    const nestedFile = join(nested, "deep.jsonl");
    for (const file of [shared, linkTarget, outside, nestedFile]) writeFileSync(file, "{}\n");
    symlinkSync(linkTarget, linked);

    seedTerminalRun(harness, { id: "shared-a", sessionFile: shared });
    seedTerminalRun(harness, { id: "shared-b", sessionFile: shared });
    seedTerminalRun(harness, { id: "nested-run", sessionFile: nestedFile });
    seedTerminalRun(harness, { id: "linked-run", sessionFile: linked });
    seedTerminalRun(harness, { id: "escaped-run", sessionFile: outside });
    seedTerminalRun(harness, { id: "missing-run", sessionFile: join(childDir, "gone.jsonl") });
    seedTerminalRun(harness, { id: "directory-run", sessionFile: nested });

    const result = await clear(harness);
    assert.equal(result.details.clearedCount, 7);
    assert.equal(result.details.changed, true);
    assert.equal(existsSync(shared), false, "a session file shared by two cleared runs is removed exactly once");
    assert.equal(existsSync(nestedFile), false);
    assert.equal(existsSync(linked), true, "a symlinked session file is never removed");
    assert.equal(existsSync(linkTarget), true);
    assert.equal(existsSync(outside), true, "a session file outside the child session directory is never removed");
    assert.equal(existsSync(nested), true, "a session path that is a directory is never removed");
    const warnings = result.details.warnings.join("\n");
    assert.match(warnings, /Retained child session file for linked-run: .*symbolic link/);
    assert.match(warnings, /Retained child session file for escaped-run: .*outside this session's child session directory/);
    assert.match(warnings, /Retained child session file for directory-run: .*not a regular file/);
    assert.doesNotMatch(warnings, /shared-a|shared-b|nested-run|missing-run/);
    assert.deepEqual(harness.runtime.registry.list(), [], "unsafe session files never block registry consistency");
    for (const id of ["shared-a", "linked-run", "escaped-run", "directory-run"]) {
      assert.equal(existsSync(harness.paths(id).runDir), false);
    }
  } finally { harness.cleanup(); }
});

test("clear ignores Goal ownership and never replays or reads/removes Goal stats", async () => {
  const cases = [
    { name: "Goal snapshot", branch: [goalBranchEntry(["run-a", "run-b"])], runIds: ["run-a", "run-b"] },
    { name: "no Goal snapshot", branch: [], runIds: ["run-a"] },
    { name: "partial Goal ownership", branch: [goalBranchEntry(["run-a"])], runIds: ["run-a", "run-b"] },
  ];
  for (const scenario of cases) {
    let statsReads = 0;
    const harness = createHarness({
      branch: scenario.branch,
      readGoalStats() {
        statsReads += 1;
        throw new Error(`clear read Goal stats in ${scenario.name}`);
      },
    });
    try {
      await harness.restore();
      const sidecars = new Map();
      for (const [index, runId] of scenario.runIds.entries()) {
        const stats = { version: 1, runId, tokens: 10 + index, tools: 1, turns: 2, compactions: 0 };
        assert.equal(writeGoalStatsSidecar(getGoalStatsRoot(harness.sessionDir), harness.ownerSessionId, stats), true);
        const file = getGoalStatsSidecarPaths(getGoalStatsRoot(harness.sessionDir), harness.ownerSessionId, runId).file;
        sidecars.set(file, readFileSync(file, "utf8"));
        seedTerminalRun(harness, { id: runId });
      }
      harness.ctx.sessionManager.getBranch = () => {
        throw new Error(`clear replayed the ${scenario.name} branch`);
      };

      const result = await clear(harness);
      assert.deepEqual(result.details.warnings, [], scenario.name);
      assert.equal(statsReads, 0, `${scenario.name} clear must not read Goal stats`);
      for (const [file, before] of sidecars) {
        assert.equal(readFileSync(file, "utf8"), before, `${scenario.name} sidecar must stay byte-for-byte unchanged`);
      }
    } finally { harness.cleanup(); }
  }
});

test("clear preserves memory-only Goal stats after sidecar write failure", async () => {
  let statsReads = 0;
  let statsWrites = 0;
  const harness = createHarness({
    readGoalStats() {
      statsReads += 1;
      return undefined;
    },
    writeGoalStats() {
      statsWrites += 1;
      throw new Error("simulated sidecar write failure");
    },
  });
  try {
    await harness.restore();
    seedTerminalRun(harness, { id: "memory-only" });
    harness.runtime.captureGoalActivity("memory-only", stateFor("memory-only", "token", {
      status: "completed", providerTokens: 73, toolUses: 4, turnCount: 5, compactionCount: 2,
    }));
    const before = harness.runtime.goalStats(["memory-only"]);
    const readsBeforeClear = statsReads;
    assert.equal(statsWrites, 1);

    const result = await clear(harness);
    assert.deepEqual(result.details.warnings, []);
    assert.deepEqual(harness.runtime.goalStats(["memory-only"]), before);
    assert.equal(statsReads, readsBeforeClear, "clear and the preserved in-memory value must not reread Goal stats");
  } finally { harness.cleanup(); }
});

test("clear empties registry, list, and widget while Goal stats remain lazy-readable", async () => {
  const statsReads = [];
  const harness = createHarness({
    mode: "tui",
    readGoalStats(root, ownerSessionId, runId) {
      statsReads.push(runId);
      return readGoalStatsSidecar(root, ownerSessionId, runId);
    },
  });
  try {
    await harness.restore();
    const expected = [
      { version: 1, runId: "lazy-a", tokens: 40, tools: 2, turns: 3, compactions: 1 },
      { version: 1, runId: "lazy-b", tokens: 60, tools: 5, turns: 7, compactions: 2 },
    ];
    for (const stats of expected) {
      assert.equal(writeGoalStatsSidecar(getGoalStatsRoot(harness.sessionDir), harness.ownerSessionId, stats), true);
      seedTerminalRun(harness, { id: stats.runId });
    }

    const result = await clear(harness);
    assert.deepEqual(result.details.warnings, []);
    assert.deepEqual(harness.runtime.registry.list(), []);
    const listed = await harness.tools.get("subagent").execute("list", { action: "list" });
    assert.deepEqual(listed.details.runs, []);
    assert.equal(harness.widgetCalls.at(-1).content, undefined);
    assert.deepEqual(statsReads, [], "clear and list must not read Goal stats");
    assert.deepEqual(harness.runtime.goalStats(expected.map((stats) => stats.runId)), {
      runCount: 2, tokens: 100, tools: 7, turns: 10, compactions: 3,
    });
    assert.deepEqual(statsReads.sort(), ["lazy-a", "lazy-b"]);
  } finally { harness.cleanup(); }
});

test("clear retains an unsafe run directory and still clears the registry consistently", async () => {
  const harness = createHarness();
  try {
    await harness.restore();
    const safe = seedTerminalRun(harness, { id: "safe-run" });
    const linkedId = "linked-run-dir";
    const linkedPaths = harness.paths(linkedId);
    mkdirSync(dirname(linkedPaths.runDir), { recursive: true, mode: 0o700 });
    const realDir = join(harness.tempDir, "real-run-dir");
    mkdirSync(realDir, { recursive: true, mode: 0o700 });
    symlinkSync(realDir, linkedPaths.runDir);
    harness.runtime.registry.add(persistedRun({ id: linkedId, status: "failed", error: "boom" }), false);

    const result = await clear(harness);
    assert.equal(result.details.clearedCount, 2);
    assert.equal(result.details.changed, true);
    assert.match(result.details.warnings.join("\n"), /Retained run directory for linked-run-dir/);
    assert.equal(existsSync(harness.paths(safe.id).runDir), false);
    assert.equal(existsSync(realDir), true, "a linked run directory is never followed");
    assert.deepEqual(harness.runtime.registry.list(), []);
    assert.deepEqual(harness.journalWrites.at(-1).data, { version: 3, runs: [] });
  } finally { harness.cleanup(); }
});

test("clear blocks poll and agent-settled callbacks from reviving a targeted run", async () => {
  let harness;
  const observed = [];
  harness = createHarness({
    onJournalWrite({ data }) {
      if (data.version !== 3) return;
      observed.push({
        clearing: harness.runtime.clearing,
        registrySize: harness.runtime.registry.list().length,
      });
      harness.runtime.deliverPendingNotification("race-run");
      harness.runtime.retryQueuedNotificationsAfterAgentSettled();
      harness.intervals[0].callback();
    },
  });
  try {
    await harness.restore();
    harness.runtime.registry.add(persistedRun({
      id: "race-run", status: "completed", output: "done", notificationPending: "completed",
    }), false);
    mkdirSync(harness.paths("race-run").controlDir, { recursive: true, mode: 0o700 });
    harness.runtime.queuedNotifications.add(expectedDeliveryKey("race-run", "completed"));
    const notificationsBefore = harness.notifications.length;

    const result = await clear(harness);
    await new Promise((resolveTick) => setImmediate(resolveTick));

    assert.deepEqual(observed, [{ clearing: true, registrySize: 1 }]);
    assert.equal(result.details.changed, true);
    assert.deepEqual(harness.runtime.registry.list(), [], "no callback revives a run during or after clear");
    assert.equal(harness.notifications.length, notificationsBefore, "clear suppresses notification delivery for targeted runs");
    assert.equal(harness.runtime.queuedNotifications.size, 0);
    assert.equal(harness.journalWrites.filter(({ data }) => data.version === 3).length, 1);
    assert.equal(harness.runtime.clearing, false);
    harness.runtime.retryQueuedNotificationsAfterAgentSettled();
    harness.intervals[0].callback();
    await new Promise((resolveTick) => setImmediate(resolveTick));
    assert.deepEqual(harness.runtime.registry.list(), []);
    assert.equal(harness.notifications.length, notificationsBefore);
  } finally { harness.cleanup(); }
});

test("every ID-bearing action reports a removed run explicitly and never reuses its ID", async () => {
  const harness = createHarness();
  try {
    await harness.restore();
    const sessionFile = join(harness.sessionDir, "omps-subagents", "cleared.jsonl");
    mkdirSync(dirname(sessionFile), { recursive: true, mode: 0o700 });
    writeFileSync(sessionFile, "{}\n");
    seedTerminalRun(harness, { id: "gone-run", sessionFile });
    await clear(harness);

    const subagent = harness.tools.get("subagent");
    const cleared = /Run gone-run was removed from the retained subagent history and is no longer available/;
    await assert.rejects(subagent.execute("status", { action: "status", id: "gone-run" }), cleared);
    await assert.rejects(subagent.execute("resume", { action: "resume", id: "gone-run", abstract: "a", message: "m" }), cleared);
    await assert.rejects(subagent.execute("steer", { action: "steer", id: "gone-run", message: "m" }), cleared);
    await assert.rejects(subagent.execute("interrupt", { action: "interrupt", id: "gone-run" }), cleared);
    await assert.rejects(subagent.execute("reply", { action: "reply", id: "gone-run", message: "m" }), cleared);
    await assert.rejects(subagent.execute("delete", { action: "delete", id: "gone-run" }), cleared);
    assert.equal(harness.runtime.clearedRunIds.has("gone-run"), true, "removed IDs stay reserved against reuse");

    harness.runtime.setModelResolver((agent) => `preset/${agent}:high`);
    harness.runtime.setDenyResolver(() => []);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      assert.notEqual(harness.runtime.newRunId(), "gone-run");
    }
  } finally { harness.cleanup(); }
});

test("clear rejects unknown fields and stays exactly { action: clear }", async () => {
  const harness = createHarness();
  try {
    await harness.restore();
    const subagent = harness.tools.get("subagent");
    await assert.rejects(subagent.execute("clear", { action: "clear", id: "x" }), /clear does not accept id or message/);
    await assert.rejects(subagent.execute("clear", { action: "clear", message: "x" }), /clear does not accept id or message/);
    await assert.rejects(subagent.execute("clear", { action: "clear", agent: "fixer" }), /clear does not accept create field\(s\): agent/);
    await assert.rejects(subagent.execute("clear", { action: "clear", abstract: "x" }), /clear does not accept create field\(s\): abstract/);
    await assert.rejects(subagent.execute("clear", { action: "clear", extra: 1 }), /subagent does not accept unknown field\(s\): extra/);
  } finally { harness.cleanup(); }
});

test("guarded child session removal rejects unsafe paths directly", () => {
  const tempDir = mkdtempSync(join(CACHE, "safe-removal-"));
  try {
    const childDir = join(tempDir, "children");
    mkdirSync(childDir, { recursive: true, mode: 0o700 });
    const file = join(childDir, "session.jsonl");
    writeFileSync(file, "{}\n");
    assert.deepEqual(removeChildSessionFile(childDir, file), { removed: true });
    assert.deepEqual(removeChildSessionFile(childDir, file), { removed: true });
    assert.equal(removeChildSessionFile(childDir, join(childDir, "..", "escape.jsonl")).removed, false);
    assert.equal(removeChildSessionFile(childDir, childDir).removed, false);
    assert.equal(removeChildSessionFile("", file).removed, false);
    assert.deepEqual(removeChildSessionFile(join(tempDir, "missing-root"), file), { removed: true });
  } finally { rmSync(tempDir, { recursive: true, force: true }); }
});

test("viewerSnapshot hands the read-only viewer a deep copy of every retained run", async () => {
  const harness = createHarness();
  try {
    await harness.restore();
    const childDir = resolve(harness.sessionDir, "omps-subagents");
    const running = await startRunningRun(harness, (runId) => ({
      status: "running",
      sessionFile: join(childDir, `${runId}.jsonl`),
      activeTools: { call: { name: "read", startedAt: "2026-04-17T00:00:01.000Z" } },
      responseText: "partial tail",
      turnCount: 3,
      toolUses: 2,
      tokens: 1234,
      contextPercent: 41,
      compactionCount: 1,
    }));
    const waiting = await startRunningRun(harness, (runId) => ({
      status: "waiting",
      waitingSeq: 1,
      sessionFile: join(childDir, `${runId}.jsonl`),
      request: {
        runId,
        reason: "need_decision",
        message: "Choose a lane.",
        interview: { questions: [{ prompt: "which" }] },
        createdAt: "2026-04-17T00:00:02.000Z",
      },
    }));
    const starting = await createRun(harness);
    const terminal = seedTerminalRun(harness, { id: "terminal-run" });

    const journalWritesBefore = harness.journalWrites.length;
    const snapshot = harness.runtime.viewerSnapshot();
    assert.equal(harness.journalWrites.length, journalWritesBefore, "viewerSnapshot must not write a journal entry");
    assert.deepEqual(
      [...snapshot.runs.map((run) => run.id)].sort(),
      [...harness.runtime.registry.list().map((run) => run.id)].sort(),
      "membership is exactly the retained set even though the viewer owns its navigation order",
    );
    assert.ok(snapshot.runs.some((run) => run.id === starting.details.run.id), "a starting run is retained too");
    assert.ok(snapshot.runs.some((run) => run.id === terminal.id), "a terminal run stays in the cycle");
    assert.equal(snapshot.childSessionDir, childDir);

    const runningSnapshot = snapshot.runs.find((run) => run.id === running.id);
    assert.equal(runningSnapshot.status, "running");
    assert.equal(runningSnapshot.live, true);
    assert.equal(runningSnapshot.model, "preset/fixer:high");
    assert.equal(runningSnapshot.sessionFile, join(childDir, `${running.id}.jsonl`));
    assert.equal(runningSnapshot.cwd, ROOT, "the viewer needs the run cwd to resolve built-in tool renderers");
    assert.deepEqual(runningSnapshot.activity, {
      turnCount: 3,
      toolUses: 2,
      activeTools: { call: { name: "read", startedAt: "2026-04-17T00:00:01.000Z" } },
      responseText: "partial tail",
      tokens: 1234,
      contextPercent: 41,
      compactionCount: 1,
    });
    const waitingSnapshot = snapshot.runs.find((run) => run.id === waiting.id);
    assert.equal(waitingSnapshot.status, "waiting");
    assert.deepEqual(waitingSnapshot.request.interview, { questions: [{ prompt: "which" }] });

    runningSnapshot.activity.activeTools.call.name = "mutated";
    runningSnapshot.activity.activeTools.injected = { name: "injected" };
    runningSnapshot.cwd = "/mutated";
    waitingSnapshot.request.interview.questions[0].prompt = "mutated";
    waitingSnapshot.request.message = "mutated";
    const second = harness.runtime.viewerSnapshot();
    const secondRunning = second.runs.find((run) => run.id === running.id);
    assert.deepEqual(secondRunning.activity.activeTools, {
      call: { name: "read", startedAt: "2026-04-17T00:00:01.000Z" },
    });
    assert.equal(secondRunning.cwd, ROOT, "a mutated snapshot copy never reaches the registry");
    const secondWaiting = second.runs.find((run) => run.id === waiting.id);
    assert.deepEqual(secondWaiting.request.interview, { questions: [{ prompt: "which" }] });
    assert.equal(secondWaiting.request.message, "Choose a lane.");
    assert.notEqual(second.runs[0], snapshot.runs[0]);

    assert.deepEqual(harness.runtime.registry.require(running.id).status, "running");
    assert.deepEqual(harness.runtime.registry.get(waiting.id).request.message, "Choose a lane.");
  } finally { harness.cleanup(); }
});

test("viewerSnapshot stays empty and safe without an attached session", () => {
  const harness = createHarness();
  try {
    const snapshot = harness.runtime.viewerSnapshot();
    assert.deepEqual(snapshot.runs, []);
    assert.equal(snapshot.childSessionDir, undefined);
  } finally { harness.cleanup(); }
});

test("viewerSnapshot membership matches registry, list, and widget while navigation uses creation order", async () => {
  const harness = createHarness();
  try {
    await harness.restore();
    const childDir = resolve(harness.sessionDir, "omps-subagents");
    const running = await startRunningRun(harness, (runId) => ({
      status: "running",
      sessionFile: join(childDir, `${runId}.jsonl`),
    }));
    const waiting = await startRunningRun(harness, (runId) => ({
      status: "waiting",
      waitingSeq: 1,
      sessionFile: join(childDir, `${runId}.jsonl`),
      request: { runId, reason: "need_decision", message: "Choose.", createdAt: "2026-04-17T00:00:02.000Z" },
    }));
    const starting = await createRun(harness);
    const startingId = starting.details.run.id;
    const completed = seedTerminalRun(harness, { id: "done-run", status: "completed", output: "final output" });
    const failed = seedTerminalRun(harness, { id: "fail-run", status: "failed", error: "provider error" });
    const interrupted = seedTerminalRun(harness, {
      id: "stop-run",
      status: "interrupted",
      error: "Interrupted by the parent session.",
    });

    const snapshot = harness.runtime.viewerSnapshot();
    const retained = harness.runtime.registry.list();
    assert.deepEqual(
      [...snapshot.runs.map((run) => run.id)].sort(),
      [...retained.map((run) => run.id)].sort(),
      "the viewer sees exactly the retained membership without borrowing registry display order",
    );
    assert.equal(snapshot.runs.length, 6);
    assert.deepEqual(
      [...new Set(snapshot.runs.map((run) => run.status))].sort(),
      ["completed", "failed", "interrupted", "running", "starting", "waiting"],
    );
    for (const id of [running.id, waiting.id, startingId, completed.id, failed.id, interrupted.id]) {
      assert.ok(snapshot.runs.some((run) => run.id === id), `${id} must be part of the viewer cycle`);
    }

    // The widget renders the same retained set; its heading total is the viewer's N.
    const widgetLines = renderSubagentWidgetLines({
      runs: retained,
      spinnerFrame: 0,
      terminalWidth: 200,
      theme: transcriptTheme,
      nowMs: NOW_MS,
      expanded: true,
    });
    const heading = stripVTControlCharacters(widgetLines[0]);
    assert.ok(heading.includes(`Agents (3/${snapshot.runs.length})`), heading);
    assert.ok(widgetLines.length <= MAX_SUBAGENT_WIDGET_LINES, "the widget still budgets its own rows");

    const terminalSnapshot = snapshot.runs.find((run) => run.id === completed.id);
    assert.equal(terminalSnapshot.transcriptCutoff, terminalSnapshot.updatedAt, "a terminal run freezes at its own end");
    assert.equal(terminalSnapshot.output, "final output");
    assert.equal(snapshot.runs.find((run) => run.id === failed.id).error, "provider error");
    assert.equal(snapshot.runs.find((run) => run.id === running.id).transcriptCutoff, undefined);
    assert.equal(snapshot.runs.find((run) => run.id === startingId).transcriptCutoff, undefined);
  } finally { harness.cleanup(); }
});

test("viewerSnapshot sorts valid creation times oldest-first, places invalid times last, and stays stable across lifecycle updates", async () => {
  const harness = createHarness();
  try {
    await harness.restore();
    for (const run of [
      persistedRun({ id: "newer", status: "completed", createdAt: "2026-04-17T00:03:00.000Z", updatedAt: "2026-04-17T00:03:00.000Z" }),
      persistedRun({ id: "tie-b", status: "completed", createdAt: "2026-04-17T00:02:00.000Z", updatedAt: "2026-04-17T00:08:00.000Z" }),
      persistedRun({ id: "invalid-z", status: "completed", createdAt: "not-a-date", updatedAt: "2026-04-17T00:09:00.000Z" }),
      persistedRun({ id: "oldest", status: "failed", createdAt: "2026-04-17T00:01:00.000Z", updatedAt: "2026-04-17T00:07:00.000Z" }),
      persistedRun({ id: "tie-a", status: "failed", createdAt: "2026-04-17T00:02:00.000Z", updatedAt: "2026-04-17T00:02:00.000Z" }),
      persistedRun({ id: "invalid-a", status: "interrupted", createdAt: "also-not-a-date", updatedAt: "2026-04-17T00:10:00.000Z" }),
    ]) harness.runtime.registry.add(run, run.status === "running" || run.status === "waiting");

    const expected = ["oldest", "tie-a", "tie-b", "newer", "invalid-a", "invalid-z"];
    assert.deepEqual(harness.runtime.viewerSnapshot().runs.map((run) => run.id), expected);
    const registryIds = harness.runtime.registry.list().map((run) => run.id);
    assert.notDeepEqual(registryIds, expected, "registry display sorting remains independent");
    const listed = await harness.tools.get("subagent").execute("list", { action: "list" });
    assert.deepEqual(listed.details.runs.map((run) => run.id), registryIds, "the list action keeps registry business sorting");

    harness.runtime.registry.update("tie-a", { status: "completed", updatedAt: "2030-01-01T00:00:00.000Z" });
    assert.deepEqual(harness.runtime.viewerSnapshot().runs.map((run) => run.id), expected, "status and updatedAt never move a viewer item");

    harness.runtime.registry.add(persistedRun({
      id: "resume-new",
      status: "starting",
      sourceRunId: "tie-a",
      createdAt: "2026-04-17T00:04:00.000Z",
      updatedAt: "2026-04-17T00:04:00.000Z",
    }), true);
    assert.deepEqual(
      harness.runtime.viewerSnapshot().runs.map((run) => run.id),
      ["oldest", "tie-a", "tie-b", "newer", "resume-new", "invalid-a", "invalid-z"],
      "a resumed run joins after older valid creations with its own new createdAt",
    );
  } finally { harness.cleanup(); }
});

test("viewerSnapshot copies the resume link and never shares a retained object", async () => {
  const harness = createHarness();
  try {
    await harness.restore();
    const source = seedTerminalRun(harness, { id: "src-run", status: "completed", output: "source output" });
    harness.runtime.registry.add(persistedRun({
      id: "resumed",
      status: "running",
      sourceRunId: source.id,
      sessionFile: "/child/shared.jsonl",
    }), true);

    const snapshot = harness.runtime.viewerSnapshot();
    const resumed = snapshot.runs.find((run) => run.id === "resumed");
    assert.equal(resumed.sourceRunId, "src-run");
    resumed.sourceRunId = "mutated";
    resumed.output = "mutated";
    assert.equal(harness.runtime.registry.require("resumed").sourceRunId, "src-run");
    assert.equal(harness.runtime.viewerSnapshot().runs.find((run) => run.id === "resumed").sourceRunId, "src-run");
  } finally { harness.cleanup(); }
});
