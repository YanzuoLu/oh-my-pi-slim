import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { stripVTControlCharacters } from "node:util";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { piRoot } from "./fixtures/pi-install.mjs";
const dependencyMap = {
  "@earendil-works/pi-coding-agent": pathToFileURL(`${piRoot}/dist/index.js`).href,
  "@earendil-works/pi-tui": pathToFileURL(`${piRoot}/node_modules/@earendil-works/pi-tui/dist/index.js`).href,
  typebox: pathToFileURL(`${piRoot}/node_modules/typebox/build/index.mjs`).href,
  "./ask-runtime.js": new URL("../extensions/oh-my-pi-slim/ask-runtime.ts", import.meta.url).href,
  "./ask-transcript-renderer.js": new URL("../extensions/oh-my-pi-slim/ask-transcript-renderer.ts", import.meta.url).href,
  "./semantic-glyph.js": new URL("../extensions/oh-my-pi-slim/semantic-glyph.ts", import.meta.url).href,
  "./subagent-core.js": new URL("../extensions/oh-my-pi-slim/subagent-core.ts", import.meta.url).href,
  "./subagent-model-display.js": new URL("../extensions/oh-my-pi-slim/subagent-model-display.ts", import.meta.url).href,
  "./widget-expansion.js": new URL("../extensions/oh-my-pi-slim/widget-expansion.ts", import.meta.url).href,
  "./subagent-viewer-data.js": new URL("../extensions/oh-my-pi-slim/subagent-viewer-data.ts", import.meta.url).href,
  "./subagent-viewer-transcript.js": new URL("../extensions/oh-my-pi-slim/subagent-viewer-transcript.ts", import.meta.url).href,
  "./subagent-widget-display.js": new URL("../extensions/oh-my-pi-slim/subagent-widget-display.ts", import.meta.url).href,
  "./subagent-widget-glyphs.js": new URL("../extensions/oh-my-pi-slim/subagent-widget-glyphs.ts", import.meta.url).href,
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    const url = dependencyMap[specifier];
    return url ? { url, shortCircuit: true } : nextResolve(specifier, context);
  },
});

const { CURSOR_MARKER, visibleWidth } = await import("@earendil-works/pi-tui");
const { initTheme } = await import("@earendil-works/pi-coding-agent");
initTheme(undefined, false);
const { AskTuiDriver } = await import("../extensions/oh-my-pi-slim/ask-tui.ts");
const { createSubagentViewer } = await import("../extensions/oh-my-pi-slim/subagent-viewer.ts");
const { createOverlayHost } = await import("./fixtures/overlay-host.mjs");
const { AskRuntime, buildAskResult, createRpcAskDriver, validateQuestionnaire } = await import("../extensions/oh-my-pi-slim/ask-runtime.ts");

const KEY = {
  tab: "\t",
  shiftTab: "\x1b[Z",
  right: "\x1b[C",
  left: "\x1b[D",
  up: "\x1b[A",
  down: "\x1b[B",
  enter: "\r",
  newline: "\n",
  escape: "\x1b",
  space: " ",
};

const theme = {
  fg: (_color, text) => text,
  bg: (_color, text) => text,
  bold: (text) => text,
};

function question(overrides = {}) {
  return {
    question: "Which path should we take?",
    header: "Path",
    options: [
      { label: "Safe", description: "Use the safe path.", preview: "# Safe preview\n\nComplete preview body." },
      { label: "Fast", description: "Use the fast path." },
    ],
    ...overrides,
  };
}

function multiQuestion(overrides = {}) {
  return question({
    question: "Which extras should be included?",
    header: "Extras",
    multiSelect: true,
    options: [
      { label: "Logs", description: "Include logs." },
      { label: "Metrics", description: "Include metrics." },
      { label: "Traces", description: "Include traces." },
    ],
    ...overrides,
  });
}

function renderLines(component, width = 120) {
  return component.render(width).map((line) => stripVTControlCharacters(line).trimEnd());
}

function render(component, width = 120) {
  return renderLines(component, width).join("\n");
}

