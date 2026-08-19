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

const { presetStatusContent } = await import("../extensions/oh-my-pi-slim/index.ts");

const theme = { fg: (role, text) => `<${role}>${text}</${role}>` };

test("active OMPS status names the preset and the package version inside one accent span", () => {
  assert.equal(typeof PACKAGE_VERSION, "string");
  assert.notEqual(PACKAGE_VERSION.trim(), "");

  const content = presetStatusContent(theme, "sol_fable_ora_opus_mix");
  assert.equal(content, `<accent>OMPS Preset: sol_fable_ora_opus_mix (v${PACKAGE_VERSION})</accent>`);

  const plain = content.slice("<accent>".length, -"</accent>".length);
  assert.equal(plain, `OMPS Preset: sol_fable_ora_opus_mix (v${PACKAGE_VERSION})`);
  assert.doesNotMatch(plain, /\*\*|orchestrator/);
});

test("OMPS status version tracks package metadata instead of a checked-in literal", () => {
  const source = readFileSync(new URL("../extensions/oh-my-pi-slim/index.ts", import.meta.url), "utf8");
  assert.match(source, /readPackageVersion\(join\(PACKAGE_ROOT, "package\.json"\)\)/);
  assert.equal(source.includes(PACKAGE_VERSION), false, "index.ts must not repeat the package version as a literal");
  assert.doesNotMatch(source, /\(v\d+\.\d+\.\d+\)/);
  assert.ok(presetStatusContent(theme, "any_preset").endsWith(`(v${PACKAGE_VERSION})</accent>`));
});

test("inactive OMPS status clears the footer slot", () => {
  assert.equal(presetStatusContent(theme, undefined), undefined);
});

test("main extension clears the status key on shutdown and never falls back to the old orchestrator text", () => {
  const source = readFileSync(new URL("../extensions/oh-my-pi-slim/index.ts", import.meta.url), "utf8");
  assert.ok(source.includes('ctx.ui.setStatus("oh-my-pi-slim", undefined)'));
  assert.ok(source.includes('ctx.ui.setStatus("oh-my-pi-slim", presetStatusContent(ctx.ui.theme, active ? activePresetName : undefined))'));
  assert.doesNotMatch(source, /`orchestrator\$\{/);
});
