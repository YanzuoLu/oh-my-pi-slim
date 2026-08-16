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
  renderSupervisorCall,
  renderSupervisorResult,
} = await import("../extensions/oh-my-pi-slim/subagent-transcript-renderer.ts");

const theme = {
  fg: (_color, text) => text,
  bg: (_color, text) => text,
  bold: (text) => text,
};

function render(component, width = 240) {
  return component.render(width)
    .map((line) => stripVTControlCharacters(line).trimEnd())
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
    task: "Low-value task text that results must not repeat",
    cwd: "/workspace/project",
    model: "openai/gpt-5.6-sol:xhigh",
    tools: ["read", "edit", "contact_supervisor"],
    status: "completed",
    createdAt: "2026-04-17T00:00:00.000Z",
    updatedAt: "2026-04-17T00:02:03.000Z",
    sourceRunId: "source-run-0",
    sessionFile: "/sessions/child.jsonl",
    live: false,
    request: {
      id: "req-1",
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
  const fresh = render(renderSubagentCall({
    agent: "fixer",
    task: "Fresh task line one\n<results>fresh task payload</results>\nFresh task line three",
    cwd: "/full/fresh/cwd",
  }, theme, { cwd: "/context/cwd" }));
  assertFull(fresh, ["Action: fresh", "Agent: fixer", "/full/fresh/cwd", "Fresh task line one", "<results>fresh task payload</results>", "Fresh task line three"]);

  const resume = render(renderSubagentCall({
    action: "resume", id: "source-run-full", message: "Continuation line one\nContinuation line two",
  }, theme));
  assertFull(resume, ["Action: resume", "Source run: source-run-full", "Continuation line one", "Continuation line two"]);

  const steer = render(renderSubagentCall({
    action: "steer", id: "run-steer-full", message: "Guidance line one\n<results>guidance payload</results>",
  }, theme));
  assertFull(steer, ["Action: steer", "Run: run-steer-full", "Guidance line one", "<results>guidance payload</results>"]);

  const interrupt = render(renderSubagentCall({ action: "interrupt", id: "run-interrupt-full" }, theme));
  assertFull(interrupt, ["Action: interrupt", "Run: run-interrupt-full"]);

  const list = render(renderSubagentCall({ action: "list" }, theme));
  assertFull(list, ["Action: list", "every retained run", "status-related request, output, and error text"]);

  const pending = render(renderSupervisorCall({ action: "pending" }, theme));
  assertFull(pending, ["Action: pending", "every pending supervisor request in full"]);

  const reply = render(renderSupervisorCall({
    action: "reply", replyTo: "req-full", message: "Reply line one\n<results>reply payload</results>\nReply line three",
  }, theme));
  assertFull(reply, ["Action: reply", "Request: req-full", "Reply line one", "<results>reply payload</results>", "Reply line three"]);
});

test("subagent immediate results use accurate compact action acknowledgements", () => {
  const fresh = render(renderSubagentResult(
    { details: { run: run({ id: "fresh-id", agent: "explorer", status: "starting", output: undefined, error: undefined }) } },
    { expanded: false, isPartial: false }, theme, { args: { agent: "explorer", task: "full task" } },
  ));
  assert.equal(fresh, "✓ Started explorer [fresh-id] · starting");
  assert.doesNotMatch(fresh, /Subagent result|Task|Cwd|Tools|Model|Activity|Response|Session/);

  const resume = render(renderSubagentResult(
    { details: { run: run({ id: "resume-id", agent: "explorer", status: "starting", output: undefined, error: undefined }) } },
    { expanded: false, isPartial: false }, theme, { args: { action: "resume", id: "source-id", message: "continue" } },
  ));
  assert.equal(resume, "✓ Resumed [source-id] → explorer [resume-id] · starting");

  const steer = render(renderSubagentResult(
    { details: { run: run({ id: "steer-id", agent: "explorer", status: "running", output: undefined, error: undefined }) } },
    { expanded: false, isPartial: false }, theme, { args: { action: "steer", id: "steer-id", message: "focus" } },
  ));
  assert.equal(steer, "✓ Steer requested · explorer [steer-id] · running");

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
    { expanded: false, isPartial: false }, theme, { args: { agent: "fixer", task: "must not repeat" } },
  ));
  assertFull(failed, ["✗ Started fixer [failed-id] · failed", "<results>failure output payload</results>", "<results>failure error payload</results>"]);
  assert.doesNotMatch(failed, /Task:|Cwd:|Model:|Activity|Response:|Live response|Session:/);
});

