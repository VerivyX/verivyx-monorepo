import bs58 from "bs58";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount, transferChecked } from "@solana/spl-token";
import { registerExactSvmScheme, type SvmClientConfig } from "@x402/svm/exact/client";
import type { x402Client } from "@x402/core/client";

import type { SolanaChainConfig } from "../config.js";
import type { FeeReceipt } from "../fee/types.js";
import { decimalToBaseUnits } from "../money.js";

export type SolanaRail = {
  readonly address: string;
};

/** Build the Solana paying wallet (x402 signer) and register its exact scheme. */
export async function setupSolanaRail(client: x402Client, config: SolanaChainConfig): Promise<SolanaRail> {
  const bytes = bs58.decode(config.secretKey);
  const signer = await createKeyPairSignerFromBytes(bytes);
  registerExactSvmScheme(client, { signer: signer as SvmClientConfig["signer"] });
  return { address: String(signer.address) };
}

/**
 * Charge the flat Verivyx MCP service fee as a SEPARATE SPL USDC transfer to the
 * platform Solana treasury. The paying wallet covers the tiny SOL fee (a fraction
 * of a cent), far below the 0.001 USDC fee.
 */
export async function chargeSolanaFee(args: {
  config: SolanaChainConfig;
  feeUsdc: string;
}): Promise<FeeReceipt> {
  const { config, feeUsdc } = args;
  const payer = Keypair.fromSecretKey(bs58.decode(config.secretKey));
  const connection = new Connection(config.rpcUrl, "confirmed");
  const mint = new PublicKey(config.usdc);
  const treasury = new PublicKey(config.feeTreasury);
  const amount = decimalToBaseUnits(feeUsdc, config.usdcDecimals);

  const source = await getOrCreateAssociatedTokenAccount(connection, payer, mint, payer.publicKey);
  const destination = await getOrCreateAssociatedTokenAccount(connection, payer, mint, treasury);

  const signature = await transferChecked(
    connection,
    payer,
    source.address,
    mint,
    destination.address,
    payer,
    amount,
    config.usdcDecimals,
  );

  return {
    charged: true,
    asset: "USDC",
    amount: feeUsdc,
    to: config.feeTreasury,
    network: config.caip2,
    txHash: signature,
  };
}

export function solanaInfo(config: SolanaChainConfig, address: string, feeUsdc: string): Record<string, unknown> {
  return {
    chain: config.caip2,
    address,
    asset: { code: "USDC", mint: config.usdc },
    rpcUrl: config.rpcUrl,
    serviceFee: feeUsdc,
    feeTreasury: config.feeTreasury,
    testnet: config.isTestnet,
  };
}
