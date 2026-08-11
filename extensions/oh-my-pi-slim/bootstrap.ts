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

const AGENT_NAMES = ["explorer", "librarian", "oracle", "designer", "fixer"] as const;
const MANIFEST_NAME = ".oh-my-pi-slim-package-assets.json";

interface ManagedFile {
  target: string;
  installedHash: string;
  created: boolean;
}

interface SettingBefore {
  existed: boolean;
  value?: unknown;
}

interface AssetManifest {
  version: 1;
  packageVersion: string;
  files: ManagedFile[];
  settings: {
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

function readJson(path: string, fallback: unknown): any {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(
      `${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.oh-my-pi-slim.tmp-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(temp, path);
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function packageMetadata(packageRoot: string): { name?: string; version?: string } {
  return readJson(join(packageRoot, "package.json"), {});
}

function ensureManagedFile(
  source: string,
  target: string,
  previous: ManagedFile | undefined,
  preserveUserEdits: boolean,
): ManagedFile | undefined {
  if (!existsSync(source)) throw new Error(`Package asset is missing: ${source}`);

  const sourceHash = hashFile(source);
  if (!existsSync(target)) {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, readFileSync(source));
    return {
      target,
      installedHash: sourceHash,
      created: previous?.created ?? true,
    };
  }

  const currentHash = hashFile(target);
  if (!previous) {
    if (currentHash === sourceHash) {
      return { target, installedHash: sourceHash, created: false };
    }
    if (preserveUserEdits) return undefined;
    throw new Error(
      `Refusing to overwrite existing agent definition: ${target}. Move it aside and restart Pi.`,
    );
  }

  if (currentHash === sourceHash) {
    return { ...previous, installedHash: sourceHash };
  }

  if (currentHash === previous.installedHash) {
    writeFileSync(target, readFileSync(source));
    return { ...previous, installedHash: sourceHash };
  }

  if (preserveUserEdits) return undefined;
  throw new Error(
    `Managed agent definition was modified: ${target}. Preserve or remove the modification before updating oh-my-pi-slim.`,
  );
}

/**
 * Materialize resources that Pi packages cannot declare natively: pi-subagents
 * Markdown definitions and subagents.json settings. This runs synchronously in
 * the extension factory, before the bundled pi-subagents extension initializes.
 */
export function ensurePackageAssets(packageRoot: string): void {
  if (/^(1|true|yes|on)$/i.test(String(process.env.OMPS_SKIP_BOOTSTRAP ?? ""))) return;

  const metadata = packageMetadata(packageRoot);
  // A legacy scripts/install.mjs installation copies this extension out of the
  // package. In that layout the package assets are not adjacent, so leave the
  // already-installed files alone.
  if (metadata.name !== "oh-my-pi-slim") return;

  const agentDir = getAgentDir();
  const manifestPath = join(agentDir, MANIFEST_NAME);
  const previous = readJson(manifestPath, undefined) as AssetManifest | undefined;
  const previousFiles = new Map((previous?.files ?? []).map((file) => [file.target, file]));
  const files: ManagedFile[] = [];

  for (const name of AGENT_NAMES) {
    const target = join(agentDir, "agents", `${name}.md`);
    const managed = ensureManagedFile(
      join(packageRoot, "agents", `${name}.md`),
      target,
      previousFiles.get(target),
      false,
    );
    if (managed) files.push(managed);
  }

  const presetTarget = join(agentDir, "oh-my-pi-slim.json");
  const preset = ensureManagedFile(
    join(packageRoot, ".pi", "oh-my-pi-slim.json"),
    presetTarget,
    previousFiles.get(presetTarget),
    true,
  );
  if (preset) files.push(preset);

  const settingsPath = join(agentDir, "subagents.json");
  const desiredSettings = readJson(join(packageRoot, "config", "subagents.json"), {});
  const settingsFileExisted = previous?.settings.fileExisted ?? existsSync(settingsPath);
  const settings = readJson(settingsPath, {});
  const before: Record<string, SettingBefore> = previous?.settings.before ?? {};

  for (const [key, value] of Object.entries(desiredSettings)) {
    if (!previous) {
      before[key] = {
        existed: Object.prototype.hasOwnProperty.call(settings, key),
        value: settings[key],
      };
    } else {
      const priorApplied = previous.settings.applied[key];
      if (
        Object.prototype.hasOwnProperty.call(previous.settings.applied, key) &&
        !sameJson(settings[key], priorApplied) &&
        !sameJson(settings[key], value)
      ) {
        throw new Error(
          `Managed pi-subagents setting "${key}" was modified in ${settingsPath}. Restore it or remove ${manifestPath} before updating.`,
        );
      }
    }
    settings[key] = value;
  }
  writeJsonAtomic(settingsPath, settings);

  const manifest: AssetManifest = {
    version: 1,
    packageVersion: metadata.version ?? "unknown",
    files,
    settings: {
      path: settingsPath,
      fileExisted: settingsFileExisted,
      before,
      applied: desiredSettings,
    },
  };
  writeJsonAtomic(manifestPath, manifest);
}

/** Remove only package-created assets whose contents are still unchanged. */
export function removePackageAssets(): CleanupResult {
  const agentDir = getAgentDir();
  const manifestPath = join(agentDir, MANIFEST_NAME);
  const result: CleanupResult = { removed: [], preserved: [], warnings: [] };
  if (!existsSync(manifestPath)) {
    result.warnings.push(`No package asset manifest found at ${manifestPath}.`);
    return result;
  }

  const manifest = readJson(manifestPath, undefined) as AssetManifest;
  let conflict = false;

  for (const file of manifest.files) {
    if (!file.created) {
      result.preserved.push(file.target);
      continue;
    }
    if (!existsSync(file.target)) continue;
    if (hashFile(file.target) !== file.installedHash) {
      conflict = true;
      result.warnings.push(`Kept modified managed file: ${file.target}`);
      continue;
    }
    rmSync(file.target, { force: true });
    result.removed.push(file.target);
  }

  const settingsState = manifest.settings;
  if (existsSync(settingsState.path)) {
    const settings = readJson(settingsState.path, {});
    for (const [key, applied] of Object.entries(settingsState.applied)) {
      if (!sameJson(settings[key], applied)) {
        conflict = true;
        result.warnings.push(`Kept modified setting "${key}" in ${settingsState.path}`);
        continue;
      }
      const prior = settingsState.before[key];
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
  else result.warnings.push(`Manifest kept for manual cleanup: ${manifestPath}`);
  return result;
}
