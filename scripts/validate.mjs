#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const AGENTS = ["designer", "explorer", "fixer", "librarian", "observer", "oracle"];
const ROLES = ["orchestrator", "explorer", "librarian", "oracle", "designer", "fixer", "observer"];
const THINKING = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
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

function staticStrings(block, label) {
  const values = [];
  for (const match of block.matchAll(/"((?:\\.|[^"\\])*)"/g)) {
    try { values.push(JSON.parse(match[0])); }
    catch (error) { errors.push(`${label} contains an unreadable string: ${error.message}`); }
  }
  return values;
}

function modelSentences(block) {
  return block.split(/(?<=[.!?])\s+/).filter(Boolean);
}

function checkSteSentence(sentence, label) {
  const words = sentence.match(/[A-Za-z0-9_]+(?:-[A-Za-z0-9_]+)*/g) ?? [];
  check(words.length <= 20, `${label} exceeds 20 words: ${sentence}`);
  check(!sentence.includes(";"), `${label} contains a semicolon: ${sentence}`);
}

function checkSteBlock(block, label) {
  const sentences = modelSentences(block);
  check(sentences.length > 0, `${label} must contain text`);
  for (const sentence of sentences) checkSteSentence(sentence, label);
}

function checkSchemaHow(block, label) {
  checkSteBlock(block, label);
  check(!/\bthis tool\b/i.test(block), `${label} uses ambiguous this tool wording: ${block}`);
}

function guidelineHasOwner(guideline, toolName) {
  const patterns = {
    ask_user_question: /\bask_user_question\b/,
    goal: /\bGoal\b|`goal(?:\s+[a-z]+)?`/,
    loop: /\bloops?\b|`loop(?:\s+[a-z]+)?`/i,
    monitor: /\bmonitors?\b|`monitor(?:\s+[a-z]+)?`/i,
    subagent: /\bsubagent\b|`subagent(?:\s+[a-z]+)?`/i,
    contact_supervisor: /\bcontact_supervisor\b/,
    todo: /\btodo\b/i,
  };
  return patterns[toolName]?.test(guideline) ?? false;
}

const TOOL_ACTIONS = {
  goal: ["create", "modify", "status", "pause", "resume", "complete", "cancel"],
  loop: ["create", "delete", "modify", "list", "pause", "resume"],
  monitor: ["create", "delete", "list", "status"],
  subagent: ["create", "list", "interrupt", "steer", "resume", "reply", "clear"],
  todo: ["list", "update"],
};

function bareGuidelineActions(guideline, toolName) {
  return (TOOL_ACTIONS[toolName] ?? []).filter((action) => guideline.includes(`\`${action}\``));
}

function checkSteGuidelines(guidelines, label, toolName) {
  check(guidelines.length > 0, `${label} must be statically readable`);
  for (const guideline of guidelines) {
    const sentences = modelSentences(guideline);
    check(sentences.length === 1, `${label} must use one sentence per guideline: ${guideline}`);
    checkSteSentence(guideline, label);
    if (!toolName) continue;
    check(guidelineHasOwner(guideline, toolName), `${label} lacks explicit ${toolName} ownership: ${guideline}`);
    check(!/\bthis tool\b/i.test(guideline), `${label} uses ambiguous this tool wording: ${guideline}`);
    for (const action of bareGuidelineActions(guideline, toolName)) {
      check(false, `${label} uses bare ${toolName} action ${action}: ${guideline}`);
    }
  }
}

check(
  JSON.stringify(bareGuidelineActions("Do not call `subagent steer`, `interrupt`, or `reply`.", "subagent")) === JSON.stringify(["interrupt", "reply"]),
  "guideline validator must detect abbreviated actions in a prefixed action list",
);
check(
  bareGuidelineActions("Do not call `subagent steer`, `subagent interrupt`, or `subagent reply`.", "subagent").length === 0,
  "guideline validator must accept fully prefixed parallel actions",
);

function checkLayerSeparation(metadata) {
  check(metadata.description !== metadata.promptSnippet, `${metadata.name} promptSnippet must differ from description`);
  const layers = [
    ["description", [metadata.description]],
    ["promptSnippet", [metadata.promptSnippet]],
    ["promptGuidelines", metadata.guidelines],
    ["schema descriptions", metadata.schemaDescriptions],
  ];
  const seen = new Map();
  for (const [layer, blocks] of layers) {
    for (const block of blocks) {
      for (const sentence of modelSentences(block)) {
        const previous = seen.get(sentence);
        check(previous === undefined || previous === layer, `${metadata.name} repeats model copy across ${previous} and ${layer}: ${sentence}`);
        if (previous === undefined) seen.set(sentence, layer);
      }
    }
  }
}

