#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPT_DIR, "..");
const AGENT_NAMES = ["explorer", "librarian", "oracle", "designer", "fixer"];
const args = new Set(process.argv.slice(2));
const installDependency = args.has("--install-dependency");
const installWebSearch = args.has("--install-web-search");
const installAskUser = args.has("--install-ask-user");
const allowExtraAgents = args.has("--allow-extra-agents");
const agentDir = process.env.PI_CODING_AGENT_DIR
  ? resolve(process.env.PI_CODING_AGENT_DIR)
  : join(homedir(), ".pi", "agent");
const agentsDir = join(agentDir, "agents");
const extensionDir = join(agentDir, "extensions", "oh-my-pi-slim");
const settingsPath = join(agentDir, "subagents.json");
const manifestPath = join(agentDir, ".oh-my-pi-slim-install.json");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupRoot = join(agentDir, ".oh-my-pi-slim-backups", stamp);

function fail(message) {
  console.error(`Install failed: ${message}`);
  process.exit(1);
}

function hashFile(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.oh-my-pi-slim.tmp-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(temp, path);
}

if (existsSync(manifestPath)) {
  fail(`an installation manifest already exists at ${manifestPath}. Run the uninstall script before reinstalling or updating.`);
}

const extraAgents = (existsSync(agentsDir)
  ? readdirSync(agentsDir, { withFileTypes: true })
  : [])
  .filter((entry) => entry.name.endsWith(".md"))
  .map((entry) => basename(entry.name, ".md"))
  .filter((name) => !AGENT_NAMES.includes(name));

if (extraAgents.length > 0 && !allowExtraAgents) {
  fail(
    `strict five-agent installation requires ${agentsDir} to contain no other agent definitions. ` +
      `Found: ${extraAgents.join(", ")}. Move them elsewhere or rerun with --allow-extra-agents (other types will then remain visible).`,
  );
}

const sourceFiles = [
  ...AGENT_NAMES.map((name) => ({
    source: join(ROOT, "agents", `${name}.md`),
    target: join(agentsDir, `${name}.md`),
  })),
  {
    source: join(ROOT, "extensions", "oh-my-pi-slim", "index.ts"),
    target: join(extensionDir, "index.ts"),
  },
  {
    source: join(ROOT, "extensions", "oh-my-pi-slim", "bootstrap.ts"),
    target: join(extensionDir, "bootstrap.ts"),
  },
  {
    source: join(ROOT, "extensions", "oh-my-pi-slim", "prompt-context.ts"),
    target: join(extensionDir, "prompt-context.ts"),
  },
  {
    source: join(ROOT, "extensions", "oh-my-pi-slim", "orchestrator.md"),
    target: join(extensionDir, "orchestrator.md"),
  },
  {
    source: join(ROOT, "extensions", "oh-my-pi-slim", "skills", "pi-documentation", "SKILL.md"),
    target: join(extensionDir, "skills", "pi-documentation", "SKILL.md"),
  },
  {
    source: join(ROOT, ".pi", "oh-my-pi-slim.json"),
    target: join(agentDir, "oh-my-pi-slim.json"),
    preserveExisting: true,
  },
];

for (const file of sourceFiles) {
  if (!existsSync(file.source)) fail(`missing repository file: ${file.source}`);
}

const desiredSettings = readJson(join(ROOT, "config", "subagents.json"), {});
const settingsExisted = existsSync(settingsPath);
const settings = readJson(settingsPath, {});
const settingsBefore = {};

for (const [key, value] of Object.entries(desiredSettings)) {
  settingsBefore[key] = {
    existed: Object.prototype.hasOwnProperty.call(settings, key),
    value: settings[key],
  };
  settings[key] = value;
}

const state = {
  version: 1,
  installedAt: new Date().toISOString(),
  sourceRoot: ROOT,
  agentDir,
  backupRoot,
  files: [],
  packages: [],
  settings: {
    path: settingsPath,
    fileExisted: settingsExisted,
    before: settingsBefore,
    applied: desiredSettings,
  },
};

function packageIsInstalled(source) {
  const piSettings = readJson(join(agentDir, "settings.json"), {});
  return Array.isArray(piSettings.packages) && piSettings.packages.includes(source);
}

function installPiPackage(source, label) {
  const wasInstalled = packageIsInstalled(source);
  const result = spawnSync("pi", ["install", source], { stdio: "inherit" });
  if (result.error) throw new Error(`could not run pi while installing ${label}: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${label} installation failed`);
  state.packages.push({ source, installedByScript: !wasInstalled });
}

function rollback() {
  for (const file of [...state.files].reverse()) {
    try {
      if (file.backup && existsSync(file.backup)) {
        mkdirSync(dirname(file.target), { recursive: true });
        copyFileSync(file.backup, file.target);
      } else {
        rmSync(file.target, { force: true });
      }
    } catch {
      // Best effort; the original install error is more useful.
    }
  }

  for (const pkg of [...state.packages].reverse()) {
    if (!pkg.installedByScript) continue;
    try {
      spawnSync("pi", ["remove", pkg.source], { stdio: "ignore" });
    } catch {
      // Best effort.
    }
  }

  try {
    if (settingsExisted) {
      const restored = readJson(settingsPath, {});
      for (const [key, prior] of Object.entries(settingsBefore)) {
        if (prior.existed) restored[key] = prior.value;
        else delete restored[key];
      }
      writeJsonAtomic(settingsPath, restored);
    } else {
      rmSync(settingsPath, { force: true });
    }
  } catch {
    // Best effort.
  }
}

try {
  if (installDependency) installPiPackage("npm:@tintinweb/pi-subagents", "pi-subagents");
  if (installWebSearch) installPiPackage("npm:pi-web-search", "pi-web-search");
  if (installAskUser) {
    installPiPackage(
      "npm:@juicesharp/rpiv-ask-user-question",
      "rpiv-ask-user-question",
    );
  }

  for (const file of sourceFiles) {
    mkdirSync(dirname(file.target), { recursive: true });
    if (file.preserveExisting && existsSync(file.target)) continue;

    let backup;
    if (existsSync(file.target)) {
      const rel = relative(agentDir, file.target);
      backup = join(backupRoot, rel);
      mkdirSync(dirname(backup), { recursive: true });
      copyFileSync(file.target, backup);
    }

    copyFileSync(file.source, file.target);
    state.files.push({
      target: file.target,
      installedHash: hashFile(file.target),
      backup,
    });
  }

  writeJsonAtomic(settingsPath, settings);
  writeJsonAtomic(manifestPath, state);
} catch (error) {
  rollback();
  fail(error instanceof Error ? error.message : String(error));
}

console.log(`Installed oh-my-pi-slim into ${agentDir}`);
console.log(`Agent definitions: ${agentsDir}`);
console.log(`Extension: ${extensionDir}`);
console.log(`Preset config: ${join(agentDir, "oh-my-pi-slim.json")}`);
console.log(`Settings merged: ${settingsPath}`);
console.log("");
console.log("Launch the orchestrator with:");
console.log("  pi --omps");
console.log("");
console.log("Or enable it inside an existing Pi session with:");
console.log("  /omps on");
