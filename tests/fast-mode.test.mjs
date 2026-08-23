import assert from "node:assert/strict";
import {
  chmodSync,
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const {
  FAST_ENV_VAR,
  applyFastServiceTier,
  fastEnabledFromEnv,
  fastEnvValue,
  readFastFlag,
  writeFastFlag,
} = await import("../extensions/oh-my-pi-slim/fast-mode.ts");

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CACHE = join(ROOT, ".cache");
mkdirSync(CACHE, { recursive: true });

function withTempDir(run) {
  const directory = mkdtempSync(join(CACHE, "fast-mode-"));
  try { return run(directory); }
  finally { rmSync(directory, { recursive: true, force: true }); }
}

function writeIo(overrides = {}) {
  return {
    randomId: () => "fixed-random",
    open: openSync,
    write: writeFileSync,
    close: closeSync,
    chmod: chmodSync,
    rename: renameSync,
    unlink: unlinkSync,
    ...overrides,
  };
}

test("Fast Mode environment encoding accepts exactly the enabled snapshot", () => {
  assert.equal(FAST_ENV_VAR, "OMPS_FAST_MODE");
  assert.equal(fastEnvValue(true), "1");
  assert.equal(fastEnvValue(false), "0");
  assert.equal(fastEnabledFromEnv("1"), true);
  for (const value of [undefined, "", "0", "true", 1, true]) assert.equal(fastEnabledFromEnv(value), false);
});

test("service tier injection requires exact provider and payload model without mutation", () => {
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

test("flag IO fails closed and preserves unknown config fields with mode 0600", () => withTempDir((directory) => {
  const path = join(directory, "oh-my-pi-slim.json");
  assert.deepEqual(readFastFlag(path).ok, false);
  writeFileSync(path, "not json");
  assert.equal(readFastFlag(path).ok, false);
  writeFileSync(path, "[]\n");
  assert.equal(readFastFlag(path).ok, false);

  const raw = {
    fast: "not-a-boolean",
    defaultPreset: "balanced",
    presets: { balanced: { future: true } },
    deny: { fixer: ["future_tool"] },
    unknownTopLevel: { retained: true },
  };
  writeFileSync(path, `${JSON.stringify(raw)}\n`);
  const read = readFastFlag(path);
  assert.equal(read.ok, true);
  assert.equal(read.fast, false, "only literal true enables Fast Mode");
  writeFastFlag(path, read.raw, true, writeIo());
  const updated = JSON.parse(readFileSync(path, "utf8"));
  assert.deepEqual(updated, { ...raw, fast: true });
  assert.equal(readFileSync(path, "utf8").endsWith("\n"), true);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(directory), ["oh-my-pi-slim.json"]);
}));

test("writer rejects a non-object presets field before creating a temp file", () => withTempDir((directory) => {
  const path = join(directory, "oh-my-pi-slim.json");
  writeFileSync(path, "original\n");
  for (const presets of [undefined, null, [], "invalid"]) {
    assert.throws(() => writeFastFlag(path, { presets }, true, writeIo()), /\.presets must be an object/);
    assert.equal(readFileSync(path, "utf8"), "original\n");
    assert.deepEqual(readdirSync(directory), ["oh-my-pi-slim.json"]);
  }
}));

test("writer closes and removes its temp file when writing fails", () => withTempDir((directory) => {
  const path = join(directory, "oh-my-pi-slim.json");
  writeFileSync(path, "original\n");
  let descriptor;
  let closed = false;
  let removed;
  const io = writeIo({
    open(temp, flags, mode) {
      descriptor = openSync(temp, flags, mode);
      return descriptor;
    },
    write() { throw new Error("injected write failure"); },
    close(fd) {
      closed = true;
      closeSync(fd);
    },
    unlink(temp) {
      removed = temp;
      unlinkSync(temp);
    },
  });
  assert.throws(
    () => writeFastFlag(path, { presets: {}, unknown: true }, true, io),
    /injected write failure/,
  );
  assert.equal(closed, true);
  assert.match(removed, /\.oh-my-pi-slim\.json\.fast-.*fixed-random\.tmp$/);
  assert.equal(readFileSync(path, "utf8"), "original\n");
  assert.deepEqual(readdirSync(directory), ["oh-my-pi-slim.json"]);
}));
