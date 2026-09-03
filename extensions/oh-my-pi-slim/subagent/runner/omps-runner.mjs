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
const STEER_IDLE_QUEUE_GRACE_MS = 250;
const ACTIVITY_FLUSH_MS = 100;
const RESPONSE_TEXT_MAX_BYTES = 2 * 1024;
const TERMINAL = new Set(["completed", "failed", "interrupted"]);
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
/** Child compaction refusals that mean the reused session already needs no migration compaction. */
const BENIGN_MIGRATION_COMPACTION_ERRORS = new Set(["Nothing to compact (session too small)", "Already compacted"]);
/** Turn-level events that belong to real work, so a migration compaction never fakes completion or activity. */
const PREFLIGHT_IGNORED_EVENT_TYPES = new Set(["agent_settled", "turn_start", "message_update", "message_end"]);
const MIGRATION_COMPACTION_ERROR_PREFIX = "Model migration compaction failed: ";
const configPath = process.argv[2];

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonEmpty(value) {
  return typeof value === "string" && value.length > 0;
}

function nonBlank(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function supervisorMessage(type, message) {
  return `<supervisor_message type="${type}">\n${message}\n</supervisor_message>`;
}

// Execution-boundary mirror; keep this exactly aligned with core.ts legacyRunAbstract().
function legacyAbstract(task) {
  return `${Array.from(task).slice(0, 100).join("")}...`;
}

// Execution-boundary mirror; keep this exactly aligned with model-display.ts parseModelSpec().
function modelSpecBase(spec) {
  const value = String(spec).trim();
  let provider;
  let model = value;
  const slash = value.indexOf("/");
  if (slash > 0 && slash < value.length - 1) {
    const candidateProvider = value.slice(0, slash);
    const candidateModel = value.slice(slash + 1);
    if (candidateProvider.trim() && candidateModel.trim()) {
      provider = candidateProvider;
      model = candidateModel;
    }
  }
  const colon = model.lastIndexOf(":");
  if (colon > 0 && THINKING_LEVELS.has(model.slice(colon + 1)) && model.slice(0, colon).trim()) {
    model = model.slice(0, colon);
  }
  return provider ? `${provider}/${model}` : model;
}

function sameModelSpecBase(left, right) {
  return modelSpecBase(left) === modelSpecBase(right);
}

function normalizeConfig(value) {
  if (!(isRecord(value) && value.v === 1 &&
    nonEmpty(value.runId) && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.runId) &&
    nonEmpty(value.token) && nonEmpty(value.ownerSessionId) &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.ownerSessionId) &&
    nonEmpty(value.task) && nonEmpty(value.cwd) && nonEmpty(value.model) &&
    typeof value.approve === "boolean" && nonEmpty(value.childSessionDir) &&
    (value.resumeSessionFile === undefined || nonEmpty(value.resumeSessionFile)) &&
    (value.resumeCompactFrom === undefined || nonEmpty(value.resumeCompactFrom)) &&
    (value.steerResponseTimeoutMs === undefined ||
      (Number.isInteger(value.steerResponseTimeoutMs) && value.steerResponseTimeoutMs > 0)) &&
    isRecord(value.piInvocation) && nonEmpty(value.piInvocation.command) &&
    Array.isArray(value.piInvocation.args) && value.piInvocation.args.every((arg) => typeof arg === "string") &&
    isRecord(value.env) && Object.values(value.env).every((entry) => typeof entry === "string") &&
    nonEmpty(value.createdAt))) return undefined;
  const abstract = value.abstract === undefined
    ? legacyAbstract(value.task)
    : nonBlank(value.abstract) ? value.abstract.trim() : undefined;
  return abstract ? { ...value, abstract } : undefined;
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

