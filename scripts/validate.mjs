#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const AGENTS = ["designer", "explorer", "fixer", "librarian", "oracle"];
const ROLES = ["orchestrator", "explorer", "librarian", "oracle", "designer", "fixer"];
const READ_ONLY = new Set(["explorer", "librarian", "oracle"]);
const THINKING = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const FORBIDDEN_ROLE_TOOL_NAMES = [
  "web_search",
  "url_context",
  "web_fetch",
  "batch_web_fetch",
  "ask_user_question",
];
const DENIED_ACTIONS = [
  "create",
  "update",
  "delete",
  "eject",
  "enable",
  "append-step",
  "refine",
  "refine.show",
  "refine.rollback",
].sort();
const errors = [];

function check(condition, message) {
  if (!condition) errors.push(message);
}

function read(relativePath) {
  return readFileSync(join(ROOT, relativePath), "utf8");
}

function json(relativePath) {
  try {
    return JSON.parse(read(relativePath));
  } catch (error) {
    errors.push(`${relativePath} must be valid JSON: ${error.message}`);
    return {};
  }
}

function frontmatter(text, file) {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  check(Boolean(match), `${file} must have YAML frontmatter and a body`);
  if (!match) return { fields: new Map(), body: text, raw: "" };

  const fields = new Map();
  for (const line of match[1].split("\n")) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const field = /^([A-Za-z][A-Za-z0-9]*):(?:\s*(.*))?$/.exec(line);
    if (field) fields.set(field[1], field[2] ?? "");
  }
  return { fields, body: match[2], raw: match[1] };
}

function hasAll(text, terms, label) {
  for (const term of terms) check(text.includes(term), `${label} missing: ${term}`);
}

function hasNone(text, terms, label) {
  for (const term of terms) check(!text.includes(term), `${label} contains forbidden legacy token: ${term}`);
}

const packageJson = json("package.json");
const lock = json("package-lock.json");
const installedBackend = json("node_modules/pi-subagents/package.json");

check(packageJson.version === "0.7.0", "package.json version must be 0.7.0");
check(
  packageJson.dependencies?.["pi-subagents"] === "0.49.0",
  "package.json must depend exactly on pi-subagents 0.49.0",
);
check(
  JSON.stringify(packageJson.pi?.extensions) === JSON.stringify([
    "./node_modules/pi-subagents/index.ts",
    "./extensions/oh-my-pi-slim/index.ts",
  ]),
  "package extensions must load native pi-subagents before OMPS",
);
check(
  JSON.stringify(packageJson.pi?.subagents?.agents) === JSON.stringify(["./agents"]),
  "package manifest must expose package-scoped agents from ./agents",
);
check(
  JSON.stringify(packageJson.pi?.skills) === JSON.stringify(["./extensions/oh-my-pi-slim/skills"]),
  "package manifest must expose the package skill directory",
);
check(!packageJson.scripts?.["install:user"], "package must not define install:user");
check(!packageJson.scripts?.["uninstall:user"], "package must not define uninstall:user");
check(lock.version === packageJson.version, "package-lock root version must match package.json");
check(lock.packages?.[""]?.version === packageJson.version, "package-lock package version must match package.json");
check(
  lock.packages?.[""]?.dependencies?.["pi-subagents"] === "0.49.0",
  "package-lock root dependency must pin pi-subagents 0.49.0",
);
check(
  lock.packages?.["node_modules/pi-subagents"]?.version === "0.49.0",
  "package-lock installed backend must be pi-subagents 0.49.0",
);
check(installedBackend.version === "0.49.0", "node_modules/pi-subagents must be version 0.49.0");

for (const obsolete of [
  "config/subagents.json",
  "scripts/install.mjs",
  "scripts/uninstall.mjs",
  "scripts/auto-resume.mjs",
  "extensions/oh-my-pi-slim/auto-resume.ts",
  "extensions/oh-my-pi-slim/operation-claims.ts",
]) {
  check(!existsSync(join(ROOT, obsolete)), `${obsolete} must not exist`);
}
check(read(".gitignore").split(/\r?\n/).includes(".cache/"), ".gitignore must contain .cache/");

const agentFiles = readdirSync(join(ROOT, "agents"))
  .filter((name) => name.endsWith(".md"))
  .sort();
check(
  JSON.stringify(agentFiles) === JSON.stringify(AGENTS.map((name) => `${name}.md`).sort()),
  "agents/ must contain exactly five specialist markdown files",
);

