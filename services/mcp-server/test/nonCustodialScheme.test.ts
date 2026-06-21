/**
 * Unit tests for NonCustodialExactStellarScheme — the client scheme that builds a
 * STANDARD x402 USDC.transfer(smartAccount -> payTo) authorized by the delegated
 * session key (via buildStandardTransferPayment), with no live network access.
 *
 * The builder is injected so we never touch RPC.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { NonCustodialExactStellarScheme } from "../src/core/stellar/exact/client/nonCustodialScheme.js";
import { STELLAR_TESTNET_CAIP2 } from "../src/core/stellar/constants.js";
import type { PaymentRequirements } from "@x402/core/types";

const SMART_ACCOUNT_ID = "CBT7K2B7KRWTUSHSWTGWUIIDA4WO2URICF5JIN3CRWY32FV5UH3KSHEU";
const USDC_TESTNET = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const PAY_TO = "GDUAJTDWNTS7M4WYQXQUCKPJ2WSYQTHPF3QE2TQMBYUCC7FQNSBXXZKJ"; // G-address fixture
const SESSION_SECRET = "SDDZGBOBLPDLBISKALD2K3JYXJOLJAACJZJZ4INGHL3W5JVDXRAGVBCI"; // not used by stub

function makeRequirements(overrides: Partial<PaymentRequirements> = {}): PaymentRequirements {
  return {
    scheme: "exact",
    network: STELLAR_TESTNET_CAIP2,
    asset: USDC_TESTNET,
    amount: "1000000",
    payTo: PAY_TO,
    maxTimeoutSeconds: 120,
    extra: {},
    ...overrides,
  };
}

test("createPaymentPayload returns the standard { x402Version, payload: { transaction } } shape", async () => {
  const calls: unknown[] = [];
  const scheme = new NonCustodialExactStellarScheme({
    smartAccountId: SMART_ACCOUNT_ID,
    sessionSecret: SESSION_SECRET,
    buildPayment: async opts => {
      calls.push(opts);
      return "STUB_XDR_BASE64";
    },
  });

  const result = await scheme.createPaymentPayload(2, makeRequirements());

  assert.equal(result.x402Version, 2);
  assert.deepEqual(result.payload, { transaction: "STUB_XDR_BASE64" });

  // The builder must be wired with the requirement's asset/payTo/amount and the
  // caller's smart account + session secret.
  assert.equal(calls.length, 1);
  const opts = calls[0] as Record<string, unknown>;
  assert.equal(opts.usdcContractId, USDC_TESTNET);
  assert.equal(opts.smartAccountId, SMART_ACCOUNT_ID);
  assert.equal(opts.payTo, PAY_TO);
  assert.equal(opts.amount, "1000000");
  assert.equal(opts.sessionSecret, SESSION_SECRET);
  assert.equal(typeof opts.networkPassphrase, "string");
  assert.equal(typeof opts.rpcUrl, "string");
});

test("rejects a non-exact scheme", async () => {
  const scheme = new NonCustodialExactStellarScheme({
    smartAccountId: SMART_ACCOUNT_ID,
    sessionSecret: SESSION_SECRET,
    buildPayment: async () => "X",
  });
  await assert.rejects(
    () => scheme.createPaymentPayload(2, makeRequirements({ scheme: "upto" })),
    /Invalid input parameters for creating Stellar payment/,
  );
});

test("rejects a non-Stellar network", async () => {
  const scheme = new NonCustodialExactStellarScheme({
    smartAccountId: SMART_ACCOUNT_ID,
    sessionSecret: SESSION_SECRET,
    buildPayment: async () => "X",
  });
  await assert.rejects(
    () => scheme.createPaymentPayload(2, makeRequirements({ network: "eip155:8453" as PaymentRequirements["network"] })),
    /Invalid input parameters for creating Stellar payment/,
  );
});

test("rejects an invalid payTo address", async () => {
  const scheme = new NonCustodialExactStellarScheme({
    smartAccountId: SMART_ACCOUNT_ID,
    sessionSecret: SESSION_SECRET,
    buildPayment: async () => "X",
  });
  await assert.rejects(
    () => scheme.createPaymentPayload(2, makeRequirements({ payTo: "not-an-address" })),
    /Invalid input parameters for creating Stellar payment/,
  );
});
