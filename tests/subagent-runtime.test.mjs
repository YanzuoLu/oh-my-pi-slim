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
import test from "node:test";

const piEntry = realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim());
const piRoot = dirname(dirname(piEntry));
const dependencyMap = {
  "@earendil-works/pi-ai": pathToFileURL(`${piRoot}/node_modules/@earendil-works/pi-ai/dist/index.js`).href,
  "@earendil-works/pi-coding-agent": pathToFileURL(`${piRoot}/dist/index.js`).href,
  "@earendil-works/pi-tui": pathToFileURL(`${piRoot}/node_modules/@earendil-works/pi-tui/dist/index.js`).href,
  typebox: pathToFileURL(`${piRoot}/node_modules/typebox/build/index.mjs`).href,
  "./subagent-core.js": new URL("../extensions/oh-my-pi-slim/subagent-core.ts", import.meta.url).href,
  "./subagent-run-files.js": new URL("../extensions/oh-my-pi-slim/subagent-run-files.ts", import.meta.url).href,
  "./subagent-widget.js": new URL("../extensions/oh-my-pi-slim/subagent-widget.ts", import.meta.url).href,
  "./subagent-widget-renderer.js": new URL("../extensions/oh-my-pi-slim/subagent-widget-renderer.ts", import.meta.url).href,
  "./subagent-widget-display.js": new URL("../extensions/oh-my-pi-slim/subagent-widget-display.ts", import.meta.url).href,
  "./subagent-widget-glyphs.js": new URL("../extensions/oh-my-pi-slim/subagent-widget-glyphs.ts", import.meta.url).href,
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    const url = dependencyMap[specifier];
    return url ? { url, shortCircuit: true } : nextResolve(specifier, context);
  },
});

const {
  SUBAGENT_ACTIONS,
  SUBAGENT_PUBLIC_FIELDS,
  SUPERVISOR_ACTIONS,
  SUPERVISOR_PUBLIC_FIELDS,
  SubagentRegistry,
  restoreRunJournal,
  runJournalEntry,
  validateFreshInput,
} = await import("../extensions/oh-my-pi-slim/subagent-core.ts");
const {
  OmpsSubagentRuntime,
  discoverPackageAgents,
  shouldApproveChildProject,
  subagentParameters,
  supervisorParameters,
} = await import("../extensions/oh-my-pi-slim/subagent-runtime.ts");
const {
  atomicWriteJson,
  getProcessIdentity,
  getRunPaths,
  getRunRoot,
  isDetachedLaunchConfig,
  isDetachedRunnerIdentity,
  listOwnerRunIds,
  removeRunFiles,
  safeReadJson,
  writeControl,
} = await import("../extensions/oh-my-pi-slim/subagent-run-files.ts");

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CACHE = join(ROOT, ".cache");
const NOW_MS = Date.parse("2026-04-17T00:00:00.000Z");
mkdirSync(CACHE, { recursive: true });

function persistedRun(overrides = {}) {
  return {
    id: "run-1",
    agent: "fixer",
    task: "fix it",
    cwd: ROOT,
    model: "provider/model:high",
    tools: ["read", "edit", "write", "contact_supervisor"],
    status: "running",
    createdAt: "2026-04-16T23:59:00.000Z",
    updatedAt: "2026-04-16T23:59:00.000Z",
    ...overrides,
  };
}

function branchEntry(data) {
  return { type: "custom", customType: "oh-my-pi-slim:subagents", data };
}

