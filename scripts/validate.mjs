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

function checkSteSentence(sentence, label) {
  const words = sentence.match(/[A-Za-z0-9_]+(?:-[A-Za-z0-9_]+)*/g) ?? [];
  check(words.length <= 20, `${label} exceeds 20 words: ${sentence}`);
  check(!sentence.includes(";"), `${label} contains a semicolon: ${sentence}`);
  check(!/\b(?:is|are|was|were|be|been|being)\s+\w+(?:ed|en)\b/i.test(sentence), `${label} does not use active voice: ${sentence}`);
  check(/^(?:Use|Add|Remove|Read|Expect|Do not|Resume|For|In|After|Before|Wait|Continue|Complete|Create|Reply|Select|Provide|Apply|Ask|Allow|Describe|Pause|Cancel)\b/.test(sentence), `${label} does not start with an instruction or condition: ${sentence}`);
}

function checkSteBlock(block, label) {
  const sentences = block.split(/(?<=[.!?])\s+/).filter(Boolean);
  check(sentences.length > 0, `${label} must contain text`);
  for (const sentence of sentences) checkSteSentence(sentence, label);
}

function checkSteGuidelines(guidelines, label) {
  check(guidelines.length > 0, `${label} must be statically readable`);
  for (const guideline of guidelines) {
    const sentences = guideline.split(/(?<=[.!?])\s+/).filter(Boolean);
    check(sentences.length === 1, `${label} must use one sentence per guideline: ${guideline}`);
    checkSteSentence(guideline, label);
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

check(packageJson.version === "0.10.0", "package version must be 0.10.0");
check(packageJson.description === "Preset-driven Pi orchestration with built-in subagents, loops, monitors, structured questions, durable goals, and session todos.", "package description must cover all built-in runtime surfaces");
check(["pi-package", "pi", "orchestration", "subagents", "loops", "monitoring", "ask-user-question", "goals", "todos", "scheduling"].every((keyword) => packageJson.keywords?.includes(keyword)), "package keywords must include Monitor, Ask, Goal, Loop, subagent, and Todo discovery terms");
check(lock.version === "0.10.0" && lock.packages?.[""]?.version === "0.10.0", "package-lock version must be 0.10.0");
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
  "GOAL_WIDGET_KEY", "renderGoalWidgetLines", 'theme.bold("● Goal")', '"↻"', '"Ⅱ"', '"◷"', '"✓"', '"×"',
  '`${view.continuationCount} cont`', 'countLabel(view.ownedChildRunCount, "run")', 'statsLabel("main"', 'statsLabel("child"',
  'setIntervalFn(() => {', "1_000", "unref?.()", "requestRender()", "truncateToWidth", "visibleWidth", "invalidate() {}", 'placement: "aboveEditor"',
  "sanitizeGoalText", "sanitizeGoalBody", "dispose()",
], "Goal fixed two-line width-safe cached widget contract");
hasNone(goalWidget, ["\\u001b[", "registerShortcut", "setStatus("], "Goal widget theme-only contract");
hasAll(goalTranscriptRenderer, [
  "renderGoalCall", "renderGoalResult", "renderGoalContinuation", "renderGoalState", 'theme.bold("goal")',
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
check(goalSchemaDescriptions.length === 6, "Goal schema must define six field descriptions");
for (const description of goalSchemaDescriptions) checkSteBlock(description, "Goal schema description");
hasAll(goalSchema, [
  'action: Type.Union(GOAL_ACTIONS.map((action) => Type.Literal(action))',
  "minItems: 1", "maxItems: 8",
  'description: "For create or modify, provide from one through eight completion criteria."',
  'description: "For complete, provide one evidence item per completion criterion."',
], "Goal schema actions, fields, and limits");
const goalToolStart = goalRuntime.indexOf('name: "goal"');
const goalGuidelinesStart = goalRuntime.indexOf("promptGuidelines: [", goalToolStart);
const goalGuidelinesEnd = goalRuntime.indexOf("      ],", goalGuidelinesStart);
const goalToolMetadata = goalRuntime.slice(goalToolStart, goalGuidelinesEnd);
const goalDescription = propertyString(goalToolMetadata, "description", "Goal tool metadata");
const goalPromptSnippet = propertyString(goalToolMetadata, "promptSnippet", "Goal tool metadata");
checkSteBlock(goalDescription, "Goal description");
checkSteBlock(goalPromptSnippet, "Goal promptSnippet");
const goalGuidelines = staticStrings(goalRuntime.slice(goalGuidelinesStart, goalGuidelinesEnd), "Goal promptGuidelines");
check(goalGuidelines.length === 11, "Goal promptGuidelines must keep the complete 11-sentence model contract");
checkSteGuidelines(goalGuidelines, "Goal promptGuideline");
hasAll(goalGuidelines.join("\n"), [
  "Use only `action`, `abstract`, `objective`, and `criteria` for `create` or `modify`.",
  "Use only `action` for `status` or `resume`.",
  "Use only `action` and `reason` for `pause` or `cancel`.",
  "Use only `action` and `evidence` for `complete`.",
  "Use `create` only when the latest user message starts with `/goal`.",
  "Do not create Goals from ordinary natural-language requests.",
  "For a bare `/goal`, call `status` and explain `/goal <objective>`.",
  "Use `modify` for an existing nonterminal Goal and provide its complete replacement contract.",
  "Pause the Goal when a blocker prevents further progress.",
  "Cancel the Goal only when the user explicitly requests cancellation.",
  "Complete the Goal only with one evidence item per completion criterion.",
], "Goal promptGuidelines action and lifecycle semantics");
hasNone(`${goalDescription}\n${goalPromptSnippet}\n${goalGuidelines.join("\n")}\n${goalSchemaDescriptions.join("\n")}`, [
  "instanceKey", "generation", "deliveryKey", "cursor", "sidecar", "revision", "goalId", "ownedRunIds", "statistics",
], "Goal model metadata private boundary");
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
checkSteGuidelines(askGuidelines, "Ask promptGuideline");
check(askGuidelines.length === 10, "Ask promptGuidelines must keep the complete 10-sentence model contract");
hasAll(askGuidelines.join("\n"), [
  "Use ask_user_question for ordinary user decisions.",
  "Provide from one through four questions.",
  "Provide from two through four options for each question.",
  "For a recommended option, place it first and append `(Recommended)` to its label.",
  "Expect the user to select an authored option or provide a custom response.",
  "Use `multiSelect` only when the user may choose multiple authored options.",
  "Use `preview` only for single-select options.",
  "Expect active Goals to make ask_user_question unavailable.",
], "Ask promptGuidelines external contract");
const askSchemaStart = askRuntime.indexOf("const askOptionSchema");
const askSchemaEnd = askRuntime.indexOf("export interface AskOption", askSchemaStart);
const askSchema = askRuntime.slice(askSchemaStart, askSchemaEnd);
const askSchemaDescriptions = [...askSchema.matchAll(/description:\s*("(?:\\.|[^"\\])*")/g)].map((match) => JSON.parse(match[1]));
check(askSchemaDescriptions.length === 8, "Ask schema must define eight field descriptions");
for (const description of askSchemaDescriptions) checkSteBlock(description, "Ask schema description");
hasAll(askSchema, [
  "minItems: 1", "maxItems: 4", "minItems: 2", "maxLength: 16", "maxLength: 60",
  'description: "For single-select only, provide optional preview content."',
  'description: "Allow selection of multiple authored options."',
], "Ask schema question, option, preview, and selection limits");
const askToolStart = askRuntime.indexOf("name: ASK_TOOL_NAME");
const askToolMetadata = askRuntime.slice(askToolStart, askRuntime.indexOf("parameters: askUserQuestionParameters", askToolStart));
const askDescription = propertyString(askToolMetadata, "description", "Ask tool metadata");
const askPromptSnippetMatch = /export const ASK_PROMPT_SNIPPET = ("(?:\\.|[^"\\])*")/.exec(askRuntime);
const askPromptSnippet = askPromptSnippetMatch ? JSON.parse(askPromptSnippetMatch[1]) : "";
check(Boolean(askPromptSnippetMatch), "Ask tool metadata must define a static promptSnippet");
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
  "Create or manage specialist runs by ID.",
  "For `create`, use `abstract` for a short run summary.",
  "For `create`, use `task` for the complete objective.",
  "Use only `action`, `id`, `abstract`, and `message` for `resume`.",
  "Use only `action`, `id`, and `message` for `reply`.",
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
  "MONITOR_RENDER_THROTTLE_MS = 110", 'theme.bold(`● Monitors (${running}/${sorted.length})`)', '"↻"', '"✓"', '"!"', '"×"',
  "sortMonitorsForDisplay", "createdAt", "endedAt", 'theme.fg("dim", `… ${hidden} more`)', "lines.slice(0, MAX_MONITOR_WIDGET_LINES)",
  'placement: "aboveEditor"', "change.reason === \"output\"", "scheduleRender()", "requestRender()", "invalidate() {}", "dispose()",
], "Monitor foreground widget visual and throttle contract");
hasNone(monitorWidget, ["notify(", "setStatus", "registerShortcut", "overlay", "setInterval("], "Monitor widget excluded UI");
hasAll(monitorTranscriptRenderer, [
  "renderMonitorCall", "renderMonitorResult", "renderMonitorNotification", 'theme.bold("monitor")',
  '`· ${safeAction}${expanded ? "" : " (ctrl+o to expand)"}`', "spacedResult", "safeFirstLine", "sanitizeMonitorBody",
  'theme.bold(`● Monitors (${running}/${monitors.length})`)', "renderOperationalState", 'addCombinedLines(container, theme, "Combined lines"',
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
check(monitorSchemaDescriptions.length === 8, "Monitor schema must define eight field descriptions");
for (const description of monitorSchemaDescriptions) checkSteBlock(description, "Monitor schema description");
const monitorToolStart = monitorRuntime.indexOf('name: "monitor"');
const monitorGuidelinesStart = monitorRuntime.indexOf("promptGuidelines: [", monitorToolStart);
const monitorGuidelinesEnd = monitorRuntime.indexOf("      ],", monitorGuidelinesStart);
const monitorToolMetadata = monitorRuntime.slice(monitorToolStart, monitorGuidelinesEnd);
const monitorDescription = propertyString(monitorToolMetadata, "description", "Monitor tool metadata");
const monitorPromptSnippet = propertyString(monitorToolMetadata, "promptSnippet", "Monitor tool metadata");
checkSteBlock(monitorDescription, "Monitor description");
checkSteBlock(monitorPromptSnippet, "Monitor promptSnippet");
const monitorGuidelines = staticStrings(monitorRuntime.slice(monitorGuidelinesStart, monitorGuidelinesEnd), "Monitor promptGuidelines");
check(monitorGuidelines.length === 10, "Monitor promptGuidelines must keep the complete 10-sentence model contract");
checkSteGuidelines(monitorGuidelines, "Monitor promptGuideline");
hasAll(monitorGuidelines.join("\n"), [
  "Use `monitor` for long-running commands that should continue while Pi works.",
  "Provide a foreground command and let monitor own its process group.",
  "Do not use nohup, setsid, disown, a trailing ampersand, or another daemon escape.",
  "After a terminal notification, use `status` to inspect results and then use `delete`.",
  "Do not poll running monitors.",
  "Use ordinary `status` reverse pagination to inspect additional log lines.",
  "Use only `action`, `abstract`, `command`, optional `cwd`, and optional `notifyOn` for `create`.",
  "Use only `action` and `id` for `delete`.",
  "Use only `action` for `list`.",
  "Use only `action`, `id`, optional `start`, and optional `end` for `status`.",
], "Monitor promptGuidelines actions and operational boundary");
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
  'theme.bold(`● Loops (${active}/${sorted.length})`)', '"↻"', '"Ⅱ"', '"!"',
  'parts.push(`next in ${formatLoopCountdown', 'parts.push("paused", fireLabel', "failureLabel(loop.failureCount)",
  "sortLoopsForDisplay", "nextFireAt", "createdAt", 'setIntervalFn(() => this.update(), 1_000)',
  "requestRender()", 'placement: "aboveEditor"', "stopTimer()", "dispose()", 'setWidget(LOOP_WIDGET_KEY, undefined)',
  'theme.fg("dim", `… ${hidden} more`)', "lines.slice(0, MAX_LOOP_WIDGET_LINES)",
], "Loop foreground widget visual contract");
hasNone(loopWidget, ["notify(", "registerShortcut", "custom(", "overlay"], "Loop widget excluded UI");
hasAll(loopTranscriptRenderer, [
  "renderLoopCall", "renderLoopResult", "renderLoopFire", "styledTitle(", '"loop"',
  '`· ${action}${expanded ? "" : " (ctrl+o to expand)"}`',
  "context.expanded === true", "options.expanded === true", "spacedResult", "safeFirstLine", "sanitizeLoopBody",
  'theme.bold(`● Loops (${active}/${sorted.length})`)', "addCompleteLoop", 'addSection(container, theme, "Prompt"',
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
check(loopSchemaDescriptions.length === 5, "Loop schema must define five field descriptions");
for (const description of loopSchemaDescriptions) checkSteBlock(description, "Loop schema description");
const loopToolStart = loopRuntime.indexOf('name: "loop"');
const loopGuidelinesStart = loopRuntime.indexOf("promptGuidelines: [", loopToolStart);
const loopGuidelinesEnd = loopRuntime.indexOf("      ],", loopGuidelinesStart);
const loopToolMetadata = loopRuntime.slice(loopToolStart, loopGuidelinesEnd);
const loopDescription = propertyString(loopToolMetadata, "description", "Loop tool metadata");
const loopPromptSnippet = propertyString(loopToolMetadata, "promptSnippet", "Loop tool metadata");
check(loopDescription === "Create and manage runtime-only repeating fixed-delay prompts.", "Loop description must state runtime-only repeating fixed-delay semantics");
check(loopPromptSnippet === "Create or manage runtime-only repeating fixed-delay prompts by loop ID.", "Loop promptSnippet must state runtime-only repeating fixed-delay semantics");
checkSteBlock(loopDescription, "Loop description");
checkSteBlock(loopPromptSnippet, "Loop promptSnippet");
const loopGuidelines = staticStrings(loopRuntime.slice(loopGuidelinesStart, loopGuidelinesEnd), "Loop promptGuidelines");
check(loopGuidelines.length === 18, "Loop promptGuidelines must keep the complete 18-sentence model contract");
checkSteGuidelines(loopGuidelines, "Loop promptGuideline");
hasAll(loopGuidelines.join("\n"), [
  "Use only `action`, `interval`, `abstract`, and `prompt` for `create`.",
  "Use only `action` and `id` for `delete`, `pause`, or `resume`.",
  "Use only `action`, `id`, and optional `interval`, `abstract`, or `prompt` for `modify`.",
  "Use only `action` for `list`.",
  "For `modify`, provide at least one of `interval`, `abstract`, or `prompt`.",
  "Expect a missing or unknown `id` to return an error.",
  "Expect repeated `pause` or `resume` actions to return no change.",
  "Use `create` only when the latest user message starts with `/loop`.",
  "Do not create loops from ordinary natural-language requests.",
  "Use `list`, `delete`, `modify`, `pause`, or `resume` for ordinary requests.",
  "For a bare `/loop`, call `list` and explain `/loop <interval> <prompt>`.",
  "For `create`, generate a short abstract from the requested work.",
  "For `create`, write a self-contained prompt for every future turn.",
  "For `interval`, use one positive integer with `s`, `m`, `h`, or `d`.",
  "Use intervals from `10s` through `7d`.",
  "Expect each `create` or `resume` to wait one full interval before firing.",
  "Expect loops to survive compaction and tree navigation.",
  "Expect reload, new, resume, fork, or quit to clear all loops.",
], "Loop promptGuidelines semantics");
hasNone(`${loopDescription}\n${loopPromptSnippet}\n${loopGuidelines.join("\n")}`, [
  "timerToken", "schedule token", "generation", "notification gate", "gatedFires", "appendEntry", "journal", "snapshot",
], "Loop model metadata internal boundary");
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
hasAll(statusFormatter, ["id: run.id", "agent: run.agent", "abstract: run.abstract", "status: run.status", "live:", "sourceRunId", "reason"], "list status formatter");
hasNone(statusFormatter, ["...run", "task:", "cwd:", "model:", "deniedTools:", "createdAt:", "updatedAt:", "sessionFile:", "activity:", "output:", "error:", "notificationPending:"], "list status formatter");
const listAction = runtime.slice(listActionStart, listActionEnd);
hasAll(listAction, ["reconcileAll", "ACTIVE_STATUSES.has(run.status)", "formatRunStatus", "JSON.stringify(runs, null, 2)", "{ runs }"], "active-only list status action");
hasNone(listAction, [".formatRun(", "this.activity", ".output", ".error", ".task"], "list status action");
const publicSchema = runtime.slice(runtime.indexOf("export const subagentParameters"), runtime.indexOf("export class OmpsSubagentRuntime"));
hasNone(publicSchema, REMOVED_CAPABILITIES, "public tool schemas");
hasAll(publicSchema, [
  "export const subagentParameters = Type.Object({", "}, { additionalProperties: false });",
  'description: "For create, select the specialist role."',
  'description: "For create or resume, provide a short run summary."',
  'description: "For create, provide the complete objective."',
  'description: "For create, provide a different working directory."',
  'description: "Select the run action."',
  'description: "For steer, interrupt, resume, or reply, provide the run ID."',
  'description: "For steer, provide guidance. For resume, provide the continuation objective. For reply, provide the waiting-request answer."',
], "subagent schema descriptions");
const publicSchemaDescriptions = [...publicSchema.matchAll(/description:\s*("(?:\\.|[^"\\])*")/g)].map((match) => JSON.parse(match[1]));
check(publicSchemaDescriptions.length === 7, "subagent schema must define seven field descriptions");
for (const description of publicSchemaDescriptions) checkSteBlock(description, "subagent schema description");
const subagentToolStart = runtime.indexOf('name: "subagent"');
const subagentGuidelinesStart = runtime.indexOf("promptGuidelines: [", subagentToolStart);
const subagentGuidelinesEnd = runtime.indexOf("      ],", subagentGuidelinesStart);
const subagentToolMetadata = runtime.slice(subagentToolStart, subagentGuidelinesEnd);
const subagentDescription = propertyString(subagentToolMetadata, "description", "subagent tool metadata");
const subagentPromptSnippet = propertyString(subagentToolMetadata, "promptSnippet", "subagent tool metadata");
const subagentGuidelineBlock = runtime.slice(subagentGuidelinesStart, subagentGuidelinesEnd);
const subagentGuidelines = staticStrings(subagentGuidelineBlock, "subagent promptGuidelines");
checkSteBlock(subagentDescription, "subagent description");
checkSteBlock(subagentPromptSnippet, "subagent promptSnippet");
checkSteGuidelines(subagentGuidelines, "subagent promptGuideline");
const subagentGuidelineText = subagentGuidelines.join("\n");
hasAll(subagentGuidelineText, [
  "Use only `action`, `agent`, `abstract`, `task`, and optional `cwd` for `create`.",
  "For `create`, select `agent` as the specialist role.",
  "For `create`, use `abstract` for a short run summary.",
  "For `create`, use `task` for the complete objective.",
  "For `create`, add `cwd` only for a different working directory.",
  "Expect `create` to return a new run ID.",
  "Read each waiting notification for the complete request and run ID.",
  "Read each terminal notification for the final output or error.",
  "Use only `action` for `list`.",
  "Use `list` to inspect active starting, running, and waiting runs.",
  "Expect `list` to return ID, agent, abstract, status, live, optional sourceRunId, and optional reason.",
  "Do not use `list` to get requests, activity, or terminal results.",
  "Use only `action`, `id`, and `message` for `steer`.",
  "For `steer`, use `message` for complete guidance.",
  "Use only `action` and `id` for `interrupt`.",
  "For `interrupt`, use a starting, running, or waiting run ID in `id`.",
  "After `interrupt`, read the terminal notification for the actual status.",
  "Use only `action`, `id`, `abstract`, and `message` for `resume`.",
  "Resume only a terminal source run that has saved context.",
  "For `resume`, use `message` for the complete continuation objective.",
  "Expect `resume` to return a new run ID.",
  "Use only `action`, `id`, and `message` for `reply`.",
  "For `reply`, use a live waiting run ID in `id`.",
  "In `message`, answer the complete waiting request.",
  "Expect `reply` to continue the same run.",
], "ASD-STE100-style subagent guidelines");
check(!/request ID|waitingSeq|deliveryKey|legacy|saved child-session/i.test(`${subagentDescription}\n${subagentPromptSnippet}\n${subagentGuidelineText}`), "subagent model metadata must not expose internal terms");
check(!runtime.includes(REMOVED_WAIT_TOOL), "runtime must not register or mention the removed wait tool");
hasAll(core, [
  '"create"', '"list"', '"interrupt"', '"steer"', '"resume"', '"reply"',
  '"starting"', '"running"', '"waiting"', '"completed"', '"failed"', '"interrupted"',
  "restoreSnapshot",
  "SubagentRegistry", "legacyRunAbstract", "waitingSeq", "abstract",
], "runtime core");
hasNone(core, [...REMOVED_CAPABILITIES, "SUPERVISOR_ACTIONS", "SUPERVISOR_PUBLIC_FIELDS", "pending(): SupervisorRequest", "replyTo"], "runtime core");
check(/SUBAGENT_ACTIONS = \[\s*"create",\s*"list",\s*"interrupt",\s*"steer",\s*"resume",\s*"reply",\s*\] as const/.test(core), "SUBAGENT_ACTIONS must keep the exact unified action order");

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
const contactGuidelinesStart = child.indexOf("promptGuidelines: [", child.indexOf('name: "contact_supervisor"'));
const contactGuidelinesEnd = child.indexOf("    ],", contactGuidelinesStart);
const contactGuidelines = child.slice(contactGuidelinesStart, contactGuidelinesEnd);
const contactGuidelineValues = staticStrings(contactGuidelines, "contact_supervisor promptGuidelines");
checkSteGuidelines(contactGuidelineValues, "contact_supervisor promptGuideline");
hasAll(contactGuidelines, [
  "Use `contact_supervisor`", "For `reason`, select", "complete request context",
  "structured questions", "wait for the orchestrator reply", "including `progress_update`",
], "ASD-STE100-style contact supervisor guidelines");
hasNone(contactGuidelines, [";", " is delivered", "saved child-session", "waitingSeq", "deliveryKey", "legacy", "request ID", "UUID"], "ASD-STE100-style contact supervisor guidelines");
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
  'description: "Select list or update."',
  'description: "For update, apply at least one operation in order. For list, omit operations."',
  'description: "Select pending, in_progress, or completed."',
  'description: "Add initial dependencies by exact subject."',
  'description: "Add dependencies by exact subject."',
  'description: "Remove dependencies by exact subject."',
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
for (const description of todoSchemaDescriptions) checkSteBlock(description, "Todo schema description");
hasAll(todoExtension, [
  'export const TODO_PROMPT_SNIPPET = "Read or update the current session todo list"',
  'description: "Read or update the current session todo list. Apply updates atomically."',
], "Todo tool metadata");
checkSteBlock("Read or update the current session todo list", "Todo promptSnippet");
checkSteBlock("Read or update the current session todo list. Apply updates atomically.", "Todo description");
const todoGuidelineStart = todoExtension.indexOf("export const TODO_PROMPT_GUIDELINES = [");
const todoGuidelineEnd = todoExtension.indexOf("] as const;", todoGuidelineStart);
const todoGuidelineBlock = todoExtension.slice(todoGuidelineStart, todoGuidelineEnd);
const todoGuidelines = staticStrings(todoGuidelineBlock, "Todo promptGuidelines");
checkSteGuidelines(todoGuidelines, "Todo promptGuideline");
const todoGuidelineText = todoGuidelines.join("\n");
hasAll(todoGuidelineText, [
  "Use `todo list` to read the complete todo list for the current session.",
  "For `list`, omit `operations`.",
  "Use `todo update` to apply all operations atomically.",
  "For `update`, provide at least one operation.",
  "For `append`, provide a unique `subject` and an `abstract`.",
  "Use `abstract` for a short item summary.",
  "For `append`, use `blockedBy` to add initial dependencies by exact subject.",
  "For `modify`, use the exact current subject in `target`.",
  "For `modify`, provide at least one change.",
  "Use `newSubject` to rename the item.",
  "For `modify`, use `abstract` as the replacement summary.",
  "For `status`, select `pending`, `in_progress`, or `completed`.",
  "Use `addBlockedBy` to add dependencies by exact subject.",
  "Use `removeBlockedBy` to remove dependencies by exact subject.",
  "Complete every dependency before you start or complete an item.",
  "Before a new task group, use `clear` only after all old items are complete.",
  "Use one update to complete old items, apply `clear`, and append a new group.",
  "Use `clear` at most once in each update.",
  "Expect any failure to cancel the whole update.",
], "Todo promptGuidelines semantics");
check(!/\b(?:snapshot|replay|store|version|widget|ID)\b/i.test(todoGuidelineText), "Todo promptGuidelines must not expose internal terms");
hasAll(todoCore, [
  "TODO_SNAPSHOT_TYPE", "applyTodoUpdate", "validateTodoState", "replayTodoBranch",
  "todo update failed at operation", "clear can appear only once",
  "requires completed dependency", "dependency cycle", "cloneTasks",
], "built-in Todo state contract");
hasNone(`${todoCore}\n${todoGuidelineText}`, [
  "at most one task can be in_progress", "at most one item in_progress",
], "Todo multiple in_progress contract");
hasAll(todoWidget, [
  "MAX_TODO_WIDGET_LINES = 12", "● Todos (", '"○"', '"◐"', '"✓"', '⛓ ${task.blockedBy',
  'theme.strikethrough', '"├─"', '"└─"', "hiddenSummary", "setWidget",
  "renderTodoListResult", "renderTodoReceipts", "expanded = false", "receiptStatusTransition",
  'operations.filter((operation) => operation.op === "append")',
  'operations.filter((operation) => operation.op === "modify")',
  'operations.filter((operation) => operation.op === "clear")',
  'Applied ${append} append · ${modify} modify · ${clear} clear → ${changed} changed · ${noChange} no-change',
  'addResultField(container, theme, "Status"', 'addResultSection(container, theme, "Abstract"',
  'addResultList(container, theme, "Blocked by"', "no-change",
], "built-in Todo widget and result-renderer contract");
hasAll(todoExtension, [
  "context.expanded === true", "todoCallTitle", 'theme.bold("todo")', 'theme.fg("muted", detail)',
  '`· ${action}${expanded ? "" : " (ctrl+o to expand)"}`', 'action === "list" || !expanded',
  'addCallField(container, theme, "Operations"', '"Append"', '"Modify"', '"Clear"',
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
  'Action:|Operations:|Append:|Modify:|Clear:',
  '✓ Applied 1 append · 2 modify · 0 clear → 2 changed · 1 no-change',
], "Todo focused Ctrl+O visual tests");
const subagentTranscriptTests = read("tests/subagent-transcript-renderer.test.mjs");
hasAll(subagentTranscriptTests, [
  "without duplicate Action rows", "(ctrl+o to expand)", "Action:",
  'assert.doesNotMatch(value, /\\(ctrl\\+o to expand\\)|Action:/)',
  'waiting (ctrl+o to expand)', '${value.status} (ctrl+o to expand)', 'running (ctrl+o to expand)',
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
  "no_progress: no_progress (ctrl+o to expand)",
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
  hasAll(text, [
    "detached",
    "contact_supervisor",
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
    "setImmediate", "compaction_end", "triggerTurn: true", "queued",
  ], file);
  hasAll(text, file === "README.md"
    ? [
        "The six specialists", "All seven provider/model pairs", 'action: "create"', "`action` is mandatory",
        "Top-level `deny`", "`--exclude-tools", "launch-time `deniedTools`", "image input",
        "copies that preset's `explorer` configuration", "reread before every create and resume",
        "next safe model boundary", "same custom message", "collapsed TUI view shows only the compact run header",
        "Press Ctrl+O", "Ctrl+O changes only TUI rendering",
      ]
    : [
        "六个 specialist", "七个 provider/model", 'action: "create"', "`action` 必填",
        "顶层 `deny`", "`--exclude-tools", "启动时 `deniedTools`", "image input",
        "复制同一 preset 的 `explorer` 配置", "每次 create 与 resume 前都会重新读取 deny",
        "下一个安全模型边界", "同一条消息", "折叠的 TUI 视图只显示紧凑 run header",
        "按 Ctrl+O", "Ctrl+O 只改变 TUI 渲染",
      ], `${file} 0.10.0 contract`);
  hasAll(text, file === "README.md"
    ? [
        "## Tool availability", "main session gets exactly the six package tools", "ask_user_question", "goal", "loop", "monitor", "subagent", "todo",
        "A detached child gets exactly `contact_supervisor` and `todo`", "Monitor is omitted on Windows",
        "register as soon as the package loads", "do not depend on `/omps on`", "phase reminder can therefore appear", "orchestrator preset is inactive",
        "never register package widgets", "JSON and print modes remove Ask", "(ctrl+o to expand)",
        "## Migration from external packages", "npm:@juicesharp/rpiv-ask-user-question", "npm:@aliou/pi-processes",
        "pi remove npm:@juicesharp/rpiv-ask-user-question", "pi remove npm:@aliou/pi-processes",
        "remove `ask_user_question` from any user specialist deny lists", "never runs `pi remove`", "rewrites user deny lists automatically",
      ]
    : [
        "## 工具可用性", "main session 精确获得本 package 的六个工具", "ask_user_question", "goal", "loop", "monitor", "subagent", "todo",
        "detached child 精确获得 `contact_supervisor` 与 `todo`", "Windows 不注册 Monitor",
        "在 package load 时立即注册", "不依赖 `/omps on`", "Goal phase reminder", "orchestrator preset inactive",
        "绝不注册 package widget", "JSON 与 print mode", "(ctrl+o to expand)",
        "## 外部 package 迁移", "npm:@juicesharp/rpiv-ask-user-question", "npm:@aliou/pi-processes",
        "pi remove npm:@juicesharp/rpiv-ask-user-question", "pi remove npm:@aliou/pi-processes",
        "从任何用户 specialist deny list 中移除 `ask_user_question`", "绝不会自动运行 `pi remove`", "重写用户 deny list",
      ], `${file} tool availability and external migration contract`);
  hasAll(text, file === "README.md"
    ? [
        "## Built-in Todo", '{ action: "list" }', '{ action: "update"', "commits once",
        "Multiple items may be `in_progress`", "versioned successful", "at most 12 total lines", "Each item shows only its subject",
        "⛓ subject1, subject2", "Abstracts stay out of the widget", "● Todos (completed/total)",
        "Collapsed list and update calls show only the title and action", "operation summary", "expanded results add", "changed", "no-change", "cannot coexist", "run `pi remove`", "never removes or uninstalls external packages",
      ]
    : [
        "## 内置 Todo", '{ action: "list" }', '{ action: "update"', "只 commit 一次",
        "多个 item 可以同时为 `in_progress`", "新版本 tool-result details", "总计最多 12 行", "每个 item 只显示 subject",
        "⛓ subject1, subject2", "abstract 不进入 widget", "● Todos (completed/total)",
        "折叠的 list 与 update call 都只显示标题与 action", "operation summary", "展开后再增加", "changed", "no-change", "不能与内置工具共存", "执行 `pi remove`", "不会主动删除或卸载任何外部 package",
      ], `${file} built-in Todo contract`);
  hasAll(text, file === "README.md"
    ? [
        "## Built-in Loop", "one `/loop` command and one model tool named `loop`", "six actions",
        "latest user message starts with `/loop`", "For a bare `/loop`", "/loop <interval> <prompt>",
        "`abstract` is the short human-readable summary", "`prompt` is the complete self-contained instruction",
        "inclusive range is `10s` through `7d`", "largest exactly divisible unit", "repeating fixed-delay",
        "Create waits one complete interval", "Repeating pause is a successful no-change", "repeating resume is a successful no-change",
        "Abstract-only or prompt-only changes preserve", "`delete` removes the loop without a tombstone or history",
        "Loop state is runtime-only", "Compaction and tree navigation preserve loops, timers, and gated fire records",
        "Reload, new session, resumed session, fork, and quit clear every loop", "no maximum fire count", "loop-count limit",
        "backlog limit, or coalescing", "deliverAs: \"steer\"", "triggerTurn: true", "shared notification pause gate",
        '"nextFireAt"', '"failureCount"', '"lastError"', "● Loops (active/total)", "atomic two-line tree entry",
        "Active loops sort first by `nextFireAt`", "at most 12 lines", "once-per-second countdown", "Ctrl+O data invariant",
      ]
    : [
        "## 内置 Loop", "一个 `/loop` command 和一个名为 `loop` 的模型工具", "六个 action",
        "最新 user message 以 `/loop` 开头", "裸 `/loop`", "/loop <interval> <prompt>",
        "`abstract` 是紧凑 UI 使用的简短人类可读摘要", "`prompt` 是每个未来模型 turn 都会收到的完整、自包含指令",
        "范围闭区间为 `10s` 到 `7d`", "可精确整除的最大单位", "repeating fixed-delay",
        "create 会等待一个完整 interval", "重复 pause 是成功的 no-change", "重复 resume 也是成功的 no-change",
        "只修改 abstract 或 prompt 会保留", "`delete` 直接移除 loop，不保留 tombstone 或 history",
        "Loop 状态只存在于 runtime memory", "compaction 与 tree navigation 会保留 loops、timers 和 gated fire records",
        "reload、new session、resumed session、fork 与 quit 会清空全部 loop", "没有最大 fire 次数", "loop 数量限制",
        "backlog 限制或 coalescing", "deliverAs: \"steer\"", "triggerTurn: true", "共用 notification pause gate",
        '"nextFireAt"', '"failureCount"', '"lastError"', "● Loops (active/total)", "不可拆分的两行 tree entry",
        "active loop 先按 `nextFireAt` 排序", "最多 12 行", "每秒刷新一次的 countdown", "Ctrl+O data invariant",
      ], `${file} built-in Loop contract`);
  hasAll(text, file === "README.md"
    ? [
        "## Built-in Monitor", "main-session-only POSIX tool", "four sequential actions", '{ action: "create", abstract, command, cwd?, notifyOn? }',
        "at most 20", "500 characters", "There is no monitor-count limit", "detached POSIX process group", "ignores stdin", "never provides stdin, a PTY",
        "guidance, not a shell parser or sandbox", "reverse-offset based", "default window is `0..100`", "maximum window is 2,000 lines",
        "OS temporary directory", "64 MiB", "32 MiB", "64 KiB", "100 ms batches", "20 batches per rolling minute",
        "deliverAs: \"steer\"", "triggerTurn: true", "Terminal records and logs remain available", "explicit `delete`", "cannot retract that message",
        "blocks Goal continuation", "● Monitors (running/total)", "at most ten monitors and twelve total lines", "Ctrl+O hint",
      ]
    : [
        "## 内置 Monitor", "main-session-only 的 POSIX 工具", "四个 sequential action", '{ action: "create", abstract, command, cwd?, notifyOn? }',
        "最多接受 20", "500 字符", "Monitor 数量没有上限", "detached POSIX process group", "stdin 被 ignore", "绝不提供 stdin、PTY",
        "只是 guideline，不是 shell parser 或 sandbox", "reverse offset", "默认窗口为 `0..100`", "最大窗口 2,000 行",
        "OS temporary directory", "64 MiB", "32 MiB", "64 KiB", "100 ms batch", "rolling minute 内 20 个 batch",
        "deliverAs: \"steer\"", "triggerTurn: true", "terminal record 与 log 会保留", "显式 `delete`", "不能撤回该消息",
        "阻塞 Goal continuation", "● Monitors (running/total)", "最多显示十个 monitor、总计十二行", "Ctrl+O hint",
      ], `${file} built-in Monitor contract`);
  hasAll(text, file === "README.md"
    ? [
        "## Built-in Ask", "main-session-only `ask_user_question`", "one through four questions", "two through four authored options",
        "at most 16 characters", "at most 60 characters", "preview", "single-select only", "multiSelect", "exact-unique",
        "tab", "single-select", "multi-select", "custom inline response", "empty selection", "partial", "empty-submit",
        "Pi's native `select` and `input`", "never tries to instantiate the TUI overlay", "single-flight", "AbortError", "hard-rejected",
        "no persistence", "no-UI execution backstop", "no paid or nested model call", "no persistence, notification message, widget, slash command, configuration, i18n layer, notes field", "Ctrl+O expansion hint",
      ]
    : [
        "## 内置 Ask", "main-session-only 的 sequential `ask_user_question`", "一到四个 question", "二到四个 authored option",
        "最多 16 字符", "最多 60 字符", "preview", "仅 single-select", "multiSelect", "exact-unique",
        "tab", "single-select", "multi-select", "custom inline response", "empty selection", "partial", "empty-submit",
        "Pi native `select` 与 `input`", "绝不会尝试实例化 TUI overlay", "single-flight", "AbortError", "hard reject",
        "没有 persistence", "no-UI", "不存在付费或 nested model call", "没有 persistence、notification message、widget、slash command、configuration、i18n layer、notes 字段", "Ctrl+O expansion hint",
      ], `${file} built-in Ask contract`);
  hasAll(text, file === "README.md"
    ? [
        "## Built-in Goal", "main-session-only durable scheduler", "exactly seven actions", '{ action: "complete", evidence }',
        "zero or one Goal on the current branch", "one through eight", "exactly one non-empty evidence item", "no public Goal ID, revision",
        "version-1 branch-local snapshots", "paused` with reason `session_restored`", "provider error", "10 s, 30 s, 1 min, 5 min, 15 min", "one-hour ceiling",
        "user abort", "Three automatic continuation runs", "lowest-priority package scheduler", "no active subagent", "no running Monitor", "no waiting Ask",
        "Pursue this Goal now.", "Continue making concrete progress toward every criterion.", "You are pursuing the active Goal: <abstract>",
        "does not dynamically rewrite the system prompt", "does not register a `context` mutation hook", "file-tool nudge mechanism has been removed completely",
        "Goal-owned", "private, session-owned mode-0600 sidecar records", "never `goal status`", "exactly two lines", "main token/tool/turn/compaction totals", "child totals",
        "Ctrl+O hint", "Known risks",
      ]
    : [
        "## 内置 Goal", "main-session-only 的 durable scheduler", "精确七个 action", '{ action: "complete", evidence }',
        "零个或一个 Goal", "一到八条", "精确一条非空 evidence", "不暴露公开 Goal ID、revision",
        "version-1 branch-local snapshot", "`paused`，reason 为 `session_restored`", "provider error", "10 秒、30 秒、1 分钟、5 分钟、15 分钟", "一小时 ceiling",
        "user abort", "连续三次 automatic continuation run", "最低优先级的 scheduler", "active subagent", "running Monitor", "waiting Ask",
        "Pursue this Goal now.", "Continue making concrete progress toward every criterion.", "You are pursuing the active Goal: <abstract>",
        "不会为该 reminder 动态改写 system prompt", "不注册 `context` mutation hook", "file-tool nudge mechanism 已被彻底移除",
        "Goal-owned", "private、session-owned、mode-0600 sidecar record", "绝不进入 `goal status`", "精确为两行", "main token/tool/turn/compaction total", "child total",
        "Ctrl+O hint", "已知风险",
      ], `${file} built-in Goal contract`);
  hasNone(text, file === "README.md" ? ["At most one item may be `in_progress`"] : ["最多一个 item 可为 `in_progress`"], `${file} removed single-in-progress contract`);
  hasNone(text, [
    "RpcClient", "RPC-client seam", "hidden follow-up", "隐藏 follow-up", "The five agents", "五个 agent",
    "all five specialist roles", "五个 specialist", "### Fresh runs", "fresh child calls", "fresh child",
    'subagent({ agent:', "`--tools`", "model/tools", "v0.9.2",
    "Collapsed update calls show the operation total", "折叠的 update call 显示 operation 总数",
  ], file);
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
  "describeWidgetActivity", "activeLines.length * 3", "budget >= 3", "run.abstract", "shortAbstract",
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
  '"Active subagent run status"', "run.abstract", "run.reason", 'addField(container, theme, "Abstract", args.abstract',
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
hasAll(listRenderer, ["styledTitle", "compactRunHeader", "undefined, true", '!expanded || status !== "waiting"', "run.reason"], "status-only list renderer");
hasNone(listRenderer, ["addFinalOutput", "addLiveActivity", "addRequest", "run.task", "run.cwd", "run.model", "run.deniedTools", "run.output", "run.error", "run.activity", "run.request)"], "status-only list renderer");
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
