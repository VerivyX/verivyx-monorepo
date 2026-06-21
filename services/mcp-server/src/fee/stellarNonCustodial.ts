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

  // Re-source: build a new tx with the sponsor account as source so the sequence is valid.
  // We re-use the same ops from the placeholder tx XDR-level (via envelope manipulation)
  // to guarantee the signed auth entries in the op body survive unchanged.
  const reSourced = new TransactionBuilder(
    new Account(sponsorAccount.accountId(), sponsorAccount.sequenceNumber()),
    {
      fee: "12000000",
      networkPassphrase,
    },
  )
    .setTimeout(120)
    .build();

  // Graft the ops from the placeholder tx into the re-sourced tx envelope.
  // Auth is stored inside each op's body (invokeHostFunctionOp().auth()), so it
  // survives this XDR-level copy without any further manipulation.
  {
    const envPlaceholder = placeholderTx.toEnvelope();
    const envReSourced = reSourced.toEnvelope();
    envReSourced.v1().tx().operations(
      envPlaceholder.v1().tx().operations(),
    );
    // Rebuild the Transaction object from the mutated envelope so it carries the ops.
    const rebuilt = new Transaction(envReSourced, networkPassphrase);
    // Simulate the re-sourced tx (with auth already in the op body) to get accurate
    // resource fees + footprint. assembleTransaction adds the resource fee without
    // touching the auth entries.
    const sim = await server.simulateTransaction(rebuilt);
    if (rpc.Api.isSimulationError(sim)) {
      throw new Error(`fee simulate error: ${sim.error}`);
    }
    let prepared = assembleTransaction(rebuilt, sim).build();

    // Defensive guard from the spike (05-session-pay.js lines 62-64):
    // if assembleTransaction cleared auth (it shouldn't), re-attach from the source tx.
    {
      const env2 = prepared.toEnvelope();
      const opBody = env2.v1().tx().operations()[0].body().invokeHostFunctionOp();
      if (opBody.auth().length === 0) {
        const auth0 = envPlaceholder.v1().tx().operations()[0].body().invokeHostFunctionOp().auth();
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

    // Poll until finalized. GetTransactionStatus has: SUCCESS, FAILED, NOT_FOUND.
    // NOT_FOUND means the transaction has not yet been processed (still pending).
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
