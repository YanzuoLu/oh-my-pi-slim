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

function checkSteGuidelines(guidelines, label, toolName) {
  for (const guideline of guidelines) {
    const sentences = modelSentences(guideline);
    check(sentences.length === 1, `${label} must use one sentence per guideline: ${guideline}`);
    checkSteSentence(guideline, label);
    if (toolName) check(guidelineHasOwner(guideline, toolName), `${label} lacks explicit ${toolName} ownership: ${guideline}`);
  }
}

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

check(packageJson.version === "0.10.14", "package version must be 0.10.14");
check(packageJson.description === "Preset-driven Pi orchestration with built-in subagents, loops, monitors, structured questions, durable goals, and session todos.", "package description must cover all built-in runtime surfaces");
check(["pi-package", "pi", "orchestration", "subagents", "loops", "monitoring", "ask-user-question", "goals", "todos", "scheduling"].every((keyword) => packageJson.keywords?.includes(keyword)), "package keywords must include Monitor, Ask, Goal, Loop, subagent, and Todo discovery terms");
check(lock.version === "0.10.14" && lock.packages?.[""]?.version === "0.10.14", "package-lock version must be 0.10.14");
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
  hasAll(parsed.body, ["**Supervisor Rules**:", "Do not ask the user directly.", "contact_supervisor", "creates a waiting request and pauses this run", "Do not call subagent create, list, status, interrupt, steer, resume, reply, or clear actions"], `${file} child lifecycle boundary`);
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
const widgetExpansion = read("extensions/oh-my-pi-slim/widget-expansion.ts");
const widgetStack = read("extensions/oh-my-pi-slim/widget-stack.ts");
const widgetStackHost = read("extensions/oh-my-pi-slim/widget-stack-host.ts");
const subagentWidget = read("extensions/oh-my-pi-slim/subagent-widget.ts");
const subagentWidgetRenderer = read("extensions/oh-my-pi-slim/subagent-widget-renderer.ts");

