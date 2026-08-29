import assert from "node:assert/strict";
import test from "node:test";

const {
  FAST_ENV_VAR,
  FAST_STATE_ENTRY_TYPE,
  FAST_STATE_VERSION,
  ULTRAFAST_MODEL_ID,
  applyFastServiceTier,
  fastEnvValue,
  fastTierFromEnv,
  isFastModeProvider,
  makeFastState,
  nextFastTier,
  parseFastState,
  replayFastState,
} = await import("../extensions/oh-my-pi-slim/fast-mode.ts");

function fastEntry(data, overrides = {}) {
  return {
    type: "custom",
    customType: FAST_STATE_ENTRY_TYPE,
    data,
    ...overrides,
  };
}

test("Fast tiers cycle exactly and invalid next input closes to fast", () => {
  assert.equal(nextFastTier("off"), "fast");
  assert.equal(nextFastTier("fast"), "ultrafast");
  assert.equal(nextFastTier("ultrafast"), "off");
  for (const invalid of [undefined, null, "", "on", "priority", 1, true, {}]) {
    assert.equal(nextFastTier(invalid), "fast");
  }
});

test("Fast Mode environment encoding writes three tiers and decoding preserves old parent compatibility", () => {
  assert.equal(FAST_ENV_VAR, "OMPS_FAST_MODE");
  for (const tier of ["off", "fast", "ultrafast"]) {
    assert.equal(fastEnvValue(tier), tier);
    assert.equal(fastTierFromEnv(tier), tier);
  }
  assert.equal(fastTierFromEnv("0"), "off");
  assert.equal(fastTierFromEnv("1"), "fast");
  for (const value of [undefined, "", "true", "on", "2", 0, 1, true]) {
    assert.equal(fastTierFromEnv(value), undefined);
    assert.equal(fastEnvValue(value), "off", "invalid encoder input fails closed without writing a legacy value");
  }
});

test("provider eligibility accepts only the exact OpenAI provider names", () => {
  for (const provider of ["openai", "openai-codex"]) assert.equal(isFastModeProvider(provider), true);
  for (const provider of [undefined, null, "", "anthropic", "OpenAI", "OPENAI", "openai-Codex", 1, true]) {
    assert.equal(isFastModeProvider(provider), false);
  }
});

test("service tier matrix is immutable and ultrafast uses the maximum supported OpenAI tier", () => {
  assert.equal(ULTRAFAST_MODEL_ID, "gpt-5.6-sol");
  assert.match(applyFastServiceTier.toString(), /isFastModeProvider\(model\.provider\)/);
  for (const provider of ["openai", "openai-codex"]) {
    for (const [tier, id, expected] of [
      ["off", "gpt-other", undefined],
      ["fast", "gpt-other", "priority"],
      ["ultrafast", "gpt-other", "priority"],
      ["fast", ULTRAFAST_MODEL_ID, "priority"],
      ["ultrafast", ULTRAFAST_MODEL_ID, "ultrafast"],
    ]) {
      const payload = { model: id, service_tier: "default", nested: { kept: true } };
      const result = applyFastServiceTier(payload, { provider, id }, tier);
      if (expected === undefined) assert.equal(result, undefined);
      else {
        assert.deepEqual(result, { model: id, service_tier: expected, nested: payload.nested });
        assert.notEqual(result, payload);
      }
      assert.equal(payload.service_tier, "default");
    }
  }

  const payload = { model: ULTRAFAST_MODEL_ID, service_tier: "default" };
  for (const [candidate, model, tier] of [
    [payload, { provider: "anthropic", id: ULTRAFAST_MODEL_ID }, "ultrafast"],
    [payload, { provider: "OpenAI", id: ULTRAFAST_MODEL_ID }, "ultrafast"],
    [payload, { provider: "openai", id: "other" }, "ultrafast"],
    [{ model: 7 }, { provider: "openai", id: "7" }, "fast"],
    [[], { provider: "openai", id: ULTRAFAST_MODEL_ID }, "fast"],
    [null, { provider: "openai", id: ULTRAFAST_MODEL_ID }, "fast"],
    [payload, { provider: "openai", id: ULTRAFAST_MODEL_ID }, "priority"],
  ]) assert.equal(applyFastServiceTier(candidate, model, tier), undefined);
  assert.deepEqual(payload, { model: ULTRAFAST_MODEL_ID, service_tier: "default" });

  const throwing = Object.create(null, { model: { get() { throw new Error("getter failure"); } } });
  assert.doesNotThrow(() => applyFastServiceTier(throwing, { provider: "openai", id: ULTRAFAST_MODEL_ID }, "ultrafast"));
  assert.equal(applyFastServiceTier(throwing, { provider: "openai", id: ULTRAFAST_MODEL_ID }, "ultrafast"), undefined);
});

