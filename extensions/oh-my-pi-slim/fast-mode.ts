export const FAST_ENV_VAR = "OMPS_FAST_MODE";
export const FAST_STATE_ENTRY_TYPE = "oh-my-pi-slim:fast-state";
export const FAST_STATE_VERSION = 2;
export const ULTRAFAST_MODEL_ID = "gpt-5.6-sol";

export type FastTier = "off" | "fast" | "ultrafast";

export interface FastModeModel {
  provider?: unknown;
  id?: unknown;
}

export interface FastState {
  version: typeof FAST_STATE_VERSION;
  tier: FastTier;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isFastTier(value: unknown): value is FastTier {
  return value === "off" || value === "fast" || value === "ultrafast";
}

export function nextFastTier(tier: FastTier): FastTier {
  if (tier === "off") return "fast";
  if (tier === "fast") return "ultrafast";
  if (tier === "ultrafast") return "off";
  return "fast";
}

export function fastEnvValue(tier: unknown): FastTier {
  return isFastTier(tier) ? tier : "off";
}

export function fastTierFromEnv(value: unknown): FastTier | undefined {
  if (isFastTier(value)) return value;
  if (value === "0") return "off";
  if (value === "1") return "fast";
  return;
}

export function isFastModeProvider(provider: unknown): boolean {
  return provider === "openai" || provider === "openai-codex";
}

export function applyFastServiceTier(
  payload: unknown,
  model: FastModeModel | undefined,
  tier: unknown,
): Record<string, unknown> | undefined {
  try {
    if (tier !== "fast" && tier !== "ultrafast") return;
    if (!isPlainObject(payload) || !model) return;
    if (!isFastModeProvider(model.provider)) return;
    if (typeof model.id !== "string" || payload.model !== model.id) return;
    const serviceTier = tier === "ultrafast" && model.id === ULTRAFAST_MODEL_ID ? "ultrafast" : "priority";
    return { ...payload, service_tier: serviceTier };
  } catch {
    return;
  }
}

export function makeFastState(tier: FastTier): FastState {
  return { version: FAST_STATE_VERSION, tier };
}

export function parseFastState(value: unknown): FastState | undefined {
  try {
    if (!isPlainObject(value)) return;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== 2 || !keys.includes("version")) return;
    const version = value.version;
    if (version === FAST_STATE_VERSION) {
      if (!keys.includes("tier")) return;
      const tier = value.tier;
      if (!isFastTier(tier)) return;
      return { version: FAST_STATE_VERSION, tier };
    }
    if (version === 1) {
      if (!keys.includes("fast")) return;
      const fast = value.fast;
      if (typeof fast !== "boolean") return;
      return { version: FAST_STATE_VERSION, tier: fast ? "fast" : "off" };
    }
    return;
  } catch {
    return;
  }
}

export function replayFastState(entries: readonly unknown[]): FastTier {
  let tier: FastTier = "off";
  try {
    if (!Array.isArray(entries)) return tier;
    for (const entry of entries) {
      try {
        if (!isPlainObject(entry)) continue;
        if (entry.type !== "custom" || entry.customType !== FAST_STATE_ENTRY_TYPE) continue;
        const state = parseFastState(entry.data);
        if (state) tier = state.tier;
      } catch {
        // Malformed entries are ignored without discarding the latest valid session state.
      }
    }
  } catch {
    // A malformed collection fails closed while preserving any valid state already replayed.
  }
  return tier;
}
