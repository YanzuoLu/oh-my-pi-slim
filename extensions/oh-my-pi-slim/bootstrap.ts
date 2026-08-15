import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const MIGRATION_STATE_KEY = "ohMyPiSlimMigration";
const LEGACY_MANIFEST_NAME = ".oh-my-pi-slim-package-assets.json";

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

export interface CleanupResult {
  removed: string[];
  preserved: string[];
  warnings: string[];
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
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
    throw new Error(
      `${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must contain a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function writeJsonAtomic(path: string, value: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.oh-my-pi-slim.tmp-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(temp, path);
}

function parseMigrationState(value: unknown, path: string): MigrationState | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid oh-my-pi-slim migration state in ${path}.`);
  }

  const state = value as Partial<MigrationState>;
  if (
    state.version !== 1 ||
    !state.userSettings ||
    !state.backendConfig ||
    typeof state.userSettings.fileExisted !== "boolean" ||
    typeof state.userSettings.subagentsExisted !== "boolean" ||
    typeof state.userSettings.disableBuiltins?.existed !== "boolean" ||
    typeof state.backendConfig.fileExisted !== "boolean" ||
    typeof state.backendConfig.maxSubagentDepth?.existed !== "boolean"
  ) {
    throw new Error(`Invalid oh-my-pi-slim migration state in ${path}.`);
  }

  return state as MigrationState;
}

function getMigrationPaths(): { agentDir: string; userSettingsPath: string; backendConfigPath: string } {
  const agentDir = getAgentDir();
  return {
    agentDir,
    userSettingsPath: join(agentDir, "settings.json"),
    backendConfigPath: join(agentDir, "extensions", "subagent", "config.json"),
  };
}

function removeLegacyPackageAssets(agentDir: string): void {
  const manifestPath = join(agentDir, LEGACY_MANIFEST_NAME);
  if (!existsSync(manifestPath)) return;

  const manifest = readJsonObject(manifestPath) as LegacyAssetManifest;
  let conflict = false;
  for (const file of manifest.files ?? []) {
    if (!file.created || !existsSync(file.target)) continue;
    if (hashFile(file.target) !== file.installedHash) {
      conflict = true;
      console.warn(`[oh-my-pi-slim] Kept modified legacy managed file: ${file.target}`);
      continue;
    }
    rmSync(file.target, { force: true });
  }

  const settingsState = manifest.settings;
  if (settingsState?.path && existsSync(settingsState.path)) {
    const settings = readJsonObject(settingsState.path);
    for (const [key, applied] of Object.entries(settingsState.applied ?? {})) {
      if (!sameJson(settings[key], applied)) {
        conflict = true;
        console.warn(`[oh-my-pi-slim] Kept modified legacy setting "${key}" in ${settingsState.path}`);
        continue;
      }
      const prior = settingsState.before?.[key];
      if (prior?.existed) settings[key] = prior.value;
      else delete settings[key];
    }
    if (!settingsState.fileExisted && Object.keys(settings).length === 0) {
      rmSync(settingsState.path, { force: true });
    } else {
      writeJsonAtomic(settingsState.path, settings);
    }
  }

  if (!conflict) rmSync(manifestPath, { force: true });
  else console.warn(`[oh-my-pi-slim] Kept legacy migration manifest for manual cleanup: ${manifestPath}`);
}

export function getPresetTemplatePath(packageRoot: string): string {
  return join(packageRoot, "config", "oh-my-pi-slim.example.json");
}

