import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { registerHooks } from "node:module";
import { realpathSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const piEntry = realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim());
const piRoot = dirname(dirname(piEntry));
const dependencyMap = {
  "@earendil-works/pi-coding-agent": pathToFileURL(`${piRoot}/dist/index.js`).href,
  "@earendil-works/pi-tui": pathToFileURL(`${piRoot}/node_modules/@earendil-works/pi-tui/dist/index.js`).href,
  typebox: pathToFileURL(`${piRoot}/node_modules/typebox/build/index.mjs`).href,
  "./ask-transcript-renderer.js": new URL("../extensions/oh-my-pi-slim/ask-transcript-renderer.ts", import.meta.url).href,
  "./semantic-glyph.js": new URL("../extensions/oh-my-pi-slim/semantic-glyph.ts", import.meta.url).href,
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    const url = dependencyMap[specifier];
    return url ? { url, shortCircuit: true } : nextResolve(specifier, context);
  },
});

const {
  ASK_CUSTOM_LABEL,
  ASK_PROMPT_GUIDELINES,
  ASK_RESERVED_LABELS,
  ASK_RPC_CANCEL_LABEL,
  ASK_RPC_DONE_LABEL,
  ASK_RPC_SUBMIT_LABEL,
  AskRuntime,
  askResultModelContent,
  askUserQuestionParameters,
  buildAskResult,
  createRpcAskDriver,
  validateQuestionnaire,
} = await import("../extensions/oh-my-pi-slim/ask-runtime.ts");

const baseParams = {
  questions: [{
    question: "Which path?",
    header: "Path",
    options: [
      { label: "Safe", description: "Use the safe path.", preview: "full preview" },
      { label: "Fast", description: "Use the fast path." },
    ],
  }],
};

function createPi(active = []) {
  const tools = new Map();
  const activeTools = [...active];
  const setCalls = [];
  const pi = {
    registerTool(tool) {
      tools.set(tool.name, tool);
      if (!activeTools.includes(tool.name)) activeTools.push(tool.name);
    },
    getActiveTools() { return [...activeTools]; },
    setActiveTools(names) {
      activeTools.splice(0, activeTools.length, ...names);
      setCalls.push([...names]);
    },
    getAllTools() { return [...tools.values()]; },
  };
  return { pi, tools, activeTools, setCalls };
}

function tuiCtx() {
  return { mode: "tui", hasUI: true, ui: {} };
}

function rpcCtx(ui) {
  return { mode: "rpc", hasUI: true, ui };
}

function deferredDriver() {
  const calls = [];
  return {
    calls,
    driver: {
      ask(questionnaire, signal) {
        return new Promise((resolve, reject) => {
          const call = { questionnaire, signal, resolve, reject };
          calls.push(call);
          signal.addEventListener("abort", () => {
            const error = new Error("driver aborted");
            error.name = "AbortError";
            reject(error);
          }, { once: true });
        });
      },
    },
  };
}

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

test("Ask schema is strict, provider-portable, and preserves RPIV field bounds", () => {
  const schema = JSON.parse(JSON.stringify(askUserQuestionParameters));
  assert.equal(schema.type, "object");
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.anyOf, undefined);
  assert.equal(schema.oneOf, undefined);
  assert.deepEqual(Object.keys(schema.properties), ["questions"]);
  assert.equal(schema.properties.questions.minItems, 1);
  assert.equal(schema.properties.questions.maxItems, 4);
  const question = schema.properties.questions.items;
  assert.equal(question.additionalProperties, false);
  assert.equal(question.properties.header.maxLength, 16);
  assert.equal(question.properties.options.minItems, 2);
  assert.equal(question.properties.options.maxItems, 4);
  assert.equal(question.properties.options.items.additionalProperties, false);
  assert.equal(question.properties.options.items.properties.label.maxLength, 60);
  assert.deepEqual(Object.keys(question.properties).sort(), ["header", "multiSelect", "options", "question"]);
  assert.deepEqual(Object.keys(question.properties.options.items.properties).sort(), ["description", "label", "preview"]);
  assert.deepEqual({
    label: question.properties.options.items.properties.label.description,
    description: question.properties.options.items.properties.description.description,
    preview: question.properties.options.items.properties.preview.description,
    question: question.properties.question.description,
    header: question.properties.header.description,
    options: question.properties.options.description,
    multiSelect: question.properties.multiSelect.description,
    questions: schema.properties.questions.description,
  }, {
    label: "Write a short option label. Mark a recommendation by placing it first and appending (Recommended). Do not use Other, Type something., or Next.",
    description: "Describe the outcome of choosing this option.",
    preview: "Add preview content only for a single-select question.",
    question: "Write one user decision question.",
    header: "Write a short question header.",
    options: "Provide authored choices in display order.",
    multiSelect: "Set true only when multiple authored options may be selected. Omit option previews when true.",
    questions: "Provide questions in display order.",
  });
});

