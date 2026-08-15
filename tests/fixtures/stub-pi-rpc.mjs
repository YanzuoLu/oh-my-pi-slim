#!/usr/bin/env node

import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const scenario = process.env.OMPS_STUB_SCENARIO || "normal";
const sessionFile = join(process.cwd(), `stub-${scenario}-session.jsonl`);
let lastAssistantText = null;
let promptCount = 0;
let settled = false;

if (process.env.OMPS_STUB_PID_FILE) writeFileSync(process.env.OMPS_STUB_PID_FILE, String(process.pid));
if (scenario === "terminal-order") {
  process.on("SIGTERM", () => {
    setTimeout(() => {
      if (process.env.OMPS_STUB_EXIT_FILE) writeFileSync(process.env.OMPS_STUB_EXIT_FILE, "exited");
      process.exit(0);
    }, 100);
  });
}

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function respond(command, data) {
  send({ type: "response", id: command.id, command: command.type, success: true, data });
}

function assistant(text, stopReason = "stop") {
  lastAssistantText = text;
  send({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      stopReason,
      usage: { totalTokens: 42 },
    },
  });
}

function complete(text) {
  send({ type: "turn_start", turnIndex: promptCount, timestamp: Date.now() });
  send({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text.slice(0, 4) }, usage: { totalTokens: 21 } });
  send({ type: "tool_execution_start", toolCallId: "tool-1", toolName: "read", args: {} });
  send({ type: "tool_execution_end", toolCallId: "tool-1", toolName: "read", result: { content: [] }, isError: false });
  send({ type: "session_compact", reason: "threshold" });
  assistant(text);
  settled = true;
  send({ type: "agent_settled" });
}

function handlePrompt(command) {
  promptCount += 1;
  if (scenario === "contact-reply-hang" && promptCount === 2) return;
  respond(command, {});
  setTimeout(() => {
    if (scenario === "normal" || scenario === "terminal-order") complete(`${scenario} completion`);
    else if (scenario === "long-stream") {
      const text = "0123456789abcdef".repeat(4096);
      send({ type: "turn_start", turnIndex: promptCount, timestamp: Date.now() });
      for (let offset = 0; offset < text.length; offset += 128) {
        send({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: text.slice(offset, offset + 128) },
          usage: { totalTokens: offset + 128 },
        });
      }
      setTimeout(() => {
        assistant(text);
        settled = true;
        send({ type: "agent_settled" });
      }, 250);
    } else if (scenario.startsWith("contact") && promptCount === 1) {
      send({ type: "turn_start", turnIndex: 1, timestamp: Date.now() });
      send({ type: "tool_execution_start", toolCallId: "contact-1", toolName: "contact_supervisor", args: {} });
      send({
        type: "tool_execution_end",
        toolCallId: "contact-1",
        toolName: "contact_supervisor",
        result: {
          details: {
            request: {
              id: "request-1",
              runId: process.env.OMPS_RUN_ID,
              reason: "need_decision",
              message: "choose a path",
              createdAt: new Date().toISOString(),
            },
          },
        },
        isError: false,
      });
      send({ type: "agent_settled" });
    } else if (scenario === "contact-reply-crash") {
      process.stderr.write("reply crash\n");
      process.exit(23);
    } else if (scenario.startsWith("contact")) complete("completed after reply");
    else if (scenario === "steer") {
      send({ type: "turn_start", turnIndex: 1, timestamp: Date.now() });
    } else if (scenario === "crash") {
      process.stderr.write("stub crash\n");
      process.exit(17);
    }
  }, 30);
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  let command;
  try { command = JSON.parse(line); } catch { return; }
  if (!command || typeof command.id !== "string") return;
  if (command.type === "get_state") {
    respond(command, { sessionFile, isStreaming: !settled });
  } else if (command.type === "get_session_stats") {
    respond(command, {
      sessionFile,
      tokens: { input: 20, output: 22, cacheRead: 0, cacheWrite: 0, total: 42 },
      contextUsage: { tokens: 50, contextWindow: 200, percent: 25 },
    });
  } else if (command.type === "get_last_assistant_text") {
    respond(command, { text: lastAssistantText });
  } else if (command.type === "prompt") {
    handlePrompt(command);
  } else if (command.type === "steer") {
    respond(command, {});
    if (scenario === "steer") setTimeout(() => complete(`steered: ${command.message}`), 20);
  } else if (command.type === "abort") {
    respond(command, {});
  } else {
    respond(command, {});
  }
});
