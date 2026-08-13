#!/usr/bin/env node

import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const AGENTS = ["explorer", "librarian", "oracle", "designer", "fixer"];
const ROLES = ["orchestrator", ...AGENTS];
const THINKING = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const errors = [];
const check = (condition, message) => { if (!condition) errors.push(message); };
const read = (path) => readFileSync(path, "utf8");
const agentFiles = readdirSync(join(ROOT, "agents")).filter((name) => name.endsWith(".md")).sort();
check(
  JSON.stringify(agentFiles) === JSON.stringify(AGENTS.map((name) => `${name}.md`).sort()),
  `agents/ must contain exactly: ${AGENTS.map((name) => `${name}.md`).join(", ")}`,
);

for (const name of AGENTS) {
  const path = join(ROOT, "agents", `${name}.md`);
  const text = read(path);
  check(text.startsWith("---\n"), `${name}.md must start with YAML frontmatter`);
  check(!/\nmodel:/.test(text), `${name}.md must not hard-code a model; presets own model selection`);
  check(!/\nthinking:/.test(text), `${name}.md must not hard-code thinking; presets own thinking selection`);
  check(/\nprompt_mode:\s*replace\b/.test(text), `${name}.md must use prompt_mode: replace`);
  check(!/\nallowed_subagents:/.test(text), `${name}.md must not enable nested delegation`);
  check(!/\ntools:/.test(text), `${name}.md must not define a tool allowlist`);
  check(
    text.includes(
      "disallowed_tools: Agent, get_subagent_result, steer_subagent, stop_subagent, ask_user_question",
    ),
    `${name}.md must deny only orchestration and direct-user-question tools`,
  );
  check(/\nextensions:\s*true\b/.test(text), `${name}.md must inherit extension tools`);
  check(!/\nexclude_extensions:/.test(text), `${name}.md must not exclude extensions`);
  check(text.includes("\n<omps-tool-guidance/>\n"), `${name}.md must include the tool guidance marker`);
  check(text.includes("\n<omps-shared-context/>\n"), `${name}.md must include the shared context marker`);
  const toolMarkerIndex = text.indexOf("<omps-tool-guidance/>");
  const contextMarkerIndex = text.indexOf("<omps-shared-context/>");
  const roleIndex = text.indexOf("You are ");
  check(
    toolMarkerIndex < contextMarkerIndex && contextMarkerIndex < roleIndex,
    `${name}.md markers must be ordered tool guidance, shared context, specialist role`,
  );
}

const presetPath = join(ROOT, ".pi", "oh-my-pi-slim.json");
const presetConfig = JSON.parse(read(presetPath));
check(
  presetConfig.presets && Object.keys(presetConfig.presets).length >= 2,
  "preset config must define multiple presets",
);
check(
  typeof presetConfig.defaultPreset === "string" && presetConfig.presets[presetConfig.defaultPreset],
  "preset config defaultPreset must reference an existing preset",
);
for (const [presetName, preset] of Object.entries(presetConfig.presets ?? {})) {
  for (const role of ROLES) {
    const roleConfig = preset[role];
    check(roleConfig && typeof roleConfig === "object", `${presetName}.${role} must be configured`);
    check(typeof roleConfig?.provider === "string" && roleConfig.provider, `${presetName}.${role}.provider missing`);
    check(typeof roleConfig?.model === "string" && roleConfig.model, `${presetName}.${role}.model missing`);
    check(THINKING.has(roleConfig?.thinking), `${presetName}.${role}.thinking invalid`);
  }
}

const orchestrator = read(join(ROOT, "extensions", "oh-my-pi-slim", "orchestrator.md"));
for (const role of AGENTS) check(orchestrator.includes(`@${role}`), `orchestrator prompt missing @${role}`);
for (const tool of ["Agent", "get_subagent_result", "steer_subagent", "stop_subagent", "ask_user_question"]) {
  check(orchestrator.includes(tool), `orchestrator prompt missing Pi tool ${tool}`);
}
for (const claudeOnly of [
  "SendMessage",
  "TaskStop",
  "AskUserQuestion",
  "EnterPlanMode",
  "subagent_type: \"oh-my-claude-code-slim:",
]) {
  check(!orchestrator.includes(claudeOnly), `orchestrator prompt contains Claude Code-only term: ${claudeOnly}`);
}
check(orchestrator.includes("resume: agent_id"), "orchestrator prompt must document Pi resume semantics");
check(
  orchestrator.includes("automatically preserves its prior result") &&
    orchestrator.includes("Do not follow it with `get_subagent_result` or a manual `Agent` resume"),
  "orchestrator prompt must document completed steer auto-resume semantics",
);
check(
  orchestrator.includes("Background completions arrive automatically"),
  "orchestrator prompt must document automatic completion notifications",
);
check(orchestrator.includes("<orchestration-preset>"), "orchestrator must use the injected preset contract");