function createDriverHarness(questionnaireValue, controller = new AbortController()) {
  let component;
  let overlayOptions;
  let doneCalls = 0;
  let renders = 0;
  let resolveOverlay;
  const tui = {
    terminal: { rows: 40, columns: 140 },
    requestRender() { renders += 1; },
  };
  const ui = {
    custom(factory, options) {
      overlayOptions = options;
      return new Promise((resolve) => {
        resolveOverlay = resolve;
        const done = (value) => {
          doneCalls += 1;
          resolve(value);
        };
        component = factory(tui, theme, {}, done);
        component.focused = true;
      });
    },
  };
  const questionnaire = validateQuestionnaire(questionnaireValue);
  const driver = new AskTuiDriver(ui);
  const pending = driver.ask(questionnaire, controller.signal);
  return {
    questionnaire,
    driver,
    pending,
    controller,
    get component() { return component; },
    get overlayOptions() { return overlayOptions; },
    get doneCalls() { return doneCalls; },
    get renders() { return renders; },
    resolveOverlay,
  };
}

function type(component, text) {
  for (const character of text) component.handleInput(character);
}

function goToCustom(component, authoredCount) {
  for (let index = 0; index < authoredCount; index += 1) component.handleInput(KEY.down);
  component.handleInput(KEY.enter);
}

test("Ask TUI uses one bottom-center full-width modal and tabs wrap in both directions", async () => {
  const harness = createDriverHarness({ questions: [
    question(),
    question({ question: "Second question?", header: "Second" }),
    question({ question: "Third question?", header: "Third" }),
    question({ question: "Fourth question?", header: "Fourth" }),
  ] });
  assert.equal(harness.overlayOptions.overlay, true);
  assert.deepEqual(harness.overlayOptions.overlayOptions, {
    width: "100%",
    maxHeight: "90%",
    anchor: "bottom-center",
    margin: { top: 0, right: 0, bottom: 0, left: 0 },
  });
  assert.match(render(harness.component), /Which path should we take/);
  harness.component.handleInput(KEY.tab);
  assert.match(render(harness.component), /Second question/);
  harness.component.handleInput(KEY.right);
  assert.match(render(harness.component), /Third question/);
  harness.component.handleInput(KEY.shiftTab);
  assert.match(render(harness.component), /Second question/);
  harness.component.handleInput(KEY.left);
  assert.match(render(harness.component), /Which path should we take/);
  harness.component.handleInput(KEY.left);
  assert.match(render(harness.component), /Submit questionnaire/);
  harness.component.handleInput(KEY.tab);
  assert.match(render(harness.component), /Which path should we take/);
  harness.component.handleInput(KEY.escape);
  assert.deepEqual(await harness.pending, { answers: [], cancelled: true });
});

test("single-select cycles, confirms an authored option, and advances to Submit", async () => {
  const harness = createDriverHarness({ questions: [question(), question({ question: "Second?", header: "Second" })] });
  harness.component.handleInput(KEY.down);
  assert.match(render(harness.component), /> 2\. Fast/);
  harness.component.handleInput(KEY.down);
  assert.match(render(harness.component), /> 3\. Type something\./);
  harness.component.handleInput(KEY.down);
  assert.match(render(harness.component), /> 1\. Safe/);
  harness.component.handleInput(KEY.up);
  assert.match(render(harness.component), /> 3\. Type something\./);
  harness.component.handleInput(KEY.down);
  harness.component.handleInput(KEY.enter);
  assert.match(render(harness.component), /Second\?/);
  harness.component.handleInput(KEY.enter);
  assert.match(render(harness.component), /2\/2 answered/);
  harness.component.handleInput(KEY.enter);
  assert.deepEqual(await harness.pending, {
    answers: [
      { questionIndex: 0, kind: "option", answer: "Safe" },
      { questionIndex: 1, kind: "option", answer: "Safe" },
    ],
  });
});