for (const name of AGENTS) {
  const file = `agents/${name}.md`;
  const parsed = frontmatter(read(file), file);
  const expectedRole = READ_ONLY.has(name) ? "read-only" : "writer";

  check(parsed.fields.get("name") === name, `${file} name must be ${name}`);
  check(parsed.fields.get("systemPromptMode") === "replace", `${file} must use systemPromptMode: replace`);
  check(parsed.fields.get("inheritProjectContext") === "true", `${file} must inherit project context`);
  check(parsed.fields.get("inheritSkills") === "true", `${file} must inherit skills`);
  check(parsed.fields.get("acceptanceRole") === expectedRole, `${file} acceptanceRole must be ${expectedRole}`);
  if (READ_ONLY.has(name)) {
    check(parsed.fields.get("completionGuard") === "false", `${file} must set completionGuard: false`);
  }

  for (const forbidden of [
    "turnBudget",
    "max_turns",
    "prompt_mode",
    "disallowed_tools",
    "tools",
    "aliases",
  ]) {
    check(!parsed.fields.has(forbidden), `${file} must not define ${forbidden}`);
  }
  hasAll(
    parsed.body,
    ["subagent", "subagent_wait", "subagent_supervisor", "contact_supervisor", "Do not ask the user directly"],
    `${file} body`,
  );
  check(
    /Do not call `subagent`, `subagent_wait`, or `subagent_supervisor`\./.test(parsed.body),
    `${file} must explicitly forbid native nested tools`,
  );
  check(
    /If blocked on a decision, use `contact_supervisor` with reason `need_decision`;/.test(parsed.body),
    `${file} must route blocked decisions to contact_supervisor`,
  );
  hasNone(parsed.body, FORBIDDEN_ROLE_TOOL_NAMES, `${file} body`);

  if (name === "librarian") {
    check(
      parsed.fields.get("description")?.includes("public source repository examples"),
      `${file} description must describe public source repository examples generically`,
    );
    hasAll(parsed.body, [
      "**Research Approach**",
      "external research capabilities available in the child environment",
      "official documentation",
      "public source repositories/examples",
      "user-provided URLs",
      "Do not assume any particular external research extension or tool is installed",
    ], `${file} generic research contract`);
  }
}

const extension = read("extensions/oh-my-pi-slim/index.ts");
const bootstrap = read("extensions/oh-my-pi-slim/bootstrap.ts");
const orchestrator = read("extensions/oh-my-pi-slim/orchestrator.md");
const readme = read("README.md");

const functionStart = extension.indexOf("export default function ohMyPiSlim");
const childReturn = extension.indexOf('if (process.env.PI_SUBAGENT_CHILD === "1") return;', functionStart);
const firstRegistration = extension.indexOf("pi.register", functionStart);
check(functionStart >= 0 && childReturn > functionStart, "extension must have a child-process early return");
check(childReturn < firstRegistration, "child early return must happen before any registration");
hasAll(extension, [
  'pi.on("session_start"',
  "assertNativeBackend(pi)",
  "ensureNativePackageSetup(PACKAGE_ROOT)",
  'pi.on("tool_call"',
  'event.toolName !== "subagent"',
  "function launchModelName",
  "launchModelName(preset[role])",
  "let activePreset: Preset | undefined",
  "activePreset = preset",
  "applyFreshPreset(input, activePreset)",
  "mutateScheduleCreate(input, activePreset)",
  "delete child.thinking",
  "delete child.turnBudget",
  "delete child.usageBudget",
  "delete child.toolBudget",
  'input.context = "fresh"',
  "blocks direct workflowScript execution",
  "CANONICAL_SCHEDULE_SCRIPT",
  'action === "schedule.create"',
  "RESUME_LAUNCH_OVERRIDE_FIELDS",
  'action === "resume"',
], "native extension contract");
hasNone(extension, [
  "function buildPresetPrompt",
  "<orchestration-preset",
], "static orchestrator prompt contract");

