#!/usr/bin/env node

import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

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
  check(
    /\nexclude_extensions:\s*oh-my-pi-slim\b/.test(text),
    `${name}.md must exclude only the main-session orchestration extension`,
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
  orchestrator.includes("Background completions arrive automatically"),
  "orchestrator prompt must document automatic completion notifications",
);
check(orchestrator.includes("<orchestration-preset>"), "orchestrator must use the injected preset contract");

const extensionPath = join(ROOT, "extensions", "oh-my-pi-slim", "index.ts");
const bootstrapPath = join(ROOT, "extensions", "oh-my-pi-slim", "bootstrap.ts");
const extension = read(extensionPath);
const bootstrap = read(bootstrapPath);
for (const role of AGENTS) check(extension.includes(`\"${role}\"`), `extension allowlist missing ${role}`);
check(extension.includes('pi.registerFlag("omps-preset"'), "extension must register --omps-preset");
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
check(
  read(join(ROOT, "README.md")).includes("pi install npm:@juicesharp/rpiv-ask-user-question"),
  "README must tell users to install rpiv-ask-user-question explicitly",
);
check(
  !read(join(ROOT, "package.json")).includes("--install-ask-user"),
  "package scripts must not install rpiv-ask-user-question automatically",
);
check(extension.includes("CHILD_AGENT_TAG"), "extension must avoid injecting orchestrator into child sessions");
check(extension.includes("ensurePackageAssets(PACKAGE_ROOT)"), "package extension must bootstrap undeclarable agent assets");
check(bootstrap.includes("AGENT_NAMES"), "bootstrap must install the five agent definitions");
check(bootstrap.includes("removePackageAssets"), "bootstrap must support reversible package cleanup");

const packageJson = JSON.parse(read(join(ROOT, "package.json")));
check(packageJson.version === "0.3.0", "independent-package release must be version 0.3.0");
check(
  !packageJson.dependencies || Object.keys(packageJson.dependencies).length === 0,
  "oh-my-pi-slim must not install third-party Pi packages as dependencies",
);
check(
  JSON.stringify(packageJson.pi?.extensions) ===
    JSON.stringify(["./extensions/oh-my-pi-slim/index.ts"]),
  "Pi package must load only the oh-my-pi-slim extension",
);

const subagentsConfig = JSON.parse(read(join(ROOT, "config", "subagents.json")));
check(subagentsConfig.disableDefaultAgents === true, "config must disable default agents");
check(subagentsConfig.fallbackSubagent === "none", "config must disable fallback agents");
check(subagentsConfig.maxSubagentDepth === 1, "config must disable nested delegation at depth 1");

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
  const customPresetText = `${JSON.stringify({
    defaultPreset: "custom",
    presets: { custom: presetConfig.presets[presetConfig.defaultPreset] },
  }, null, 2)}\n`;
  mkdirSync(dirname(oldExplorer), { recursive: true });
  writeFileSync(oldExplorer, "previous explorer\n", "utf8");
  writeFileSync(oldPreset, customPresetText, "utf8");
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

  const uninstall = spawnSync(process.execPath, [join(ROOT, "scripts", "uninstall.mjs")], {
    cwd: ROOT,
    env: { ...process.env, PI_CODING_AGENT_DIR: tempAgentDir },
    encoding: "utf8",
  });
  check(uninstall.status === 0, `isolated uninstall failed: ${uninstall.stderr || uninstall.stdout}`);
  check(read(oldExplorer) === "previous explorer\n", "uninstall must restore an overwritten role file");
  check(read(oldPreset) === customPresetText, "uninstall must preserve an existing preset config");

  const restoredSettings = JSON.parse(read(join(tempAgentDir, "subagents.json")));
  check(restoredSettings.maxConcurrent === 9, "uninstall must preserve unrelated settings");
  check(restoredSettings.disableDefaultAgents === false, "uninstall must restore prior settings values");
  check(
    !Object.prototype.hasOwnProperty.call(restoredSettings, "fallbackSubagent"),
    "uninstall must remove newly-added settings",
  );

  rmSync(oldPreset, { force: true });
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
} finally {
  rmSync(tempAgentDir, { recursive: true, force: true });
}

if (errors.length > 0) {
  console.error(`Validation failed:\n- ${errors.join("\n- ")}`);
  process.exit(1);
}

console.log("Validation passed.");
