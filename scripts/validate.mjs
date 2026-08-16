#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const AGENTS = ["designer", "explorer", "fixer", "librarian", "oracle"];
const ROLES = ["orchestrator", "explorer", "librarian", "oracle", "designer", "fixer"];
const THINKING = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const EXPECTED_TOOLS = {
  explorer: ["read", "grep", "find", "ls", "bash", "contact_supervisor"],
  librarian: ["read", "grep", "find", "ls", "bash", "web_search", "web_fetch", "batch_web_fetch", "contact_supervisor"],
  oracle: ["read", "grep", "find", "ls", "bash", "contact_supervisor"],
  designer: ["read", "grep", "find", "ls", "bash", "edit", "write", "contact_supervisor"],
  fixer: ["read", "grep", "find", "ls", "bash", "edit", "write", "contact_supervisor"],
};
const REMOVED_CAPABILITIES = [
  "workflowScript",
  "schedule.create",
  "mission.",
  "fleet",
  "watchdog",
  "worktree.",
  "refine.",
  "turnBudget",
  "usageBudget",
  "toolBudget",
];
const errors = [];
const REMOVED_WAIT_TOOL = ["subagent", "wait"].join("_");

function check(condition, message) {
  if (!condition) errors.push(message);
}

function read(relativePath) {
  return readFileSync(join(ROOT, relativePath), "utf8");
}

function json(relativePath) {
  try { return JSON.parse(read(relativePath)); }
  catch (error) {
    errors.push(`${relativePath} must be valid JSON: ${error.message}`);
    return {};
  }
}

function hasAll(text, terms, label) {
  for (const term of terms) check(text.includes(term), `${label} missing: ${term}`);
}

function hasNone(text, terms, label) {
  for (const term of terms) check(!text.includes(term), `${label} contains removed token: ${term}`);
}

function frontmatter(text, file) {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  check(Boolean(match), `${file} must have YAML frontmatter and a body`);
  if (!match) return { fields: new Map(), body: text };
  const fields = new Map();
  for (const line of match[1].split("\n")) {
    const field = /^([A-Za-z][A-Za-z0-9]*):(?:\s*(.*))?$/.exec(line);
    if (field) fields.set(field[1], field[2] ?? "");
  }
  return { fields, body: match[2] };
}

function parseToolArray(value) {
  const match = /^\[(.*)\]$/.exec(value ?? "");
  return match ? match[1].split(",").map((item) => item.trim()).filter(Boolean) : [];
}

const packageJson = json("package.json");
const lock = json("package-lock.json");
const packageText = read("package.json");
const lockText = read("package-lock.json");

check(packageJson.version === "0.8.4", "package version must be 0.8.4");
check(JSON.stringify(packageJson.pi?.extensions) === JSON.stringify(["./extensions/oh-my-pi-slim/index.ts"]), "package must load only the OMPS extension");
check(packageJson.pi?.subagents === undefined, "package must not expose a pi.subagents manifest");
check(packageJson.dependencies === undefined || Object.keys(packageJson.dependencies).length === 0, "package must have no runtime dependency on the removed backend");
check(!packageText.includes('"pi-subagents"'), "package.json must not mention pi-subagents");
check(!lockText.includes('"pi-subagents"'), "package-lock.json must not mention pi-subagents");
check(lock.packages && Object.keys(lock.packages).length === 1, "package-lock must contain only the root package");
check(packageJson.scripts?.test === "node --test tests/*.test.mjs", "package must expose the project test suite");
check(packageJson.scripts?.validate === "node scripts/validate.mjs && npm test", "validate must run static checks and tests");

const agentFiles = readdirSync(join(ROOT, "agents")).filter((name) => name.endsWith(".md")).sort();
check(JSON.stringify(agentFiles) === JSON.stringify(AGENTS.map((name) => `${name}.md`).sort()), "agents/ must contain exactly five package roles");
for (const name of AGENTS) {
  const file = `agents/${name}.md`;
  const parsed = frontmatter(read(file), file);
  check(parsed.fields.get("name") === name, `${file} name must match filename`);
  check(parsed.fields.get("systemPromptMode") === "replace", `${file} must replace the system prompt`);
  check(parsed.fields.get("inheritProjectContext") === "true", `${file} must inherit project context`);
  check(parsed.fields.get("inheritSkills") === "true", `${file} must inherit skills`);
  check(JSON.stringify(parseToolArray(parsed.fields.get("tools"))) === JSON.stringify(EXPECTED_TOOLS[name]), `${file} tools allowlist is incorrect`);
  hasAll(parsed.body, ["contact_supervisor", "Do not ask the user directly", "Do not call `subagent` or `subagent_supervisor`."], `${file} child boundary`);
  check(!parsed.body.includes(REMOVED_WAIT_TOOL), `${file} must not mention the removed wait tool`);
}

