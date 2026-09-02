import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { piRoot } from "./fixtures/pi-install.mjs";
const dependencyMap = {
  "@earendil-works/pi-coding-agent": pathToFileURL(`${piRoot}/dist/index.js`).href,
  "@earendil-works/pi-tui": pathToFileURL(`${piRoot}/node_modules/@earendil-works/pi-tui/dist/index.js`).href,
  typebox: pathToFileURL(`${piRoot}/node_modules/typebox/build/index.mjs`).href,
  "../tool-contracts.js": new URL("../extensions/oh-my-pi-slim/tool-contracts.ts", import.meta.url).href,
  "./transcript-renderer.js": new URL("../extensions/oh-my-pi-slim/ask/transcript-renderer.ts", import.meta.url).href,
  "../semantic-glyph.js": new URL("../extensions/oh-my-pi-slim/semantic-glyph.ts", import.meta.url).href,
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    const url = dependencyMap[specifier];
    return url ? { url, shortCircuit: true } : nextResolve(specifier, context);
  },
});

const {
  ASK_CUSTOM_LABEL,
  ASK_RESERVED_LABELS,
  ASK_RPC_CANCEL_LABEL,
  ASK_RPC_DONE_LABEL,
  ASK_RPC_SUBMIT_LABEL,
  AskRuntime,
  askResultModelContent,
  buildAskModelDto,
  buildAskResult,
  createRpcAskDriver,
  validateQuestionnaire,
} = await import("../extensions/oh-my-pi-slim/ask/runtime.ts");
const { ASK_TOOL_CONTRACT, ASK_TOOL_DESCRIPTIONS, askUserQuestionParameters } = await import("../extensions/oh-my-pi-slim/tool-contracts.ts");

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
  const handlers = new Map();
  const pi = {
    on(event, handler) {
      const registered = handlers.get(event) ?? [];
      registered.push(handler);
      handlers.set(event, registered);
    },
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
  async function emit(event, payload = {}, ctx = {}) {
    const results = [];
    for (const handler of handlers.get(event) ?? []) results.push(await handler(payload, ctx));
    return results;
  }
  return { pi, tools, activeTools, setCalls, handlers, emit };
}

function assistantBranch(toolCallIds = ["call"]) {
  return [{
    type: "message",
    id: "assistant",
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: {
      role: "assistant",
      content: toolCallIds.map((id) => ({ type: "toolCall", id, name: id === "call" ? "ask_user_question" : "read", arguments: {} })),
    },
  }];
}

function tuiCtx(toolCallIds = ["call"], hasPendingMessages = false) {
  return {
    mode: "tui",
    hasUI: true,
    ui: {},
    sessionManager: { getBranch: () => assistantBranch(toolCallIds) },
    hasPendingMessages: () => hasPendingMessages,
  };
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
    label: ASK_TOOL_DESCRIPTIONS.input.questions.items.options.items.label,
    description: ASK_TOOL_DESCRIPTIONS.input.questions.items.options.items.description,
    preview: ASK_TOOL_DESCRIPTIONS.input.questions.items.options.items.preview,
    question: ASK_TOOL_DESCRIPTIONS.input.questions.items.question,
    header: ASK_TOOL_DESCRIPTIONS.input.questions.items.header,
    options: ASK_TOOL_DESCRIPTIONS.input.questions.items.options.description,
    multiSelect: ASK_TOOL_DESCRIPTIONS.input.questions.items.multiSelect,
    questions: ASK_TOOL_DESCRIPTIONS.input.questions.description,
  });
});