test("a single question completes on confirmation and never shows a Submit tab or panel", async () => {
  const authored = createDriverHarness({ questions: [question()] });
  const surface = render(authored.component);
  assert.doesNotMatch(surface, /Submit/, "a one-question questionnaire has nothing left to submit");
  assert.doesNotMatch(surface, /Cancel questionnaire/);
  assert.match(surface, /↑↓ move · Enter confirm · Esc cancel and discard/);
  assert.doesNotMatch(surface, /next tab|previous tab/);

  // Tab, Shift-Tab, Right, and Left all resolve to the one real tab: there is no ghost index to reach.
  for (const key of [KEY.tab, KEY.shiftTab, KEY.right, KEY.left, KEY.tab, KEY.tab]) {
    authored.component.handleInput(key);
    const cycled = render(authored.component);
    assert.match(cycled, /Which path should we take/);
    assert.doesNotMatch(cycled, /Submit/);
  }
  assert.equal(authored.doneCalls, 0);
  authored.component.handleInput(KEY.enter);
  assert.equal(authored.doneCalls, 1, "confirming the only question completes the questionnaire at once");
  assert.deepEqual(await authored.pending, {
    answers: [{ questionIndex: 0, kind: "option", answer: "Safe" }],
  });

  // A focused preview changes nothing about the completion path.
  const previewed = createDriverHarness({ questions: [question()] });
  assert.match(render(previewed.component), /Safe preview/);
  previewed.component.handleInput(KEY.enter);
  assert.deepEqual(await previewed.pending, {
    answers: [{ questionIndex: 0, kind: "option", answer: "Safe" }],
  });

  // Multi-select keeps Enter and Space as toggles, and the existing Next row is the confirmation.
  const multi = createDriverHarness({ questions: [multiQuestion()] });
  assert.doesNotMatch(render(multi.component), /Submit/);
  multi.component.handleInput(KEY.enter);
  multi.component.handleInput(KEY.down);
  multi.component.handleInput(KEY.space);
  assert.equal(multi.doneCalls, 0, "Enter and Space only toggle while an authored option is focused");
  assert.match(render(multi.component), /\[x\] 1\. Logs/);
  assert.match(render(multi.component), /\[x\] 2\. Metrics/);
  for (let index = 0; index < 3; index += 1) multi.component.handleInput(KEY.down);
  assert.match(render(multi.component), /> 5\. Next/);
  multi.component.handleInput(KEY.enter);
  assert.deepEqual(await multi.pending, {
    answers: [{ questionIndex: 0, kind: "multi", answer: ["Logs", "Metrics"] }],
  });

  // Space on the Next row confirms an empty multi-select without any Ctrl+Enter shortcut.
  const emptyMulti = createDriverHarness({ questions: [multiQuestion()] });
  for (let index = 0; index < 4; index += 1) emptyMulti.component.handleInput(KEY.down);
  emptyMulti.component.handleInput(KEY.space);
  assert.deepEqual(await emptyMulti.pending, {
    answers: [{ questionIndex: 0, kind: "multi", answer: [] }],
  });
});

test("a single custom question completes from inside the editor while Esc still keeps the draft", async () => {
  const harness = createDriverHarness({ questions: [question()] });
  goToCustom(harness.component, 2);
  type(harness.component, "first");
  harness.component.handleInput(KEY.newline);
  type(harness.component, "second");
  assert.equal(harness.doneCalls, 0, "Shift+Enter adds a line instead of confirming");

  // Esc leaves the editor and keeps the draft, and a second Esc cancels the questionnaire.
  harness.component.handleInput(KEY.escape);
  assert.match(render(harness.component), /> 3\. Type something\./);
  assert.equal(harness.doneCalls, 0);
  harness.component.handleInput(KEY.enter);
  const reopened = render(harness.component, 80);
  assert.match(reopened, /first/);
  assert.match(reopened, /second/);
  harness.component.handleInput(KEY.enter);
  assert.equal(harness.doneCalls, 1, "Enter inside the editor completes the one-question questionnaire");
  assert.deepEqual(await harness.pending, {
    answers: [{ questionIndex: 0, kind: "custom", answer: "first\nsecond" }],
  });

  const discarded = createDriverHarness({ questions: [question()] });
  goToCustom(discarded.component, 2);
  type(discarded.component, "draft only");
  discarded.component.handleInput(KEY.escape);
  discarded.component.handleInput(KEY.escape);
  assert.deepEqual(await discarded.pending, { answers: [], cancelled: true });
});