const extension = read("extensions/oh-my-pi-slim/index.ts");
const runtime = read("extensions/oh-my-pi-slim/subagent-runtime.ts");
const core = read("extensions/oh-my-pi-slim/subagent-core.ts");
const child = read("extensions/oh-my-pi-slim/child-supervisor.ts");
const runFiles = read("extensions/oh-my-pi-slim/subagent-run-files.ts");
const rpcChild = read("extensions/oh-my-pi-slim/runner/rpc-child.mjs");
const detachedRunner = read("extensions/oh-my-pi-slim/runner/omps-runner.mjs");
const bootstrap = read("extensions/oh-my-pi-slim/bootstrap.ts");
const orchestrator = read("extensions/oh-my-pi-slim/orchestrator.md");

const functionStart = extension.indexOf("export default function ohMyPiSlim");
const childGate = extension.indexOf('process.env.PI_SUBAGENT_CHILD === "1" || process.env.OMPS_SUBAGENT_CHILD === "1"', functionStart);
const runtimeRegistration = extension.indexOf("registerSubagentRuntime(pi)", functionStart);
check(functionStart >= 0 && childGate > functionStart && childGate < runtimeRegistration, "main extension must return before child registration");
hasAll(extension, [
  "assertNoLegacyBackend(pi)",
  "ensurePackageSetup(PACKAGE_ROOT)",
  "subagents.restore(ctx)",
  "await subagents.shutdown()",
  "subagents.setModelResolver((role) => launchModelName(preset[role]))",
  'pi.on("session_before_tree"',
  'pi.on("session_tree"',
  'pi.on("turn_end"',
  'pi.on("turn_start"',
  'pi.on("message_end"',
  "setImmediate(() =>",
  "subagents.acknowledgeNotificationMessage(message)",
  "SettingsManager.create(",
  "shouldCompact(",
], "main extension contract");
hasNone(extension, REMOVED_CAPABILITIES, "main extension");
const notificationMessageEndStart = extension.indexOf('pi.on("message_end"');
const notificationMessageEndEnd = extension.indexOf('pi.on("tool_execution_end"', notificationMessageEndStart);
const notificationMessageEnd = extension.slice(notificationMessageEndStart, notificationMessageEndEnd);
hasAll(notificationMessageEnd, [
  'event.message.role !== "custom"', "event.message.customType !== SUBAGENT_NOTIFICATION_TYPE",
  "deliveryEpoch = sessionEpoch", "deliverySessionId = ctx.sessionManager.getSessionId()", "setImmediate(() =>",
  "deliveryEpoch !== sessionEpoch", "sessionCtx?.sessionManager.getSessionId() !== deliverySessionId",
  "subagents.acknowledgeNotificationMessage(message)",
], "deferred notification acknowledgement binding");
const agentSettledStart = extension.indexOf('pi.on("agent_settled"');
const agentSettledEnd = extension.indexOf('pi.on("session_shutdown"', agentSettledStart);
const agentSettled = extension.slice(agentSettledStart, agentSettledEnd);
hasAll(agentSettled, [
  "deliveryEpoch = sessionEpoch", "deliverySessionId = ctx.sessionManager.getSessionId()", "setImmediate(() =>",
  "deliveryEpoch !== sessionEpoch", "sessionCtx?.sessionManager.getSessionId() !== deliverySessionId",
  "subagents.retryQueuedNotificationsAfterAgentSettled()", "const checkpoint = pendingCheckpoint",
  "scheduleCheckpointResume(checkpoint, ctx)",
], "deferred settled notification retry and checkpoint compatibility");
check(notificationMessageEndStart < agentSettledStart, "message_end acknowledgement binding must precede agent_settled retry binding");

