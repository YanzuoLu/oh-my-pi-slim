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
check(extension.includes("ensurePackageAssets(PACKAGE_ROOT)"), "package extension must bootstrap undeclarable agent assets");
check(bootstrap.includes("AGENT_NAMES"), "bootstrap must install the five agent definitions");
check(bootstrap.includes("removePackageAssets"), "bootstrap must support reversible package cleanup");

const readme = read(join(ROOT, "README.md"));
check(!readme.includes("non-blocking `tool_result`"), "README must not describe waited auto-resume as non-blocking");
check(
  readme.includes("validated against pi-subagents 0.15.0/current cross-package registry shape") &&
    readme.includes("about 10 minutes") &&
    readme.includes("session replacement/switch") &&
    readme.includes("not a stable public resume API"),
  "README must document the validated compatibility range and live-session cleanup limits",
);

const packageJson = JSON.parse(read(join(ROOT, "package.json")));
check(packageJson.version === "0.4.0", "independent-package release must be version 0.4.0");
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