test("every TUI cancel entry discards answers that were already confirmed", async () => {
  const questions = { questions: [question(), question({ question: "Second?", header: "Second" })] };

  const escaped = createDriverHarness(questions);
  escaped.component.handleInput(KEY.enter);
  assert.match(render(escaped.component), /Second\?/);
  escaped.component.handleInput(KEY.escape);
  assert.deepEqual(await escaped.pending, { answers: [], cancelled: true }, "Esc withdraws the whole questionnaire");

  const cancelButton = createDriverHarness(questions);
  cancelButton.component.handleInput(KEY.enter);
  cancelButton.component.handleInput(KEY.enter);
  const panel = render(cancelButton.component);
  assert.match(panel, /2\/2 answered/);
  assert.match(panel, /Discard every confirmed answer and cancel the questionnaire\./);
  assert.doesNotMatch(panel, /keep any answers/);
  cancelButton.component.handleInput(KEY.down);
  cancelButton.component.handleInput(KEY.enter);
  assert.deepEqual(await cancelButton.pending, { answers: [], cancelled: true });

  const singleEscape = createDriverHarness({ questions: [question()] });
  singleEscape.component.handleInput(KEY.down);
  singleEscape.component.handleInput(KEY.escape);
  assert.deepEqual(await singleEscape.pending, { answers: [], cancelled: true });
});

test("multi-select toggles with Space and Enter, clears on custom, confirms empty, and preserves authored order", async () => {
  const ordered = createDriverHarness({ questions: [multiQuestion()] });
  ordered.component.handleInput(KEY.down);
  ordered.component.handleInput(KEY.down);
  ordered.component.handleInput(KEY.space);
  ordered.component.handleInput(KEY.up);
  ordered.component.handleInput(KEY.up);
  ordered.component.handleInput(KEY.enter);
  for (let index = 0; index < 4; index += 1) ordered.component.handleInput(KEY.down);
  ordered.component.handleInput(KEY.enter);
  assert.deepEqual(await ordered.pending, {
    answers: [{ questionIndex: 0, kind: "multi", answer: ["Logs", "Traces"] }],
  });

  const cleared = createDriverHarness({ questions: [multiQuestion()] });
  cleared.component.handleInput(KEY.space);
  for (let index = 0; index < 3; index += 1) cleared.component.handleInput(KEY.down);
  cleared.component.handleInput(KEY.enter);
  assert.doesNotMatch(render(cleared.component), /Preview/);
  cleared.component.handleInput(KEY.escape);
  cleared.component.handleInput(KEY.down);
  cleared.component.handleInput(KEY.enter);
  assert.deepEqual(await cleared.pending, {
    answers: [{ questionIndex: 0, kind: "multi", answer: [] }],
  });
});

test("inline Pi Editor supports multiline, paste, IME focus, explicit submit/cancel, empty null, and per-tab drafts", async () => {
  const drafts = createDriverHarness({ questions: [
    question(),
    question({ question: "Add a note?", header: "Note", options: [
      { label: "Skip", description: "Skip it." },
      { label: "Add", description: "Add it." },
    ] }),
  ] });
  goToCustom(drafts.component, 2);
  assert.ok(drafts.component.focused);
  assert.ok(drafts.component.render(80).some((line) => line.includes(CURSOR_MARKER)), "focused editor propagates the IME cursor marker");
  type(drafts.component, "first");
  drafts.component.handleInput(KEY.newline);
  type(drafts.component, "line");
  drafts.component.handleInput(KEY.escape);
  assert.match(render(drafts.component, 80), /Type something/);
  drafts.component.handleInput(KEY.tab);
  goToCustom(drafts.component, 2);
  drafts.component.handleInput("\x1b[200~pasted\n汉字\x1b[201~");
  drafts.component.handleInput(KEY.escape);
  drafts.component.handleInput(KEY.shiftTab);
  drafts.component.handleInput(KEY.enter);
  const restored = render(drafts.component, 80);
  assert.match(restored, /first/);
  assert.match(restored, /line/);
  drafts.component.handleInput(KEY.enter);
  assert.match(render(drafts.component), /Add a note/);
  drafts.component.handleInput(KEY.enter);
  drafts.component.handleInput(KEY.enter);
  assert.match(render(drafts.component), /2\/2 answered/);
  drafts.component.handleInput(KEY.enter);
  assert.deepEqual(await drafts.pending, {
    answers: [
      { questionIndex: 0, kind: "custom", answer: "first\nline" },
      { questionIndex: 1, kind: "custom", answer: "pasted\n汉字" },
    ],
  });

  const empty = createDriverHarness({ questions: [question()] });
  goToCustom(empty.component, 2);
  empty.component.handleInput(KEY.enter);
  assert.deepEqual(await empty.pending, {
    answers: [{ questionIndex: 0, kind: "custom", answer: null }],
  });

  const pasted = createDriverHarness({ questions: [question()] });
  goToCustom(pasted.component, 2);
  pasted.component.handleInput("\x1b[200~pasted\n汉字\x1b[201~");
  pasted.component.handleInput(KEY.enter);
  assert.deepEqual(await pasted.pending, {
    answers: [{ questionIndex: 0, kind: "custom", answer: "pasted\n汉字" }],
  });
});