hasAll(runtime, [
  "parseFrontmatter",
  "discoverPackageAgents",
  'join(PACKAGE_ROOT, "agents")',
  "getRunRoot(ctx.sessionManager.getSessionDir())",
  "getPiInvocation(args",
  "launchDetachedRunner",
  "readLaunchConfig",
  "readRunState",
  "writeControl",
  "reconcileAll",
  "startPoller",
  '"--mode", "rpc"',
  '"--model"',
  '"--session-dir"',
  '"--session"',
  '"--tools"',
  '"--extension"',
  "pi.appendEntry(SNAPSHOT_TYPE",
  "ctx.sessionManager.getBranch()",
  "restoreRunJournal(entries",
  "runJournalEntry(run)",
  "sourceRunId: sourceId",
  "notificationPending",
  "queuedNotifications",
  "notificationDeliveryKey",
  "notificationDeliveryFromDetails",
  "acknowledgeNotificationMessage",
  "retryQueuedNotificationsAfterAgentSettled",
  "collectRunDirectoryGarbage",
  "Launch a package specialist asynchronously and manage its run by ID.",
  "Inspect waiting child requests and reply by request ID.",
  "PI_SUBAGENT_CHILD: \"1\"",
  "OMPS_SUBAGENT_CHILD: \"1\"",
], "built-in detached runtime");
hasNone(runtime, ["RpcClient", "getPackageDir", "promptLive", "watchClientLiveness", "closingSessions", 'deliverAs: "followUp"'], "built-in detached runtime");
const sendNotificationStart = runtime.indexOf("private sendNotification(run: PersistedRun");
const deliverNotificationStart = runtime.indexOf("private deliverPendingNotification", sendNotificationStart);
const deliverNotificationEnd = runtime.indexOf("private failRun", deliverNotificationStart);
const sendNotification = runtime.slice(sendNotificationStart, deliverNotificationStart);
const deliverNotification = runtime.slice(deliverNotificationStart, deliverNotificationEnd);
hasAll(sendNotification, ['display: true', "deliveryKey: delivery.deliveryKey", 'deliverAs: "steer"', "triggerTurn: true"], "single steer notification message");
hasAll(deliverNotification, ["queuedNotifications.has", "queuedNotifications.add", "sendNotification", "queuedNotifications.delete"], "pending-until-message-end notification queue");
hasNone(deliverNotification, ["notificationPending: undefined", "appendEntry"], "pending-until-message-end notification queue");
const acknowledgeNotificationStart = runtime.indexOf("acknowledgeNotificationMessage(messageValue: unknown)");
const acknowledgeNotificationEnd = runtime.indexOf("private sendNotification", acknowledgeNotificationStart);
const acknowledgeNotification = runtime.slice(acknowledgeNotificationStart, acknowledgeNotificationEnd);
hasAll(acknowledgeNotification, ['message?.role !== "custom"', "notificationDeliveryFromDetails", "acknowledgeNotificationDelivery"], "delivered custom-message acknowledgement");
const acknowledgeDeliveryStart = runtime.indexOf("private acknowledgeNotificationDelivery");
const acknowledgeDeliveryEnd = runtime.indexOf("acknowledgeNotificationMessage", acknowledgeDeliveryStart);
const acknowledgeDelivery = runtime.slice(acknowledgeDeliveryStart, acknowledgeDeliveryEnd);
hasAll(acknowledgeDelivery, ["queuedNotifications.delete(delivery.deliveryKey)", "pendingNotificationDelivery(run)", "notificationPending: undefined"], "stale-safe notification acknowledgement");
check(
  acknowledgeDelivery.indexOf("queuedNotifications.delete(delivery.deliveryKey)") < acknowledgeDelivery.indexOf("pendingNotificationDelivery(run)"),
  "notification acknowledgement must remove its queued key before checking current pending delivery",
);
const retryNotificationStart = runtime.indexOf("retryQueuedNotificationsAfterAgentSettled(): void");
const retryNotificationEnd = runtime.indexOf("private failRun", retryNotificationStart);
const retryNotification = runtime.slice(retryNotificationStart, retryNotificationEnd);
hasAll(retryNotification, [
  "pendingByKey", "this.registry.list()", "this.pendingNotificationDelivery(run)",
  "[...this.queuedNotifications]", "this.queuedNotifications.delete(deliveryKey)",
  "this.deliverPendingNotification(delivery.runId)",
], "agent-settled notification retry");
check(!runtime.includes("appendEntry(SUBAGENT_NOTIFICATION_TYPE"), "notification delivery must not append a second TUI entry");
const restoreStart = runtime.indexOf("async restore(ctx: ExtensionContext)");
const restoreEnd = runtime.indexOf("onTurnStart(): void", restoreStart);
const restoreNotificationFlow = runtime.slice(restoreStart, restoreEnd);
hasAll(restoreNotificationFlow, [
  "queuedNotifications.clear()", 'entry.type === "custom_message"', "SUBAGENT_NOTIFICATION_TYPE",
  "notificationDeliveryFromDetails(entry.details)", "acknowledgeNotificationDelivery(delivery)",
  "deliverPendingNotification(run.id)",
], "restore notification replay and persisted-message acknowledgement");
const shutdownStart = runtime.indexOf("async shutdown(): Promise<void>");
const shutdownEnd = runtime.indexOf("private startPoller", shutdownStart);
hasAll(runtime.slice(shutdownStart, shutdownEnd), ["queuedNotifications.clear()"], "shutdown notification queue cleanup");
const applyStateStart = runtime.indexOf("private applyState(");
const applyStateEnd = runtime.indexOf("private async failUnhealthyRun", applyStateStart);
const applyState = runtime.slice(applyStateStart, applyStateEnd);
hasAll(applyState, [
  'current.status === "waiting" && state.status === "waiting"', "!sameRequest(current.request, request)",
  "enteredWaiting || waitingRequestChanged", '? "waiting"', "deliverPendingNotification(id)",
], "changed waiting-request notification transition");
const statusFormatterStart = runtime.indexOf("private formatRunStatus(run: PersistedRun)");
const fullFormatterStart = runtime.indexOf("private formatRun(run: PersistedRun)", statusFormatterStart);
const listActionStart = runtime.indexOf('if (action === "list") {', fullFormatterStart);
const listActionEnd = runtime.indexOf("const id = requireString", listActionStart);
check(statusFormatterStart >= 0 && fullFormatterStart > statusFormatterStart, "runtime must define a dedicated list status formatter before formatRun");
const statusFormatter = runtime.slice(statusFormatterStart, fullFormatterStart);
hasAll(statusFormatter, ["id: run.id", "agent: run.agent", "status: run.status", "live:", "sourceRunId", "requestId", "reason"], "list status formatter");
hasNone(statusFormatter, ["...run", "task:", "cwd:", "model:", "tools:", "createdAt:", "updatedAt:", "sessionFile:", "activity:", "output:", "error:", "notificationPending:"], "list status formatter");
const listAction = runtime.slice(listActionStart, listActionEnd);
hasAll(listAction, ["reconcileAll", "formatRunStatus", "JSON.stringify(runs, null, 2)", "{ runs }"], "list status action");
hasNone(listAction, [".formatRun(", "this.activity", ".output", ".error", ".task"], "list status action");
const publicSchema = runtime.slice(runtime.indexOf("export const subagentParameters"), runtime.indexOf("export const supervisorParameters"));
hasNone(publicSchema, REMOVED_CAPABILITIES, "public tool schemas");
check(!runtime.includes(REMOVED_WAIT_TOOL), "runtime must not register or mention the removed wait tool");
hasAll(core, [
  '"list"', '"interrupt"', '"steer"', '"resume"',
  '"pending"', '"reply"',
  '"starting"', '"running"', '"waiting"', '"completed"', '"failed"', '"interrupted"',
  "restoreSnapshot",
  "SubagentRegistry",
], "runtime core");
hasNone(core, REMOVED_CAPABILITIES, "runtime core");

