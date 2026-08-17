import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { registerHooks } from "node:module";
import { realpathSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const piEntry = realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim());
const piRoot = dirname(dirname(piEntry));
const moduleUrls = {
  codingAgent: pathToFileURL(`${piRoot}/dist/index.js`).href,
  piAi: pathToFileURL(`${piRoot}/node_modules/@earendil-works/pi-ai/dist/index.js`).href,
  piTui: pathToFileURL(`${piRoot}/node_modules/@earendil-works/pi-tui/dist/index.js`).href,
  typebox: pathToFileURL(`${piRoot}/node_modules/typebox/build/index.mjs`).href,
};
const localMap = {
  "./bootstrap.js": new URL("../extensions/oh-my-pi-slim/bootstrap.ts", import.meta.url).href,
  "./loop-runtime.js": new URL("../extensions/oh-my-pi-slim/loop-runtime.ts", import.meta.url).href,
  "./loop-transcript-renderer.js": new URL("../extensions/oh-my-pi-slim/loop-transcript-renderer.ts", import.meta.url).href,
  "./loop-widget.js": new URL("../extensions/oh-my-pi-slim/loop-widget.ts", import.meta.url).href,
  "./prompt-context.js": new URL("../extensions/oh-my-pi-slim/prompt-context.ts", import.meta.url).href,
  "./subagent-checkpoint.js": new URL("../extensions/oh-my-pi-slim/subagent-checkpoint.ts", import.meta.url).href,
  "./subagent-core.js": new URL("../extensions/oh-my-pi-slim/subagent-core.ts", import.meta.url).href,
  "./subagent-model-display.js": new URL("../extensions/oh-my-pi-slim/subagent-model-display.ts", import.meta.url).href,
  "./subagent-run-files.js": new URL("../extensions/oh-my-pi-slim/subagent-run-files.ts", import.meta.url).href,
  "./subagent-transcript-renderer.js": new URL("../extensions/oh-my-pi-slim/subagent-transcript-renderer.ts", import.meta.url).href,
  "./subagent-widget.js": new URL("../extensions/oh-my-pi-slim/subagent-widget.ts", import.meta.url).href,
  "./subagent-widget-renderer.js": new URL("../extensions/oh-my-pi-slim/subagent-widget-renderer.ts", import.meta.url).href,
  "./subagent-widget-display.js": new URL("../extensions/oh-my-pi-slim/subagent-widget-display.ts", import.meta.url).href,
  "./subagent-widget-glyphs.js": new URL("../extensions/oh-my-pi-slim/subagent-widget-glyphs.ts", import.meta.url).href,
  "./widget.js": new URL("../extensions/todo/widget.ts", import.meta.url).href,
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@earendil-works/pi-coding-agent") return { url: moduleUrls.codingAgent, shortCircuit: true };
    if (specifier === "@earendil-works/pi-ai") return { url: moduleUrls.piAi, shortCircuit: true };
    if (specifier === "@earendil-works/pi-tui") return { url: moduleUrls.piTui, shortCircuit: true };
    if (specifier === "typebox") return { url: moduleUrls.typebox, shortCircuit: true };
    if (specifier === "./core.js" && context.parentURL?.includes("/extensions/todo/")) {
      return { url: new URL("../extensions/todo/core.ts", import.meta.url).href, shortCircuit: true };
    }
    const url = localMap[specifier];
    return url ? { url, shortCircuit: true } : nextResolve(specifier, context);
  },
});

const { loopParameters } = await import("../extensions/oh-my-pi-slim/loop-runtime.ts");
const { subagentParameters } = await import("../extensions/oh-my-pi-slim/subagent-runtime.ts");
const { contactSupervisorParameters } = await import("../extensions/oh-my-pi-slim/child-supervisor.ts");
const { todoParameters } = await import("../extensions/todo/index.ts");

function providerJson(schema) {
  return JSON.parse(JSON.stringify(schema));
}

function assertPortableObjectRoot(name, schema) {
  assert.equal(schema.type, "object", `${name} root must declare type object`);
  assert.equal(schema.additionalProperties, false, `${name} root must reject unknown fields`);
  assert.ok(schema.properties && typeof schema.properties === "object", `${name} root must expose properties`);
  assert.notEqual(Object.keys(schema).length, 1, `${name} root must not contain only a union keyword`);
  assert.equal(schema.anyOf, undefined, `${name} root must not use anyOf`);
  assert.equal(schema.oneOf, undefined, `${name} root must not use oneOf`);
}

test("all production model-tool schemas serialize with provider-portable object roots", () => {
  const schemas = {
    subagent: providerJson(subagentParameters),
    contact_supervisor: providerJson(contactSupervisorParameters),
    loop: providerJson(loopParameters),
    todo: providerJson(todoParameters),
  };
  assert.deepEqual(Object.keys(schemas).sort(), ["contact_supervisor", "loop", "subagent", "todo"]);
  for (const [name, schema] of Object.entries(schemas)) assertPortableObjectRoot(name, schema);

  const operationBranches = schemas.todo.properties.operations.items.anyOf;
  assert.equal(operationBranches.length, 3);
  assert.deepEqual(operationBranches.map((branch) => branch.properties.op.const).sort(), ["append", "clear", "modify"]);
  for (const branch of operationBranches) {
    assert.equal(branch.type, "object");
    assert.equal(branch.additionalProperties, false);
  }
  const modify = operationBranches.find((branch) => branch.properties.op.const === "modify");
  assert.equal(modify.minProperties, undefined, "provider schema must rely on Todo runtime mutable-field validation");
});
