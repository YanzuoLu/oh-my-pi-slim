import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

export const FAST_ENV_VAR = "OMPS_FAST_MODE";

export interface FastModeModel {
  provider?: unknown;
  id?: unknown;
}

export interface FastFlagRead {
  ok: boolean;
  fast: boolean;
  raw?: Record<string, unknown>;
  error?: string;
}

export interface FastModeWriteIO {
  randomId: () => string;
  open: typeof openSync;
  write: typeof writeFileSync;
  close: typeof closeSync;
  chmod: typeof chmodSync;
  rename: typeof renameSync;
  unlink: typeof unlinkSync;
}

function defaultWriteIO(): FastModeWriteIO {
  return {
    randomId: randomUUID,
    open: openSync,
    write: writeFileSync,
    close: closeSync,
    chmod: chmodSync,
    rename: renameSync,
    unlink: unlinkSync,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function fastEnvValue(enabled: boolean): "1" | "0" {
  return enabled ? "1" : "0";
}

export function fastEnabledFromEnv(value: unknown): boolean {
  return value === "1";
}

export function applyFastServiceTier(payload: unknown, model: FastModeModel | undefined): Record<string, unknown> | undefined {
  try {
    if (!isPlainObject(payload) || !model) return;
    if (model.provider !== "openai" && model.provider !== "openai-codex") return;
    if (typeof model.id !== "string" || payload.model !== model.id) return;
    return { ...payload, service_tier: "priority" };
  } catch {
    return;
  }
}

export function readFastFlag(path: string): FastFlagRead {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return {
      ok: false,
      fast: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  if (!isPlainObject(value)) {
    return { ok: false, fast: false, error: `${path} must contain a JSON object.` };
  }
  return { ok: true, fast: value.fast === true, raw: value };
}

export function writeFastFlag(
  path: string,
  raw: unknown,
  next: boolean,
  io: FastModeWriteIO = defaultWriteIO(),
): void {
  if (!isPlainObject(raw)) throw new Error(`${path} must contain a JSON object.`);
  if (!isPlainObject(raw.presets)) throw new Error(`${path}.presets must be an object.`);

  const value = { ...raw, fast: next };
  const temp = join(dirname(path), `.${basename(path)}.fast-${process.pid}-${io.randomId()}.tmp`);
  let descriptor: number | undefined;
  let renamed = false;
  try {
    descriptor = io.open(temp, "wx", 0o600);
    io.write(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    io.close(descriptor);
    descriptor = undefined;
    io.chmod(temp, 0o600);
    io.rename(temp, path);
    renamed = true;
  } catch (error) {
    if (descriptor !== undefined) {
      try { io.close(descriptor); } catch {}
    }
    if (!renamed) {
      try { io.unlink(temp); } catch {}
    }
    throw error;
  }
}