const extensionPath = join(ROOT, "extensions", "oh-my-pi-slim", "index.ts");
const bootstrapPath = join(ROOT, "extensions", "oh-my-pi-slim", "bootstrap.ts");
const promptContextPath = join(ROOT, "extensions", "oh-my-pi-slim", "prompt-context.ts");
const piDocumentationSkillPath = join(
  ROOT,
  "extensions",
  "oh-my-pi-slim",
  "skills",
  "pi-documentation",
  "SKILL.md",
);
const extension = read(extensionPath);
const bootstrap = read(bootstrapPath);
const promptContext = read(promptContextPath);
const piDocumentationSkill = read(piDocumentationSkillPath);
for (const role of AGENTS) check(extension.includes(`\"${role}\"`), `extension allowlist missing ${role}`);
check(extension.includes('pi.registerFlag("omps-preset"'), "extension must register --omps-preset");
check(extension.includes('pi.registerCommand("preset"'), "extension must register the standalone /preset command");
check(extension.includes("CONFIG_DIR_NAME"), "extension must use Pi's project config directory constant");
check(extension.includes("loadPresetConfig"), "extension must load preset configuration");
check(extension.includes("pi.setModel(orchestratorModel)"), "extension must apply the orchestrator model");
check(extension.includes("pi.setThinkingLevel"), "extension must apply orchestrator thinking");
check(!extension.includes("setActiveTools"), "extension must not override Pi's active tool list");
check(!extension.includes("getActiveTools"), "extension must not snapshot or override Pi's active tool list");
check(extension.includes('pi.on("session_shutdown", async'), "extension must restore session-scoped preset state on shutdown");
check(extension.includes('event.toolName !== "Agent"'), "extension must gate Agent tool calls");
check(extension.includes("actualModel.toLowerCase()"), "extension must enforce specialist preset models");
check(extension.includes("actualThinking !== expected.thinking"), "extension must enforce specialist thinking");
check(extension.includes('name: STOP_TOOL'), "extension must register stop_subagent");
check(!extension.includes("ASK_USER_TOOL"), "extension must not reimplement ask_user_question");
check(!extension.includes("ctx.ui.select"), "extension must use the installed question package");
check(!extension.includes("ctx.ui.input"), "extension must use the installed question package");
check(extension.includes("subagents:rpc:stop"), "stop_subagent must use pi-subagents RPC");
check(extension.includes('pi.on("tool_result", async'), "completed steer fallback must run in async tool_result");
check(extension.includes('event.toolName !== STEER_TOOL'), "completed steer fallback must target steer_subagent");
check(extension.includes('Symbol.for("pi-subagents:manager")'), "completed steer fallback must use the cross-package global manager registry");
check(extension.includes("resumeCompletedRecord"), "completed steer fallback must resume the same session with the steer message");
check(extension.includes("isCompletedSteerRejection"), "completed steer fallback must only intercept upstream completed/steered rejections");
check(extension.includes("withResumeLock"), "completed steer fallback must serialize resumes per agent");
check(extension.includes("AgentOperationClaims"), "Agent resume and completed steer must share operation claims");
check(extension.includes("operationClaims.claimSteer"), "steer_subagent must claim completed/steered agent IDs before execution");
check(extension.includes("operationClaims.claimExplicitResume"), "Agent resume must claim agent IDs before execution");
check(extension.includes("operationClaims.releaseToolCall(event.toolCallId)"), "tool execution end must release operation claims by toolCallId");
check(!extension.includes("record.session.steer ="), "completed steer fallback must not replace session.steer");
check(
  read(join(ROOT, "README.md")).includes("pi install npm:@juicesharp/rpiv-ask-user-question"),
  "README must tell users to install rpiv-ask-user-question explicitly",
);
check(
  !read(join(ROOT, "package.json")).includes("--install-ask-user"),
  "package scripts must not install rpiv-ask-user-question automatically",
);
check(extension.includes("CHILD_AGENT_TAG"), "extension must avoid injecting orchestrator into child sessions");
check(
  extension.includes('const CHILD_AGENT_TAG = /^<active_agent\\s+name="[^\"]+"\\s*\\/>/;'),
  "child detection must only match an active_agent tag at the start of the prompt",
);
check(
  extension.includes('if (sessionRole !== "child" && active) await deactivate(ctx);'),
  "before_agent_start must restore accidentally activated child sessions",
);
const presetCommandStart = extension.indexOf('pi.registerCommand("preset"');
const commandHandlerStart = extension.indexOf('pi.registerCommand("omps"');
const presetCommand = extension.slice(presetCommandStart, commandHandlerStart);
check(presetCommandStart !== -1, "/preset command handler must exist");
check(
  presetCommand.includes('description: "Switch the oh-my-pi-slim preset: /preset <name>"'),
  "/preset description must document the required preset name",
);
check(presetCommand.includes('if (sessionRole === "child") return;'), "/preset must remain inert in child sessions");
check(
  presetCommand.includes('if (sessionRole === "unknown") {') &&
    presetCommand.includes('sessionRole = "main";') &&
    presetCommand.includes("pendingActivation = undefined;"),
  "/preset must safely classify an unknown interactive session as main and clear pending activation",
);
check(
  presetCommand.includes("const requestedPreset = args.trim();") &&
    presetCommand.includes("await activate(ctx, requestedPreset);"),
  "/preset <name> must trim the full argument and activate the requested preset directly",
);
const emptyPresetStart = presetCommand.indexOf("if (!requestedPreset) {");
const directPresetStart = presetCommand.indexOf("\n\n      try {", emptyPresetStart);
const emptyPresetHandler = presetCommand.slice(emptyPresetStart, directPresetStart);
check(
  emptyPresetStart !== -1 &&
    directPresetStart !== -1 &&
    emptyPresetHandler.includes("const config = loadPresetConfig(ctx);") &&
    emptyPresetHandler.includes("availablePresetsMessage(config)") &&
    emptyPresetHandler.includes("return;") &&
    !emptyPresetHandler.includes("activate(ctx"),
  "/preset without arguments must load config, report available presets/default/usage, and return without activation",
);
check(
  extension.includes("if (!active) {") &&
    extension.includes("originalModel = ctx.model;") &&
    extension.includes("originalThinking = pi.getThinkingLevel() as ThinkingLevel;"),
  "preset switching must preserve the original model/thinking snapshot after first activation",
);
const commandHandlerEnd = extension.indexOf('pi.on("session_start"', commandHandlerStart);
const commandHandler = extension.slice(commandHandlerStart, commandHandlerEnd);
check(commandHandler.includes('if (sessionRole === "child") return;'), "/omps must remain inert in child sessions");
check(!commandHandler.includes('if (sessionRole !== "main") return;'), "/omps must not silently return for an unknown session role");
check(
  commandHandler.includes('if (sessionRole === "unknown") {') &&
    commandHandler.includes('sessionRole = "main";') &&
    commandHandler.includes('pendingActivation = undefined;'),
  "/omps must safely classify an unknown interactive session as main and clear pending activation",
);
check(!commandHandler.includes("pending.shouldActivate"), "/omps must not auto-activate a pending startup request before handling the explicit command");
check(
  extension.indexOf("CHILD_AGENT_TAG.test(event.systemPrompt)") < extension.indexOf('sessionRole === "unknown"', extension.indexOf('pi.on("before_agent_start"')),
  "before_agent_start must recheck the child tag before unknown-role handling",
);
check(extension.includes("ctx.getSystemPrompt()"), "session_start must inspect the built base system prompt");
check(extension.indexOf("ctx.getSystemPrompt()") < extension.indexOf('pi.getFlag("omps-preset")'), "session_start must identify child sessions before activation-related flag handling");
check(extension.includes("loadProjectContextFiles({"), "child sessions must use Pi's project context loader");
check(extension.includes("agentDir: getAgentDir()"), "child context loading must include Pi's agent directory");
const beforeAgentStart = extension.slice(
  extension.indexOf('pi.on("before_agent_start"'),
  extension.indexOf('pi.on("tool_call"', extension.indexOf('pi.on("before_agent_start"')),
);
check(
  beforeAgentStart.includes("renderToolGuidance(event.systemPromptOptions)"),
  "child tool guidance must use the current turn's event.systemPromptOptions active tool view",
);
check(
  beforeAgentStart.indexOf("injectToolGuidance(event.systemPrompt, toolGuidance)") <
    beforeAgentStart.indexOf("injectSharedProjectContext(systemPrompt, childProjectContext)"),
  "child tool guidance must be injected before cached project context",
);
check(
  extension.includes('ctx.model?.provider === "anthropic"') &&
    extension.includes('ctx.model?.api === "anthropic-messages"') &&
    extension.includes("ctx.modelRegistry.isUsingOAuth(ctx.model)"),
  "identity handling must require Anthropic provider, Messages API, and registry-confirmed OAuth",
);
check(
  beforeAgentStart.indexOf('if (!active || !activePreset || !activePresetName) return;') < beforeAgentStart.indexOf("removeMainPiIdentity(systemPrompt)"),
  "inactive main sessions must return before Anthropic OAuth identity trimming",
);
check(!extension.includes("before_provider_request"), "extension must not rewrite provider payloads");
check(!/access[_-]?token|id[_-]?token|refresh[_-]?token/i.test(extension), "extension must not parse OAuth tokens");
check(extension.includes("ensurePackageAssets(PACKAGE_ROOT)"), "package extension must bootstrap undeclarable agent assets");
check(bootstrap.includes("AGENT_NAMES"), "bootstrap must install the five agent definitions");
check(bootstrap.includes("removePackageAssets"), "bootstrap must support reversible package cleanup");
check(promptContext.includes("prompt.startsWith(MAIN_PI_IDENTITY)"), "main identity removal must remain prefix-only");
check(promptContext.includes("PI_DOCUMENTATION_START"), "main prompt trimming must use the exact Pi documentation start anchor");
check(promptContext.includes("PI_DOCUMENTATION_END"), "main prompt trimming must use the exact Pi documentation end anchor");
check(promptContext.includes("CHILD_PROMPT_PREFIX"), "child identity removal must use the narrow child prompt prefix");
const childBranchStart = beforeAgentStart.indexOf('if (sessionRole === "child") {');
const childBranchEnd = beforeAgentStart.indexOf('if (!active || !activePreset || !activePresetName) return;');
const childBranch = beforeAgentStart.slice(childBranchStart, childBranchEnd);
const mainBranch = beforeAgentStart.slice(childBranchEnd);
check(
  mainBranch.includes("removeMainPiDocumentation(event.systemPrompt)") &&
    mainBranch.indexOf("removeMainPiDocumentation(event.systemPrompt)") <
      mainBranch.indexOf("injectDocumentationSkill(systemPrompt, event.systemPromptOptions)") &&
    mainBranch.indexOf("injectDocumentationSkill(systemPrompt, event.systemPromptOptions)") <
      mainBranch.indexOf("removeMainPiIdentity(systemPrompt)"),
  "active main sessions must remove built-in Pi documentation, inject the conditional skill, then trim OAuth identity",
);
check(
  mainBranch.startsWith('if (!active || !activePreset || !activePresetName) return;') &&
    mainBranch.indexOf('if (!active || !activePreset || !activePresetName) return;') <
      mainBranch.indexOf("injectDocumentationSkill(systemPrompt, event.systemPromptOptions)"),
  "inactive main sessions must return before the Pi documentation skill is injected",
);
check(
  childBranch.includes("injectDocumentationSkill(systemPrompt, event.systemPromptOptions)") &&
    childBranch.indexOf("injectDocumentationSkill(systemPrompt, event.systemPromptOptions)") <
      childBranch.indexOf('if (isAnthropicOAuth(ctx)) systemPrompt = removeChildPiIdentity(systemPrompt);'),
  "managed child sessions must receive the Pi documentation skill through their normal prompt path",
);
check(
  extension.includes("formatSkillsForPrompt(currentSkills)") &&
    extension.includes("formatSkillsForPrompt([...currentSkills, loadedPiDocumentationSkill])") &&
    extension.includes("loadSkillsFromDir({") &&
    extension.includes('source: "extension:oh-my-pi-slim"'),
  "OMPS must load and render its private skill with Pi's official skill APIs",
);
check(
  extension.includes("canReadSkills(event.systemPromptOptions)") &&
    extension.includes('.includes("read")'),
  "OMPS must expose its conditional skill only when the session can read SKILL.md",
);
const legacyInstaller = read(join(ROOT, "scripts", "install.mjs"));
check(
  legacyInstaller.includes('target: join(extensionDir, "prompt-context.ts")'),
  "legacy install must copy the prompt-context helper",
);
check(
  legacyInstaller.includes('source: join(ROOT, "extensions", "oh-my-pi-slim", "skills", "pi-documentation", "SKILL.md")') &&
    legacyInstaller.includes('target: join(extensionDir, "skills", "pi-documentation", "SKILL.md")'),
  "legacy install must keep the conditional Pi documentation skill private to the OMPS extension",
);

