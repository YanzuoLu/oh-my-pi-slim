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
  "../tool-contracts.js": new URL("../extensions/oh-my-pi-slim/tool-contracts.ts", import.meta.url).href,
  "./core.js": new URL("../extensions/oh-my-pi-slim/subagent/core.ts", import.meta.url).href,
  "./legacy-abstract.js": new URL("../extensions/oh-my-pi-slim/subagent/legacy-abstract.ts", import.meta.url).href,
  "../semantic-glyph.js": new URL("../extensions/oh-my-pi-slim/semantic-glyph.ts", import.meta.url).href,
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    const url = dependencyMap[specifier];
    return url ? { url, shortCircuit: true } : nextResolve(specifier, context);
  },
});

const { visibleWidth } = await import("@earendil-works/pi-tui");
const {
  renderSubagentCall,
  renderSubagentNotification,
  renderSubagentResult,
} = await import("../extensions/oh-my-pi-slim/subagent/transcript-renderer.ts");

const theme = {
  fg: (_color, text) => text,
  bg: (_color, text) => text,
  bold: (text) => text,
};
const roleAnsiTheme = {
  fg: (color, text) => {
    const code = { accent: 35, dim: 2, success: 32, toolOutput: 36, toolTitle: 34, muted: 90, warning: 33, error: 31 }[color] ?? 39;
    return `\u001b[${code}m${text}\u001b[0m`;
  },
  bg: (_color, text) => text,
  bold: (text) => `\u001b[1m${text}\u001b[22m`,
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
    message: "Create message line one\n<results>create message payload</results>\nCreate message line three",
    cwd: "/full/create/cwd",
  };
  const createCollapsed = render(renderSubagentCall(createArgs, theme, { cwd: "/context/cwd", expanded: false }));
  assertFull(createCollapsed, ["subagent · create (ctrl+o to expand)", "Abstract: Create concise abstract"]);
  assert.doesNotMatch(createCollapsed, /Agent:/);
  assert.doesNotMatch(createCollapsed, /Action:|Cwd:|full\/create|Message:|create message payload/);
  const createExpanded = render(renderSubagentCall(createArgs, theme, { cwd: "/context/cwd", expanded: true }));
  assertFull(createExpanded, ["subagent · create", "Abstract: Create concise abstract", "/full/create/cwd", "Fork: true", "Create message line one", "<results>create message payload</results>", "Create message line three"]);
  assert.doesNotMatch(createExpanded, /Agent:/);

  const resumeArgs = {
    action: "resume", id: "source-run-full", abstract: "Fresh continuation abstract",
    message: "Continuation line one\nContinuation line two",
  };
  const resumeCollapsed = render(renderSubagentCall(resumeArgs, theme, { expanded: false }));
  assertFull(resumeCollapsed, ["subagent · resume (ctrl+o to expand)", "Source run: source-run-full", "Abstract: Fresh continuation abstract"]);
  assert.doesNotMatch(resumeCollapsed, /Action:|Cwd:|Continuation task|Continuation line/);
  const resumeExpanded = render(renderSubagentCall(resumeArgs, theme, { expanded: true }));
  assertFull(resumeExpanded, ["subagent · resume", "Source run: source-run-full", "Abstract: Fresh continuation abstract", "Cwd: (source run cwd)", "Continuation line one", "Continuation line two"]);

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

  const checkCollapsed = render(renderSubagentCall({ action: "check", id: "run-check-full" }, theme, { expanded: false }));
  const checkExpanded = render(renderSubagentCall({ action: "check", id: "run-check-full" }, theme, { expanded: true }));
  assert.equal(checkCollapsed, "subagent · check · run-check-full (ctrl+o to expand)");
  assert.equal(checkExpanded, "subagent · check\nRun: run-check-full");

  const interruptCollapsed = render(renderSubagentCall({ action: "interrupt", id: "run-interrupt-full" }, theme, { expanded: false }));
  const interruptExpanded = render(renderSubagentCall({ action: "interrupt", id: "run-interrupt-full" }, theme, { expanded: true }));
  assert.equal(interruptCollapsed, "subagent · interrupt (ctrl+o to expand)\nRun: run-interrupt-full");
  assert.equal(interruptExpanded, "subagent · interrupt\nRun: run-interrupt-full");

  const deleteArgs = { action: "delete", id: "run-delete-full" };
  const deleteBefore = structuredClone(deleteArgs);
  const deleteCollapsed = render(renderSubagentCall(deleteArgs, theme, { expanded: false }));
  const deleteExpanded = render(renderSubagentCall(deleteArgs, theme, { expanded: true }));
  assert.equal(deleteCollapsed, "subagent · delete (ctrl+o to expand)\nRun: run-delete-full");
  assert.equal(deleteExpanded, "subagent · delete\nRun: run-delete-full");
  assert.deepEqual(deleteArgs, deleteBefore);

  const listCollapsed = render(renderSubagentCall({ action: "list" }, theme, { expanded: false }));
  assert.equal(listCollapsed, "subagent · list (ctrl+o to expand)");
  const listExpanded = render(renderSubagentCall({ action: "list" }, theme, { expanded: true }));
  assertFull(listExpanded, ["subagent · list", "compact public state", "every retained run", "without terminal results"]);
  assert.doesNotMatch(listExpanded, /activity|task|output|error/i);

  const clearCollapsed = render(renderSubagentCall({ action: "clear" }, theme, { expanded: false }));
  assert.equal(clearCollapsed, "subagent · clear (ctrl+o to expand)");
  const clearExpanded = render(renderSubagentCall({ action: "clear" }, theme, { expanded: true }));
  assertFull(clearExpanded, ["subagent · clear", "Clears retained Subagent history", "run files", "child session files", "warnings"]);
  assert.doesNotMatch(clearExpanded, /Goal|sidecar/i);

  const collapsedCalls = [createCollapsed, resumeCollapsed, steerCollapsed, replyCollapsed, checkCollapsed, interruptCollapsed, deleteCollapsed, listCollapsed, clearCollapsed];
  const expandedCalls = [createExpanded, resumeExpanded, steerExpanded, replyExpanded, checkExpanded, interruptExpanded, deleteExpanded, listExpanded, clearExpanded];
  assert.equal(collapsedCalls.length, 9);
  assert.equal(expandedCalls.length, 9);
  for (const value of collapsedCalls) {
    assert.match(value.split("\n")[0], /\(ctrl\+o to expand\)$/);
    assert.doesNotMatch(value, /Action:/);
  }
  for (const value of expandedCalls) {
    assert.doesNotMatch(value, /\(ctrl\+o to expand\)|Action:/);
  }
});

