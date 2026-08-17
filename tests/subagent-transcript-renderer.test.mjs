import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { pathToFileURL } from "node:url";
import test from "node:test";

const piEntry = realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim());
const piRoot = dirname(dirname(piEntry));
const dependencyMap = {
  "@earendil-works/pi-coding-agent": pathToFileURL(`${piRoot}/dist/index.js`).href,
  "@earendil-works/pi-tui": pathToFileURL(`${piRoot}/node_modules/@earendil-works/pi-tui/dist/index.js`).href,
  "./subagent-core.js": new URL("../extensions/oh-my-pi-slim/subagent-core.ts", import.meta.url).href,
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    const url = dependencyMap[specifier];
    return url ? { url, shortCircuit: true } : nextResolve(specifier, context);
  },
});

const {
  renderSubagentCall,
  renderSubagentNotification,
  renderSubagentResult,
} = await import("../extensions/oh-my-pi-slim/subagent-transcript-renderer.ts");

const theme = {
  fg: (_color, text) => text,
  bg: (_color, text) => text,
  bold: (text) => text,
};

function renderLines(component, width = 240) {
  return component.render(width).map((line) => stripVTControlCharacters(line).trimEnd());
}

function render(component, width = 240) {
  return renderLines(component, width)
    .join("\n")
    .replace(/^\n+|\n+$/g, "");
}

