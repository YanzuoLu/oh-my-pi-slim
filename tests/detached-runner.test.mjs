import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import {
  atomicWriteJson,
  ensureRunPaths,
  getDetachedRunnerInvocation,
  getPiInvocation,
  getRunPaths,
  isDetachedRunState,
  isPidAlive,
  readControlInbox,
  safeReadJson,
  writeControl,
} from "../extensions/oh-my-pi-slim/subagent-run-files.ts";

const ROOT = resolve(import.meta.dirname, "..");
const CACHE = join(ROOT, ".cache");
const RUNNER = join(ROOT, "extensions/oh-my-pi-slim/runner/omps-runner.mjs");
const STUB = join(ROOT, "tests/fixtures/stub-pi-rpc.mjs");
const processes = new Set();
let sequence = 0;

mkdirSync(CACHE, { recursive: true });

function mode(path) {
  return statSync(path).mode & 0o777;
}

function makeRun(scenario, { start = true, extraEnv = {} } = {}) {
  const tempDir = mkdtempSync(join(CACHE, "test-detached-runner-"));
  chmodSync(tempDir, 0o700);
  const runId = `run-${++sequence}`;
  const token = `token-${sequence}`;
  const paths = getRunPaths(join(tempDir, "runs"), "owner-session", runId);
  ensureRunPaths(paths);
  const config = {
    v: 1,
    runId,
    token,
    ownerSessionId: "owner-session",
    agent: "fixer",
    task: `task-${scenario}`,
    cwd: ROOT,
    model: "stub/model:high",
    tools: ["read", "contact_supervisor"],
    systemPrompt: "stub system prompt",
    approve: false,
    childSessionDir: join(tempDir, "child-sessions"),
    piInvocation: { command: process.execPath, args: [STUB, "--mode", "rpc"] },
    env: { OMPS_STUB_SCENARIO: scenario, OMPS_RUN_ID: runId, ...extraEnv },
    createdAt: new Date().toISOString(),
  };
  atomicWriteJson(paths.configFile, config);
  let child;
  let stdout = "";
  let stderr = "";
  if (start) {
    child = spawn(process.execPath, [RUNNER, paths.configFile], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    processes.add(child);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("exit", () => processes.delete(child));
  }
  return { tempDir, paths, config, child, output: () => ({ stdout, stderr }) };
}

function readState(run) {
  return safeReadJson(run.paths.stateFile, isDetachedRunState);
}

async function waitFor(predicate, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const value = predicate();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function waitForStatus(run, status, timeoutMs) {
  return waitFor(() => {
    const state = readState(run);
    return state?.status === status ? state : undefined;
  }, timeoutMs);
}

async function waitForExit(run, timeoutMs = 3000) {
  if (!run.child) throw new Error("runner was launched by an external owner process");
  if (run.child.exitCode !== null) return run.child.exitCode;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanupListeners();
      reject(new Error(`runner did not exit: ${JSON.stringify(run.output())}`));
    }, timeoutMs);
    const onExit = (code) => {
      cleanupListeners();
      resolve(code);
    };
    const cleanupListeners = () => {
      clearTimeout(timer);
      run.child.off("exit", onExit);
    };
    run.child.once("exit", onExit);
  });
}

function sendControl(run, control) {
  const name = `${Date.now()}-${String(++sequence).padStart(5, "0")}.json`;
  atomicWriteJson(join(run.paths.controlDir, name), { v: 1, ...control });
}

async function cleanup(run) {
  if (run.child?.exitCode === null) {
    run.child.kill("SIGTERM");
    await waitForExit(run).catch(() => run.child.kill("SIGKILL"));
  } else if (!run.child) {
    const state = readState(run);
    if (state && isPidAlive(state.pid)) {
      try { process.kill(state.pid, "SIGTERM"); } catch { /* already exited */ }
    }
  }
  rmSync(run.tempDir, { recursive: true, force: true });
}

test.after(() => {
  for (const child of processes) {
    if (child.exitCode === null) child.kill("SIGKILL");
  }
});