const readme = read(join(ROOT, "README.md"));
check(!readme.includes("non-blocking `tool_result`"), "README must not describe waited auto-resume as non-blocking");
check(
  readme.includes("/preset economy") &&
    readme.includes("`/preset` without a name lists the available preset names") &&
    readme.includes("Usage: /preset <name>") &&
    readme.includes("/omps preset economy") &&
    readme.includes("immediately updates the main orchestrator model, thinking level, active preset prompt, and status") &&
    readme.includes("New specialist sessions use the newly selected preset") &&
    readme.includes("existing and resumed specialist sessions retain the model"),
  "README Launching must document direct /preset switching, empty-argument usage, compatibility, and session model semantics",
);
check(
  readme.includes("validated against pi-subagents 0.15.0/current cross-package registry shape") &&
    readme.includes("about 10 minutes") &&
    readme.includes("session replacement/switch") &&
    readme.includes("not a stable public resume API"),
  "README must document the validated compatibility range and live-session cleanup limits",
);

const packageJson = JSON.parse(read(join(ROOT, "package.json")));
check(packageJson.version === "0.5.2", "independent-package release must be version 0.5.2");
check(
  !packageJson.dependencies || Object.keys(packageJson.dependencies).length === 0,
  "oh-my-pi-slim must not install third-party Pi packages as dependencies",
);
check(
  JSON.stringify(packageJson.pi?.extensions) ===
    JSON.stringify(["./extensions/oh-my-pi-slim/index.ts"]),
  "Pi package must load only the oh-my-pi-slim extension",
);
check(
  packageJson.pi?.skills === undefined && !existsSync(join(ROOT, "skills")),
  "Pi package must not expose an OMPS-only skill through its manifest or conventional root skills directory",
);
const skillFrontmatterEnd = piDocumentationSkill.indexOf("\n---\n", 4);
const skillFrontmatter = piDocumentationSkill.slice(4, skillFrontmatterEnd);
const skillDescription = /^description:\s*["']?(.+?)["']?$/m.exec(skillFrontmatter)?.[1] ?? "";
check(
  piDocumentationSkill.startsWith("---\nname: pi-documentation\n") &&
    skillFrontmatterEnd > 0 &&
    skillDescription.length > 0 &&
    skillDescription.length <= 1024 &&
    !skillFrontmatter.includes("\ncompatibility:") &&
    piDocumentationSkill.includes("Use this skill only when the task concerns Pi itself") &&
    piDocumentationSkill.includes("PI_PACKAGE_DIR") &&
    piDocumentationSkill.includes("docs/extensions.md") &&
    piDocumentationSkill.includes("docs/packages.md"),
  "Pi documentation skill must have standard frontmatter and verified installed-documentation guidance",
);
check(
  !bootstrap.includes("pi-documentation"),
  "package bootstrap must not expose the OMPS-only skill through the global skill directory",
);
const piExecutable = spawnSync("sh", ["-lc", "command -v pi"], { encoding: "utf8" });
let installedPiRoot;
if (piExecutable.status === 0 && piExecutable.stdout.trim()) {
  const entrypoint = realpathSync(piExecutable.stdout.trim());
  const candidates = [
    process.env.PI_PACKAGE_DIR,
    dirname(entrypoint),
    dirname(dirname(entrypoint)),
  ].filter((candidate) => typeof candidate === "string" && candidate.length > 0);
  installedPiRoot = candidates.find((candidate) =>
    existsSync(join(candidate, "README.md")) && existsSync(join(candidate, "dist", "core", "system-prompt.js"))
  );
  if (installedPiRoot) {
    const installedSystemPrompt = read(join(installedPiRoot, "dist", "core", "system-prompt.js"));
    check(
      installedSystemPrompt.includes(
        "Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):",
      ) && installedSystemPrompt.includes(
        "- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)",
      ),
      "installed Pi system prompt changed the documentation anchors used by OMPS",
    );
  }
}
check(typeof installedPiRoot === "string", "validation must locate the installed Pi package root");

const subagentsConfig = JSON.parse(read(join(ROOT, "config", "subagents.json")));
check(subagentsConfig.disableDefaultAgents === true, "config must disable default agents");
check(subagentsConfig.fallbackSubagent === "none", "config must disable fallback agents");
check(subagentsConfig.maxSubagentDepth === 1, "config must disable nested delegation at depth 1");

const {
  CHILD_PI_IDENTITY_LINE,
  MAIN_PI_IDENTITY,
  PI_DOCUMENTATION_END,
  PI_DOCUMENTATION_START,
  SHARED_CONTEXT_MARKER,
  TOOL_GUIDANCE_MARKER,
  injectPiDocumentationSkill,
  injectSharedProjectContext,
  injectToolGuidance,
  removeChildPiIdentity,
  removeMainPiDocumentation,
  removeMainPiIdentity,
  renderProjectContext,
  renderToolGuidance,
} = await import(new URL("../extensions/oh-my-pi-slim/prompt-context.ts", import.meta.url));
{
  const guidancePrefix = "Available tools:\n";
  const guidanceSuffix = "\n\nIn addition to the tools above, you may have access to other custom tools depending on the project.\n\nGuidelines:\n";
  const fixedGuidelines = "- Be concise in your responses\n- Show file paths clearly when working with files";
  check(
    renderToolGuidance({
      selectedTools: ["custom", "read", "hidden"],
      toolSnippets: { read: "Read files", custom: "Run custom work", hidden: "" },
    }) === `${guidancePrefix}- custom: Run custom work\n- read: Read files${guidanceSuffix}${fixedGuidelines}`,
    "tool guidance must list only active tools with truthy snippets in selectedTools order",
  );
  check(
    renderToolGuidance({ selectedTools: ["custom"], toolSnippets: {} }) ===
      `${guidancePrefix}(none)${guidanceSuffix}${fixedGuidelines}`,
    "tool guidance must render (none) when no active tool has a visible snippet",
  );
  check(
    renderToolGuidance({
      selectedTools: ["grep"],
      promptGuidelines: [
        "  Prefer exact matches  ",
        "",
        "Prefer exact matches",
        " Be concise in your responses ",
        " Show file paths clearly when working with files ",
      ],
    }) === `${guidancePrefix}(none)${guidanceSuffix}` +
      "- Prefer exact matches\n- Be concise in your responses\n- Show file paths clearly when working with files",
    "tool guidance must trim, ignore empty, and first-occurrence deduplicate custom and fixed guidelines",
  );
  const bashFallback = renderToolGuidance({
    selectedTools: ["bash"],
    toolSnippets: { bash: "Run commands" },
  });
  check(
    bashFallback.includes("Guidelines:\n- Use bash for file operations like ls, rg, find\n"),
    "tool guidance must add Pi's bash file-operation fallback when grep, find, and ls are inactive",
  );
  const noBashFallback = renderToolGuidance({
    selectedTools: ["bash", "grep"],
    toolSnippets: { bash: "Run commands", grep: "Search files" },
  });
  check(
    !noBashFallback.includes("Use bash for file operations like ls, rg, find"),
    "tool guidance must omit the bash fallback when grep, find, or ls is active",
  );
  const defaultTools = renderToolGuidance({ toolSnippets: { bash: "Run commands" } });
  check(
    defaultTools.startsWith(`${guidancePrefix}- bash: Run commands${guidanceSuffix}`) &&
      defaultTools.includes("Use bash for file operations like ls, rg, find"),
    "tool guidance must default selectedTools to read, bash, edit, write",
  );

  const guidance = renderToolGuidance({ selectedTools: [] });
  const wrappedGuidance = `<omps-tool-guidance>\n${guidance}\n</omps-tool-guidance>`;
  const markerPrompt = `environment\n${TOOL_GUIDANCE_MARKER}\n${SHARED_CONTEXT_MARKER}\nrole`;
  check(
    injectToolGuidance(markerPrompt, guidance) ===
      `environment\n${wrappedGuidance}\n${SHARED_CONTEXT_MARKER}\nrole`,
    "tool guidance placeholder must be replaced with the stable wrapper",
  );
  const promptWithMarkerAndWrapper = `${TOOL_GUIDANCE_MARKER}\nold ${wrappedGuidance}`;
  const placeholderFirst = injectToolGuidance(promptWithMarkerAndWrapper, guidance);
  check(
    placeholderFirst.startsWith(wrappedGuidance) && !placeholderFirst.includes(TOOL_GUIDANCE_MARKER),
    "tool guidance placeholder replacement must take priority when a wrapper also exists",
  );
  const alreadyWrapped = `environment\n${wrappedGuidance}\nrole`;
  const changedWrappedGuidance = "<omps-tool-guidance>\nchanged guidance\n</omps-tool-guidance>";
  check(
    injectToolGuidance(alreadyWrapped, "changed guidance") ===
      `environment\n${changedWrappedGuidance}\nrole`,
    "existing tool guidance wrappers must be updated for the current turn",
  );
  check(
    injectToolGuidance("prompt without marker", guidance) ===
      `prompt without marker\n\n${wrappedGuidance}`,
    "tool guidance injection must safely append when marker and wrapper are missing",
  );
  const damagedWrapper = "environment\n<omps-tool-guidance>\nold incomplete guidance\nrole";
  check(
    injectToolGuidance(damagedWrapper, "changed guidance") ===
      `${damagedWrapper}\n\n${changedWrappedGuidance}`,
    "damaged tool guidance wrappers must be preserved while a fresh wrapper is appended",
  );

  const files = [
    { path: "/global/AGENTS.md", content: "global rules" },
    { path: "/project/CLAUDE.md", content: "project rules" },
  ];
  const expected = "\n\n<project_context>\n\nProject-specific instructions and guidelines:\n\n" +
    '<project_instructions path="/global/AGENTS.md">\nglobal rules\n</project_instructions>\n\n' +
    '<project_instructions path="/project/CLAUDE.md">\nproject rules\n</project_instructions>\n\n' +
    "</project_context>\n";
  const context = renderProjectContext(files);
  check(context === expected, "project context rendering must exactly match Pi formatting and preserve order");
  check(renderProjectContext([]) === "", "empty project context must render as an empty string");
  const base = `prefix\n${SHARED_CONTEXT_MARKER}\nspecialist`;
  const injected = injectSharedProjectContext(base, context);
  check(injected === `prefix\n${context}\nspecialist`, "shared context must replace the specialist marker");
  const roleMentionsContext = `prefix\n${SHARED_CONTEXT_MARKER}\nrole describes <project_context> semantics`;
  const injectedWithRoleMention = injectSharedProjectContext(roleMentionsContext, context);
  check(
    injectedWithRoleMention === `prefix\n${context}\nrole describes <project_context> semantics`,
    "shared context marker must take priority over project_context text in specialist role instructions",
  );
  const markerWithExistingContext = `${context}prefix\n${SHARED_CONTEXT_MARKER}\nspecialist`;
  check(
    injectSharedProjectContext(markerWithExistingContext, context) === `${context}prefix\n\nspecialist`,
    "an existing matching shared context must only cause the marker to be removed",
  );
  const roleOnlyMentionsContext = "prefix\nrole describes <project_context> semantics";
  check(
    injectSharedProjectContext(roleOnlyMentionsContext, context) === `${roleOnlyMentionsContext}${context}`,
    "project_context text in role instructions must not prevent real context from being appended",
  );
  check(injectSharedProjectContext(injected, context) === injected, "shared context injection must be idempotent");
  check(injectSharedProjectContext(injectedWithRoleMention, context) === injectedWithRoleMention, "already-injected prompts with role project_context text must remain unchanged");
  check(injectSharedProjectContext(`prefix\n${SHARED_CONTEXT_MARKER}\nspecialist`, "") === "prefix\n\nspecialist", "empty context must remove the marker without creating a section");
  check(injectSharedProjectContext("prompt without marker", context) === `prompt without marker${context}`, "missing marker must safely append context");
  check(injectSharedProjectContext("prompt without marker", "") === "prompt without marker", "empty context without a marker must leave the prompt unchanged");
  const documentationBlock = `${PI_DOCUMENTATION_START}\n` +
    "- Main documentation: /installed/pi/README.md\n" +
    "- Additional docs: /installed/pi/docs\n" +
    `${PI_DOCUMENTATION_END}`;
  const afterDocumentation = "\n\nAPPEND SYSTEM\n\n<project_context>project rules</project_context>\n" +
    "<available_skills><skill>skill summary</skill></available_skills>\n" +
    "Current working directory: /project";
  const mainPromptWithDocumentation = `${MAIN_PI_IDENTITY}\n\nAvailable tools:\n- read` +
    `${documentationBlock}${afterDocumentation}`;
  check(
    removeMainPiDocumentation(mainPromptWithDocumentation) ===
      `${MAIN_PI_IDENTITY}\n\nAvailable tools:\n- read${afterDocumentation}`,
    "main documentation removal must preserve tools, append system, project context, skills, and cwd",
  );
  check(
    removeMainPiDocumentation(`${mainPromptWithDocumentation}${documentationBlock}`) ===
      `${MAIN_PI_IDENTITY}\n\nAvailable tools:\n- read${afterDocumentation}${documentationBlock}`,
    "main documentation removal must affect only the first exact block",
  );
  check(
    removeMainPiDocumentation(`custom prompt${documentationBlock}`) === "custom prompt",
    "main documentation removal must survive earlier extension changes to the Pi identity prefix",
  );
  check(
    removeMainPiDocumentation(`${MAIN_PI_IDENTITY}\n\nAvailable tools:\n- read`) ===
      `${MAIN_PI_IDENTITY}\n\nAvailable tools:\n- read`,
    "main documentation removal must be unchanged without the start anchor",
  );
  check(
    removeMainPiDocumentation(`${MAIN_PI_IDENTITY}${PI_DOCUMENTATION_START}\nchanged ending`) ===
      `${MAIN_PI_IDENTITY}${PI_DOCUMENTATION_START}\nchanged ending`,
    "main documentation removal must fail safe when Pi changes the end anchor",
  );
  const renderedPiSkill = "\n\nThe following skills provide specialized instructions for specific tasks.\n" +
    "Use the read tool to load a skill's file when the task matches its description.\n" +
    "When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.\n\n" +
    "<available_skills>\n  <skill>\n    <name>pi-documentation</name>\n" +
    "    <description>Use for work about Pi itself.</description>\n" +
    "    <location>/package/skills/pi-documentation/SKILL.md</location>\n" +
    "  </skill>\n</available_skills>";
  const existingSkills = renderedPiSkill
    .replace("pi-documentation", "other-skill")
    .replace("Use for work about Pi itself.", "Other skill")
    .replace("/package/skills/pi-documentation/SKILL.md", "/skills/other/SKILL.md");
  const nextSkills = existingSkills.replace(
    "</available_skills>",
    renderedPiSkill.slice(
      renderedPiSkill.indexOf("  <skill>"),
      renderedPiSkill.indexOf("</available_skills>"),
    ) + "</available_skills>",
  );
  const promptWithSkills = `role${existingSkills}\nCurrent working directory: /project`;
  const mergedSkills = injectPiDocumentationSkill(promptWithSkills, existingSkills, nextSkills);
  check(
    mergedSkills.includes("<name>other-skill</name>") &&
      mergedSkills.includes("<name>pi-documentation</name>") &&
      mergedSkills.indexOf("<name>pi-documentation</name>") < mergedSkills.indexOf("</available_skills>") &&
      mergedSkills.endsWith("Current working directory: /project"),
    "conditional skill injection must merge into Pi's existing available_skills block before cwd",
  );
  const promptWithoutSkills = "role\nCurrent working directory: /project";
  check(
    injectPiDocumentationSkill(promptWithoutSkills, "", renderedPiSkill) ===
      `role${renderedPiSkill}\nCurrent working directory: /project`,
    "conditional skill injection must create Pi's standard skills block before cwd",
  );
  const misleadingSkillsText = "role <available_skills>documentation example</available_skills>\nCurrent working directory: /project";
  check(
    injectPiDocumentationSkill(misleadingSkillsText, "", renderedPiSkill) ===
      `role <available_skills>documentation example</available_skills>${renderedPiSkill}\nCurrent working directory: /project`,
    "conditional skill injection must not merge into unrelated available_skills text",
  );
  check(
    injectPiDocumentationSkill(mergedSkills, nextSkills, nextSkills) === mergedSkills,
    "conditional skill injection must be idempotent",
  );
  const mainPrompt = `${MAIN_PI_IDENTITY}\n\nAvailable tools:\n- read`;
  check(removeMainPiIdentity(mainPrompt) === "\n\nAvailable tools:\n- read", "main identity removal must preserve Available tools and later content");
  check(removeMainPiIdentity(`${MAIN_PI_IDENTITY}\n${MAIN_PI_IDENTITY}`).endsWith(MAIN_PI_IDENTITY), "main identity removal must affect only the first exact prefix");
  const middleMainIdentity = `prefix\n${MAIN_PI_IDENTITY}\nsuffix`;
  check(removeMainPiIdentity(middleMainIdentity) === middleMainIdentity, "main identity removal must not affect identity text in the middle");
  check(removeMainPiIdentity("no main identity") === "no main identity", "main identity removal must be unchanged without its exact anchor");
  const childTag = '<active_agent name="fixer"/>';
  const childPrompt = `${childTag}\n\n${CHILD_PI_IDENTITY_LINE}You have been invoked to work.`;
  check(removeChildPiIdentity(childPrompt) === `${childTag}\n\nYou have been invoked to work.`, "child identity removal must preserve the active_agent tag and invocation text");
  const repeatedChildIdentity = `${childTag}\n\n${CHILD_PI_IDENTITY_LINE}${CHILD_PI_IDENTITY_LINE}`;
  check(removeChildPiIdentity(repeatedChildIdentity).endsWith(CHILD_PI_IDENTITY_LINE), "child identity removal must affect only the first exact prefixed identity");
  const middleChildIdentity = `${childTag}\n\nrole instructions\n${CHILD_PI_IDENTITY_LINE}invocation`;
  check(removeChildPiIdentity(middleChildIdentity) === middleChildIdentity, "child identity removal must not affect identity text in the middle");
  check(removeChildPiIdentity(`${CHILD_PI_IDENTITY_LINE}no tag`) === `${CHILD_PI_IDENTITY_LINE}no tag`, "child identity removal must require the active_agent prompt prefix");
  check(removeChildPiIdentity("no child identity") === "no child identity", "child identity removal must be unchanged without its exact anchor");
  check(mainPrompt === `${MAIN_PI_IDENTITY}\n\nAvailable tools:\n- read`, "non-OAuth flow must retain identity by not invoking the trimming helper");
}

// Exercise the completed-steer compatibility logic with controllable live-session mocks.
const { cancelledResumeOutcome, resumeCompletedRecord } = await import(
  new URL("../extensions/oh-my-pi-slim/auto-resume.ts", import.meta.url)
);
const { AgentOperationClaims } = await import(
  new URL("../extensions/oh-my-pi-slim/operation-claims.ts", import.meta.url)
);
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const createResumeHarness = ({ status = "completed", result = "old output", prompt, isStreaming = false } = {}) => {
  const lifecycle = [];
  const messages = [{ role: "assistant", content: "old output", stopReason: "stop" }];
  let listener = () => {};
  let aborts = 0;
  let promptCalls = 0;
  let promptOptions;
  const session = {
    messages,
    isStreaming,
    abort() { aborts++; },
    subscribe(next) { listener = next; return () => { listener = () => {}; }; },
    async prompt(message, options) {
      promptCalls++;
      promptOptions = options;
      await (prompt ?? (async () => {
        const assistant = { role: "assistant", content: `new: ${message}`, stopReason: "stop" };
        listener({ type: "message_start", message: assistant });
        listener({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: assistant.content } });
        messages.push(assistant);
        listener({ type: "message_end", message: assistant });
      }))(message, options, { messages, emit: (event) => listener(event) });
    },
  };
  const record = {
    id: "agent-1",
    type: "fixer",
    description: "mock agent",
    isBackground: true,
    status,
    result,
    toolUses: 0,
    startedAt: 1,
    completedAt: 2,
    session,
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
    compactionCount: 0,
    resultConsumed: false,
  };
  return {
    record,
    session,
    registry: { getRecord: () => record },
    lifecycle: {
      emit(name, data) { lifecycle.push({ name, data }); },
      append(data) { lifecycle.push({ name: "subagents:record", data }); },
    },
    lifecycleEvents: lifecycle,
    get aborts() { return aborts; },
    get promptCalls() { return promptCalls; },
    get promptOptions() { return promptOptions; },
  };
};