test("Ask tool metadata and action fields match the frozen contract", () => {
  const harness = createPi();
  const runtime = new AskRuntime(harness.pi, { tuiDriver: { ask: async () => ({ answers: [] }) } });
  runtime.registerTool();
  const tool = harness.tools.get("ask_user_question");
  assert.equal(tool.executionMode, "sequential");
  assert.equal(tool.description, "Ask the user structured questions and return structured answers.");
  assert.equal(tool.promptSnippet, "Ask the user structured questions for decisions.");
  assert.deepEqual(tool.promptGuidelines, [
    "Choose `ask_user_question` only when the user's decision should direct the next step.",
    "Prefer bounded authored choices in `ask_user_question` when likely outcomes are known.",
    "Allow a custom `ask_user_question` response when authored choices may not fit.",
    "Treat partial or cancelled `ask_user_question` answers as valid outcomes, not failed calls.",
    "Do not call `ask_user_question` while a Goal is active.",
  ]);
  assert.deepEqual(ASK_RESERVED_LABELS, ["Other", "Type something.", "Next"]);
  assert.equal(tool.parameters.properties.action, undefined);
  assert.equal(typeof tool.renderCall, "function");
  assert.equal(typeof tool.renderResult, "function");
});

test("runtime validation rejects exact duplicates, reserved labels, unknown fields, and preview on multi-select", () => {
  assert.throws(() => validateQuestionnaire({ ...baseParams, extra: true }), /does not accept field/);
  assert.throws(() => validateQuestionnaire({ questions: [...baseParams.questions, baseParams.questions[0]] }), /duplicate exact question/);
  assert.throws(() => validateQuestionnaire({ questions: [{ ...baseParams.questions[0], options: [
    { label: "Same", description: "a" }, { label: "Same", description: "b" },
  ] }] }), /duplicate exact label/);
  for (const label of ASK_RESERVED_LABELS) {
    assert.throws(() => validateQuestionnaire({ questions: [{ ...baseParams.questions[0], options: [
      { label, description: "a" }, { label: "Allowed", description: "b" },
    ] }] }), /reserved label/);
  }
  assert.throws(() => validateQuestionnaire({ questions: [{ ...baseParams.questions[0], multiSelect: true }] }), /preview is single-select only/);
  assert.doesNotThrow(() => validateQuestionnaire({ questions: [{
    ...baseParams.questions[0],
    question: "which path?",
    options: [{ label: "same", description: "a" }, { label: "Same", description: "b" }],
  }, baseParams.questions[0]] }));
});

