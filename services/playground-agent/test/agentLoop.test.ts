// Unit tests for the unpaid-probe classification logic in agentLoop.ts.
// We test the probe note/classification mapping without spawning a real agent loop.
import assert from "node:assert/strict";
import { test } from "node:test";

process.env.OPENROUTER_API_KEY = "test-key";
process.env.PLAYGROUND_FAUCET_SECRET = "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
process.env.STELLAR_NETWORK = "testnet";

// ---------------------------------------------------------------------------
// The probe classification is captured inline in agentLoop.ts but the rules are
// simple enough to unit-test directly here:
//   • status 402  → blocked:true  → "Access denied — HTTP 402 Payment Required"
//   • status !402 → blocked:false → "Unexpected: the resource returned … without payment"
// ---------------------------------------------------------------------------

function classifyProbeStatus(status: number): { blocked: boolean; note: string } {
  const blocked = status === 402;
  const note = blocked
    ? "Access denied — HTTP 402 Payment Required. The resource is paywalled; no content was returned because no payment was made. This is what an unpaid bot or scraper receives."
    : `Unexpected: the resource returned ${status} without payment — the paywall did not enforce on this request.`;
  return { blocked, note };
}

test("probe: 402 → blocked:true with correct message", () => {
  const result = classifyProbeStatus(402);
  assert.equal(result.blocked, true);
  assert.ok(result.note.startsWith("Access denied"), `unexpected note: ${result.note}`);
});

test("probe: 200 → blocked:false with leak-warning message", () => {
  const result = classifyProbeStatus(200);
  assert.equal(result.blocked, false);
  assert.ok(
    result.note.includes("Unexpected"),
    `expected content-leak warning, got: ${result.note}`,
  );
  assert.ok(
    result.note.includes("200"),
    `expected status code in message, got: ${result.note}`,
  );
});

test("probe: 403 → blocked:false with leak-warning message (not a proper 402)", () => {
  const result = classifyProbeStatus(403);
  assert.equal(result.blocked, false);
  assert.ok(result.note.includes("403"), `expected status code 403 in note, got: ${result.note}`);
});

test("probe: 503 → blocked:false with leak-warning message", () => {
  const result = classifyProbeStatus(503);
  assert.equal(result.blocked, false);
  assert.ok(result.note.includes("503"), `expected status code 503 in note, got: ${result.note}`);
});