{
  const harness = createResumeHarness();
  const outcome = await resumeCompletedRecord(
    harness.registry, "agent-1", "/literal command", "completed", harness.lifecycle,
  );
  check(outcome.status === "completed" && outcome.previousResult === "old output" && outcome.newResult === "new: /literal command", "auto-resume happy path must preserve old output and return the new assistant output");
  check(harness.promptOptions?.expandPromptTemplates === false, "auto-resume prompt must disable prompt template expansion");
  check(harness.record.resultConsumed === true, "auto-resume must leave inline results consumed");
  check(harness.record.promise instanceof Promise, "auto-resume must publish record.promise");
  check(await harness.record.promise === outcome.newResult, "settled record.promise must resolve to the new result");
  check(harness.lifecycleEvents.map((event) => event.name).join(",") === "subagents:started,subagents:completed,subagents:record", "successful auto-resume must emit and persist lifecycle events");
}

{
  const gate = deferred();
  const harness = createResumeHarness({
    prompt: async (_message, _options, context) => {
      await gate.promise;
      const assistant = { role: "assistant", content: "delayed", stopReason: "stop" };
      context.emit({ type: "message_start", message: assistant });
      context.emit({ type: "message_end", message: assistant });
    },
  });
  const running = resumeCompletedRecord(harness.registry, "agent-1", "continue", "completed", harness.lifecycle);
  await new Promise((resolve) => setTimeout(resolve, 0));
  check(harness.record.status === "running" && harness.record.promise instanceof Promise, "record.promise must be pending while the resumed turn runs");
  let settled = false;
  harness.record.promise.then(() => { settled = true; });
  await new Promise((resolve) => setTimeout(resolve, 0));
  check(!settled, "record.promise must not settle before the resumed prompt");
  gate.resolve();
  await running;
  await harness.record.promise;
  check(settled, "record.promise must settle with the resumed prompt");
}

