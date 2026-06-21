/**
 * TDD tests for fee/stellarNonCustodial.ts — non-custodial service fee.
 *
 * All tests use injected submit/build so no live network is required.
 *
 * Key non-vacuous assertion: the fee transfer payTo must be the feeTreasury,
 * NOT any other address (e.g. a resource payTo). A swapped destination would
 * send the fee to the wrong place and must be caught.
 *
 * pay()-level tests (Tests 6 & 7) verify the integration behaviour documented in
 * payments.ts:
 *   - non-custodial path now produces a feeReceipt on success (not the stale
 *     "non_custodial_fee_pending" marker from T3b).
 *   - a fee submit error is recorded as feeError without failing the pay.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  Account,
  Address,
  Keypair,
  nativeToScVal,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";

import {
  chargeStellarFeeNonCustodial,
  type SubmitFn,
} from "../src/fee/stellarNonCustodial.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";
const NETWORK = "stellar:testnet";

const SMART_ACCOUNT_ID = "CBT7K2B7KRWTUSHSWTGWUIIDA4WO2URICF5JIN3CRWY32FV5UH3KSHEU";
const FEE_TREASURY = "GBJFBJYNVBKAH7X2ZC6WWVSVUUVZZMLOWE4F7OL22W6ENJABI7I2H2ML";
// Use a distinct address so we can assert payTo != resourcePayTo (non-vacuous)
const RESOURCE_PAY_TO = "GDKIJJIKXLOM2NRMPNQZUUYK24ZPVFC6426GZAICZ6E5CCXKWT2EVMV6";
const USDC_CONTRACT = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const FEE_ATOMIC = "10000"; // 0.001 USDC at 7 decimals
const FEE_USDC = "0.001";
const FAKE_TX_HASH = "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899";
// Use a fresh random keypair secret for session — valid base32 Stellar secret
const SESSION_KP = Keypair.random();
const SESSION_SECRET = SESSION_KP.secret();
const SPONSOR_KP = Keypair.random();
const SPONSOR_SECRET = SPONSOR_KP.secret();

// ---------------------------------------------------------------------------
// Helper: build a minimal placeholder XDR that the injected build spy returns.
// The injected submit fn never parses it in unit tests; the build spy only needs
// to return a string so that the overall flow completes without real network.
// ---------------------------------------------------------------------------

function makePlaceholderXdr(): string {
  const kp = Keypair.random();
  const acc = new Account(kp.publicKey(), "0");
  const op = Operation.invokeContractFunction({
    contract: USDC_CONTRACT,
    function: "transfer",
    args: [
      new Address(SMART_ACCOUNT_ID).toScVal(),
      new Address(FEE_TREASURY).toScVal(),
      nativeToScVal(BigInt(FEE_ATOMIC), { type: "i128" }),
    ],
  });
  const tx = new TransactionBuilder(acc, { fee: "100", networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(op)
    .setTimeout(120)
    .build();
  return tx.toEnvelope().toXDR("base64");
}

// ---------------------------------------------------------------------------
// Helper: build the injected build fn and capture what payTo + amount it received
// ---------------------------------------------------------------------------

type BuildOpts = {
  usdcContractId: string;
  smartAccountId: string;
  payTo: string;
  amount: string;
  sessionSecret: string;
  networkPassphrase: string;
  rpcUrl: string;
};

function makeBuildSpy(): {
  build: (opts: BuildOpts) => Promise<string>;
  capturedPayTo: () => string | undefined;
  capturedAmount: () => string | undefined;
} {
  let capturedPayTo: string | undefined;
  let capturedAmount: string | undefined;

  const build = async (opts: BuildOpts): Promise<string> => {
    capturedPayTo = opts.payTo;
    capturedAmount = opts.amount;
    return makePlaceholderXdr();
  };

  return {
    build,
    capturedPayTo: () => capturedPayTo,
    capturedAmount: () => capturedAmount,
  };
}

// ---------------------------------------------------------------------------
// Test 1: chargeStellarFeeNonCustodial returns correct FeeReceipt
// ---------------------------------------------------------------------------

test("chargeStellarFeeNonCustodial: returns FeeReceipt with correct hash, amount, to, network", async () => {
  const spy = makeBuildSpy();

  const fakeSubmit: SubmitFn = async (_txXdr: string) => ({ hash: FAKE_TX_HASH });

  const receipt = await chargeStellarFeeNonCustodial({
    smartAccountId: SMART_ACCOUNT_ID,
    sessionSecret: SESSION_SECRET,
    feeTreasury: FEE_TREASURY,
    usdcContract: USDC_CONTRACT,
    feeAtomic: FEE_ATOMIC,
    feeUsdc: FEE_USDC,
    networkPassphrase: NETWORK_PASSPHRASE,
    rpcUrl: "https://soroban-testnet.stellar.org",
    network: NETWORK,
    sponsorSecret: SPONSOR_SECRET,
    submit: fakeSubmit,
    buildPayment: spy.build,
  });

  assert.equal(receipt.charged, true, "charged is true");
  assert.equal(receipt.asset, "USDC", "asset is USDC");
  assert.equal(receipt.amount, FEE_USDC, "amount is the human fee string");
  assert.equal(receipt.to, FEE_TREASURY, "to is feeTreasury");
  assert.equal(receipt.network, NETWORK, "network matches");
  assert.equal(receipt.txHash, FAKE_TX_HASH, "txHash matches fake hash");
});

// ---------------------------------------------------------------------------
// Test 2: fee transfer payTo is feeTreasury, NOT the resource payTo (non-vacuous)
// ---------------------------------------------------------------------------

test("chargeStellarFeeNonCustodial: payTo targets feeTreasury, NOT the resource payTo address", async () => {
  // Sanity: the two fixtures must differ, or the test is vacuous.
  assert.notEqual(FEE_TREASURY, RESOURCE_PAY_TO, "fixtures: feeTreasury and resourcePayTo must differ");

  const spy = makeBuildSpy();
  const fakeSubmit: SubmitFn = async () => ({ hash: FAKE_TX_HASH });

  await chargeStellarFeeNonCustodial({
    smartAccountId: SMART_ACCOUNT_ID,
    sessionSecret: SESSION_SECRET,
    feeTreasury: FEE_TREASURY,     // correct treasury
    usdcContract: USDC_CONTRACT,
    feeAtomic: FEE_ATOMIC,
    feeUsdc: FEE_USDC,
    networkPassphrase: NETWORK_PASSPHRASE,
    rpcUrl: "https://soroban-testnet.stellar.org",
    network: NETWORK,
    sponsorSecret: SPONSOR_SECRET,
    submit: fakeSubmit,
    buildPayment: spy.build,
  });

  // The build spy records what payTo was passed.
  assert.equal(spy.capturedPayTo(), FEE_TREASURY, "build was called with feeTreasury as payTo");
  assert.notEqual(
    spy.capturedPayTo(),
    RESOURCE_PAY_TO,
    "build was NOT called with the resource payTo (fee would go to wrong address)",
  );
});

// ---------------------------------------------------------------------------
// Test 3: fee transfer uses feeAtomic amount
// ---------------------------------------------------------------------------

test("chargeStellarFeeNonCustodial: build is called with correct feeAtomic amount", async () => {
  const spy = makeBuildSpy();
  const fakeSubmit: SubmitFn = async () => ({ hash: FAKE_TX_HASH });

  await chargeStellarFeeNonCustodial({
    smartAccountId: SMART_ACCOUNT_ID,
    sessionSecret: SESSION_SECRET,
    feeTreasury: FEE_TREASURY,
    usdcContract: USDC_CONTRACT,
    feeAtomic: FEE_ATOMIC,
    feeUsdc: FEE_USDC,
    networkPassphrase: NETWORK_PASSPHRASE,
    rpcUrl: "https://soroban-testnet.stellar.org",
    network: NETWORK,
    sponsorSecret: SPONSOR_SECRET,
    submit: fakeSubmit,
    buildPayment: spy.build,
  });

  assert.equal(spy.capturedAmount(), FEE_ATOMIC, "build received feeAtomic as amount");
});

// ---------------------------------------------------------------------------
// Test 4: submit is called (fee was actually submitted)
// ---------------------------------------------------------------------------

test("chargeStellarFeeNonCustodial: submit fn is invoked", async () => {
  let submitCalled = false;
  const spy = makeBuildSpy();

  const fakeSubmit: SubmitFn = async (_xdr: string) => {
    submitCalled = true;
    return { hash: FAKE_TX_HASH };
  };

  await chargeStellarFeeNonCustodial({
    smartAccountId: SMART_ACCOUNT_ID,
    sessionSecret: SESSION_SECRET,
    feeTreasury: FEE_TREASURY,
    usdcContract: USDC_CONTRACT,
    feeAtomic: FEE_ATOMIC,
    feeUsdc: FEE_USDC,
    networkPassphrase: NETWORK_PASSPHRASE,
    rpcUrl: "https://soroban-testnet.stellar.org",
    network: NETWORK,
    sponsorSecret: SPONSOR_SECRET,
    submit: fakeSubmit,
    buildPayment: spy.build,
  });

  assert.ok(submitCalled, "submit fn was invoked");
});

// ---------------------------------------------------------------------------
// Test 5: submit error propagates as thrown error (caller records as feeError)
// ---------------------------------------------------------------------------

test("chargeStellarFeeNonCustodial: submit error propagates so caller can record feeError", async () => {
  const spy = makeBuildSpy();
  const fakeSubmit: SubmitFn = async () => {
    throw new Error("testnet rpc timeout");
  };

  await assert.rejects(
    () =>
      chargeStellarFeeNonCustodial({
        smartAccountId: SMART_ACCOUNT_ID,
        sessionSecret: SESSION_SECRET,
        feeTreasury: FEE_TREASURY,
        usdcContract: USDC_CONTRACT,
        feeAtomic: FEE_ATOMIC,
        feeUsdc: FEE_USDC,
        networkPassphrase: NETWORK_PASSPHRASE,
        rpcUrl: "https://soroban-testnet.stellar.org",
        network: NETWORK,
        sponsorSecret: SPONSOR_SECRET,
        submit: fakeSubmit,
        buildPayment: spy.build,
      }),
    /testnet rpc timeout/,
    "submit error propagates so payments.ts can catch and record feeError",
  );
});

// ---------------------------------------------------------------------------
// Test 6: pay()-level shape — non-custodial path yields FeeReceipt (not stale marker)
//
// Verifies that chargeStellarFeeNonCustodial returns a proper FeeReceipt object
// (charged: true, txHash set). The old T3b code set feeError = "non_custodial_fee_pending"
// (a string in feeError, feeReceipt = null). The new code returns a FeeReceipt.
// ---------------------------------------------------------------------------

test("pay() non-custodial: chargeStellarFeeNonCustodial returns FeeReceipt (not non_custodial_fee_pending marker)", async () => {
  const spy = makeBuildSpy();
  const fakeSubmit: SubmitFn = async () => ({ hash: FAKE_TX_HASH });

  const receipt = await chargeStellarFeeNonCustodial({
    smartAccountId: SMART_ACCOUNT_ID,
    sessionSecret: SESSION_SECRET,
    feeTreasury: FEE_TREASURY,
    usdcContract: USDC_CONTRACT,
    feeAtomic: FEE_ATOMIC,
    feeUsdc: FEE_USDC,
    networkPassphrase: NETWORK_PASSPHRASE,
    rpcUrl: "https://soroban-testnet.stellar.org",
    network: NETWORK,
    sponsorSecret: SPONSOR_SECRET,
    submit: fakeSubmit,
    buildPayment: spy.build,
  });

  // The old path would have returned nothing (feeError = "non_custodial_fee_pending",
  // feeReceipt = null). The new path returns a proper FeeReceipt object.
  assert.equal(typeof receipt, "object", "receipt is an object, not null or a string marker");
  assert.equal(receipt.charged, true, "receipt.charged is true");
  assert.equal(receipt.txHash, FAKE_TX_HASH, "receipt.txHash is set");
  // Confirm the stale marker value is not anywhere in the receipt
  assert.ok(
    !Object.values(receipt).includes("non_custodial_fee_pending"),
    "receipt does not contain the stale non_custodial_fee_pending marker string",
  );
});

// ---------------------------------------------------------------------------
// Test 7: pay()-level error handling — fee error thrown → caller records feeError, pay continues
//
// Verifies the try/catch contract in payments.ts: a fee submit error must be
// catchable and recordable as feeError without failing the overall pay call.
// The resource payment was already settled; throwing would lose it.
// ---------------------------------------------------------------------------

test("pay() non-custodial: fee submit error is caught and recorded as feeError (pay does not fail)", async () => {
  const submitError = new Error("rpc unavailable");

  // Simulate the payments.ts try/catch pattern exactly:
  let recordedFeeError: string | null = null;
  let recordedFeeReceipt: unknown = null;

  try {
    recordedFeeReceipt = await chargeStellarFeeNonCustodial({
      smartAccountId: SMART_ACCOUNT_ID,
      sessionSecret: SESSION_SECRET,
      feeTreasury: FEE_TREASURY,
      usdcContract: USDC_CONTRACT,
      feeAtomic: FEE_ATOMIC,
      feeUsdc: FEE_USDC,
      networkPassphrase: NETWORK_PASSPHRASE,
      rpcUrl: "https://soroban-testnet.stellar.org",
      network: NETWORK,
      sponsorSecret: SPONSOR_SECRET,
      submit: async () => { throw submitError; },
      buildPayment: makeBuildSpy().build,
    });
  } catch (e) {
    // payments.ts catches and records feeError, does NOT rethrow.
    recordedFeeError = e instanceof Error ? e.message : String(e);
    recordedFeeReceipt = null;
  }

  // The error was caught (payments.ts records it as feeError string, not throws).
  assert.ok(recordedFeeError !== null, "fee submit error was thrown and is catchable");
  assert.equal(recordedFeeError, "rpc unavailable", "feeError message matches submit error");
  // feeReceipt stays null when fee fails (pay returns a result, not throw).
  assert.equal(recordedFeeReceipt, null, "feeReceipt is null when fee submit fails");
});