hasAll(child, [
  'process.env.OMPS_SUBAGENT_CHILD !== "1"',
  'name: "contact_supervisor"',
  '"need_decision"',
  '"interview_request"',
  '"progress_update"',
  "details: { request }",
  "terminate: true",
], "child supervisor extension");

hasAll(runFiles, [
  "getRunPaths", "ensureRunPaths", "listOwnerRunIds", "removeRunFiles", "atomicWriteJson", "safeReadJson", "tailLog", "isPidAlive", "getProcessIdentity",
  "getPiInvocation", "getDetachedRunnerInvocation", "launchDetachedRunner", "readLaunchConfig", "readRunState",
  "writeControl", "readControlInbox", "DetachedLaunchConfig", "DetachedRunState",
], "detached run files");
hasAll(rpcChild, [
  "export class RpcChild", 'stdio: ["pipe", "pipe", "pipe"]', "pending", "getLastAssistantText", "getSessionStats",
  'child.kill("SIGTERM")', 'child.kill("SIGKILL")',
], "detached RPC child");
hasAll(detachedRunner, [
  'status: "starting"', 'transition("running"', 'transition("waiting"', "heartbeatAt", "updatedAt",
  "tool_execution_start", "tool_execution_end", "compaction_end", "processControls", "watch(controlDir",
  'finish("failed"', 'client.prompt(config.task)', 'process.on(signal', 'REPLY_PROMPT_TIMEOUT_MS',
  "updateContextTokens", "let tokenResetPending = false",
], "detached runner");
hasNone(detachedRunner, ['event.type === "session_compact"'], "detached runner RPC compaction semantics");
const contextTokensStart = detachedRunner.indexOf("function updateContextTokens(candidate)");
const updateStatsStart = detachedRunner.indexOf("function updateStats(stats)", contextTokensStart);
const collectMetadataStart = detachedRunner.indexOf("async function collectFinalMetadata()", updateStatsStart);
const messageUpdateStart = detachedRunner.indexOf('if (event.type === "message_update")');
const messageEndStart = detachedRunner.indexOf('if (event.type === "message_end")', messageUpdateStart);
const toolStart = detachedRunner.indexOf('if (event.type === "tool_execution_start")', messageEndStart);
const compactionStart = detachedRunner.indexOf('if (event.type === "compaction_end")', toolStart);
const settledStart = detachedRunner.indexOf('if (event.type === "agent_settled")', compactionStart);
const contextTokens = detachedRunner.slice(contextTokensStart, updateStatsStart);
const updateStatsTokens = detachedRunner.slice(updateStatsStart, collectMetadataStart);
const collectMetadata = detachedRunner.slice(collectMetadataStart, detachedRunner.indexOf("async function publishTerminal", collectMetadataStart));
const messageUpdateTokens = detachedRunner.slice(messageUpdateStart, messageEndStart);
const messageEndTokens = detachedRunner.slice(messageEndStart, toolStart);
const compactionTokens = detachedRunner.slice(compactionStart, settledStart);
hasAll(contextTokens, [
  "Number.isFinite(candidate)", "candidate <= 0", "if (tokenResetPending)", "state.tokens = candidate",
  "tokenResetPending = false", "Number.isFinite(state.tokens)", "Math.max(current, candidate)", "state.tokens = next",
], "epoch-aware runner context-token helper");
hasAll(updateStatsTokens, [
  "const usage = stats.contextUsage", "updateContextTokens(usage.tokens)", "Number.isFinite(usage.percent)",
  "Number.isFinite(usage.tokens)", "usage.tokens > 0", "Number.isFinite(usage.contextWindow)", "usage.contextWindow > 0",
], "final current-context stats path");
hasNone(updateStatsTokens, ["stats.tokens.total", "updateContextTokens(stats.tokens"], "cumulative session stats exclusion");
hasAll(collectMetadata, ["client.getSessionStats()", "updateStats(stats)"], "final metadata context-token path");
hasAll(messageUpdateTokens, ["updateContextTokens(event.usage.totalTokens)", "patch.tokens = state.tokens"], "streaming current-context token path");
hasNone(messageUpdateTokens, ["patch.tokens = event.usage.totalTokens"], "streaming current-context token path");
hasAll(messageEndTokens, ["updateContextTokens(event.message.usage.totalTokens)", "state.tokens > 0"], "message-end current-context token path");
hasNone(messageEndTokens, ["state.tokens = event.message.usage.totalTokens"], "message-end current-context token path");
hasAll(compactionTokens, [
  'event.aborted === false', "isRecord(event.result)", "tokenResetPending = true",
  "compactionCount: state.compactionCount + 1", "contextPercent: undefined",
], "successful RPC compaction token-epoch reset");
check((detachedRunner.match(/state\.tokens\s*=(?!=)/g) ?? []).length === 2, "runner token state must only be assigned by the epoch-aware context-token helper");
check(existsSync(join(ROOT, "tests/fixtures/stub-pi-rpc.mjs")), "detached RPC test fixture must exist");
check(existsSync(join(ROOT, "tests/detached-runner.test.mjs")), "detached runner integration tests must exist");

