export const CACHE_RETENTION_ENV_VAR = "OMPS_CACHE_RETENTION";
export const CACHE_STATE_ENTRY_TYPE = "oh-my-pi-slim:cache-state";
export const CACHE_STATE_VERSION = 1;

export type CacheRetention = "short" | "long";

export interface CacheRetentionModel {
  provider?: unknown;
  api?: unknown;
  id?: unknown;
  compat?: { supportsLongCacheRetention?: unknown } | null;
}

export interface CacheState {
  version: typeof CACHE_STATE_VERSION;
  retention: CacheRetention;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isCacheRetention(value: unknown): value is CacheRetention {
  return value === "short" || value === "long";
}

const MAX_CACHE_MARKERS = 4;
const NO_CACHE_CONTROL = Symbol("no-cache-control");

function legalCacheControl(value: unknown): value is Record<string, unknown> {
  if (!isPlainObject(value)) return false;
  const keys = Reflect.ownKeys(value);
  const hasTtl = keys.includes("ttl");
  const typeDescriptor = Object.getOwnPropertyDescriptor(value, "type");
  const ttlDescriptor = hasTtl ? Object.getOwnPropertyDescriptor(value, "ttl") : undefined;
  return Boolean(
    typeDescriptor?.enumerable && "value" in typeDescriptor && typeDescriptor.value === "ephemeral" &&
    keys.every((key) => key === "type" || key === "ttl") &&
    (!hasTtl || (ttlDescriptor?.enumerable && "value" in ttlDescriptor &&
      (ttlDescriptor.value === "5m" || ttlDescriptor.value === "1h"))),
  );
}

function cacheControl(value: unknown): Record<string, unknown> | typeof NO_CACHE_CONTROL {
  if (!isPlainObject(value)) return NO_CACHE_CONTROL;
  const descriptor = Object.getOwnPropertyDescriptor(value, "cache_control");
  if (!descriptor) return NO_CACHE_CONTROL;
  if (!descriptor.enumerable || !("value" in descriptor) || !legalCacheControl(descriptor.value)) {
    throw new Error("Invalid cache_control on a target surface.");
  }
  return descriptor.value;
}

function countOwner(value: unknown): number {
  return cacheControl(value) === NO_CACHE_CONTROL ? 0 : 1;
}

function countContent(value: unknown): number {
  if (Array.isArray(value)) return value.reduce((count, item) => count + countContent(item), 0);
  if (!isPlainObject(value)) return 0;
  const ownCount = countOwner(value);
  return Object.prototype.hasOwnProperty.call(value, "content")
    ? ownCount + countContent(value.content)
    : ownCount;
}

function countTools(value: unknown): number {
  return Array.isArray(value) ? value.reduce((count, tool) => count + countOwner(tool), 0) : 0;
}

function countMessages(value: unknown): number {
  if (!Array.isArray(value)) return 0;
  return value.reduce((count, message) => {
    if (!isPlainObject(message) || !Object.prototype.hasOwnProperty.call(message, "content")) return count;
    return count + countContent(message.content);
  }, 0);
}

function countTargetMarkers(payload: Record<string, unknown>): number {
  let count = countOwner(payload);
  if (Object.prototype.hasOwnProperty.call(payload, "system")) count += countContent(payload.system);
  if (Object.prototype.hasOwnProperty.call(payload, "tools")) count += countTools(payload.tools);
  if (Object.prototype.hasOwnProperty.call(payload, "messages")) count += countMessages(payload.messages);
  return count;
}

function transformCacheControl(value: Record<string, unknown>, retention: CacheRetention): Record<string, unknown> {
  const ttlDescriptor = Object.getOwnPropertyDescriptor(value, "ttl");
  if (retention === "long") return ttlDescriptor?.value === "1h" ? value : { ...value, ttl: "1h" };
  if (!ttlDescriptor) return value;
  const clone = { ...value };
  delete clone.ttl;
  return clone;
}

function transformOwner(value: unknown, retention: CacheRetention): unknown {
  const current = cacheControl(value);
  if (current === NO_CACHE_CONTROL) return value;
  const transformed = transformCacheControl(current, retention);
  return transformed === current ? value : { ...(value as Record<string, unknown>), cache_control: transformed };
}

function transformContent(value: unknown, retention: CacheRetention): unknown {
  if (Array.isArray(value)) {
    let changed = false;
    const transformed = value.map((item) => {
      const next = transformContent(item, retention);
      if (next !== item) changed = true;
      return next;
    });
    return changed ? transformed : value;
  }
  if (!isPlainObject(value)) return value;
  let transformed = transformOwner(value, retention) as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(value, "content")) {
    const content = transformContent(value.content, retention);
    if (content !== value.content) transformed = { ...transformed, content };
  }
  return transformed;
}

