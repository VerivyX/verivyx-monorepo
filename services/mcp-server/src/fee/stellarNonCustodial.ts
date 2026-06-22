/**
 * Non-custodial Stellar service fee — delegated USDC.transfer(smartAccount → feeTreasury)
 *
 * The fee is authorized by the session key (the user's delegated signer on their OZ smart
 * account) and submitted by the MCP wallet (which sponsors gas as the tx source).
 *
 * Auth is op-level in Soroban: the signed auth entries live in the InvokeHostFunction op
 * body (not in the tx envelope). Re-sourcing the tx with a different account and
 * assembleTransaction only updates the tx-level source + resource fee fields; the op's
 * auth array is preserved unchanged because auth is not part of the tx header.
 *
 * Make the SUBMIT step injectable so unit tests can verify the transfer target + amount
 * without any live network access.
 */

import {
  Account,
  BASE_FEE,
  Keypair,
  Transaction,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import { assembleTransaction } from "@stellar/stellar-sdk/rpc";

import { buildStandardTransferPayment } from "../wallet/sessionPayment.js";
import type { FeeReceipt } from "./types.js";

// ---------------------------------------------------------------------------
// Injectable submit type (for unit testing)
// ---------------------------------------------------------------------------

export type SubmitFn = (txXdr: string) => Promise<{ hash: string }>;

// ---------------------------------------------------------------------------
// Default real-network submit: re-source, assemble, sign, send, poll
// ---------------------------------------------------------------------------

async function defaultSubmit(
  txXdr: string,
  sponsorSecret: string,
  networkPassphrase: string,
  rpcUrl: string,
): Promise<{ hash: string }> {
  // Lazy import keeps rpc out of test-side bundles
  const { rpc } = await import("@stellar/stellar-sdk");
  const server = new rpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith("http://") });

  const sponsorKp = Keypair.fromSecret(sponsorSecret);

  // Load the MCP wallet's on-chain account (real sequence + ledger headers).
  const sponsorAccount = await server.getAccount(sponsorKp.publicKey());

  // Parse the placeholder-sourced tx that came from buildStandardTransferPayment.
  // The InvokeHostFunction op carries the signed auth in its body — it is NOT touched
  // by re-sourcing because auth is op-level (lives inside the op body XDR), independent
  // of the tx source account.
  const placeholderTx = TransactionBuilder.fromXDR(txXdr, networkPassphrase) as Transaction;

  // Re-source with the sponsor account as source (valid sequence). Build the tx WITH the
  // op (the InvokeHostFunction op already carries the signed auth in its body — auth is
  // op-level, independent of the tx source). Building WITH the op (not a 0-op build +
  // envelope graft) is what lets assembleTransaction compute the fee correctly — the old
  // 0-op-graft path produced txInsufficientFee. Mirrors smartAccount.ts submitWithOwnerAuth.
  // Take the raw xdr.Operation from the placeholder envelope (its body carries the signed
  // auth) — addOperation accepts an xdr.Operation and preserves the auth verbatim.
  const op = placeholderTx.toEnvelope().v1().tx().operations()[0];
  const reSourced = new TransactionBuilder(
    new Account(sponsorAccount.accountId(), sponsorAccount.sequenceNumber()),
    {
      // Inclusion-fee base; assembleTransaction sets the real fee (inclusion + Soroban resource).
      fee: BASE_FEE,
      networkPassphrase,
    },
  )
    .addOperation(op)
    .setTimeout(120)
    .build();

  // Simulate (auth already in the op body) → assembleTransaction sets resource fee + footprint.
  const sim = await server.simulateTransaction(reSourced);
  if (rpc.Api.isSimulationError(sim)) {
    throw new Error(`fee simulate error: ${sim.error}`);
  }
  let prepared = assembleTransaction(reSourced, sim).build();

  // Defensive: if assembleTransaction cleared auth (it shouldn't), re-attach from the placeholder.
  {
    const env2 = prepared.toEnvelope();
    const opBody = env2.v1().tx().operations()[0].body().invokeHostFunctionOp();
    if (opBody.auth().length === 0) {
      const auth0 = placeholderTx.toEnvelope().v1().tx().operations()[0].body().invokeHostFunctionOp().auth();
      opBody.auth(auth0);
      prepared = new Transaction(env2, networkPassphrase);
    }
  }

  // MCP wallet signs as tx source / gas sponsor.
  prepared.sign(sponsorKp);

  const send = await server.sendTransaction(prepared);
  if (send.status === "ERROR") {
    const detail = send.errorResult?.toXDR?.("base64") ?? JSON.stringify(send);
    throw new Error(`fee tx send ERROR: ${detail}`);
  }

  // Poll until finalized. GetTransactionStatus: SUCCESS, FAILED, NOT_FOUND (pending).
  const deadline = Date.now() + 90_000;
  let got = await server.getTransaction(send.hash);
  while (got.status === rpc.Api.GetTransactionStatus.NOT_FOUND && Date.now() < deadline) {
    await new Promise<void>(r => setTimeout(r, 2_000));
    got = await server.getTransaction(send.hash);
  }
  if (got.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
    const xdrDetail = got.status === rpc.Api.GetTransactionStatus.FAILED
      ? (got as { resultXdr?: xdr.TransactionResult }).resultXdr?.toXDR?.("base64") ?? ""
      : `(status: ${got.status})`;
    throw new Error(`fee tx ${got.status}: ${send.hash}\n${xdrDetail}`);
  }

  return { hash: send.hash };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type ChargeStellarFeeNonCustodialOpts = {
  /** The user's OZ smart account contract address (C…) */
  smartAccountId: string;
  /** The session key secret (S…) — delegated signer on the smart account */
  sessionSecret: string;
  /** Fee treasury address (G… or C…) — where the fee USDC lands */
  feeTreasury: string;
  /** USDC SEP-41 SAC contract ID (C…) */
  usdcContract: string;
  /** Fee amount in USDC atomic units (e.g. "10000" for 0.001 USDC at 7 decimals) */
  feeAtomic: string;
  /** Human-readable fee amount for the receipt (e.g. "0.001") */
  feeUsdc: string;
  /** Soroban network passphrase */
  networkPassphrase: string;
  /** Soroban RPC URL */
  rpcUrl: string;
  /** CAIP-2 network identifier for the receipt (e.g. "stellar:testnet") */
  network: string;
  /** MCP wallet secret key — sponsors gas as the tx source */
  sponsorSecret: string;
  /**
   * Injectable submit function for unit testing.
   * Receives the placeholder-sourced XDR (with signed auth embedded) and returns a tx hash.
   * When omitted, the real re-source → assemble → send → poll path is used.
   */
  submit?: SubmitFn;
  /**
   * Injectable build function for unit testing.
   * When omitted, buildStandardTransferPayment is called for real.
   */
  buildPayment?: (opts: {
    usdcContractId: string;
    smartAccountId: string;
    payTo: string;
    amount: string;
    sessionSecret: string;
    networkPassphrase: string;
    rpcUrl: string;
  }) => Promise<string>;
};