function assertFull(text, expected) {
  for (const value of expected) assert.match(text, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(text, /\bpreview\b|\btruncated\b|\.\.\. \d+ more/i);
}

function run(overrides = {}) {
  return {
    id: "run-1",
    agent: "fixer",
    abstract: "Concise run abstract",
    task: "Low-value task text that results must not repeat",
    cwd: "/workspace/project",
    model: "openai/gpt-5.6-sol:xhigh",
    deniedTools: ["ask_user_question"],
    status: "completed",
    createdAt: "2026-04-17T00:00:00.000Z",
    updatedAt: "2026-04-17T00:02:03.000Z",
    sourceRunId: "source-run-0",
    sessionFile: "/sessions/child.jsonl",
    live: false,
    waitingSeq: 1,
    request: {
      runId: "run-1",
      reason: "need_decision",
      message: "Full request message\n<results>request payload</results>",
      interview: { title: "Choose", questions: [{ prompt: "A or B?" }] },
      createdAt: "2026-04-17T00:01:00.000Z",
    },
    activity: {
      turnCount: 3,
      toolUses: 4,
      activeTools: { toolA: { name: "read", startedAt: "2026-04-17T00:01:30.000Z" } },
      responseText: "Live response text\n<results>activity payload</results>",
      tokens: 8200,
      contextPercent: 31,
      compactionCount: 2,
    },
    output: "Complete output line one\n<results>stored output payload</results>\nComplete output line three",
    error: "Complete error line one\n<results>stored error payload</results>\nComplete error line three",
    ...overrides,
  };
}

test("Ctrl+O expands complete action-specific call input without duplicate Action rows", () => {
  const createArgs = {
    action: "create",
    agent: "fixer",
    abstract: "Create concise abstract",
    task: "Create task line one\n<results>create task payload</results>\nCreate task line three",
    cwd: "/full/create/cwd",
  };
  const createCollapsed = render(renderSubagentCall(createArgs, theme, { cwd: "/context/cwd", expanded: false }));
  assertFull(createCollapsed, ["subagent · create (ctrl+o to expand)", "Agent: fixer", "Abstract: Create concise abstract"]);
  assert.doesNotMatch(createCollapsed, /Action:|Cwd:|full\/create|Task:|create task payload/);
  const createExpanded = render(renderSubagentCall(createArgs, theme, { cwd: "/context/cwd", expanded: true }));
  assertFull(createExpanded, ["subagent · create", "Agent: fixer", "Abstract: Create concise abstract", "/full/create/cwd", "Create task line one", "<results>create task payload</results>", "Create task line three"]);

  const resumeArgs = {
    action: "resume", id: "source-run-full", abstract: "Fresh continuation abstract",
    message: "Continuation line one\nContinuation line two",
  };
  const resumeCollapsed = render(renderSubagentCall(resumeArgs, theme, { expanded: false }));
  assertFull(resumeCollapsed, ["subagent · resume (ctrl+o to expand)", "Source run: source-run-full", "Abstract: Fresh continuation abstract"]);
  assert.doesNotMatch(resumeCollapsed, /Action:|Continuation task|Continuation line/);
  const resumeExpanded = render(renderSubagentCall(resumeArgs, theme, { expanded: true }));
  assertFull(resumeExpanded, ["subagent · resume", "Source run: source-run-full", "Abstract: Fresh continuation abstract", "Continuation line one", "Continuation line two"]);

  const steerArgs = { action: "steer", id: "run-steer-full", message: "Guidance line one\n<results>guidance payload</results>" };
  const steerCollapsed = render(renderSubagentCall(steerArgs, theme, { expanded: false }));
  assertFull(steerCollapsed, ["subagent · steer (ctrl+o to expand)", "Run: run-steer-full"]);
  assert.doesNotMatch(steerCollapsed, /Action:|Guidance|guidance payload/);
  const steerExpanded = render(renderSubagentCall(steerArgs, theme, { expanded: true }));
  assertFull(steerExpanded, ["subagent · steer", "Run: run-steer-full", "Guidance line one", "<results>guidance payload</results>"]);

  const replyArgs = { action: "reply", id: "run-full", message: "Reply line one\n<results>reply payload</results>\nReply line three" };
  const replyCollapsed = render(renderSubagentCall(replyArgs, theme, { expanded: false }));
  assertFull(replyCollapsed, ["subagent · reply (ctrl+o to expand)", "Run: run-full"]);
  assert.doesNotMatch(replyCollapsed, /Action:|Reply:|reply payload|Reply line/);
  const replyExpanded = render(renderSubagentCall(replyArgs, theme, { expanded: true }));
  assertFull(replyExpanded, ["subagent · reply", "Run: run-full", "Reply line one", "<results>reply payload</results>", "Reply line three"]);

  const interruptCollapsed = render(renderSubagentCall({ action: "interrupt", id: "run-interrupt-full" }, theme, { expanded: false }));
  const interruptExpanded = render(renderSubagentCall({ action: "interrupt", id: "run-interrupt-full" }, theme, { expanded: true }));
  assert.equal(interruptCollapsed, "subagent · interrupt (ctrl+o to expand)\nRun: run-interrupt-full");
  assert.equal(interruptExpanded, "subagent · interrupt\nRun: run-interrupt-full");

  const listCollapsed = render(renderSubagentCall({ action: "list" }, theme, { expanded: false }));
  assert.equal(listCollapsed, "subagent · list (ctrl+o to expand)");
  const listExpanded = render(renderSubagentCall({ action: "list" }, theme, { expanded: true }));
  assertFull(listExpanded, ["subagent · list", "starting, running, and waiting", "abstract", "waiting reason"]);
  assert.doesNotMatch(listExpanded, /output|error|activity|task/i);

  for (const value of [createCollapsed, resumeCollapsed, steerCollapsed, replyCollapsed, interruptCollapsed, listCollapsed]) {
    assert.match(value.split("\n")[0], /\(ctrl\+o to expand\)$/);
    assert.doesNotMatch(value, /Action:/);
  }
  for (const value of [createExpanded, resumeExpanded, steerExpanded, replyExpanded, interruptExpanded, listExpanded]) {
    assert.doesNotMatch(value, /\(ctrl\+o to expand\)|Action:/);
  }
});

test("tool results start with one blank separator line", () => {
  const subagent = renderLines(renderSubagentResult(
    { details: { run: run({ id: "spacing-run", agent: "explorer", status: "starting", output: undefined, error: undefined }) } },
    { expanded: false, isPartial: false }, theme, { args: { action: "create", agent: "explorer", task: "spacing task" } },
  ));
  assert.equal(subagent[0], "");
  assert.equal(subagent[1], "✓ Started explorer [spacing-run] · starting");

  const reply = renderLines(renderSubagentResult(
    { details: { run: run({ id: "spacing-reply", agent: "fixer", status: "running" }) } },
    { expanded: false, isPartial: false }, theme, { args: { action: "reply", id: "spacing-reply", message: "continue" } },
  ));
  assert.equal(reply[0], "");
  assert.equal(reply[1], "✓ Replied · fixer [spacing-reply] · running");
});

test("subagent immediate results use accurate compact action acknowledgements", () => {
  const created = render(renderSubagentResult(
    { details: { run: run({ id: "create-id", agent: "explorer", status: "starting", output: undefined, error: undefined }) } },
    { expanded: false, isPartial: false }, theme, { args: { action: "create", agent: "explorer", task: "full task" } },
  ));
  assert.equal(created, "✓ Started explorer [create-id] · starting");
  assert.doesNotMatch(created, /Subagent result|Task|Cwd|Tools|Model|Activity|Response|Session/);

  const resume = render(renderSubagentResult(
    { details: { run: run({ id: "resume-id", agent: "explorer", status: "starting", output: undefined, error: undefined }) } },
    { expanded: false, isPartial: false }, theme, { args: { action: "resume", id: "source-id", abstract: "new summary", message: "continue" } },
  ));
  assert.equal(resume, "✓ Resumed [source-id] → explorer [resume-id] · starting");

  const steer = render(renderSubagentResult(
    { details: { run: run({ id: "steer-id", agent: "explorer", status: "running", output: undefined, error: undefined }) } },
    { expanded: false, isPartial: false }, theme, { args: { action: "steer", id: "steer-id", message: "focus" } },
  ));
  assert.equal(steer, "✓ Steer requested · explorer [steer-id] · running");

  const reply = render(renderSubagentResult(
    { details: { run: run({ id: "reply-id", agent: "fixer", status: "running", output: undefined, error: undefined }) } },
    { expanded: false, isPartial: false }, theme, { args: { action: "reply", id: "reply-id", message: "continue" } },
  ));
  assert.equal(reply, "✓ Replied · fixer [reply-id] · running");

  const interrupt = render(renderSubagentResult(
    { details: { run: run({ id: "interrupt-id", agent: "explorer", status: "running", output: undefined, error: undefined }) } },
    { expanded: false, isPartial: false }, theme, { args: { action: "interrupt", id: "interrupt-id" } },
  ));
  assert.equal(interrupt, "! Interrupt requested · explorer [interrupt-id] · running");

  const terminalResult = { details: { run: run({ id: "done-id", agent: "explorer", status: "completed", output: "terminal output", error: undefined }) } };
  const alreadyTerminalCollapsed = render(renderSubagentResult(
    terminalResult, { expanded: false, isPartial: false }, theme, { args: { action: "interrupt", id: "done-id" } },
  ));
  assert.equal(alreadyTerminalCollapsed, "✓ explorer [done-id] · already completed");
  assert.doesNotMatch(alreadyTerminalCollapsed, /terminal output|Interrupt requested/);
  const alreadyTerminalExpanded = render(renderSubagentResult(
    terminalResult, { expanded: true, isPartial: false }, theme, { args: { action: "interrupt", id: "done-id" } },
  ));
  assertFull(alreadyTerminalExpanded, ["✓ explorer [done-id] · already completed", "terminal output"]);

  const failedResult = { details: { run: run({ id: "failed-steer-id", agent: "fixer", status: "failed", output: undefined, error: "stored failure" }) } };
  const failedSteerCollapsed = render(renderSubagentResult(
    failedResult, { expanded: false, isPartial: false }, theme, { args: { action: "steer", id: "failed-steer-id", message: "too late" } },
  ));
  assert.equal(failedSteerCollapsed, "✗ fixer [failed-steer-id] · already failed");
  assert.doesNotMatch(failedSteerCollapsed, /stored failure|Steer requested/);
  const failedSteerExpanded = render(renderSubagentResult(
    failedResult, { expanded: true, isPartial: false }, theme, { args: { action: "steer", id: "failed-steer-id", message: "too late" } },
  ));
  assertFull(failedSteerExpanded, ["✗ fixer [failed-steer-id] · already failed", "stored failure"]);
});

test("terminal immediate results expand only final output and error", () => {
  const result = { details: { run: run({
    id: "failed-id",
    agent: "fixer",
    status: "failed",
    output: "Failure output\n<results>failure output payload</results>",
    error: "Failure error\n<results>failure error payload</results>",
  }) } };
  const collapsed = render(renderSubagentResult(
    result, { expanded: false, isPartial: false }, theme, { args: { action: "create", agent: "fixer", task: "must not repeat" } },
  ));
  assert.equal(collapsed, "✗ Started fixer [failed-id] · failed");
  assert.doesNotMatch(collapsed, /failure output|failure error|Task:/i);
  const expanded = render(renderSubagentResult(
    result, { expanded: true, isPartial: false }, theme, { args: { action: "create", agent: "fixer", task: "must not repeat" } },
  ));
  assertFull(expanded, ["✗ Started fixer [failed-id] · failed", "<results>failure output payload</results>", "<results>failure error payload</results>"]);
  assert.doesNotMatch(expanded, /Task:|Cwd:|Model:|Activity|Response:|Live response|Session:/);
});

test("Ctrl+O expands list waiting reasons without exposing excluded run data", () => {
  const result = {
    details: {
      runs: [
        run({
          id: "terminal-id",
          abstract: "TERMINAL_ABSTRACT_SENTINEL",
          status: "completed",
          task: "TASK_SENTINEL",
          cwd: "CWD_SENTINEL",
          model: "MODEL_SENTINEL",
          deniedTools: ["TOOLS_SENTINEL"],
          createdAt: "CREATED_SENTINEL",
          updatedAt: "UPDATED_SENTINEL",
          sessionFile: "SESSION_SENTINEL",
          sourceRunId: "SOURCE_SENTINEL",
          activity: { responseText: "ACTIVITY_SENTINEL", activeTools: { old: { name: "ACTIVITY_TOOL_SENTINEL" } } },
          output: "OUTPUT_SENTINEL",
          error: "ERROR_SENTINEL",
          notificationPending: "NOTIFICATION_SENTINEL",
        }),
        run({
          id: "active-id",
          agent: "explorer",
          abstract: "active abstract",
          status: "running",
          task: "ACTIVE_TASK_SENTINEL",
          activity: { responseText: "ACTIVE_ACTIVITY_SENTINEL" },
          output: "ACTIVE_OUTPUT_SENTINEL",
          error: "ACTIVE_ERROR_SENTINEL",
        }),
        run({
          id: "waiting-id",
          abstract: "waiting abstract",
          status: "waiting",
          reason: "interview_request",
          task: "WAITING_TASK_SENTINEL",
          activity: { responseText: "WAITING_ACTIVITY_SENTINEL" },
          output: "WAITING_OUTPUT_SENTINEL",
          error: "WAITING_ERROR_SENTINEL",
          request: {
            runId: "waiting-id",
            reason: "progress_update",
            message: "REQUEST_MESSAGE_SENTINEL",
            interview: { title: "INTERVIEW_SENTINEL", questions: [{ prompt: "QUESTION_SENTINEL" }] },
            createdAt: "REQUEST_CREATED_SENTINEL",
          },
        }),
      ],
    },
  };
  const before = structuredClone(result);
  const collapsed = render(renderSubagentResult(result, { expanded: false, isPartial: false }, theme, { args: { action: "list" } }));
  assertFull(collapsed, [
    "Active subagent run status · 2",
    "● explorer [active-id] · running  active abstract",
    "! fixer [waiting-id] · waiting  waiting abstract",
  ]);
  assert.doesNotMatch(collapsed, /Reason:|interview_request/);
  const expanded = render(renderSubagentResult(result, { expanded: true, isPartial: false }, theme, { args: { action: "list" } }));
  assertFull(expanded, [
    "Active subagent run status · 2",
    "● explorer [active-id] · running  active abstract",
    "! fixer [waiting-id] · waiting  waiting abstract",
    "Reason: interview_request",
  ]);
  assert.deepEqual(result, before);
  for (const sentinel of [
    "TASK_SENTINEL", "CWD_SENTINEL", "MODEL_SENTINEL", "TOOLS_SENTINEL", "CREATED_SENTINEL",
    "UPDATED_SENTINEL", "SESSION_SENTINEL", "SOURCE_SENTINEL", "ACTIVITY_SENTINEL", "ACTIVITY_TOOL_SENTINEL",
    "OUTPUT_SENTINEL", "ERROR_SENTINEL", "NOTIFICATION_SENTINEL", "ACTIVE_TASK_SENTINEL",
    "ACTIVE_ACTIVITY_SENTINEL", "ACTIVE_OUTPUT_SENTINEL", "ACTIVE_ERROR_SENTINEL", "WAITING_TASK_SENTINEL",
    "WAITING_ACTIVITY_SENTINEL", "WAITING_OUTPUT_SENTINEL", "WAITING_ERROR_SENTINEL", "TERMINAL_ABSTRACT_SENTINEL",
    "REQUEST_MESSAGE_SENTINEL", "INTERVIEW_SENTINEL", "QUESTION_SENTINEL", "REQUEST_CREATED_SENTINEL",
  ]) {
    assert.doesNotMatch(collapsed, new RegExp(sentinel));
    assert.doesNotMatch(expanded, new RegExp(sentinel));
  }
  assert.doesNotMatch(expanded, /Task:|Cwd:|Tools:|Model:|Created:|Updated:|Session:|Source run:|Live response:|Output:|Error:|Message:|Interview:/);
});

test("legacy transcript list derives a Unicode-safe abstract or shows an explicit unavailable placeholder", () => {
  const task = `${"文".repeat(98)}😀🚀tail`;
  const listText = render(renderSubagentResult({
    details: {
      runs: [
        run({ id: "legacy-task", status: "running", abstract: undefined, task }),
        run({ id: "legacy-empty", status: "waiting", abstract: undefined, task: undefined, reason: "need_decision" }),
      ],
    },
  }, { expanded: false, isPartial: false }, theme, { args: { action: "list" } }));
  assert.match(listText, new RegExp(`${"文".repeat(98)}😀🚀\\.\\.\\.`));
  assert.match(listText, /Legacy run summary unavailable/);
  assert.doesNotMatch(listText, /tail/);
});

test("Ctrl+O collapses waiting notification details without changing model content", () => {
  const message = {
    content: "Model-facing waiting content with the complete request.",
    display: true,
    details: { event: "waiting", status: "waiting", request: run({ status: "waiting" }).request, run: run({ status: "waiting" }) },
  };
  const before = structuredClone(message);
  const collapsed = render(renderSubagentNotification(message, { expanded: false, outputPad: 1 }, theme));
  assert.equal(collapsed, " ! fixer [run-1] · waiting");
  assert.doesNotMatch(collapsed, /Request|need_decision|request payload|Choose|A or B|Created|Model-facing/);

  const expanded = render(renderSubagentNotification(message, { expanded: true, outputPad: 1 }, theme));
  assertFull(expanded, [
    "! fixer [run-1] · waiting", "Request", "need_decision", "<results>request payload</results>",
    "Choose", "A or B?", "Created: 2026-04-17T00:01:00.000Z",
  ]);
  assert.doesNotMatch(expanded, /Task:|Low-value task|Live response|activity payload|Output:|stored output|Error:|stored error|Model:|Cwd:|Tools:|Session:|waitingSeq|Model-facing/);
  assert.deepEqual(message, before);
  assert.equal(message.content, before.content);
});

test("Ctrl+O expands completed, failed, and interrupted notification output or error", () => {
  const cases = [
    { status: "completed", glyph: "✓", run: run({ status: "completed", output: "COMPLETED_OUTPUT", error: undefined }), body: "COMPLETED_OUTPUT" },
    { status: "failed", glyph: "✗", run: run({ status: "failed", output: undefined, error: "FAILED_ERROR" }), body: "FAILED_ERROR" },
    { status: "interrupted", glyph: "✗", run: run({ status: "interrupted", output: "INTERRUPTED_OUTPUT", error: "INTERRUPTED_ERROR" }), body: "INTERRUPTED_OUTPUT" },
  ];
  for (const value of cases) {
    const message = {
      content: `Model-facing ${value.status} content.`,
      display: true,
      details: { event: value.status, status: value.status, run: value.run },
    };
    const before = structuredClone(message);
    const collapsed = render(renderSubagentNotification(message, { expanded: false, outputPad: 1 }, theme));
    assert.equal(collapsed, ` ${value.glyph} fixer [run-1] · ${value.status}`);
    assert.doesNotMatch(collapsed, /COMPLETED_OUTPUT|FAILED_ERROR|INTERRUPTED_OUTPUT|INTERRUPTED_ERROR|Model-facing/);

    const expanded = render(renderSubagentNotification(message, { expanded: true, outputPad: 1 }, theme));
    assertFull(expanded, [`${value.glyph} fixer [run-1] · ${value.status}`, value.body]);
    if (value.status === "interrupted") assert.match(expanded, /INTERRUPTED_ERROR/);
    assert.doesNotMatch(expanded, /Task:|Low-value task|Live response|activity payload|Model:|Cwd:|Tools:|Request|Model-facing/);
    assert.deepEqual(message, before);
  }
});

test("Ctrl+O collapses active activity and expands complete live details", () => {
  const message = {
    content: "Model-facing running content.",
    display: true,
    details: { event: "running", status: "running", run: run({ status: "running", output: undefined, error: undefined }) },
  };
  const before = structuredClone(message);
  const collapsed = render(renderSubagentNotification(message, { expanded: false, outputPad: 1 }, theme));
  assert.equal(collapsed, " ● fixer [run-1] · running");
  assert.doesNotMatch(collapsed, /Live response|activity payload|toolA|Model-facing/);

  const expanded = render(renderSubagentNotification(message, { expanded: true, outputPad: 1 }, theme));
  assertFull(expanded, ["● fixer [run-1] · running", "Live response:", "<results>activity payload</results>", "Active tools:", "toolA"]);
  assert.doesNotMatch(expanded, /Task:|Low-value task|Output:|Error:|Model:|Cwd:|Request|Model-facing/);
  assert.deepEqual(message, before);
});

test("notification fallback collapses to a safe first line and expands full content", () => {
  const message = { content: "Fallback first line\n<results>fallback full payload</results>\nFallback last line" };
  const collapsed = render(renderSubagentNotification(message, { expanded: false, outputPad: 1 }, theme));
  assert.equal(collapsed, " Fallback first line");
  assert.doesNotMatch(collapsed, /fallback full payload|Fallback last line/);
  const expanded = render(renderSubagentNotification(message, { expanded: true, outputPad: 1 }, theme));
  assertFull(expanded, ["Fallback first line", "<results>fallback full payload</results>", "Fallback last line"]);
});

test("tool-result fallback collapses safely and expands full content", () => {
  const result = {
    content: [{ type: "text", text: "Fallback\u0000 line one\n<results>fallback payload</results>\nFallback line three" }],
  };
  const before = structuredClone(result);
  const collapsed = render(renderSubagentResult(
    result, { expanded: false, isPartial: true }, theme, { args: { action: "create" } },
  ));
  assert.equal(collapsed, "Fallback  line one");
  assert.doesNotMatch(collapsed, /fallback payload|Fallback line three|\u0000/);
  const expanded = render(renderSubagentResult(
    result, { expanded: true, isPartial: true }, theme, { args: { action: "create" } },
  ));
  assertFull(expanded, ["Fallback", "<results>fallback payload</results>", "Fallback line three"]);
  assert.deepEqual(result, before);

  const emptyPartial = render(renderSubagentResult(
    { content: [] }, { expanded: false, isPartial: true }, theme, { args: { action: "create" } },
  ));
  assert.match(emptyPartial, /Result pending/);
});