test("invocation helpers cover script, standalone, generic fallback, and runner interpreter selection", () => {
  assert.deepEqual(getPiInvocation(["--mode", "rpc"], {
    argv: ["runtime", "/real/pi.js"],
    execPath: "/usr/bin/node",
    exists: (path) => path === "/real/pi.js",
  }), { command: "/usr/bin/node", args: ["/real/pi.js", "--mode", "rpc"] });

  assert.deepEqual(getPiInvocation(["--mode", "rpc"], {
    argv: ["pi", "/$bunfs/root/pi.js"],
    execPath: "/Applications/Pi/pi",
    exists: () => true,
  }), { command: "/Applications/Pi/pi", args: ["--mode", "rpc"] });

  assert.deepEqual(getPiInvocation(["--mode", "rpc"], {
    argv: ["node", "/missing/pi.js"],
    execPath: "/usr/bin/node",
    exists: () => false,
  }), { command: "pi", args: ["--mode", "rpc"] });

  assert.deepEqual(getDetachedRunnerInvocation("/package/runner.mjs", {
    execPath: "/usr/local/bin/bun",
  }), { command: "/usr/local/bin/bun", args: ["/package/runner.mjs"] });

  assert.deepEqual(getDetachedRunnerInvocation("/package/runner.mjs", {
    execPath: "/Applications/Pi/pi",
    probeRuntime: (command) => command === "node",
  }), { command: "node", args: ["/package/runner.mjs"] });

  assert.deepEqual(getDetachedRunnerInvocation("/package/runner.mjs", {
    execPath: "/Applications/Pi/pi",
    probeRuntime: (command) => command === "bun",
  }), { command: "bun", args: ["/package/runner.mjs"] });

  assert.throws(() => getDetachedRunnerInvocation("/package/runner.mjs", {
    execPath: "/Applications/Pi/pi",
    probeRuntime: () => false,
  }), /requires Node\.js or Bun on PATH/);
});