test("shared result builder normalizes option, empty custom, empty multi, partial submit, and cancel partial", () => {
  const questionnaire = validateQuestionnaire({ questions: [
    baseParams.questions[0],
    {
      question: "Which extras?",
      header: "Extras",
      multiSelect: true,
      options: [{ label: "Logs", description: "Include logs." }, { label: "Metrics", description: "Include metrics." }],
    },
    {
      question: "Any note?",
      header: "Note",
      options: [{ label: "Skip", description: "Skip it." }, { label: "Add", description: "Add it." }],
    },
  ] });
  const full = buildAskResult(questionnaire, { answers: [
    { questionIndex: 0, kind: "option", answer: "Safe" },
    { questionIndex: 1, kind: "multi", answer: [] },
    { questionIndex: 2, kind: "custom", answer: "" },
  ] });
  assert.deepEqual(full, {
    answers: [
      { questionIndex: 0, question: "Which path?", header: "Path", kind: "option", answer: "Safe", selected: ["Safe"], preview: "full preview" },
      { questionIndex: 1, question: "Which extras?", header: "Extras", kind: "multi", answer: [], selected: [] },
      { questionIndex: 2, question: "Any note?", header: "Note", kind: "custom", answer: null },
    ],
    cancelled: false,
    partial: false,
  });
  const partial = buildAskResult(questionnaire, { answers: [{ questionIndex: 2, kind: "custom", answer: "note" }] });
  assert.equal(partial.cancelled, false);
  assert.equal(partial.partial, true);
  const cancelled = buildAskResult(questionnaire, { answers: [{ questionIndex: 1, kind: "multi", answer: [] }], cancelled: true });
  assert.equal(cancelled.cancelReason, "user_cancelled");
  assert.equal(cancelled.answers.length, 1);
  assert.deepEqual(buildAskResult(questionnaire, { answers: [] }), {
    answers: [], cancelled: true, partial: true, cancelReason: "empty_submit",
  });
  const content = askResultModelContent(cancelled, questionnaire);
  assert.match(content, /not completed/);
  assert.match(content, /Partial confirmed answers/);
  assert.match(content, /no options selected/);
  assert.match(content, /Unanswered questions/);
});

test("single-flight queue runs one dialog at a time and waiting excludes queued invocations", async () => {
  const harness = createPi();
  const deferred = deferredDriver();
  const runtime = new AskRuntime(harness.pi, { tuiDriver: deferred.driver });
  const states = [];
  runtime.subscribe((state) => states.push(state));
  const first = runtime.execute(baseParams, undefined, tuiCtx());
  const second = runtime.execute(baseParams, undefined, tuiCtx());
  await flush();
  assert.equal(deferred.calls.length, 1);
  assert.equal(runtime.waitingCount(), 1);
  assert.equal(runtime.isWaiting(), true);
  assert.equal(runtime.state().queuedCount, 1);
  deferred.calls[0].resolve({ answers: [{ questionIndex: 0, kind: "option", answer: "Safe" }] });
  await first;
  await flush();
  assert.equal(deferred.calls.length, 2);
  assert.equal(runtime.waitingCount(), 1);
  deferred.calls[1].resolve({ answers: [{ questionIndex: 0, kind: "option", answer: "Fast" }] });
  await second;
  assert.equal(runtime.waitingCount(), 0);
  assert.ok(states.some((state) => state.waitingCount === 1 && state.queuedCount === 1));
  assert.equal(Math.max(...states.map((state) => state.waitingCount)), 1);
});

test("queued and active aborts reject exactly once with AbortError and never become user cancellations", async () => {
  const harness = createPi();
  const deferred = deferredDriver();
  const runtime = new AskRuntime(harness.pi, { tuiDriver: deferred.driver });
  const activeController = new AbortController();
  const queuedController = new AbortController();
  const active = runtime.execute(baseParams, activeController.signal, tuiCtx());
  const queued = runtime.execute(baseParams, queuedController.signal, tuiCtx());
  await flush();
  queuedController.abort("queued stop");
  await assert.rejects(queued, (error) => error.name === "AbortError" && /queued stop/.test(error.message));
  assert.equal(deferred.calls.length, 1);
  activeController.abort("active stop");
  await assert.rejects(active, (error) => error.name === "AbortError" && /active stop/.test(error.message));
  await flush();
  assert.equal(runtime.waitingCount(), 0);
  assert.equal(runtime.state().queuedCount, 0);
});

