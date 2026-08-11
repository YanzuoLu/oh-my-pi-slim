#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const args = new Set(process.argv.slice(2));
const removeDependencies = args.has("--remove-dependencies");
const removeDependency = removeDependencies || args.has("--remove-dependency");
const removeWebSearch = removeDependencies || args.has("--remove-web-search");
const removeAskUser = removeDependencies || args.has("--remove-ask-user");
const agentDir = process.env.PI_CODING_AGENT_DIR
  ? resolve(process.env.PI_CODING_AGENT_DIR)
  : join(homedir(), ".pi", "agent");
const manifestPath = join(agentDir, ".oh-my-pi-slim-install.json");

function fail(message) {
  console.error(`Uninstall failed: ${message}`);
  process.exit(1);
}

function hashFile(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function readJson(path) {
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

function equalJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

if (!existsSync(manifestPath)) {
  fail(`no installation manifest found at ${manifestPath}`);
}

const manifest = readJson(manifestPath);
const warnings = [];

for (const file of manifest.files ?? []) {
  if (!existsSync(file.target)) {
    warnings.push(`Already missing: ${file.target}`);
    continue;
  }

  if (hashFile(file.target) !== file.installedHash) {
    warnings.push(`Left modified installed file in place: ${file.target}`);
    continue;
  }

  if (file.backup && existsSync(file.backup)) {
    mkdirSync(dirname(file.target), { recursive: true });
    copyFileSync(file.backup, file.target);
  } else {
    rmSync(file.target, { force: true });
  }
}

const settingsState = manifest.settings;
if (settingsState?.path) {
  if (!existsSync(settingsState.path)) {
    warnings.push(`Settings file already missing: ${settingsState.path}`);
  } else {
    const current = readJson(settingsState.path);
    for (const [key, appliedValue] of Object.entries(settingsState.applied ?? {})) {
      if (!equalJson(current[key], appliedValue)) {
        warnings.push(`Kept user-modified setting ${key} in ${settingsState.path}`);
        continue;
      }

      const prior = settingsState.before?.[key];
      if (prior?.existed) current[key] = prior.value;
      else delete current[key];
    }

    if (!settingsState.fileExisted && Object.keys(current).length === 0) {
      rmSync(settingsState.path, { force: true });
    } else {
      writeJsonAtomic(settingsState.path, current);
    }
  }
}

rmSync(manifestPath, { force: true });

if (warnings.length === 0 && manifest.backupRoot) {
  rmSync(manifest.backupRoot, { recursive: true, force: true });
}

function removePiPackage(source) {
  const result = spawnSync("pi", ["remove", source], { stdio: "inherit" });
  if (result.error) warnings.push(`Could not run pi remove ${source}: ${result.error.message}`);
  else if (result.status !== 0) warnings.push(`pi remove ${source} failed`);
}

if (removeDependency) removePiPackage("npm:@tintinweb/pi-subagents");
if (removeWebSearch) removePiPackage("npm:pi-web-search");
if (removeAskUser) removePiPackage("npm:@juicesharp/rpiv-ask-user-question");

console.log(`Uninstalled managed oh-my-pi-slim files from ${agentDir}`);
if (!removeDependency || !removeWebSearch || !removeAskUser) {
  console.log("Left shared Pi packages installed unless explicitly requested otherwise.");
  if (!removeDependency) console.log("  pi remove npm:@tintinweb/pi-subagents");
  if (!removeWebSearch) console.log("  pi remove npm:pi-web-search");
  if (!removeAskUser) console.log("  pi remove npm:@juicesharp/rpiv-ask-user-question");
}

if (warnings.length > 0) {
  console.log("\nWarnings:");
  for (const warning of warnings) console.log(`- ${warning}`);
  if (manifest.backupRoot) console.log(`Backups were kept at: ${manifest.backupRoot}`);
}
