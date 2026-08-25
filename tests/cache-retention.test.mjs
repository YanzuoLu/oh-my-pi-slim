import assert from "node:assert/strict";
import test from "node:test";

const {
  CACHE_RETENTION_ENV_VAR,
  CACHE_STATE_ENTRY_TYPE,
  CACHE_STATE_VERSION,
  applyCacheRetention,
  applyCacheRetentionForRequest,
  cacheRetentionEnvValue,
  cacheRetentionFromEnv,
  makeCacheState,
  parseCacheState,
  replayCacheState,
} = await import("../extensions/oh-my-pi-slim/cache-retention.ts");

function cacheEntry(data, overrides = {}) {
  return {
    type: "custom",
    customType: CACHE_STATE_ENTRY_TYPE,
    data,
    ...overrides,
  };
}

function oauthModel(overrides = {}) {
  return {
    provider: "anthropic",
    api: "anthropic-messages",
    id: "claude-exact",
    compat: {},
    ...overrides,
  };
}

/** Mirrors Pi's Anthropic OAuth agent payload with two system, last-tool, and last-user markers. */
function realPiOAuthPayload() {
  return {
    model: "claude-exact",
    max_tokens: 32_000,
    system: [
      { type: "text", text: "identity", cache_control: { type: "ephemeral" } },
      { type: "text", text: "project context", cache_control: { type: "ephemeral", ttl: "5m" } },
    ],
    tools: [
      { name: "read", description: "Read", input_schema: { type: "object" } },
      {
        name: "contact_supervisor",
        description: "Contact",
        input_schema: { type: "object", additionalProperties: false },
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [
      { role: "assistant", content: [{ type: "text", text: "ready" }] },
      {
        role: "user",
        content: [
          { type: "text", text: "work" },
          { type: "text", text: "latest user block", cache_control: { type: "ephemeral", ttl: "5m" } },
        ],
      },
    ],
    metadata: { user_id: "kept" },
  };
}

function realPiMarkers(payload) {
  return [
    payload.system[0].cache_control,
    payload.system[1].cache_control,
    payload.tools.at(-1).cache_control,
    payload.messages.at(-1).content.at(-1).cache_control,
  ];
}

function countRealPiMarkers(payload) {
  return realPiMarkers(payload).filter(Boolean).length;
}

test("Cache retention environment accepts only explicit short and long child snapshots", () => {
  assert.equal(CACHE_RETENTION_ENV_VAR, "OMPS_CACHE_RETENTION");
  assert.equal(cacheRetentionEnvValue("short"), "short");
  assert.equal(cacheRetentionEnvValue("long"), "long");
  assert.equal(cacheRetentionFromEnv("short"), "short");
  assert.equal(cacheRetentionFromEnv("long"), "long");
  for (const value of [undefined, null, "", "Short", "LONG", "1", 1, true]) {
    assert.equal(cacheRetentionFromEnv(value), undefined);
  }
});

test("real Pi OAuth four-marker fixture stays four across immutable Long and Short rewrites", () => {
  const payload = realPiOAuthPayload();
  const beforeLong = structuredClone(payload);
  assert.equal(countRealPiMarkers(payload), 4);

  const long = applyCacheRetention(payload, "long");
  assert.ok(long);
  assert.notEqual(long, payload);
  assert.equal(countRealPiMarkers(long), 4);
  assert.deepEqual(realPiMarkers(long), Array.from({ length: 4 }, () => ({ type: "ephemeral", ttl: "1h" })));
  assert.deepEqual(payload, beforeLong, "Long never mutates the Pi payload fixture");
  assert.equal(long.tools[0], payload.tools[0], "unmarked tool identity is preserved");
  assert.deepEqual(long.tools.at(-1).input_schema, { type: "object", additionalProperties: false });
  assert.deepEqual(long.metadata, { user_id: "kept" });

  const beforeShort = structuredClone(long);
  const short = applyCacheRetention(long, "short");
  assert.ok(short);
  assert.equal(countRealPiMarkers(short), 4);
  assert.deepEqual(realPiMarkers(short), Array.from({ length: 4 }, () => ({ type: "ephemeral" })));
  assert.deepEqual(long, beforeShort, "Short never mutates the Long payload");
  assert.equal(short.messages[0], long.messages[0], "unmarked message identity is preserved");
});

test("top-level and nested tool-result target markers transform without creating markers", () => {
  const payload = {
    model: "claude-exact",
    cache_control: { type: "ephemeral" },
    messages: [{
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: "tool-1",
        cache_control: { type: "ephemeral", ttl: "5m" },
        content: [
          { type: "text", text: "nested", cache_control: { type: "ephemeral" } },
          { type: "text", text: "unmarked" },
        ],
      }],
    }],
  };
  const before = structuredClone(payload);
  const long = applyCacheRetention(payload, "long");
  assert.deepEqual([
    long.cache_control.ttl,
    long.messages[0].content[0].cache_control.ttl,
    long.messages[0].content[0].content[0].cache_control.ttl,
  ], ["1h", "1h", "1h"]);
  assert.equal("cache_control" in long.messages[0].content[0].content[1], false);
  assert.equal(long.messages[0].content[0].tool_use_id, "tool-1");
  assert.deepEqual(payload, before);
});