test("Submit supports partial and zero answers while Cancel discards every confirmed answer", async () => {
  const questions = { questions: [question(), question({ question: "Second?", header: "Second" })] };
  const partial = createDriverHarness(questions);
  partial.component.handleInput(KEY.enter);
  partial.component.handleInput(KEY.tab);
  assert.match(render(partial.component), /1\/2 answered/);
  assert.match(render(partial.component), /Unanswered: Second/);
  partial.component.handleInput(KEY.enter);
  assert.deepEqual(await partial.pending, { answers: [{ questionIndex: 0, kind: "option", answer: "Safe" }] });

  const zero = createDriverHarness(questions);
  zero.component.handleInput(KEY.left);
  assert.match(render(zero.component), /0\/2 answered/);
  zero.component.handleInput(KEY.enter);
  assert.deepEqual(await zero.pending, { answers: [] });
  assert.deepEqual(buildAskResult(zero.questionnaire, { answers: [] }), {
    answers: [], cancelled: true, partial: true, cancelReason: "empty_submit",
  });

  const cancelled = createDriverHarness(questions);
  cancelled.component.handleInput(KEY.down);
  cancelled.component.handleInput(KEY.enter);
  cancelled.component.handleInput(KEY.escape);
  assert.deepEqual(await cancelled.pending, { answers: [], cancelled: true });

  const cancelButton = createDriverHarness(questions);
  cancelButton.component.handleInput(KEY.left);
  cancelButton.component.handleInput(KEY.down);
  cancelButton.component.handleInput(KEY.enter);
  assert.deepEqual(await cancelButton.pending, { answers: [], cancelled: true });
});

test("preview is full markdown, wide two-column, narrow stacked, empty-state aware, hidden in custom, and width-safe", async () => {
  const sentinel = "PREVIEW_END_SENTINEL";
  const harness = createDriverHarness({ questions: [question({ options: [
    { label: "Safe", description: "Use the safe path.", preview: `# Preview\n\n${"complete preview content ".repeat(16)}${sentinel}` },
    { label: "Fast", description: "Use the fast path." },
  ] })] });
  const wideLines = renderLines(harness.component, 120);
  assert.ok(wideLines.every((line) => visibleWidth(line) <= 120));
  assert.match(wideLines.join("\n"), /1\. Safe.*Preview/);
  assert.match(wideLines.join("\n"), new RegExp(sentinel));
  harness.component.handleInput(KEY.down);
  assert.match(render(harness.component, 120), /No preview for this option/);
  const narrowLines = renderLines(harness.component, 72);
  assert.ok(narrowLines.every((line) => visibleWidth(line) <= 72));
  const narrow = narrowLines.join("\n");
  assert.ok(narrow.indexOf("2. Fast") < narrow.indexOf("Preview"), "narrow preview is stacked below the options");
  harness.component.handleInput(KEY.down);
  harness.component.handleInput(KEY.enter);
  const customLines = renderLines(harness.component, 34);
  assert.ok(customLines.every((line) => visibleWidth(line) <= 34));
  assert.doesNotMatch(customLines.join("\n"), /Preview|No preview/);
  harness.component.handleInput(KEY.escape);
  harness.component.handleInput(KEY.escape);
  await harness.pending;
});

