import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire, isBuiltin, registerHooks } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const piEntry = realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim());
const piRoot = dirname(dirname(piEntry));
const piRequire = createRequire(`${piRoot}/package.json`);
const packageMap = {
  "@earendil-works/pi-coding-agent": pathToFileURL(`${piRoot}/dist/index.js`).href,
};

// The package ships TypeScript sources with `.js` specifiers and resolves peer packages from the host Pi install.
registerHooks({
  resolve(specifier, context, nextResolve) {
    const mapped = packageMap[specifier];
    if (mapped) return { url: mapped, shortCircuit: true };
    if (specifier.startsWith(".") && specifier.endsWith(".js") && context.parentURL) {
      const candidate = new URL(`${specifier.slice(0, -3)}.ts`, context.parentURL);
      if (existsSync(fileURLToPath(candidate))) return { url: candidate.href, shortCircuit: true };
    }
    if (!specifier.startsWith(".") && !specifier.includes("://") && !isBuiltin(specifier)) {
      try { return { url: pathToFileURL(piRequire.resolve(specifier)).href, shortCircuit: true }; }
      catch { /* fall through to the default resolver */ }
    }
    return nextResolve(specifier, context);
  },
});

const PACKAGE_JSON_URL = new URL("../package.json", import.meta.url);
const PACKAGE_VERSION = JSON.parse(readFileSync(PACKAGE_JSON_URL, "utf8")).version;
const INDEX_URL = new URL("../extensions/oh-my-pi-slim/index.ts", import.meta.url);

const { presetStatusContent } = await import(INDEX_URL.href);

const theme = { fg: (role, text) => `<${role}>${text}</${role}>` };
const preset = "sol_fable_ora_opus_mix";
const baseStatus = `OMPS Preset: ${preset} (v${PACKAGE_VERSION})`;

function status(fastEnabled, provider) {
  return presetStatusContent(theme, preset, fastEnabled, provider === undefined ? undefined : { provider, id: "gpt-exact" });
}

test("active OMPS status appends Fast Mode On or Off for both exact OpenAI providers", () => {
  for (const provider of ["openai", "openai-codex"]) {
    assert.equal(status(true, provider), `<accent>${baseStatus} · Fast Mode On</accent>`);
    assert.equal(status(false, provider), `<accent>${baseStatus} · Fast Mode Off</accent>`);
  }
});

test("other providers, case mismatches, and an undefined model keep the original preset status", () => {
  for (const provider of ["anthropic", "OpenAI", "OPENAI", "openai-Codex", ""]) {
    assert.equal(status(true, provider), `<accent>${baseStatus}</accent>`);
    assert.equal(status(false, provider), `<accent>${baseStatus}</accent>`);
  }
  assert.equal(status(true, undefined), `<accent>${baseStatus}</accent>`);
  assert.equal(status(false, undefined), `<accent>${baseStatus}</accent>`);
  assert.equal(presetStatusContent(theme, preset), `<accent>${baseStatus}</accent>`, "the existing two-argument call stays suffix-free");
});

test("inactive OMPS status clears the same footer slot regardless of Fast Mode or model", () => {
  assert.equal(presetStatusContent(theme, undefined), undefined);
  assert.equal(presetStatusContent(theme, undefined, true, { provider: "openai", id: "gpt-exact" }), undefined);
  assert.equal(presetStatusContent(theme, undefined, false, { provider: "openai-codex", id: "gpt-exact" }), undefined);
});

test("the complete status line is rendered in one accent span", () => {
  const calls = [];
  const trackingTheme = {
    fg(role, text) {
      calls.push({ role, text });
      return `<${role}>${text}</${role}>`;
    },
  };
  const content = presetStatusContent(trackingTheme, preset, true, { provider: "openai", id: "gpt-exact" });
  assert.equal(content, `<accent>${baseStatus} · Fast Mode On</accent>`);
  assert.deepEqual(calls, [{ role: "accent", text: `${baseStatus} · Fast Mode On` }]);
  assert.equal(content.match(/<accent>/g)?.length, 1);
  assert.equal(content.match(/<\/accent>/g)?.length, 1);
});

