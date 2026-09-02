import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { beforeEach } from "node:test";
import { piRoot } from "./fixtures/pi-install.mjs";
const moduleUrls = {
  codingAgent: pathToFileURL(`${piRoot}/dist/index.js`).href,
  piAi: pathToFileURL(`${piRoot}/node_modules/@earendil-works/pi-ai/dist/index.js`).href,
  piTui: pathToFileURL(`${piRoot}/node_modules/@earendil-works/pi-tui/dist/index.js`).href,
  typebox: pathToFileURL(`${piRoot}/node_modules/typebox/build/index.mjs`).href,
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@earendil-works/pi-coding-agent") return { url: moduleUrls.codingAgent, shortCircuit: true };
    if (specifier === "@earendil-works/pi-ai") return { url: moduleUrls.piAi, shortCircuit: true };
    if (specifier === "@earendil-works/pi-tui") return { url: moduleUrls.piTui, shortCircuit: true };
    if (specifier === "typebox") return { url: moduleUrls.typebox, shortCircuit: true };
    if (specifier.startsWith(".") && specifier.endsWith(".js") && context.parentURL) {
      const candidate = new URL(`${specifier.slice(0, -3)}.ts`, context.parentURL);
      if (existsSync(fileURLToPath(candidate))) return { url: candidate.href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const {
  ASK_TOOL_CONTRACT,
  ASK_TOOL_DESCRIPTIONS,
  askResultSchema,
  CONTACT_SUPERVISOR_TOOL_CONTRACT,
  CONTACT_SUPERVISOR_TOOL_DESCRIPTIONS,
  contactSupervisorResultSchema,
  GOAL_ACTIONS,
  GOAL_PUBLIC_FIELDS,
  GOAL_TOOL_CONTRACT,
  GOAL_TOOL_DESCRIPTIONS,
  goalResultSchema,
  MONITOR_ACTIONS,
  MONITOR_PUBLIC_FIELDS,
  MONITOR_TOOL_CONTRACT,
  MONITOR_TOOL_DESCRIPTIONS,
  monitorResultSchema,
  SUBAGENT_ACTIONS,
  SUBAGENT_PUBLIC_FIELDS,
  SUBAGENT_TOOL_CONTRACT,
  SUBAGENT_TOOL_DESCRIPTIONS,
  subagentResultSchema,
  TODO_TOOL_CONTRACT,
  TODO_TOOL_DESCRIPTIONS,
  todoResultSchema,
  TODO_ACTIONS,
  TODO_PUBLIC_FIELDS,
  askUserQuestionParameters,
  contactSupervisorParameters,
  goalParameters,
  monitorParameters,
  subagentParameters,
  todoParameters,
} = await import("../extensions/oh-my-pi-slim/tool-contracts.ts");
const { resetWidgetStackHost } = await import("../extensions/oh-my-pi-slim/widget-stack-host.ts");

// The aggregate widget host is a process-wide singleton, so every test starts from an empty one.
beforeEach(() => resetWidgetStackHost());

function providerJson(schema) {
  return JSON.parse(JSON.stringify(schema));
}

function assertPortableObjectRoot(name, schema) {
  assert.equal(schema.type, "object", `${name} root must declare type object`);
  assert.equal(schema.additionalProperties, false, `${name} root must reject unknown fields`);
  assert.ok(schema.properties && typeof schema.properties === "object", `${name} root must expose properties`);
  assert.notEqual(Object.keys(schema).length, 1, `${name} root must not contain only a union keyword`);
  assert.equal(schema.anyOf, undefined, `${name} root must not use anyOf`);
  assert.equal(schema.oneOf, undefined, `${name} root must not use oneOf`);
}

test("all production model-tool schemas survive the Kimi strict-provider portability smoke", () => {
  const schemas = {
    ask_user_question: providerJson(askUserQuestionParameters),
    goal: providerJson(goalParameters),
    subagent: providerJson(subagentParameters),
    contact_supervisor: providerJson(contactSupervisorParameters),
    monitor: providerJson(monitorParameters),
    todo: providerJson(todoParameters),
  };
  assert.deepEqual(Object.keys(schemas).sort(), ["ask_user_question", "contact_supervisor", "goal", "monitor", "subagent", "todo"]);
  for (const [name, schema] of Object.entries(schemas)) assertPortableObjectRoot(name, schema);

  const operationBranches = schemas.todo.properties.operations.items.anyOf;
  assert.equal(operationBranches.length, 4);
  assert.deepEqual(operationBranches.map((branch) => branch.properties.op.const).sort(), ["append", "clear", "delete", "modify"]);
  for (const branch of operationBranches) {
    assert.equal(branch.type, "object");
    assert.equal(branch.additionalProperties, false);
  }
  const modify = operationBranches.find((branch) => branch.properties.op.const === "modify");
  assert.equal(modify.minProperties, undefined, "provider schema must rely on Todo runtime mutable-field validation");
  const remove = operationBranches.find((branch) => branch.properties.op.const === "delete");
  assert.deepEqual(Object.keys(remove.properties).sort(), ["op", "target"]);
  assert.deepEqual(remove.required.slice().sort(), ["op", "target"]);
  assert.equal(remove.anyOf, undefined, "delete branch must not use a nested union");
  assert.equal(remove.oneOf, undefined, "delete branch must not use a nested union");
  assert.equal(remove.properties.target.description, TODO_TOOL_DESCRIPTIONS.input.operations.items.delete.target);
  const clear = operationBranches.find((branch) => branch.properties.op.const === "clear");
  assert.equal(clear.description, TODO_TOOL_DESCRIPTIONS.input.operations.items.clear.description);
  assert.deepEqual(Object.fromEntries(operationBranches.map((branch) => [
    branch.properties.op.const, branch.properties.op.description,
  ])), {
    append: TODO_TOOL_DESCRIPTIONS.input.operations.items.append.op,
    modify: TODO_TOOL_DESCRIPTIONS.input.operations.items.modify.op,
    delete: TODO_TOOL_DESCRIPTIONS.input.operations.items.delete.op,
    clear: TODO_TOOL_DESCRIPTIONS.input.operations.items.clear.op,
  });
  assert.equal(schemas.todo.properties.action.description, TODO_TOOL_DESCRIPTIONS.input.action);
  assert.equal(schemas.todo.properties.operations.description, TODO_TOOL_DESCRIPTIONS.input.operations.description);
  assert.deepEqual(schemas.todo.required, ["action"]);
  assert.equal("confirmed" in schemas.todo.properties, false);
  assert.equal("force" in schemas.todo.properties, false);

  const ask = schemas.ask_user_question.properties.questions;
  assert.deepEqual({
    questions: ask.description,
    question: ask.items.properties.question.description,
    header: ask.items.properties.header.description,
    options: ask.items.properties.options.description,
    label: ask.items.properties.options.items.properties.label.description,
    optionDescription: ask.items.properties.options.items.properties.description.description,
    preview: ask.items.properties.options.items.properties.preview.description,
    multiSelect: ask.items.properties.multiSelect.description,
  }, {
    questions: ASK_TOOL_DESCRIPTIONS.input.questions.description,
    question: ASK_TOOL_DESCRIPTIONS.input.questions.items.question,
    header: ASK_TOOL_DESCRIPTIONS.input.questions.items.header,
    options: ASK_TOOL_DESCRIPTIONS.input.questions.items.options.description,
    label: ASK_TOOL_DESCRIPTIONS.input.questions.items.options.items.label,
    optionDescription: ASK_TOOL_DESCRIPTIONS.input.questions.items.options.items.description,
    preview: ASK_TOOL_DESCRIPTIONS.input.questions.items.options.items.preview,
    multiSelect: ASK_TOOL_DESCRIPTIONS.input.questions.items.multiSelect,
  });

  const actionContracts = [
    ["goal", GOAL_ACTIONS, GOAL_PUBLIC_FIELDS],
    ["monitor", MONITOR_ACTIONS, MONITOR_PUBLIC_FIELDS],
    ["subagent", SUBAGENT_ACTIONS, SUBAGENT_PUBLIC_FIELDS],
    ["todo", TODO_ACTIONS, TODO_PUBLIC_FIELDS],
  ];
  for (const [name, actions, fields] of actionContracts) {
    assert.deepEqual(schemas[name].properties.action.anyOf.map(({ const: action }) => action), [...actions]);
    assert.deepEqual(Object.keys(schemas[name].properties).sort(), [...fields].sort());
    assert.deepEqual(schemas[name].required, ["action"], `${name} root requires only action, so clear never requires id`);
    assert.match(schemas[name].properties.action.description, /^Action to perform\./);
    assert.equal("confirmed" in schemas[name].properties, false);
    assert.equal("force" in schemas[name].properties, false);
    assert.equal(Object.keys(schemas[name].properties)[0], "action", `${name} must put action first`);
  }

  assert.equal(schemas.goal.properties.action.description, GOAL_TOOL_DESCRIPTIONS.input.action);
  assert.equal(schemas.monitor.properties.action.description, MONITOR_TOOL_DESCRIPTIONS.input.action);
  assert.equal(schemas.monitor.properties.command.description, MONITOR_TOOL_DESCRIPTIONS.input.command);
  assert.equal(schemas.monitor.properties.id.description, MONITOR_TOOL_DESCRIPTIONS.input.id);
  assert.equal(schemas.subagent.properties.action.description, SUBAGENT_TOOL_DESCRIPTIONS.input.action);
  assert.equal(schemas.subagent.properties.cwd.description, SUBAGENT_TOOL_DESCRIPTIONS.input.cwd);
  assert.equal(schemas.subagent.properties.cwd.type, "string");
  assert.equal(schemas.subagent.required.includes("cwd"), false, "cwd stays optional for create and resume");
  assert.equal(schemas.subagent.properties.id.description, SUBAGENT_TOOL_DESCRIPTIONS.input.id);
  assert.equal(schemas.subagent.properties.message.description, SUBAGENT_TOOL_DESCRIPTIONS.input.message);

  const contact = schemas.contact_supervisor.properties;
  assert.deepEqual({
    reason: contact.reason.description,
    message: contact.message.description,
    interview: contact.interview.description,
    questions: contact.interview.properties.questions.description,
    title: contact.interview.properties.title.description,
    id: contact.interview.properties.questions.items.properties.id.description,
    prompt: contact.interview.properties.questions.items.properties.prompt.description,
    options: contact.interview.properties.questions.items.properties.options.description,
  }, {
    reason: CONTACT_SUPERVISOR_TOOL_DESCRIPTIONS.input.reason,
    message: CONTACT_SUPERVISOR_TOOL_DESCRIPTIONS.input.message,
    interview: CONTACT_SUPERVISOR_TOOL_DESCRIPTIONS.input.interview.description,
    questions: CONTACT_SUPERVISOR_TOOL_DESCRIPTIONS.input.interview.questions.description,
    title: CONTACT_SUPERVISOR_TOOL_DESCRIPTIONS.input.interview.title,
    id: CONTACT_SUPERVISOR_TOOL_DESCRIPTIONS.input.interview.questions.items.id,
    prompt: CONTACT_SUPERVISOR_TOOL_DESCRIPTIONS.input.interview.questions.items.prompt,
    options: CONTACT_SUPERVISOR_TOOL_DESCRIPTIONS.input.interview.questions.items.options,
  });
});

test("all model-visible tool contracts and result shapes are defined centrally", () => {
  const contracts = [
    ASK_TOOL_CONTRACT,
    GOAL_TOOL_CONTRACT,
    MONITOR_TOOL_CONTRACT,
    SUBAGENT_TOOL_CONTRACT,
    CONTACT_SUPERVISOR_TOOL_CONTRACT,
    TODO_TOOL_CONTRACT,
  ];
  assert.deepEqual(contracts.map(({ name }) => name).sort(), [
    "ask_user_question",
    "contact_supervisor",
    "goal",
    "monitor",
    "subagent",
    "todo",
  ]);
  for (const contract of contracts) {
    assert.equal(contract.parameters.type, "object");
    assert.equal(typeof contract.description, "string");
    assert.ok(contract.description.length > 0);
  }
  for (const schema of [
    askResultSchema,
    goalResultSchema,
    monitorResultSchema,
    subagentResultSchema,
    contactSupervisorResultSchema,
    todoResultSchema,
  ]) assert.ok(schema);
  assert.match(ASK_TOOL_CONTRACT.description, /\n\n## Rules\n\n/);
  for (const contract of [GOAL_TOOL_CONTRACT, MONITOR_TOOL_CONTRACT, SUBAGENT_TOOL_CONTRACT, TODO_TOOL_CONTRACT]) {
    assert.match(contract.description, /\n\n## Actions\n\n/);
  }
  assert.doesNotMatch(CONTACT_SUPERVISOR_TOOL_CONTRACT.description, /## Actions/);
});