{
  const runningRecord = createResumeHarness({ status: "running" });
  const outcome = await resumeCompletedRecord(runningRecord.registry, "agent-1", "continue", "completed", runningRecord.lifecycle);
  check(outcome.status === "error" && runningRecord.promptCalls === 0, "running records must remain a no-op and must not start an auto-resume prompt");
}

{
  const streamingRecord = createResumeHarness({ isStreaming: true });
  const outcome = await resumeCompletedRecord(streamingRecord.registry, "agent-1", "continue", "completed", streamingRecord.lifecycle);
  check(outcome.status === "error" && streamingRecord.promptCalls === 0, "terminal records with a streaming session must not start an auto-resume prompt");
}

{
  const harness = createResumeHarness();
  const controller = new AbortController();
  controller.abort();
  const outcome = await resumeCompletedRecord(harness.registry, "agent-1", "continue", "completed", harness.lifecycle, controller.signal);
  check(outcome.status === "aborted" && harness.promptCalls === 0, "already-aborted callers must not start an auto-resume prompt");
  check(harness.record.result === "old output" && harness.record.resultConsumed === true, "already-aborted auto-resume must preserve and consume the old result");
}

{
  const gate = deferred();
  const harness = createResumeHarness({
    prompt: async (_message, _options, context) => {
      await gate.promise;
      const assistant = { role: "assistant", content: "partial", stopReason: "aborted" };
      context.emit({ type: "message_start", message: assistant });
      context.emit({ type: "message_end", message: assistant });
    },
  });
  const controller = new AbortController();
  const running = resumeCompletedRecord(harness.registry, "agent-1", "continue", "completed", harness.lifecycle, controller.signal);
  await new Promise((resolve) => setTimeout(resolve, 0));
  controller.abort();
  gate.resolve();
  const outcome = await running;
  check(outcome.status === "aborted" && harness.aborts === 1 && harness.record.status === "aborted", "mid-prompt caller abort must abort the session and settle as aborted");
}