test("abortAll tears down active and queued asks and clears waiting state", async () => {
  const harness = createPi();
  const deferred = deferredDriver();
  const runtime = new AskRuntime(harness.pi, { tuiDriver: deferred.driver });
  const active = runtime.execute(baseParams, undefined, tuiCtx());
  const queued = runtime.execute(baseParams, undefined, tuiCtx());
  await flush();
  runtime.abortAll("session teardown");
  assert.equal(runtime.waitingCount(), 0);
  assert.equal(runtime.state().queuedCount, 0);
  await assert.rejects(active, (error) => error.name === "AbortError" && /session teardown/.test(error.message));
  await assert.rejects(queued, (error) => error.name === "AbortError" && /session teardown/.test(error.message));
});

test("Goal guard runs after validation and before UI or waiting", async () => {
  const harness = createPi();
  let calls = 0;
  const runtime = new AskRuntime(harness.pi, {
    tuiDriver: { async ask() { calls += 1; return { answers: [] }; } },
    goalActiveResolver: () => true,
  });
  await assert.rejects(runtime.execute(baseParams, undefined, tuiCtx()), /ask_user_question is unavailable while an active Goal is being pursued\./);
  assert.equal(calls, 0);
  assert.equal(runtime.waitingCount(), 0);
  await assert.rejects(runtime.execute({ questions: [] }, undefined, tuiCtx()), /questions must contain/);
});

test("RPC single-select carries preview, custom input normalizes empty, and dialog calls receive the signal", async () => {
  const selectCalls = [];
  const inputCalls = [];
  const selections = ["Option 1: Safe", ASK_CUSTOM_LABEL];
  const inputs = [""];
  const ui = {
    async select(title, options, opts) {
      selectCalls.push({ title, options, opts });
      return selections.shift();
    },
    async input(title, placeholder, opts) {
      inputCalls.push({ title, placeholder, opts });
      return inputs.shift();
    },
  };
  const signal = new AbortController().signal;
  const questionnaire = validateQuestionnaire({ questions: [
    baseParams.questions[0],
    { question: "Any note?", header: "Note", options: [{ label: "No", description: "No note." }, { label: "Yes", description: "Add note." }] },
  ] });
  const raw = await createRpcAskDriver(ui).ask(questionnaire, signal);
  const result = buildAskResult(questionnaire, raw);
  assert.match(selectCalls[0].title, /Preview for Safe: full preview/);
  assert.deepEqual(selectCalls[0].options, [
    "Option 1: Safe",
    "Option 2: Fast",
    "Type something.",
    "Submit questionnaire",
    "Cancel questionnaire",
  ]);
  assert.equal(selectCalls[0].opts.signal, signal);
  assert.equal(inputCalls[0].opts.signal, signal);
  assert.equal(result.answers[0].preview, "full preview");
  assert.equal(result.answers[1].kind, "custom");
  assert.equal(result.answers[1].answer, null);
});