// One aggregate foreground widget: the host is the only `setWidget` owner in the package, and the
// five section renderers stay pure. The stack may reorder sections but never rewrites their lines.
hasAll(widgetStack, [
  'WIDGET_STACK_SECTION_IDS = ["goal", "todos", "agents", "monitors", "loops"] as const',
  "export function widgetStackSectionRank", "export function orderWidgetStackSections", "export function renderWidgetStack",
  "isActive(): boolean", "render(input: WidgetStackRenderInput): readonly string[]",
  "(section.isActive() ? active : idle).push(section)",
  "[...active.sort(byRank), ...idle.sort(byRank)]",
  "lines.push(...section.render(input))",
], "widget stack orders active sections above idle ones in fixed product order");
hasNone(widgetStack, [
  "setWidget", "requestRender", "globalThis", "truncateToWidth", "theme.fg(", "theme.bold(",
  "join(", "push(\"\")", "slice(0,", "maxLines", "readWidgetExpanded",
], "widget stack must add no separator, cap, style, or UI state of its own");
hasAll(widgetStackHost, [
  'WIDGET_STACK_KEY = "oh-my-pi-slim:widgets"', "WIDGET_STACK_HOST_PROTOCOL = 1",
  'WIDGET_STACK_HOST_GLOBAL_KEY = "__ohMyPiSlimWidgetStackHost_v1"',
  "bind(owner: string, ui: WidgetStackUI | undefined): void",
  "unbind(owner: string, ui?: WidgetStackUI | undefined): void",
  "publish(id: WidgetStackSectionId, section: WidgetStackSection | undefined): void",
  "requestRender(): void", "export function widgetStackHost", "export function resetWidgetStackHost",
  "if (previous === next && ui === next) return",
  "if (expected !== undefined && bound !== expected) return",
  "for (const value of owners.values()) if (value === ui) return",
  "if (sections.size === 0) {", "clearWidget(ui)",
  "target.setWidget(WIDGET_STACK_KEY,", 'placement: "aboveEditor"',
  "renderWidgetStack([...sections.values()]", "resolveWidth(width, nextTui)",
  "readWidgetExpanded(ui)", "widgetExpandHint()", "invalidate() {}",
  // A binding released with no UI must release exactly this owner's recorded claim.
  "host.unbind(owner, owners.get(owner))",
  // The newest distinct UI takes over, and only owners of the live UI hold it open.
  "if (ui !== next) {", "clearWidget(ui);",
  // A factory the host never runs must not lock the aggregate into a dead registration.
  "let announced = false", "let registered = false",
  "if (announced && target) target.setWidget(WIDGET_STACK_KEY, undefined)",
  "tui = undefined;\n    target.setWidget(WIDGET_STACK_KEY,",
  "announced = true;", "registered = tui !== undefined;",
  // An explicit width is authoritative down to zero.
  "if (typeof width === \"number\" && Number.isFinite(width) && width >= 0) return Math.floor(width)",
  "DEFAULT_WIDGET_STACK_WIDTH = 80",
  "Reflect.get(globalThis, WIDGET_STACK_HOST_GLOBAL_KEY)",
  "if (isWidgetStackHost(existing)) return existing", "Object.defineProperty(globalThis, WIDGET_STACK_HOST_GLOBAL_KEY",
  "Reflect.deleteProperty(globalThis, WIDGET_STACK_HOST_GLOBAL_KEY)",
  "candidate.protocol === WIDGET_STACK_HOST_PROTOCOL",
], "widget stack host owns the single aggregate key through a versioned globalThis singleton");
hasNone(widgetStackHost, [
  "instanceof", "registerShortcut", "setStatus", "notify(", "overlay", "appendEntry", "registerTool",
  "theme.fg(", "theme.bold(", "truncateToWidth", "as unknown as", "host.unbind(owner)",
], "widget stack host must stay a binding and dispatch layer with no styling, cast, or module singleton");
// One shared UI type: the widget classes hold `WidgetStackUI` directly instead of a partial copy,
// and Agents extends it rather than redeclaring the host surface.
for (const [name, source] of [
  ["Goal widget", goalWidget],
  ["Monitor widget", monitorWidget],
  ["Loop widget", loopWidget],
]) {
  hasAll(source, [
    'import { widgetStackHost, type WidgetStackUI } from "./widget-stack-host.js"',
    "private ui: WidgetStackUI | undefined",
    "const next: WidgetStackUI | undefined = ui;",
  ], `${name} must hold the shared host UI type`);
  hasNone(source, [
    "WidgetUI {", "as unknown as", "as MonitorWidgetUI", "as GoalWidgetUI", "as LoopWidgetUI",
  ], `${name} must not redeclare or cast around the host UI type`);
}
hasAll(subagentWidget, [
  'import { widgetStackHost, type WidgetStackUI } from "./widget-stack-host.js"',
  "export interface SubagentWidgetUI extends WidgetStackUI {",
  "setStatus(key: string, text: string | undefined): void;",
  "theme: input.theme,",
], "Agents widget must extend the shared host UI type and keep its own status bar");
hasNone(subagentWidget, ["as unknown as", "as WidgetTheme"], "Agents widget must not cast around the shared types");
hasAll(todoWidget, [
  "private ui: ExtensionUIContext | undefined",
], "Todo widget keeps Pi's own extension UI type");
hasNone(todoWidget, ["as unknown as"], "Todo widget must not cast around the shared types");
// The host is the single `setWidget` owner: no other file in the package may register a widget.
const widgetOwners = readdirSync(join(ROOT, "extensions"), { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile() && /\.(ts|mjs)$/.test(entry.name))
  .map((entry) => join(entry.parentPath, entry.name))
  .filter((path) => readFileSync(path, "utf8").includes("setWidget"))
  .map((path) => path.slice(join(ROOT, "extensions").length + 1))
  .sort();
check(
  JSON.stringify(widgetOwners) === JSON.stringify(["oh-my-pi-slim/widget-stack-host.ts"]),
  `widget-stack-host must be the only setWidget owner, found: ${widgetOwners.join(", ")}`,
);
// Both extension entries bind the same host idempotently and release only their own claim.
hasAll(extension, [
  'WIDGET_STACK_OWNER = "oh-my-pi-slim:extension"',
  'OWNED_WIDGET_SECTIONS: readonly WidgetStackSectionId[] = ["goal", "agents", "monitors", "loops"]',
  "for (const id of OWNED_WIDGET_SECTIONS) widgetStackHost().publish(id, undefined);",
  'widgetStackHost().bind(WIDGET_STACK_OWNER, ctx.mode === "tui" ? ctx.ui : undefined)',
  'widgetStackHost().unbind(WIDGET_STACK_OWNER, ctx.mode === "tui" ? ctx.ui : undefined)',
], "main extension binds the aggregate host on start and tree and releases only its own claim");
hasAll(todoExtension, [
  'TODO_EXTENSION_OWNER = "oh-my-pi-slim:todo-extension"',
  "widgetStackHost().publish(TODO_SECTION_ID, undefined);",
  'if (ctx.mode === "tui") widgetStackHost().bind(TODO_EXTENSION_OWNER, ctx.ui);',
  'if (ctx.mode === "tui") widgetStackHost().unbind(TODO_EXTENSION_OWNER, ctx.ui);',
  // Shutdown always disposes; the foreground id only tracks which session owns the widget.
  "widget.dispose();\n    if (id === foregroundSession) foregroundSession = \"\";",
], "Todo extension binds the same aggregate host and releases only its own claim");
check(
  !/if \(id === foregroundSession\) \{\s*\n\s*widget\.dispose\(\)/.test(todoExtension),
  "Todo shutdown must not gate widget disposal on the foreground session id",
);
// Only the host may call setWidget; every widget class publishes a section instead of owning a key.
for (const [name, source] of [
  ["Goal widget", goalWidget],
  ["Todo widget", todoWidget],
  ["Agents widget", subagentWidget],
  ["Monitor widget", monitorWidget],
  ["Loop widget", loopWidget],
]) {
  hasNone(source, ["setWidget", "WIDGET_STACK_KEY", "aboveEditor", "belowEditor"], `${name} must not own a widget key`);
  hasAll(source, [
    "widgetStackHost()", ".publish(", ".bind(", ".unbind(", "requestRender()", "isActive: () =>", "render: (input)",
  ], `${name} must publish one stack section and request aggregate renders`);
}

// Persistent widget expansion must reuse Pi's own global tool-output state and nothing else.
hasAll(widgetExpansion, [
  'import { keyText } from "@earendil-works/pi-coding-agent"',
  'DEFAULT_WIDGET_EXPAND_KEY = "ctrl+o"',
  "export function readWidgetExpanded",
  'typeof ui.getToolsExpanded !== "function"', "return true", "ui.getToolsExpanded() !== false",
  "export function widgetExpandKey", 'keyText("app.tools.expand")', "try {", "catch {",
  "export function widgetExpandHint", "return ` · ${widgetExpandKey()} to expand`",
], "shared widget expansion reads Pi global state and the configured key");
hasNone(widgetExpansion, [
  "registerShortcut", "setToolsExpanded", "setEditorComponent", "CustomEditor", "handleInput",
  "writeFileSync", "appendEntry", "localStorage", "globalThis", "let ", "theme.fg(", "theme.bold(", "registerTool",
], "shared widget expansion must own no keybinding, editor, store, persistence, or theme");
hasAll(widgetStackHost, [
  "readWidgetExpanded", "widgetExpandHint()",
], "the aggregate host must read Pi global expansion live on every render");
for (const [name, source] of [
  ["Monitor widget", monitorWidget],
  ["Todo widget", todoWidget],
  ["Subagent widget", subagentWidget],
]) {
  hasAll(source, [
    "input.expanded", "input.hint",
  ], `${name} must pass the host's live expansion state straight into its pure renderer`);
}
for (const [name, source] of [
  ["Monitor widget", monitorWidget],
  ["Todo widget", todoWidget],
  ["Subagent widget", subagentWidget],
  ["widget stack host", widgetStackHost],
]) {
  hasNone(source, [
    "registerShortcut", "setToolsExpanded", "setEditorComponent",
  ], `${name} must not register or hijack the expansion keybinding`);
}
for (const [name, source] of [["Goal widget", goalWidget], ["Loop widget", loopWidget]]) {
  hasNone(source, [
    "widget-expansion", "readWidgetExpanded", "widgetExpandHint", "getToolsExpanded", "input.expanded", "input.hint", "to expand",
  ], `${name} must stay out of Ctrl+O expansion with a permanently full body`);
}
// Persistent widgets are presentation only: no tool schema, prompt text, or model-facing payload lives here.
for (const [name, source] of [
  ["Monitor widget", monitorWidget],
  ["Loop widget", loopWidget],
  ["Goal widget", goalWidget],
  ["Todo widget", todoWidget],
  ["Subagent widget renderer", read("extensions/oh-my-pi-slim/subagent-widget-renderer.ts")],
]) {
  hasNone(source, [
    "registerTool", "promptSnippet", "promptGuidelines", "Type.Object", "parameters:", "content: [{",
  ], `${name} must not touch tool schema or model-facing content`);
}
for (const file of [
  "tests/monitor-ui.test.mjs", "tests/monitor.test.mjs", "tests/subagent-widget.test.mjs",
  "tests/subagent-runtime.test.mjs", "tests/loop.test.mjs", "tests/provider-schema.test.mjs",
]) {
  hasAll(read(file), ["./widget-expansion.js"], `${file} shared widget expansion load mapping`);
}
for (const file of ["tests/todo.test.mjs", "tests/provider-schema.test.mjs"]) {
  hasAll(read(file), ["../oh-my-pi-slim/widget-expansion.js"], `${file} Todo shared widget expansion load mapping`);
}

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
  "registerAskRuntime(pi)", "new AskTuiDriver(ctx.ui, { beforeOpen: () => subagentViewer.closeAsync() })",
  "bindAskDriver(ctx)", "bindAskDriver()",
  "registerGoalRuntime(pi", "asks.setGoalActiveResolver", "subagents.subscribeRunCreated", "goal?.onAgentSettled(ctx)",
  "registerLoopRuntime(pi)", "registerMonitorRuntime(pi)",
  "treeNotificationHold", "releaseTreeNotificationHoldDeferred", "subagents.restore(ctx, notificationGate.isPaused())",
  "loops.reset()", "loops.shutdown()", "await monitors?.reset()", "await monitors?.shutdown()",
  'loops.setUICtx(ctx.mode === "tui" ? ctx.ui : undefined)', "loops.refreshUI()",
  'monitors?.setUICtx(ctx.mode === "tui" ? ctx.ui : undefined)', "monitors?.refreshUI()",
  'goal?.setUICtx(ctx.mode === "tui" ? ctx.ui : undefined)', "goal?.setUICtx(undefined)", "goal?.refreshFromBranch(ctx)",
  "monitors?.acknowledgeNotificationMessage(message)", "monitors?.retryQueuedNotificationsAfterAgentSettled()",
], "main extension contract");
check(
  extension.includes("!IMPORTANT! Scheduler workflow: First choose the lightest workflow that fits the work. If direct execution is justified, complete it and verify proportionately. Otherwise: plan lanes/dependencies → dispatch background specialists → continue non-overlapping work when available → await completion notifications → reconcile terminal results → verify. !END!"),
  "phase reminder must preserve direct execution while forbidding overlapping post-dispatch work and waiting for notifications",
);
hasNone(extension, ["track task IDs", "hook-driven completion"], "phase reminder removed manual tracking and implementation-specific completion wording");
// The footer status must name the active preset with the version taken from package metadata, never a second literal.
hasAll(extension, [
  'const PACKAGE_ROOT = resolve(EXTENSION_DIR, "../..")',
  'const PACKAGE_VERSION = readPackageVersion(join(PACKAGE_ROOT, "package.json"))',
  "function readPackageVersion(path: string): string",
  "return nonEmptyString((raw as Record<string, unknown>).version, `${path}.version`)",
  "export function presetStatusContent(theme: Pick<Theme, \"fg\">, presetName: string | undefined): string | undefined",
  "if (presetName === undefined) return undefined",
  'return theme.fg("accent", `OMPS Preset: ${presetName} (v${PACKAGE_VERSION})`)',
  'ctx.ui.setStatus("oh-my-pi-slim", presetStatusContent(ctx.ui.theme, active ? activePresetName : undefined))',
  'ctx.ui.setStatus("oh-my-pi-slim", undefined)',
], "main extension status line contract");
hasNone(extension, [
  "`orchestrator${",
  "orchestrator:${",
  'with { type: "json" }',
  'assert { type: "json" }',
  "process.cwd()",
], "main extension status line removed sources");
check(!/\(v\d+\.\d+\.\d+\)/.test(extension), "main extension must not hardcode a package version in the status line");
check((extension.match(/setStatus\(/g) ?? []).length === 2, "main extension must set the oh-my-pi-slim status only when updating and when shutting down");
check(!/setStatus\("(?!oh-my-pi-slim")/.test(extension), "main extension must keep the oh-my-pi-slim status key");
const presetStatusBody = extension.slice(extension.indexOf("export function presetStatusContent"), extension.indexOf("function isAnthropicOAuth"));
hasNone(presetStatusBody, [".bold(", "theme.bold", "glyph", "Glyph"], "OMPS status plain accent-only rendering");
check((json("package.json").version ?? "").trim().length > 0, "package.json must define a non-empty version for the OMPS status line");

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
  'GOAL_SECTION_ID = "goal"', "renderGoalWidgetLines", 'theme.bold("●")', 'theme.fg("accent", "↻")', '"Ⅱ"', '"◷"', '"✓"', '"×"',
  '`${view.continuationCount} cont`', 'countLabel(view.ownedChildRunCount, "run")', 'statsLabel("main"', 'statsLabel("child"',
  'setIntervalFn(() => {', "1_000", "unref?.()", "requestRender()", "truncateToWidth", "visibleWidth",
  "sanitizeGoalText", "sanitizeGoalBody", "dispose()",
], "Goal fixed two-line width-safe cached widget contract");
hasNone(goalWidget, ["\\u001b[", "registerShortcut", "setStatus("], "Goal widget theme-only contract");
const goalPrefixBlock = goalWidget.slice(
  goalWidget.indexOf("export function isGoalPursuing"),
  goalWidget.indexOf("function headingLine"),
);
hasAll(goalPrefixBlock, [
  'return status === "active" || status === "retry_wait"',
  "export function isGoalViewPursuing", "return view.goal ? isGoalPursuing(view.goal.status) : false",
  "const pursuing = isGoalPursuing(status)",
  'const role = pursuing ? statusRole(status) : "dim"',
  'const glyph = pursuing ? theme.bold("●") : "○"',
  'const label = pursuing ? theme.bold("Goal") : "Goal"',
  "formatSemanticGlyphPrefix(theme.fg(role, glyph))", "theme.fg(role, label)",
], "Goal pursuing-versus-idle heading prefix visual");
hasNone(goalPrefixBlock, ['theme.bold("○")', "Goal (", "hint"], "Goal prefix must stay ratio-free, unbolded when idle, and free of expand hints");
check(
  goalWidget.includes("`${goalWidgetPrefix(goal.status, theme)} ${theme.fg(\"dim\", \"·\")} ${formatSemanticGlyphPrefix(goalStatusGlyph(goal.status, theme))}${theme.fg(role, sanitizeGoalText(goal.status))} ${theme.fg(\"dim\", \"·\")} `"),
  "Goal heading must keep the status glyph, status text, and abstract structure behind the shared prefix",
);
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
  "Choose an action. create and modify require abstract, objective, and criteria. pause and cancel require reason. complete requires evidence. status and resume accept no other fields.",
  "Short Goal summary for create or modify.",
  "Complete Goal objective for create or modify.",
  "One to eight completion criteria for create or modify.",
  "Reason for pause or cancel.",
  "For complete, provide exactly one concrete evidence item per criterion.",
];
check(JSON.stringify(goalSchemaDescriptions) === JSON.stringify(expectedGoalSchemaDescriptions), "Goal schema descriptions must match the HOW contract");
for (const description of goalSchemaDescriptions) checkSchemaHow(description, "Goal schema description");
hasAll(goalSchema, [
  'action: Type.Union(GOAL_ACTIONS.map((action) => Type.Literal(action))',
  "minItems: 1", "maxItems: 8",
  'description: "Choose an action. create and modify require abstract, objective, and criteria. pause and cancel require reason. complete requires evidence. status and resume accept no other fields."',
  'description: "One to eight completion criteria for create or modify."',
  'description: "For complete, provide exactly one concrete evidence item per criterion."',
], "Goal schema actions, fields, and limits");
const goalToolStart = goalRuntime.indexOf('name: "goal"');
const goalGuidelinesStart = goalRuntime.indexOf("promptGuidelines: [", goalToolStart);
const goalGuidelinesEnd = goalRuntime.indexOf("      ],", goalGuidelinesStart);
const goalToolMetadata = goalRuntime.slice(goalToolStart, goalGuidelinesEnd);
const goalDescription = propertyString(goalToolMetadata, "description", "Goal tool metadata");
const goalPromptSnippet = propertyString(goalToolMetadata, "promptSnippet", "Goal tool metadata");
check(goalDescription === "Manage one durable Goal on the current branch. `goal create` activates an explicit objective with one to eight completion criteria. Active Goals continue autonomously while blockers, pending interactions, or other managed work can delay continuation. Provider failures retry automatically. Repeated no-progress runs pause the Goal. User aborts pause the Goal instead of cancelling it. `goal pause` stops autonomous continuation until `goal resume` explicitly reactivates the Goal. Restored unfinished Goals remain paused until explicitly resumed. `goal modify` replaces the nonterminal contract and activates it. Cancellation means the user abandons the Goal. Completion requires one concrete evidence item per criterion. Actions return the current Goal state and whether it changed.", "Goal description must match the reviewed contract");
check(goalPromptSnippet === "Manage the branch-local Goal.", "Goal promptSnippet must match the reviewed contract");
checkSteBlock(goalDescription, "Goal description");
checkSteBlock(goalPromptSnippet, "Goal promptSnippet");
const goalGuidelines = staticStrings(goalRuntime.slice(goalGuidelinesStart, goalGuidelinesEnd), "Goal promptGuidelines");
const expectedGoalGuidelines = [
  "Call `goal create` only for a user message beginning with `/goal`.",
  "For bare `/goal`, call `goal status` and explain `/goal <objective>`.",
  "Use Goal for one durable outcome, not as a `todo` checklist.",
  "`goal modify` replaces the entire nonterminal contract, not individual fields.",
  "Call `goal cancel` only when the user explicitly abandons the Goal.",
  "Call `goal complete` only with concrete evidence for every criterion.",
];
check(JSON.stringify(goalGuidelines) === JSON.stringify(expectedGoalGuidelines), "Goal promptGuidelines must match the reviewed array");
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
  "Use `ask_user_question` when a user decision must direct the next step.",
  "Do not call `ask_user_question` while a Goal is active.",
];
check(JSON.stringify(askGuidelines) === JSON.stringify(expectedAskGuidelines), "Ask promptGuidelines must match the reviewed array");
checkSteGuidelines(askGuidelines, "Ask promptGuideline", "ask_user_question");
const askSchemaStart = askRuntime.indexOf("const askOptionSchema");
const askSchemaEnd = askRuntime.indexOf("export interface AskOption", askSchemaStart);
const askSchema = askRuntime.slice(askSchemaStart, askSchemaEnd);
const askSchemaDescriptions = [...askSchema.matchAll(/description:\s*("(?:\\.|[^"\\])*")/g)].map((match) => JSON.parse(match[1]));
check(askSchemaDescriptions.length === 8, "Ask schema must define eight field descriptions");
for (const description of askSchemaDescriptions) checkSchemaHow(description, "Ask schema description");
const expectedAskSchemaDescriptions = [
  "Unique option label up to 60 characters. Place the recommended option first and append (Recommended). Reserved labels are Other, Type something., and Next.",
  "Explain the outcome of choosing this option.",
  "Optional preview for single-select only.",
  "Decision question shown to the user.",
  "Short header up to 16 characters.",
  "Two to four authored options in display order.",
  "True enables multiple authored selections. Omit or use false for single-select. Multi-select options cannot include previews.",
  "One to four questions in display order.",
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
check(askDescription === "Ask the user one to four structured questions with single-select, multi-select, custom responses, and optional single-select previews. Each question accepts two to four authored options. Results report confirmed answers, partial completion, and cancellation as normal outcomes. `ask_user_question` is unavailable while a Goal is active.", "Ask description must match the reviewed contract");
check(askPromptSnippet === "Collect structured user decisions.", "Ask promptSnippet must match the reviewed contract");
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
  "Delegate and manage specialist runs.",
  "Delegate bounded specialist work with `subagent create` when an independent lane improves progress.",
  "`subagent create` starts new work, while `subagent resume` starts a new run from reusable terminal context.",
  "Complete continuation objective for resume.",
  "Complete answer to the waiting request for reply.",
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
hasAll(runtime, [
  "const DEFAULT_INTERRUPT_WAIT_MS = 8000",
  'const INTERRUPT_ERROR = "Interrupted by the parent session."',
  "interruptWaitMs?: number",
  "this.interruptWaitMs = options.interruptWaitMs ?? DEFAULT_INTERRUPT_WAIT_MS",
  "this.shutdownWaitMs = options.shutdownWaitMs ?? DEFAULT_SHUTDOWN_WAIT_MS",
  'export type InterruptOutcome = "already-terminal" | "stopped" | "raced" | "unconfirmed"',
  "private readonly reconciling = new Map<string, Promise<void>>()",
  "private readonly terminating = new Map<string, Promise<PersistedRun>>()",
  "private readonly notificationSuppression = new Map<string, number>()",
  "private generation = 0",
], "synchronous interrupt seams, outcome contract, and per-run termination sharing");
check(
  /async restore\(ctx: ExtensionContext, notificationDeliveryPaused = false\): Promise<void> \{\s*this\.generation \+= 1;/.test(runtime) &&
  /async shutdown\(\): Promise<void> \{\s*if \(this\.shuttingDown\) return;\s*this\.generation \+= 1;/.test(runtime),
  "restore and shutdown must bump the runtime generation before any other work",
);
check(
  deliverNotification.includes("this.notificationSuppression.has(id)") &&
  deliverNotification.indexOf("this.notificationSuppression.has(id)") < deliverNotification.indexOf("const run = this.registry.get(id)"),
  "run-scoped interrupt suppression must early-return from the single notification choke point",
);
const terminateStart = runtime.indexOf("private terminateRun(id: string, error: string, notify: boolean, waitMs = this.shutdownWaitMs)");
const terminateEnd = runtime.indexOf("private formatRunSummary(", terminateStart);
check(terminateStart >= 0 && terminateEnd > terminateStart, "runtime must keep one shared terminateRun that resolves with the final run");
const termination = runtime.slice(terminateStart, terminateEnd);
hasAll(termination, [
  "const inFlight = this.terminating.get(id)", "if (inFlight) return inFlight",
  ".then(() => this.runTermination(id, error, notify, waitMs))",
  "this.terminating.set(id, settled)", "this.terminating.delete(id)",
  "this.terminationConfirmed.set(id, true)", "this.terminationConfirmed.set(id, stopConfirmed)",
  "stopConfirmed = stopped.safeToCleanup", "await this.stopVerifiedProcess(target, id)",
  "this.acquireNotificationSuppression(id)",
  "this.terminateRun(id, INTERRUPT_ERROR, true, this.interruptWaitMs)",
  "const outcome: InterruptOutcome",
  "this.shuttingDown || this.generation !== generation || !this.registry.get(id)",
  "if (handed.notificationPending !== undefined) this.updateRun(id, { notificationPending: undefined })",
  "this.releaseNotificationSuppression(id)", "this.deliverPendingNotification(id)",
  "signal.addEventListener(\"abort\"", "signal.removeEventListener(", "abortError(",
], "synchronous interrupt termination, abort seam, suppression, and result handoff");
hasNone(termination, ["this.killPid", "process.kill", "this.signalProcess"], "termination must reuse the shared verified-process stop helper");
const reconcileGuardStart = runtime.indexOf("private reconcileRun(id: string): Promise<void>");
const reconcilePassStart = runtime.indexOf("private async runReconcilePass(id: string): Promise<void>", reconcileGuardStart);
check(reconcileGuardStart >= 0 && reconcilePassStart > reconcileGuardStart, "runtime must isolate reconciliation ownership from one reconcile pass");
const reconcileGuard = runtime.slice(reconcileGuardStart, reconcilePassStart);
hasAll(reconcileGuard, [
  "if (this.clearing) return Promise.resolve();",
  "if (this.terminating.has(id)) return Promise.resolve();",
  "if (this.reconciling.has(id)) return Promise.resolve();",
  "const pass = this.runReconcilePass(id).finally(() => { this.reconciling.delete(id); })",
  "this.reconciling.set(id, pass)",
], "reconciliation must skip terminated ownership and retain an awaitable in-flight pass");
check(
  reconcileGuard.indexOf("if (this.terminating.has(id)) return Promise.resolve();") <
    reconcileGuard.indexOf("if (this.reconciling.has(id)) return Promise.resolve();") &&
  reconcileGuard.indexOf("this.reconciling.set(id, pass)") > reconcileGuard.indexOf("const pass = this.runReconcilePass(id)"),
  "the termination guard must precede reconciliation reentrancy and each pass must be retained before returning",
);
hasAll(termination, [
  "private async settledByInFlightReconciliation(id: string)",
  "const inFlight = this.reconciling.get(id)",
  "await inFlight.catch(() => undefined)",
  "const reconciled = await this.settledByInFlightReconciliation(id)",
  "if (reconciled) return reconciled",
], "termination must wait out a reconciliation that acquired process-stop ownership first");
const runTerminationStart = termination.indexOf("private async runTermination(");
const reconciledWait = termination.indexOf("const reconciled = await this.settledByInFlightReconciliation(id)", runTerminationStart);
const terminationTarget = termination.indexOf("const target = this.validConfig(id)", runTerminationStart);
check(runTerminationStart >= 0 && reconciledWait > runTerminationStart && terminationTarget > reconciledWait,
  "termination must adopt an earlier reconciliation before reading control state or writing a second interrupt");
check(
  termination.indexOf("this.acquireNotificationSuppression(id)") < termination.indexOf("await this.awaitWithAbort("),
  "interrupt must acquire run-scoped suppression synchronously before any await",
);
const interruptDispatch = runtime.slice(runtime.indexOf('if (action === "steer") {'), runtime.indexOf("private async launchCreate("));
hasAll(interruptDispatch, ["return this.interruptRun(id, signal);"], "interrupt must dispatch through the synchronous termination handoff");
hasNone(interruptDispatch, ["Interrupt requested"], "interrupt must not return an enqueue-only receipt");
hasAll(monitorRuntime, [
  'export const MONITOR_ACTIONS = ["create", "delete", "list", "status"] as const',
  'export const MONITOR_PUBLIC_FIELDS = ["action", "abstract", "command", "cwd", "checkAfter", "notifyOn", "id", "start", "end"] as const',
  "export const MONITOR_MIN_CHECK_AFTER_MS = 10_000", "export const MONITOR_MAX_CHECK_AFTER_MS = 7 * 24 * 60 * 60 * 1_000",
  'export type MonitorNotificationKind = "matcher" | "silence" | "summary" | "terminal"',
  "export const monitorParameters = Type.Object({", "}, { additionalProperties: false });",
  'executionMode: "sequential"', 'name: "monitor"', 'spawnFn(shell, ["-lc", command]',
  'stdio: ["ignore", "pipe", "pipe"]', 'detached: true', "child.unref()", "StringDecoder", "notificationCursor",
  "const NOTIFICATION_LINE_CAP = 100", "const TERMINAL_DIAGNOSTIC_TAIL_LINES = 20",
  "pendingMatchLines: MonitorCombinedLine[]", "pendingMatchTotal: number",
  "private pendingMatchPayload(record: MonitorRecord): NotificationLines", "private terminalPayload(record: MonitorRecord): NotificationLines",
  "hasRunning(): boolean", "hasBlockingWork(): boolean", "Reserved for Goal", "setDeliveryPaused(paused: boolean)",
  "acknowledgeNotificationMessage", "retryQueuedNotificationsAfterAgentSettled", 'deliverAs: "steer", triggerTurn: true',
  "finalKillWaitMs", "forceTerminal(record", "trySignal(record", "safeGroupAlive(record", "try", "finally",
  "recentLines", "scanLogTail", "STATUS_SCAN_CHUNK", "renameSync(tempPath, record.logPath)",
  "returned", "omitted", "truncated", "notificationContentMaxBytes", "notificationDetailsMaxBytes", "toolContentMaxBytes",
  "truncatedBytes", "bytes]", "summaryItems", "buildSummaryNotification", "isAbsolute(shell)", "SIGTERM", "SIGKILL",
  "droppedBytes", "droppedLines", "MONITOR_NOTIFICATION_TYPE",
  "registerMessageRenderer(MONITOR_NOTIFICATION_TYPE, renderMonitorNotification)", "renderCall: renderMonitorCall", "renderResult: renderMonitorResult",
  "setUICtx(ui: ExtensionUIContext | undefined)", "refreshUI(): void", "this.widget.handleChange(change)", "this.widget.dispose()",
  "private buildUpdateNotification(", 'kind: "update"', "const state = this.operationalState(record, start, end, this.toolContentMaxBytes)", "combined: scan.lines",
  "lastOutputAt: record.lastOutputAt", "checkAfter: record.checkAfter",
], "Monitor runtime and visual wiring contract");
hasNone(monitorRuntime, [
  "parseLoopInterval", "canonicalizeLoopInterval", "./loop-runtime.js",
  "silenceReminderCount", "nextCheckAt",
], "Monitor silence threshold must stay self-contained and expose no extra public counters");
const monitorCheckAfterParser = monitorRuntime.slice(
  monitorRuntime.indexOf("export function canonicalizeMonitorCheckAfter"),
  monitorRuntime.indexOf("function formatSilenceDuration"),
);
hasAll(monitorCheckAfterParser, [
  "/^([1-9][0-9]*)([smhd])$/",
  "checkAfter must use one positive integer and one unit: s, m, h, or d.",
  "checkAfter must be between 10s and 7d inclusive.",
  "milliseconds < BigInt(MONITOR_MIN_CHECK_AFTER_MS) || milliseconds > BigInt(MONITOR_MAX_CHECK_AFTER_MS)",
  "checkAfter: canonicalizeMonitorCheckAfter(numericMilliseconds)",
], "Monitor checkAfter parser strict format, inclusive bounds, and canonical unit contract");
const monitorAcceptChunk = monitorRuntime.slice(
  monitorRuntime.indexOf("private acceptChunk(record: MonitorRecord"),
  monitorRuntime.indexOf("private flushStream(record: MonitorRecord"),
);
check(
  monitorAcceptChunk.indexOf("if (chunk.length > 0) this.noteOutputActivity(record)") >
    monitorAcceptChunk.indexOf('if (record.generation !== this.generation || record.status !== "running") return;') &&
  monitorAcceptChunk.indexOf("if (chunk.length > 0) this.noteOutputActivity(record)") < monitorAcceptChunk.indexOf("state.decoder.write(chunk)"),
  "Monitor silence anchor must update inside the generation and status guard and before any decoding",
);
const monitorSilenceBlock = monitorRuntime.slice(
  monitorRuntime.indexOf("private noteOutputActivity(record: MonitorRecord)"),
  monitorRuntime.indexOf("private trySignal(record: MonitorRecord"),
);
hasAll(monitorSilenceBlock, [
  "record.lastActivityMs = now", "record.lastOutputAt = new Date(now).toISOString()", "this.cancelSilenceReminder(record)",
  "if (deliveryKey !== undefined) this.notifications.delete(deliveryKey)",
  "record.silenceToken += 1", "const token = record.silenceToken + 1",
  "const delay = Math.min(Math.max(0, delayMs), record.checkAfterMs)",
  "(timer as { unref?: () => void }).unref?.()",
  "if (!current || current !== record || current.silenceToken !== token || generation !== this.generation) return;",
  "this.defer(() => this.onSilenceTimeout(record, token, generation))",
  "const elapsed = this.nowMs() - record.lastActivityMs",
  "if (elapsed < record.checkAfterMs) {",
  "this.prepareSilenceCheck(record, record.checkAfterMs - elapsed)",
  "this.notifySilence(record, elapsed)",
  "if (!this.silenceTimeoutStillOwns(record, token, generation)) return;",
  "if (!current || current !== record || current.silenceToken !== token || generation !== this.generation) return false;",
  'if (record.status !== "running" || record.deleting || this.shuttingDown) return false;',
], "Monitor lazy silence deadline, timer token, defer seam, and cancellation guards");
hasNone(monitorSilenceBlock, [
  "notificationCursor", "buildUpdateNotification", "sentMatcherAt", "rateLimitCount",
], "Monitor silence scheduling must not touch the incremental cursor or the matcher rate window");
const monitorSilenceBuilder = monitorRuntime.slice(
  monitorRuntime.indexOf("private buildSilenceNotification(record: MonitorRecord"),
  monitorRuntime.indexOf("private queueNotification(record: MonitorRecord"),
);
hasAll(monitorSilenceBuilder, [
  'kind: "silence"', 'status: "running"', "checkAfter: record.checkAfter", "silentFor,", "silentForMs: silentForRoundedMs",
  "lastOutputAt: record.lastOutputAt",
  "Math.max(0, Math.floor(silentForMs / 1_000)) * 1_000",
  "has produced no stdout or stderr output for ${silentFor}.",
  "Call monitor status with id ${record.id} now to check the current state of this monitor.",
  "const pending = pendingKey === undefined ? undefined : this.notifications.get(pendingKey)",
  "pending.content = built.content", "pending.details = built.details",
  'record.pendingSilenceKey = this.queueNotification(record, "silence", built.content, built.details)',
], "Monitor silence reminder payload and single in-place queue entry");
hasNone(monitorSilenceBuilder, [
  "buildUpdateNotification", "notificationCursor", "fitNotificationLines", "lines", "operationalState(",
], "Monitor silence reminder must never reuse the incremental update payload");
for (const [label, block] of [
  ["delete", monitorRuntime.slice(monitorRuntime.indexOf("private async delete(record: MonitorRecord"), monitorRuntime.indexOf("private attachProcess(record: MonitorRecord"))],
  ["finalize", monitorRuntime.slice(monitorRuntime.indexOf("private finalize(record: MonitorRecord"), monitorRuntime.indexOf("private forceTerminal(record: MonitorRecord"))],
  ["dispose", monitorRuntime.slice(monitorRuntime.indexOf("private disposeRecord(record: MonitorRecord"), monitorRuntime.indexOf("private detachListeners(record: MonitorRecord"))],
]) hasAll(block, ["this.cancelSilence(record)"], `Monitor ${label} must clear the silence timer and its queued reminder`);
const monitorCreateCommit = monitorRuntime.slice(
  monitorRuntime.indexOf("this.records.set(id, record);"),
  monitorRuntime.indexOf('this.emit({ type: "created"'),
);
hasAll(monitorCreateCommit, [
  "record.lastActivityMs = this.nowMs()",
  "this.applySilenceCheck(record, this.prepareSilenceCheck(record, record.checkAfterMs))",
  "this.records.delete(id)", 'this.trySignal(record, "SIGKILL", "create silence rollback KILL")',
], "Monitor silence timer activates only after the record is committed and rolls back the child on failure");
hasNone(monitorRuntime, ["registerCommand", "registerShortcut", "setWidget", "notify(", "nohup parser", "readFileSync", "writeFileSync", "partialLineMaxChars"], "Monitor delegated visual boundary");
check((monitorRuntime.match(/buildUpdateNotification\(/g) ?? []).length === 3, "Monitor matcher and terminal notifications must share exactly one payload builder and two call sites");
const monitorUpdateBuilder = monitorRuntime.slice(
  monitorRuntime.indexOf("private buildUpdateNotification("),
  monitorRuntime.indexOf("private finalize(record: MonitorRecord)"),
);
hasAll(monitorUpdateBuilder, [
  'const terminal = record.status !== "running"',
  "this.fitNotificationLines(record, payload, (lines, omitted, truncated)",
  "`Monitor ${record.id} (${abstract}) status ${record.status}.`",
  '`Matched: ${matched.join(", ")}.`',
  '`Exit code: ${exitCode ?? "null"}; signal: ${signal ?? "null"}; error: ${error ?? "null"}.`',
  "const exitCode = terminal ? record.exitCode : null",
  "const signal = terminal ? record.signal : null",
  "const error = terminal && record.error !== null ? boundedText(record.error, RESPONSE_TEXT_MAX).text : null",
  "matched: [...matched]",
  "exitCode,\n        signal,\n        error,",
  "[truncated: omitted ${omitted} lines and/or shortened oversized lines; use monitor status]",
  "lines,\n        omitted,\n        truncated,",
], "Monitor unified incremental update payload builder");
hasNone(monitorUpdateBuilder, [
  "operationalState(", "scanLogTail(", "logPath", "combined", "command", "cwd", "pid",
], "unified update payload must never embed full operational state");
const monitorAppendLine = monitorRuntime.slice(
  monitorRuntime.indexOf("private appendLine(record: MonitorRecord"),
  monitorRuntime.indexOf("private writeStructuredLine(record: MonitorRecord"),
);
hasAll(monitorAppendLine, [
  "const matched = record.notifyOn.filter((matcher) => text.includes(matcher))",
  "record.matchedCount += matched.length",
  "record.pendingMatchTotal += 1",
  "record.pendingMatchLines.push(line)",
  "if (record.pendingMatchLines.length > NOTIFICATION_LINE_CAP)",
  "record.pendingMatchLines.splice(0, record.pendingMatchLines.length - NOTIFICATION_LINE_CAP)",
], "Monitor records every matched line exactly once and bounds the pending match buffer");
const monitorMatchPayloads = monitorRuntime.slice(
  monitorRuntime.indexOf("private pendingMatchPayload(record: MonitorRecord)"),
  monitorRuntime.indexOf("private notificationLines(record: MonitorRecord"),
);
hasAll(monitorMatchPayloads, [
  "const lines = record.pendingMatchLines.map((line) => ({ ...line }))",
  "const omitted = Math.max(0, record.pendingMatchTotal - lines.length)",
  "totalNew: record.pendingMatchTotal",
  "record.pendingMatchLines = []",
  "record.pendingMatchTotal = 0",
  "const matches = this.pendingMatchPayload(record)",
  'if (record.status === "completed") return matches;',
  "const tail = this.notificationLines(record, record.notificationCursor, TERMINAL_DIAGNOSTIC_TAIL_LINES)",
  "const merged = new Map<number, MonitorCombinedLine>()",
  "for (const line of [...matches.lines, ...tail.lines]) merged.set(line.seq, line)",
  "const lines = [...merged.values()].sort((left, right) => left.seq - right.seq)",
  "const totalNew = Math.max(tail.totalNew, lines.length)",
], "Monitor match-only payloads, completed match-only terminal, and merged bounded failure tail");
hasNone(monitorMatchPayloads, [
  "scanLogTail", "logPath", "readSync", "operationalState(",
], "Monitor match-only payloads must never read the retained log file");
const monitorMatcherFlush = monitorRuntime.slice(
  monitorRuntime.indexOf("private flushMatcherBatch(record: MonitorRecord)"),
  monitorRuntime.indexOf("private expireRateWindow()"),
);
hasAll(monitorMatcherFlush, [
  "const payload = this.pendingMatchPayload(record)",
  "this.clearPendingMatches(record)",
  "record.notificationCursor = latest",
  "suppressed.lines += payload.totalNew",
  "this.buildUpdateNotification(record, keywords, payload)",
  'this.queueNotification(record, "matcher", fitted.content, fitted.details)',
], "Monitor matcher batch delivers matched lines only while the cursor still passes every new line");
hasNone(monitorMatcherFlush, [
  'kind: "matcher"', "fitNotificationLines", "operationalState(", "this.notificationLines(", "recentLines",
], "Monitor matcher batch must not keep a second payload template or replay unmatched lines");
const monitorFinalize = monitorRuntime.slice(
  monitorRuntime.indexOf("private finalize(record: MonitorRecord)"),
  monitorRuntime.indexOf("private forceTerminal(record: MonitorRecord"),
);
hasAll(monitorFinalize, [
  "const matched = [...record.matchKeywords]",
  "record.matchKeywords.clear()",
  "const payload = this.terminalPayload(record)",
  "this.clearPendingMatches(record)",
  "record.notificationCursor = record.nextSeq - 1",
  "this.buildUpdateNotification(record, matched, payload)",
  'this.queueNotification(record, "terminal", fitted.content, fitted.details)',
], "Monitor terminal close reuses the unified builder and reports the literals its pending matches hit");
hasNone(monitorFinalize, [
  "operationalState(record, 0, 100, 36 * 1024)", "operationalState(", "scanLogTail(", 'kind: "terminal"', "fitNotificationLines",
  "this.notificationLines(record, record.notificationCursor, 100)",
  "this.buildUpdateNotification(record, [], payload)",
], "Monitor terminal close must not scan the retained log, replay unmatched history, or drop its pending literals");
check(
  monitorFinalize.indexOf("this.cancelMatchTimer(record)") < monitorFinalize.indexOf("const matched = [...record.matchKeywords]") &&
  monitorFinalize.indexOf("const matched = [...record.matchKeywords]") < monitorFinalize.indexOf("record.matchKeywords.clear()"),
  "Monitor terminal close must capture the still unflushed literals after the batch timer stops and before the keyword set clears",
);
hasAll(monitorWidget, [
  'MONITOR_SECTION_ID = "monitors"', "MAX_MONITOR_WIDGET_LINES = 12", "MAX_VISIBLE_MONITORS = 10",
  "MONITOR_RENDER_THROTTLE_MS = 110", 'theme.bold("●")', 'theme.fg("accent", "↻")', '"✓"', '"!"', '"×"',
  "sortMonitorsForDisplay", "createdAt", "endedAt", 'theme.fg("dim", `… ${hidden} more`)', "lines.slice(0, MAX_MONITOR_WIDGET_LINES)",
  "change.reason === \"output\"", "scheduleRender()", "requestRender()", "dispose()",
  "isActive: () => hasRunningMonitors(this.listMonitors())",
  "if (!this.ui || !this.published) return;",
  "expanded = true", 'hint = ""', 'sorted.filter((monitor) => monitor.status === "running")',
  "const policyHidden = sorted.length - shown.length", "const hidden = shown.length - visible.length",
  "monitorHeadingLine(monitorWidgetHeading(monitors, theme), policyHidden > 0 ? hint : \"\", theme, safeWidth)",
], "Monitor foreground widget visual, collapse policy, and throttle contract");
hasNone(monitorWidget, ["notify(", "setStatus", "registerShortcut", "overlay", "setInterval("], "Monitor widget excluded UI");
hasAll(monitorWidget, [
  'export function countRunningMonitors(monitors: readonly MonitorWidgetItem[]): number {\n  return monitors.filter((monitor) => monitor.status === "running").length;',
  "export function hasRunningMonitors(monitors: readonly MonitorWidgetItem[]): boolean {\n  return countRunningMonitors(monitors) > 0;",
], "Monitor heading ratio and stack section share one running count");
const monitorHeadingBlock = monitorWidget.slice(
  monitorWidget.indexOf("function monitorWidgetHeading"),
  monitorWidget.indexOf("export function renderMonitorWidgetLines"),
);
hasAll(monitorHeadingBlock, [
  "const running = countRunningMonitors(monitors)",
  "const terminal = monitors.length - running",
  "const active = running > 0",
  'const role = active ? "accent" : "dim"',
  'const glyph = active ? theme.bold("●") : "○"',
  'const label = active ? theme.bold(`Monitors (${terminal}/${monitors.length})`) : `Monitors (${terminal}/${monitors.length})`',
  "formatSemanticGlyphPrefix(theme.fg(role, glyph))", "theme.fg(role, label)",
  'if (hint !== "" && visibleWidth(heading) + visibleWidth(hint) <= width)',
  '`${heading}${theme.fg("dim", hint)}`', 'return truncateToWidth(heading, width, "…")',
], "Monitor terminal-over-total heading, active-idle emphasis, and atomic dim expand hint");
hasNone(monitorHeadingBlock, [
  'theme.bold("○")', "${running}/", "sorted", "shown", "policyHidden", "theme.bold(hint)",
], "Monitor heading must count the whole retained set and never bold the idle glyph or the hint");
hasAll(monitorTranscriptRenderer, [
  "renderMonitorCall", "renderMonitorResult", "renderMonitorNotification", 'theme.bold("monitor")', 'monitorStatusGlyph("running", theme)',
  '`· ${safeAction}${expanded ? "" : " (ctrl+o to expand)"}`', "spacedResult", "safeFirstLine", "sanitizeMonitorBody",
  'theme.bold(`Monitors (${running}/${monitors.length})`)', "renderOperationalState", 'addCombinedLines(container, theme, "Combined lines"',
  'details?.kind === "update"', 'details?.kind === "silence"', 'details?.kind === "matcher"', 'details?.kind === "terminal"', 'details?.kind === "summary"',
  "function silenceNotification(value: UnknownRecord): SilenceNotification | undefined",
  "function renderSilenceNotification(details: SilenceNotification, expanded: boolean, theme: Theme): Component",
  "const lastOutputAt = state.lastOutputAt === undefined ? null : asNullableString(state.lastOutputAt)",
  'const checkAfter = state.checkAfter === undefined ? "" : asString(state.checkAfter)',
  'addField(container, theme, "Last output", state.lastOutputAt, 2)',
  'addField(container, theme, "Check after", state.checkAfter === "" ? null : state.checkAfter, 2)',
  'addField(container, theme, "Check after", args.checkAfter)',
  'Monitors · rate limited', 'matched ${details.matched.length}', "Incremental lines", "Forced deletion",
  "ExpandableNotificationLine", 'theme.fg("muted", " (ctrl+o to expand)")', "visibleWidth(this.hint)",
  "function updateNotification(value: UnknownRecord): UpdateNotification | undefined",
  "function renderUpdateNotification(details: UpdateNotification, expanded: boolean, theme: Theme): Component",
  "Legacy pre-`update` matcher payload", "Legacy pre-`update` terminal payload",
], "Monitor Ctrl+O, result, and notification visual contract");
hasNone(monitorTranscriptRenderer, ["\\u001b", "registerShortcut", "notify(", "overlay", '"Action"'], "Monitor renderer theme-only visual contract");
const monitorUpdateRenderBlock = monitorTranscriptRenderer.slice(
  monitorTranscriptRenderer.indexOf("function renderUpdateNotification"),
  monitorTranscriptRenderer.indexOf("interface MatcherNotification"),
);
hasAll(monitorUpdateRenderBlock, [
  'monitorStatusGlyph(details.status, theme)', '` · ${details.status}${matchedSuffix}`',
  '` · matched ${details.matched.length}`', 'addField(container, theme, "Status", details.status)',
  'addStringList(container, theme, "Matched", details.matched)', 'addField(container, theme, "Exit code", details.exitCode)',
  'addField(container, theme, "Signal", details.signal)', 'addSection(container, theme, "Error"',
  'addField(container, theme, "Omitted", details.omitted)', 'addField(container, theme, "Truncated", details.truncated)',
  'addCombinedLines(container, theme, "Incremental lines", details.lines)',
], "unified update notification renderer layout");
hasNone(monitorUpdateRenderBlock, [
  "renderOperationalState", "Log path", "Combined lines", "Notification stats", "operationalStateFromValue",
], "unified update notification renderer must not display full operational state");
const monitorSilenceRenderBlock = monitorTranscriptRenderer.slice(
  monitorTranscriptRenderer.indexOf("function renderSilenceNotification"),
  monitorTranscriptRenderer.indexOf("interface MatcherNotification"),
);
hasAll(monitorSilenceRenderBlock, [
  "monitorStatusGlyph(details.status, theme)", "` · silent ${sanitizeMonitorText(details.silentFor)}`",
  "if (!expanded) return new ExpandableNotificationLine(head, tail, theme)",
  'addField(container, theme, "Status", details.status)', 'addField(container, theme, "Check after", details.checkAfter)',
  'addField(container, theme, "Silent for", details.silentFor)', 'addField(container, theme, "Last output", details.lastOutputAt)',
], "silence reminder notification renderer layout");
hasNone(monitorSilenceRenderBlock, [
  "renderOperationalState", "addCombinedLines", "Incremental lines", "operationalStateFromValue", "Matched",
], "silence reminder renderer must not display incremental output or full operational state");
const trustedBashStart = monitorRuntime.indexOf('candidates.push(\n    "/bin/bash"');
const pathBashFallback = monitorRuntime.indexOf('String(process.env.PATH ?? "").split(delimiter)', trustedBashStart);
check(trustedBashStart >= 0 && trustedBashStart < pathBashFallback, "Monitor must prefer trusted absolute bash candidates before PATH fallback");
const monitorSchemaStart = monitorRuntime.indexOf("export const monitorParameters");
const monitorSchemaEnd = monitorRuntime.indexOf("export class MonitorRuntime", monitorSchemaStart);
const monitorSchema = monitorRuntime.slice(monitorSchemaStart, monitorSchemaEnd);
check(!monitorSchema.includes("anyOf:") && !monitorSchema.includes("oneOf:"), "Monitor schema root must not declare anyOf or oneOf");
const monitorSchemaDescriptions = [...monitorSchema.matchAll(/description:\s*("(?:\\.|[^"\\])*")/g)].map((match) => JSON.parse(match[1]));
const expectedMonitorSchemaDescriptions = [
  "Choose an action. create requires abstract, command, and checkAfter, with optional cwd and notifyOn. delete requires id. status requires id, with optional start and end. list accepts no other fields.",
  "Short command summary for create.",
  "Foreground Bash command for create. Do not use nohup, setsid, disown, trailing &, or another detach escape.",
  "Working directory for create. Defaults to the current session directory.",
  "Required silence threshold for create, from 10s through 7d. A reminder arrives whenever the command stays silent that long. Format: one positive integer plus s, m, h, or d.",
  "Up to 20 unique case-sensitive literal matchers for create. Each matcher is at most 500 characters.",
  "Exact eight-character lowercase hexadecimal monitor ID for delete or status.",
  "Newest retained log lines to skip for status. Defaults to 0.",
  "Reverse log offset ending the status window. Defaults to 100 and must exceed start by at most 2000.",
];
check(JSON.stringify(monitorSchemaDescriptions) === JSON.stringify(expectedMonitorSchemaDescriptions), "Monitor schema descriptions must match the HOW contract");
for (const description of monitorSchemaDescriptions) checkSchemaHow(description, "Monitor schema description");
const monitorToolStart = monitorRuntime.indexOf('name: "monitor"');
const monitorGuidelinesStart = monitorRuntime.indexOf("promptGuidelines: [", monitorToolStart);
const monitorGuidelinesEnd = monitorRuntime.indexOf("      ],", monitorGuidelinesStart);
const monitorToolMetadata = monitorRuntime.slice(monitorToolStart, monitorGuidelinesEnd);
const monitorDescription = propertyString(monitorToolMetadata, "description", "Monitor tool metadata");
const monitorPromptSnippet = propertyString(monitorToolMetadata, "promptSnippet", "Monitor tool metadata");
check(monitorDescription === "Run and manage long-running foreground Bash commands on POSIX systems while Pi remains available. Each monitor owns the command's foreground process group. Matcher notifications carry the current status and only the new lines that matched a `notifyOn` literal. Terminal notifications carry the final status, exit code, signal, error, and any matched lines no earlier notification delivered. A failed or killed command also adds a bounded recent diagnostic tail. A silence reminder arrives whenever a running command produces no output for its `checkAfter` threshold. Summary notifications report rate-limited matcher batches. `notifyOn` performs case-sensitive literal matching. `monitor list` returns compact retained records. `monitor status` returns one record's full retained state and combined logs. `monitor delete` stops a running group when needed and removes its retained record. Terminal records remain available until deletion. Runtime shutdown terminates active groups and clears retained monitor data.", "Monitor description must match the reviewed contract");
check(monitorPromptSnippet === "Supervise long-running foreground commands.", "Monitor promptSnippet must match the reviewed contract");
checkSteBlock(monitorDescription, "Monitor description");
checkSteBlock(monitorPromptSnippet, "Monitor promptSnippet");
const monitorGuidelines = staticStrings(monitorRuntime.slice(monitorGuidelinesStart, monitorGuidelinesEnd), "Monitor promptGuidelines");
const expectedMonitorGuidelines = [
  "Never detach a `monitor create` command with nohup, setsid, disown, trailing &, or another daemon escape.",
  "Do not poll a running monitor with repeated `monitor status` calls.",
  "Matcher updates carry matching lines, terminal updates add pending matches and bounded failure tails, and `monitor status` returns everything retained.",
];
check(JSON.stringify(monitorGuidelines) === JSON.stringify(expectedMonitorGuidelines), "Monitor promptGuidelines must match the reviewed array");
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
  'LOOP_SECTION_ID = "loops"', "MAX_LOOP_WIDGET_LINES = 12", "MAX_VISIBLE_LOOPS = 5",
  "truncateToWidth(loopWidgetHeading(sorted, theme), safeWidth, \"…\")", 'theme.fg("accent", "↻")', '"Ⅱ"', '"!"',
  'parts.push(`next in ${formatLoopCountdown', 'parts.push("paused", fireLabel', "failureLabel(loop.failureCount)",
  "sortLoopsForDisplay", "nextFireAt", "createdAt", 'setIntervalFn(() => this.update(), 1_000)',
  "requestRender()", "stopTimer()", "dispose()", "publish(LOOP_SECTION_ID, undefined)",
  'theme.fg("dim", `… ${hidden} more`)', "lines.slice(0, MAX_LOOP_WIDGET_LINES)",
], "Loop foreground widget visual contract");
hasNone(loopWidget, ["notify(", "registerShortcut", "custom(", "overlay"], "Loop widget excluded UI");
const loopHeadingBlock = loopWidget.slice(
  loopWidget.indexOf("function loopWidgetHeading"),
  loopWidget.indexOf("export function renderLoopWidgetLines"),
);
hasAll(loopHeadingBlock, [
  "const active = hasActiveLoops(loops)",
  'const role = active ? "accent" : "dim"',
  'const glyph = active ? theme.bold("●") : "○"',
  'const label = active ? theme.bold("Loops") : "Loops"',
  "formatSemanticGlyphPrefix(theme.fg(role, glyph))", "theme.fg(role, label)",
], "Loop ratio-free active-idle heading visual");
hasAll(loopWidget, [
  'export function hasActiveLoops(loops: readonly PublicLoop[]): boolean {\n  return loops.some((loop) => loop.status === "active");',
  "isActive: () => hasActiveLoops(this.listLoops())",
], "Loop heading and stack section share one active predicate");
hasNone(loopHeadingBlock, ['theme.bold("○")', "Loops (", "${active}", "hint"], "Loop heading must drop the ratio, the bold idle glyph, and any expand hint");
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
  "Choose an action. create requires interval, abstract, and prompt. modify requires id and at least one changed field. delete, pause, and resume require id. list accepts no other fields.",
  "Exact eight-character lowercase hexadecimal loop ID for delete, modify, pause, or resume.",
  "Fixed delay for create or modify, from 10s through 7d. Format: one positive integer plus s, m, h, or d.",
  "Short loop summary for create or modify.",
  "Complete future-turn prompt for create or modify.",
];
check(JSON.stringify(loopSchemaDescriptions) === JSON.stringify(expectedLoopSchemaDescriptions), "Loop schema descriptions must match the HOW contract");
for (const description of loopSchemaDescriptions) checkSchemaHow(description, "Loop schema description");
const loopToolStart = loopRuntime.indexOf('name: "loop"');
const loopGuidelinesStart = loopRuntime.indexOf("promptGuidelines: [", loopToolStart);
const loopGuidelinesEnd = loopRuntime.indexOf("      ],", loopGuidelinesStart);
const loopToolMetadata = loopRuntime.slice(loopToolStart, loopGuidelinesEnd);
const loopDescription = propertyString(loopToolMetadata, "description", "Loop tool metadata");
const loopPromptSnippet = propertyString(loopToolMetadata, "promptSnippet", "Loop tool metadata");
check(loopDescription === "Create and manage runtime-only fixed-delay loops from 10s through 7d. Creation and resume wait one full interval before firing. Each later delay starts only after the previous tick finishes. Each fire delivers the stored prompt for a future turn. Loop state survives compaction and tree navigation within the current runtime. Reload, session replacement, and shutdown clear every loop. Actions return current loop state, change receipts, or the retained loop list.", "Loop description must match the reviewed contract");
check(loopPromptSnippet === "Manage fixed-delay prompt loops.", "Loop promptSnippet must match the reviewed contract");
checkSteBlock(loopDescription, "Loop description");
checkSteBlock(loopPromptSnippet, "Loop promptSnippet");
const loopGuidelines = staticStrings(loopRuntime.slice(loopGuidelinesStart, loopGuidelinesEnd), "Loop promptGuidelines");
const expectedLoopGuidelines = [
  "Call `loop create` only for a user message beginning with `/loop`.",
  "For bare `/loop`, call `loop list` and explain `/loop <interval> <prompt>`.",
  "Make every `loop create` prompt self-contained and repeatable for future turns.",
];
check(JSON.stringify(loopGuidelines) === JSON.stringify(expectedLoopGuidelines), "Loop promptGuidelines must match the reviewed array");
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
check(
  restoreNotificationFlow.includes("`terminating` and `notificationSuppression` deliberately survive a generation change"),
  "restore must document why shared termination and suppression ownership outlives a generation change",
);
hasNone(restoreNotificationFlow, ["this.terminating.clear()", "this.notificationSuppression.clear()"], "restore must not drop shared termination or suppression ownership");
hasNone(runtime.slice(shutdownStart, shutdownEnd), ["this.terminating.clear()", "this.notificationSuppression.clear()"], "shutdown must not drop shared termination or suppression ownership");
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
const summaryFormatterStart = runtime.indexOf("private formatRunSummary(run: PersistedRun)");
const statusFormatterStart = runtime.indexOf("private formatRunStatus(run: PersistedRun)", summaryFormatterStart);
const fullFormatterStart = runtime.indexOf("private formatRun(run: PersistedRun)", statusFormatterStart);
const listActionStart = runtime.indexOf('if (action === "list") {', fullFormatterStart);
const listActionEnd = runtime.indexOf("const id = requireString", listActionStart);
check(summaryFormatterStart >= 0 && statusFormatterStart > summaryFormatterStart && fullFormatterStart > statusFormatterStart, "runtime must split list summary, single-run status, and rich lifecycle formatters");
const summaryFormatter = runtime.slice(summaryFormatterStart, statusFormatterStart);
const statusFormatter = runtime.slice(statusFormatterStart, fullFormatterStart);
hasAll(summaryFormatter, [
  "id: run.id", "agent: run.agent", "abstract: run.abstract", "status: run.status", "live:", "sourceRunId", "reason",
], "list summary formatter");
hasNone(summaryFormatter, ["...run", "output", "error", "task:", "cwd:", "model:", "deniedTools:", "createdAt:", "updatedAt:", "sessionFile:", "activity:", "notificationPending:"], "list summary formatter");
hasAll(statusFormatter, [
  "const summary = this.formatRunSummary(run)", "if (!isTerminalStatus(run.status)) return summary",
  "...summary", "run.output !== undefined", "run.error !== undefined",
], "single-run status formatter");
hasNone(statusFormatter, ["...run", "task:", "cwd:", "model:", "deniedTools:", "createdAt:", "updatedAt:", "sessionFile:", "activity:", "notificationPending:"], "single-run status formatter");
const listAction = runtime.slice(listActionStart, listActionEnd);
hasAll(listAction, ["reconcileAll", "this.registry.list()", "formatRunSummary", "JSON.stringify(runs, null, 2)", "{ runs }"], "retained-run list action");
hasNone(listAction, ["formatRunStatus", ".formatRun(", "this.activity", "ACTIVE_STATUSES.has(run.status)", ".task"], "list action");
const statusActionStart = runtime.indexOf('if (action === "status") {', listActionEnd);
const statusActionEnd = runtime.indexOf('if (action === "reply")', statusActionStart);
const statusAction = runtime.slice(statusActionStart, statusActionEnd);
hasAll(statusAction, ["this.formatRunStatus(this.requireRun(id))", "JSON.stringify(run, null, 2)", "{ run }"], "single retained-run status action");
const terminalRaceStart = runtime.indexOf("if (isTerminalStatus(run.status)) {", statusActionEnd);
const terminalRaceEnd = runtime.indexOf("const target = this.validConfig(id);", terminalRaceStart);
check(terminalRaceStart > statusActionEnd && terminalRaceEnd > terminalRaceStart, "steer and interrupt must share one terminal-status branch before control writing");
const terminalRace = runtime.slice(terminalRaceStart, terminalRaceEnd);
hasAll(terminalRace, [
  "const terminalRun = this.formatRunSummary(run)",
  'const alreadyTerminal: InterruptOutcome = "already-terminal"',
  'action === "interrupt" ? { run: terminalRun, outcome: alreadyTerminal } : { run: terminalRun }',
  "`${id} is already ${run.status}.`", "toolText(`${id} is already ${run.status}.`, terminalDetails)",
], "terminal steer and interrupt race receipts must carry only the public run summary");
hasNone(terminalRace, [
  "run.output", "run.error", "this.activity", "formatRunStatus", "deliverPendingNotification",
  "notificationPending", "queuedNotifications", "deliveryKey", "controlWriter", "acquireNotificationSuppression",
], "terminal steer and interrupt race receipts");
check(runtime.indexOf("await this.reconcileRun(id)", listActionEnd) < statusActionStart, "status must reconcile its ID before reading the latest registry value");
hasAll(runtime, [
  'if ((action === "status" || action === "interrupt") && input.message !== undefined)',
  'throw new Error(`${action} does not accept message.`)',
  'const createFields = ["agent", "abstract", "task", "cwd"]',
], "status action field isolation");
const resumeDispatchStart = runtime.indexOf('if (action === "resume") {');
const resumeDispatchEnd = runtime.indexOf("const createFields =", resumeDispatchStart);
check(resumeDispatchStart >= 0 && resumeDispatchEnd > resumeDispatchStart, "resume must dispatch before the shared create-field rejection");
const resumeDispatch = runtime.slice(resumeDispatchStart, resumeDispatchEnd);
hasAll(resumeDispatch, [
  'const invalidFields = ["agent", "task"]',
  "resume does not accept field(s): ${invalidFields.join(\", \")}",
  'const cwd = input.cwd === undefined ? undefined : requireString(input.cwd, "cwd")',
  "return this.resume(id, abstract, message, cwd)",
], "resume optional cwd dispatch");
check(!resumeDispatch.includes('["agent", "task", "cwd"]'), "resume must accept an optional cwd override");
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
  "removeRunFiles(this.pathsFor(run.id))", "this.purgeChildSessionFiles(runs, [])",
], "Subagent-owned run-directory and child-session clear guards");
const clearBoundary = runtime.slice(purgeStart, clearEnd);
hasNone(clearBoundary, [
  "replayGoalBranch", "goalOwnedRunIds", "removeGoalStatsSidecar", "goalStatsRoot", "Goal stats", "sidecar",
], "subagent clear must not inspect, remove, or warn about Goal stats");
hasNone(clearImplementation, [
  "this.goalActivity.delete", "this.loadedGoalStatsSidecars.delete",
], "subagent clear must preserve Goal stats memory and lazy-read state");
hasAll(runtime, [
  "removeChildSessionFile(childDir, run.sessionFile)", "canonicalSessionFile", "another retained run still references it",
  "private requireRun(id: string)", "was cleared from the subagent history",
  "this.registry.get(id) || this.clearedRunIds.has(id)",
  "if (this.shuttingDown || this.clearing) return", "if (this.clearing) return",
], "clear safety, cleared-ID reservation, and callback race guards");
hasNone(purge, ["realpathSync", "isSafePathSegment", "rmSync", "unlinkSync", "lstatSync"], "clear must delegate to the shared run-file security helpers");
const resumeStart = runtime.indexOf("private async resume(");
const resumeEnd = runtime.indexOf("private reply(", resumeStart);
check(resumeStart >= 0 && resumeEnd > resumeStart, "resume implementation must precede reply");
const resumeImplementation = runtime.slice(resumeStart, resumeEnd);
hasAll(resumeImplementation, [
  "private async resume(sourceId: string, abstract: string, message: string, cwd?: string)",
  "cwd: cwd === undefined ? source.cwd : resolve(this.ctx?.cwd ?? process.cwd(), cwd),",
  "const result = await this.launchRun(run, source.sessionFile)",
], "resume must inherit the source directory and resolve a relative override against the parent session");
hasNone(resumeImplementation, [
  "existsSync(cwd", "statSync", "readLaunchConfig", "shouldApproveChildProject", "isProjectTrusted",
], "resume cwd override must reuse the shared launch and approval chain without extra preconditions");
const publicSchema = runtime.slice(runtime.indexOf("export const subagentParameters"), runtime.indexOf("export class OmpsSubagentRuntime"));
hasNone(publicSchema, REMOVED_CAPABILITIES, "public tool schemas");
hasAll(publicSchema, [
  "export const subagentParameters = Type.Object({", "}, { additionalProperties: false });",
  'description: "Specialist role for create."',
  'description: "Short run summary for create or resume."',
  'description: "Complete bounded objective for create."',
  "description: \"Working directory for create or resume. Relative paths resolve against the parent working directory. Create defaults to the parent working directory. Resume defaults to the source run's working directory.\"",
  'description: "Retained run ID for status, steer, interrupt, resume, or reply."',
], "subagent schema descriptions");
const publicSchemaDescriptions = [...publicSchema.matchAll(/description:\s*("(?:\\.|[^"\\])*")/g)].map((match) => JSON.parse(match[1]));
const expectedSubagentSchemaDescriptions = [
  "Specialist role for create.",
  "Short run summary for create or resume.",
  "Complete bounded objective for create.",
  "Working directory for create or resume. Relative paths resolve against the parent working directory. Create defaults to the parent working directory. Resume defaults to the source run's working directory.",
  "Choose create, list, status, interrupt, steer, resume, reply, or clear. create requires agent, abstract, and task, with optional cwd. status and interrupt require id. steer and reply require id and message. resume requires id, abstract, and message, with optional cwd. list and clear accept no other fields.",
  "Retained run ID for status, steer, interrupt, resume, or reply.",
  "New instruction for steer. Complete continuation objective for resume. Complete answer to the waiting request for reply.",
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
check(subagentDescription === "Create and manage retained specialist runs through eight lifecycle actions. `subagent create` starts an independent run and returns its run ID immediately. `subagent list` returns a compact overview of every retained run without output or errors. `subagent status` returns one run and includes terminal output or error when available. Waiting and terminal notifications deliver complete requests, results, and errors. `subagent resume` starts a new run from reusable terminal context, optionally in another working directory. `subagent reply` continues the same waiting run after an answer. `subagent steer` sends a new instruction to a running run. `subagent interrupt` stops a live run, waits for its terminal status, and returns that result without a separate notification. `subagent clear` removes all retained history only when every run is terminal. Reload, tree navigation, and session replacement interrupt active runs but retain their history. Clearing Subagent history never changes Goal statistics.", "subagent description must match the reviewed contract");
check(subagentPromptSnippet === "Delegate and manage specialist runs.", "subagent promptSnippet must match the reviewed contract");
checkSteBlock(subagentDescription, "subagent description");
checkSteBlock(subagentPromptSnippet, "subagent promptSnippet");
const expectedSubagentGuidelines = [
  "Delegate bounded specialist work with `subagent create` when an independent lane improves progress.",
  "Give concurrent `subagent create` runs disjoint writer ownership and nonconflicting dependencies.",
  "Do not duplicate work owned by a starting, running, or waiting `subagent` run.",
  "`subagent create` starts new work, while `subagent resume` starts a new run from reusable terminal context.",
  "`subagent list` summarizes retained runs, while `subagent status` returns one run's detailed result.",
  "Use `subagent reply` only to answer the complete request from that same waiting run.",
  "Use `subagent steer` only for a genuine new instruction, not polling or reassurance.",
  "Use `subagent interrupt` only to stop a starting, running, or waiting run and wait for its final result.",
  "`subagent interrupt` is not rollback, so inspect partial file changes before continuing.",
  "Use `subagent clear` only when every run is terminal and all retained history should be removed.",
];
check(JSON.stringify(subagentGuidelines) === JSON.stringify(expectedSubagentGuidelines), "subagent promptGuidelines must match the reviewed array");
checkSteGuidelines(subagentGuidelines, "subagent promptGuideline", "subagent");
const subagentGuidelineText = subagentGuidelines.join("\n");
check(!/request ID|waitingSeq|deliveryKey|legacy|saved child-session/i.test(`${subagentDescription}\n${subagentPromptSnippet}\n${subagentGuidelineText}`), "subagent model metadata must not expose internal terms");
check(!runtime.includes(REMOVED_WAIT_TOOL), "runtime must not register or mention the removed wait tool");
hasAll(core, [
  '"create"', '"list"', '"status"', '"interrupt"', '"steer"', '"resume"', '"reply"', '"clear"',
  "RunJournalReplacement", "version: 3", "runJournalReplacementEntry", "runJournalClearEntry",
  "clearedRunIds", "everSeen", "clear(): void",
  '"starting"', '"running"', '"waiting"', '"completed"', '"failed"', '"interrupted"',
  "restoreSnapshot",
  "SubagentRegistry", "legacyRunAbstract", "waitingSeq", "abstract",
  "compareRetainedSubagentRuns", "sortRetainedSubagentRuns", 'status === "running" || status === "waiting"',
  'status === "starting"', "right.updatedAt.localeCompare(left.updatedAt)", "right.createdAt.localeCompare(left.createdAt)",
], "runtime core");
hasNone(core, [...REMOVED_CAPABILITIES, "SUPERVISOR_ACTIONS", "SUPERVISOR_PUBLIC_FIELDS", "pending(): SupervisorRequest", "replyTo"], "runtime core");
check(/SUBAGENT_ACTIONS = \[\s*"create",\s*"list",\s*"status",\s*"interrupt",\s*"steer",\s*"resume",\s*"reply",\s*"clear",\s*\] as const/.test(core), "SUBAGENT_ACTIONS must keep the exact unified action order");

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
  "Request type: need_decision, interview_request, or progress_update.",
  "Complete context the orchestrator needs to respond. Defaults to the selected reason when omitted or blank.",
  "Optional short interview title.",
  "Optional short identifier for matching a question.",
  "Question the orchestrator should answer.",
  "Optional authored answer choices.",
  "Authored interview questions in display order.",
  "Structured interview details for interview_request.",
];
check(JSON.stringify(contactSchemaDescriptions) === JSON.stringify(expectedContactSchemaDescriptions), "contact_supervisor schema descriptions must match the reviewed contract");
for (const description of contactSchemaDescriptions) checkSchemaHow(description, "contact_supervisor schema description");
const contactToolStart = child.indexOf('name: "contact_supervisor"');
const contactGuidelinesStart = child.indexOf("promptGuidelines: [", contactToolStart);
const contactGuidelinesEnd = child.indexOf("    ],", contactGuidelinesStart);
const contactToolMetadata = child.slice(contactToolStart, contactGuidelinesEnd);
const contactDescription = propertyString(contactToolMetadata, "description", "contact_supervisor tool metadata");
const contactPromptSnippet = propertyString(contactToolMetadata, "promptSnippet", "contact_supervisor tool metadata");
check(contactDescription === "Request an orchestrator response for a decision, structured interview, or progress update. Every call moves the child run to waiting, including progress updates. The result records the request context and ends the current child turn. Work continues in the same run after the orchestrator replies.", "contact_supervisor description must match the reviewed contract");
check(contactPromptSnippet === "Request an orchestrator response.", "contact_supervisor promptSnippet must match the reviewed contract");
checkSteBlock(contactDescription, "contact_supervisor description");
checkSteBlock(contactPromptSnippet, "contact_supervisor promptSnippet");
const contactGuidelines = child.slice(contactGuidelinesStart, contactGuidelinesEnd);
const contactGuidelineValues = staticStrings(contactGuidelines, "contact_supervisor promptGuidelines");
const expectedContactGuidelines = [
  "Use `contact_supervisor` whenever child work requires an orchestrator reply.",
  "Every `contact_supervisor` reason waits for that reply, including `progress_update`.",
];
check(JSON.stringify(contactGuidelineValues) === JSON.stringify(expectedContactGuidelines), "contact_supervisor promptGuidelines must match the reviewed array");
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
hasNone(runFiles, ["export function removeGoalStatsSidecar"], "Goal stats sidecars must not expose a clear-time deletion API");
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
  "clear ignores Goal ownership and never replays or reads/removes Goal stats",
  "clear preserves memory-only Goal stats after sidecar write failure",
  "clear empties registry, list, and widget while Goal stats remain lazy-readable",
  "clear retains an unsafe run directory and still clears the registry consistently",
  "clear blocks poll and agent-settled callbacks from reviving a targeted run",
  "every ID-bearing action reports a cleared run explicitly and never reuses its ID",
  "clear rejects unknown fields and stays exactly { action: clear }",
  "guarded child session removal rejects unsafe paths directly",
  "subagent list stays compact across all six statuses while status isolates one latest retained result",
  "subagent status reconciles before reading the latest registry and distinguishes unknown IDs",
  "reload and restore retain terminal results for status until clear removes the run",
  "a steer that loses the terminal race stays compact while the queued notification keeps the only full result",
], "Subagent clear and retained-history list tests");
hasAll(subagentRuntimeTests, [
  "interrupt stops a running run synchronously, returns the full result, and sends no notification",
  "interrupting a waiting run keeps its waiting notification and adds no retry",
  "interrupt accepts natural completion inside its wait window and never sends a terminal notification",
  "interrupt of an already terminal run writes no control and never steals its notification",
  "interrupt escalates to verified SIGTERM then SIGKILL when the runner never publishes a terminal state",
  "interrupt never signals an unverifiable runner and reports an unconfirmed stop",
  "interrupt of a dead runner adopts the failed reconciliation without a control",
  "two concurrent interrupts share one termination and both receive the same final result",
  "poller reconciliation during an interrupt never delivers the suppressed terminal notification",
  "an aborted interrupt keeps its control and replays the pending notification exactly once",
  "a shutdown during an interrupt refuses the handoff and journals the pending notification for the next session",
  "a restore during an interrupt refuses the handoff and delivers the pending notification exactly once",
  "poller failure paths never duplicate a termination that an interrupt already owns",
  "an interrupt waits out a reconciliation that already owns the stop and never duplicates it",
  "a handed-back terminal event never replays after restore",
], "synchronous subagent interrupt handoff tests");
hasAll(subagentRuntimeTests, [
  "resume inherits the source run working directory and resolves cwd overrides like create",
  "resume rejects a blank cwd and still refuses agent and task",
], "resume optional cwd override tests");
hasAll(read("tests/subagent-transcript-renderer.test.mjs"), [
  "synchronous interrupt outcomes collapse to the final result and expand its complete output and error",
  "expanded resume calls show a cwd override and fall back to the source run cwd",
], "synchronous interrupt outcome and resume cwd renderer tests");
hasAll(subagentRuntimeTests, [
  '["abstract", "agent", "id", "live", "status"]',
  'assert.equal(controls(harness, id).length, 0, "a terminal run never receives a steer control")',
  "assert.equal(harness.runtime.registry.get(id).notificationPending, status)",
  "assert.equal(harness.runtime.queuedNotifications.has(sent.message.details.deliveryKey), true)",
  "assert.doesNotMatch(JSON.stringify(result.details), /SENTINEL/)",
], "Subagent terminal steer race compact receipt and untouched notification lifecycle test");
const subagentWidgetTests = read("tests/subagent-widget.test.mjs");
hasAll(subagentWidgetTests, [
  "terminal runs never drop or linger out and dispose clears widget, status, and timer",
  "shared retained sorting keeps list, restored state, and widget IDs in active, starting, terminal-newest parity",
  "a retained terminal run keeps the widget registered",
  "clearing every retained run removes the widget",
  "↻  0 · 5.0s", "[●⠋↻◦✓] [^ ]|[●⠋↻◦✓] {3}", "visibleWidth(line) <= terminalWidth",
  "persistent widget heading counts terminal over retained runs with Todo-parity active and idle roles",
  "persistent widget heading refreshes on every live-to-terminal flip and clears with the last retained run",
  '"**●**  **Agents (5/8)**"', '"○  Agents (5/5)"', '"**●**  **Agents (1/2)**"', '"**●**  **Agents (2/3)**"',
  '"\\u001b[35m\\u001b[1m●\\u001b[22m\\u001b[0m  \\u001b[35m\\u001b[1mAgents (5/8)\\u001b[22m\\u001b[0m"',
  '"\\u001b[2m○\\u001b[0m  \\u001b[2mAgents (5/5)\\u001b[0m"',
  "must count as live and stay out of the numerator",
  "an all-terminal widget must not render any accent role",
  "the idle heading must stay dim without bold emphasis",
  "hidden rows never change the retained counts", "two hidden terminal rows still count toward the heading",
  "clearing every retained run unregisters the widget", "roleAnsiTheme",
  "collapsed Agents body keeps starting, running, and waiting rows and hides every terminal run",
  "expanded keeps the previous body byte for byte",
  '"**●**  **Agents (3/6)** · ctrl+o to expand"', '["○  Agents (3/3) · ctrl+o to expand"]',
  "a collapsed widget with nothing hidden shows no hint at all",
  "an all-terminal collapsed widget keeps a heading-only body with no tree",
  "the last collapsed active entry keeps its three-line block and closes the tree",
  "withConfiguredExpandKey", '"app.tools.expand"', '" · ctrl+shift+e to expand"',
  "the hint renders identically in the active and idle heading states",
  "the hint is never bold", "must drop the whole hint, never half of it",
  "heading counts ignore both filtering and overflow",
  "policy-hidden terminal runs stay out of the overflow summary",
  "three whole lines per surviving active run plus the queued row, none split",
  "reads Pi's live expansion state on every render without re-registering the widget",
  "Ctrl+O must not re-register the widget", "Ctrl+O toggles straight back to the full body",
  "a host without getToolsExpanded stays expanded",
], "Subagent widget retained-run parity, heading count, collapse, hint, and fixed turn-glyph padding tests");

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
  'subagent({ action: "status", id })', 'Use `subagent clear` when retained runs are no longer useful and should be discarded.',
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
- Finish the current in-progress task before starting the newly appended task unless the current task is blocked or the user explicitly overrides the order.
- Clear the completed todo list when its items are unrelated to upcoming work.`;
const todoContinuityStart = orchestrator.indexOf("### Todo Continuity");
const todoContinuityEnd = orchestrator.indexOf("Can tasks be split", todoContinuityStart);
check(
  orchestrator.slice(todoContinuityStart, todoContinuityEnd).trim() === expectedTodoContinuity,
  "orchestrator Todo Continuity must preserve upstream guidance and the reviewed clear boundary",
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
  'description: "Choose list or update. list accepts no operations. update requires one or more ordered operations."',
  'description: "Ordered append, modify, delete, or clear operations for update. Omit for list."',
  'description: "Use clear at most once after every current item is completed."',
  'description: "Replacement status: pending, in_progress, or completed."',
  'description: "Initial dependencies for the appended item."',
  'description: "Dependencies to add to the target item."',
  'description: "Dependencies to remove from the target item."',
  'description: "Exact subject to delete."',
], "Todo schema descriptions");
hasNone(todoSchemaBlock, [
  'description: "List exact dependency subjects."',
  "export const todoParameters = Type.Union([",
  "minProperties",
], "Todo schema portability");
check(todoSchemaBlock.split('description: "Initial dependencies for the appended item."').length - 1 === 1, "append blockedBy must have one distinct array description");
check(todoSchemaBlock.split('description: "Dependencies to add to the target item."').length - 1 === 1, "addBlockedBy must have one distinct array description");
check(todoSchemaBlock.split('description: "Dependencies to remove from the target item."').length - 1 === 1, "removeBlockedBy must have one distinct array description");
check(todoSchemaBlock.split('description: "Exact subject of an existing item."').length - 1 === 3, "each dependency array item must use the exact-subject description");
const todoSchemaDescriptions = [...todoSchemaBlock.matchAll(/description:\s*("(?:\\.|[^"\\])*")/g)].map((match) => JSON.parse(match[1]));
const expectedTodoSchemaDescriptions = [
  "Replacement status: pending, in_progress, or completed.",
  "Exact subject of an existing item.",
  "Initial dependencies for the appended item.",
  "Exact subject of an existing item.",
  "Dependencies to add to the target item.",
  "Exact subject of an existing item.",
  "Dependencies to remove from the target item.",
  "append requires subject and abstract, with optional blockedBy.",
  "Unique subject for the new item.",
  "Short summary for the new item.",
  "modify requires target and at least one changed field.",
  "Exact current subject of the item to modify.",
  "Unique replacement subject.",
  "Replacement item summary.",
  "delete requires target.",
  "Exact subject to delete.",
  "clear accepts no other fields.",
  "Use clear at most once after every current item is completed.",
  "Choose list or update. list accepts no operations. update requires one or more ordered operations.",
  "Ordered append, modify, delete, or clear operations for update. Omit for list.",
];
check(JSON.stringify(todoSchemaDescriptions) === JSON.stringify(expectedTodoSchemaDescriptions), "Todo schema descriptions must match the HOW contract");
for (const description of todoSchemaDescriptions) checkSchemaHow(description, "Todo schema description");
hasAll(todoExtension, [
  'export const TODO_PROMPT_SNIPPET = "Track session tasks and dependencies."',
  'description: "Read or atomically update a session-local task ledger. `todo list` returns every item in original order. `todo update` applies ordered append, modify, delete, or clear operations as one batch. Multiple items may be in progress. Dependencies must form an acyclic graph and reference exact existing subjects. Deleting a referenced item is rejected. Clear is allowed only for an empty list or a fully completed task group. Any invalid operation or final graph rolls back the entire batch."',
], "Todo tool metadata");
const todoDescription = "Read or atomically update a session-local task ledger. `todo list` returns every item in original order. `todo update` applies ordered append, modify, delete, or clear operations as one batch. Multiple items may be in progress. Dependencies must form an acyclic graph and reference exact existing subjects. Deleting a referenced item is rejected. Clear is allowed only for an empty list or a fully completed task group. Any invalid operation or final graph rolls back the entire batch.";
const todoPromptSnippet = "Track session tasks and dependencies.";
checkSteBlock(todoPromptSnippet, "Todo promptSnippet");
checkSteBlock(todoDescription, "Todo description");
const todoGuidelineStart = todoExtension.indexOf("export const TODO_PROMPT_GUIDELINES = [");
const todoGuidelineEnd = todoExtension.indexOf("] as const;", todoGuidelineStart);
const todoGuidelineBlock = todoExtension.slice(todoGuidelineStart, todoGuidelineEnd);
const todoGuidelines = staticStrings(todoGuidelineBlock, "Todo promptGuidelines");
const expectedTodoGuidelines = [
  "Append newly added user work with `todo update` instead of replacing existing items.",
  "Preserve existing `todo` items unless the user or current work requires a change.",
  "Finish current in-progress `todo` work before appended work unless blocked or explicitly reordered.",
  "Complete each `todo` dependency before starting or completing its dependent item.",
  "Remove all `todo` dependency references before deleting their target.",
  "Use `todo` clear only after the current group finishes, then append the replacement group.",
];
check(JSON.stringify(todoGuidelines) === JSON.stringify(expectedTodoGuidelines), "Todo promptGuidelines must match the reviewed array");
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
for (const metadata of modelMetadataAudit) {
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
  'theme.strikethrough', '"├─"', '"└─"', "hiddenSummary", 'TODO_SECTION_ID = "todos"',
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
hasAll(todoWidget, [
  'export function countCompletedTodoTasks(tasks: readonly TodoTask[]): number {\n  return tasks.filter((task) => task.status === "completed").length;',
  "export function hasOpenTodoTasks(tasks: readonly TodoTask[]): boolean {\n  return countCompletedTodoTasks(tasks) < tasks.length;",
  "isActive: () => hasOpenTodoTasks(this.tasks)",
], "Todo heading counts and stack section share one open-task predicate");
const todoWidgetHeadingBlock = todoWidget.slice(todoWidget.indexOf("function todoWidgetHeading"), todoWidget.indexOf("/** Appends the collapsed hint"));
hasAll(todoWidgetHeadingBlock, [
  "const completed = countCompletedTodoTasks(tasks)", "const active = hasOpenTodoTasks(tasks)", 'const color = active ? "accent" : "dim"',
  'const glyph = active ? theme.bold("●") : "○"',
  'const label = active ? theme.bold(`Todos (${completed}/${tasks.length})`) : `Todos (${completed}/${tasks.length})`',
  "formatSemanticGlyphPrefix(theme.fg(color, glyph))", "theme.fg(color, label)",
], "Todo persistent widget active and all-completed idle heading visual");
hasNone(todoWidgetHeadingBlock, ['theme.bold("○")'], "Todo idle heading must remain dim without bold emphasis");
check(
  todoWidget.includes("todoHeadingLine(todoWidgetHeading(tasks, theme), policyHidden > 0 ? hint : \"\", theme, safeWidth)"),
  "Todo persistent widget must render through the active-idle heading helper with its collapsed hint",
);
const todoHeadingLineBlock = todoWidget.slice(
  todoWidget.indexOf("function todoHeadingLine"),
  todoWidget.indexOf("export function isTodoTaskBlocked"),
);
hasAll(todoHeadingLineBlock, [
  'if (hint !== "" && visibleWidth(heading) + visibleWidth(hint) <= width)',
  '`${heading}${theme.fg("dim", hint)}`', 'return truncateToWidth(heading, width, "…")',
], "Todo collapsed hint is one atomic dim segment that only fits or disappears");
hasNone(todoHeadingLineBlock, ["theme.bold(hint)", "slice(0,", "to collapse"], "Todo hint must never be bold, split, or inverted");
hasAll(todoWidget, [
  "expanded = true", 'hint = ""',
  'const sorted = expanded ? ranked : ranked.filter((task) => task.status !== "completed")',
  "const policyHidden = expanded ? 0 : countCompletedTodoTasks(tasks)",
  "selectTodoWidgetLayout(tasks, maxLines, expanded)",
], "Todo collapsed policy hides only completed rows and ranks against the whole ledger");
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
check(existsSync(join(ROOT, "tests/widget-stack.test.mjs")), "aggregate widget contract tests must exist");
const widgetStackTests = read("tests/widget-stack.test.mjs");
hasAll(widgetStackTests, [
  "the stack sorts every active combination with active sections above idle ones in fixed product order",
  "mask < 32", "Goal \u2192 Todos \u2192 Agents \u2192 Monitors \u2192 Loops inside each group",
  "the stack concatenates section bodies with no separator, no blank line, and no global cap",
  "the stack never inserts a blank line between sections",
  "each section keeps its own budget and the stack adds no cap of its own",
  "every section's active flag comes from the same source as its own heading glyph",
  "five real widgets register one aggregate key once and reorder on every active flip without touching setWidget",
  "five widgets produce exactly one setWidget call", "must not call setWidget again", "must request an aggregate render",
  "an empty section contributes no lines and the aggregate key is revoked only when every section is gone",
  "one empty section never revokes the shared key", "the last section leaving revokes the aggregate key",
  "a third-party widget keeps its own key and its relative position never moves when a section flips",
  "the package owns exactly one widget key",
  "the host is a globalThis singleton shared by a second module graph of the same source",
  "?graph=todo", "the two graphs really are separate module copies", "both copies resolve the same host instance",
  "releasing one owner keeps the shared binding alive", "the last owner releasing clears the aggregate",
  "rebinding moves the aggregate to the new UI and a late unbind never clears a newer binding",
  "reload clears the previous providers before a new widget instance publishes the same section",
  "dispose retracts only its own section and a late timer tick never resurrects it",
  "a late tick never re-registers a disposed section", "a late tick never republishes a disposed section",
  "a tree cycle drops the old sections and republishes them on the new UI without orphan rows",
  "the pre-tree branch leaves no orphan rows behind", "a tree cycle reuses the single registration",
  "the aggregate component reads live width, theme, and Ctrl+O state while invalidate stays a no-op",
  "Ctrl+O never re-registers the aggregate", "invalidate is a no-op and never re-registers",
  "one width reaches every section",
  "a session without a TUI UI publishes freely and still calls setWidget zero times",
  "an RPC or print session never registers the aggregate",
  "a host that ignores component factories, as RPC does, never locks the aggregate into a dead registration",
  "a factory the host never ran is not a live registration",
  "later updates retry the factory instead of being dropped",
  "an ignored factory still leaves a clearable key",
  "the first executed factory becomes the live registration",
  "an explicit width is authoritative down to zero and only a missing or invalid width falls back",
  '"w=0"', "a zero-column frame is an instruction, not a missing width",
  "a negative width is invalid and falls back",
  "no width and no terminal falls back to the documented default",
  "the newest distinct UI wins and only owners of that UI can hold it open",
  "the superseded UI is cleared immediately", "the newest UI takes the aggregate over",
  "a late unbind from the superseded owner changes nothing",
  "an owner still recorded against a replaced UI cannot hold the live one open",
  "binding no UI releases exactly this owner's recorded claim and nothing else",
  "one owner leaving keeps the other owner's binding", "releasing an owner that never bound is a no-op",
  "section ids are fixed, exhaustive, and unknown ids sort last instead of throwing",
], "aggregate widget ordering, ownership, lifecycle, and dual module graph tests");
hasAll(read("tests/todo.test.mjs"), [
  "session shutdown always disposes the Todo section while RPC and no-UI sessions still never register",
  "an unmatched shutdown still clears the aggregate", "a repeated shutdown clears nothing twice",
  "sessions never register or clear a widget",
], "Todo unconditional shutdown disposal and headless parity tests");
for (const file of [
  "tests/widget-stack.test.mjs", "tests/monitor-ui.test.mjs", "tests/goal-ui.test.mjs",
  "tests/loop-ui.test.mjs", "tests/subagent-widget.test.mjs",
]) {
  hasAll(read(file), [
    "./widget-stack.js", "./widget-stack-host.js", "resetWidgetStackHost",
  ], `${file} aggregate widget load mapping and per-test host reset`);
}
hasAll(read("tests/todo.test.mjs"), [
  "../oh-my-pi-slim/widget-stack.js", "../oh-my-pi-slim/widget-stack-host.js", "resetWidgetStackHost",
], "tests/todo.test.mjs aggregate widget load mapping and per-test host reset");
// Every suite that loads a widget class also loads the host it publishes through.
for (const file of [
  "tests/goal.test.mjs", "tests/loop.test.mjs", "tests/monitor.test.mjs",
  "tests/provider-schema.test.mjs", "tests/subagent-runtime.test.mjs",
]) {
  hasAll(read(file), [
    "./widget-expansion.js", "./widget-stack.js", "./widget-stack-host.js",
    // The host is process-wide, so a suite that loads a widget must start each test from a clean one.
    'import test, { beforeEach } from "node:test"',
    "resetWidgetStackHost", "beforeEach(() => resetWidgetStackHost());",
  ], `${file} aggregate widget load mapping and per-test host reset`);
}
hasAll(read("tests/provider-schema.test.mjs"), [
  "../oh-my-pi-slim/widget-stack.js", "../oh-my-pi-slim/widget-stack-host.js",
], "tests/provider-schema.test.mjs Todo aggregate widget load mapping");
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
  'assert.equal(lines[0], "●  Loops")', "the Loops heading carries no active/total ratio",
  "drops the ratio, mirrors the Todo active and idle roles, and never joins Ctrl+O expansion",
  '"○  Loops"', "the idle Loops heading stays dim without bold emphasis",
  "an all-paused Loops widget renders no accent role",
  "Loops never filters rows and never appends an expand hint",
  "the Loops renderer takes no expansion parameters", "roleAnsiTheme",
], "Loop focused ratio-free heading and no-expansion visual tests");
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
  "widget active and all-completed idle headings keep exact roles, ANSI, width, overflow, and row treatment",
  "widget heading refreshes both ways across update, delete, clear, replay, tree, compact, and session restore",
  '"○  Todos (14/14)"', "all-completed widget must not render any accent role",
  "tool result keeps its existing non-widget heading visual", "roleAnsiTheme",
  "collapsed widget keeps pending and in_progress rows, including blocked pending, and hides only completed ones",
  '"●  Todos (2/6) · ctrl+o to expand"', '"├─ ○  blocked-work ⛓  open-dependency"',
  '["○  Todos (2/2) · ctrl+o to expand"]', "a collapsed ledger with nothing hidden shows no hint at all",
  "withConfiguredExpandKey", '"app.tools.expand"', '" · ctrl+shift+e to expand"',
  "the hint renders identically in the active and idle heading states",
  "the hint is never bold", "must drop the whole hint, never half of it",
  "heading counts ignore both filtering and overflow",
  "policy-hidden completed rows stay out of the overflow summary",
  "reads Pi's live expansion state on every render without re-registering the widget",
  "Ctrl+O must not re-register the widget", "Ctrl+O toggles straight back without a second registration",
  "an all-completed collapsed ledger keeps a heading-only widget",
  "a non-empty ledger stays registered while collapsed",
  "an empty ledger still unregisters while collapsed",
], "Todo focused Ctrl+O, active-idle, and collapsed-widget visual tests");
const subagentTranscriptTests = read("tests/subagent-transcript-renderer.test.mjs");
hasAll(subagentTranscriptTests, [
  "collapsed list results show only the retained-run heading count",
  'assert.deepEqual(collapsedLines, ["", "Retained subagent run status · 3"])',
  'assert.deepEqual(emptyCollapsedLines, ["", "Retained subagent run status · 0"])',
  'assert.equal(emptyExpanded, "Retained subagent run status · 0\\nNo retained runs.")',
  "clear receipts stay compact when collapsed and list every retained-item warning when expanded",
  "subagent · clear (ctrl+o to expand)", "Clears retained Subagent history", "run files", "child session files",
  "assert.doesNotMatch(clearExpanded, /Goal|sidecar/i)", "Retained subagent run status · 3",
  "status result stays single-line collapsed", "subagent · status · run-status-full (ctrl+o to expand)",
  "without duplicate Action rows", "(ctrl+o to expand)", "Action:",
  'assert.doesNotMatch(value, /\\(ctrl\\+o to expand\\)|Action:/)',
  'waiting (ctrl+o to expand)', '${value.status} (ctrl+o to expand)', 'running (ctrl+o to expand)',
  "[✓●!] [^ ]|[✓●!] {3}",
  "terminal steer immediate results never repeat final output or error even from legacy full run details",
  "assert.doesNotMatch(value, /SENTINEL/)",
  "assert.doesNotMatch(value, /Output:|Error:|Live response|Task:|Session:/)",
  "assert.doesNotMatch(failedSteerExpanded, /stored failure|Output:|Error:/)",
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
  "share one incremental update contract that states current status",
  '["id", "abstract", "kind", "status", "matched", "exitCode", "signal", "error", "lines", "omitted", "truncated", "deliveryKey"]',
  'assert.equal(matcher.details.kind, "update")', 'assert.equal(terminal.details.kind, "update")',
  "a terminal update names the literals its undelivered matches hit",
  "the merged failure payload names the literals its pending matches hit",
  "a close without pending matches names no literal",
  "literals already reported by a delivered batch never repeat",
  "terminal updates report completed, failed, and killed while matcher updates always stay running",
  "close after a matcher batch repeats no line",
  "a matcher batch still pending at close folds its lines into the single terminal update",
  "zero incremental lines stay legal and never replay retained history",
  "terminal notification must not carry full state field",
  "monitor status stays the only full retained state and log entry point",
], "Monitor focused process, logging, delivery, payload, and Goal-reservation tests");
const monitorUiTests = read("tests/monitor-ui.test.mjs");
hasAll(monitorUiTests, [
  "the exact terminal/total heading ratio, glyphs, running/terminal order, overflow, width safety, and empty state",
  "throttles and coalesces output", "registers once", "invalidate a no-op", "rebinds", "disposes",
  "all four actions", "uniform hints", "full operational state", "forced warnings", "global summary notifications",
  "matched 2 (ctrl+o to expand)", "rate limited (ctrl+o to expand)", '${status} (ctrl+o to expand)',
  "Monitor unified update notifications collapse by status and expand one incremental layout without full operational state",
  "Monitor legacy matcher, legacy terminal, and global summary notifications still render complete bounded details",
  'kind: "update"', "a running update carries no terminal verdict rows",
  "a terminal update never embeds notification stats, log paths, combined lines, or full operational state",
  "a tight width sheds the abstract but never the expand hint",
  'for (const kind of ["terminal", "update", "matcher", undefined])',
  "fallbacks and errors sanitize controls", "model-facing list data invariant", "without a TUI context",
  "narrow.map((line) => stripVTControlCharacters(line))", '"printf done"',
  "├─ ↻  running first", "[↻!×✓●○] [^ ]|[↻!×✓●○] {3}", "↻  Monitor [00000001]",
  'assert.equal(lines[0], "●  Monitors (3/5)"', "completed, failed, and killed all count as terminal in the numerator",
  '"●  Monitors (0/13)"', "the 12-line budget and overflow row never shrink the heading total",
  '"●  Monitors (0/2)"', "a fully running widget reports a zero numerator",
  '"○  Monitors (3/3)"', "an all-terminal widget reads N/N with the hollow dim glyph, even while every row stays hidden",
  "collapsing away every terminal row leaves the heading ratio untouched",
  "a narrow terminal keeps the whole ratio while the rows truncate",
  "the widest hintless heading keeps the ratio whole",
  "six rows hidden by the line budget still count in the heading",
  "collapse plus budget never changes the ratio", "display sorting never reorders the counted set",
  "a lifecycle refresh moves the ratio and drops the heading to idle",
  "collapsed body keeps only running rows", "one atomic dim expand hint",
  '"●  Monitors (3/5) · ctrl+o to expand"', '["○  Monitors (3/3) · ctrl+o to expand"]',
  "a collapsed widget with nothing hidden shows no hint at all",
  "withConfiguredExpandKey", '"app.tools.expand"', '" · ctrl+shift+e to expand"',
  "the hint renders identically in the active and idle heading states",
  "a running monitor keeps the filled accent bold glyph, label, and ratio",
  "an all-terminal widget drops to a hollow dim non-bold glyph, label, and ratio",
  "the hint is never bold", "must drop the whole hint, never half of it",
  "only the two budget-hidden running rows are summarised", "policy-hidden terminal rows never reach the body",
  "reads Pi's live expansion state on every render without re-registering the widget",
  "Ctrl+O must not re-register the widget", "Ctrl+O toggles straight back to the full body",
  "a host without getToolsExpanded stays expanded", "roleAnsiTheme",
], "Monitor focused widget, terminal/total heading ratio, collapse, hint, and RPC visual tests");
const loopLoadTests = read("tests/loop-load.test.mjs");
hasAll(loopLoadTests, [
  "real Pi isolated RPC main and child sessions expose exact package tools without widgets",
  '["ask_user_question", "goal", "loop", "monitor", "subagent", "todo"]', '["contact_supervisor", "todo"]',
  'events.some((event) => event.type === "extension_ui_request" && event.method === "setWidget")',
  '["create", "list", "status", "interrupt", "steer", "resume", "reply", "clear"]',
  "assert.deepEqual(main.systemPromptToolLines, Object.entries(main.promptSnippets)",
  "assert.deepEqual(child.systemPromptToolLines, Object.entries(child.promptSnippets)",
  "assert.deepEqual(main.flattenedGuidelines, Object.values(main.guidelinesByTool).flat())",
  "assert.deepEqual(child.flattenedGuidelines, Object.values(child.guidelinesByTool).flat())",
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
  "no_progress: no_progress (ctrl+o to expand)", "●  Goal · ↻  active", "[↻Ⅱ◷✓×●○] [^ ]|[↻Ⅱ◷✓×●○] {3}", "continuationWide",
  "pursuing versus idle across all five statuses and never joins Ctrl+O expansion",
  "the Goal heading carries no ratio", "must render a hollow dim prefix", "must not bold the Goal prefix",
  "the status glyph and text keep their own status colour", "the abstract keeps its existing text role",
  "must never append an expand hint", "the Goal renderer takes no expansion parameters", "roleAnsiTheme",
], "Goal focused widget, five-status prefix, no-expansion, and RPC visual tests");
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
        "## `/loop` and `/goal`", "## Presets and configuration", "## Runtime, UI, and persistence",
        "### Subagent viewer", "## Deliberate scope",
        "## Development", "## License",
      ]
    : [
        "## 核心特性", "## 六个 specialist", "## 要求与包管理", "### 要求", "### 安装",
        "### 从外部 Ask 与 Process package 迁移", "### 更新", "### 移除", "## 工具可用性", "## Main 工具",
        "### `subagent`", "### `todo`", "### `loop`", "### `monitor`", "### `ask_user_question`", "### `goal`",
        "## `/loop` 与 `/goal`", "## Preset 与配置", "## Runtime、UI 与持久化",
        "### Subagent viewer", "## 有意限制",
        "## 开发", "## License",
      ];
  check(JSON.stringify(headings) === JSON.stringify(expectedHeadings), `${file} heading structure must stay aligned`);
  // The viewer shortcut is a plain modified arrow key, so the README documents no terminal key
  // mapping, no raw ESC sequence, and no per-emulator promise at all.
  hasNone(text, [
    "super+left", "super+right", "Terminal.app", "Send Text", "cat -v",
    "\\033", "[1;9D", "[1;9C", "^[[1;9D", "^[[1;9C",
  ], `${file} viewer shortcut documentation`);
  check(
    !/(all|every)[^.\n]*terminals?[^.\n]*(work|support)/i.test(text),
    `${file} must not promise that the viewer shortcut works in every terminal`,
  );

  hasAll(text, [
    "pi install git:github.com/YanzuoLu/oh-my-pi-slim",
    "pi update --extension git:github.com/YanzuoLu/oh-my-pi-slim",
    "pi remove git:github.com/YanzuoLu/oh-my-pi-slim",
    "pi remove npm:@juicesharp/rpiv-ask-user-question",
    "pi remove npm:@aliou/pi-processes",
    "ask_user_question", "goal", "loop", "monitor", "subagent", "todo", "contact_supervisor",
    "need_decision", "interview_request", "progress_update",
    "10s", "7d", "nohup", "setsid", "disown", "blockedBy", "Ctrl+O",
    "ctrl+shift+left", "ctrl+shift+right", "Read-Only",
    "~/.pi/agent/oh-my-pi-slim.json", "provider", "model", "thinking",
    "npm test", "npm run validate", "git diff --check", "MIT",
  ], `${file} public README contract`);

  hasAll(text, english
    ? [
        "Exactly `subagent`, `todo`, `loop`, `monitor`, `ask_user_question`, and `goal`",
        "Exactly `contact_supervisor` and `todo`",
        "never automatically uninstalls external packages",
        "every retained run", "compact public state", "never includes terminal `output` or `error`", "`status` with one retained run ID", "same retained set and ordering",
        "refused while any run is `starting`, `running`, or `waiting`", "without rolling back file changes", "never changes Goal statistics",
        "saved child session as a new run with a new ID and optionally override its cwd. Omitted cwd inherits the source run's working directory", "continue that same run",
        "matched exactly", "atomic", "still names the target in `blockedBy`", "Multiple items may be `in_progress`", "acyclic graph", "`clear` requires an empty or fully completed current group",
        "runtime-only fixed-delay", "Creation and resume wait one full interval", "reload, new session, session resume, fork, or quit",
        "case-sensitive literal matching", "remain available until `delete`", "Use `status`",
        "`checkAfter` is required on `create`", "a silence reminder asks you to call `monitor status`", "`lastOutputAt`",
        "one to four questions", "single-select", "multi-select", "custom responses", "previews", "unavailable while a Goal is active",
        "branch-local durable Goal", "restore unfinished work as paused", "Provider failures retry automatically", "user aborts pause instead of cancelling", "one non-empty evidence item for each criterion",
        "active or waiting subagents", "Monitor work", "waiting Ask dialog",
        "safely queued during compaction and tree operations", "collapsed and expanded views", "compact widgets",
        "successful subagent `clear` remains clear after reload",
      ]
    : [
        "精确为 `subagent`、`todo`、`loop`、`monitor`、`ask_user_question`、`goal`",
        "精确为 `contact_supervisor` 与 `todo`",
        "不会自动卸载外部 package",
        "全部 retained run", "精简公开状态", "绝不包含 terminal `output` 或 `error`", "单个 retained run ID 调用 `status`", "相同的 retained 集合与排序",
        "存在 `starting`、`running` 或 `waiting` run，`clear` 就会被拒绝", "不回滚文件修改", "不会改变 Goal statistics",
        "保存的 child session 创建新 run，并生成新 ID。可选覆盖 cwd，省略时继承 source run 的工作目录", "继续同一个 run",
        "使用 exact match", "原子的", "仍在 `blockedBy` 中引用目标", "多个 item 可以同时处于 `in_progress`", "无环图", "`clear` 要求当前组为空或全部 completed",
        "runtime-only fixed-delay", "创建和恢复后都会先等待一个完整 interval", "reload、new session、session resume、fork 或 quit",
        "区分大小写的 literal match", "一直保留到 `delete`", "用 `status`",
        "`checkAfter` 在 `create` 时必填", "就会收到一条 silence reminder", "`lastOutputAt`",
        "一到四个 question", "single-select", "multi-select", "custom response", "preview", "Goal active 时不可用",
        "branch-local durable Goal", "恢复为 paused", "provider failure 会自动重试", "用户 abort 也会暂停而不是取消", "每条 criterion 必须精确对应一条非空 evidence",
        "active 或 waiting subagent", "Monitor 工作", "waiting Ask dialog",
        "compaction 与 tree operation 期间", "collapsed/expanded", "紧凑 widget",
        "subagent `clear` 在 reload 后仍保持清空",
      ], `${file} visible behavior contract`);

  const subagent = section("### `subagent`", "### `todo`");
  const todo = section("### `todo`", "### `loop`");
  const loop = section("### `loop`", "### `monitor`");
  const monitor = section("### `monitor`", "### `ask_user_question`");
  const goal = section("### `goal`", english ? "## `/loop` and `/goal`" : "## `/loop` 与 `/goal`");
  expectTableItems("subagent", subagent, ["create", "list", "status", "interrupt", "steer", "resume", "reply", "clear"]);
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
hasAll(widget, [
  "setIntervalFn(() => this.update(), 80)", "requestRender()", "dispose()",
  'AGENTS_SECTION_ID = "agents"', "isActive: () => hasActiveSubagentRuns(this.listRuns())",
  "terminalWidth: input.width", "this.uiCtx = undefined;",
], "subagent widget lifecycle");
hasNone(widget, ["finishedTurnAge", "shouldShowFinished", "ERROR_LINGER_TURNS", "seedFinishedRuns"], "retained-run widget parity");
hasNone(widgetRenderer, ["shouldShowFinished"], "retained-run widget renderer parity");
hasAll(widgetDisplay, ['formatSemanticGlyphPrefix(SUBAGENT_WIDGET_GLYPHS.turns)'], "subagent turn glyph fixed semantic padding");
check(!/pi\.on\("tool_execution_start"[\s\S]{0,120}subagents\.onTurnStart/.test(extension), "widget turn aging must not bind to tool_execution_start");
hasAll(widgetRenderer, [
  "MAX_SUBAGENT_WIDGET_LINES = 12", '"├─"', '"└─"', "renderSubagentWidgetLines", "waiting",
  "formatWidgetModel", "formatSubagentModel", "run.model", "formatWidgetTurns", "formatWidgetSessionTokens",
  "describeWidgetActivity", "activeLines.length * 3", "queuedLines.length", "budget >= 3", "run.abstract", "shortAbstract",
  "sortRetainedSubagentRuns(runs)", "lines.push(...sections.queuedLines, ...sections.finishedLines)",
  "const expanded = params.expanded ?? true",
  "const policyHidden = expanded ? 0 : categories.finished.length",
  "const shown: Categories = expanded ? categories : { ...categories, finished: [] }",
  "subagentHeadingLine(", "subagentWidgetHeading(runs, theme),", 'policyHidden > 0 ? params.hint ?? "" : "",',
  "buildSections(shown, spinnerFrame, theme, truncate, nowMs)",
], "subagent widget renderer");
const subagentHintBlock = widgetRenderer.slice(
  widgetRenderer.indexOf("function subagentHeadingLine"),
  widgetRenderer.indexOf("interface Categories"),
);
hasAll(subagentHintBlock, [
  'if (hint !== "" && visibleWidth(heading) + visibleWidth(hint) <= width)',
  '`${heading}${theme.fg("dim", hint)}`', "return truncateToWidth(heading, width)",
], "Agents collapsed hint is one atomic dim segment that only fits or disappears");
hasNone(subagentHintBlock, ["theme.bold(hint)", "slice(0,", "to collapse"], "Agents hint must never be bold, split, or inverted");
const subagentHeadingBlock = widgetRenderer.slice(
  widgetRenderer.indexOf("function subagentWidgetHeading"),
  widgetRenderer.indexOf("function subagentHeadingLine"),
);
hasAll(widgetRenderer, [
  "export function countActiveSubagentRuns(runs: readonly WidgetRun[]): number {\n  return runs.filter((run) => ACTIVE_STATUSES.has(run.status)).length;",
  "export function hasActiveSubagentRuns(runs: readonly WidgetRun[]): boolean {\n  return countActiveSubagentRuns(runs) > 0;",
], "Agents heading ratio and stack section share one live-run count");
hasAll(subagentHeadingBlock, [
  "const live = countActiveSubagentRuns(runs)", "const terminal = runs.length - live",
  "const active = live > 0", 'const color = active ? "accent" : "dim"',
  "theme.bold(SUBAGENT_WIDGET_GLYPHS.agentsActive)", "SUBAGENT_WIDGET_GLYPHS.agentsIdle",
  "theme.bold(`Agents (${terminal}/${runs.length})`)", "`Agents (${terminal}/${runs.length})`",
  "formatSemanticGlyphPrefix(theme.fg(color, glyph))", "theme.fg(color, label)",
], "Subagent persistent widget active and all-terminal idle heading visual");
hasNone(subagentHeadingBlock, [
  "theme.bold(SUBAGENT_WIDGET_GLYPHS.agentsIdle)", "categories", "sections", "maxBody",
], "Subagent idle heading must stay dim without bold and count runs before any layout budget");
hasNone(widgetRenderer, ["headingColor", "headingIcon"], "Subagent heading must render through the active-idle heading helper");
hasNone(widgetRenderer, ["run.task", "shortTask"], "abstract-only widget labels");
hasAll(modelDisplay, ["THINKING_LEVELS", "formatSubagentModel", '"xhigh"', '"max"'], "subagent model display formatter");
hasAll(transcriptRenderer, [
  "Container", "Box", "Text", "Markdown", "Spacer", "getMarkdownTheme", "RAW_HTML_TAG",
  "renderSubagentCall", "renderSubagentResult", "styledTitle(", '"subagent"',
  "collapsedStatusId", '`· ${action}${collapsedStatusId}${expanded ? "" : " (ctrl+o to expand)"}`',
  "renderSubagentNotification", "details?.run", "details?.runs", "details?.request",
  "ExpandableNotificationLine", 'theme.fg("muted", " (ctrl+o to expand)")', "visibleWidth(this.hint)",
  'actionFromContext(context, "create")',
  "immediateAck", "renderRunStatus", "renderRunList", "addRunSummaryDetails", "addFinalOutput", "spacedToolResult", '"Live response"',
  '"Retained subagent run status"', "run.abstract", "run.reason", 'addField(container, theme, "Abstract", args.abstract',
  'addField(container, theme, "Cwd", args.cwd ?? context.cwd, "(parent session cwd)")',
  'addField(container, theme, "Cwd", args.cwd, "(source run cwd)")',
  "clearReceipt", "details.clearedCount", "details.warnings", "details.changed === true",
  "expanded?: boolean", "context.expanded === true", "options.expanded === true", "terminal && expanded",
  "fallbackResult(result, theme, options.isPartial === true, expanded)",
], "subagent transcript renderer");
hasNone(transcriptRenderer, [
  "gotgenes", "Nico", "preview", "truncated", '"Subagent result"', "renderRunSection", "addActivity",
  "renderSupervisorCall", "renderSupervisorResult", "subagent_supervisor", "replyTo", '"Action"',
], "subagent transcript renderer ownership and focused-output contract");
const clearRendererStart = transcriptRenderer.indexOf('} else if (action === "clear") {');
const clearRendererEnd = transcriptRenderer.indexOf("  } else {", clearRendererStart);
const clearRenderer = transcriptRenderer.slice(clearRendererStart, clearRendererEnd);
hasAll(clearRenderer, [
  "Clears retained Subagent history", "run files", "exclusively owned child session files", "warnings",
], "subagent clear renderer boundary copy");
hasNone(clearRenderer, ["Goal", "sidecar"], "subagent clear renderer must not describe Goal stats storage");
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
const immediateAckStart = transcriptRenderer.indexOf("function immediateAck(");
const immediateAckEnd = transcriptRenderer.indexOf("function addRunSummaryDetails", immediateAckStart);
check(immediateAckStart >= 0 && immediateAckEnd > immediateAckStart, "transcript renderer must keep one immediate acknowledgement helper");
const immediateAckRenderer = transcriptRenderer.slice(immediateAckStart, immediateAckEnd);
hasAll(immediateAckRenderer, [
  'text = `${agent} [${id}] · already ${status}`',
  'const interruptFinal = action === "interrupt" && outcome !== undefined && INTERRUPT_FINAL_OUTCOMES.has(outcome)',
  '`${agent} [${id}] · ${status} before interrupt`',
  '`${agent} [${id}] · ${status} · stop unconfirmed`',
  '`${agent} [${id}] · ${status} · stopped`',
  'const ownsFinalResult = interruptFinal || (action !== "steer" && action !== "interrupt")',
  "if (terminal && expanded && ownsFinalResult) addFinalOutput(container, theme, run)",
], "terminal steer and already-terminal interrupt acknowledgements must never repeat final output or error");
hasAll(transcriptRenderer, [
  'const INTERRUPT_FINAL_OUTCOMES = new Set(["stopped", "raced", "unconfirmed"])',
  'immediateAck(run, action, args, theme, expanded, asString(details?.outcome))',
], "synchronous interrupt outcome rendering");
hasNone(immediateAckRenderer, [
  "if (terminal && expanded) addFinalOutput", "addLiveActivity", "addRequest", "run.task", "run.activity",
], "immediate acknowledgement renderer");
const statusRendererStart = transcriptRenderer.indexOf("function renderRunStatus");
const listRendererStart = transcriptRenderer.indexOf("function renderRunList", statusRendererStart);
const listRendererEnd = transcriptRenderer.indexOf("export function renderSubagentCall", listRendererStart);
const statusRenderer = transcriptRenderer.slice(statusRendererStart, listRendererStart);
const listRenderer = transcriptRenderer.slice(listRendererStart, listRendererEnd);
hasAll(statusRenderer, [
  "compactRunHeader", "undefined, true", "if (!expanded) return container", "addRunSummaryDetails",
  "TERMINAL_STATUSES.has(runIdentity(run).status)", "addFinalOutput(container, theme, run)",
], "single retained-run status renderer");
hasAll(listRenderer, [
  "styledTitle", "compactRunHeader", "undefined, true", "addRunSummaryDetails(container, theme, run)",
  "if (!expanded) return container",
], "retained-run list renderer");
check(
  listRenderer.indexOf("if (!expanded) return container") <
    listRenderer.indexOf('theme.fg("dim", "No retained runs.")') &&
  listRenderer.indexOf("if (!expanded) return container") < listRenderer.indexOf("runs.forEach"),
  "a collapsed retained-run list must return right after the heading, before any run row or empty-list note",
);
hasNone(listRenderer, [
  "addFinalOutput", "run.output", "run.error", "addLiveActivity", "addRequest", "run.task", "run.cwd", "run.model",
  "run.deniedTools", "run.activity", "run.request)",
], "retained-run list renderer");
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

// Read-only Subagent viewer: one full-screen overlay owned by the package, Main as item 0 of the
// cycle, and no host-layout inspection, no editor replacement, and no write of any kind.
const viewer = read("extensions/oh-my-pi-slim/subagent-viewer.ts");
const viewerData = read("extensions/oh-my-pi-slim/subagent-viewer-data.ts");
check(existsSync(join(ROOT, "tests/subagent-viewer.test.mjs")), "read-only viewer contract tests must exist");
const viewerTests = read("tests/subagent-viewer.test.mjs");

hasAll(viewer, [
  "overlay: true",
  'overlayOptions: { width: "100%", maxHeight: "100%", row: 0, col: 0, margin: 0 }',
  'VIEWER_READ_ONLY_LABEL = "Read-Only"',
  "VIEWER_REFRESH_MS = 250",
  'VIEWER_EMPTY_MESSAGE = "No running or waiting subagents."',
  "this.tui.terminal?.rows",
], "viewer owns one full-screen overlay through public geometry only");

// The viewer removes exactly its own overlay entry through the public OverlayHandle, so a close
// can never pop a foreign capturing, non-capturing, or temporarily hidden overlay.
hasAll(viewer, [
  "type OverlayHandle,",
  "private handle: OverlayHandle | undefined;",
  "onHandle: (handle: OverlayHandle) => {",
  "try { handle.hide(); } catch",
  "private completeClose(): void",
  "private hostDroppedOverlay(): boolean",
  "VIEWER_GONE_TICKS",
  "async closeAsync(): Promise<void>",
  "ui.notify(`Subagent viewer could not open:",
  "this.pendingForce = this.pendingForce || force;",
], "viewer closes by hiding its own overlay handle and self-heals a host-dropped entry");
hasNone(viewer, [
  "tui.hideOverlay", "overlayStack", "prototype.", "Object.defineProperty", "[\"__", "as any",
  "VIEWER_CLOSE_RETRY_TICKS", "closeRequested", "tryComplete", "abandonOverlay", "overlayState(",
  "getFocusedComponent",
], "viewer must not patch the host, retry a blocked close, or guess ownership from focus");
check(
  (viewer.match(/try \{ handle\.hide\(\); \} catch/g) ?? []).length === 2,
  "the viewer must hide its own overlay entry on the close path and on the stale-mount path",
);
check(
  (viewer.match(/\bdone\(\)/g) ?? []).length === 2,
  "done may only be used on the two pre-mount paths, never once an overlay handle exists",
);
for (const guard of [
  'const resolvable = done !== undefined && !(typeof this.tui?.hasOverlay === "function" && this.tui.hasOverlay());',
  'if (typeof tui.hasOverlay !== "function" || !tui.hasOverlay()) queueMicrotask(() => done());',
]) {
  check(viewer.includes(guard), "a pre-mount close may only resolve done when the host has nothing to pop");
}
hasNone(viewer, [
  "tui.children", "getMountedRoots", "setEditorComponent", "getEditorComponent", "setEditorText",
  "pasteToEditor", "setWidget", "setFooter", "setHeader", "setStatus", "switchSession", "newSession",
  "navigateTree", "sessionManager", "appendEntry", "sendMessage", "sendUserMessage", "nonCapturing",
], "viewer must not measure host layout, replace the editor, or touch host state");

