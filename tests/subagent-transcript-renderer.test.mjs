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
  "./semantic-glyph.js": new URL("../extensions/oh-my-pi-slim/semantic-glyph.ts", import.meta.url).href,
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

  const statusCollapsed = render(renderSubagentCall({ action: "status", id: "run-status-full" }, theme, { expanded: false }));
  const statusExpanded = render(renderSubagentCall({ action: "status", id: "run-status-full" }, theme, { expanded: true }));
  assert.equal(statusCollapsed, "subagent · status · run-status-full (ctrl+o to expand)");
  assert.equal(statusExpanded, "subagent · status\nRun: run-status-full");

  const interruptCollapsed = render(renderSubagentCall({ action: "interrupt", id: "run-interrupt-full" }, theme, { expanded: false }));
  const interruptExpanded = render(renderSubagentCall({ action: "interrupt", id: "run-interrupt-full" }, theme, { expanded: true }));
  assert.equal(interruptCollapsed, "subagent · interrupt (ctrl+o to expand)\nRun: run-interrupt-full");
  assert.equal(interruptExpanded, "subagent · interrupt\nRun: run-interrupt-full");

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

  for (const value of [createCollapsed, resumeCollapsed, steerCollapsed, replyCollapsed, statusCollapsed, interruptCollapsed, listCollapsed, clearCollapsed]) {
    assert.match(value.split("\n")[0], /\(ctrl\+o to expand\)$/);
    assert.doesNotMatch(value, /Action:/);
  }
  for (const value of [createExpanded, resumeExpanded, steerExpanded, replyExpanded, statusExpanded, interruptExpanded, listExpanded, clearExpanded]) {
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
    { expanded: false, isPartial: false }, theme, { args: { action: "create", agent: "explorer", task: "spacing task" } },
  ));
  assert.equal(subagent[0], "");
  assert.equal(subagent[1], "✓  Started explorer [spacing-run] · starting");

  const reply = renderLines(renderSubagentResult(
    { details: { run: run({ id: "spacing-reply", agent: "fixer", status: "running" }) } },
    { expanded: false, isPartial: false }, theme, { args: { action: "reply", id: "spacing-reply", message: "continue" } },
  ));
  assert.equal(reply[0], "");
  assert.equal(reply[1], "✓  Replied · fixer [spacing-reply] · running");
});

test("subagent immediate results use accurate compact action acknowledgements", () => {
  const created = render(renderSubagentResult(
    { details: { run: run({ id: "create-id", agent: "explorer", status: "starting", output: undefined, error: undefined }) } },
    { expanded: false, isPartial: false }, theme, { args: { action: "create", agent: "explorer", task: "full task" } },
  ));
  assert.equal(created, "✓  Started explorer [create-id] · starting");
  assert.doesNotMatch(created, /Subagent result|Task|Cwd|Tools|Model|Activity|Response|Session/);

  const resume = render(renderSubagentResult(
    { details: { run: run({ id: "resume-id", agent: "explorer", status: "starting", output: undefined, error: undefined }) } },
    { expanded: false, isPartial: false }, theme, { args: { action: "resume", id: "source-id", abstract: "new summary", message: "continue" } },
  ));
  assert.equal(resume, "✓  Resumed [source-id] → explorer [resume-id] · starting");

  const steer = render(renderSubagentResult(
    { details: { run: run({ id: "steer-id", agent: "explorer", status: "running", output: undefined, error: undefined }) } },
    { expanded: false, isPartial: false }, theme, { args: { action: "steer", id: "steer-id", message: "focus" } },
  ));
  assert.equal(steer, "✓  Steer requested · explorer [steer-id] · running");

  const reply = render(renderSubagentResult(
    { details: { run: run({ id: "reply-id", agent: "fixer", status: "running", output: undefined, error: undefined }) } },
    { expanded: false, isPartial: false }, theme, { args: { action: "reply", id: "reply-id", message: "continue" } },
  ));
  assert.equal(reply, "✓  Replied · fixer [reply-id] · running");

  // A legacy transcript entry recorded before interrupt became synchronous replays without an outcome.
  const legacyInterrupt = render(renderSubagentResult(
    { details: { run: run({ id: "interrupt-id", agent: "explorer", status: "running", output: undefined, error: undefined }) } },
    { expanded: false, isPartial: false }, theme, { args: { action: "interrupt", id: "interrupt-id" } },
  ));
  assert.equal(legacyInterrupt, "!  Interrupt requested · explorer [interrupt-id] · running");

  const terminalResult = { details: { run: run({ id: "done-id", agent: "explorer", status: "completed", output: "terminal output", error: undefined }), outcome: "already-terminal" } };
  const alreadyTerminalCollapsed = render(renderSubagentResult(
    terminalResult, { expanded: false, isPartial: false }, theme, { args: { action: "interrupt", id: "done-id" } },
  ));
  assert.equal(alreadyTerminalCollapsed, "✓  explorer [done-id] · already completed");
  assert.doesNotMatch(alreadyTerminalCollapsed, /terminal output|Interrupt requested/);
  // The reconciled terminal notification still owns that full result, so the receipt never repeats it.
  const alreadyTerminalExpanded = render(renderSubagentResult(
    terminalResult, { expanded: true, isPartial: false }, theme, { args: { action: "interrupt", id: "done-id" } },
  ));
  assert.equal(alreadyTerminalExpanded, "✓  explorer [done-id] · already completed");
  assert.doesNotMatch(alreadyTerminalExpanded, /terminal output|Output:|Error:/);

  const failedResult = { details: { run: run({ id: "failed-steer-id", agent: "fixer", status: "failed", output: undefined, error: "stored failure" }) } };
  const failedSteerCollapsed = render(renderSubagentResult(
    failedResult, { expanded: false, isPartial: false }, theme, { args: { action: "steer", id: "failed-steer-id", message: "too late" } },
  ));
  assert.equal(failedSteerCollapsed, "✗  fixer [failed-steer-id] · already failed");
  assert.doesNotMatch(failedSteerCollapsed, /stored failure|Steer requested/);
  const failedSteerExpanded = render(renderSubagentResult(
    failedResult, { expanded: true, isPartial: false }, theme, { args: { action: "steer", id: "failed-steer-id", message: "too late" } },
  ));
  assert.equal(failedSteerExpanded, "✗  fixer [failed-steer-id] · already failed");
  assert.doesNotMatch(failedSteerExpanded, /stored failure|Output:|Error:/);
});