test("authored Ask fields strip ANSI, OSC, C0, and C1 only in the TUI projection while preview newlines and params stay intact", async () => {
  const colorOpen = "\x1b[38;2;1;2;3m";
  const colorClose = "\x1b[0m";
  const oscOpen = "\x1b]8;;https://evil.example\x07";
  const oscClose = "\x1b]8;;\x07";
  const shortOsc = "\x1b]0;\x07";
  const params = { questions: [{
    question: `Question ${colorOpen}red${colorClose}?\x00\nSecond\x01 line`,
    header: `H${shortOsc}e\x00\nX`,
    options: [
      {
        label: `Sa${colorOpen}fe${colorClose}\x00`,
        description: `First ${oscOpen}description${oscClose}\x00\ncontinued\x85`,
        preview: `# Pre${colorOpen}view${colorClose}\n\npreview\x00 line one\n${oscOpen}preview line two${oscClose}\nPREVIEW_END\x85`,
      },
      {
        label: `Fa${oscOpen}st${oscClose}\x1f`,
        description: `Second ${colorOpen}description${colorClose}\x7f`,
      },
    ],
  }] };
  const originalParams = structuredClone(params);
  const harness = createDriverHarness(params);
  const originalValidated = structuredClone(harness.questionnaire);
  const raw = harness.component.render(120).join("\n");
  const displayed = stripVTControlCharacters(raw);

  assert.match(displayed, /He  X/);
  assert.match(displayed, /Question red\? /);
  assert.match(displayed, /Second  line/);
  assert.match(displayed, /1\. Safe /);
  assert.match(displayed, /First description /);
  assert.match(displayed, /continued /);
  assert.match(displayed, /2\. Fast /);
  assert.match(displayed, /Second description /);
  assert.match(displayed, /Preview/);
  assert.match(displayed, /preview  line one/);
  assert.match(displayed, /preview line two/);
  assert.match(displayed, /PREVIEW_END /);
  assert.ok(displayed.indexOf("Preview") < displayed.indexOf("preview  line one"));
  assert.ok(displayed.indexOf("preview  line one") < displayed.indexOf("preview line two"));
  assert.ok(displayed.indexOf("preview line two") < displayed.indexOf("PREVIEW_END"));

  assert.equal(raw.includes(colorOpen), false);
  assert.equal(raw.includes(oscOpen), false);
  assert.equal(raw.includes(oscClose), false);
  assert.equal(raw.includes(shortOsc), false);
  assert.equal(raw.includes("\x00"), false);
  assert.equal(raw.includes("\x01"), false);
  assert.equal(raw.includes("\x1f"), false);
  assert.equal(raw.includes("\x7f"), false);
  assert.equal(raw.includes("\x85"), false);
  assert.deepEqual(params, originalParams);
  assert.deepEqual(harness.questionnaire, originalValidated);

  harness.component.handleInput(KEY.escape);
  await harness.pending;
});

test("Abort closes the overlay exactly once, rejects AbortError, removes listeners, and normal completion also cleans up", async () => {
  const controller = new AbortController();
  let adds = 0;
  let removes = 0;
  const originalAdd = controller.signal.addEventListener.bind(controller.signal);
  const originalRemove = controller.signal.removeEventListener.bind(controller.signal);
  controller.signal.addEventListener = (...args) => { adds += 1; return originalAdd(...args); };
  controller.signal.removeEventListener = (...args) => { removes += 1; return originalRemove(...args); };
  const aborted = createDriverHarness({ questions: [question()] }, controller);
  controller.abort("tree moved");
  await assert.rejects(aborted.pending, (error) => error.name === "AbortError" && /tree moved/.test(error.message));
  assert.equal(aborted.doneCalls, 1);
  assert.equal(adds, 1);
  assert.equal(removes, 1);
  controller.abort("again");
  assert.equal(aborted.doneCalls, 1);

  const normalController = new AbortController();
  let normalRemoves = 0;
  const normalRemove = normalController.signal.removeEventListener.bind(normalController.signal);
  normalController.signal.removeEventListener = (...args) => { normalRemoves += 1; return normalRemove(...args); };
  const normal = createDriverHarness({ questions: [question()] }, normalController);
  normal.component.handleInput(KEY.enter);
  await normal.pending;
  assert.equal(normal.doneCalls, 1);
  assert.equal(normalRemoves, 1);
  normalController.abort("stale");
  assert.equal(normal.doneCalls, 1, "a completed driver leaves no stale abort listener");
});

