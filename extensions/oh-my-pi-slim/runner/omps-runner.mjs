#!/usr/bin/env node

import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  watch,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { RpcChild } from "./rpc-child.mjs";

const HEARTBEAT_MS = 1500;
const CONTROL_POLL_MS = 300;
const STARTUP_TIMEOUT_MS = 9000;
const REPLY_PROMPT_TIMEOUT_MS = 10_000;
const ACTIVITY_FLUSH_MS = 100;
const RESPONSE_TEXT_MAX_BYTES = 2 * 1024;
const TERMINAL = new Set(["completed", "failed", "interrupted"]);
const configPath = process.argv[2];

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonEmpty(value) {
  return typeof value === "string" && value.length > 0;
}

function validConfig(value) {
  return isRecord(value) && value.v === 1 &&
    nonEmpty(value.runId) && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.runId) &&
    nonEmpty(value.token) && nonEmpty(value.ownerSessionId) && nonEmpty(value.agent) &&
    nonEmpty(value.task) && nonEmpty(value.cwd) && nonEmpty(value.model) &&
    Array.isArray(value.deniedTools) && value.deniedTools.every(nonEmpty) &&
    typeof value.systemPrompt === "string" &&
    typeof value.approve === "boolean" && nonEmpty(value.childSessionDir) &&
    (value.resumeSessionFile === undefined || nonEmpty(value.resumeSessionFile)) &&
    isRecord(value.piInvocation) && nonEmpty(value.piInvocation.command) &&
    Array.isArray(value.piInvocation.args) && value.piInvocation.args.every((arg) => typeof arg === "string") &&
    isRecord(value.env) && Object.values(value.env).every((entry) => typeof entry === "string") &&
    nonEmpty(value.createdAt);
}

function atomicWriteJson(filePath, value) {
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(filePath), `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  const descriptor = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  } finally {
    closeSync(descriptor);
  }
  try {
    renameSync(temporary, filePath);
    chmodSync(filePath, 0o600);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* already renamed or removed */ }
    throw error;
  }
}

function readJson(filePath) {
  try { return JSON.parse(readFileSync(filePath, "utf8")); } catch { return undefined; }
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

function assistantText(message) {
  if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) return "";
  return message.content
    .filter((part) => isRecord(part) && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function boundedResponseText(text) {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= RESPONSE_TEXT_MAX_BYTES) return text;
  return bytes.subarray(bytes.length - RESPONSE_TEXT_MAX_BYTES).toString("utf8").replace(/^\uFFFD+/, "");
}

async function withTimeout(promise, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs} ms.`)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

if (!configPath) {
  process.stderr.write("Usage: omps-runner.mjs <launch-config-path>\n");
  process.exit(2);
}

const config = readJson(configPath);
if (!validConfig(config)) {
  process.stderr.write("Invalid detached subagent launch config.\n");
  process.exit(2);
}

const runDir = dirname(configPath);
const stateFile = join(runDir, "state.json");
const controlDir = join(runDir, "control");
mkdirSync(controlDir, { recursive: true, mode: 0o700 });
chmodSync(controlDir, 0o700);

const now = () => new Date().toISOString();
let state = {
  v: 1,
  token: config.token,
  runId: config.runId,
  pid: process.pid,
  heartbeatAt: now(),
  status: "starting",
  updatedAt: now(),
  turnCount: 0,
  toolUses: 0,
  activeTools: {},
  responseText: "",
  tokens: 0,
  compactionCount: 0,
};
let ending = false;
let processingControls = false;
let lastStopReason;
let lastError;
let heartbeatTimer;
let controlTimer;
let activityFlushTimer;
let controlWatcher;
let client;
let lastAssistantOutput = "";
let tokenResetPending = false;

function writeState() {
  atomicWriteJson(stateFile, state);
}

function clearActivityFlush() {
  if (!activityFlushTimer) return;
  clearTimeout(activityFlushTimer);
  activityFlushTimer = undefined;
}

function flushActivity() {
  activityFlushTimer = undefined;
  if (ending) return;
  state = { ...state, heartbeatAt: now() };
  writeState();
}

function patchActivity(patch, { defer = false } = {}) {
  if (ending) return;
  state = { ...state, ...patch };
  if (defer) {
    if (!activityFlushTimer) {
      activityFlushTimer = setTimeout(flushActivity, ACTIVITY_FLUSH_MS);
      activityFlushTimer.unref?.();
    }
    return;
  }
  clearActivityFlush();
  state = { ...state, heartbeatAt: now() };
  writeState();
}

