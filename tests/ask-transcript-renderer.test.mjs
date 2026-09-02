import assert from "node:assert/strict";
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
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    const url = dependencyMap[specifier];
    return url ? { url, shortCircuit: true } : nextResolve(specifier, context);
  },
});

const { initTheme } = await import("@earendil-works/pi-coding-agent");
const { visibleWidth } = await import("@earendil-works/pi-tui");
initTheme(undefined, false);
const { AskRuntime, askResultModelContent, buildAskResult, validateQuestionnaire } = await import("../extensions/oh-my-pi-slim/ask-runtime.ts");
const { renderAskCall, renderAskResult } = await import("../extensions/oh-my-pi-slim/ask-transcript-renderer.ts");

const theme = {
  fg: (_color, text) => text,
  bg: (_color, text) => text,
  bold: (text) => text,
};

const args = {
  questions: [
    {
      question: "Which path should we take?",
      header: "Path",
      options: [
        { label: "Safe", description: "Use every safety check.", preview: "# Full safe preview\n\nPREVIEW_BODY_SENTINEL" },
        { label: "Fast", description: "Optimize for speed." },
      ],
    },
    {
      question: "Which extras should be included?",
      header: "Extras",
      multiSelect: true,
      options: [
        { label: "Logs", description: "Include logs." },
        { label: "Metrics", description: "Include metrics." },
        { label: "Traces", description: "Include traces." },
      ],
    },
    {
      question: "Any final note?",
      header: "Note",
      options: [
        { label: "Skip", description: "Do not add a note." },
        { label: "Add", description: "Add a note." },
      ],
    },
  ],
};

function renderLines(component, width = 240) {
  return component.render(width).map((line) => stripVTControlCharacters(line).trimEnd());
}

function render(component, width = 240) {
  return renderLines(component, width).join("\n").replace(/^\n+|\n+$/g, "");
}

