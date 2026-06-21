/**
 * TDD tests for wallet/errorMap.ts — delegation/settlement error code mapper.
 *
 * Tests pure string-matching heuristics that map raw Soroban/RPC error messages and
 * simulation diagnostics to stable agent-friendly codes:
 *   delegation_budget_exhausted | delegation_expired | insufficient_balance | settlement_failed
 *
 * All tests are synchronous and dependency-free (no Stellar SDK, no network).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { mapSettlementError } from "../src/wallet/errorMap.js";

// ---------------------------------------------------------------------------
// Test 1: SEP-41 balance shortfall → insufficient_balance
// (must be checked BEFORE #3002 cases)
// ---------------------------------------------------------------------------

test("mapSettlementError: SAC balance error → insufficient_balance", () => {
  // Realistic SAC balance error string from Soroban
  const code = mapSettlementError({
    message: 'HostError: Value(BalanceError) host function invocation contract call failed: Error(Contract, #10)',
  });
  assert.equal(code, "insufficient_balance");
});

test("mapSettlementError: message contains 'insufficient' → insufficient_balance", () => {
  const code = mapSettlementError({
    message: "transaction simulation failed: insufficient balance to perform transfer",
  });
  assert.equal(code, "insufficient_balance");
});

test("mapSettlementError: message contains 'balance' → insufficient_balance", () => {
  const code = mapSettlementError({
    message: "Error: balance check failed for account",
  });
  assert.equal(code, "insufficient_balance");
});

test("mapSettlementError: message contains 'allowance' → insufficient_balance", () => {
  const code = mapSettlementError({
    message: "allowance exceeded for token transfer",
  });
  assert.equal(code, "insufficient_balance");
});

// ---------------------------------------------------------------------------
// Test 2: #3002 + policy diagnostic → delegation_budget_exhausted
// ---------------------------------------------------------------------------

test("mapSettlementError: #3002 + spending_limit diagnostic string → delegation_budget_exhausted", () => {
  const code = mapSettlementError({
    message: "simulate error (CUSDC.transfer): Error(Auth, InvalidAction) #3002",
    diagnostics: ["fn_call contract can_enforce spending_limit policy returned false"],
  });
  assert.equal(code, "delegation_budget_exhausted");
});

test("mapSettlementError: #3002 + can_enforce in diagnostics array → delegation_budget_exhausted", () => {
  const code = mapSettlementError({
    message: "Error(Auth, InvalidAction) with inner #3002",
    diagnostics: ["can_enforce returned false", "UnvalidatedContext"],
  });
  assert.equal(code, "delegation_budget_exhausted");
});

test("mapSettlementError: #3002 + SpendingLimit in diagnostics string → delegation_budget_exhausted", () => {
  const code = mapSettlementError({
    message: "#3002 UnvalidatedContext",
    diagnostics: "SpendingLimit policy can_enforce false",
  });
  assert.equal(code, "delegation_budget_exhausted");
});

test("mapSettlementError: InvalidAction + spending_limit in combined haystack → delegation_budget_exhausted", () => {
  // diagnostics contains spending_limit; message has InvalidAction
  const code = mapSettlementError({
    message: "Error(Auth, InvalidAction)",
    diagnostics: ["spending_limit period exceeded"],
  });
  assert.equal(code, "delegation_budget_exhausted");
});

// ---------------------------------------------------------------------------
// Test 3: #3002 / InvalidAction / UnvalidatedContext WITHOUT policy → delegation_expired
// ---------------------------------------------------------------------------

test("mapSettlementError: #3002 with no policy diagnostic → delegation_expired", () => {
  const code = mapSettlementError({
    message: "simulate error: Error(Auth, InvalidAction) Error(Contract, #3002) UnvalidatedContext",
    diagnostics: [],
  });
  assert.equal(code, "delegation_expired");
});

test("mapSettlementError: #3002 with undefined diagnostics → delegation_expired", () => {
  const code = mapSettlementError({
    message: "Error(Auth, InvalidAction) #3002",
  });
  assert.equal(code, "delegation_expired");
});

test("mapSettlementError: UnvalidatedContext alone (no #3002 explicitly, no policy) → delegation_expired", () => {
  const code = mapSettlementError({
    message: "Error(Auth, InvalidAction) UnvalidatedContext rule skipped",
    diagnostics: ["some unrelated event"],
  });
  assert.equal(code, "delegation_expired");
});

test("mapSettlementError: InvalidAction alone (no policy diagnostic) → delegation_expired", () => {
  const code = mapSettlementError({
    message: "Error(Auth, InvalidAction) context rule did not match",
  });
  assert.equal(code, "delegation_expired");
});

// ---------------------------------------------------------------------------
// Test 4: Random / unknown error → settlement_failed
// ---------------------------------------------------------------------------

test("mapSettlementError: random RPC error → settlement_failed", () => {
  const code = mapSettlementError({
    message: "network timeout while connecting to soroban-testnet.stellar.org",
  });
  assert.equal(code, "settlement_failed");
});

test("mapSettlementError: empty message → settlement_failed", () => {
  const code = mapSettlementError({ message: "" });
  assert.equal(code, "settlement_failed");
});

test("mapSettlementError: generic contract error without auth keyword → settlement_failed", () => {
  const code = mapSettlementError({
    message: "Error(Contract, #1) some contract panic",
    diagnostics: [],
  });
  assert.equal(code, "settlement_failed");
});

test("mapSettlementError: no message field → settlement_failed", () => {
  const code = mapSettlementError({});
  assert.equal(code, "settlement_failed");
});

// ---------------------------------------------------------------------------
// Test 5: Precedence — "balance" + "#3002" in same message → insufficient_balance wins
// (balance is checked BEFORE delegation cases)
// ---------------------------------------------------------------------------

test("mapSettlementError: both 'balance' and '#3002' present → insufficient_balance wins (checked first)", () => {
  // A contrived message that contains both: balance check must win per documented precedence.
  const code = mapSettlementError({
    message: "balance check failed Error(Auth, InvalidAction) #3002",
    diagnostics: [],
  });
  assert.equal(code, "insufficient_balance",
    "insufficient_balance must be checked before #3002 delegation cases");
});

test("mapSettlementError: BalanceError + #3002 + can_enforce diagnostic → insufficient_balance wins", () => {
  // Even with a policy diagnostic present, a balance error in the message wins.
  const code = mapSettlementError({
    message: "BalanceError #3002 simulation failed",
    diagnostics: ["can_enforce false"],
  });
  assert.equal(code, "insufficient_balance",
    "balance shortfall takes precedence over delegation budget check");
});