const config = normalizeConfig(readJson(configPath));
if (!config) {
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
  providerTokens: 0,
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
/** True only while the pre-prompt model-migration compaction owns the child. */
let preflighting = false;
let lastAssistantOutput = "";
let tokenResetPending = false;
let providerTokenBaseline = 0;
/** A contact request remains valid across non-steer retry and compaction turns. */
let pendingRequest;
/** Accepted steer controls are submitted serially and consumed one generation per steer turn. */
let steerGeneration = 0;
let consumedSteerGeneration = 0;
let activeTurnGeneration = 0;
let initialTurnPending = true;
const steerRecords = [];
let steerSubmissionTail = Promise.resolve();
let latestSettlement;

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

function providerUsageTokens(usage) {
  if (!isRecord(usage)) return 0;
  return ["input", "output", "cacheRead", "cacheWrite"]
    .map((field) => typeof usage[field] === "number" && Number.isFinite(usage[field]) && usage[field] > 0 ? usage[field] : 0)
    .reduce((sum, amount) => sum + amount, 0);
}

function updateStats(stats) {
  if (!isRecord(stats)) return;
  if (isRecord(stats.tokens) && typeof stats.tokens.total === "number" && Number.isFinite(stats.tokens.total) && stats.tokens.total >= 0) {
    state.providerTokens = Math.max(state.providerTokens, stats.tokens.total - providerTokenBaseline);
  }
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

async function readFinalMetadata() {
  try {
    const [lastText, childState, stats] = await Promise.all([
      withTimeout(client.getLastAssistantText(), STARTUP_TIMEOUT_MS, "get_last_assistant_text"),
      withTimeout(client.getState(), STARTUP_TIMEOUT_MS, "get_state"),
      withTimeout(client.getSessionStats(), STARTUP_TIMEOUT_MS, "get_session_stats"),
    ]);
    return { lastText, childState, stats };
  } catch {
    // Event-derived output and the last known session path remain authoritative fallbacks.
    return undefined;
  }
}

function applyFinalMetadata(metadata) {
  if (!metadata) return;
  if (typeof metadata.lastText === "string" && metadata.lastText.trim()) {
    lastAssistantOutput = metadata.lastText.trim();
    state.responseText = boundedResponseText(lastAssistantOutput);
  }
  if (isRecord(metadata.childState) && typeof metadata.childState.sessionFile === "string") {
    state.sessionFile = metadata.childState.sessionFile;
  }
  updateStats(metadata.stats);
}

async function collectFinalMetadata() {
  applyFinalMetadata(await readFinalMetadata());
}

function clearSteerBarriers() {
  pendingRequest = undefined;
  latestSettlement = undefined;
}

async function publishTerminal(status, patch = {}, { collect = false } = {}) {
  if (collect) await collectFinalMetadata();
  clearSteerBarriers();
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

function settlementIsCurrent(settlement) {
  return !ending && state.status !== "waiting" && latestSettlement === settlement;
}

function steerSubmissionBlockers() {
  return steerRecords.filter((record) => ["queued", "submitting"].includes(record.status));
}

function childIsBusy(childState) {
  return isRecord(childState) && (childState.isStreaming === true || childState.isCompacting === true);
}

function childPendingMessages(childState) {
  return isRecord(childState) && Number.isInteger(childState.pendingMessageCount) && childState.pendingMessageCount > 0
    ? childState.pendingMessageCount
    : 0;
}

function waitForIdleQueueGrace() {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, STEER_IDLE_QUEUE_GRACE_MS);
    timer.unref?.();
  });
}

function reportDroppedSteers(settlement, pendingMessageCount) {
  const dropped = steerRecords.filter((record) => (
    !record.consumed && !record.reported && record.generation > settlement.generation &&
    ["acknowledged", "unconfirmed"].includes(record.status)
  ));
  for (const record of dropped) {
    record.reported = true;
    console.error(`Steer dropped without a child turn for generation ${record.generation}.`);
  }
  if (pendingMessageCount > 0) {
    console.error(`Child became idle with ${pendingMessageCount} queued message(s); late steer was dropped.`);
  }
}

