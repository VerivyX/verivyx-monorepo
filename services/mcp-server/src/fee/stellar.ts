import {
  Asset,
  BASE_FEE,
  Horizon,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";

import { STELLAR_TESTNET_CAIP2 } from "../core/stellar/constants.js";
import type { StellarChainConfig } from "../config.js";
import type { FeeReceipt } from "./types.js";

/**
 * Charge the flat Verivyx MCP service fee as a SEPARATE classic USDC payment
 * from the paying wallet to the per-chain platform treasury.
 *
 * F0 keeps this as its own transaction (not bundled into the resource payment):
 * gas on Stellar (~$0.000001) is negligible versus the 0.001 USDC fee, and a
 * standalone op keeps the fee path chain-agnostic and easy to audit. The bundled
 * single-tx fee-op arrives with the non-custodial session-key model (Fase 5).
 */
export async function chargeStellarFee(args: {
  config: StellarChainConfig;
  secretKey: string;
  feeUsdc: string;
}): Promise<FeeReceipt> {
  const { config, secretKey, feeUsdc } = args;
  const networkPassphrase =
    config.network === STELLAR_TESTNET_CAIP2 ? Networks.TESTNET : Networks.PUBLIC;

  const server = new Horizon.Server(config.horizonUrl);
  const keypair = Keypair.fromSecret(secretKey);
  const source = await server.loadAccount(keypair.publicKey());

  const tx = new TransactionBuilder(source, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(
      Operation.payment({
        destination: config.feeTreasury,
        asset: new Asset("USDC", config.usdcIssuer),
        amount: feeUsdc,
      }),
    )
    .setTimeout(60)
    .build();

  tx.sign(keypair);
  const result = await server.submitTransaction(tx);

  return {
    charged: true,
    asset: "USDC",
    amount: feeUsdc,
    to: config.feeTreasury,
    network: config.network,
    txHash: result.hash,
  };
}
