import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire, isBuiltin, registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { piRoot } from "./fixtures/pi-install.mjs";
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

const { presetCacheModeEligible, presetStatusContent } = await import(INDEX_URL.href);

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

function makeUniformPreset(provider) {
  return makePreset(provider, Object.fromEntries(ROLES.slice(1).map((role) => [role, { provider }])));
}

function status(preset, cacheRetention = "short") {
  return presetStatusContent(theme, presetName, cacheRetention, presetCacheModeEligible(preset));
}

test("active preset Cache eligibility checks all seven roles for exact anthropic", () => {
  assert.equal(presetCacheModeEligible(makeUniformPreset("openai")), false);
  for (const role of ROLES) {
    const preset = makeUniformPreset("openai");
    preset[role] = { ...preset[role], provider: "anthropic" };
    assert.equal(presetCacheModeEligible(preset), true, `${role} must qualify Cache status`);
  }
  for (const provider of ["Anthropic", "ANTHROPIC", "anthropic-messages", ""]) {
    assert.equal(presetCacheModeEligible(makeUniformPreset(provider)), false);
  }
  assert.equal(presetCacheModeEligible(undefined), false);
});

test("eligible and unrelated presets show the correct preset-wide Cache suffix", () => {
  assert.equal(status(makeUniformPreset("anthropic"), "long"), `<accent>${baseStatus} · Anthropic Cache Mode: long</accent>`);
  assert.equal(status(makeUniformPreset("anthropic"), "short"), `<accent>${baseStatus} · Anthropic Cache Mode: short</accent>`);
  assert.equal(status(makeUniformPreset("openai")), `<accent>${baseStatus}</accent>`);
  assert.equal(status(makeUniformPreset("google")), `<accent>${baseStatus}</accent>`);
});

test("a manually selected Main cannot change suffix eligibility from the active preset", () => {
  const allAnthropic = makeUniformPreset("anthropic");
  const allGoogle = makeUniformPreset("google");
  assert.equal(status(allAnthropic), `<accent>${baseStatus} · Anthropic Cache Mode: short</accent>`);
  assert.equal(status(allGoogle), `<accent>${baseStatus}</accent>`);
  assert.equal(presetStatusContent(theme, presetName), `<accent>${baseStatus}</accent>`, "the existing two-argument call stays suffix-free");
});

test("inactive OMPS status clears the shared footer slot", () => {
  assert.equal(presetStatusContent(theme, undefined), undefined);
  assert.equal(presetStatusContent(theme, undefined, "long", true), undefined);
  assert.equal(presetStatusContent(theme, undefined, "short", true), undefined);
});

test("the complete status line is rendered in one accent span", () => {
  const calls = [];
  const trackingTheme = {
    fg(role, text) {
      calls.push({ role, text });
      return `<${role}>${text}</${role}>`;
    },
  };
  const content = presetStatusContent(trackingTheme, presetName, "long", true);
  assert.equal(content, `<accent>${baseStatus} · Anthropic Cache Mode: long</accent>`);
  assert.deepEqual(calls, [{ role: "accent", text: `${baseStatus} · Anthropic Cache Mode: long` }]);
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

test("status source uses active preset Cache eligibility and refreshes every required lifecycle", () => {
  const source = readFileSync(INDEX_URL, "utf8");
  const statusKeys = [...source.matchAll(/setStatus\(\s*"([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(statusKeys, ["oh-my-pi-slim"], "updateStatus owns the only status write and existing key");
  assert.match(source, /Object\.values\(preset\)\.some\(\(role\) => role\.provider === "anthropic"\)/);
  assert.match(source, /cacheRetention,\s*presetCacheModeEligible\(activePreset\)/);
  assert.doesNotMatch(source, /`orchestrator\$\{/);

  const activateBlock = source.slice(source.indexOf("async function activate"), source.indexOf("async function deactivate"));
  const deactivateBlock = source.slice(source.indexOf("async function deactivate"), source.indexOf('pi.registerCommand("cache"'));
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

test("status has no model_select handler because current Main model and authentication are irrelevant", () => {
  const source = readFileSync(INDEX_URL, "utf8");
  assert.equal(source.match(/pi\.on\("model_select"/g)?.length ?? 0, 0);
  const updateStatusBlock = source.slice(source.indexOf("function updateStatus"), source.indexOf("function takeTreeNotificationHold"));
  assert.doesNotMatch(updateStatusBlock, /ctx\.model/);
});

test("successful Cache toggle refreshes only after append and assignment", () => {
  const source = readFileSync(INDEX_URL, "utf8");
  const cacheBlock = source.slice(source.indexOf('pi.registerCommand("cache"'), source.indexOf('pi.registerCommand("preset"'));
  const appendIndex = cacheBlock.indexOf("pi.appendEntry(CACHE_STATE_ENTRY_TYPE, makeCacheState(next))");
  const assignIndex = cacheBlock.indexOf("cacheRetention = next");
  const refreshIndex = cacheBlock.indexOf("updateStatus(ctx)");
  assert.ok(appendIndex >= 0 && appendIndex < assignIndex && assignIndex < refreshIndex);
  assert.equal(cacheBlock.match(/updateStatus\(ctx\)/g)?.length, 1);
  assert.match(cacheBlock, /report\(ctx, "Usage: \/cache", "warning"\)/);
  assert.doesNotMatch(cacheBlock.slice(cacheBlock.indexOf("if (args.trim())"), cacheBlock.indexOf("const next")), /updateStatus\(/);
  assert.doesNotMatch(cacheBlock.slice(cacheBlock.indexOf("} catch (error) {"), assignIndex), /updateStatus\(/);
});