test("control filenames preserve write order within one process and millisecond", () => {
  const tempDir = mkdtempSync(join(CACHE, "test-control-order-"));
  const paths = getRunPaths(join(tempDir, "runs"), "owner-session", "control-order");
  ensureRunPaths(paths);
  const originalNow = Date.now;
  Date.now = () => 1776384000000;
  try {
    writeControl(paths, "token", "reply", "first", "request-1");
    writeControl(paths, "token", "steer", "second");
    writeControl(paths, "token", "interrupt");
    assert.deepEqual(readControlInbox(paths.controlDir).map(({ type, message }) => [type, message]), [
      ["reply", "first"],
      ["steer", "second"],
      ["interrupt", undefined],
    ]);
  } finally {
    Date.now = originalNow;
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("detached launcher survives its short-lived owner process", async () => {
  const run = makeRun("normal", { start: false });
  try {
    const helperUrl = pathToFileURL(join(ROOT, "extensions/oh-my-pi-slim/subagent-run-files.ts")).href;
    const launcher = spawnSync(process.execPath, ["--input-type=module", "--eval", [
      `import { launchDetachedRunner } from ${JSON.stringify(helperUrl)};`,
      `const launched = await launchDetachedRunner(${JSON.stringify(run.paths.configFile)}, ${JSON.stringify(RUNNER)}, { cwd: ${JSON.stringify(ROOT)} });`,
      "process.stdout.write(String(launched.pid));",
    ].join("\n")], { cwd: ROOT, encoding: "utf8", timeout: 5000 });
    assert.equal(launcher.status, 0, launcher.stderr);
    const runnerPid = Number(launcher.stdout);
    assert.equal(Number.isInteger(runnerPid) && runnerPid > 0, true);
    const completed = await waitForStatus(run, "completed");
    assert.equal(completed.pid, runnerPid);
    assert.equal(completed.output, "normal completion");
    await waitFor(() => !isPidAlive(runnerPid), 3000);
    assert.match(readFileSync(run.paths.logFile, "utf8"), /^$/);
    assert.equal(mode(run.paths.logFile), 0o600);
  } finally {
    await cleanup(run);
  }
});

test("real runner atomically persists secure config/state and completed output with activity", async () => {
  const run = makeRun("normal");
  try {
    assert.equal(mode(run.paths.runRoot), 0o700);
    assert.equal(mode(run.paths.ownerDir), 0o700);
    assert.equal(mode(run.paths.runDir), 0o700);
    assert.equal(mode(run.paths.controlDir), 0o700);
    assert.equal(mode(run.paths.configFile), 0o600);

    const state = await waitForStatus(run, "completed");
    assert.equal(mode(run.paths.stateFile), 0o600);
    assert.equal(state.output, "normal completion");
    assert.equal(state.responseText, "normal completion");
    assert.match(state.sessionFile, /stub-normal-session\.jsonl$/);
    assert.equal(state.turnCount, 1);
    assert.equal(state.toolUses, 1);
    assert.deepEqual(state.activeTools, {});
    assert.equal(state.tokens, 42);
    assert.equal(state.contextPercent, 25);
    assert.equal(state.compactionCount, 1);
    assert.equal(typeof state.heartbeatAt, "string");
    assert.equal(state.token, run.config.token);
    assert.equal(await waitForExit(run), 0);
  } finally {
    await cleanup(run);
  }
});

test("long streaming activity stays bounded while terminal output remains complete", async () => {
  const run = makeRun("long-stream");
  const expected = "0123456789abcdef".repeat(4096);
  try {
    const streaming = await waitFor(() => {
      const state = readState(run);
      return state?.status === "running" && state.responseText.length > 0 ? state : undefined;
    });
    assert.equal(Buffer.byteLength(streaming.responseText, "utf8") <= 2 * 1024, true);
    assert.equal(statSync(run.paths.stateFile).size < 8 * 1024, true);

    const completed = await waitForStatus(run, "completed");
    assert.equal(completed.output, expected);
    assert.equal(Buffer.byteLength(completed.responseText, "utf8") <= 2 * 1024, true);
    assert.equal(await waitForExit(run), 0);
  } finally {
    await cleanup(run);
  }
});

test("waiting request persists, wrong-token controls are ignored, and matching reply continues", async () => {
  const run = makeRun("contact");
  try {
    const waiting = await waitForStatus(run, "waiting");
    assert.equal(waiting.request.id, "request-1");
    assert.equal(waiting.request.message, "choose a path");
    const waitingUpdatedAt = waiting.updatedAt;

    sendControl(run, { token: "wrong-token", type: "reply", requestId: "request-1", message: "bad" });
    await new Promise((resolve) => setTimeout(resolve, 500));
    const stillWaiting = readState(run);
    assert.equal(stillWaiting.status, "waiting");
    assert.equal(stillWaiting.request.id, "request-1");
    assert.equal(stillWaiting.updatedAt, waitingUpdatedAt);

    sendControl(run, { token: run.config.token, type: "reply", requestId: "request-1", message: "continue" });
    const completed = await waitForStatus(run, "completed");
    assert.equal(completed.output, "completed after reply");
    assert.equal(completed.request, undefined);
    assert.equal(await waitForExit(run), 0);
  } finally {
    await cleanup(run);
  }
});

test("reply prompt crash publishes failed instead of crashing without terminal state", async () => {
  const run = makeRun("contact-reply-crash");
  try {
    const waiting = await waitForStatus(run, "waiting");
    sendControl(run, { token: run.config.token, type: "reply", requestId: waiting.request.id, message: "continue" });
    const failed = await waitForStatus(run, "failed", 2500);
    assert.match(failed.error, /code=23/);
    assert.match(failed.error, /reply crash/);
    assert.equal(await waitForExit(run), 1);
  } finally {
    await cleanup(run);
  }
});

test("hanging reply prompt does not block a later interrupt control", async () => {
  const run = makeRun("contact-reply-hang");
  try {
    const waiting = await waitForStatus(run, "waiting");
    sendControl(run, { token: run.config.token, type: "reply", requestId: waiting.request.id, message: "continue" });
    await waitForStatus(run, "running");
    sendControl(run, { token: run.config.token, type: "interrupt" });
    const interrupted = await waitForStatus(run, "interrupted", 2500);
    assert.match(interrupted.error, /Interrupted/);
    assert.equal(await waitForExit(run), 0);
  } finally {
    await cleanup(run);
  }
});

test("interrupting a waiting run clears its persisted request", async () => {
  const run = makeRun("contact");
  try {
    const waiting = await waitForStatus(run, "waiting");
    assert.equal(waiting.request.id, "request-1");
    sendControl(run, { token: run.config.token, type: "interrupt" });
    const interrupted = await waitForStatus(run, "interrupted");
    assert.equal(interrupted.request, undefined);
    assert.equal(await waitForExit(run), 0);
  } finally {
    await cleanup(run);
  }
});

test("heartbeat advances without changing logical updatedAt and steer is fire-and-forget", async () => {
  const run = makeRun("steer");
  try {
    const running = await waitForStatus(run, "running");
    const initialHeartbeat = running.heartbeatAt;
    const initialUpdatedAt = running.updatedAt;
    await new Promise((resolve) => setTimeout(resolve, 1600));
    await waitFor(() => {
      const state = readState(run);
      return state?.status === "running" && state.heartbeatAt !== initialHeartbeat ? state : undefined;
    }, 1500);
    const heartbeating = readState(run);
    assert.equal(heartbeating.updatedAt, initialUpdatedAt);

    sendControl(run, { token: run.config.token, type: "steer", message: "new direction" });
    const completed = await waitForStatus(run, "completed");
    assert.equal(completed.output, "steered: new direction");
    assert.equal(await waitForExit(run), 0);
  } finally {
    await cleanup(run);
  }
});

test("interrupt control aborts the RPC child and persists interrupted", async () => {
  const run = makeRun("hang");
  try {
    await waitForStatus(run, "running");
    sendControl(run, { token: run.config.token, type: "interrupt" });
    const terminal = await waitForStatus(run, "interrupted");
    assert.match(terminal.error, /Interrupted/);
    assert.deepEqual(terminal.activeTools, {});
    assert.equal(await waitForExit(run), 0);
  } finally {
    await cleanup(run);
  }
});

test("SIGTERM is handled as an interrupted terminal transition and stops the RPC child", async () => {
  const tempDir = mkdtempSync(join(CACHE, "test-runner-sigterm-"));
  const pidFile = join(tempDir, "child.pid");
  const run = makeRun("hang", { extraEnv: { OMPS_STUB_PID_FILE: pidFile } });
  try {
    await waitForStatus(run, "running");
    const childPid = await waitFor(() => {
      try { return Number(readFileSync(pidFile, "utf8")); } catch { return undefined; }
    });
    run.child.kill("SIGTERM");
    const interrupted = await waitForStatus(run, "interrupted", 2500);
    assert.match(interrupted.error, /SIGTERM/);
    assert.equal(await waitForExit(run), 0);
    assert.equal(isPidAlive(childPid), false);
  } finally {
    await cleanup(run);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("RPC child crash fails the detached run quickly with stderr context", async () => {
  const run = makeRun("crash");
  try {
    const startedAt = Date.now();
    const failed = await waitForStatus(run, "failed", 2000);
    assert.equal(Date.now() - startedAt < 2000, true);
    assert.match(failed.error, /code=17/);
    assert.match(failed.error, /stub crash/);
    assert.equal(await waitForExit(run), 1);
  } finally {
    await cleanup(run);
  }
});

test("terminal state is published only after the RPC child has exited", async () => {
  const tempDir = mkdtempSync(join(CACHE, "test-terminal-order-"));
  const pidFile = join(tempDir, "child.pid");
  const exitFile = join(tempDir, "child.exited");
  const run = makeRun("terminal-order", {
    extraEnv: { OMPS_STUB_PID_FILE: pidFile, OMPS_STUB_EXIT_FILE: exitFile },
  });
  try {
    const state = await waitForStatus(run, "completed");
    const childPid = Number(readFileSync(pidFile, "utf8"));
    assert.equal(state.output, "terminal-order completion");
    assert.equal(readFileSync(exitFile, "utf8"), "exited");
    assert.equal(isPidAlive(childPid), false);
    assert.equal(await waitForExit(run), 0);
  } finally {
    await cleanup(run);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("safe state reads reject malformed or partially-written JSON", () => {
  const tempDir = mkdtempSync(join(CACHE, "test-detached-read-"));
  try {
    const path = join(tempDir, "state.json");
    atomicWriteJson(path, { nope: true });
    assert.equal(safeReadJson(path, isDetachedRunState), undefined);
    assert.doesNotThrow(() => readFileSync(path, "utf8"));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
