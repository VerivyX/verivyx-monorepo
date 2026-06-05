import type { x402Client } from "@x402/core/client";

import { ExactStellarScheme } from "../core/stellar/exact/client/scheme.js";
import { createEd25519Signer } from "../core/stellar/signer.js";
import type { StellarChainConfig } from "../config.js";

export type StellarRail = {
  readonly address: string;
};

/** Build the Stellar paying wallet and register its exact scheme on the shared x402 client. */
export function setupStellarRail(client: x402Client, config: StellarChainConfig, secretKey: string): StellarRail {
  const signer = createEd25519Signer(secretKey, config.network);
  client.register(
    "stellar:*",
    new ExactStellarScheme(signer, config.rpcUrl ? { url: config.rpcUrl } : undefined),
  );
  return { address: signer.address };
}

export function stellarInfo(config: StellarChainConfig, address: string, feeUsdc: string): Record<string, unknown> {
  return {
    chain: config.network,
    address,
    asset: { code: "USDC", contract: config.usdcContract, issuer: config.usdcIssuer },
    rpcUrl: config.rpcUrl ?? null,
    horizonUrl: config.horizonUrl,
    serviceFee: feeUsdc,
    feeTreasury: config.feeTreasury,
    testnet: config.isTestnet,
  };
}