/**
 * Charge the flat Verivyx MCP service fee from the user's smart account to the fee
 * treasury, authorized by the session key and gas-sponsored by the MCP wallet.
 *
 * Returns the same FeeReceipt shape as the custodial chargeStellarFee.
 */
export async function chargeStellarFeeNonCustodial(
  opts: ChargeStellarFeeNonCustodialOpts,
): Promise<FeeReceipt> {
  const {
    smartAccountId,
    sessionSecret,
    feeTreasury,
    usdcContract,
    feeAtomic,
    feeUsdc,
    networkPassphrase,
    rpcUrl,
    network,
    sponsorSecret,
    submit: injectSubmit,
    buildPayment: injectBuild,
  } = opts;

  // Build the delegated USDC.transfer(smartAccount → feeTreasury, feeAtomic) XDR.
  // Placeholder-sourced (sequence 0); the submit step re-sources with the MCP wallet.
  const buildFn = injectBuild ?? (async (buildOpts) => {
    return buildStandardTransferPayment({
      usdcContractId: buildOpts.usdcContractId,
      smartAccountId: buildOpts.smartAccountId,
      payTo: buildOpts.payTo,
      amount: buildOpts.amount,
      sessionSecret: buildOpts.sessionSecret,
      networkPassphrase: buildOpts.networkPassphrase,
      rpcUrl: buildOpts.rpcUrl,
    });
  });

  const txXdr = await buildFn({
    usdcContractId: usdcContract,
    smartAccountId,
    payTo: feeTreasury,
    amount: feeAtomic,
    sessionSecret,
    networkPassphrase,
    rpcUrl,
  });

  // Submit: either the injected (test) or real (prod) path.
  const submitFn: SubmitFn = injectSubmit ?? ((xdrStr) =>
    defaultSubmit(xdrStr, sponsorSecret, networkPassphrase, rpcUrl)
  );

  const { hash } = await submitFn(txXdr);

  return {
    charged: true,
    asset: "USDC",
    amount: feeUsdc,
    to: feeTreasury,
    network,
    txHash: hash,
  };
}