/** Seed the user preset when missing and apply two native settings while preserving their original values. */
export function ensureNativePackageSetup(packageRoot: string): void {
  if (/^(1|true|yes|on)$/i.test(String(process.env.OMPS_SKIP_BOOTSTRAP ?? ""))) return;

  const packageJson = readJsonObject(join(packageRoot, "package.json"));
  if (packageJson.name !== "oh-my-pi-slim") return;

  const bundledPresetPath = getPresetTemplatePath(packageRoot);
  if (!existsSync(bundledPresetPath)) {
    throw new Error(`Package preset template is missing: ${bundledPresetPath}`);
  }

  const { agentDir, userSettingsPath, backendConfigPath } = getMigrationPaths();
  removeLegacyPackageAssets(agentDir);

  const userPresetPath = join(agentDir, "oh-my-pi-slim.json");
  if (!existsSync(userPresetPath)) {
    mkdirSync(agentDir, { recursive: true });
    try {
      writeFileSync(userPresetPath, readFileSync(bundledPresetPath), { flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }

  const userSettingsFileExisted = existsSync(userSettingsPath);
  const backendConfigFileExisted = existsSync(backendConfigPath);
  const userSettings = readJsonObject(userSettingsPath);
  const backendConfig = readJsonObject(backendConfigPath);
  const existingSubagents = userSettings.subagents;
  if (
    existingSubagents !== undefined &&
    (!existingSubagents || typeof existingSubagents !== "object" || Array.isArray(existingSubagents))
  ) {
    throw new Error(`${userSettingsPath}.subagents must be a JSON object.`);
  }

  const subagents = existingSubagents as Record<string, unknown> | undefined;
  const state = parseMigrationState(backendConfig[MIGRATION_STATE_KEY], backendConfigPath) ?? {
    version: 1,
    userSettings: {
      fileExisted: userSettingsFileExisted,
      subagentsExisted: subagents !== undefined,
      disableBuiltins: {
        existed: subagents !== undefined && hasOwn(subagents, "disableBuiltins"),
        value: subagents?.disableBuiltins,
      },
    },
    backendConfig: {
      fileExisted: backendConfigFileExisted,
      maxSubagentDepth: {
        existed: hasOwn(backendConfig, "maxSubagentDepth"),
        value: backendConfig.maxSubagentDepth,
      },
    },
  } satisfies MigrationState;

  backendConfig.maxSubagentDepth = 1;
  backendConfig[MIGRATION_STATE_KEY] = state;
  writeJsonAtomic(backendConfigPath, backendConfig);

  userSettings.subagents = {
    ...(subagents ?? {}),
    disableBuiltins: true,
  };
  writeJsonAtomic(userSettingsPath, userSettings);
}

/** Restore the exact pre-install values. The package itself is removed separately with `pi remove`. */
export function restoreNativePackageSetup(): CleanupResult {
  const result: CleanupResult = { removed: [], preserved: [], warnings: [] };
  const { userSettingsPath, backendConfigPath } = getMigrationPaths();
  if (!existsSync(backendConfigPath)) {
    result.warnings.push(`No pi-subagents config found at ${backendConfigPath}; migration state cannot be restored.`);
    return result;
  }

  const backendConfig = readJsonObject(backendConfigPath);
  const state = parseMigrationState(backendConfig[MIGRATION_STATE_KEY], backendConfigPath);
  if (!state) {
    result.warnings.push(`No oh-my-pi-slim migration state found in ${backendConfigPath}.`);
    return result;
  }

  const userSettings = readJsonObject(userSettingsPath);
  const existingSubagents = userSettings.subagents;
  if (
    existingSubagents !== undefined &&
    (!existingSubagents || typeof existingSubagents !== "object" || Array.isArray(existingSubagents))
  ) {
    throw new Error(`${userSettingsPath}.subagents must be a JSON object.`);
  }

  const subagents = (existingSubagents ?? {}) as Record<string, unknown>;
  if (state.userSettings.disableBuiltins.existed) {
    subagents.disableBuiltins = state.userSettings.disableBuiltins.value;
  } else {
    delete subagents.disableBuiltins;
  }
  if (!state.userSettings.subagentsExisted && Object.keys(subagents).length === 0) {
    delete userSettings.subagents;
  } else {
    userSettings.subagents = subagents;
  }

  if (!state.userSettings.fileExisted && Object.keys(userSettings).length === 0) {
    rmSync(userSettingsPath, { force: true });
    result.removed.push(userSettingsPath);
  } else {
    writeJsonAtomic(userSettingsPath, userSettings);
    result.preserved.push(userSettingsPath);
  }

  if (state.backendConfig.maxSubagentDepth.existed) {
    backendConfig.maxSubagentDepth = state.backendConfig.maxSubagentDepth.value;
  } else {
    delete backendConfig.maxSubagentDepth;
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