test("any malformed target cache_control rejects the whole payload without mixed TTLs", () => {
  const invalidMarkers = [
    { type: "persistent" },
    { type: "ephemeral", ttl: "forever" },
    { type: "ephemeral", extra: true },
    "ephemeral",
    null,
    Object.defineProperty({}, "type", { value: "ephemeral" }),
    Object.defineProperty({}, "type", { enumerable: true, get() { throw new Error("broken type"); } }),
  ];
  for (const invalid of invalidMarkers) {
    const payload = realPiOAuthPayload();
    payload.system[0].cache_control = invalid;
    let before;
    try { before = structuredClone(payload); } catch { /* accessor fixtures are intentionally unclonable */ }
    assert.doesNotThrow(() => applyCacheRetention(payload, "long"));
    assert.equal(applyCacheRetention(payload, "long"), undefined);
    if (before) assert.deepEqual(payload, before);
  }

  const accessorOwner = realPiOAuthPayload();
  Object.defineProperty(accessorOwner.system[0], "cache_control", {
    enumerable: true,
    get() { throw new Error("broken cache_control owner"); },
  });
  assert.doesNotThrow(() => applyCacheRetention(accessorOwner, "long"));
  assert.equal(applyCacheRetention(accessorOwner, "long"), undefined);

  const payload = realPiOAuthPayload();
  payload.tools.at(-1).cache_control = { type: "ephemeral", ttl: "1h", extra: "invalid" };
  assert.equal(applyCacheRetention(payload, "short"), undefined, "one malformed marker prevents valid siblings from changing");
  assert.deepEqual(realPiMarkers(payload).slice(0, 2), [
    { type: "ephemeral" },
    { type: "ephemeral", ttl: "5m" },
  ]);
});

test("zero or more than four target markers are silent no-ops", () => {
  const zero = {
    model: "claude-exact",
    system: "plain system string",
    messages: [{ role: "user", content: "plain message content string" }],
  };
  assert.equal(applyCacheRetention(zero, "long"), undefined);
  assert.deepEqual(zero, {
    model: "claude-exact",
    system: "plain system string",
    messages: [{ role: "user", content: "plain message content string" }],
  });

  const five = realPiOAuthPayload();
  five.cache_control = { type: "ephemeral" };
  const before = structuredClone(five);
  assert.equal(applyCacheRetention(five, "long"), undefined);
  assert.deepEqual(five, before);
  assert.equal(countRealPiMarkers(five), 4, "the fifth top-level marker is not rewritten or removed");
});

test("non-target strings and message-level cache_control stay byte-for-byte unchanged", () => {
  const messageLevel = { type: "not-a-target", ttl: "forever" };
  const schemaMarker = { type: "ephemeral" };
  const payload = {
    model: "claude-exact",
    cache_control: { type: "ephemeral" },
    system: "plain system string",
    tools: [{
      name: "custom",
      input_schema: { type: "object", cache_control: schemaMarker },
    }],
    messages: [{
      role: "user",
      cache_control: messageLevel,
      content: "plain message content string",
    }],
  };
  const before = structuredClone(payload);
  const long = applyCacheRetention(payload, "long");
  assert.deepEqual(long.cache_control, { type: "ephemeral", ttl: "1h" });
  assert.equal(long.system, "plain system string");
  assert.equal(long.messages[0].content, "plain message content string");
  assert.deepEqual(long.messages[0].cache_control, messageLevel);
  assert.deepEqual(long.tools[0].input_schema.cache_control, schemaMarker);
  assert.deepEqual(payload, before);
});

