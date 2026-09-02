import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CACHE = join(ROOT, ".cache");
const MAIN_EXTENSION = join(ROOT, "extensions/oh-my-pi-slim/index.ts");
const CHILD_EXTENSION = join(ROOT, "extensions/oh-my-pi-slim/subagent/child-supervisor.ts");
const PROBE_EXTENSION = join(ROOT, "tests/fixtures/omps-load-probe.ts");
const ASK_RPC_PROBE_EXTENSION = join(ROOT, "tests/fixtures/ask-rpc-probe.ts");

function isolatedEnv(agentDir, child = false) {
  const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir };
  if (child) {
    env.PI_SUBAGENT_CHILD = "1";
    env.OMPS_SUBAGENT_CHILD = "1";
    env.OMPS_PARENT_RUN_ID = "load-probe-child";
  } else {
    delete env.PI_SUBAGENT_CHILD;
    delete env.OMPS_SUBAGENT_CHILD;
    delete env.OMPS_PARENT_RUN_ID;
  }
  return env;
}

function runPi(agentDir, input, child = false) {
  const extensions = child
    ? [MAIN_EXTENSION, CHILD_EXTENSION, PROBE_EXTENSION]
    : [MAIN_EXTENSION, PROBE_EXTENSION];
  const args = [
    "--mode", "rpc",
    "--no-session",
    "--offline",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--no-builtin-tools",
    ...extensions.flatMap((extension) => ["--extension", extension]),
  ];
  const result = spawnSync("pi", args, {
    cwd: ROOT,
    env: isolatedEnv(agentDir, child),
    input: `${JSON.stringify({ id: "probe", type: "prompt", message: input })}\n`,
    encoding: "utf8",
    timeout: 20_000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const events = result.stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  assert.doesNotMatch(result.stderr, /extension_error|runtime not initialized/i);
  assert.equal(events.some((event) => event.type === "extension_error"), false);
  assert.equal(events.some((event) => event.type === "extension_ui_request" && event.method === "setWidget"), false);
  // The read-only Subagent viewer is TUI-only: neither a main RPC session nor a child session may open it.
  assert.equal(events.some((event) => event.type === "extension_ui_request" && event.method === "custom"), false);
  return events;
}

function notificationJson(events, prefix) {
  const notification = events.find((event) =>
    event.type === "extension_ui_request" && event.method === "notify" && event.message?.startsWith(prefix));
  assert.ok(notification, events.map((event) => JSON.stringify(event)).join("\n"));
  return JSON.parse(notification.message.slice(prefix.length));
}

const ASK_RPC_COMPLETE_SCRIPT = ["Option 1: Safe", "[ ] Option 2: Metrics", "Done with this question"];

function runAskRpcDialog(agentDir, selectScript = ASK_RPC_COMPLETE_SCRIPT) {
  const args = [
    "--mode", "rpc",
    "--no-session",
    "--offline",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--no-builtin-tools",
    "--extension", MAIN_EXTENSION,
    "--extension", ASK_RPC_PROBE_EXTENSION,
  ];
  return new Promise((resolve, reject) => {
    const child = spawn("pi", args, {
      cwd: ROOT,
      env: isolatedEnv(agentDir),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const events = [];
    let stdout = "";
    let stdoutLog = "";
    let stderr = "";
    let selectCount = 0;
    let resultSeen = false;
    let settled = false;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Ask RPC probe timed out.\n${stderr}\n${stdoutLog}`));
    }, 20_000);

    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      reject(error);
    };
    const acceptLine = (line) => {
      if (!line) return;
      let event;
      try { event = JSON.parse(line); }
      catch (error) { fail(new Error(`Ask RPC emitted invalid JSON: ${error.message}\n${line}`)); return; }
      events.push(event);
      if (event.type === "extension_ui_request" && event.method === "notify" && event.message?.startsWith("ASK_RPC_PROBE ")) {
        resultSeen = true;
        child.stdin.end();
        child.kill("SIGTERM");
        return;
      }
      if (event.type !== "extension_ui_request" || event.method !== "select") return;
      const value = selectScript[Math.min(selectCount, selectScript.length - 1)];
      selectCount += 1;
      child.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: event.id, value })}\n`);
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      stdoutLog += chunk;
      while (true) {
        const newline = stdout.indexOf("\n");
        if (newline < 0) break;
        let line = stdout.slice(0, newline);
        stdout = stdout.slice(newline + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        acceptLine(line);
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", fail);
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (stdout) acceptLine(stdout.endsWith("\r") ? stdout.slice(0, -1) : stdout);
      const stoppedAfterResult = code === 0 || signal === "SIGTERM" || (code === 143 && signal === null);
      if (!resultSeen || !stoppedAfterResult) {
        reject(new Error(`Ask RPC probe exited with code ${code} signal ${signal}.\n${stderr}\n${stdoutLog}`));
        return;
      }
      resolve({ events, stderr });
    });
    child.stdin.write(`${JSON.stringify({ id: "ask-probe", type: "prompt", message: "/ask-rpc-probe" })}\n`);
  });
}

test("real Pi isolated RPC main and child sessions expose exact package tools without widgets", () => {
  mkdirSync(CACHE, { recursive: true });
  const mainAgentDir = mkdtempSync(join(CACHE, "omps-main-pi-smoke-"));
  const childAgentDir = mkdtempSync(join(CACHE, "omps-child-pi-smoke-"));
  try {
    const main = notificationJson(runPi(mainAgentDir, "/omps-load-probe"), "OMPS_LOAD_PROBE ");
    assert.deepEqual(main.tools, ["ask_user_question", "goal", "monitor", "subagent", "todo"]);
    assert.deepEqual(main.activeTools, ["ask_user_question", "goal", "monitor", "subagent", "todo"]);
    assert.deepEqual(main.commands, ["cache", "fast", "goal"]);
    assert.deepEqual(Object.keys(main.descriptions).sort(), [...main.tools].sort());
    for (const description of Object.values(main.descriptions)) assert.equal(description.length > 0, true);
    assert.match(main.descriptions.ask_user_question, /## Rules/);
    for (const name of ["goal", "monitor", "subagent", "todo"]) assert.match(main.descriptions[name], /## Actions/);
    assert.deepEqual(main.promptSnippets, {});
    assert.deepEqual(main.flattenedGuidelines, []);
    assert.equal(main.schemas.ask_user_question.rootType, "object");
    assert.equal(main.schemas.ask_user_question.additionalProperties, false);
    assert.equal(main.schemas.ask_user_question.rootHasUnion, false);
    assert.deepEqual(main.schemas.goal, {
      rootType: "object",
      additionalProperties: false,
      rootHasUnion: false,
      actions: ["create", "check", "modify", "pause", "resume", "complete", "clear"],
    });
    assert.equal(main.schemas.contact_supervisor, null);
    assert.equal(main.schemas.monitor.rootType, "object");
    assert.equal(main.schemas.monitor.additionalProperties, false);
    assert.equal(main.schemas.monitor.rootHasUnion, false);
    assert.deepEqual(main.schemas.monitor.actions, ["create", "list", "check", "stop", "clear"]);
    assert.match(main.descriptions.monitor, /Each stdout line becomes an event notification/);
    assert.equal(main.schemas.subagent.rootType, "object");
    assert.equal(main.schemas.subagent.additionalProperties, false);
    assert.equal(main.schemas.subagent.rootHasUnion, false);
    assert.deepEqual(main.schemas.subagent.actions, ["create", "list", "check", "steer", "interrupt", "reply", "resume", "delete", "clear"]);
    assert.equal(main.schemas.todo.rootType, "object");
    assert.equal(main.schemas.todo.additionalProperties, false);
    assert.equal(main.schemas.todo.rootHasUnion, false);

    const child = notificationJson(runPi(childAgentDir, "/omps-load-probe", true), "OMPS_LOAD_PROBE ");
    assert.deepEqual(child.tools, ["contact_supervisor"]);
    assert.deepEqual(child.activeTools, ["contact_supervisor"]);
    assert.deepEqual(child.commands, []);
    assert.deepEqual(Object.keys(child.descriptions), ["contact_supervisor"]);
    assert.match(child.descriptions.contact_supervisor, /moves the run to `waiting`/);
    assert.deepEqual(child.promptSnippets, {});
    assert.deepEqual(child.flattenedGuidelines, []);
    const guidelinesByTool = { ...main.guidelinesByTool, ...child.guidelinesByTool };
    assert.deepEqual(Object.keys(guidelinesByTool).sort(), [...new Set([...main.tools, ...child.tools])].sort());
    assert.deepEqual(guidelinesByTool, Object.fromEntries([...main.tools, ...child.tools].map((tool) => [tool, []])));
    assert.equal(child.schemas.ask_user_question, null);
    assert.equal(child.schemas.goal, null);
    assert.equal(child.schemas.monitor, null);
    assert.equal(child.schemas.subagent, null);
    assert.equal(child.schemas.contact_supervisor.rootType, "object");
    assert.equal(child.schemas.contact_supervisor.additionalProperties, false);
    assert.equal(child.schemas.contact_supervisor.rootHasUnion, false);
    assert.equal(child.schemas.todo, null);
  } finally {
    rmSync(mainAgentDir, { recursive: true, force: true });
    rmSync(childAgentDir, { recursive: true, force: true });
  }
});

test("real Pi RPC Ask dialog completes through native extension UI without a model call", async () => {
  mkdirSync(CACHE, { recursive: true });
  const agentDir = mkdtempSync(join(CACHE, "omps-ask-rpc-smoke-"));
  try {
    const { events, stderr } = await runAskRpcDialog(agentDir);
    assert.doesNotMatch(stderr, /extension_error|runtime not initialized/i);
    assert.equal(events.some((event) => event.type === "extension_error"), false);
    assert.equal(events.some((event) => event.type === "agent_start" || event.type === "message_start"), false);
    assert.equal(events.some((event) => event.type === "extension_ui_request" && event.method === "setWidget"), false);
    const selects = events.filter((event) => event.type === "extension_ui_request" && event.method === "select");
    assert.equal(selects.length, 3);
    assert.match(selects[0].title, /Preview for Safe: Safe preview\./);
    assert.ok(selects[0].options.includes("Submit questionnaire"));
    assert.ok(selects[1].options.includes("[ ] Option 2: Metrics"));
    assert.ok(selects[2].options.includes("[x] Option 2: Metrics"));
    const result = notificationJson(events, "ASK_RPC_PROBE ");
    assert.deepEqual(result, {
      answers: [
        {
          questionIndex: 0,
          question: "Which path?",
          header: "Path",
          kind: "option",
          answer: "Safe",
          selected: ["Safe"],
          preview: "Safe preview.",
        },
        {
          questionIndex: 1,
          question: "Which extras?",
          header: "Extras",
          kind: "multi",
          answer: ["Metrics"],
          selected: ["Metrics"],
        },
      ],
      cancelled: false,
      partial: false,
    });
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("real Pi RPC Ask cancel discards the answer the user already confirmed", async () => {
  mkdirSync(CACHE, { recursive: true });
  const agentDir = mkdtempSync(join(CACHE, "omps-ask-rpc-cancel-smoke-"));
  try {
    // The first question is answered for real, then the second dialog is cancelled.
    const { events, stderr } = await runAskRpcDialog(agentDir, ["Option 1: Safe", "Cancel questionnaire"]);
    assert.doesNotMatch(stderr, /extension_error|runtime not initialized/i);
    assert.equal(events.some((event) => event.type === "extension_error"), false);
    assert.equal(events.some((event) => event.type === "agent_start" || event.type === "message_start"), false);
    const selects = events.filter((event) => event.type === "extension_ui_request" && event.method === "select");
    assert.equal(selects.length, 2);
    assert.ok(selects[0].options.includes("Option 1: Safe"));
    assert.ok(selects[1].options.includes("Cancel questionnaire"));
    assert.deepEqual(notificationJson(events, "ASK_RPC_PROBE "), {
      answers: [],
      cancelled: true,
      partial: true,
      cancelReason: "user_cancelled",
    });
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("real Pi RPC forwards Goal slash text once as extension input without command recursion or a model call", () => {
  mkdirSync(CACHE, { recursive: true });
  const goalAgentDir = mkdtempSync(join(CACHE, "omps-goal-forward-smoke-"));
  try {
    for (const [agentDir, input, prefix] of [
      [goalAgentDir, "/goal   deliver the exact frozen core", "GOAL_FORWARD_PROBE "],
    ]) {
      const events = runPi(agentDir, input);
      const forwards = events.filter((event) =>
        event.type === "extension_ui_request" && event.method === "notify" && event.message?.startsWith(prefix));
      assert.equal(forwards.length, 1);
      assert.deepEqual(JSON.parse(forwards[0].message.slice(prefix.length)), {
        text: input,
        source: "extension",
      });
      assert.equal(events.some((event) => event.type === "agent_start" || event.type === "message_start"), false);
    }
  } finally {
    rmSync(goalAgentDir, { recursive: true, force: true });
  }
});