function containsAll(text, values) {
  for (const value of values) assert.match(text, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
}

test("Ask call Ctrl+O rendering keeps the exact collapsed title, headers, full expanded schema, no Action row, and input invariance", () => {
  const before = structuredClone(args);
  const collapsedComponent = renderAskCall(args, theme, { expanded: false });
  const collapsed = render(collapsedComponent);
  assert.equal(collapsed.split("\n")[0], "ask_user_question · 3 questions (ctrl+o to expand)");
  containsAll(collapsed, ["1: Path", "2: Extras", "3: Note"]);
  assert.doesNotMatch(collapsed, /Which path|Use every safety|PREVIEW_BODY|Multi-select|Options:|Action:/);

  const expanded = render(renderAskCall(args, theme, { expanded: true }));
  assert.equal(expanded.split("\n")[0], "ask_user_question · 3 questions");
  containsAll(expanded, [
    "1. Path", "Question:", "Which path should we take?", "Header: Path", "Multi-select: false",
    "Options:", "1. Safe", "Description:", "Use every safety check.", "Preview:", "Full safe preview",
    "PREVIEW_BODY_SENTINEL", "2. Fast", "Optimize for speed.", "2. Extras", "Multi-select: true",
    "Logs", "Metrics", "Traces", "3. Note", "Any final note?", "Do not add a note.", "Add a note.",
  ]);
  assert.doesNotMatch(expanded, /\(ctrl\+o to expand\)|Action:/);
  assert.deepEqual(args, before);
  const narrow = renderLines(renderAskCall(args, theme, { expanded: true }), 38);
  assert.ok(narrow.every((line) => visibleWidth(line) <= 38));
});

test("Ask result collapsed summaries distinguish complete, partial, cancelled, and empty submit with one leading blank line", () => {
  const questionnaire = validateQuestionnaire(args);
  const complete = buildAskResult(questionnaire, { answers: [
    { questionIndex: 0, kind: "option", answer: "Safe" },
    { questionIndex: 1, kind: "multi", answer: [] },
    { questionIndex: 2, kind: "custom", answer: null },
  ] });
  const partial = buildAskResult(questionnaire, { answers: [{ questionIndex: 0, kind: "option", answer: "Fast" }] });
  const cancelled = buildAskResult(questionnaire, {
    answers: [{ questionIndex: 1, kind: "multi", answer: ["Traces", "Logs"] }],
    cancelled: true,
  });
  const empty = buildAskResult(questionnaire, { answers: [] });
  const cases = [
    [complete, "✓  Answered 3/3 · complete"],
    [partial, "◐  Answered 1/3 · partial"],
    // A new cancel discards every answer, so the honest summary is 0/3.
    [cancelled, "!  Cancelled · 0/3 answered · user cancelled"],
    [empty, "!  Cancelled · 0/3 answered · empty submit"],
  ];
  for (const [details, expected] of cases) {
    const component = renderAskResult({ content: [{ type: "text", text: "MODEL_CONTENT_SENTINEL" }], details }, { expanded: false }, theme, { args });
    const lines = renderLines(component);
    assert.equal(lines[0], "");
    assert.equal(render(component), expected);
    assert.doesNotMatch(render(component), /MODEL_CONTENT_SENTINEL|Question:|Answer:|Unanswered/);
    assert.doesNotMatch(render(component), /[✓◐!] [^ ]|[✓◐!] {3}/);
  }
});

test("Ask result rendering prioritizes details while compact JSON remains a safe fallback", () => {
  const questionnaire = validateQuestionnaire(args);
  const details = buildAskResult(questionnaire, { answers: [
    { questionIndex: 0, kind: "option", answer: "Safe" },
    { questionIndex: 1, kind: "multi", answer: ["Logs"] },
    { questionIndex: 2, kind: "custom", answer: "line one\nline two" },
  ] });
  const content = askResultModelContent(details, questionnaire);
  const result = { content: [{ type: "text", text: content }], details };

  const collapsed = render(renderAskResult(result, { expanded: false }, theme, { args }));
  assert.equal(collapsed, "✓  Answered 3/3 · complete");
  assert.doesNotMatch(collapsed, /outcome|questionIndex|line one/);
  const expanded = render(renderAskResult(result, { expanded: true }, theme, { args }));
  containsAll(expanded, ["Answered 3/3 · complete", "Safe", "- Logs", "line one", "line two"]);
  assert.doesNotMatch(expanded, /"outcome"|"questionIndex"/);

  const fallback = render(renderAskResult({ content: result.content, details: { answers: "malformed" } }, { expanded: false }, theme, { args }), 1000);
  assert.equal(fallback, content);
  assert.equal(content.includes("\n"), false);
  assert.match(fallback, /line one\\nline two/);
});

test("a new cancel renders an honest empty result in both densities", () => {
  const questionnaire = validateQuestionnaire(args);
  const details = buildAskResult(questionnaire, {
    answers: [{ questionIndex: 0, kind: "option", answer: "Safe" }],
    cancelled: true,
  });
  assert.deepEqual(details, { answers: [], cancelled: true, partial: true, cancelReason: "user_cancelled" });
  const collapsed = render(renderAskResult({ details }, { expanded: false }, theme, { args }));
  assert.equal(collapsed, "!  Cancelled · 0/3 answered · user cancelled");
  const expanded = render(renderAskResult({ details }, { expanded: true }, theme, { args }));
  containsAll(expanded, [
    "Cancelled · 0/3 answered · user cancelled", "Cancelled: true", "Partial: true", "Cancel reason: user_cancelled",
    "Answers", "No answers were confirmed.",
    "Unanswered", "1. Path", "2. Extras", "3. Note",
  ]);
  assert.doesNotMatch(expanded, /Safe|Kind:|Selected preview/);
});

test("the renderer replays historical cancelled details with answers untouched", () => {
  // Transcripts written before cancel discarded answers still carry them. The renderer is a pure
  // projection of the recorded details, so it must show that history exactly as it was stored.
  const legacyDetails = {
    answers: [
      {
        questionIndex: 0,
        question: "Which path should we take?",
        header: "Path",
        kind: "option",
        answer: "Safe",
        selected: ["Safe"],
        preview: "# Full safe preview\n\nPREVIEW_BODY_SENTINEL",
      },
      { questionIndex: 1, question: "Which extras should be included?", header: "Extras", kind: "multi", answer: ["Logs"], selected: ["Logs"] },
    ],
    cancelled: true,
    partial: true,
    cancelReason: "user_cancelled",
  };
  const legacyContent = "Questionnaire not completed because the user cancelled it.\nPartial confirmed answers:";
  const legacyResult = { content: [{ type: "text", text: legacyContent }], details: legacyDetails };
  const before = structuredClone(legacyResult);

  const collapsed = render(renderAskResult(legacyResult, { expanded: false }, theme, { args }));
  assert.equal(collapsed, "!  Cancelled · 2/3 answered · user cancelled");
  const expanded = render(renderAskResult(legacyResult, { expanded: true }, theme, { args }));
  containsAll(expanded, [
    "Cancelled · 2/3 answered · user cancelled", "Cancel reason: user_cancelled",
    "1. Path", "Kind: option", "Safe", "Selected preview:", "PREVIEW_BODY_SENTINEL",
    "2. Extras", "Kind: multi", "- Logs", "Unanswered", "3. Note",
  ]);
  assert.doesNotMatch(expanded, /No answers were confirmed/);

  // The renderer never rewrites the model-facing content or the recorded details.
  assert.deepEqual(legacyResult, before);
  assert.equal(legacyResult.content[0].text, legacyContent);
  assert.deepEqual(legacyResult.details, legacyDetails);
});

test("expanded Ask result shows complete answers, selected preview, empty values, unanswered questions, cancel reason, and data invariance", () => {
  const questionnaire = validateQuestionnaire(args);
  const details = {
    ...buildAskResult(questionnaire, {
      answers: [
        { questionIndex: 0, kind: "option", answer: "Safe" },
        { questionIndex: 1, kind: "multi", answer: [] },
      ],
    }),
    cancelled: true,
    cancelReason: "user_cancelled",
  };
  const result = {
    content: [{ type: "text", text: "MODEL_CONTENT_MUST_STAY_EXACT\nSECOND_MODEL_LINE" }],
    details,
  };
  const before = structuredClone(result);
  const component = renderAskResult(result, { expanded: true }, theme, { args });
  const lines = renderLines(component);
  assert.equal(lines[0], "");
  const expanded = render(component);
  containsAll(expanded, [
    "Cancelled · 2/3 answered · user cancelled", "Cancelled: true", "Partial: true", "Cancel reason: user_cancelled",
    "Answers", "1. Path", "Which path should we take?", "Kind: option", "Answer:", "Safe",
    "Selected:", "- Safe", "Selected preview:", "Full safe preview", "PREVIEW_BODY_SENTINEL",
    "2. Extras", "Kind: multi", "(no options selected)", "Selected:", "(none)",
    "Unanswered", "3. Note", "Any final note?",
  ]);
  assert.doesNotMatch(expanded, /MODEL_CONTENT_MUST_STAY_EXACT|SECOND_MODEL_LINE|\(ctrl\+o to expand\)/);
  assert.deepEqual(result, before);
  assert.equal(result.content[0].text, before.content[0].text);
  assert.deepEqual(result.details, before.details);
  const narrow = renderLines(component, 42);
  assert.ok(narrow.every((line) => visibleWidth(line) <= 42));
});

test("expanded custom result preserves multiline and empty custom answers", () => {
  const questionnaire = validateQuestionnaire(args);
  const details = buildAskResult(questionnaire, { answers: [
    { questionIndex: 0, kind: "custom", answer: "line one\nline two" },
    { questionIndex: 1, kind: "multi", answer: ["Metrics", "Logs"] },
    { questionIndex: 2, kind: "custom", answer: "" },
  ] });
  const expanded = render(renderAskResult({ details }, { expanded: true }, theme, { args }));
  containsAll(expanded, [
    "line one", "line two", "Selected:", "- Logs", "- Metrics", "(empty custom response)", "Unanswered", "(none)",
  ]);
  assert.ok(expanded.indexOf("- Logs") < expanded.indexOf("- Metrics"), "selected values remain in authored order");
});

test("Ask renderer safely falls back for errors and malformed details without mutating content", () => {
  const result = {
    content: [{ type: "text", text: "Ask error\u0000 first line\nFULL_ERROR_SECOND\nFULL_ERROR_THIRD" }],
    details: { answers: "malformed" },
  };
  const before = structuredClone(result);
  const collapsedComponent = renderAskResult(result, { expanded: false, isError: true }, theme, { args });
  assert.equal(renderLines(collapsedComponent)[0], "");
  assert.equal(render(collapsedComponent), "Ask error  first line");
  assert.doesNotMatch(render(collapsedComponent), /FULL_ERROR_SECOND|\u0000/);
  const expanded = render(renderAskResult(result, { expanded: true, isError: true }, theme, { args }));
  containsAll(expanded, ["Ask error  first line", "FULL_ERROR_SECOND", "FULL_ERROR_THIRD"]);
  assert.deepEqual(result, before);

  const pending = render(renderAskResult({ content: [] }, { expanded: false, isPartial: true }, theme, { args }));
  assert.match(pending, /Result pending/);
  const malformedCall = render(renderAskCall({ questions: "bad" }, theme, { expanded: false }));
  assert.equal(malformedCall, "ask_user_question · 0 questions (ctrl+o to expand)");
});

test("AskRuntime registers the package-isomorphic call and result renderers", () => {
  const tools = new Map();
  const pi = { on() {}, registerTool(tool) { tools.set(tool.name, tool); } };
  const runtime = new AskRuntime(pi);
  runtime.registerTool();
  const tool = tools.get("ask_user_question");
  assert.equal(tool.renderCall, renderAskCall);
  assert.equal(tool.renderResult, renderAskResult);
});