test("OMPS status version tracks package metadata instead of a checked-in literal", () => {
  assert.equal(typeof PACKAGE_VERSION, "string");
  assert.notEqual(PACKAGE_VERSION.trim(), "");

  const source = readFileSync(INDEX_URL, "utf8");
  assert.match(source, /readPackageVersion\(join\(PACKAGE_ROOT, "package\.json"\)\)/);
  assert.equal(source.includes(PACKAGE_VERSION), false, "index.ts must not repeat the package version as a literal");
  assert.doesNotMatch(source, /\(v\d+\.\d+\.\d+\)/);
  assert.equal(presetStatusContent(theme, "any_preset"), `<accent>OMPS Preset: any_preset (v${PACKAGE_VERSION})</accent>`);
});

test("status source uses one OMPS key and refreshes every required lifecycle", () => {
  const source = readFileSync(INDEX_URL, "utf8");
  const statusKeys = [...source.matchAll(/setStatus\(\s*"([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(statusKeys, ["oh-my-pi-slim"], "updateStatus owns the only status write and existing key");
  assert.match(source, /presetStatusContent\(ctx\.ui\.theme, active \? activePresetName : undefined, fastEnabled, ctx\.model\)/);
  assert.doesNotMatch(source, /`orchestrator\$\{/);

  const activateBlock = source.slice(source.indexOf("async function activate"), source.indexOf("async function deactivate"));
  const deactivateBlock = source.slice(source.indexOf("async function deactivate"), source.indexOf('pi.registerCommand("fast"'));
  const sessionStartBlock = source.slice(source.indexOf('pi.on("session_start"'), source.indexOf('pi.on("session_before_switch"'));
  const sessionTreeBlock = source.slice(source.indexOf('pi.on("session_tree"'), source.indexOf('pi.on("input"'));
  const shutdownBlock = source.slice(source.indexOf('pi.on("session_shutdown"'));
  for (const [name, block] of [
    ["activate", activateBlock],
    ["deactivate", deactivateBlock],
    ["session_start", sessionStartBlock],
    ["session_tree", sessionTreeBlock],
    ["session_shutdown", shutdownBlock],
  ]) assert.match(block, /updateStatus\(ctx\)/, `${name} must refresh the shared OMPS status`);
  assert.match(
    sessionStartBlock,
    /catch \(error\) \{[\s\S]*?report\(ctx,[\s\S]*?updateStatus\(ctx\);\s*return;/,
    "a failed session restore clears the stale footer before returning",
  );
  assert.doesNotMatch(shutdownBlock, /setStatus\(/, "shutdown clears through updateStatus instead of a duplicate write");
});

test("one model_select handler refreshes status for model command, cycle, and setModel changes", () => {
  const source = readFileSync(INDEX_URL, "utf8");
  assert.equal(source.match(/pi\.on\("model_select"/g)?.length, 1);
  const handler = source.slice(source.indexOf('pi.on("model_select"'), source.indexOf('pi.on("session_start"'));
  assert.match(handler, /updateStatus\(ctx\)/);
  assert.equal(handler.match(/updateStatus\(ctx\)/g)?.length, 1);
});

test("a successful Fast Mode toggle refreshes only after append and assignment", () => {
  const source = readFileSync(INDEX_URL, "utf8");
  const block = source.slice(source.indexOf('pi.registerCommand("fast"'), source.indexOf('pi.registerCommand("preset"'));
  const appendIndex = block.indexOf("pi.appendEntry(FAST_STATE_ENTRY_TYPE, makeFastState(next))");
  const assignIndex = block.indexOf("fastEnabled = next");
  const refreshIndex = block.indexOf("updateStatus(ctx)");
  assert.ok(appendIndex >= 0 && appendIndex < assignIndex && assignIndex < refreshIndex);
  assert.equal(block.match(/updateStatus\(ctx\)/g)?.length, 1);

  const usageBlock = block.slice(block.indexOf("if (args.trim())"), block.indexOf("const next = !fastEnabled"));
  const failureBlock = block.slice(block.indexOf("} catch (error) {"), assignIndex);
  assert.doesNotMatch(usageBlock, /updateStatus\(/, "Usage does not refresh status");
  assert.doesNotMatch(failureBlock, /updateStatus\(/, "append failure does not refresh status");
});
