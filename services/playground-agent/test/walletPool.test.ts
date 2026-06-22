// Unit tests for the wallet-pool retire logic.
// These test only the pure pool-management behaviour (no network calls).
import assert from "node:assert/strict";
import { test } from "node:test";

// ---------------------------------------------------------------------------
// Minimal stubs so walletPool.ts can be imported without real env / network.
// PLAYGROUND_FAUCET_SECRET must be a syntactically valid Stellar secret key
// because faucet.ts calls Keypair.fromSecret() at module scope.
// ---------------------------------------------------------------------------
process.env.OPENROUTER_API_KEY = "test-key";
// Valid Stellar testnet keypair (no real funds — used only for Keypair.fromSecret parse).
process.env.PLAYGROUND_FAUCET_SECRET = "SBQCJZWSWKJ3C2ISDKZJRJOR6SYNDMDA7W57ZHPP56UFZ4NCAI6KNUTR";
process.env.STELLAR_NETWORK = "testnet";

// ---------------------------------------------------------------------------

test("retireWallet: no-op on unknown public key", async () => {
  const { retireWallet } = await import("../src/walletPool.js");
  // An unknown public key should never throw.
  assert.doesNotThrow(() =>
    retireWallet("GAHKAV3E3GIB37W4GSMXSLH5BP5RKFLL5CEHXWH3ZNBJVFWUSOAWIEHY"),
  );
});

test("retireWallet: no-op on arbitrary string (empty pool)", async () => {
  const { retireWallet } = await import("../src/walletPool.js");
  assert.doesNotThrow(() => retireWallet("GDOESNOTEXISTPOOLISEMPTYATSTARTTESTENV"));
});