test("RPC multi-select redraws toggles, preserves authored order, allows empty, supports custom, and cancels with partial answers", async () => {
  const question = validateQuestionnaire({ questions: [{
    question: "Which extras?", header: "Extras", multiSelect: true,
    options: [{ label: "A", description: "A." }, { label: "B", description: "B." }, { label: "C", description: "C." }],
  }] });
  const calls = [];
  const choices = ["[ ] Option 3: C", "[ ] Option 1: A", "[x] Option 3: C", ASK_RPC_DONE_LABEL];
  const ui = {
    async select(_title, options) { calls.push(options); return choices.shift(); },
    async input() { throw new Error("unexpected input"); },
  };
  const selected = buildAskResult(question, await createRpcAskDriver(ui).ask(question, new AbortController().signal));
  assert.deepEqual(selected.answers[0].answer, ["A"]);
  assert.deepEqual(calls[1].slice(0, 3), ["[ ] Option 1: A", "[ ] Option 2: B", "[x] Option 3: C"]);

  const emptyUi = { async select() { return ASK_RPC_DONE_LABEL; }, async input() {} };
  const empty = buildAskResult(question, await createRpcAskDriver(emptyUi).ask(question, new AbortController().signal));
  assert.deepEqual(empty.answers[0].answer, []);

  const customChoices = ["[ ] Option 1: A", ASK_CUSTOM_LABEL];
  const customUi = {
    async select() { return customChoices.shift(); },
    async input() { return "custom only"; },
  };
  const custom = buildAskResult(question, await createRpcAskDriver(customUi).ask(question, new AbortController().signal));
  assert.equal(custom.answers[0].kind, "custom");
  assert.equal(custom.answers[0].answer, "custom only");
  assert.equal(custom.answers[0].selected, undefined);

  const two = validateQuestionnaire({ questions: [baseParams.questions[0], { ...baseParams.questions[0], question: "Second?", header: "Second" }] });
  const cancelChoices = ["Option 2: Fast", ASK_RPC_CANCEL_LABEL];
  const cancelUi = { async select() { return cancelChoices.shift(); }, async input() {} };
  const cancelled = buildAskResult(two, await createRpcAskDriver(cancelUi).ask(two, new AbortController().signal));
  assert.equal(cancelled.cancelReason, "user_cancelled");
  assert.equal(cancelled.partial, true);
  assert.equal(cancelled.answers[0].answer, "Fast");
});

test("RPC exposes complete, partial, empty, and cancelled questionnaire outcomes", async () => {
  const questionnaire = validateQuestionnaire({ questions: [
    baseParams.questions[0],
    {
      question: "Any note?",
      header: "Note",
      options: [{ label: "No", description: "No note." }, { label: "Yes", description: "Add note." }],
    },
  ] });
  async function run(choices) {
    const pending = [...choices];
    const ui = {
      async select() { return pending.shift(); },
      async input() { throw new Error("unexpected input"); },
    };
    return buildAskResult(questionnaire, await createRpcAskDriver(ui).ask(questionnaire, new AbortController().signal));
  }

  const complete = await run(["Option 1: Safe", "Option 2: Yes"]);
  assert.equal(complete.cancelled, false);
  assert.equal(complete.partial, false);
  assert.deepEqual(complete.answers.map((answer) => answer.answer), ["Safe", "Yes"]);

  const partial = await run(["Option 1: Safe", ASK_RPC_SUBMIT_LABEL]);
  assert.equal(partial.cancelled, false);
  assert.equal(partial.partial, true);
  assert.deepEqual(partial.answers.map((answer) => answer.answer), ["Safe"]);

  const empty = await run([ASK_RPC_SUBMIT_LABEL]);
  assert.deepEqual(empty, {
    answers: [], cancelled: true, partial: true, cancelReason: "empty_submit",
  });

  const cancelled = await run(["Option 2: Fast", ASK_RPC_CANCEL_LABEL]);
  assert.equal(cancelled.cancelled, true);
  assert.equal(cancelled.cancelReason, "user_cancelled");
  assert.equal(cancelled.partial, true);
  assert.deepEqual(cancelled.answers.map((answer) => answer.answer), ["Fast"]);
});