test("expanded resume calls show a cwd override and fall back to the source run cwd", () => {
  const base = { action: "resume", id: "source-run-cwd", abstract: "Continuation abstract", message: "Continue there" };

  const overrideExpanded = render(renderSubagentCall({ ...base, cwd: "/override/resume/cwd" }, theme, { cwd: "/context/cwd", expanded: true }));
  assertFull(overrideExpanded, ["subagent · resume", "Source run: source-run-cwd", "Cwd: /override/resume/cwd", "Continue there"]);
  assert.doesNotMatch(overrideExpanded, /source run cwd|\/context\/cwd/);

  const relativeExpanded = render(renderSubagentCall({ ...base, cwd: "packages/api" }, theme, { cwd: "/context/cwd", expanded: true }));
  assertFull(relativeExpanded, ["Cwd: packages/api"]);

  const inheritedExpanded = render(renderSubagentCall(base, theme, { cwd: "/context/cwd", expanded: true }));
  assertFull(inheritedExpanded, ["subagent · resume", "Cwd: (source run cwd)"]);
  assert.doesNotMatch(inheritedExpanded, /\/context\/cwd/);

  for (const args of [{ ...base, cwd: "/override/resume/cwd" }, base]) {
    const collapsed = render(renderSubagentCall(args, theme, { cwd: "/context/cwd", expanded: false }));
    assert.doesNotMatch(collapsed, /Cwd:|override\/resume|source run cwd/);
    assert.match(collapsed.split("\n")[0], /\(ctrl\+o to expand\)$/);
  }
});

test("tool results start with one blank separator line", () => {
  const subagent = renderLines(renderSubagentResult(
    { details: { run: run({ id: "spacing-run", agent: "explorer", status: "starting", output: undefined, error: undefined }) } },
    { expanded: false, isPartial: false }, theme, { args: { action: "create", agent: "explorer", message: "spacing task" } },
  ));
  assert.equal(subagent[0], "");
  assert.equal(subagent[1], "✓  Started Subagent [spacing-run] · starting");

  const reply = renderLines(renderSubagentResult(
    { details: { run: run({ id: "spacing-reply", agent: "fixer", status: "running" }) } },
    { expanded: false, isPartial: false }, theme, { args: { action: "reply", id: "spacing-reply", message: "continue" } },
  ));
  assert.equal(reply[0], "");
  assert.equal(reply[1], "✓  Replied · Subagent [spacing-reply] · running");
});

