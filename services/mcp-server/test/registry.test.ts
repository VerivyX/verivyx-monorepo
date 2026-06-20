/**
 * TDD tests for the identity↔smart-account wallet binding registry.
 *
 * These tests use an in-memory fake querier — no live DB required.
 * The fake stores what upsertBinding encrypts and returns it on SELECT,
 * so we can verify the secret column is ciphertext (not plaintext) and
 * that getBinding decrypts it back to the original.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

// Set the enc key before importing registry (module-level env read)
process.env.MCP_WALLET_ENC_KEY = "0".repeat(64); // 32 bytes = 64 hex chars

import {
  getBinding,
  upsertBinding,
  encryptSecret,
  decryptSecret,
  type WalletBinding,
  type Querier,
} from "../src/wallet/registry.js";

// ---------------------------------------------------------------------------
// In-memory fake querier
// ---------------------------------------------------------------------------
// Mirrors the two queries registry.ts issues:
//   SELECT ... FROM "McpWallet" WHERE oauth_sub = $1
//   INSERT ... ON CONFLICT (oauth_sub) DO UPDATE ...
// The fake keeps a Map<oauthSub, rowObject>.

function makeFakeQuerier(): { querier: Querier; store: Map<string, Record<string, unknown>> } {
  const store = new Map<string, Record<string, unknown>>();
  const querier: Querier = {
    async query(sql: string, params: unknown[]) {
      if (/INSERT/i.test(sql)) {
        // upsert: (oauth_sub, smart_account, session_signer_pubkey, session_signer_secret_enc, budget_atomic, expiry_ledger)
        const [sub, smartAccount, pubkey, secretEnc, budget, expiry] = params as string[];
        store.set(sub, {
          oauth_sub: sub,
          smart_account: smartAccount,
          session_signer_pubkey: pubkey,
          session_signer_secret_enc: secretEnc,
          budget_atomic: budget,
          expiry_ledger: expiry,
        });
        return { rows: [] };
      } else if (/SELECT/i.test(sql)) {
        const [sub] = params as string[];
        const row = store.get(sub);
        return { rows: row ? [row] : [] };
      }
      return { rows: [] };
    },
  };
  return { querier, store };
}

const sample: WalletBinding = {
  oauthSub: "user:hydra:abc123",
  smartAccount: "GBDEADBEEF000000000000000000000000000000000000000000000000000",
  sessionSignerPubkey: "GCAFE000000000000000000000000000000000000000000000000000000",
  sessionSignerSecret: "SDEADBEEF_PLAINTEXT_SESSION_SECRET_GOES_HERE_FILL_PADDING_XXX",
  budgetAtomic: 5_000_000n,
  expiryLedger: 99999n,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("upsertBinding then getBinding returns the same binding", async () => {
  const { querier } = makeFakeQuerier();
  await upsertBinding(sample, querier);
  const result = await getBinding(sample.oauthSub, querier);
  assert.ok(result !== null, "expected a non-null binding");
  assert.equal(result.oauthSub, sample.oauthSub);
  assert.equal(result.smartAccount, sample.smartAccount);
  assert.equal(result.sessionSignerPubkey, sample.sessionSignerPubkey);
  assert.equal(result.sessionSignerSecret, sample.sessionSignerSecret, "decrypted secret must match original plaintext");
  assert.equal(result.budgetAtomic, sample.budgetAtomic);
  assert.equal(result.expiryLedger, sample.expiryLedger);
});

test("stored secret column is NOT the plaintext", async () => {
  const { querier, store } = makeFakeQuerier();
  await upsertBinding(sample, querier);
  const row = store.get(sample.oauthSub);
  assert.ok(row, "row must exist after upsert");
  const stored = row.session_signer_secret_enc as string;
  assert.notEqual(stored, sample.sessionSignerSecret, "column must be ciphertext, not plaintext");
});

test("getBinding returns null for unknown sub", async () => {
  const { querier } = makeFakeQuerier();
  const result = await getBinding("does-not-exist", querier);
  assert.equal(result, null);
});

test("encrypt→decrypt round-trip returns original plaintext", () => {
  const plaintext = "my-secret-session-key";
  const enc = encryptSecret(plaintext);
  const dec = decryptSecret(enc);
  assert.equal(dec, plaintext);
});

test("two encryptions of the same plaintext produce different ciphertexts (random iv)", () => {
  const plaintext = "my-secret-session-key";
  const enc1 = encryptSecret(plaintext);
  const enc2 = encryptSecret(plaintext);
  assert.notEqual(enc1, enc2, "ciphertexts must differ due to random iv");
});

test("getBinding throws when MCP_WALLET_ENC_KEY is unset", async () => {
  const savedKey = process.env.MCP_WALLET_ENC_KEY;
  delete process.env.MCP_WALLET_ENC_KEY;

  // Import the module in a fresh sub-scope by calling the exported functions
  // directly — the key check happens at call time, not module load, so we
  // temporarily unset it and restore after.
  try {
    await assert.rejects(
      () => getBinding("any-sub"),
      /MCP_WALLET_ENC_KEY/i,
    );
  } finally {
    if (savedKey !== undefined) process.env.MCP_WALLET_ENC_KEY = savedKey;
  }
});
