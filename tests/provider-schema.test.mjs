import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { registerHooks } from "node:module";
import { realpathSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const piEntry = realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim());
const piRoot = dirname(dirname(piEntry));
const moduleUrls = {
  codingAgent: pathToFileURL(`${piRoot}/dist/index.js`).href,
  piAi: pathToFileURL(`${piRoot}/node_modules/@earendil-works/pi-ai/dist/index.js`).href,
  piTui: pathToFileURL(`${piRoot}/node_modules/@earendil-works/pi-tui/dist/index.js`).href,
  typebox: pathToFileURL(`${piRoot}/node_modules/typebox/build/index.mjs`).href,
};
const localMap = {
  "./ask-runtime.js": new URL("../extensions/oh-my-pi-slim/ask-runtime.ts", import.meta.url).href,
  "./ask-transcript-renderer.js": new URL("../extensions/oh-my-pi-slim/ask-transcript-renderer.ts", import.meta.url).href,
  "./ask-tui.js": new URL("../extensions/oh-my-pi-slim/ask-tui.ts", import.meta.url).href,
  "./bootstrap.js": new URL("../extensions/oh-my-pi-slim/bootstrap.ts", import.meta.url).href,
  "./goal-runtime.js": new URL("../extensions/oh-my-pi-slim/goal-runtime.ts", import.meta.url).href,
  "./goal-transcript-renderer.js": new URL("../extensions/oh-my-pi-slim/goal-transcript-renderer.ts", import.meta.url).href,
  "./goal-widget.js": new URL("../extensions/oh-my-pi-slim/goal-widget.ts", import.meta.url).href,
  "./loop-runtime.js": new URL("../extensions/oh-my-pi-slim/loop-runtime.ts", import.meta.url).href,
  "./monitor-runtime.js": new URL("../extensions/oh-my-pi-slim/monitor-runtime.ts", import.meta.url).href,
  "./monitor-transcript-renderer.js": new URL("../extensions/oh-my-pi-slim/monitor-transcript-renderer.ts", import.meta.url).href,
  "./monitor-widget.js": new URL("../extensions/oh-my-pi-slim/monitor-widget.ts", import.meta.url).href,
  "./loop-transcript-renderer.js": new URL("../extensions/oh-my-pi-slim/loop-transcript-renderer.ts", import.meta.url).href,
  "./loop-widget.js": new URL("../extensions/oh-my-pi-slim/loop-widget.ts", import.meta.url).href,
  "./prompt-context.js": new URL("../extensions/oh-my-pi-slim/prompt-context.ts", import.meta.url).href,
  "./subagent-checkpoint.js": new URL("../extensions/oh-my-pi-slim/subagent-checkpoint.ts", import.meta.url).href,
  "./subagent-core.js": new URL("../extensions/oh-my-pi-slim/subagent-core.ts", import.meta.url).href,
  "./subagent-model-display.js": new URL("../extensions/oh-my-pi-slim/subagent-model-display.ts", import.meta.url).href,
  "./subagent-run-files.js": new URL("../extensions/oh-my-pi-slim/subagent-run-files.ts", import.meta.url).href,
  "./subagent-transcript-renderer.js": new URL("../extensions/oh-my-pi-slim/subagent-transcript-renderer.ts", import.meta.url).href,
  "./subagent-widget.js": new URL("../extensions/oh-my-pi-slim/subagent-widget.ts", import.meta.url).href,
  "./subagent-widget-renderer.js": new URL("../extensions/oh-my-pi-slim/subagent-widget-renderer.ts", import.meta.url).href,
  "./subagent-widget-display.js": new URL("../extensions/oh-my-pi-slim/subagent-widget-display.ts", import.meta.url).href,
  "./subagent-widget-glyphs.js": new URL("../extensions/oh-my-pi-slim/subagent-widget-glyphs.ts", import.meta.url).href,
  "./semantic-glyph.js": new URL("../extensions/oh-my-pi-slim/semantic-glyph.ts", import.meta.url).href,
  "../oh-my-pi-slim/semantic-glyph.js": new URL("../extensions/oh-my-pi-slim/semantic-glyph.ts", import.meta.url).href,
  "./widget.js": new URL("../extensions/todo/widget.ts", import.meta.url).href,
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@earendil-works/pi-coding-agent") return { url: moduleUrls.codingAgent, shortCircuit: true };
    if (specifier === "@earendil-works/pi-ai") return { url: moduleUrls.piAi, shortCircuit: true };
    if (specifier === "@earendil-works/pi-tui") return { url: moduleUrls.piTui, shortCircuit: true };
    if (specifier === "typebox") return { url: moduleUrls.typebox, shortCircuit: true };
    if (specifier === "./core.js" && context.parentURL?.includes("/extensions/todo/")) {
      return { url: new URL("../extensions/todo/core.ts", import.meta.url).href, shortCircuit: true };
    }
    const url = localMap[specifier];
    return url ? { url, shortCircuit: true } : nextResolve(specifier, context);
  },
});

