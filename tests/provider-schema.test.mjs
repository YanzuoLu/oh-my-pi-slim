import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { registerHooks } from "node:module";
import { realpathSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import test, { beforeEach } from "node:test";

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
  "./subagent-viewer-data.js": new URL("../extensions/oh-my-pi-slim/subagent-viewer-data.ts", import.meta.url).href,
  "./subagent-viewer-transcript.js": new URL("../extensions/oh-my-pi-slim/subagent-viewer-transcript.ts", import.meta.url).href,
  "./subagent-widget.js": new URL("../extensions/oh-my-pi-slim/subagent-widget.ts", import.meta.url).href,
  "./subagent-widget-renderer.js": new URL("../extensions/oh-my-pi-slim/subagent-widget-renderer.ts", import.meta.url).href,
  "./subagent-widget-display.js": new URL("../extensions/oh-my-pi-slim/subagent-widget-display.ts", import.meta.url).href,
  "./subagent-widget-glyphs.js": new URL("../extensions/oh-my-pi-slim/subagent-widget-glyphs.ts", import.meta.url).href,
  "./semantic-glyph.js": new URL("../extensions/oh-my-pi-slim/semantic-glyph.ts", import.meta.url).href,
  "./widget-expansion.js": new URL("../extensions/oh-my-pi-slim/widget-expansion.ts", import.meta.url).href,
  "./widget-stack.js": new URL("../extensions/oh-my-pi-slim/widget-stack.ts", import.meta.url).href,
  "./widget-stack-host.js": new URL("../extensions/oh-my-pi-slim/widget-stack-host.ts", import.meta.url).href,
  "../oh-my-pi-slim/semantic-glyph.js": new URL("../extensions/oh-my-pi-slim/semantic-glyph.ts", import.meta.url).href,
  "../oh-my-pi-slim/widget-expansion.js": new URL("../extensions/oh-my-pi-slim/widget-expansion.ts", import.meta.url).href,
  "../oh-my-pi-slim/widget-stack.js": new URL("../extensions/oh-my-pi-slim/widget-stack.ts", import.meta.url).href,
  "../oh-my-pi-slim/widget-stack-host.js": new URL("../extensions/oh-my-pi-slim/widget-stack-host.ts", import.meta.url).href,
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
  assert.equal(remove.properties.target.description, "Exact subject to delete.");
  const clear = operationBranches.find((branch) => branch.properties.op.const === "clear");
  assert.equal(clear.description, "Use clear at most once after every current item is completed.");
  assert.deepEqual(Object.fromEntries(operationBranches.map((branch) => [
    branch.properties.op.const, branch.properties.op.description,
  ])), {
    append: "append requires subject and abstract, with optional blockedBy.",
    modify: "modify requires target and at least one changed field.",
    delete: "delete requires target.",
    clear: "clear accepts no other fields.",
  });
  assert.equal(schemas.todo.properties.action.description, "Choose list or update. list accepts no operations. update requires one or more ordered operations.");
  assert.equal(schemas.todo.properties.operations.description, "Ordered append, modify, delete, or clear operations for update. Omit for list.");

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
    questions: "One to four questions in display order.",
    question: "Decision question shown to the user.",
    header: "Short header up to 16 characters.",
    options: "Two to four authored options in display order.",
    label: "Unique option label up to 60 characters. Place the recommended option first and append (Recommended). Reserved labels are Other, Type something., and Next.",
    optionDescription: "Explain the outcome of choosing this option.",
    preview: "Optional preview for single-select only.",
    multiSelect: "True enables multiple authored selections. Omit or use false for single-select. Multi-select options cannot include previews.",
  });

  assert.equal(schemas.goal.properties.action.description, "Choose an action. create and modify require abstract, objective, and criteria. pause and cancel require reason. complete requires evidence. clear removes a completed or cancelled Goal from the branch. status, resume, and clear accept no other fields.");
  assert.equal(schemas.loop.properties.action.description, "Choose an action. create requires interval, abstract, and prompt. modify requires id and at least one changed field. delete, pause, and resume require id. list accepts no other fields.");
  assert.equal(schemas.loop.properties.interval.description, "Fixed delay for create or modify, from 10s through 7d. Format: one positive integer plus s, m, h, or d.");
  assert.equal(schemas.monitor.properties.action.description, "Choose an action. create requires abstract, command, and checkAfter, with optional cwd and notifyOn. delete requires id. status requires id, with optional start and end. list accepts no other fields.");
  assert.equal(schemas.monitor.properties.command.description, "Foreground Bash command for create. Do not use nohup, setsid, disown, trailing &, or another detach escape.");
  assert.equal(schemas.monitor.properties.checkAfter.description, "Required silence threshold for create, from 10s through 7d. A reminder arrives whenever the command stays silent that long. Format: one positive integer plus s, m, h, or d.");
  assert.equal(schemas.monitor.properties.checkAfter.type, "string");
  assert.equal(schemas.monitor.required?.includes("checkAfter") ?? false, false, "checkAfter stays optional in the shared action schema and is enforced by the Monitor runtime");
  assert.equal(schemas.monitor.properties.end.description, "Reverse log offset ending the status window. Defaults to 100 and must exceed start by at most 2000.");
  assert.deepEqual(schemas.subagent.properties.action.anyOf.map(({ const: action }) => action), [
    "create", "list", "status", "interrupt", "steer", "resume", "reply", "clear",
  ]);
  assert.equal(schemas.subagent.properties.action.description, "Choose create, list, status, interrupt, steer, resume, reply, or clear. create requires agent, abstract, and task, with optional cwd. status and interrupt require id. steer and reply require id and message. resume requires id, abstract, and message, with optional cwd. list and clear accept no other fields.");
  assert.equal(schemas.subagent.properties.cwd.description, "Working directory for create or resume. Relative paths resolve against the parent working directory. Create defaults to the parent working directory. Resume defaults to the source run's working directory.");
  assert.equal(schemas.subagent.properties.cwd.type, "string");
  assert.equal(schemas.subagent.required.includes("cwd"), false, "cwd stays optional for create and resume");
  assert.equal(schemas.subagent.properties.id.description, "Retained run ID for status, steer, interrupt, resume, or reply.");
  assert.equal(schemas.subagent.properties.message.description, "New instruction for steer. Complete continuation objective for resume. Complete answer to the waiting request for reply.");

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
    reason: "Request type: need_decision, interview_request, or progress_update.",
    message: "Complete context the orchestrator needs to respond. Defaults to the selected reason when omitted or blank.",
    interview: "Structured interview details for interview_request.",
    questions: "Authored interview questions in display order.",
    title: "Optional short interview title.",
    id: "Optional short identifier for matching a question.",
    prompt: "Question the orchestrator should answer.",
    options: "Optional authored answer choices.",
  });
});