test("list shows compact status-related sections and never repeats terminal live response", () => {
  const listText = render(renderSubagentResult({
    details: {
      runs: [
        run({
          id: "terminal-id",
          status: "completed",
          activity: { responseText: "TERMINAL RESPONSE MUST NOT APPEAR", activeTools: { old: { name: "read" } } },
        }),
        run({
          id: "active-id",
          agent: "explorer",
          status: "running",
          output: undefined,
          error: undefined,
          activity: {
            responseText: "Active response full\n<results>active response payload</results>",
            activeTools: { liveTool: { name: "grep", startedAt: "now" } },
          },
        }),
        run({
          id: "waiting-id",
          status: "waiting",
          output: undefined,
          error: undefined,
          activity: {
            responseText: "WAITING RESPONSE MUST NOT APPEAR",
            activeTools: { pausedTool: { name: "read" } },
          },
          request: {
            id: "req-waiting",
            runId: "waiting-id",
            reason: "interview_request",
            message: "Waiting message full\n<results>waiting payload</results>",
            interview: { title: "Full interview", questions: [{ prompt: "Full question" }] },
            createdAt: "low-value timestamp",
          },
        }),
      ],
    },
  }, { expanded: false, isPartial: false }, theme, { args: { action: "list" } }));

  assertFull(listText, [
    "Retained subagent runs · 3",
    "✓ fixer [terminal-id] · completed",
    "<results>stored output payload</results>",
    "<results>stored error payload</results>",
    "● explorer [active-id] · running",
    "Live response:",
    "<results>active response payload</results>",
    "liveTool",
    "! fixer [waiting-id] · waiting",
    "Request [req-waiting]",
    "interview_request",
    "<results>waiting payload</results>",
    "Full interview",
    "Full question",
  ]);
  assert.doesNotMatch(listText, /TERMINAL RESPONSE MUST NOT APPEAR|WAITING RESPONSE MUST NOT APPEAR|pausedTool|Task:|Cwd:|Tools:|Model:|Created:|Updated:|Session:|Source run:|Live:/);
  assert.doesNotMatch(listText, /Response:/);
});

test("supervisor pending keeps the full request while reply is one compact line", () => {
  const pending = render(renderSupervisorResult({
    details: {
      pending: [{
        id: "req-pending",
        runId: "run-waiting",
        reason: "interview_request",
        message: "Pending message full\n<results>pending payload</results>",
        interview: { title: "Decision", questions: [{ prompt: "Choose now" }] },
        createdAt: "must not render",
      }],
    },
  }, { expanded: false, isPartial: false }, theme, { args: { action: "pending" } }));
  assertFull(pending, ["req-pending", "run-waiting", "interview_request", "<results>pending payload</results>", "Decision", "Choose now"]);
  assert.doesNotMatch(pending, /Created:|must not render/);

  const reply = render(renderSupervisorResult(
    { details: { run: run({ id: "reply-run", agent: "fixer", status: "running" }) } },
    { expanded: false, isPartial: false }, theme, { args: { action: "reply", replyTo: "req-pending", message: "continue" } },
  ));
  assert.equal(reply, "✓ Replied [req-pending] · fixer [reply-run] · running");
  assert.doesNotMatch(reply, /Task|Output|Error|Activity|Response|Model|Cwd|Status:/);
});

test("terminal notifications contain only compact status and complete output or error", () => {
  for (const [status, glyph] of [["completed", "✓"], ["failed", "✗"], ["interrupted", "✗"]]) {
    const notification = render(renderSubagentNotification({
      content: "Model-facing content must not be duplicated.",
      display: true,
      details: { event: status, status, run: run({ status }) },
    }, { expanded: false, outputPad: 1 }, theme));
    assertFull(notification, [
      `${glyph} fixer [run-1] · ${status}`,
      "<results>stored output payload</results>",
      "<results>stored error payload</results>",
    ]);
    assert.doesNotMatch(notification, /Task:|Low-value task|Response:|Live response|activity payload|Model:|Cwd:|Tools:|Created:|Updated:|Session:|Request|Model-facing content/);
  }
});

test("waiting notification contains only the complete request", () => {
  const notification = render(renderSubagentNotification({
    content: "Model-facing waiting content.",
    display: true,
    details: { event: "waiting", status: "waiting", run: run({ status: "waiting" }) },
  }, { expanded: false, outputPad: 1 }, theme));
  assertFull(notification, [
    "! fixer [run-1] · waiting",
    "Request [req-1]",
    "need_decision",
    "<results>request payload</results>",
    "Choose",
    "A or B?",
  ]);
  assert.doesNotMatch(notification, /Task:|Low-value task|Response:|Live response|activity payload|Output:|stored output|Error:|stored error|Model:|Cwd:|Tools:|Created:|Session:/);
});

test("active notification may show only explicitly labeled live response and active tools", () => {
  const notification = render(renderSubagentNotification({
    content: "Model-facing running content.",
    display: true,
    details: { event: "running", status: "running", run: run({ status: "running", output: undefined, error: undefined }) },
  }, { expanded: false, outputPad: 1 }, theme));
  assertFull(notification, ["● fixer [run-1] · running", "Live response:", "<results>activity payload</results>", "toolA"]);
  assert.doesNotMatch(notification, /Task:|Low-value task|Response:|Output:|Error:|Model:|Cwd:|Tools:|Request/);
});

test("missing details and partial results keep full content fallback", () => {
  const fallback = render(renderSubagentResult({
    content: [{ type: "text", text: "Fallback line one\n<results>fallback payload</results>\nFallback line three" }],
  }, { expanded: false, isPartial: true }, theme, { args: { action: "fresh" } }));
  assertFull(fallback, ["Fallback line one", "<results>fallback payload</results>", "Fallback line three"]);

  const supervisorFallback = render(renderSupervisorResult({
    content: [{ type: "text", text: "Supervisor fallback full\n<results>supervisor fallback payload</results>" }],
  }, { expanded: false, isPartial: true }, theme, { args: { action: "reply", replyTo: "missing" } }));
  assertFull(supervisorFallback, ["Supervisor fallback full", "<results>supervisor fallback payload</results>"]);

  const emptyPartial = render(renderSubagentResult(
    { content: [] }, { expanded: false, isPartial: true }, theme, { args: { action: "fresh" } },
  ));
  assert.match(emptyPartial, /Result pending/);
});