test("Fast state writer emits exact version-2 tier data and parser strictly migrates version 1", () => {
  assert.equal(FAST_STATE_ENTRY_TYPE, "oh-my-pi-slim:fast-state");
  assert.equal(FAST_STATE_VERSION, 2);
  for (const tier of ["off", "fast", "ultrafast"]) {
    assert.deepEqual(makeFastState(tier), { version: 2, tier });
    assert.deepEqual(parseFastState({ tier, version: 2 }), { version: 2, tier });
  }
  assert.deepEqual(parseFastState({ version: 1, fast: true }), { version: 2, tier: "fast" });
  assert.deepEqual(parseFastState(Object.assign(Object.create(null), { version: 1, fast: false })), { version: 2, tier: "off" });

  const symbolExtra = { version: 2, tier: "fast", [Symbol("extra")]: false };
  const hiddenExtra = Object.defineProperty({ version: 1, fast: true }, "extra", { value: false });
  for (const invalid of [
    undefined, null, [], true, {}, { version: 2 }, { tier: "fast" },
    { version: 2, tier: "priority" }, { version: 2, tier: "fast", extra: false },
    { version: 1 }, { version: 1, tier: "fast" }, { version: 1, fast: "true" },
    { version: 1, fast: true, extra: false }, { version: 3, tier: "fast" }, symbolExtra, hiddenExtra,
  ]) assert.equal(parseFastState(invalid), undefined);

  const throwing = new Proxy({}, { ownKeys() { throw new Error("broken keys"); } });
  assert.doesNotThrow(() => parseFastState(throwing));
  assert.equal(parseFastState(throwing), undefined);
});

test("Fast state parser snapshots unstable version, tier, and fast getters exactly once", () => {
  let versionReads = 0;
  const unstableVersion = {
    get version() { versionReads += 1; return versionReads === 1 ? 2 : 1; },
    tier: "ultrafast",
  };
  assert.deepEqual(parseFastState(unstableVersion), { version: 2, tier: "ultrafast" });
  assert.equal(versionReads, 1);

  let tierReads = 0;
  const unstableTier = {
    version: 2,
    get tier() { tierReads += 1; return tierReads === 1 ? "fast" : "invalid"; },
  };
  assert.deepEqual(parseFastState(unstableTier), { version: 2, tier: "fast" });
  assert.equal(tierReads, 1);

  let fastReads = 0;
  const unstableFast = {
    version: 1,
    get fast() { fastReads += 1; return fastReads === 1; },
  };
  assert.deepEqual(parseFastState(unstableFast), { version: 2, tier: "fast" });
  assert.equal(fastReads, 1);
});

test("session replay traverses mixed v1 and v2 once in time order with last-valid-wins", () => {
  const v1ThenV2 = [fastEntry({ version: 1, fast: false }), fastEntry({ version: 2, tier: "ultrafast" })];
  const v2ThenV1 = [fastEntry({ version: 2, tier: "ultrafast" }), fastEntry({ version: 1, fast: true })];
  assert.equal(replayFastState(v1ThenV2), "ultrafast");
  assert.equal(replayFastState(v2ThenV1), "fast");
  assert.equal(v1ThenV2.length, 2, "replay does not append a migration entry");

  const entries = [
    fastEntry({ version: 1, fast: false }),
    { type: "message", customType: FAST_STATE_ENTRY_TYPE, data: { version: 2, tier: "ultrafast" } },
    fastEntry({ version: 2, tier: "fast" }, { customType: "other-extension:fast-state" }),
    fastEntry({ version: 2, tier: "off" }),
    fastEntry({ version: 2, tier: "ultrafast", extra: true }),
  ];
  assert.equal(replayFastState(entries), "off");
});

test("session replay defaults off and skips malformed latest entries without erasing valid state", () => {
  assert.equal(replayFastState([]), "off");
  assert.equal(replayFastState([fastEntry({ version: 2, tier: "priority" })]), "off");
  assert.equal(replayFastState([
    fastEntry({ version: 1, fast: false }),
    fastEntry({ version: 2, tier: "ultrafast" }),
    fastEntry({ version: 2, tier: "off", extra: "invalid latest" }),
    fastEntry(null),
  ]), "ultrafast", "an invalid latest candidate falls back to the last valid session state");

  const throwingEntry = new Proxy({}, { get() { throw new Error("broken entry"); } });
  assert.doesNotThrow(() => replayFastState([fastEntry({ version: 2, tier: "off" }), throwingEntry]));
  assert.equal(replayFastState([fastEntry({ version: 2, tier: "off" }), throwingEntry]), "off");
  assert.doesNotThrow(() => replayFastState(undefined));
  assert.equal(replayFastState(undefined), "off");
});