hasAll(bootstrap, [
  "Seed the user preset once",
  "cleanupLegacySubagentSetup",
  'join(agentDir, "extensions", "subagent", "config.json")',
  "disableBuiltins",
  "maxSubagentDepth",
  "writeFileSync(userPresetPath, readFileSync(bundledPresetPath), { flag: \"wx\" })",
], "bootstrap migration cleanup");
check(!/export function ensurePackageSetup[\s\S]*disableBuiltins\s*=\s*true/.test(bootstrap), "future bootstrap must not maintain disableBuiltins");
check(!/export function ensurePackageSetup[\s\S]*maxSubagentDepth\s*=\s*1/.test(bootstrap), "future bootstrap must not maintain maxSubagentDepth");

hasAll(orchestrator, [
  'subagent({ agent: "explorer", task:',
  "returns immediately",
  "lifecycle notification",
  "next safe model boundary",
  "same message appears in the TUI and enters model context",
  "without requiring the orchestrator to yield or wait for idle",
  'action: "list"',
  'action: "steer"',
  'action: "interrupt"',
  'action: "resume"',
  "subagent_supervisor",
  "contact_supervisor",
  "creates a new run ID",
], "orchestrator contract");
check(!orchestrator.includes(REMOVED_WAIT_TOOL), "orchestrator must not mention the removed wait tool");
hasNone(orchestrator, ["workflowScript", "schedule.create", "mission.", "fleet", "watchdog", "worktree.", "refine."], "orchestrator removed capabilities");

