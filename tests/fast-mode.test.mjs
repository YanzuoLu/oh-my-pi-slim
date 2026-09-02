import assert from "node:assert/strict";
import test from "node:test";

const FAST_MODE_URL = new URL("../extensions/oh-my-pi-slim/fast-mode.ts", import.meta.url);
const {
  FAST_STATE_ENTRY_TYPE,
  applyFastServiceTier,
  fastEnabledFromEnv,
  fastEnvValue,
  makeFastState,
  parseFastState,
  replayFastState,
} = await import(FAST_MODE_URL.href);

test("Fast Mode injects priority only for the matching OpenAI request", () => {
  for (const provider of ["openai", "openai-codex"]) {
    const payload = { model: "gpt-test", service_tier: "default" };
    assert.deepEqual(applyFastServiceTier(payload, { provider, id: "gpt-test" }), {
      model: "gpt-test",
      service_tier: "priority",
    });
    assert.equal(payload.service_tier, "default");
  }
  assert.equal(applyFastServiceTier({ model: "gpt-test" }, { provider: "anthropic", id: "gpt-test" }), undefined);
  assert.equal(applyFastServiceTier({ model: "other" }, { provider: "openai", id: "gpt-test" }), undefined);
});

test("Fast Mode stores and replays one boolean session switch", () => {
  assert.deepEqual(makeFastState(true), { version: 1, fast: true });
  assert.deepEqual(parseFastState({ version: 1, fast: false }), { version: 1, fast: false });
  assert.equal(parseFastState({ version: 1, fast: true, tier: "priority" }), undefined);
  assert.equal(replayFastState([
    { type: "custom", customType: FAST_STATE_ENTRY_TYPE, data: makeFastState(true) },
    { type: "custom", customType: FAST_STATE_ENTRY_TYPE, data: makeFastState(false) },
  ]), false);
});

test("Fast Mode child snapshots use only 1 and 0", () => {
  assert.equal(fastEnvValue(true), "1");
  assert.equal(fastEnvValue(false), "0");
  assert.equal(fastEnabledFromEnv("1"), true);
  for (const value of ["0", "true", true, undefined]) assert.equal(fastEnabledFromEnv(value), false);
});