test("ordinary Claude Anthropic OAuth gate requires every exact model and account condition", () => {
  const payload = realPiOAuthPayload();
  const apply = (model, usingOAuth = true, candidate = payload, retention = "long") => {
    let oauthChecks = 0;
    const result = applyCacheRetentionForRequest(candidate, model, retention, () => {
      oauthChecks += 1;
      return usingOAuth;
    });
    return { result, oauthChecks };
  };

  const eligible = apply(oauthModel());
  assert.equal(eligible.oauthChecks, 1);
  assert.deepEqual(realPiMarkers(eligible.result).map((marker) => marker.ttl), ["1h", "1h", "1h", "1h"]);
  assert.ok(apply(oauthModel({ compat: { supportsLongCacheRetention: true } })).result);
  assert.ok(apply(oauthModel({ compat: undefined })).result);

  for (const model of [
    oauthModel({ provider: "Anthropic" }),
    oauthModel({ provider: "openai" }),
    oauthModel({ provider: "openai-codex" }),
    oauthModel({ api: "openai-completions" }),
    oauthModel({ api: "anthropic-compatible" }),
    oauthModel({ id: "claude-other" }),
    oauthModel({ compat: { supportsLongCacheRetention: false } }),
    undefined,
  ]) {
    const blocked = apply(model);
    assert.equal(blocked.result, undefined);
    assert.equal(blocked.oauthChecks, 0, "OAuth lookup runs only after the exact cheap gates");
  }

  assert.equal(apply(oauthModel(), false).result, undefined, "API key and compatible endpoint auth stay unchanged");
  assert.equal(apply(oauthModel(), true, { ...payload, model: "rewritten-before-OMPS" }).result, undefined, "payload.model rewritten by an earlier hook skips Cache transformation");
  assert.equal(apply(oauthModel(), true, { model: 7, cache_control: { type: "ephemeral" } }).result, undefined);
  assert.equal(apply(oauthModel(), true, []).result, undefined);
  assert.doesNotThrow(() => applyCacheRetentionForRequest(payload, oauthModel(), "long", () => { throw new Error("OAuth registry failure"); }));
  assert.equal(applyCacheRetentionForRequest(payload, oauthModel(), "long", () => { throw new Error("OAuth registry failure"); }), undefined);
});

test("request gate supports Short while preserving payloads for every ineligible provider path", () => {
  const long = applyCacheRetention(realPiOAuthPayload(), "long");
  const before = structuredClone(long);
  const result = applyCacheRetentionForRequest(long, oauthModel(), "short", () => true);
  assert.deepEqual(realPiMarkers(result), Array.from({ length: 4 }, () => ({ type: "ephemeral" })));
  assert.deepEqual(long, before);

  for (const model of [
    { provider: "openai", api: "openai-responses", id: "claude-exact" },
    { provider: "openai-codex", api: "openai-responses", id: "claude-exact" },
    { provider: "anthropic", api: "anthropic-messages", id: "claude-exact", compat: { supportsLongCacheRetention: false } },
  ]) assert.equal(applyCacheRetentionForRequest(long, model, "short", () => true), undefined);
});

test("Cache state maker and parser enforce exact version-1 short or long data", () => {
  assert.equal(CACHE_STATE_ENTRY_TYPE, "oh-my-pi-slim:cache-state");
  assert.equal(CACHE_STATE_VERSION, 1);
  assert.deepEqual(makeCacheState("short"), { version: 1, retention: "short" });
  assert.deepEqual(makeCacheState("long"), { version: 1, retention: "long" });
  assert.deepEqual(parseCacheState({ retention: "short", version: 1 }), { version: 1, retention: "short" });
  assert.deepEqual(parseCacheState(Object.assign(Object.create(null), { version: 1, retention: "long" })), { version: 1, retention: "long" });

  const symbolExtra = { version: 1, retention: "long", [Symbol("extra")]: true };
  const hiddenExtra = Object.defineProperty({ version: 1, retention: "short" }, "extra", { value: true });
  for (const invalid of [
    undefined, null, [], {}, { version: 1 }, { retention: "long" },
    { version: 2, retention: "long" }, { version: 1, retention: "Long" },
    { version: 1, retention: "5m" }, { version: 1, retention: "long", extra: true },
    symbolExtra, hiddenExtra,
  ]) assert.equal(parseCacheState(invalid), undefined);

  const throwing = new Proxy({}, { ownKeys() { throw new Error("broken keys"); } });
  assert.doesNotThrow(() => parseCacheState(throwing));
  assert.equal(parseCacheState(throwing), undefined);
});

test("Cache session replay defaults Long and uses the last valid full-log entry", () => {
  assert.equal(replayCacheState([]), "long");
  const entries = [
    cacheEntry({ version: 1, retention: "short" }),
    { type: "message", customType: CACHE_STATE_ENTRY_TYPE, data: { version: 1, retention: "long" } },
    cacheEntry({ version: 1, retention: "long" }, { customType: "other-extension:cache-state" }),
    cacheEntry({ version: 1, retention: "long" }),
    cacheEntry({ version: 1, retention: "Short" }),
    cacheEntry({ version: 1, retention: "short", extra: true }),
  ];
  assert.equal(replayCacheState(entries), "long");
  assert.equal(replayCacheState([...entries, cacheEntry({ version: 1, retention: "short" })]), "short");
  assert.equal(replayCacheState([cacheEntry({ version: 1, retention: "invalid" })]), "long");

  const throwingEntry = new Proxy({}, { get() { throw new Error("broken entry"); } });
  assert.doesNotThrow(() => replayCacheState([cacheEntry({ version: 1, retention: "short" }), throwingEntry]));
  assert.equal(replayCacheState([cacheEntry({ version: 1, retention: "short" }), throwingEntry]), "short");
  assert.equal(replayCacheState(undefined), "long");
});