for (const file of ["README.md", "README.zh-CN.md"]) {
  const text = read(file);
  hasAll(text, [
    "detached",
    "contact_supervisor",
    "subagent_supervisor",
    "--mode rpc",
    "--session-dir",
    "--session <saved sessionFile>",
    "triggerTurn: true",
    'deliverAs: "steer"',
    "version: 2",
    "launch.json",
    "state.json",
    "control/",
    "80 ms",
    "session_shutdown",
    "interrupted",
    "resume",
    "follow-up continuation turn",
  ], file);
  hasAll(text, file === "README.md"
    ? ["next safe model boundary", "same custom message"]
    : ["下一个安全模型边界", "同一条消息"], `${file} notification delivery`);
  hasNone(text, ["RpcClient", "RPC-client seam", "hidden follow-up", "隐藏 follow-up"], file);
  check(!text.includes(REMOVED_WAIT_TOOL), `${file} must not mention the removed wait tool`);
}

const widget = read("extensions/oh-my-pi-slim/subagent-widget.ts");
const widgetRenderer = read("extensions/oh-my-pi-slim/subagent-widget-renderer.ts");
const modelDisplay = read("extensions/oh-my-pi-slim/subagent-model-display.ts");
const transcriptRenderer = read("extensions/oh-my-pi-slim/subagent-transcript-renderer.ts");
hasAll(widget, ["setIntervalFn(() => this.update(), 80)", "requestRender()", 'placement: "aboveEditor"', "widgetRegistered", "dispose()"], "subagent widget lifecycle");
check(!/pi\.on\("tool_execution_start"[\s\S]{0,120}subagents\.onTurnStart/.test(extension), "widget turn aging must not bind to tool_execution_start");
hasAll(widgetRenderer, [
  "MAX_SUBAGENT_WIDGET_LINES = 12", '"├─"', '"└─"', "renderSubagentWidgetLines", "waiting",
  "formatWidgetModel", "formatSubagentModel", "run.model", "formatWidgetTurns", "formatWidgetSessionTokens",
  "describeWidgetActivity", "activeLines.length * 3", "budget >= 3",
], "subagent widget renderer");
hasAll(modelDisplay, ["THINKING_LEVELS", "formatSubagentModel", '"xhigh"', '"max"'], "subagent model display formatter");
hasAll(transcriptRenderer, [
  "Container", "Box", "Text", "Markdown", "Spacer", "getMarkdownTheme", "RAW_HTML_TAG",
  "renderSubagentCall", "renderSubagentResult", "renderSupervisorCall", "renderSupervisorResult",
  "renderSubagentNotification", "details?.run", "details?.runs", "details?.pending",
  'actionFromContext(context, "fresh")', 'actionFromContext(context, "pending")',
  "immediateAck", "renderRunList", "addFinalOutput", "spacedToolResult", '"Live response"',
  '"Retained subagent run status"', "run.requestId", "run.reason",
], "subagent transcript renderer");
hasNone(transcriptRenderer, [
  "gotgenes", "Nico", "preview", "truncated", '"Subagent result"', "renderRunSection", "addActivity",
], "subagent transcript renderer ownership and focused-output contract");
const listRendererStart = transcriptRenderer.indexOf("function renderRunList");
const listRendererEnd = transcriptRenderer.indexOf("export function renderSubagentCall", listRendererStart);
const listRenderer = transcriptRenderer.slice(listRendererStart, listRendererEnd);
hasAll(listRenderer, ["styledTitle", "compactRunHeader", 'status !== "waiting"', "run.requestId", "run.reason"], "status-only list renderer");
hasNone(listRenderer, ["addFinalOutput", "addLiveActivity", "addRequest", "run.task", "run.cwd", "run.model", "run.tools", "run.output", "run.error", "run.activity", "run.request)"], "status-only list renderer");
const notificationStart = transcriptRenderer.indexOf("export function renderSubagentNotification");
const notificationTerminal = transcriptRenderer.indexOf("if (TERMINAL_STATUSES.has(event))", notificationStart);
const notificationWaiting = transcriptRenderer.indexOf('else if (event === "waiting")', notificationTerminal);
const notificationLive = transcriptRenderer.indexOf("else if (LIVE_STATUSES.has(event)", notificationWaiting);
check(
  notificationStart >= 0 && notificationTerminal > notificationStart && notificationWaiting > notificationTerminal &&
  notificationLive > notificationWaiting &&
  transcriptRenderer.slice(notificationTerminal, notificationWaiting).includes("addFinalOutput") &&
  !transcriptRenderer.slice(notificationTerminal, notificationWaiting).includes("addLiveActivity"),
  "terminal notifications must render final output without live response",
);
hasAll(runtime, [
  "registerMessageRenderer(SUBAGENT_NOTIFICATION_TYPE, renderSubagentNotification)",
  "renderCall: renderSubagentCall", "renderResult: renderSubagentResult",
  "renderCall: renderSupervisorCall", "renderResult: renderSupervisorResult",
  "display: true", "run: this.formatRun(run)", "event,",
], "subagent transcript registration and visible notification contract");
check(!runtime.includes('renderShell: "self"'), "subagent transcript tools must use the default tool shell");
check(existsSync(join(ROOT, "THIRD_PARTY_NOTICES.md")), "third-party notice must exist for the adapted widget");

const preset = json("config/oh-my-pi-slim.example.json");
check(Boolean(preset.presets?.[preset.defaultPreset]), "default preset must exist");
for (const [presetName, value] of Object.entries(preset.presets ?? {})) {
  check(JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...ROLES].sort()), `${presetName} must define exactly six roles`);
  for (const role of ROLES) {
    check(typeof value[role]?.provider === "string" && value[role].provider, `${presetName}.${role}.provider must be non-empty`);
    check(typeof value[role]?.model === "string" && value[role].model, `${presetName}.${role}.model must be non-empty`);
    check(THINKING.has(value[role]?.thinking), `${presetName}.${role}.thinking is invalid`);
  }
}