function createHarness({
  branch = [],
  ownerSessionId = "owner-a",
  mode = "rpc",
  trusted = true,
  shutdownWaitMs = 0,
  sleep = async () => {},
  sendMessageError,
  launchError,
  keepAliveAfterKill = false,
  keepAliveAfterTerm = false,
  rejectGroupSignal = false,
} = {}) {
  const tempDir = mkdtempSync(join(CACHE, "runtime-harness-"));
  chmodSync(tempDir, 0o700);
  const sessionDir = join(tempDir, "sessions");
  mkdirSync(sessionDir, { recursive: true });
  let clock = NOW_MS;
  const tools = new Map();
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
  const statusCalls = [];
  const pi = {
    registerTool(definition) { tools.set(definition.name, definition); },
    appendEntry(type, data) { journalWrites.push({ type, data }); },
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
    controlWriter(paths, token, type, message, requestId) {
      controlWrites.push({ runId: paths.runDir.split("/").at(-1), token, type, message, requestId });
      return writeControl(paths, token, type, message, requestId);
    },
    setInterval(callback, ms) {
      const timer = { callback, ms, unref() {} };
      intervals.push(timer);
      return timer;
    },
    clearInterval(timer) { clearedIntervals.push(timer); },
    sleep,
  });
  runtime.registerTools();
  const ui = {
    setWidget(key, content, options) { widgetCalls.push({ key, content, options }); },
    setStatus(key, text) { statusCalls.push({ key, text }); },
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
    tempDir, sessionDir, ownerSessionId, runtime, tools, notifications, journalWrites, launches,
    intervals, clearedIntervals, alive, killed, controlWrites, widgetCalls, statusCalls, ctx,
    advance(ms) { clock += ms; },
    setProcessIdentity(pid, identity) { processIdentities.set(pid, identity); },
    paths(id, owner = ownerSessionId) { return getRunPaths(getRunRoot(sessionDir), owner, id); },
    async restore() { await runtime.restore(ctx); },
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

async function fresh(harness, overrides = {}) {
  harness.runtime.setModelResolver((agent) => `preset/${agent}:high`);
  return harness.tools.get("subagent").execute("call", { agent: "fixer", task: "detached task", ...overrides });
}

async function inspect(harness, id) {
  const result = await harness.tools.get("subagent").execute("list", { action: "list" });
  return result.details.runs.find((run) => run.id === id);
}

test("public schemas and package-agent boundaries remain minimal", async () => {
  assert.deepEqual(SUBAGENT_ACTIONS, ["list", "interrupt", "steer", "resume"]);
  assert.deepEqual(SUBAGENT_PUBLIC_FIELDS, ["agent", "task", "cwd", "action", "id", "message"]);
  assert.deepEqual(SUPERVISOR_ACTIONS, ["pending", "reply"]);
  assert.deepEqual(SUPERVISOR_PUBLIC_FIELDS, ["action", "replyTo", "message"]);
  assert.deepEqual(Object.keys(subagentParameters.properties).sort(), [...SUBAGENT_PUBLIC_FIELDS].sort());
  assert.equal(subagentParameters.additionalProperties, false);
  assert.equal(supervisorParameters.additionalProperties, false);
  assert.deepEqual(subagentParameters.properties.action.anyOf.map(({ const: action }) => action), SUBAGENT_ACTIONS);
  assert.deepEqual(supervisorParameters.properties.action.anyOf.map(({ const: action }) => action), SUPERVISOR_ACTIONS);
  assert.deepEqual(validateFreshInput({ agent: "explorer", task: " map " }), { agent: "explorer", task: "map", cwd: undefined });
  assert.throws(() => validateFreshInput({ agent: "custom", task: "x" }), /Unknown agent/);
  assert.equal(discoverPackageAgents().get("explorer").tools.includes("edit"), false);
  assert.equal(shouldApproveChildProject(true, ROOT, join(ROOT, "extensions")), true);
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

test("runtime rejects unknown fresh, action, and supervisor fields", async () => {
  const harness = createHarness();
  try {
    await harness.restore();
    await assert.rejects(
      harness.tools.get("subagent").execute("fresh", { agent: "fixer", task: "x", model: "override" }),
      /unknown field.*model/i,
    );
    await assert.rejects(
      harness.tools.get("subagent").execute("list", { action: "list", async: true }),
      /unknown field.*async/i,
    );
    await assert.rejects(
      harness.tools.get("subagent_supervisor").execute("pending", { action: "pending", thinking: "high" }),
      /unknown field.*thinking/i,
    );
  } finally { harness.cleanup(); }
});

test("registered tool prompt metadata describes the notification-driven lifecycle", () => {
  const harness = createHarness();
  try {
    const subagent = harness.tools.get("subagent");
    const supervisor = harness.tools.get("subagent_supervisor");
    assert.equal(subagent.description, "Start a package specialist asynchronously and receive a new run ID with status starting. Follow-up notifications deliver waiting requests and complete terminal results. Use list for retained runs, steer for running work, interrupt for active work, and resume for saved child sessions.");
    assert.equal(subagent.promptSnippet, "Launch a package specialist asynchronously and manage its run by ID.");
    const subagentGuidelines = subagent.promptGuidelines.join("\n");
    for (const phrase of ["run ID", "status starting", "request ID", "reason", "message", "completed", "failed", "interrupted", "stored output", "stored output and error", "list", "steer", "running run", "interrupt", "resume", "saved child session", "new run ID"]) {
      assert.match(subagentGuidelines, new RegExp(phrase, "i"));
    }
    assert.equal(subagent.promptGuidelines[0], "A fresh subagent call supplies agent, task, and optional cwd; the result contains the complete new run record with status starting.");
    assert.equal(subagent.promptGuidelines.at(-1), "subagent resume returns a new run ID; subsequent steer, interrupt, and resume actions use the new run ID.");
    assert.doesNotMatch(subagentGuidelines, /\b(can|may|later)\b|as needed|do not|cannot|implementation|protocol/i);
    assert.equal(supervisor.promptSnippet, "Inspect waiting child requests and reply by request ID.");
    const supervisorGuidelines = supervisor.promptGuidelines.join("\n");
    for (const phrase of ["pending", "request ID", "reply", "same run ID", "running", "child-session context", "follow-up notification"]) {
      assert.match(supervisorGuidelines, new RegExp(phrase, "i"));
    }
    assert.doesNotMatch(supervisorGuidelines, /\b(can|may|later)\b|as needed|do not|cannot|implementation|protocol/i);
  } finally { harness.cleanup(); }
});

test("contact_supervisor prompt metadata describes persistent reply-to-continue requests", async () => {
  const previousChild = process.env.OMPS_SUBAGENT_CHILD;
  const previousPiChild = process.env.PI_SUBAGENT_CHILD;
  process.env.OMPS_SUBAGENT_CHILD = "1";
  process.env.PI_SUBAGENT_CHILD = "1";
  try {
    let definition;
    const module = await import(`${new URL("../extensions/oh-my-pi-slim/child-supervisor.ts", import.meta.url).href}?metadata=1`);
    module.default({ registerTool(tool) { definition = tool; } });
    assert.equal(definition.promptSnippet, "Create a supervisor request and pause until reply.");
    assert.equal(definition.promptGuidelines[0], "A call includes reason; optional message adds request context; optional interview carries structured questions.");
    assert.equal(definition.parameters.required.includes("message"), false);
    const guidelines = definition.promptGuidelines.join("\n");
    for (const phrase of ["reason", "message", "interview", "request ID", "waiting", "need_decision", "interview_request", "progress_update", "same run ID", "reply"]) {
      assert.match(guidelines, new RegExp(phrase, "i"));
    }
    assert.doesNotMatch(guidelines, /\b(can|may|later)\b|as needed|do not|cannot|implementation|protocol/i);
  } finally {
    if (previousChild === undefined) delete process.env.OMPS_SUBAGENT_CHILD;
    else process.env.OMPS_SUBAGENT_CHILD = previousChild;
    if (previousPiChild === undefined) delete process.env.PI_SUBAGENT_CHILD;
    else process.env.PI_SUBAGENT_CHILD = previousPiChild;
  }
});

test("SubagentRegistry markLive emits only when liveness changes", () => {
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

test("journal restore skips run IDs that are unsafe path segments", () => {
  const restored = restoreRunJournal([
    { version: 1, runs: [persistedRun(), persistedRun({ id: "../escape" })] },
    { version: 2, run: persistedRun({ id: "also/unsafe" }) },
  ]);
  assert.deepEqual(restored.runs.map(({ id }) => id), ["run-1"]);
  assert.deepEqual(restored.activeRunIds, ["run-1"]);
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

test("fresh writes secure detached config, journals once, launches, and returns immediately", async () => {
  const harness = createHarness();
  try {
    await harness.restore();
    const result = await fresh(harness);
    const id = result.details.run.id;
    const config = readConfig(harness, id);
    assert.match(result.content[0].text, new RegExp(`${id}.*status starting`));
    assert.deepEqual(result.details, {
      run: {
        id,
        agent: "fixer",
        task: "detached task",
        cwd: ROOT,
        model: "preset/fixer:high",
        tools: discoverPackageAgents().get("fixer").tools,
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
    assert.deepEqual(config.piInvocation.command, "pi");
    assert.deepEqual(config.piInvocation.args.slice(0, 4), ["--mode", "rpc", "--model", "preset/fixer:high"]);
    assert.equal(config.piInvocation.args.includes("--session-dir"), true);
    assert.equal(config.piInvocation.args.includes("--system-prompt"), true);
    assert.equal(config.piInvocation.args.includes("--tools"), true);
    assert.equal(config.piInvocation.args.includes("--extension"), true);
    assert.equal(config.env.OMPS_PARENT_RUN_ID, id);
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

test("fresh launch waits for the just-spawned PID to exit before cleaning up when process identity is unavailable", async () => {
  const sleeps = [];
  let harness;
  harness = createHarness({
    keepAliveAfterTerm: true,
    sleep: async (ms) => {
      sleeps.push(ms);
      const [run] = harness.runtime.registry.list();
      assert.equal(existsSync(harness.paths(run.id).runDir), true, "run directory remains during termination grace");
      assert.equal(harness.alive.has(999), sleeps.length === 1, "cleanup waits until exit is confirmed");
    },
  });
  try {
    await harness.restore();
    harness.alive.add(999);
    harness.setProcessIdentity(999, undefined);
    const result = await fresh(harness);
    const run = result.details.run;
    assert.deepEqual(run, {
      id: run.id,
      agent: "fixer",
      task: "detached task",
      cwd: ROOT,
      model: "preset/fixer:high",
      tools: discoverPackageAgents().get("fixer").tools,
      status: "failed",
      createdAt: new Date(NOW_MS).toISOString(),
      updatedAt: new Date(NOW_MS).toISOString(),
      error: "Could not capture OS process identity for detached runner PID 999.",
      live: false,
    });
    assert.deepEqual(harness.killed, [
      { pid: -999, signal: "SIGTERM" },
      { pid: -999, signal: "SIGKILL" },
    ]);
    assert.deepEqual(sleeps, [1500, 1500]);
    assert.equal(existsSync(harness.paths(run.id).runDir), false);
  } finally { harness.cleanup(); }
});

test("fresh launch retains the run directory when the just-spawned PID cannot be confirmed exited", async () => {
  const sleeps = [];
  const harness = createHarness({ keepAliveAfterKill: true, sleep: async (ms) => { sleeps.push(ms); } });
  try {
    await harness.restore();
    harness.alive.add(999);
    harness.setProcessIdentity(999, undefined);
    const result = await fresh(harness);
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
    assert.equal(harness.journalWrites.length, 3, "starting, failed pending, and notification acknowledgement are journaled");
    assert.equal(harness.notifications.length, 1);
  } finally { harness.cleanup(); }
});

test("fresh launch failure returns the complete failed run", async () => {
  const harness = createHarness({ launchError: new Error("spawn failed") });
  try {
    await harness.restore();
    const result = await fresh(harness);
    const run = result.details.run;
    assert.match(result.content[0].text, new RegExp(`${run.id}.*status failed`));
    assert.deepEqual(run, {
      id: run.id,
      agent: "fixer",
      task: "detached task",
      cwd: ROOT,
      model: "preset/fixer:high",
      tools: discoverPackageAgents().get("fixer").tools,
      status: "failed",
      createdAt: new Date(NOW_MS).toISOString(),
      updatedAt: new Date(NOW_MS).toISOString(),
      error: "spawn failed",
      live: false,
    });
    assert.equal(harness.runtime.registry.isLive(run.id), false);
    assert.equal(harness.journalWrites.length, 3, "starting, failed pending, and notification acknowledgement are journaled");
    assert.equal(existsSync(harness.paths(run.id).runDir), false);
  } finally { harness.cleanup(); }
});

test("poll folds logical state but activity and heartbeat changes do not journal", async () => {
  const harness = createHarness();
  try {
    await harness.restore();
    const started = await fresh(harness);
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

test("waiting notification and supervisor reply use detached control without blocking", async () => {
  const harness = createHarness();
  try {
    await harness.restore();
    const started = await fresh(harness);
    const id = started.details.run.id;
    const config = readConfig(harness, id);
    harness.alive.add(999);
    atomicWriteJson(harness.paths(id).stateFile, stateFor(id, config.token, {
      status: "waiting",
      request: { id: "req-1", runId: id, reason: "need_decision", message: "choose", createdAt: new Date(NOW_MS).toISOString() },
    }));
    await inspect(harness, id);
    const waitingNotification = harness.notifications.at(-1).message;
    assert.equal(waitingNotification.details.status, "waiting");
    assert.equal(waitingNotification.details.reason, "need_decision");
    assert.equal(waitingNotification.content, `Subagent ${id} (fixer) is waiting.\nRequest req-1 (need_decision): choose`);
    const reply = await harness.tools.get("subagent_supervisor").execute("reply", {
      action: "reply", replyTo: "req-1", message: "option A",
    });
    assert.match(reply.content[0].text, /is running/);
    assert.deepEqual(controls(harness, id).at(-1), {
      v: 1, token: config.token, type: "reply", message: "option A", requestId: "req-1",
    });
    assert.equal(harness.runtime.registry.get(id).request, undefined);

    const notificationsAfterReply = harness.notifications.length;
    atomicWriteJson(harness.paths(id).stateFile, stateFor(id, config.token, {
      status: "waiting",
      heartbeatAt: new Date(NOW_MS + 100).toISOString(),
      turnCount: 7,
      responseText: "runner has not consumed reply yet",
      request: { id: "req-1", runId: id, reason: "need_decision", message: "choose", createdAt: new Date(NOW_MS).toISOString() },
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

test("reply grace suppression still fails a stale waiting runner whose PID dies", async () => {
  const harness = createHarness();
  try {
    await harness.restore();
    const started = await fresh(harness);
    const id = started.details.run.id;
    const config = readConfig(harness, id);
    harness.alive.add(999);
    atomicWriteJson(harness.paths(id).stateFile, stateFor(id, config.token, {
      status: "waiting",
      request: { id: "req-dead", runId: id, reason: "need_decision", message: "choose", createdAt: new Date(NOW_MS).toISOString() },
    }));
    await inspect(harness, id);
    await harness.tools.get("subagent_supervisor").execute("reply", {
      action: "reply", replyTo: "req-dead", message: "option A",
    });
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
    const started = await fresh(harness);
    const id = started.details.run.id;
    const config = readConfig(harness, id);
    harness.alive.add(999);
    atomicWriteJson(harness.paths(id).stateFile, stateFor(id, config.token, {
      status: "waiting",
      request: { id: "req-grace", runId: id, reason: "need_decision", message: "choose", createdAt: new Date(NOW_MS).toISOString() },
    }));
    await inspect(harness, id);
    await harness.tools.get("subagent_supervisor").execute("reply", {
      action: "reply", replyTo: "req-grace", message: "option A",
    });
    harness.advance(5001);
    await inspect(harness, id);
    assert.equal(harness.runtime.registry.get(id).status, "waiting");
    assert.equal(harness.runtime.registry.get(id).request.id, "req-grace");
    assert.equal(harness.notifications.filter(({ message }) => message.details.status === "waiting").length, 2);
  } finally { harness.cleanup(); }
});

test("steer and interrupt only enqueue controls and return requested", async () => {
  for (const action of ["steer", "interrupt"]) {
    const harness = createHarness();
    try {
      await harness.restore();
      const started = await fresh(harness);
      const id = started.details.run.id;
      const config = readConfig(harness, id);
      harness.alive.add(999);
      atomicWriteJson(harness.paths(id).stateFile, stateFor(id, config.token));
      await inspect(harness, id);
      const result = await harness.tools.get("subagent").execute(action, {
        action, id, ...(action === "steer" ? { message: "focus" } : {}),
      });
      assert.match(result.content[0].text, /requested/i);
      assert.equal(controls(harness, id).at(-1).type, action);
      assert.equal(harness.runtime.registry.get(id).status, "running");
    } finally { harness.cleanup(); }
  }
});

test("interrupt accepts a waiting non-terminal run", async () => {
  const harness = createHarness();
  try {
    await harness.restore();
    const started = await fresh(harness);
    const id = started.details.run.id;
    const config = readConfig(harness, id);
    harness.alive.add(999);
    atomicWriteJson(harness.paths(id).stateFile, stateFor(id, config.token, {
      status: "waiting",
      request: { id: "req-interrupt", runId: id, reason: "need_decision", message: "choose", createdAt: new Date(NOW_MS).toISOString() },
    }));
    await inspect(harness, id);
    const result = await harness.tools.get("subagent").execute("interrupt", { action: "interrupt", id });
    assert.match(result.content[0].text, /Interrupt requested/);
    assert.equal(controls(harness, id).at(-1).type, "interrupt");
  } finally { harness.cleanup(); }
});

test("terminal state journals once, stops tracking, and sends a hidden notification", async () => {
  const harness = createHarness();
  try {
    await harness.restore();
    const started = await fresh(harness);
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
    assert.equal(harness.runtime.registry.get(id).status, "completed");
    assert.equal(harness.runtime.registry.isLive(id), false);
    assert.equal(harness.journalWrites.length, 3, "terminal pending and delivery acknowledgement are journaled");
    assert.equal(existsSync(harness.paths(id).runDir), false);
    assert.deepEqual(harness.notifications[0].options, { deliverAs: "followUp", triggerTurn: true });
    assert.equal(harness.notifications[0].message.display, false);
    assert.equal(harness.notifications[0].message.details.status, "completed");
    assert.equal(
      harness.notifications[0].message.content,
      `Subagent ${id} (fixer) is completed.\n\nOutput: complete output\nsecond output line\n\nError: complete error\nsecond error line`,
    );
  } finally { harness.cleanup(); }
});

test("notification delivery is durable, replayed on restore, and keeps complete output", async () => {
  const first = createHarness({ sendMessageError: new Error("delivery failed") });
  let branch;
  const output = "complete-output-".repeat(6000);
  try {
    await first.restore();
    const started = await fresh(first);
    const id = started.details.run.id;
    const config = readConfig(first, id);
    atomicWriteJson(first.paths(id).stateFile, stateFor(id, config.token, {
      status: "completed", output, responseText: "done",
    }));
    const retained = await inspect(first, id);
    assert.equal(retained.output, output);
    assert.equal(first.runtime.registry.get(id).notificationPending, "completed");
    assert.equal(first.notifications.length, 0);
    assert.equal(existsSync(first.paths(id).runDir), false);
    branch = first.journalWrites.map(({ data }) => branchEntry(data));
  } finally { first.cleanup(); }

  const restored = createHarness({ branch });
  try {
    await restored.restore();
    assert.equal(restored.notifications.length, 1);
    assert.match(restored.notifications[0].message.content, new RegExp(`${output.slice(0, 100)}`));
    assert.equal(restored.notifications[0].message.content.endsWith(output), true);
    assert.equal(restored.runtime.registry.get(branch.at(-1).data.run.id).notificationPending, undefined);
  } finally { restored.cleanup(); }
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
    const started = await fresh(noState);
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
    assert.equal(existsSync(noState.paths(id).runDir), false);
  } finally { noState.cleanup(); }

  const stale = createHarness();
  try {
    await stale.restore();
    const started = await fresh(stale);
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
    assert.equal(existsSync(stale.paths(id).runDir), false);
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
    const started = await fresh(harness);
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
    const started = await fresh(harness);
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
    const started = await fresh(harness);
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
    const started = await fresh(harness);
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
    const started = await fresh(harness);
    const id = started.details.run.id;
    harness.runtime.health.set(id, { trackedAt: NOW_MS });
    harness.runtime.pendingReplies.set(id, { requestId: "stale", sentAt: NOW_MS });
    rmSync(harness.paths(id).runDir, { recursive: true, force: true });
    await inspect(harness, id);
    assert.equal(harness.runtime.registry.get(id).status, "interrupted");
    assert.equal(harness.runtime.health.has(id), false);
    assert.equal(harness.runtime.pendingReplies.has(id), false);
  } finally { harness.cleanup(); }
});

test("invalid launch config retains the unverifiable run directory without signaling", async () => {
  const harness = createHarness();
  const errors = [];
  const originalConsoleError = console.error;
  console.error = (...args) => { errors.push(args.join(" ")); };
  try {
    await harness.restore();
    const started = await fresh(harness);
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
      ["starting", "failed", "failed"],
      "starting, failed pending, and notification acknowledgement are journaled",
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
    const started = await fresh(harness);
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
    const started = await fresh(harness);
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
    const started = await fresh(harness);
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
    const started = await fresh(harness);
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
    const started = await fresh(harness);
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
    const started = await fresh(harness);
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
      assert.equal(next.runtime.registry.get(id).notificationPending, undefined);
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
    const started = await fresh(harness);
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
    const started = await fresh(harness);
    const id = started.details.run.id;
    const config = readConfig(harness, id);
    const sessionFile = join(harness.tempDir, "resume.jsonl");
    writeFileSync(sessionFile, "");
    harness.alive.add(999);
    atomicWriteJson(harness.paths(id).stateFile, stateFor(id, config.token, {
      status: "waiting",
      sessionFile,
      request: { id: "req-shutdown", runId: id, reason: "progress_update", message: "checkpoint", createdAt: new Date(NOW_MS).toISOString() },
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
      assert.equal(next.runtime.registry.get(id).notificationPending, undefined);
    } finally { next.cleanup(); }
  } finally { harness.cleanup(); }
});

test("restore terminates verified live orphans before cleanup and removes terminal leftovers", async () => {
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
      agent: "fixer", task: "orphan", cwd: ROOT, model: "provider/model:high",
      tools: ["read"], systemPrompt: "prompt", approve: false,
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
    assert.equal(existsSync(terminalPaths.runDir), false);
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
      agent: "fixer", task: "orphan", cwd: ROOT, model: "provider/model:high",
      tools: ["read"], systemPrompt: "prompt", approve: false,
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
        agent: run.agent, task: run.task, cwd: run.cwd, model: run.model, tools: run.tools,
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
      agent: activeRun.agent, task: activeRun.task, cwd: activeRun.cwd, model: activeRun.model, tools: activeRun.tools,
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

test("restore does not kill an identity whose token does not match launch config", async () => {
  const activeRun = persistedRun({ id: "bad-identity" });
  const harness = createHarness({ branch: [branchEntry({ version: 1, runs: [activeRun] })] });
  try {
    const paths = harness.paths(activeRun.id);
    mkdirSync(paths.controlDir, { recursive: true, mode: 0o700 });
    atomicWriteJson(paths.configFile, {
      v: 1, runId: activeRun.id, token: "config-token", ownerSessionId: harness.ownerSessionId,
      agent: activeRun.agent, task: activeRun.task, cwd: activeRun.cwd, model: activeRun.model, tools: activeRun.tools,
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
      agent: activeRun.agent, task: activeRun.task, cwd: activeRun.cwd, model: activeRun.model, tools: activeRun.tools,
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
      agent: activeRun.agent, task: activeRun.task, cwd: activeRun.cwd, model: activeRun.model, tools: activeRun.tools,
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
    const started = await fresh(harness);
    const id = started.details.run.id;
    assert.match(harness.paths(id).runDir, /owner-b/);
    assert.equal(harness.widgetCalls.length, 0);
  } finally { harness.cleanup(); }
});

test("index tree lifecycle, widget turn binding, and fixed checkpoint resume prompt stay exact", () => {
  const source = readFileSync(join(ROOT, "extensions/oh-my-pi-slim/index.ts"), "utf8");
  const resumeText = "Resume the user's latest intent. Re-read kept recent messages above the summary to confirm the latest request. If it supersedes earlier plans in the summary, follow it. If no work remains, say so briefly; do not invent work.";
  assert.match(source, /pi\.on\("session_before_tree", async[\s\S]*await subagents\.shutdown\(\)/);
  assert.match(source, /pi\.on\("session_tree", async[\s\S]*await subagents\.restore\(ctx\)[\s\S]*subagents\.setModelResolver/);
  assert.match(source, /pi\.on\("turn_start", \(\) => \{\s*subagents\.onTurnStart\(\)/);
  assert.doesNotMatch(source, /pi\.on\("tool_execution_start", \(\) => \{\s*subagents\.onTurnStart\(\)/);
  assert.equal(source.includes(`const CHECKPOINT_RESUME_TEXT = ${JSON.stringify(resumeText)};`), true);
  assert.match(source, /pi\.sendUserMessage\(CHECKPOINT_RESUME_TEXT, \{ deliverAs: "followUp" \}\)/);
  assert.doesNotMatch(source, /checkpoint\.tools|Completed tool calls at the checkpoint|Re-fetch/);
});

test("resume creates a new run ID and a complete --session invocation", async () => {
  const harness = createHarness();
  try {
    await harness.restore();
    const sessionFile = join(harness.tempDir, "source.jsonl");
    writeFileSync(sessionFile, "session");
    harness.runtime.registry.add(persistedRun({ id: "source", status: "interrupted", sessionFile }));
    const result = await harness.tools.get("subagent").execute("resume", { action: "resume", id: "source", message: "continue" });
    const id = result.details.run.id;
    const config = readConfig(harness, id);
    assert.match(result.content[0].text, new RegExp(`${id}.*status starting`));
    assert.notEqual(id, "source");
    assert.deepEqual(result.details.run, {
      id,
      agent: "fixer",
      task: "continue",
      cwd: ROOT,
      model: "provider/model:high",
      tools: ["read", "edit", "write", "contact_supervisor"],
      status: "starting",
      sourceRunId: "source",
      sessionFile,
      createdAt: new Date(NOW_MS).toISOString(),
      updatedAt: new Date(NOW_MS).toISOString(),
      live: true,
    });
    assert.equal(config.resumeSessionFile, sessionFile);
    const sessionIndex = config.piInvocation.args.indexOf("--session");
    assert.equal(config.piInvocation.args[sessionIndex + 1], sessionFile);
    assert.equal(config.runId, id);
  } finally { harness.cleanup(); }
});