test("subagent immediate results use accurate compact action acknowledgements", () => {
  const created = render(renderSubagentResult(
    {
      content: [{ type: "text", text: '{"id":"content-create-id","agent":"fixer","status":"failed"}' }],
      details: { run: run({ id: "create-id", agent: "explorer", status: "starting", output: undefined, error: undefined }) },
    },
    { expanded: false, isPartial: false }, theme, { args: { action: "create", agent: "explorer", message: "full task" } },
  ));
  assert.equal(created, "✓  Started Subagent [create-id] · starting");
  assert.doesNotMatch(created, /Subagent result|Task|Cwd|Tools|Model|Activity|Response|Session/);

  const resume = render(renderSubagentResult(
    {
      content: [{ type: "text", text: '{"id":"content-resume-id","sourceRunId":"wrong-source","status":"failed"}' }],
      details: { run: run({ id: "resume-id", agent: "explorer", status: "starting", output: undefined, error: undefined }) },
    },
    { expanded: false, isPartial: false }, theme, { args: { action: "resume", id: "source-id", abstract: "new summary", message: "continue" } },
  ));
  assert.equal(resume, "✓  Resumed [source-id] → Subagent [resume-id] · starting");

  const steer = render(renderSubagentResult(
    {
      content: [{ type: "text", text: '{"id":"content-steer-id","status":"failed"}' }],
      details: { run: run({ id: "steer-id", agent: "explorer", status: "running", output: undefined, error: undefined }) },
    },
    { expanded: false, isPartial: false }, theme, { args: { action: "steer", id: "steer-id", message: "focus" } },
  ));
  assert.equal(steer, "✓  Steer requested · Subagent [steer-id] · running");

  const reply = render(renderSubagentResult(
    {
      content: [{ type: "text", text: '{"id":"content-reply-id","status":"failed"}' }],
      details: { run: run({ id: "reply-id", agent: "fixer", status: "running", output: undefined, error: undefined }) },
    },
    { expanded: false, isPartial: false }, theme, { args: { action: "reply", id: "reply-id", message: "continue" } },
  ));
  assert.equal(reply, "✓  Replied · Subagent [reply-id] · running");

  const legacyInterrupt = render(renderSubagentResult(
    { details: { run: run({ id: "interrupt-id", agent: "explorer", status: "running", output: undefined, error: undefined }) } },
    { expanded: false, isPartial: false }, theme, { args: { action: "interrupt", id: "interrupt-id" } },
  ));
  assert.equal(legacyInterrupt, "!  Interrupt requested · Subagent [interrupt-id] · running");

  const terminalResult = { details: { run: run({ id: "done-id", agent: "explorer", status: "completed", output: "terminal output", error: undefined }) } };
  const alreadyTerminalCollapsed = render(renderSubagentResult(
    terminalResult, { expanded: false, isPartial: false }, theme, { args: { action: "interrupt", id: "done-id" } },
  ));
  assert.equal(alreadyTerminalCollapsed, "✓  Subagent [done-id] · completed");
  assert.doesNotMatch(alreadyTerminalCollapsed, /terminal output|Interrupt requested/);
  const alreadyTerminalExpanded = render(renderSubagentResult(
    terminalResult, { expanded: true, isPartial: false }, theme, { args: { action: "interrupt", id: "done-id" } },
  ));
  assertFull(alreadyTerminalExpanded, ["✓  Subagent [done-id] · completed", "terminal output"]);

  const failedResult = { details: { run: run({ id: "failed-steer-id", agent: "fixer", status: "failed", output: undefined, error: "stored failure" }) } };
  const failedSteerCollapsed = render(renderSubagentResult(
    failedResult, { expanded: false, isPartial: false }, theme, { args: { action: "steer", id: "failed-steer-id", message: "too late" } },
  ));
  assert.equal(failedSteerCollapsed, "✗  Subagent [failed-steer-id] · already failed");
  assert.doesNotMatch(failedSteerCollapsed, /stored failure|Steer requested/);
  const failedSteerExpanded = render(renderSubagentResult(
    failedResult, { expanded: true, isPartial: false }, theme, { args: { action: "steer", id: "failed-steer-id", message: "too late" } },
  ));
  assert.equal(failedSteerExpanded, "✗  Subagent [failed-steer-id] · already failed");
  assert.doesNotMatch(failedSteerExpanded, /stored failure|Output:|Error:/);
});

test("synchronous interrupt results collapse to the final result and expand its complete output and error", () => {
  for (const { status, glyph, collapsed } of [
    { status: "interrupted", glyph: "✗", collapsed: "✗  Subagent [stop-id] · interrupted" },
    { status: "completed", glyph: "✓", collapsed: "✓  Subagent [stop-id] · completed" },
  ]) {
    const result = {
      content: [{ type: "text", text: JSON.stringify({
        id: "content-stop-id", agent: "explorer", status: "failed",
        output: "CONTENT_OUTPUT_SENTINEL", error: "CONTENT_ERROR_SENTINEL",
      }) }],
      details: {
        run: run({
          id: "stop-id",
          agent: "fixer",
          status,
          output: "INTERRUPT_OUTPUT_SENTINEL",
          error: "INTERRUPT_ERROR_SENTINEL",
          task: "INTERRUPT_TASK_SENTINEL",
          activity: { responseText: "INTERRUPT_ACTIVITY_SENTINEL" },
        }),
      },
    };
    const context = { args: { action: "interrupt", id: "stop-id" } };
    const compact = render(renderSubagentResult(result, { expanded: false, isPartial: false }, theme, context));
    assert.equal(compact, collapsed);
    assert.doesNotMatch(compact, /SENTINEL/);
    assert.equal(compact.startsWith(glyph), true);
    const expanded = render(renderSubagentResult(result, { expanded: true, isPartial: false }, theme, context));
    assertFull(expanded, [collapsed, "INTERRUPT_OUTPUT_SENTINEL", "INTERRUPT_ERROR_SENTINEL"]);
    assert.doesNotMatch(expanded, /CONTENT_(?:OUTPUT|ERROR)_SENTINEL|content-stop-id|INTERRUPT_TASK_SENTINEL|INTERRUPT_ACTIVITY_SENTINEL|Task:|Cwd:|Model:|Live response/);
  }
});