{
  const gate = deferred();
  const harness = createResumeHarness({ prompt: async () => { await gate.promise; } });
  const running = resumeCompletedRecord(harness.registry, "agent-1", "continue", "completed", harness.lifecycle);
  await new Promise((resolve) => setTimeout(resolve, 0));
  harness.record.status = "stopped";
  harness.record.abortController.abort();
  gate.resolve();
  const outcome = await running;
  check(outcome.status === "stopped" && harness.record.status === "stopped", "manager stop must not be overwritten when the resumed turn settles");
}

{
  const harness = createResumeHarness({ prompt: async () => {} });
  const outcome = await resumeCompletedRecord(harness.registry, "agent-1", "continue", "completed", harness.lifecycle);
  check(outcome.status === "error" && outcome.failure?.includes("no new assistant message"), "auto-resume without a message_end assistant must fail");
  check(harness.record.resultConsumed === true, "failed inline auto-resume must remain consumed");
}

{
  const harness = createResumeHarness({
    prompt: async (_message, _options, context) => {
      const assistant = { role: "assistant", content: "compaction-safe result", stopReason: "stop" };
      context.emit({ type: "message_start", message: assistant });
      context.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: assistant.content } });
      context.emit({ type: "message_end", message: assistant });
      harness.session.messages = [{ role: "assistant", content: "compacted history", stopReason: "stop" }];
    },
  });
  const outcome = await resumeCompletedRecord(harness.registry, "agent-1", "continue", "completed", harness.lifecycle);
  check(outcome.status === "completed" && outcome.newResult === "compaction-safe result", "auto-resume must use the subscribed final assistant when compaction replaces session.messages");
}