test("RPC authored prefixes keep Submit, Cancel, and Done label collisions unambiguous", async () => {
  const single = validateQuestionnaire({ questions: [{
    question: "Choose a control word.",
    header: "Single",
    options: [
      { label: ASK_RPC_SUBMIT_LABEL, description: "Authored submit label." },
      { label: ASK_RPC_CANCEL_LABEL, description: "Authored cancel label." },
    ],
  }] });
  const singleCalls = [];
  const singleUi = {
    async select(_title, options) {
      singleCalls.push(options);
      return `Option 1: ${ASK_RPC_SUBMIT_LABEL}`;
    },
    async input() { throw new Error("unexpected input"); },
  };
  const singleResult = buildAskResult(single, await createRpcAskDriver(singleUi).ask(single, new AbortController().signal));
  assert.equal(singleResult.answers[0].answer, ASK_RPC_SUBMIT_LABEL);
  assert.ok(singleCalls[0].includes(ASK_RPC_SUBMIT_LABEL));
  assert.ok(singleCalls[0].includes(`Option 1: ${ASK_RPC_SUBMIT_LABEL}`));

  const multi = validateQuestionnaire({ questions: [{
    question: "Choose control words.",
    header: "Multi",
    multiSelect: true,
    options: [
      { label: ASK_RPC_DONE_LABEL, description: "Authored done label." },
      { label: ASK_RPC_SUBMIT_LABEL, description: "Authored submit label." },
      { label: ASK_RPC_CANCEL_LABEL, description: "Authored cancel label." },
    ],
  }] });
  const choices = [
    `[ ] Option 1: ${ASK_RPC_DONE_LABEL}`,
    `[ ] Option 2: ${ASK_RPC_SUBMIT_LABEL}`,
    `[ ] Option 3: ${ASK_RPC_CANCEL_LABEL}`,
    ASK_RPC_DONE_LABEL,
  ];
  const multiUi = {
    async select() { return choices.shift(); },
    async input() { throw new Error("unexpected input"); },
  };
  const multiResult = buildAskResult(multi, await createRpcAskDriver(multiUi).ask(multi, new AbortController().signal));
  assert.deepEqual(multiResult.answers[0].answer, [ASK_RPC_DONE_LABEL, ASK_RPC_SUBMIT_LABEL, ASK_RPC_CANCEL_LABEL]);
});

test("Ask prompt guidelines keep short tool-owned metadata sentences", () => {
  for (const guideline of ASK_PROMPT_GUIDELINES) {
    const words = guideline.match(/[A-Za-z0-9_]+(?:-[A-Za-z0-9_]+)*/g) ?? [];
    assert.ok(words.length <= 20, guideline);
    assert.equal(guideline.includes(";"), false, guideline);
    assert.match(guideline, /\bask_user_question\b/);
  }
});

test("headless reconciliation removes and restores only Ask, while execute keeps a no-UI backstop", async () => {
  const harness = createPi(["read"]);
  const runtime = new AskRuntime(harness.pi, { tuiDriver: { ask: async () => ({ answers: [] }) } });
  runtime.registerTool();
  assert.deepEqual(harness.activeTools, ["read", "ask_user_question"]);
  runtime.reconcileHostMode({ mode: "json" });
  assert.deepEqual(harness.activeTools, ["read"]);
  runtime.reconcileHostMode({ mode: "print" });
  assert.equal(harness.setCalls.length, 1, "repeated headless reconciliation must not claim another removal");
  runtime.reconcileHostMode({ mode: "rpc" });
  assert.deepEqual(harness.activeTools, ["read", "ask_user_question"]);
  runtime.reconcileHostMode({ mode: "tui" });
  assert.equal(harness.setCalls.length, 2, "UI reconciliation must restore Ask only once");
  await assert.rejects(runtime.execute(baseParams, undefined, { mode: "json", hasUI: false, ui: {} }), /UI is unavailable in json mode/);
  assert.equal(runtime.waitingCount(), 0);
});

test("registered tool uses the shared envelope and user cancel remains a normal result", async () => {
  const harness = createPi();
  const runtime = new AskRuntime(harness.pi, { tuiDriver: { ask: async () => ({
    answers: [{ questionIndex: 0, kind: "custom", answer: "partial" }],
    cancelled: true,
  }) } });
  runtime.registerTool();
  const result = await harness.tools.get("ask_user_question").execute("call", baseParams, undefined, undefined, tuiCtx());
  assert.equal(result.details.cancelReason, "user_cancelled");
  assert.equal(result.details.answers[0].answer, "partial");
  assert.match(result.content[0].text, /not completed/);
  assert.doesNotMatch(result.content[0].text, /declin/i);
});
