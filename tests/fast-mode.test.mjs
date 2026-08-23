import assert from "node:assert/strict";
import test from "node:test";

const {
  FAST_ENV_VAR,
  FAST_STATE_ENTRY_TYPE,
  FAST_STATE_VERSION,
  applyFastServiceTier,
  fastEnabledFromEnv,
  fastEnvValue,
  isFastModeProvider,
  makeFastState,
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

test("Fast Mode environment encoding accepts exactly the enabled child snapshot", () => {
  assert.equal(FAST_ENV_VAR, "OMPS_FAST_MODE");
  assert.equal(fastEnvValue(true), "1");
  assert.equal(fastEnvValue(false), "0");
  assert.equal(fastEnabledFromEnv("1"), true);
  for (const value of [undefined, "", "0", "true", 1, true]) assert.equal(fastEnabledFromEnv(value), false);
});

test("provider eligibility accepts only the exact OpenAI provider names", () => {
  for (const provider of ["openai", "openai-codex"]) assert.equal(isFastModeProvider(provider), true);
  for (const provider of [undefined, null, "", "anthropic", "OpenAI", "OPENAI", "openai-Codex", 1, true]) {
    assert.equal(isFastModeProvider(provider), false);
  }
});

test("service tier injection reuses provider eligibility and requires the exact payload model without mutation", () => {
  assert.match(applyFastServiceTier.toString(), /isFastModeProvider\(model\.provider\)/);
  for (const provider of ["openai", "openai-codex"]) {
    const payload = { model: "gpt-exact", service_tier: "default", nested: { kept: true } };
    const result = applyFastServiceTier(payload, { provider, id: "gpt-exact" });
    assert.deepEqual(result, { model: "gpt-exact", service_tier: "priority", nested: payload.nested });
    assert.notEqual(result, payload);
    assert.equal(payload.service_tier, "default");
  }

  const payload = { model: "gpt-exact", service_tier: "default" };
  for (const [candidate, model] of [
    [payload, { provider: "anthropic", id: "gpt-exact" }],
    [payload, { provider: "OpenAI", id: "gpt-exact" }],
    [payload, { provider: "openai", id: "other" }],
    [{ model: 7 }, { provider: "openai", id: "7" }],
    [[], { provider: "openai", id: "gpt-exact" }],
    [null, { provider: "openai", id: "gpt-exact" }],
  ]) assert.equal(applyFastServiceTier(candidate, model), undefined);
  assert.deepEqual(payload, { model: "gpt-exact", service_tier: "default" });

  const throwing = Object.create(null, { model: { get() { throw new Error("getter failure"); } } });
  assert.doesNotThrow(() => applyFastServiceTier(throwing, { provider: "openai", id: "gpt-exact" }));
  assert.equal(applyFastServiceTier(throwing, { provider: "openai", id: "gpt-exact" }), undefined);
});

test("Fast state maker and parser enforce exact version-1 boolean data", () => {
  assert.equal(FAST_STATE_ENTRY_TYPE, "oh-my-pi-slim:fast-state");
  assert.equal(FAST_STATE_VERSION, 1);
  assert.deepEqual(makeFastState(true), { version: FAST_STATE_VERSION, fast: true });
  assert.deepEqual(makeFastState(false), { version: 1, fast: false });
  assert.deepEqual(parseFastState({ fast: true, version: 1 }), { version: 1, fast: true });
  assert.deepEqual(parseFastState(Object.assign(Object.create(null), { version: 1, fast: false })), { version: 1, fast: false });
  const symbolExtra = { version: 1, fast: true, [Symbol("extra")]: false };
  const hiddenExtra = Object.defineProperty({ version: 1, fast: true }, "extra", { value: false });

  for (const invalid of [
    undefined,
    null,
    [],
    true,
    {},
    { version: 1 },
    { fast: true },
    { version: 2, fast: true },
    { version: 1, fast: "true" },
    { version: 1, fast: true, extra: false },
    symbolExtra,
    hiddenExtra,
  ]) assert.equal(parseFastState(invalid), undefined);

  const throwing = new Proxy({}, { ownKeys() { throw new Error("broken keys"); } });
  assert.doesNotThrow(() => parseFastState(throwing));
  assert.equal(parseFastState(throwing), undefined);
});

test("session replay uses the last valid exact custom entry across the full entry log", () => {
  const entries = [
    fastEntry({ version: 1, fast: false }),
    { type: "message", customType: FAST_STATE_ENTRY_TYPE, data: { version: 1, fast: true } },
    fastEntry({ version: 1, fast: true }, { customType: "other-extension:fast-state" }),
    fastEntry({ version: 1, fast: true }),
    { type: "custom", customType: "branch-local-state", data: { branch: "other" } },
  ];
  assert.equal(replayFastState(entries), true);
  assert.equal(replayFastState([...entries, fastEntry({ version: 1, fast: false })]), false);
});

test("session replay defaults off and skips malformed latest entries without erasing valid state", () => {
  assert.equal(replayFastState([]), false);
  assert.equal(replayFastState([fastEntry({ version: 1, fast: "true" })]), false);
  assert.equal(replayFastState([
    fastEntry({ version: 1, fast: true }),
    fastEntry({ version: 1, fast: false, extra: "invalid latest" }),
    fastEntry({ version: 2, fast: false }),
    fastEntry(null),
  ]), true, "an invalid latest candidate falls back to the last valid session state");

  const throwingEntry = new Proxy({}, { get() { throw new Error("broken entry"); } });
  assert.doesNotThrow(() => replayFastState([fastEntry({ version: 1, fast: true }), throwingEntry]));
  assert.equal(replayFastState([fastEntry({ version: 1, fast: true }), throwingEntry]), true);
  assert.doesNotThrow(() => replayFastState(undefined));
  assert.equal(replayFastState(undefined), false);
});
