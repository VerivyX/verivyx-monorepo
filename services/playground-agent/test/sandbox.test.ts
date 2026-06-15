// config.ts reads several env vars at import time, so set them before importing
// the module under test.
import assert from "node:assert/strict";
import { test, before } from "node:test";

process.env.OPENROUTER_API_KEY = "test-openrouter-key";
process.env.PLAYGROUND_FAUCET_SECRET = "test-faucet-secret";
process.env.ALLOWED_PAYMENT_PREFIXES =
  "http://playground-agent:8087/api/v1/playground/demo,https://playground.verivyx.com/api/v1/playground/demo";

let assertAllowedUrl: (url: string) => void;

before(async () => {
  ({ assertAllowedUrl } = await import("../src/sandbox.js"));
});

test("allows the configured demo prefixes", () => {
  assert.doesNotThrow(() =>
    assertAllowedUrl("http://playground-agent:8087/api/v1/playground/demo/pg-abc"),
  );
  assert.doesNotThrow(() =>
    assertAllowedUrl("https://playground.verivyx.com/api/v1/playground/demo/article"),
  );
});

test("refuses any URL outside the allowlist (prompt-injection guard)", () => {
  assert.throws(() => assertAllowedUrl("https://evil.example.com/pay"), /Sandbox/);
  assert.throws(() => assertAllowedUrl("https://x402.org/protected"), /Sandbox/);
  // a prefix-collision attempt that is not actually under the allowed path host
  assert.throws(() => assertAllowedUrl("http://playground-agent:8087/api/v1/admin"), /Sandbox/);
});

test("refuses malformed URLs", () => {
  assert.throws(() => assertAllowedUrl("not-a-url"), /Sandbox/);
  assert.throws(() => assertAllowedUrl(""), /Sandbox/);
});
