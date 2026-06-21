/**
 * Unit tests for the pure routing decision helper `chooseStellarPaymentMode`.
 *
 * This factors the per-request payment-service selection in index.ts into a pure
 * function so all four branches are covered without HTTP request mocking:
 *   - oauth + binding         -> "noncustodial"
 *   - oauth + no binding      -> "no_wallet_linked"
 *   - key   + sessionSecret   -> "session_override"  (playground, MUST be preserved)
 *   - key   + no sessionSecret-> "custodial"         (live custodial MCP wallet)
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { chooseStellarPaymentMode } from "../src/chains/routing.js";

const OAUTH_USER = { kind: "oauth" as const, sub: "user-123" };
const KEY_USER = { kind: "key" as const, label: "playground" };

test("oauth caller WITH a wallet binding -> noncustodial", () => {
  assert.equal(chooseStellarPaymentMode(OAUTH_USER, true, false), "noncustodial");
  // A session-secret header from an oauth caller must NOT divert to the playground path.
  assert.equal(chooseStellarPaymentMode(OAUTH_USER, true, true), "noncustodial");
});

test("oauth caller WITHOUT a wallet binding -> no_wallet_linked", () => {
  assert.equal(chooseStellarPaymentMode(OAUTH_USER, false, false), "no_wallet_linked");
  // Even with a stray session-secret header, an unlinked oauth caller never pays
  // from the MCP custodial wallet.
  assert.equal(chooseStellarPaymentMode(OAUTH_USER, false, true), "no_wallet_linked");
});

test("static-key caller WITH x-session-stellar-secret -> session_override (playground)", () => {
  assert.equal(chooseStellarPaymentMode(KEY_USER, false, true), "session_override");
});

test("static-key caller WITHOUT session secret -> custodial (live MCP wallet)", () => {
  assert.equal(chooseStellarPaymentMode(KEY_USER, false, false), "custodial");
});

test("undefined caller falls back to the legacy static-key behavior", () => {
  // No mcpUser (defensive): treat like a static-key caller — playground override
  // when the header is present, else custodial. Never non-custodial.
  assert.equal(chooseStellarPaymentMode(undefined, false, true), "session_override");
  assert.equal(chooseStellarPaymentMode(undefined, false, false), "custodial");
});