// Inside the overlay a plain arrow and the global combination cycle the same ring, and the footer
// names the combination the package actually registers.
hasAll(viewer, [
  'if (matchesKey(data, Key.ctrlShift("right")) || matchesKey(data, Key.right)) {',
  'if (matchesKey(data, Key.ctrlShift("left")) || matchesKey(data, Key.left)) {',
  '"←/→ or Ctrl+Shift+←/→ run",',
], "viewer cycles on plain arrows and on ctrl+shift arrows only");
for (const [name, source] of [["viewer", viewer], ["viewer data", viewerData], ["main extension", extension]]) {
  hasNone(source, [
    "Key.super", "super+left", "super+right", "\u2318", "[1;9D", "[1;9C",
  ], `${name} must carry no super or Command viewer key`);
}
for (const [name, source] of [["viewer", viewer], ["viewer data", viewerData]]) {
  hasNone(source, [
    "writeFileSync", "atomicWriteJson", "mkdirSync", "unlinkSync", "rmSync", "renameSync", "chmodSync",
    "writeControl", "SessionManager", "registerCommand", "registerTool", "registerShortcut",
  ], `${name} must stay read-only`);
}

// Main is item 0 and a vacated position resolves to its neighbor before falling back to Main.
hasAll(viewerData, [
  "export function cycleViewerSelection",
  "const items: (string | undefined)[] = [undefined, ...runIds];",
  "export function neighborAfterViewerRemoval",
  "nextIds[Math.min(index, nextIds.length - 1)]",
  'const VIEWER_STATUSES = new Set<RunStatus>(["running", "waiting"]);',
], "viewer cycle keeps Main at item 0 and only running or waiting runs in the ring");