function propertyString(block, property, label) {
  const match = new RegExp(`\\b${property}:\\s*("(?:\\\\.|[^"\\\\])*")`).exec(block);
  if (!match) {
    errors.push(`${label} must define ${property}`);
    return "";
  }
  try { return JSON.parse(match[1]); }
  catch (error) {
    errors.push(`${label} contains an unreadable ${property}: ${error.message}`);
    return "";
  }
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

const packageJson = json("package.json");
const lock = json("package-lock.json");
const packageText = read("package.json");
const lockText = read("package-lock.json");

check(packageJson.version === "0.10.1", "package version must be 0.10.1");
check(packageJson.description === "Preset-driven Pi orchestration with built-in subagents, loops, monitors, structured questions, durable goals, and session todos.", "package description must cover all built-in runtime surfaces");
check(["pi-package", "pi", "orchestration", "subagents", "loops", "monitoring", "ask-user-question", "goals", "todos", "scheduling"].every((keyword) => packageJson.keywords?.includes(keyword)), "package keywords must include Monitor, Ask, Goal, Loop, subagent, and Todo discovery terms");
check(lock.version === "0.10.1" && lock.packages?.[""]?.version === "0.10.1", "package-lock version must be 0.10.1");
check(JSON.stringify(packageJson.pi?.extensions) === JSON.stringify([
  "./extensions/oh-my-pi-slim/index.ts",
  "./extensions/todo/index.ts",
]), "package must load the OMPS and built-in Todo extensions");
check(packageJson.pi?.subagents === undefined, "package must not expose a pi.subagents manifest");
check(packageJson.dependencies === undefined || Object.keys(packageJson.dependencies).length === 0, "package must have no runtime dependency on the removed backend");
check(!packageText.includes('"pi-subagents"'), "package.json must not mention pi-subagents");
check(!lockText.includes('"pi-subagents"'), "package-lock.json must not mention pi-subagents");
check(lock.packages && Object.keys(lock.packages).length === 1, "package-lock must contain only the root package");
check(packageJson.scripts?.test === "node --test tests/*.test.mjs", "package must expose the project test suite");
check(packageJson.scripts?.validate === "node scripts/validate.mjs && npm test", "validate must run static checks and tests");

const agentFiles = readdirSync(join(ROOT, "agents")).filter((name) => name.endsWith(".md")).sort();
check(JSON.stringify(agentFiles) === JSON.stringify(AGENTS.map((name) => `${name}.md`).sort()), "agents/ must contain exactly six package specialists");
for (const name of AGENTS) {
  const file = `agents/${name}.md`;
  const parsed = frontmatter(read(file), file);
  check(JSON.stringify([...parsed.fields.keys()].sort()) === JSON.stringify(["description", "name"]), `${file} frontmatter must contain only name and description`);
  check(parsed.fields.get("name") === name, `${file} name must match filename`);
  check(parsed.fields.get("description"), `${file} must define a description`);
  check(parsed.body.trim().length > 0, `${file} must contain a role prompt body`);
  hasAll(parsed.body, ["**Supervisor Rules**:", "Do not ask the user directly.", "contact_supervisor", "creates a waiting request and pauses this run", "Do not call subagent create, list, steer, interrupt, resume, or reply actions"], `${file} child lifecycle boundary`);
  hasNone(parsed.body, ["ast_grep_search", "context7", "gh_grep", "apply_patch"], `${file} removed OpenCode tools`);
}

const extension = read("extensions/oh-my-pi-slim/index.ts");
const askRuntime = read("extensions/oh-my-pi-slim/ask-runtime.ts");
const askTui = read("extensions/oh-my-pi-slim/ask-tui.ts");
const askTranscriptRenderer = read("extensions/oh-my-pi-slim/ask-transcript-renderer.ts");
const goalRuntime = read("extensions/oh-my-pi-slim/goal-runtime.ts");
const goalWidget = read("extensions/oh-my-pi-slim/goal-widget.ts");
const goalTranscriptRenderer = read("extensions/oh-my-pi-slim/goal-transcript-renderer.ts");
const loopRuntime = read("extensions/oh-my-pi-slim/loop-runtime.ts");
const monitorRuntime = read("extensions/oh-my-pi-slim/monitor-runtime.ts");
const monitorWidget = read("extensions/oh-my-pi-slim/monitor-widget.ts");
const monitorTranscriptRenderer = read("extensions/oh-my-pi-slim/monitor-transcript-renderer.ts");
const loopWidget = read("extensions/oh-my-pi-slim/loop-widget.ts");
const loopTranscriptRenderer = read("extensions/oh-my-pi-slim/loop-transcript-renderer.ts");
const checkpoint = read("extensions/oh-my-pi-slim/subagent-checkpoint.ts");
const runtime = read("extensions/oh-my-pi-slim/subagent-runtime.ts");
const core = read("extensions/oh-my-pi-slim/subagent-core.ts");
const child = read("extensions/oh-my-pi-slim/child-supervisor.ts");
const runFiles = read("extensions/oh-my-pi-slim/subagent-run-files.ts");
const rpcChild = read("extensions/oh-my-pi-slim/runner/rpc-child.mjs");
const detachedRunner = read("extensions/oh-my-pi-slim/runner/omps-runner.mjs");
const bootstrap = read("extensions/oh-my-pi-slim/bootstrap.ts");
const orchestrator = read("extensions/oh-my-pi-slim/orchestrator.md");
const todoExtension = read("extensions/todo/index.ts");
const todoCore = read("extensions/todo/core.ts");
const todoWidget = read("extensions/todo/widget.ts");
const semanticGlyph = read("extensions/oh-my-pi-slim/semantic-glyph.ts");

hasAll(semanticGlyph, [
  'SEMANTIC_GLYPH_GAP = "  "', "formatSemanticGlyphPrefix", 'return `${glyph}${SEMANTIC_GLYPH_GAP}`',
], "package semantic glyph column helper");
hasNone(semanticGlyph, ["East_Asian_Width", "wcwidth", "visibleWidth", "codePointAt", "allowlist"], "package semantic glyph helper width-classification boundary");
for (const [name, source] of [
  ["Ask transcript", askTranscriptRenderer],
  ["Goal widget", goalWidget],
  ["Goal transcript", goalTranscriptRenderer],
  ["Loop widget", loopWidget],
  ["Loop transcript", loopTranscriptRenderer],
  ["Monitor widget", monitorWidget],
  ["Monitor transcript", monitorTranscriptRenderer],
  ["Subagent widget display", read("extensions/oh-my-pi-slim/subagent-widget-display.ts")],
  ["Subagent widget renderer", read("extensions/oh-my-pi-slim/subagent-widget-renderer.ts")],
  ["Subagent transcript", read("extensions/oh-my-pi-slim/subagent-transcript-renderer.ts")],
  ["Todo widget", todoWidget],
]) {
  hasAll(source, ["formatSemanticGlyphPrefix"], `${name} semantic glyph column contract`);
}

const functionStart = extension.indexOf("export default function ohMyPiSlim");
const childGate = extension.indexOf('process.env.PI_SUBAGENT_CHILD === "1" || process.env.OMPS_SUBAGENT_CHILD === "1"', functionStart);
const loopRegistration = extension.indexOf("registerLoopRuntime(pi)", functionStart);
const monitorRegistration = extension.indexOf("registerMonitorRuntime(pi)", functionStart);
const runtimeRegistration = extension.indexOf("registerSubagentRuntime(pi)", functionStart);
check(functionStart >= 0 && childGate > functionStart && childGate < loopRegistration && loopRegistration < monitorRegistration && monitorRegistration < runtimeRegistration, "main extension must return before Loop, Monitor, and subagent registration");
hasAll(extension, [
  "assertNoLegacyBackend(pi)",
  "ensurePackageSetup(PACKAGE_ROOT)",
  "subagents.restore(ctx)",
  "await subagents.shutdown()",
  "configureSubagentResolvers(activePreset, ctx)",
  "subagents.setDenyResolver((role) => loadPresetConfig().deny[role])",
  'pi.on("session_before_fork"',
  'pi.on("session_before_tree"',
  'pi.on("session_tree"',
  'pi.on("session_before_compact"',
  'pi.on("session_compact"',
  'pi.on("turn_end"',
  'pi.on("turn_start"',
  'pi.on("message_end"',
  "setImmediate(() =>",
  "subagents.acknowledgeNotificationMessage(message)",
  "SettingsManager.create(",
  "contextUsageNeedsCheckpoint(",
  "NotificationDeliveryPauseGate", "setNotificationDeliveryPaused(paused)", "loops.setDeliveryPaused(paused)",
  "monitors?.setDeliveryPaused(paused)", "notificationGate.releaseDeferred", "notificationGate.clearWithoutDelivery",
  "registerAskRuntime(pi)", "new AskTuiDriver(ctx.ui)", "bindAskDriver(ctx)", "bindAskDriver()",
  "registerGoalRuntime(pi", "asks.setGoalActiveResolver", "subagents.subscribeRunCreated", "goal?.onAgentSettled(ctx)",
  "registerLoopRuntime(pi)", "registerMonitorRuntime(pi)",
  "treeNotificationHold", "releaseTreeNotificationHoldDeferred", "subagents.restore(ctx, notificationGate.isPaused())",
  "loops.reset()", "loops.shutdown()", "await monitors?.reset()", "await monitors?.shutdown()",
  'loops.setUICtx(ctx.mode === "tui" ? ctx.ui : undefined)', "loops.refreshUI()",
  'monitors?.setUICtx(ctx.mode === "tui" ? ctx.ui : undefined)', "monitors?.refreshUI()",
  'goal?.setUICtx(ctx.mode === "tui" ? ctx.ui : undefined)', "goal?.setUICtx(undefined)", "goal?.refreshFromBranch(ctx)",
  "monitors?.acknowledgeNotificationMessage(message)", "monitors?.retryQueuedNotificationsAfterAgentSettled()",
], "main extension contract");
const sessionStartHandlerStart = extension.indexOf('pi.on("session_start"');
const beforeSwitchStart = extension.indexOf('pi.on("session_before_switch"');
const beforeForkStart = extension.indexOf('pi.on("session_before_fork"');
const beforeTreeStart = extension.indexOf('pi.on("session_before_tree"');
const sessionTreeStart = extension.indexOf('pi.on("session_tree"');
const inputStart = extension.indexOf('pi.on("input"');
const sessionStartHandler = extension.slice(sessionStartHandlerStart, beforeSwitchStart);
const beforeSwitchHandler = extension.slice(beforeSwitchStart, beforeForkStart);
const beforeForkHandler = extension.slice(beforeForkStart, beforeTreeStart);
const beforeTreeHandler = extension.slice(beforeTreeStart, sessionTreeStart);
const sessionTreeHandler = extension.slice(sessionTreeStart, inputStart);
const beforeAgentStartHandlerStart = extension.indexOf('pi.on("before_agent_start"');
const beforeAgentStartHandlerEnd = extension.indexOf('pi.on("agent_start"', beforeAgentStartHandlerStart);
const beforeAgentStartHandler = extension.slice(beforeAgentStartHandlerStart, beforeAgentStartHandlerEnd);
hasAll(beforeAgentStartHandler, [
  "const goalReminder = goal?.phaseReminder()", "goalReminder ? `${PHASE_REMINDER}\\n\\n${goalReminder}` : PHASE_REMINDER",
  "if (!active || !activePreset || !activePresetName) return goalReminder ? { message } : undefined",
  "systemPrompt: `${systemPrompt}\\n\\n${ORCHESTRATOR_PROMPT}`",
], "Goal independent phase-message and fixed orchestrator prompt boundary");
check(!/systemPrompt:\s*[^\n]*goalReminder/.test(beforeAgentStartHandler), "Goal phase reminder must not dynamically rewrite the system prompt");
hasNone(goalRuntime, ['pi.on("context"', "systemPrompt:", "systemPromptOptions", "before_provider_request"], "Goal dynamic system and context injection boundary");
hasAll(sessionStartHandler, [
  "invalidateCheckpoint(false)", "clearTreeNotificationHold()", "asks.reset()", "bindAskDriver(ctx)", "asks.reconcileHostMode(ctx)",
  "loops.reset()", "await monitors?.reset()",
  'monitors?.setUICtx(ctx.mode === "tui" ? ctx.ui : undefined)', "monitors?.refreshUI()",
  "goal?.restore(ctx", 'goal?.setUICtx(ctx.mode === "tui" ? ctx.ui : undefined)',
], "session-start tree abort ownership cleanup and Goal/Monitor UI binding");
hasAll(beforeSwitchHandler, ["invalidateCheckpoint(false)", "clearTreeNotificationHold()", "asks.abortAll(", "bindAskDriver()", "loops.shutdown()", "goal?.setUICtx(undefined)", "await monitors?.shutdown()"], "session-switch runtime cleanup");
hasAll(beforeForkHandler, ["invalidateCheckpoint(false)", "clearTreeNotificationHold()", "asks.abortAll(", "bindAskDriver()", "loops.shutdown()", "goal?.setUICtx(undefined)", "await monitors?.shutdown()"], "fork runtime cleanup");
hasAll(beforeTreeHandler, [
  "invalidateCheckpoint(false)", "clearTreeNotificationHold()", "asks.abortAll(", "bindAskDriver()", "goal?.setUICtx(undefined)", "const generation = notificationGate.pause()",
  'event.signal.addEventListener("abort", abortListener, { once: true })', "event.signal.aborted", "abortPending",
  "await subagents.shutdown()", "hold.shutdownComplete = true", "releaseTreeNotificationHoldDeferred(hold)", "throw error",
], "tree shared delivery pause and abort compensation");
check(beforeTreeHandler.indexOf("await subagents.shutdown()") < beforeTreeHandler.indexOf("hold.shutdownComplete = true"), "tree abort compensation must wait for shutdown completion");
const treeShutdownCatch = beforeTreeHandler.slice(beforeTreeHandler.indexOf("} catch (error)"));
check(treeShutdownCatch.indexOf("releaseTreeNotificationHoldDeferred(hold)") < treeShutdownCatch.indexOf("throw error"), "tree shutdown failure must schedule deferred release before propagation");
hasNone(beforeTreeHandler, ["clearWithoutDelivery", "loops.shutdown()", "loops.reset()", "monitors?.shutdown()", "monitors?.reset()"], "tree state preservation");
hasAll(sessionTreeHandler, [
  "bindAskDriver(ctx)", "asks.reconcileHostMode(ctx)",
  "const hold = takeTreeNotificationHold()", "subagents.restore(ctx, notificationGate.isPaused())", "finally", "notificationGate.releaseDeferred(hold.generation)",
  'monitors?.setUICtx(ctx.mode === "tui" ? ctx.ui : undefined)', "monitors?.refreshUI()",
  "goal?.restore(ctx, true)", 'goal?.setUICtx(ctx.mode === "tui" ? ctx.ui : undefined)',
], "tree deferred matching release and Goal/Monitor UI rebinding");
hasNone(sessionTreeHandler, ["clearWithoutDelivery", "loops.setDeliveryPaused(false)", "notificationGate.release(generation)"], "tree synchronous release");
const shutdownHandler = extension.slice(extension.indexOf('pi.on("session_shutdown"'));
hasAll(shutdownHandler, ["invalidateCheckpoint(false)", "clearTreeNotificationHold()", "asks.abortAll(", "bindAskDriver()", "loops.shutdown()", "goal?.shutdown()", "monitors?.shutdown()"], "session-shutdown runtime cleanup");
hasAll(extension.slice(inputStart, extension.indexOf('pi.on("session_before_compact"')), ["releaseCurrentNotificationsDeferred()"], "ordinary-input canceled-tree fallback");
hasNone(extension, [...REMOVED_CAPABILITIES, "oh-my-pi-slim:file-nudge", "fileToolSeenThisTurn", "nudgeSentThisUserTurn", "FILE_TOOLS"], "main extension");
const productionToolNames = [...`${extension}\n${askRuntime}\n${goalRuntime}\n${loopRuntime}\n${monitorRuntime}\n${runtime}\n${child}\n${todoExtension}`.matchAll(/registerTool\(\{[\s\S]*?\bname:\s*(?:ASK_TOOL_NAME|"([^"]+)")/g)]
  .map((match) => match[1] ?? "ask_user_question")
  .sort();
check(JSON.stringify(productionToolNames) === JSON.stringify(["ask_user_question", "contact_supervisor", "goal", "loop", "monitor", "subagent", "todo"]), "production extensions must register exactly the seven audited model tools");
const productionSources = `${extension}\n${askRuntime}\n${askTui}\n${askTranscriptRenderer}\n${goalRuntime}\n${goalWidget}\n${goalTranscriptRenderer}\n${loopRuntime}\n${monitorRuntime}\n${monitorWidget}\n${monitorTranscriptRenderer}\n${runtime}\n${core}\n${child}\n${runFiles}\n${detachedRunner}\n${todoExtension}\n${todoCore}\n${todoWidget}`;
hasNone(productionSources, ["file-nudge", "npm:@juicesharp/rpiv-ask-user-question", "npm:@aliou/pi-processes"], "production external-migration and removed file-nudge boundary");
hasNone(monitorRuntime, ["process.stdin", "node-pty", "forkpty", "openpty", "stdin: \"pipe\"", 'stdio: ["pipe", "pipe", "pipe"]'], "Monitor stdin and PTY boundary");
check(!/\b(?:notes?|collapse|config|i18n)\b/i.test(`${askRuntime}\n${askTui}`), "Ask production must not add notes, collapse, config, or i18n surfaces");

hasAll(goalRuntime, [
  'export const GOAL_ACTIONS = ["create", "modify", "status", "pause", "resume", "complete", "cancel"] as const',
  'GOAL_STATE_ENTRY_TYPE = "oh-my-pi-slim:goal-state"', 'GOAL_CONTINUATION_MESSAGE_TYPE', 'GOAL_STATE_MESSAGE_TYPE',
  "export const goalParameters = Type.Object({", "}, { additionalProperties: false });", 'executionMode: "sequential"', 'name: "goal"',
  'this.pi.registerCommand("goal"', 'expandPromptTemplates: false', 'deliverAs: "steer" as const',
  "parseGoalSnapshot", "replayGoalBranch", "ctx.sessionManager.getBranch()", "this.pi.appendEntry(GOAL_STATE_ENTRY_TYPE",
  '"retry_wait"', "GOAL_RETRY_BACKOFF_MS", "retryDelayMs", "hasActiveSubagents", "hasBlockingMonitors", "askWaitingCount",
  "goalActivationContent", "goalContinuationContent", "goalPhaseReminder", "goalView()", "subscribe(listener", "setUICtx(", "refreshUI()",
  "registerMessageRenderer(GOAL_CONTINUATION_MESSAGE_TYPE, renderGoalContinuation)", "registerMessageRenderer(GOAL_STATE_MESSAGE_TYPE, renderGoalState)",
  "renderCall: renderGoalCall", "renderResult: renderGoalResult", "continuationNumber", "parseGoalContinuationMessageDetails", "this.widget.update()", "this.refreshDerivedView()",
  "Pursue this Goal now.", "Do not ask the user questions while this Goal is active.",
  "Continue until every criterion has concrete evidence.", "Continue making concrete progress toward every criterion.",
  "Use Todo, Monitor, and Subagents when useful.", "If safe progress is blocked, call `goal pause` with a concrete reason.",
  "Call `goal complete` only with one evidence entry for every criterion.",
], "Goal durable core, cached UI, renderer registration, and continuation numbering contract");
hasNone(goalRuntime, ["\"Rules:\"", '"- Pursue this Goal now."', '"- Make concrete progress in this run."'], "Goal frozen model text rewrite boundary");
hasNone(goalRuntime, ["registerEntryRenderer", "registerShortcut", "goalId", "revision", "action: \"list\"", "action: \"clear\""], "Goal public-ID and action boundary");
hasAll(goalWidget, [
  "GOAL_WIDGET_KEY", "renderGoalWidgetLines", 'theme.bold("●")', 'theme.fg("accent", "↻")', '"Ⅱ"', '"◷"', '"✓"', '"×"',
  '`${view.continuationCount} cont`', 'countLabel(view.ownedChildRunCount, "run")', 'statsLabel("main"', 'statsLabel("child"',
  'setIntervalFn(() => {', "1_000", "unref?.()", "requestRender()", "truncateToWidth", "visibleWidth", "invalidate() {}", 'placement: "aboveEditor"',
  "sanitizeGoalText", "sanitizeGoalBody", "dispose()",
], "Goal fixed two-line width-safe cached widget contract");
hasNone(goalWidget, ["\\u001b[", "registerShortcut", "setStatus("], "Goal widget theme-only contract");
hasAll(goalTranscriptRenderer, [
  "renderGoalCall", "renderGoalResult", "renderGoalContinuation", "renderGoalState", 'theme.bold("goal")', 'goalStatusGlyph("active", theme)',
  '`· ${sanitizeGoalText(action)}${expanded ? "" : " (ctrl+o to expand)"}`', "new Spacer(1)", "addCompleteGoal", "addCriterionEvidence",
  "ExpandableNotificationLine", 'theme.fg("muted", " (ctrl+o to expand)")', "visibleWidth(this.hint)", "options.expanded === true",
  '"Continuation content"', '"Criterion evidence:"', '"Model result"', "safeFirstLine", "sanitizeGoalBody",
], "Goal Ctrl+O call, result, continuation, and state renderer contract");
hasNone(goalTranscriptRenderer, ["\\u001b[", "registerShortcut", "notify(", "overlay", '"Action"'], "Goal renderer theme-only visual contract");
const goalStatusBlock = goalRuntime.slice(goalRuntime.indexOf('if (action === "status")'), goalRuntime.indexOf('if (action === "create")'));
hasNone(goalStatusBlock, ["this.store(", "generation +=", "pendingContinuation", "activitySerial", "goalView", "cachedMainStats", "cachedChildStats", "ownedRunIds", "continuationCount"], "Goal status pure read-only and stats-private contract");
const goalPauseNoOp = goalRuntime.slice(goalRuntime.indexOf('if (snapshot.goal.status === "paused")'), goalRuntime.indexOf("const next = cloneSnapshot(snapshot)", goalRuntime.indexOf('if (snapshot.goal.status === "paused")')));
hasNone(goalPauseNoOp, ["this.store(", "generation +="], "Goal repeated pause no-op contract");
const goalResumeNoOp = goalRuntime.slice(goalRuntime.indexOf('if (snapshot.goal.status === "active")', goalRuntime.indexOf("private resume")), goalRuntime.indexOf("const next = cloneSnapshot(snapshot)", goalRuntime.indexOf("private resume")));
hasNone(goalResumeNoOp, ["this.store(", "generation +="], "Goal repeated resume no-op contract");
hasAll(goalRuntime.slice(goalRuntime.indexOf("private clearRetryAfterSuccess"), goalRuntime.indexOf("private hasRetryMetadata")), ['status !== "active"', 'status !== "retry_wait"'], "Goal retry-success internal status guard");
const goalSchemaStart = goalRuntime.indexOf("export const goalParameters");
const goalSchemaEnd = goalRuntime.indexOf("function toolText", goalSchemaStart);
const goalSchema = goalRuntime.slice(goalSchemaStart, goalSchemaEnd);
hasNone(goalSchema, ["id:", "goalId", "revision", "generation", "instanceKey", "stats", "ownedRunIds", "continuationCount"], "Goal public schema ID, revision, ownership, and stats boundary");
check(!goalSchema.includes("anyOf:") && !goalSchema.includes("oneOf:"), "Goal schema root must not declare anyOf or oneOf");
const goalSchemaDescriptions = [...goalSchema.matchAll(/description:\s*("(?:\\.|[^"\\])*")/g)].map((match) => JSON.parse(match[1]));
const expectedGoalSchemaDescriptions = [
  "Select the Goal action. Create and modify use abstract, objective, and criteria. Pause and cancel use reason. Complete uses evidence. Status and resume use no other fields.",
  "For create or modify, provide a short Goal summary.",
  "For create or modify, provide the complete Goal objective.",
  "For create or modify, provide from one through eight completion criteria.",
  "For pause or cancel, provide the reason.",
  "For complete, provide one evidence item per completion criterion.",
];
check(JSON.stringify(goalSchemaDescriptions) === JSON.stringify(expectedGoalSchemaDescriptions), "Goal schema descriptions must match the HOW contract");
for (const description of goalSchemaDescriptions) checkSchemaHow(description, "Goal schema description");
hasAll(goalSchema, [
  'action: Type.Union(GOAL_ACTIONS.map((action) => Type.Literal(action))',
  "minItems: 1", "maxItems: 8",
  'description: "Select the Goal action. Create and modify use abstract, objective, and criteria. Pause and cancel use reason. Complete uses evidence. Status and resume use no other fields."',
  'description: "For create or modify, provide from one through eight completion criteria."',
  'description: "For complete, provide one evidence item per completion criterion."',
], "Goal schema actions, fields, and limits");
const goalToolStart = goalRuntime.indexOf('name: "goal"');
const goalGuidelinesStart = goalRuntime.indexOf("promptGuidelines: [", goalToolStart);
const goalGuidelinesEnd = goalRuntime.indexOf("      ],", goalGuidelinesStart);
const goalToolMetadata = goalRuntime.slice(goalToolStart, goalGuidelinesEnd);
const goalDescription = propertyString(goalToolMetadata, "description", "Goal tool metadata");
const goalPromptSnippet = propertyString(goalToolMetadata, "promptSnippet", "Goal tool metadata");
check(goalDescription === "Create and manage one durable branch-local Goal with autonomous continuation and explicit completion evidence. Restored unfinished Goals remain paused until resumed.", "Goal description must match the four-layer contract");
check(goalPromptSnippet === "Manage one durable branch-local Goal.", "Goal promptSnippet must match the four-layer contract");
checkSteBlock(goalDescription, "Goal description");
checkSteBlock(goalPromptSnippet, "Goal promptSnippet");
const goalGuidelines = staticStrings(goalRuntime.slice(goalGuidelinesStart, goalGuidelinesEnd), "Goal promptGuidelines");
const expectedGoalGuidelines = [
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
];
check(JSON.stringify(goalGuidelines) === JSON.stringify(expectedGoalGuidelines), "Goal promptGuidelines must match the four-layer contract");
checkSteGuidelines(goalGuidelines, "Goal promptGuideline", "goal");
hasNone(`${goalDescription}\n${goalPromptSnippet}\n${goalGuidelines.join("\n")}\n${goalSchemaDescriptions.join("\n")}`, [
  "instanceKey", "generation", "deliveryKey", "cursor", "sidecar", "revision", "goalId", "ownedRunIds", "statistics",
], "Goal model metadata private boundary");
const goalCommandStart = goalRuntime.indexOf('this.pi.registerCommand("goal"');
const goalCommandBlock = goalRuntime.slice(goalCommandStart, goalRuntime.indexOf("handler:", goalCommandStart));
const goalCommandDescription = propertyString(goalCommandBlock, "description", "/goal command metadata");
check(goalCommandDescription === "Forward a goal request to the model.", "/goal description must match the audited forwarding contract");
checkSteBlock(goalCommandDescription, "/goal description");
hasAll(goalRuntime.slice(goalRuntime.indexOf("const ACTION_FIELDS"), goalRuntime.indexOf("export const goalParameters")), [
  'create: ["action", "abstract", "objective", "criteria"]',
  'modify: ["action", "abstract", "objective", "criteria"]',
  'status: ["action"]', 'pause: ["action", "reason"]', 'resume: ["action"]',
  'complete: ["action", "evidence"]', 'cancel: ["action", "reason"]',
], "Goal exact action-field boundary");
const activationTail = /\.\.\.goalContractFields\(goal\),([\s\S]*?)\]\.join\("\\n"\);/.exec(goalRuntime.slice(goalRuntime.indexOf("export function goalActivationContent"), goalRuntime.indexOf("export function goalContinuationContent")));
const continuationTail = /\.\.\.goalContractFields\(goal\),([\s\S]*?)\]\.join\("\\n"\);/.exec(goalRuntime.slice(goalRuntime.indexOf("export function goalContinuationContent"), goalRuntime.indexOf("export function goalPhaseReminder")));
const expectedActivationTail = [
  "", "Pursue this Goal now.", "Do not ask the user questions while this Goal is active.",
  "Continue until every criterion has concrete evidence.", "Use Todo, Monitor, and Subagents when useful.",
  "If safe progress is blocked, call `goal pause` with a concrete reason.",
  "Call `goal complete` only with one evidence entry for every criterion.",
];
const expectedContinuationTail = [
  "", "Do not ask the user questions while this Goal is active.",
  "Continue making concrete progress toward every criterion.", "Use Todo, Monitor, and Subagents when useful.",
  "If safe progress is blocked, call `goal pause` with a concrete reason.",
  "Call `goal complete` only with one evidence entry for every criterion.",
];
check(Boolean(activationTail) && JSON.stringify(staticStrings(activationTail?.[1] ?? "", "Goal activation prompt tail")) === JSON.stringify(expectedActivationTail), "Goal activation prompt tail must remain frozen");
check(Boolean(continuationTail) && JSON.stringify(staticStrings(continuationTail?.[1] ?? "", "Goal continuation prompt tail")) === JSON.stringify(expectedContinuationTail), "Goal continuation prompt tail must remain frozen");
hasAll(goalRuntime.slice(goalRuntime.indexOf("export function goalPhaseReminder"), goalRuntime.indexOf("function statusReceipt")), [
  "<system-reminder>\\n!IMPORTANT! You are pursuing the active Goal: ${abstract}. Keep this run aligned with it and continue making concrete progress. !END!\\n</system-reminder>",
], "Goal frozen phase reminder");

const askGuidelineStart = askRuntime.indexOf("export const ASK_PROMPT_GUIDELINES = [");
const askGuidelineEnd = askRuntime.indexOf("] as const;", askGuidelineStart);
const askGuidelines = staticStrings(askRuntime.slice(askGuidelineStart, askGuidelineEnd), "Ask promptGuidelines");
const expectedAskGuidelines = [
  "Choose `ask_user_question` only when the user's decision should direct the next step.",
  "Prefer bounded authored choices in `ask_user_question` when likely outcomes are known.",
  "Allow a custom `ask_user_question` response when authored choices may not fit.",
  "Treat partial or cancelled `ask_user_question` answers as valid outcomes, not failed calls.",
  "Do not call `ask_user_question` while a Goal is active.",
];
check(JSON.stringify(askGuidelines) === JSON.stringify(expectedAskGuidelines), "Ask promptGuidelines must match the four-layer contract");
checkSteGuidelines(askGuidelines, "Ask promptGuideline", "ask_user_question");
const askSchemaStart = askRuntime.indexOf("const askOptionSchema");
const askSchemaEnd = askRuntime.indexOf("export interface AskOption", askSchemaStart);
const askSchema = askRuntime.slice(askSchemaStart, askSchemaEnd);
const askSchemaDescriptions = [...askSchema.matchAll(/description:\s*("(?:\\.|[^"\\])*")/g)].map((match) => JSON.parse(match[1]));
check(askSchemaDescriptions.length === 8, "Ask schema must define eight field descriptions");
for (const description of askSchemaDescriptions) checkSchemaHow(description, "Ask schema description");
const expectedAskSchemaDescriptions = [
  "Write a short option label. Mark a recommendation by placing it first and appending (Recommended). Do not use Other, Type something., or Next.",
  "Describe the outcome of choosing this option.",
  "Add preview content only for a single-select question.",
  "Write one user decision question.",
  "Write a short question header.",
  "Provide authored choices in display order.",
  "Set true only when multiple authored options may be selected. Omit option previews when true.",
  "Provide questions in display order.",
];
check(JSON.stringify(askSchemaDescriptions) === JSON.stringify(expectedAskSchemaDescriptions), "Ask schema descriptions must match the HOW contract");
hasAll(askSchema, [
  "minItems: 1", "maxItems: 4", "minItems: 2", "maxLength: 16", "maxLength: 60",
], "Ask schema question, option, preview, and selection limits");
const askToolStart = askRuntime.indexOf("name: ASK_TOOL_NAME");
const askToolMetadata = askRuntime.slice(askToolStart, askRuntime.indexOf("parameters: askUserQuestionParameters", askToolStart));
const askDescription = propertyString(askToolMetadata, "description", "Ask tool metadata");
const askPromptSnippetMatch = /export const ASK_PROMPT_SNIPPET = ("(?:\\.|[^"\\])*")/.exec(askRuntime);
const askPromptSnippet = askPromptSnippetMatch ? JSON.parse(askPromptSnippetMatch[1]) : "";
check(Boolean(askPromptSnippetMatch), "Ask tool metadata must define a static promptSnippet");
check(askDescription === "Ask the user structured questions and return structured answers.", "Ask description must match the four-layer contract");
check(askPromptSnippet === "Ask the user structured questions for decisions.", "Ask promptSnippet must match the four-layer contract");
checkSteBlock(askDescription, "Ask description");
checkSteBlock(askPromptSnippet, "Ask promptSnippet");
hasNone(`${askDescription}\n${askPromptSnippet}\n${askGuidelines.join("\n")}\n${askSchemaDescriptions.join("\n")}`, [
  "generation", "instance", "deliveryKey", "cursor", "sidecar", "notes", "collapse", "config", "i18n",
], "Ask model metadata private and excluded-surface boundary");
hasAll(askRuntime, [
  'renderCall: renderAskCall', 'renderResult: renderAskResult', "this.tuiDriver = undefined",
  'ASK_RPC_SUBMIT_LABEL = "Submit questionnaire"',
  'ASK_RPC_CANCEL_LABEL = "Cancel questionnaire"',
  'ASK_RPC_DONE_LABEL = "Done with this question"',
  "if (choice === ASK_RPC_SUBMIT_LABEL) return { answers, cancelled: false }",
  "if (choice === undefined || choice === ASK_RPC_CANCEL_LABEL) return { answers, cancelled: true }",
], "Ask RPC submit and cancel contract");
hasAll(askTui, [
  "export class AskTuiDriver", "this.ui.custom", "overlay: true", 'width: "100%"', 'maxHeight: "90%"', 'anchor: "bottom-center"',
  "AskQuestionnaireComponent", "implements Component, Focusable", "this.editor.focused", "signal.addEventListener", "signal.removeEventListener",
  "ASK_CUSTOM_LABEL", "ASK_NEXT_LABEL", "WIDE_PREVIEW_MIN_WIDTH", "new Markdown(", "stripTerminalSequences", "safeAuthoredBody", "safeAuthoredInline", "truncateToWidth",
], "Ask tabbed TUI driver, modal, focus, preview, abort, and width contract");
hasNone(askTui, ["process.stdin", "setRawMode", "setWidget", "setStatus", "notify(", "external editor"], "Ask TUI forbidden side channels");
hasAll(askTranscriptRenderer, [
  "renderAskCall", "renderAskResult", "ask_user_question", "(ctrl+o to expand)", "Selected preview", "Unanswered", "Cancel reason", "new Spacer(1)",
], "Ask Ctrl+O transcript rendering contract");
const notificationMessageEndStart = extension.indexOf('pi.on("message_end"');
const notificationMessageEndEnd = extension.indexOf('pi.on("tool_execution_start"', notificationMessageEndStart);
const notificationMessageEnd = extension.slice(notificationMessageEndStart, notificationMessageEndEnd);
hasAll(notificationMessageEnd, [
  'event.message.role !== "custom"', "message.customType !== SUBAGENT_NOTIFICATION_TYPE",
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
hasAll(agentSettled, ["releaseCurrentNotificationsDeferred()"], "agent-settled canceled-tree fallback");
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
  '"--exclude-tools"',
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
  "setNotificationDeliveryPaused(paused: boolean)", "notificationDeliveryPaused",
  "collectRunDirectoryGarbage", "getGoalStatsRoot", "readGoalStatsSidecar", "writeGoalStatsSidecar",
  "loadedGoalStatsSidecars", "loadGoalStatsSidecar", "captureGoalActivity", "goalStats(runIds",
  "Create or manage retained specialist runs by ID.",
  "Delegate bounded specialist work with `subagent create` when an independent lane improves progress.",
  "`subagent create` starts new work, while `subagent resume` continues reusable terminal context in a new run.",
  "For resume, provide the complete continuation objective.",
  "For reply, answer the complete waiting request.",
  "PI_SUBAGENT_CHILD: \"1\"",
  "OMPS_SUBAGENT_CHILD: \"1\"",
], "built-in detached runtime");
hasNone(runtime, ["RpcClient", "getPackageDir", "promptLive", "watchClientLiveness", "closingSessions", 'deliverAs: "followUp"', 'name: "subagent_supervisor"', "supervisorParameters", "executeSupervisor", "replyTo"], "built-in detached runtime");
const sendNotificationStart = runtime.indexOf("private sendNotification(run: PersistedRun");
const deliverNotificationStart = runtime.indexOf("private deliverPendingNotification", sendNotificationStart);
const deliverNotificationEnd = runtime.indexOf("private failRun", deliverNotificationStart);
const sendNotification = runtime.slice(sendNotificationStart, deliverNotificationStart);
const deliverNotification = runtime.slice(deliverNotificationStart, deliverNotificationEnd);
hasAll(sendNotification, ['display: true', "deliveryKey: delivery.deliveryKey", 'deliverAs: "steer"', "triggerTurn: true"], "single steer notification message");
hasAll(deliverNotification, ["notificationDeliveryPaused", "queuedNotifications.has", "queuedNotifications.add", "sendNotification", "queuedNotifications.delete"], "pending-until-message-end notification queue");
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
hasAll(monitorRuntime, [
  'export const MONITOR_ACTIONS = ["create", "delete", "list", "status"] as const',
  "export const monitorParameters = Type.Object({", "}, { additionalProperties: false });",
  'executionMode: "sequential"', 'name: "monitor"', 'spawnFn(shell, ["-lc", command]',
  'stdio: ["ignore", "pipe", "pipe"]', 'detached: true', "child.unref()", "StringDecoder", "notificationCursor",
  "hasRunning(): boolean", "hasBlockingWork(): boolean", "Reserved for Goal", "setDeliveryPaused(paused: boolean)",
  "acknowledgeNotificationMessage", "retryQueuedNotificationsAfterAgentSettled", 'deliverAs: "steer", triggerTurn: true',
  "finalKillWaitMs", "forceTerminal(record", "trySignal(record", "safeGroupAlive(record", "try", "finally",
  "recentLines", "scanLogTail", "STATUS_SCAN_CHUNK", "renameSync(tempPath, record.logPath)",
  "returned", "omitted", "truncated", "notificationContentMaxBytes", "notificationDetailsMaxBytes", "toolContentMaxBytes",
  "truncatedBytes", "bytes]", "summaryItems", "buildSummaryNotification", "isAbsolute(shell)", "SIGTERM", "SIGKILL",
  "droppedBytes", "droppedLines", "MONITOR_NOTIFICATION_TYPE",
  "registerMessageRenderer(MONITOR_NOTIFICATION_TYPE, renderMonitorNotification)", "renderCall: renderMonitorCall", "renderResult: renderMonitorResult",
  "setUICtx(ui: ExtensionUIContext | undefined)", "refreshUI(): void", "this.widget.handleChange(change)", "this.widget.dispose()",
], "Monitor runtime and visual wiring contract");
hasNone(monitorRuntime, ["registerCommand", "registerShortcut", "setWidget", "notify(", "nohup parser", "readFileSync", "writeFileSync", "partialLineMaxChars"], "Monitor delegated visual boundary");
hasAll(monitorWidget, [
  'MONITOR_WIDGET_KEY = "oh-my-pi-slim:monitors"', "MAX_MONITOR_WIDGET_LINES = 12", "MAX_VISIBLE_MONITORS = 10",
  "MONITOR_RENDER_THROTTLE_MS = 110", 'theme.bold("●")', 'theme.fg("accent", "↻")', '"✓"', '"!"', '"×"',
  "sortMonitorsForDisplay", "createdAt", "endedAt", 'theme.fg("dim", `… ${hidden} more`)', "lines.slice(0, MAX_MONITOR_WIDGET_LINES)",
  'placement: "aboveEditor"', "change.reason === \"output\"", "scheduleRender()", "requestRender()", "invalidate() {}", "dispose()",
], "Monitor foreground widget visual and throttle contract");
hasNone(monitorWidget, ["notify(", "setStatus", "registerShortcut", "overlay", "setInterval("], "Monitor widget excluded UI");
hasAll(monitorTranscriptRenderer, [
  "renderMonitorCall", "renderMonitorResult", "renderMonitorNotification", 'theme.bold("monitor")', 'monitorStatusGlyph("running", theme)',
  '`· ${safeAction}${expanded ? "" : " (ctrl+o to expand)"}`', "spacedResult", "safeFirstLine", "sanitizeMonitorBody",
  'theme.bold(`Monitors (${running}/${monitors.length})`)', "renderOperationalState", 'addCombinedLines(container, theme, "Combined lines"',
  'details?.kind === "matcher"', 'details?.kind === "terminal"', 'details?.kind === "summary"',
  'Monitors · rate limited', 'matched ${details.matched.length}', "Incremental lines", "Forced deletion",
  "ExpandableNotificationLine", 'theme.fg("muted", " (ctrl+o to expand)")', "visibleWidth(this.hint)",
], "Monitor Ctrl+O, result, and notification visual contract");
hasNone(monitorTranscriptRenderer, ["\\u001b", "registerShortcut", "notify(", "overlay", '"Action"'], "Monitor renderer theme-only visual contract");
const trustedBashStart = monitorRuntime.indexOf('candidates.push(\n    "/bin/bash"');
const pathBashFallback = monitorRuntime.indexOf('String(process.env.PATH ?? "").split(delimiter)', trustedBashStart);
check(trustedBashStart >= 0 && trustedBashStart < pathBashFallback, "Monitor must prefer trusted absolute bash candidates before PATH fallback");
const monitorSchemaStart = monitorRuntime.indexOf("export const monitorParameters");
const monitorSchemaEnd = monitorRuntime.indexOf("export class MonitorRuntime", monitorSchemaStart);
const monitorSchema = monitorRuntime.slice(monitorSchemaStart, monitorSchemaEnd);
check(!monitorSchema.includes("anyOf:") && !monitorSchema.includes("oneOf:"), "Monitor schema root must not declare anyOf or oneOf");
const monitorSchemaDescriptions = [...monitorSchema.matchAll(/description:\s*("(?:\\.|[^"\\])*")/g)].map((match) => JSON.parse(match[1]));
const expectedMonitorSchemaDescriptions = [
  "Select the monitor action. Create uses abstract, command, optional cwd, and optional notifyOn. Delete uses id. Status uses id and optional start and end. List uses no other fields.",
  "For create, provide a short command summary.",
  "Provide one foreground Bash command. Do not use nohup, setsid, disown, a trailing ampersand, or another daemon escape.",
  "For create, provide an optional working directory.",
  "For create, provide unique case-sensitive literal matchers.",
  "For delete or status, provide the exact monitor ID.",
  "For status, skip this many newest log lines.",
  "For status, read through this reverse log offset. Set `start` to the prior `end` for older lines.",
];
check(JSON.stringify(monitorSchemaDescriptions) === JSON.stringify(expectedMonitorSchemaDescriptions), "Monitor schema descriptions must match the HOW contract");
for (const description of monitorSchemaDescriptions) checkSchemaHow(description, "Monitor schema description");
const monitorToolStart = monitorRuntime.indexOf('name: "monitor"');
const monitorGuidelinesStart = monitorRuntime.indexOf("promptGuidelines: [", monitorToolStart);
const monitorGuidelinesEnd = monitorRuntime.indexOf("      ],", monitorGuidelinesStart);
const monitorToolMetadata = monitorRuntime.slice(monitorToolStart, monitorGuidelinesEnd);
const monitorDescription = propertyString(monitorToolMetadata, "description", "Monitor tool metadata");
const monitorPromptSnippet = propertyString(monitorToolMetadata, "promptSnippet", "Monitor tool metadata");
check(monitorDescription === "Create and manage foreground long-running Bash commands while Pi remains available. Monitor owns each process group. Terminal results remain available until deletion or runtime shutdown.", "Monitor description must match the four-layer contract");
check(monitorPromptSnippet === "Manage foreground long-running commands by monitor ID.", "Monitor promptSnippet must match the four-layer contract");
checkSteBlock(monitorDescription, "Monitor description");
checkSteBlock(monitorPromptSnippet, "Monitor promptSnippet");
const monitorGuidelines = staticStrings(monitorRuntime.slice(monitorGuidelinesStart, monitorGuidelinesEnd), "Monitor promptGuidelines");
const expectedMonitorGuidelines = [
  "Create a monitor for foreground long-running commands that should continue while Pi remains available.",
  "Let monitor own the complete process group for every monitored command.",
  "Never detach a monitor command with nohup, setsid, disown, or a background ampersand.",
  "Use monitor `notifyOn` for case-sensitive literal alerts that merit attention before completion.",
  "Use `monitor list` to inspect current monitors without polling command output.",
  "Do not poll running monitors with repeated `monitor status` calls.",
  "After a monitor terminal notification, call `monitor status` to inspect results, then call `monitor delete`.",
  "Expect runtime shutdown to terminate monitor process groups and discard retained terminal results.",
];
check(JSON.stringify(monitorGuidelines) === JSON.stringify(expectedMonitorGuidelines), "Monitor promptGuidelines must match the four-layer contract");
checkSteGuidelines(monitorGuidelines, "Monitor promptGuideline", "monitor");
hasNone(`${monitorDescription}\n${monitorPromptSnippet}\n${monitorGuidelines.join("\n")}\n${monitorSchemaDescriptions.join("\n")}`, [
  "generation", "instance", "deliveryKey", "cursor", "sidecar", "notificationCursor",
], "Monitor model metadata private boundary");

hasAll(loopRuntime, [
  'export const LOOP_ACTIONS = ["create", "delete", "modify", "list", "pause", "resume"] as const',
  "export const loopParameters = Type.Object({", "}, { additionalProperties: false });",
  'executionMode: "sequential"', 'name: "loop"', 'pi.registerCommand("loop"',
  'expandPromptTemplates: false', 'deliverAs: "steer" as const',
  'customType: LOOP_MESSAGE_TYPE', 'deliverAs: "steer", triggerTurn: true',
  "registerMessageRenderer(LOOP_MESSAGE_TYPE, renderLoopFire)", "renderCall: renderLoopCall", "renderResult: renderLoopResult",
  "setUICtx(ui: ExtensionUIContext | undefined)", "this.widget.update()", "this.widget.dispose()",
  "firedAt", "setDeliveryPaused(paused: boolean)", "flushGatedFires()", "cancelGatedFires(loop.id)",
  "parseLoopInterval", "canonicalizeLoopInterval", "randomBytes(4).toString(\"hex\")",
  "PreparedLoopSchedule", "firedBeforeActivation", "scheduled.activate()", "acceptScheduledTimeout",
  "this.setTimeoutFn", "this.schedule(current, this.nowMs())", "this.generation += 1",
], "Loop runtime contract");
const loopCreateBlock = loopRuntime.slice(loopRuntime.indexOf("private create("), loopRuntime.indexOf("private delete("));
check(
  loopCreateBlock.indexOf("const scheduled = this.prepareSchedule") < loopCreateBlock.indexOf("this.loops.set(loop.id, loop)") &&
  loopCreateBlock.indexOf("this.loops.set(loop.id, loop)") < loopCreateBlock.indexOf("this.applySchedule(loop, scheduled)"),
  "Loop create must prepare before registry commit and activate only after commit",
);
const loopApplySchedule = loopRuntime.slice(loopRuntime.indexOf("private applySchedule("), loopRuntime.indexOf("private acceptScheduledTimeout"));
check(
  loopApplySchedule.indexOf("loop.timer = scheduled.timer") < loopApplySchedule.indexOf("scheduled.activate()") &&
  loopApplySchedule.indexOf("loop.timerToken = scheduled.token") < loopApplySchedule.indexOf("scheduled.activate()") &&
  loopApplySchedule.indexOf("loop.nextFireAt = scheduled.nextFireAt") < loopApplySchedule.indexOf("scheduled.activate()"),
  "Loop schedule activation must follow timer, token, and nextFireAt commit",
);
hasNone(loopRuntime, ["appendEntry", "setInterval(", "maxFires", "expiresAt", "maxLength", "registerShortcut", "setWidget"], "Loop core semantic boundary");
hasAll(loopWidget, [
  'LOOP_WIDGET_KEY = "oh-my-pi-slim:loops"', "MAX_LOOP_WIDGET_LINES = 12", "MAX_VISIBLE_LOOPS = 5",
  'theme.bold(`Loops (${active}/${sorted.length})`)', 'theme.fg("accent", "↻")', '"Ⅱ"', '"!"',
  'parts.push(`next in ${formatLoopCountdown', 'parts.push("paused", fireLabel', "failureLabel(loop.failureCount)",
  "sortLoopsForDisplay", "nextFireAt", "createdAt", 'setIntervalFn(() => this.update(), 1_000)',
  "requestRender()", 'placement: "aboveEditor"', "stopTimer()", "dispose()", 'setWidget(LOOP_WIDGET_KEY, undefined)',
  'theme.fg("dim", `… ${hidden} more`)', "lines.slice(0, MAX_LOOP_WIDGET_LINES)",
], "Loop foreground widget visual contract");
hasNone(loopWidget, ["notify(", "registerShortcut", "custom(", "overlay"], "Loop widget excluded UI");
hasAll(loopTranscriptRenderer, [
  "renderLoopCall", "renderLoopResult", "renderLoopFire", "styledTitle(", '"loop"', 'theme.fg("accent", "↻")',
  '`· ${action}${expanded ? "" : " (ctrl+o to expand)"}`',
  "context.expanded === true", "options.expanded === true", "spacedResult", "safeFirstLine", "sanitizeLoopBody",
  'theme.bold(`Loops (${active}/${sorted.length})`)', "addCompleteLoop", 'addSection(container, theme, "Prompt"',
  'addField(container, theme, "Fired at"', "LoopFireLine", '· fire ${this.details.fireCount}',
  "ExpandableNotificationLine", 'theme.fg("muted", " (ctrl+o to expand)")', "visibleWidth(this.hint)",
  'verbs: Record<Exclude<LoopAction, "list">, string>', '"Created"', '"Deleted"', '"Modified"', '"Paused"', '"Resumed"',
  'No change · loop', "fallbackResult(result, options, theme)",
], "Loop Ctrl+O and fire renderer visual contract");
hasNone(loopTranscriptRenderer, ["\\u001b", "registerShortcut", "notify(", "overlay", '"Action"'], "Loop renderer theme-only visual contract");
const loopSchemaStart = loopRuntime.indexOf("export const loopParameters");
const loopSchemaEnd = loopRuntime.indexOf("export class LoopRuntime", loopSchemaStart);
const loopSchema = loopRuntime.slice(loopSchemaStart, loopSchemaEnd);
check(!loopSchema.includes("anyOf:") && !loopSchema.includes("oneOf:"), "Loop schema root must not declare anyOf or oneOf");
const loopSchemaDescriptions = [...loopSchema.matchAll(/description:\s*("(?:\\.|[^"\\])*")/g)].map((match) => JSON.parse(match[1]));
const expectedLoopSchemaDescriptions = [
  "Select the loop action. Create uses interval, abstract, and prompt. Modify uses id and at least one changed field. Delete, pause, and resume use id. List uses no other fields.",
  "For delete, modify, pause, or resume, provide the exact loop ID.",
  "For create or modify, provide one interval from 10s through 7d. Use one integer with `s`, `m`, `h`, or `d`.",
  "For create or modify, provide a short loop summary.",
  "For create or modify, provide the complete future prompt.",
];
check(JSON.stringify(loopSchemaDescriptions) === JSON.stringify(expectedLoopSchemaDescriptions), "Loop schema descriptions must match the HOW contract");
for (const description of loopSchemaDescriptions) checkSchemaHow(description, "Loop schema description");
const loopToolStart = loopRuntime.indexOf('name: "loop"');
const loopGuidelinesStart = loopRuntime.indexOf("promptGuidelines: [", loopToolStart);
const loopGuidelinesEnd = loopRuntime.indexOf("      ],", loopGuidelinesStart);
const loopToolMetadata = loopRuntime.slice(loopToolStart, loopGuidelinesEnd);
const loopDescription = propertyString(loopToolMetadata, "description", "Loop tool metadata");
const loopPromptSnippet = propertyString(loopToolMetadata, "promptSnippet", "Loop tool metadata");
check(loopDescription === "Create and manage runtime-only fixed-delay loops that survive compaction and tree navigation. Reload, session replacement, or shutdown clears every loop.", "Loop description must match the four-layer contract");
check(loopPromptSnippet === "Manage runtime-only fixed-delay loops.", "Loop promptSnippet must match the four-layer contract");
checkSteBlock(loopDescription, "Loop description");
checkSteBlock(loopPromptSnippet, "Loop promptSnippet");
const loopGuidelines = staticStrings(loopRuntime.slice(loopGuidelinesStart, loopGuidelinesEnd), "Loop promptGuidelines");
const expectedLoopGuidelines = [
  "Create loops with `loop create` only from a user message that starts with `/loop`.",
  "For a bare `/loop`, call `loop list` and explain `/loop <interval> <prompt>`.",
  "Make every `loop create` prompt self-contained and repeatable for future turns.",
  "Expect `loop create` and `loop resume` to wait one full fixed interval before firing.",
  "Start each next `loop` delay only after the previous tick finishes.",
  "Inspect current loops with `loop list` before changing uncertain loop state.",
  "Change a loop schedule or future prompt with `loop modify`.",
  "Suspend or reactivate a loop with `loop pause` or `loop resume`.",
  "Remove an unwanted loop with `loop delete`.",
  "Expect loops to survive compaction and tree navigation within the current runtime.",
  "Treat loops as runtime-only because reload, session replacement, or shutdown clears every loop.",
];
check(JSON.stringify(loopGuidelines) === JSON.stringify(expectedLoopGuidelines), "Loop promptGuidelines must match the four-layer contract");
checkSteGuidelines(loopGuidelines, "Loop promptGuideline", "loop");
hasNone(`${loopDescription}\n${loopPromptSnippet}\n${loopGuidelines.join("\n")}`, [
  "timerToken", "schedule token", "generation", "notification gate", "gatedFires", "appendEntry", "journal", "snapshot",
], "Loop model metadata internal boundary");
const loopCommandStart = loopRuntime.indexOf('pi.registerCommand("loop"');
const loopCommandBlock = loopRuntime.slice(loopCommandStart, loopRuntime.indexOf("handler:", loopCommandStart));
const loopCommandDescription = propertyString(loopCommandBlock, "description", "/loop command metadata");
check(loopCommandDescription === "Forward a loop request to the model.", "/loop description must remain unchanged");
checkSteBlock(loopCommandDescription, "/loop description");
const restoreStart = runtime.indexOf("async restore(ctx: ExtensionContext, notificationDeliveryPaused = false)");
const restoreEnd = runtime.indexOf("onTurnStart(): void", restoreStart);
const restoreNotificationFlow = runtime.slice(restoreStart, restoreEnd);
hasAll(restoreNotificationFlow, [
  "queuedNotifications.clear()", "this.notificationDeliveryPaused = notificationDeliveryPaused",
  'entry.type === "custom_message"', "SUBAGENT_NOTIFICATION_TYPE",
  "notificationDeliveryFromDetails(entry.details)", "acknowledgeNotificationDelivery(delivery)",
  "deliverPendingNotification(run.id)",
], "restore notification replay and persisted-message acknowledgement");
const shutdownStart = runtime.indexOf("async shutdown(): Promise<void>");
const shutdownEnd = runtime.indexOf("private startPoller", shutdownStart);
hasAll(runtime.slice(shutdownStart, shutdownEnd), ["queuedNotifications.clear()", "notificationDeliveryPaused = false"], "shutdown notification queue cleanup");
const pauseSetterStart = runtime.indexOf("setNotificationDeliveryPaused(paused: boolean)");
const pauseSetterEnd = runtime.indexOf("registerTools(): void", pauseSetterStart);
const pauseSetter = runtime.slice(pauseSetterStart, pauseSetterEnd);
hasAll(pauseSetter, ["this.notificationDeliveryPaused === paused", "if (paused || this.shuttingDown) return", "this.registry.list()", "this.deliverPendingNotification(run.id)"], "notification delivery pause setter");
const beforeCompactStart = extension.indexOf('pi.on("session_before_compact"');
const beforeCompactEnd = extension.indexOf('pi.on("before_agent_start"', beforeCompactStart);
const beforeCompact = extension.slice(beforeCompactStart, beforeCompactEnd);
hasAll(beforeCompact, [
  "notificationGate.pause()", "event.signal.aborted", 'addEventListener("abort"', "setImmediate(() =>",
  "notificationGate.isCurrent(generation)", "notificationGate.release(generation)",
], "compaction notification pause and abort release");
const sessionCompactStart = extension.indexOf('pi.on("session_compact"');
const sessionCompactEnd = extension.indexOf('pi.on("agent_settled"', sessionCompactStart);
const sessionCompactHandler = extension.slice(sessionCompactStart, sessionCompactEnd);
hasAll(sessionCompactHandler, ["pendingCheckpoint.sawThresholdCompaction = true", "releaseCurrentNotificationsDeferred()"], "deferred compaction notification release");
hasNone(sessionCompactHandler, ["setNotificationDeliveryPaused(false)", "sendNotification("], "session_compact synchronous notification release");
const checkpointResumeStart = extension.indexOf("function scheduleCheckpointResume");
const checkpointResumeEnd = extension.indexOf("function resolvePresetModels", checkpointResumeStart);
const checkpointResume = extension.slice(checkpointResumeStart, checkpointResumeEnd);
check(
  checkpointResume.indexOf("pi.sendUserMessage(CHECKPOINT_RESUME_TEXT") < checkpointResume.indexOf("notificationGate.releaseDeferred"),
  "checkpoint continuation must start before deferred notification release",
);
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
hasAll(statusFormatter, [
  "id: run.id", "agent: run.agent", "abstract: run.abstract", "status: run.status", "live:", "sourceRunId", "reason",
  "isTerminalStatus(run.status)", "terminal && run.output !== undefined", "terminal && run.error !== undefined",
], "list status formatter");
hasNone(statusFormatter, ["...run", "task:", "cwd:", "model:", "deniedTools:", "createdAt:", "updatedAt:", "sessionFile:", "activity:", "notificationPending:"], "list status formatter");
const listAction = runtime.slice(listActionStart, listActionEnd);
hasAll(listAction, ["reconcileAll", "this.registry.list()", "formatRunStatus", "JSON.stringify(runs, null, 2)", "{ runs }"], "retained-run list status action");
hasNone(listAction, [".formatRun(", "this.activity", "ACTIVE_STATUSES.has(run.status)", ".task"], "list status action");
const clearActionStart = runtime.indexOf('if (action === "clear") return this.clearRetainedRuns();');
check(clearActionStart > listActionStart, "clear must dispatch from the same action switch as list");
const clearStart = runtime.indexOf("private async clearRetainedRuns()");
const clearEnd = runtime.indexOf("private async resume(", clearStart);
const clearImplementation = runtime.slice(clearStart, clearEnd);
hasAll(clearImplementation, [
  "await this.reconcileAll()", "ACTIVE_STATUSES.has(run.status)",
  "clear requires every retained run to reach a terminal status",
  "clearedCount: 0, warnings: [], changed: false", "No retained subagent runs to clear.",
  "this.clearing = true", "this.purgeRetainedRuns(runs)", "runJournalClearEntry()",
  "this.clearedRunIds.add(run.id)", "this.queuedNotifications.clear()", "this.registry.clear()",
  "} finally {", "this.clearing = false",
], "atomic subagent clear plan");
check(
  clearImplementation.indexOf("this.purgeRetainedRuns(runs)") < clearImplementation.indexOf("runJournalClearEntry()") &&
  clearImplementation.indexOf("runJournalClearEntry()") < clearImplementation.indexOf("this.registry.clear()"),
  "clear must purge on disk, append its replacement snapshot, and only then empty the registry",
);
const purgeStart = runtime.indexOf("private purgeRetainedRuns(");
const purgeEnd = runtime.indexOf("private async clearRetainedRuns()", purgeStart);
const purge = runtime.slice(purgeStart, purgeEnd);
hasAll(purge, [
  "this.goalOwnedRunIds()", "runs.every((run) => owned.has(run.id))",
  "Retained Goal stats sidecars because this branch has no Goal snapshot.",
  "Retained Goal stats sidecars because the Goal snapshot does not own every cleared run.",
  "removeRunFiles(this.pathsFor(run.id))", "removeGoalStatsSidecar(this.goalStatsRoot, this.ownerSessionId, run.id)",
  "this.purgeChildSessionFiles(runs, [])",
], "Goal-owned sidecar and run-directory clear guards");
hasAll(runtime, [
  "replayGoalBranch(this.ctx.sessionManager.getBranch())", "removeChildSessionFile(childDir, run.sessionFile)",
  "canonicalSessionFile", "another retained run still references it",
  "private requireRun(id: string)", "was cleared from the subagent history",
  "this.registry.get(id) || this.clearedRunIds.has(id)",
  "if (this.shuttingDown || this.clearing) return", "if (this.clearing) return",
], "clear safety, cleared-ID reservation, and callback race guards");
hasNone(purge, ["realpathSync", "isSafePathSegment", "rmSync", "unlinkSync", "lstatSync"], "clear must delegate to the shared run-file security helpers");
const publicSchema = runtime.slice(runtime.indexOf("export const subagentParameters"), runtime.indexOf("export class OmpsSubagentRuntime"));
hasNone(publicSchema, REMOVED_CAPABILITIES, "public tool schemas");
hasAll(publicSchema, [
  "export const subagentParameters = Type.Object({", "}, { additionalProperties: false });",
  'description: "For create, select the specialist role."',
  'description: "For create or resume, provide a short run summary."',
  'description: "For create, provide the complete objective."',
  'description: "For create, provide a different working directory."',
  'description: "For steer, interrupt, resume, or reply, provide the run ID."',
], "subagent schema descriptions");
const publicSchemaDescriptions = [...publicSchema.matchAll(/description:\s*("(?:\\.|[^"\\])*")/g)].map((match) => JSON.parse(match[1]));
const expectedSubagentSchemaDescriptions = [
  "For create, select the specialist role.",
  "For create or resume, provide a short run summary.",
  "For create, provide the complete objective.",
  "For create, provide a different working directory.",
  "Select the subagent action. Create uses agent, abstract, task, and optional cwd. Steer and reply use id and message. Resume uses id, abstract, and message. Interrupt uses id. List and clear use no other fields.",
  "For steer, interrupt, resume, or reply, provide the run ID.",
  "For steer, provide an actual instruction. For resume, provide the complete continuation objective. For reply, answer the complete waiting request.",
];
check(JSON.stringify(publicSchemaDescriptions) === JSON.stringify(expectedSubagentSchemaDescriptions), "subagent schema descriptions must match the HOW contract");
for (const description of publicSchemaDescriptions) checkSchemaHow(description, "subagent schema description");
const subagentToolStart = runtime.indexOf('name: "subagent"');
const subagentGuidelinesStart = runtime.indexOf("promptGuidelines: [", subagentToolStart);
const subagentGuidelinesEnd = runtime.indexOf("      ],", subagentGuidelinesStart);
const subagentToolMetadata = runtime.slice(subagentToolStart, subagentGuidelinesEnd);
const subagentDescription = propertyString(subagentToolMetadata, "description", "subagent tool metadata");
const subagentPromptSnippet = propertyString(subagentToolMetadata, "promptSnippet", "subagent tool metadata");
const subagentGuidelineBlock = runtime.slice(subagentGuidelinesStart, subagentGuidelinesEnd);
const subagentGuidelines = staticStrings(subagentGuidelineBlock, "subagent promptGuidelines");
check(subagentDescription === "Create and manage retained specialist runs by run ID. List reports every retained run and its public state. Terminal history includes final output or errors until cleared. Resume creates a new run, while reply continues a waiting run. Interrupt requests resolve through terminal notifications.", "subagent description must match the four-layer contract");
check(subagentPromptSnippet === "Create or manage retained specialist runs by ID.", "subagent promptSnippet must match the four-layer contract");
checkSteBlock(subagentDescription, "subagent description");
checkSteBlock(subagentPromptSnippet, "subagent promptSnippet");
const expectedSubagentGuidelines = [
  "Delegate bounded specialist work with `subagent create` when an independent lane improves progress.",
  "Give each `subagent create` lane exclusive writer ownership over its assigned files.",
  "Run independent `subagent` lanes concurrently only when their ownership and dependencies do not conflict.",
  "`subagent create` starts new work, while `subagent resume` continues reusable terminal context in a new run.",
  "Do not duplicate work already owned by a starting, running, or waiting `subagent` run.",
  "Use `subagent list` to inspect every retained run and its public state.",
  "Expect terminal `subagent list` entries to include final output or errors.",
  "Read each waiting `subagent` notification before answering with `subagent reply`.",
  "`subagent reply` continues the same waiting run after the complete answer arrives.",
  "Use `subagent steer` only for an actual instruction, never for polling or reassurance.",
  "Use `subagent interrupt` only when a live run is obsolete, wrong, or conflicting.",
  "Limit `subagent interrupt` to starting, running, or waiting runs.",
  "Inspect partial file changes after `subagent interrupt` because interruption is not rollback.",
  "Read every terminal `subagent` notification for final output, errors, or interrupt status.",
  "Expect reload, tree navigation, or session replacement to interrupt active `subagent` runs while retaining their history.",
  "Call `subagent clear` only after every retained run becomes terminal.",
  "Do not call any `subagent` action on a run removed by `subagent clear`.",
];
check(JSON.stringify(subagentGuidelines) === JSON.stringify(expectedSubagentGuidelines), "subagent promptGuidelines must match the four-layer contract");
checkSteGuidelines(subagentGuidelines, "subagent promptGuideline", "subagent");
const subagentGuidelineText = subagentGuidelines.join("\n");
check(!/request ID|waitingSeq|deliveryKey|legacy|saved child-session/i.test(`${subagentDescription}\n${subagentPromptSnippet}\n${subagentGuidelineText}`), "subagent model metadata must not expose internal terms");
check(!runtime.includes(REMOVED_WAIT_TOOL), "runtime must not register or mention the removed wait tool");
hasAll(core, [
  '"create"', '"list"', '"interrupt"', '"steer"', '"resume"', '"reply"', '"clear"',
  "RunJournalReplacement", "version: 3", "runJournalReplacementEntry", "runJournalClearEntry",
  "clearedRunIds", "everSeen", "clear(): void",
  '"starting"', '"running"', '"waiting"', '"completed"', '"failed"', '"interrupted"',
  "restoreSnapshot",
  "SubagentRegistry", "legacyRunAbstract", "waitingSeq", "abstract",
  "compareRetainedSubagentRuns", "sortRetainedSubagentRuns", 'status === "running" || status === "waiting"',
  'status === "starting"', "right.updatedAt.localeCompare(left.updatedAt)", "right.createdAt.localeCompare(left.createdAt)",
], "runtime core");
hasNone(core, [...REMOVED_CAPABILITIES, "SUPERVISOR_ACTIONS", "SUPERVISOR_PUBLIC_FIELDS", "pending(): SupervisorRequest", "replyTo"], "runtime core");
check(/SUBAGENT_ACTIONS = \[\s*"create",\s*"list",\s*"interrupt",\s*"steer",\s*"resume",\s*"reply",\s*"clear",\s*\] as const/.test(core), "SUBAGENT_ACTIONS must keep the exact unified action order");

hasAll(checkpoint, [
  "export const CHECKPOINT_RESUME_TEXT", "export function completedToolBatch",
  "export function contextUsageNeedsCheckpoint", "shouldCompact(",
], "shared checkpoint contract");
hasAll(child, [
  'export const contactSupervisorParameters = Type.Object({', "}, { additionalProperties: false });",
  "parameters: contactSupervisorParameters",
  'process.env.OMPS_SUBAGENT_CHILD !== "1"',
  'name: "contact_supervisor"',
  '"need_decision"',
  '"interview_request"',
  '"progress_update"',
  "details: { request }",
  "terminate: true",
  "Yielded to supervisor for run",
  'pi.on("session_start"',
  "pi.setActiveTools(pi.getAllTools().map((tool) => tool.name))",
  'pi.on("turn_start"', 'pi.on("tool_execution_end"', 'pi.on("turn_end"',
  'pi.on("session_compact"', 'pi.on("agent_settled"', 'pi.on("session_shutdown"',
  "completedToolBatch(event)", "contactedSupervisorThisTurn", "ctx.hasPendingMessages()",
  "SettingsManager.create(ctx.cwd, getAgentDir()", "contextUsageNeedsCheckpoint(usage, settings)",
  "ctx.abort()", 'event.reason !== "threshold"', "event.willRetry !== false",
  'pi.sendUserMessage(CHECKPOINT_RESUME_TEXT, { deliverAs: "followUp" })',
  "pendingCheckpoint = undefined",
], "child supervisor extension");
const contactSchemaStart = child.indexOf("export const contactSupervisorParameters");
const contactSchemaEnd = child.indexOf("export default function childSupervisor", contactSchemaStart);
const contactSchema = child.slice(contactSchemaStart, contactSchemaEnd);
const contactSchemaDescriptions = [...contactSchema.matchAll(/description:\s*("(?:\\.|[^"\\])*")/g)].map((match) => JSON.parse(match[1]));
const expectedContactSchemaDescriptions = [
  "Select the supervisor request type.",
  "Provide the complete request context for the orchestrator.",
  "Provide a short interview title.",
  "Provide a short question identifier.",
  "Provide the question text.",
  "Provide the answer options.",
  "Provide the structured interview questions.",
  "Provide structured interview details.",
];
check(JSON.stringify(contactSchemaDescriptions) === JSON.stringify(expectedContactSchemaDescriptions), "contact_supervisor schema descriptions must match the eight audited instructions");
for (const description of contactSchemaDescriptions) checkSchemaHow(description, "contact_supervisor schema description");
const contactToolStart = child.indexOf('name: "contact_supervisor"');
const contactGuidelinesStart = child.indexOf("promptGuidelines: [", contactToolStart);
const contactGuidelinesEnd = child.indexOf("    ],", contactGuidelinesStart);
const contactToolMetadata = child.slice(contactToolStart, contactGuidelinesEnd);
const contactDescription = propertyString(contactToolMetadata, "description", "contact_supervisor tool metadata");
const contactPromptSnippet = propertyString(contactToolMetadata, "promptSnippet", "contact_supervisor tool metadata");
check(contactDescription === "Request an orchestrator reply and pause the child run until the reply arrives.", "contact_supervisor description must match the four-layer contract");
check(contactPromptSnippet === "Request an orchestrator reply from a child run.", "contact_supervisor promptSnippet must match the four-layer contract");
checkSteBlock(contactDescription, "contact_supervisor description");
checkSteBlock(contactPromptSnippet, "contact_supervisor promptSnippet");
const contactGuidelines = child.slice(contactGuidelinesStart, contactGuidelinesEnd);
const contactGuidelineValues = staticStrings(contactGuidelines, "contact_supervisor promptGuidelines");
const expectedContactGuidelines = [
  "Contact the orchestrator through `contact_supervisor` when a decision, interview, or progress update needs acknowledgement.",
  "Request a structured interview through `contact_supervisor` when authored questions will help the orchestrator decide.",
  "Treat every `contact_supervisor` request as a waiting transition, including progress updates.",
  "Resume child work only after the orchestrator replies to `contact_supervisor`.",
];
check(JSON.stringify(contactGuidelineValues) === JSON.stringify(expectedContactGuidelines), "contact_supervisor promptGuidelines must match the four-layer contract");
checkSteGuidelines(contactGuidelineValues, "contact_supervisor promptGuideline", "contact_supervisor");
hasNone(contactGuidelines, [";", " is delivered", "saved child-session", "waitingSeq", "deliveryKey", "legacy", "request ID", "UUID"], "contact_supervisor prompt guidelines");
hasNone(child, ["randomUUID", "request ID", "request.id"], "child supervisor request schema");

hasAll(runFiles, [
  "getRunPaths", "ensureRunPaths", "listOwnerRunIds", "removeRunFiles", "atomicWriteJson", "safeReadJson", "tailLog", "isPidAlive", "getProcessIdentity",
  "getPiInvocation", "getDetachedRunnerInvocation", "launchDetachedRunner", "readLaunchConfig", "readRunState",
  "writeControl", "readControlInbox", "DetachedLaunchConfig", "DetachedRunState", "waitingSeq", '"requestId" in value',
  'GOAL_STATS_DIR_NAME = "omps-goal-stats"', "getGoalStatsRoot", "getGoalStatsSidecarPaths", "writeGoalStatsSidecar", "readGoalStatsSidecar",
  "ensurePrivateDirectory", "0o700", "0o600", "isSymbolicLink", "GoalRunStatsSidecar",
  "normalizeDetachedLaunchConfig", "legacyRunAbstract(value.task)", "value.abstract.trim()",
  "Canonical predicate for newly written launch.json files", "normalized only by readLaunchConfig()",
], "detached run files");
hasAll(rpcChild, [
  "export class RpcChild", 'stdio: ["pipe", "pipe", "pipe"]', "pending", "getLastAssistantText", "getSessionStats",
  'child.kill("SIGTERM")', 'child.kill("SIGKILL")',
], "detached RPC child");
hasAll(detachedRunner, [
  'status: "starting"', 'transition("running"', 'transition("waiting"', "heartbeatAt", "updatedAt",
  "tool_execution_start", "tool_execution_end", "compaction_end", "processControls", "watch(controlDir",
  'finish("failed"', 'client.prompt(config.task)', 'process.on(signal', 'REPLY_PROMPT_TIMEOUT_MS',
  "updateContextTokens", "let tokenResetPending = false", "normalizeConfig", "legacyAbstract(value.task)",
  "keep this exactly aligned with subagent-core.ts legacyRunAbstract()",
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
  "stats.tokens.total", "state.providerTokens = Math.max(state.providerTokens, stats.tokens.total - providerTokenBaseline)", "providerTokenBaseline",
  "const usage = stats.contextUsage", "updateContextTokens(usage.tokens)", "Number.isFinite(usage.percent)",
  "Number.isFinite(usage.tokens)", "usage.tokens > 0", "Number.isFinite(usage.contextWindow)", "usage.contextWindow > 0",
], "separate cumulative-provider and current-context stats paths");
hasNone(updateStatsTokens, ["updateContextTokens(stats.tokens"], "provider totals must not replace context occupancy");
hasAll(collectMetadata, ["client.getSessionStats()", "updateStats(stats)"], "final metadata context-token path");
hasAll(messageUpdateTokens, ["updateContextTokens(event.usage.totalTokens)", "patch.tokens = state.tokens"], "streaming current-context token path");
hasNone(messageUpdateTokens, ["patch.tokens = event.usage.totalTokens"], "streaming current-context token path");
hasAll(messageEndTokens, ["updateContextTokens(event.message.usage.totalTokens)", "state.providerTokens += providerUsageTokens(event.message.usage)", "state.tokens > 0"], "message-end context and cumulative-provider token paths");
hasNone(messageEndTokens, ["state.tokens = event.message.usage.totalTokens"], "message-end current-context token path");
hasAll(compactionTokens, [
  'event.aborted === false', "isRecord(event.result)", "tokenResetPending = true",
  "compactionCount: state.compactionCount + 1", "contextPercent: undefined",
], "successful RPC compaction token-epoch reset");
check((detachedRunner.match(/state\.tokens\s*=(?!=)/g) ?? []).length === 2, "runner token state must only be assigned by the epoch-aware context-token helper");
check(existsSync(join(ROOT, "tests/fixtures/stub-pi-rpc.mjs")), "detached RPC test fixture must exist");
check(existsSync(join(ROOT, "tests/detached-runner.test.mjs")), "detached runner integration tests must exist");
const detachedRunnerTests = read("tests/detached-runner.test.mjs");
hasAll(detachedRunnerTests, ["provider token reconciliation preserves a higher message-event total", "completed.providerTokens, 100"], "runner provider-token high-water reconciliation test");
const subagentRuntimeTests = read("tests/subagent-runtime.test.mjs");
hasAll(subagentRuntimeTests, [
  "Goal stats sidecars enforce private paths", "Goal stats capture writes only actual changes", "Goal stats sidecars preserve completed owned-run aggregates across branch restore",
  "getGoalStatsSidecarPaths", "writeGoalStatsSidecar", "readGoalStatsSidecar", "run-directory GC never deletes session-owned Goal stats sidecars",
], "Subagent Goal stats sidecar security, bounded-write, and cross-branch tests");
hasAll(subagentRuntimeTests, [
  "clear rejects while any run stays active and changes nothing",
  "clear on empty terminal history is a no-change without a clear journal entry",
  "clear removes terminal run directories and appends one version-3 replacement snapshot",
  "clear replay stays empty over legacy version-1 and version-2 history and later upserts still fold",
  "clear removes owned child session files once and warns about shared, escaped, and linked paths",
  "clear removes Goal stats sidecars only when the Goal snapshot owns every cleared run",
  "clear retains an unsafe run directory and still clears the registry consistently",
  "clear blocks poll and agent-settled callbacks from reviving a targeted run",
  "every ID-bearing action reports a cleared run explicitly and never reuses its ID",
  "clear rejects unknown fields and stays exactly { action: clear }",
  "guarded removal helpers reject unsafe sidecar and session paths directly",
  "subagent list returns active then starting then newest terminal runs without changing public fields or terminal output",
], "Subagent clear and retained-history list tests");
const subagentWidgetTests = read("tests/subagent-widget.test.mjs");
hasAll(subagentWidgetTests, [
  "terminal runs never drop or linger out and dispose clears widget, status, and timer",
  "shared retained sorting keeps list, restored state, and widget IDs in active, starting, terminal-newest parity",
  "a retained terminal run keeps the widget registered",
  "clearing every retained run removes the widget",
  "↻  0 · 5.0s", "[●⠋↻◦✓] [^ ]|[●⠋↻◦✓] {3}", "visibleWidth(line) <= terminalWidth",
], "Subagent widget retained-run parity and fixed turn-glyph padding tests");

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
  "<Role>", "<Agents>", "@explorer", "@librarian", "@oracle", "@designer", "@fixer", "@observer", "<Workflow>",
  'subagent({ action: "create", agent, abstract, task, cwd? })', 'subagent({ action: "list" })',
  'subagent({ action: "clear" })', 'clear is refused while any run is starting, running, or waiting',
  'subagent({ action: "steer", id, message })', 'subagent({ action: "interrupt", id })',
  'subagent({ action: "resume", id: "source-run-id", abstract: "new run summary", message: "continuation objective" })',
  'subagent({ action: "reply", id: runId, message })', "lifecycle notifications arrive automatically at the next safe model boundary",
], "orchestrator OMPS contract");
check(!orchestrator.includes("@council"), "orchestrator must keep Council excluded");
hasNone(orchestrator, [
  "task_result", "task_status", "task_nudge", "cancel_task", "wait_for_user", "Background Job Board",
  "Reusable Sessions", "Active / Unreconciled", "subagent_type", "task_id", "ast_grep_search", "apply_patch",
], "orchestrator removed OpenCode runtime");
const expectedTodoContinuity = `### Todo Continuity
- When the user adds a new task while a todo list exists, append the new task to the end of the existing todo list instead of replacing the list.
- Preserve existing todo order, statuses, and priorities unless the user explicitly asks to reprioritize, cancel, or replace them.
- Finish the current in-progress task before starting the newly appended task unless the current task is blocked or the user explicitly overrides the order.`;
const todoContinuityStart = orchestrator.indexOf("### Todo Continuity");
const todoContinuityEnd = orchestrator.indexOf("Can tasks be split", todoContinuityStart);
check(
  orchestrator.slice(todoContinuityStart, todoContinuityEnd).trim() === expectedTodoContinuity,
  "orchestrator Todo Continuity must match the exact upstream text",
);

hasAll(todoExtension, [
  'name: "todo"', 'executionMode: "sequential"', 'Type.Literal("list")', 'Type.Literal("update")',
  "export const todoParameters = Type.Object({", "operations: Type.Optional(Type.Array(todoOperationSchema",
  "additionalProperties: false", "minItems: 1", "TODO_PROMPT_GUIDELINES",
  'ctx.mode !== "tui"', 'pi.on("session_start"', 'pi.on("session_tree"',
  'pi.on("session_compact"', 'pi.on("session_shutdown"', "makeTodoSnapshot",
  "JSON.stringify(tasks)",
], "built-in Todo extension");
const todoFactory = todoExtension.slice(todoExtension.indexOf("export default function todoExtension"));
hasNone(todoFactory, ["getAllTools("], "Todo extension factory initialization");
const todoSchemaBlock = todoExtension.slice(0, todoExtension.indexOf("export const TODO_PROMPT_SNIPPET"));
hasAll(todoSchemaBlock, [
  'description: "Select list to read state or update to apply operations."',
  'description: "For update, provide operations in execution order. Omit this field for list."',
  'description: "Apply clear at most once in an update."',
  'description: "Select pending, in_progress, or completed."',
  'description: "Add initial dependencies by exact subject."',
  'description: "Add dependencies by exact subject."',
  'description: "Remove dependencies by exact subject."',
  'description: "Use the exact subject to delete."',
], "Todo schema descriptions");
hasNone(todoSchemaBlock, [
  'description: "List exact dependency subjects."',
  "export const todoParameters = Type.Union([",
  "minProperties",
], "Todo schema portability");
check(todoSchemaBlock.split('description: "Add initial dependencies by exact subject."').length - 1 === 1, "append blockedBy must have one distinct array description");
check(todoSchemaBlock.split('description: "Add dependencies by exact subject."').length - 1 === 1, "addBlockedBy must have one distinct array description");
check(todoSchemaBlock.split('description: "Remove dependencies by exact subject."').length - 1 === 1, "removeBlockedBy must have one distinct array description");
check(todoSchemaBlock.split('description: "Use an existing exact subject."').length - 1 === 3, "each dependency array item must use the exact-subject description");
const todoSchemaDescriptions = [...todoSchemaBlock.matchAll(/description:\s*("(?:\\.|[^"\\])*")/g)].map((match) => JSON.parse(match[1]));
const expectedTodoSchemaDescriptions = [
  "Select pending, in_progress, or completed.",
  "Use an existing exact subject.",
  "Add initial dependencies by exact subject.",
  "Use an existing exact subject.",
  "Add dependencies by exact subject.",
  "Use an existing exact subject.",
  "Remove dependencies by exact subject.",
  "Provide a unique item subject.",
  "Provide a short item summary.",
  "Use the exact current subject.",
  "Provide a unique replacement subject.",
  "Provide a short replacement summary.",
  "Use the exact subject to delete.",
  "Apply clear at most once in an update.",
  "Select list to read state or update to apply operations.",
  "For update, provide operations in execution order. Omit this field for list.",
];
check(JSON.stringify(todoSchemaDescriptions) === JSON.stringify(expectedTodoSchemaDescriptions), "Todo schema descriptions must match the HOW contract");
for (const description of todoSchemaDescriptions) checkSchemaHow(description, "Todo schema description");
hasAll(todoExtension, [
  'export const TODO_PROMPT_SNIPPET = "Track session work, dependencies, and progress."',
  'description: "Read or atomically update the current session todo list. Failed update batches leave the list unchanged."',
], "Todo tool metadata");
const todoDescription = "Read or atomically update the current session todo list. Failed update batches leave the list unchanged.";
const todoPromptSnippet = "Track session work, dependencies, and progress.";
checkSteBlock(todoPromptSnippet, "Todo promptSnippet");
checkSteBlock(todoDescription, "Todo description");
const todoGuidelineStart = todoExtension.indexOf("export const TODO_PROMPT_GUIDELINES = [");
const todoGuidelineEnd = todoExtension.indexOf("] as const;", todoGuidelineStart);
const todoGuidelineBlock = todoExtension.slice(todoGuidelineStart, todoGuidelineEnd);
const todoGuidelines = staticStrings(todoGuidelineBlock, "Todo promptGuidelines");
const expectedTodoGuidelines = [
  "Treat `todo` as the session-local planning ledger for work, dependencies, and progress.",
  "Use `todo list` to inspect current plan state before uncertain updates.",
  "Use `todo update` for atomic ordered changes that should succeed or fail together.",
  "Append new user tasks through `todo update` instead of replacing existing `todo` items.",
  "Preserve existing `todo` items unless the user or current work requires a change.",
  "Complete every `todo` dependency before starting or completing a dependent item.",
  "Allow multiple `todo` items in progress when work genuinely proceeds concurrently.",
  "Delete a `todo` item only after removing every `blockedBy` reference to it.",
  "Finish current in-progress `todo` work before appended tasks unless blocked or explicitly reordered.",
  "Apply `clear` through `todo update` only after current items finish, then append the new task group.",
];
check(JSON.stringify(todoGuidelines) === JSON.stringify(expectedTodoGuidelines), "Todo promptGuidelines must match the four-layer contract");
checkSteGuidelines(todoGuidelines, "Todo promptGuideline", "todo");
const todoGuidelineText = todoGuidelines.join("\n");
check(!/\b(?:snapshot|replay|store|version|widget|ID)\b/i.test(todoGuidelineText), "Todo promptGuidelines must not expose internal terms");

const modelMetadataAudit = [
  {
    name: "ask_user_question", description: askDescription, promptSnippet: askPromptSnippet,
    schemaDescriptions: askSchemaDescriptions, guidelines: askGuidelines,
    internalTerms: ["generation", "instance", "deliveryKey", "cursor", "sidecar", "notes", "collapse", "config", "i18n"],
  },
  {
    name: "goal", description: goalDescription, promptSnippet: goalPromptSnippet,
    schemaDescriptions: goalSchemaDescriptions, guidelines: goalGuidelines,
    internalTerms: ["instanceKey", "generation", "deliveryKey", "cursor", "sidecar", "revision", "goalId", "ownedRunIds", "statistics"],
  },
  {
    name: "loop", description: loopDescription, promptSnippet: loopPromptSnippet,
    schemaDescriptions: loopSchemaDescriptions, guidelines: loopGuidelines,
    internalTerms: ["timerToken", "schedule token", "generation", "notification gate", "gatedFires", "appendEntry", "journal", "snapshot"],
  },
  {
    name: "monitor", description: monitorDescription, promptSnippet: monitorPromptSnippet,
    schemaDescriptions: monitorSchemaDescriptions, guidelines: monitorGuidelines,
    internalTerms: ["generation", "instance", "deliveryKey", "cursor", "sidecar", "notificationCursor"],
  },
  {
    name: "subagent", description: subagentDescription, promptSnippet: subagentPromptSnippet,
    schemaDescriptions: publicSchemaDescriptions, guidelines: subagentGuidelines,
    internalTerms: ["request ID", "waitingSeq", "deliveryKey", "legacy", "saved child-session"],
  },
  {
    name: "contact_supervisor", description: contactDescription, promptSnippet: contactPromptSnippet,
    schemaDescriptions: contactSchemaDescriptions, guidelines: contactGuidelineValues,
    internalTerms: ["request ID", "UUID", "waitingSeq", "deliveryKey", "legacy", "saved child-session"],
  },
  {
    name: "todo", description: todoDescription, promptSnippet: todoPromptSnippet,
    schemaDescriptions: todoSchemaDescriptions, guidelines: todoGuidelines,
    internalTerms: ["snapshot", "replay", "store", "version", "widget"],
  },
];
check(
  JSON.stringify(modelMetadataAudit.map(({ name }) => name)) === JSON.stringify([
    "ask_user_question", "goal", "loop", "monitor", "subagent", "contact_supervisor", "todo",
  ]),
  "model metadata audit must enumerate all seven package tools",
);
const standaloneGuidelineCoverage = {
  ask_user_question: ["decision should direct", "bounded authored choices", "custom", "partial or cancelled", "Goal is active"],
  goal: ["`goal create`", "`goal status`", "durable contract", "`todo` checklist", "autonomously", "continuation wait", "pending messages", "user input", "blocker", "provider failures", "`retry_wait`", "repeated automatic Goal runs", "without progress", "pause the Goal for review", "user abort", "restored unfinished Goals", "`goal modify`", "`goal pause`", "`goal resume`", "`goal cancel`", "`goal complete`", "concrete evidence"],
  loop: ["`loop create`", "self-contained", "repeatable", "one full fixed interval", "previous tick finishes", "`loop list`", "`loop modify`", "`loop pause`", "`loop resume`", "`loop delete`", "compaction", "runtime-only", "shutdown"],
  monitor: ["foreground long-running", "process group", "nohup", "setsid", "disown", "`notifyOn`", "`monitor list`", "repeated `monitor status`", "terminal notification", "`monitor delete`", "runtime shutdown"],
  subagent: ["bounded specialist", "writer ownership", "concurrently", "`subagent create`", "`subagent resume`", "Do not duplicate", "`subagent list`", "final output or errors", "waiting", "same waiting run", "`subagent steer`", "polling", "`subagent interrupt`", "obsolete", "partial file changes", "not rollback", "terminal", "reload", "tree navigation", "session replacement", "retaining their history", "`subagent clear`", "removed"],
  contact_supervisor: ["decision, interview, or progress update", "needs acknowledgement", "structured interview", "authored questions", "waiting transition", "orchestrator replies"],
  todo: ["session-local planning ledger", "`todo list`", "`todo update`", "atomic ordered", "Append new user tasks", "Preserve existing `todo` items", "current work requires a change", "dependency", "multiple `todo` items in progress", "`blockedBy`", "in-progress `todo` work", "`clear`", "new task group"],
};
for (const metadata of modelMetadataAudit) {
  hasAll(metadata.guidelines.join("\n"), standaloneGuidelineCoverage[metadata.name], `${metadata.name} standalone operational guidance`);
  const blocks = [metadata.description, metadata.promptSnippet, ...metadata.schemaDescriptions];
  for (const block of blocks) {
    checkSteBlock(block, `${metadata.name} audited metadata`);
    const sentences = modelSentences(block);
    check(new Set(sentences).size === sentences.length, `${metadata.name} audited metadata must not repeat a sentence: ${block}`);
  }
  checkSteGuidelines(metadata.guidelines, `${metadata.name} audited promptGuideline`, metadata.name);
  check(new Set(metadata.guidelines).size === metadata.guidelines.length, `${metadata.name} promptGuidelines must not contain duplicates`);
  checkLayerSeparation(metadata);
  const visibleText = [...blocks, ...metadata.guidelines].join("\n").toLowerCase();
  for (const term of metadata.internalTerms) {
    check(!visibleText.includes(term.toLowerCase()), `${metadata.name} audited metadata exposes internal term: ${term}`);
  }
}
const commandMetadataAudit = [
  { name: "/goal", description: goalCommandDescription },
  { name: "/loop", description: loopCommandDescription },
];
check(commandMetadataAudit.length === 2, "command metadata audit must enumerate /goal and /loop");
for (const command of commandMetadataAudit) checkSteBlock(command.description, `${command.name} audited metadata`);

hasAll(todoCore, [
  "TODO_SNAPSHOT_TYPE", "applyTodoUpdate", "validateTodoState", "replayTodoBranch",
  "todo update failed at operation", "clear can appear only once",
  "requires completed dependency", "dependency cycle", "cloneTasks",
  "delete contains unknown fields", "cannot delete ", "depend on it.",
], "built-in Todo state contract");
hasNone(`${todoCore}\n${todoGuidelineText}`, [
  "at most one task can be in_progress", "at most one item in_progress",
], "Todo multiple in_progress contract");
hasAll(todoWidget, [
  "MAX_TODO_WIDGET_LINES = 12", 'theme.bold("●")', 'theme.bold(`Todos (${completed}/${tasks.length})`)', '"○"', '"◐"', '"✓"', 'theme.fg("dim", "⛓")',
  'theme.strikethrough', '"├─"', '"└─"', "hiddenSummary", "setWidget",
  "isTodoTaskBlocked", "sortTodoTasksForWidget", "sorted.slice(0, taskBudget)", "sorted.slice(taskBudget)",
  "renderTodoListResult", "renderTodoReceipts", "expanded = false", "receiptStatusTransition",
  'operations.filter((operation) => operation.op === "append")',
  'operations.filter((operation) => operation.op === "modify")',
  'operations.filter((operation) => operation.op === "delete")',
  'operations.filter((operation) => operation.op === "clear")',
  'Applied ${append} append · ${modify} modify · ${deletes} delete · ${clear} clear → ${changed} changed · ${noChange} no-change',
  'addResultField(container, theme, "Status"', 'addResultSection(container, theme, "Abstract"',
  'addResultList(container, theme, "Blocked by"', "no-change",
], "built-in Todo widget and result-renderer contract");
hasAll(todoExtension, [
  "context.expanded === true", "todoCallTitle", 'theme.bold("todo")', 'theme.fg("muted", detail)',
  '`· ${action}${expanded ? "" : " (ctrl+o to expand)"}`', 'action === "list" || !expanded',
  'addCallField(container, theme, "Operations"', '"Append"', '"Modify"', '"Delete"', '"Clear"',
  'addCallSection(container, theme, "Abstract"', 'addCallList(container, theme, "Blocked by"',
  'addCallList(container, theme, "Add blocked by"', 'addCallList(container, theme, "Remove blocked by"',
  "options.expanded === true", "safeFallbackLine", "sanitizeTodoBody",
  "renderTodoReceipts(snapshot.receipts, snapshot.operations, theme, expanded)",
], "Todo Ctrl+O call and result renderer contract");
hasNone(todoExtension, ['"Action"', "operationCounts", 'theme.bold(`todo · ${action}`)'], "Todo duplicate call metadata");
check(existsSync(join(ROOT, "tests/todo.test.mjs")), "Todo contract tests must exist");
check(existsSync(join(ROOT, "tests/provider-schema.test.mjs")), "provider schema compatibility tests must exist");
check(existsSync(join(ROOT, "tests/loop.test.mjs")), "Loop core contract tests must exist");
check(existsSync(join(ROOT, "tests/loop-ui.test.mjs")), "Loop visual contract tests must exist");
check(existsSync(join(ROOT, "tests/goal-ui.test.mjs")), "Goal visual contract tests must exist");
check(existsSync(join(ROOT, "tests/monitor-ui.test.mjs")), "Monitor visual contract tests must exist");
check(existsSync(join(ROOT, "tests/fixtures/todo-load-probe.ts")), "Todo real-Pi load probe must exist");
check(existsSync(join(ROOT, "tests/fixtures/omps-load-probe.ts")), "OMPS real-Pi load probe must exist");
check(existsSync(join(ROOT, "tests/fixtures/ask-rpc-probe.ts")), "Ask native RPC dialog probe must exist");
check(existsSync(join(ROOT, "tests/loop-load.test.mjs")), "Loop real-Pi load tests must exist");
const loopUiTests = read("tests/loop-ui.test.mjs");
hasAll(loopUiTests, [
  "exact heading, glyph priority, counts, order", "caps at 12 lines", "one shared 1s timer",
  "all six actions", "uniform collapsed hints", "(ctrl+o to expand)", "Action:",
  "compact receipts", "result fallback", "fire renderer", "without mutation",
  "· fire 3 (ctrl+o to expand)", "Legacy first  line (ctrl+o to expand)",
  "├─ ↻  middle", "[↻!Ⅱ●] [^ ]|[↻!Ⅱ●] {3}", "wideAnsi", "visibleWidth(line) <= 28",
], "Loop focused visual tests");
const loopCoreTests = read("tests/loop.test.mjs");
hasAll(loopCoreTests, [
  "synchronous injected timeout callbacks activate after commit", "scheduler failures preserve active modify and paused resume atomicity",
  "scheduler unavailable", "tree abort waits for shutdown completion", "abort cannot release delivery before subagent shutdown completes",
  "shutdown failure schedules deferred gate release before propagating", "ordinary input releases a canceled tree gate",
], "Loop scheduler seam and tree abort compensation tests");
const askRuntimeTests = read("tests/ask-runtime.test.mjs");
const askUiTests = read("tests/ask-ui.test.mjs");
const askTranscriptTests = read("tests/ask-transcript-renderer.test.mjs");
hasAll(askRuntimeTests, [
  "single-flight queue runs one dialog at a time", "queued and active aborts reject exactly once", "RPC exposes complete, partial, empty, and cancelled",
  "headless reconciliation removes and restores only Ask", "typeof tool.renderCall", "typeof tool.renderResult",
], "Ask core schema, result, RPC, single-flight, abort, headless, and renderer registration tests");
hasAll(askUiTests, [
  "tabs wrap in both directions", "single-select cycles", "multi-select toggles", "per-tab drafts", "partial and zero answers",
  "wide two-column", "narrow stacked", "Abort closes the overlay exactly once", "RPC never uses custom overlay", "main lifecycle binds fresh TUI drivers",
  "CURSOR_MARKER", "visibleWidth(line) <=", "pasted\\n汉字", "authored Ask fields strip ANSI, OSC, C0, and C1", "originalParams", "originalValidated",
], "Ask focused modal, tabs, input, draft, preview, abort, cleanup, RPC, focus, and width tests");
hasAll(askTranscriptTests, [
  "ask_user_question · 3 questions (ctrl+o to expand)", "full expanded schema", "one leading blank line", "Selected preview",
  "data invariance", "safely falls back", "package-isomorphic call and result renderers", "Action:",
], "Ask focused Ctrl+O call, result, fallback, spacing, and invariance tests");
for (const file of ["tests/loop.test.mjs", "tests/provider-schema.test.mjs", "tests/subagent-runtime.test.mjs"]) {
  hasAll(read(file), ["./ask-runtime.js", "./ask-transcript-renderer.js", "./ask-tui.js"], `${file} Ask TypeScript load mappings`);
}
const todoTests = read("tests/todo.test.mjs");
hasAll(todoTests, [
  'todo · list (ctrl+o to expand)', 'todo · update (ctrl+o to expand)',
  'assert.equal(collapsed, "todo · update (ctrl+o to expand)")',
  'Action:|Operations:|Append:|Modify:|Delete:|Clear:',
  '✓  Applied 1 append · 2 modify · 0 delete · 0 clear → 2 changed · 1 no-change',
  '✓  Applied 0 append · 0 modify · 1 delete · 0 clear → 1 changed · 0 no-change',
  "widget priority sorts every state from current dependencies", "missing-ref", "sorts before slicing",
  'cannot delete "Core" because "Left", "Right" depend on it',
], "Todo focused Ctrl+O visual tests");
const subagentTranscriptTests = read("tests/subagent-transcript-renderer.test.mjs");
hasAll(subagentTranscriptTests, [
  "clear receipts stay compact when collapsed and list every retained-item warning when expanded",
  "subagent · clear (ctrl+o to expand)", "Retained subagent run status · 3",
  "without duplicate Action rows", "(ctrl+o to expand)", "Action:",
  'assert.doesNotMatch(value, /\\(ctrl\\+o to expand\\)|Action:/)',
  'waiting (ctrl+o to expand)', '${value.status} (ctrl+o to expand)', 'running (ctrl+o to expand)',
  "[✓●!] [^ ]|[✓●!] {3}",
], "Subagent focused Ctrl+O tool and notification visual tests");
const providerSchemaTests = read("tests/provider-schema.test.mjs");
hasAll(providerSchemaTests, [
  "goalParameters", "loopParameters", "monitorParameters", "subagentParameters", "contactSupervisorParameters", "todoParameters",
  'schema.type, "object"', 'schema.additionalProperties, false', "schema.anyOf, undefined", "schema.oneOf, undefined",
  "operationBranches", 'branch.type, "object"', "branch.additionalProperties, false", "modify.minProperties, undefined",
], "provider schema JSON audit");
const monitorTests = read("tests/monitor.test.mjs");
hasAll(monitorTests, [
  "real detached descendant holding a pipe cannot block sequential delete",
  "delete and shutdown isolate EPERM or unknown process-group errors",
  "bounded recent-line ring without reading the JSONL file",
  "status scans JSONL from the tail in chunks",
  "write, rename, and rollover reopen failures",
  "deleting one monitor rebuilds a gated global rate summary",
  "partial-line truncation reports dropped UTF-8 bytes",
  "matcher and terminal payloads include abstract",
  "hasBlockingWork()",
], "Monitor focused process, logging, delivery, payload, and Goal-reservation tests");
const monitorUiTests = read("tests/monitor-ui.test.mjs");
hasAll(monitorUiTests, [
  "exact heading, glyphs, running/terminal order, overflow, width safety, and empty state",
  "throttles and coalesces output", "registers once", "invalidate a no-op", "rebinds", "disposes",
  "all four actions", "uniform hints", "full operational state", "forced warnings", "global summary notifications",
  "matched 2 (ctrl+o to expand)", "rate limited (ctrl+o to expand)", '${status} (ctrl+o to expand)',
  "fallbacks and errors sanitize controls", "model-facing list data invariant", "without a TUI context",
  "narrow.map((line) => stripVTControlCharacters(line))", '"printf done"',
  "├─ ↻  running first", "[↻!×✓●] [^ ]|[↻!×✓●] {3}", "↻  Monitor [00000001]",
], "Monitor focused widget, Ctrl+O, result, notification, fallback, invariant, and RPC visual tests");
const loopLoadTests = read("tests/loop-load.test.mjs");
hasAll(loopLoadTests, [
  "real Pi isolated RPC main and child sessions expose exact package tools without widgets",
  '["ask_user_question", "goal", "loop", "monitor", "subagent", "todo"]', '["contact_supervisor", "todo"]',
  'events.some((event) => event.type === "extension_ui_request" && event.method === "setWidget")',
  "real Pi RPC Ask dialog completes through native extension UI without a model call", "ASK_RPC_PROBE ",
  'event.method === "select"', '"Option 1: Safe"', '"Done with this question"',
  "real Pi RPC forwards Loop and Goal slash text once as extension input without command recursion or a model call",
  '"/loop   review the exact raw request"', '"/goal   deliver the exact frozen core"', 'source: "extension"',
], "Loop and Goal isolated real-Pi main, child, widget, and slash forwarding smoke");
const goalTests = read("tests/goal.test.mjs");
const goalUiTests = read("tests/goal-ui.test.mjs");
hasAll(goalTests, [
  "Goal schema is a strict portable object", "create, modify, terminal replacement", "status and repeated pause or resume no-ops", "retry-success cleanup is internally guarded", "snapshot replay is strict",
  "phase and model-facing continuation text", "continuation waits for the full safe gate", "provider failures use unbounded frozen backoff",
  "user abort pauses, host abort does not", "no-progress counts only automatic continuation runs", "ownership and Goal view stats",
  "slash command resends a real user message", "continuationNumber", "refreshUI()",
], "Goal focused durable state, lifecycle, gate, retry, abort, ownership, stats, numbering, and registration tests");
hasAll(goalUiTests, [
  "five statuses, exact two-line order, stats, elapsed, retry, paused reason, width, and empty state",
  "one shared 1s timer", "Component.invalidate is a no-op", "caches branch stats across timer ticks", "RPC or print widget",
  "all seven calls", "uniform collapsed hints", "status none/goal", "pause/resume no-change", "evidence, cancel, retry fields",
  "continuation and state notifications", "fallback hints", "data invariance", "continuation 7 (ctrl+o to expand)",
  "no_progress: no_progress (ctrl+o to expand)", "●  Goal · ↻  active", "[↻Ⅱ◷✓×●] [^ ]|[↻Ⅱ◷✓×●] {3}", "continuationWide",
], "Goal focused widget, lifecycle, Ctrl+O, result, notification, fallback, invariant, and RPC visual tests");
for (const file of ["tests/loop.test.mjs", "tests/provider-schema.test.mjs", "tests/subagent-runtime.test.mjs"]) {
  hasAll(read(file), ["./goal-runtime.js", "./goal-transcript-renderer.js", "./goal-widget.js"], `${file} Goal TypeScript load mappings`);
}
hasAll(todoTests, [
  "PI_CODING_AGENT_DIR", '"--no-extensions"', '"--extension", join(root, "extensions/todo/index.ts")',
  "TODO_LOAD_PROBE", "runtime not initialized", "executionMode", "setWidget",
  'rootType: "object"', "rootHasUnion: false", "Todo execute enforces action-specific operations boundaries",
  "multiple items can become in_progress", "parseTodoSnapshot(snapshot)?.state.tasks",
], "Todo isolated real-Pi load smoke and multiple-active contract");

for (const file of ["README.md", "README.zh-CN.md"]) {
  const text = read(file);
  const english = file === "README.md";
  const section = (startHeading, endHeading) => {
    const start = text.indexOf(startHeading);
    const end = text.indexOf(endHeading, start + startHeading.length);
    check(start >= 0 && end > start, `${file} must contain ordered sections ${startHeading} and ${endHeading}`);
    return text.slice(start, end);
  };
  const tableItems = (value) => [...value.matchAll(/^\| `([^`]+)` \|/gm)].map((match) => match[1]);
  const expectTableItems = (label, value, expected) => {
    check(JSON.stringify(tableItems(value)) === JSON.stringify(expected), `${file} ${label} action list must be exact`);
  };

  const headings = [...text.matchAll(/^#{2,3} .+$/gm)].map((match) => match[0]);
  const expectedHeadings = english
    ? [
        "## Highlights", "## Six specialists", "## Requirements and package management", "### Requirements", "### Install",
        "### Migrate from external Ask and Process packages", "### Update", "### Remove", "## Tool availability", "## Main tools",
        "### `subagent`", "### `todo`", "### `loop`", "### `monitor`", "### `ask_user_question`", "### `goal`",
        "## `/loop` and `/goal`", "## Presets and configuration", "## Runtime, UI, and persistence", "## Deliberate scope",
        "## Development", "## License",
      ]
    : [
        "## 核心特性", "## 六个 specialist", "## 要求与包管理", "### 要求", "### 安装",
        "### 从外部 Ask 与 Process package 迁移", "### 更新", "### 移除", "## 工具可用性", "## Main 工具",
        "### `subagent`", "### `todo`", "### `loop`", "### `monitor`", "### `ask_user_question`", "### `goal`",
        "## `/loop` 与 `/goal`", "## Preset 与配置", "## Runtime、UI 与持久化", "## 有意限制",
        "## 开发", "## License",
      ];
  check(JSON.stringify(headings) === JSON.stringify(expectedHeadings), `${file} heading structure must stay aligned`);

  hasAll(text, [
    "pi install git:github.com/YanzuoLu/oh-my-pi-slim",
    "pi update --extension git:github.com/YanzuoLu/oh-my-pi-slim",
    "pi remove git:github.com/YanzuoLu/oh-my-pi-slim",
    "pi remove npm:@juicesharp/rpiv-ask-user-question",
    "pi remove npm:@aliou/pi-processes",
    "ask_user_question", "goal", "loop", "monitor", "subagent", "todo", "contact_supervisor",
    "need_decision", "interview_request", "progress_update",
    "10s", "7d", "nohup", "setsid", "disown", "blockedBy", "Ctrl+O",
    "~/.pi/agent/oh-my-pi-slim.json", "provider", "model", "thinking",
    "npm test", "npm run validate", "git diff --check", "MIT",
  ], `${file} public README contract`);

  hasAll(text, english
    ? [
        "Exactly `subagent`, `todo`, `loop`, `monitor`, `ask_user_question`, and `goal`",
        "Exactly `contact_supervisor` and `todo`",
        "never automatically uninstalls external packages",
        "every retained run", "running and waiting runs by creation time", "terminal runs by latest update", "final `output` and `error`", "same retained set",
        "refused while any run is `starting`, `running`, or `waiting`",
        "saved child session as a new run with a new ID", "continue that same run",
        "matched exactly", "atomic", "still names the target in `blockedBy`",
        "runtime-only fixed-delay", "reload, new session, session resume, fork, or quit",
        "case-sensitive literal matching", "remain available until `delete`", "Use `status`",
        "one to four questions", "single-select", "multi-select", "custom responses", "previews", "unavailable while a Goal is active",
        "branch-local durable Goal", "restore unfinished work as paused", "one non-empty evidence item for each criterion",
        "active or waiting subagents", "Monitor work", "waiting Ask dialog",
        "safely queued during compaction and tree operations", "collapsed and expanded views", "compact widgets",
        "successful subagent `clear` remains clear after reload",
      ]
    : [
        "精确为 `subagent`、`todo`、`loop`、`monitor`、`ask_user_question`、`goal`",
        "精确为 `contact_supervisor` 与 `todo`",
        "不会自动卸载外部 package",
        "全部 retained run", "按创建时间返回 running 与 waiting run", "按最新更新时间返回 terminal run", "最终 `output` 和 `error`", "完全相同的 retained 集合",
        "存在 `starting`、`running` 或 `waiting` run，`clear` 就会被拒绝",
        "保存的 child session 创建新 run，并生成新 ID", "继续同一个 run",
        "使用 exact match", "原子的", "仍在 `blockedBy` 中引用目标",
        "runtime-only fixed-delay", "reload、new session、session resume、fork 或 quit",
        "区分大小写的 literal match", "一直保留到 `delete`", "用 `status`",
        "一到四个 question", "single-select", "multi-select", "custom response", "preview", "Goal active 时不可用",
        "branch-local durable Goal", "恢复为 paused", "每条 criterion 必须精确对应一条非空 evidence",
        "active 或 waiting subagent", "Monitor 工作", "waiting Ask dialog",
        "compaction 与 tree operation 期间", "collapsed/expanded", "紧凑 widget",
        "subagent `clear` 在 reload 后仍保持清空",
      ], `${file} visible behavior contract`);

  const subagent = section("### `subagent`", "### `todo`");
  const todo = section("### `todo`", "### `loop`");
  const loop = section("### `loop`", "### `monitor`");
  const monitor = section("### `monitor`", "### `ask_user_question`");
  const goal = section("### `goal`", english ? "## `/loop` and `/goal`" : "## `/loop` 与 `/goal`");
  expectTableItems("subagent", subagent, ["create", "list", "interrupt", "steer", "resume", "reply", "clear"]);
  expectTableItems("Todo", todo, ["list", "update", "append", "modify", "delete", "clear"]);
  expectTableItems("Loop", loop, ["create", "delete", "modify", "list", "pause", "resume"]);
  expectTableItems("Monitor", monitor, ["create", "delete", "list", "status"]);
  expectTableItems("Goal", goal, ["create", "modify", "status", "pause", "resume", "complete", "cancel"]);

  hasNone(text, [
    "RpcClient", "launch.json", "state.json", "control/", "setImmediate", "compaction_end", "triggerTurn: true", 'deliverAs: "steer"',
    "64 MiB", "32 MiB", "64 KiB", "100 ms", "mode-0600", "appendEntry", "retry_wait", "10 s, 30 s",
    "replacement wins", "Goal-owned", "file-tool nudge", "notification ACK", "acknowledgement",
  ], `${file} excludes internal implementation detail`);
  check(!/(waitingSeq|deliveryKey|instanceKey|generation|notificationCursor|sidecar|timer[ -]?token|journal version|version[- ]?[123])/i.test(text), `${file} must not expose internal persistence or delivery terms`);
  check(!text.includes(REMOVED_WAIT_TOOL), `${file} must not mention the removed wait tool`);
}

const widget = read("extensions/oh-my-pi-slim/subagent-widget.ts");
const widgetRenderer = read("extensions/oh-my-pi-slim/subagent-widget-renderer.ts");
const widgetDisplay = read("extensions/oh-my-pi-slim/subagent-widget-display.ts");
const modelDisplay = read("extensions/oh-my-pi-slim/subagent-model-display.ts");
const transcriptRenderer = read("extensions/oh-my-pi-slim/subagent-transcript-renderer.ts");
hasAll(widget, ["setIntervalFn(() => this.update(), 80)", "requestRender()", 'placement: "aboveEditor"', "widgetRegistered", "dispose()"], "subagent widget lifecycle");
hasNone(widget, ["finishedTurnAge", "shouldShowFinished", "ERROR_LINGER_TURNS", "seedFinishedRuns"], "retained-run widget parity");
hasNone(widgetRenderer, ["shouldShowFinished"], "retained-run widget renderer parity");
hasAll(widgetDisplay, ['formatSemanticGlyphPrefix(SUBAGENT_WIDGET_GLYPHS.turns)'], "subagent turn glyph fixed semantic padding");
check(!/pi\.on\("tool_execution_start"[\s\S]{0,120}subagents\.onTurnStart/.test(extension), "widget turn aging must not bind to tool_execution_start");
hasAll(widgetRenderer, [
  "MAX_SUBAGENT_WIDGET_LINES = 12", '"├─"', '"└─"', "renderSubagentWidgetLines", "waiting",
  "formatWidgetModel", "formatSubagentModel", "run.model", "formatWidgetTurns", "formatWidgetSessionTokens",
  "describeWidgetActivity", "activeLines.length * 3", "queuedLines.length", "budget >= 3", "run.abstract", "shortAbstract",
  "sortRetainedSubagentRuns(runs)", "lines.push(...sections.queuedLines, ...sections.finishedLines)",
], "subagent widget renderer");
hasNone(widgetRenderer, ["run.task", "shortTask"], "abstract-only widget labels");
hasAll(modelDisplay, ["THINKING_LEVELS", "formatSubagentModel", '"xhigh"', '"max"'], "subagent model display formatter");
hasAll(transcriptRenderer, [
  "Container", "Box", "Text", "Markdown", "Spacer", "getMarkdownTheme", "RAW_HTML_TAG",
  "renderSubagentCall", "renderSubagentResult", "styledTitle(", '"subagent"',
  '`· ${action}${expanded ? "" : " (ctrl+o to expand)"}`',
  "renderSubagentNotification", "details?.run", "details?.runs", "details?.request",
  "ExpandableNotificationLine", 'theme.fg("muted", " (ctrl+o to expand)")', "visibleWidth(this.hint)",
  'actionFromContext(context, "create")',
  "immediateAck", "renderRunList", "addFinalOutput", "spacedToolResult", '"Live response"',
  '"Retained subagent run status"', "run.abstract", "run.reason", 'addField(container, theme, "Abstract", args.abstract',
  "clearReceipt", "details.clearedCount", "details.warnings", "details.changed === true", "addCompactSummary",
  "expanded?: boolean", "context.expanded === true", "options.expanded === true", "terminal && expanded",
  "fallbackResult(result, theme, options.isPartial === true, expanded)",
], "subagent transcript renderer");
hasNone(transcriptRenderer, [
  "gotgenes", "Nico", "preview", "truncated", '"Subagent result"', "renderRunSection", "addActivity",
  "renderSupervisorCall", "renderSupervisorResult", "subagent_supervisor", "replyTo", '"Action"',
], "subagent transcript renderer ownership and focused-output contract");
for (const [name, source] of [
  ["Subagent", transcriptRenderer],
  ["Loop", loopTranscriptRenderer],
  ["Monitor", monitorTranscriptRenderer],
  ["Goal", goalTranscriptRenderer],
]) {
  hasAll(source, [
    "ExpandableNotificationLine", 'theme.fg("muted", " (ctrl+o to expand)")',
    "options.expanded === true", "truncateToWidth", "visibleWidth(this.hint)",
  ], `${name} package-owned expandable notification hint contract`);
}
const listRendererStart = transcriptRenderer.indexOf("function renderRunList");
const listRendererEnd = transcriptRenderer.indexOf("export function renderSubagentCall", listRendererStart);
const listRenderer = transcriptRenderer.slice(listRendererStart, listRendererEnd);
hasAll(listRenderer, [
  "styledTitle", "compactRunHeader", "undefined, true", '!expanded || status !== "waiting"', "run.reason",
  "TERMINAL_STATUSES.has(status)", "addFinalOutput(container, theme, run)",
  'addCompactSummary(container, theme, "Output", run.output)', 'addCompactSummary(container, theme, "Error", run.error)',
], "retained-run list renderer");
hasNone(listRenderer, ["addLiveActivity", "addRequest", "run.task", "run.cwd", "run.model", "run.deniedTools", "run.activity", "run.request)"], "retained-run list renderer");
const notificationStart = transcriptRenderer.indexOf("export function renderSubagentNotification");
const notificationHeader = transcriptRenderer.indexOf("container.addChild(compactRunHeader", notificationStart);
const notificationExpanded = transcriptRenderer.indexOf("if (options.expanded === true)", notificationHeader);
const notificationTerminal = transcriptRenderer.indexOf("if (TERMINAL_STATUSES.has(event))", notificationExpanded);
const notificationWaiting = transcriptRenderer.indexOf('else if (event === "waiting")', notificationTerminal);
const notificationLive = transcriptRenderer.indexOf("else if (LIVE_STATUSES.has(event)", notificationWaiting);
check(
  notificationStart >= 0 && notificationHeader > notificationStart && notificationExpanded > notificationHeader &&
  notificationTerminal > notificationExpanded && notificationWaiting > notificationTerminal && notificationLive > notificationWaiting &&
  transcriptRenderer.slice(notificationTerminal, notificationWaiting).includes("addFinalOutput") &&
  !transcriptRenderer.slice(notificationTerminal, notificationWaiting).includes("addLiveActivity"),
  "notification details must render only inside the options.expanded branch",
);
hasAll(runtime, [
  "registerMessageRenderer(SUBAGENT_NOTIFICATION_TYPE, renderSubagentNotification)",
  "renderCall: renderSubagentCall", "renderResult: renderSubagentResult",
  "display: true", "run: this.formatRun(run)", "event,",
], "subagent transcript registration and visible notification contract");
check(!runtime.includes('renderShell: "self"'), "subagent transcript tools must use the default tool shell");
check(existsSync(join(ROOT, "THIRD_PARTY_NOTICES.md")), "third-party notice must exist for the adapted widget");

const preset = json("config/oh-my-pi-slim.example.json");
check(Boolean(preset.presets?.[preset.defaultPreset]), "default preset must exist");
for (const [presetName, value] of Object.entries(preset.presets ?? {})) {
  check(JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...ROLES].sort()), `${presetName} must define exactly seven roles`);
  for (const role of ROLES) {
    check(typeof value[role]?.provider === "string" && value[role].provider, `${presetName}.${role}.provider must be non-empty`);
    check(typeof value[role]?.model === "string" && value[role].model, `${presetName}.${role}.model must be non-empty`);
    check(THINKING.has(value[role]?.thinking), `${presetName}.${role}.thinking is invalid`);
  }
  check(JSON.stringify(value.observer) === JSON.stringify(value.explorer), `${presetName}.observer must explicitly copy explorer in the bundled preset`);
}
check(JSON.stringify(Object.keys(preset.deny ?? {}).sort()) === JSON.stringify([...AGENTS].sort()), "bundled deny must define exactly the six specialists");
for (const role of AGENTS) check(Array.isArray(preset.deny?.[role]) && preset.deny[role].length === 0, `bundled deny.${role} must default to []`);

check(existsSync(join(ROOT, "tests/subagent-runtime.test.mjs")), "runtime test file must exist");
const packCheck = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
check(packCheck.status === 0, `npm pack --dry-run failed:\n${packCheck.stderr}`.trim());
if (packCheck.status === 0) {
  try {
    const packed = JSON.parse(packCheck.stdout);
    const files = packed[0]?.files?.map((entry) => entry.path) ?? [];
    check(files.includes("extensions/oh-my-pi-slim/runner/omps-runner.mjs"), "npm pack must include the detached runner");
    check(files.includes("extensions/oh-my-pi-slim/subagent-checkpoint.ts"), "npm pack must include the shared checkpoint helper");
    check(files.includes("extensions/oh-my-pi-slim/runner/rpc-child.mjs"), "npm pack must include the runner RPC child helper");
    check(files.includes("extensions/oh-my-pi-slim/subagent-model-display.ts"), "npm pack must include the shared subagent model formatter");
    check(files.includes("extensions/oh-my-pi-slim/semantic-glyph.ts"), "npm pack must include the shared semantic glyph helper");
    check(files.includes("extensions/oh-my-pi-slim/subagent-transcript-renderer.ts"), "npm pack must include the subagent transcript renderer");
    check(files.includes("extensions/oh-my-pi-slim/loop-runtime.ts"), "npm pack must include the Loop runtime");
    check(files.includes("extensions/oh-my-pi-slim/loop-widget.ts"), "npm pack must include the Loop widget");
    check(files.includes("extensions/oh-my-pi-slim/loop-transcript-renderer.ts"), "npm pack must include the Loop transcript renderer");
    check(files.includes("extensions/oh-my-pi-slim/ask-runtime.ts"), "npm pack must include the Ask runtime");
    check(files.includes("extensions/oh-my-pi-slim/ask-tui.ts"), "npm pack must include the Ask TUI");
    check(files.includes("extensions/oh-my-pi-slim/ask-transcript-renderer.ts"), "npm pack must include the Ask transcript renderer");
    check(files.includes("extensions/oh-my-pi-slim/monitor-runtime.ts"), "npm pack must include the Monitor runtime");
    check(files.includes("extensions/oh-my-pi-slim/monitor-widget.ts"), "npm pack must include the Monitor widget");
    check(files.includes("extensions/oh-my-pi-slim/monitor-transcript-renderer.ts"), "npm pack must include the Monitor transcript renderer");
    check(files.includes("extensions/oh-my-pi-slim/goal-runtime.ts"), "npm pack must include the Goal runtime");
    check(files.includes("extensions/oh-my-pi-slim/goal-widget.ts"), "npm pack must include the Goal widget");
    check(files.includes("extensions/oh-my-pi-slim/goal-transcript-renderer.ts"), "npm pack must include the Goal transcript renderer");
    check(files.includes("extensions/oh-my-pi-slim/subagent-run-files.ts"), "npm pack must include the Goal stats sidecar helper");
    check(files.includes("extensions/oh-my-pi-slim/subagent-runtime.ts"), "npm pack must include the Goal child ownership and sidecar runtime");
    check(files.includes("tests/loop.test.mjs"), "npm pack must include the Loop core tests");
    check(files.includes("tests/loop-ui.test.mjs"), "npm pack must include the Loop visual tests");
    check(files.includes("tests/loop-load.test.mjs"), "npm pack must include the Loop real-Pi load tests");
    check(files.includes("tests/fixtures/omps-load-probe.ts"), "npm pack must include the OMPS real-Pi load probe");
    check(files.includes("tests/fixtures/ask-rpc-probe.ts"), "npm pack must include the Ask native RPC dialog probe");
    check(files.includes("tests/fixtures/stub-pi-rpc.mjs"), "npm pack must include the detached RPC fixture used by Goal stats tests");
    check(files.includes("tests/ask-runtime.test.mjs"), "npm pack must include the Ask runtime tests");
    check(files.includes("tests/ask-ui.test.mjs"), "npm pack must include the Ask TUI tests");
    check(files.includes("tests/ask-transcript-renderer.test.mjs"), "npm pack must include the Ask transcript tests");
    check(files.includes("tests/monitor.test.mjs"), "npm pack must include the Monitor runtime tests");
    check(files.includes("tests/monitor-ui.test.mjs"), "npm pack must include the Monitor UI tests");
    check(files.includes("tests/goal.test.mjs"), "npm pack must include the Goal runtime tests");
    check(files.includes("tests/goal-ui.test.mjs"), "npm pack must include the Goal UI tests");
    check(files.includes("tests/subagent-runtime.test.mjs"), "npm pack must include the Goal child stats sidecar tests");
    check(files.includes("extensions/todo/index.ts"), "npm pack must include the Todo extension entry");
    check(files.includes("extensions/todo/core.ts"), "npm pack must include the Todo state core");
    check(files.includes("extensions/todo/widget.ts"), "npm pack must include the Todo widget");
    check(files.includes("tests/todo.test.mjs"), "npm pack must include the Todo contract tests");
    check(files.includes("tests/fixtures/todo-load-probe.ts"), "npm pack must include the Todo real-Pi load probe");
    check(files.includes("agents/observer.md"), "npm pack must include the Observer role");
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