const loadPresetStart = extension.indexOf("function loadPresetConfig()");
const loadPresetEnd = extension.indexOf("function fullModelName", loadPresetStart);
const loadPresetBlock = extension.slice(loadPresetStart, loadPresetEnd);
check(loadPresetStart >= 0 && loadPresetEnd > loadPresetStart, "extension must define user-only preset loading");
hasAll(loadPresetBlock, [
  "join(getAgentDir(), CONFIG_FILE)",
  "parseConfigFile(userPath)",
  "User preset config is missing",
  "Enable bootstrap and restart Pi to rebuild it from the bundled example",
  "or create it manually before using oh-my-pi-slim",
  "User preset config contains no presets",
], "user-only preset loading");
hasNone(loadPresetBlock, [
  "PACKAGE_ROOT",
  "ctx.cwd",
  "isProjectTrusted",
  "mergeConfig",
  "packagePath",
  "projectPath",
], "user-only preset loading");
hasNone(extension, [
  "function mergeConfig",
  "getDefaultPresetPath",
  "CONFIG_DIR_NAME",
  "Refusing project preset config",
  "compatibility user config",
], "removed preset overlay implementation");
hasAll(extension, [
  'description: "Select an oh-my-pi-slim preset from ~/.pi/agent/oh-my-pi-slim.json"',
], "stable preset flag description");

const freshPresetStart = extension.indexOf("function applyFreshPreset");
const freshPresetEnd = extension.indexOf("function resumeOverrideFields", freshPresetStart);
const freshPresetBlock = extension.slice(freshPresetStart, freshPresetEnd);
check(freshPresetStart >= 0 && freshPresetEnd > freshPresetStart, "extension must define fresh preset enforcement");
hasAll(freshPresetBlock, [
  "child.model = launchModelName(preset[role])",
  "delete child.thinking",
  "delete child.turnBudget",
  "delete child.usageBudget",
  "delete child.toolBudget",
], "fresh preset model enforcement");

const scheduleCreateStart = extension.indexOf("function mutateScheduleCreate");
const scheduleCreateEnd = extension.indexOf("interface CheckpointTool", scheduleCreateStart);
const scheduleCreateBlock = extension.slice(scheduleCreateStart, scheduleCreateEnd);
check(scheduleCreateStart >= 0 && scheduleCreateEnd > scheduleCreateStart, "extension must define schedule preset enforcement");
hasAll(scheduleCreateBlock, [
  "applyFreshPreset(child, preset)",
  "delete input.model",
  "delete input.thinking",
  "delete input.turnBudget",
  "delete input.usageBudget",
  "delete input.toolBudget",
], "schedule preset model enforcement");

const beforeAgentStart = extension.indexOf('pi.on("before_agent_start"');
const beforeAgentStartEnd = extension.indexOf('pi.on("tool_call"', beforeAgentStart);
const beforeAgentStartBlock = extension.slice(beforeAgentStart, beforeAgentStartEnd);
check(beforeAgentStart >= 0 && beforeAgentStartEnd > beforeAgentStart, "extension must register before_agent_start");
check(
  beforeAgentStartBlock.includes('systemPrompt: `${systemPrompt}\\n\\n${ORCHESTRATOR_PROMPT}`,') &&
    beforeAgentStartBlock.split("ORCHESTRATOR_PROMPT").length === 2,
  "before_agent_start must append only ORCHESTRATOR_PROMPT",
);
hasNone(beforeAgentStartBlock, ["buildPresetPrompt", "<orchestration-preset"], "before_agent_start prompt assembly");

check(
  extension.indexOf("assertNativeBackend(pi)", extension.indexOf("async function activate")) >= 0,
  "activate must check the native backend",
);

const rootImportEndMarker = 'from "@earendil-works/pi-coding-agent";';
const rootImportEnd = extension.indexOf(rootImportEndMarker);
const importBlock = extension.slice(0, rootImportEnd + rootImportEndMarker.length);
check(rootImportEnd >= 0, "extension must import checkpoint APIs from the Pi public root export");
hasAll(importBlock, [
  "SettingsManager",
  "shouldCompact",
  "getAgentDir",
  "type TurnEndEvent",
], "checkpoint public root imports");

const batchHelperStart = extension.indexOf("function completedToolBatch(event: TurnEndEvent)");
const batchHelperEnd = extension.indexOf("export default function ohMyPiSlim", batchHelperStart);
const batchHelper = extension.slice(batchHelperStart, batchHelperEnd);
check(batchHelperStart >= 0 && batchHelperEnd > batchHelperStart, "extension must define the pure completedToolBatch helper");
hasAll(batchHelper, [
  'event.message.role !== "assistant"',
  'event.message.stopReason !== "toolUse"',
  'content.type !== "toolCall"',
  "callsById.has(content.id)",
  "event.toolResults.length !== tools.length",
  "resultIds.has(result.toolCallId)",
  "callsById.get(result.toolCallId) !== result.toolName",
  "tools.push({ id: content.id, name: content.name })",
], "complete tool batch helper");
hasNone(batchHelper, [
  "result.content",
  "result.details",
  "result.isError",
  "pi.",
  "ctx.",
  "SettingsManager",
], "complete tool batch helper");