const { askUserQuestionParameters } = await import("../extensions/oh-my-pi-slim/ask-runtime.ts");
const { goalParameters } = await import("../extensions/oh-my-pi-slim/goal-runtime.ts");
const { loopParameters } = await import("../extensions/oh-my-pi-slim/loop-runtime.ts");
const { monitorParameters } = await import("../extensions/oh-my-pi-slim/monitor-runtime.ts");
const { subagentParameters } = await import("../extensions/oh-my-pi-slim/subagent-runtime.ts");
const { contactSupervisorParameters } = await import("../extensions/oh-my-pi-slim/child-supervisor.ts");
const { todoParameters } = await import("../extensions/todo/index.ts");

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
    loop: providerJson(loopParameters),
    monitor: providerJson(monitorParameters),
    todo: providerJson(todoParameters),
  };
  assert.deepEqual(Object.keys(schemas).sort(), ["ask_user_question", "contact_supervisor", "goal", "loop", "monitor", "subagent", "todo"]);
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
  assert.equal(remove.properties.target.description, "Use the exact subject to delete.");
  const clear = operationBranches.find((branch) => branch.properties.op.const === "clear");
  assert.equal(clear.description, "Apply clear at most once in an update.");
  assert.equal(schemas.todo.properties.action.description, "Select list to read state or update to apply operations.");
  assert.equal(schemas.todo.properties.operations.description, "For update, provide operations in execution order. Omit this field for list.");

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
    questions: "Provide questions in display order.",
    question: "Write one user decision question.",
    header: "Write a short question header.",
    options: "Provide authored choices in display order.",
    label: "Write a short option label. Mark a recommendation by placing it first and appending (Recommended). Do not use Other, Type something., or Next.",
    optionDescription: "Describe the outcome of choosing this option.",
    preview: "Add preview content only for a single-select question.",
    multiSelect: "Set true only when multiple authored options may be selected. Omit option previews when true.",
  });

  assert.equal(schemas.goal.properties.action.description, "Select the Goal action. Create and modify use abstract, objective, and criteria. Pause and cancel use reason. Complete uses evidence. Status and resume use no other fields.");
  assert.equal(schemas.loop.properties.action.description, "Select the loop action. Create uses interval, abstract, and prompt. Modify uses id and at least one changed field. Delete, pause, and resume use id. List uses no other fields.");
  assert.equal(schemas.loop.properties.interval.description, "For create or modify, provide one interval from 10s through 7d. Use one integer with `s`, `m`, `h`, or `d`.");
  assert.equal(schemas.monitor.properties.action.description, "Select the monitor action. Create uses abstract, command, optional cwd, and optional notifyOn. Delete uses id. Status uses id and optional start and end. List uses no other fields.");
  assert.equal(schemas.monitor.properties.command.description, "Provide one foreground Bash command. Do not use nohup, setsid, disown, a trailing ampersand, or another daemon escape.");
  assert.equal(schemas.monitor.properties.end.description, "For status, read through this reverse log offset. Set `start` to the prior `end` for older lines.");
  assert.equal(schemas.subagent.properties.action.description, "Select the subagent action. Create uses agent, abstract, task, and optional cwd. Steer and reply use id and message. Resume uses id, abstract, and message. Interrupt uses id. List and clear use no other fields.");
  assert.equal(schemas.subagent.properties.message.description, "For steer, provide an actual instruction. For resume, provide the complete continuation objective. For reply, answer the complete waiting request.");

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
    reason: "Select the supervisor request type.",
    message: "Provide the complete request context for the orchestrator.",
    interview: "Provide structured interview details.",
    questions: "Provide the structured interview questions.",
    title: "Provide a short interview title.",
    id: "Provide a short question identifier.",
    prompt: "Provide the question text.",
    options: "Provide the answer options.",
  });
});
