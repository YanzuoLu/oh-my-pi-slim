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

test("call renderers keep complete action-specific input", () => {
  const created = render(renderSubagentCall({
    action: "create",
    agent: "fixer",
    abstract: "Create concise abstract",
    task: "Create task line one\n<results>create task payload</results>\nCreate task line three",
    cwd: "/full/create/cwd",
  }, theme, { cwd: "/context/cwd" }));
  assertFull(created, ["Action: create", "Agent: fixer", "Abstract: Create concise abstract", "/full/create/cwd", "Create task line one", "<results>create task payload</results>", "Create task line three"]);

  const resume = render(renderSubagentCall({
    action: "resume", id: "source-run-full", abstract: "Fresh continuation abstract",
    message: "Continuation line one\nContinuation line two",
  }, theme));
  assertFull(resume, ["Action: resume", "Source run: source-run-full", "Abstract: Fresh continuation abstract", "Continuation line one", "Continuation line two"]);

  const steer = render(renderSubagentCall({
    action: "steer", id: "run-steer-full", message: "Guidance line one\n<results>guidance payload</results>",
  }, theme));
  assertFull(steer, ["Action: steer", "Run: run-steer-full", "Guidance line one", "<results>guidance payload</results>"]);

  const interrupt = render(renderSubagentCall({ action: "interrupt", id: "run-interrupt-full" }, theme));
  assertFull(interrupt, ["Action: interrupt", "Run: run-interrupt-full"]);

  const list = render(renderSubagentCall({ action: "list" }, theme));
  assertFull(list, ["Action: list", "starting, running, and waiting", "abstract", "waiting reason"]);
  assert.doesNotMatch(list, /output|error|activity|task/i);

  const reply = render(renderSubagentCall({
    action: "reply", id: "run-full", message: "Reply line one\n<results>reply payload</results>\nReply line three",
  }, theme));
  assertFull(reply, ["Action: reply", "Run: run-full", "Reply line one", "<results>reply payload</results>", "Reply line three"]);
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

  const alreadyTerminal = render(renderSubagentResult(
    { details: { run: run({ id: "done-id", agent: "explorer", status: "completed", output: "terminal output", error: undefined }) } },
    { expanded: false, isPartial: false }, theme, { args: { action: "interrupt", id: "done-id" } },
  ));
  assertFull(alreadyTerminal, ["✓ explorer [done-id] · already completed", "terminal output"]);
  assert.doesNotMatch(alreadyTerminal, /Interrupt requested/);

  const failedSteer = render(renderSubagentResult(
    { details: { run: run({ id: "failed-steer-id", agent: "fixer", status: "failed", output: undefined, error: "stored failure" }) } },
    { expanded: false, isPartial: false }, theme, { args: { action: "steer", id: "failed-steer-id", message: "too late" } },
  ));
  assertFull(failedSteer, ["✗ fixer [failed-steer-id] · already failed", "stored failure"]);
  assert.doesNotMatch(failedSteer, /Steer requested/);
});

test("failed immediate result adds only complete final output and error", () => {
  const failed = render(renderSubagentResult(
    { details: { run: run({
      id: "failed-id",
      agent: "fixer",
      status: "failed",
      output: "Failure output\n<results>failure output payload</results>",
      error: "Failure error\n<results>failure error payload</results>",
    }) } },
    { expanded: false, isPartial: false }, theme, { args: { action: "create", agent: "fixer", task: "must not repeat" } },
  ));
  assertFull(failed, ["✗ Started fixer [failed-id] · failed", "<results>failure output payload</results>", "<results>failure error payload</results>"]);
  assert.doesNotMatch(failed, /Task:|Cwd:|Model:|Activity|Response:|Live response|Session:/);
});

test("list renders only compact run status and waiting request identity", () => {
  const listText = render(renderSubagentResult({
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
  }, { expanded: false, isPartial: false }, theme, { args: { action: "list" } }));

  assertFull(listText, [
    "Active subagent run status · 2",
    "● explorer [active-id] · running  active abstract",
    "! fixer [waiting-id] · waiting  waiting abstract",
    "Request · interview_request",
  ]);
  for (const sentinel of [
    "TASK_SENTINEL", "CWD_SENTINEL", "MODEL_SENTINEL", "TOOLS_SENTINEL", "CREATED_SENTINEL",
    "UPDATED_SENTINEL", "SESSION_SENTINEL", "SOURCE_SENTINEL", "ACTIVITY_SENTINEL", "ACTIVITY_TOOL_SENTINEL",
    "OUTPUT_SENTINEL", "ERROR_SENTINEL", "NOTIFICATION_SENTINEL", "ACTIVE_TASK_SENTINEL",
    "ACTIVE_ACTIVITY_SENTINEL", "ACTIVE_OUTPUT_SENTINEL", "ACTIVE_ERROR_SENTINEL", "WAITING_TASK_SENTINEL",
    "WAITING_ACTIVITY_SENTINEL", "WAITING_OUTPUT_SENTINEL", "WAITING_ERROR_SENTINEL", "TERMINAL_ABSTRACT_SENTINEL",
    "REQUEST_MESSAGE_SENTINEL", "INTERVIEW_SENTINEL", "QUESTION_SENTINEL", "REQUEST_CREATED_SENTINEL",
  ]) {
    assert.doesNotMatch(listText, new RegExp(sentinel));
  }
  assert.doesNotMatch(listText, /Task:|Cwd:|Tools:|Model:|Created:|Updated:|Session:|Source run:|Live response:|Output:|Error:|Message:|Interview:/);
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

test("missing details and partial results keep full content fallback", () => {
  const fallback = render(renderSubagentResult({
    content: [{ type: "text", text: "Fallback line one\n<results>fallback payload</results>\nFallback line three" }],
  }, { expanded: false, isPartial: true }, theme, { args: { action: "create" } }));
  assertFull(fallback, ["Fallback line one", "<results>fallback payload</results>", "Fallback line three"]);

  const emptyPartial = render(renderSubagentResult(
    { content: [] }, { expanded: false, isPartial: true }, theme, { args: { action: "create" } },
  ));
  assert.match(emptyPartial, /Result pending/);
});