hasAll(extension, [
  "let sessionEpoch = 0",
  "let pendingCheckpoint:",
  "sawThresholdCompaction: boolean",
  "resumeScheduled: boolean",
  "let fileToolSeenThisTurn = false",
  'pi.on("session_before_switch"',
  'pi.on("turn_end"',
  'pi.on("session_compact"',
  'pi.on("agent_settled"',
  "SettingsManager.create(",
  "ctx.cwd",
  "getAgentDir()",
  "{ projectTrusted: ctx.isProjectTrusted() }",
  ").getCompactionSettings()",
  "ctx.getContextUsage()",
  "usage.tokens !== null",
  "usage.contextWindow !== null",
  "shouldCompact(usage.tokens, usage.contextWindow, settings)",
  "!pendingCheckpoint && !ctx.hasPendingMessages()",
  "ctx.abort();",
  'event.reason === "threshold"',
  "event.willRetry === false",
  "if (checkpoint.sawThresholdCompaction)",
  "setImmediate(() =>",
  "pendingCheckpoint !== checkpoint",
  "checkpoint.epoch !== sessionEpoch",
  "pendingCheckpoint = undefined",
  'pi.sendUserMessage(resumeText, { deliverAs: "followUp" })',
  'pi.on("tool_execution_end"',
  "fileToolSeenThisTurn = true",
  "const sawFileTool = fileToolSeenThisTurn",
  "fileToolSeenThisTurn = false",
], "tool-batch checkpoint runtime");
const toolEndStart = extension.indexOf('pi.on("tool_execution_end"');
const turnEndStart = extension.indexOf('pi.on("turn_end"', toolEndStart);
const turnEndEnd = extension.indexOf('pi.on("session_compact"', turnEndStart);
const toolEndBlock = extension.slice(toolEndStart, turnEndStart);
const turnEndBlock = extension.slice(turnEndStart, turnEndEnd);
hasNone(toolEndBlock, ["pi.sendMessage", "pi.sendUserMessage"], "tool_execution_end file nudge");
hasAll(turnEndBlock, [
  "ctx.abort();",
  "return;",
], "turn_end checkpoint dispatch");
hasNone(turnEndBlock, [
  "await ctx.abort",
  "waitForIdle",
  "isIdle()",
], "turn_end checkpoint dispatch");
check(
  turnEndBlock.indexOf("ctx.abort();") < turnEndBlock.indexOf("pi.sendMessage("),
  "turn_end must abort the old low-level run before the file nudge",
);
const sessionCompactStart = extension.indexOf('pi.on("session_compact"', turnEndStart);
const agentSettledStart = extension.indexOf('pi.on("agent_settled"', sessionCompactStart);
const agentSettledEnd = extension.indexOf('pi.on("session_shutdown"', agentSettledStart);
const sessionCompactBlock = extension.slice(sessionCompactStart, agentSettledStart);
const agentSettledBlock = extension.slice(agentSettledStart, agentSettledEnd);
hasAll(sessionCompactBlock, [
  "pendingCheckpoint?.epoch === sessionEpoch",
  'event.reason === "threshold"',
  "event.willRetry === false",
  "pendingCheckpoint.sawThresholdCompaction = true",
], "threshold session_compact checkpoint");
hasAll(agentSettledBlock, [
  "const checkpoint = pendingCheckpoint",
  "if (!checkpoint || checkpoint.epoch !== sessionEpoch) return",
  "if (checkpoint.sawThresholdCompaction)",
  "scheduleCheckpointResume(checkpoint, ctx)",
  "pendingCheckpoint = undefined",
  "Pi did not complete threshold compaction",
  '"warning"',
], "agent_settled checkpoint outcome");
hasNone(agentSettledBlock, [
  "ctx.abort",
  "ctx.compact",
  "waitForIdle",
], "agent_settled checkpoint outcome");
check(
  /async function deactivate[\s\S]*?invalidateCheckpoint\(\);[\s\S]*?active = false;/.test(extension),
  "deactivate must invalidate checkpoint identity before disabling OMPS",
);
hasAll(extension.slice(extension.indexOf('pi.on("input"'), extension.indexOf('pi.on("before_agent_start"')), [
  'event.source === "extension"',
  "pendingCheckpoint = undefined",
  "nudgeSentThisUserTurn = false",
], "non-extension input cancellation");

