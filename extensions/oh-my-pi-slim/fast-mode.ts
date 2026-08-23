export const FAST_ENV_VAR = "OMPS_FAST_MODE";
export const FAST_STATE_ENTRY_TYPE = "oh-my-pi-slim:fast-state";
export const FAST_STATE_VERSION = 1;

export interface FastModeModel {
  provider?: unknown;
  id?: unknown;
}

export interface FastState {
  version: typeof FAST_STATE_VERSION;
  fast: boolean;
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

export function isFastModeProvider(provider: unknown): boolean {
  return provider === "openai" || provider === "openai-codex";
}

export function applyFastServiceTier(payload: unknown, model: FastModeModel | undefined): Record<string, unknown> | undefined {
  try {
    if (!isPlainObject(payload) || !model) return;
    if (!isFastModeProvider(model.provider)) return;
    if (typeof model.id !== "string" || payload.model !== model.id) return;
    return { ...payload, service_tier: "priority" };
  } catch {
    return;
  }
}

export function makeFastState(fast: boolean): FastState {
  return { version: FAST_STATE_VERSION, fast };
}

export function parseFastState(value: unknown): FastState | undefined {
  try {
    if (!isPlainObject(value)) return;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== 2 || !keys.includes("version") || !keys.includes("fast")) return;
    if (value.version !== FAST_STATE_VERSION || typeof value.fast !== "boolean") return;
    return { version: FAST_STATE_VERSION, fast: value.fast };
  } catch {
    return;
  }
}

export function replayFastState(entries: readonly unknown[]): boolean {
  let fast = false;
  try {
    if (!Array.isArray(entries)) return fast;
    for (const entry of entries) {
      try {
        if (!isPlainObject(entry)) continue;
        if (entry.type !== "custom" || entry.customType !== FAST_STATE_ENTRY_TYPE) continue;
        const state = parseFastState(entry.data);
        if (state) fast = state.fast;
      } catch {
        // Malformed entries are ignored without discarding the latest valid session state.
      }
    }
  } catch {
    // A malformed collection fails closed while preserving any valid state already replayed.
  }
  return fast;
}