function transformTools(value: unknown, retention: CacheRetention): unknown {
  if (!Array.isArray(value)) return value;
  let changed = false;
  const transformed = value.map((tool) => {
    const next = transformOwner(tool, retention);
    if (next !== tool) changed = true;
    return next;
  });
  return changed ? transformed : value;
}

function transformMessages(value: unknown, retention: CacheRetention): unknown {
  if (!Array.isArray(value)) return value;
  let changed = false;
  const transformed = value.map((message) => {
    if (!isPlainObject(message) || !Object.prototype.hasOwnProperty.call(message, "content")) return message;
    const content = transformContent(message.content, retention);
    if (content === message.content) return message;
    changed = true;
    return { ...message, content };
  });
  return changed ? transformed : value;
}

/** Clone one to four existing legal Anthropic cache breakpoints only when every target marker is valid. */
export function applyCacheRetention(payload: unknown, retention: CacheRetention): Record<string, unknown> | undefined {
  try {
    if (!isPlainObject(payload) || !isCacheRetention(retention)) return;
    const markerCount = countTargetMarkers(payload);
    if (markerCount === 0 || markerCount > MAX_CACHE_MARKERS) return;
    let transformed = transformOwner(payload, retention) as Record<string, unknown>;
    for (const [field, transform] of [
      ["system", transformContent],
      ["tools", transformTools],
      ["messages", transformMessages],
    ] as const) {
      if (!Object.prototype.hasOwnProperty.call(payload, field)) continue;
      const value = transform(payload[field], retention);
      if (value !== payload[field]) transformed = { ...transformed, [field]: value };
    }
    return transformed === payload ? undefined : transformed;
  } catch {
    return;
  }
}

/**
 * Apply retention only to an exact ordinary Claude Anthropic OAuth request.
 *
 * Pi currently keeps compaction and branch-summary calls outside the agent loop onPayload path and
 * upstream forces cacheRetention to "none" for those calls. This boundary depends on Pi's implementation.
 */
export function applyCacheRetentionForRequest(
  payload: unknown,
  model: CacheRetentionModel | undefined,
  retention: CacheRetention,
  isUsingOAuth: () => boolean,
): Record<string, unknown> | undefined {
  try {
    if (!isPlainObject(payload) || !model || !isCacheRetention(retention)) return;
    if (model.provider !== "anthropic" || model.api !== "anthropic-messages") return;
    if (typeof model.id !== "string" || payload.model !== model.id) return;
    if (model.compat?.supportsLongCacheRetention === false) return;
    if (isUsingOAuth() !== true) return;
    return applyCacheRetention(payload, retention);
  } catch {
    return;
  }
}

export function cacheRetentionEnvValue(retention: CacheRetention): CacheRetention {
  return retention;
}

export function cacheRetentionFromEnv(value: unknown): CacheRetention | undefined {
  return isCacheRetention(value) ? value : undefined;
}

export function makeCacheState(retention: CacheRetention): CacheState {
  return { version: CACHE_STATE_VERSION, retention };
}

export function parseCacheState(value: unknown): CacheState | undefined {
  try {
    if (!isPlainObject(value)) return;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== 2 || !keys.includes("version") || !keys.includes("retention")) return;
    if (value.version !== CACHE_STATE_VERSION || !isCacheRetention(value.retention)) return;
    return { version: CACHE_STATE_VERSION, retention: value.retention };
  } catch {
    return;
  }
}

export function replayCacheState(entries: readonly unknown[]): CacheRetention {
  let retention: CacheRetention = "short";
  try {
    if (!Array.isArray(entries)) return retention;
    for (const entry of entries) {
      try {
        if (!isPlainObject(entry)) continue;
        if (entry.type !== "custom" || entry.customType !== CACHE_STATE_ENTRY_TYPE) continue;
        const state = parseCacheState(entry.data);
        if (state) retention = state.retention;
      } catch {
        // Malformed entries do not erase the latest valid session policy.
      }
    }
  } catch {
    // A malformed collection keeps the default or the latest valid policy already replayed.
  }
  return retention;
}