test("terminal steer immediate results never repeat final output or error even from legacy full run details", () => {
  for (const { status, glyph, output, error } of [
    { status: "completed", glyph: "✓", output: "LEGACY_STEER_OUTPUT_SENTINEL", error: undefined },
    { status: "failed", glyph: "✗", output: undefined, error: "LEGACY_STEER_ERROR_SENTINEL" },
    { status: "interrupted", glyph: "✗", output: "LEGACY_STEER_PARTIAL_SENTINEL", error: "LEGACY_STEER_STOP_SENTINEL" },
  ]) {
    // Legacy sessions replayed a full run shape into details.run; the renderer must still suppress it.
    const legacy = {
      content: [{ type: "text", text: `legacy-steer-${status} is already ${status}.` }],
      details: {
        run: run({
          id: `legacy-steer-${status}`,
          agent: "fixer",
          status,
          output,
          error,
          task: "LEGACY_STEER_TASK_SENTINEL",
          sessionFile: "/tmp/legacy-steer-session.jsonl",
          activity: { responseText: "LEGACY_STEER_ACTIVITY_SENTINEL" },
        }),
      },
    };
    const context = { args: { action: "steer", id: `legacy-steer-${status}`, message: "too late" } };
    const collapsed = render(renderSubagentResult(legacy, { expanded: false, isPartial: false }, theme, context));
    assert.equal(collapsed, `${glyph}  Subagent [legacy-steer-${status}] · already ${status}`);
    const expanded = render(renderSubagentResult(legacy, { expanded: true, isPartial: false }, theme, context));
    assert.equal(expanded, `${glyph}  Subagent [legacy-steer-${status}] · already ${status}`);
    for (const value of [collapsed, expanded]) {
      assert.doesNotMatch(value, /SENTINEL/);
      assert.doesNotMatch(value, /Output:|Error:|Live response|Task:|Session:/);
    }

    // subagent check stays the explicit full-result entry point for the very same run shape.
    const checkExpanded = render(renderSubagentResult(
      legacy, { expanded: true, isPartial: false }, theme, { args: { action: "check", id: `legacy-steer-${status}` } },
    ));
    if (output !== undefined) assert.match(checkExpanded, new RegExp(output));
    if (error !== undefined) assert.match(checkExpanded, new RegExp(error));
  }
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
    result, { expanded: false, isPartial: false }, theme, { args: { action: "create", agent: "fixer", message: "must not repeat" } },
  ));
  assert.equal(collapsed, "✗  Started Subagent [failed-id] · failed");
  assert.doesNotMatch(collapsed, /failure output|failure error|Task:/i);
  const expanded = render(renderSubagentResult(
    result, { expanded: true, isPartial: false }, theme, { args: { action: "create", agent: "fixer", message: "must not repeat" } },
  ));
  assertFull(expanded, ["✗  Started Subagent [failed-id] · failed", "<results>failure output payload</results>", "<results>failure error payload</results>"]);
  assert.doesNotMatch(expanded, /Task:|Cwd:|Model:|Activity|Response:|Live response|Session:/);
});