// Untrusted JSONL is shape-filtered and proven acyclic before any Pi branch helper touches it.
hasAll(viewerData, [
  "function viewerEntryOf(value: unknown): SessionEntry | undefined",
  "function checkViewerBranches(",
  "function selectViewerEntries(",
  'if (index.has(entry.id)) return { ok: false, reason: "duplicate entry id" };',
  'if (walking.has(current.id)) return { ok: false, reason: "parent cycle" };',
  "if (parentId === row.id) return undefined;",
  "const branches = checkViewerBranches(accepted);",
  "return { entries: buildContextEntries(accepted.slice()), warnings };",
  "showing file order",
  "} catch (error) {",
], "viewer proves the branch graph is safe before it calls a Pi helper");
check(
  viewerData.indexOf("function checkViewerBranches(") < viewerData.indexOf("buildContextEntries(accepted.slice())"),
  "the cycle check must be defined before the only buildContextEntries call site",
);
check(
  (viewerData.match(/buildContextEntries\(/g) ?? []).length === 1,
  "buildContextEntries may be called exactly once, behind the branch check",
);

// Child JSONL access is read-only, containment-checked, bounded, and terminal-sequence safe.
hasAll(viewerData, [
  "parseSessionEntries(", "buildContextEntries(",
  "realpathSync(resolve(childSessionDir))",
  'inside === ".." || inside.startsWith(`..${sep}`)',
  "stat.isSymbolicLink()", "!stat.isFile()",
  "VIEWER_MAX_FILE_BYTES", "VIEWER_MAX_ENTRIES", "VIEWER_MAX_BLOCK_LINES", "VIEWER_MAX_TRANSCRIPT_LINES",
  "VIEWER_MAX_ARGS_CHARS", "VIEWER_MAX_LIVE_CHARS",
  "stripTerminalSequences", "truncateToWidth", "previousFingerprint",
  "boundViewerText", "formatViewerElapsed", "liveTextIsRedundant",
], "viewer reads child sessions read-only, inside containment, and within bounds");
check(
  !viewerData.includes('inside.startsWith("..") ||'),
  "containment must reject only a real `..` path segment, not every name starting with dots",
);
check(
  (viewerData.match(/openSync\(/g) ?? []).length === 1 && viewerData.includes('openSync(path, "r")'),
  "the viewer may only open a child session file for reading",
);
check(!viewerData.includes("part.data"), "the viewer must never render image bytes");

// The transcript body is Pi's own Main components, reached through root exports only.
const viewerTranscript = read("extensions/oh-my-pi-slim/subagent-viewer-transcript.ts");
hasAll(viewerTranscript, [
  "UserMessageComponent", "AssistantMessageComponent", "ToolExecutionComponent",
  "BashExecutionComponent", "CustomMessageComponent", "CompactionSummaryMessageComponent",
  "BranchSummaryMessageComponent", "SkillInvocationMessageComponent",
  "getMarkdownTheme", "sessionEntryToContextMessages", "parseSkillBlock",
  "showImages: false", "PROMPT_ZONE_PATTERN", "sanitizeViewerText", "boundViewerText",
  "VIEWER_MAX_TRANSCRIPT_LINES", "dispose(): void", "setExpanded(expanded: boolean): void",
], "viewer transcript body reuses Pi's Main components with sanitized, bounded input");

// Presentation settings are read, never managed: SettingsManager locks and can create files.
hasAll(viewerTranscript, [
  'import { readFileSync } from "node:fs";',
  'const SETTINGS_FILE = "settings.json";',
  'const PROJECT_SETTINGS_RELATIVE = ".pi/settings.json";',
  "export type ViewerSettingsFileReader = (path: string) => string;",
  'readFileSync(path, "utf-8")',
  "join(agentDir, SETTINGS_FILE)",
  "resolve(cwd, PROJECT_SETTINGS_RELATIVE)",
  "&& projectTrusted",
], "viewer settings are read straight from the two settings files");
hasNone(viewerTranscript, [
  "SettingsManager", "writeFileSync", "appendFileSync", "mkdirSync", "rmSync", "renameSync",
  "createWriteStream", "lockfile", "openSync",
], "the viewer transcript body must never create, lock, or write a settings file");
check(
  (viewerTranscript.match(/readFileSync\(/g) ?? []).length === 1,
  "the viewer transcript body reads files through exactly one readFileSync seam",
);

// A bash row whose fill-in throws must not leave Pi's Loader interval running.
hasAll(viewerTranscript, [
  "function releaseBashComponent(component: BashExecutionComponent): void",
  "try { component.setComplete(undefined, true); }",
  "if (!ready) releaseBashComponent(component);",
  "export type ViewerBashComponentFactory = (",
  "readonly bashComponent?: ViewerBashComponentFactory;",
], "a half-built bash row stops its loader before the entry degrades to a note");
check(
  viewerTranscript.indexOf("if (output) component.appendOutput(output);") <
    viewerTranscript.indexOf("if (!ready) releaseBashComponent(component);"),
  "the bash loader cleanup must sit in the finally that guards appendOutput",
);
check(
  !/from "@earendil-works\/(pi-coding-agent|pi-tui)\/[^"]+"/.test(viewerTranscript),
  "the viewer transcript body must import only root package entry points",
);
check(
  viewerTranscript.includes("new ToolExecutionComponent(") && viewerTranscript.includes("undefined,\n              tui,\n              cwd,"),
  "tool rows must use Pi's built-in renderer fallback with the run's own cwd",
);
check(
  !viewerTranscript.includes("getMessageRenderer") && viewerTranscript.includes("new CustomMessageComponent(safeMessage, undefined,"),
  "a child extension's message renderer must never be resolved or executed",
);
check(!viewerTranscript.includes("part.data"), "the transcript body must never hand image bytes to a component");
hasAll(viewerTranscript, ["[image "], "images render as a placeholder");

// Regular-mode wheel reporting is owned by the viewer, enabled only after a real mount.
hasAll(viewer, [
  'VIEWER_MOUSE_ENABLE = "\\x1b[?1000h\\x1b[?1006h"',
  'VIEWER_MOUSE_DISABLE = "\\x1b[?1006l\\x1b[?1000l"',
  "private enableMouse(tui: TUI): void",
  "private disableMouse(): void",
  'if (tui.mode !== "regular") return;',
  "if (this.tui) this.enableMouse(this.tui);",
  "export function parseViewerWheel", "export function isViewerMouseSequence",
  "if (isViewerMouseSequence(data)) return;",
], "the viewer owns minimal wheel reporting and swallows every other mouse report");
check(
  (viewer.match(/terminal\.write\(/g) ?? []).length === 2,
  "the viewer may write exactly the two mouse mode sequences",
);
check(!viewer.includes("?1002") && !viewer.includes("?1003"),
  "motion tracking must stay off so the terminal keeps its own drag selection");
check(
  viewer.indexOf("this.disableMouse();") < viewer.indexOf("this.generation += 1;\n    this.stopTimer();"),
  "teardown must release wheel reporting before anything else can throw",
);

// Bottom-aware follow, with an explicit suppression flag that really gates re-arming.
hasAll(viewer, [
  "suppressed: boolean;",
  "state.suppressed = state.scroll >= this.maxScroll();",
  "} else if (next >= max && !state.suppressed) {",
  "if (next < max) state.suppressed = false;",
  "if (this.maxScroll() > 0) state.suppressed = false;",
  "private maxScroll(): number",
  "noteViewport(contentLines: number, transcriptRows: number): void",
], "follow re-arms only by reaching the end and stays off when the user suppressed it");
check(
  (viewer.match(/^ +state\.suppressed = false;$/gm) ?? []).length === 2,
  "only turning follow back on and End may clear suppression unconditionally",
);

// One global expansion state, resolved through the user's own keybinding.
hasAll(viewer, [
  '"getToolsExpanded"',
  '"setToolsExpanded"',
  'this.keybindings?.matches(data, "app.tools.expand") === true',
  "readWidgetExpanded(ui)",
  "ui?.setToolsExpanded?.(next)",
  "widgetExpandKey()",
  "widgetExpandHint()",
], "the viewer shares Pi's one tool-output expansion state and never hardcodes its key");
check(!/"ctrl\+o"/i.test(viewer), "the viewer must not hardcode the expansion key");

// Bottom-anchored layout and the split body/status caches.
hasAll(viewer, [
  "private statusLines(", "private hintLines(", "private metaLine(", "private readOnlyLines(",
  "private bodyRevision = 0;", "private statusRevision = 0;",
  "private bumpBody(): void", "private bumpStatus(): void",
  "invalidateFrame(): void",
  "if (chrome() + VIEWER_MIN_TRANSCRIPT_ROWS > rows) live = [];",
  "if (chrome() + 1 > rows) hints = [];",
], "the viewer keeps the status at the bottom and separates body from status repaints");

// The clock repaints on the string the status row shows, not on a wall-clock bucket.
hasAll(viewer, [
  "private elapsedDisplay(): string",
  "formatViewerElapsed(run.createdAt, this.nowMs())",
  "const elapsed = this.elapsedDisplay();",
  "if (elapsed !== this.lastElapsed) {",
], "the elapsed repaint follows the displayed value");
hasNone(viewer, [
  "Math.floor(this.nowMs() / 1000)", "lastSecond",
], "the viewer must not bucket the wall clock for the elapsed row");
check(
  (viewer.match(/if \(repaint\) this\.requestRender\(\);/g) ?? []).length === 1,
  "one tick may request at most one render for activity and the clock together",
);
check(!viewer.includes("private headerLines("), "the viewer must not render a top header");
const viewerComponentSource = viewer.slice(
  viewer.indexOf("export class SubagentViewerComponent"),
  viewer.indexOf("export interface SubagentViewerKeyTarget"),
);
check(!/Date\.now\(\)/.test(viewerComponentSource), "viewer rendering must use the injected clock, never Date.now");
check(
  (viewer.match(/Date\.now\(\)/g) ?? []).length === 1 && viewer.includes("this.nowMs = options.nowMs ?? (() => Date.now());"),
  "the injected clock default is the only Date.now in the viewer",
);
check(!viewerTranscript.includes("Date.now()"), "the transcript body must not read the wall clock");
const renderBody = viewer.slice(viewer.indexOf("  render(width: number): string[] {"), viewer.indexOf("  handleInput(data: string): void {"));
check(
  renderBody.indexOf("for (let index = 0; index < transcriptRows; index += 1)") < renderBody.indexOf("lines.push(...readOnly);") &&
  renderBody.indexOf("lines.push(...readOnly);") < renderBody.indexOf("lines.push(...status);") &&
  renderBody.indexOf("lines.push(...status);") < renderBody.indexOf("lines.push(...hints);"),
  "rendered rows must run transcript, live, Read-Only, status, then hints",
);

// One cloned snapshot API on the runtime, filtered to the viewer statuses.
hasAll(runtime, [
  "viewerSnapshot(): ViewerSnapshot",
  "if (!isViewerStatus(run.status)) continue;",
  "cloneViewerValue(run.request)",
  "cloneViewerActivity(this.activity.get(run.id))",
  "cwd: run.cwd,",
], "runtime exposes exactly one cloned read-only viewer snapshot");

// The package entry owns exactly two shortcuts, no command, and the full viewer lifecycle.
hasAll(extension, [
  "createSubagentViewer({ snapshot: () => subagents.viewerSnapshot() })",
  '[["ctrl+shift+left", -1], ["ctrl+shift+right", 1]] as const',
  "pi.registerShortcut(shortcut, {",
  "subagentViewer.reset();",
  "subagentViewer.dispose();",
  'enabled: ctx.hasUI && ctx.mode === "tui"',
], "main extension registers the two viewer shortcuts and drives the viewer lifecycle");
check((extension.match(/registerShortcut\(/g) ?? []).length === 1, "the package must register shortcuts in exactly one place");
check((extension.match(/subagentViewer\.close\(\)/g) ?? []).length === 3, "switch, fork, and tree must each close the viewer");
check(!/registerCommand\("(?:viewer|subagent-viewer|agents?|subagents?)"/.test(extension), "the viewer must not add a slash command");
hasAll(read("tests/loop.test.mjs"), [
  'assert.deepEqual(main.shortcuts, ["ctrl+shift+left", "ctrl+shift+right"], "main sessions register exactly the two viewer shortcuts");',
  'assert.deepEqual(child.shortcuts, [], "child sessions register no viewer shortcut");',
], "registration tests must pin two main shortcuts and none in a child");

hasAll(viewerTests, [
  "a mounted regular-mode overlay enables wheel reporting exactly once and restores it on close",
  "a stale handle from an already closed open never enables wheel reporting",
  "a host that throws on open leaves no wheel reporting behind",
  "a host that drops the overlay entry still restores wheel reporting",
  "follow re-arms only by actually reaching the end",
  "f at the end suppresses re-arming until follow is turned back on",
  "a suppressed view never re-arms on Down, PageDown, the wheel, growth, or a resize",
  "f turns follow back on for a suppressed view and pins it to the end again",
  "leaving the end upward clears suppression so the way back down re-arms follow",
  "Home clears suppression only by really leaving the end",
  "a resize clamp never counts as the user reaching the end",
  "Ctrl+O uses the user's real binding and flips Pi's one global expansion state",
  "the elapsed clock repaints on the first tick where its shown value changes",
  "an hour-old run repaints on its minute, not on every second",
  "a run with an unusable createdAt never churns the status row",
  "a bash row that throws while filling in stops its loader and keeps the next block",
  "the viewer defaults are Pi's own defaults",
  "transcript settings read the global file even without a project",
  "a trusted project overrides only the values it defines",
  "an untrusted project is never read",
  "malformed, unreadable, and invalid settings fall back to Pi's defaults",
  "the transcript module holds no settings manager and no write API",
  "the transcript body is rendered by Pi's own Main components",
  "the bottom rows shed in order and always keep the transcript, Read-Only, and status title",
  "the overlay opens full screen at the viewport origin",
  "a read that completes after close cannot render or revive the viewer",
  "a timer tick after close never reopens the viewer",
  "session file resolution refuses escapes, links, and directories",
  "a full viewer session writes nothing inside the session directory",
  "the reader follows the active compaction-aware branch",
  "a close under a foreign capturing overlay removes only the viewer entry, with no zombie",
  "a foreign non-capturing or temporarily hidden overlay is never popped by a viewer close",
  "a host that hides the viewer entry without resolving is healed by the refresh timer",
  "a close that lands before the overlay is mounted leaves no entry behind",
  "a close before mount under a foreign overlay hides the late entry instead of popping theirs",
  "a deferred factory whose close already ran never resolves done over a foreign overlay",
  "createOverlayHost",
  "a synchronous ui.custom throw notifies once and leaves the viewer reopenable",
  "the raw rendered screen carries no untrusted ESC, OSC, C0, or C1 byte",
  "null, scalar, array, and shapeless rows never reach the branch helpers",
  "a self-referencing entry is dropped before any parent walk starts",
  "a two-entry parent cycle degrades to file order instead of hanging",
  "a duplicate entry id degrades to file order instead of rewiring the parent chain",
  "a dangling parent reference reads cleanly and keeps the whole chain",
  "a truncated tail shows the file-order tail rather than collapsing to the last entry",
  "every session lifecycle handler aborts Ask before it touches the viewer",
  "r pressed during an in-flight read still forces the follow-up read",
  "ctrl+shift+right starts at the first run and ctrl+shift+left starts at the last run",
  "plain and ctrl+shift arrows cycle identically and leaving the ring returns to Main",
  "no production source keeps a super arrow key or a Terminal ESC mapping",
  "the viewer overlay matches ctrl+shift arrows and no super arrow",
  "BRANCH_READ_BUDGET_MS",
], "viewer tests cover ownership, self-healing, hostile branch data, and zero writes");
hasAll(read("tests/ask-ui.test.mjs"), [
  "Ask closes the read-only viewer before it opens its own overlay",
  "Ask still opens when the viewer sits under a foreign overlay, and pops neither",
  'assert.deepEqual(events, ["custom:0", "custom:0"]);',
  "createOverlayHost",
], "Ask must close the viewer before it opens its own overlay");
// One shared host fixture keeps every overlay-ownership assertion on identical real semantics.
check(existsSync(join(ROOT, "tests/fixtures/overlay-host.mjs")), "the real-semantics overlay host fixture must exist");
hasAll(read("tests/fixtures/overlay-host.mjs"), [
  "showOverlay(component, options)", "hide: () => { removeEntry(entry); }",
  "hideOverlay()", "nonCapturing", "isHidden: () => entry.hidden",
  "other.preFocus = entry.preFocus", "void Promise.resolve().then(() => {",
], "the overlay host fixture must reproduce TuiBase handle, stack, focus, and mount timing");
hasAll(askTui, [
  "export interface AskTuiDriverOptions", "beforeOpen?: () => void | Promise<void>", "await this.beforeOpen()",
], "Ask exposes one public coordination hook instead of a patched viewer");
hasAll(subagentRuntimeTests, ["viewerSnapshot"], "runtime tests must cover the cloned viewer snapshot");
hasAll(read("tests/loop-load.test.mjs"), ['event.method === "custom"'], "load tests must assert the viewer never opens outside a TUI session");

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
    check(files.includes("extensions/oh-my-pi-slim/widget-stack.ts"), "npm pack must include the widget stack ordering layer");
    check(files.includes("extensions/oh-my-pi-slim/widget-stack-host.ts"), "npm pack must include the aggregate widget host");
    check(files.includes("tests/widget-stack.test.mjs"), "npm pack must include the aggregate widget tests");
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
    check(files.includes("extensions/oh-my-pi-slim/widget-expansion.ts"), "npm pack must include the shared widget expansion module");
    check(files.includes("extensions/oh-my-pi-slim/subagent-viewer.ts"), "npm pack must include the read-only Subagent viewer");
    check(files.includes("extensions/oh-my-pi-slim/subagent-viewer-data.ts"), "npm pack must include the viewer read-only data layer");
    check(files.includes("extensions/oh-my-pi-slim/subagent-viewer-transcript.ts"), "npm pack must include the viewer transcript body");
    check(files.includes("tests/subagent-viewer.test.mjs"), "npm pack must include the viewer contract tests");
    check(files.includes("tests/fixtures/overlay-host.mjs"), "npm pack must include the real-semantics overlay host fixture");
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