test("synchronous interrupt outcomes collapse to the final result and expand its complete output and error", () => {
  for (const { outcome, status, glyph, collapsed } of [
    { outcome: "stopped", status: "interrupted", glyph: "✗", collapsed: "✗  fixer [stop-id] · interrupted · stopped" },
    { outcome: "raced", status: "completed", glyph: "✓", collapsed: "✓  fixer [stop-id] · completed before interrupt" },
    { outcome: "unconfirmed", status: "interrupted", glyph: "✗", collapsed: "✗  fixer [stop-id] · interrupted · stop unconfirmed" },
  ]) {
    const result = {
      content: [{ type: "text", text: `Run stop-id (fixer) is ${status}.` }],
      details: {
        outcome,
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
    assert.doesNotMatch(expanded, /INTERRUPT_TASK_SENTINEL|INTERRUPT_ACTIVITY_SENTINEL|Task:|Cwd:|Model:|Live response/);
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
    assert.equal(collapsed, `${glyph}  fixer [legacy-steer-${status}] · already ${status}`);
    const expanded = render(renderSubagentResult(legacy, { expanded: true, isPartial: false }, theme, context));
    assert.equal(expanded, `${glyph}  fixer [legacy-steer-${status}] · already ${status}`);
    for (const value of [collapsed, expanded]) {
      assert.doesNotMatch(value, /SENTINEL/);
      assert.doesNotMatch(value, /Output:|Error:|Live response|Task:|Session:/);
    }

    // subagent status stays the explicit full-result entry point for the very same run shape.
    const statusExpanded = render(renderSubagentResult(
      legacy, { expanded: true, isPartial: false }, theme, { args: { action: "status", id: `legacy-steer-${status}` } },
    ));
    if (output !== undefined) assert.match(statusExpanded, new RegExp(output));
    if (error !== undefined) assert.match(statusExpanded, new RegExp(error));
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
    result, { expanded: false, isPartial: false }, theme, { args: { action: "create", agent: "fixer", task: "must not repeat" } },
  ));
  assert.equal(collapsed, "✗  Started fixer [failed-id] · failed");
  assert.doesNotMatch(collapsed, /failure output|failure error|Task:/i);
  const expanded = render(renderSubagentResult(
    result, { expanded: true, isPartial: false }, theme, { args: { action: "create", agent: "fixer", task: "must not repeat" } },
  ));
  assertFull(expanded, ["✗  Started fixer [failed-id] · failed", "<results>failure output payload</results>", "<results>failure error payload</results>"]);
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
  const collapsedLines = renderLines(renderSubagentResult(result, { expanded: false, isPartial: false }, theme, { args: { action: "list" } }));
  const collapsed = collapsedLines.join("\n").replace(/^\n+|\n+$/g, "");
  // Collapsed is exactly one heading line after the shared tool-result separator: no run rows, no blank filler.
  assert.deepEqual(collapsedLines, ["", "Retained subagent run status · 3"]);
  assert.equal(collapsed, "Retained subagent run status · 3");
  assert.doesNotMatch(collapsed, /terminal-id|active-id|waiting-id|fixer|explorer|No retained runs/);
  assert.doesNotMatch(collapsed, /Reason:|Source run:|Live:|interview_request|OUTPUT_SENTINEL|ERROR_SENTINEL/);
  const expanded = render(renderSubagentResult(result, { expanded: true, isPartial: false }, theme, { args: { action: "list" } }));
  assert.doesNotMatch(expanded, /[✓●!] [^ ]|[✓●!] {3}/);
  assertFull(expanded, [
    "Retained subagent run status · 3",
    "✓  fixer [terminal-id] · completed  TERMINAL_ABSTRACT_SENTINEL",
    "Live: false",
    "Source run: SOURCE_SENTINEL",
    "●  explorer [active-id] · running  active abstract",
    "!  fixer [waiting-id] · waiting  waiting abstract",
    "Reason: interview_request",
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

test("status result stays single-line collapsed and expands only public summary fields plus terminal results", () => {
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
  const context = { args: { action: "status", id: "status-terminal" } };
  const collapsed = render(renderSubagentResult(terminal, { expanded: false, isPartial: false }, theme, context));
  assert.equal(collapsed, "✗  fixer [status-terminal] · failed  status terminal abstract");
  assert.doesNotMatch(collapsed, /Live:|Source run:|STATUS_OUTPUT|STATUS_ERROR|Task:|Model:/);
  const expanded = render(renderSubagentResult(terminal, { expanded: true, isPartial: false }, theme, context));
  assertFull(expanded, [
    "✗  fixer [status-terminal] · failed  status terminal abstract",
    "Live: false", "Source run: status-source",
    "<results>status output payload</results>", "<results>status error payload</results>",
  ]);
  assert.doesNotMatch(expanded, /Task:|Cwd:|Model:|Tools:|Created:|Updated:|Session:|Activity|Request:|waitingSeq|notificationPending|content must stay invariant/);
  assert.deepEqual(terminal, before);

  const waiting = {
    content: [{ type: "text", text: "waiting model content" }],
    details: { run: {
      id: "status-waiting", agent: "explorer", abstract: "status waiting abstract",
      status: "waiting", live: true, reason: "progress_update",
      output: "NONTERMINAL_OUTPUT_SENTINEL", error: "NONTERMINAL_ERROR_SENTINEL",
    } },
  };
  const waitingBefore = structuredClone(waiting);
  const waitingExpanded = render(renderSubagentResult(
    waiting, { expanded: true, isPartial: false }, theme, { args: { action: "status", id: "status-waiting" } },
  ));
  assertFull(waitingExpanded, [
    "!  explorer [status-waiting] · waiting  status waiting abstract",
    "Live: true", "Reason: progress_update",
  ]);
  assert.doesNotMatch(waitingExpanded, /NONTERMINAL_OUTPUT|NONTERMINAL_ERROR|Output:|Error:|waiting model content/);
  assert.deepEqual(waiting, waitingBefore);
});

test("clear receipts stay compact when collapsed and list every retained-item warning when expanded", () => {
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
  assert.equal(collapsed, "✓  Cleared 3 retained runs · 2 retained items");
  assert.doesNotMatch(collapsed, /SESSION_WARNING_SENTINEL/);
  const expanded = render(renderSubagentResult(changed, { expanded: true, isPartial: false }, theme, context));
  assertFull(expanded, [
    "✓  Cleared 3 retained runs · 2 retained items",
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
  assert.equal(collapsed, "Retained subagent run status · 2");
  assert.doesNotMatch(collapsed, /legacy-task|legacy-empty|Legacy run summary unavailable|文/);
  const listText = render(renderSubagentResult(legacy, { expanded: true, isPartial: false }, theme, context));
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
  // An empty retained list collapses to the same single heading line, never to "No retained runs.".
  assert.deepEqual(emptyCollapsedLines, ["", "Retained subagent run status · 0"]);
  const emptyCollapsed = render(renderSubagentResult(empty, { expanded: false, isPartial: false }, theme, context));
  assert.equal(emptyCollapsed, "Retained subagent run status · 0");
  assert.doesNotMatch(emptyCollapsed, /No retained runs|EMPTY_LIST_MODEL_CONTENT_SENTINEL/);
  const emptyExpanded = render(renderSubagentResult(empty, { expanded: true, isPartial: false }, theme, context));
  assert.equal(emptyExpanded, "Retained subagent run status · 0\nNo retained runs.");
  assert.doesNotMatch(emptyExpanded, /EMPTY_LIST_MODEL_CONTENT_SENTINEL/);
  assert.deepEqual(empty, emptyBefore);

  const single = {
    content: [{ type: "text", text: "SINGLE_LIST_MODEL_CONTENT_SENTINEL" }],
    details: { runs: [run({ id: "only-id", status: "running", abstract: "ONLY_ABSTRACT_SENTINEL", live: true })] },
  };
  const singleBefore = structuredClone(single);
  const singleCollapsedLines = renderLines(renderSubagentResult(single, { expanded: false, isPartial: false }, theme, context));
  assert.deepEqual(singleCollapsedLines, ["", "Retained subagent run status · 1"]);
  const singleCollapsed = render(renderSubagentResult(single, { expanded: false, isPartial: false }, theme, context));
  assert.equal(singleCollapsed, "Retained subagent run status · 1");
  assert.doesNotMatch(singleCollapsed, /only-id|ONLY_ABSTRACT_SENTINEL|Live:|SINGLE_LIST_MODEL_CONTENT_SENTINEL/);
  const singleExpanded = render(renderSubagentResult(single, { expanded: true, isPartial: false }, theme, context));
  assertFull(singleExpanded, [
    "Retained subagent run status · 1",
    "●  fixer [only-id] · running  ONLY_ABSTRACT_SENTINEL",
    "Live: true",
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
  assert.equal(collapsed, " !  fixer [run-1] · waiting (ctrl+o to expand)");
  assert.doesNotMatch(collapsed, /Request|need_decision|request payload|Choose|A or B|Created|Model-facing/);

  const expanded = render(renderSubagentNotification(message, { expanded: true, outputPad: 1 }, theme));
  assertFull(expanded, [
    "!  fixer [run-1] · waiting", "!  Request", "need_decision", "<results>request payload</results>",
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
    assert.equal(collapsed, ` ${value.glyph}  fixer [run-1] · ${value.status} (ctrl+o to expand)`);
    assert.doesNotMatch(collapsed, /COMPLETED_OUTPUT|FAILED_ERROR|INTERRUPTED_OUTPUT|INTERRUPTED_ERROR|Model-facing/);

    const expanded = render(renderSubagentNotification(message, { expanded: true, outputPad: 1 }, theme));
    assertFull(expanded, [`${value.glyph}  fixer [run-1] · ${value.status}`, value.body]);
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
  assert.equal(collapsed, " ●  fixer [run-1] · running (ctrl+o to expand)");
  const narrow = renderLines(renderSubagentNotification(message, { expanded: false, outputPad: 1 }, theme), 52);
  assert.ok(narrow.every((line) => visibleWidth(line) <= 52));
  assert.match(render(renderSubagentNotification(message, { expanded: false, outputPad: 1 }, theme), 52).trim(), /· running \(ctrl\+o to expand\)$/);
  assert.doesNotMatch(collapsed, /Live response|activity payload|toolA|Model-facing/);

  const expanded = render(renderSubagentNotification(message, { expanded: true, outputPad: 1 }, theme));
  assertFull(expanded, ["●  fixer [run-1] · running", "Live response:", "<results>activity payload</results>", "Active tools:", "toolA"]);
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

  const statusCollapsed = render(renderSubagentResult(
    result, { expanded: false, isPartial: true }, theme, { args: { action: "status", id: "missing-shape" } },
  ));
  const statusExpanded = render(renderSubagentResult(
    result, { expanded: true, isPartial: true }, theme, { args: { action: "status", id: "missing-shape" } },
  ));
  assert.equal(statusCollapsed, collapsed);
  assert.equal(statusExpanded, expanded);

  const emptyPartial = render(renderSubagentResult(
    { content: [] }, { expanded: false, isPartial: true }, theme, { args: { action: "create" } },
  ));
  assert.match(emptyPartial, /Result pending/);
});