test("Ctrl+O expands list public summary fields without leaking terminal results or internal run data", () => {
  const result = {
    content: [{ type: "text", text: "LIST_MODEL_CONTENT_SENTINEL" }],
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
  const collapsedLines = renderLines(renderSubagentResult(result, { expanded: false, isPartial: false }, theme, { args: { action: "list" } }));
  const collapsed = collapsedLines.join("\n").replace(/^\n+|\n+$/g, "");
  // Collapsed is exactly one heading line after the shared tool-result separator: no run rows, no blank filler.
  assert.deepEqual(collapsedLines, ["", "●  Subagents (1/3)"]);
  assert.equal(collapsed, "●  Subagents (1/3)");
  assert.doesNotMatch(collapsed, /terminal-id|active-id|waiting-id|fixer|explorer|No retained runs/);
  assert.doesNotMatch(collapsed, /Reason:|Source run:|Live:|interview_request|OUTPUT_SENTINEL|ERROR_SENTINEL/);
  const expandedComponent = renderSubagentResult(result, { expanded: true, isPartial: false }, theme, { args: { action: "list" } });
  const expandedLines = renderLines(expandedComponent);
  assert.deepEqual(expandedLines.slice(0, 4), ["", "●  Subagents (1/3)", "", "✓  Subagent [terminal-id] · completed · TERMINAL_ABSTRACT_SENTINEL"]);
  const expanded = render(expandedComponent);
  assert.doesNotMatch(expanded, /[✓●!] [^ ]|[✓●!] {3}/);
  assertFull(expanded, [
    "●  Subagents (1/3)",
    "✓  Subagent [terminal-id] · completed · TERMINAL_ABSTRACT_SENTINEL",
    "Source run: SOURCE_SENTINEL",
    "●  Subagent [active-id] · running · active abstract",
    "!  Subagent [waiting-id] · waiting · waiting abstract",
  ]);
  assert.doesNotMatch(expanded, /OUTPUT_SENTINEL|ERROR_SENTINEL|ACTIVE_OUTPUT_SENTINEL|ACTIVE_ERROR_SENTINEL|WAITING_OUTPUT_SENTINEL|WAITING_ERROR_SENTINEL/);
  assert.deepEqual(result, before);
  assert.doesNotMatch(collapsed, /LIST_MODEL_CONTENT_SENTINEL/);
  assert.doesNotMatch(expanded, /LIST_MODEL_CONTENT_SENTINEL/);
  for (const sentinel of [
    "TASK_SENTINEL", "CWD_SENTINEL", "MODEL_SENTINEL", "TOOLS_SENTINEL", "CREATED_SENTINEL",
    "UPDATED_SENTINEL", "SESSION_SENTINEL", "ACTIVITY_SENTINEL", "ACTIVITY_TOOL_SENTINEL",
    "NOTIFICATION_SENTINEL", "ACTIVE_TASK_SENTINEL",
    "ACTIVE_ACTIVITY_SENTINEL", "ACTIVE_OUTPUT_SENTINEL", "ACTIVE_ERROR_SENTINEL", "WAITING_TASK_SENTINEL",
    "WAITING_ACTIVITY_SENTINEL", "WAITING_OUTPUT_SENTINEL", "WAITING_ERROR_SENTINEL",
    "REQUEST_MESSAGE_SENTINEL", "INTERVIEW_SENTINEL", "QUESTION_SENTINEL", "REQUEST_CREATED_SENTINEL",
  ]) {
    assert.doesNotMatch(collapsed, new RegExp(sentinel));
    assert.doesNotMatch(expanded, new RegExp(sentinel));
  }
  assert.doesNotMatch(expanded, /Task:|Cwd:|Tools:|Model:|Created:|Updated:|Session:|Live response:|Message:|Interview:|Output:|Error:/);
});

test("check result stays single-line collapsed and expands only public summary fields plus terminal results", () => {
  const terminal = {
    content: [{ type: "text", text: JSON.stringify({ model: "content must stay invariant" }) }],
    details: { run: run({
      id: "status-terminal", status: "failed", abstract: "status terminal abstract", live: false,
      sourceRunId: "status-source", reason: undefined,
      output: "STATUS_OUTPUT_SENTINEL\n<results>status output payload</results>",
      error: "STATUS_ERROR_SENTINEL\n<results>status error payload</results>",
    }) },
  };
  const before = structuredClone(terminal);
  const context = { args: { action: "check", id: "status-terminal" } };
  const collapsed = render(renderSubagentResult(terminal, { expanded: false, isPartial: false }, theme, context));
  assert.equal(collapsed, "✗  Subagent [status-terminal] · failed · status terminal abstract");
  assert.doesNotMatch(collapsed, /Live:|Source run:|STATUS_OUTPUT|STATUS_ERROR|Task:|Model:/);
  const expanded = render(renderSubagentResult(terminal, { expanded: true, isPartial: false }, theme, context));
  assertFull(expanded, [
    "✗  Subagent [status-terminal] · failed · status terminal abstract",
    "Source run: status-source",
    "<results>status output payload</results>", "<results>status error payload</results>",
  ]);
  assert.doesNotMatch(expanded, /Task:|Cwd:|Model:|Tools:|Created:|Updated:|Session:|Activity|Request:|waitingSeq|notificationPending|content must stay invariant/);
  assert.deepEqual(terminal, before);

  const waiting = {
    content: [{ type: "text", text: "waiting model content" }],
    details: { run: {
      id: "status-waiting", agent: "explorer", abstract: "status waiting abstract",
      status: "waiting", live: true,
      output: "NONTERMINAL_OUTPUT_SENTINEL", error: "NONTERMINAL_ERROR_SENTINEL",
    } },
  };
  const waitingBefore = structuredClone(waiting);
  const waitingExpanded = render(renderSubagentResult(
    waiting, { expanded: true, isPartial: false }, theme, { args: { action: "check", id: "status-waiting" } },
  ));
  assertFull(waitingExpanded, [
    "!  Subagent [status-waiting] · waiting · status waiting abstract",
  ]);
  assert.doesNotMatch(waitingExpanded, /NONTERMINAL_OUTPUT|NONTERMINAL_ERROR|Output:|Error:|waiting model content/);
  assert.deepEqual(waiting, waitingBefore);
});

test("delete receipts show the run ID, warning count, complete warnings, width safety, and no private fallback data", () => {
  const result = {
    content: [{ type: "text", text: "RAW_DELETE_MODEL_CONTENT_SENTINEL" }],
    details: {
      id: "delete-run-1",
      deleted: true,
      changed: true,
      warnings: [
        "Retained child session file: SESSION_WARNING_SENTINEL",
        "Retained run directory: RUN_DIRECTORY_WARNING_SENTINEL",
      ],
      privateRun: "PRIVATE_RUN_SENTINEL",
    },
  };
  const before = structuredClone(result);
  const context = { args: { action: "delete", id: "delete-run-1" } };
  const collapsedComponent = renderSubagentResult(result, { expanded: false, isPartial: false }, theme, context);
  const collapsed = render(collapsedComponent);
  assert.equal(collapsed, "✓  Deleted subagent run [delete-run-1] · 2 warnings");
  assert.doesNotMatch(collapsed, /SESSION_WARNING_SENTINEL|RAW_DELETE_MODEL_CONTENT_SENTINEL/);
  for (const width of [16, 28, 48]) {
    assert.ok(collapsedComponent.render(width).every((line) => visibleWidth(line) <= width));
  }
  const expanded = render(renderSubagentResult(result, { expanded: true, isPartial: false }, theme, context));
  assertFull(expanded, [
    "✓  Deleted subagent run [delete-run-1] · 2 warnings",
    "Warnings:",
    "• Retained child session file: SESSION_WARNING_SENTINEL",
    "• Retained run directory: RUN_DIRECTORY_WARNING_SENTINEL",
  ]);
  assert.doesNotMatch(expanded, /RAW_DELETE_MODEL_CONTENT_SENTINEL|PRIVATE_RUN_SENTINEL|privateRun|Deleted:|Changed:/);
  assert.deepEqual(result, before);

  const clean = {
    content: [{ type: "text", text: "RAW_DELETE_CLEAN_SENTINEL" }],
    details: { id: "delete-run-2", deleted: true, changed: true, warnings: [] },
  };
  const cleanBefore = structuredClone(clean);
  assert.equal(
    render(renderSubagentResult(clean, { expanded: false, isPartial: false }, theme, { args: { action: "delete", id: "delete-run-2" } })),
    "✓  Deleted subagent run [delete-run-2]",
  );
  assert.equal(
    render(renderSubagentResult(clean, { expanded: true, isPartial: false }, theme, { args: { action: "delete", id: "delete-run-2" } })),
    "✓  Deleted subagent run [delete-run-2]",
  );
  assert.deepEqual(clean, cleanBefore);

  const singular = { details: { id: "delete-run-3", deleted: true, changed: true, warnings: ["One warning"] } };
  assert.equal(
    render(renderSubagentResult(singular, { expanded: false }, theme, { args: { action: "delete", id: "delete-run-3" } })),
    "✓  Deleted subagent run [delete-run-3] · 1 warning",
  );
});

test("clear receipts stay compact when collapsed and list every warning when expanded", () => {
  const changed = {
    content: [{ type: "text", text: "Cleared 3 retained subagent runs." }],
    details: {
      clearedCount: 3,
      warnings: [
        "Retained child session file for run-a: SESSION_WARNING_SENTINEL",
        "Retained run directory for run-b: RUN_DIRECTORY_WARNING_SENTINEL",
      ],
      changed: true,
    },
  };
  const context = { args: { action: "clear" } };
  const collapsed = render(renderSubagentResult(changed, { expanded: false, isPartial: false }, theme, context));
  assert.equal(collapsed, "✓  Cleared 3 retained runs · 2 warnings");
  assert.doesNotMatch(collapsed, /SESSION_WARNING_SENTINEL/);
  const expanded = render(renderSubagentResult(changed, { expanded: true, isPartial: false }, theme, context));
  assertFull(expanded, [
    "✓  Cleared 3 retained runs · 2 warnings",
    "Warnings:",
    "• Retained child session file for run-a: SESSION_WARNING_SENTINEL",
    "• Retained run directory for run-b: RUN_DIRECTORY_WARNING_SENTINEL",
  ]);
  assert.doesNotMatch(expanded, /Goal|sidecar/i);

  const unchanged = {
    content: [{ type: "text", text: "No retained subagent runs to clear." }],
    details: { clearedCount: 0, warnings: [], changed: false },
  };
  assert.equal(
    render(renderSubagentResult(unchanged, { expanded: false, isPartial: false }, theme, context)),
    "○  No retained runs to clear",
  );
  assert.equal(
    render(renderSubagentResult(unchanged, { expanded: true, isPartial: false }, theme, context)),
    "○  No retained runs to clear",
  );
});

test("legacy transcript list derives a Unicode-safe abstract or shows an explicit unavailable placeholder", () => {
  const task = `${"文".repeat(98)}😀🚀tail`;
  const legacy = {
    details: {
      runs: [
        run({ id: "legacy-task", status: "running", abstract: undefined, task }),
        run({ id: "legacy-empty", status: "waiting", abstract: undefined, task: undefined, reason: "need_decision" }),
      ],
    },
  };
  const context = { args: { action: "list" } };
  const collapsed = render(renderSubagentResult(legacy, { expanded: false, isPartial: false }, theme, context));
  assert.equal(collapsed, "●  Subagents (0/2)");
  assert.doesNotMatch(collapsed, /legacy-task|legacy-empty|Legacy run summary unavailable|文/);
  const listText = render(renderSubagentResult(legacy, { expanded: true, isPartial: false }, theme, context), 260);
  assert.match(listText, new RegExp(`${"文".repeat(98)}😀🚀\\.\\.\\.`));
  assert.match(listText, /Legacy run summary unavailable/);
  assert.doesNotMatch(listText, /tail/);
});

test("collapsed list results show only the retained-run heading count", () => {
  const empty = {
    content: [{ type: "text", text: "EMPTY_LIST_MODEL_CONTENT_SENTINEL" }],
    details: { runs: [] },
  };
  const emptyBefore = structuredClone(empty);
  const context = { args: { action: "list" } };
  const emptyCollapsedLines = renderLines(renderSubagentResult(empty, { expanded: false, isPartial: false }, theme, context));
  // An empty retained list collapses to the same single heading line, never to the empty note.
  assert.deepEqual(emptyCollapsedLines, ["", "○  Subagents (0/0)"]);
  const emptyCollapsed = render(renderSubagentResult(empty, { expanded: false, isPartial: false }, theme, context));
  assert.equal(emptyCollapsed, "○  Subagents (0/0)");
  assert.doesNotMatch(emptyCollapsed, /No agents|EMPTY_LIST_MODEL_CONTENT_SENTINEL/);
  const emptyExpanded = render(renderSubagentResult(empty, { expanded: true, isPartial: false }, theme, context));
  assert.equal(emptyExpanded, "○  Subagents (0/0)\nNo subagents.");
  assert.doesNotMatch(emptyExpanded, /EMPTY_LIST_MODEL_CONTENT_SENTINEL/);
  const emptyAnsi = renderSubagentResult(empty, { expanded: false }, roleAnsiTheme, context).render(200)[1].trimEnd();
  assert.equal(emptyAnsi, "\u001b[2m○\u001b[0m  \u001b[2mSubagents (0/0)\u001b[0m");
  assert.deepEqual(empty, emptyBefore);

  const single = {
    content: [{ type: "text", text: "SINGLE_LIST_MODEL_CONTENT_SENTINEL" }],
    details: { runs: [run({ id: "only-id", status: "running", abstract: "ONLY_ABSTRACT_SENTINEL", live: true })] },
  };
  const singleBefore = structuredClone(single);
  const singleCollapsedLines = renderLines(renderSubagentResult(single, { expanded: false, isPartial: false }, theme, context));
  assert.deepEqual(singleCollapsedLines, ["", "●  Subagents (0/1)"]);
  const singleCollapsed = render(renderSubagentResult(single, { expanded: false, isPartial: false }, theme, context));
  assert.equal(singleCollapsed, "●  Subagents (0/1)");
  assert.doesNotMatch(singleCollapsed, /only-id|ONLY_ABSTRACT_SENTINEL|Live:|SINGLE_LIST_MODEL_CONTENT_SENTINEL/);
  const activeAnsi = renderSubagentResult(single, { expanded: false }, roleAnsiTheme, context).render(200)[1].trimEnd();
  assert.equal(activeAnsi, "\u001b[35m\u001b[1m●\u001b[22m\u001b[0m  \u001b[35m\u001b[1mSubagents (0/1)\u001b[22m\u001b[0m");
  const singleExpanded = render(renderSubagentResult(single, { expanded: true, isPartial: false }, theme, context));
  assertFull(singleExpanded, [
    "●  Subagents (0/1)",
    "●  Subagent [only-id] · running · ONLY_ABSTRACT_SENTINEL",
    "Source run: source-run-0",
  ]);
  assert.doesNotMatch(singleExpanded, /SINGLE_LIST_MODEL_CONTENT_SENTINEL|Output:|Error:|Task:/);
  assert.deepEqual(single, singleBefore);
});

test("Ctrl+O collapses waiting notification details without changing model content", () => {
  const message = {
    content: "Model-facing waiting content with the complete request.",
    display: true,
    details: { event: "waiting", status: "waiting", request: run({ status: "waiting" }).request, run: run({ status: "waiting" }) },
  };
  const before = structuredClone(message);
  const collapsed = render(renderSubagentNotification(message, { expanded: false, outputPad: 1 }, theme));
  assert.equal(collapsed, " !  Subagent [run-1] · waiting · Concise run abstract (ctrl+o to expand)");
  assert.doesNotMatch(collapsed, /Request|need_decision|request payload|Choose|A or B|Created|Model-facing/);

  const expanded = render(renderSubagentNotification(message, { expanded: true, outputPad: 1 }, theme));
  assertFull(expanded, [
    "!  Subagent [run-1] · waiting", "!  Request", "need_decision", "<results>request payload</results>",
    "Choose", "A or B?", "Created: 2026-04-17T00:01:00.000Z",
  ]);
  assert.doesNotMatch(expanded, /\(ctrl\+o to expand\)|Task:|Low-value task|Live response|activity payload|Output:|stored output|Error:|stored error|Model:|Cwd:|Tools:|Session:|waitingSeq|Model-facing/);
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
    assert.equal(collapsed, ` ${value.glyph}  Subagent [run-1] · ${value.status} · Concise run abstract (ctrl+o to expand)`);
    assert.doesNotMatch(collapsed, /COMPLETED_OUTPUT|FAILED_ERROR|INTERRUPTED_OUTPUT|INTERRUPTED_ERROR|Model-facing/);

    const expanded = render(renderSubagentNotification(message, { expanded: true, outputPad: 1 }, theme));
    assertFull(expanded, [`${value.glyph}  Subagent [run-1] · ${value.status}`, value.body]);
    if (value.status === "interrupted") assert.match(expanded, /INTERRUPTED_ERROR/);
    assert.doesNotMatch(expanded, /\(ctrl\+o to expand\)|Task:|Low-value task|Live response|activity payload|Model:|Cwd:|Tools:|Request|Model-facing/);
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
  assert.equal(collapsed, " ●  Subagent [run-1] · running · Concise run abstract (ctrl+o to expand)");
  const narrow = renderLines(renderSubagentNotification(message, { expanded: false, outputPad: 1 }, theme), 52);
  assert.ok(narrow.every((line) => visibleWidth(line) <= 52));
  assert.match(render(renderSubagentNotification(message, { expanded: false, outputPad: 1 }, theme), 52).trim(), /· running … \(ctrl\+o to expand\)$/);
  assert.doesNotMatch(collapsed, /Live response|activity payload|toolA|Model-facing/);

  const expanded = render(renderSubagentNotification(message, { expanded: true, outputPad: 1 }, theme));
  assertFull(expanded, ["●  Subagent [run-1] · running", "Live response:", "<results>activity payload</results>", "Active tools:", "toolA"]);
  assert.doesNotMatch(expanded, /\(ctrl\+o to expand\)|Task:|Low-value task|Output:|Error:|Model:|Cwd:|Request|Model-facing/);
  assert.deepEqual(message, before);
});

test("notification fallback collapses to a safe first line and expands full content", () => {
  const message = { content: "Fallback first line\n<results>fallback full payload</results>\nFallback last line" };
  const collapsed = render(renderSubagentNotification(message, { expanded: false, outputPad: 1 }, theme));
  assert.equal(collapsed, " Fallback first line (ctrl+o to expand)");
  assert.doesNotMatch(collapsed, /fallback full payload|Fallback last line/);
  const expanded = render(renderSubagentNotification(message, { expanded: true, outputPad: 1 }, theme));
  assertFull(expanded, ["Fallback first line", "<results>fallback full payload</results>", "Fallback last line"]);
  assert.doesNotMatch(expanded, /\(ctrl\+o to expand\)/);
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

  const checkCollapsed = render(renderSubagentResult(
    result, { expanded: false, isPartial: true }, theme, { args: { action: "check", id: "missing-shape" } },
  ));
  const checkExpanded = render(renderSubagentResult(
    result, { expanded: true, isPartial: true }, theme, { args: { action: "check", id: "missing-shape" } },
  ));
  assert.equal(checkCollapsed, collapsed);
  assert.equal(checkExpanded, expanded);

  const activeRefusal = {
    content: [{ type: "text", text: "Delete requires a terminal retained run\u0000.\nStill active: active-run (running).\nAsk the user whether to interrupt this active run, then retry delete only if they agree." }],
    details: { legacy: true },
  };
  const refusalBefore = structuredClone(activeRefusal);
  const refusalComponent = renderSubagentResult(
    activeRefusal, { expanded: false, isPartial: false, isError: true }, theme, { args: { action: "delete", id: "active-run" } },
  );
  const refusal = render(refusalComponent, 38);
  const refusalFlow = refusal.replace(/\s+/g, " ");
  assert.match(refusalFlow, /Delete requires a terminal retained run \./);
  assert.match(refusalFlow, /Still active: active-run \(running\)\./);
  assert.match(refusalFlow, /Ask the user whether to interrupt this active run, then retry delete only if they agree\./);
  assert.ok(refusalComponent.render(38).every((line) => visibleWidth(line) <= 38));
  const refusalExpanded = render(renderSubagentResult(
    activeRefusal, { expanded: true, isPartial: false, isError: true }, theme, { args: { action: "delete", id: "active-run" } },
  ));
  assertFull(refusalExpanded, ["Delete requires a terminal retained run .", "Still active: active-run (running).", "Ask the user whether to interrupt this active run, then retry delete only if they agree."]);
  assert.deepEqual(activeRefusal, refusalBefore);

  const emptyPartial = render(renderSubagentResult(
    { content: [] }, { expanded: false, isPartial: true }, theme, { args: { action: "create" } },
  ));
  assert.match(emptyPartial, /Result pending/);
});