function transition(status, patch = {}) {
  clearActivityFlush();
  const timestamp = now();
  state = { ...state, ...patch, status, heartbeatAt: timestamp, updatedAt: timestamp };
  writeState();
}

function updateContextTokens(candidate) {
  if (typeof candidate !== "number" || !Number.isFinite(candidate) || candidate <= 0) return false;
  if (tokenResetPending) {
    state.tokens = candidate;
    tokenResetPending = false;
    return true;
  }
  const current = typeof state.tokens === "number" && Number.isFinite(state.tokens) && state.tokens > 0
    ? state.tokens
    : 0;
  const next = Math.max(current, candidate);
  if (next === state.tokens) return false;
  state.tokens = next;
  return true;
}

function updateStats(stats) {
  if (!isRecord(stats)) return;
  const usage = stats.contextUsage;
  if (isRecord(usage)) {
    updateContextTokens(usage.tokens);
    if (typeof usage.percent === "number" && Number.isFinite(usage.percent)) state.contextPercent = usage.percent;
    else if (
      typeof usage.tokens === "number" && Number.isFinite(usage.tokens) && usage.tokens > 0 &&
      typeof usage.contextWindow === "number" && Number.isFinite(usage.contextWindow) && usage.contextWindow > 0
    ) {
      state.contextPercent = (usage.tokens / usage.contextWindow) * 100;
    }
  }
  if (typeof stats.sessionFile === "string") state.sessionFile = stats.sessionFile;
}

async function collectFinalMetadata() {
  try {
    const [lastText, childState, stats] = await Promise.all([
      withTimeout(client.getLastAssistantText(), STARTUP_TIMEOUT_MS, "get_last_assistant_text"),
      withTimeout(client.getState(), STARTUP_TIMEOUT_MS, "get_state"),
      withTimeout(client.getSessionStats(), STARTUP_TIMEOUT_MS, "get_session_stats"),
    ]);
    if (typeof lastText === "string" && lastText.trim()) {
      lastAssistantOutput = lastText.trim();
      state.responseText = boundedResponseText(lastAssistantOutput);
    }
    if (isRecord(childState) && typeof childState.sessionFile === "string") state.sessionFile = childState.sessionFile;
    updateStats(stats);
  } catch {
    // Event-derived output and the last known session path remain authoritative fallbacks.
  }
}

async function publishTerminal(status, patch = {}, { collect = false } = {}) {
  if (collect) await collectFinalMetadata();
  const terminalPatch = {
    ...patch,
    request: undefined,
    activeTools: {},
    ...(state.sessionFile ? { sessionFile: state.sessionFile } : {}),
  };
  if (status === "completed") terminalPatch.output = lastAssistantOutput || state.responseText;
  clearInterval(heartbeatTimer);
  clearInterval(controlTimer);
  clearActivityFlush();
  controlWatcher?.close();
  await client?.stop().catch(() => undefined);
  transition(status, terminalPatch);
  process.exitCode = status === "failed" ? 1 : 0;
}

async function finish(status, patch = {}, options = {}) {
  if (ending || TERMINAL.has(state.status)) return;
  ending = true;
  await publishTerminal(status, patch, options);
}

async function settleRun() {
  if (ending || state.status === "waiting") return;
  await collectFinalMetadata();
  const failed = lastStopReason === "error" || lastStopReason === "aborted";
  await finish(failed ? "failed" : "completed", failed ? {
    error: lastError || client.getStderr() || "Child run failed.",
  } : {});
}

function handleEvent(event) {
  if (ending || !isRecord(event)) return;
  if (event.type === "turn_start") {
    patchActivity({ turnCount: state.turnCount + 1 });
    return;
  }
  if (event.type === "message_update") {
    const update = event.assistantMessageEvent;
    const patch = {};
    if (isRecord(update) && update.type === "text_delta" && typeof update.delta === "string") {
      patch.responseText = boundedResponseText(state.responseText + update.delta);
    }
    if (isRecord(event.usage) && updateContextTokens(event.usage.totalTokens)) {
      patch.tokens = state.tokens;
    }
    if (Object.keys(patch).length > 0) patchActivity(patch, { defer: true });
    return;
  }
  if (event.type === "message_end") {
    const text = assistantText(event.message);
    if (text) {
      lastAssistantOutput = text;
      state.responseText = boundedResponseText(text);
    }
    if (isRecord(event.message) && event.message.role === "assistant") {
      if (typeof event.message.stopReason === "string") lastStopReason = event.message.stopReason;
      if (typeof event.message.errorMessage === "string") lastError = event.message.errorMessage;
      if (isRecord(event.message.usage)) updateContextTokens(event.message.usage.totalTokens);
    }
    patchActivity({
      responseText: state.responseText,
      ...(state.tokens > 0 ? { tokens: state.tokens } : {}),
    });
    return;
  }
  if (event.type === "tool_execution_start") {
    const id = typeof event.toolCallId === "string" ? event.toolCallId : randomUUID();
    const name = typeof event.toolName === "string" ? event.toolName : "tool";
    patchActivity({
      toolUses: state.toolUses + 1,
      activeTools: { ...state.activeTools, [id]: { name, startedAt: now() } },
    });
    return;
  }
  if (event.type === "tool_execution_end") {
    const activeTools = { ...state.activeTools };
    if (typeof event.toolCallId === "string") delete activeTools[event.toolCallId];
    if (event.toolName === "contact_supervisor") {
      const request = event.result?.details?.request;
      if (isRecord(request) && request.runId === config.runId && nonEmpty(request.id)) {
        transition("waiting", { activeTools, request });
        return;
      }
    }
    patchActivity({ activeTools });
    return;
  }
  if (event.type === "compaction_end") {
    if (event.aborted === false && isRecord(event.result)) {
      tokenResetPending = true;
      patchActivity({ compactionCount: state.compactionCount + 1, contextPercent: undefined });
    }
    return;
  }
  if (event.type === "agent_settled") void settleRun();
}