async function settleRun(settlement) {
  if (!settlementIsCurrent(settlement) || settlement.collecting) return;
  if (steerSubmissionBlockers().length > 0) return;

  settlement.collecting = true;
  let metadata = await readFinalMetadata();
  if (!settlementIsCurrent(settlement)) {
    settlement.collecting = false;
    return;
  }
  if (!metadata && !client.isAlive()) {
    settlement.collecting = false;
    latestSettlement = undefined;
    return;
  }
  if (childIsBusy(metadata?.childState)) {
    settlement.collecting = false;
    latestSettlement = undefined;
    return;
  }

  let pendingMessageCount = childPendingMessages(metadata?.childState);
  if (pendingMessageCount > 0) {
    await waitForIdleQueueGrace();
    if (!settlementIsCurrent(settlement)) {
      settlement.collecting = false;
      return;
    }
    let childState;
    try {
      childState = await withTimeout(client.getState(), STARTUP_TIMEOUT_MS, "late steer state confirmation");
    } catch {
      if (!client.isAlive()) {
        settlement.collecting = false;
        latestSettlement = undefined;
        return;
      }
      childState = metadata?.childState;
    }
    if (!settlementIsCurrent(settlement)) {
      settlement.collecting = false;
      return;
    }
    if (childIsBusy(childState)) {
      settlement.collecting = false;
      latestSettlement = undefined;
      return;
    }
    pendingMessageCount = childPendingMessages(childState);
    if (metadata) metadata = { ...metadata, childState };
  }

  settlement.collecting = false;
  if (!settlementIsCurrent(settlement) || steerSubmissionBlockers().length > 0) return;
  reportDroppedSteers(settlement, pendingMessageCount);
  applyFinalMetadata(metadata);
  const failed = lastStopReason === "error" || lastStopReason === "aborted";
  await finish(failed ? "failed" : "completed", failed ? {
    error: lastError || client.getStderr() || "Child run failed.",
  } : {});
}

async function submitSteer(record, message) {
  if (ending) return;
  record.status = "submitting";
  try {
    await client.steer(supervisorMessage("steer", message));
    record.status = "acknowledged";
  } catch (error) {
    record.status = error?.code === "RPC_TIMEOUT" ? "unconfirmed" : "failed";
    const outcome = record.status === "unconfirmed" ? "delivery unconfirmed" : "control failed";
    console.error(`Steer ${outcome} for generation ${record.generation}: ${errorText(error)}`);
  } finally {
    const settlement = latestSettlement;
    if (!ending && settlement) settleRun(settlement).catch((error) => {
      console.error(`Settlement retry failed after steer control: ${errorText(error)}`);
    });
  }
}

function enqueueSteer(message) {
  const record = { generation: ++steerGeneration, status: "queued", consumed: false };
  steerRecords.push(record);
  const submission = steerSubmissionTail.then(() => submitSteer(record, message));
  steerSubmissionTail = submission.catch(() => undefined);
}