const resumeStart = extension.indexOf("function scheduleCheckpointResume");
const resumeEnd = extension.indexOf("function resolvePresetModels", resumeStart);
const resumeBlock = extension.slice(resumeStart, resumeEnd);
hasAll(resumeBlock, [
  "setImmediate(() =>",
  "checkpoint.tools.map(({ id, name }) => `- ${id}: ${name}`)",
  "new post-compaction turn, not a transparent continuation",
  "Do not repeat these calls solely because the turn restarted",
  "Re-fetch only when needed to verify state or recover missing information",
  '"warning"',
], "checkpoint resume copy");
hasNone(resumeBlock, [
  "toolResults",
  "tool output",
  "custom summary",
  "plan:",
], "checkpoint resume copy");

hasNone(extension, [
  'pi.on("context"',
  'pi.on("session_before_compact"',
  "customInstructions",
  "DEFAULT_COMPACTION_SETTINGS",
  "reserveTokens",
  "keepRecentTokens",
  "truncateHead",
  "truncateTail",
  "emergency truncation",
  "ctx.compact(",
  "onComplete:",
  "onError:",
  "Tool-batch checkpoint compaction failed",
  "await ctx.abort",
  "waitForIdle",
  "isIdle()",
  "usage.percent",
  "percentage",
  "百分比",
  '"%"',
], "checkpoint forbidden implementation");

const deniedBlock = /const DENIED_ACTIONS = new Set\(\[([\s\S]*?)\]\);/.exec(extension)?.[1] ?? "";
const sourceDenied = [...deniedBlock.matchAll(/"([^"]+)"/g)].map((match) => match[1]).sort();
check(
  JSON.stringify(sourceDenied) === JSON.stringify(DENIED_ACTIONS),
  `DENIED_ACTIONS must contain exactly: ${DENIED_ACTIONS.join(", ")}`,
);
check(!sourceDenied.includes("disable") && !sourceDenied.includes("reset"), "denylist must not include disable or reset");
hasNone(extension, [
  "registerTool",
  'Symbol.for("pi-subagents:manager")',
  "subagents:rpc:",
  "findHistoricalSubagentRecord",
  "historicalSubagentResult",
  "resumeCompletedRecord",
  "AgentOperationClaims",
  "autoResume",
], "extension");

const exportedBootstrapFunctions = [...bootstrap.matchAll(/export function\s+(\w+)/g)]
  .map((match) => match[1])
  .sort();
check(
  JSON.stringify(exportedBootstrapFunctions) === JSON.stringify([
    "ensureNativePackageSetup",
    "getPresetTemplatePath",
    "restoreNativePackageSetup",
  ]),
  "bootstrap must export only native setup, restore, and preset template helpers",
);
hasAll(bootstrap, [
  "Seed the user preset when missing and apply two native settings",
  'join(agentDir, "settings.json")',
  'join(agentDir, "extensions", "subagent", "config.json")',
  "disableBuiltins",
  "maxSubagentDepth",
  "ohMyPiSlimMigration",
  "MigrationState",
], "bootstrap native setup");

const templateHelperStart = bootstrap.indexOf("export function getPresetTemplatePath");
const templateHelperEnd = bootstrap.indexOf("export function ensureNativePackageSetup", templateHelperStart);
const templateHelperBlock = bootstrap.slice(templateHelperStart, templateHelperEnd);
check(templateHelperStart >= 0 && templateHelperEnd > templateHelperStart, "bootstrap must export the preset template path helper");
hasAll(templateHelperBlock, [
  'join(packageRoot, "config", "oh-my-pi-slim.example.json")',
], "preset template path helper");
hasNone(templateHelperBlock, [
  '".pi"',
  "getDefaultPresetPath",
], "preset template path helper");