test("AskRuntime reset drops old TUI context, can rebind cleanly, RPC never uses custom overlay, and headless never opens UI", async () => {
  const tools = new Map();
  const pi = {
    registerTool(tool) { tools.set(tool.name, tool); },
    getActiveTools() { return [...tools.keys()]; },
    setActiveTools() {},
    getAllTools() { return [...tools.values()]; },
  };
  let oldCalls = 0;
  let newCalls = 0;
  const runtime = new AskRuntime(pi, { tuiDriver: { async ask() { oldCalls += 1; return { answers: [] }; } } });
  runtime.reset();
  await assert.rejects(runtime.execute({ questions: [question()] }, undefined, { mode: "tui", hasUI: true, ui: {} }), /no TUI driver is configured/);
  assert.equal(oldCalls, 0);
  runtime.setTuiDriver({ async ask() { newCalls += 1; return { answers: [{ questionIndex: 0, kind: "option", answer: "Safe" }] }; } });
  const rebound = await runtime.execute({ questions: [question()] }, undefined, { mode: "tui", hasUI: true, ui: {} });
  assert.equal(newCalls, 1);
  assert.equal(rebound.answers[0].answer, "Safe");

  let customCalls = 0;
  const rpcUi = {
    custom() { customCalls += 1; throw new Error("custom overlay must not open"); },
    async select() { return "Option 1: Safe"; },
    async input() { return "unused"; },
  };
  const rpc = await runtime.execute({ questions: [question()] }, undefined, { mode: "rpc", hasUI: true, ui: rpcUi });
  assert.equal(rpc.answers[0].answer, "Safe");
  assert.equal(customCalls, 0);
  assert.equal(newCalls, 1);
  await assert.rejects(runtime.execute({ questions: [question()] }, undefined, { mode: "print", hasUI: false, ui: rpcUi }), /UI is unavailable in print mode/);
  assert.equal(customCalls, 0);

  const rpcDriver = createRpcAskDriver(rpcUi);
  await rpcDriver.ask(validateQuestionnaire({ questions: [question()] }), new AbortController().signal);
  assert.equal(customCalls, 0);
});

