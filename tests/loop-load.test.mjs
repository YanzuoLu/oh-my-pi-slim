import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CACHE = join(ROOT, ".cache");
const MAIN_EXTENSION = join(ROOT, "extensions/oh-my-pi-slim/index.ts");
const CHILD_EXTENSION = join(ROOT, "extensions/oh-my-pi-slim/child-supervisor.ts");
const TODO_EXTENSION = join(ROOT, "extensions/todo/index.ts");
const PROBE_EXTENSION = join(ROOT, "tests/fixtures/omps-load-probe.ts");
const ASK_RPC_PROBE_EXTENSION = join(ROOT, "tests/fixtures/ask-rpc-probe.ts");

function isolatedEnv(agentDir, child = false) {
  const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir };
  delete env.OMPS_ENABLE;
  delete env.OMPS_PRESET;
  delete env.OMPS_FAST_MODE;
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
    ? [MAIN_EXTENSION, CHILD_EXTENSION, TODO_EXTENSION, PROBE_EXTENSION]
    : [MAIN_EXTENSION, TODO_EXTENSION, PROBE_EXTENSION];
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
    "--extension", TODO_EXTENSION,
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
    assert.deepEqual(main.tools, ["ask_user_question", "goal", "loop", "monitor", "subagent", "todo"]);
    const bootstrappedConfig = join(mainAgentDir, "oh-my-pi-slim.json");
    assert.equal("fast" in JSON.parse(readFileSync(bootstrappedConfig, "utf8")), false);
    assert.equal(statSync(bootstrappedConfig).mode & 0o777, 0o600);
    assert.deepEqual(main.activeTools, ["ask_user_question", "goal", "loop", "monitor", "subagent", "todo"]);
    assert.deepEqual(main.commands, ["fast", "goal", "loop"]);
    assert.deepEqual(main.descriptions, {
      ask_user_question: "Ask the user one to four structured questions with single-select, multi-select, custom responses, and optional single-select previews. Each question accepts two to four authored options. Results report confirmed answers, partial completion, and cancellation as normal outcomes. A partial submit keeps every confirmed answer, while cancelling discards all of them. `ask_user_question` is unavailable while a Goal is active.",
      goal: "Manage one durable Goal on the current branch. `goal create` activates an explicit objective with one to eight completion criteria. Active Goals continue autonomously while blockers, pending interactions, or other managed work can delay continuation. Provider failures retry automatically. Repeated no-progress runs pause the Goal. User aborts pause the Goal only when Goal continuation is immediately safe to deliver. Otherwise, blockers keep the Goal active for later reevaluation. `goal pause` stops autonomous continuation until `goal resume` explicitly reactivates the Goal. Restored unfinished Goals remain paused until explicitly resumed. `goal modify` replaces the nonterminal contract and activates it. Cancellation means the user abandons the Goal. Completion requires one concrete evidence item per criterion. `goal clear` removes a paused, completed, or cancelled Goal. It rejects active and retry_wait Goals until the user agrees to pause or cancel. Actions return the current Goal state and whether it changed.",
      loop: "Create and manage runtime-only fixed-delay loops from 10s through 7d. Creation and resume wait one full interval before firing. Each later delay starts only after the previous tick finishes. Each fire delivers the stored prompt for a future turn. Active loops must be paused before deletion or clearing. Loop state survives compaction and tree navigation within the current runtime. Reload, session replacement, and shutdown clear every loop. Actions return current loop state, change receipts, clear receipts, or the retained loop list.",
      monitor: "Run and manage long-running foreground Bash commands on POSIX systems while Pi remains available. Each monitor owns the command's foreground process group. Matcher notifications carry the current status and only the new lines that matched a `notifyOn` literal. Terminal notifications carry the final status, exit code, signal, error, and any matched lines no earlier notification delivered. A failed or killed command also adds a bounded recent diagnostic tail. A silence reminder arrives whenever a running command produces no output for its `checkAfter` threshold. Summary notifications report rate-limited matcher batches. `notifyOn` performs case-sensitive literal matching. `monitor list` returns compact retained records. `monitor status` returns one record's full retained state and combined logs. `monitor stop` terminates a running group and returns its complete terminal state. `monitor delete` removes one terminal record, while `monitor clear` removes all terminal records. Running records must be stopped only after user agreement. Terminal records remain available until deletion or clearing. Runtime shutdown terminates active groups and clears retained monitor data.",
      subagent: "Create and manage retained specialist runs through nine lifecycle actions. `subagent create` starts an independent run and returns its run ID immediately. `subagent list` returns a compact overview of every retained run without output or errors. `subagent status` returns one run and includes terminal output or error when available. Waiting and terminal notifications deliver complete requests, results, and errors. `subagent resume` starts a new run from reusable terminal context, optionally in another working directory. `subagent reply` continues the same waiting run after an answer. `subagent steer` sends a new instruction to a running run. `subagent interrupt` stops a live run, waits for its terminal status, and returns that result without a separate notification. `subagent delete` removes one retained run only after it reaches a terminal status. `subagent clear` removes all retained history only when every run is terminal. Reload, tree navigation, and session replacement interrupt active runs but retain their history. Deleting or clearing Subagent history never changes Goal statistics.",
      todo: "Read or atomically update a session-local task ledger. `todo list` returns every item in original order. `todo update` applies ordered append, modify, delete, or clear operations as one batch. Multiple items may be in progress. Dependencies must form an acyclic graph and reference exact existing subjects. Deleting an in_progress item is rejected before dependency checks. Deleting a referenced item is rejected. Clear rejects every current in_progress item. It removes all pending and completed items. Any invalid operation or final graph rolls back the entire batch.",
    });
    assert.deepEqual(main.promptSnippets, {
      ask_user_question: "Collect structured user decisions.",
      goal: "Manage the branch-local Goal.",
      loop: "Manage fixed-delay prompt loops.",
      monitor: "Supervise long-running foreground commands.",
      subagent: "Delegate and manage specialist runs.",
      todo: "Track session tasks and dependencies.",
    });
    assert.deepEqual(main.systemPromptToolLines, Object.entries(main.promptSnippets).map(([name, snippet]) => `- ${name}: ${snippet}`));
    assert.deepEqual(main.flattenedGuidelines, Object.values(main.guidelinesByTool).flat());
    assert.equal(main.flattenedGuidelines.length, 30);
    assert.equal(main.schemas.ask_user_question.rootType, "object");
    assert.equal(main.schemas.ask_user_question.additionalProperties, false);
    assert.equal(main.schemas.ask_user_question.rootHasUnion, false);
    assert.deepEqual(main.schemas.goal, {
      rootType: "object",
      additionalProperties: false,
      rootHasUnion: false,
      actions: ["create", "modify", "status", "pause", "resume", "complete", "cancel", "clear"],
    });
    assert.deepEqual(main.schemas.loop, {
      rootType: "object",
      additionalProperties: false,
      rootHasUnion: false,
      actions: ["create", "delete", "clear", "modify", "list", "pause", "resume"],
    });
    assert.equal(main.schemas.contact_supervisor, null);
    assert.equal(main.schemas.monitor.rootType, "object");
    assert.equal(main.schemas.monitor.additionalProperties, false);
    assert.equal(main.schemas.monitor.rootHasUnion, false);
    assert.deepEqual(main.schemas.monitor.actions, ["create", "stop", "delete", "clear", "list", "status"]);
    assert.match(main.descriptions.monitor, /A silence reminder arrives whenever a running command produces no output for its `checkAfter` threshold\./);
    assert.equal(main.schemas.subagent.rootType, "object");
    assert.equal(main.schemas.subagent.additionalProperties, false);
    assert.equal(main.schemas.subagent.rootHasUnion, false);
    assert.deepEqual(main.schemas.subagent.actions, ["create", "list", "status", "interrupt", "steer", "resume", "reply", "delete", "clear"]);
    assert.equal(main.schemas.todo.rootType, "object");
    assert.equal(main.schemas.todo.additionalProperties, false);
    assert.equal(main.schemas.todo.rootHasUnion, false);

    const child = notificationJson(runPi(childAgentDir, "/omps-load-probe", true), "OMPS_LOAD_PROBE ");
    assert.deepEqual(child.tools, ["contact_supervisor", "todo"]);
    assert.deepEqual(child.activeTools, ["contact_supervisor", "todo"]);
    assert.deepEqual(child.commands, []);
    assert.deepEqual(child.descriptions, {
      contact_supervisor: "Request an orchestrator response for a decision, structured interview, or progress update. Every call moves the child run to waiting, including progress updates. The result records the request context and ends the current child turn. Work continues in the same run after the orchestrator replies.",
      todo: "Read or atomically update a session-local task ledger. `todo list` returns every item in original order. `todo update` applies ordered append, modify, delete, or clear operations as one batch. Multiple items may be in progress. Dependencies must form an acyclic graph and reference exact existing subjects. Deleting an in_progress item is rejected before dependency checks. Deleting a referenced item is rejected. Clear rejects every current in_progress item. It removes all pending and completed items. Any invalid operation or final graph rolls back the entire batch.",
    });
    assert.deepEqual(child.promptSnippets, {
      contact_supervisor: "Request an orchestrator response.",
      todo: "Track session tasks and dependencies.",
    });
    assert.deepEqual(child.systemPromptToolLines, Object.entries(child.promptSnippets).map(([name, snippet]) => `- ${name}: ${snippet}`));
    assert.deepEqual(child.flattenedGuidelines, Object.values(child.guidelinesByTool).flat());
    assert.equal(child.flattenedGuidelines.length, 10);
    const guidelinesByTool = { ...main.guidelinesByTool, ...child.guidelinesByTool };
    assert.deepEqual(Object.keys(guidelinesByTool).sort(), [...new Set([...main.tools, ...child.tools])].sort());
    for (const [tool, guidelines] of Object.entries(guidelinesByTool)) {
      for (const guideline of guidelines) {
        assert.match(guideline, tool === "goal" ? /\bGoal\b|`goal / : new RegExp(tool));
      }
    }
    assert.equal(child.schemas.ask_user_question, null);
    assert.equal(child.schemas.goal, null);
    assert.equal(child.schemas.loop, null);
    assert.equal(child.schemas.monitor, null);
    assert.equal(child.schemas.subagent, null);
    assert.equal(child.schemas.contact_supervisor.rootType, "object");
    assert.equal(child.schemas.contact_supervisor.additionalProperties, false);
    assert.equal(child.schemas.contact_supervisor.rootHasUnion, false);
    assert.equal(child.schemas.todo.rootType, "object");
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

test("real Pi RPC forwards Loop and Goal slash text once as extension input without command recursion or a model call", () => {
  mkdirSync(CACHE, { recursive: true });
  const loopAgentDir = mkdtempSync(join(CACHE, "omps-loop-forward-smoke-"));
  const goalAgentDir = mkdtempSync(join(CACHE, "omps-goal-forward-smoke-"));
  try {
    for (const [agentDir, input, prefix] of [
      [loopAgentDir, "/loop   review the exact raw request", "LOOP_FORWARD_PROBE "],
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
    rmSync(loopAgentDir, { recursive: true, force: true });
    rmSync(goalAgentDir, { recursive: true, force: true });
  }
});
