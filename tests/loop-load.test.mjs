import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CACHE = join(ROOT, ".cache");
const MAIN_EXTENSION = join(ROOT, "extensions/oh-my-pi-slim/index.ts");
const CHILD_EXTENSION = join(ROOT, "extensions/oh-my-pi-slim/child-supervisor.ts");
const TODO_EXTENSION = join(ROOT, "extensions/todo/index.ts");
const PROBE_EXTENSION = join(ROOT, "tests/fixtures/omps-load-probe.ts");

function isolatedEnv(agentDir, child = false) {
  const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir };
  delete env.OMPS_ENABLE;
  delete env.OMPS_PRESET;
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
  return events;
}

function notificationJson(events, prefix) {
  const notification = events.find((event) =>
    event.type === "extension_ui_request" && event.method === "notify" && event.message?.startsWith(prefix));
  assert.ok(notification, events.map((event) => JSON.stringify(event)).join("\n"));
  return JSON.parse(notification.message.slice(prefix.length));
}

test("real Pi isolated RPC main and child sessions expose exact package tools without widgets", () => {
  mkdirSync(CACHE, { recursive: true });
  const mainAgentDir = mkdtempSync(join(CACHE, "omps-main-pi-smoke-"));
  const childAgentDir = mkdtempSync(join(CACHE, "omps-child-pi-smoke-"));
  try {
    const main = notificationJson(runPi(mainAgentDir, "/omps-load-probe"), "OMPS_LOAD_PROBE ");
    assert.deepEqual(main.tools, ["loop", "subagent", "todo"]);
    assert.deepEqual(main.activeTools, ["loop", "subagent", "todo"]);
    assert.deepEqual(main.commands, ["loop"]);
    assert.deepEqual(main.schemas.loop, {
      rootType: "object",
      additionalProperties: false,
      rootHasUnion: false,
      actions: ["create", "delete", "modify", "list", "pause", "resume"],
    });
    assert.equal(main.schemas.contact_supervisor, null);
    assert.equal(main.schemas.subagent.rootType, "object");
    assert.equal(main.schemas.subagent.additionalProperties, false);
    assert.equal(main.schemas.subagent.rootHasUnion, false);
    assert.equal(main.schemas.todo.rootType, "object");
    assert.equal(main.schemas.todo.additionalProperties, false);
    assert.equal(main.schemas.todo.rootHasUnion, false);

    const child = notificationJson(runPi(childAgentDir, "/omps-load-probe", true), "OMPS_LOAD_PROBE ");
    assert.deepEqual(child.tools, ["contact_supervisor", "todo"]);
    assert.deepEqual(child.activeTools, ["contact_supervisor", "todo"]);
    assert.deepEqual(child.commands, []);
    assert.equal(child.schemas.loop, null);
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

test("real Pi RPC forwards slash text once as extension input without command recursion or a model call", () => {
  mkdirSync(CACHE, { recursive: true });
  const agentDir = mkdtempSync(join(CACHE, "omps-loop-forward-smoke-"));
  try {
    const events = runPi(agentDir, "/loop   review the exact raw request");
    const forwards = events.filter((event) =>
      event.type === "extension_ui_request" && event.method === "notify" && event.message?.startsWith("LOOP_FORWARD_PROBE "));
    assert.equal(forwards.length, 1);
    assert.deepEqual(JSON.parse(forwards[0].message.slice("LOOP_FORWARD_PROBE ".length)), {
      text: "/loop   review the exact raw request",
      source: "extension",
    });
    assert.equal(events.some((event) => event.type === "agent_start" || event.type === "message_start"), false);
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});
