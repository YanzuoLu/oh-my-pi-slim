#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (path) => readFileSync(join(ROOT, path), "utf8");
const check = (condition, message) => {
  if (!condition) throw new Error(message);
};

const packageJson = JSON.parse(read("package.json"));
check(
  JSON.stringify(packageJson.pi?.extensions) === JSON.stringify(["./extensions/oh-my-pi-slim/index.ts"]),
  "package must expose exactly one OMPS extension",
);
check(packageJson.pi?.skills === undefined, "package must not register built-in skills");

for (const path of [
  "agents/designer.md",
  "agents/explorer.md",
  "agents/fixer.md",
  "agents/librarian.md",
  "agents/observer.md",
  "agents/oracle.md",
  "config/oh-my-pi-slim.example.json",
  "extensions/todo/index.ts",
  "extensions/todo/core.ts",
  "extensions/todo/widget.ts",
  "extensions/oh-my-pi-slim/bootstrap.ts",
  "extensions/oh-my-pi-slim/loop-runtime.ts",
  "extensions/oh-my-pi-slim/loop-transcript-renderer.ts",
  "extensions/oh-my-pi-slim/loop-widget.ts",
  "extensions/oh-my-pi-slim/prompt-context.ts",
  "extensions/oh-my-pi-slim/skills/pi-documentation/SKILL.md",
]) check(!existsSync(join(ROOT, path)), `${path} must not exist`);

for (const path of [
  "extensions/oh-my-pi-slim/orchestrator.md",
  "extensions/oh-my-pi-slim/todo/core.ts",
  "extensions/oh-my-pi-slim/todo/runtime.ts",
  "extensions/oh-my-pi-slim/todo/widget.ts",
]) check(existsSync(join(ROOT, path)), `${path} is missing`);

const productionFiles = readdirSync(join(ROOT, "extensions", "oh-my-pi-slim"), { recursive: true })
  .filter((path) => /\.(?:ts|mjs)$/.test(path));
check(JSON.stringify(productionFiles.filter((path) => !path.includes("/")).sort()) === JSON.stringify([
  "cache-retention.ts",
  "fast-mode.ts",
  "index.ts",
  "semantic-glyph.ts",
  "tool-contracts.ts",
  "widget-expansion.ts",
  "widget-stack-host.ts",
  "widget-stack.ts",
]), "OMPS root modules must stay limited to shared infrastructure");
const production = productionFiles.map((path) => read(`extensions/oh-my-pi-slim/${path}`)).join("\n");
for (const forbidden of [
  "promptSnippet",
  "promptGuidelines",
  "--system-prompt",
  "defaultPreset",
  "OMPS_PRESET",
  "setThinkingLevel(",
  "setModel(",
]) check(!production.includes(forbidden), `production code must not contain ${forbidden}`);

const index = read("extensions/oh-my-pi-slim/index.ts");
check(index.includes('import { registerTodoRuntime } from "./todo/runtime.js"'), "main extension must import Todo");
check(index.includes('readFileSync(new URL("./orchestrator.md", import.meta.url), "utf8")'), "main extension must load the orchestrator prompt");
check(index.includes('pi.on("before_agent_start", (event) => ({'), "main extension must append the orchestrator prompt before each agent run");
check(index.includes('systemPrompt: `${event.systemPrompt}\\n\\n${ORCHESTRATOR_PROMPT}`'), "main extension must preserve and extend the chained system prompt");
check(
  index.indexOf("registerTodoRuntime(pi)") > index.indexOf('process.env.PI_SUBAGENT_CHILD === "1"'),
  "main extension must register Todo after the child-only return",
);
check(index.includes('`· OMPS Version: v${PACKAGE_VERSION}${mode}`'), "OMPS status must expose the separated package version and current provider mode");
check(index.includes('readFileSync(new URL("../../package.json", import.meta.url), "utf8")'), "OMPS reload must read the current package version without the require cache");
check(!index.includes("createRequire"), "OMPS package version must not remain cached across reloads");
check(!index.includes('"oh-my-pi-slim:fast"'), "Fast Mode must share the OMPS status line");

const fastMode = read("extensions/oh-my-pi-slim/fast-mode.ts");
check(fastMode.includes('service_tier: "priority"'), "Fast Mode must request the priority service tier");

const contracts = read("extensions/oh-my-pi-slim/tool-contracts.ts");
for (const [symbol, name] of [
  ["ASK_TOOL_NAME", "ask_user_question"],
  ["CONTACT_SUPERVISOR_TOOL_NAME", "contact_supervisor"],
  ["GOAL_TOOL_NAME", "goal"],
  ["MONITOR_TOOL_NAME", "monitor"],
  ["SUBAGENT_TOOL_NAME", "subagent"],
  ["TODO_TOOL_NAME", "todo"],
]) check(contracts.includes(`const ${symbol} = "${name}"`), `tool contract is missing ${name}`);
check((contracts.match(/export const \w+ResultSchema =/g) ?? []).length === 6, "every tool must define one model-visible result schema");
for (const path of productionFiles.filter((path) => path !== "tool-contracts.ts")) {
  check(!read(`extensions/oh-my-pi-slim/${path}`).includes('from "typebox"'), `${path} must source model schemas from tool-contracts.ts`);
}
for (const [path, symbol] of [
  ["ask/runtime.ts", "ASK_TOOL_CONTRACT"],
  ["goal/runtime.ts", "GOAL_TOOL_CONTRACT"],
  ["monitor/runtime.ts", "MONITOR_TOOL_CONTRACT"],
  ["subagent/runtime.ts", "SUBAGENT_TOOL_CONTRACT"],
  ["subagent/child-supervisor.ts", "CONTACT_SUPERVISOR_TOOL_CONTRACT"],
  ["todo/runtime.ts", "TODO_TOOL_CONTRACT"],
]) check(read(`extensions/oh-my-pi-slim/${path}`).includes(symbol), `${path} must use ${symbol}`);
for (const [path, symbols] of [
  ["ask/runtime.ts", ["askModelResult"]],
  ["goal/runtime.ts", ["goalModelResult"]],
  ["monitor/runtime.ts", ["monitorStatusModelResult", "monitorStopModelResult"]],
  ["subagent/runtime.ts", ["subagentRunModelResult", "subagentActionModelResult"]],
  ["subagent/child-supervisor.ts", ["contactSupervisorModelResult"]],
  ["todo/runtime.ts", ["todoListContent", "todoUpdateContent"]],
]) {
  const source = read(`extensions/oh-my-pi-slim/${path}`);
  for (const symbol of symbols) check(source.includes(symbol), `${path} must use model-facing result builder ${symbol}`);
}

const subagents = read("extensions/oh-my-pi-slim/subagent/runtime.ts");
check(subagents.includes("model.provider") && subagents.includes("model.id") && subagents.includes("thinkingLevel"), "subagents must inherit the parent model and thinking level");
for (const removed of ["SpecialistName", "AgentDefinition", "deniedTools", "modelResolver", "denyResolver"]) {
  check(!subagents.includes(removed), `subagent runtime must not contain ${removed}`);
}

console.log(`Validated ${productionFiles.length} production modules.`);
