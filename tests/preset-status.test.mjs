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

const { presetFastModeEligible, presetStatusContent } = await import(INDEX_URL.href);

const ROLES = ["orchestrator", "explorer", "librarian", "oracle", "designer", "fixer", "observer"];
const theme = { fg: (role, text) => `<${role}>${text}</${role}>` };
const presetName = "sol_fable_ora_opus_mix";
const baseStatus = `OMPS Preset: ${presetName} (v${PACKAGE_VERSION})`;

function makePreset(orchestratorProvider = "anthropic", overrides = {}) {
  return Object.fromEntries(ROLES.map((role) => [role, {
    provider: role === "orchestrator" ? orchestratorProvider : "anthropic",
    model: `${role}-model`,
    thinking: "high",
    ...overrides[role],
  }]));
}

function status(fastEnabled, preset) {
  return presetStatusContent(theme, presetName, fastEnabled, presetFastModeEligible(preset));
}

test("active preset eligibility checks all seven roles and accepts both exact OpenAI providers", () => {
  const allNonOpenAI = makePreset();
  assert.deepEqual(Object.keys(allNonOpenAI), ROLES);
  assert.equal(presetFastModeEligible(allNonOpenAI), false);

  for (const provider of ["openai", "openai-codex"]) {
    assert.equal(presetFastModeEligible(makePreset("anthropic", { designer: { provider } })), true);
    assert.equal(presetFastModeEligible(makePreset(provider)), true);
  }
});

test("Main can be non-OpenAI while any OpenAI specialist qualifies the active preset", () => {
  for (const role of ROLES.slice(1)) {
    const preset = makePreset("anthropic", { [role]: { provider: "openai" } });
    assert.equal(preset.orchestrator.provider, "anthropic");
    assert.equal(presetFastModeEligible(preset), true, `${role} must qualify the preset`);
  }
  assert.equal(status(true, makePreset("anthropic", { observer: { provider: "openai-codex" } })), `<accent>${baseStatus} · Fast Mode On</accent>`);
});

test("all non-OpenAI providers and case mismatches do not qualify the active preset", () => {
  assert.equal(presetFastModeEligible(makePreset()), false);
  for (const provider of ["OpenAI", "OPENAI", "openai-Codex", "OPENAI-CODEX", ""]) {
    assert.equal(presetFastModeEligible(makePreset("anthropic", { explorer: { provider } })), false);
  }
  assert.equal(presetFastModeEligible(undefined), false);
});

test("eligible active preset status appends Fast Mode On or Off as a session toggle only", () => {
  const eligiblePreset = makePreset("anthropic", { librarian: { provider: "openai" } });
  assert.equal(status(true, eligiblePreset), `<accent>${baseStatus} · Fast Mode On</accent>`);
  assert.equal(status(false, eligiblePreset), `<accent>${baseStatus} · Fast Mode Off</accent>`);
});

test("a manually selected OpenAI Main cannot qualify an all-non-OpenAI active preset", () => {
  const allNonOpenAI = makePreset();
  assert.equal(status(true, allNonOpenAI), `<accent>${baseStatus}</accent>`);
  assert.equal(status(false, allNonOpenAI), `<accent>${baseStatus}</accent>`);
  assert.equal(presetStatusContent(theme, presetName), `<accent>${baseStatus}</accent>`, "the existing two-argument call stays suffix-free");
});

test("inactive OMPS status clears the same footer slot regardless of Fast Mode or preset eligibility", () => {
  assert.equal(presetStatusContent(theme, undefined), undefined);
  assert.equal(presetStatusContent(theme, undefined, true, true), undefined);
  assert.equal(presetStatusContent(theme, undefined, false, true), undefined);
});

test("the complete status line is rendered in one accent span", () => {
  const calls = [];
  const trackingTheme = {
    fg(role, text) {
      calls.push({ role, text });
      return `<${role}>${text}</${role}>`;
    },
  };
  const content = presetStatusContent(trackingTheme, presetName, true, true);
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

test("status source uses active preset eligibility and refreshes every required lifecycle", () => {
  const source = readFileSync(INDEX_URL, "utf8");
  const statusKeys = [...source.matchAll(/setStatus\(\s*"([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(statusKeys, ["oh-my-pi-slim"], "updateStatus owns the only status write and existing key");
  assert.match(source, /Object\.values\(preset\)\.some\(\(role\) => isFastModeProvider\(role\.provider\)\)/);
  assert.match(source, /presetStatusContent\(ctx\.ui\.theme, active \? activePresetName : undefined, fastEnabled, presetFastModeEligible\(activePreset\)\)/);
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

test("preset switch updates active preset before status and omps off clears it", () => {
  const source = readFileSync(INDEX_URL, "utf8");
  const activateBlock = source.slice(source.indexOf("async function activate"), source.indexOf("async function deactivate"));
  assert.ok(activateBlock.indexOf("activePreset = preset") < activateBlock.indexOf("updateStatus(ctx)"));

  const presetCommand = source.slice(source.indexOf('pi.registerCommand("preset"'), source.indexOf('pi.registerCommand("omps"'));
  assert.match(presetCommand, /await activate\(ctx, requestedPreset\)/);

  const ompsCommand = source.slice(source.indexOf('pi.registerCommand("omps"'), source.indexOf("function consumeReloadPresetSlot"));
  assert.match(ompsCommand, /if \(action === "off"\) \{\s*await deactivate\(ctx\)/);
  assert.match(ompsCommand, /await activate\(ctx, requestedPreset\)/);
});

test("status has no model_select handler because current Main model is irrelevant", () => {
  const source = readFileSync(INDEX_URL, "utf8");
  assert.equal(source.match(/pi\.on\("model_select"/g)?.length ?? 0, 0);
  const updateStatusBlock = source.slice(source.indexOf("function updateStatus"), source.indexOf("function takeTreeNotificationHold"));
  assert.doesNotMatch(updateStatusBlock, /ctx\.model/);
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
