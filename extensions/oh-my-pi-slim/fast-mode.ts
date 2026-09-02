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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function applyFastServiceTier(
  payload: unknown,
  model: FastModeModel | undefined,
): Record<string, unknown> | undefined {
  if (!isRecord(payload) || !model) return;
  if (model.provider !== "openai" && model.provider !== "openai-codex") return;
  if (typeof model.id !== "string" || payload.model !== model.id) return;
  return { ...payload, service_tier: "priority" };
}

export function makeFastState(fast: boolean): FastState {
  return { version: FAST_STATE_VERSION, fast };
}

export function parseFastState(value: unknown): FastState | undefined {
  if (!isRecord(value) || Object.keys(value).sort().join(",") !== "fast,version") return;
  if (value.version !== FAST_STATE_VERSION || typeof value.fast !== "boolean") return;
  return { version: FAST_STATE_VERSION, fast: value.fast };
}

export function replayFastState(entries: readonly unknown[]): boolean {
  let fast = false;
  for (const entry of entries) {
    if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== FAST_STATE_ENTRY_TYPE) continue;
    const state = parseFastState(entry.data);
    if (state) fast = state.fast;
  }
  return fast;
}

export function fastEnvValue(enabled: boolean): "1" | "0" {
  return enabled ? "1" : "0";
}

export function fastEnabledFromEnv(value: unknown): boolean {
  return value === "1";
}