for (const stopReason of ["aborted", "error"]) {
  const harness = createResumeHarness({
    prompt: async (_message, _options, context) => {
      const partial = { role: "assistant", content: "earlier partial", stopReason: "stop" };
      context.emit({ type: "message_start", message: partial });
      context.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: partial.content } });
      context.emit({ type: "message_end", message: partial });
      const final = { role: "assistant", content: "", stopReason, errorMessage: stopReason === "error" ? "provider failed" : undefined };
      context.emit({ type: "message_start", message: final });
      context.emit({ type: "message_end", message: final });
    },
  });
  const outcome = await resumeCompletedRecord(harness.registry, "agent-1", "continue", "completed", harness.lifecycle);
  check(outcome.status === stopReason && outcome.newResult === "", `final empty ${stopReason} assistant must control status and must not reuse an earlier partial assistant`);
}

{
  const harness = createResumeHarness({
    prompt: async (_message, _options, context) => {
      const assistant = { role: "assistant", content: "", stopReason: "length" };
      context.emit({ type: "message_start", message: assistant });
      context.emit({ type: "message_end", message: assistant });
    },
  });
  const outcome = await resumeCompletedRecord(harness.registry, "agent-1", "continue", "completed", harness.lifecycle);
  check(outcome.status === "error" && outcome.failure?.includes("output token limit"), "final empty length assistant must fail rather than complete");
}

{
  const harness = createResumeHarness({
    prompt: async (_message, _options, context) => {
      const assistant = { role: "assistant", content: "provider partial", stopReason: "error", errorMessage: "provider failed" };
      context.emit({ type: "message_start", message: assistant });
      context.emit({ type: "message_end", message: assistant });
    },
  });
  const outcome = await resumeCompletedRecord(harness.registry, "agent-1", "continue", "completed", harness.lifecycle);
  check(outcome.status === "error" && outcome.failure === "provider failed" && outcome.newResult === "provider partial", "provider error turns must fail while preserving the final assistant's partial output");
}

{
  const claims = new AgentOperationClaims();
  check(claims.claimExplicitResume("agent-1", "agent-call").allowed, "first explicit Agent resume claim must be allowed");
  const steerSecond = claims.claimSteer("agent-1", "steer-call", "completed");
  check(!steerSecond.allowed && steerSecond.conflict?.kind === "explicit-resume", "Agent-first/steer-second must block the completed steer claim");
  const runningSteerSecond = claims.claimSteer("agent-1", "running-steer-call", "running");
  check(!runningSteerSecond.allowed && runningSteerSecond.conflict?.kind === "explicit-resume", "an in-flight explicit resume must also block a same-ID steer whose record is now running");
  claims.releaseToolCall("agent-call");
  check(claims.claimSteer("agent-1", "steer-call", "completed").allowed, "first completed steer claim must be allowed after cleanup");
  const agentSecond = claims.claimExplicitResume("agent-1", "agent-call-2");
  check(!agentSecond.allowed && agentSecond.conflict?.kind === "auto-steer", "steer-first/Agent-second must block the explicit resume claim");
  check(claims.claimExplicitResume("agent-2", "agent-call-2").allowed, "different agent IDs must be claimable concurrently");
  const runningSteer = claims.claimSteer("agent-3", "running-steer", "running");
  check(runningSteer.allowed && !runningSteer.claimed && !claims.get("agent-3"), "running steer must remain unclaimed");
  claims.releaseToolCall("steer-call");
  claims.releaseToolCall("agent-call-2");
  check(!claims.get("agent-1") && !claims.get("agent-2"), "toolCallId cleanup must release all associated claims");
}