function validControl(value) {
  return isRecord(value) && value.v === 1 && nonEmpty(value.token) &&
    ["interrupt", "steer", "reply"].includes(value.type) &&
    (value.message === undefined || typeof value.message === "string") &&
    (value.requestId === undefined || typeof value.requestId === "string");
}

async function applyControl(control) {
  if (ending || control.token !== config.token) return;
  if (control.type === "steer") {
    if (state.status === "running" && nonEmpty(control.message)) void client.steer(control.message).catch(() => undefined);
    return;
  }
  if (control.type === "reply") {
    if (
      state.status === "waiting" && nonEmpty(control.message) && nonEmpty(control.requestId) &&
      isRecord(state.request) && state.request.id === control.requestId
    ) {
      transition("running", { request: undefined });
      void withTimeout(
        client.prompt(`Supervisor reply to request ${control.requestId}:\n\n${control.message}`),
        REPLY_PROMPT_TIMEOUT_MS,
        "supervisor reply prompt",
      ).catch((error) => finish("failed", { error: errorText(error) }));
    }
    return;
  }
  if (control.type === "interrupt") {
    ending = true;
    await withTimeout(client.abort(), 750, "abort").catch(() => undefined);
    await publishTerminal("interrupted", { error: "Interrupted by supervisor." });
  }
}

async function processControls() {
  if (processingControls || ending) return;
  processingControls = true;
  try {
    let names;
    try { names = readdirSync(controlDir).sort(); } catch { return; }
    for (const name of names) {
      const path = join(controlDir, name);
      let control;
      try {
        if (!statSync(path).isFile()) continue;
        const value = readJson(path);
        if (validControl(value)) control = value;
      } catch {
        // Invalid inbox entries are discarded below.
      } finally {
        try { unlinkSync(path); } catch { /* already removed */ }
      }
      if (control) await applyControl(control);
      if (ending) break;
    }
  } finally {
    processingControls = false;
  }
}

for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(signal, () => {
    void finish("interrupted", { error: `Runner received ${signal}.` });
  });
}

writeState();
heartbeatTimer = setInterval(() => {
  if (ending || TERMINAL.has(state.status)) return;
  clearActivityFlush();
  state = { ...state, heartbeatAt: now() };
  writeState();
}, HEARTBEAT_MS);
heartbeatTimer.unref?.();
controlTimer = setInterval(() => void processControls(), CONTROL_POLL_MS);
controlTimer.unref?.();
try {
  controlWatcher = watch(controlDir, () => void processControls());
  controlWatcher.on("error", () => undefined);
} catch {
  // The polling fallback remains active.
}

try {
  if (ending) throw new Error("Runner is ending.");
  client = new RpcChild({
    command: config.piInvocation.command,
    args: config.piInvocation.args,
    cwd: config.cwd,
    env: config.env,
  });
  client.onEvent(handleEvent);
  client.onExit((error) => {
    if (!ending && !TERMINAL.has(state.status)) void finish("failed", { error: errorText(error) });
  });
  await client.start();
  const childState = await withTimeout(client.getState(), STARTUP_TIMEOUT_MS, "RPC child startup probe");
  transition("running", {
    sessionFile: isRecord(childState) && typeof childState.sessionFile === "string" ? childState.sessionFile : undefined,
  });
  await client.prompt(config.task);
  await processControls();
} catch (error) {
  await finish("failed", { error: errorText(error) });
}