const setupStart = bootstrap.indexOf("export function ensureNativePackageSetup");
const seedEnd = bootstrap.indexOf("const userSettingsFileExisted", setupStart);
const seedBlock = bootstrap.slice(setupStart, seedEnd);
check(setupStart >= 0 && seedEnd > setupStart, "bootstrap must seed the user preset before settings migration");
hasAll(seedBlock, [
  "getPresetTemplatePath(packageRoot)",
  'join(agentDir, "oh-my-pi-slim.json")',
  "if (!existsSync(userPresetPath))",
  "mkdirSync(agentDir, { recursive: true })",
  "writeFileSync(userPresetPath, readFileSync(bundledPresetPath), { flag: \"wx\" })",
  'code !== "EEXIST"',
], "bootstrap user preset seed contract");
hasNone(seedBlock, [
  "writeJsonAtomic(userPresetPath",
  "rmSync(userPresetPath",
], "bootstrap user preset seed contract");

const restoreStart = bootstrap.indexOf("export function restoreNativePackageSetup");
const restoreBlock = bootstrap.slice(restoreStart);
check(restoreStart >= 0, "bootstrap must export native setup restore");
hasNone(restoreBlock, [
  '"oh-my-pi-slim.json"',
  "userPresetPath",
], "uninstall user preset preservation");

hasNone(bootstrap, [
  "copyFileSync",
  "cpSync",
  "installAgents",
  "copyAgents",
  "installPreset",
  "copyPreset",
  "aliases",
  "getDefaultPresetPath",
], "removed bootstrap asset-copy implementation");

hasAll(orchestrator, [
  'subagent({ agent: "explorer", task:',
  "asynchronous and run in the background by default",
  "async: false",
  "For fresh calls, do not pass `model`, `thinking`, `turnBudget`, `usageBudget`, or `toolBudget`",
  "The OMPS runtime enforces the current active preset's model contract and removes caller overrides",
  "subagent_wait",
  'action: "status"',
  'action: "steer"',
  'action: "interrupt"',
  'action: "stop"',
  'action: "resume"',
  "creates a new run ID",
  "Direct `workflowScript` execution is blocked",
  'action: "schedule.create"',
  "contact_supervisor",
  "Only the main orchestrator may ask the user direct questions",
], "orchestrator native contract");
hasNone(orchestrator, [...FORBIDDEN_ROLE_TOOL_NAMES, "<orchestration-preset"], "orchestrator body");

hasAll(readme, [
  "0.7.0 preset migration",
  "breaking preset 配置变更",
  "运行时仅从用户文件",
  "移除 project/package overlay",
  "用户文件缺失时",
  "bundled 示例",
  "已有文件不会被覆盖",
  "不会自动获得 `balanced`、`economy` 或 `openai`",
  "手工合并",
  "pi install git:github.com/YanzuoLu/oh-my-pi-slim@v0.7.0",
  "重启 Pi，或执行 `/reload`",
], "README 0.7.0 preset migration contract");

hasAll(readme, [
  "0.6.0 breaking migration",
  "pi-subagents@0.49.0",
  "pi remove npm:@tintinweb/pi-subagents",
  "pi install git:github.com/YanzuoLu/oh-my-pi-slim",
  "会拒绝激活",
  "./node_modules/pi-subagents/index.ts",
  'pi.subagents.agents: ["./agents"]',
  "不会把 agent 复制到 `~/.pi/agent/agents`",
  "pi --omps",
  "pi --omps --omps-preset balanced",
  "/omps on economy",
  "/preset openai",
  "/omps status",
  "/omps off",
  "/omps presets",
  "/omps uninstall",
  'subagent({ agent: "explorer", task:',
  "subagent_wait",
  "不要 sleep，也不要循环调用 status 轮询",
  "新的 run ID",
  "provider/model:thinking",
  'context: "fresh"',
  "禁止直接 arbitrary `workflowScript`",
  "create, update, delete, eject, enable, append-step",
  "disable` 与 `reset` 不在 OMPS denylist",
  "canonical strict-JSON",
  "backend timer 直接执行，不经过 OMPS 的 `tool_call` gate",
  "不是完整 sandbox",
  "原生 persistence、status、result、events 和 restart recovery",
  "Tool-batch checkpoint compaction",
  "Pi `SettingsManager`",
  "`shouldCompact`",
  "完整 tool batch",
  "public `ctx.abort()`",
  "post-run `_checkCompaction`",
  "threshold auto path",
  '`reason === "threshold"`',
  "`willRetry === false`",
  "`agent_settled`",
  "新的 extension user turn",
  "不是 transparent continuation",
  "不是透明 continuation",
  "模型仍可能重复调用",
  "batch 不完整",
  "usage 未知",
  "compaction 已禁用",
  "已有 pending",
  "不裁剪或改写 context request 副本",
  "不修改 Pi compaction settings",
  '"disableBuiltins": true',
  '"maxSubagentDepth": 1',
  "trusted project settings 可以覆盖",
  "shadow package agent",
  "PI_SUBAGENT_CHILD=1",
  "contact_supervisor",
  "禁止直接询问用户",
  "角色 prompt 不依赖具体外部 extension 工具名",
  "native child 环境当前加载的工具决定",
  "@gotgenes/pi-anthropic-auth",
  "运行时 preset 的唯一来源是用户文件",
  "~/.pi/agent/oh-my-pi-slim.json",
  "不读取 package 内的 preset 配置",
  "不读取任何 `<project>/.pi/oh-my-pi-slim.json`",
  "不存在 package/user/project overlay 或 preset 合并语义",
  "config/oh-my-pi-slim.example.json",
  "exclusive create（`wx`）",
  "`EEXIST` 会被安全忽略",
  "升级不会覆盖或刷新",
  "`/omps uninstall` 也不会删除",
  "用户拥有",
  "balanced",
  "economy",
  "openai",
  "默认是 `balanced`",
  "从旧 overlay 语义升级",
  "已有的用户 JSON 现在会成为完整真源",
  "不会自动补入缺少的 `balanced`、`economy` 或 `openai`",
  "手工合并",
  "先备份再删除用户 JSON 并重启 Pi",
  "bootstrap 重新 seed bundled 示例",
  "直接删除会永久丢失原有自定义",
  "pi remove git:github.com/YanzuoLu/oh-my-pi-slim",
  "npm run validate",
], "README 0.6 contract");