{
  const harness = createResumeHarness();
  const outcome = cancelledResumeOutcome(harness.registry, "agent-1", "completed");
  check(outcome.status === "aborted" && harness.record.resultConsumed === true, "lock-wait cancellation must preserve the old inline result as consumed");
}

// Exercise Pi's TypeScript extension loader without invoking a model.
const loadExtension = spawnSync(
  "pi",
  ["-p", "--no-extensions", "--extension", extensionPath, "--no-session"],
  {
    cwd: ROOT,
    env: { ...process.env, PI_OFFLINE: "1", OMPS_SKIP_BOOTSTRAP: "1" },
    encoding: "utf8",
  },
);
check(
  loadExtension.status === 0,
  `Pi failed to load the orchestration extension: ${loadExtension.stderr || loadExtension.stdout}`,
);

// Exercise reversible installation in an isolated Pi agent directory.
const tempAgentDir = mkdtempSync(join(tmpdir(), "oh-my-pi-slim-validate-"));
try {
  const oldExplorer = join(tempAgentDir, "agents", "explorer.md");
  const oldPreset = join(tempAgentDir, "oh-my-pi-slim.json");
  const oldPiDocumentationSkill = join(
    tempAgentDir,
    "extensions",
    "oh-my-pi-slim",
    "skills",
    "pi-documentation",
    "SKILL.md",
  );
  const customPresetText = `${JSON.stringify({
    defaultPreset: "custom",
    presets: { custom: presetConfig.presets[presetConfig.defaultPreset] },
  }, null, 2)}\n`;
  mkdirSync(dirname(oldExplorer), { recursive: true });
  mkdirSync(dirname(oldPiDocumentationSkill), { recursive: true });
  writeFileSync(oldExplorer, "previous explorer\n", "utf8");
  writeFileSync(oldPreset, customPresetText, "utf8");
  writeFileSync(oldPiDocumentationSkill, "previous Pi documentation skill\n", "utf8");
  writeFileSync(
    join(tempAgentDir, "subagents.json"),
    `${JSON.stringify({ maxConcurrent: 9, disableDefaultAgents: false }, null, 2)}\n`,
    "utf8",
  );

  const install = spawnSync(process.execPath, [join(ROOT, "scripts", "install.mjs")], {
    cwd: ROOT,
    env: { ...process.env, PI_CODING_AGENT_DIR: tempAgentDir },
    encoding: "utf8",
  });
  check(install.status === 0, `isolated install failed: ${install.stderr || install.stdout}`);

  const installedSettings = JSON.parse(read(join(tempAgentDir, "subagents.json")));
  check(installedSettings.maxConcurrent === 9, "install must preserve unrelated subagents settings");
  check(installedSettings.disableDefaultAgents === true, "install must apply strict agent settings");
  check(read(oldPreset) === customPresetText, "install must preserve an existing global preset config");
  for (const role of AGENTS) {
    check(
      read(join(tempAgentDir, "agents", `${role}.md`)).includes("prompt_mode: replace"),
      `install missed ${role}`,
    );
  }
  check(
    read(join(tempAgentDir, "extensions", "oh-my-pi-slim", "prompt-context.ts")) === promptContext,
    "legacy install must copy the prompt-context helper",
  );
  check(
    read(oldPiDocumentationSkill) === piDocumentationSkill,
    "legacy install must copy the Pi documentation skill",
  );
  const loadLegacySkill = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { loadSkillsFromDir } from ${JSON.stringify(
        installedPiRoot
          ? pathToFileURL(join(installedPiRoot, "dist", "core", "skills.js")).href
          : "",
      )}; const result = loadSkillsFromDir({ dir: ${JSON.stringify(dirname(oldPiDocumentationSkill))}, source: "extension:oh-my-pi-slim" }); if (result.skills.length !== 1 || result.skills[0].name !== "pi-documentation" || result.diagnostics.length > 0) { console.error(JSON.stringify(result)); process.exit(1); }`,
    ],
    { cwd: ROOT, encoding: "utf8" },
  );
  check(
    loadLegacySkill.status === 0,
    `Pi failed to load the legacy copied private skill: ${loadLegacySkill.stderr || loadLegacySkill.stdout}`,
  );

  const uninstall = spawnSync(process.execPath, [join(ROOT, "scripts", "uninstall.mjs")], {
    cwd: ROOT,
    env: { ...process.env, PI_CODING_AGENT_DIR: tempAgentDir },
    encoding: "utf8",
  });
  check(uninstall.status === 0, `isolated uninstall failed: ${uninstall.stderr || uninstall.stdout}`);
  check(read(oldExplorer) === "previous explorer\n", "uninstall must restore an overwritten role file");
  check(read(oldPreset) === customPresetText, "uninstall must preserve an existing preset config");
  check(
    read(oldPiDocumentationSkill) === "previous Pi documentation skill\n",
    "uninstall must restore an overwritten Pi documentation skill",
  );

  const restoredSettings = JSON.parse(read(join(tempAgentDir, "subagents.json")));
  check(restoredSettings.maxConcurrent === 9, "uninstall must preserve unrelated settings");
  check(restoredSettings.disableDefaultAgents === false, "uninstall must restore prior settings values");
  check(
    !Object.prototype.hasOwnProperty.call(restoredSettings, "fallbackSubagent"),
    "uninstall must remove newly-added settings",
  );

  rmSync(oldPreset, { force: true });
  rmSync(oldPiDocumentationSkill, { force: true });
  const freshInstall = spawnSync(process.execPath, [join(ROOT, "scripts", "install.mjs")], {
    cwd: ROOT,
    env: { ...process.env, PI_CODING_AGENT_DIR: tempAgentDir },
    encoding: "utf8",
  });
  check(freshInstall.status === 0, `fresh preset install failed: ${freshInstall.stderr || freshInstall.stdout}`);
  check(
    read(oldPreset) === read(presetPath),
    "install must copy the default global preset when none exists",
  );

  const freshUninstall = spawnSync(process.execPath, [join(ROOT, "scripts", "uninstall.mjs")], {
    cwd: ROOT,
    env: { ...process.env, PI_CODING_AGENT_DIR: tempAgentDir },
    encoding: "utf8",
  });
  check(
    freshUninstall.status === 0,
    `fresh preset uninstall failed: ${freshUninstall.stderr || freshUninstall.stdout}`,
  );
  check(!existsSync(oldPreset), "uninstall must remove the default preset it created");
  check(
    !existsSync(oldPiDocumentationSkill),
    "uninstall must remove the Pi documentation skill it created",
  );
} finally {
  rmSync(tempAgentDir, { recursive: true, force: true });
}

if (errors.length > 0) {
  console.error(`Validation failed:\n- ${errors.join("\n- ")}`);
  process.exit(1);
}

console.log("Validation passed.");
