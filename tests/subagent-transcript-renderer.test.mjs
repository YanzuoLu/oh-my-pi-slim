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
  "./subagent-model-display.js": new URL("../extensions/oh-my-pi-slim/subagent-model-display.ts", import.meta.url).href,
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
  return component.render(width).map((line) => stripVTControlCharacters(line)).join("\n");
}

function assertFull(text, expected) {
  for (const value of expected) assert.match(text, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(text, /\bpreview\b|\btruncated\b|\.\.\. \d+ more/i);
}

function run(overrides = {}) {
  return {
    id: "run-complete-1",
    agent: "fixer",
    task: "First task line\n<results>task payload remains visible</results>\nFinal task line",
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
      runId: "run-complete-1",
      reason: "need_decision",
      message: "Full request message\n<results>request payload</results>",
      interview: { title: "Choose", questions: [{ prompt: "A or B?" }] },
      createdAt: "2026-04-17T00:01:00.000Z",
    },
    activity: {
      turnCount: 3,
      toolUses: 4,
      activeTools: { toolA: { name: "read", startedAt: "2026-04-17T00:01:30.000Z" } },
      responseText: "Full activity response\n<results>activity payload</results>",
      tokens: 8200,
      contextPercent: 31,
      compactionCount: 2,
    },
    output: "Complete output line one\n<results>stored output payload</results>\nComplete output line three",
    error: "Complete error line one\n<results>stored error payload</results>\nComplete error line three",
    ...overrides,
  };
}

test("subagent and supervisor call renderers always show complete action-specific input", () => {
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
  assertFull(list, ["Action: list", "every retained run", "complete stored result", "full output and error fields"]);

  const pending = render(renderSupervisorCall({ action: "pending" }, theme));
  assertFull(pending, ["Action: pending", "every pending supervisor request in full"]);

  const reply = render(renderSupervisorCall({
    action: "reply", replyTo: "req-full", message: "Reply line one\n<results>reply payload</results>\nReply line three",
  }, theme));
  assertFull(reply, ["Action: reply", "Request: req-full", "Reply line one", "<results>reply payload</results>", "Reply line three"]);
});

test("subagent result renderer shows one complete structured run and safely falls back to full content", () => {
  const structured = render(renderSubagentResult({
    content: [{ type: "text", text: "model-facing summary is not used as a display substitute" }],
    details: { run: run() },
  }, { expanded: false, isPartial: false }, theme));
  assertFull(structured, [
    "✓ fixer [run-complete-1] · completed",
    "Model: (openai) gpt-5.6-sol • xhigh",
    "Status: completed",
    "Live: false",
    "Created: 2026-04-17T00:00:00.000Z",
    "Updated: 2026-04-17T00:02:03.000Z",
    "Cwd: /workspace/project",
    "Tools: read, edit, contact_supervisor",
    "Source run: source-run-0",
    "Session: /sessions/child.jsonl",
    "<results>task payload remains visible</results>",
    "Request [req-1]",
    "<results>request payload</results>",
    "Turns: 3",
    "Tool uses: 4",
    "Tokens: 8200",
    "Context: 31%",
    "Compactions: 2",
    "toolA",
    "<results>activity payload</results>",
    "<results>stored output payload</results>",
    "<results>stored error payload</results>",
  ]);

  const fallback = render(renderSubagentResult({
    content: [{ type: "text", text: "Fallback line one\n<results>fallback payload</results>\nFallback line three" }],
  }, { expanded: false, isPartial: true }, theme));
  assertFull(fallback, ["Fallback line one", "<results>fallback payload</results>", "Fallback line three"]);

  const emptyPartial = render(renderSubagentResult({ content: [] }, { expanded: false, isPartial: true }, theme));
  assert.match(emptyPartial, /Result pending/);
});

test("list and supervisor results render every complete section without expansion gates", () => {
  const listText = render(renderSubagentResult({
    content: [{ type: "text", text: "list context" }],
    details: {
      runs: [
        run({ id: "run-list-a", output: "A output full\n<results>A output payload</results>", error: "A error full" }),
        run({ id: "run-list-b", agent: "oracle", status: "failed", output: "B output full", error: "B error full\n<results>B error payload</results>" }),
      ],
    },
  }, { expanded: false, isPartial: false }, theme));
  assertFull(listText, [
    "Retained subagent runs · 2",
    "run-list-a",
    "A output full",
    "<results>A output payload</results>",
    "A error full",
    "run-list-b",
    "B output full",
    "B error full",
    "<results>B error payload</results>",
  ]);

  const pendingText = render(renderSupervisorResult({
    content: [{ type: "text", text: "pending context" }],
    details: {
      pending: [{
        id: "req-pending-full",
        runId: "run-waiting-full",
        reason: "interview_request",
        message: "Pending message line one\n<results>pending payload</results>\nPending message line three",
        interview: { title: "Full interview", questions: [{ prompt: "Full question" }] },
        createdAt: "2026-04-17T00:03:00.000Z",
      }],
    },
  }, { expanded: false, isPartial: false }, theme));
  assertFull(pendingText, ["req-pending-full", "run-waiting-full", "interview_request", "<results>pending payload</results>", "Full interview", "Full question"]);

  const replyText = render(renderSupervisorResult({ details: { run: run({ id: "run-after-reply", status: "running" }) } }, { expanded: false, isPartial: false }, theme));
  assertFull(replyText, ["Supervisor reply result", "run-after-reply", "Status: running", "<results>stored output payload</results>", "<results>stored error payload</results>"]);
});

test("notification renderer displays the same structured follow-up with complete stored text", () => {
  const notification = render(renderSubagentNotification({
    customType: "oh-my-pi-slim:subagent-notification",
    content: "Model-facing notification content remains one message.",
    display: true,
    details: {
      event: "completed",
      status: "completed",
      runId: "run-complete-1",
      requestId: "req-1",
      reason: "need_decision",
      run: run(),
    },
  }, { expanded: false, outputPad: 1 }, theme));
  assertFull(notification, [
    "✓ Subagent notification · completed",
    "fixer [run-complete-1] · completed",
    "Model: (openai) gpt-5.6-sol • xhigh",
    "<results>task payload remains visible</results>",
    "<results>request payload</results>",
    "<results>activity payload</results>",
    "<results>stored output payload</results>",
    "<results>stored error payload</results>",
  ]);
  assert.doesNotMatch(notification, /Model-facing notification content remains one message/);
});
