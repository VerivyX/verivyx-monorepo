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
//   SELECT "oauthSub", ... FROM "McpWallet" WHERE "oauthSub" = $1
//   INSERT INTO "McpWallet" ("oauthSub", ...) ON CONFLICT ("oauthSub") DO UPDATE ...
// pg preserves the case of quoted identifiers and returns row keys with exactly
// the case written in the query — so row keys are camelCase (oauthSub, etc.).

function makeFakeQuerier(): { querier: Querier; store: Map<string, Record<string, unknown>>; sqls: string[] } {
  const store = new Map<string, Record<string, unknown>>();
  const sqls: string[] = [];
  const querier: Querier = {
    async query(sql: string, params: unknown[]) {
      sqls.push(sql);
      if (/INSERT/i.test(sql)) {
        // upsert: ("oauthSub", "smartAccount", "sessionSignerPubkey", "sessionSignerSecretEnc", "budgetAtomic", "expiryLedger")
        const [sub, smartAccount, pubkey, secretEnc, budget, expiry] = params as string[];
        store.set(sub, {
          oauthSub: sub,
          smartAccount,
          sessionSignerPubkey: pubkey,
          sessionSignerSecretEnc: secretEnc,
          budgetAtomic: budget,
          expiryLedger: expiry,
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
  return { querier, store, sqls };
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

test("getBinding parses pg Decimal-format budgetAtomic (scale-30 string) to bigint", async () => {
  // REGRESSION: pg returns a Prisma `Decimal` column as a scale-30 string, e.g.
  // "5000000.000000000000000000000000000000". `BigInt(...)` throws on the fraction
  // ("Cannot convert ... to a BigInt"). The fake querier in other tests stores the
  // raw integer string, so it never reproduced this — here we return the real format.
  const encSecret = encryptSecret(sample.sessionSignerSecret);
  const querier: Querier = {
    async query(sql: string) {
      if (/SELECT/i.test(sql)) {
        return {
          rows: [
            {
              oauthSub: sample.oauthSub,
              smartAccount: sample.smartAccount,
              sessionSignerPubkey: sample.sessionSignerPubkey,
              sessionSignerSecretEnc: encSecret,
              budgetAtomic: "5000000.000000000000000000000000000000",
              expiryLedger: "99999",
            },
          ],
        };
      }
      return { rows: [] };
    },
  };
  const result = await getBinding(sample.oauthSub, querier);
  assert.ok(result !== null, "expected a non-null binding");
  assert.equal(result.budgetAtomic, 5_000_000n, "Decimal-format budgetAtomic must parse to bigint");
  assert.equal(result.expiryLedger, 99999n);
});

test("stored secret column is NOT the plaintext", async () => {
  const { querier, store } = makeFakeQuerier();
  await upsertBinding(sample, querier);
  const row = store.get(sample.oauthSub);
  assert.ok(row, "row must exist after upsert");
  const stored = row.sessionSignerSecretEnc as string;
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

// ---------------------------------------------------------------------------
// SQL guard: column names must match the "McpWallet" migration exactly
// ---------------------------------------------------------------------------
// These tests assert that the SQL strings issued by upsertBinding and
// getBinding reference the quoted camelCase identifiers from migration
// 0006_mcp_wallets/migration.sql. The fake querier captures every SQL string
// so we can verify without a live DB. This prevents recurrence of the
// snake_case vs camelCase mismatch that caused "column does not exist" at
// runtime (Postgres folds unquoted identifiers to lowercase; the migration
// used quoted identifiers so the live table has camelCase columns).

test("upsert SQL references quoted camelCase column names from McpWallet migration", async () => {
  const { querier, sqls } = makeFakeQuerier();
  await upsertBinding(sample, querier);

  const insertSql = sqls.find(s => /INSERT/i.test(s));
  assert.ok(insertSql, "upsertBinding must issue an INSERT statement");

  // Required camelCase quoted column names
  const requiredColumns = [
    '"oauthSub"',
    '"smartAccount"',
    '"sessionSignerPubkey"',
    '"sessionSignerSecretEnc"',
    '"budgetAtomic"',
    '"expiryLedger"',
  ];
  for (const col of requiredColumns) {
    assert.ok(
      insertSql.includes(col),
      `INSERT SQL must contain ${col} — got:\n${insertSql}`,
    );
  }

  // Must NOT contain unquoted snake_case names that Postgres folds to lowercase
  const forbiddenSnakeCase = [
    "oauth_sub",
    "smart_account",
    "session_signer_pubkey",
    "session_signer_secret_enc",
    "budget_atomic",
    "expiry_ledger",
  ];
  for (const bad of forbiddenSnakeCase) {
    assert.ok(
      !insertSql.includes(bad),
      `INSERT SQL must NOT contain snake_case identifier "${bad}" — got:\n${insertSql}`,
    );
  }
});

test("select SQL references quoted camelCase column names from McpWallet migration", async () => {
  const { querier, sqls } = makeFakeQuerier();
  await getBinding("nonexistent-sub", querier);

  const selectSql = sqls.find(s => /SELECT/i.test(s));
  assert.ok(selectSql, "getBinding must issue a SELECT statement");

  const requiredColumns = [
    '"oauthSub"',
    '"smartAccount"',
    '"sessionSignerPubkey"',
    '"sessionSignerSecretEnc"',
    '"budgetAtomic"',
    '"expiryLedger"',
  ];
  for (const col of requiredColumns) {
    assert.ok(
      selectSql.includes(col),
      `SELECT SQL must contain ${col} — got:\n${selectSql}`,
    );
  }

  // WHERE clause must also use quoted camelCase
  assert.ok(
    selectSql.includes('"oauthSub" = $1'),
    `SELECT WHERE clause must use "oauthSub" = $1 — got:\n${selectSql}`,
  );
});