test("Ask tool metadata and action fields match the frozen contract", () => {
  const harness = createPi();
  const runtime = new AskRuntime(harness.pi, { tuiDriver: { ask: async () => ({ answers: [] }) } });
  runtime.registerTool();
  const tool = harness.tools.get("ask_user_question");
  assert.equal(tool.executionMode, "sequential");
  assert.equal(tool.description, ASK_TOOL_CONTRACT.description);
  assert.equal(tool.promptSnippet, undefined);
  assert.equal(tool.promptGuidelines, undefined);
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

test("shared result builder normalizes answers, partial submit, empty submit, and discarded cancellation", () => {
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
  assert.deepEqual(cancelled, { answers: [], cancelled: true, partial: true, cancelReason: "user_cancelled" });
  assert.deepEqual(buildAskResult(questionnaire, { answers: [] }), {
    answers: [], cancelled: true, partial: true, cancelReason: "empty_submit",
  });
});

test("model result is a fixed-order answer list with null for unanswered questions", () => {
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
  const complete = buildAskResult(questionnaire, { answers: [
    { questionIndex: 0, kind: "option", answer: "Safe" },
    { questionIndex: 1, kind: "multi", answer: [] },
    { questionIndex: 2, kind: "custom", answer: "" },
  ] });
  const partial = buildAskResult(questionnaire, { answers: [{ questionIndex: 2, kind: "custom", answer: "note" }] });
  const userCancelled = buildAskResult(questionnaire, {
    answers: [{ questionIndex: 0, kind: "option", answer: "Safe" }],
    cancelled: true,
  });
  const emptySubmit = buildAskResult(questionnaire, { answers: [] });

  assert.equal(
    askResultModelContent(complete, questionnaire),
    '["Safe",[],null]',
  );
  assert.equal(
    askResultModelContent(partial, questionnaire),
    '[null,null,"note"]',
  );
  assert.equal(
    askResultModelContent(userCancelled, questionnaire),
    '[null,null,null]',
  );
  assert.equal(
    askResultModelContent(emptySubmit, questionnaire),
    '[null,null,null]',
  );
  assert.deepEqual(buildAskModelDto(complete, questionnaire), ["Safe", [], null]);
  assert.equal(askResultModelContent(complete, questionnaire).includes("\n"), false);
  assert.doesNotMatch(askResultModelContent(complete, questionnaire), /(?:outcome|unanswered|reason|questionIndex|kind|preview)/);
});

test("the shared result builder discards cancelled driver answers, malformed ones included", () => {
  const questionnaire = validateQuestionnaire({ questions: [
    baseParams.questions[0],
    { question: "Any extra?", header: "Extra", options: [{ label: "No", description: "No." }, { label: "Yes", description: "Yes." }] },
  ] });
  const canonical = { answers: [], cancelled: true, partial: true, cancelReason: "user_cancelled" };
  const hostileDriverResults = [
    { answers: [{ questionIndex: 0, kind: "option", answer: "Safe" }, { questionIndex: 1, kind: "option", answer: "Yes" }], cancelled: true },
    // Every one of these would throw on a non-cancelled result. A cancel never inspects them at all.
    { answers: [{ questionIndex: 9, kind: "option", answer: "Safe" }], cancelled: true },
    { answers: [{ questionIndex: 0, kind: "option", answer: "Not an authored label" }], cancelled: true },
    { answers: [{ questionIndex: 0, kind: "multi", answer: ["Safe"] }], cancelled: true },
    { answers: [{ questionIndex: 0, kind: "nonsense", answer: "Safe" }], cancelled: true },
    { answers: [null], cancelled: true },
    { answers: [
      { questionIndex: 0, kind: "option", answer: "Safe" },
      { questionIndex: 0, kind: "option", answer: "Fast" },
    ], cancelled: true },
  ];
  for (const driverResult of hostileDriverResults) {
    assert.deepEqual(buildAskResult(questionnaire, driverResult), canonical, JSON.stringify(driverResult));
  }
  assert.throws(() => buildAskResult(questionnaire, { answers: [], cancelled: "yes" }), /cancelled must be a boolean/);
  assert.throws(() => buildAskResult(questionnaire, { cancelled: true }), /must return an answers array/);

  const content = askResultModelContent(canonical, questionnaire);
  assert.equal(content, '[null,null]');
  assert.doesNotMatch(content, /Safe|Yes|Which path|Any extra|Path|Extra/);
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
  await assert.rejects(runtime.execute(baseParams, undefined, tuiCtx()), /`ask_user_question` is unavailable while a Goal is active\./);
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

test("RPC multi-select redraws toggles, preserves authored order, allows empty, supports custom, and discards answers on cancel", async () => {
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
  assert.deepEqual(cancelled, { answers: [], cancelled: true, partial: true, cancelReason: "user_cancelled" });
});

test("every RPC cancel entry discards answers that were already confirmed", async () => {
  const single = validateQuestionnaire({ questions: [
    baseParams.questions[0],
    { question: "Second?", header: "Second", options: [{ label: "No", description: "No." }, { label: "Yes", description: "Yes." }] },
  ] });
  const multi = validateQuestionnaire({ questions: [
    baseParams.questions[0],
    {
      question: "Which extras?", header: "Extras", multiSelect: true,
      options: [{ label: "Logs", description: "Include logs." }, { label: "Metrics", description: "Include metrics." }],
    },
  ] });
  const discarded = { answers: [], cancelled: true };

  async function drive(questionnaire, selects, inputs = []) {
    const pendingSelects = [...selects];
    const pendingInputs = [...inputs];
    const ui = {
      async select() { return pendingSelects.shift(); },
      async input() { return pendingInputs.shift(); },
    };
    return createRpcAskDriver(ui).ask(questionnaire, new AbortController().signal);
  }

  // Single-select: the explicit cancel entry and a dismissed select both drop the first answer.
  assert.deepEqual(await drive(single, ["Option 1: Safe", ASK_RPC_CANCEL_LABEL]), discarded);
  assert.deepEqual(await drive(single, ["Option 1: Safe", undefined]), discarded);
  // Single-select custom input: a dismissed input drops the first answer too.
  assert.deepEqual(await drive(single, ["Option 1: Safe", ASK_CUSTOM_LABEL], [undefined]), discarded);
  // Multi-select: cancel, dismissed select, and dismissed custom input all discard toggles and answers.
  assert.deepEqual(await drive(multi, ["Option 1: Safe", "[ ] Option 1: Logs", ASK_RPC_CANCEL_LABEL]), discarded);
  assert.deepEqual(await drive(multi, ["Option 1: Safe", "[ ] Option 1: Logs", undefined]), discarded);
  assert.deepEqual(await drive(multi, ["Option 1: Safe", "[ ] Option 1: Logs", ASK_CUSTOM_LABEL], [undefined]), discarded);

  for (const questionnaire of [single, multi]) {
    assert.deepEqual(buildAskResult(questionnaire, discarded), {
      answers: [], cancelled: true, partial: true, cancelReason: "user_cancelled",
    });
  }
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
  assert.deepEqual(cancelled, { answers: [], cancelled: true, partial: true, cancelReason: "user_cancelled" });
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
  await assert.rejects(runtime.execute(baseParams, undefined, { mode: "json", hasUI: false, ui: {} }), /`ask_user_question` is unavailable in json mode/);
  assert.equal(runtime.waitingCount(), 0);
});

test("registered Ask rejects pre-existing pending messages before opening UI", async () => {
  const harness = createPi();
  let driverCalls = 0;
  const runtime = new AskRuntime(harness.pi, { tuiDriver: { ask: async () => {
    driverCalls += 1;
    return { answers: [] };
  } } });
  runtime.registerTool();
  let abortCalls = 0;
  const ctx = { ...tuiCtx(["call"], true), abort() { abortCalls += 1; } };
  await assert.rejects(
    harness.tools.get("ask_user_question").execute("call", baseParams, undefined, undefined, ctx),
    (error) => error.message === "`ask_user_question` requires Pi to have no pending messages. Retry `ask_user_question` alone after Pi is idle.",
  );
  assert.equal(driverCalls, 0);
  assert.equal(abortCalls, 0);
});

test("waiting Ask handles only new RPC input and releases the gate after ordinary completion", async () => {
  const harness = createPi();
  const deferred = deferredDriver();
  const runtime = new AskRuntime(harness.pi, { tuiDriver: deferred.driver });
  runtime.registerTool();
  const pending = harness.tools.get("ask_user_question").execute("call", baseParams, undefined, undefined, { ...tuiCtx(), abort() {} });
  await flush();
  assert.equal(runtime.waitingCount(), 1);
  assert.equal(runtime.state().blockingCount, 1);
  const notifications = [];
  const inputCtx = { ui: { notify(message, level) { notifications.push({ message, level }); } } };
  assert.deepEqual(await harness.emit("input", { source: "rpc" }, inputCtx), [{ action: "handled" }]);
  assert.deepEqual(notifications, [{ message: "Ask is blocking new RPC prompts. Retry after Pi is idle.", level: "warning" }]);
  assert.deepEqual(await harness.emit("input", { source: "extension" }, inputCtx), [undefined]);
  deferred.calls[0].resolve({ answers: [{ questionIndex: 0, kind: "option", answer: "Safe" }] });
  await pending;
  assert.equal(runtime.state().blockingCount, 0);
  assert.deepEqual(await harness.emit("input", { source: "rpc" }, inputCtx), [undefined]);
  assert.equal(notifications.length, 1);
});

test("registered tool aborts and terminates only when the user cancels", async () => {
  const harness = createPi();
  const runtime = new AskRuntime(harness.pi, { tuiDriver: { ask: async () => ({
    answers: [{ questionIndex: 0, kind: "custom", answer: "discarded" }],
    cancelled: true,
  }) } });
  runtime.registerTool();
  const states = [];
  runtime.subscribe((state) => states.push(state));
  let abortCalls = 0;
  const ctx = { ...tuiCtx(), abort() { abortCalls += 1; } };
  const result = await harness.tools.get("ask_user_question").execute("call", baseParams, undefined, undefined, ctx);
  assert.equal(abortCalls, 1);
  assert.deepEqual(result, {
    content: [{ type: "text", text: "The user declined to answer." }],
    details: { answers: [], cancelled: true, partial: true, cancelReason: "user_cancelled" },
    terminate: true,
  });
  assert.equal(runtime.waitingCount(), 0);
  assert.equal(runtime.state().blockingCount, 1);
  assert.ok(states.some((state) => state.waitingCount === 0 && state.blockingCount === 1));

  const notifications = [];
  const inputCtx = { ui: { notify(message, level) { notifications.push({ message, level }); } } };
  assert.deepEqual(await harness.emit("input", { source: "rpc" }, inputCtx), [{ action: "handled" }]);
  assert.deepEqual(notifications, [{ message: "Ask is blocking new RPC prompts. Retry after Pi is idle.", level: "warning" }]);

  let agentStartAborts = 0;
  const rpcAbortNotifications = [];
  const agentCtx = {
    mode: "rpc",
    ui: { notify(message, level) { rpcAbortNotifications.push({ message, level }); } },
    abort() { agentStartAborts += 1; },
  };
  await harness.emit("agent_start", {}, agentCtx);
  await harness.emit("agent_start", {}, agentCtx);
  assert.equal(agentStartAborts, 2);
  assert.deepEqual(rpcAbortNotifications, [{
    message: "Queued RPC messages were aborted with Ask. Retry after Pi is idle.",
    level: "warning",
  }]);
  let tuiAgentStartAborts = 0;
  await harness.emit("agent_start", {}, {
    mode: "tui",
    ui: { notify() { throw new Error("non-RPC agent_start must not notify"); } },
    abort() { tuiAgentStartAborts += 1; },
  });
  assert.equal(tuiAgentStartAborts, 1);
  assert.equal(rpcAbortNotifications.length, 1);

  await harness.emit("agent_settled");
  assert.equal(runtime.state().blockingCount, 0);
  assert.equal(states.at(-1).blockingCount, 0);
  await harness.emit("agent_start", {}, agentCtx);
  assert.equal(agentStartAborts, 2);
  assert.deepEqual(await harness.emit("input", { source: "rpc" }, inputCtx), [undefined]);
  assert.equal(notifications.length, 1);
});

test("RPC cancel warns once when a direct queued message appears before execute abort", async () => {
  const harness = createPi();
  const runtime = new AskRuntime(harness.pi);
  runtime.registerTool();
  let pendingChecks = 0;
  let abortCalls = 0;
  const notifications = [];
  const ctx = {
    ...tuiCtx(),
    mode: "rpc",
    ui: {
      async select() { return ASK_RPC_CANCEL_LABEL; },
      async input() { throw new Error("unexpected input"); },
      notify(message, level) { notifications.push({ message, level }); },
    },
    hasPendingMessages() {
      pendingChecks += 1;
      return pendingChecks > 1;
    },
    abort() { abortCalls += 1; },
  };
  const result = await harness.tools.get("ask_user_question").execute("call", baseParams, undefined, undefined, ctx);
  assert.equal(result.content[0].text, "The user declined to answer.");
  assert.equal(result.terminate, true);
  assert.equal(abortCalls, 1);
  assert.deepEqual(notifications, [{
    message: "Queued RPC messages were aborted with Ask. Retry after Pi is idle.",
    level: "warning",
  }]);
  await harness.emit("agent_start", {}, ctx);
  await harness.emit("agent_start", {}, ctx);
  assert.equal(abortCalls, 3);
  assert.equal(notifications.length, 1);
});

test("a user cancel suppresses every non-retrying threshold compaction until settled or reset", async () => {
  const harness = createPi();
  const runtime = new AskRuntime(harness.pi, { tuiDriver: { ask: async () => ({ answers: [], cancelled: true }) } });
  runtime.registerTool();
  const tool = harness.tools.get("ask_user_question");
  const ctx = { ...tuiCtx(), abort() {} };

  await tool.execute("call", baseParams, undefined, undefined, ctx);
  assert.deepEqual(await harness.emit("session_before_compact", { reason: "manual", willRetry: false }), [undefined]);
  assert.deepEqual(await harness.emit("session_before_compact", { reason: "overflow", willRetry: true }), [undefined]);
  assert.deepEqual(await harness.emit("session_before_compact", { reason: "threshold", willRetry: true }), [undefined]);
  assert.deepEqual(await harness.emit("session_before_compact", { reason: "threshold", willRetry: false }), [{ cancel: true }]);
  assert.deepEqual(await harness.emit("session_before_compact", { reason: "threshold", willRetry: false }), [{ cancel: true }]);
  assert.deepEqual(await harness.emit("session_before_compact", { reason: "threshold", willRetry: false }), [{ cancel: true }]);

  await tool.execute("call", baseParams, undefined, undefined, ctx);
  await harness.emit("agent_settled");
  assert.deepEqual(await harness.emit("session_before_compact", { reason: "threshold", willRetry: false }), [undefined]);

  await tool.execute("call", baseParams, undefined, undefined, ctx);
  runtime.reset();
  assert.deepEqual(await harness.emit("session_before_compact", { reason: "threshold", willRetry: false }), [undefined]);
});

test("registered Ask rejects sibling tool calls before opening UI and accepts a sole or unmatched direct call", async () => {
  const harness = createPi();
  let driverCalls = 0;
  const runtime = new AskRuntime(harness.pi, { tuiDriver: { ask: async () => {
    driverCalls += 1;
    return { answers: [{ questionIndex: 0, kind: "option", answer: "Safe" }] };
  } } });
  runtime.registerTool();
  const tool = harness.tools.get("ask_user_question");
  let abortCalls = 0;
  const mixedCtx = { ...tuiCtx(["call", "sibling"]), abort() { abortCalls += 1; } };
  await assert.rejects(
    tool.execute("call", baseParams, undefined, undefined, mixedCtx),
    (error) => error.message === "`ask_user_question` must be the only tool call in its assistant message. Retry `ask_user_question` alone.",
  );
  assert.equal(driverCalls, 0);
  assert.equal(abortCalls, 0);

  const sole = await tool.execute("call", baseParams, undefined, undefined, { ...tuiCtx(), abort() { abortCalls += 1; } });
  assert.equal(sole.terminate, undefined);
  assert.equal(driverCalls, 1);
  const unmatched = await tool.execute("call", baseParams, undefined, undefined, { ...tuiCtx(["other"]), abort() { abortCalls += 1; } });
  assert.equal(unmatched.terminate, undefined);
  assert.equal(driverCalls, 2);
  assert.equal(abortCalls, 0);
});

test("registered tool returns fixed-order answer lists and continues after normal submission", async () => {
  const twoQuestions = { questions: [
    baseParams.questions[0],
    { question: "Second?", header: "Second", options: [{ label: "No", description: "No." }, { label: "Yes", description: "Yes." }] },
  ] };
  const cases = [
    {
      params: baseParams,
      driverResult: { answers: [{ questionIndex: 0, kind: "option", answer: "Safe" }] },
      content: '["Safe"]',
    },
    {
      params: twoQuestions,
      driverResult: { answers: [{ questionIndex: 0, kind: "option", answer: "Safe" }] },
      content: '["Safe",null]',
    },
    {
      params: baseParams,
      driverResult: { answers: [] },
      content: '[null]',
    },
  ];

  for (const { params, driverResult, content } of cases) {
    const harness = createPi();
    const runtime = new AskRuntime(harness.pi, { tuiDriver: { ask: async () => driverResult } });
    runtime.registerTool();
    let abortCalls = 0;
    const ctx = { ...tuiCtx(), abort() { abortCalls += 1; } };
    const result = await harness.tools.get("ask_user_question").execute("call", params, undefined, undefined, ctx);
    assert.equal(abortCalls, 0);
    assert.equal(result.terminate, undefined);
    assert.equal(result.content[0].text, content);
    assert.equal(runtime.state().blockingCount, 0);
    assert.deepEqual(await harness.emit("session_before_compact", { reason: "threshold", willRetry: false }), [undefined]);
  }
});

test("a host, tool, or session abort stays an AbortError and never becomes a user cancellation", async () => {
  const harness = createPi();
  const runtime = new AskRuntime(harness.pi, { tuiDriver: {
    ask(_questionnaire, signal) {
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          const error = new Error("driver aborted");
          error.name = "AbortError";
          reject(error);
        }, { once: true });
      });
    },
  } });
  runtime.registerTool();
  const tool = harness.tools.get("ask_user_question");
  const controller = new AbortController();
  const pending = tool.execute("call", baseParams, controller.signal, undefined, tuiCtx());
  await flush();
  controller.abort("tool call cancelled");
  await assert.rejects(pending, (error) => error.name === "AbortError" && /tool call cancelled/.test(error.message));

  const preAborted = AbortSignal.abort("host already stopped");
  await assert.rejects(
    tool.execute("call", baseParams, preAborted, undefined, tuiCtx()),
    (error) => error.name === "AbortError" && /host already stopped/.test(error.message),
  );
  assert.equal(runtime.waitingCount(), 0);
  assert.equal(runtime.state().queuedCount, 0);
});
