// config.ts reads several env vars at import time, so set them before importing
// the module under test.
import assert from "node:assert/strict";
import { test, before } from "node:test";

process.env.OPENROUTER_API_KEY = "test-openrouter-key";
process.env.PLAYGROUND_FAUCET_SECRET = "test-faucet-secret";
process.env.ALLOWED_PAYMENT_PREFIXES =
  "https://demo-sdk-next.verivyx.com/,https://web-test.verivyx.com/";

let assertAllowedUrl: (url: string) => void;

before(async () => {
  ({ assertAllowedUrl } = await import("../src/sandbox.js"));
});

test("allows the configured SDK demo prefixes", () => {
  assert.doesNotThrow(() =>
    assertAllowedUrl("https://demo-sdk-next.verivyx.com/seven-wonders"),
  );
  assert.doesNotThrow(() =>
    assertAllowedUrl("https://demo-sdk-next.verivyx.com/another-article"),
  );
});

test("allows real web-test.verivyx.com posts and pages", () => {
  assert.doesNotThrow(() =>
    assertAllowedUrl("https://web-test.verivyx.com/2026/05/31/hello-world/"),
  );
  assert.doesNotThrow(() => assertAllowedUrl("https://web-test.verivyx.com/sample-page/"));
});

test("refuses any URL outside the allowlist (prompt-injection guard)", () => {
  assert.throws(() => assertAllowedUrl("https://evil.example.com/pay"), /Sandbox/);
  assert.throws(() => assertAllowedUrl("https://x402.org/protected"), /Sandbox/);
  // a prefix-collision attempt that is not actually under the allowed path host
  assert.throws(() => assertAllowedUrl("http://playground-agent:8087/api/v1/admin"), /Sandbox/);
  // a look-alike host must not satisfy the web-test prefix
  assert.throws(() => assertAllowedUrl("https://web-test.verivyx.com.evil.com/x"), /Sandbox/);
});

test("refuses malformed URLs", () => {
  assert.throws(() => assertAllowedUrl("not-a-url"), /Sandbox/);
  assert.throws(() => assertAllowedUrl(""), /Sandbox/);
});