const legacyCalls = [
  "`Agent(",
  "Agent({",
  "get_subagent_result(",
  "steer_subagent(",
  "resume_subagent(",
  "stop_subagent(",
];
for (const [label, text] of [["README", readme], ["orchestrator", orchestrator]]) {
  hasNone(text, [...legacyCalls, "max_turns", "same-ID resume", "same ID resume", "10-minute", "10 minutes", "ten minutes"], label);
}
hasNone(readme, [
  "manual native compaction",
  "<package>/.pi/oh-my-pi-slim.json",
  "后加载文件按 preset 名覆盖",
  "不是逐 role 深合并",
  "package base 自带",
  "compatibility user overlay",
  "trusted project overlay",
], "README obsolete contract");

const legacyPresetPath = ".pi/oh-my-pi-slim.json";
check(!existsSync(join(ROOT, legacyPresetPath)), "legacy package preset path must not exist");
const presetPath = "config/oh-my-pi-slim.example.json";
check(existsSync(join(ROOT, presetPath)), "bundled preset example must exist");
const presetConfig = json(presetPath);
check(presetConfig.defaultPreset === "balanced", "bundled preset example defaultPreset must be balanced");
check(
  presetConfig.presets?.[presetConfig.defaultPreset],
  "bundled preset example defaultPreset must reference a preset",
);
check(
  JSON.stringify(Object.keys(presetConfig.presets ?? {}).sort()) === JSON.stringify(["balanced", "economy", "openai"]),
  "bundled preset example must contain exactly balanced, economy, and openai",
);
for (const [presetName, preset] of Object.entries(presetConfig.presets ?? {})) {
  check(
    JSON.stringify(Object.keys(preset).sort()) === JSON.stringify([...ROLES].sort()),
    `bundled ${presetName} preset must define exactly six roles`,
  );
  for (const role of ROLES) {
    const config = preset[role];
    check(config && typeof config === "object" && !Array.isArray(config), `bundled ${presetName}.${role} must be an object`);
    check(typeof config?.provider === "string" && config.provider.trim(), `bundled ${presetName}.${role}.provider must be non-empty`);
    check(typeof config?.model === "string" && config.model.trim(), `bundled ${presetName}.${role}.model must be non-empty`);
    check(THINKING.has(config?.thinking), `bundled ${presetName}.${role}.thinking is invalid`);
  }
}

const diffCheck = spawnSync("git", ["diff", "--check"], {
  cwd: ROOT,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
});
check(diffCheck.status === 0, `git diff --check failed:\n${diffCheck.stdout}${diffCheck.stderr}`.trim());

if (errors.length > 0) {
  console.error(`Validation failed with ${errors.length} error(s):`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log("Validation passed: oh-my-pi-slim 0.7.0 native contract is internally consistent.");