function handleEvent(event) {
  if (ending || !isRecord(event)) return;
  // A migration compaction is not a turn: its turn-level events would fake completion and pollute activity.
  if (preflighting && PREFLIGHT_IGNORED_EVENT_TYPES.has(event.type)) return;
  if (event.type === "turn_start") {
    const consumed = initialTurnPending
      ? undefined
      : steerRecords.find((record) => !record.consumed && !["queued", "failed"].includes(record.status));
    initialTurnPending = false;
    if (consumed) {
      consumed.consumed = true;
      consumedSteerGeneration = consumed.generation;
    }
    activeTurnGeneration = consumedSteerGeneration;
    if (pendingRequest && steerGeneration > pendingRequest.generation) pendingRequest = undefined;
    latestSettlement = undefined;
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
      if (isRecord(event.message.usage)) {
        updateContextTokens(event.message.usage.totalTokens);
        state.providerTokens += providerUsageTokens(event.message.usage);
      }
    }
    patchActivity({
      responseText: state.responseText,
      ...(state.tokens > 0 ? { tokens: state.tokens } : {}),
      providerTokens: state.providerTokens,
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
      if (
        isRecord(request) && request.runId === config.runId &&
        ["need_decision", "interview_request", "progress_update"].includes(request.reason) &&
        typeof request.message === "string" && typeof request.createdAt === "string"
      ) pendingRequest = { request, generation: steerGeneration };
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
  if (event.type === "agent_settled") {
    if (pendingRequest) {
      const { request } = pendingRequest;
      pendingRequest = undefined;
      latestSettlement = undefined;
      const waitingSeq = (Number.isInteger(state.waitingSeq) ? state.waitingSeq : 0) + 1;
      transition("waiting", { request, waitingSeq });
      return;
    }
    const settlement = { generation: activeTurnGeneration };
    latestSettlement = settlement;
    void settleRun(settlement);
  }
}

function validControl(value) {
  return isRecord(value) && value.v === 1 && nonEmpty(value.token) && !("requestId" in value) &&
    ["interrupt", "steer", "reply"].includes(value.type) &&
    (value.message === undefined || typeof value.message === "string") &&
    (value.waitingSeq === undefined || (Number.isInteger(value.waitingSeq) && value.waitingSeq >= 1)) &&
    (value.type !== "reply" || (nonEmpty(value.message) && Number.isInteger(value.waitingSeq) && value.waitingSeq >= 1));
}

async function applyControl(control) {
  if (ending || control.token !== config.token) return;
  if (control.type === "steer") {
    if (state.status === "running" && nonEmpty(control.message)) {
      if (control.message.trimStart().startsWith("/")) {
        console.error("Ignoring unsupported slash steer from detached RPC control.");
      } else {
        enqueueSteer(control.message);
      }
    }
    return;
  }
  if (control.type === "reply") {
    if (
      state.status === "waiting" && nonEmpty(control.message) &&
      Number.isInteger(control.waitingSeq) && control.waitingSeq === state.waitingSeq &&
      isRecord(state.request)
    ) {
      transition("running", { request: undefined });
      void withTimeout(
        client.prompt(supervisorMessage("reply", control.message)),
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

/**
 * Cross-model resume preflight barrier.
 *
 * A resumed child session whose provider/model base actually changes is compacted exactly once, while the
 * run stays `starting` and before its first prompt. A benign refusal is a successful no-op and the run
 * continues. Any other failure fails the run closed, so a migrated session is never prompted uncompacted.
 */
async function runModelMigrationCompaction() {
  if (!nonEmpty(config.resumeCompactFrom) || sameModelSpecBase(config.resumeCompactFrom, config.model)) return;
  preflighting = true;
  try {
    await client.compact();
  } catch (error) {
    const message = errorText(error);
    if (!BENIGN_MIGRATION_COMPACTION_ERRORS.has(message)) {
      throw new Error(`${MIGRATION_COMPACTION_ERROR_PREFIX}${message}`);
    }
  } finally {
    preflighting = false;
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
    ...(config.steerResponseTimeoutMs === undefined
      ? {}
      : { steerResponseTimeoutMs: config.steerResponseTimeoutMs }),
  });
  client.onEvent(handleEvent);
  client.onExit((error) => {
    if (!ending && !TERMINAL.has(state.status)) void finish("failed", { error: errorText(error) });
  });
  await client.start();
  const [childState, initialStats] = await Promise.all([
    withTimeout(client.getState(), STARTUP_TIMEOUT_MS, "RPC child startup probe"),
    withTimeout(client.getSessionStats(), STARTUP_TIMEOUT_MS, "RPC child startup stats"),
  ]);
  if (isRecord(initialStats?.tokens) && typeof initialStats.tokens.total === "number" && Number.isFinite(initialStats.tokens.total) && initialStats.tokens.total >= 0) {
    providerTokenBaseline = initialStats.tokens.total;
  }
  await runModelMigrationCompaction();
  transition("running", {
    sessionFile: isRecord(childState) && typeof childState.sessionFile === "string" ? childState.sessionFile : undefined,
  });
  await client.prompt(supervisorMessage("task", config.task));
  await processControls();
} catch (error) {
  await finish("failed", { error: errorText(error) });
}