check(existsSync(join(ROOT, "tests/subagent-runtime.test.mjs")), "runtime test file must exist");
const packCheck = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
check(packCheck.status === 0, `npm pack --dry-run failed:\n${packCheck.stderr}`.trim());
if (packCheck.status === 0) {
  try {
    const packed = JSON.parse(packCheck.stdout);
    const files = packed[0]?.files?.map((entry) => entry.path) ?? [];
    check(files.includes("extensions/oh-my-pi-slim/runner/omps-runner.mjs"), "npm pack must include the detached runner");
    check(files.includes("extensions/oh-my-pi-slim/runner/rpc-child.mjs"), "npm pack must include the runner RPC child helper");
    check(files.includes("extensions/oh-my-pi-slim/subagent-model-display.ts"), "npm pack must include the shared subagent model formatter");
    check(files.includes("extensions/oh-my-pi-slim/subagent-transcript-renderer.ts"), "npm pack must include the subagent transcript renderer");
  } catch (error) {
    errors.push(`npm pack --dry-run output must be JSON: ${error.message}`);
  }
}
const diffCheck = spawnSync("git", ["diff", "--check"], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
check(diffCheck.status === 0, `git diff --check failed:\n${diffCheck.stdout}${diffCheck.stderr}`.trim());

if (errors.length > 0) {
  console.error(`Validation failed with ${errors.length} error(s):`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log("Validation passed: OMPS detached background-runner contract is internally consistent.");
