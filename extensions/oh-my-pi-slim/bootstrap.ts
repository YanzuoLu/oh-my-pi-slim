import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const MIGRATION_STATE_KEY = "ohMyPiSlimMigration";
const LEGACY_MANIFEST_NAME = ".oh-my-pi-slim-package-assets.json";

interface SettingBefore {
  existed: boolean;
  value?: unknown;
}

interface MigrationState {
  version: 1;
  userSettings: {
    fileExisted: boolean;
    subagentsExisted: boolean;
    disableBuiltins: SettingBefore;
  };
  backendConfig: {
    fileExisted: boolean;
    maxSubagentDepth: SettingBefore;
  };
}

interface LegacyManagedFile {
  target: string;
  installedHash: string;
  created: boolean;
}

interface LegacyAssetManifest {
  files?: LegacyManagedFile[];
  settings?: {
    path: string;
    fileExisted: boolean;
    before: Record<string, SettingBefore>;
    applied: Record<string, unknown>;
  };
}

export interface CleanupResult {
  removed: string[];
  preserved: string[];
  warnings: string[];
}

function hashFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function readJsonObject(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must contain a JSON object.`);
  return value as Record<string, unknown>;
}

function writeJsonAtomic(path: string, value: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.oh-my-pi-slim.tmp-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(temp, path);
}

function parseMigrationState(value: unknown): MigrationState | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const state = value as Partial<MigrationState>;
  if (
    state.version !== 1 ||
    typeof state.userSettings?.fileExisted !== "boolean" ||
    typeof state.userSettings?.subagentsExisted !== "boolean" ||
    typeof state.userSettings?.disableBuiltins?.existed !== "boolean" ||
    typeof state.backendConfig?.fileExisted !== "boolean" ||
    typeof state.backendConfig?.maxSubagentDepth?.existed !== "boolean"
  ) return undefined;
  return state as MigrationState;
}

function removeLegacyPackageAssets(agentDir: string, result: CleanupResult): void {
  const manifestPath = join(agentDir, LEGACY_MANIFEST_NAME);
  if (!existsSync(manifestPath)) return;
  const manifest = readJsonObject(manifestPath) as LegacyAssetManifest;
  let conflict = false;
  for (const file of manifest.files ?? []) {
    if (!file.created || !existsSync(file.target)) continue;
    if (hashFile(file.target) !== file.installedHash) {
      conflict = true;
      result.warnings.push(`Kept modified legacy managed file: ${file.target}`);
      continue;
    }
    rmSync(file.target, { force: true });
    result.removed.push(file.target);
  }

  const settingsState = manifest.settings;
  if (settingsState?.path && existsSync(settingsState.path)) {
    const settings = readJsonObject(settingsState.path);
    for (const [key, applied] of Object.entries(settingsState.applied ?? {})) {
      if (!sameJson(settings[key], applied)) {
        conflict = true;
        result.warnings.push(`Kept modified legacy setting "${key}" in ${settingsState.path}`);
        continue;
      }
      const prior = settingsState.before?.[key];
      if (prior?.existed) settings[key] = prior.value;
      else delete settings[key];
    }
    if (!settingsState.fileExisted && Object.keys(settings).length === 0) {
      rmSync(settingsState.path, { force: true });
      result.removed.push(settingsState.path);
    } else {
      writeJsonAtomic(settingsState.path, settings);
      result.preserved.push(settingsState.path);
    }
  }

  if (!conflict) {
    rmSync(manifestPath, { force: true });
    result.removed.push(manifestPath);
  } else {
    result.warnings.push(`Kept legacy asset manifest for manual cleanup: ${manifestPath}`);
  }
}

export function getPresetTemplatePath(packageRoot: string): string {
  return join(packageRoot, "config", "oh-my-pi-slim.example.json");
}

/** Restore and remove setup state written by OMPS releases that depended on pi-subagents. */
export function cleanupLegacySubagentSetup(): CleanupResult {
  const result: CleanupResult = { removed: [], preserved: [], warnings: [] };
  const agentDir = getAgentDir();
  removeLegacyPackageAssets(agentDir, result);

  const userSettingsPath = join(agentDir, "settings.json");
  const backendConfigPath = join(agentDir, "extensions", "subagent", "config.json");
  if (!existsSync(backendConfigPath)) return result;

  const backendConfig = readJsonObject(backendConfigPath);
  const state = parseMigrationState(backendConfig[MIGRATION_STATE_KEY]);
  if (!state) return result;

  const userSettings = readJsonObject(userSettingsPath);
  const existingSubagents = userSettings.subagents;
  const subagents = existingSubagents && typeof existingSubagents === "object" && !Array.isArray(existingSubagents)
    ? existingSubagents as Record<string, unknown>
    : {};

  if (sameJson(subagents.disableBuiltins, true)) {
    if (state.userSettings.disableBuiltins.existed) subagents.disableBuiltins = state.userSettings.disableBuiltins.value;
    else delete subagents.disableBuiltins;
  } else if (Object.prototype.hasOwnProperty.call(subagents, "disableBuiltins")) {
    result.warnings.push(`Kept modified settings.subagents.disableBuiltins in ${userSettingsPath}`);
  }

  if (!state.userSettings.subagentsExisted && Object.keys(subagents).length === 0) delete userSettings.subagents;
  else if (existingSubagents !== undefined || Object.keys(subagents).length > 0) userSettings.subagents = subagents;

  if (!state.userSettings.fileExisted && Object.keys(userSettings).length === 0) {
    rmSync(userSettingsPath, { force: true });
    result.removed.push(userSettingsPath);
  } else if (existsSync(userSettingsPath) || Object.keys(userSettings).length > 0) {
    writeJsonAtomic(userSettingsPath, userSettings);
    result.preserved.push(userSettingsPath);
  }

  if (sameJson(backendConfig.maxSubagentDepth, 1)) {
    if (state.backendConfig.maxSubagentDepth.existed) backendConfig.maxSubagentDepth = state.backendConfig.maxSubagentDepth.value;
    else delete backendConfig.maxSubagentDepth;
  } else if (Object.prototype.hasOwnProperty.call(backendConfig, "maxSubagentDepth")) {
    result.warnings.push(`Kept modified maxSubagentDepth in ${backendConfigPath}`);
  }
  delete backendConfig[MIGRATION_STATE_KEY];

  if (!state.backendConfig.fileExisted && Object.keys(backendConfig).length === 0) {
    rmSync(backendConfigPath, { force: true });
    result.removed.push(backendConfigPath);
  } else {
    writeJsonAtomic(backendConfigPath, backendConfig);
    result.preserved.push(backendConfigPath);
  }
  return result;
}

/** Seed the user preset once and clean legacy backend migration state. */
export function ensurePackageSetup(packageRoot: string): void {
  if (/^(1|true|yes|on)$/i.test(String(process.env.OMPS_SKIP_BOOTSTRAP ?? ""))) return;
  const packageJson = readJsonObject(join(packageRoot, "package.json"));
  if (packageJson.name !== "oh-my-pi-slim") return;
  const bundledPresetPath = getPresetTemplatePath(packageRoot);
  if (!existsSync(bundledPresetPath)) throw new Error(`Package preset template is missing: ${bundledPresetPath}`);

  cleanupLegacySubagentSetup();
  const agentDir = getAgentDir();
  const userPresetPath = join(agentDir, "oh-my-pi-slim.json");
  if (!existsSync(userPresetPath)) {
    mkdirSync(agentDir, { recursive: true });
    try {
      writeFileSync(userPresetPath, readFileSync(bundledPresetPath), { flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}