test("main lifecycle binds fresh TUI drivers and clears them before switch, fork, tree, and shutdown", () => {
  const source = readFileSync(new URL("../extensions/oh-my-pi-slim/index.ts", import.meta.url), "utf8");
  for (const event of ["session_start", "session_tree"]) {
    const start = source.indexOf(`pi.on("${event}"`);
    const end = source.indexOf("pi.on(\"", start + 8);
    assert.match(source.slice(start, end < 0 ? undefined : end), /bindAskDriver\(ctx\)/);
  }
  for (const event of ["session_before_switch", "session_before_fork", "session_before_tree", "session_shutdown"]) {
    const start = source.indexOf(`pi.on("${event}"`);
    const end = source.indexOf("pi.on(\"", start + 8);
    const handler = source.slice(start, end < 0 ? undefined : end);
    assert.match(handler, /asks\.abortAll\(/);
    assert.match(handler, /bindAskDriver\(\)/);
    assert.ok(handler.indexOf("asks.abortAll(") < handler.indexOf("bindAskDriver()"));
  }
  assert.match(source, /new AskTuiDriver\(ctx\.ui, \{ beforeOpen: \(\) => subagentViewer\.closeAsync\(\) \}\)/);
});

/* ------------------------------------------------------------------------------------------------
 * Ask and the read-only Subagent viewer never stack: the viewer closes first, and Ask waits for it.
 * ---------------------------------------------------------------------------------------------- */

function viewerSnapshotForTests() {
  return {
    runs: [{
      id: "run-a",
      agent: "fixer",
      abstract: "fix it",
      status: "running",
      live: true,
      model: "provider/model",
      createdAt: "2026-04-17T00:00:00.000Z",
      updatedAt: "2026-04-17T00:00:00.000Z",
      activity: { turnCount: 0, toolUses: 0, activeTools: {}, responseText: "", tokens: 0, compactionCount: 0 },
    }],
    childSessionDir: undefined,
  };
}

function createViewerAskHost() {
  const events = [];
  const timers = [];
  const host = createOverlayHost({ rows: 40, columns: 140, theme });
  const ui = {
    notify() {},
    custom(factory, options) {
      events.push(`custom:${host.entries().length}`);
      return host.custom(factory, options, { onResolve: () => events.push("done") });
    },
  };
  const viewer = createSubagentViewer({
    snapshot: viewerSnapshotForTests,
    loadTranscript: () => ({ status: "waiting", transcript: { status: "waiting", entries: [], hiddenEntries: 0 } }),
    setInterval: (callback, ms) => {
      const timer = { callback, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearInterval: (timer) => { timer.cleared = true; },
  });
  return { events, host, timers, ui, viewer };
}

test("Ask closes the read-only viewer before it opens its own overlay", async () => {
  const { events, host, timers, ui, viewer } = createViewerAskHost();
  const viewerOpen = viewer.handleShortcut(ui, 1, { enabled: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(viewer.isOpen(), true);
  assert.equal(host.entries().length, 1);
  const viewerComponent = host.entries()[0].component;

  const driver = new AskTuiDriver(ui, { beforeOpen: () => viewer.closeAsync() });
  const controller = new AbortController();
  const pending = driver.ask(validateQuestionnaire({ questions: [question()] }), controller.signal);
  await viewerOpen;
  await new Promise((resolve) => setImmediate(resolve));

  // The viewer's overlay entry is gone before Ask asks for one, so the two can never stack. The
  // viewer removes itself through its own handle, so the host's `done` never runs for it.
  assert.deepEqual(events, ["custom:0", "custom:0"]);
  assert.equal(viewer.isOpen(), false);
  assert.equal(host.contains(viewerComponent), false, "no zombie viewer entry may survive");
  assert.equal(host.entries().length, 1, "only the questionnaire may be mounted");
  assert.equal(host.focusedComponent(), host.entries()[0].component);
  assert.equal(timers.every((timer) => timer.cleared), true, "the viewer refresh timer must be cleared");

  controller.abort();
  await assert.rejects(pending, /aborted/i);
  assert.equal(host.entries().length, 0);
});

test("Ask still opens when the viewer sits under a foreign overlay, and pops neither", async () => {
  const { events, host, timers, ui, viewer } = createViewerAskHost();
  const viewerOpen = viewer.handleShortcut(ui, 1, { enabled: true });
  await new Promise((resolve) => setImmediate(resolve));
  const viewerComponent = host.entries()[0].component;
  const foreign = host.pushForeignOverlay();
  assert.equal(host.entries().length, 2);

  const driver = new AskTuiDriver(ui, { beforeOpen: () => viewer.closeAsync() });
  const controller = new AbortController();
  const pending = driver.ask(validateQuestionnaire({ questions: [question()] }), controller.signal);
  await viewerOpen;
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(events, ["custom:0", "custom:1"]);
  assert.equal(viewer.isOpen(), false);
  assert.equal(host.contains(viewerComponent), false, "only the viewer entry may be removed");
  assert.equal(host.contains(foreign.component), true, "the foreign overlay must survive");
  assert.equal(host.entries().length, 2, "the foreign overlay plus the questionnaire");
  assert.equal(timers.every((timer) => timer.cleared), true);

  controller.abort();
  await assert.rejects(pending, /aborted/i);
  assert.deepEqual(host.components(), [foreign.component], "closing Ask returns to the foreign overlay");
});
